# effect-saga

Saga-pattern state management built on Effect-TS structured concurrency.

## Tech

- Deno runtime, TypeScript
- Functional TypeScript: pure functions tested, effects at edges, data over classes
- Commands: `deno task test` (all tests), `deno task check` (Biome lint/format)
- **Every code change must pass `deno task test` and `deno task check` before being considered complete.**
