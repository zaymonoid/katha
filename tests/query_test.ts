/// <reference lib="deno.ns" />

import { combineReducers, makeStore } from "../src/index.ts";
import { assertEquals } from "@std/assert";
import { Effect } from "effect";
import {
  defineQuery,
  initialQueriesState,
  type QueriesState,
  type QueryState,
  queriesReducer,
} from "../src/query.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const settle = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) yield* Effect.yieldNow();
  }).pipe(Effect.timeout("500 millis"), Effect.orDie);

const letProcessSubscribe = Effect.yieldNow().pipe(Effect.repeatN(5));

// Minimal app state for testing — just queries + a simple "nav" slice
type NavState = { selectedMonth: string | null };
type NavAction = { id: "select-month"; data: string };
const navReducer = (_s: NavState, a: NavAction): NavState | undefined => {
  if (a.id === "select-month") return { selectedMonth: a.data };
  return undefined;
};

const rootReducer = combineReducers({
  nav: navReducer,
  queries: queriesReducer,
});

type TestState = { nav: NavState; queries: QueriesState };

const initialState: TestState = {
  nav: { selectedMonth: null },
  queries: initialQueriesState,
};

// ---------------------------------------------------------------------------
// Reducer tests
// ---------------------------------------------------------------------------

Deno.test("query-started on empty cache creates loading entry", () => {
  const state = queriesReducer(initialQueriesState, {
    id: "query-started",
    data: { queryId: "summary:2026-1:combined" },
  });
  assertEquals(state?.cache["summary:2026-1:combined"], {
    status: "loading",
    data: undefined,
    error: undefined,
    isFetching: true,
    dataUpdatedAt: undefined,
  });
});

Deno.test("query-started on existing entry preserves data (SWR)", () => {
  const existing: QueriesState = {
    cache: {
      "summary:2026-1:combined": {
        status: "success",
        data: { total: 100 },
        error: undefined,
        isFetching: false,
        dataUpdatedAt: 1000,
      },
    },
  };
  const state = queriesReducer(existing, {
    id: "query-started",
    data: { queryId: "summary:2026-1:combined" },
  });
  assertEquals(state?.cache["summary:2026-1:combined"]?.data, { total: 100 });
  assertEquals(state?.cache["summary:2026-1:combined"]?.isFetching, true);
  assertEquals(state?.cache["summary:2026-1:combined"]?.status, "success");
});

Deno.test("query-success sets data and status", () => {
  const state = queriesReducer(initialQueriesState, {
    id: "query-success",
    data: { queryId: "summary:2026-1:combined", result: { total: 200 }, dataUpdatedAt: 9999 },
  });
  assertEquals(state?.cache["summary:2026-1:combined"]?.status, "success");
  assertEquals(state?.cache["summary:2026-1:combined"]?.data, { total: 200 });
  assertEquals(state?.cache["summary:2026-1:combined"]?.isFetching, false);
  assertEquals(state?.cache["summary:2026-1:combined"]?.dataUpdatedAt, 9999);
});

Deno.test("query-error preserves stale data", () => {
  const existing: QueriesState = {
    cache: {
      "summary:2026-1:combined": {
        status: "success",
        data: { total: 100 },
        error: undefined,
        isFetching: true,
        dataUpdatedAt: 1000,
      },
    },
  };
  const state = queriesReducer(existing, {
    id: "query-error",
    data: { queryId: "summary:2026-1:combined", error: "Network error" },
  });
  assertEquals(state?.cache["summary:2026-1:combined"]?.status, "error");
  assertEquals(state?.cache["summary:2026-1:combined"]?.data, { total: 100 });
  assertEquals(state?.cache["summary:2026-1:combined"]?.error, "Network error");
  assertEquals(state?.cache["summary:2026-1:combined"]?.isFetching, false);
});

