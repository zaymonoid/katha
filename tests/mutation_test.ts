/// <reference lib="deno.ns" />

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { Effect } from "effect";
import { combineReducers, makeStore, type Reducer } from "../src/index.ts";
import {
  defineMutation,
  defineQuery,
  type IntentTarget,
  initialQueriesState,
  type MutationRunAction,
  type MutationState,
  type MutationTarget,
  mutationTargets,
  type OverlayIntent,
  onQuery,
  onQueryKey,
  type QueriesAction,
  type QueriesState,
  type QueryState,
  queriesReducer,
  resolveTargets,
} from "../src/query.ts";
import { registerOverlays, requireQuery } from "../src/query-registry.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const entry = (
  data: unknown,
  overrides: Partial<QueryState<unknown>> = {},
): QueryState<unknown> => ({
  status: "success",
  data,
  error: undefined,
  isFetching: false,
  isStale: false,
  dataUpdatedAt: 1000,
  ...overrides,
});

const intent = (overrides: Partial<OverlayIntent> = {}): OverlayIntent => ({
  intentId: "i1",
  mutation: "updateUser",
  variables: { name: "Ada" },
  phase: "pending",
  targets: [{ query: "user", key: "1" }],
  ...overrides,
});

/** The error-run fields of a mutation state, or `undefined` when it isn't one. */
const failure = <V>(state: MutationState<V>) =>
  state.status === "error" ? { error: state.error, variables: state.variables } : undefined;

const qs = (partial: Partial<QueriesState> = {}): QueriesState => ({
  cache: {},
  overlays: [],
  mutations: {},
  ...partial,
});

// ---------------------------------------------------------------------------
// katha/mutation/started
// ---------------------------------------------------------------------------

Deno.test("katha/mutation/started records lifecycle and appends intent, cache untouched", () => {
  const targets: IntentTarget[] = [{ query: "user", key: "1" }];
  const before = qs({ cache: { "user:1": entry({ name: "Zed" }) } });
  const state = queriesReducer(before, {
    id: "katha/mutation/started",
    data: {
      name: "updateUser",
      intentId: "i1",
      variables: { name: "Ada" },
      targets,
      submittedAt: 111,
    },
  });
  assertEquals(state, {
    cache: before.cache,
    overlays: [
      {
        intentId: "i1",
        mutation: "updateUser",
        variables: { name: "Ada" },
        phase: "pending",
        targets,
      },
    ],
    mutations: {
      updateUser: {
        status: "pending",
        intentId: "i1",
        variables: { name: "Ada" },
        submittedAt: 111,
      },
    },
  });
  assertStrictEquals(state?.cache, before.cache);
});

Deno.test("katha/mutation/started with no targets records lifecycle only", () => {
  const state = queriesReducer(initialQueriesState, {
    id: "katha/mutation/started",
    data: { name: "ping", intentId: "i1", variables: null, targets: [], submittedAt: 1 },
  });
  assertEquals(state?.overlays, []);
  assertEquals(state?.mutations.ping?.status, "pending");
});

Deno.test("two starts of the same mutation: latest lifecycle, ordered intents", () => {
  const first = queriesReducer(initialQueriesState, {
    id: "katha/mutation/started",
    data: {
      name: "m",
      intentId: "i1",
      variables: 1,
      targets: [{ query: "q", key: "1" }],
      submittedAt: 1,
    },
  });
  // biome-ignore lint/style/noNonNullAssertion: first is a handled action
  const second = queriesReducer(first!, {
    id: "katha/mutation/started",
    data: {
      name: "m",
      intentId: "i2",
      variables: 2,
      targets: [{ query: "q", key: "1" }],
      submittedAt: 2,
    },
  });
  assertEquals(
    second?.overlays.map((i) => i.intentId),
    ["i1", "i2"],
  );
  assertEquals(second?.mutations.m, {
    status: "pending",
    intentId: "i2",
    variables: 2,
    submittedAt: 2,
  });
});

// ---------------------------------------------------------------------------
// katha/mutation/success / katha/mutation/error
// ---------------------------------------------------------------------------

Deno.test("katha/mutation/success settles the intent and keeps variables", () => {
  const before = qs({
    cache: { "user:1": entry({ name: "Zed" }) },
    overlays: [intent()],
    mutations: {
      updateUser: {
        status: "pending",
        intentId: "i1",
        variables: { name: "Ada" },
        submittedAt: 111,
      },
    },
  });
  const state = queriesReducer(before, {
    id: "katha/mutation/success",
    data: { name: "updateUser", intentId: "i1", invalidations: [{ query: "user", key: "1" }] },
  });
  assertEquals(state?.overlays[0]?.phase, "settling");
  assertEquals(state?.cache["user:1"]?.isStale, true);
  assertEquals(state?.mutations.updateUser, {
    status: "success",
    intentId: "i1",
    variables: { name: "Ada" },
    submittedAt: 111,
  });
});

Deno.test("katha/mutation/success drops targets with no cache entry (no stranded intents)", () => {
  const partial = qs({
    cache: { "user:1": entry({ name: "Zed" }) },
    overlays: [
      intent({
        targets: [
          { query: "user", key: "1" },
          { query: "neverFetched", key: "1" },
        ],
      }),
    ],
  });
  const settled = queriesReducer(partial, {
    id: "katha/mutation/success",
    data: { name: "updateUser", intentId: "i1", invalidations: [] },
  });
  // Only the target that has an entry to wait on survives
  assertEquals(settled?.overlays[0]?.targets, [{ query: "user", key: "1" }]);

  const orphan = qs({ overlays: [intent({ targets: [{ query: "neverFetched", key: "1" }] })] });
  const dropped = queriesReducer(orphan, {
    id: "katha/mutation/success",
    data: { name: "updateUser", intentId: "i1", invalidations: [] },
  });
  assertEquals(dropped?.overlays, []);
});

