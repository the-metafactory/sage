/**
 * Type-level assertion helpers for compile-time invariants in tests.
 *
 * Lives under `test/`. The filename has no `.test.` suffix so Bun's test
 * discovery (`*.test.ts` / `*_test.ts` / `*.spec.ts`) ignores it as an
 * entry point. The leading underscore is a human signal ("helper, not a
 * test") — not what makes the runner skip the file.
 *
 * Kept off the production source tree because nothing in `src/` consumes
 * these and `src/util/` should not become a dumping ground for
 * compile-time-only test infrastructure.
 *
 * Usage — inside a test body:
 *
 *   typeCheck<Equal<A, B>>();
 *
 * If `A` and `B` differ, the call fails to type-check. Runtime is
 * unaffected — these are pure type-system artifacts.
 */

export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * Runtime-zero helper that lifts an `Equal<…>` check into a callable shape.
 * `typeCheck<Equal<A, B>>()` reads as intentional ("this test exists to
 * pin a type-level invariant") and leaves no misleading runtime assertion
 * in the test body.
 */
// Intentionally empty body — the `T extends true` constraint is the entire
// assertion (see JSDoc above). The `T` type parameter is referenced only
// in its own constraint; that is intentional and is how the helper does
// its job. Type parameters are out of scope for
// `@typescript-eslint/no-unused-vars`, so no lint-disable is needed for
// that rule. The `no-empty-function` disable below covers the body —
// strict lint configs would otherwise flag the deliberately-empty body
// without surfacing why; the disable + the comment above keep intent
// visible if a future lint config tightens.
// eslint-disable-next-line @typescript-eslint/no-empty-function
export function typeCheck<T extends true>(): void {}
