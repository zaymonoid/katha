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

/** Effect-side context passed to processes and combinators. */
export interface StoreContext<S, A extends Action> {
  /** Raw action stream — for combinators to subscribe. */
  readonly actions: PubSub.PubSub<A>;
  /** Reactive state ref. */
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  /** Reduce action into state, then publish to action subscribers. */
  readonly put: (action: A) => Effect.Effect<void>;
  /** Read the current state snapshot. */
  readonly select: () => Effect.Effect<S>;
}

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
  /** Raw action stream for combinators. */
  readonly actions: PubSub.PubSub<A>;
  /** Reactive state ref. */
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  /** Pre-built plain JS handle (used by UI). */
  readonly handle: StoreHandle<S, A>;
}
