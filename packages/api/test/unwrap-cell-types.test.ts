import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type {
  AnyBrandedCell,
  Cell,
  OpaqueCell,
  UnwrapCell,
} from "@commonfabric/api";

/** `true` where `T` is `any`, and `false` for every other type. */
type IsAny<T> = 0 extends (1 & T) ? true : false;

/** `true` where `A` and `B` are the same type, and `false` otherwise. */
type Same<A, B> = (<X>() => X extends A ? 1 : 2) extends
  (<X>() => X extends B ? 1 : 2) ? true : false;

describe("UnwrapCell", () => {
  it("resolves at compile time to the value beneath any depth of cells", () => {
    // Each annotation is a check `deno task check` makes: a type resolving
    // otherwise makes its line an error. The last one is `false`, which a
    // `Same` unable to tell two types apart could not be assigned.

    // deno-lint-ignore no-explicit-any
    const ofAny: IsAny<UnwrapCell<any>> = true;
    // deno-lint-ignore no-explicit-any
    const ofCellOfAny: IsAny<UnwrapCell<Cell<any>>> = true;
    const ofUnknown: Same<UnwrapCell<unknown>, unknown> = true;
    const ofNever: Same<UnwrapCell<never>, never> = true;
    const ofPlain: Same<UnwrapCell<{ id: string }>, { id: string }> = true;
    const ofCell: Same<UnwrapCell<Cell<{ id: string }>>, { id: string }> = true;
    const ofNested: Same<UnwrapCell<OpaqueCell<Cell<number>>>, number> = true;
    const ofBranded: Same<
      UnwrapCell<AnyBrandedCell<AnyBrandedCell<string>>>,
      string
    > = true;
    const ofUnion: Same<UnwrapCell<Cell<string> | number>, string | number> =
      true;
    const ofMember: Same<
      UnwrapCell<Cell<{ count: Cell<number> }>>,
      { count: Cell<number> }
    > = true;
    const ofAnother: Same<UnwrapCell<Cell<string>>, number> = false;

    expect([
      ofAny,
      ofCellOfAny,
      ofUnknown,
      ofNever,
      ofPlain,
      ofCell,
      ofNested,
      ofBranded,
      ofUnion,
      ofMember,
      ofAnother,
    ]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});
