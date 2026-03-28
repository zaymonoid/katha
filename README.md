# effect-saga

State management with saga-pattern side effects, built on [Effect-TS](https://effect.website) structured concurrency.

The saga pattern — long-running processes that listen for actions and coordinate side effects — with real structured concurrency: typed cancellation, scoped lifetimes, and fiber-based coordination powered by Effect's runtime.

> ⚠️ **Pre-1.0 experimental release.** The API is unstable and may change between versions. Expect breaking changes without notice.

## Why

As Effect grows in popularity, developers need a way to manage application state that leverages the runtime they're already using — without being locked to a specific UI framework.

Redux-saga showed that long-running processes coordinating side effects via actions is a powerful model. effect-saga brings that model to Effect-TS — a real fiber runtime with typed cancellation, scoped lifetimes, and structured concurrency built in.

effect-saga connects a minimal store (reducer + action stream) with the familiar saga combinators (`takeEvery`, `takeLatest`, `takeLeading`, `debounce`) — backed by real fiber interruption and typed effects. Because processes are plain Effects, all the async machinery — retries, timeouts, scheduling, resource management, dependency injection — comes from the Effect ecosystem natively. No reinventing the wheel.

**Leverage the power of Effect for state, and let UI libraries do the thing they're actually good at.** Bridge effect-saga natively into your reactive UI library of choice — [React](#react) via hooks, [Lit](#lit) via reactive controllers. First class developer experience on both sides of the fold.

## Install

```bash
# npm
npm install effect-saga effect

# deno
deno add npm:effect-saga npm:effect
```

## Quick start

```ts
import { combinators, createStoreRef, makeStore } from "effect-saga";
import type { Process } from "effect-saga";
import { Effect } from "effect";

// 1. Define your state and actions
type State = { query: string; results: string[] };
type Action =
  | { id: "search"; data: string }
  | { id: "results"; data: string[] };

// 2. Bind combinators to your types once
const { takeLatest } = combinators<State, Action>();

// 3. Write a reducer
const reduce = (state: State, action: Action) => {
  switch (action.id) {
    case "search":  return { ...state, query: action.data };
    case "results": return { ...state, results: action.data };
    default:        return undefined; // no change
  }
};

// 4. Write processes — long-running Effects that coordinate side effects
const search = takeLatest(["search"], (action, ctx) =>
  Effect.gen(function* () {
    const results = yield* fetchResults(action.data);
    yield* ctx.put({ id: "results", data: results });
  }),
);

const root: Process<State, Action> = (ctx) =>
  Effect.gen(function* () {
    yield* search(ctx);
    // add more processes here
  });

// 5. Define the store program
const storeEffect = makeStore({
  initialState: { query: "", results: [] },
  reduce,
  process: root,
});

// 6. Create a store ref and boot the runtime
const { ref: store, attach } = createStoreRef<State, Action>({
  query: "",
  results: [],
});

Effect.runFork(Effect.scoped(storeEffect.pipe(Effect.tap(attach))));

// Use the ref anywhere — actions buffer until attach
store.subscribe((s) => console.log(s.results));
store.put({ id: "search", data: "effect-ts" });
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

### `createStoreRef`

The idea: let Effect handle state, coordination, and side effects — let UI libraries do the thing they're actually good at (rendering). But Effect boots asynchronously, and your UI needs a store reference at import time. `createStoreRef` bridges this gap — it returns a handle you can use immediately, buffering actions and subscriptions until the real store is ready:

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

### Reducers

Standard `(state, action) => state` with one twist: returning `undefined` means "no change". This enables `combineReducers` to preserve referential equality when a slice doesn't handle an action:

```ts
import { combineReducers } from "effect-saga";
import type { Reducer, StateOf, ActionsOf } from "effect-saga";

const rootReducer = combineReducers({
  users: usersReducer,
  posts: postsReducer,
});
// If postsReducer returns undefined, rootReducer returns the same
// state object — same reference, no unnecessary re-renders.

type AppState = StateOf<typeof rootReducer>;
type AppAction = ActionsOf<typeof rootReducer>;
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

    // Compose sub-processes
    yield* someHandler(ctx);
    yield* anotherHandler(ctx);
  });
```

### Combinators

Saga-style concurrency strategies for handling actions. Each returns a `Process` you can compose into your root process.

| Combinator | Behavior |
|---|---|
| `takeEvery(ids, handler)` | Fork a handler for every match. No cancellation. |
| `takeLatest(ids, handler)` | Cancel the previous handler, fork a new one. |
| `takeLeading(ids, handler)` | Ignore new triggers while a handler is running. |
| `debounce(duration, ids, handler)` | Wait for a quiet period, then run once. |
| `take(ctx, ids)` | Suspend until a matching action arrives (one-shot). |

Each combinator subscribes to the action stream and forks a long-lived listener fiber. Calling `yield* search(ctx)` sets up the listener and **returns immediately** — it doesn't block. So yielding multiple combinators in sequence starts concurrent listeners, not a sequential chain. Processes compose the same way: a sub-process yields to its combinators, and the root process yields to sub-processes.

```ts
import { combinators } from "effect-saga";
import type { Process } from "effect-saga";

