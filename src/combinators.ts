/**
 * Saga-style combinators for process coordination.
 *
 * Each combinator subscribes to the action stream and forks handlers
 * with a specific concurrency strategy.
 *
 * NOTE: The standalone functions and the {@link CombinatorSet} interface expose
 * the same operations. Keep their JSDoc in sync when editing.
 */

import { type Duration, Effect, Fiber, PubSub, Queue, type Scope } from "effect";
import type { Action, ActionOf, Process, StoreContext } from "./types.ts";

/**
 * Suspend until an action with a matching ID arrives. Returns the narrowed
 * action. The caller must be inside a scoped context — the subscription is
 * cleaned up when the scope closes.
 *
 * @typeParam S - Store state type.
 * @typeParam A - Action union type.
 * @typeParam K - Subset of action IDs to match.
 * @param ctx - The store context to subscribe to.
 * @param ids - Action IDs to listen for.
 * @returns An Effect that resolves with the first matching action.
 *
 * @example
 * ```ts
 * const action = yield* take<State, Action, "form/submitted">(ctx, ["form/submitted"]);
 * console.log(action.payload);
 * ```
 */
export function take<S, A extends Action, K extends A["id"]>(
  ctx: StoreContext<S, A>,
  ids: K[],
): Effect.Effect<ActionOf<A, K>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* PubSub.subscribe(ctx.actions);
    return yield* Effect.gen(function* () {
      while (true) {
        const action = yield* Queue.take(queue);
        if ((ids as string[]).includes(action.id)) {
          return action as ActionOf<A, K>;
        }
      }
    });
  });
}

/**
 * Fork a handler for every matching action. All handlers run concurrently
 * with no cancellation — every trigger gets its own fiber.
 *
 * @typeParam S - Store state type.
 * @typeParam A - Action union type.
 * @typeParam K - Subset of action IDs to match.
 * @typeParam R - Requirements of the handler effect.
 * @param ids - Action IDs to listen for.
 * @param handler - Effect to run for each matched action. Receives the
 *   narrowed action and the store context.
 * @returns A {@link Process} that can be registered with the store.
 *
 * @example
 * ```ts
 * const logAllClicks = takeEvery<State, Action, "click", never>(
 *   ["click"],
 *   (action, ctx) => Effect.log(`Clicked ${action.payload}`),
 * );
 * ```
 */
export function takeEvery<S, A extends Action, K extends A["id"], R>(
  ids: K[],
  handler: (action: ActionOf<A, K>, ctx: StoreContext<S, A>) => Effect.Effect<void, never, R>,
): Process<S, A, R> {
  return (ctx) =>
    Effect.gen(function* () {
      const queue = yield* PubSub.subscribe(ctx.actions);
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const action = yield* Queue.take(queue);
            if ((ids as string[]).includes(action.id)) {
              yield* Effect.forkScoped(handler(action as ActionOf<A, K>, ctx));
            }
          }),
        ),
      );
    });
}

/**
 * Fork a handler for matching actions, cancelling any in-flight handler
 * from a previous trigger. Useful for search-as-you-type or other cases
 * where only the most recent response matters.
 *
 * @typeParam S - Store state type.
 * @typeParam A - Action union type.
 * @typeParam K - Subset of action IDs to match.
 * @typeParam R - Requirements of the handler effect.
 * @param ids - Action IDs to listen for.
 * @param handler - Effect to run for each matched action. Any previously
 *   forked handler is interrupted before the new one starts.
 * @returns A {@link Process} that can be registered with the store.
 *
 * @example
 * ```ts
 * const search = takeLatest<State, Action, "search/query", never>(
 *   ["search/query"],
 *   (action, ctx) =>
 *     Effect.gen(function* () {
 *       const results = yield* fetchResults(action.payload);
 *       ctx.dispatch({ id: "search/results", payload: results });
 *     }),
 * );
 * ```
 */
