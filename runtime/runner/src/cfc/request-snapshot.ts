import { cloneIfNecessary } from "@commonfabric/data-model";
import type { FabricValue } from "@commonfabric/api";

/**
 * Produces a detached, deep-frozen snapshot of a request `value`, for use as a
 * CFC write-policy input (which is also content-hashed downstream). The result
 * is a deep clone, so later mutation of the input does not leak into the
 * snapshot.
 *
 * The `value` is treated as a `FabricValue`: `cloneIfNecessary()` deep-clones
 * to a frozen result, preserving `FabricInstance` / `FabricPrimitive` class
 * identity (which a `structuredClone()` would silently strip). Cyclic values
 * are not yet supported (see `cloneIfNecessary`).
 */
export function createFrozenRequestSnapshot<T extends FabricValue>(
  value: T,
): T {
  // `cloneIfNecessary`'s frozen default is typed `Immutable<T>`; callers
  // consume the snapshot as a (read-only-in-practice) `T`.
  return cloneIfNecessary(value) as T;
}
