/**
 * Lit adapter — bridges a StoreHandle into Lit components.
 *
 * `fromStore` creates a reactive controller that selects a slice of state.
 * Reading and writing are separate concerns: `fromStore` is for reading,
 * `store.put` is for writing.
 */

import { deepEqual } from "fast-equals";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { Action, StoreHandle } from "./types.ts";

class StoreController<S, A extends Action, T> implements ReactiveController {
  private _host: ReactiveControllerHost;
  private _store: StoreHandle<S, A>;
  private _select: (s: S) => T;
  private _unsub?: () => void;

  value: T;

  constructor(host: ReactiveControllerHost, store: StoreHandle<S, A>, select: (s: S) => T) {
    this._host = host;
    this._store = store;
    this._select = select;
    this.value = select(store.getState());
    host.addController(this);
  }

  hostConnected(): void {
    this._unsub = this._store.subscribe((state) => {
      const next = this._select(state);
      if (!deepEqual(next, this.value)) {
        this.value = next;
        this._host.requestUpdate();
      }
    });
  }

  hostDisconnected(): void {
    this._unsub?.();
  }
}

/**
 * Create a reactive controller that selects a slice of store state.
 *
 * Usage:
 * ```ts
 * private month = fromStore(this, store, (s) => s.selectedMonth);
 * render() { return html`${this.month.state}`; }
 * ```
 */
export function fromStore<S, A extends Action, T>(
  host: ReactiveControllerHost,
  store: StoreHandle<S, A>,
  select: (s: S) => T,
): StoreController<S, A, T> {
  return new StoreController(host, store, select);
}
