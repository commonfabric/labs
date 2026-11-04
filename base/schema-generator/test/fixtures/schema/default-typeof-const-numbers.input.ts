/**
 * Tests `Default<T, typeof CONST>` where the constant's initializer holds
 * numbers that are not bare literals: sign-prefixed ones, and the non-finite
 * globals.
 *
 * A literal-type payload is handed over by the checker, but an object or array
 * payload is not -- those values are read off the constant's initializer in the
 * AST. That reader has to recognize a number in every spelling it has, or the
 * value silently does not arrive.
 *
 * Note what this fixture depends on: the golden has to be able to hold `-0`,
 * `NaN` and the infinities to pin any of it.
 */

import { Default } from "commonfabric";

const SENTINELS = { selected: -1, ratio: -0.5, negZero: -0 };
const NON_FINITE = { nan: NaN, inf: Infinity, negInf: -Infinity };
const OFFSETS = [-1, 2, -3];

interface SchemaRoot {
  // Object payload, sign-prefixed values (`-1` is the canonical sentinel).
  sentinels: Default<
    { selected: number; ratio: number; negZero: number },
    typeof SENTINELS
  >;

  // Object payload, values with no literal form at all.
  nonFinite: Default<
    { nan: number; inf: number; negInf: number },
    typeof NON_FINITE
  >;

  // Array payload: every element has to be readable, or the whole default is
  // withheld rather than shipped with a hole; position is pinned here.
  offsets: Default<number[], typeof OFFSETS>;
}
