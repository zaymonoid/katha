/**
 * Declarative data-fetching layer built on katha stores.
 *
 * Define queries with {@linkcode defineQuery}, wire the provided
 * {@linkcode queriesReducer} into your store via `combineReducers`, and the
 * query process handles fetch orchestration, caching, and invalidation
 * automatically.
 *
 * @module
 */

import { Effect, Either, Fiber, Ref, type Scope, Stream } from "effect";
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
          [name]: { status: "pending", error: undefined, variables, submittedAt },
        },
      };
    }
    case "mutation-success": {
      const { name, intentId } = action.data;
      const existing = state.mutations[name];
      return {
        ...state,
        overlays: state.overlays.map((intent) =>
          intent.intentId === intentId ? { ...intent, phase: "settling" as const } : intent,
        ),
        mutations: {
          ...state.mutations,
          [name]: {
            status: "success",
            error: undefined,
            variables: existing?.variables,
            submittedAt: existing?.submittedAt,
          },
        },
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
        mutations: {
          ...state.mutations,
          [name]: {
            status: "error",
            error,
            variables: existing?.variables,
            submittedAt: existing?.submittedAt,
          },
        },
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

  const select = (state: S): QueryState<T> | undefined => {
    const entries = normalise(derive(state));
    if (entries.length === 0) return undefined;
    const key = makeKey(entries[0].key);
    return state.queries.cache[key] as QueryState<T> | undefined;
  };

  const selectByKey = (state: S, key: string): QueryState<T> | undefined =>
    state.queries.cache[makeKey(key)] as QueryState<T> | undefined;

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
  // If you add properties to Single/MultiQueryDefinition, update the object above.
  return { name, select, selectByKey, process } as unknown as
    | SingleQueryDefinition<T, S>
    | MultiQueryDefinition<T, S>;
}