Deno.test("a superseded run's completion does not overwrite the latest lifecycle", () => {
  const run = (n: string, id: string) =>
    ({
      id: "katha/mutation/started",
      data: { name: n, intentId: id, variables: id, targets: [], submittedAt: 1 },
    }) as const;
  let state = queriesReducer(initialQueriesState, run("m", "i1"));
  // biome-ignore lint/style/noNonNullAssertion: handled action
  state = queriesReducer(state!, run("m", "i2"))!;

  // The older run finishing (either way) must not touch the newer lifecycle
  const afterOldSuccess = queriesReducer(state, {
    id: "katha/mutation/success",
    data: { name: "m", intentId: "i1", invalidations: [] },
  });
  assertEquals(afterOldSuccess?.mutations.m?.status, "pending");
  const afterOldError = queriesReducer(state, {
    id: "katha/mutation/error",
    data: { name: "m", intentId: "i1", error: "late" },
  });
  assertEquals(afterOldError?.mutations.m?.status, "pending");

  // The latest run's completion applies
  const afterNewSuccess = queriesReducer(state, {
    id: "katha/mutation/success",
    data: { name: "m", intentId: "i2", invalidations: [] },
  });
  assertEquals(afterNewSuccess?.mutations.m?.status, "success");
});

Deno.test("katha/mutation/error removes the intent (rollback), leaves siblings and cache", () => {
  const before = qs({
    cache: { "user:1": entry({ name: "Zed" }) },
    overlays: [intent(), intent({ intentId: "i2", mutation: "other" })],
    mutations: {
      updateUser: {
        status: "pending",
        intentId: "i1",
        variables: { name: "Ada" },
        submittedAt: 111,
      },
    },
  });
  const state = queriesReducer(before, {
    id: "katha/mutation/error",
    data: { name: "updateUser", intentId: "i1", error: "boom" },
  });
  assertEquals(
    state?.overlays.map((i) => i.intentId),
    ["i2"],
  );
  assertStrictEquals(state?.cache, before.cache);
  assertEquals(state?.mutations.updateUser, {
    status: "error",
    intentId: "i1",
    variables: { name: "Ada" },
    submittedAt: 111,
    error: "boom",
  });
});

Deno.test("katha/mutation/success/error with unknown intentId leave lifecycle untouched", () => {
  const s1 = queriesReducer(initialQueriesState, {
    id: "katha/mutation/success",
    data: { name: "m", intentId: "nope", invalidations: [] },
  });
  assertEquals(s1?.mutations, {});
  const s2 = queriesReducer(initialQueriesState, {
    id: "katha/mutation/error",
    data: { name: "m", intentId: "nope", error: "e" },
  });
  assertEquals(s2?.mutations, {});
});

// ---------------------------------------------------------------------------
// Overlay settling — the atomic handoff
// ---------------------------------------------------------------------------

Deno.test("katha/query/success writes fresh data and releases the settling overlay atomically", () => {
  const before = qs({
    cache: { "user:1": entry({ name: "Zed" }, { isFetching: true }) },
    overlays: [intent({ phase: "settling" })],
  });
  const state = queriesReducer(before, {
    id: "katha/query/success",
    data: { queryId: "user:1", result: { name: "Ada" }, dataUpdatedAt: 2000 },
  });
  // One action, one state: fresh data in, overlay out. No frame between.
  assertEquals(state?.cache["user:1"]?.data, { name: "Ada" });
  assertEquals(state?.overlays, []);
});

Deno.test("katha/query/success drops only the matching target; intent survives with the rest", () => {
  const multi = intent({
    phase: "settling",
    targets: [
      { query: "user", key: "1" },
      { query: "audit", key: "1" },
    ],
  });
  const state = queriesReducer(qs({ overlays: [multi] }), {
    id: "katha/query/success",
    data: { queryId: "user:1", result: {}, dataUpdatedAt: 1 },
  });
  assertEquals(state?.overlays[0]?.targets, [{ query: "audit", key: "1" }]);
});

Deno.test("katha/query/success leaves pending-phase intents untouched", () => {
  const state = queriesReducer(qs({ overlays: [intent({ phase: "pending" })] }), {
    id: "katha/query/success",
    data: { queryId: "user:1", result: {}, dataUpdatedAt: 1 },
  });
  assertEquals(state?.overlays.length, 1);
  assertEquals(state?.overlays[0]?.phase, "pending");
});

Deno.test("katha/query/error also releases settling targets", () => {
  const state = queriesReducer(qs({ overlays: [intent({ phase: "settling" })] }), {
    id: "katha/query/error",
    data: { queryId: "user:1", error: "boom" },
  });
  assertEquals(state?.overlays, []);
});

Deno.test("target matching is exact: a settling target releases only on its own entry", () => {
  const keyed = intent({ phase: "settling", targets: [{ query: "q", key: "a" }] });
  const success = (queryId: string) =>
    ({ id: "katha/query/success", data: { queryId, result: {}, dataUpdatedAt: 1 } }) as const;

  assertEquals(queriesReducer(qs({ overlays: [keyed] }), success("q:b"))?.overlays.length, 1);
  assertEquals(queriesReducer(qs({ overlays: [keyed] }), success("q2:a"))?.overlays.length, 1);
  assertEquals(queriesReducer(qs({ overlays: [keyed] }), success("q:a"))?.overlays, []);
});

