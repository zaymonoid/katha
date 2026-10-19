/**
 * Defect policy — internal. One rule, applied at every isolation point: a
 * failure is logged where it happens, under a label naming what failed, with
 * the cause as structured log data (`Effect.logError(label, cause)` hands it to
 * the logger as `cause`, not stringified into the message). Interrupt-only
 * causes are never logged or caught: they are scope shutdown, and must still
 * stop whatever they reach.
 *
 * Effect 4 reports nothing when a forked fiber fails, so a failure that isn't
 * logged by one of these is silent.
 */

import { Cause, Effect, type Fiber, type Scope } from "effect";

/** Is `cause` a real failure — anything but interruption alone? */
export const isFailure = (cause: Cause.Cause<unknown>): boolean => !Cause.hasInterruptsOnly(cause);

/**
 * Log a failure of `effect` under `label`, then re-raise it unchanged so
 * callers still see it. For operations whose callers decide what happens next.
 */
export const logFailure =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tapCause(effect, (cause) =>
      isFailure(cause) ? Effect.logError(label, cause) : Effect.void,
    );

/**
 * Catch every non-interrupt failure of `effect` with `onFailure`. Only
 * interruption is left uncaught, and it carries no typed error — hence `never`.
 */
const catchFailures =
  (onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(Effect.asVoid, Effect.catchCauseIf(isFailure, onFailure)) as Effect.Effect<
      void,
      never,
      R
    >;

/**
 * Log a failure of `effect` under `label` and swallow it — for a loop body or
 * a forked handler, which must outlive one bad iteration. Interruption still
 * propagates.
 */
export const isolate = (
  label: string,
): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void, never, R>) =>
  catchFailures((cause) => Effect.logError(label, cause));

/**
 * {@linkcode isolate} for a body that retries on every trigger, where a
 * persistent failure would otherwise log on each one: a failure is logged only
 * when it differs from the previous run's, and a success resets. Stateful —
 * make one per loop.
 */
export const isolateDeduped = (
  label: string,
): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void, never, R>) => {
  let last: string | undefined;
  const swallow = catchFailures((cause) =>
    Effect.suspend(() => {
      const signature = String(Cause.squash(cause));
      if (signature === last) return Effect.void;
      last = signature;
      return Effect.logError(label, cause);
    }),
  );
  return (effect) =>
    swallow(
      Effect.tap(effect, () =>
        Effect.sync(() => {
          last = undefined;
        }),
      ),
    );
};

/**
 * Fork `handler` into the current scope, isolated: a sync throw while building
 * its Effect or a failure while running it is logged under `label` and ends
 * only this fiber. Deferred, so the throw happens inside the fork rather than
 * in the caller's listener loop.
 */
export const forkHandler = <E, R>(
  label: string,
  handler: () => Effect.Effect<void, E, R>,
): Effect.Effect<Fiber.Fiber<void>, never, R | Scope.Scope> =>
  Effect.forkScoped(isolate(label)(Effect.suspend(handler)));
