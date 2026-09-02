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

import { Cause, Effect, Exit, Fiber, Option, PubSub, Queue, Ref, type Scope, Stream } from "effect";
import {
  type QueryOverlay,
  registerOverlays,
  registerQuery,
  requireQuery,
} from "./query-registry.ts";
import type { Reducer } from "./reducer.ts";
import type { Action, ActionOf, StoreContext } from "./types.ts";

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

/**
 * Lifecycle of a mutation's most recent run (per mutation name — latest call
 * wins). `intentId` identifies the run: completions of superseded runs are
 * ignored, so a newer run's lifecycle is never overwritten by an older one.
 */
export type MutationRun<V = unknown> =
  | {
      readonly status: "pending";
      readonly intentId: string;
      readonly variables: V;
      readonly submittedAt: number;
    }
  | {
      readonly status: "success";
      readonly intentId: string;
      readonly variables: V;
      readonly submittedAt: number;
    }
  | {
      readonly status: "error";
      readonly intentId: string;
      readonly variables: V;
      readonly submittedAt: number;
      readonly error: string;
    };

/**
 * What {@linkcode MutationDefinition.select} returns: `idle` before the first
 * run, otherwise the latest run. Narrow on `status` to reach the run's fields.
 */
export type MutationState<V = unknown> = { readonly status: "idle" } | MutationRun<V>;

/** Lifecycle status of a mutation. */
export type MutationStatus = MutationState["status"];

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
  /** Latest run per mutation name. Idle is the absence of an entry. */
  readonly mutations: Record<string, MutationRun>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Ids of the query actions, namespaced under `katha/` so they can never
 * collide with an app's own actions. Match on them in your processes:
 * `takeEvery([QueryActionId.success], ...)`.
 */
export const QueryActionId = {
  started: "katha/query/started",
  success: "katha/query/success",
  error: "katha/query/error",
  invalidate: "katha/query/invalidate",
} as const;

/** Ids of the mutation actions. `run` is the trigger a definition's `run(variables)` builds. */
export const MutationActionId = {
  run: "katha/mutation/run",
  started: "katha/mutation/started",
  success: "katha/mutation/success",
  error: "katha/mutation/error",
} as const;

/** Discriminated union of actions dispatched by the query process. */
export type QueriesAction =
  | { readonly id: typeof QueryActionId.started; readonly data: { readonly queryId: string } }
  | {
      readonly id: typeof QueryActionId.success;
      readonly data: {
        readonly queryId: string;
        readonly result: unknown;
        readonly dataUpdatedAt: number;
      };
    }
  | {
      readonly id: typeof QueryActionId.error;
      readonly data: { readonly queryId: string; readonly error: string };
    }
  | {
      readonly id: typeof QueryActionId.invalidate;
      readonly data: {
        readonly queryName: string;
        /** Restrict invalidation to the single entry `queryName:key`. Omit for all keys. */
        readonly key?: string;
        /** Keep data visible and refetch in the background instead of deleting the entry. */
        readonly soft?: boolean;
      };
    }
  | {
      readonly id: typeof MutationActionId.run;
      /** Trigger a run. Built by a mutation definition's `run(variables)`. */
      readonly data: { readonly name: string; readonly variables: unknown };
    }
  | {
      readonly id: typeof MutationActionId.started;
      readonly data: {
        readonly name: string;
        readonly intentId: string;
        readonly variables: unknown;
        readonly targets: readonly IntentTarget[];
        readonly submittedAt: number;
      };
    }
  | {
      readonly id: typeof MutationActionId.success;
      readonly data: {
        readonly name: string;
        readonly intentId: string;
        /** Applied in the same transition that settles the intent, so no refetch can land between. */
        readonly invalidations: readonly Invalidation[];
      };
    }
  | {
      readonly id: typeof MutationActionId.error;
      readonly data: { readonly name: string; readonly intentId: string; readonly error: string };
    };

/** Options for a query definition's `invalidate` (and {@linkcode invalidateQuery}). */
export interface InvalidateOptions {
  /** Invalidate the single entry `name:key` instead of every key of the query. */
  readonly key?: string;
  /** Keep data visible and refetch in the background instead of deleting the entry. */
  readonly soft?: boolean;
}

