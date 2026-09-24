import { isPlainObject } from "./types.ts";

/**
 * Returns a copy of `value` with `undefined`-valued properties removed,
 * recursively through plain-object values. Non-plain-object values
 * (primitives, arrays, class instances) are returned as-is; only own
 * enumerable string-keyed properties of plain objects are walked.
 *
 * Intended use is to canonicalize an object shape for stable comparison
 * (e.g. content-hashing), where a property that's present-but-`undefined`
 * should be treated the same as an omitted property. The `FabricValue` layer
 * preserves `undefined`-valued properties, so callers that need this
 * normalization must apply it directly.
 *
 * The result's members keep the member type `V`, which is accurate for any
 * `V` that still admits a plain object once some of its `undefined`-valued
 * properties are removed. `FabricValue` is one such type.
 */
export function stripUndefinedProps<V>(
  value: Readonly<Record<string, V>>,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    // Use `defineProperty` rather than `out[key] = ...` so that a special
    // key like `"__proto__"` is written as a plain own data property
    // rather than triggering the prototype setter on `out` (which would
    // pollute the prototype chain of the returned object).
    Object.defineProperty(out, key, {
      value: isPlainObject(val) ? stripUndefinedProps(val) : val,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}