export function takeLatest<S, A extends Action, K extends A["id"], R>(
  ids: K[],
  handler: (action: ActionOf<A, K>, ctx: StoreContext<S, A>) => Effect.Effect<void, never, R>,
): Process<S, A, R> {
  return (ctx) =>
    Effect.gen(function* () {
      const queue = yield* PubSub.subscribe(ctx.actions);
      let inflight: Fiber.Fiber<void> | null = null;
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const action = yield* Queue.take(queue);
            if ((ids as string[]).includes(action.id)) {
              if (inflight) yield* Fiber.interrupt(inflight);
              inflight = yield* Effect.forkScoped(handler(action as ActionOf<A, K>, ctx));
            }
          }),
        ),
      );
    });
}

/**
 * Fork a handler for matching actions, but ignore subsequent triggers
 * while the handler is still running. Good for one-shot operations like
 * form submission where double-firing is undesirable.
 *
 * @typeParam S - Store state type.
 * @typeParam A - Action union type.
 * @typeParam K - Subset of action IDs to match.
 * @typeParam R - Requirements of the handler effect.
 * @param ids - Action IDs to listen for.
 * @param handler - Effect to run. Subsequent matching actions are dropped
 *   until this handler's fiber completes.
 * @returns A {@link Process} that can be registered with the store.
 *
 * @example
 * ```ts
 * const submitForm = takeLeading<State, Action, "form/submit", never>(
 *   ["form/submit"],
 *   (action, ctx) =>
 *     Effect.gen(function* () {
 *       yield* postForm(action.payload);
 *       ctx.dispatch({ id: "form/submitted" });
 *     }),
 * );
 * ```
 */
export function takeLeading<S, A extends Action, K extends A["id"], R>(
  ids: K[],
  handler: (action: ActionOf<A, K>, ctx: StoreContext<S, A>) => Effect.Effect<void, never, R>,
): Process<S, A, R> {
  return (ctx) =>
    Effect.gen(function* () {
      const queue = yield* PubSub.subscribe(ctx.actions);
      let inflight: Fiber.Fiber<void> | null = null;
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const action = yield* Queue.take(queue);
            if ((ids as string[]).includes(action.id)) {
              if (inflight) {
                const exit = yield* Fiber.poll(inflight);
                if (exit._tag === "None") return; // still running, skip
              }
              inflight = yield* Effect.forkScoped(handler(action as ActionOf<A, K>, ctx));
            }
          }),
        ),
      );
    });
}

/**
 * Wait for a quiet period after the last matching action before running
 * the handler. Each new matching action resets the timer. Only the final
 * action in a burst is handled.
 *
 * @typeParam S - Store state type.
 * @typeParam A - Action union type.
 * @typeParam K - Subset of action IDs to match.
 * @typeParam R - Requirements of the handler effect.
 * @param duration - How long to wait after the last action before firing.
 * @param ids - Action IDs to listen for.
 * @param handler - Effect to run once the quiet period elapses.
 * @returns A {@link Process} that can be registered with the store.
 *
 * @example
 * ```ts
 * const autoSave = debounce<State, Action, "editor/change", never>(
 *   "500 millis",
 *   ["editor/change"],
 *   (action, ctx) =>
 *     Effect.gen(function* () {
 *       yield* save(ctx.getState());
 *     }),
 * );
 * ```
 */
export function debounce<S, A extends Action, K extends A["id"], R>(
  duration: Duration.DurationInput,
  ids: K[],
  handler: (action: ActionOf<A, K>, ctx: StoreContext<S, A>) => Effect.Effect<void, never, R>,
): Process<S, A, R> {
  return (ctx) =>
    Effect.gen(function* () {
      const queue = yield* PubSub.subscribe(ctx.actions);
      let pending: Fiber.Fiber<void> | null = null;
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const action = yield* Queue.take(queue);
            if ((ids as string[]).includes(action.id)) {
              if (pending) yield* Fiber.interrupt(pending);
              pending = yield* Effect.forkScoped(
                Effect.gen(function* () {
                  yield* Effect.sleep(duration);
                  yield* handler(action as ActionOf<A, K>, ctx);
                }),
              );
            }
          }),
        ),
      );
    });
}

