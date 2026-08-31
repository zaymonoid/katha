/// <reference lib="deno.ns" />

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type IntentTarget,
  initialQueriesState,
  type OverlayIntent,
  type QueriesState,
  type QueryState,
  queriesReducer,
} from "../src/query.ts";

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
  targets: [{ query: "user" }],
  ...overrides,
});

const qs = (partial: Partial<QueriesState> = {}): QueriesState => ({
  cache: {},
  overlays: [],
  mutations: {},
  ...partial,
});

// ---------------------------------------------------------------------------
// mutation-started
// ---------------------------------------------------------------------------

Deno.test("mutation-started records lifecycle and appends intent, cache untouched", () => {
  const targets: IntentTarget[] = [{ query: "user" }];
  const before = qs({ cache: { "user:1": entry({ name: "Zed" }) } });
  const state = queriesReducer(before, {
    id: "mutation-started",
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
        error: undefined,
        variables: { name: "Ada" },
        submittedAt: 111,
      },
    },
  });
  assertStrictEquals(state?.cache, before.cache);
});

Deno.test("mutation-started with no targets records lifecycle only", () => {
  const state = queriesReducer(initialQueriesState, {
    id: "mutation-started",
    data: { name: "ping", intentId: "i1", variables: null, targets: [], submittedAt: 1 },
  });
  assertEquals(state?.overlays, []);
  assertEquals(state?.mutations.ping?.status, "pending");
});

Deno.test("two starts of the same mutation: latest lifecycle, ordered intents", () => {
  const first = queriesReducer(initialQueriesState, {
    id: "mutation-started",
    data: { name: "m", intentId: "i1", variables: 1, targets: [{ query: "q" }], submittedAt: 1 },
  });
  // biome-ignore lint/style/noNonNullAssertion: first is a handled action
  const second = queriesReducer(first!, {
    id: "mutation-started",
    data: { name: "m", intentId: "i2", variables: 2, targets: [{ query: "q" }], submittedAt: 2 },
  });
  assertEquals(
    second?.overlays.map((i) => i.intentId),
    ["i1", "i2"],
  );
  assertEquals(second?.mutations.m, {
    status: "pending",
    error: undefined,
    variables: 2,
    submittedAt: 2,
  });
});

// ---------------------------------------------------------------------------
// mutation-success / mutation-error
// ---------------------------------------------------------------------------

Deno.test("mutation-success settles the intent and keeps variables", () => {
  const before = qs({
    overlays: [intent()],
    mutations: {
      updateUser: {
        status: "pending",
        error: undefined,
        variables: { name: "Ada" },
        submittedAt: 111,
      },
    },
  });
  const state = queriesReducer(before, {
    id: "mutation-success",
    data: { name: "updateUser", intentId: "i1" },
  });
  assertEquals(state?.overlays[0]?.phase, "settling");
  assertEquals(state?.mutations.updateUser, {
    status: "success",
    error: undefined,
    variables: { name: "Ada" },
    submittedAt: 111,
  });
});

Deno.test("mutation-error removes the intent (rollback), leaves siblings and cache", () => {
  const before = qs({
    cache: { "user:1": entry({ name: "Zed" }) },
    overlays: [intent(), intent({ intentId: "i2", mutation: "other" })],
    mutations: {
      updateUser: {
        status: "pending",
        error: undefined,
        variables: { name: "Ada" },
        submittedAt: 111,
      },
    },
  });
  const state = queriesReducer(before, {
    id: "mutation-error",
    data: { name: "updateUser", intentId: "i1", error: "boom" },
  });
  assertEquals(
    state?.overlays.map((i) => i.intentId),
    ["i2"],
  );
  assertStrictEquals(state?.cache, before.cache);
  assertEquals(state?.mutations.updateUser, {
    status: "error",
    error: "boom",
    variables: { name: "Ada" },
    submittedAt: 111,
  });
});

Deno.test("mutation-success/error with unknown intentId are total", () => {
  const s1 = queriesReducer(initialQueriesState, {
    id: "mutation-success",
    data: { name: "m", intentId: "nope" },
  });
  assertEquals(s1?.mutations.m?.status, "success");
  assertEquals(s1?.mutations.m?.variables, undefined);
  const s2 = queriesReducer(initialQueriesState, {
    id: "mutation-error",
    data: { name: "m", intentId: "nope", error: "e" },
  });
  assertEquals(s2?.mutations.m?.status, "error");
});

// ---------------------------------------------------------------------------
// Overlay settling — the atomic handoff
// ---------------------------------------------------------------------------

Deno.test("query-success writes fresh data and releases the settling overlay atomically", () => {
  const before = qs({
    cache: { "user:1": entry({ name: "Zed" }, { isFetching: true }) },
    overlays: [intent({ phase: "settling" })],
  });
  const state = queriesReducer(before, {
    id: "query-success",
    data: { queryId: "user:1", result: { name: "Ada" }, dataUpdatedAt: 2000 },
  });
  // One action, one state: fresh data in, overlay out. No frame between.
  assertEquals(state?.cache["user:1"]?.data, { name: "Ada" });
  assertEquals(state?.overlays, []);
});

Deno.test("query-success drops only the matching target; intent survives with the rest", () => {
  const multi = intent({ phase: "settling", targets: [{ query: "user" }, { query: "audit" }] });
  const state = queriesReducer(qs({ overlays: [multi] }), {
    id: "query-success",
    data: { queryId: "user:1", result: {}, dataUpdatedAt: 1 },
  });
  assertEquals(state?.overlays[0]?.targets, [{ query: "audit" }]);
});

Deno.test("query-success leaves pending-phase intents untouched", () => {
  const state = queriesReducer(qs({ overlays: [intent({ phase: "pending" })] }), {
    id: "query-success",
    data: { queryId: "user:1", result: {}, dataUpdatedAt: 1 },
  });
  assertEquals(state?.overlays.length, 1);
  assertEquals(state?.overlays[0]?.phase, "pending");
});

Deno.test("query-error also releases settling targets", () => {
  const state = queriesReducer(qs({ overlays: [intent({ phase: "settling" })] }), {
    id: "query-error",
    data: { queryId: "user:1", error: "boom" },
  });
  assertEquals(state?.overlays, []);
});

Deno.test("target matching: keyless is name-prefixed, keyed is exact", () => {
  const keyless = intent({ phase: "settling", targets: [{ query: "q" }] });
  const keyed = intent({ intentId: "i2", phase: "settling", targets: [{ query: "q", key: "a" }] });
  const success = (queryId: string) =>
    ({ id: "query-success", data: { queryId, result: {}, dataUpdatedAt: 1 } }) as const;

  // Keyless target matches any key of its query…
  assertEquals(queriesReducer(qs({ overlays: [keyless] }), success("q:zzz"))?.overlays, []);
  // …but not a different query name that shares a prefix.
  assertEquals(queriesReducer(qs({ overlays: [keyless] }), success("q2:zzz"))?.overlays.length, 1);

  // Keyed target matches only its exact entry.
  assertEquals(queriesReducer(qs({ overlays: [keyed] }), success("q:b"))?.overlays.length, 1);
  assertEquals(queriesReducer(qs({ overlays: [keyed] }), success("q:a"))?.overlays, []);
});
