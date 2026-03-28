/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { Effect, TestClock, TestContext } from "effect";
import { debounce, take, takeEvery, takeLatest, takeLeading } from "../src/combinators.ts";
import { makeStore } from "../src/makeStore.ts";
import {
  letProcessSubscribe,
  reduce,
  type State,
  settle,
  type TestAction,
} from "./test-helpers.ts";

Deno.test("take resolves on matching action", () =>
  Effect.gen(function* () {
    let matched = false;
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: (ctx) =>
        Effect.gen(function* () {
          const action = yield* take(ctx, ["inc"]);
          assertEquals(action.id, "inc");
          matched = true;
        }),
    });
    yield* letProcessSubscribe;
    store.handle.put({ id: "inc" });
    yield* settle(() => matched);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("take ignores non-matching actions", () =>
  Effect.gen(function* () {
    let resolved = false;
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* take(ctx, ["inc"]);
          resolved = true;
        }),
    });
    yield* letProcessSubscribe;
    store.handle.put({ id: "dec" });
    yield* settle(() => store.handle.getState().count === -1);
    assertEquals(resolved, false);

    store.handle.put({ id: "inc" });
    yield* settle(() => resolved);
    assertEquals(resolved, true);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("takeEvery forks handler for each match", () =>
  Effect.gen(function* () {
    const handled: string[] = [];
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: takeEvery<State, TestAction, "inc", never>(["inc"], (action) =>
        Effect.sync(() => {
          handled.push(action.id);
        }),
      ),
    });
    yield* letProcessSubscribe;
    store.handle.put({ id: "inc" });
    yield* settle(() => handled.length >= 1);
    store.handle.put({ id: "dec" }); // should be ignored
    yield* settle(() => store.handle.getState().count === 1);
    store.handle.put({ id: "inc" });
    yield* settle(() => handled.length >= 2);
    assertEquals(handled, ["inc", "inc"]);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("takeLatest cancels previous handler", () =>
  Effect.gen(function* () {
    const completed: number[] = [];
    let call = 0;
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: takeLatest<State, TestAction, "inc", never>(["inc"], () => {
        const myCall = ++call;
        return Effect.gen(function* () {
          yield* Effect.sleep("50 millis");
          completed.push(myCall);
        });
      }),
    });
    yield* letProcessSubscribe;

    store.handle.put({ id: "inc" }); // call 1 — should be cancelled
    yield* settle(() => call >= 1);
    store.handle.put({ id: "inc" }); // call 2 — should complete
    yield* settle(() => call >= 2);

    yield* TestClock.adjust("100 millis");
    yield* settle(() => completed.length >= 1);

    assertEquals(completed, [2]);
  }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise));

Deno.test("takeLeading ignores while handler runs", () =>
  Effect.gen(function* () {
    const completed: number[] = [];
    let call = 0;
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: takeLeading<State, TestAction, "inc", never>(["inc"], () => {
        const myCall = ++call;
        return Effect.gen(function* () {
          yield* Effect.sleep("50 millis");
          completed.push(myCall);
        });
      }),
    });
    yield* letProcessSubscribe;

    store.handle.put({ id: "inc" }); // call 1 — accepted
    yield* settle(() => call >= 1);
    store.handle.put({ id: "inc" }); // call 2 — should be ignored (1 still running)
    yield* settle(() => store.handle.getState().count === 2);

    yield* TestClock.adjust("100 millis");
    yield* settle(() => completed.length >= 1);

    // Only the first handler should have run
    assertEquals(completed, [1]);
  }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise));

Deno.test("debounce fires after quiet period", () =>
  Effect.gen(function* () {
    const handled: string[] = [];
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: debounce<State, TestAction, "inc", never>("100 millis", ["inc"], (action) =>
        Effect.sync(() => {
          handled.push(action.id);
        }),
      ),
    });
    yield* letProcessSubscribe;

    store.handle.put({ id: "inc" });
    yield* settle(() => store.handle.getState().count === 1);

    yield* TestClock.adjust("100 millis");
    yield* settle(() => handled.length >= 1);

    assertEquals(handled, ["inc"]);
  }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise));

Deno.test("debounce resets timer on repeated actions", () =>
  Effect.gen(function* () {
    const handled: string[] = [];
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: debounce<State, TestAction, "inc", never>("100 millis", ["inc"], (action) =>
        Effect.sync(() => {
          handled.push(action.id);
        }),
      ),
    });
    yield* letProcessSubscribe;

    store.handle.put({ id: "inc" });
    yield* settle(() => store.handle.getState().count === 1);

    // Advance only 50ms — handler should not have fired yet
    yield* TestClock.adjust("50 millis");
    yield* settle(() => store.handle.getState().count === 1);
    assertEquals(handled, []);

    // Fire again — resets the debounce timer
    store.handle.put({ id: "inc" });
    yield* settle(() => store.handle.getState().count === 2);

    // Advance 50ms from the second fire — still not enough (need 100ms from last)
    yield* TestClock.adjust("50 millis");
    yield* settle(() => store.handle.getState().count === 2);
    assertEquals(handled, []);

    // Now complete the 100ms quiet period after the last action
    yield* TestClock.adjust("50 millis");
    yield* settle(() => handled.length >= 1);
    assertEquals(handled, ["inc"]);
  }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise));

Deno.test("multiple combinators on the same store", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: (ctx) =>
        Effect.gen(function* () {
          // takeEvery on "inc" — logs every inc
          yield* takeEvery<State, TestAction, "inc", never>(["inc"], () =>
            Effect.sync(() => {
              log.push("every:inc");
            }),
          )(ctx);
          // takeLatest on "dec" — only the last dec handler completes
          yield* takeLatest<State, TestAction, "dec", never>(["dec"], () =>
            Effect.gen(function* () {
              yield* Effect.sleep("50 millis");
              log.push("latest:dec");
            }),
          )(ctx);
          // debounce on "reset" — fires after quiet period
          yield* debounce<State, TestAction, "reset", never>("100 millis", ["reset"], () =>
            Effect.sync(() => {
              log.push("debounce:reset");
            }),
          )(ctx);
        }),
    });
    yield* letProcessSubscribe;

    // Fire inc twice — takeEvery should handle both
    store.handle.put({ id: "inc" });
    yield* settle(() => log.length >= 1);
    store.handle.put({ id: "inc" });
    yield* settle(() => log.length >= 2);
    assertEquals(log.filter((e) => e === "every:inc").length, 2);

    // Fire dec twice — takeLatest should cancel the first
    store.handle.put({ id: "dec" });
    yield* settle(() => store.handle.getState().count === 1);
    store.handle.put({ id: "dec" });
    yield* settle(() => store.handle.getState().count === 0);

    yield* TestClock.adjust("100 millis");
    yield* settle(() => log.includes("latest:dec"));
    assertEquals(log.filter((e) => e === "latest:dec").length, 1);

    // Fire reset — debounce should wait for quiet period
    store.handle.put({ id: "reset" });
    yield* settle(() => store.handle.getState().count === 0);

    yield* TestClock.adjust("100 millis");
    yield* settle(() => log.includes("debounce:reset"));
    assertEquals(log.filter((e) => e === "debounce:reset").length, 1);

    // Verify all three combinators fired
    assertEquals(log, ["every:inc", "every:inc", "latest:dec", "debounce:reset"]);
  }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise));
