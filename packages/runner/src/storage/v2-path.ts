import type { FabricValue } from "@commonfabric/api";
import { isKeyableObjectOrArray } from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";

export type ReadPathOptions = {
  allowArrayLength?: boolean;
};

export const isArrayIndexSegment = (segment: string): boolean =>
  isArrayIndexPropertyName(segment);

const hasOwnPathSegment = (
  value: Record<string, unknown> | unknown[],
  segment: string | number,
): boolean => Object.hasOwn(value, segment);

// Both descents below stop at a `FabricSpecialObject`, so a path into one
// reports absent / `undefined` -- the same answer `getAtPath` in `traverse.ts`
// gives for the same address, and the whole story for a leaf that no path
// addresses anything inside of. That includes a `FabricInstance`: these two are
// read helpers on the write path, and `normalizeAndDiff` reads the current
// value at every slot it is about to write, so a write anywhere below a stored
// instance reaches them.
//
// TODO(danfuzz): "absent" is an incomplete answer for an instance, whose codec
// contents are real and simply not addressable by a path segment yet. When
// that descent lands, the contents speak for themselves.
export const hasValueAtPath = (
  root: FabricValue | undefined,
  path: readonly string[],
  options: ReadPathOptions = {},
): boolean => {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (options.allowArrayLength === true && segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexSegment(segment)) {
        return false;
      }
      const index = Number(segment);
      if (!hasOwnPathSegment(current, index)) {
        return false;
      }
      current = current[index];
      continue;
    }
    if (!isKeyableObjectOrArray(current)) {
      return false;
    }
    if (!hasOwnPathSegment(current, segment)) {
      return false;
    }
    current = current[segment];
  }
  return true;
};

// As `hasValueAtPath` above, marker included: a path into a `FabricInstance`
// reads as `undefined` rather than reaching its codec contents.
export const readValueAtPath = (
  root: FabricValue | undefined,
  path: readonly string[],
  options: ReadPathOptions = {},
): FabricValue | undefined => {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (options.allowArrayLength === true && segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexSegment(segment)) {
        return undefined;
      }
      const index = Number(segment);
      if (!hasOwnPathSegment(current, index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isKeyableObjectOrArray(current)) {
      return undefined;
    }
    if (!hasOwnPathSegment(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current as FabricValue | undefined;
};