// Bind your state/action types once — all combinators are fully typed from here
const { takeLatest, takeEvery, debounce } = combinators<State, Action>();

// Define handlers as standalone values
const search = takeLatest(["search"], (action, ctx) =>
  Effect.gen(function* () {
    const results = yield* fetchResults(action.data);
    yield* ctx.put({ id: "results", data: results });
  }),
);

const track = takeEvery(["analytics/track"], (action, ctx) =>
  Effect.log(`tracked: ${action.data}`),
);

const autoSave = debounce("500 millis", ["editor/change"], (action, ctx) =>
  Effect.gen(function* () {
    const state = yield* ctx.select();
    yield* save(state);
  }),
);

// Each yield* starts a listener and returns immediately — all run concurrently
const root: Process<State, Action> = (ctx) =>
  Effect.gen(function* () {
    yield* search(ctx);
    yield* track(ctx);
    yield* autoSave(ctx);
  });
```

### Value equality

Unnecessary re-renders are avoided at two levels:

1. **Reducers** — returning `undefined` means "no change", preserving the previous state reference. `combineReducers` only allocates a new object when at least one slice actually changed.
2. **Selectors** — UI bindings like `fromStore` use deep equality (`fast-equals`) to compare selected values. Even if the state reference changes, the component only re-renders when the selected slice is structurally different.

Together these mean you can freely select derived data (filtered lists, computed objects) without worrying about spurious updates.

## Integration

### Lit

Reactive controller for [Lit](https://lit.dev) components. Selectors are compared with deep equality — derived objects and filtered arrays won't cause re-renders unless the values actually change.

```ts
import { fromStore } from "effect-saga/lit";

class MyComponent extends LitElement {
  private count = fromStore(this, store, (s) => s.count);
  private active = fromStore(this, store, (s) => s.items.filter((i) => i.active));

  render() {
    return html`
      <p>Count: ${this.count.value}, Active: ${this.active.value.length}</p>
      <button @click=${() => store.put({ id: "increment" })}>+1</button>
    `;
  }
}
```

### React

Coming soon.

## effect-saga/query

Data fetching with caching and stale-while-revalidate, inspired by [SWR](https://swr.vercel.app) and [TanStack Query](https://tanstack.com/query). Available as a separate import. The query system is itself just a reducer + process — the same primitives available to user-land code.

### How it works

A query is defined by a `derive` function that runs on every state change. `derive` inspects the current state and returns what should be fetched: a `{ key, fetch }` entry, an array of entries, or `null` (nothing needed right now).

The query process reconciles derived entries against what's already cached or in-flight:

| Cached | In-flight | Action |
|---|---|---|
| no | no | Fork a new fetch |
| yes | no | Skip — serve cached data |
| no | yes | Interrupt and refetch (inputs changed mid-flight) |
| yes | yes | Leave alone — serve stale data while refetch completes (SWR) |

Invalidation clears the cache; the next reconciliation triggers a fresh fetch. Currently the app controls staleness via invalidation actions — built-in TTL support is coming soon.

### Defining queries

`defineQuery` supports two modes based on what the derive function returns:

- **Single query** — return a `{ key, fetch }` object (or `null` to skip). Read with `query.select(state)`.
- **Multi query** — return an array of `{ key, fetch }` entries. Each is independently cached and fetched. Read individual entries with `query.selectByKey(state, key)`.

```ts
import { defineQuery, queriesReducer, initialQueriesState } from "effect-saga/query";

// Single: one user at a time
const userQuery = defineQuery<User, AppState>("user", (state) =>
  state.userId ? { key: state.userId, fetch: fetchUser(state.userId) } : null,
);

// Multi: many entries derived from state
const categoryTxQuery = defineQuery<Transaction[], AppState>("categoryTx", (state) =>
  state.expandedCategories.map((cat) => ({
    key: cat,
    fetch: fetchTransactions(cat),
  })),
);
```

### Wiring into your store

```ts
// Add the query reducer to your store
const reduce = combineReducers({
  queries: queriesReducer,
  // ...other slices
});

// Register query processes alongside your other processes
const rootProcess: Process<AppState, AppAction> = (ctx) =>
  Effect.gen(function* () {
    yield* userQuery.process(ctx);
    yield* categoryTxQuery.process(ctx);
  });

// Read cached data from the UI
const cached = userQuery.select(store.handle.getState());
```

### Query devtools

```ts
import "effect-saga/query-devtools";
```

```html
<query-devtools .store=${store.handle}></query-devtools>
```

Implemented in Lit and available as a standard web component — drop it into any framework! Renders a panel showing all cached queries, their status, timestamps, and manual invalidation controls.

![Query devtools panel](docs/query-devtools.png)

## License

MIT