Deno.test("query-invalidate removes matching entries", () => {
  const existing: QueriesState = {
    cache: {
      "summary:2026-1:combined": {
        status: "success",
        data: { total: 100 },
        error: undefined,
        isFetching: false,
        dataUpdatedAt: 1000,
      },
      "summary:2026-2:combined": {
        status: "success",
        data: { total: 200 },
        error: undefined,
        isFetching: false,
        dataUpdatedAt: 2000,
      },
      "settlement:2026-1": {
        status: "success",
        data: { net: 50 },
        error: undefined,
        isFetching: false,
        dataUpdatedAt: 3000,
      },
    },
  };
  const state = queriesReducer(existing, {
    id: "query-invalidate",
    data: { queryName: "summary" },
  });
  assertEquals(state?.cache["summary:2026-1:combined"], undefined);
  assertEquals(state?.cache["summary:2026-2:combined"], undefined);
  assertEquals(state?.cache["settlement:2026-1"]?.data, { net: 50 });
});

Deno.test("unhandled action returns undefined (no change)", () => {
  const result = queriesReducer(initialQueriesState, {
    id: "some-other-action",
  } as unknown as Parameters<typeof queriesReducer>[1]);
  assertEquals(result, undefined);
});

// ---------------------------------------------------------------------------
// defineQuery tests
// ---------------------------------------------------------------------------

const testQuery = defineQuery<{ total: number }, TestState>("test", (state) => {
  if (!state.nav.selectedMonth) return null;
  return {
    key: `${state.nav.selectedMonth}:combined`,
    fetch: Effect.succeed({ total: 42 }),
  };
});

Deno.test("defineQuery select reads from cache with correct type", () => {
  const state: TestState = {
    nav: { selectedMonth: "2026-1" },
    queries: {
      cache: {
        "test:2026-1:combined": {
          status: "success",
          data: { total: 42 },
          error: undefined,
          isFetching: false,
          dataUpdatedAt: 1000,
        },
      },
    },
  };
  const result = testQuery.select(state);
  assertEquals(result?.data, { total: 42 });
  const _typed: QueryState<{ total: number }> | undefined = result; // biome-ignore lint/correctness/noUnusedVariables: type assertion
});

Deno.test("defineQuery select returns undefined when derive returns null", () => {
  const state: TestState = {
    nav: { selectedMonth: null },
    queries: { cache: {} },
  };
  const result = testQuery.select(state);
  assertEquals(result, undefined);
});

Deno.test("defineQuery select returns undefined on cache miss", () => {
  const state: TestState = {
    nav: { selectedMonth: "2026-1" },
    queries: { cache: {} },
  };
  const result = testQuery.select(state);
  assertEquals(result, undefined);
});

Deno.test("defineQuery select finds cached entry when derive matches", () => {
  const state: TestState = {
    nav: { selectedMonth: "2026-1" },
    queries: {
      cache: {
        "test:2026-1:combined": {
          status: "success",
          data: { total: 99 },
          error: undefined,
          isFetching: false,
          dataUpdatedAt: 1000,
        },
      },
    },
  };
  const result = testQuery.select(state);
  assertEquals(result?.data, { total: 99 });
});

// ---------------------------------------------------------------------------
// Multi-key derive tests
// ---------------------------------------------------------------------------

type MultiState = { categories: string[]; queries: QueriesState };
const multiQuery = defineQuery<string[], MultiState>("multi", (state) =>
  state.categories.map((cat) => ({
    key: cat,
    fetch: Effect.succeed([cat]),
  })),
);

Deno.test("defineQuery with array derive returns multiple entries", () => {
  const state: MultiState = {
    categories: ["food", "transport"],
    queries: {
      cache: {
        "multi:food": {
          status: "success",
          data: ["food"],
          error: undefined,
          isFetching: false,
          dataUpdatedAt: 1000,
        },
      },
    },
  };

  // selectByKey looks up specific entries
  assertEquals(multiQuery.selectByKey(state, "food")?.data, ["food"]);
  assertEquals(multiQuery.selectByKey(state, "transport"), undefined);
});

// ---------------------------------------------------------------------------
// Overload type guards — single-key has select, multi-key has selectByKey
// ---------------------------------------------------------------------------

// @ts-expect-error: single-key queries expose select, not selectByKey
testQuery.selectByKey?.(initialState, "key");
// @ts-expect-error: multi-key queries expose selectByKey, not select
multiQuery.select?.({ categories: [], queries: initialQueriesState });

