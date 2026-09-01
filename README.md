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
import { Effect, ManagedRuntime } from "effect";

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

// 5. Define the store as a service
class AppStore extends Effect.Service<AppStore>()("AppStore", {
  scoped: makeStore({
    initialState: { query: "", results: [] } as State,
    reduce: rootReducer,
    process: rootProcess,
  }),
}) {}

// 6. Create a store ref and boot with ManagedRuntime
const { ref: store, attach } = createStoreRef<State, Action>({
  query: "",
  results: [],
});

const runtime = ManagedRuntime.make(AppStore.Default);
runtime.runPromise(AppStore).then(attach);

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

const makeToast = (message: string, duration = 3000): Toast => ({
  id: ulid(),
  message,
  duration,
});

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

Notice that `Toast` arrives fully formed — the `id` is generated *before* it reaches the reducer. Reducers must be pure and deterministic, so side-effects like ID generation belong in a helper like `makeToast` above:

```ts
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

> **Best practice:** Call `combinators<State, Action>()` once and export the bound functions from a shared module. This keeps your type parameters in one place and gives every process file a consistent, fully-typed import.
>
> ```ts
> // combinators.ts
> import { combinators } from "@zaymonoid/katha";
> import type { State, Action } from "./store.ts";
>
> export const { takeEvery, takeLatest, takeLeading, debounce } =
>   combinators<State, Action>();
> ```

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

For [mutations](#mutations), `useMutation` bundles the lifecycle read with a stable trigger. Mutation state is store-backed, so every component using the same mutation sees the same lifecycle:

```tsx
import { useMutation } from "@zaymonoid/katha/react";

