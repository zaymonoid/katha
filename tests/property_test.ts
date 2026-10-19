/**
 * Regression tests for bugs found by property / stress testing. Each test
 * reproduces a bug that once failed; the comment above it records what broke.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { Arbitrary, Cause, Effect, Exit, Fiber, PubSub, Schema } from "effect";
import {
  combineReducers,
  createStoreRef,
  debounce,
  makeStore,
  type Reducer,
  take,
  takeEvery,
  takeLatest,
  takeLeading,
} from "../src/index.ts";
import {
  defineMutation,
  defineQuery,
  initialQueriesState,
  type QueriesAction,
  type QueriesState,
  queriesReducer,
} from "../src/query.ts";
import {
  captureLogs,
  letProcessSubscribe,
  noop,
  reduce,
  type State,
  settle,
  type TestAction,
} from "./test-helpers.ts";

type QState = { queries: QueriesState };
const qReducer = combineReducers({ queries: queriesReducer }) as unknown as Reducer<
  QState,
  QueriesAction
>;

const gate = (): { open: () => void; wait: Effect.Effect<void> } => {
  const ref: { current: (() => void) | null; opened: boolean } = { current: null, opened: false };
  return {
    open: () => {
      ref.opened = true;
      ref.current?.();
    },
    wait: Effect.callback<void>((resume) => {
      if (ref.opened) {
        resume(Effect.void);
        return;
      }
      ref.current = () => resume(Effect.void);
    }),
  };
};

type Tagged = { id: "tagged"; seq: number };

Deno.test("put: transition stream order matches reducer order under concurrent puts", () =>
  Effect.gen(function* () {
    const reduced: number[] = [];
    const published: number[] = [];
    // Each transition's state must be the one its own action produced.
    const mispaired: number[] = [];
    const store = yield* makeStore<{ last: number }, Tagged, never>({
      initialState: { last: -1 },
      reduce: (_, a) => {
        reduced.push(a.seq);
        return { last: a.seq };
      },
      process: () => Effect.void,
    });
    const sub = yield* PubSub.subscribe(store.transitions);
    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(sub).pipe(
          Effect.tap(({ action, state }) =>
            Effect.sync(() => {
              published.push(action.seq);
              if (state.last !== action.seq) mispaired.push(action.seq);
            }),
          ),
        ),
      ),
    );

    // Enough work per fiber that the scheduler auto-yields mid-put.
    let seq = 0;
    const putters = [];
    for (let f = 0; f < 8; f++) {
      putters.push(
        yield* Effect.forkChild(
          Effect.forEach(
            Array.from({ length: 2000 }),
            () => store.put({ id: "tagged", seq: seq++ }),
            {
              discard: true,
            },
          ),
        ),
      );
    }
    yield* Fiber.joinAll(putters);
    yield* settle(() => published.length === reduced.length);

    assertEquals(published, reduced);
    assertEquals(mispaired, []);
  }).pipe(Effect.scoped, Effect.runPromise));

// Found by a no-flash property: with only successful +delta mutations the
// visible value can never legitimately decrease, yet it went 202 -> 201.
Deno.test("process: a fetch in flight when a mutation starts does not double-apply its overlay", () =>
  Effect.gen(function* () {
    let server = 200;
    let fetches = 0;
    const refetchGate = gate();
    const runGate = gate();

    const q = defineQuery<number, QState>("propCounter", () => ({
      key: "1",
      fetch: Effect.gen(function* () {
        if (fetches++ > 0) yield* refetchGate.wait;
        return server;
      }),
    }));
    const m = defineMutation("propIncrement", {
      query: q,
      optimistic: (n, delta: number) => n + delta,
      run: (delta: number) =>
        Effect.gen(function* () {
          server += delta;
          yield* runGate.wait;
        }),
    });

    const store = yield* makeStore({
      initialState: { queries: initialQueriesState },
      reduce: qReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });
    yield* letProcessSubscribe;
    const visible = () => q.select(store.handle.getState())?.data;
    yield* settle(() => visible() === 200);

    // A background refetch is in flight when the mutation starts...
    store.handle.put(q.makeInvalidateAction({ soft: true }));
    yield* settle(() => fetches === 2);
    store.handle.put(m.makeAction(1));
    yield* settle(() => server === 201 && visible() === 201);

    // ...and its response reads the server after the mutation's write but
    // lands while the intent is still pending.
    refetchGate.open();
    yield* settle(
      () => store.handle.getState().queries.cache.propCounter?.["1"]?.isFetching === false,
    );

    assertEquals(m.select(store.handle.getState()).status, "pending");
    assertEquals(visible(), 201); // actual: 202 — the +1 counted twice
    // The untrusted response was discarded, not written
    assertEquals(store.handle.getState().queries.cache.propCounter?.["1"]?.data, 200);

    // Once the window closes, the refetch is trusted and hands off without a flash
    runGate.open();
    yield* settle(() => store.handle.getState().queries.overlays.length === 0);
    assertEquals(visible(), 201);
    assertEquals(store.handle.getState().queries.cache.propCounter?.["1"]?.data, 201);
  }).pipe(Effect.scoped, Effect.runPromise));

// Review bug (a): a `null` base broke a `??` sentinel and the overlay doubled.
Deno.test("process: an overlay over null data with a fetch in flight does not double-apply", () =>
  Effect.gen(function* () {
    let server: number[] | null = null;
    let fetches = 0;
    const refetchGate = gate();
    const runGate = gate();

    const q = defineQuery<number[] | null, QState>("propNullable", () => ({
      key: "1",
      fetch: Effect.gen(function* () {
        if (fetches++ > 0) yield* refetchGate.wait;
        return server;
      }),
    }));
    const m = defineMutation("propAppend", {
      query: q,
      optimistic: (xs, x: number) => [...(xs ?? []), x],
      run: (x: number) =>
        Effect.gen(function* () {
          server = [...(server ?? []), x];
          yield* runGate.wait;
        }),
    });

    const store = yield* makeStore({
      initialState: { queries: initialQueriesState },
      reduce: qReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });
    yield* letProcessSubscribe;
    const visible = () => q.select(store.handle.getState())?.data;
    yield* settle(() => q.select(store.handle.getState())?.status === "success");
    assertEquals(visible(), null);

    store.handle.put(q.makeInvalidateAction({ soft: true }));
    yield* settle(() => fetches === 2);
    store.handle.put(m.makeAction(7));
    yield* settle(() => server !== null);
    refetchGate.open();
    yield* settle(
      () => store.handle.getState().queries.cache.propNullable?.["1"]?.isFetching === false,
    );
    assertEquals(visible(), [7]);

    runGate.open();
    yield* settle(() => store.handle.getState().queries.overlays.length === 0);
    assertEquals(visible(), [7]);
  }).pipe(Effect.scoped, Effect.runPromise));

// Review bug (b): bookkeeping on the entry leaked into selector output.
Deno.test("select: output carries only QueryState fields, with or without an overlay", () => {
  const q = defineQuery<number, QState>("propShape", () => ({
    key: "1",
    fetch: Effect.succeed(0),
  }));
  defineMutation("propShapeAdd", {
    query: q,
    optimistic: (n, d: number) => n + d,
    run: () => Effect.void,
  });
  const fields = ["data", "dataUpdatedAt", "error", "isFetching", "isStale", "status"];
  const steps: QueriesAction[] = [
    { id: "katha/query/started", data: { query: "propShape", key: "1" } },
    {
      id: "katha/query/success",
      data: { query: "propShape", key: "1", result: 1, dataUpdatedAt: 1 },
    },
    {
      id: "katha/mutation/started",
      data: {
        name: "propShapeAdd",
        intentId: "i1",
        variables: 1,
        targets: [{ query: "propShape", key: "1" }],
        submittedAt: 1,
      },
    },
    { id: "katha/query/started", data: { query: "propShape", key: "1" } },
    {
      id: "katha/query/success",
      data: { query: "propShape", key: "1", result: 2, dataUpdatedAt: 2 },
    },
    {
      id: "katha/mutation/success",
      data: {
        name: "propShapeAdd",
        intentId: "i1",
        invalidations: [{ query: "propShape", key: "1" }],
      },
    },
    { id: "katha/query/started", data: { query: "propShape", key: "1" } },
    {
      id: "katha/query/success",
      data: { query: "propShape", key: "1", result: 2, dataUpdatedAt: 3 },
    },
  ];
  let state: QState = { queries: initialQueriesState };
  const views: unknown[] = [];
  for (const step of steps) {
    state = qReducer(state, step) ?? state;
    const view = q.select(state);
    assertEquals(Object.keys(view ?? {}).sort(), fields);
    views.push(view?.data);
  }
  assertEquals(views, [undefined, 1, 2, 2, 2, 2, 2, 2]);
});

// Review bug (c): a hard invalidate during the pending window dropped the
// pinned base, so the reload that followed counted the write twice.
Deno.test("process: a hard invalidate while a mutation is pending does not double-apply", () =>
  Effect.gen(function* () {
    let server = 200;
    const runGate = gate();

    const q = defineQuery<number, QState>("propHard", () => ({
      key: "1",
      fetch: Effect.sync(() => server),
    }));
    const m = defineMutation("propHardIncrement", {
      query: q,
      optimistic: (n, delta: number) => n + delta,
      run: (delta: number) =>
        Effect.gen(function* () {
          server += delta;
          yield* runGate.wait;
        }),
    });

    const store = yield* makeStore({
      initialState: { queries: initialQueriesState },
      reduce: qReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });
    yield* letProcessSubscribe;
    const visible = () => q.select(store.handle.getState())?.data;
    const seen: Array<number | undefined> = [];
    store.handle.subscribe((s) => seen.push(q.select(s)?.data));
    yield* settle(() => visible() === 200);

    store.handle.put(m.makeAction(1));
    yield* settle(() => server === 201 && visible() === 201);

    // The reload reads 201 while the intent is pending: discarded, the entry
    // stays loading rather than showing 202
    store.handle.put(q.makeInvalidateAction());
    const entry = () => store.handle.getState().queries.cache.propHard?.["1"];
    yield* settle(() => entry()?.status === "loading" && entry()?.isFetching === false);
    yield* letProcessSubscribe;
    assertEquals(entry()?.status, "loading");
    assertEquals(visible(), undefined);

    runGate.open();
    yield* settle(() => visible() === 201 && store.handle.getState().queries.overlays.length === 0);
    assertEquals(
      seen.filter((n) => n !== undefined && n > 201),
      [],
    );
  }).pipe(Effect.scoped, Effect.runPromise));

// The rule behind (a)–(c), fuzzed at the reducer: fetches read the server at
// random points, mutations write it at random points while pending, and the
// reconciler refetches whatever is absent or stale. The folded view must never
// exceed truth plus the deltas not yet written, must never drop while only
// successful +1 mutations run, and must end on server truth with no overlays.
const FuzzOp = Schema.Literals([
  "fetchStart",
  "fetchRead",
  "fetchLand",
  "fetchFail",
  "mutStart",
  "mutWrite",
  "mutSucceed",
  "mutFail",
  "soft",
  "hard",
]);
const fuzzQuery = defineQuery<number | null, QState>("fuzzCounter", () => ({
  key: "1",
  fetch: Effect.succeed(0),
}));
defineMutation("fuzzIncrement", {
  query: fuzzQuery,
  optimistic: (n, d: number) => (n ?? 0) + d,
  run: () => Effect.void,
});

const fuzzWindow = (
  ops: readonly (typeof FuzzOp.Type)[],
  allowFail: boolean,
  base: number | null,
): string | undefined => {
  const target = { query: "fuzzCounter", key: "1" };
  let state: QState = { queries: initialQueriesState };
  let server = base;
  // Widened by `as`: closures reassign it, which narrowing does not see.
  let inflight = null as { read?: number | null } | null;
  let lastView: number | undefined;
  const muts: { intentId: string; written: boolean; done: boolean }[] = [];
  const put = (a: QueriesAction) => {
    state = qReducer(state, a) ?? state;
  };
  const entry = () => state.queries.cache.fuzzCounter?.["1"];
  const start = () => {
    inflight = {};
    put({ id: "katha/query/started", data: target });
  };
  const reconcile = () => {
    const e = entry();
    if (e === undefined || e.isStale) start();
  };
  const write = () => {
    server = (server ?? 0) + 1;
  };
  const succeed = (m: (typeof muts)[number]) => {
    m.done = true;
    put({
      id: "katha/mutation/success",
      data: { name: "fuzzIncrement", intentId: m.intentId, invalidations: [target] },
    });
  };
  const violation = (label: string): string | undefined => {
    const view = fuzzQuery.select(state)?.data;
    if (view === undefined) return;
    const unwritten = muts.filter((m) => !m.done && !m.written).length;
    if ((view ?? 0) > (server ?? 0) + unwritten)
      return `${label}: ${view} > ${server}+${unwritten}`;
    if (!allowFail && lastView !== undefined && (view ?? 0) < lastView)
      return `${label}: dropped ${lastView} -> ${view}`;
    lastView = view ?? 0;
  };
  reconcile();
  for (const op of ops) {
    const open = muts.filter((m) => !m.done);
    const unwritten = open.find((m) => !m.written);
    const written = open.find((m) => m.written);
    if (op === "fetchStart" && inflight === null) start();
    if (op === "fetchRead" && inflight !== null && !("read" in inflight)) inflight.read = server;
    if (op === "fetchLand" && inflight !== null && "read" in inflight) {
      const result = inflight.read;
      inflight = null;
      put({ id: "katha/query/success", data: { ...target, result, dataUpdatedAt: 1 } });
    }
    if (op === "fetchFail" && allowFail && inflight !== null) {
      inflight = null;
      put({ id: "katha/query/error", data: { ...target, error: "down" } });
    }
    if (op === "mutStart" && open.length < 3) {
      const intentId = `i${muts.length}`;
      muts.push({ intentId, written: false, done: false });
      put({
        id: "katha/mutation/started",
        data: { name: "fuzzIncrement", intentId, variables: 1, targets: [target], submittedAt: 1 },
      });
    }
    if (op === "mutWrite" && unwritten !== undefined) {
      unwritten.written = true;
      write();
    }
    if (op === "mutSucceed" && written !== undefined) succeed(written);
    if (op === "mutFail" && allowFail && unwritten !== undefined) {
      unwritten.done = true;
      put({
        id: "katha/mutation/error",
        data: { name: "fuzzIncrement", intentId: unwritten.intentId, error: "denied" },
      });
    }
    if (op === "soft") put(fuzzQuery.makeInvalidateAction({ soft: true }));
    if (op === "hard") put(fuzzQuery.makeInvalidateAction());
    reconcile();
    const v = violation(op);
    if (v !== undefined) return v;
  }
  // Drain: every mutation succeeds, then fetches complete until quiescent.
  for (const m of muts.filter((m) => !m.done)) {
    if (!m.written) write();
    m.written = true;
    succeed(m);
    reconcile();
  }
  for (let i = 0; i < 3; i++) {
    if (entry()?.status === "error") put(fuzzQuery.makeInvalidateAction({ soft: true }));
    reconcile();
    if (inflight === null) continue;
    inflight = null;
    put({ id: "katha/query/success", data: { ...target, result: server, dataUpdatedAt: 2 } });
    const v = violation("drain");
    if (v !== undefined) return v;
  }
  const view = fuzzQuery.select(state)?.data;
  if (view !== server) return `ended on ${view}, server ${server}`;
  if (state.queries.overlays.length > 0) return "overlays left over";
};

for (const [allowFail, base] of [
  [false, 100],
  [true, 100],
  [false, null],
  [true, null],
] as const) {
  Deno.test(`reducer: responses during an open intent never double-count (fails: ${allowFail}, base: ${base})`, () =>
    Effect.gen(function* () {
      const result = yield* Arbitrary.checkEffect(
        Arbitrary.array(Arbitrary.schema(FuzzOp), { maxLength: 40 }),
        (ops) => fuzzWindow(ops, allowFail, base) === undefined,
        { runs: 500, size: 40, seed: 1 },
      );
      assertEquals(
        result._tag === "Falsified" ? fuzzWindow(result.shrunkInput, allowFail, base) : result._tag,
        "Passed",
      );
    }).pipe(Effect.runPromise));
}

// Found by the same no-flash property: an overlay showed up on the key the
// user navigated to right after dispatching, not the one it was issued for.
// The success invalidation follows the same wrong key, so the entry actually
// mutated ("a") is never marked stale and keeps serving pre-mutation data.
Deno.test("process: a 'current' target resolves from the state at dispatch, not when the handler runs", () =>
  Effect.gen(function* () {
    type SelState = { queries: QueriesState; selected: string };
    type SelAction = QueriesAction | { id: "select"; key: string };
    const selReducer = combineReducers({
      queries: queriesReducer,
      selected: (_: string, a: SelAction) => (a.id === "select" ? a.key : undefined),
    }) as unknown as Reducer<SelState, SelAction>;
    const runGate = gate();

    const q = defineQuery<number, SelState>("propSelected", (s) => ({
      key: s.selected,
      fetch: Effect.succeed(0),
    }));
    const m = defineMutation("propBump", {
      query: q,
      optimistic: (n, delta: number) => n + delta,
      run: () => runGate.wait,
    });

    const store = yield* makeStore({
      initialState: { queries: initialQueriesState, selected: "a" },
      reduce: selReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });
    yield* letProcessSubscribe;
    yield* settle(() => q.select(store.handle.getState())?.status === "success");

    // Bump the entry on screen, then navigate away straight after. The
    // refetch keeps the scheduler busy so the handler runs after "select".
    store.handle.put(q.makeInvalidateAction({ soft: true }));
    store.handle.put(m.makeAction(1));
    store.handle.put({ id: "select", key: "b" });
    yield* settle(() => m.select(store.handle.getState()).status === "pending");

    assertEquals(store.handle.getState().queries.overlays[0]?.targets, [
      { query: "propSelected", key: "a" },
    ]); // actual: key "b"
  }).pipe(Effect.scoped, Effect.runPromise));

// The same hazard one level down: a combinator handler forks after its
// trigger is published, so by the time it runs `select()` may already reflect
// a later action. The handler's `state` argument is pinned to the trigger.
type NavState = { selected: string };
type NavAction = { id: "go" } | { id: "select"; key: string };
type NavHandler = Parameters<typeof takeEvery<NavState, NavAction, "go", never>>[1];
for (const [name, combinator] of [
  ["takeEvery", (h: NavHandler) => takeEvery(["go"], h)],
  ["takeLatest", (h: NavHandler) => takeLatest(["go"], h)],
  ["takeLeading", (h: NavHandler) => takeLeading(["go"], h)],
  ["debounce", (h: NavHandler) => debounce("1 millis", ["go"], h)],
] as const) {
  Deno.test(`${name}: the handler gets its trigger's state, not the state when it runs`, () =>
    Effect.gen(function* () {
      let seen: { trigger: string; current: string } | undefined;
      const store = yield* makeStore<NavState, NavAction, never>({
        initialState: { selected: "a" },
        reduce: (s, a) => (a.id === "select" ? { selected: a.key } : s),
        process: combinator((_, ctx, state) =>
          Effect.gen(function* () {
            const current = yield* ctx.select();
            seen = { trigger: state.selected, current: current.selected };
          }),
        ),
      });
      yield* letProcessSubscribe;

      // Navigate away straight after the trigger. Effect-side puts reduce in
      // this fiber, so both are reduced before the listener fiber even takes
      // "go", let alone forks its handler.
      yield* store.put({ id: "go" });
      yield* store.put({ id: "select", key: "b" });
      yield* settle(() => seen !== undefined);

      assertEquals(seen, { trigger: "a", current: "b" });
    }).pipe(Effect.scoped, Effect.runPromise));
}

// Found by a multi-key property: derive returning the same key twice forks two
// fetches, and the first fiber is dropped from in-flight tracking.
Deno.test("process: a multi-key derive with a duplicate key starts one fetch for it", () =>
  Effect.gen(function* () {
    const started: string[] = [];
    const q = defineQuery<string, QState>("propDupes", () =>
      ["a", "a"].map((key) => ({
        key,
        fetch: Effect.sync(() => {
          started.push(key);
          return key;
        }),
      })),
    );

    const store = yield* makeStore({
      initialState: { queries: initialQueriesState },
      reduce: qReducer,
      process: (ctx) => q.process(ctx),
    });
    yield* settle(() => store.handle.getState().queries.cache.propDupes?.a?.status === "success");
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 10 }));

    assertEquals(started, ["a"]); // actual: ["a", "a"]
  }).pipe(Effect.scoped, Effect.runPromise));

// Found by probing name-level invalidation: the cache was flat, keyed by the
// joined string `name:key`. Name-level invalidation prefix-matched "todos:", so
// invalidating `todos` also hit a query named `todos:archived`; and query `a`
// with key `b:c` and query `a:b` with key `c` both became "a:b:c" and
// overwrote each other. Fixed by nesting the cache by name, then key, so no
// character is reserved and a name-level invalidation is structural.
Deno.test("invalidate: a name never covers another name it is a prefix of", () => {
  const entry = (data: unknown) => ({
    status: "success" as const,
    data,
    error: undefined,
    isFetching: false,
    isStale: false,
    dataUpdatedAt: 1,
  });
  const archived = { "1": entry(["old"]) };
  const before: QueriesState = {
    ...initialQueriesState,
    cache: { todos: { "1": entry(["new"]) }, "todos:archived": archived },
  };

  const hard = queriesReducer(before, {
    id: "katha/query/invalidate",
    data: { query: "todos" },
  });
  assertEquals(hard?.cache.todos, undefined);
  assertStrictEquals(hard?.cache["todos:archived"], archived); // actual: undefined

  const soft = queriesReducer(before, {
    id: "katha/query/invalidate",
    data: { query: "todos", soft: true },
  });
  assertEquals(soft?.cache.todos?.["1"]?.isStale, true);
  assertStrictEquals(soft?.cache["todos:archived"], archived); // actual: marked stale
});

Deno.test("process: query `a` key `b:c` and query `a:b` key `c` keep separate entries", () =>
  Effect.gen(function* () {
    const fetches = { outer: 0, inner: 0 };
    const outer = defineQuery<string, QState>("propNest", () => ({
      key: "b:c",
      fetch: Effect.sync(() => `outer-${++fetches.outer}`),
    }));
    const inner = defineQuery<string, QState>("propNest:b", () => ({
      key: "c",
      fetch: Effect.sync(() => `inner-${++fetches.inner}`),
    }));

    const store = yield* makeStore({
      initialState: { queries: initialQueriesState },
      reduce: qReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* outer.process(ctx);
          yield* inner.process(ctx);
        }),
    });
    yield* letProcessSubscribe;
    const state = () => store.handle.getState();
    yield* settle(
      () =>
        outer.select(state())?.status === "success" && inner.select(state())?.status === "success",
    );
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 10 }));

    // Each query reads its own entry; neither fetch overwrote the other.
    assertEquals(outer.select(state())?.data, "outer-1"); // actual: whichever landed last
    assertEquals(inner.select(state())?.data, "inner-1");
    assertEquals(state().queries.cache.propNest?.["b:c"]?.data, "outer-1");
    assertEquals(state().queries.cache["propNest:b"]?.c?.data, "inner-1");
    assertEquals(fetches, { outer: 1, inner: 1 });

    // Invalidating `propNest` refetches it alone.
    store.handle.put(outer.makeInvalidateAction());
    yield* settle(() => outer.select(state())?.data === "outer-2");
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 10 }));
    assertEquals(inner.select(state())?.data, "inner-1");
    assertEquals(fetches, { outer: 2, inner: 1 });
  }).pipe(Effect.scoped, Effect.runPromise));

// Found probing failure isolation: listeners run on the store's single
// broadcaster fiber, so one throw ends it and the handle stops updating.
Deno.test("handle: a listener that throws once does not stop the handle from updating", () =>
  Effect.gen(function* () {
    const store = yield* makeStore({ initialState: { count: 0 }, reduce, process: noop });
    let thrown = false;
    store.handle.subscribe((s) => {
      if (s.count === 1 && !thrown) {
        thrown = true;
        throw new Error("listener bug");
      }
    });

    store.handle.put({ id: "inc" });
    yield* settle(() => thrown);
    store.handle.put({ id: "inc" });
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

    assertEquals(store.handle.getState().count, 2); // actual: 1, forever
  }).pipe(Effect.scoped, Effect.runPromise));

// Same shape on the command side: handle.put runs reducers on one fiber that
// a single throw ends, after which every put is silently dropped.
Deno.test("handle: a reducer that throws once does not drop every later put", () =>
  Effect.gen(function* () {
    let fail = true;
    const store = yield* makeStore({
      initialState: { count: 0 },
      reduce: (s: State, a: TestAction) => {
        if (a.id === "reset" && fail) {
          fail = false;
          throw new Error("reducer bug");
        }
        return reduce(s, a);
      },
      process: noop,
    });

    store.handle.put({ id: "reset" });
    store.handle.put({ id: "inc" });
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

    assertEquals(store.handle.getState().count, 1); // actual: 0, forever
  }).pipe(Effect.scoped, Effect.runPromise));

// Low severity (the React and Lit adapters dedupe): Set.forEach visits a
// listener added mid-notify, on top of subscribe's immediate call.
Deno.test("handle: a listener subscribed during a notification sees that state once", () =>
  Effect.gen(function* () {
    const store = yield* makeStore({ initialState: { count: 0 }, reduce, process: noop });
    yield* letProcessSubscribe;
    const lateSeen: number[] = [];
    let added = false;
    store.handle.subscribe((s) => {
      if (s.count === 1 && !added) {
        added = true;
        store.handle.subscribe((t) => lateSeen.push(t.count));
      }
    });

    store.handle.put({ id: "inc" });
    yield* settle(() => added);
    yield* letProcessSubscribe;

    assertEquals(lateSeen, [1]); // actual: [1, 1]
  }).pipe(Effect.scoped, Effect.runPromise));

// Same failure-isolation family on the query side: derive runs on the
// reconciler's single stream fiber, so one throw ends the query for good.
Deno.test("process: a derive that throws once does not stop the query reconciling", () =>
  Effect.gen(function* () {
    type IdState = { queries: QueriesState; id: number };
    type IdAction = QueriesAction | { id: "setId"; value: number };
    const idReducer = combineReducers({
      queries: queriesReducer,
      id: (_: number, a: IdAction) => (a.id === "setId" ? a.value : undefined),
    }) as unknown as Reducer<IdState, IdAction>;

    const q = defineQuery<number, IdState>("propDerive", (s) => {
      if (s.id === 13) throw new Error("derive bug");
      return { key: String(s.id), fetch: Effect.succeed(s.id) };
    });
    const store = yield* makeStore({
      initialState: { queries: initialQueriesState, id: 1 },
      reduce: idReducer,
      process: (ctx) => q.process(ctx),
    });
    yield* settle(() => q.select(store.handle.getState())?.status === "success");

    store.handle.put({ id: "setId", value: 13 });
    store.handle.put({ id: "setId", value: 2 });
    yield* settle(() => store.handle.getState().id === 2);
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

    assertEquals(q.select(store.handle.getState())?.data, 2); // actual: never fetched
  }).pipe(Effect.scoped, Effect.runPromise));

// reportExit routes failures and defects inside run's Effect, but a run that
// throws before returning one escapes it and strands the intent as pending.
Deno.test("process: a run that throws synchronously fails the mutation instead of stranding it", () =>
  Effect.gen(function* () {
    const q = defineQuery<number, QState>("propSyncThrow", () => ({
      key: "1",
      fetch: Effect.succeed(1),
    }));
    const m = defineMutation("propSyncThrowRun", {
      query: q,
      optimistic: (n, delta: number) => n + delta,
      run: (delta: number): Effect.Effect<void> => {
        if (delta < 0) throw new Error("negative delta");
        return Effect.void;
      },
    });

    const store = yield* makeStore({
      initialState: { queries: initialQueriesState },
      reduce: qReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });
    yield* settle(() => q.select(store.handle.getState())?.data === 1);

    store.handle.put(m.makeAction(-1));
    yield* settle(() => m.select(store.handle.getState()).status !== "idle");
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

    assertEquals(m.select(store.handle.getState()).status, "error"); // actual: "pending"
    assertEquals(q.select(store.handle.getState())?.data, 1); // actual: 0 — overlay never rolls back
  }).pipe(Effect.scoped, Effect.runPromise));

// The combinators call the handler in their listener loop to get the Effect to
// fork, so a handler that throws before returning one ends the loop. debounce
// calls it inside the forked fiber and survives.
for (const [name, combinator] of [
  ["takeEvery", takeEvery],
  ["takeLatest", takeLatest],
  ["takeLeading", takeLeading],
] as const) {
  Deno.test(`${name}: a handler that throws synchronously once keeps handling later actions`, () =>
    Effect.gen(function* () {
      type N = { id: "n"; n: number };
      const handled: number[] = [];
      const store = yield* makeStore<Record<string, never>, N, never>({
        initialState: {},
        process: combinator<Record<string, never>, N, "n", never>(["n"], (a) => {
          if (a.n === 1) throw new Error("handler bug");
          return Effect.sync(() => {
            handled.push(a.n);
          });
        }),
      });
      yield* letProcessSubscribe;

      for (const n of [0, 1, 2]) {
        store.handle.put({ id: "n", n });
        yield* letProcessSubscribe;
      }
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

      assertEquals(handled, [0, 2]); // actual: [0]
    }).pipe(Effect.scoped, Effect.runPromise));
}

// Effect 4 reports nothing when a forked fiber fails, and only the command
// loop logged a throwing reducer: the same action put by a saga via ctx.put
// killed the saga with no trace.
Deno.test("put: a reducer throw under ctx.put is logged once and fails the caller", () => {
  const logs = captureLogs();
  return Effect.gen(function* () {
    let sagaExit: Exit.Exit<void> | undefined;
    const store = yield* makeStore({
      initialState: { count: 0 },
      reduce: (s: State, a: TestAction) => {
        if (a.id === "reset") throw new Error("reducer bug");
        return reduce(s, a);
      },
      process: takeEvery<State, TestAction, "inc", never>(["inc"], (_, ctx) =>
        ctx.put({ id: "reset" }).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              sagaExit = exit;
            }),
          ),
        ),
      ),
    });

    store.handle.put({ id: "inc" });
    yield* settle(() => sagaExit !== undefined);
    assertEquals(sagaExit !== undefined && Exit.hasDies(sagaExit), true);
    assertEquals(logs.matching("Store put reset failed").length, 1); // actual: 0

    // handle.put of the same action: logged by put, swallowed by the command
    // loop without a second line.
    store.handle.put({ id: "reset" });
    store.handle.put({ id: "inc" });
    yield* settle(() => logs.matching("Store put reset failed").length >= 3);
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
    assertEquals(logs.matching("Store put reset failed").length, 3);
    assertEquals(store.handle.getState().count, 2);
    assertEquals(Cause.hasDies(logs.entries[0].cause), true);
  }).pipe(Effect.scoped, Effect.provide(logs.layer), Effect.runPromise);
});

// A failing handler Effect killed only its forked fiber, with no log.
const debounced: typeof takeEvery = (ids, handler) => debounce("1 millis", ids, handler);
for (const [name, combinator] of [
  ["takeEvery", takeEvery],
  ["takeLatest", takeLatest],
  ["takeLeading", takeLeading],
  ["debounce", debounced],
] as const) {
  Deno.test(`${name}: a failing handler is logged and later actions are still handled`, () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      type N = { id: "n"; n: number };
      const handled: number[] = [];
      const store = yield* makeStore<Record<string, never>, N, never>({
        initialState: {},
        process: combinator<Record<string, never>, N, "n", never>(["n"], (a) =>
          a.n === 1
            ? Effect.die(new Error("handler bug"))
            : Effect.sync(() => {
                handled.push(a.n);
              }),
        ),
      });
      yield* letProcessSubscribe;

      for (const n of [0, 1, 2]) {
        store.handle.put({ id: "n", n });
        yield* settle(() => handled.length + logs.entries.length === n + 1);
      }

      assertEquals(handled, [0, 2]);
      assertEquals(logs.matching(`${name} handler for n failed`).length, 1); // actual: 0
    }).pipe(Effect.scoped, Effect.provide(logs.layer), Effect.runPromise);
  });
}

// Target resolution (derive, key) ran before `started` and outside reportExit,
// so a throw there killed the handler: nothing logged, the mutation left idle.
Deno.test("process: a target key that throws fails the mutation instead of dropping it", () => {
  const logs = captureLogs();
  return Effect.gen(function* () {
    const q = defineQuery<number, QState>("propKeyThrow", () => [
      { key: "a", fetch: Effect.succeed(1) },
    ]);
    const m = defineMutation("propKeyThrowRun", {
      query: q,
      key: (delta: number) => {
        if (delta < 0) throw new Error("no key for a negative delta");
        return "a";
      },
      optimistic: (n, delta: number) => n + delta,
      run: () => Effect.void,
      concurrency: "leading",
    });

    const store = yield* makeStore({
      initialState: { queries: initialQueriesState },
      reduce: qReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });
    const state = () => store.handle.getState();
    yield* settle(() => q.selectByKey(state(), "a")?.data === 1);

    store.handle.put(m.makeAction(-1));
    yield* settle(() => m.select(state()).status === "error");
    const failed = m.select(state());
    assertEquals(failed.status === "error" && failed.variables, -1);
    assertEquals(failed.status === "error" && failed.error.includes("negative delta"), true);
    assertEquals(state().queries.overlays, []);
    assertEquals(logs.matching("Mutation propKeyThrowRun failed").length, 1);

    // Not stranded: the next run, even under "leading", goes through.
    store.handle.put(m.makeAction(2));
    yield* settle(() => m.select(state()).status === "success");
    assertEquals(m.select(state()).status, "success");
  }).pipe(Effect.scoped, Effect.provide(logs.layer), Effect.runPromise);
});

// `changes` emits on every put, so a derive that keeps throwing logged on
// every action. Logged once per run of identical failures instead.
Deno.test("process: a derive that keeps throwing logs once, and again after recovering", () => {
  const logs = captureLogs();
  return Effect.gen(function* () {
    type IdState = { queries: QueriesState; id: number };
    type IdAction = QueriesAction | { id: "setId"; value: number };
    const idReducer = combineReducers({
      queries: queriesReducer,
      id: (_: number, a: IdAction) => (a.id === "setId" ? a.value : undefined),
    }) as unknown as Reducer<IdState, IdAction>;

    const q = defineQuery<number, IdState>("propDeriveDedupe", (s) => {
      if (s.id === 13) throw new Error("derive bug");
      return { key: String(s.id), fetch: Effect.succeed(s.id) };
    });
    const store = yield* makeStore({
      initialState: { queries: initialQueriesState, id: 1 },
      reduce: idReducer,
      process: (ctx) => q.process(ctx),
    });
    const failures = () => logs.matching("Query propDeriveDedupe reconcile failed").length;
    yield* settle(() => q.select(store.handle.getState())?.status === "success");

    for (let i = 0; i < 5; i++) {
      yield* store.put({ id: "setId", value: 13 });
      yield* letProcessSubscribe;
    }
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
    assertEquals(failures(), 1); // actual: 5

    yield* store.put({ id: "setId", value: 2 });
    yield* settle(() => q.select(store.handle.getState())?.data === 2);
    yield* store.put({ id: "setId", value: 13 });
    yield* settle(() => failures() === 2);
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
    assertEquals(failures(), 2);
  }).pipe(Effect.scoped, Effect.provide(logs.layer), Effect.runPromise);
});

// Interrupt variant of the put-ordering bug: takeLatest interrupts a handler
// between put's reduce and publish, so the state changes but the action is
// never published — sagas waiting on it miss it entirely.
Deno.test("put: an interrupted put either publishes its action or never reduces it", () =>
  Effect.gen(function* () {
    type Work = { id: "go" } | { id: "done" };
    let reducedDone = 0;
    let publishedDone = 0;
    const store = yield* makeStore<Record<string, never>, Work, never>({
      initialState: {},
      reduce: (s, a) => {
        if (a.id === "done") reducedDone++;
        return s;
      },
      // Enough puts per handler that the scheduler auto-yields mid-put.
      process: takeLatest<Record<string, never>, Work, "go", never>(["go"], (_, ctx) =>
        Effect.forEach(Array.from({ length: 3000 }), () => ctx.put({ id: "done" }), {
          discard: true,
        }),
      ),
    });
    const sub = yield* PubSub.subscribe(store.transitions);
    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(sub).pipe(
          Effect.tap(({ action }) =>
            Effect.sync(() => {
              if (action.id === "done") publishedDone++;
            }),
          ),
        ),
      ),
    );
    yield* letProcessSubscribe;

    for (let i = 0; i < 100; i++) {
      yield* store.put({ id: "go" });
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: i % 7 }));
    }
    let seen = -1;
    while (seen !== reducedDone + publishedDone) {
      seen = reducedDone + publishedDone;
      yield* Effect.sleep("20 millis");
    }

    assertEquals(publishedDone, reducedDone); // actual: some reduced puts never published
  }).pipe(Effect.scoped, Effect.runPromise));

// Startup race: the root process subscribes to the action stream in a forked
// fiber, but makeStore returns (and the command queue starts draining) before
// it has. Actions put that early are reduced but never reach the sagas — which
// is exactly what createStoreRef's buffer flushes into at attach.
Deno.test("createStoreRef: an action buffered before attach reaches the store's sagas", () =>
  Effect.gen(function* () {
    const { ref, attach } = createStoreRef<State, TestAction>({ count: 0 });
    ref.put({ id: "inc" });

    let handled = 0;
    const store = yield* makeStore({
      initialState: { count: 0 },
      reduce,
      process: takeEvery<State, TestAction, "inc", never>(["inc"], () =>
        Effect.sync(() => {
          handled++;
        }),
      ),
    });
    attach(store);
    yield* settle(() => ref.getState().count === 1);
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

    assertEquals(handled, 1); // actual: 0 — reduced, never seen by takeEvery
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("makeStore: an action put as soon as the store is made reaches its sagas", () =>
  Effect.gen(function* () {
    let handled = 0;
    const store = yield* makeStore({
      initialState: { count: 0 },
      reduce,
      process: takeEvery<State, TestAction, "inc", never>(["inc"], () =>
        Effect.sync(() => {
          handled++;
        }),
      ),
    });
    store.handle.put({ id: "inc" });
    yield* settle(() => store.handle.getState().count === 1);
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

    assertEquals(handled, 1); // actual: 0
  }).pipe(Effect.scoped, Effect.runPromise));

// Found while reviewing a fix: attach replays pending subscribers by iterating
// the `pending` Map, and a subscriber that unsubscribes during its replay call
// is deleted and then re-set — appended, so the loop visits it again and
// re-subscribes it. An always-unsubscribing one-shot listener loops forever;
// this one only unsubscribes on its first call so the test can't hang.
Deno.test("createStoreRef: a subscriber that unsubscribes during attach's replay stays unsubscribed", () =>
  Effect.gen(function* () {
    const { ref, attach } = createStoreRef<State, TestAction>({ count: 0 });
    let calls = 0;
    const unsubscribe = ref.subscribe(() => {
      calls++;
      if (calls === 1) unsubscribe();
    });
    const store = yield* makeStore({ initialState: { count: 0 }, reduce, process: noop });

    attach(store);
    ref.put({ id: "inc" });
    yield* settle(() => ref.getState().count === 1);
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

    assertEquals(calls, 1); // actual: re-subscribed by attach, called again
  }).pipe(Effect.scoped, Effect.runPromise));

// Found by fuzzing: undoing the replayed subscription after the listener left
// must not also undo a re-subscription it made in the same call.
Deno.test("createStoreRef: a subscriber that unsubscribes and re-subscribes during attach's replay stays subscribed", () =>
  Effect.gen(function* () {
    const { ref, attach } = createStoreRef<State, TestAction>({ count: 0 });
    const seen: number[] = [];
    const listener = (s: State) => {
      seen.push(s.count);
      if (seen.length === 1) {
        unsubscribe();
        ref.subscribe(listener);
      }
    };
    const unsubscribe = ref.subscribe(listener);
    const store = yield* makeStore({ initialState: { count: 0 }, reduce, process: noop });

    attach(store);
    ref.put({ id: "inc" });
    yield* settle(() => ref.getState().count === 1);
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

    assertEquals(seen.at(-1), 1); // without the re-subscribe check: stuck at 0
  }).pipe(Effect.scoped, Effect.runPromise));

// Found by the attach-replay fuzz: handle.subscribe adds the listener before
// its immediate call, so a throw there escapes with no unsub returned — the
// listener stays subscribed and can never be removed.
Deno.test("handle: a listener that throws on subscribe is not left subscribed", () =>
  Effect.gen(function* () {
    const store = yield* makeStore({ initialState: { count: 0 }, reduce, process: noop });
    let calls = 0;
    const listener = () => {
      calls++;
      throw new Error("listener bug");
    };

    let threw = false;
    try {
      store.handle.subscribe(listener);
    } catch {
      threw = true;
    }
    store.handle.put({ id: "inc" });
    yield* settle(() => store.handle.getState().count === 1);
    yield* letProcessSubscribe;

    assertEquals(threw, true);
    assertEquals(calls, 1); // actual: called again for count 1 — still subscribed
  }).pipe(Effect.scoped, Effect.runPromise));

// Same root cause on the ref side: a listener that throws during attach's
// replay aborted attach — later subscribers never replayed, buffered actions
// never flushed.
Deno.test("createStoreRef: a listener that throws during attach's replay does not abort attach", () =>
  Effect.gen(function* () {
    const { ref, attach } = createStoreRef<State, TestAction>({ count: 0 });
    ref.subscribe(() => {
      throw new Error("listener bug");
    });
    const seen: number[] = [];
    ref.subscribe((s) => seen.push(s.count));
    ref.put({ id: "inc" });
    const store = yield* makeStore({ initialState: { count: 0 }, reduce, process: noop });

    let threw = false;
    try {
      attach(store);
    } catch {
      threw = true;
    }
    yield* settle(() => ref.getState().count === 1);
    yield* letProcessSubscribe;

    assertEquals(threw, true); // the failure still surfaces to attach's caller
    assertEquals(seen.at(-1), 1); // actual: never replayed, buffered inc never flushed
  }).pipe(Effect.scoped, Effect.runPromise));

// Found asking whether pairing every action with its state leaks: take
// returned on its first match but kept its subscription open until the
// caller's scope closed, so the queue kept every later transition — each
// pinning a whole state snapshot. A saga looping on take in the root process
// grew one undrained queue per iteration.
Deno.test("take: closes its subscription once it returns", () =>
  Effect.gen(function* () {
    const store = yield* makeStore({ initialState: { count: 0 }, reduce, process: noop });
    const waiting = yield* Effect.forkChild(take(store, ["reset"]));
    yield* letProcessSubscribe;
    yield* store.put({ id: "reset" });
    yield* Fiber.join(waiting);

    for (let i = 0; i < 100; i++) yield* store.put({ id: "inc" });

    assertEquals(yield* PubSub.size(store.transitions), 0); // actual: 100 retained
  }).pipe(Effect.scoped, Effect.runPromise));
