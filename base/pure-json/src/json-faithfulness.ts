/**
 * Reports every part of a runtime value that ordinary JSON serialization
 * (`JSON.stringify`) would silently alter, drop, or fail to represent -- so a
 * caller that must hand a value across a JSON boundary can refuse or repair it
 * before the loss happens, rather than discovering a mangled value downstream.
 *
 * This is a positive whitelist, not a search for known-bad leaves. Only the
 * shapes JSON round-trips by identity are accepted -- `null`, booleans,
 * strings, finite numbers other than `-0`, dense arrays of accepted values,
 * and plain objects whose values are accepted. Everything else is reported:
 * `undefined` (dropped from an object, `null` in an array), `NaN` and
 * `±Infinity` (both become `null`), `-0` (loses its sign), `bigint` /
 * `symbol` / `function` (not representable), array holes (`null`), a
 * non-index property on an array (dropped), symbol-keyed properties
 * (dropped), a `toJSON` hook (replaces the value before JSON sees it),
 * non-plain objects such as a class instance (flattened -- `JSON.stringify`
 * finds no data in its private fields), and cycles (`JSON.stringify` throws).
 *
 * A blacklist that only hunted bad numbers would pass every one of those: they
 * leave no offending numeric leaf, yet JSON still alters them. Whitelisting is
 * the only framing that makes an empty result actually mean "JSON serialization
 * will not change this."
 *
 * Known limitations. The walk reads enumerable own keys (`Object.keys` /
 * `Object.entries`) and an own `toJSON` data property, which certifies the
 * ordinary values it is meant for. It does _not_ fully certify
 * adversarially-shaped objects, so for these the empty result is not a
 * guarantee (all confirmed to pass here while `JSON.stringify` alters them):
 *
 *   - A non-enumerable string data property on a _plain object_ is dropped by
 *     JSON but not seen here (that walk is enumerable-only). An array's
 *     properties are read with `Object.getOwnPropertyNames`, so the same
 *     property on an array _is_ reported.
 *   - An accessor-based `toJSON` (a getter) is missed: the own-descriptor check
 *     matches a data property whose value is a function, not an accessor -- and
 *     a plain read could fire the getter, which the check avoids on purpose.
 *   - An inherited `toJSON` (e.g. on a custom array prototype) is missed: the
 *     check looks at own descriptors only.
 *   - The array-hole test uses `i in obj`, which consults the prototype, so an
 *     inherited numeric property masks a hole; this also does not match JSON's
 *     own-vs-inherited element read.
 *
 * TODO(danfuzz): Close those four gaps, by inspecting own property
 * descriptors for plain objects instead of using `Object.entries`, rejecting
 * accessors and non-enumerable data properties, using `Object.hasOwn` for
 * array slots, and rejecting a nonstandard array prototype or an inherited
 * `toJSON`. Required once a caller has to certify a value it did not
 * construct.
 */

import type { JSONValue } from "@commonfabric/api";

import { isPlainObject } from "@commonfabric/utils/types";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";

/** A value ordinary JSON serialization would not carry faithfully. */
export interface JsonUnfaithfulValue {
  /** RFC 6901 JSON Pointer to the value; `""` is the whole input. */
  readonly pointer: string;

  /** Why JSON would not carry it, e.g. `` `NaN` (becomes `null`) ``. */
  readonly reason: string;
}

/**
 * Helper for `walk()`, which appends one token to the JSON Pointer `base`,
 * escaping `~` and `/` per RFC 6901.
 */
