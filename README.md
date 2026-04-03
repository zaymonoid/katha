# katha

> **katha** (कथा) /kə.tʰɑː/ _n. Sanskrit_ — a story; a narrative told in sequence, where each event arises from the last and shapes what follows.

Saga-pattern state management built on [Effect-TS](https://effect.website) structured concurrency — a minimal store plus long-running processes that coordinate side effects with typed cancellation, scoped lifetimes, and fiber-based coordination.

> ⚠️ **Pre-1.0 experimental release.** The API is unstable and may change between versions. Expect breaking changes without notice.

---

## In the Beginning

As Effect grows in popularity, developers need a way to manage application state that leverages the runtime they're already using — without being locked to a specific UI framework.

Redux-saga showed that long-running processes coordinating side effects via actions is a powerful model. katha brings that model to Effect-TS, where the runtime already provides everything sagas need.

katha connects a minimal store (reducer + action stream) with the familiar saga combinators (`takeEvery`, `takeLatest`, `takeLeading`, `debounce`). Because processes are plain Effects, all the async machinery — retries, timeouts, scheduling, resource management, dependency injection — comes from the Effect ecosystem natively. No reinventing the wheel.

**Leverage the power of Effect for state, and let UI libraries do the thing they're actually good at.** [Bridge katha](#integration) natively into your reactive UI library of choice — React via hooks, Lit via reactive controllers. First class developer experience on both sides of the fold.

---

## Install

```bash
# npm
npm install @zaymonoid/katha effect

# deno
deno add jsr:@zaymonoid/katha npm:effect
```

---

## Quick start

```ts
import { combinators, createStoreRef, makeStore } from "@zaymonoid/katha";
import type { Process } from "@zaymonoid/katha";
import { Effect } from "effect";

// 1. Define your state and actions
type State = { query: string; results: string[] };
type Action =
  | { id: "search"; data: string }
  | { id: "results"; data: string[] };

// 2. Bind combinators to your types once
const { takeLatest } = combinators<State, Action>();

// 3. Write a reducer
const rootReducer = (state: State, action: Action) => {
  switch (action.id) {
    case "search":
      return { ...state, query: action.data };
    case "results":
      return { ...state, results: action.data };
    default:
      return undefined; // no change
  }
};

// 4. Write processes — long-running Effects that coordinate side effects
const search = takeLatest(["search"], (action, ctx) =>
  Effect.gen(function* () {
    const results = yield* fetchResults(action.data);
    yield* ctx.put({ id: "results", data: results });
  }),
);

const rootProcess: Process<State, Action> = (ctx) =>
  Effect.gen(function* () {
    yield* search(ctx);
    // add more processes here
  });

// 5. Define the store program
const storeEffect = makeStore({
  initialState: { query: "", results: [] },
  reduce: rootReducer,
  process: rootProcess,
});

// 6. Create a store ref
const { ref: store, attach } = createStoreRef<State, Action>({
  query: "",
  results: [],
});

// Run the store and bind to the store ref with attach
Effect.runFork(Effect.scoped(storeEffect.pipe(Effect.tap(attach))));

// Use the ref anywhere — actions buffer until the store boots and attaches
store.subscribe((s) => console.log(s.results));
store.put({ id: "search", data: "effect-ts" });
```

`takeLatest` automatically cancels the previous in-flight search when a new one arrives. No manual abort controllers, no race conditions.

---

## Core concepts

### Store

`makeStore` returns an Effect that creates a store scoped to the runtime. The store has two faces:

**Processes** receive a `StoreContext` — the Effect-side API for reading state and dispatching actions:

```ts
ctx.put(action); // Effect<void> — reduce and publish
ctx.select(); // Effect<S> — read current state
ctx.state; // SubscriptionRef<S> — reactive state stream
ctx.actions; // PubSub<A> — raw action stream
```

**Consuming code** interacts with a `StoreHandle` — a plain JS interface with no Effect types. You get one from `createStoreRef`:

```ts
store.put(action); // void — dispatch an action
store.getState(); // S — read current state
store.subscribe(fn); // () => void — subscribe to state changes
```

For rendering, prefer the [UI integrations](#integration) (`fromStore` for Lit, `useSelector` for React) — they add deep equality checks and framework-native reactivity on top of the raw `StoreHandle`.

### `createStoreRef`

Effect boots asynchronously, but your app needs a store reference at import time. `createStoreRef` bridges this gap — it returns a `StoreHandle` you can use immediately, buffering actions and subscriptions until the real store is attached and ready:

```ts
import { createStoreRef } from "@zaymonoid/katha";

const { ref, attach } = createStoreRef<State, Action>(initialState);

// Use ref immediately (actions buffer until attach)
ref.put({ id: "early-action" });
ref.subscribe((s) => render(s));

// Later, when the Effect runtime is ready:
const store = yield * makeStore(config);
attach(store); // flushes buffered actions, replays subscribers
```

### Reducers

Reducers are pure functions that take the current state and an action and return the next state. Actions describe *what happened*; the reducer decides *what it means*. Let's build a simple toast notification system:

```ts
import type { Reducer } from "@zaymonoid/katha";

type Toast = { id: string; message: string; duration: number };
type ToastAction =
  | { id: "toast/show"; data: Toast }
  | { id: "toast/clear"; data: { id: string } };

interface ToastState {
  readonly toasts: readonly Toast[];
}

const initialToastState: ToastState = { toasts: [] };

const toastReducer: Reducer<ToastState, ToastAction> = (state, action) => {
  switch (action.id) {
    case "toast/show":
      return { ...state, toasts: [...state.toasts, action.data] };
    case "toast/clear":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.data.id) };
    default:
      return undefined; // no change
  }
};
```

Notice that `Toast` arrives fully formed — the `id` is generated *before* it reaches the reducer. Reducers must be pure and deterministic, so side-effects like ID generation belong in a helper at the call site:

```ts
const makeToast = (message: string, duration = 3000): Toast => ({
  id: ulid(),
  message,
  duration,
});

// at the call site
store.put({ id: "toast/show", data: makeToast("Saved!") });
```

This keeps reducers trivially testable — the same input always produces the same output.

Returning `undefined` means "this action isn't mine" — the previous state reference is preserved. `combineReducers` uses this to skip allocating a new object when no slice actually changed, keeping referential equality intact and avoiding unnecessary re-renders:

```ts
import { combineReducers } from "@zaymonoid/katha";
import type { StateOf, ActionsOf } from "@zaymonoid/katha";

const rootReducer = combineReducers({
  toasts: toastReducer,
  users: usersReducer,
  posts: postsReducer,
});

type AppState = StateOf<typeof rootReducer>;   // { toasts: ToastState; users: ...; posts: ... }
type AppAction = ActionsOf<typeof rootReducer>; // ToastAction | UsersAction | PostsAction
```

`StateOf` and `ActionsOf` extract the combined types from the reducer so you never write them by hand — define your slices, combine them, and the root types follow.

### Processes

The toast reducer can show and clear toasts — but what if we want them to auto-dismiss after a timeout? That's async coordination, and it's what processes are for.

A process is a long-running Effect that reacts to actions and state changes. It runs for the lifetime of the store and is automatically cleaned up when the store scope closes. Here's the other half of our toast system:

```ts
const toastProcess = takeEvery(["toast/show"], (action, ctx) =>
  Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(action.data.duration));
    yield* ctx.put({ id: "toast/clear", data: { id: action.data.id } });
  }),
);
```

`takeEvery` forks a new fiber for each `toast/show` action, so multiple toasts dismiss independently on their own timers. The process uses `ctx.put` to dispatch a `toast/clear` action back through the reducer — processes and reducers coordinate through the same action stream.

Each process receives a `StoreContext`:

| Member       | Type                    | Purpose                                  |
| ------------ | ----------------------- | ---------------------------------------- |
| `ctx.put`    | `(A) => Effect<void>`   | Reduce action into state, then publish   |
| `ctx.select` | `() => Effect<S>`       | Read the current state snapshot          |
| `ctx.state`  | `SubscriptionRef<S>`    | Reactive state stream                    |
| `ctx.actions`| `PubSub<A>`             | Raw action stream (used by combinators)  |

Processes compose by yielding sub-processes. Each `yield*` sets up listeners and returns immediately, so multiple sub-processes run concurrently as fibers:

```ts
const rootProcess: Process<AppState, AppAction> = (ctx) =>
  Effect.gen(function* () {
    yield* toastProcess(ctx);
    yield* otherAppProcessA(ctx);
    yield* otherAppProcessB(ctx);
  });
```

Because processes are plain Effects, the entire Effect ecosystem works natively — retries, timeouts, resource management, dependency injection — without any katha-specific wrapper API.

### Combinators

Saga-style concurrency strategies for handling actions. Each returns a `Process` you can compose into your root process.

| Combinator                         | Behavior                                            |
| ---------------------------------- | --------------------------------------------------- |
| `takeEvery(ids, handler)`          | Fork a handler for every match. No cancellation.    |
| `takeLatest(ids, handler)`         | Cancel the previous handler, fork a new one.        |
| `takeLeading(ids, handler)`        | Ignore new triggers while a handler is running.     |
| `debounce(duration, ids, handler)` | Wait for a quiet period, then run once.             |
| `take(ctx, ids)`                   | Suspend until a matching action arrives (one-shot). |

Each combinator subscribes to the action stream and forks a long-lived listener fiber. Calling `yield* search(ctx)` sets up the listener and **returns immediately** — it doesn't block. So yielding multiple combinators in sequence starts concurrent listeners, not a sequential chain. Processes compose the same way: a sub-process yields to its combinators, and the root process yields to sub-processes.

```ts
import { combinators } from "@zaymonoid/katha";
import type { Process } from "@zaymonoid/katha";

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
2. **Selectors** — consumer bindings like `fromStore` use deep equality (`fast-equals`) to compare selected values. Even if the state reference changes, subscribers only re-render when the selected slice is structurally different.

Together these mean you can freely select derived data (filtered lists, computed objects) without worrying about spurious updates.

---

## Integration

### Lit

Reactive controller for [Lit](https://lit.dev) components. Selectors are compared with deep equality — derived objects and filtered arrays won't cause re-renders unless the values actually change.

```ts
import { fromStore } from "@zaymonoid/katha/lit";

class MyComponent extends LitElement {
  private count = fromStore(this, store, (s) => s.count);
  private active = fromStore(this, store, (s) =>
    s.items.filter((i) => i.active),
  );

  render() {
    return html`
      <p>Count: ${this.count.value}, Active: ${this.active.value.length}</p>
      <button @click=${() => store.put({ id: "increment" })}>+1</button>
    `;
  }
}
```

### React

Hook for [React](https://react.dev) 18+. Uses `useSyncExternalStore` under the hood for tear-free concurrent reads. Selectors are compared with deep equality — derived objects and filtered arrays only trigger a re-render when the selected value is structurally different.

```tsx
import { useSelector } from "@zaymonoid/katha/react";

function MyComponent() {
  const count = useSelector(store, (s) => s.count);
  const active = useSelector(store, (s) =>
    s.items.filter((i) => i.active),
  );

  return (
    <div>
      <p>Count: {count}, Active: {active.length}</p>
      <button onClick={() => store.put({ id: "increment" })}>+1</button>
    </div>
  );
}
```

---

## katha/query

Data fetching with caching and stale-while-revalidate, inspired by [SWR](https://swr.vercel.app) and [TanStack Query](https://tanstack.com/query). Available as a separate import. The query system is itself just a reducer + process — the same primitives available to user-land code.

### How it works

A query is defined by a `derive` function that runs on every state change. `derive` inspects the current state and returns what should be fetched: a `{ key, fetch }` entry, an array of entries, or `null` (nothing needed right now).

The query process reconciles derived entries against what's already cached or in-flight:

| Cached | In-flight | Action                                                       |
| ------ | --------- | ------------------------------------------------------------ |
| no     | no        | Fork a new fetch                                             |
| yes    | no        | Skip — serve cached data                                     |
| no     | yes       | Interrupt and refetch (inputs changed mid-flight)            |
| yes    | yes       | Leave alone — serve stale data while refetch completes (SWR) |

Invalidation clears the cache; the next reconciliation triggers a fresh fetch. Currently the app controls staleness via invalidation actions — built-in TTL support is coming soon.

### Defining queries

`defineQuery` supports two modes based on what the derive function returns:

- **Single query** — return a `{ key, fetch }` object (or `null` to skip). Read with `query.select(state)`.
- **Multi query** — return an array of `{ key, fetch }` entries. Each is independently cached and fetched. Read individual entries with `query.selectByKey(state, key)`.

```ts
import {
  defineQuery,
  queriesReducer,
  initialQueriesState,
} from "@zaymonoid/katha/query";

// Single: one user at a time
const userQuery = defineQuery<User, AppState>("user", (state) =>
  state.userId ? { key: state.userId, fetch: fetchUser(state.userId) } : null,
);

// Multi: many entries derived from state
const categoryTxQuery = defineQuery<Transaction[], AppState>(
  "categoryTx",
  (state) =>
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
import "@zaymonoid/katha/query-devtools";
```

```html
<query-devtools .store="${store.handle}"></query-devtools>
```

Implemented in Lit and available as a standard web component — drop it into any framework! Renders a panel showing all cached queries, their status, timestamps, and manual invalidation controls.

![Query devtools panel](docs/query-devtools.png)

---

## License

MIT
