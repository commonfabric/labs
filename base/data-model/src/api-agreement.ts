/**
 * Compile-time agreement between the abstract base classes in `interface.ts`
 * and their pattern-visible declarations in `api.ts`, which is what a pattern
 * compiles against. No module imports this one: it exists to be type-checked,
 * which `deno check` does for every module under the package whether or not
 * something imports it, and everything here erases at compile time. The
 * concrete classes under `fabric-primitives/` and `fabric-instances/` carry
 * the same kind of guard, each beside its own definition.
 *
 * Mutual assignability, not `satisfies`. A one-way check passes when the class
 * carries a member the declaration omits, since the extra member only makes
 * the class more assignable; that is the direction a pattern feels, because
 * the member it cannot reach is the one missing from the declaration. Both
 * directions have to be asserted for a member added on either side alone to
 * fail here. Each class is checked on its instance side and on its
 * constructor side, so a static member or a construct signature that one side
 * gains alone fails here as well.
 */

import type { MustBeTrue, Same } from "@commonfabric/utils/types";

import type {
  FabricInstance as ApiFabricInstance,
  FabricPrimitive as ApiFabricPrimitive,
} from "./api.ts";
import type { FabricInstance, FabricPrimitive } from "./interface.ts";

/** Whether `FabricInstance` agrees with its declaration. */
export type InstanceAgrees = MustBeTrue<
  Same<FabricInstance, ApiFabricInstance>
>;

/** Whether `FabricPrimitive` agrees with its declaration. */
export type PrimitiveAgrees = MustBeTrue<
  Same<FabricPrimitive, ApiFabricPrimitive>
>;

/** Whether the `FabricInstance` constructor agrees with its declaration. */
export type InstanceConstructorAgrees = MustBeTrue<
  Same<typeof FabricInstance, typeof ApiFabricInstance>
>;

/** Whether the `FabricPrimitive` constructor agrees with its declaration. */
export type PrimitiveConstructorAgrees = MustBeTrue<
  Same<typeof FabricPrimitive, typeof ApiFabricPrimitive>
>;
