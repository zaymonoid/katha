/**
 * Saga-style combinators for process coordination.
 *
 * Each combinator subscribes to the store's transition stream and forks
 * handlers with a specific concurrency strategy. A handler gets its trigger
 * action and the state that action's own reduction produced. Handlers are
 * isolated: one that throws or fails is logged and ends only its own fiber,
 * never the listener.
 *
 * NOTE: The standalone functions and the {@link CombinatorSet} interface expose
 * the same operations. Keep their JSDoc in sync when editing.
 */

import { type Duration, Effect, Fiber, PubSub, type Scope } from "effect";
import { forkHandler } from "./defects.ts";
import type { Action, ActionOf, Process, StoreContext } from "./types.ts";

const isOneOf = <A extends Action, K extends A["id"]>(ids: K[], action: A): boolean =>
  (ids as string[]).includes(action.id);

/**
 * Subscribe to `ctx.transitions` now — in the caller's fiber, so the
 * subscription exists before the process suspends (the startup contract on
 * {@link Process}) — and fork a listener that runs `onMatch` with each
 * matching action and its post-reduction state, in reducer order.
 */
const listen = <S, A extends Action, K extends A["id"], R>(
  ctx: StoreContext<S, A>,
  ids: K[],
  onMatch: (action: ActionOf<A, K>, state: S) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* PubSub.subscribe(ctx.transitions);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const { action, state } = yield* PubSub.take(queue);
          if (isOneOf(ids, action)) yield* onMatch(action as ActionOf<A, K>, state);
        }),
      ),
    );
  });

/**
 * Suspend until an action with a matching ID arrives. Returns the narrowed
 * action. The subscription opens when `take` runs and closes as soon as it
 * returns — left open, its queue would keep every later transition (and the
 * state each one carries) until the caller's scope closed.
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
): Effect.Effect<ActionOf<A, K>> {
  return Effect.scoped(
    Effect.gen(function* () {
      const queue = yield* PubSub.subscribe(ctx.transitions);
      while (true) {
        const { action } = yield* PubSub.take(queue);
        if (isOneOf(ids, action)) return action as ActionOf<A, K>;
      }
    }),
  );
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
 *   narrowed action, the store context, and the state the action's own
 *   reduction produced — read it rather than `ctx.select()`, which may
 *   already reflect later actions.
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
  handler: (
    action: ActionOf<A, K>,
    ctx: StoreContext<S, A>,
    state: S,
  ) => Effect.Effect<void, never, R>,
): Process<S, A, R> {
  return (ctx) =>
    listen(ctx, ids, (action, state) =>
      Effect.asVoid(
        forkHandler(`takeEvery handler for ${action.id} failed`, () => handler(action, ctx, state)),
      ),
    );
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
 * @param handler - Effect to run for each matched action, with the same
 *   arguments as `takeEvery`'s. Any previously forked handler is
 *   interrupted before the new one starts.
 * @returns A {@link Process} that can be registered with the store.
 *
 * @example
 * ```ts
 * const search = takeLatest<State, Action, "search/query", never>(
 *   ["search/query"],
 *   (action, ctx) =>
 *     Effect.gen(function* () {
 *       const results = yield* fetchResults(action.payload);
 *       yield* ctx.put({ id: "search/results", payload: results });
 *     }),
 * );
 * ```
 */