function pointerChild(base: string, token: string | number): string {
  const escaped = String(token).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${base}/${escaped}`;
}

/**
 * Helper for `walk()`, which returns the reason JSON would not carry `value`
 * faithfully, or `null` if it would.
 */
function numberReason(value: number): string | null {
  if (Number.isNaN(value)) return "`NaN` (becomes `null`)";
  if (value === Infinity) return "`Infinity` (becomes `null`)";
  if (value === -Infinity) return "`-Infinity` (becomes `null`)";
  if (Object.is(value, -0)) return "`-0` (loses its sign)";
  return null;
}

/**
 * Helper for `findJsonUnfaithfulValues()`, which walks `value` -- found at
 * `pointer`, with `ancestors` holding the objects on the path down to it --
 * appending to `out` a report for each part JSON would not carry faithfully.
 */
function walk(
  value: unknown,
  pointer: string,
  ancestors: Set<object>,
  out: JsonUnfaithfulValue[],
): void {
  if (value === null) return;

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number": {
      const reason = numberReason(value);
      if (reason !== null) out.push({ pointer, reason });
      return;
    }
    case "bigint":
      out.push({
        pointer,
        reason: `\`bigint\` value \`${value}n\` (not representable)`,
      });
      return;
    case "undefined":
      out.push({
        pointer,
        reason: "`undefined` (dropped from an object, `null` in an array)",
      });
      return;
    case "symbol":
      out.push({ pointer, reason: "`symbol` (not representable)" });
      return;
    case "function":
      out.push({ pointer, reason: "`function` (not representable)" });
      return;
  }

  // A non-null object. Track ancestors (not all visited nodes), so a shared
  // reference at sibling positions -- which `JSON.stringify` duplicates rather
  // than rejects -- is fine; only an actual cycle is reported.
  const obj = value as object;
  if (ancestors.has(obj)) {
    out.push({
      pointer,
      reason: "circular reference (`JSON.stringify()` throws)",
    });
    return;
  }
  ancestors.add(obj);
  try {
    // A `toJSON` hook (own, even non-enumerable) replaces this value before
    // JSON sees its contents, so what a consumer receives is whatever it
    // returns -- not the value walked here. Refuse: this check cannot certify
    // something it does not get to look at.
    const toJson = Object.getOwnPropertyDescriptor(obj, "toJSON");
    if (toJson !== undefined && typeof toJson.value === "function") {
      out.push({
        pointer,
        reason:
          "`toJSON()` method (`JSON.stringify()` would replace this value)",
      });
      return;
    }

    // Symbol-keyed properties carry data JSON silently drops, on an array or a
    // plain object alike.
    if (Object.getOwnPropertySymbols(obj).length > 0) {
      out.push({ pointer, reason: "symbol-keyed properties (dropped)" });
    }

    if (Array.isArray(obj)) {
      // JSON serializes an array's indices only; any other own property is
      // dropped, whether or not it is enumerable -- hence own property *names*
      // rather than `Object.keys`. `length` is the one non-index name every
      // array carries, and JSON encodes it structurally rather than dropping
      // it, so it is not an offender.
      //
      // A hole is a separate matter, reported by the element loop below: JSON
      // cannot carry one, while a `FabricValue` can. The two checks disagree
      // there on purpose.
      for (const key of Object.getOwnPropertyNames(obj)) {
        if ((key !== "length") && !isArrayIndexPropertyName(key)) {
          out.push({
            pointer: pointerChild(pointer, key),
            reason: "non-index array property (dropped)",
          });
        }
      }
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) {
          out.push({
            pointer: pointerChild(pointer, i),
            reason: "array hole (becomes `null`)",
          });
          continue;
        }
        walk(obj[i], pointerChild(pointer, i), ancestors, out);
      }
      return;
    }

    if (!isPlainObject(obj)) {
      const name = obj.constructor?.name ?? "object";
      out.push({
        pointer,
        reason:
          `non-plain object (\`${name}\`; \`JSON.stringify()\` sees no own data)`,
      });
      return;
    }

    for (const [key, child] of Object.entries(obj)) {
      walk(child, pointerChild(pointer, key), ancestors, out);
    }
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * Finds every value in `value` that ordinary JSON serialization would not carry
 * faithfully -- see the module comment for the whitelist. Returns them with
 * their JSON Pointers; an empty array means the value round-trips through JSON
 * by identity and is safe to send.
 */
export function findJsonUnfaithfulValues(
  value: unknown,
): JsonUnfaithfulValue[] {
  const out: JsonUnfaithfulValue[] = [];
  walk(value, "", new Set<object>(), out);
  return out;
}

/**
 * Indicates whether `value` is pure JSON -- that ordinary JSON serialization
 * carries it faithfully, by the whitelist in the module comment above. This is
 * the boolean form of {@link findJsonUnfaithfulValues}; reach for that one when
 * a caller needs to report _which_ parts are unfaithful and where.
 *
 * Note the known limitations documented above: an empty result does not certify
 * adversarially-shaped objects, so this answers "will JSON change this ordinary
 * value", not "is this hostile input safe".
 */
export function isPureJson(value: unknown): value is JSONValue {
  return findJsonUnfaithfulValues(value).length === 0;
}
