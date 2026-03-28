import type { Action, Store, StoreHandle } from "./types.ts";

/**
 * Stable store reference with action buffering.
 *
 * `createStoreRef` returns a `StoreHandle` that can be imported and used
 * immediately — before the Effect runtime has booted. Actions dispatched
 * before `attach` are buffered and flushed once the real store is ready.
 */
export function createStoreRef<S, A extends Action>(
  initialState: S,
): {
  ref: StoreHandle<S, A>;
  attach: (store: Store<S, A>) => void;
} {
  let handle: StoreHandle<S, A> | null = null;
  const actionBuffer: A[] = [];
  // Maps subscriber → real unsub (populated during attach)
  const pending = new Map<(state: S) => void, (() => void) | null>();

  const ref: StoreHandle<S, A> = {
    put(action) {
      if (handle) {
        handle.put(action);
      } else {
        actionBuffer.push(action);
      }
    },
    subscribe(fn) {
      if (handle) {
        return handle.subscribe(fn);
      }
      pending.set(fn, null);
      return () => {
        const realUnsub = pending.get(fn);
        if (realUnsub) {
          realUnsub();
        }
        pending.delete(fn);
      };
    },
    getState() {
      if (handle) return handle.getState();
      return initialState;
    },
  };

  const attach = (store: Store<S, A>) => {
    handle = store.handle;

    // Replay pending subscriptions, storing real unsubs
    for (const [fn] of pending) {
      const unsub = handle.subscribe(fn);
      pending.set(fn, unsub);
    }

    // Flush buffered actions
    for (const a of actionBuffer) {
      handle.put(a);
    }
    actionBuffer.length = 0;
  };

  return { ref, attach };
}