export function takeLatest<S, A extends Action, K extends A["id"], R>(
  ids: K[],
  handler: (
    action: ActionOf<A, K>,
    ctx: StoreContext<S, A>,
    state: S,
  ) => Effect.Effect<void, never, R>,
): Process<S, A, R> {
  return (ctx) => {
    let inflight: Fiber.Fiber<void> | null = null;
    return listen(ctx, ids, (action, state) =>
      Effect.gen(function* () {
        if (inflight) yield* Fiber.interrupt(inflight);
        inflight = yield* forkHandler(`takeLatest handler for ${action.id} failed`, () =>
          handler(action, ctx, state),
        );
      }),
    );
  };
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
 * @param handler - Effect to run, with the same arguments as
 *   `takeEvery`'s. Subsequent matching actions are dropped until this
 *   handler's fiber completes.
 * @returns A {@link Process} that can be registered with the store.
 *
 * @example
 * ```ts
 * const submitForm = takeLeading<State, Action, "form/submit", never>(
 *   ["form/submit"],
 *   (action, ctx) =>
 *     Effect.gen(function* () {
 *       yield* postForm(action.payload);
 *       yield* ctx.put({ id: "form/submitted" });
 *     }),
 * );
 * ```
 */
export function takeLeading<S, A extends Action, K extends A["id"], R>(
  ids: K[],
  handler: (
    action: ActionOf<A, K>,
    ctx: StoreContext<S, A>,
    state: S,
  ) => Effect.Effect<void, never, R>,
): Process<S, A, R> {
  return (ctx) => {
    let inflight: Fiber.Fiber<void> | null = null;
    return listen(ctx, ids, (action, state) =>
      Effect.gen(function* () {
        if (inflight && inflight.pollUnsafe() === undefined) return; // still running, skip
        inflight = yield* forkHandler(`takeLeading handler for ${action.id} failed`, () =>
          handler(action, ctx, state),
        );
      }),
    );
  };
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
 * @param handler - Effect to run once the quiet period elapses, with the
 *   same arguments as `takeEvery`'s. `state` is as of the last action in
 *   the burst; `ctx.select()` gives the state when the handler fires.
 * @returns A {@link Process} that can be registered with the store.
 *
 * @example
 * ```ts
 * const autoSave = debounce<State, Action, "editor/change", never>(
 *   "500 millis",
 *   ["editor/change"],
 *   (action, ctx) =>
 *     Effect.gen(function* () {
 *       yield* save(yield* ctx.select());
 *     }),
 * );
 * ```
 */
export function debounce<S, A extends Action, K extends A["id"], R>(
  duration: Duration.Input,
  ids: K[],
  handler: (
    action: ActionOf<A, K>,
    ctx: StoreContext<S, A>,
    state: S,
  ) => Effect.Effect<void, never, R>,
): Process<S, A, R> {
  return (ctx) => {
    let pending: Fiber.Fiber<void> | null = null;
    return listen(ctx, ids, (action, state) =>
      Effect.gen(function* () {
        if (pending) yield* Fiber.interrupt(pending);
        pending = yield* forkHandler(`debounce handler for ${action.id} failed`, () =>
          Effect.andThen(
            Effect.sleep(duration),
            Effect.suspend(() => handler(action, ctx, state)),
          ),
        );
      }),
    );
  };
}

/** All combinators with `S` and `A` pre-bound. Returned by {@link combinators}. */
export interface CombinatorSet<S, A extends Action> {
  /**
   * Fork a handler for every matching action. All handlers run concurrently
   * with no cancellation — every trigger gets its own fiber.
   *
   * @param ids - Action IDs to listen for.
   * @param handler - Effect to run for each matched action. Receives the
   *   narrowed action, the store context, and the state the action's own
   *   reduction produced — read it rather than `ctx.select()`, which may
   *   already reflect later actions.
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
    handler: (
      action: ActionOf<A, K>,
      ctx: StoreContext<S, A>,
      state: S,
    ) => Effect.Effect<void, never, R>,
  ): Process<S, A, R>;

  /**
   * Fork a handler for matching actions, cancelling any in-flight handler
   * from a previous trigger. Useful for search-as-you-type or other cases
   * where only the most recent response matters.
   *
   * @param ids - Action IDs to listen for.
   * @param handler - Effect to run for each matched action, with the same
   *   arguments as `takeEvery`'s. Any previously forked handler is
   *   interrupted before the new one starts.
   * @returns A {@link Process} that can be registered with the store.
   *
   * @example
   * ```ts
   * const { takeLatest } = combinators<State, Action>();
   *
   * const search = takeLatest(["search/query"], (action, ctx) =>
   *   Effect.gen(function* () {
   *     const results = yield* fetchResults(action.payload);
   *     yield* ctx.put({ id: "search/results", payload: results });
   *   }),
   * );
   * ```
   */
  takeLatest<K extends A["id"], R>(
    ids: K[],
    handler: (
      action: ActionOf<A, K>,
      ctx: StoreContext<S, A>,
      state: S,
    ) => Effect.Effect<void, never, R>,
  ): Process<S, A, R>;

  /**
   * Fork a handler for matching actions, but ignore subsequent triggers
   * while the handler is still running. Good for one-shot operations like
   * form submission where double-firing is undesirable.
   *
   * @param ids - Action IDs to listen for.
   * @param handler - Effect to run, with the same arguments as
   *   `takeEvery`'s. Subsequent matching actions are dropped until this
   *   handler's fiber completes.
   * @returns A {@link Process} that can be registered with the store.
   *
   * @example
   * ```ts
   * const { takeLeading } = combinators<State, Action>();
   *
   * const submitForm = takeLeading(["form/submit"], (action, ctx) =>
   *   Effect.gen(function* () {
   *     yield* postForm(action.payload);
   *     yield* ctx.put({ id: "form/submitted" });
   *   }),
   * );
   * ```
   */
  takeLeading<K extends A["id"], R>(
    ids: K[],
    handler: (
      action: ActionOf<A, K>,
      ctx: StoreContext<S, A>,
      state: S,
    ) => Effect.Effect<void, never, R>,
  ): Process<S, A, R>;

  /**
   * Wait for a quiet period after the last matching action before running
   * the handler. Each new matching action resets the timer. Only the final
   * action in a burst is handled.
   *
   * @param duration - How long to wait after the last action before firing.
   * @param ids - Action IDs to listen for.
   * @param handler - Effect to run once the quiet period elapses, with the
   *   same arguments as `takeEvery`'s. `state` is as of the last action in
   *   the burst; `ctx.select()` gives the state when the handler fires.
   * @returns A {@link Process} that can be registered with the store.
   *
   * @example
   * ```ts
   * const { debounce } = combinators<State, Action>();
   *
   * const autoSave = debounce("500 millis", ["editor/change"], (action, ctx) =>
   *   Effect.gen(function* () {
   *     yield* save(yield* ctx.select());
   *   }),
   * );
   * ```
   */
  debounce<K extends A["id"], R>(
    duration: Duration.Input,
    ids: K[],
    handler: (
      action: ActionOf<A, K>,
      ctx: StoreContext<S, A>,
      state: S,
    ) => Effect.Effect<void, never, R>,
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
