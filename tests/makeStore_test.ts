/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { Effect } from "effect";
import { makeStore } from "../src/makeStore.ts";
import type { StoreContext } from "../src/types.ts";
import { noop, reduce, type State, settle, type TestAction } from "./test-helpers.ts";

Deno.test("initial state is accessible via handle.getState", () =>
  Effect.gen(function* () {
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    assertEquals(store.handle.getState(), { count: 0 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("handle.put dispatches action and reduces state", () =>
  Effect.gen(function* () {
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    store.handle.put({ id: "inc" });
    yield* settle(() => store.handle.getState().count === 1);
    assertEquals(store.handle.getState(), { count: 1 });

    store.handle.put({ id: "dec" });
    yield* settle(() => store.handle.getState().count === 0);
    assertEquals(store.handle.getState(), { count: 0 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("handle.subscribe fires on state change", () =>
  Effect.gen(function* () {
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    const observed: State[] = [];
    store.handle.subscribe((s) => observed.push(s));

    store.handle.put({ id: "inc" });
    yield* settle(() => observed.length >= 2);

    // First call is the initial state (subscribe fires immediately), second is after inc
    assertEquals(observed, [{ count: 0 }, { count: 1 }]);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("handle.subscribe unsubscribe stops notifications", () =>
  Effect.gen(function* () {
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    const observed: State[] = [];
    const unsub = store.handle.subscribe((s) => observed.push(s));

    store.handle.put({ id: "inc" });
    yield* settle(() => observed.length >= 2);

    unsub();

    store.handle.put({ id: "inc" });
    yield* settle(() => store.handle.getState().count === 2);

    // Should only see initial + first inc, not the second
    assertEquals(observed, [{ count: 0 }, { count: 1 }]);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("actions are processed sequentially", () =>
  Effect.gen(function* () {
    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    store.handle.put({ id: "inc" });
    store.handle.put({ id: "inc" });
    store.handle.put({ id: "inc" });
    store.handle.put({ id: "dec" });

    yield* settle(() => store.handle.getState().count === 2);

    assertEquals(store.handle.getState(), { count: 2 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process receives context and runs", () =>
  Effect.gen(function* () {
    let processRan = false;
    yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: (_ctx: StoreContext<State, TestAction>) =>
        Effect.sync(() => {
          processRan = true;
        }),
    });
    yield* settle(() => processRan);
    assertEquals(processRan, true);
  }).pipe(Effect.scoped, Effect.runPromise));
