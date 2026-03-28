# effect-saga

State management with saga-pattern side effects, built on [Effect-TS](https://effect.website) structured concurrency.

The saga pattern done right — Effect's fiber runtime gives you typed cancellation, scoped lifetimes, and structured concurrency where redux-saga gave you generator tricks and a prayer.

## Why

Redux-saga showed that long-running processes coordinating side effects via actions is a great model. But its use of generators is a hack — `yield` simulates concurrency without actually having it. Cancellation is bolted on, error handling is stringly-typed, and there's no structured lifetime management.

Effect-TS has a real fiber runtime with all of this built in. effect-saga connects it to a minimal store (reducer + action stream) with the familiar saga combinators (`takeEvery`, `takeLatest`, `takeLeading`, `debounce`) — except now they use real fiber interruption, scoped lifetimes, and typed effects.

The key design constraint: **Effect types never leak to the UI.** The store exposes a plain JS `StoreHandle` — `put`, `subscribe`, `getState` — that any framework can consume. Processes run in Effect-land with full access to the fiber runtime.

## Install

```bash
# npm
npm install effect-saga effect

# deno
deno add npm:effect-saga npm:effect
```

## Quick start

```ts
import { makeStore, takeLatest } from "effect-saga";
import { Effect } from "effect";

// 1. Define your state and actions
type State = { query: string; results: string[] };
type Action =
  | { id: "search"; query: string }
  | { id: "results"; results: string[] };

// 2. Write a reducer
const reduce = (state: State, action: Action) => {
  switch (action.id) {
    case "search":  return { ...state, query: action.query };
    case "results": return { ...state, results: action.results };
  }
};

// 3. Write a process — a long-running Effect that coordinates side effects
const searchProcess = takeLatest<State, Action, "search", never>(
  ["search"],
  (action, ctx) =>
    Effect.gen(function* () {
      const results = yield* fetchResults(action.query);
      yield* ctx.put({ id: "results", results });
    }),
);

// 4. Create the store
const program = Effect.gen(function* () {
  const store = yield* makeStore({
    initialState: { query: "", results: [] },
    reduce,
    process: searchProcess,
  });

  // The handle is plain JS — use it anywhere
  store.handle.subscribe((s) => console.log(s.results));
  store.handle.put({ id: "search", query: "effect-ts" });
});

Effect.runFork(Effect.scoped(program));
```

`takeLatest` automatically cancels the previous in-flight search when a new one arrives. No manual abort controllers, no race conditions.

## Core concepts

### Store

`makeStore` creates a store scoped to the Effect runtime. It returns both Effect-side internals (for processes) and a plain JS handle (for UI):

```ts
// Effect-side — used by processes
store.put(action)     // Effect<void>
store.select()        // Effect<S>
store.state           // SubscriptionRef<S>
store.actions         // PubSub<A>

// Plain JS — used by UI
store.handle.put(action)        // void
store.handle.getState()         // S
store.handle.subscribe(fn)      // () => void (unsubscribe)
```

The bridge between these two worlds is automatic — actions dispatched via the handle are queued and processed by the Effect runtime.

### Reducers

Standard `(state, action) => state` with one twist: returning `undefined` means "no change". This enables `combineReducers` to preserve referential equality when a slice doesn't handle an action:

```ts
import { combineReducers } from "effect-saga";

const rootReducer = combineReducers({
  users: usersReducer,
  posts: postsReducer,
});
// If postsReducer returns undefined, rootReducer returns the same
// state object — same reference, no unnecessary re-renders.
```

### Processes

A process is an Effect that runs for the lifetime of the store. It receives a `StoreContext` with access to the action stream and state:

```ts
import type { Process } from "effect-saga";

const myProcess: Process<State, Action> = (ctx) =>
  Effect.gen(function* () {
    // Read state
    const state = yield* ctx.select();

    // Dispatch actions
    yield* ctx.put({ id: "loaded", data });

    // Subscribe to state changes
    yield* ctx.state.changes.pipe(
      Stream.runForEach((s) => Effect.log(s)),
    );
  });
```

## Combinators

Saga-style concurrency strategies for handling actions. Each returns a `Process` you can pass to `makeStore`.

| Combinator | Behavior |
|---|---|
| `takeEvery(ids, handler)` | Fork a handler for every match. No cancellation. |
| `takeLatest(ids, handler)` | Cancel the previous handler, fork a new one. |
| `takeLeading(ids, handler)` | Ignore new triggers while a handler is running. |
| `debounce(duration, ids, handler)` | Wait for a quiet period, then run once. |
| `take(ctx, ids)` | Suspend until a matching action arrives (one-shot). |

```ts
import { combinators } from "effect-saga";

// Pre-bind your state/action types once
const { takeLatest, takeEvery, debounce } = combinators<State, Action>();

const rootProcess: Process<State, Action> = (ctx) =>
  Effect.gen(function* () {
    yield* takeLatest(["search"], searchHandler)(ctx);
    yield* takeEvery(["analytics/track"], trackHandler)(ctx);
    yield* debounce("500 millis", ["editor/change"], autoSaveHandler)(ctx);
  });
```

## Extras

### `combineReducers`

Combines a record of reducers into one. Preserves structural sharing — the combined state object reference is stable when no slice changes.

```ts
type StateOf<R>    // Extract state type from a reducer
type ActionsOf<R>  // Extract action type from a reducer
```

### `createStoreRef`

A deferred store handle for use before the Effect runtime boots. Actions and subscriptions are buffered and replayed on attach:

```ts
import { createStoreRef } from "effect-saga";

const { ref, attach } = createStoreRef<State, Action>(initialState);

// Use ref immediately (actions buffer until attach)
ref.put({ id: "early-action" });
ref.subscribe((s) => render(s));

// Later, when the Effect runtime is ready:
const store = yield* makeStore(config);
attach(store);  // flushes buffered actions, replays subscribers
```

### Query system

Built-in data fetching with caching and stale-while-revalidate:

```ts
import { defineQuery, queriesReducer, initialQueriesState } from "effect-saga/query";

const userQuery = defineQuery<User, AppState>("user", (state) =>
  state.userId
    ? { key: state.userId, fetch: fetchUser(state.userId) }
    : null,
);

// Wire into your store
const reduce = combineReducers({
  queries: queriesReducer,
  // ...other slices
});

// In your root process
const rootProcess: Process<AppState, AppAction> = (ctx) =>
  Effect.gen(function* () {
    yield* userQuery.process(ctx);
  });

// Read cached data
const cached = userQuery.select(store.handle.getState());
```

Queries are derived from state — when the inputs change, the query re-evaluates. Cached data is served immediately while refetches happen in the background.

### Lit integration

Reactive controller for [Lit](https://lit.dev) components:

```ts
import { fromStore } from "effect-saga/lit";

class MyComponent extends LitElement {
  private count = fromStore(this, store, (s) => s.count);

  render() {
    return html`<p>Count: ${this.count.value}</p>`;
  }
}
```

Deep equality prevents spurious re-renders when the selected slice is structurally identical.

### Query devtools

```ts
import "effect-saga/query-devtools";
```

```html
<query-devtools .store=${store.handle}></query-devtools>
```

Renders a panel showing all cached queries, their status, timestamps, and manual invalidation controls.

## Design decisions

- **8,192-action bounded queue** bridges imperative `put()` calls to the Effect runtime. Overflow throws — if you hit it, you have a bug.
- **`undefined` return convention** in reducers enables structural sharing without immer or immutable.js.
- **Fiber-based cancellation** means `takeLatest` and `debounce` use real interruption, not boolean flags.
- **No middleware** — processes are the only extension point. They compose naturally via Effect.

## License

MIT
