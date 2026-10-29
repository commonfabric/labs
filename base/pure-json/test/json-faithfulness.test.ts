/**
 * The corpus that holds `findJsonUnfaithfulValues` to a whitelist rather than
 * a hunt for bad numbers.
 *
 * Most of these cases carry no offending numeric leaf at all and are still not
 * carried faithfully by `JSON.stringify`: a dropped `undefined`, an array
 * hole, a symbol-keyed or non-index property, a `toJSON` hook, a class
 * instance whose data lives in private fields, a cycle (which throws rather
 * than altering anything). A blacklist passes every one of them, so they are
 * what distinguishes the two designs and why they are here.
 *
 * Several pin a boundary in the other direction, where reporting would be
 * wrong: an array's own `length`, a non-enumerable index, and a shared (but
 * acyclic) reference are all faithful. Pointers are checked for nesting and
 * for `~` and `/` escaping, since an unactionable pointer makes a correct
 * report useless. `isPureJson` delegates to `findJsonUnfaithfulValues`, so the
 * two cannot disagree by construction; two of the cases here pin its boolean
 * surface directly, and the third spot-checks the delegation.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { findJsonUnfaithfulValues, isPureJson } from "@commonfabric/pure-json";

describe("json-faithfulness", () => {
  describe("findJsonUnfaithfulValues()", () => {
    it("returns an empty list for JSON-faithful shapes", () => {
      // The whitelist: null, booleans, strings, finite numbers other than -0,
      // dense arrays of accepted values, plain objects of accepted values.

      const schema = {
        type: "object",
        properties: {
          n: { type: "number", default: -1, minimum: 0, maximum: 100 },
          z: { type: "number", default: 0 },
          s: { type: "string", default: "x" },
          flag: { type: "boolean", default: false },
          nothing: { type: "null", default: null },
          tags: {
            type: "array",
            default: ["a", "b"],
            items: { type: "string" },
          },
          nested: { type: "object", default: { deep: [1, 2, { k: "v" }] } },
        },
        required: ["n"],
      };
      expect(findJsonUnfaithfulValues(schema)).toEqual([]);
    });

    it("returns an empty list for a bare boolean", () => {
      expect(findJsonUnfaithfulValues(true)).toEqual([]);
      expect(findJsonUnfaithfulValues(false)).toEqual([]);
    });

    it("reports each non-finite and signed zero", () => {
      for (const value of [NaN, Infinity, -Infinity, -0]) {
        const found = findJsonUnfaithfulValues({
          type: "number",
          default: value,
        });
        expect(found).toHaveLength(1);
        expect(found[0]!.pointer).toBe("/default");
      }
    });

    it("reports a `bigint`", () => {
      // JSON.stringify throws on a bigint; caught here so the failure names the
      // value rather than surfacing as an opaque serialization error.

      const found = findJsonUnfaithfulValues({ default: 42n });
      expect(found).toEqual([{
        pointer: "/default",
        reason: "`bigint` value `42n` (not representable)",
      }]);
    });

    it("reports `undefined` -- dropped, not a bad number", () => {
      // A blacklist of bad numbers would miss this: `{ default: undefined }`
      // serializes to `{}`, silently losing the default.

      const found = findJsonUnfaithfulValues({ default: undefined });
      expect(found).toHaveLength(1);
      expect(found[0]!.pointer).toBe("/default");
    });

    it("reports `undefined` inside an array (becomes `null`)", () => {
      const found = findJsonUnfaithfulValues({ default: [1, undefined, 3] });
      expect(found).toHaveLength(1);
      expect(found[0]!.pointer).toBe("/default/1");
    });

    it("reports a sparse array hole (becomes `null`)", () => {
      // A hole is exactly what is under test.
      // deno-lint-ignore no-sparse-arrays
      const holed = [1, , 3];
      const found = findJsonUnfaithfulValues({ default: holed });
      expect(found).toHaveLength(1);
      expect(found[0]!.pointer).toBe("/default/1");
      expect(found[0]!.reason).toContain("hole");
    });

    it("reports `symbol` and `function` values", () => {
      expect(findJsonUnfaithfulValues({ a: Symbol("s") })).toHaveLength(1);
      expect(findJsonUnfaithfulValues({ a: () => 1 })).toHaveLength(1);
    });

    it("reports a symbol-keyed property", () => {
      const found = findJsonUnfaithfulValues({ [Symbol("s")]: 1, ok: 2 });
      expect(found).toHaveLength(1);
      expect(found[0]!.reason).toContain("symbol-keyed");
    });

    it("reports a non-index property on an array", () => {
      // `JSON.stringify` serializes an array's indices only; an extra own
      // property is dropped. The indices themselves stay faithful.

      const withExtra = Object.assign([1, 2], { foo: 3 });
      const found = findJsonUnfaithfulValues({ default: withExtra });
      expect(found).toHaveLength(1);
      expect(found[0]!.pointer).toBe("/default/foo");
      expect(found[0]!.reason).toContain("non-index");
    });

    it("reports a _non-enumerable_ non-index property on an array", () => {
      // `JSON.stringify` drops it just the same, so an enumerable-only walk
      // would certify a value that JSON demonstrably mangles.

      const withHidden: unknown[] = [1, 2];
      Object.defineProperty(withHidden, "foo", { value: 3, enumerable: false });

      const found = findJsonUnfaithfulValues({ default: withHidden });

      expect(found).toHaveLength(1);
      expect(found[0]!.pointer).toBe("/default/foo");
      expect(found[0]!.reason).toContain("non-index");
    });

    it("does not report an array's own `length` as a dropped property", () => {
      // `length` is a non-index own name on every array, so walking own
      // property names rather than enumerable keys must not start flagging it.

      expect(findJsonUnfaithfulValues({ default: [1, 2, 3] })).toHaveLength(0);
    });

    it("keeps reporting a non-enumerable index as faithful", () => {
      // Such an index is a real element -- `JSON.stringify` emits it -- so
      // it is not an offender even though it is invisible to an
      // enumerable-only walk.

      const arr: unknown[] = [1, 2, 3];
      Object.defineProperty(arr, "0", { value: 9, enumerable: false });

      expect(JSON.stringify(arr)).toBe("[9,2,3]");
      expect(findJsonUnfaithfulValues({ default: arr })).toHaveLength(0);
    });

    it("reports a `toJSON()` hook, even non-enumerable", () => {
      // `toJSON` replaces the value before JSON sees its contents, so the walk
      // cannot certify what would be sent.

      expect(findJsonUnfaithfulValues({ a: 1, toJSON: () => 5 })).toHaveLength(
        1,
      );

      const hidden: Record<string, unknown> = { a: 1 };
      Object.defineProperty(hidden, "toJSON", {
        value: () => 5,
        enumerable: false,
      });
      const found = findJsonUnfaithfulValues({ default: hidden });
      expect(found).toHaveLength(1);
      expect(found[0]!.pointer).toBe("/default");
      expect(found[0]!.reason).toContain("toJSON");
    });

    it("reports a non-plain object (a class instance)", () => {
      // A class instance keeps its data in private fields, so `JSON.stringify`
      // finds nothing to emit. Any class instance is rejected.

      class Holder {
        #data = 5;
        get() {
          return this.#data;
        }
      }
      const found = findJsonUnfaithfulValues({ default: new Holder() });
      expect(found).toHaveLength(1);
      expect(found[0]!.reason).toContain("non-plain object");
    });

    it("reports a cycle, but not a shared reference", () => {
      // A shared subtree at sibling positions is fine -- JSON.stringify
      // duplicates it. Only an actual cycle throws, so only that is reported.

      const shared = { k: 1 };
      expect(findJsonUnfaithfulValues({ a: shared, b: shared })).toEqual([]);

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const found = findJsonUnfaithfulValues(cyclic);
      expect(found).toHaveLength(1);
      expect(found[0]!.reason).toContain("circular");
    });

    it("reaches nested values with correct pointers", () => {
      const found = findJsonUnfaithfulValues({
        properties: { cfg: { default: { ratio: NaN, offsets: [1, -0, 3] } } },
      });
      expect(found.map((p) => p.pointer).sort()).toEqual([
        "/properties/cfg/default/offsets/1",
        "/properties/cfg/default/ratio",
      ]);
    });

    it("escapes `~` and `/` in pointer tokens", () => {
      // RFC 6901: `~` -> `~0`, `/` -> `~1`. A property named `a/b` must not
      // read as two path steps.

      const found = findJsonUnfaithfulValues({ "a/b~c": NaN });
      expect(found[0]!.pointer).toBe("/a~1b~0c");
    });
  });

  describe("isPureJson()", () => {
    it("returns `true` for what JSON carries faithfully", () => {
      expect(isPureJson(null)).toBe(true);
      expect(isPureJson("text")).toBe(true);
      expect(isPureJson(1)).toBe(true);
      expect(isPureJson(true)).toBe(true);
      expect(isPureJson({ a: [1, "two", { b: null }] })).toBe(true);
    });

    it("returns `false` for what JSON would alter or drop", () => {
      expect(isPureJson(undefined)).toBe(false);
      expect(isPureJson(Number.NaN)).toBe(false);
      expect(isPureJson(-0)).toBe(false);
      expect(isPureJson(1n)).toBe(false);
      expect(isPureJson(Symbol.for("s"))).toBe(false);
      expect(isPureJson(() => 1)).toBe(false);
      expect(isPureJson(new Date())).toBe(false);
      expect(isPureJson({ nested: { bad: Number.POSITIVE_INFINITY } })).toBe(
        false,
      );
    });

    it("agrees with `findJsonUnfaithfulValues()`", () => {
      for (const value of [null, 1, "s", { a: 1 }, [1, 2], new Map(), 1n]) {
        expect(isPureJson(value)).toBe(
          findJsonUnfaithfulValues(value).length === 0,
        );
      }
    });
  });
});
