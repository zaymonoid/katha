/**
 * Declarative data layer built on katha stores.
 *
 * Define queries with {@linkcode defineQuery} and mutations with
 * {@linkcode defineMutation}, wire the provided {@linkcode queriesReducer}
 * into your store via `combineReducers`, and the processes handle fetch
 * orchestration, caching, and invalidation automatically.
 *
 * Reads: query selectors serve canonical cached data with any pending
 * optimistic overlays folded in invisibly. Writes: a mutation records an
 * optimistic intent, runs its effect, then either soft-invalidates its target
 * queries (success — the overlay holds until fresh data replaces it) or drops
 * the intent (error — rollback is removal, the cache was never touched).
 *
 * @module
 */

import { Cause, Effect, Exit, Fiber, Ref, type Scope, Stream } from "effect";
import { takeEvery, takeLeading } from "./combinators.ts";
import type { Reducer } from "./reducer.ts";
import type { Action, StoreContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle state of a single query. */
export type QueryStatus = "loading" | "success" | "error";

/** Snapshot of a single query's cache entry. */
export interface QueryState<T> {
  readonly status: QueryStatus;
  readonly data: T | undefined;
  readonly error: string | undefined;
  readonly isFetching: boolean;
  /** Set by a soft invalidate: data stays visible while the reconciler refetches. */
  readonly isStale: boolean;
  readonly dataUpdatedAt: number | undefined;
}

/** Lifecycle state of a single mutation (per mutation name — latest call wins). */
export type MutationStatus = "idle" | "pending" | "success" | "error";

/** Snapshot of a mutation's lifecycle, read via {@linkcode MutationDefinition.select}. */
export interface MutationState<V = unknown> {
  readonly status: MutationStatus;
  readonly error: string | undefined;
  /** Variables of the most recent run. `undefined` only in the idle state. */
  readonly variables: V | undefined;
  readonly submittedAt: number | undefined;
  /**
   * Id of the run this lifecycle reflects. Completions of superseded runs are
   * ignored so the latest call always wins. `undefined` only in the idle state.
   */
  readonly intentId: string | undefined;
}

/**
 * One cache entry (`query:key`) an optimistic intent applies to and, after
 * success, waits on. Every target is keyed: keyed overlays resolve the key
 * from the variables, keyless ones from the key the query derived at dispatch
 * — so an overlay follows the entry it was issued for, not whichever key the
 * query derives later.
 */
export interface IntentTarget {
  readonly query: string;
  readonly key: string;
}

/** A soft invalidation: the single entry `query:key` when `key` is set, otherwise every key of `query`. */
export interface Invalidation {
  readonly query: string;
  readonly key?: string;
}

/**
 * Overlay intent phase. `pending` — the mutation is in flight. `settling` — the
 * server confirmed, and the overlay is held until the refetched data lands so
 * the optimistic view hands off to fresh truth without a flash.
 */
export type IntentPhase = "pending" | "settling";

/**
 * One optimistic intent, in dispatch order. Plain data: the overlay function
 * itself lives on the mutation definition, registered against the query.
 */
export interface OverlayIntent {
  readonly intentId: string;
  readonly mutation: string;
  readonly variables: unknown;
  readonly phase: IntentPhase;
  readonly targets: readonly IntentTarget[];
}

/**
 * The queries slice of store state. `cache` holds canonical server truth and is
 * never touched by optimism; `overlays` holds pending optimistic intents that
 * {@linkcode defineQuery} selectors fold over cached data invisibly; `mutations`
 * holds per-name mutation lifecycle state.
 */
export interface QueriesState {
  readonly cache: Record<string, QueryState<unknown>>;
  readonly overlays: readonly OverlayIntent[];
  readonly mutations: Record<string, MutationState>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Discriminated union of actions dispatched by the query process. */
export type QueriesAction =
  | { readonly id: "query-started"; readonly data: { readonly queryId: string } }
  | {
      readonly id: "query-success";
      readonly data: {
        readonly queryId: string;
        readonly result: unknown;
        readonly dataUpdatedAt: number;
      };
    }
  | {
      readonly id: "query-error";
      readonly data: { readonly queryId: string; readonly error: string };
    }
  | {
      readonly id: "query-invalidate";
      readonly data: {
        readonly queryName: string;
        /** Restrict invalidation to the single entry `queryName:key`. Omit for all keys. */
        readonly key?: string;
        /** Keep data visible and refetch in the background instead of deleting the entry. */
        readonly soft?: boolean;
      };
    }
  | {
      readonly id: "mutation-started";
      readonly data: {
        readonly name: string;
        readonly intentId: string;
        readonly variables: unknown;
        readonly targets: readonly IntentTarget[];
        readonly submittedAt: number;
      };
    }
  | {
      readonly id: "mutation-success";
      readonly data: {
        readonly name: string;
        readonly intentId: string;
        /** Applied in the same transition that settles the intent, so no refetch can land between. */
        readonly invalidations: readonly Invalidation[];
      };
    }
  | {
      readonly id: "mutation-error";
      readonly data: { readonly name: string; readonly intentId: string; readonly error: string };
    };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Empty initial state for the queries slice. */
export const initialQueriesState: QueriesState = { cache: {}, overlays: [], mutations: {} };

/** The cache key of an intent target. */
const cacheKeyOf = (target: IntentTarget): string => `${target.query}:${target.key}`;

/** Does an invalidation cover this cache key? Keyed ones match exactly, name-level ones every key. */
const invalidationCovers = (invalidation: Invalidation, cacheKey: string): boolean =>
  invalidation.key !== undefined
    ? cacheKey === `${invalidation.query}:${invalidation.key}`
    : cacheKey === invalidation.query || cacheKey.startsWith(`${invalidation.query}:`);

/** Mark every covered entry stale. Returns the same cache when nothing changed. */
const markStale = (
  cache: Record<string, QueryState<unknown>>,
  invalidations: readonly Invalidation[],
): Record<string, QueryState<unknown>> => {
  let changed = false;
  const next: Record<string, QueryState<unknown>> = {};
  for (const [cacheKey, value] of Object.entries(cache)) {
    if (!value.isStale && invalidations.some((inv) => invalidationCovers(inv, cacheKey))) {
      next[cacheKey] = { ...value, isStale: true };
      changed = true;
    } else {
      next[cacheKey] = value;
    }
  }
  return changed ? next : cache;
};

/**
 * Fresh data landed for `queryId` — drop the consumed target from settling
 * intents, and drop intents with no targets left. Pending intents are left
 * alone: their mutation hasn't succeeded yet, so this data predates them.
 *
 * `query-error` consumes targets too: if the post-mutation refetch fails, the
 * overlay is released and canonical (older) data shows with the entry's error
 * — fail toward truth; re-invalidate to retry. Neither action settles while
 * the entry is still marked stale: that response was in flight before the
 * invalidation and predates the mutation, so the reducer holds the overlay
 * for the reconciler's refetch instead.
 */
const settleOverlays = (
  overlays: readonly OverlayIntent[],
  queryId: string,
): readonly OverlayIntent[] => {
  let changed = false;
  const next: OverlayIntent[] = [];
  for (const intent of overlays) {
    if (intent.phase !== "settling") {
      next.push(intent);
      continue;
    }
    const remaining = intent.targets.filter((t) => cacheKeyOf(t) !== queryId);
    if (remaining.length === intent.targets.length) {
      next.push(intent);
    } else {
      changed = true;
      if (remaining.length > 0) next.push({ ...intent, targets: remaining });
    }
  }
  return changed ? next : overlays;
};

/**
 * Reducer that handles {@linkcode QueriesAction} to maintain the query cache,
 * optimistic overlays, and mutation lifecycle state.
 */
export const queriesReducer: Reducer<QueriesState, QueriesAction> = (state, action) => {
  switch (action.id) {
    case "query-started": {
      const existing = state.cache[action.data.queryId];
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.data.queryId]:
            existing?.data !== undefined
              ? { ...existing, isFetching: true, isStale: false }
              : {
                  status: "loading" as const,
                  data: undefined,
                  error: undefined,
                  isFetching: true,
                  isStale: false,
                  dataUpdatedAt: undefined,
                },
        },
      };
    }
    case "query-success": {
      const { queryId } = action.data;
      const existing = state.cache[queryId];
      // A stale entry means a soft invalidate landed while this fetch was in
      // flight, so the response predates it. Keep the flag (the reconciler
      // refetches) and hold any settling overlay for that refetch — releasing
      // it now would hand the view off to pre-mutation data.
      const predatesInvalidation = existing?.isStale ?? false;
      return {
        ...state,
        cache: {
          ...state.cache,
          [queryId]: {
            status: "success" as const,
            data: action.data.result,
            error: undefined,
            isFetching: false,
            isStale: predatesInvalidation,
            dataUpdatedAt: action.data.dataUpdatedAt,
          },
        },
        // Same action writes fresh data AND releases the settling overlay —
        // the optimistic view hands off to server truth with no frame between.
        overlays: predatesInvalidation ? state.overlays : settleOverlays(state.overlays, queryId),
      };
    }
    case "query-error": {
      const { queryId } = action.data;
      const existing = state.cache[queryId];
      const predatesInvalidation = existing?.isStale ?? false;
      return {
        ...state,
        cache: {
          ...state.cache,
          [queryId]: {
            status: "error" as const,
            data: existing?.data,
            error: action.data.error,
            isFetching: false,
            isStale: predatesInvalidation,
            dataUpdatedAt: existing?.dataUpdatedAt,
          },
        },
        overlays: predatesInvalidation ? state.overlays : settleOverlays(state.overlays, queryId),
      };
    }
    case "query-invalidate": {
      const { queryName, key, soft } = action.data;
      const invalidation: Invalidation =
        key === undefined ? { query: queryName } : { query: queryName, key };
      if (soft) {
        const cache = markStale(state.cache, [invalidation]);
        return cache === state.cache ? undefined : { ...state, cache };
      }
      let removed = false;
      const filtered: Record<string, QueryState<unknown>> = {};
      for (const [cacheKey, value] of Object.entries(state.cache)) {
        if (invalidationCovers(invalidation, cacheKey)) {
          removed = true;
        } else {
          filtered[cacheKey] = value;
        }
      }
      return removed ? { ...state, cache: filtered } : undefined;
    }
    case "mutation-started": {
      const { name, intentId, variables, targets, submittedAt } = action.data;
      const intent: OverlayIntent = {
        intentId,
        mutation: name,
        variables,
        phase: "pending",
        targets,
      };
      return {
        ...state,
        overlays: targets.length > 0 ? [...state.overlays, intent] : state.overlays,
        mutations: {
          ...state.mutations,
          [name]: { status: "pending", error: undefined, variables, submittedAt, intentId },
        },
      };
    }
    case "mutation-success": {
      const { name, intentId, invalidations } = action.data;
      const existing = state.mutations[name];
      let overlaysChanged = false;
      const nextOverlays: OverlayIntent[] = [];
      for (const intent of state.overlays) {
        if (intent.intentId !== intentId) {
          nextOverlays.push(intent);
          continue;
        }
        overlaysChanged = true;
        // Keep only targets with a cache entry to wait on — nothing will ever
        // refetch an absent one, so holding it would strand the intent.
        // In-flight fetches have (loading) entries, so real settling survives.
        const live = intent.targets.filter((t) => state.cache[cacheKeyOf(t)] !== undefined);
        if (live.length > 0) {
          nextOverlays.push({ ...intent, phase: "settling", targets: live });
        }
      }
      return {
        ...state,
        // Settle and mark stale in one transition: no refetch result can land
        // between the two and consume the overlay with pre-mutation data.
        cache: markStale(state.cache, invalidations),
        overlays: overlaysChanged ? nextOverlays : state.overlays,
        // A superseded run's completion must not overwrite a newer run's
        // lifecycle — latest call wins.
        mutations:
          existing !== undefined && existing.intentId === intentId
            ? {
                ...state.mutations,
                [name]: { ...existing, status: "success", error: undefined },
              }
            : state.mutations,
      };
    }
    case "mutation-error": {
      const { name, intentId, error } = action.data;
      const existing = state.mutations[name];
      return {
        ...state,
        // Rollback is removal: the canonical cache was never touched, so the
        // next select derives the pre-mutation view with nothing to restore.
        overlays: state.overlays.filter((intent) => intent.intentId !== intentId),
        mutations:
          existing !== undefined && existing.intentId === intentId
            ? { ...state.mutations, [name]: { ...existing, status: "error", error } }
            : state.mutations,
      };
    }
    default:
      return undefined;
  }
};

