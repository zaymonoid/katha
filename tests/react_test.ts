/// <reference lib="deno.ns" />

/**
 * Integration tests for the React `fromStore` hook.
 *
 * Uses happy-dom for a minimal DOM environment and @testing-library/react's
 * renderHook + act to drive the hook through real React render cycles.
 */

import { Window } from "happy-dom";

// Set up a minimal DOM before React loads — React probes for document at import time.
const win = new Window();
Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  customElements: win.customElements,
});

import { assertEquals, assertStrictEquals } from "@std/assert";
import { act, renderHook } from "@testing-library/react";
import { Effect } from "effect";
import { makeStore } from "../src/makeStore.ts";
import { useSelector } from "../src/react.ts";
import { noop, reduce, type State, settle, type TestAction } from "./test-helpers.ts";

// React + happy-dom manage their own timers; disable Deno's leak detection for these tests.
const sanitize = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name: "useSelector returns initial state",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      const store = yield* makeStore<State, TestAction, never>({
        initialState: { count: 0 },
        reduce,
        process: noop,
      });
      const { result } = renderHook(() => useSelector(store.handle, (s) => s.count));
      assertEquals(result.current, 0);
    }).pipe(Effect.scoped, Effect.runPromise),
});

Deno.test({
  name: "useSelector updates on dispatch",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      const store = yield* makeStore<State, TestAction, never>({
        initialState: { count: 0 },
        reduce,
        process: noop,
      });

      const { result } = renderHook(() => useSelector(store.handle, (s) => s.count));
      assertEquals(result.current, 0);

      store.handle.put({ id: "inc" });
      yield* settle(() => store.handle.getState().count === 1);

      // act() flushes React's update queue so the hook re-renders
      act(() => {});
      assertEquals(result.current, 1);
    }).pipe(Effect.scoped, Effect.runPromise),
});

Deno.test({
  name: "useSelector supports derived selectors",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      const store = yield* makeStore<State, TestAction, never>({
        initialState: { count: 5 },
        reduce,
        process: noop,
      });

      const { result } = renderHook(() =>
        useSelector(store.handle, (s) => ({ doubled: s.count * 2 })),
      );
      assertEquals(result.current, { doubled: 10 });

      store.handle.put({ id: "inc" });
      yield* settle(() => store.handle.getState().count === 6);

      act(() => {});
      assertEquals(result.current, { doubled: 12 });
    }).pipe(Effect.scoped, Effect.runPromise),
});

Deno.test({
  name: "useSelector deep equality prevents spurious object identity changes",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      const store = yield* makeStore<State, TestAction, never>({
        initialState: { count: 0 },
        reduce,
        process: noop,
      });

      // Selector always returns a new object, but with the same shape
      const { result } = renderHook(() => useSelector(store.handle, (s) => ({ count: s.count })));

      // Dispatch reset — state is still { count: 0 }, but getSnapshot runs again
      // producing a structurally equal but referentially new object.
      // Deep equality should return the same reference.
      const before = result.current;
      store.handle.put({ id: "reset" });
      yield* settle(() => store.handle.getState().count === 0);
      act(() => {});

      assertStrictEquals(result.current, before);
    }).pipe(Effect.scoped, Effect.runPromise),
});

Deno.test({
  name: "useSelector does not re-render when selected slice is unchanged",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      type MultiState = { count: number; label: string };
      type MultiAction =
        | { id: "inc" }
        | { id: "dec" }
        | { id: "reset" }
        | { id: "relabel"; label: string };

      const store = yield* makeStore<MultiState, MultiAction, never>({
        initialState: { count: 0, label: "hello" },
        reduce: (s, a) => {
          switch (a.id) {
            case "inc":
              return { ...s, count: s.count + 1 };
            case "relabel":
              return { ...s, label: a.label };
            default:
              return s;
          }
        },
        process: noop,
      });

      let renderCount = 0;
      const { result } = renderHook(() => {
        renderCount++;
        return useSelector(store.handle, (s) => s.count);
      });

      assertEquals(result.current, 0);
      const initialRenders = renderCount;

      // Mutate a different slice — count selector should NOT re-render
      store.handle.put({ id: "relabel", label: "world" });
      yield* settle(() => store.handle.getState().label === "world");
      act(() => {});

      assertEquals(
        renderCount,
        initialRenders,
        "should not re-render when unrelated slice changes",
      );
      assertEquals(result.current, 0);

      // Now mutate count — should re-render
      store.handle.put({ id: "inc" });
      yield* settle(() => store.handle.getState().count === 1);
      act(() => {});

      assertEquals(
        renderCount,
        initialRenders + 1,
        "should re-render exactly once when selected slice changes",
      );
      assertEquals(result.current, 1);
    }).pipe(Effect.scoped, Effect.runPromise),
});

