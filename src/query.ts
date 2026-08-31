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

import { Effect, Either, Fiber, Ref, type Scope, Stream } from "effect";
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

/** A query entry targeted by an optimistic intent. `key` is set for keyed overlays. */
export interface IntentTarget {
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
      readonly data: { readonly name: string; readonly intentId: string };
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

/** Does an intent target cover this cache key? Keyed targets match exactly. */
const targetMatches = (target: IntentTarget, queryId: string): boolean =>
  target.key !== undefined
    ? queryId === `${target.query}:${target.key}`
    : queryId === target.query || queryId.startsWith(`${target.query}:`);

/**
 * Fresh data landed for `queryId` — drop the consumed targets from settling
 * intents, and drop intents with no targets left. Pending intents are left
 * alone: their mutation hasn't succeeded yet, so this data predates them.
 *
 * Two deliberate consequences. (1) `query-error` consumes targets too: if the
 * post-mutation refetch fails, the overlay is released and canonical (older)
 * data shows with the entry's error — fail toward truth; re-invalidate to
 * retry. (2) A refetch forked *before* the mutation succeeded can, in a very
 * narrow window, land after settling and consume the overlay with
 * pre-mutation data; the stale-flag preservation on `query-success` plus the
 * reconciler's interrupt-on-stale make the window fiber-interleaving-sized,
 * and the accepted worst case is a brief flash healed by the refetch.
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
    const remaining = intent.targets.filter((t) => !targetMatches(t, queryId));
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
      const existing = state.cache[action.data.queryId];
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.data.queryId]: {
            status: "success" as const,
            data: action.data.result,
            error: undefined,
            isFetching: false,
            // Preserve staleness rather than clearing it: if a soft invalidate
            // landed while this fetch was in flight, the response predates the
            // invalidation — keeping the flag makes the reconciler refetch.
            isStale: existing?.isStale ?? false,
            dataUpdatedAt: action.data.dataUpdatedAt,
          },
        },
        // Same action writes fresh data AND releases the settling overlay —
        // the optimistic view hands off to server truth with no frame between.
        overlays: settleOverlays(state.overlays, action.data.queryId),
      };
    }
    case "query-error": {
      const existing = state.cache[action.data.queryId];
      return {
        ...state,
        cache: {
          ...state.cache,
          [action.data.queryId]: {
            status: "error" as const,
            data: existing?.data,
            error: action.data.error,
            isFetching: false,
            isStale: existing?.isStale ?? false,
            dataUpdatedAt: existing?.dataUpdatedAt,
          },
        },
        overlays: settleOverlays(state.overlays, action.data.queryId),
      };
    }
    case "query-invalidate": {
      const { queryName, key, soft } = action.data;
      const matches = (cacheKey: string): boolean =>
        key !== undefined
          ? cacheKey === `${queryName}:${key}`
          : cacheKey === queryName || cacheKey.startsWith(`${queryName}:`);
      if (soft) {
        let changed = false;
        const next: Record<string, QueryState<unknown>> = {};
        for (const [cacheKey, value] of Object.entries(state.cache)) {
          if (matches(cacheKey) && !value.isStale) {
            next[cacheKey] = { ...value, isStale: true };
            changed = true;
          } else {
            next[cacheKey] = value;
          }
        }
        return changed ? { ...state, cache: next } : undefined;
      }
      let removed = false;
      const filtered: Record<string, QueryState<unknown>> = {};
      for (const [cacheKey, value] of Object.entries(state.cache)) {
        if (matches(cacheKey)) {
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
      const { name, intentId } = action.data;
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
        const cacheKeys = Object.keys(state.cache);
        const live = intent.targets.filter((t) => cacheKeys.some((k) => targetMatches(t, k)));
        if (live.length > 0) {
          nextOverlays.push({ ...intent, phase: "settling", targets: live });
        }
      }
      return {
        ...state,
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
 * Non-exported symbol carrying each query definition's overlay list. The
 * channel between defineQuery and defineMutation is module-private — no
 * public API surface exists for it.
 */
const OVERLAYS = Symbol("katha.query.overlays");

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
  const list = (def as { [OVERLAYS]?: QueryOverlay[] })[OVERLAYS];
  if (list === undefined) {
    throw new Error(
      `Cannot register an optimistic overlay: "${def.name}" is not a defineQuery definition`,
    );
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].mutation === mutation) list.splice(i, 1);
  }
  list.push(...overlays);
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
   * is pending or the entry has no data. Keyed targets apply only when the
   * read resolves their key; keyless targets apply to every key of the query.
   *
   * When an overlay applies, a fresh object is returned per call — the React
   * and Lit adapters deep-compare selector output, so this never causes
   * spurious re-renders there, but raw `subscribe` users comparing by
   * reference will see churn while intents are pending.
   */
  const applyOverlays = (
    state: S,
    base: QueryState<T> | undefined,
    currentKey: string,
  ): QueryState<T> | undefined => {
    if (base?.data === undefined) return base;
    const intents = state.queries.overlays;
    if (intents.length === 0 || overlays.length === 0) return base;
    let data: T = base.data;
    let changed = false;
    for (const intent of intents) {
      for (const overlay of overlays) {
        if (overlay.mutation !== intent.mutation) continue;
        const targetKey = overlay.keyOf?.(intent.variables);
        // The overlay's target must still be unconsumed on the intent —
        // settling removes targets as refetched data lands — and a keyed
        // overlay applies only when the read resolves its key.
        const present = intent.targets.some((t) => t.query === name && t.key === targetKey);
        if (!present) continue;
        if (targetKey !== undefined && targetKey !== currentKey) continue;
        data = overlay.apply(data, intent.variables) as T;
        changed = true;
      }
    }
    return changed ? { ...base, data } : base;
  };

  const select = (state: S): QueryState<T> | undefined => {
    const entries = normalise(derive(state));
    if (entries.length === 0) return undefined;
    const entryKey = entries[0].key;
    const base = state.queries.cache[makeKey(entryKey)] as QueryState<T> | undefined;
    return applyOverlays(state, base, entryKey);
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

          const result = yield* fetchEffect.pipe(Effect.either);

          yield* Either.match(result, {
            onRight: (data) =>
              put({
                id: "query-success",
                data: { queryId: key, result: data, dataUpdatedAt: Date.now() },
              }),
            onLeft: (error) =>
              Effect.gen(function* () {
                const errorMsg = String(error);
                yield* Effect.logError(`Query ${key} failed: ${errorMsg}`);
                yield* put({
                  id: "query-error",
                  data: { queryId: key, error: errorMsg },
                });
              }),
          });
          yield* removeFromInflight(key);
        }).pipe(Effect.onInterrupt(() => removeFromInflight(key)));

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
  // The OVERLAYS list rides along unexported so defineMutation can register
  // optimistic overlays against this definition at module-definition time.
  // If you add properties to Single/MultiQueryDefinition, update the object above.
  return { name, select, selectByKey, process, [OVERLAYS]: overlays } as unknown as
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