// ---------------------------------------------------------------------------
// QueryEntry
// ---------------------------------------------------------------------------

/** A query key paired with the Effect that fetches its data. */
export type QueryEntry<T> = {
  readonly key: string;
  readonly fetch: Effect.Effect<T, unknown, never>;
};

// ---------------------------------------------------------------------------
// Overlay registry (module-private)
// ---------------------------------------------------------------------------

/** An overlay function registered on a query definition by defineMutation. */
interface QueryOverlay {
  readonly mutation: string;
  /** Key resolver for keyed overlays — `undefined` for keyless (single-key) ones. */
  readonly keyOf: ((variables: unknown) => string) | undefined;
  readonly apply: (data: unknown, variables: unknown) => unknown;
}

/**
 * Module-private internals of a query definition. The channel between
 * defineQuery and defineMutation — reached through a non-exported symbol,
 * so no public API surface exists for it.
 */
interface QueryInternals {
  readonly overlays: QueryOverlay[];
  /**
   * The key the query derives from this state, or `undefined` when it derives
   * nothing. Keyless (single-key) mutation targets resolve their key here at
   * dispatch, so the overlay follows the entry it was issued for.
   */
  readonly currentKey: (state: unknown) => string | undefined;
}

const INTERNALS = Symbol("katha.query.internals");

