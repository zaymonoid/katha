import { Effect } from "effect";

export type State = { count: number };
export type Inc = { id: "inc" };
export type Dec = { id: "dec" };
export type Reset = { id: "reset" };
export type TestAction = Inc | Dec | Reset;

export const reduce = (s: State, a: TestAction): State => {
  switch (a.id) {
    case "inc":
      return { count: s.count + 1 };
    case "dec":
      return { count: s.count - 1 };
    case "reset":
      return { count: 0 };
  }
};

/** Yield to the scheduler until `predicate` returns true, or time out. */
export const settle = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) yield* Effect.yieldNow();
  }).pipe(Effect.timeout("500 millis"), Effect.orDie);

/**
 * Let the root process fiber reach its PubSub subscription.
 * Needed in tests because makeStore forks the root process — the subscribe
 * happens in a child fiber that must run before the test publishes actions.
 */
export const letProcessSubscribe = Effect.yieldNow().pipe(Effect.repeatN(5));

export const noop = () => Effect.void;
