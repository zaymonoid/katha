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
  // The subscriber attach is replaying, and whether its last (un)subscribe
  // during that replay call was a re-subscribe straight to the handle.
  let replaying: ((state: S) => void) | null = null;
  let resubscribed = false;

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
        if (fn === replaying) resubscribed = true;
        return handle.subscribe(fn);
      }
      pending.set(fn, null);
      return () => {
        if (fn === replaying) resubscribed = false;
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

    // Replay pending subscriptions, storing real unsubs. Iterate a snapshot:
    // handle.subscribe calls `fn` at once, and a listener that unsubscribes
    // there deletes itself before its real unsub is stored — re-setting it
    // would append it to the live Map and replay it again, forever. Skip one
    // unsubscribed earlier in the pass; undo the real subscription of one that
    // unsubscribed during its own call (unless it then re-subscribed).
    // A listener that throws on replay is dropped (handle.subscribe is
    // all-or-nothing) and doesn't stop the rest; its error is rethrown once
    // every subscriber is replayed and the buffer is flushed.
    const failures: unknown[] = [];
    for (const fn of [...pending.keys()]) {
      if (!pending.has(fn)) continue;
      replaying = fn;
      resubscribed = false;
      let unsub: () => void;
      try {
        unsub = handle.subscribe(fn);
      } catch (e) {
        failures.push(e);
        pending.delete(fn);
        continue;
      } finally {
        replaying = null;
      }
      if (pending.has(fn)) {
        pending.set(fn, unsub);
      } else if (!resubscribed) {
        unsub();
      }
    }

    // Flush buffered actions
    for (const a of actionBuffer) {
      handle.put(a);
    }
    actionBuffer.length = 0;

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Store listeners failed on attach");
  };

  return { ref, attach };
}