/** The action a query definition's `invalidate` builds. */
export type QueryInvalidateAction = ActionOf<QueriesAction, typeof QueryActionId.invalidate>;

/**
 * Build a `katha/query/invalidate` action by query name. Prefer the definition's
 * own `invalidate(options)` where you have it; this is for callers that only
 * hold the name (devtools).
 */
export const invalidateQuery = (
  queryName: string,
  options: InvalidateOptions = {},
): QueryInvalidateAction => ({ id: QueryActionId.invalidate, data: { queryName, ...options } });

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
 * `katha/query/error` consumes targets too: if the post-mutation refetch fails, the
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
    case QueryActionId.started: {
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
    case QueryActionId.success: {
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
    case QueryActionId.error: {
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
    case QueryActionId.invalidate: {
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
    case MutationActionId.started: {
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
          [name]: { status: "pending", intentId, variables, submittedAt },
        },
      };
    }
    case MutationActionId.success: {
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
                [name]: {
                  status: "success",
                  intentId,
                  variables: existing.variables,
                  submittedAt: existing.submittedAt,
                },
              }
            : state.mutations,
      };
    }
    case MutationActionId.error: {
      const { name, intentId, error } = action.data;
      const existing = state.mutations[name];
      return {
        ...state,
        // Rollback is removal: the canonical cache was never touched, so the
        // next select derives the pre-mutation view with nothing to restore.
        overlays: state.overlays.filter((intent) => intent.intentId !== intentId),
        mutations:
          existing !== undefined && existing.intentId === intentId
            ? {
                ...state.mutations,
                [name]: {
                  status: "error",
                  intentId,
                  variables: existing.variables,
                  submittedAt: existing.submittedAt,
                  error,
                },
              }
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
  /**
   * Build the action that invalidates this query — hard by default (entries
   * deleted, next reconcile refetches from loading), `soft: true` to keep
   * data visible while refetching. Plain data — dispatch it with `store.put`
   * or `ctx.put`.
   */
  readonly makeInvalidateAction: (options?: InvalidateOptions) => QueryInvalidateAction;
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

  const currentKey = (state: S): string | undefined => normalise(derive(state))[0]?.key;

  const makeInvalidateAction = (options?: InvalidateOptions): QueryInvalidateAction =>
    invalidateQuery(name, options);

  // Registered at definition time so defineMutation can attach overlays and
  // resolve this query's current key at dispatch. Read live by the selectors.
  const registration = registerQuery(name, currentKey as (state: unknown) => string | undefined);

  /**
   * Fold pending optimistic intents over a cached entry, in dispatch order.
   * Both "pending" and "settling" intents apply — a settling overlay is held
   * until the refetched data replaces it. Zero-cost fast paths when nothing
   * is pending or the entry has no data. An intent applies only while it still
   * targets this entry (settling consumes targets as refetched data lands);
   * within an intent, a keyed overlay applies only to the key it resolves
   * from the variables, a keyless one to the key the intent recorded.
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
    if (intents.length === 0 || registration.overlays.size === 0) return base;
    let data: T = base.data;
    let changed = false;
    for (const intent of intents) {
      if (!intent.targets.some((t) => t.query === name && t.key === key)) continue;
      const overlays = registration.overlays.get(intent.mutation);
      if (overlays === undefined) continue;
      for (const overlay of overlays) {
        if (overlay.keyOf !== undefined && overlay.keyOf(intent.variables) !== key) continue;
        data = overlay.apply(data, intent.variables) as T;
        changed = true;
      }
    }
    return changed ? { ...base, data } : base;
  };

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

      // Query actions (katha/query/started, katha/query/success, katha/query/error) are always
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
            id: QueryActionId.started,
            data: { queryId: key },
          });

          const exit = yield* fetchEffect.pipe(Effect.exit);

          yield* reportExit(
            exit,
            (data) =>
              put({
                id: QueryActionId.success,
                data: { queryId: key, result: data, dataUpdatedAt: Date.now() },
              }),
            (error, detail) =>
              Effect.gen(function* () {
                yield* Effect.logError(`Query ${key} failed: ${detail}`);
                yield* put({ id: QueryActionId.error, data: { queryId: key, error } });
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
  // If you add properties to Single/MultiQueryDefinition, update the object above.
  return { name, select, selectByKey, makeInvalidateAction, process } as unknown as
    | SingleQueryDefinition<T, S>
    | MultiQueryDefinition<T, S>;
}

// ---------------------------------------------------------------------------
// defineMutation
// ---------------------------------------------------------------------------

/**
 * Trigger action for a mutation, built by the definition's `makeAction(variables)`.
 * A {@linkcode QueriesAction} narrowed to one mutation — it is already in
 * your app's action union through `queriesReducer`, so nothing to declare.
 */
export type MutationRunAction<Name extends string, V> = {
  readonly id: typeof MutationActionId.run;
  readonly data: { readonly name: Name; readonly variables: V };
};

const isRunOf = (action: Action, name: string): action is MutationRunAction<string, unknown> =>
  action.id === MutationActionId.run &&
  (action as MutationRunAction<string, unknown>).data?.name === name;

/**
 * Listen for one mutation's runs and fork `handler` per run under the
 * concurrency policy. Every mutation shares the `katha/mutation/run` id and is told
 * apart by `data.name`, so matching happens on the payload here rather than
 * through `takeEvery` / `takeLeading` — those match on id alone, and a
 * `"leading"` gate over the shared id would block unrelated mutations. If a
 * second payload-matched listener appears, lift a predicate combinator into
 * combinators.ts instead of copying this.
 */
const onMutationRun = <S, A extends Action>(
  ctx: StoreContext<S, A>,
  name: string,
  concurrency: "every" | "leading",
  handler: (variables: unknown) => Effect.Effect<void>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* PubSub.subscribe(ctx.actions);
    let inflight: Fiber.Fiber<void> | null = null;
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const action = yield* Queue.take(queue);
          if (!isRunOf(action, name)) return;
          if (concurrency === "leading" && inflight !== null) {
            const exit = yield* Fiber.poll(inflight);
            if (Option.isNone(exit)) return; // still running — drop this trigger
          }
          inflight = yield* Effect.forkScoped(handler(action.data.variables));
        }),
      ),
    );
  });