Deno.test("a response that predates the invalidation (stale entry) does not settle", () => {
  const before = qs({
    cache: { "user:1": entry({ name: "Zed" }, { isFetching: true, isStale: true }) },
    overlays: [intent({ phase: "settling" })],
  });
  const success = queriesReducer(before, {
    id: "katha/query/success",
    data: { queryId: "user:1", result: { name: "Zed" }, dataUpdatedAt: 2 },
  });
  // Data is written and stays stale so the reconciler refetches; overlay held for that refetch
  assertEquals(success?.cache["user:1"]?.data, { name: "Zed" });
  assertEquals(success?.cache["user:1"]?.isStale, true);
  assertEquals(success?.overlays.length, 1);

  const error = queriesReducer(before, {
    id: "katha/query/error",
    data: { queryId: "user:1", error: "boom" },
  });
  assertEquals(error?.cache["user:1"]?.isStale, true);
  assertEquals(error?.overlays.length, 1);
});

Deno.test("katha/mutation/success marks its invalidations stale in the same transition", () => {
  const before = qs({
    cache: {
      "user:1": entry({ name: "Zed" }),
      "audit:1": entry([]),
      "audit:2": entry([]),
      "other:1": entry(0),
    },
    overlays: [intent()],
  });
  const state = queriesReducer(before, {
    id: "katha/mutation/success",
    data: {
      name: "updateUser",
      intentId: "i1",
      invalidations: [{ query: "user", key: "1" }, { query: "audit" }, { query: "absent" }],
    },
  });
  // One state: the overlay is settling AND its targets are stale — no refetch can land between
  assertEquals(state?.overlays[0]?.phase, "settling");
  assertEquals(state?.cache["user:1"]?.isStale, true);
  assertEquals(state?.cache["audit:1"]?.isStale, true);
  assertEquals(state?.cache["audit:2"]?.isStale, true);
  assertEquals(state?.cache["other:1"]?.isStale, false);
});

// ---------------------------------------------------------------------------
// Select overlay tests — optimism is invisible to query consumers
// ---------------------------------------------------------------------------

type SelState = { categories: string[]; selectedUser: string; queries: QueriesState };

const selUser = defineQuery<{ name: string }, SelState>("selUser", () => ({
  key: "1",
  fetch: Effect.succeed({ name: "server" }),
}));

const selTx = defineQuery<string[], SelState>("selTx", (state) =>
  state.categories.map((cat) => ({ key: cat, fetch: Effect.succeed([cat]) })),
);

const selCounter = defineQuery<{ count: number }, SelState>("selCounter", () => ({
  key: "1",
  fetch: Effect.succeed({ count: 0 }),
}));

const selRename = defineMutation("selRename", {
  query: selUser,
  run: (vars: { name: string }) => Effect.succeed(vars),
  optimistic: (data, vars) => ({ ...data, name: vars.name }),
});

defineMutation("selSuffix", {
  query: selUser,
  run: (vars: { suffix: string }) => Effect.succeed(vars),
  optimistic: (data, vars) => ({ ...data, name: data.name + vars.suffix }),
});

defineMutation("selAddTx", {
  query: selTx,
  key: (vars) => vars.category,
  run: (vars: { category: string; tx: string }) => Effect.succeed(vars),
  optimistic: (data, vars) => [...data, vars.tx],
});

defineMutation("selBump", {
  query: selCounter,
  run: (vars: { by: number }) => Effect.succeed(vars),
  optimistic: (data, vars) => ({ count: data.count + vars.by }),
});

const selCross = defineMutation("selCross", {
  run: (vars: { name: string; category: string }) => Effect.succeed(vars),
  optimistic: [
    onQuery(selUser, (data, vars: { name: string; category: string }) => ({
      ...data,
      name: vars.name,
    })),
    onQueryKey(
      selTx,
      (vars: { name: string; category: string }) => vars.category,
      (data, vars) => [...data, vars.name],
    ),
  ],
});

const selProfile = defineQuery<{ name: string }, SelState>("selProfile", (state) => ({
  key: state.selectedUser,
  fetch: Effect.succeed({ name: "server" }),
}));

defineMutation("selRenameProfile", {
  query: selProfile,
  run: (vars: { name: string }) => Effect.succeed(vars),
  optimistic: (data, vars) => ({ ...data, name: vars.name }),
});

const selState = (partial: Partial<QueriesState>, categories: string[] = []): SelState => ({
  categories,
  selectedUser: "1",
  queries: qs(partial),
});

Deno.test("select without pending intents returns the cache entry by reference", () => {
  const base = entry({ name: "Zed" });
  const state = selState({ cache: { "selUser:1": base } });
  assertStrictEquals(selUser.select(state), base);
});

Deno.test("pending intent folds into select; canonical cache untouched", () => {
  const state = selState({
    cache: { "selUser:1": entry({ name: "Zed" }) },
    overlays: [
      intent({
        mutation: "selRename",
        variables: { name: "Ada" },
        targets: [{ query: "selUser", key: "1" }],
      }),
    ],
  });
  assertEquals(selUser.select(state)?.data, { name: "Ada" });
  assertEquals(state.queries.cache["selUser:1"]?.data, { name: "Zed" });
});

Deno.test("multiple intents fold in dispatch order", () => {
  const state = selState({
    cache: { "selUser:1": entry({ name: "Zed" }) },
    overlays: [
      intent({
        intentId: "i1",
        mutation: "selRename",
        variables: { name: "Ada" },
        targets: [{ query: "selUser", key: "1" }],
      }),
      intent({
        intentId: "i2",
        mutation: "selSuffix",
        variables: { suffix: "!" },
        targets: [{ query: "selUser", key: "1" }],
      }),
    ],
  });
  assertEquals(selUser.select(state)?.data, { name: "Ada!" });
});

