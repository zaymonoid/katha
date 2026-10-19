/**
 * Core store types.
 *
 * Separated into Effect-side (`Store`) and plain-JS (`StoreHandle`) interfaces.
 * Consumers interact with `StoreHandle` — no Effect types leak to the UI.
 */

import type { Effect, PubSub, Scope, SubscriptionRef } from "effect";

export type Action = { readonly id: string };

/**
 * Narrow an action union to variants matching the given ID(s).
 *
 * The conditional `A extends A` distributes over the union, forcing
 * TypeScript to eagerly resolve each member. Tooltips show the
 * concrete narrowed variants instead of `ActionOf<BigUnion, K>`.
 */
export type ActionOf<A extends Action, K extends A["id"]> = A extends { id: K } ? A : never;

/** An action paired with the state its reduction produced. */
export interface Transition<S, A extends Action> {
  readonly action: A;
  /** State right after `action` was reduced — before any later action. */
  readonly state: S;
}

/** Effect-side context passed to processes and combinators. */
export interface StoreContext<S, A extends Action> {
  /**
   * The store's event stream: every put action, once, in reducer order, paired
   * with the state its own reduction produced. The single source the
   * combinators and every other listener subscribe to — take `.action` for the
   * action alone. Prefer `state` here over `select()` in a handler: by the time
   * a subscriber takes a transition, `select()` may already reflect later
   * actions.
   */
  readonly transitions: PubSub.PubSub<Transition<S, A>>;
  /** Reactive state ref. */
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  /** Reduce action into state, then publish its transition to subscribers. */
  readonly put: (action: A) => Effect.Effect<void>;
  /** Read the current state snapshot. */
  readonly select: () => Effect.Effect<S>;
}

/**
 * A long-running saga, forked once by {@link makeStore}-style factories as the
 * store's root process.
 *
 * Startup contract: subscribe to `ctx.transitions` before awaiting anything
 * async, or actions put early may be missed. The root process starts
 * immediately and runs synchronously to its first suspension before the store
 * is returned; the combinators (`takeEvery` & co) subscribe in that first
 * slice.
 *
 * How early is "early" depends on how the action is put:
 * - `handle.put` is queued for the command loop, which the scheduler runs
 *   after anything the process already queued — so a subscription made in a
 *   child the process forked, before awaiting anything, is also in place.
 * - An Effect-side `store.put` right after the store is made reduces and
 *   publishes in the caller's fiber, with no scheduler step in between. Only
 *   subscriptions made in the root's initial synchronous slice are guaranteed
 *   to see it; one made inside a forked child may not exist yet.
 */
export type Process<S, A extends Action, R = never> = (
  ctx: StoreContext<S, A>,
) => Effect.Effect<void, never, R | Scope.Scope>;

export interface StoreConfig<S, A extends Action, R> {
  readonly initialState: S;
  readonly reduce?: (state: S, action: A) => S | undefined;
  readonly process: Process<S, A, R>;
}

/** Plain JS handle — no Effect types. Safe for UI code to import and use. */
export interface StoreHandle<S, A extends Action> {
  readonly put: (action: A) => void;
  readonly subscribe: (fn: (state: S) => void) => () => void;
  readonly getState: () => S;
}

/** Full store — both Effect-side internals and the pre-built plain JS handle. */
export interface Store<S, A extends Action> {
  /** Effect-side (used by processes, internal wiring). */
  readonly put: (action: A) => Effect.Effect<void>;
  /** Read the current state snapshot. */
  readonly select: () => Effect.Effect<S>;
  /**
   * Every put action, once, in reducer order, paired with the state its own
   * reduction produced. See {@link StoreContext.transitions}.
   */
  readonly transitions: PubSub.PubSub<Transition<S, A>>;
  /** Reactive state ref. */
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  /** Pre-built plain JS handle (used by UI). */
  readonly handle: StoreHandle<S, A>;
}