/** All combinators with `S` and `A` pre-bound. Returned by {@link combinators}. */
export interface CombinatorSet<S, A extends Action> {
  /**
   * Fork a handler for every matching action. All handlers run concurrently
   * with no cancellation — every trigger gets its own fiber.
   *
   * @param ids - Action IDs to listen for.
   * @param handler - Effect to run for each matched action. Receives the
   *   narrowed action and the store context.
   * @returns A {@link Process} that can be registered with the store.
   *
   * @example
   * ```ts
   * const { takeEvery } = combinators<State, Action>();
   *
   * const logAllClicks = takeEvery(["click"], (action, ctx) =>
   *   Effect.log(`Clicked ${action.payload}`),
   * );
   * ```
   */
  takeEvery<K extends A["id"], R>(
    ids: K[],
    handler: (action: ActionOf<A, K>, ctx: StoreContext<S, A>) => Effect.Effect<void, never, R>,
  ): Process<S, A, R>;

  /**
   * Fork a handler for matching actions, cancelling any in-flight handler
   * from a previous trigger. Useful for search-as-you-type or other cases
   * where only the most recent response matters.
   *
   * @param ids - Action IDs to listen for.
   * @param handler - Effect to run for each matched action. Any previously
   *   forked handler is interrupted before the new one starts.
   * @returns A {@link Process} that can be registered with the store.
   *
   * @example
   * ```ts
   * const { takeLatest } = combinators<State, Action>();
   *
   * const search = takeLatest(["search/query"], (action, ctx) =>
   *   Effect.gen(function* () {
   *     const results = yield* fetchResults(action.payload);
   *     ctx.dispatch({ id: "search/results", payload: results });
   *   }),
   * );
   * ```
   */
  takeLatest<K extends A["id"], R>(
    ids: K[],
    handler: (action: ActionOf<A, K>, ctx: StoreContext<S, A>) => Effect.Effect<void, never, R>,
  ): Process<S, A, R>;

  /**
   * Fork a handler for matching actions, but ignore subsequent triggers
   * while the handler is still running. Good for one-shot operations like
   * form submission where double-firing is undesirable.
   *
   * @param ids - Action IDs to listen for.
   * @param handler - Effect to run. Subsequent matching actions are dropped
   *   until this handler's fiber completes.
   * @returns A {@link Process} that can be registered with the store.
   *
   * @example
   * ```ts
   * const { takeLeading } = combinators<State, Action>();
   *
   * const submitForm = takeLeading(["form/submit"], (action, ctx) =>
   *   Effect.gen(function* () {
   *     yield* postForm(action.payload);
   *     ctx.dispatch({ id: "form/submitted" });
   *   }),
   * );
   * ```
   */
  takeLeading<K extends A["id"], R>(
    ids: K[],
    handler: (action: ActionOf<A, K>, ctx: StoreContext<S, A>) => Effect.Effect<void, never, R>,
  ): Process<S, A, R>;

  /**
   * Wait for a quiet period after the last matching action before running
   * the handler. Each new matching action resets the timer. Only the final
   * action in a burst is handled.
   *
   * @param duration - How long to wait after the last action before firing.
   * @param ids - Action IDs to listen for.
   * @param handler - Effect to run once the quiet period elapses.
   * @returns A {@link Process} that can be registered with the store.
   *
   * @example
   * ```ts
   * const { debounce } = combinators<State, Action>();
   *
   * const autoSave = debounce("500 millis", ["editor/change"], (action, ctx) =>
   *   Effect.gen(function* () {
   *     yield* save(ctx.getState());
   *   }),
   * );
   * ```
   */
  debounce<K extends A["id"], R>(
    duration: Duration.DurationInput,
    ids: K[],
    handler: (action: ActionOf<A, K>, ctx: StoreContext<S, A>) => Effect.Effect<void, never, R>,
  ): Process<S, A, R>;
}

/**
 * Bind `S` and `A` once, get back all combinators with those types fixed.
 * Call sites need zero type parameters — `K` and `R` are inferred.
 */
export function combinators<S, A extends Action>(): CombinatorSet<S, A> {
  return {
    takeEvery: (ids, handler) => takeEvery(ids, handler),
    takeLatest: (ids, handler) => takeLatest(ids, handler),
    takeLeading: (ids, handler) => takeLeading(ids, handler),
    debounce: (duration, ids, handler) => debounce(duration, ids, handler),
  };
}