/** Definition returned by {@linkcode defineMutation}. */
export interface MutationDefinition<Name extends string, V, S extends { queries: QueriesState }> {
  readonly name: Name;
  /** Build the trigger action for a run — plain data. Dispatch it with `store.put` or `ctx.put`. */
  readonly makeAction: (variables: V) => MutationRunAction<Name, V>;
  /** Lifecycle of the most recent run — `status: "idle"` before the first. */
  readonly select: (state: S) => MutationState<V>;
  readonly process: <A extends Action>(
    ctx: StoreContext<S, A>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * Which cache entries of a query a {@linkcode MutationTarget} covers.
 * - `"every"` — all cached keys of the query. Invalidation only.
 * - `"current"` — the key the query derives from state at dispatch, so the
 *   overlay follows the entry it was issued for (single-key queries).
 * - a function — the key resolved from the run's variables (multi-key queries).
 */
export type TargetKey<V> = "every" | "current" | ((variables: V) => string);

/**
 * One query a mutation touches: soft-invalidated on success and, when
 * `overlay` is set, overlaid optimistically while the run is in flight. An
 * `"every"` target has no single entry to overlay, so it carries none.
 * Built by {@linkcode onQuery} / {@linkcode onQueryKey}, or desugared from the
 * `query` / `key` / `optimistic` / `invalidates` config by
 * {@linkcode mutationTargets}.
 */
export type MutationTarget<V> =
  | { readonly query: string; readonly key: "every" }
  | {
      readonly query: string;
      readonly key: "current" | ((variables: V) => string);
      readonly overlay?: (data: unknown, variables: V) => unknown;
    };

/** Overlay a single-key query from a multi-query mutation (escape hatch). */
export function onQuery<T, V>(
  // biome-ignore lint/suspicious/noExplicitAny: the app state type is irrelevant for overlay registration
  query: SingleQueryDefinition<T, any>,
  apply: (data: T, variables: V) => T,
): MutationTarget<V> {
  return {
    query: query.name,
    key: "current",
    overlay: apply as (data: unknown, variables: V) => unknown,
  };
}

/** Overlay one key of a multi-key query from a multi-query mutation (escape hatch). */
export function onQueryKey<T, V>(
  // biome-ignore lint/suspicious/noExplicitAny: the app state type is irrelevant for overlay registration
  query: MultiQueryDefinition<T, any>,
  keyOf: (variables: V) => string,
  apply: (data: T, variables: V) => T,
): MutationTarget<V> {
  return {
    query: query.name,
    key: keyOf,
    overlay: apply as (data: unknown, variables: V) => unknown,
  };
}

/** The config→data step of {@linkcode defineMutation}, shared by every overload. */
export interface MutationTargetsConfig<V> {
  readonly query?: { readonly name: string };
  readonly key?: (variables: V) => string;
  readonly optimistic?: ((data: never, variables: V) => unknown) | ReadonlyArray<MutationTarget<V>>;
  readonly invalidates?: ReadonlyArray<string | { readonly name: string }>;
}

/**
 * Desugar a mutation config into the targets it touches, in order: the
 * primary `query` (keyed by `key`, else by the query's current key at
 * dispatch, overlaid when `optimistic` is a function), then any explicit
 * `optimistic` targets, then the `invalidates` extras — every key of each,
 * stale-only.
 */
export const mutationTargets = <V>(
  config: MutationTargetsConfig<V>,
): readonly MutationTarget<V>[] => {
  const primary: readonly MutationTarget<V>[] =
    config.query === undefined
      ? []
      : typeof config.optimistic === "function"
        ? [
            {
              query: config.query.name,
              key: config.key ?? "current",
              overlay: config.optimistic as (data: unknown, variables: V) => unknown,
            },
          ]
        : [{ query: config.query.name, key: config.key ?? "current" }];
  const explicit = Array.isArray(config.optimistic) ? config.optimistic : [];
  const extras = (config.invalidates ?? []).map(
    (inv): MutationTarget<V> => ({ query: typeof inv === "string" ? inv : inv.name, key: "every" }),
  );
  return [...primary, ...explicit, ...extras];
};

/**
 * Resolve a run's targets into plain data for the intent: the entries to
 * overlay and the invalidations to apply on success. `currentKeys` holds the
 * key each `"current"` target's query derives right now; a query that derives
 * nothing has no entry to overlay, so it yields no intent target and goes
 * stale name-level instead — whatever it has cached is behind the server
 * either way.
 */
export const resolveTargets = <V>(
  targets: readonly MutationTarget<V>[],
  variables: V,
  currentKeys: Readonly<Record<string, string | undefined>>,
): {
  readonly targets: readonly IntentTarget[];
  readonly invalidations: readonly Invalidation[];
} => {
  const intentTargets: IntentTarget[] = [];
  const invalidations: Invalidation[] = [];
  for (const target of targets) {
    if (target.key === "every") {
      invalidations.push({ query: target.query });
      continue;
    }
    const key =
      typeof target.key === "function" ? target.key(variables) : currentKeys[target.query];
    if (key === undefined) {
      invalidations.push({ query: target.query });
      continue;
    }
    invalidations.push({ query: target.query, key });
    if (target.overlay !== undefined) intentTargets.push({ query: target.query, key });
  }
  return { targets: intentTargets, invalidations };
};

interface MutationConfigBase<V> {
  /** The mutation effect. Its success value is unused; failures and defects alike become `katha/mutation/error`. */
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
 * Define a mutation: a trigger action built by `makeAction(variables)`, lifecycle state in
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
 * processes. The trigger is a {@linkcode QueriesAction}, so `queriesReducer`
 * already puts it in your app's action union.
 */
export function defineMutation<Name extends string, T, V, S extends { queries: QueriesState }>(
  name: Name,
  config: MutationConfigBase<V> & {
    readonly query: SingleQueryDefinition<T, S>;
    readonly optimistic?: (data: T, variables: V) => T;
  },
): MutationDefinition<Name, V, S>;
export function defineMutation<Name extends string, T, V, S extends { queries: QueriesState }>(
  name: Name,
  config: MutationConfigBase<V> & {
    readonly query: MultiQueryDefinition<T, S>;
    /** Which key of the multi-key query this mutation targets. */
    readonly key: (variables: V) => string;
    readonly optimistic?: (data: T, variables: V) => T;
  },
): MutationDefinition<Name, V, S>;
export function defineMutation<Name extends string, V, S extends { queries: QueriesState }>(
  name: Name,
  config: MutationConfigBase<V> & {
    readonly optimistic?: ReadonlyArray<MutationTarget<V>>;
  },
): MutationDefinition<Name, V, S>;
export function defineMutation<Name extends string, T, V, S extends { queries: QueriesState }>(
  name: Name,
  config: MutationConfigBase<V> & {
    readonly query?: SingleQueryDefinition<T, S> | MultiQueryDefinition<T, S>;
    readonly key?: (variables: V) => string;
    readonly optimistic?: ((data: T, variables: V) => T) | ReadonlyArray<MutationTarget<V>>;
  },
): MutationDefinition<Name, V, S> {
  const targets = mutationTargets<V>(config);

  // Register this mutation's overlays on each query it overlays, as a set per
  // query (replace-by-mutation-name, so re-evaluation cannot double-apply).
  const overlaysByQuery = new Map<string, QueryOverlay[]>();
  for (const target of targets) {
    if (target.key === "every" || target.overlay === undefined) continue;
    const group = overlaysByQuery.get(target.query) ?? [];
    group.push({
      keyOf:
        typeof target.key === "function"
          ? (target.key as (variables: unknown) => string)
          : undefined,
      apply: target.overlay as (data: unknown, variables: unknown) => unknown,
    });
    overlaysByQuery.set(target.query, group);
  }
  for (const [query, overlays] of overlaysByQuery) registerOverlays(query, name, overlays);

  // `"current"` targets read their query's key from state at dispatch.
  // Looking the query up here fails fast on an unregistered target.
  const current = targets
    .filter((t) => t.key === "current")
    .map((t) => ({ query: t.query, registration: requireQuery(t.query) }));

  const makeAction = (variables: V): MutationRunAction<Name, V> => ({
    id: MutationActionId.run,
    data: { name, variables },
  });

  const idle: MutationState<V> = { status: "idle" };

  const select = (state: S): MutationState<V> =>
    (state.queries.mutations[name] as MutationRun<V> | undefined) ?? idle;

  const process = <A extends Action>(
    ctx: StoreContext<S, A>,
  ): Effect.Effect<void, never, Scope.Scope> => {
    // Mutation actions are always part of the store's action union via
    // queriesReducer in combineReducers. The double cast is needed because A
    // is generic — TS can't verify the membership at the definition site
    // (same as the query process).
    const put = ctx.put as unknown as (a: QueriesAction) => Effect.Effect<void>;

    const handler = (variables: V) =>
      Effect.gen(function* () {
        const intentId = crypto.randomUUID();
        const state = yield* ctx.select();
        const currentKeys: Record<string, string | undefined> = Object.fromEntries(
          current.map((c) => [c.query, c.registration.currentKey(state)]),
        );
        const run = resolveTargets(targets, variables, currentKeys);

        yield* put({
          id: MutationActionId.started,
          data: { name, intentId, variables, targets: run.targets, submittedAt: Date.now() },
        });

        const exit = yield* config.run(variables).pipe(Effect.exit);

        yield* reportExit(
          exit,
          // Settling and invalidation ride one action, so the reducer applies
          // them in one transition and no refetch can land between them.
          () =>
            put({
              id: MutationActionId.success,
              data: { name, intentId, invalidations: run.invalidations },
            }),
          (error, detail) =>
            Effect.gen(function* () {
              yield* Effect.logError(`Mutation ${name} failed: ${detail}`);
              yield* put({ id: MutationActionId.error, data: { name, intentId, error } });
            }),
        );
      });

    return onMutationRun(ctx, name, config.concurrency ?? "every", (variables) =>
      handler(variables as V),
    );
  };

  return { name, makeAction, select, process };
}