Deno.test({
  name: "useSelector with derived object skips re-render on deep-equal result",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      const store = yield* makeStore<State, TestAction, never>({
        initialState: { count: 0 },
        reduce,
        process: noop,
      });

      let renderCount = 0;
      const { result } = renderHook(() => {
        renderCount++;
        return useSelector(store.handle, (s) => ({ even: s.count % 2 === 0 }));
      });

      assertEquals(result.current, { even: true });
      const initialRenders = renderCount;

      // inc twice: 0 -> 1 -> 2. The derived value { even: true } is the same at 0 and 2.
      store.handle.put({ id: "inc" });
      yield* settle(() => store.handle.getState().count === 1);
      act(() => {});

      assertEquals(result.current, { even: false }, "should be odd after first inc");
      assertEquals(renderCount, initialRenders + 1, "should re-render exactly once: even changed");

      store.handle.put({ id: "inc" });
      yield* settle(() => store.handle.getState().count === 2);
      act(() => {});

      assertEquals(result.current, { even: true }, "should be even again");
      assertEquals(
        renderCount,
        initialRenders + 2,
        "should re-render exactly once more: even changed back",
      );

      // Now dispatch reset — count stays 0 which is still even.
      // But store state actually changes (count 2 -> 0), so subscribe fires.
      // Deep equality on the derived { even: true } should prevent a re-render.
      store.handle.put({ id: "reset" });
      yield* settle(() => store.handle.getState().count === 0);
      act(() => {});

      assertEquals(result.current, { even: true });
      assertEquals(
        renderCount,
        initialRenders + 2,
        "should NOT re-render: derived value unchanged",
      );
    }).pipe(Effect.scoped, Effect.runPromise),
});

Deno.test({
  name: "useSelector cleans up subscription on unmount",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      const store = yield* makeStore<State, TestAction, never>({
        initialState: { count: 0 },
        reduce,
        process: noop,
      });

      const { result, unmount } = renderHook(() => useSelector(store.handle, (s) => s.count));
      assertEquals(result.current, 0);

      unmount();

      // Dispatch after unmount — should not throw or update
      store.handle.put({ id: "inc" });
      yield* settle(() => store.handle.getState().count === 1);
      // If cleanup failed, this would throw or the value would have changed
      // Since unmounted, result.current retains the last rendered value
      assertEquals(result.current, 0);
    }).pipe(Effect.scoped, Effect.runPromise),
});

Deno.test({
  name: "useSelector handles multiple rapid dispatches",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      const store = yield* makeStore<State, TestAction, never>({
        initialState: { count: 0 },
        reduce,
        process: noop,
      });

      const { result } = renderHook(() => useSelector(store.handle, (s) => s.count));

      store.handle.put({ id: "inc" });
      store.handle.put({ id: "inc" });
      store.handle.put({ id: "inc" });

      yield* settle(() => store.handle.getState().count === 3);
      act(() => {});
      assertEquals(result.current, 3);
    }).pipe(Effect.scoped, Effect.runPromise),
});

Deno.test({
  name: "useSelector swallows immediate subscribe call (useSyncExternalStore contract)",
  ...sanitize,
  fn: () =>
    Effect.gen(function* () {
      const store = yield* makeStore<State, TestAction, never>({
        initialState: { count: 0 },
        reduce,
        process: noop,
      });

      // StoreHandle.subscribe calls the listener immediately. If that call
      // leaks through to useSyncExternalStore's onStoreChange, React may
      // schedule a spurious synchronous re-render during commit. Verify that
      // the initial render count is exactly what React itself produces — no
      // extra renders from the immediate subscribe callback.
      let renderCount = 0;
      const { result } = renderHook(() => {
        renderCount++;
        return useSelector(store.handle, (s) => s.count);
      });

      assertEquals(result.current, 0);
      // React 18 renders once in non-strict mode. If the immediate subscribe
      // leaked, we'd see 2+ renders here.
      assertEquals(
        renderCount,
        1,
        "should render exactly once on mount — no extra render from subscribe",
      );
    }).pipe(Effect.scoped, Effect.runPromise),
});
