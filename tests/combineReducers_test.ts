/// <reference lib="deno.ns" />

import { assertEquals, assertStrictEquals } from "@std/assert";
import { Effect } from "effect";
import { makeStore } from "../src/makeStore.ts";
import { type ActionsOf, combineReducers, type StateOf } from "../src/reducer.ts";
import { settle } from "./test-helpers.ts";

// --- sub-reducer types — each sub-reducer declares only the actions it handles ---
type CounterState = { count: number };
type TodosState = { items: string[] };

type CounterAction = { id: "inc" } | { id: "dec" } | { id: "set"; value: number };

type TodosAction = { id: "addTodo"; text: string } | { id: "reset" };

// Slice reducers return undefined for unhandled actions — no default branch needed
const counterReducer = (s: CounterState, a: CounterAction): CounterState | undefined => {
  switch (a.id) {
    case "inc":
      return { count: s.count + 1 };
    case "dec":
      return { count: s.count - 1 };
    case "set":
      return { count: a.value };
  }
};

const todosReducer = (s: TodosState, a: TodosAction): TodosState | undefined => {
  switch (a.id) {
    case "addTodo":
      return { items: [...s.items, a.text] };
    case "reset":
      return { items: [] };
  }
};

const rootReducer = combineReducers({
  counter: counterReducer,
  todos: todosReducer,
});

const initialState = { counter: { count: 0 }, todos: { items: [] as string[] } };

// --- tests ---

Deno.test("combined state has correct shape", () => {
  const state = rootReducer(initialState, { id: "inc" });
  assertEquals(Object.keys(state).sort(), ["counter", "todos"]);
  assertEquals(state.counter, { count: 1 });
  assertEquals(state.todos, { items: [] });
});

Deno.test("dispatching updates the correct sub-reducer only", () => {
  const state = rootReducer(initialState, { id: "inc" });
  assertEquals(state.counter, { count: 1 });
  assertEquals(state.todos, initialState.todos);

  const state2 = rootReducer(initialState, { id: "addTodo", text: "buy milk" });
  assertEquals(state2.todos, { items: ["buy milk"] });
});

Deno.test("payload narrowing in case branches", () => {
  // "set" narrows to Set, giving access to .value
  const state = rootReducer(initialState, { id: "set", value: 42 });
  assertEquals(state.counter, { count: 42 });

  // "addTodo" narrows to AddTodo, giving access to .text
  const state2 = rootReducer(initialState, { id: "addTodo", text: "test" });
  assertEquals(state2.todos, { items: ["test"] });
});

Deno.test("addTodo only affects todos sub-reducer", () => {
  const state = rootReducer(initialState, { id: "addTodo", text: "buy milk" });
  assertEquals(state.counter, { count: 0 }); // counter unaffected
  assertEquals(state.todos, { items: ["buy milk"] });
});

Deno.test("void return keeps previous state for that sub-reducer", () => {
  // "reset" is only handled by todosReducer — counterReducer returns void
  const populated = { counter: { count: 5 }, todos: { items: ["a", "b"] } };
  const state = rootReducer(populated, { id: "reset" });
  assertStrictEquals(state.counter, populated.counter); // same reference, kept by void
  assertEquals(state.todos, { items: [] });
});

Deno.test("referential equality — same object when no sub-reducer changed", () => {
  // "inc" changes counter but not todos — verify todos keeps its reference
  const state = rootReducer(initialState, { id: "inc" });
  assertStrictEquals(state.todos, initialState.todos);
});

Deno.test("unhandled action preserves state", () => {
  // Actions may be intended for processes, not reducers — no warning needed
  const bogus = { id: "bogus" } as unknown as ActionsOf<typeof rootReducer>;
  const state = rootReducer(initialState, bogus);
  assertStrictEquals(state, initialState);
});

Deno.test("type inference — combined state and action types", () => {
  // Compile-time: state shape is correctly inferred
  const state = rootReducer(initialState, { id: "inc" });
  const _count: number = state.counter.count;
  const _items: string[] = state.todos.items;

  // All action types accepted
  rootReducer(initialState, { id: "dec" });
  rootReducer(initialState, { id: "set", value: 10 });
  rootReducer(initialState, { id: "addTodo", text: "x" });
  rootReducer(initialState, { id: "reset" });
});

Deno.test("StateOf / ActionsOf — derive types from combined reducer", () => {
  // No manually-written AppAction / AppState — derived from the reducer map
  type AppState = StateOf<typeof rootReducer>;
  type AppAction = ActionsOf<typeof rootReducer>;

  // StateOf produces the combined state shape
  const _state: AppState = { counter: { count: 0 }, todos: { items: [] } };
  const _count: number = _state.counter.count;
  const _items: string[] = _state.todos.items;

  // ActionsOf produces the union of all sub-reducer actions
  const _inc: AppAction = { id: "inc" };
  const _set: AppAction = { id: "set", value: 1 };
  const _add: AppAction = { id: "addTodo", text: "x" };
  const _reset: AppAction = { id: "reset" };
});

Deno.test("overlapping action ids across sub-reducers — multicasts to both", () => {
  type ActionA = { id: "save" } | { id: "load" };
  type ActionB = { id: "save" } | { id: "delete" }; // "save" overlaps

  const reducerA = (s: { a: number }, a: ActionA) => {
    if (a.id === "save") return { a: s.a + 1 };
    return undefined;
  };
  const reducerB = (s: { b: number }, a: ActionB) => {
    if (a.id === "save") return { b: s.b + 10 };
    return undefined;
  };

  const root = combineReducers({ a: reducerA, b: reducerB });
  const state = root({ a: { a: 0 }, b: { b: 0 } }, { id: "save" });
  assertEquals(state.a, { a: 1 });
  assertEquals(state.b, { b: 10 });
});

Deno.test("integration with makeStore — process reads combined state", () =>
  Effect.gen(function* () {
    let observedCount = -1;
    let observedItems: string[] = [];

    const store = yield* makeStore({
      initialState,
      reduce: rootReducer,
      process: (ctx) =>
        Effect.gen(function* () {
          const state = yield* ctx.select();
          observedCount = state.counter.count;
          observedItems = state.todos.items;
        }),
    });

    yield* settle(() => observedCount === 0);
    assertEquals(observedCount, 0);
    assertEquals(observedItems, []);

    store.handle.put({ id: "set", value: 99 });
    yield* settle(() => store.handle.getState().counter.count === 99);
    assertEquals(store.handle.getState().counter, { count: 99 });

    store.handle.put({ id: "addTodo", text: "test" });
    yield* settle(() => store.handle.getState().todos.items.length === 1);
    assertEquals(store.handle.getState().counter, { count: 99 });
    assertEquals(store.handle.getState().todos, { items: ["test"] });
  }).pipe(Effect.scoped, Effect.runPromise));