Deno.test("settling intent still folds (held until fresh data lands)", () => {
  const state = selState({
    cache: { "selUser:1": entry({ name: "Zed" }) },
    overlays: [
      intent({
        mutation: "selRename",
        variables: { name: "Ada" },
        phase: "settling",
        targets: [{ query: "selUser", key: "1" }],
      }),
    ],
  });
  assertEquals(selUser.select(state)?.data, { name: "Ada" });
});

Deno.test("keyed intent folds only into the matching key", () => {
  const transport = entry(["t1"]);
  const state = selState(
    {
      cache: { "selTx:food": entry(["f1"]), "selTx:transport": transport },
      overlays: [
        intent({
          mutation: "selAddTx",
          variables: { category: "food", tx: "f2" },
          targets: [{ query: "selTx", key: "food" }],
        }),
      ],
    },
    ["food", "transport"],
  );
  assertEquals(selTx.selectByKey(state, "food")?.data, ["f1", "f2"]);
  assertStrictEquals(selTx.selectByKey(state, "transport"), transport);
});

Deno.test("keyless overlay applies only to the key its intent was issued for", () => {
  const other = entry({ name: "Bob" });
  const state = selState({
    cache: { "selProfile:1": entry({ name: "Zed" }), "selProfile:2": other },
    overlays: [
      intent({
        mutation: "selRenameProfile",
        variables: { name: "Ada" },
        targets: [{ query: "selProfile", key: "1" }],
      }),
    ],
  });
  assertEquals(selProfile.select({ ...state, selectedUser: "1" })?.data, { name: "Ada" });
  // Switching selection mid-flight must not carry the overlay onto another entity
  assertStrictEquals(selProfile.select({ ...state, selectedUser: "2" }), other);
});

Deno.test("no fold when the entry has no data (loading)", () => {
  const loading = entry(undefined, { status: "loading", isFetching: true });
  const state = selState({
    cache: { "selUser:1": loading },
    overlays: [
      intent({
        mutation: "selRename",
        variables: { name: "Ada" },
        targets: [{ query: "selUser", key: "1" }],
      }),
    ],
  });
  assertStrictEquals(selUser.select(state), loading);
});

Deno.test("intent from a mutation with no overlay on this query is ignored", () => {
  const base = entry({ name: "Zed" });
  const state = selState({
    cache: { "selUser:1": base },
    overlays: [intent({ mutation: "ghost", targets: [{ query: "selUser", key: "1" }] })],
  });
  assertStrictEquals(selUser.select(state), base);
});

Deno.test("re-defining a mutation replaces its overlay (no double-apply)", () => {
  defineMutation("selBump", {
    query: selCounter,
    run: (vars: { by: number }) => Effect.succeed(vars),
    optimistic: (data, vars) => ({ count: data.count + vars.by }),
  });
  const state = selState({
    cache: { "selCounter:1": entry({ count: 1 }) },
    overlays: [
      intent({
        mutation: "selBump",
        variables: { by: 1 },
        targets: [{ query: "selCounter", key: "1" }],
      }),
    ],
  });
  assertEquals(selCounter.select(state)?.data, { count: 2 });
});

Deno.test("descriptor escape hatch overlays multiple queries from one mutation", () => {
  const state = selState(
    {
      cache: { "selUser:1": entry({ name: "Zed" }), "selTx:food": entry(["f1"]) },
      overlays: [
        intent({
          mutation: "selCross",
          variables: { name: "Ada", category: "food" },
          targets: [
            { query: "selUser", key: "1" },
            { query: "selTx", key: "food" },
          ],
        }),
      ],
    },
    ["food"],
  );
  assertEquals(selUser.select(state)?.data, { name: "Ada" });
  assertEquals(selTx.selectByKey(state, "food")?.data, ["f1", "Ada"]);
  assertEquals(selCross.name, "selCross");
});

const selMove = defineMutation("selMove", {
  run: (vars: { from: string; to: string; tx: string }) => Effect.succeed(vars),
  optimistic: [
    onQueryKey(
      selTx,
      (vars: { from: string; to: string; tx: string }) => vars.from,
      (data, vars) => data.filter((t) => t !== vars.tx),
    ),
    onQueryKey(
      selTx,
      (vars: { from: string; to: string; tx: string }) => vars.to,
      (data, vars) => [...data, vars.tx],
    ),
  ],
});

Deno.test("two keyed overlays from one mutation on one query apply to their own keys", () => {
  const state = selState(
    {
      cache: { "selTx:food": entry(["x", "keep"]), "selTx:transport": entry(["t1"]) },
      overlays: [
        intent({
          mutation: "selMove",
          variables: { from: "food", to: "transport", tx: "x" },
          targets: [
            { query: "selTx", key: "food" },
            { query: "selTx", key: "transport" },
          ],
        }),
      ],
    },
    ["food", "transport"],
  );
  // The remove overlay applies only to the source key, the add only to the destination
  assertEquals(selTx.selectByKey(state, "food")?.data, ["keep"]);
  assertEquals(selTx.selectByKey(state, "transport")?.data, ["t1", "x"]);
  assertEquals(selMove.name, "selMove");
});

Deno.test("definitions build their own actions: makeAction and makeInvalidateAction", () => {
  assertEquals(selRename.makeAction({ name: "Ada" }), {
    id: "katha/mutation/run",
    data: { name: "selRename", variables: { name: "Ada" } },
  });
  assertEquals(selUser.makeInvalidateAction(), {
    id: "katha/query/invalidate",
    data: { queryName: "selUser" },
  });
  assertEquals(selTx.makeInvalidateAction({ key: "food", soft: true }), {
    id: "katha/query/invalidate",
    data: { queryName: "selTx", key: "food", soft: true },
  });
});

Deno.test("mutation select returns a stable idle state before the first run", () => {
  const state = selState({});
  const idle = selRename.select(state);
  assertEquals(idle, { status: "idle" });
  // Referentially stable so deep-equal selectors and Object.is both hold
  assertStrictEquals(selRename.select(state), idle);
});

