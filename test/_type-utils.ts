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
 * Usage:
 *
 *   // As a type assertion at the call site:
 *   type _Check = Expect<Equal<A, B>>;
 *
 *   // As a runtime-zero helper invoked inside a test body (preferred —
 *   // no misleading `expect(true).toBe(true)` sentinel needed):
 *   typeCheck<Equal<A, B>>();
 *
 * If `A` and `B` are not equal, the call (or the `_Check` line) fails to
 * type-check. Runtime is unaffected — these are pure type-system
 * artifacts.
 */

export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

export type Expect<T extends true> = T;

/**
 * Runtime-zero helper that lifts an `Equal<…>` check into a callable shape.
 * `typeCheck<Equal<A, B>>()` reads as intentional ("this test exists to
 * pin a type-level invariant") and leaves no misleading runtime assertion
 * in the test body.
 */
// Intentionally empty body — the `T extends true` constraint is the entire
// assertion (see JSDoc above). Do NOT rename `T` to `_T`: the underscore
// would imply "unused", but the constraint is load-bearing.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function typeCheck<T extends true>(): void {}