// ---------------------------------------------------------------------------
// Process integration tests
// ---------------------------------------------------------------------------

Deno.test("process: reactive refetch on state change", () =>
  Effect.gen(function* () {
    let fetchCount = 0;
    const q = defineQuery<{ total: number }, TestState>("reactive", (state) => {
      if (!state.nav.selectedMonth) return null;
      return {
        key: state.nav.selectedMonth,
        fetch: Effect.sync(() => {
          fetchCount++;
          return { total: fetchCount };
        }),
      };
    });

    const store = yield* makeStore({
      initialState,
      reduce: rootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    // No month selected → no fetch
    assertEquals(fetchCount, 0);

    // Select a month → triggers fetch
    store.handle.put({ id: "select-month", data: "2026-1" });
    yield* settle(() => fetchCount === 1);
    assertEquals(fetchCount, 1);

    yield* settle(
      () => store.handle.getState().queries.cache["reactive:2026-1"]?.status === "success",
    );
    assertEquals(store.handle.getState().queries.cache["reactive:2026-1"]?.data, { total: 1 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: skip when key is already in cache", () =>
  Effect.gen(function* () {
    let fetchCount = 0;
    const q = defineQuery<{ total: number }, TestState>("cached", (state) => {
      if (!state.nav.selectedMonth) return null;
      return {
        key: state.nav.selectedMonth,
        fetch: Effect.sync(() => {
          fetchCount++;
          return { total: fetchCount };
        }),
      };
    });

    const store = yield* makeStore({
      initialState: {
        ...initialState,
        nav: { selectedMonth: "2026-1" },
      },
      reduce: rootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    // Wait for initial reactive fetch
    yield* settle(() => fetchCount === 1);

    // Dispatch an unrelated action — shouldn't trigger a new fetch
    // since the key is already in cache
    store.handle.put({ id: "select-month", data: "2026-1" }); // same month
    yield* Effect.sleep("50 millis");
    assertEquals(fetchCount, 1);
  }).pipe(Effect.scoped, Effect.runPromise));

// Shared multi-key test helpers
type CatState = { categories: string[]; queries: QueriesState };
type AddCategoryAction = { id: "add-category"; data: string };
const catReducer = (s: string[], a: AddCategoryAction): string[] | undefined => {
  if (a.id === "add-category") return [...s, a.data];
  return undefined;
};
const catRootReducer = combineReducers({
  categories: catReducer,
  queries: queriesReducer,
});
const catInitialState: CatState = { categories: [], queries: initialQueriesState };

Deno.test("process: multi-key derive fetches all entries", () =>
  Effect.gen(function* () {
    const fetchedKeys: string[] = [];
    const q = defineQuery<string, CatState>("multiKey", (state) =>
      state.categories.map((cat) => ({
        key: cat,
        fetch: Effect.sync(() => {
          fetchedKeys.push(cat);
          return cat;
        }),
      })),
    );

    const store = yield* makeStore({
      initialState: catInitialState,
      reduce: catRootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    store.handle.put({ id: "add-category", data: "food" });
    yield* settle(() => fetchedKeys.includes("food"));

    store.handle.put({ id: "add-category", data: "transport" });
    yield* settle(() => fetchedKeys.includes("transport"));

    assertEquals(fetchedKeys.sort(), ["food", "transport"]);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: empty array derive transitions to populated", () =>
  Effect.gen(function* () {
    const fetchedKeys: string[] = [];
    const q = defineQuery<string, CatState>("emptyStart", (state) =>
      state.categories.map((cat) => ({
        key: cat,
        fetch: Effect.sync(() => {
          fetchedKeys.push(cat);
          return cat;
        }),
      })),
    );

    const store = yield* makeStore({
      initialState: catInitialState, // categories: []
      reduce: catRootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    // Empty derive → no fetches
    assertEquals(fetchedKeys.length, 0);

    // Add first category → fetches it
    store.handle.put({ id: "add-category", data: "food" });
    yield* settle(() => fetchedKeys.length === 1);
    assertEquals(fetchedKeys, ["food"]);

    yield* settle(
      () => store.handle.getState().queries.cache["emptyStart:food"]?.status === "success",
    );
    assertEquals(store.handle.getState().queries.cache["emptyStart:food"]?.data, "food");
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: invalidation causes refetch", () =>
  Effect.gen(function* () {
    let fetchCount = 0;
    const q = defineQuery<{ total: number }, TestState>("invalidated", (state) => {
      if (!state.nav.selectedMonth) return null;
      return {
        key: state.nav.selectedMonth,
        fetch: Effect.sync(() => {
          fetchCount++;
          return { total: fetchCount };
        }),
      };
    });

    const store = yield* makeStore({
      initialState: {
        ...initialState,
        nav: { selectedMonth: "2026-1" },
      },
      reduce: rootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    // Wait for initial fetch
    yield* settle(() => fetchCount === 1);

    // Invalidate — should trigger refetch
    store.handle.put({
      id: "query-invalidate",
      data: { queryName: "invalidated" },
    });
    yield* settle(() => fetchCount === 2);
    assertEquals(fetchCount, 2);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: SWR keeps data during refetch", () =>
  Effect.gen(function* () {
    let fetchCount = 0;
    const resolveRef: { current: (() => void) | null } = { current: null };

    const q = defineQuery<{ total: number }, TestState>("swr", (state) => {
      if (!state.nav.selectedMonth) return null;
      return {
        key: state.nav.selectedMonth,
        fetch: Effect.gen(function* () {
          fetchCount++;
          if (fetchCount === 2) {
            // Second fetch: wait for manual resolve
            yield* Effect.async<void>((resume) => {
              resolveRef.current = () => resume(Effect.void);
            });
          }
          return { total: fetchCount };
        }),
      };
    });

    const store = yield* makeStore({
      initialState: {
        ...initialState,
        nav: { selectedMonth: "2026-1" },
      },
      reduce: rootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    // Wait for initial fetch
    yield* settle(() => fetchCount === 1);
    yield* settle(() => store.handle.getState().queries.cache["swr:2026-1"]?.status === "success");
    assertEquals(store.handle.getState().queries.cache["swr:2026-1"]?.data, { total: 1 });

    // Invalidate to trigger refetch
    store.handle.put({
      id: "query-invalidate",
      data: { queryName: "swr" },
    });

    // Wait for second fetch to start
    yield* settle(() => fetchCount === 2);

    // Resolve the second fetch
    yield* settle(() => resolveRef.current !== null);
    (resolveRef.current as () => void)();

    yield* settle(() => store.handle.getState().queries.cache["swr:2026-1"]?.status === "success");
    assertEquals(store.handle.getState().queries.cache["swr:2026-1"]?.data, { total: 2 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: invalidation interrupts in-flight fetch and refetches", () =>
  Effect.gen(function* () {
    let fetchCount = 0;
    const resolveRefs: Array<() => void> = [];

    const q = defineQuery<{ total: number }, TestState>("interrupt", (state) => {
      if (!state.nav.selectedMonth) return null;
      return {
        key: state.nav.selectedMonth,
        fetch: Effect.gen(function* () {
          fetchCount++;
          const current = fetchCount;
          yield* Effect.async<void>((resume) => {
            resolveRefs[current - 1] = () => resume(Effect.void);
          });
          return { total: current };
        }),
      };
    });

    const store = yield* makeStore({
      initialState: {
        ...initialState,
        nav: { selectedMonth: "2026-1" },
      },
      reduce: rootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    // Wait for first fetch to start (blocked on manual resolve)
    yield* settle(() => fetchCount === 1);
    assertEquals(fetchCount, 1);

    // Invalidate while first fetch is in-flight
    store.handle.put({
      id: "query-invalidate",
      data: { queryName: "interrupt" },
    });

    // A second fetch should start — the first was interrupted
    yield* settle(() => fetchCount === 2);
    assertEquals(fetchCount, 2);

    // Resolve the second fetch
    yield* settle(() => resolveRefs[1] !== undefined);
    resolveRefs[1]();

    // Cache should contain the fresh result from the second fetch
    yield* settle(
      () => store.handle.getState().queries.cache["interrupt:2026-1"]?.status === "success",
    );
    assertEquals(store.handle.getState().queries.cache["interrupt:2026-1"]?.data, { total: 2 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: fetch error dispatches query-error and cleans up inflight", () =>
  Effect.gen(function* () {
    let fetchCount = 0;

    const q = defineQuery<{ total: number }, TestState>("erroring", (state) => {
      if (!state.nav.selectedMonth) return null;
      return {
        key: state.nav.selectedMonth,
        fetch: Effect.gen(function* () {
          fetchCount++;
          if (fetchCount === 1) return yield* Effect.fail("network down");
          return { total: fetchCount };
        }),
      };
    });

    const store = yield* makeStore({
      initialState: {
        ...initialState,
        nav: { selectedMonth: "2026-1" },
      },
      reduce: rootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    // First fetch fails
    yield* settle(() => fetchCount === 1);
    yield* settle(
      () => store.handle.getState().queries.cache["erroring:2026-1"]?.status === "error",
    );

    const entry = store.handle.getState().queries.cache["erroring:2026-1"];
    assertEquals(entry?.status, "error");
    assertEquals(entry?.error, "network down");
    assertEquals(entry?.isFetching, false);

    // Invalidate — should be able to refetch (inflight was cleaned up)
    store.handle.put({
      id: "query-invalidate",
      data: { queryName: "erroring" },
    });
    yield* settle(() => fetchCount === 2);
    yield* settle(
      () => store.handle.getState().queries.cache["erroring:2026-1"]?.status === "success",
    );
    assertEquals(store.handle.getState().queries.cache["erroring:2026-1"]?.data, { total: 2 });
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: multi-key invalidation interrupts all in-flight fetches", () =>
  Effect.gen(function* () {
    const fetchCounts: Record<string, number> = {};
    // Always holds the latest resolve for each key — earlier attempts are
    // abandoned (interrupted), so we only ever need to resolve the final one.
    const latestResolve: Record<string, () => void> = {};

    const q = defineQuery<string, CatState>("multiInv", (state) =>
      state.categories.map((cat) => ({
        key: cat,
        fetch: Effect.gen(function* () {
          fetchCounts[cat] = (fetchCounts[cat] ?? 0) + 1;
          const attempt = fetchCounts[cat];
          yield* Effect.async<void>((resume) => {
            latestResolve[cat] = () => resume(Effect.void);
          });
          return `${cat}-${attempt}`;
        }),
      })),
    );

    const store = yield* makeStore({
      initialState: { ...catInitialState, categories: ["food", "transport"] },
      reduce: catRootReducer,
      process: (ctx) => q.process(ctx),
    });

    yield* letProcessSubscribe;

    // Both fetches start, blocked on manual resolve
    yield* settle(() => fetchCounts.food >= 1 && fetchCounts.transport >= 1);

    // Invalidate all — both in-flight fetches should be interrupted and refetched
    store.handle.put({
      id: "query-invalidate",
      data: { queryName: "multiInv" },
    });

    // Each key gets at least one post-invalidation fetch (may be >2 total due
    // to cascading reconciles — see review note on stale currentInflight snapshot)
    yield* settle(() => fetchCounts.food >= 2 && fetchCounts.transport >= 2);

    // Resolve the latest fetch for each key
    yield* settle(() => latestResolve.food !== undefined && latestResolve.transport !== undefined);
    latestResolve.food();
    latestResolve.transport();

    yield* settle(
      () =>
        store.handle.getState().queries.cache["multiInv:food"]?.status === "success" &&
        store.handle.getState().queries.cache["multiInv:transport"]?.status === "success",
    );

    // Both entries hold data from a post-invalidation fetch
    const foodData = store.handle.getState().queries.cache["multiInv:food"]?.data as string;
    const transportData = store.handle.getState().queries.cache["multiInv:transport"]
      ?.data as string;
    assertEquals(foodData.startsWith("food-"), true);
    assertEquals(transportData.startsWith("transport-"), true);
    // Attempt number > 1 confirms the original fetch was interrupted
    assertEquals(Number(foodData.split("-")[1]) >= 2, true);
    assertEquals(Number(transportData.split("-")[1]) >= 2, true);
  }).pipe(Effect.scoped, Effect.runPromise));
