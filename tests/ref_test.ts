/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { Effect } from "effect";
import { makeStore } from "../src/makeStore.ts";
import { createStoreRef } from "../src/ref.ts";
import { noop, reduce, type State, settle, type TestAction } from "./test-helpers.ts";

Deno.test("getState returns initial before attach", () => {
  const { ref } = createStoreRef<State, TestAction>({ count: 0 });
  assertEquals(ref.getState(), { count: 0 });
});

Deno.test("put buffers actions before attach", () =>
  Effect.gen(function* () {
    const { ref, attach } = createStoreRef<State, TestAction>({ count: 0 });

    ref.put({ id: "inc" });
    ref.put({ id: "inc" });

    // State unchanged before attach
    assertEquals(ref.getState(), { count: 0 });

    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    attach(store);
    yield* settle(() => ref.getState().count === 2);

    assertEquals(ref.getState(), { count: 2 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("attach flushes buffered actions", () =>
  Effect.gen(function* () {
    const { ref, attach } = createStoreRef<State, TestAction>({ count: 0 });

    ref.put({ id: "inc" });
    ref.put({ id: "inc" });
    ref.put({ id: "dec" });

    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    attach(store);
    yield* settle(() => ref.getState().count === 1);

    assertEquals(ref.getState(), { count: 1 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("subscribe before attach receives updates after attach", () =>
  Effect.gen(function* () {
    const { ref, attach } = createStoreRef<State, TestAction>({ count: 0 });

    const observed: State[] = [];
    ref.subscribe((s) => observed.push(s));

    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    attach(store);
    yield* settle(() => observed.length >= 1);

    // subscribe is replayed on attach — fires with initial state
    assertEquals(observed[0], { count: 0 });

    ref.put({ id: "inc" });
    yield* settle(() => observed[observed.length - 1]?.count === 1);

    assertEquals(observed[observed.length - 1], { count: 1 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("unsubscribe before attach is honoured", () =>
  Effect.gen(function* () {
    const { ref, attach } = createStoreRef<State, TestAction>({ count: 0 });

    const observed: State[] = [];
    const unsub = ref.subscribe((s) => observed.push(s));
    unsub();

    const store = yield* makeStore<State, TestAction, never>({
      initialState: { count: 0 },
      reduce,
      process: noop,
    });
    attach(store);

    ref.put({ id: "inc" });
    yield* settle(() => ref.getState().count === 1);

    // Should not have received any updates since we unsubbed before attach
    assertEquals(observed, []);
  }).pipe(Effect.scoped, Effect.runPromise));
