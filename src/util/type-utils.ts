/**
 * Type-level assertion helpers for compile-time invariants in tests.
 *
 * Usage:
 *   type _Check = Expect<Equal<A, B>>;
 *
 * If `A` and `B` are not equal, the line fails to type-check. Runtime is
 * unaffected — these are pure type-system artifacts.
 */

export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

export type Expect<T extends true> = T;
