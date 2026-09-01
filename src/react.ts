/**
 * React adapter — bridges a StoreHandle into React components.
 *
 * `useSelector` is a hook that selects a slice of state using
 * `useSyncExternalStore`. Deep equality (via fast-equals) prevents
 * unnecessary re-renders when the selected value is structurally identical.
 *
 * `useMutation` binds a `defineMutation` definition to a store: lifecycle
 * state plus a stable `trigger` callback.
 */

import { deepEqual } from "fast-equals";
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { MutationDefinition, MutationState, QueriesState } from "./query.ts";
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

/**
 * Return value of {@linkcode useMutation}: the lifecycle state plus a trigger,
 * with `error` and `variables` flattened for rendering (`undefined` when the
 * state has none). Narrow on `status` to reach the precise run fields.
 */
export type UseMutationResult<V> = MutationState<V> & {
  /** `status === "pending"` — convenience for disabling buttons and spinners. */
  readonly isPending: boolean;
  /** The latest run's error, or `undefined` unless `status === "error"`. */
  readonly error: string | undefined;
  /** The latest run's variables, or `undefined` while idle. */
  readonly variables: V | undefined;
  /** Dispatch the mutation's `` `${name}/run` `` action with these variables. */
  readonly trigger: (variables: V) => void;
};

/**
 * Bind a mutation definition to a store.
 *
 * Mutation state lives in the store (`state.queries.mutations`), so every
 * component using the same mutation sees the same lifecycle — there are no
 * per-hook copies to fall out of sync.
 *
 * Usage:
 * ```tsx
 * const { isPending, error, trigger } = useMutation(store, updateUser);
 * <button disabled={isPending} onClick={() => trigger({ id, name })}>Save</button>
 * ```
 */
export function useMutation<V, S extends { queries: QueriesState }, A extends Action>(
  store: StoreHandle<S, A>,
  mutation: MutationDefinition<string, V, S>,
): UseMutationResult<V> {
  const state = useSelector(store, mutation.select);
  const run = mutation.run;
  const trigger = useCallback(
    (variables: V) => {
      // The run action is a QueriesAction, in the app's union through
      // queriesReducer; membership can't be proven here for a generic A.
      store.put(run(variables) as unknown as A);
    },
    [store, run],
  );
  const isPending = state.status === "pending";
  switch (state.status) {
    case "idle":
      return { ...state, isPending, error: undefined, variables: undefined, trigger };
    case "error":
      return { ...state, isPending, trigger };
    default:
      return { ...state, isPending, error: undefined, trigger };
  }
}