const internalsOf = (def: { readonly name: string }): QueryInternals => {
  const internals = (def as { [INTERNALS]?: QueryInternals })[INTERNALS];
  if (internals === undefined) {
    throw new Error(
      `Cannot target "${def.name}" from a mutation: it is not a defineQuery definition. ` +
        "Pass the object returned by defineQuery.",
    );
  }
  return internals;
};

/**
 * Register `mutation`'s overlays on a query definition, replacing any previous
 * registration for the same mutation name so re-evaluation cannot double-apply.
 * A mutation may register several overlays on one query (distinct keyed
 * targets); they are replaced as a set. Runs at module-definition time,
 * alongside wiring the mutation's process.
 */
const registerOverlays = (
  def: { readonly name: string },
  mutation: string,
  overlays: readonly QueryOverlay[],
): void => {
  const list = internalsOf(def).overlays;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].mutation === mutation) list.splice(i, 1);
  }
  list.push(...overlays);
};

// ---------------------------------------------------------------------------
// Outcome reporting (shared by the fetch and mutation processes)
// ---------------------------------------------------------------------------

/**
 * Report a fetch or run outcome. Typed failures and defects alike reach
 * `onFailure` — a rejected promise or a throw inside the effect must never
 * strand an entry or an intent in its in-flight phase — while interruption
 * reports nothing: the interrupter's own actions supersede this one.
 */