interface MutationConfigBase<V> {
  /** The mutation effect. Its success value is unused; failures become `mutation-error`. */
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

  // What to soft-invalidate on success: every overlay target, the `query`
  // target even when it has no optimistic function, and the `invalidates`
  // extras (name-level). Keys are resolved from variables at dispatch time.
  const invalidateSpecs: Array<{
    readonly query: string;
    readonly keyOf?: (variables: V) => string;
  }> = descriptors.map((d) => ({ query: d.query.name, keyOf: d.keyOf }));
  if (config.query !== undefined && typeof config.optimistic !== "function") {
    invalidateSpecs.push({ query: config.query.name, keyOf: config.key });
  }
  for (const inv of config.invalidates ?? []) {
    invalidateSpecs.push({ query: typeof inv === "string" ? inv : inv.name });
  }

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
        const targets: IntentTarget[] = descriptors.map((d) =>
          d.keyOf === undefined
            ? { query: d.query.name }
            : { query: d.query.name, key: d.keyOf(variables) },
        );

        yield* put({
          id: "mutation-started",
          data: { name, intentId, variables, targets, submittedAt: Date.now() },
        });

        const result = yield* config.run(variables).pipe(Effect.either);

        yield* Either.match(result, {
          onRight: () =>
            Effect.gen(function* () {
              // Settle the intent BEFORE invalidating, so no refetch can
              // complete while the intent is still in its pending phase.
              yield* put({ id: "mutation-success", data: { name, intentId } });

              // One soft invalidate per distinct queryName|key pair. Keyed
              // specs invalidate a single entry; extras are name-level.
              const seen = new Set<string>();
              for (const spec of invalidateSpecs) {
                const key = spec.keyOf?.(variables);
                const pair = `${spec.query}|${key ?? ""}`;
                if (seen.has(pair)) continue;
                seen.add(pair);
                yield* put({
                  id: "query-invalidate",
                  data:
                    key === undefined
                      ? { queryName: spec.query, soft: true }
                      : { queryName: spec.query, key, soft: true },
                });
              }
            }),
          onLeft: (error) =>
            Effect.gen(function* () {
              const errorMsg = String(error);
              yield* Effect.logError(`Mutation ${name} failed: ${errorMsg}`);
              yield* put({ id: "mutation-error", data: { name, intentId, error: errorMsg } });
            }),
        });
      });

    type RunAction = { readonly id: string; readonly data: V };
    const inner = ctx as unknown as StoreContext<S, RunAction>;
    const combinator = config.concurrency === "leading" ? takeLeading : takeEvery;
    return combinator<S, RunAction, string, never>([`${name}/run`], handler)(inner);
  };

  return { name, select, process };
}
