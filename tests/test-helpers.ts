import { type Cause, Effect, Logger } from "effect";

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
    while (!predicate()) yield* Effect.yieldNow;
  }).pipe(Effect.timeout("500 millis"), Effect.orDie);

/**
 * Let the root process fiber reach its PubSub subscription.
 * Needed in tests because makeStore forks the root process — the subscribe
 * happens in a child fiber that must run before the test publishes actions.
 */
export const letProcessSubscribe = Effect.yieldNow.pipe(Effect.repeat({ times: 5 }));

export const noop = () => Effect.void;

/** One captured log line: the message parts joined, and the structured cause. */
export type LogEntry = { readonly message: string; readonly cause: Cause.Cause<unknown> };

/**
 * A logger that records instead of printing. Provide `layer` over the whole
 * test so the store's forked fibers inherit it; it replaces the default logger.
 */
export const captureLogs = () => {
  const entries: LogEntry[] = [];
  const layer = Logger.layer([
    Logger.make(({ message, cause }) => {
      entries.push({ message: (Array.isArray(message) ? message : [message]).join(" "), cause });
    }),
  ]);
  const matching = (text: string): LogEntry[] => entries.filter((e) => e.message.includes(text));
  return { entries, layer, matching };
};