const reportExit = <A>(
  exit: Exit.Exit<A, unknown>,
  onSuccess: (value: A) => Effect.Effect<void>,
  onFailure: (error: string, detail: string) => Effect.Effect<void>,
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) return onSuccess(exit.value);
  if (Cause.isInterruptedOnly(exit.cause)) return Effect.void;
  return onFailure(String(Cause.squash(exit.cause)), Cause.pretty(exit.cause));
};

// ---------------------------------------------------------------------------
// defineQuery
// ---------------------------------------------------------------------------

interface QueryDefinitionBase<S extends { queries: QueriesState }> {
  readonly name: string;
  readonly process: <A extends Action>(
    ctx: StoreContext<S, A>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/** Definition returned by {@linkcode defineQuery} for single-key queries. */
export interface SingleQueryDefinition<T, S extends { queries: QueriesState }>
  extends QueryDefinitionBase<S> {
  readonly select: (state: S) => QueryState<T> | undefined;
  readonly selectByKey?: "Use .select() for single-key queries";
}

/** Definition returned by {@linkcode defineQuery} for multi-key queries. */
export interface MultiQueryDefinition<T, S extends { queries: QueriesState }>
  extends QueryDefinitionBase<S> {
  readonly select?: "Use .selectByKey(state, key) for multi-key queries";
  readonly selectByKey: (state: S, key: string) => QueryState<T> | undefined;
}

/**
 * Define a reactive query that automatically fetches when its derived inputs change.
 *
 * Return a single {@linkcode QueryEntry} (or `null`) for a single-key query,
 * or an array of entries for a multi-key query. The returned definition includes
 * a `process` that should be passed to {@linkcode makeStore}.
 */
export function defineQuery<T, S extends { queries: QueriesState }>(
  name: string,
  derive: (state: S) => QueryEntry<T> | null,
): SingleQueryDefinition<T, S>;
export function defineQuery<T, S extends { queries: QueriesState }>(
  name: string,
  derive: (state: S) => Array<QueryEntry<T>>,
): MultiQueryDefinition<T, S>;
export function defineQuery<T, S extends { queries: QueriesState }>(
  name: string,
  derive: (state: S) => QueryEntry<T> | Array<QueryEntry<T>> | null,
): SingleQueryDefinition<T, S> | MultiQueryDefinition<T, S> {
  const makeKey = (entryKey: string): string => `${name}:${entryKey}`;

  const normalise = (result: QueryEntry<T> | Array<QueryEntry<T>> | null): Array<QueryEntry<T>> => {
    if (result === null) return [];
    if (Array.isArray(result)) return result;
    return [result];
  };

  const overlays: QueryOverlay[] = [];

  /**
   * Fold pending optimistic intents over a cached entry, in dispatch order.
   * Both "pending" and "settling" intents apply — a settling overlay is held
   * until the refetched data replaces it. Zero-cost fast paths when nothing
   * is pending or the entry has no data. An overlay applies only to the key
   * its intent targets: a keyed overlay resolves that key from the variables,
   * a keyless one targets the key the query derived when the mutation was
   * dispatched.
   *
   * When an overlay applies, a fresh object is returned per call — the React
   * and Lit adapters deep-compare selector output, so this never causes
   * spurious re-renders there, but raw `subscribe` users comparing by
   * reference will see churn while intents are pending.
   */
  const applyOverlays = (
    state: S,
    base: QueryState<T> | undefined,
    key: string,
  ): QueryState<T> | undefined => {
    if (base?.data === undefined) return base;
    const intents = state.queries.overlays;
    if (intents.length === 0 || overlays.length === 0) return base;
    let data: T = base.data;
    let changed = false;
    for (const intent of intents) {
      for (const overlay of overlays) {
        if (overlay.mutation !== intent.mutation) continue;
        const targetKey = overlay.keyOf === undefined ? key : overlay.keyOf(intent.variables);
        if (targetKey !== key) continue;
        // The target must still be unconsumed on the intent — settling
        // removes targets as refetched data lands.
        if (!intent.targets.some((t) => t.query === name && t.key === key)) continue;
        data = overlay.apply(data, intent.variables) as T;
        changed = true;
      }
    }
    return changed ? { ...base, data } : base;
  };

  const currentKey = (state: S): string | undefined => normalise(derive(state))[0]?.key;

  const select = (state: S): QueryState<T> | undefined => {
    const key = currentKey(state);
    if (key === undefined) return undefined;
    return applyOverlays(
      state,
      state.queries.cache[makeKey(key)] as QueryState<T> | undefined,
      key,
    );
  };

  const selectByKey = (state: S, key: string): QueryState<T> | undefined =>
    applyOverlays(state, state.queries.cache[makeKey(key)] as QueryState<T> | undefined, key);

  const process = <A extends Action>(
    ctx: StoreContext<S, A>,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const inflight = yield* Ref.make(new Map<string, Fiber.RuntimeFiber<void, never>>());

      // Query actions (query-started, query-success, query-error) are always
      // part of the store's action union via queriesReducer in combineReducers.
      // The double cast is needed because A is generic — TS can't verify
      // QueriesAction ⊆ A at the definition site.
      const put = ctx.put as unknown as (a: QueriesAction) => Effect.Effect<void>;

      const removeFromInflight = (key: string) =>
        Ref.update(inflight, (m) => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });

      const doFetch = (key: string, fetchEffect: Effect.Effect<T, unknown, never>) =>
        Effect.gen(function* () {
          yield* put({
            id: "query-started",
            data: { queryId: key },
          });

          const exit = yield* fetchEffect.pipe(Effect.exit);

          yield* reportExit(
            exit,
            (data) =>
              put({
                id: "query-success",
                data: { queryId: key, result: data, dataUpdatedAt: Date.now() },
              }),
            (error, detail) =>
              Effect.gen(function* () {
                yield* Effect.logError(`Query ${key} failed: ${detail}`);
                yield* put({ id: "query-error", data: { queryId: key, error } });
              }),
          );
        }).pipe(Effect.ensuring(removeFromInflight(key)));

      /**
       * Reconciler. An entry is "fresh" when it exists and is not stale.
       * ┌────────┬──────────┬────────────────────────────────────────────────┐
       * │ entry  │ inflight │ action                                         │
       * ├────────┼──────────┼────────────────────────────────────────────────┤
       * │ fresh  │ no       │ skip — serve cached                           │
       * │ fresh  │ yes      │ skip — SWR refetch in progress                │
       * │ stale  │ no       │ fork background refetch (data retained)        │
       * │ stale  │ yes      │ interrupt (response predates invalidation),    │
       * │        │          │ refork                                         │
       * │ absent │ no       │ fork new fetch                                 │
       * │ absent │ yes      │ hard-invalidated mid-flight — interrupt,      │
       * │        │          │ refetch                                        │
       * └────────┴──────────┴────────────────────────────────────────────────┘
       */
      const reconcile = (state: S) =>
        Effect.gen(function* () {
          const entries = normalise(derive(state));
          const currentInflight = yield* Ref.get(inflight);

          // Only iterates current entries — fibers for keys no longer derived
          // (e.g. user navigated away) run to completion and warm the cache.
          for (const entry of entries) {
            const key = makeKey(entry.key);
            const cached = state.queries.cache[key];
            const fresh = cached !== undefined && !cached.isStale;
            const existingFiber = currentInflight.get(key);

            if (fresh) continue;

            if (existingFiber) {
              yield* Fiber.interrupt(existingFiber);
            }

            const fiber = yield* Effect.forkScoped(doFetch(key, entry.fetch));
            yield* Ref.update(inflight, (m) => new Map(m).set(key, fiber));
          }
        });

      yield* ctx.state.changes.pipe(Stream.runForEach(reconcile), Effect.forkScoped);
    });

