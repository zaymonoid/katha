/**
 * React adapter — bridges a StoreHandle into React components.
 *
 * `useSelector` is a hook that selects a slice of state using
 * `useSyncExternalStore`. Deep equality (via fast-equals) prevents
 * unnecessary re-renders when the selected value is structurally identical.
 */

import { deepEqual } from "fast-equals";
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Action, StoreHandle } from "./types.ts";

/**
 * Subscribe to a slice of store state.
 *
 * Uses `useSyncExternalStore` for tear-free reads, with deep equality
 * on the selector output so derived objects/arrays don't trigger
 * spurious re-renders.
 *
 * Usage:
 * ```tsx
 * const month = useSelector(store, (s) => s.selectedMonth);
 * const active = useSelector(store, (s) => s.items.filter(i => i.active));
 * ```
 */
export function useSelector<S, A extends Action, T>(
  store: StoreHandle<S, A>,
  select: (s: S) => T,
): T {
  const EMPTY = useRef(Symbol());
  const prevRef = useRef<T | symbol>(EMPTY.current);
  const selectRef = useRef(select);
  selectRef.current = select;

  const getSnapshot = useCallback((): T => {
    const next = selectRef.current(store.getState());
    if (prevRef.current !== EMPTY.current && deepEqual(prevRef.current, next)) {
      return prevRef.current as T;
    }
    prevRef.current = next;
    return next;
  }, [store]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // StoreHandle.subscribe calls the listener immediately with the current
      // state. useSyncExternalStore's contract requires subscribe to only
      // register — React calls getSnapshot itself to read the initial value.
      // Swallow the synchronous first invocation to satisfy the contract.
      let initialized = false;
      const unsub = store.subscribe(() => {
        if (initialized) onStoreChange();
      });
      initialized = true;
      return unsub;
    },
    [store],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
