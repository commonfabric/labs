import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue, PrimitiveValueTag } from "@";
import { FabricError, FabricLink, FabricMap } from "@/fabric-instances";
import { FabricBytes } from "@/fabric-primitives";
import {
  DO_RECURSE_KEYS,
  DO_RECURSE_KEYS_VALUES,
  DO_RECURSE_VALUES,
  type ValueVisitor,
} from "@/value-visit";
import { VisitInProgress } from "@/value-visit/VisitInProgress.ts";

import { DO_DISPATCH, mainResult, Recorder, replace } from "./Recorder.ts";

/** Runs a fresh visit of `value` with `vis`. */
function visit(value: unknown, vis: ValueVisitor<unknown, unknown>): unknown {
  return new VisitInProgress(vis).visit(value);
}

describe("VisitInProgress", () => {
  describe("instance members", () => {
    describe("visit()", () => {
      describe("dispatch", () => {
        it("visits a nested value depth-first, reporting each element and mapping after its value", () => {
          const rec = new Recorder();
          const inner = { b: null };
          const array = [1, inner];
          const root = { a: array };

          expect(visit(root, rec)).toBeUndefined();
          expect(rec.events).toEqual([
            ["value", root, "Object"],
            ["object", root],
            ["value", array, "Array"],
            ["array", array],
            ["value", 1, "number"],
            ["primitive", 1, "number"],
            ["visitedElement", array, 0, 1],
            ["value", inner, "Object"],
            ["object", inner],
            ["value", null, "null"],
            ["primitive", null, "null"],
            ["visitedFabricPlainObjectEntry", inner, "b", null],
            ["visitedElement", array, 1, inner],
            ["visitedFabricPlainObjectEntry", root, "a", array],
          ]);
        });

        const primitiveCases: [string, unknown, PrimitiveValueTag][] = [
          ["a bigint", 123n, "bigint"],
          ["a boolean", true, "boolean"],
          ["`null`", null, "null"],
          ["a number", 5, "number"],
          ["a string", "x", "string"],
          ["a registry symbol", Symbol.for("value-visit"), "symbol"],
          ["`undefined`", undefined, "undefined"],
          [
            "a `FabricBytes`",
            new FabricBytes(new Uint8Array([1])),
            "FabricBytes",
          ],
        ];

        for (const [label, value, tag] of primitiveCases) {
          it(`passes ${label} to \`visitValue()\` with the tag \`${tag}\``, () => {
            const rec = new Recorder();

            visit(value, rec);
            expect(rec.events).toEqual([
              ["value", value, tag],
              ["primitive", value, tag],
            ]);
          });
        }

        it("returns the value of a `mainResult` from `visitValue()`, visiting nothing beneath the value", () => {
          const rec = new Recorder();
          rec.onValue = () => mainResult("done");

          expect(visit([1], rec)).toBe("done");
          expect(rec.names).toEqual(["value"]);
        });
      });

      describe("`replace` results", () => {
        it("dispatches on the replacement rather than the original", () => {
          const rec = new Recorder();
          rec.onValue = (v) => (v === "x") ? replace(42) : DO_DISPATCH;

          visit("x", rec);
          expect(rec.events).toEqual([
            ["value", "x", "string"],
            ["value", 42, "number"],
            ["primitive", 42, "number"],
          ]);
        });

        it("follows a chain of replacements", () => {
          const rec = new Recorder();
          rec.onValue = (v) => {
            if (v === "x") return replace("y");
            if (v === "y") return replace(3);
            return DO_DISPATCH;
          };

          visit("x", rec);
          expect(rec.events).toEqual([
            ["value", "x", "string"],
            ["value", "y", "string"],
            ["value", 3, "number"],
            ["primitive", 3, "number"],
          ]);
        });

        it("dispatches on a replacement made by a subtype visitor", () => {
          const rec = new Recorder();
          rec.onPrimitive = (v) => (v === 1) ? replace(2) : undefined;

          visit(1, rec);
          expect(rec.events).toEqual([
            ["value", 1, "number"],
            ["primitive", 1, "number"],
            ["value", 2, "number"],
            ["primitive", 2, "number"],
          ]);
        });

        it("passes the replacement's own tag when a subtype visitor replaces a primitive with a container", () => {
          const rec = new Recorder();
          const replacement: unknown[] = [];
          rec.onPrimitive = (v) => (v === 1) ? replace(replacement) : undefined;

          visit(1, rec);
          expect(rec.events).toEqual([
            ["value", 1, "number"],
            ["primitive", 1, "number"],
            ["value", replacement, "Array"],
            ["array", replacement],
          ]);
        });

        it("passes the replacement's own tag when `visitValue()` replaces a container with a primitive", () => {
          const rec = new Recorder();
          const array = [1];
          rec.onValue = (v) => (v === array) ? replace("x") : DO_DISPATCH;

          visit(array, rec);
          expect(rec.events).toEqual([
            ["value", array, "Array"],
            ["value", "x", "string"],
            ["primitive", "x", "string"],
          ]);
        });

        it("routes a non-fabric replacement under a valid root to `visitPlusType()`", () => {
          const rec = new Recorder();
          const date = new Date(0);
          rec.onValue = (v) => (v === "x") ? replace(date) : DO_DISPATCH;

          visit(["x"], rec);
          expect(rec.events.filter((e) => e[0] === "plusType")).toEqual([
            ["plusType", date],
          ]);
        });

        it("reports the original element, not its replacement, to `visitedFabricArrayElement()`", () => {
          const rec = new Recorder();
          rec.onValue = (v) => (v === "x") ? replace(42) : DO_DISPATCH;
          const array = ["x"];

          visit(array, rec);
          expect(rec.events.filter((e) => e[0] === "visitedElement")).toEqual([
            ["visitedElement", array, 0, "x"],
          ]);
        });

        it("puts a replacement plain object on the cycle stack", () => {
          const replacement: Record<string, unknown> = {};
          replacement.self = replacement;

          const rec = new Recorder();
          rec.onValue = (v) => (v === "x") ? replace(replacement) : DO_DISPATCH;

          visit(["x"], rec);
          expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
            ["cycle", replacement, "Object", 1, 2],
          ]);
        });

        for (const path of ["directly", "via subtype dispatch"] as const) {
          it(`puts a replacement array on the cycle stack when the \`recurse\` form is produced ${path}`, () => {
            const replacement: unknown[] = [];
            replacement.push(replacement);

            const rec = new Recorder();
            rec.onValue = (v) => {
              if (v === "x") return replace(replacement);
              if (v === replacement && path === "directly") {
                return DO_RECURSE_VALUES;
              }
              return DO_DISPATCH;
            };

            visit(["x"], rec);
            expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
              ["cycle", replacement, "Array", 1, 2],
            ]);
          });
        }
      });

      describe("cycles", () => {
        it("calls `visitCycle()` with the depth the value was pushed at and the current depth", () => {
          const a: Record<string, unknown> = {};
          a.b = { c: a };

          const rec = new Recorder();

          visit(a, rec);
          expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
            ["cycle", a, "Object", 0, 2],
          ]);
        });

        it("does not call `visitCycle()` for shared substructure that is not a cycle", () => {
          const shared = { s: 1 };
          const rec = new Recorder();

          visit([shared, shared], rec);
          expect(rec.names).not.toContain("cycle");
          expect(rec.events.filter((e) => e[0] === "object")).toEqual([
            ["object", shared],
            ["object", shared],
          ]);
        });

        it("honors a `mainResult` from `visitCycle()`", () => {
          const a: Record<string, unknown> = {};
          a.self = a;

          const rec = new Recorder();
          rec.onCycle = () => mainResult("cycle!");

          expect(visit(a, rec)).toBe("cycle!");
        });

        it("honors a `recurse` from `visitCycle()`, re-entering the value at the next depth", () => {
          const a: Record<string, unknown> = {};
          a.self = a;

          const rec = new Recorder();
          rec.onCycle = (_v, _tag, _orig, depth) =>
            (depth < 3) ? DO_RECURSE_VALUES : undefined;

          visit(a, rec);
          expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
            ["cycle", a, "Object", 0, 1],
            ["cycle", a, "Object", 0, 2],
            ["cycle", a, "Object", 0, 3],
          ]);
        });
      });

      describe("`mainResult` results", () => {
        it("ends the visit from `visitedFabricArrayElement()`, skipping later elements", () => {
          const rec = new Recorder();
          rec.onVisitedElement = (i) =>
            (i === 1) ? mainResult("at 1") : undefined;
          const array = [10, 20, 30];

          expect(visit(array, rec)).toBe("at 1");
          expect(rec.events.filter((e) => e[0] === "visitedElement")).toEqual([
            ["visitedElement", array, 0, 10],
            ["visitedElement", array, 1, 20],
          ]);
          expect(rec.events.map((e) => e[1])).not.toContain(30);
        });

        it("ends the visit from `visitedFabricPlainObjectEntry()`, skipping later mappings", () => {
          const rec = new Recorder();
          rec.onVisitedMapping = () => mainResult("first");
          const object = { a: 1, b: 2 };

          expect(visit(object, rec)).toBe("first");
          expect(
            rec.events.filter((e) => e[0] === "visitedFabricPlainObjectEntry"),
          )
            .toEqual([
              ["visitedFabricPlainObjectEntry", object, "a", 1],
            ]);
          expect(rec.events.map((e) => e[1])).not.toContain(2);
        });

        it("ends the visit from a key's recursion, before the value is visited", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
          rec.onPrimitive = (v) => (v === "a") ? mainResult("key") : undefined;

          expect(visit({ a: 1 }, rec)).toBe("key");
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "a", "string"],
          ]);
          expect(rec.names).not.toContain("visitedFabricPlainObjectEntry");
        });

        it("ends the visit from `visitedFabricArrayGap()`, for a gap before an element", () => {
          const rec = new Recorder();
          rec.onVisitedGap = () => mainResult("gap");

          // deno-lint-ignore no-sparse-arrays
          expect(visit([, 1], rec)).toBe("gap");
          expect(rec.names).not.toContain("visitedElement");
        });

        it("ends the visit from `visitedFabricArrayGap()`, for a gap at the end", () => {
          const rec = new Recorder();
          rec.onVisitedGap = () => mainResult("gap");

          // deno-lint-ignore no-sparse-arrays
          expect(visit([[1, ,], 2], rec)).toBe("gap");
          expect(rec.events.map((e) => e[1])).not.toContain(2);
        });

        it("ends the visit from deep inside a nested value", () => {
          const rec = new Recorder();
          rec.onPrimitive = (v) =>
            (v === "stop") ? mainResult("deep") : undefined;

          expect(visit({ p: [1, "stop", 3], q: 4 }, rec)).toBe("deep");
          expect(rec.events.map((e) => e[1])).not.toContain(3);
          expect(rec.events.map((e) => e[1])).not.toContain(4);
        });
      });

      describe("`recurse` results", () => {
        it("visits both keys and values of a plain object for `DO_RECURSE_KEYS_VALUES`, each key before its value", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;

          visit({ a: 1, b: 2 }, rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "a", "string"],
            ["primitive", 1, "number"],
            ["primitive", "b", "string"],
            ["primitive", 2, "number"],
          ]);
        });

        it("visits only the keys of a plain object for `DO_RECURSE_KEYS`", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_KEYS;

          visit({ a: 1 }, rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "a", "string"],
          ]);
        });

        it("visits only the values of a plain object for `DO_RECURSE_VALUES`", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_VALUES;

          visit({ a: 1 }, rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
          ]);
        });

        it("visits the elements of an array for `DO_RECURSE_VALUES`", () => {
          const rec = new Recorder();
          rec.onArray = () => DO_RECURSE_VALUES;

          visit([1, 2], rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
            ["primitive", 2, "number"],
          ]);
        });

        it("visits the elements of an array for `DO_RECURSE_KEYS_VALUES`, there being no keys", () => {
          const rec = new Recorder();
          rec.onArray = () => DO_RECURSE_KEYS_VALUES;

          visit([1], rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
          ]);
        });

        it("reports each mapping to `visitedFabricPlainObjectEntry()` whichever of keys or values is recursed", () => {
          for (const form of [DO_RECURSE_KEYS, DO_RECURSE_VALUES]) {
            const rec = new Recorder();
            rec.onPlainObject = () => form;
            const object = { a: 1 };

            visit(object, rec);
            expect(
              rec.events.filter((e) =>
                e[0] === "visitedFabricPlainObjectEntry"
              ),
            )
              .toEqual([
                ["visitedFabricPlainObjectEntry", object, "a", 1],
              ]);
          }
        });

        it("iterates nothing for `DO_RECURSE_KEYS` on an array", () => {
          const rec = new Recorder();
          rec.onArray = () => DO_RECURSE_KEYS;

          visit([1, 2], rec);
          expect(rec.names).not.toContain("primitive");
          expect(rec.names).not.toContain("visitedElement");
        });

        it("iterates nothing for a `recurse` form with both flags `false`, on a plain object", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => ({
            type: "recurse",
            doKeys: false,
            doValues: false,
          });

          visit({ a: 1 }, rec);
          expect(rec.names).not.toContain("primitive");
          expect(rec.names).not.toContain("visitedFabricPlainObjectEntry");
        });

        it("honors a `recurse` returned directly from `visitValue()`, without subtype dispatch", () => {
          const rec = new Recorder();
          rec.onValue = (v) =>
            Array.isArray(v) ? DO_RECURSE_VALUES : DO_DISPATCH;

          visit([1], rec);
          expect(rec.names).toEqual([
            "value",
            "value",
            "primitive",
            "visitedElement",
          ]);
        });

        it("throws for a `recurse` from `visitValue()` on a primitive", () => {
          const rec = new Recorder();
          rec.onValue = () => DO_RECURSE_VALUES;

          expect(() => visit(1, rec)).toThrow(
            /Cannot use `recurse` result with non-container: `1`/,
          );
        });

        it("throws for a `recurse` from `visitValue()` on a `PlusType` value", () => {
          const rec = new Recorder();
          rec.onPlusType = () => DO_RECURSE_VALUES;

          expect(() => visit(new Date(0), rec)).toThrow(
            /Cannot use `recurse` result with non-container: /,
          );
        });
      });

      describe("`FabricInstance` recursion", () => {
        // `FabricLink` and `FabricError` are the fixtures because their
        // codecs are real. A link's state is its payload, the very object,
        // which makes the sequence easy to state; an error's state is built
        // fresh on each encode and can hold a `cause`, which is what a cycle
        // through an instance needs.

        it("visits the state under the instance, then reports both to `visitedFabricInstance()`", () => {
          const rec = new Recorder();
          const payload = { id: "fid1:abc" };
          const link = new FabricLink(payload);

          expect(visit(link, rec)).toBeUndefined();
          expect(rec.events).toEqual([
            ["value", link, "FabricInstance"],
            ["instance", link],
            ["value", payload, "Object"],
            ["object", payload],
            ["value", "fid1:abc", "string"],
            ["primitive", "fid1:abc", "string"],
            ["visitedFabricPlainObjectEntry", payload, "id", "fid1:abc"],
            ["visitedInstance", link, payload],
          ]);
        });

        it("visits the state its codec encodes", () => {
          const rec = new Recorder();
          const error = new FabricError({
            type: "TypeError",
            message: "boom",
            stack: undefined,
            cause: undefined,
          });

          visit(error, rec);
          expect(rec.events.filter((e) => e[0] === "visitedInstance")).toEqual([
            ["visitedInstance", error, {
              type: "TypeError",
              name: null,
              message: "boom",
            }],
          ]);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "TypeError", "string"],
            ["primitive", null, "null"],
            ["primitive", "boom", "string"],
          ]);
        });

        it("reports a cycle through an instance at the instance", () => {
          const holder: Record<string, unknown> = {};
          const error = new FabricError({
            type: "Error",
            message: "m",
            stack: undefined,
            cause: holder as FabricValue,
          });
          holder.err = error;

          const rec = new Recorder();

          visit(error, rec);
          expect(rec.events.filter((e) => e[0] === "cycle")).toEqual([
            ["cycle", error, "FabricInstance", 0, 3],
          ]);
        });

        it("ends the visit from inside the state, before `visitedFabricInstance()`", () => {
          const rec = new Recorder();
          rec.onPrimitive = (v) =>
            (v === "boom") ? mainResult("found") : undefined;
          const error = new FabricError({
            type: "Error",
            message: "boom",
            stack: undefined,
            cause: undefined,
          });

          expect(visit(error, rec)).toBe("found");
          expect(rec.names).not.toContain("visitedInstance");
        });

        it("ends the visit from `visitedFabricInstance()`", () => {
          const rec = new Recorder();
          rec.onVisitedInstance = () => mainResult("after");
          const link = new FabricLink({ id: "fid1:abc" });

          expect(visit([link, 1], rec)).toBe("after");
          expect(rec.events.map((e) => e[1])).not.toContain(1);
        });

        it("iterates nothing for `DO_RECURSE_KEYS` on an instance", () => {
          const rec = new Recorder();
          rec.onInstance = () => DO_RECURSE_KEYS;
          const link = new FabricLink({ id: "fid1:abc" });

          visit(link, rec);
          expect(rec.names).not.toContain("visitedInstance");
          expect(rec.names).not.toContain("primitive");
        });

        it("throws from the codec for an instance whose codec is a stub", () => {
          const rec = new Recorder();
          const instance = new FabricMap(new Map());

          expect(() => visit(instance, rec)).toThrow(/not yet implemented/);
        });
      });

      describe("array gaps", () => {
        /** Expected gap and element events, without the array argument. */
        type Expected = [name: string, ...args: unknown[]][];

        const cases: [string, unknown[], Expected][] = [
          // deno-lint-ignore no-sparse-arrays
          ["a leading hole", [, 5], [["gap", 0, 1], ["element", 1, 5]]],
          // deno-lint-ignore no-sparse-arrays
          ["a trailing hole", [5, ,], [["element", 0, 5], ["gap", 1, 1]]],
          [
            "several gaps",
            // deno-lint-ignore no-sparse-arrays
            [, , 5, , , 6, ,],
            [
              ["gap", 0, 2],
              ["element", 2, 5],
              ["gap", 3, 2],
              ["element", 5, 6],
              ["gap", 6, 1],
            ],
          ],
          ["a dense array", [7, 8], [["element", 0, 7], ["element", 1, 8]]],
          ["an empty array", [], []],
          ["an array of only holes", new Array(3), [["gap", 0, 3]]],
        ];

        for (const [label, array, expected] of cases) {
          it(`reports the gaps and elements of ${label}, in order`, () => {
            const rec = new Recorder();

            visit(array, rec);

            const actual = rec.events
              .filter((e) => e[0] === "visitedGap" || e[0] === "visitedElement")
              .map(([name, arr, ...rest]) => {
                expect(arr).toBe(array);
                return [name === "visitedGap" ? "gap" : "element", ...rest];
              });
            expect(actual).toEqual(expected);
          });
        }
      });

      describe("the extent of inspection", () => {
        // These pin the contract `visitValue()` states: dispatch is by shape
        // alone, and a container which is not inert is walked as its shape
        // says.

        it("routes a non-fabric root to `visitPlusType()`", () => {
          const rec = new Recorder();
          const date = new Date(0);

          visit(date, rec);
          expect(rec.events).toEqual([
            ["value", date, "PlusType"],
            ["plusType", date],
          ]);
        });

        it("treats an array holding a function as a `FabricArray`, and routes the function to `visitPlusType()`", () => {
          const rec = new Recorder();
          const fn = () => 1;

          visit([fn], rec);
          expect(rec.names).toEqual([
            "value",
            "array",
            "value",
            "plusType",
            "visitedElement",
          ]);
        });

        it("throws on reaching a named property while iterating an array, after the elements before it", () => {
          const rec = new Recorder();
          const array: unknown[] & { extra?: number } = [1];
          array.extra = 2;

          expect(() => visit(array, rec)).toThrow(
            /Non-index property in alleged `FabricArray`: `extra`/,
          );
          expect(rec.names).toEqual([
            "value",
            "array",
            "value",
            "primitive",
            "visitedElement",
          ]);
        });

        it("walks a plain object with a symbol-keyed property as a plain object, skipping that entry", () => {
          const rec = new Recorder();
          const object = { a: 1, [Symbol("s")]: 2 };

          visit(object, rec);
          expect(rec.plusTypeChecks).toEqual([]);
          expect(rec.events.map((e) => e[1])).not.toContain(2);
          expect(
            rec.events.filter((e) => e[0] === "visitedFabricPlainObjectEntry"),
          ).toEqual([
            ["visitedFabricPlainObjectEntry", object, "a", 1],
          ]);
        });

        it("skips a non-enumerable property of a plain object", () => {
          const rec = new Recorder();
          const object = Object.defineProperty({ a: 1 }, "hidden", {
            value: 2,
            enumerable: false,
          });

          visit(object, rec);
          expect(rec.events.map((e) => e[1])).not.toContain(2);
          expect(
            rec.events.filter((e) => e[0] === "visitedFabricPlainObjectEntry"),
          ).toEqual([
            ["visitedFabricPlainObjectEntry", object, "a", 1],
          ]);
        });

        it("reads an accessor-backed property of a plain object, running its getter once", () => {
          const rec = new Recorder();
          let reads = 0;
          const object = Object.defineProperty({}, "a", {
            get: () => {
              reads++;
              return 1;
            },
            enumerable: true,
          });

          visit(object, rec);
          expect(reads).toBe(1);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
          ]);
        });

        it("passes a null-prototype object to `isPlusType()` rather than walking it as a plain object", () => {
          // A `FabricPlainObject` is `Object.prototype`-rooted, so this one is
          // a non-fabric value like any other.

          const rec = new Recorder();
          const object = Object.assign(Object.create(null), { a: 1 });

          visit(object, rec);
          expect(rec.plusTypeChecks).toEqual([object]);
          expect(rec.names).toEqual(["value", "plusType"]);
        });
      });

      describe("`isPlusType()`", () => {
        it("passes a non-fabric value to `isPlusType()` and, on `true`, to `visitPlusType()`", () => {
          const rec = new Recorder();
          const date = new Date(0);

          visit(date, rec);
          expect(rec.plusTypeChecks).toEqual([date]);
          expect(rec.names).toEqual(["value", "plusType"]);
        });

        it("passes a unique symbol to `isPlusType()` and, on `true`, to `visitPlusType()`", () => {
          const rec = new Recorder();
          const unique = Symbol("u");

          visit(unique, rec);
          expect(rec.plusTypeChecks).toEqual([unique]);
          expect(rec.events).toEqual([
            ["value", unique, "PlusType"],
            ["plusType", unique],
          ]);
        });

        it("passes a registry-interned symbol to `visitPrimitiveValue()` without consulting `isPlusType()`", () => {
          const rec = new Recorder();
          const interned = Symbol.for("value-visit");

          visit(interned, rec);
          expect(rec.plusTypeChecks).toEqual([]);
          expect(rec.events).toEqual([
            ["value", interned, "symbol"],
            ["primitive", interned, "symbol"],
          ]);
        });

        it("throws for a unique symbol, without calling `visitPlusType()`, on `false`", () => {
          const rec = new Recorder();
          rec.onIsPlusType = () => false;

          expect(() => visit(Symbol("u"), rec)).toThrow(
            /Cannot visit unrecognized value: /,
          );
          expect(rec.names).not.toContain("plusType");
        });

        it("throws for a non-fabric value, without calling `visitPlusType()`, on `false`", () => {
          const rec = new Recorder();
          rec.onIsPlusType = () => false;

          expect(() => visit(new Date(0), rec)).toThrow(
            /Cannot visit unrecognized value: /,
          );
          expect(rec.names).not.toContain("plusType");
        });

        it("passes the tag `null` to `visitValue()` for a non-fabric value, on `false`", () => {
          const rec = new Recorder();
          const date = new Date(0);
          rec.onIsPlusType = () => false;

          expect(() => visit(date, rec)).toThrow(
            /Cannot visit unrecognized value: /,
          );
          expect(rec.events).toEqual([["value", date, null]]);
        });

        it("honors a `mainResult` from `visitValue()` for a value whose tag is `null`", () => {
          const rec = new Recorder();
          rec.onIsPlusType = () => false;
          rec.onValue = (_v, tag) =>
            (tag === null) ? mainResult("untagged") : DO_DISPATCH;

          expect(visit([new Date(0)], rec)).toBe("untagged");
        });

        it("throws for a non-fabric replacement under a valid root, on `false`", () => {
          const rec = new Recorder();
          rec.onIsPlusType = () => false;
          rec.onValue = (v) => (v === "x") ? replace(new Date(0)) : DO_DISPATCH;

          expect(() => visit(["x"], rec)).toThrow(
            /Cannot visit unrecognized value: /,
          );
        });

        it("does not call `isPlusType()` for a valid `FabricValue`", () => {
          const rec = new Recorder();

          visit({ a: [1, "two", null] }, rec);
          expect(rec.plusTypeChecks).toEqual([]);
        });

        it("passes the function itself, not the array holding it", () => {
          const rec = new Recorder();
          const fn = () => 1;

          visit([fn], rec);
          expect(rec.plusTypeChecks).toEqual([fn]);
        });
      });

      describe("results", () => {
        it("returns `undefined` when no visitor produces a `mainResult`", () => {
          expect(visit({ a: [1] }, new Recorder())).toBeUndefined();
        });

        it("returns the value of the first `mainResult` a visitor produces", () => {
          const rec = new Recorder();
          rec.onPrimitive = (v, tag) =>
            (tag === "number") ? mainResult(v) : undefined;

          expect(visit(["x", 7, 8], rec)).toBe(7);
        });

        it("puts `undefined` to `isResultType()` when no visitor produces a `mainResult`", () => {
          const rec = new Recorder();

          expect(visit([1], rec)).toBeUndefined();
          expect(rec.resultTypeChecks).toStrictEqual([undefined]);
        });

        it("throws when no visitor produces a `mainResult` and `isResultType()` returns `false`", () => {
          const rec = new Recorder();
          rec.onIsResultType = () => false;

          expect(() => visit([1], rec)).toThrow(
            /Not a `ResultType` value: `undefined`/,
          );
          expect(rec.resultTypeChecks).toStrictEqual([undefined]);
        });

        it("does not put a `mainResult`'s value to `isResultType()`", () => {
          const rec = new Recorder();
          rec.onIsResultType = () => false;
          rec.onPrimitive = () => mainResult(undefined);

          expect(visit([1], rec)).toBeUndefined();
          expect(rec.resultTypeChecks).toStrictEqual([]);
        });
      });

      describe("re-entry", () => {
        it("throws when a visitor starts another top-level visit on the same instance mid-visit", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);
          rec.onPrimitive = () => {
            inProgress.visit(2);
            return undefined;
          };

          expect(() => inProgress.visit([1])).toThrow(
            /multiple concurrent top-level visits/,
          );
        });

        it("accepts a second top-level visit once the first has completed", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);

          expect(inProgress.visit([1])).toBeUndefined();
          expect(inProgress.visit({ a: 2 })).toBeUndefined();
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
            ["primitive", 2, "number"],
          ]);
        });

        it("accepts a second top-level visit after the first threw", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);
          rec.onPrimitive = (v) => (v === 1) ? DO_RECURSE_VALUES : undefined;

          expect(() => inProgress.visit([1])).toThrow(/non-container/);
          expect(inProgress.visit([2])).toBeUndefined();
        });

        it("throws when a visitor re-enters from the root value, before anything is on the stack", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);
          rec.onValue = (v) => {
            if (v === "root") {
              inProgress.visit(2);
            }
            return DO_DISPATCH;
          };

          expect(() => inProgress.visit("root")).toThrow(
            /multiple concurrent top-level visits/,
          );
        });

        it("continues the outer visit, and accepts a later one, when a visitor swallows a re-entry error", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec);
          rec.onValue = (v) => {
            if (v === "root") {
              try {
                inProgress.visit(2);
              } catch {
                // Deliberately swallowed.
              }
              return replace([1]);
            }
            return DO_DISPATCH;
          };

          inProgress.visit("root");
          expect(rec.names).toEqual([
            "value",
            "value",
            "array",
            "value",
            "primitive",
            "visitedElement",
          ]);
          expect(rec.events.map((e) => e[1])).not.toContain(2);
          expect(inProgress.visit(3)).toBeUndefined();
        });
      });
    });
  });
});