function SaveButton() {
  const { isPending, error, trigger } = useMutation(store, updateUser);
  return (
    <>
      <button disabled={isPending} onClick={() => trigger({ id: "u1", name: "Ada" })}>
        Save
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
```

Your UI library of choice isn't listed? [Open an issue](https://github.com/zaymonoid/katha/issues) or file a PR — integrations are thin adapters and relatively straightforward to add.

---

## katha/query

Data fetching with caching and stale-while-revalidate, inspired by [SWR](https://swr.vercel.app) and [TanStack Query](https://tanstack.com/query). Available as a separate import. The query system is itself just a reducer + process — the same primitives available to user-land code.

### How it works

A query is defined by a `derive` function that runs on every state change. `derive` inspects the current state and returns what should be fetched: a `{ key, fetch }` entry, an array of entries, or `null` (nothing needed right now).

The query process reconciles derived entries against what's already cached or in-flight. An entry is *fresh* when it exists and is not marked stale:

| Entry  | In-flight | Action                                                       |
| ------ | --------- | ------------------------------------------------------------ |
| fresh  | no        | Skip — serve cached data                                     |
| fresh  | yes       | Leave alone — serve stale data while refetch completes (SWR) |
| stale  | no        | Fork a background refetch — data stays visible               |
| stale  | yes       | Interrupt (the response predates the invalidation), refork   |
| absent | no        | Fork a new fetch                                             |
| absent | yes       | Interrupt and refetch (hard-invalidated mid-flight)          |

Invalidation comes in two flavours, both built by the definition's own `invalidate`. A **hard** invalidate (`store.put(userQuery.invalidate())`) deletes matching entries — the next reconciliation refetches from a loading state. A **soft** invalidate (`userQuery.invalidate({ soft: true })`) marks entries stale instead: cached data stays visible while the refetch happens in the background, so nothing flashes. Pass `key` to invalidate the single `name:key` entry instead of every key of the query. From a process, `yield* ctx.put(userQuery.invalidate({ soft: true }))`. [Mutations](#mutations) use soft, keyed invalidation automatically. Built-in TTL support is coming soon.

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

### Mutations

Mutations are the write side of the data layer — defined with `defineMutation`, built from the same primitives (the queries reducer plus a process), and read through the same selectors. The definition takes its target query, so data, state, and variables types all infer from siblings — no explicit type arguments:

```ts
import { defineMutation } from "@zaymonoid/katha/query";

const updateUser = defineMutation("updateUser", {
  query: userQuery, // the target query — T and S infer from here
  run: (vars: { id: string; name: string }) => api.updateUser(vars), // an Effect; V infers from here
  optimistic: (data, vars) => ({ ...data, name: vars.name }), // (User, V) => User, fully inferred
  invalidates: [invitationsQuery], // extras — the target query is always included
});

// Multi-key target: say which key the mutation touches
const addTransaction = defineMutation("addTransaction", {
  query: categoryTxQuery,
  key: (vars) => vars.category, // only categoryTx:<category> is overlaid and invalidated
  run: (vars: { category: string; tx: Transaction }) => api.addTransaction(vars),
  optimistic: (data, vars) => [...data, vars.tx],
});
```

**Optimism lives on the read path.** The canonical cache is never optimistically written. Dispatching `updateUser.run(vars)` records a pending *intent* — plain data in `state.queries.overlays` — and the target query's own `select`/`selectByKey` fold pending intents over cached data. Every consumer sees the optimistic view without importing anything mutation-related, and rollback is a non-event: on error the intent is removed, and the next select derives the pre-mutation view. No snapshots, no compensating actions, and interleaved mutations stay correct by construction — each surviving intent simply re-derives over whatever the canonical data is now.

**Success always reconciles with the server.** The optimistic function only has to be approximately right for the pending window: on success the mutation soft-invalidates its target queries and the overlay is held ("settling") until the refetched data lands. Both happen in the single `mutation-success` transition, and the reducer releases the overlay in the same action that writes the fresh data, so the optimistic view hands off to server truth with no flash at either edge. A response that was already in flight when the mutation succeeded predates it and never releases the overlay — the reconciler refetches and that data settles it. If the refetch itself fails, the overlay is released and the canonical (pre-mutation) data shows with the entry's error; re-invalidate to retry.

Overlays are keyed to the entry they were issued for. A single-key query whose key comes from state (say, the selected user) keeps its overlay on the key it derived when the mutation was dispatched, so switching selection mid-flight neither shows the optimistic value on the new key nor lets the new key's fetch settle the old key's overlay.

Wiring mirrors queries — mutation state lives in the same `queries` slice and the trigger is a queries action (`mutation-run`, carrying the mutation name), so there is no new reducer or action type to add. Register the process:

```ts
const rootProcess: Process<AppState, AppAction> = (ctx) =>
  Effect.gen(function* () {
    yield* userQuery.process(ctx);
    yield* updateUser.process(ctx);
  });
```

Firing a mutation is dispatching the action its definition builds — `updateUser.run(variables)` is typed by the mutation, so no id string appears at the call site. It is identical from a component or a process, and the whole lifecycle (`mutation-started`, then `mutation-success` — which carries the soft invalidations — or `mutation-error`, then the refetch) is visible in the action history:

```ts
// From a component (or use the useMutation hook — see React integration)
store.put(updateUser.run({ id, name }));
const run = useSelector(store, updateUser.select); // { status: "idle" } | pending | success | error
if (run.status === "error") console.warn(run.error, run.variables);

// From a process
yield* ctx.put(updateUser.run({ id, name }));
```

**Concurrency** defaults to `takeEvery` — the overlay model keeps interleaved runs correct, so concurrency is safe. Pass `concurrency: "leading"` for double-submit protection. There is deliberately no `"latest"`: interrupting an in-flight HTTP mutation doesn't un-send it.

A mutation that overlays several queries at once can pass a list of targets (built with `onQuery` / `onQueryKey`) instead of a single `query`:

```ts
import { onQuery, onQueryKey } from "@zaymonoid/katha/query";

const complexMutation = defineMutation("complexMutation", {
  run: (vars: Vars) => api.complex(vars),
  optimistic: [
    onQuery(userQuery, (data, vars: Vars) => ({ ...data, name: vars.name })),
    onQueryKey(categoryTxQuery, (vars: Vars) => vars.category, (data, vars) => [...data, vars.tx]),
  ],
});
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
