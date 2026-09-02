/**
 * Query registry — the one piece of module-level mutable state in the data
 * layer, made explicit.
 *
 * Store state is plain data, so the functions a mutation contributes to a
 * query (optimistic overlays) and the function a query uses to derive its
 * current key cannot live there. They live here instead, keyed by query name
 * — the same identity the cache uses (`name:key`). `defineQuery` registers a
 * query at definition time; `defineMutation` registers overlays against it.
 * Re-defining a query replaces its registration; re-defining a mutation
 * replaces its overlays as a set, so module re-evaluation never double-applies.
 *
 * @module
 */

/** An optimistic transform a mutation contributes to one query. */
export interface QueryOverlay {
  /**
   * Resolves which key of a multi-key query this overlay applies to.
   * `undefined` for keyless overlays — they apply to the key the query
   * derived when the mutation was dispatched, recorded on the intent.
   */
  readonly keyOf: ((variables: unknown) => string) | undefined;
  readonly apply: (data: unknown, variables: unknown) => unknown;
}

/** What the registry holds for one query. */
export interface QueryRegistration {
  /** The key the query derives from this state, or `undefined` when it derives nothing. */
  readonly currentKey: (state: unknown) => string | undefined;
  /** Overlays by mutation name. Read live by the query's selectors. */
  readonly overlays: ReadonlyMap<string, readonly QueryOverlay[]>;
}

interface MutableRegistration {
  readonly currentKey: (state: unknown) => string | undefined;
  readonly overlays: Map<string, readonly QueryOverlay[]>;
}

const registry = new Map<string, MutableRegistration>();

/**
 * Register a query, replacing any previous registration of the same name.
 * Returns the registration; its `overlays` map reflects later
 * {@linkcode registerOverlays} calls.
 */
export const registerQuery = (
  name: string,
  currentKey: (state: unknown) => string | undefined,
): QueryRegistration => {
  const registration: MutableRegistration = { currentKey, overlays: new Map() };
  registry.set(name, registration);
  return registration;
};

const lookup = (name: string, purpose: string): MutableRegistration => {
  const registration = registry.get(name);
  if (registration === undefined) {
    throw new Error(
      `${purpose}: no query named "${name}" is registered. ` +
        "Define it with defineQuery before the mutation that targets it, " +
        "and pass the object defineQuery returned.",
    );
  }
  return registration;
};

/** Look up a registered query, or throw a prescriptive error. */
export const requireQuery = (name: string): QueryRegistration =>
  lookup(name, `Cannot target query "${name}"`);

/**
 * Register `mutation`'s overlays on `query` as a set, replacing any previous
 * set for the same mutation name.
 */
export const registerOverlays = (
  query: string,
  mutation: string,
  overlays: readonly QueryOverlay[],
): void => {
  const registration = lookup(query, `Cannot overlay query "${query}" from mutation "${mutation}"`);
  if (overlays.length === 0) {
    registration.overlays.delete(mutation);
  } else {
    registration.overlays.set(mutation, overlays);
  }
};
