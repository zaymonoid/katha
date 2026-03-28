import type { Prettify } from "./type-utils.ts";
import type { Action } from "./types.ts";

export type Reducer<S, A extends Action> = (state: S, action: A) => S | undefined;

// biome-ignore lint/suspicious/noExplicitAny: inference position requires any
export type StateOf<R extends Reducer<any, any>> = R extends Reducer<infer S, any> ? S : never;
// biome-ignore lint/suspicious/noExplicitAny: inference position requires any
export type ActionsOf<R extends Reducer<any, any>> = R extends Reducer<any, infer A> ? A : never;

// biome-ignore lint/suspicious/noExplicitAny: required for generic type-level inference
type CombinedState<M extends Record<string, Reducer<any, any>>> = Prettify<{
  // biome-ignore lint/suspicious/noExplicitAny: infer position requires any
  [K in keyof M]: M[K] extends Reducer<infer S, any> ? S : never;
}>;

// biome-ignore lint/suspicious/noExplicitAny: required for generic type-level inference
type CombinedAction<M extends Record<string, Reducer<any, any>>> = Parameters<M[keyof M]>[1];

// biome-ignore lint/suspicious/noExplicitAny: required for generic type-level inference
export function combineReducers<M extends Record<string, Reducer<any, any>>>(
  reducers: M,
): (state: CombinedState<M>, action: CombinedAction<M>) => CombinedState<M> {
  const keys = Object.keys(reducers as M);
  return (state, action) => {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of keys) {
      const prev = state[key as keyof typeof state];
      const result = (reducers as M)[key](prev, action);
      if (result === undefined) {
        next[key] = prev;
      } else {
        next[key] = result;
        if (result !== prev) changed = true;
      }
    }
    return (changed ? next : state) as CombinedState<M>;
  };
}