// ---------------------------------------------------------------------------
// Config → targets → intent data (pure)
// ---------------------------------------------------------------------------

type Vars = { readonly id: string; readonly name: string };
const rename = (data: unknown, vars: Vars) => ({ ...(data as object), name: vars.name });
const byId = (vars: Vars) => vars.id;

Deno.test("mutationTargets: primary query is keyed by `key`, else current; overlaid only when optimistic is a function", () => {
  assertEquals(mutationTargets<Vars>({ query: { name: "user" } }), [
    { query: "user", key: "current" },
  ]);
  assertEquals(mutationTargets<Vars>({ query: { name: "user" }, optimistic: rename }), [
    { query: "user", key: "current", overlay: rename },
  ]);
  assertEquals(mutationTargets<Vars>({ query: { name: "users" }, key: byId, optimistic: rename }), [
    { query: "users", key: byId, overlay: rename },
  ]);
});

Deno.test("mutationTargets: explicit targets pass through, invalidates extras are every-key and stale-only", () => {
  const explicit: MutationTarget<Vars> = { query: "user", key: "current", overlay: rename };
  assertEquals(
    mutationTargets<Vars>({ optimistic: [explicit], invalidates: ["list", { name: "stats" }] }),
    [explicit, { query: "list", key: "every" }, { query: "stats", key: "every" }],
  );
});

Deno.test("resolveTargets: keyed and current targets become keyed data; overlays alone become intent targets", () => {
  const vars: Vars = { id: "7", name: "Ada" };
  const targets: readonly MutationTarget<Vars>[] = [
    { query: "users", key: byId, overlay: rename },
    { query: "user", key: "current" },
    { query: "list", key: "every" },
  ];
  assertEquals(resolveTargets(targets, vars, { user: "me" }), {
    targets: [{ query: "users", key: "7" }],
    invalidations: [{ query: "users", key: "7" }, { query: "user", key: "me" }, { query: "list" }],
  });
});

Deno.test("resolveTargets: a current target whose query derives nothing yields no intent target and goes stale name-level", () => {
  const targets: readonly MutationTarget<Vars>[] = [
    { query: "user", key: "current", overlay: rename },
  ];
  assertEquals(resolveTargets(targets, { id: "1", name: "Ada" }, { user: undefined }), {
    targets: [],
    invalidations: [{ query: "user" }],
  });
});

Deno.test("registry: targeting an unregistered query fails fast with a prescriptive error", () => {
  assertThrows(() => requireQuery("nope"), Error, 'no query named "nope" is registered');
  assertThrows(
    () => registerOverlays("nope", "m", [{ keyOf: undefined, apply: (d) => d }]),
    Error,
    "Define it with defineQuery before the mutation that targets it",
  );
});

// ---------------------------------------------------------------------------
// Process integration tests
// ---------------------------------------------------------------------------

const settle = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) yield* Effect.yieldNow();
  }).pipe(Effect.timeout("500 millis"), Effect.orDie);

const letProcessSubscribe = Effect.yieldNow().pipe(Effect.repeatN(5));

type AppState = { queries: QueriesState };
type AppAction = QueriesAction;

const appReducer = combineReducers({ queries: queriesReducer }) as unknown as Reducer<
  AppState,
  AppAction
>;

const appInitial: AppState = { queries: initialQueriesState };

const gate = (): { open: () => void; wait: Effect.Effect<void> } => {
  const ref: { current: (() => void) | null; opened: boolean } = { current: null, opened: false };
  return {
    open: () => {
      ref.opened = true;
      ref.current?.();
    },
    wait: Effect.async<void>((resume) => {
      if (ref.opened) {
        resume(Effect.void);
        return;
      }
      ref.current = () => resume(Effect.void);
    }),
  };
};