  // The implementation has both select and selectByKey as real functions.
  // The overload signatures hide the wrong one behind a string literal type.
  // The internals ride along unexported so defineMutation can register
  // optimistic overlays against this definition at module-definition time and
  // resolve its current key at dispatch.
  // If you add properties to Single/MultiQueryDefinition, update the object above.
  const internals: QueryInternals = {
    overlays,
    currentKey: currentKey as (state: unknown) => string | undefined,
  };
  return { name, select, selectByKey, process, [INTERNALS]: internals } as unknown as
    | SingleQueryDefinition<T, S>
    | MultiQueryDefinition<T, S>;
}

// ---------------------------------------------------------------------------
// defineMutation
// ---------------------------------------------------------------------------

/**
 * Trigger action for a mutation — include it in your app's action union:
 *
 * ```ts
 * type AppAction = ActionsOf<typeof rootReducer> | MutationRunAction<"updateUser", Vars>;
 * ```
 */
export type MutationRunAction<Name extends string, V> = {
  readonly id: `${Name}/run`;
  readonly data: V;
};

/** Definition returned by {@linkcode defineMutation}. */
export interface MutationDefinition<V, S extends { queries: QueriesState }> {
  readonly name: string;
  /** Lifecycle of the most recent run — `status: "idle"` before the first. */
  readonly select: (state: S) => MutationState<V>;
  readonly process: <A extends Action>(
    ctx: StoreContext<S, A>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * Optimistic overlay descriptor for the multi-query escape hatch. Built with
 * {@linkcode onQuery} / {@linkcode onQueryKey}; prefer the `query` config
 * shorthand for the common single-target case.
 */
export interface OverlayDescriptor<V> {
  readonly query: { readonly name: string };
  readonly keyOf: ((variables: V) => string) | undefined;
  readonly apply: (data: unknown, variables: V) => unknown;
}

/** Overlay a single-key query from a multi-query mutation (escape hatch). */
export function onQuery<T, V>(
  // biome-ignore lint/suspicious/noExplicitAny: the app state type is irrelevant for overlay registration
  query: SingleQueryDefinition<T, any>,
  apply: (data: T, variables: V) => T,
): OverlayDescriptor<V> {
  return {
    query,
    keyOf: undefined,
    apply: apply as (data: unknown, variables: V) => unknown,
  };
}

/** Overlay one key of a multi-key query from a multi-query mutation (escape hatch). */
export function onQueryKey<T, V>(
  // biome-ignore lint/suspicious/noExplicitAny: the app state type is irrelevant for overlay registration
  query: MultiQueryDefinition<T, any>,
  keyOf: (variables: V) => string,
  apply: (data: T, variables: V) => T,
): OverlayDescriptor<V> {
  return {
    query: query as { readonly name: string },
    keyOf,
    apply: apply as (data: unknown, variables: V) => unknown,
  };
}

/** A query a mutation touches, before its key is resolved at dispatch. */
interface TouchedQuery<V> {
  readonly query: { readonly name: string };
  /** Set for keyed (multi-key) targets; keyless ones read the query's current key from state. */
  readonly keyOf: ((variables: V) => string) | undefined;
}

/**
 * Resolve what one run touches into plain data: the intent targets to overlay
 * and the invalidations to apply on success. A keyless touch whose query
 * currently derives nothing has no entry to overlay, so it yields no target
 * and goes stale name-level instead — whatever that query has cached is
 * behind the server either way.
 */
const resolveTouches = <V>(
  overlaid: ReadonlyArray<TouchedQuery<V>>,
  staleOnly: ReadonlyArray<TouchedQuery<V>>,
  extras: readonly string[],
  variables: V,
  currentKeys: Readonly<Record<string, string | undefined>>,
): {
  readonly targets: readonly IntentTarget[];
  readonly invalidations: readonly Invalidation[];
} => {
  const resolveKey = (t: TouchedQuery<V>): string | undefined =>
    t.keyOf !== undefined ? t.keyOf(variables) : currentKeys[t.query.name];
  const invalidationFor = (query: string, key: string | undefined): Invalidation =>
    key === undefined ? { query } : { query, key };

  const targets: IntentTarget[] = [];
  const invalidations: Invalidation[] = [];
  for (const t of overlaid) {
    const key = resolveKey(t);
    if (key !== undefined) targets.push({ query: t.query.name, key });
    invalidations.push(invalidationFor(t.query.name, key));
  }
  for (const t of staleOnly) invalidations.push(invalidationFor(t.query.name, resolveKey(t)));
  for (const query of extras) invalidations.push({ query });
  return { targets, invalidations };
};

interface MutationConfigBase<V> {
  /** The mutation effect. Its success value is unused; failures and defects alike become `mutation-error`. */
  readonly run: (variables: V) => Effect.Effect<unknown, unknown, never>;
  /**
   * Extra queries to soft-invalidate on success, by definition or name.
   * The overlay target query is always included automatically.
   */
  readonly invalidates?: ReadonlyArray<string | { readonly name: string }>;
  /**
   * `"every"` (default) — run every trigger concurrently; the overlay model
   * keeps interleaved mutations correct. `"leading"` — ignore triggers while
   * a run is in flight (double-submit protection). There is deliberately no
   * `"latest"`: interrupting an in-flight HTTP mutation does not un-send it.
   */
  readonly concurrency?: "every" | "leading";
}

/**
 * Define a mutation: a trigger action (`` `${name}/run` ``), lifecycle state in
 * `state.queries.mutations`, an optional optimistic overlay folded invisibly
 * into the target query's selectors while the mutation is in flight, and
 * declarative soft invalidation on success.
 *
 * The canonical cache is never optimistically written. On error the intent is
 * simply removed — the next select derives the pre-mutation view. On success
 * the overlay holds ("settling") until the refetched data lands; the reducer
 * releases it in the same action that writes the fresh data, so the optimistic
 * view hands off to server truth without a flash.
 *
 * Wire `updateUser.process(ctx)` into your root process alongside the query
 * processes, and add {@linkcode MutationRunAction} to your app action union.
 */
export function defineMutation<T, V, S extends { queries: QueriesState }>(
  name: string,
  config: MutationConfigBase<V> & {
    readonly query: SingleQueryDefinition<T, S>;
    readonly optimistic?: (data: T, variables: V) => T;
  },
): MutationDefinition<V, S>;
export function defineMutation<T, V, S extends { queries: QueriesState }>(
  name: string,
  config: MutationConfigBase<V> & {
    readonly query: MultiQueryDefinition<T, S>;
    /** Which key of the multi-key query this mutation targets. */
    readonly key: (variables: V) => string;
    readonly optimistic?: (data: T, variables: V) => T;
  },
): MutationDefinition<V, S>;
export function defineMutation<V, S extends { queries: QueriesState }>(
  name: string,
  config: MutationConfigBase<V> & {
    readonly optimistic?: ReadonlyArray<OverlayDescriptor<V>>;
  },
): MutationDefinition<V, S>;
export function defineMutation<T, V, S extends { queries: QueriesState }>(
  name: string,
  config: MutationConfigBase<V> & {
    readonly query?: SingleQueryDefinition<T, S> | MultiQueryDefinition<T, S>;
    readonly key?: (variables: V) => string;
    readonly optimistic?: ((data: T, variables: V) => T) | ReadonlyArray<OverlayDescriptor<V>>;
  },
): MutationDefinition<V, S> {
  // Desugar the query/key/optimistic shorthand into overlay descriptors.
  const descriptors: Array<OverlayDescriptor<V>> = [];
  if (config.query !== undefined && typeof config.optimistic === "function") {
    descriptors.push({
      query: config.query as unknown as { readonly name: string },
      keyOf: config.key,
      apply: config.optimistic as (data: unknown, variables: V) => unknown,
    });
  } else if (Array.isArray(config.optimistic)) {
    descriptors.push(...(config.optimistic as ReadonlyArray<OverlayDescriptor<V>>));
  }

  // Register each target query's overlays as a set, so a mutation with several
  // descriptors on one query keeps all of them (replace-by-mutation-name).
  const byQuery = new Map<{ readonly name: string }, QueryOverlay[]>();
  for (const d of descriptors) {
    const group = byQuery.get(d.query) ?? [];
    group.push({
      mutation: name,
      keyOf: d.keyOf as ((variables: unknown) => string) | undefined,
      apply: d.apply as (data: unknown, variables: unknown) => unknown,
    });
    byQuery.set(d.query, group);
  }
  for (const [queryDef, group] of byQuery) {
    registerOverlays(queryDef, name, group);
  }

  // What this mutation touches. Overlaid queries become intent targets and go
  // stale on success; the bare `query` (no optimistic function) and the
  // `invalidates` extras only go stale. Keys are resolved at dispatch.
  const overlaid: ReadonlyArray<TouchedQuery<V>> = descriptors;
  const staleOnly: ReadonlyArray<TouchedQuery<V>> =
    config.query !== undefined && typeof config.optimistic !== "function"
      ? [{ query: config.query as unknown as { readonly name: string }, keyOf: config.key }]
      : [];
  const extras: readonly string[] = (config.invalidates ?? []).map((inv) =>
    typeof inv === "string" ? inv : inv.name,
  );
  // Keyless touches read their query's current key from state at dispatch.
  // Resolving the internals here fails fast on a non-defineQuery target.
  const keyless = [...overlaid, ...staleOnly]
    .filter((t) => t.keyOf === undefined)
    .map((t) => ({ name: t.query.name, internals: internalsOf(t.query) }));

  const idle: MutationState<V> = {
    status: "idle",
    error: undefined,
    variables: undefined,
    submittedAt: undefined,
    intentId: undefined,
  };

  const select = (state: S): MutationState<V> =>
    (state.queries.mutations[name] as MutationState<V> | undefined) ?? idle;

  const process = <A extends Action>(
    ctx: StoreContext<S, A>,
  ): Effect.Effect<void, never, Scope.Scope> => {
    // Mutation lifecycle actions are always part of the store's action union
    // via queriesReducer in combineReducers; the trigger action is declared by
    // the app. The double casts are needed because A is generic — TS can't
    // verify the memberships at the definition site (same as the query process).
    const put = ctx.put as unknown as (a: QueriesAction) => Effect.Effect<void>;

    const handler = (action: { readonly data: V }) =>
      Effect.gen(function* () {
        const variables = action.data;
        const intentId = crypto.randomUUID();
        const state = yield* ctx.select();
        const currentKeys: Record<string, string | undefined> = Object.fromEntries(
          keyless.map((q) => [q.name, q.internals.currentKey(state)]),
        );
        const { targets, invalidations } = resolveTouches(
          overlaid,
          staleOnly,
          extras,
          variables,
          currentKeys,
        );

        yield* put({
          id: "mutation-started",
          data: { name, intentId, variables, targets, submittedAt: Date.now() },
        });

        const exit = yield* config.run(variables).pipe(Effect.exit);

        yield* reportExit(
          exit,
          // Settling and invalidation ride one action, so the reducer applies
          // them in one transition and no refetch can land between them.
          () => put({ id: "mutation-success", data: { name, intentId, invalidations } }),
          (error, detail) =>
            Effect.gen(function* () {
              yield* Effect.logError(`Mutation ${name} failed: ${detail}`);
              yield* put({ id: "mutation-error", data: { name, intentId, error } });
            }),
        );
      });

    type RunAction = { readonly id: string; readonly data: V };
    const inner = ctx as unknown as StoreContext<S, RunAction>;
    const combinator = config.concurrency === "leading" ? takeLeading : takeEvery;
    return combinator<S, RunAction, string, never>([`${name}/run`], handler)(inner);
  };

  return { name, select, process };
}
