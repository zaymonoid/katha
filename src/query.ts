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
 * the intent (error — rollback is removal, the cache was never touched) and
 * soft-invalidates its targets. While an intent is open on an entry, fetch
 * responses for it are discarded; the refetch after the intent exits is the
 * first one trusted.
 *
 * @module
 */

import {
  Cause,
  Effect,
  Exit,
  Fiber,
  PubSub,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { forkHandler, isolateDeduped } from "./defects.ts";
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
 * One cache entry (`cache[query][key]`) an optimistic intent applies to and, after
 * success, waits on. Every target is keyed: keyed overlays resolve the key
 * from the variables, keyless ones from the key the query derived at dispatch
 * — so an overlay follows the entry it was issued for, not whichever key the
 * query derives later.
 */
export interface IntentTarget {
  readonly query: string;
  readonly key: string;
}

/** A soft invalidation: the single entry `cache[query][key]` when `key` is set, otherwise every key of `query`. */
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
 * never touched by optimism (a response that may already include an open
 * intent's write is discarded, not written); `overlays` holds pending
 * optimistic intents that {@linkcode defineQuery} selectors fold over cached
 * data invisibly; `mutations` holds per-name mutation lifecycle state.
 */
export interface QueriesState {
  /**
   * Entries by query name, then key: `cache[name][key]`. Nested rather than
   * joined into one string, so no character is reserved in names or keys and
   * a name-level invalidation is structural. A name with no entries left is
   * removed, so every inner record is non-empty.
   */
  readonly cache: Record<string, Record<string, QueryState<unknown>>>;
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

/** Ids of the mutation actions. `run` is the trigger a definition's `makeAction(variables)` builds. */
export const MutationActionId = {
  run: "katha/mutation/run",
  started: "katha/mutation/started",
  success: "katha/mutation/success",
  error: "katha/mutation/error",
} as const;

/**
 * Discriminated union of actions dispatched by the query process. Fetch
 * lifecycle actions address their entry as an {@linkcode IntentTarget}:
 * `{ query, key }`, the entry `cache[query][key]`.
 */
export type QueriesAction =
  | {
      readonly id: typeof QueryActionId.started;
      readonly data: { readonly query: string; readonly key: string };
    }
  | {
      readonly id: typeof QueryActionId.success;
      readonly data: {
        readonly query: string;
        readonly key: string;
        readonly result: unknown;
        readonly dataUpdatedAt: number;
      };
    }
  | {
      readonly id: typeof QueryActionId.error;
      readonly data: { readonly query: string; readonly key: string; readonly error: string };
    }
  | {
      readonly id: typeof QueryActionId.invalidate;
      readonly data: {
        readonly query: string;
        /** Restrict invalidation to the single entry `cache[query][key]`. Omit for all keys. */
        readonly key?: string;
        /** Keep data visible and refetch in the background instead of deleting the entry. */
        readonly soft?: boolean;
      };
    }
  | {
      readonly id: typeof MutationActionId.run;
      /** Trigger a run. Built by a mutation definition's `makeAction(variables)`. */
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

/** Options for a query definition's `makeInvalidateAction` (and {@linkcode invalidateQuery}). */
export interface InvalidateOptions {
  /** Invalidate the single entry `cache[name][key]` instead of every key of the query. */
  readonly key?: string;
  /** Keep data visible and refetch in the background instead of deleting the entry. */
  readonly soft?: boolean;
}

/** The action a query definition's `makeInvalidateAction` builds. */
export type QueryInvalidateAction = ActionOf<QueriesAction, typeof QueryActionId.invalidate>;

/**
 * Build a `katha/query/invalidate` action by query name. Prefer the definition's
 * own `makeInvalidateAction(options)` where you have it; this is for callers that only
 * hold the name (devtools).
 */
export const invalidateQuery = (
  query: string,
  options: InvalidateOptions = {},
): QueryInvalidateAction => ({ id: QueryActionId.invalidate, data: { query, ...options } });

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Empty initial state for the queries slice. */
export const initialQueriesState: QueriesState = { cache: {}, overlays: [], mutations: {} };

type QueryCache = QueriesState["cache"];

/**
 * Own-property read. Query names and keys are arbitrary strings, so a lookup
 * must never fall through to the prototype (`"constructor"`, `"toString"`).
 */
const own = <V>(record: Readonly<Record<string, V>>, k: string): V | undefined =>
  Object.hasOwn(record, k) ? record[k] : undefined;

/** `record` without `k`. */
const omit = <V>(record: Readonly<Record<string, V>>, k: string): Record<string, V> => {
  const { [k]: _, ...rest } = record;
  return rest;
};

/** Do two targets address the same cache entry? */
const sameEntry = (a: IntentTarget, b: IntentTarget): boolean =>
  a.query === b.query && a.key === b.key;

/** The cache entry `target` addresses, if any. */
const entryOf = (cache: QueryCache, target: IntentTarget): QueryState<unknown> | undefined => {
  const byKey = own(cache, target.query);
  return byKey === undefined ? undefined : own(byKey, target.key);
};

/** `cache` with the entry `target` addresses set to `entry`. */
const withEntry = (
  cache: QueryCache,
  target: IntentTarget,
  entry: QueryState<unknown>,
): QueryCache => ({
  ...cache,
  [target.query]: { ...own(cache, target.query), [target.key]: entry },
});

/**
 * Mark every covered entry stale — keyed invalidations one entry, name-level
 * ones every key of the name. Returns the same cache when nothing changed.
 */
const markStale = (cache: QueryCache, invalidations: readonly Invalidation[]): QueryCache => {
  let next = cache;
  for (const inv of invalidations) {
    const byKey = own(next, inv.query);
    if (byKey === undefined) continue;
    const covers = (key: string, entry: QueryState<unknown>): boolean =>
      !entry.isStale && (inv.key === undefined || key === inv.key);
    const entries = Object.entries(byKey);
    if (!entries.some(([key, entry]) => covers(key, entry))) continue;
    next = {
      ...next,
      [inv.query]: Object.fromEntries(
        entries.map(([key, entry]) => [
          key,
          covers(key, entry) ? { ...entry, isStale: true } : entry,
        ]),
      ),
    };
  }
  return next;
};

/**
 * Fresh data landed for `target` — drop the consumed target from settling
 * intents, and drop intents with no targets left. Pending intents are left
 * alone: their mutation hasn't succeeded yet, so they stay folded.
 *
 * `katha/query/error` consumes targets too: if the post-mutation refetch fails, the
 * overlay is released and the last trusted data (read before the mutation, so
 * without its write) shows with the entry's error — fail toward truth;
 * re-invalidate to retry. Only a `"fresh"` response settles.
 */
const settleOverlays = (
  overlays: readonly OverlayIntent[],
  target: IntentTarget,
): readonly OverlayIntent[] => {
  let changed = false;
  const next: OverlayIntent[] = [];
  for (const intent of overlays) {
    if (intent.phase !== "settling") {
      next.push(intent);
      continue;
    }
    const remaining = intent.targets.filter((t) => !sameEntry(t, target));
    if (remaining.length === intent.targets.length) {
      next.push(intent);
    } else {
      changed = true;
      if (remaining.length > 0) next.push({ ...intent, targets: remaining });
    }
  }
  return changed ? next : overlays;
};

/** Does `intent` target the cache entry `target`? */
const hasTarget = (intent: OverlayIntent, target: IntentTarget): boolean =>
  intent.targets.some((t) => sameEntry(t, target));

/**
 * What a fetch response for an entry is, decided by `classifyResponse`.
 * - `"fresh"` — trusted and current: written, and it settles the entry's
 *   settling overlays in the same action.
 * - `"stale"` — trusted but predates an invalidation: written, kept stale so
 *   the reconciler refetches, settles nothing.
 * - `"untrusted"` — discarded, because an intent is open on the entry and the
 *   response may already include a write the overlay would count again.
 *   Nothing is written, recorded or settled; the intent's exit soft-invalidates
 *   the entry, and the refetch after it is `"fresh"`.
 */
type ResponseKind = "fresh" | "stale" | "untrusted";

/**
 * Classify a response for `target`. A response can't tell whether it read the
 * server before or after a mutation's write, so it is discarded while an
 * intent is open on the entry: any pending intent (the write can happen at any
 * point while pending, so neither a fetch already in flight nor one started
 * since is safe), or a settling one when the response predates the success
 * invalidation (it was in flight across the write).
 *
 * An entry with no data follows the same rule: a first load, or a load after
 * a hard invalidate, landing while an intent is open is discarded, so the
 * entry stays loading until the intent exits and its refetch lands. Writing it
 * would let the overlay fold over data that may already include the write.
 */
const classifyResponse = (state: QueriesState, target: IntentTarget): ResponseKind => {
  const existing = entryOf(state.cache, target);
  // A stale entry means a soft invalidate landed while this fetch was in
  // flight, so the response predates it. An absent entry means a hard
  // invalidate removed it mid-flight (`started` always precedes a response).
  const predatesInvalidation = existing === undefined || existing.isStale;
  const open = state.overlays.some(
    (intent) => hasTarget(intent, target) && (intent.phase === "pending" || predatesInvalidation),
  );
  if (open) return "untrusted";
  return predatesInvalidation ? "stale" : "fresh";
};

/**
 * Apply a fetch response for `target`. `written` builds the entry a trusted
 * response writes (minus the flags set here) from the entry it replaces. A
 * discarded response only ends the fetch: data, status, error and staleness
 * stay as they were — an untrusted failure is no more evidence than an
 * untrusted success — and an absent entry stays absent. Returns `undefined`
 * (no change) when a discard has nothing to clear.
 */
const applyResponse = (
  state: QueriesState,
  target: IntentTarget,
  written: (
    existing: QueryState<unknown> | undefined,
  ) => Omit<QueryState<unknown>, "isFetching" | "isStale">,
): QueriesState | undefined => {
  const existing = entryOf(state.cache, target);
  const kind = classifyResponse(state, target);
  switch (kind) {
    case "untrusted":
      return existing === undefined || !existing.isFetching
        ? undefined
        : { ...state, cache: withEntry(state.cache, target, { ...existing, isFetching: false }) };
    case "stale":
    case "fresh":
      return {
        ...state,
        cache: withEntry(state.cache, target, {
          ...written(existing),
          isFetching: false,
          isStale: kind === "stale",
        }),
        // Same action writes fresh data AND releases the settling overlay —
        // the optimistic view hands off to server truth with no frame between.
        overlays: kind === "fresh" ? settleOverlays(state.overlays, target) : state.overlays,
      };
  }
};

/**
 * Reducer that handles {@linkcode QueriesAction} to maintain the query cache,
 * optimistic overlays, and mutation lifecycle state.
 */
export const queriesReducer: Reducer<QueriesState, QueriesAction> = (state, action) => {
  switch (action.id) {
    case QueryActionId.started: {
      const { query, key } = action.data;
      const existing = entryOf(state.cache, { query, key });
      return {
        ...state,
        cache: withEntry(
          state.cache,
          { query, key },
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
        ),
      };
    }
    case QueryActionId.success: {
      const { query, key, result, dataUpdatedAt } = action.data;
      return applyResponse(state, { query, key }, () => ({
        status: "success",
        data: result,
        error: undefined,
        dataUpdatedAt,
      }));
    }
    case QueryActionId.error: {
      const { query, key, error } = action.data;
      return applyResponse(state, { query, key }, (existing) => ({
        status: "error",
        data: existing?.data,
        error,
        dataUpdatedAt: existing?.dataUpdatedAt,
      }));
    }
    case QueryActionId.invalidate: {
      const { query, key, soft } = action.data;
      if (soft) {
        const invalidation: Invalidation = key === undefined ? { query } : { query, key };
        const cache = markStale(state.cache, [invalidation]);
        return cache === state.cache ? undefined : { ...state, cache };
      }
      const byKey = own(state.cache, query);
      if (byKey === undefined) return undefined;
      if (key === undefined) return { ...state, cache: omit(state.cache, query) };
      if (!Object.hasOwn(byKey, key)) return undefined;
      const remaining = omit(byKey, key);
      return {
        ...state,
        // Drop the name with its last entry, so every inner record is non-empty.
        cache:
          Object.keys(remaining).length === 0
            ? omit(state.cache, query)
            : { ...state.cache, [query]: remaining },
      };
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
        const live = intent.targets.filter((t) => entryOf(state.cache, t) !== undefined);
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
      const removed = state.overlays.find((intent) => intent.intentId === intentId);
      return {
        ...state,
        // Rollback is removal: the canonical cache was never touched, so the
        // next select derives the pre-mutation view with nothing to restore.
        // Responses that landed while the intent was open were discarded, so
        // its targets go stale in the same transition and the reconciler
        // fetches truth now the window has closed.
        cache: removed === undefined ? state.cache : markStale(state.cache, removed.targets),
        overlays:
          removed === undefined
            ? state.overlays
            : state.overlays.filter((intent) => intent !== removed),
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
 * `onFailure` gets the error message for state and the full cause for logging.
 */
const reportExit = <A>(
  exit: Exit.Exit<A, unknown>,
  onSuccess: (value: A) => Effect.Effect<void>,
  onFailure: (error: string, cause: Cause.Cause<unknown>) => Effect.Effect<void>,
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) return onSuccess(exit.value);
  if (Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
  return onFailure(String(Cause.squash(exit.cause)), exit.cause);
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
 * a `process` to register in your root process.
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
    return selectByKey(state, key);
  };

  const selectByKey = (state: S, key: string): QueryState<T> | undefined =>
    applyOverlays(
      state,
      entryOf(state.queries.cache, { query: name, key }) as QueryState<T> | undefined,
      key,
    );

  const process = <A extends Action>(
    ctx: StoreContext<S, A>,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      // Keyed by entry key alone: this map is per query, so the name is implied.
      const inflight = yield* Ref.make(new Map<string, Fiber.Fiber<void, never>>());

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
          const exit = yield* fetchEffect.pipe(Effect.exit);

          yield* reportExit(
            exit,
            (data) =>
              put({
                id: QueryActionId.success,
                data: { query: name, key, result: data, dataUpdatedAt: Date.now() },
              }),
            (error, cause) =>
              Effect.gen(function* () {
                yield* Effect.logError(`Query ${name}:${key} failed`, cause);
                yield* put({ id: QueryActionId.error, data: { query: name, key, error } });
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
      // The stream is only a trigger: a streamed snapshot may predate this
      // fiber's own `started` puts, so decide on the latest state instead.
      const reconcile = () =>
        Effect.gen(function* () {
          const state = yield* ctx.select();
          const entries = normalise(derive(state));
          const currentInflight = yield* Ref.get(inflight);

          // `state` and `currentInflight` are snapshots, so a key derived
          // twice would look absent again and fork an untracked duplicate
          // fetch. The first entry for a key wins; later ones are ignored.
          const seen = new Set<string>();

          // Only iterates current entries — fibers for keys no longer derived
          // (e.g. user navigated away) run to completion and warm the cache.
          for (const entry of entries) {
            const { key } = entry;
            if (seen.has(key)) continue;
            seen.add(key);
            const cached = entryOf(state.queries.cache, { query: name, key });
            const fresh = cached !== undefined && !cached.isStale;
            const existingFiber = currentInflight.get(key);

            if (fresh) continue;

            if (existingFiber) {
              yield* Fiber.interrupt(existingFiber);
            }

            // `started` is put here, not in the fetch fiber, so every state
            // this reconciler sees afterwards already has the loading entry.
            yield* put({ id: QueryActionId.started, data: { query: name, key } });
            const fiber = yield* Effect.forkScoped(doFetch(key, entry.fetch));
            yield* Ref.update(inflight, (m) => new Map(m).set(key, fiber));
          }
        });

      // One failed reconcile (e.g. a throwing derive) is logged and the next
      // state change retries — it must not end the query for good. `changes`
      // emits on every put, even one leaving state unchanged, so a derive that
      // keeps throwing logs once, then again only after a reconcile succeeds
      // or the failure changes.
      const isolateReconcile = isolateDeduped(`Query ${name} reconcile failed`);
      yield* SubscriptionRef.changes(ctx.state).pipe(
        Stream.runForEach(() => isolateReconcile(reconcile())),
        Effect.forkScoped,
      );
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
 * concurrency policy. The handler gets the state the run action's own
 * reduction produced — not the store's current state, which by the time the
 * fiber runs may already reflect later actions (the user navigating away).
 * Every mutation shares the `katha/mutation/run` id and is told apart by
 * `data.name`, so matching happens on the payload here rather than
 * through `takeEvery` / `takeLeading` — those match on id alone, and a
 * `"leading"` gate over the shared id would block unrelated mutations. If a
 * second payload-matched listener appears, lift a predicate combinator into
 * combinators.ts instead of copying this.
 */
const onMutationRun = <S, A extends Action>(
  ctx: StoreContext<S, A>,
  name: string,
  concurrency: "every" | "leading",
  handler: (variables: unknown, state: S) => Effect.Effect<void>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* PubSub.subscribe(ctx.transitions);
    let inflight: Fiber.Fiber<void> | null = null;
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const { action, state } = yield* PubSub.take(queue);
          if (!isRunOf(action, name)) return;
          if (concurrency === "leading" && inflight !== null) {
            if (inflight.pollUnsafe() === undefined) return; // still running — drop this trigger
          }
          inflight = yield* forkHandler(`Mutation ${name} handler failed`, () =>
            handler(action.data.variables, state),
          );
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
 * simply removed — the next select derives the pre-mutation view — and its
 * targets are soft-invalidated, since responses that landed while it was open
 * were discarded. On success
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

    const handler = (variables: V, state: S) =>
      Effect.gen(function* () {
        const intentId = crypto.randomUUID();
        // Target resolution calls user code (each "current" query's derive, a
        // target's key), so a throw is captured as this run's failure rather
        // than killing the handler and leaving the mutation idle.
        const resolved = yield* Effect.sync(() =>
          resolveTargets(
            targets,
            variables,
            Object.fromEntries(current.map((c) => [c.query, c.registration.currentKey(state)])),
          ),
        ).pipe(Effect.exit);
        const run = Exit.isSuccess(resolved) ? resolved.value : { targets: [], invalidations: [] };

        // Put even when resolution failed — with no targets, so no overlay —
        // so the failure below lands as an ordinary started → error run.
        yield* put({
          id: MutationActionId.started,
          data: { name, intentId, variables, targets: run.targets, submittedAt: Date.now() },
        });

        // Suspended so a run that throws before returning its Effect becomes a
        // defect reportExit sees, rather than stranding the intent as pending.
        const exit = Exit.isSuccess(resolved)
          ? yield* Effect.suspend(() => config.run(variables)).pipe(Effect.exit)
          : resolved;

        yield* reportExit(
          exit,
          // Settling and invalidation ride one action, so the reducer applies
          // them in one transition and no refetch can land between them.
          () =>
            put({
              id: MutationActionId.success,
              data: { name, intentId, invalidations: run.invalidations },
            }),
          (error, cause) =>
            Effect.gen(function* () {
              yield* Effect.logError(`Mutation ${name} failed`, cause);
              yield* put({ id: MutationActionId.error, data: { name, intentId, error } });
            }),
        );
      });

    return onMutationRun(ctx, name, config.concurrency ?? "every", (variables, state) =>
      handler(variables as V, state),
    );
  };

  return { name, makeAction, select, process };
}
