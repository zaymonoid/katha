/**
 * Store factory — creates an Effect-TS store with saga-style process coordination.
 *
 * Returns a `Store<S, A>` containing both Effect-side internals (for processes)
 * and a pre-built `StoreHandle` (for UI code). The consumer never bridges
 * Effect ↔ imperative themselves.
 */

import { Effect, PubSub, Queue, type Scope, Stream, SubscriptionRef } from "effect";
import type { Action, Store, StoreConfig, StoreContext, StoreHandle } from "./types.ts";

const COMMAND_QUEUE_CAPACITY = 8_192; // power of 2 for Effect Queue internals

export function makeStore<S, A extends Action, R>(
  config: StoreConfig<S, A, R>,
): Effect.Effect<Store<S, A>, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<S>(config.initialState);
    const actions = yield* PubSub.unbounded<A>();

    const put = (action: A): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (config.reduce) {
          // biome-ignore lint/style/noNonNullAssertion: guarded by if
          yield* SubscriptionRef.update(state, (s) => config.reduce!(s, action) ?? s);
        }
        yield* PubSub.publish(actions, action);
      });

    const select = (): Effect.Effect<S> => SubscriptionRef.get(state);

    const ctx: StoreContext<S, A> = { actions, state, put, select };

    // Imperative broadcaster for the handle
    let current: S = config.initialState;
    const listeners = new Set<(state: S) => void>();

    yield* Effect.forkScoped(
      state.changes.pipe(
        Stream.runForEach((s) =>
          Effect.sync(() => {
            current = s;
            // biome-ignore lint/suspicious/useIterableCallbackReturn: return value unused
            listeners.forEach((fn) => fn(s));
          }),
        ),
      ),
    );

    const commandQueue = yield* Queue.bounded<A>(COMMAND_QUEUE_CAPACITY);

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const action = yield* Queue.take(commandQueue);
          yield* put(action);
        }),
      ),
    );

    // Fork the single root process
    yield* Effect.forkScoped(config.process(ctx));

    const handle: StoreHandle<S, A> = {
      put: (action: A) => {
        if (!Queue.unsafeOffer(commandQueue, action)) {
          throw new Error(
            `Store command queue is full (${COMMAND_QUEUE_CAPACITY} pending actions) — this is probably a bug. ` +
              "Are you dispatching in a tight loop?",
          );
        }
      },
      subscribe: (fn: (state: S) => void): (() => void) => {
        listeners.add(fn);
        fn(current);
        return () => listeners.delete(fn);
      },
      getState: () => current,
    };

    return { put, select, actions, state, handle };
  });
}
