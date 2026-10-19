/**
 * Core API for katha — saga-pattern state management built on Effect-TS.
 *
 * Re-exports store construction ({@linkcode makeStore}, {@linkcode createStoreRef}),
 * reducer utilities ({@linkcode combineReducers}), and saga combinators
 * ({@linkcode takeEvery}, {@linkcode takeLatest}, {@linkcode takeLeading}, etc.).
 *
 * @module
 */

export type { CombinatorSet } from "./combinators.ts";
export {
  combinators,
  debounce,
  take,
  takeEvery,
  takeLatest,
  takeLeading,
} from "./combinators.ts";
export { makeStore } from "./makeStore.ts";
export type { ActionsOf, Reducer, StateOf } from "./reducer.ts";
export { combineReducers } from "./reducer.ts";
export { createStoreRef } from "./ref.ts";
export type {
  Action,
  ActionOf,
  Process,
  Store,
  StoreConfig,
  StoreContext,
  StoreHandle,
  Transition,
} from "./types.ts";