Deno.test("process: optimistic mutation hands off to server truth with no flash", () =>
  Effect.gen(function* () {
    let serverName = "Zed";
    let fetchCount = 0;
    const runGate = gate();

    const q = defineQuery<{ name: string }, AppState>("hUser", () => ({
      key: "1",
      fetch: Effect.sync(() => {
        fetchCount++;
        return { name: serverName };
      }),
    }));

    const m = defineMutation("hRename", {
      query: q,
      run: (vars: { name: string }) =>
        Effect.gen(function* () {
          yield* runGate.wait;
          serverName = vars.name;
          return null;
        }),
      optimistic: (data, vars) => ({ ...data, name: vars.name }),
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;

    const viewName = () =>
      (q.select(store.handle.getState())?.data as { name: string } | undefined)?.name;

    const seen: Array<string | undefined> = [];
    store.handle.subscribe((s) => {
      seen.push((q.select(s)?.data as { name: string } | undefined)?.name);
    });

    yield* settle(() => viewName() === "Zed");

    store.handle.put(m.makeAction({ name: "Ada" }));

    // Optimistic view while the mutation is pending
    yield* settle(() => viewName() === "Ada");
    assertEquals(m.select(store.handle.getState()).status, "pending");
    assertEquals(store.handle.getState().queries.cache["hUser:1"]?.data, { name: "Zed" });

    runGate.open();

    // Settled: refetched server truth, overlay released, lifecycle success
    yield* settle(() => store.handle.getState().queries.overlays.length === 0);
    yield* settle(() => store.handle.getState().queries.cache["hUser:1"]?.isFetching === false);
    assertEquals(q.select(store.handle.getState())?.data, { name: "Ada" });
    assertEquals(m.select(store.handle.getState()).status, "success");
    assertEquals(fetchCount, 2);

    // No flash: once the optimistic value appears, the old value never does
    const firstAda = seen.indexOf("Ada");
    assertEquals(firstAda >= 0, true);
    assertEquals(
      seen.slice(firstAda).every((n) => n === "Ada"),
      true,
    );
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: failed mutation rolls back by intent removal, no refetch", () =>
  Effect.gen(function* () {
    let fetchCount = 0;
    const runGate = gate();

    const q = defineQuery<{ name: string }, AppState>("eUser", () => ({
      key: "1",
      fetch: Effect.sync(() => {
        fetchCount++;
        return { name: "Zed" };
      }),
    }));

    const m = defineMutation("eRename", {
      query: q,
      run: (_vars: { name: string }) =>
        Effect.gen(function* () {
          yield* runGate.wait;
          return yield* Effect.fail("denied");
        }),
      optimistic: (data, vars) => ({ ...data, name: vars.name }),
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;

    const viewName = () =>
      (q.select(store.handle.getState())?.data as { name: string } | undefined)?.name;

    yield* settle(() => viewName() === "Zed");

    store.handle.put(m.makeAction({ name: "Ada" }));
    yield* settle(() => viewName() === "Ada");

    runGate.open();

    yield* settle(() => m.select(store.handle.getState()).status === "error");
    // Rollback: intent gone, view derives the canonical value again
    assertEquals(viewName(), "Zed");
    assertEquals(store.handle.getState().queries.overlays, []);
    assertEquals(failure(m.select(store.handle.getState())), {
      error: "denied",
      variables: { name: "Ada" },
    });
    // Errors do not invalidate — the canonical cache was never touched
    assertEquals(fetchCount, 1);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: a defect in run fails the mutation instead of stranding it", () =>
  Effect.gen(function* () {
    const q = defineQuery<{ name: string }, AppState>("dUser", () => ({
      key: "1",
      fetch: Effect.succeed({ name: "Zed" }),
    }));

    // A rejected promise is a defect, not a typed failure — the most common
    // way to wrap an API call must still reach katha/mutation/error.
    const m = defineMutation("dRename", {
      query: q,
      run: (_vars: { name: string }) => Effect.promise(() => Promise.reject(new Error("network"))),
      optimistic: (data, vars) => ({ ...data, name: vars.name }),
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;

    const viewName = () =>
      (q.select(store.handle.getState())?.data as { name: string } | undefined)?.name;

    yield* settle(() => viewName() === "Zed");
    store.handle.put(m.makeAction({ name: "Ada" }));

    yield* settle(() => m.select(store.handle.getState()).status === "error");
    assertEquals(viewName(), "Zed");
    assertEquals(store.handle.getState().queries.overlays, []);
    assertEquals(failure(m.select(store.handle.getState()))?.error, "Error: network");
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: keyless overlay stays on the key derived at dispatch across a selection change", () =>
  Effect.gen(function* () {
    const fetchCounts: Record<string, number> = {};
    const names: Record<string, string> = { "1": "Zed", "2": "Bob" };
    const runGate = gate();

    type NavAppState = { selectedUser: string; queries: QueriesState };
    type NavAction = AppAction | { id: "select-user"; data: string };
    const navReducer = combineReducers({
      selectedUser: (_s: string, a: NavAction): string | undefined =>
        a.id === "select-user" ? (a.data as string) : undefined,
      queries: queriesReducer,
    }) as unknown as Reducer<NavAppState, NavAction>;

    const q = defineQuery<{ name: string }, NavAppState>("nUser", (state) => ({
      key: state.selectedUser,
      fetch: Effect.sync(() => {
        fetchCounts[state.selectedUser] = (fetchCounts[state.selectedUser] ?? 0) + 1;
        return { name: names[state.selectedUser] };
      }),
    }));

    const m = defineMutation("nRename", {
      query: q,
      run: (vars: { name: string }) =>
        Effect.gen(function* () {
          yield* runGate.wait;
          names["1"] = vars.name;
          return null;
        }),
      optimistic: (data, vars) => ({ ...data, name: vars.name }),
    });

    const store = yield* makeStore({
      initialState: { selectedUser: "1", queries: initialQueriesState },
      reduce: navReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;

    const viewName = () =>
      (q.select(store.handle.getState())?.data as { name: string } | undefined)?.name;
    const cache = () => store.handle.getState().queries.cache;

    yield* settle(() => viewName() === "Zed");

    store.handle.put(m.makeAction({ name: "Ada" }));
    yield* settle(() => viewName() === "Ada");
    assertEquals(store.handle.getState().queries.overlays[0]?.targets, [
      { query: "nUser", key: "1" },
    ]);

    // Switch selection mid-flight: user 2 shows canonical data, not user 1's overlay
    store.handle.put({ id: "select-user", data: "2" });
    yield* settle(() => viewName() === "Bob");
    assertEquals(store.handle.getState().queries.overlays.length, 1);

    // Success while user 2 is selected: only user 1's entry goes stale, and user 2's
    // data does not consume the overlay. Nothing derives user 1, so it holds.
    runGate.open();
    yield* settle(() => m.select(store.handle.getState()).status === "success");
    assertEquals(cache()["nUser:1"]?.isStale, true);
    assertEquals(cache()["nUser:2"]?.isStale, false);
    assertEquals(store.handle.getState().queries.overlays.length, 1);
    assertEquals(viewName(), "Bob");
    assertEquals(fetchCounts["2"], 1);

    // Switch back: the reconciler refetches user 1 and that data settles the overlay
    store.handle.put({ id: "select-user", data: "1" });
    yield* settle(() => store.handle.getState().queries.overlays.length === 0);
    yield* settle(() => cache()["nUser:1"]?.isFetching === false);
    assertEquals(cache()["nUser:1"]?.data, { name: "Ada" });
    assertEquals(viewName(), "Ada");
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: interleaved mutations — one fails, the other's overlay survives", () =>
  Effect.gen(function* () {
    let serverName = "Zed";
    let fetchCount = 0;
    const gateA = gate();
    const gateB = gate();

    const q = defineQuery<{ name: string }, AppState>("iUser", () => ({
      key: "1",
      fetch: Effect.sync(() => {
        fetchCount++;
        return { name: serverName };
      }),
    }));

    const a = defineMutation("iRename", {
      query: q,
      run: (_vars: { name: string }) =>
        Effect.gen(function* () {
          yield* gateA.wait;
          return yield* Effect.fail("denied");
        }),
      optimistic: (data, vars) => ({ ...data, name: vars.name }),
    });

    const b = defineMutation("iSuffix", {
      query: q,
      run: (vars: { suffix: string }) =>
        Effect.gen(function* () {
          yield* gateB.wait;
          serverName = serverName + vars.suffix;
          return null;
        }),
      optimistic: (data, vars) => ({ ...data, name: data.name + vars.suffix }),
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* a.process(ctx);
          yield* b.process(ctx);
        }),
    });

    yield* letProcessSubscribe;

    const viewName = () =>
      (q.select(store.handle.getState())?.data as { name: string } | undefined)?.name;

    yield* settle(() => viewName() === "Zed");

    store.handle.put(a.makeAction({ name: "Ada" }));
    yield* settle(() => viewName() === "Ada");
    store.handle.put(b.makeAction({ suffix: "!" }));
    yield* settle(() => viewName() === "Ada!");

    // A fails: its intent is removed; B's overlay re-derives over canonical
    gateA.open();
    yield* settle(() => a.select(store.handle.getState()).status === "error");
    assertEquals(viewName(), "Zed!");
    assertEquals(store.handle.getState().queries.overlays.length, 1);

    // B succeeds: settles, refetches, hands off to server truth
    gateB.open();
    yield* settle(() => store.handle.getState().queries.overlays.length === 0);
    yield* settle(() => store.handle.getState().queries.cache["iUser:1"]?.isFetching === false);
    assertEquals(q.select(store.handle.getState())?.data, { name: "Zed!" });
    assertEquals(b.select(store.handle.getState()).status, "success");
    assertEquals(fetchCount, 2);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: keyed mutation refetches only its key", () =>
  Effect.gen(function* () {
    const fetchCounts: Record<string, number> = { food: 0, transport: 0 };

    type CatAppState = { categories: string[]; queries: QueriesState };
    const catReducer = combineReducers({
      categories: (_s: string[], _a: { id: "noop" }): string[] | undefined => undefined,
      queries: queriesReducer,
    }) as unknown as Reducer<CatAppState, AppAction>;

    const q = defineQuery<string[], CatAppState>("kTx", (state) =>
      state.categories.map((cat) => ({
        key: cat,
        fetch: Effect.sync(() => {
          fetchCounts[cat] = (fetchCounts[cat] ?? 0) + 1;
          return [`${cat}-${fetchCounts[cat]}`];
        }),
      })),
    );

    const m = defineMutation("kAddTx", {
      query: q,
      key: (vars) => vars.category,
      run: (vars: { category: string; tx: string }) => Effect.succeed(vars),
      optimistic: (data, vars) => [...data, vars.tx],
    });

    const store = yield* makeStore({
      initialState: { categories: ["food", "transport"], queries: initialQueriesState },
      reduce: catReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;
    yield* settle(() => fetchCounts.food >= 1 && fetchCounts.transport >= 1);
    yield* settle(
      () =>
        store.handle.getState().queries.cache["kTx:food"]?.data !== undefined &&
        store.handle.getState().queries.cache["kTx:transport"]?.data !== undefined,
    );
    // Let startup reconcile cascades finish before taking baselines
    yield* Effect.sleep("50 millis");
    const foodBefore = fetchCounts.food;
    const transportBefore = fetchCounts.transport;
    const transportEntry = store.handle.getState().queries.cache["kTx:transport"];

    store.handle.put(m.makeAction({ category: "food", tx: "f-opt" }));

    // Only food refetches; its settling intent drops on food's refresh
    yield* settle(() => store.handle.getState().queries.overlays.length === 0);
    yield* settle(() => fetchCounts.food >= foodBefore + 1);
    assertEquals(fetchCounts.transport, transportBefore);
    assertStrictEquals(store.handle.getState().queries.cache["kTx:transport"], transportEntry);
    assertEquals(store.handle.getState().queries.cache["kTx:food"]?.data, [
      `food-${fetchCounts.food}`,
    ]);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: a 'leading' mutation is gated only by its own runs, not another mutation's", () =>
  Effect.gen(function* () {
    let leadingRuns = 0;
    let otherRuns = 0;
    const otherGate = gate();

    const q = defineQuery<{ n: number }, AppState>("lgQ", () => ({
      key: "1",
      fetch: Effect.succeed({ n: 0 }),
    }));

    const other = defineMutation("lgOther", {
      query: q,
      run: (_vars: Record<never, never>) =>
        Effect.gen(function* () {
          otherRuns++;
          yield* otherGate.wait;
          return null;
        }),
    });
    const leading = defineMutation("lgLeading", {
      query: q,
      run: (_vars: Record<never, never>) =>
        Effect.sync(() => {
          leadingRuns++;
        }),
      concurrency: "leading",
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* other.process(ctx);
          yield* leading.process(ctx);
        }),
    });

    yield* letProcessSubscribe;

    // Another mutation's run in flight on the shared trigger id...
    store.handle.put(other.makeAction({}));
    yield* settle(() => otherRuns === 1);
    // ...must not gate the leading mutation.
    store.handle.put(leading.makeAction({}));
    yield* settle(() => leadingRuns === 1);

    otherGate.open();
    yield* settle(() => other.select(store.handle.getState()).status === "success");
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: concurrency 'leading' drops triggers while one is in flight", () =>
  Effect.gen(function* () {
    let runCount = 0;
    const runGate = gate();

    const q = defineQuery<{ n: number }, AppState>("lQ", () => ({
      key: "1",
      fetch: Effect.succeed({ n: 0 }),
    }));

    const m = defineMutation("lPing", {
      query: q,
      run: (_vars: Record<never, never>) =>
        Effect.gen(function* () {
          runCount++;
          yield* runGate.wait;
          return null;
        }),
      concurrency: "leading",
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;

    store.handle.put(m.makeAction({}));
    yield* settle(() => runCount === 1);
    store.handle.put(m.makeAction({}));
    yield* Effect.sleep("30 millis");
    assertEquals(runCount, 1);

    runGate.open();
    yield* settle(() => m.select(store.handle.getState()).status === "success");
    assertEquals(runCount, 1);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: default concurrency 'every' runs all triggers", () =>
  Effect.gen(function* () {
    let runCount = 0;

    const q = defineQuery<{ n: number }, AppState>("vQ", () => ({
      key: "1",
      fetch: Effect.succeed({ n: 0 }),
    }));

    const m = defineMutation("vPing", {
      query: q,
      run: (_vars: Record<never, never>) =>
        Effect.sync(() => {
          runCount++;
          return null;
        }),
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;

    store.handle.put(m.makeAction({}));
    store.handle.put(m.makeAction({}));
    yield* settle(() => runCount === 2);
    assertEquals(runCount, 2);
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: invalidates-only mutation soft-refetches the listed queries", () =>
  Effect.gen(function* () {
    const fetchCounts = { a: 0, b: 0 };

    const qa = defineQuery<number, AppState>("invA", () => ({
      key: "1",
      fetch: Effect.sync(() => ++fetchCounts.a),
    }));
    const qb = defineQuery<number, AppState>("invB", () => ({
      key: "1",
      fetch: Effect.sync(() => ++fetchCounts.b),
    }));

    const m = defineMutation("invPing", {
      run: (_vars: Record<never, never>) => Effect.succeed(null),
      invalidates: [qa, "invB"],
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* qa.process(ctx);
          yield* qb.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;
    yield* settle(() => fetchCounts.a >= 1 && fetchCounts.b >= 1);
    // Let startup reconcile cascades finish before taking baselines
    yield* Effect.sleep("50 millis");
    const aBefore = fetchCounts.a;
    const bBefore = fetchCounts.b;

    store.handle.put(m.makeAction({}));
    yield* settle(() => fetchCounts.a >= aBefore + 1 && fetchCounts.b >= bBefore + 1);
    // Lifecycle-only mutation never creates an overlay intent
    assertEquals(store.handle.getState().queries.overlays, []);
    assertEquals(m.select(store.handle.getState()).status, "success");
  }).pipe(Effect.scoped, Effect.runPromise));

Deno.test("process: a query target without an optimistic fn is still soft-invalidated", () =>
  Effect.gen(function* () {
    let fetchCount = 0;

    const q = defineQuery<number, AppState>("noOptQ", () => ({
      key: "1",
      fetch: Effect.sync(() => ++fetchCount),
    }));

    const m = defineMutation("noOptPing", {
      query: q,
      run: (_vars: Record<never, never>) => Effect.succeed(null),
    });

    const store = yield* makeStore({
      initialState: appInitial,
      reduce: appReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          yield* q.process(ctx);
          yield* m.process(ctx);
        }),
    });

    yield* letProcessSubscribe;
    yield* settle(() => fetchCount >= 1);
    yield* Effect.sleep("50 millis");
    const before = fetchCount;

    store.handle.put(m.makeAction({}));
    yield* settle(() => fetchCount >= before + 1);
    assertEquals(store.handle.getState().queries.overlays, []);
    assertEquals(m.select(store.handle.getState()).status, "success");
  }).pipe(Effect.scoped, Effect.runPromise));

// ---------------------------------------------------------------------------
// Type-level guards — the primary form infers everything from siblings
// ---------------------------------------------------------------------------

// Zero-annotation inference: data and vars are typed from query/run (compiles = passes)
defineMutation("tInferred", {
  query: selUser,
  run: (vars: { name: string }) => Effect.succeed(vars),
  optimistic: (data, vars) => ({ ...data, name: `${data.name}${vars.name}` }),
});

defineMutation("tBad1", {
  query: selTx,
  run: (vars: { category: string }) => Effect.succeed(vars),
  // @ts-expect-error: a multi-key target query requires `key`
  optimistic: (data: string[]) => data,
});

// @ts-expect-error: a single-key target query rejects `key`
defineMutation("tBad2", {
  query: selUser,
  key: (vars: { name: string }) => vars.name,
  run: (vars: { name: string }) => Effect.succeed(vars),
});

// @ts-expect-error: onQuery rejects multi-key query definitions
onQuery(selTx, (data: string[]) => data);

onQueryKey(
  // @ts-expect-error: onQueryKey rejects single-key query definitions
  selUser,
  () => "k",
  (data: { name: string }) => data,
);

const _run: MutationRunAction<"m", { a: number }> = {
  id: "katha/mutation/run",
  data: { name: "m", variables: { a: 1 } },
};
const _badRun: MutationRunAction<"m", { a: number }> = {
  id: "katha/mutation/run",
  // @ts-expect-error: payload must match the mutation's variables type
  data: { name: "m", variables: { b: 2 } },
};
// The trigger is a QueriesAction, so an app union needs nothing per mutation
const _inUnion: QueriesAction = _run;
