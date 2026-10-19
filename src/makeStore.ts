/**
 * Store factory — creates an Effect-TS store with saga-style process coordination.
 *
 * Returns a `Store<S, A>` containing both Effect-side internals (for processes)
 * and a pre-built `StoreHandle` (for UI code). The consumer never bridges
 * Effect ↔ imperative themselves.
 */

import { Effect, PubSub, Queue, type Scope, Semaphore, Stream, SubscriptionRef } from "effect";
import { isFailure, isolate, logFailure } from "./defects.ts";
import type { Action, Store, StoreConfig, StoreContext, StoreHandle, Transition } from "./types.ts";

const COMMAND_QUEUE_CAPACITY = 8_192; // power of 2 for Effect Queue internals

export function makeStore<S, A extends Action, R>(
  config: StoreConfig<S, A, R>,
): Effect.Effect<Store<S, A>, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<S>(config.initialState);
    const transitions = yield* PubSub.unbounded<Transition<S, A>>();

    // Reduce + publish must be atomic: serialised so the transition stream's
    // order matches reducer order, and uninterruptible so an interrupted put
    // can't change state without publishing. Waiting for the permit stays
    // interruptible. The serialisation is also what makes each transition
    // exact: the state paired with an action is the one its own reduction
    // produced, never a later one. Each action is published once, as a
    // transition — subscribers that only want the action take `.action`.
    // A throwing reducer is logged here, whoever called put — a saga's ctx.put
    // runs in a forked fiber whose death Effect would not report — and
    // re-raised so Effect callers still see it.
    const putLock = yield* Semaphore.make(1);
    const reduce = config.reduce;
    const put = (action: A): Effect.Effect<void> =>
      Semaphore.withPermit(
        putLock,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const next = reduce
              ? yield* SubscriptionRef.updateAndGet(state, (s) => reduce(s, action) ?? s)
              : yield* SubscriptionRef.get(state);
            yield* PubSub.publish(transitions, { action, state: next });
          }),
        ),
      ).pipe(logFailure(`Store put ${action.id} failed`));

    const select = (): Effect.Effect<S> => SubscriptionRef.get(state);

    const ctx: StoreContext<S, A> = { transitions, state, put, select };

    // Imperative broadcaster for the handle
    let current: S = config.initialState;
    const listeners = new Set<(state: S) => void>();
    const isolateListener = isolate("Store listener failed");

    // Start immediately so `changes` emits the initial state before any
    // handle.subscribe — otherwise new listeners would see it twice.
    yield* Effect.forkScoped(
      SubscriptionRef.changes(state).pipe(
        Stream.runForEach((s) =>
          Effect.suspend(() => {
            current = s;
            // Isolate each listener: a throw is logged and must neither skip
            // the others nor end this fiber, or the handle would silently
            // stop updating.
            // Iterate a snapshot: a listener subscribed mid-pass already got
            // `s` from handle.subscribe, and live Set iteration would call it
            // again. The membership check, made as each listener is reached,
            // skips one unsubscribed mid-pass.
            return Effect.forEach(
              [...listeners],
              (fn) => (listeners.has(fn) ? isolateListener(Effect.sync(() => fn(s))) : Effect.void),
              { discard: true },
            );
          }),
        ),
      ),
      { startImmediately: true },
    );

    // Fork the single root process. Start it immediately, and before the
    // command loop, so its synchronous setup (PubSub subscriptions from
    // takeEvery & co, mutation listeners) runs to its first suspension before
    // makeStore returns — otherwise an early handle.put (e.g. createStoreRef's
    // flush on attach) is reduced and published with no saga listening.
    // This is the startup contract documented on `Process`: subscribe before
    // awaiting anything async. Setup long enough to hit the scheduler's op
    // budget (MaxOpsBeforeYield) yields, and a subscription made in a forked
    // child runs later still, but both are queued ahead of the command loop's
    // first run — scheduler FIFO covers handle.put. It does not cover an
    // Effect-side store.put right after makeStore: that reduces and publishes
    // in the caller's fiber, so only the root's initial synchronous slice is
    // guaranteed to have subscribed.
    yield* Effect.forkScoped(config.process(ctx), { startImmediately: true });

    const commandQueue = yield* Queue.bounded<A>(COMMAND_QUEUE_CAPACITY);

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const action = yield* Queue.take(commandQueue);
          // A throwing reducer drops only its own action (state unchanged,
          // nothing published) — it must not end the loop and every later put.
          // put has already logged it, so swallow without logging again.
          yield* put(action).pipe(Effect.catchCauseIf(isFailure, () => Effect.void));
        }),
      ),
    );

    const handle: StoreHandle<S, A> = {
      put: (action: A) => {
        if (!Queue.offerUnsafe(commandQueue, action)) {
          throw new Error(
            `Store command queue is full (${COMMAND_QUEUE_CAPACITY} pending actions) — this is probably a bug. ` +
              "Are you dispatching in a tight loop?",
          );
        }
      },
      subscribe: (fn: (state: S) => void): (() => void) => {
        const alreadySubscribed = listeners.has(fn);
        listeners.add(fn);
        try {
          fn(current);
        } catch (e) {
          // Subscribing is all-or-nothing: the caller gets no unsub back, so a
          // listener left in place could never be removed.
          if (!alreadySubscribed) listeners.delete(fn);
          throw e;
        }
        return () => listeners.delete(fn);
      },
      getState: () => current,
    };

    return { put, select, transitions, state, handle };
  });
}
