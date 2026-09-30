import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue, PrimitiveValueTag } from "@";
import { UnknownValue } from "@/codec-common";
import { CODEC, type NonterminalCodec } from "@/codec-interface/interface.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { FabricError, FabricLink, FabricMap } from "@/fabric-instances";
import { FabricBytes } from "@/fabric-primitives";
import {
  DO_OMIT,
  DO_RECURSE_KEYS_VALUES,
  DO_RECURSE_VALUES,
  type ValueVisitor,
} from "@/value-visit";
import { VisitInProgress } from "@/value-visit/VisitInProgress.ts";

import {
  DO_DISPATCH,
  mainResult,
  mapTo,
  mapToEntry,
  Recorder,
  replace,
  replaceEntry,
} from "./Recorder.ts";

/** Runs a fresh visit of `value` with `vis`. */
function visit(value: unknown, vis: ValueVisitor<unknown, unknown>): unknown {
  return new VisitInProgress(vis, { mode: "visit" }).visit(value);
}

/**
 * Runs a fresh structural-map of `value` with `vis`, freezing the containers
 * it produces.
 */
function map(value: unknown, vis: ValueVisitor<unknown, unknown>): unknown {
  return new VisitInProgress(vis, { mode: "map", freeze: true }).visit(value);
}

/**
 * Runs a fresh structural-map of `value` with `vis`, leaving the containers it
 * produces mutable.
 */
function mutableMap(
  value: unknown,
  vis: ValueVisitor<unknown, unknown>,
): unknown {
  return new VisitInProgress(vis, { mode: "map", freeze: false }).visit(value);
}

/** Returns a `FabricError` with the given message. */
function error(message: string): FabricError {
  return new FabricError({
    type: "Error",
    message,
    stack: undefined,
    cause: undefined,
  });
}

/**
 * Returns a `FabricError` with the given message, whose class's codec is
 * `FabricError`'s own except for the methods in `overrides`.
 */
function errorWithCodec(
  message: string,
  overrides: Partial<Record<keyof NonterminalCodec, unknown>>,
): FabricError {
  const base = FabricError[CODEC];
  const codec = {
    encode: base.encode.bind(base),
    canDecode: base.canDecode.bind(base),
    tagForValue: base.tagForValue.bind(base),
    decode: base.decode.bind(base),
    ...overrides,
  } as unknown as NonterminalCodec;

  class CodecOverridingError extends FabricError {
    static override get [CODEC](): NonterminalCodec {
      return codec;
    }
  }

  return new CodecOverridingError({
    type: "Error",
    message,
    stack: undefined,
    cause: undefined,
  });
}

describe("VisitInProgress", () => {
  describe("instance members", () => {
    describe("visit()", () => {
      describe("dispatch", () => {
        it("visits a nested value depth-first, reporting each element and entry before its value", () => {
          const rec = new Recorder();
          const inner = { b: null };
          const array = [1, inner];
          const root = { a: array };

          expect(visit(root, rec)).toBeUndefined();
          expect(rec.events).toEqual([
            ["value", root, "Object"],
            ["object", root],
            ["visitingFabricPlainObjectEntry", root, "a", array],
            ["value", array, "Array"],
            ["array", array],
            ["visitingFabricArrayElement", array, 0, 1],
            ["value", 1, "number"],
            ["primitive", 1, "number"],
            ["visitingFabricArrayElement", array, 1, inner],
            ["value", inner, "Object"],
            ["object", inner],
            ["visitingFabricPlainObjectEntry", inner, "b", null],
            ["value", null, "null"],
            ["primitive", null, "null"],
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

        it("reports the original element, not its replacement, to `visitingFabricArrayElement()`", () => {
          const rec = new Recorder();
          rec.onValue = (v) => (v === "x") ? replace(42) : DO_DISPATCH;
          const array = ["x"];

          visit(array, rec);
          expect(
            rec.events.filter((e) => e[0] === "visitingFabricArrayElement"),
          ).toEqual([
            ["visitingFabricArrayElement", array, 0, "x"],
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
        it("ends the visit from `visitingFabricArrayElement()`, visiting neither that element nor later ones", () => {
          const rec = new Recorder();
          rec.onVisitingFabricArrayElement = (i) =>
            (i === 1) ? mainResult("at 1") : undefined;
          const array = [10, 20, 30];

          expect(visit(array, rec)).toBe("at 1");
          expect(
            rec.events.filter((e) => e[0] === "visitingFabricArrayElement"),
          ).toEqual([
            ["visitingFabricArrayElement", array, 0, 10],
            ["visitingFabricArrayElement", array, 1, 20],
          ]);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 10, "number"],
          ]);
        });

        it("ends the visit from `visitingFabricPlainObjectEntry()`, visiting neither that entry nor later ones", () => {
          const rec = new Recorder();
          rec.onVisitingFabricPlainObjectEntry = () => mainResult("first");
          const object = { a: 1, b: 2 };

          expect(visit(object, rec)).toBe("first");
          expect(
            rec.events.filter((e) => e[0] === "visitingFabricPlainObjectEntry"),
          ).toEqual([
            ["visitingFabricPlainObjectEntry", object, "a", 1],
          ]);
          expect(rec.names).not.toContain("primitive");
        });

        it("ends the visit from a key's recursion, before the value is visited", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
          rec.onPrimitive = (v) => (v === "a") ? mainResult("key") : undefined;

          expect(visit({ a: 1 }, rec)).toBe("key");
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "a", "string"],
          ]);
        });

        it("ends the visit from `visitingFabricArrayGap()`, for a gap before an element", () => {
          const rec = new Recorder();
          rec.onVisitingFabricArrayGap = () => mainResult("gap");

          // deno-lint-ignore no-sparse-arrays
          expect(visit([, 1], rec)).toBe("gap");
          expect(rec.names).not.toContain("visitingFabricArrayElement");
        });

        it("ends the visit from `visitingFabricArrayGap()`, for a gap at the end", () => {
          const rec = new Recorder();
          rec.onVisitingFabricArrayGap = () => mainResult("gap");

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

      describe("`visiting*()` results that settle or redirect a visit", () => {
        it("does not visit an element that `visitingFabricArrayElement()` settles with a `mapTo`", () => {
          const rec = new Recorder();
          rec.onVisitingFabricArrayElement = (i) =>
            (i === 0) ? mapTo("x") : undefined;

          expect(visit([1, 2], rec)).toBeUndefined();
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 2, "number"],
          ]);
        });

        it("visits the replacement that `visitingFabricArrayElement()` names with a `replace`, in place of the element", () => {
          const rec = new Recorder();
          rec.onVisitingFabricArrayElement = (i) =>
            (i === 0) ? replace(5) : undefined;

          visit([1, 2], rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 5, "number"],
            ["primitive", 2, "number"],
          ]);
        });

        it("does not visit instance state that `visitingFabricInstanceState()` settles with a `mapTo`", () => {
          const rec = new Recorder();
          rec.onVisitingFabricInstanceState = () => mapTo("x");

          visit(error("boom"), rec);
          expect(rec.names).not.toContain("primitive");
        });

        it("visits the replacement state that `visitingFabricInstanceState()` names with a `replace`", () => {
          const rec = new Recorder();
          rec.onVisitingFabricInstanceState = () =>
            replace({ type: "Error", name: null, message: "bang" });

          visit(error("boom"), rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "Error", "string"],
            ["primitive", null, "null"],
            ["primitive", "bang", "string"],
          ]);
        });

        it("visits neither half of an entry that `visitingFabricPlainObjectEntry()` settles with a `mapTo`", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
          rec.onVisitingFabricPlainObjectEntry = (k) =>
            (k === "a") ? mapToEntry("z", 9) : undefined;

          visit({ a: 1, b: 2 }, rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "b", "string"],
            ["primitive", 2, "number"],
          ]);
        });

        it("does not visit an element that `visitingFabricArrayElement()` omits", () => {
          const rec = new Recorder();
          rec.onVisitingFabricArrayElement = (i) =>
            (i === 0) ? DO_OMIT : undefined;

          expect(visit([1, 2], rec)).toBeUndefined();
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 2, "number"],
          ]);
        });

        it("visits neither half of an entry that `visitingFabricPlainObjectEntry()` omits", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
          rec.onVisitingFabricPlainObjectEntry = (k) =>
            (k === "a") ? DO_OMIT : undefined;

          visit({ a: 1, b: 2 }, rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "b", "string"],
            ["primitive", 2, "number"],
          ]);
        });

        it("visits the key and value that `visitingFabricPlainObjectEntry()` names with a `replace`, in place of the entry's own", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
          rec.onVisitingFabricPlainObjectEntry = () => replaceEntry("z", 9);

          visit({ a: 1 }, rec);
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", "z", "string"],
            ["primitive", 9, "number"],
          ]);
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

        it("reports each entry to `visitingFabricPlainObjectEntry()` whether or not keys are recursed", () => {
          for (const form of [DO_RECURSE_KEYS_VALUES, DO_RECURSE_VALUES]) {
            const rec = new Recorder();
            rec.onPlainObject = () => form;
            const object = { a: 1 };

            visit(object, rec);
            expect(
              rec.events.filter((e) =>
                e[0] === "visitingFabricPlainObjectEntry"
              ),
            ).toEqual([
              ["visitingFabricPlainObjectEntry", object, "a", 1],
            ]);
          }
        });

        it("honors a `recurse` returned directly from `visitValue()`, without subtype dispatch", () => {
          const rec = new Recorder();
          rec.onValue = (v) =>
            Array.isArray(v) ? DO_RECURSE_VALUES : DO_DISPATCH;

          visit([1], rec);
          expect(rec.names).toEqual([
            "value",
            "visitingFabricArrayElement",
            "value",
            "primitive",
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
        // codecs are real. A link's state is its `.payload`, the very object,
        // which makes the sequence easy to state; an error's state is built
        // fresh on each encode and can hold a `cause`, which is what a cycle
        // through an instance needs.

        it("reports the instance and its state to `visitingFabricInstanceState()`, then visits the state under the instance", () => {
          const rec = new Recorder();
          const link = new FabricLink({ id: "fid1:abc" });
          const payload = link.payload;

          expect(visit(link, rec)).toBeUndefined();
          expect(rec.events).toEqual([
            ["value", link, "FabricInstance"],
            ["instance", link],
            ["visitingFabricInstanceState", link, payload],
            ["value", payload, "Object"],
            ["object", payload],
            ["visitingFabricPlainObjectEntry", payload, "id", "fid1:abc"],
            ["value", "fid1:abc", "string"],
            ["primitive", "fid1:abc", "string"],
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
          expect(
            rec.events.filter((e) => e[0] === "visitingFabricInstanceState"),
          ).toEqual([
            ["visitingFabricInstanceState", error, {
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

        it("ends the visit from inside the state", () => {
          const rec = new Recorder();
          rec.onPrimitive = (v) =>
            (v === "boom") ? mainResult("found") : undefined;
          const error = new FabricError({
            type: "Error",
            message: "boom",
            stack: undefined,
            cause: undefined,
          });

          expect(visit([error, 1], rec)).toBe("found");
          expect(rec.events.map((e) => e[1])).not.toContain(1);
        });

        it("ends the visit from `visitingFabricInstanceState()`, before the state is visited", () => {
          const rec = new Recorder();
          rec.onVisitingFabricInstanceState = () => mainResult("before");
          const link = new FabricLink({ id: "fid1:abc" });
          const payload = link.payload;

          expect(visit([link, 1], rec)).toBe("before");
          expect(rec.events.map((e) => e[1])).not.toContain(payload);
          expect(rec.events.map((e) => e[1])).not.toContain(1);
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
              .filter((e) =>
                e[0] === "visitingFabricArrayGap" ||
                e[0] === "visitingFabricArrayElement"
              )
              .map(([name, arr, ...rest]) => {
                expect(arr).toBe(array);
                return [
                  name === "visitingFabricArrayGap" ? "gap" : "element",
                  ...rest,
                ];
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
            "visitingFabricArrayElement",
            "value",
            "plusType",
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
            "visitingFabricArrayElement",
            "value",
            "primitive",
          ]);
        });

        it("walks a plain object with a symbol-keyed property as a plain object, skipping that entry", () => {
          const rec = new Recorder();
          const object = { a: 1, [Symbol("s")]: 2 };

          visit(object, rec);
          expect(rec.plusTypeChecks).toEqual([]);
          expect(rec.events.map((e) => e[1])).not.toContain(2);
          expect(
            rec.events.filter((e) => e[0] === "visitingFabricPlainObjectEntry"),
          ).toEqual([
            ["visitingFabricPlainObjectEntry", object, "a", 1],
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
            rec.events.filter((e) => e[0] === "visitingFabricPlainObjectEntry"),
          ).toEqual([
            ["visitingFabricPlainObjectEntry", object, "a", 1],
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

        it("returns the value of a `mapTo` from the root value", () => {
          const rec = new Recorder();
          rec.onValue = () => mapTo("mapped");

          expect(visit([1], rec)).toBe("mapped");
        });

        it("returns `undefined` for a `mapTo` from beneath the root value", () => {
          const rec = new Recorder();
          rec.onPrimitive = () => mapTo("mapped");

          expect(visit([1], rec)).toBeUndefined();
        });

        it("does not call any `mapped*()` method", () => {
          const rec = new Recorder();

          visit([1, { a: new FabricLink({ id: "fid1:abc" }) }], rec);
          expect(rec.names.filter((n) => n.startsWith("mapped"))).toEqual([]);
          expect(rec.names.filter((n) => n.startsWith("visiting"))).toEqual([
            "visitingFabricArrayElement",
            "visitingFabricArrayElement",
            "visitingFabricPlainObjectEntry",
            "visitingFabricInstanceState",
            "visitingFabricPlainObjectEntry",
          ]);
        });

        it("returns the value of the first `mainResult` a visitor produces", () => {
          const rec = new Recorder();
          rec.onPrimitive = (v, tag) =>
            (tag === "number") ? mainResult(v) : undefined;

          expect(visit(["x", 7, 8], rec)).toBe(7);
        });

        it("puts `undefined` to `isResultType()` when no visitor produces a `mainResult` and `isDomainAssignableToResultType()` returns `false`", () => {
          const rec = new Recorder();
          rec.onIsDomainAssignableToResultType = () => false;

          expect(visit([1], rec)).toBeUndefined();
          expect(rec.resultTypeChecks).toStrictEqual([undefined]);
        });

        it("throws when no visitor produces a `mainResult`, `isDomainAssignableToResultType()` returns `false`, and `isResultType()` returns `false`", () => {
          const rec = new Recorder();
          rec.onIsDomainAssignableToResultType = () => false;
          rec.onIsResultType = () => false;

          expect(() => visit([1], rec)).toThrow(
            /Not a `ResultType` value: `undefined`/,
          );
          expect(rec.resultTypeChecks).toStrictEqual([undefined]);
        });

        it("does not call `isResultType()` when `isDomainAssignableToResultType()` returns `true`", () => {
          const rec = new Recorder();
          rec.onIsDomainAssignableToResultType = () => true;
          rec.onIsResultType = () => false;

          expect(visit([1], rec)).toBeUndefined();
          expect(rec.domainAssignableChecks).toBe(1);
          expect(rec.resultTypeChecks).toStrictEqual([]);
        });

        it("does not put a `mainResult`'s value to `isResultType()`", () => {
          const rec = new Recorder();
          rec.onIsDomainAssignableToResultType = () => false;
          rec.onIsResultType = () => false;
          rec.onPrimitive = () => mainResult(undefined);

          expect(visit([1], rec)).toBeUndefined();
          expect(rec.resultTypeChecks).toStrictEqual([]);
        });
      });

      describe("re-entry", () => {
        it("throws when a visitor starts another top-level visit on the same instance mid-visit", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec, {
            mode: "visit",
          });
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
          const inProgress = new VisitInProgress<unknown, unknown>(rec, {
            mode: "visit",
          });

          expect(inProgress.visit([1])).toBeUndefined();
          expect(inProgress.visit({ a: 2 })).toBeUndefined();
          expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
            ["primitive", 1, "number"],
            ["primitive", 2, "number"],
          ]);
        });

        it("accepts a second top-level visit after the first threw", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec, {
            mode: "visit",
          });
          rec.onPrimitive = (v) => (v === 1) ? DO_RECURSE_VALUES : undefined;

          expect(() => inProgress.visit([1])).toThrow(/non-container/);
          expect(inProgress.visit([2])).toBeUndefined();
        });

        it("throws when a visitor re-enters from the root value, before anything is on the stack", () => {
          const rec = new Recorder();
          const inProgress = new VisitInProgress<unknown, unknown>(rec, {
            mode: "visit",
          });
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
          const inProgress = new VisitInProgress<unknown, unknown>(rec, {
            mode: "visit",
          });
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
            "visitingFabricArrayElement",
            "value",
            "primitive",
          ]);
          expect(rec.events.map((e) => e[1])).not.toContain(2);
          expect(inProgress.visit(3)).toBeUndefined();
        });
      });

      describe("when mapping", () => {
        describe("results", () => {
          it("returns a primitive the visitor leaves alone as itself", () => {
            expect(map(5, new Recorder())).toBe(5);
          });

          it("returns the same array when no element changes and the array is deeply frozen", () => {
            const array = deepFreeze([1, [2]]);

            expect(map(array, new Recorder())).toBe(array);
          });

          it("returns the same plain object when no entry changes and the object is deeply frozen", () => {
            const object = deepFreeze({ a: 1, b: { c: 2 } });

            expect(map(object, new Recorder())).toBe(object);
          });

          it("returns the same instance when its state does not change and the instance is deeply frozen", () => {
            const link = deepFreeze(new FabricLink({ id: "fid1:abc" }));

            expect(map(link, new Recorder())).toBe(link);
          });

          it("returns the value of a `mapTo` from the root value", () => {
            const rec = new Recorder();
            rec.onValue = () => mapTo("mapped");

            expect(map([1], rec)).toBe("mapped");
            expect(rec.names).toEqual(["value"]);
          });

          it("returns the value of a `mainResult`, visiting nothing after it", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === 2) ? mainResult("stop") : mapTo(0);

            expect(map([1, 2, 3], rec)).toBe("stop");
            expect(rec.events.map((e) => e[1])).not.toContain(3);
          });
        });

        describe("arrays", () => {
          it("returns a new array of the elements' mapped values, leaving the original alone", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === 2) ? mapTo("two") : undefined;
            const array = [1, 2, 3];
            const result = map(array, rec);

            expect(result).toEqual([1, "two", 3]);
            expect(result).not.toBe(array);
            expect(array).toEqual([1, 2, 3]);
          });

          it("keeps the holes of a mapped array", () => {
            const rec = new Recorder();
            rec.onPrimitive = () => mapTo("one");
            // deno-lint-ignore no-sparse-arrays
            const result = map([, 1, ,], rec) as unknown[];

            expect(result.length).toBe(3);
            expect(Object.keys(result)).toEqual(["1"]);
            expect(result[1]).toBe("one");
          });

          it("reports each element and its mapped value to `mappedFabricArrayElement()`, after visiting the element", () => {
            const rec = new Recorder();
            rec.onPrimitive = () => mapTo("one");
            const array = [1];

            map(array, rec);
            expect(rec.events).toEqual([
              ["value", array, "Array"],
              ["array", array],
              ["visitingFabricArrayElement", array, 0, 1],
              ["value", 1, "number"],
              ["primitive", 1, "number"],
              ["mappedFabricArrayElement", array, 0, 1, "one"],
            ]);
          });

          it("ends the map from `mappedFabricArrayElement()`, visiting no later element", () => {
            const rec = new Recorder();
            rec.onMappedFabricArrayElement = (i) =>
              (i === 0) ? mainResult("after 0") : undefined;

            expect(map([10, 20], rec)).toBe("after 0");
            expect(rec.events.map((e) => e[1])).not.toContain(20);
          });

          it("ends the map from `visitingFabricArrayGap()`", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayGap = () => mainResult("gap");

            // deno-lint-ignore no-sparse-arrays
            expect(map([1, , 2], rec)).toBe("gap");
            expect(rec.events.map((e) => e[1])).not.toContain(2);
          });

          it("counts `-0` mapped to `0` as a change", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => Object.is(v, -0) ? mapTo(0) : undefined;
            const array = [-0];
            const result = map(array, rec) as number[];

            expect(result).not.toBe(array);
            expect(result[0]).toBe(0);
          });

          it("counts a `NaN` left alone as no change", () => {
            const array = Object.freeze([NaN]);

            expect(map(array, new Recorder())).toBe(array);
          });
        });

        describe("plain objects", () => {
          it("returns a new object of the entries' mapped values, leaving the original alone", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === 2) ? mapTo("two") : undefined;
            const object = { a: 1, b: 2 };
            const result = map(object, rec);

            expect(result).toEqual({ a: 1, b: "two" });
            expect(result).not.toBe(object);
            expect(object).toEqual({ a: 1, b: 2 });
          });

          it("returns a new object with mapped keys, for `DO_RECURSE_KEYS_VALUES`", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onPrimitive = (v) => (v === "a") ? mapTo("z") : undefined;

            expect(map({ a: 1, b: 2 }, rec)).toEqual({ z: 1, b: 2 });
          });

          it("reports each entry and its final key and mapped value to `mappedFabricPlainObjectEntry()`, after visiting the entry", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onPrimitive = (v) => mapTo((v === "a") ? "z" : "one");
            const object = { a: 1 };

            map(object, rec);
            expect(rec.events).toEqual([
              ["value", object, "Object"],
              ["object", object],
              ["visitingFabricPlainObjectEntry", object, "a", 1],
              ["value", "a", "string"],
              ["primitive", "a", "string"],
              ["value", 1, "number"],
              ["primitive", 1, "number"],
              ["mappedFabricPlainObjectEntry", object, "a", 1, "z", "one"],
            ]);
          });

          it("ends the map from `mappedFabricPlainObjectEntry()`, visiting no later entry", () => {
            const rec = new Recorder();
            rec.onMappedFabricPlainObjectEntry = () => mainResult("first");

            expect(map({ a: 1, b: 2 }, rec)).toBe("first");
            expect(rec.events.map((e) => e[1])).not.toContain(2);
          });

          it("ends the map from a key's recursion", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onPrimitive = (v) =>
              (v === "a") ? mainResult("key") : undefined;

            expect(map({ a: 1 }, rec)).toBe("key");
            expect(rec.events.map((e) => e[1])).not.toContain(1);
          });

          it("throws for a key mapped to a non-string", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onPrimitive = (v) => (v === "a") ? mapTo(5) : undefined;

            expect(() => map({ a: 1 }, rec)).toThrow(
              /Visit of key `"a"` mapped to non-string: `5`/,
            );
          });

          it("throws for a key mapped to an unsafe key", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onPrimitive = (v) =>
              (v === "a") ? mapTo("__proto__") : undefined;

            expect(() => map({ a: 1 }, rec)).toThrow(
              /Visit of key `"a"` mapped to unsafe key: `"__proto__"`/,
            );
          });

          it("throws for an unsafe key left as it is", () => {
            const object = JSON.parse('{ "__proto__": 1 }');

            expect(() => map(object, new Recorder())).toThrow(
              /Visit of unsafe key `"__proto__"` mapped to itself/,
            );
          });

          it("throws for two keys mapped to the same key", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onPrimitive = (_v, tag) =>
              (tag === "string") ? mapTo("k") : undefined;

            expect(() => map({ a: 1, b: 2 }, rec)).toThrow(
              /Visit of key `"b"` mapped to already-mapped key: `"k"`/,
            );
          });

          it("does not put a key to `isResultType()`", () => {
            const rec = new Recorder();
            rec.onIsDomainAssignableToResultType = () => false;
            rec.onIsResultType = (v) => typeof v !== "string";
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            const object = { a: 1 };

            expect(map(object, rec)).toEqual(object);
            expect(rec.resultTypeChecks).not.toContain("a");
          });
        });

        describe("`FabricInstance`s", () => {
          it("returns a new instance decoded from the mapped state", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === "boom") ? mapTo("bang") : undefined;
            const original = error("boom");
            const result = map(original, rec);

            expect(result).toBeInstanceOf(FabricError);
            expect(result).not.toBe(original);
            expect((result as FabricError).message).toBe("bang");
            expect(original.message).toBe("boom");
          });

          it("reports the state and its mapped form to `mappedFabricInstanceState()`, after visiting the state", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === "boom") ? mapTo("bang") : undefined;
            const original = error("boom");

            map(original, rec);
            expect(rec.names.slice(-1)).toEqual(["mappedFabricInstanceState"]);
            expect(rec.events.slice(-1)).toEqual([
              ["mappedFabricInstanceState", original, {
                type: "Error",
                name: null,
                message: "boom",
              }, {
                type: "Error",
                name: null,
                message: "bang",
              }],
            ]);
          });

          it("ends the map from `mappedFabricInstanceState()`", () => {
            const rec = new Recorder();
            rec.onMappedFabricInstanceState = () => mainResult("after");

            expect(map([error("boom"), 1], rec)).toBe("after");
            expect(rec.events.map((e) => e[1])).not.toContain(1);
          });

          it("returns a new instance for a deeply frozen instance whose state changes", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) =>
              (v === "fid1:abc") ? mapTo("fid1:xyz") : undefined;
            const original = deepFreeze(new FabricLink({ id: "fid1:abc" }));
            const result = map(original, rec);

            expect(result).toBeInstanceOf(FabricLink);
            expect(result).not.toBe(original);
            expect((result as FabricLink).payload).toEqual({ id: "fid1:xyz" });
            expect(original.payload).toEqual({ id: "fid1:abc" });
          });

          it("throws when the codec refuses the mapped state", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === "boom") ? mapTo(5) : undefined;

            expect(() => map(error("boom"), rec)).toThrow(
              /Codec of .* refused replacement state /,
            );
          });

          it("throws when the codec refuses a state mapped to `undefined`", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => mapTo(undefined);

            expect(() => map(error("boom"), rec)).toThrow(
              /Codec of .* refused replacement state `undefined`/,
            );
          });

          it("decodes a state mapped to `undefined` when the codec accepts it", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => mapTo(undefined);
            const decoded = error("decoded");
            const states: unknown[] = [];
            const instance = errorWithCodec("boom", {
              canDecode: () => true,
              decode: (_tag: string, state: unknown) => {
                states.push(state);
                return decoded;
              },
            });

            expect(map(instance, rec)).toBe(decoded);
            expect(states.length).toBe(1);
            expect(states[0]).toBeUndefined();
          });

          it("throws when the codec fails while checking the mapped state", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === "boom") ? mapTo("bang") : undefined;
            const instance = errorWithCodec("boom", {
              canDecode: () => {
                throw new Error("canDecode failed");
              },
            });

            expect(() => map(instance, rec)).toThrow(
              /Codec of .* failed while checking replacement state /,
            );
          });

          it("throws when the codec fails when asked for a tag", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === "boom") ? mapTo("bang") : undefined;
            const instance = errorWithCodec("boom", {
              tagForValue: () => {
                throw new Error("tagForValue failed");
              },
            });

            expect(() => map(instance, rec)).toThrow(
              /Codec of .* failed when asked for a tag/,
            );
          });

          it("throws when the codec accepts but then fails to decode the mapped state", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === "boom") ? mapTo("bang") : undefined;
            const instance = errorWithCodec("boom", {
              decode: () => {
                throw new Error("decode failed");
              },
            });

            expect(() => map(instance, rec)).toThrow(
              /Codec of .* accepted but then failed to decode replacement state /,
            );
          });
        });

        describe("`replace` results", () => {
          it("returns the replacement for a value whose replacement the visitor leaves alone", () => {
            const rec = new Recorder();
            rec.onValue = (v) => (v === 1) ? replace("one") : DO_DISPATCH;

            expect(map(1, rec)).toBe("one");
            expect(map([1, 2], rec)).toEqual(["one", 2]);
          });

          it("returns a frozen replacement container that is left unchanged as that same container", () => {
            const two = Object.freeze([2]);
            const rec = new Recorder();
            rec.onValue = (v) => (v === 1) ? replace(two) : DO_DISPATCH;

            expect(map(1, rec)).toBe(two);
            expect((map({ a: 1 }, rec) as { a: unknown }).a).toBe(two);
          });

          it("reports the original element alongside its mapped replacement to `mappedFabricArrayElement()`", () => {
            const rec = new Recorder();
            rec.onValue = (v) => (v === "x") ? replace(42) : DO_DISPATCH;
            const array = ["x"];

            map(array, rec);
            expect(
              rec.events.filter((e) => e[0] === "mappedFabricArrayElement"),
            ).toEqual([
              ["mappedFabricArrayElement", array, 0, "x", 42],
            ]);
          });
        });

        describe("`visiting*()` results", () => {
          it("places the value of a `visitingFabricArrayElement()` `mapTo` as given, without visiting the element", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = (i) =>
              (i === 0) ? mapTo("x") : undefined;

            expect(map([1, 2], rec)).toEqual(["x", 2]);
            expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
              ["primitive", 2, "number"],
            ]);
          });

          it("maps the replacement of a `visitingFabricArrayElement()` `replace` in place of the element", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = (i) =>
              (i === 0) ? replace(5) : undefined;
            rec.onPrimitive = (v) => (v === 5) ? mapTo("five") : undefined;

            expect(map([1, 2], rec)).toEqual(["five", 2]);
          });

          it("places the replacement of a `visitingFabricArrayElement()` `replace` as itself when its visit maps nothing", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = (i) =>
              (i === 0) ? replace(5) : undefined;

            expect(map([1, 2], rec)).toEqual([5, 2]);
          });

          it("reports the original element and a `mapTo` result to `mappedFabricArrayElement()`", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = () => mapTo("x");
            const array = [1];

            map(array, rec);
            expect(
              rec.events.filter((e) => e[0] === "mappedFabricArrayElement"),
            ).toEqual([
              ["mappedFabricArrayElement", array, 0, 1, "x"],
            ]);
          });

          it("reports the original element and a `replace` result to `mappedFabricArrayElement()`", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = () => replace(5);
            const array = [1];

            map(array, rec);
            expect(
              rec.events.filter((e) => e[0] === "mappedFabricArrayElement"),
            ).toEqual([
              ["mappedFabricArrayElement", array, 0, 1, 5],
            ]);
          });

          it("rebuilds an instance from the state of a `visitingFabricInstanceState()` `mapTo`, without visiting the original state", () => {
            const rec = new Recorder();
            const settled = { type: "Error", name: null, message: "bang" };
            rec.onVisitingFabricInstanceState = () => mapTo(settled);
            const original = error("boom");

            const result = map(original, rec);
            expect(result).toBeInstanceOf(FabricError);
            expect((result as FabricError).message).toBe("bang");
            expect(rec.names).not.toContain("primitive");
            expect(rec.events.slice(-1)).toEqual([
              ["mappedFabricInstanceState", original, {
                type: "Error",
                name: null,
                message: "boom",
              }, settled],
            ]);
          });

          it("rebuilds an instance from the mapped replacement of a `visitingFabricInstanceState()` `replace`", () => {
            const rec = new Recorder();
            rec.onVisitingFabricInstanceState = () =>
              replace({ type: "Error", name: null, message: "bang" });
            rec.onPrimitive = (v) => (v === "bang") ? mapTo("pow") : undefined;

            const result = map(error("boom"), rec);
            expect(result).toBeInstanceOf(FabricError);
            expect((result as FabricError).message).toBe("pow");
          });

          it("places the key and value of a `visitingFabricPlainObjectEntry()` `mapTo` as given, without visiting the entry", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onVisitingFabricPlainObjectEntry = (k) =>
              (k === "a") ? mapToEntry("z", 9) : undefined;
            const object = { a: 1, b: 2 };

            expect(map(object, rec)).toEqual({ z: 9, b: 2 });
            expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
              ["primitive", "b", "string"],
              ["primitive", 2, "number"],
            ]);
            expect(
              rec.events.filter((e) =>
                e[0] === "mappedFabricPlainObjectEntry"
              )[0],
            ).toEqual(["mappedFabricPlainObjectEntry", object, "a", 1, "z", 9]);
          });

          it("maps the key and value of a `visitingFabricPlainObjectEntry()` `replace` in place of the entry's own, when keys are visited", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onVisitingFabricPlainObjectEntry = () => replaceEntry("z", 9);
            rec.onPrimitive = (v) => (v === "z") ? mapTo("y") : undefined;
            const object = { a: 1 };

            expect(map(object, rec)).toEqual({ y: 9 });
            expect(rec.events.slice(-1)).toEqual([
              ["mappedFabricPlainObjectEntry", object, "a", 1, "y", 9],
            ]);
          });

          it("places the key of a `visitingFabricPlainObjectEntry()` `replace` without visiting it, when keys are not visited", () => {
            const rec = new Recorder();
            rec.onVisitingFabricPlainObjectEntry = () => replaceEntry("z", 9);

            expect(map({ a: 1 }, rec)).toEqual({ z: 9 });
            expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
              ["primitive", 9, "number"],
            ]);
          });

          it("leaves a hole for an element that `visitingFabricArrayElement()` omits, without visiting it", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = (i) =>
              (i === 1) ? DO_OMIT : undefined;

            const result = map([1, 2, 3], rec) as unknown[];
            expect(result.length).toBe(3);
            expect(Object.hasOwn(result, 1)).toBe(false);
            expect(result[0]).toBe(1);
            expect(result[2]).toBe(3);
            expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
              ["primitive", 1, "number"],
              ["primitive", 3, "number"],
            ]);
          });

          it("keeps the length of an array whose last element `visitingFabricArrayElement()` omits", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = (i) =>
              (i === 1) ? DO_OMIT : undefined;

            const result = map([1, 2], rec) as unknown[];
            expect(result.length).toBe(2);
            expect(Object.hasOwn(result, 1)).toBe(false);
          });

          it("reports an element that `visitingFabricArrayElement()` omits to no `mappedFabricArrayElement()` call", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = (i) =>
              (i === 0) ? DO_OMIT : undefined;
            const array = [1, 2];

            map(array, rec);
            expect(
              rec.events.filter((e) => e[0] === "mappedFabricArrayElement"),
            ).toEqual([
              ["mappedFabricArrayElement", array, 1, 2, 2],
            ]);
          });

          it("returns a new array for a frozen original whose only change is an omitted element", () => {
            const rec = new Recorder();
            rec.onVisitingFabricArrayElement = (i) =>
              (i === 1) ? DO_OMIT : undefined;
            const original = Object.freeze([1, 2]);

            const result = map(original, rec) as unknown[];
            expect(result).not.toBe(original);
            expect(Object.hasOwn(result, 1)).toBe(false);
          });

          it("leaves out an entry that `visitingFabricPlainObjectEntry()` omits, without visiting it", () => {
            const rec = new Recorder();
            rec.onPlainObject = () => DO_RECURSE_KEYS_VALUES;
            rec.onVisitingFabricPlainObjectEntry = (k) =>
              (k === "a") ? DO_OMIT : undefined;

            const result = map({ a: 1, b: 2 }, rec);
            expect(result).toEqual({ b: 2 });
            expect(Object.hasOwn(result as object, "a")).toBe(false);
            expect(rec.events.filter((e) => e[0] === "primitive")).toEqual([
              ["primitive", "b", "string"],
              ["primitive", 2, "number"],
            ]);
          });

          it("reports an entry that `visitingFabricPlainObjectEntry()` omits to no `mappedFabricPlainObjectEntry()` call", () => {
            const rec = new Recorder();
            rec.onVisitingFabricPlainObjectEntry = (k) =>
              (k === "a") ? DO_OMIT : undefined;
            const object = { a: 1, b: 2 };

            map(object, rec);
            expect(
              rec.events.filter((e) => e[0] === "mappedFabricPlainObjectEntry"),
            ).toEqual([
              ["mappedFabricPlainObjectEntry", object, "b", 2, "b", 2],
            ]);
          });

          it("returns a new object for a frozen original whose only change is an omitted entry", () => {
            const rec = new Recorder();
            rec.onVisitingFabricPlainObjectEntry = () => DO_OMIT;
            const original = Object.freeze({ a: 1 });

            const result = map(original, rec);
            expect(result).not.toBe(original);
            expect(result).toEqual({});
          });

          it("throws for a `visitingFabricPlainObjectEntry()` `mapTo` naming a key already mapped", () => {
            const rec = new Recorder();
            rec.onVisitingFabricPlainObjectEntry = (k) =>
              (k === "b") ? mapToEntry("a", 9) : undefined;

            expect(() => map({ a: 1, b: 2 }, rec)).toThrow(
              "mapped to already-mapped key",
            );
          });

          it("throws for a `visitingFabricPlainObjectEntry()` `replace` naming a key already mapped, when keys are not visited", () => {
            const rec = new Recorder();
            rec.onVisitingFabricPlainObjectEntry = (k) =>
              (k === "b") ? replaceEntry("a", 9) : undefined;

            expect(() => map({ a: 1, b: 2 }, rec)).toThrow(
              "mapped to already-mapped key",
            );
          });

          it("throws for a `visitingFabricPlainObjectEntry()` `replace` naming an unsafe key, when keys are not visited", () => {
            const rec = new Recorder();
            rec.onVisitingFabricPlainObjectEntry = () =>
              replaceEntry("__proto__", 9);

            expect(() => map({ a: 1 }, rec)).toThrow("Visit of unsafe key");
          });

          it("throws for a `visitingFabricPlainObjectEntry()` `mapTo` naming an unsafe key", () => {
            const rec = new Recorder();
            rec.onVisitingFabricPlainObjectEntry = () =>
              mapToEntry("__proto__", 9);

            expect(() => map({ a: 1 }, rec)).toThrow("mapped to unsafe key");
          });
        });

        describe("result types", () => {
          it("puts unchanged elements and the new container to `isResultType()` when `isDomainAssignableToResultType()` returns `false`", () => {
            const rec = new Recorder();
            rec.onIsDomainAssignableToResultType = () => false;
            rec.onPrimitive = (v) => (v === 2) ? mapTo("two") : undefined;

            expect(map([1, 2], rec)).toEqual([1, "two"]);
            expect(rec.resultTypeChecks).toStrictEqual([1, [1, "two"]]);
          });

          it("throws when `isResultType()` returns `false` for a new container", () => {
            const rec = new Recorder();
            rec.onIsDomainAssignableToResultType = () => false;
            rec.onIsResultType = (v) => !Array.isArray(v);
            rec.onPrimitive = () => mapTo("one");

            expect(() => map([1], rec)).toThrow(
              /Not a `ResultType` value: `\["one"\]`/,
            );
          });

          it("calls `isDomainAssignableToResultType()` at most once per instance", () => {
            const rec = new Recorder();
            rec.onIsDomainAssignableToResultType = () => false;
            const inProgress = new VisitInProgress<unknown, unknown>(rec, {
              mode: "map",
              freeze: true,
            });

            inProgress.visit([1, [2]]);
            inProgress.visit({ a: 3 });
            expect(rec.domainAssignableChecks).toBe(1);
          });
        });

        describe("freezing", () => {
          it("freezes the array it makes from mapped elements", () => {
            const rec = new Recorder();
            rec.onPrimitive = () => mapTo("one");

            expect(Object.isFrozen(map([1], rec))).toBe(true);
          });

          it("returns a frozen copy of an unchanged array that is not frozen, leaving the original unfrozen", () => {
            const array = [1, 2];
            const result = map(array, new Recorder());

            expect(result).not.toBe(array);
            expect(result).toEqual(array);
            expect(Object.isFrozen(result)).toBe(true);
            expect(Object.isFrozen(array)).toBe(false);
          });

          it("returns a frozen copy of an unchanged plain object that is not frozen, leaving the original unfrozen", () => {
            const object = { a: 1 };
            const result = map(object, new Recorder());

            expect(result).not.toBe(object);
            expect(result).toEqual(object);
            expect(Object.isFrozen(result)).toBe(true);
            expect(Object.isFrozen(object)).toBe(false);
          });

          it("returns a frozen copy of an unfrozen container, holding the same unchanged frozen child", () => {
            const child = Object.freeze([2]);
            const parent = [1, child];
            const result = map(parent, new Recorder()) as unknown[];

            expect(result).not.toBe(parent);
            expect(Object.isFrozen(result)).toBe(true);
            expect(result[1]).toBe(child);
          });

          it("returns frozen copies of the unfrozen containers inside a frozen container", () => {
            const child = [2];
            const parent = Object.freeze([1, child]);
            const result = map(parent, new Recorder()) as unknown[];

            expect(result).not.toBe(parent);
            expect(Object.isFrozen(result)).toBe(true);
            expect(result[1]).not.toBe(child);
            expect(Object.isFrozen(result[1])).toBe(true);
            expect(Object.isFrozen(child)).toBe(false);
          });

          it("returns a new frozen instance for an unfrozen instance whose state does not change", () => {
            const original = new FabricError({
              type: "Error",
              message: "boom",
              stack: undefined,
              cause: undefined,
            });
            const result = map(original, new Recorder());

            expect(result).toBeInstanceOf(FabricError);
            expect(result).not.toBe(original);
            expect((result as FabricError).message).toBe("boom");
            expect(Object.isFrozen(result)).toBe(true);
            expect(Object.isFrozen(original)).toBe(false);
          });

          it("leaves unfrozen the external state an instance encodes as itself", () => {
            // An `UnknownValue`'s state is an external reference, which its
            // codec returns as itself, unfrozen.
            const state = { a: 1 };
            const original = new UnknownValue("Test@1", state);
            const result = map(original, new Recorder()) as UnknownValue;

            expect(result).not.toBe(original);
            expect(result.state).not.toBe(state);
            expect(result.state).toEqual(state);
            expect(Object.isFrozen(result.state)).toBe(true);
            expect(Object.isFrozen(state)).toBe(false);
          });

          it("places a container the visitor supplies through `mapTo` as given", () => {
            const supplied = { b: 2 };
            const rec = new Recorder();
            rec.onPrimitive = () => mapTo(supplied);
            const result = map([1], rec) as unknown[];

            expect(Object.isFrozen(result)).toBe(true);
            expect(result[0]).toBe(supplied);
            expect(Object.isFrozen(supplied)).toBe(false);
          });

          it("rebuilds an unfrozen instance around a state the visitor maps to itself, leaving that state as given", () => {
            const state = { a: 1 };
            const original = new UnknownValue("Test@1", state);
            const rec = new Recorder();
            rec.onPlainObject = (v) => mapTo(v);
            const result = map(original, rec) as UnknownValue;

            expect(result).not.toBe(original);
            expect(Object.isFrozen(result)).toBe(true);
            expect(result.state).toBe(state);
            expect(Object.isFrozen(state)).toBe(false);
          });

          it("returns a frozen instance as itself when the visitor maps its state to itself", () => {
            const state = { a: 1 };
            const original = Object.freeze(new UnknownValue("Test@1", state));
            const rec = new Recorder();
            rec.onPlainObject = (v) => mapTo(v);

            expect(map(original, rec)).toBe(original);
            expect(Object.isFrozen(state)).toBe(false);
          });

          it("places a state the visitor supplies through `mapTo` as given", () => {
            const supplied = { b: 2 };
            const rec = new Recorder();
            rec.onPlainObject = () => mapTo(supplied);
            const result = map(
              new UnknownValue("Test@1", { a: 1 }),
              rec,
            ) as UnknownValue;

            expect(result.state).toBe(supplied);
            expect(Object.isFrozen(supplied)).toBe(false);
          });

          it("returns the instance its codec's `decode()` returns, as it is", () => {
            const rec = new Recorder();
            rec.onPrimitive = (v) => (v === "boom") ? mapTo("bang") : undefined;
            const decoded = error("decoded");
            const instance = errorWithCodec("boom", {
              canDecode: () => true,
              decode: () => decoded,
            });

            expect(map(instance, rec)).toBe(decoded);
            expect(Object.isFrozen(decoded)).toBe(false);
          });
        });

        describe("without freezing", () => {
          it("returns an unfrozen copy of an unchanged frozen array", () => {
            const array = Object.freeze([1, 2]);
            const result = mutableMap(array, new Recorder());

            expect(result).not.toBe(array);
            expect(result).toEqual(array);
            expect(Object.isFrozen(result)).toBe(false);
          });

          it("returns an unfrozen copy of an unchanged frozen plain object", () => {
            const object = Object.freeze({ a: 1 });
            const result = mutableMap(object, new Recorder());

            expect(result).not.toBe(object);
            expect(result).toEqual(object);
            expect(Object.isFrozen(result)).toBe(false);
          });

          it("returns unfrozen copies of the unchanged containers inside a container", () => {
            const child = deepFreeze({ b: 2 });
            const parent = deepFreeze({ a: child });
            const result = mutableMap(parent, new Recorder()) as {
              a: unknown;
            };

            expect(result.a).not.toBe(child);
            expect(result.a).toEqual(child);
            expect(Object.isFrozen(result.a)).toBe(false);
          });

          it("leaves the array it makes from mapped elements unfrozen", () => {
            const rec = new Recorder();
            rec.onPrimitive = () => mapTo("one");

            expect(Object.isFrozen(mutableMap([1], rec))).toBe(false);
          });

          it("returns a new instance for a deeply frozen instance whose state does not change", () => {
            const link = deepFreeze(new FabricLink({ id: "fid1:abc" }));
            const result = mutableMap(link, new Recorder());

            expect(result).toBeInstanceOf(FabricLink);
            expect(result).not.toBe(link);
            expect(Object.isFrozen(result)).toBe(false);
          });
        });
      });

      describe("containers the visitor returns `undefined` for", () => {
        it("maps a nested container to `undefined` when the visitor leaves `undefined` alone", () => {
          const rec = new Recorder();
          rec.onArray = (v) => (v.length === 1) ? undefined : DO_RECURSE_VALUES;
          const result = map([0, [1]], rec) as unknown[];

          expect(result.length).toBe(2);
          expect(result[1]).toBeUndefined();
        });

        it("maps a container to whatever the visitor maps `undefined` to", () => {
          const rec = new Recorder();
          rec.onPlainObject = (v) =>
            ("inner" in v) ? DO_RECURSE_VALUES : undefined;
          rec.onPrimitive = (v) =>
            (v === undefined) ? mapTo("gone") : undefined;

          expect(map({ inner: { a: 1 } }, rec)).toStrictEqual({
            inner: "gone",
          });
        });

        it("maps a root container to `undefined`", () => {
          const rec = new Recorder();
          rec.onArray = () => undefined;

          expect(map([1], rec)).toBeUndefined();
        });

        it("maps a container to `undefined` without freezing", () => {
          const rec = new Recorder();
          rec.onPlainObject = (v) => ("a" in v) ? undefined : DO_RECURSE_VALUES;
          const result = mutableMap({ b: { a: 1 } }, rec) as { b: unknown };

          expect(Object.hasOwn(result, "b")).toBe(true);
          expect(result.b).toBeUndefined();
        });

        it("maps an instance to `undefined`", () => {
          const rec = new Recorder();
          rec.onInstance = () => undefined;

          expect(map([error("boom")], rec)).toStrictEqual([undefined]);
        });

        it("throws when the codec refuses the `undefined` that an instance's declined state becomes", () => {
          const rec = new Recorder();
          rec.onPlainObject = () => undefined;

          expect(() => map(error("boom"), rec)).toThrow(
            /Codec of .* refused replacement state `undefined`/,
          );
        });

        it("maps a cyclic reference to `undefined` when `visitCycle()` returns `undefined`", () => {
          const rec = new Recorder();
          rec.onCycle = () => undefined;
          const array: unknown[] = [1];
          array.push(array);
          const result = map(array, rec) as unknown[];

          expect(result).toStrictEqual([1, undefined]);
        });

        it("visits `undefined` in a plain visit, in place of the container", () => {
          const rec = new Recorder();
          rec.onArray = (v) => (v.length === 1) ? undefined : DO_RECURSE_VALUES;
          const inner = [1];

          visit([0, inner], rec);
          expect(rec.events.map((e) => e[1])).not.toContain(1);
          expect(
            rec.events.filter((e) => e[0] === "value").map((e) => e[1]),
          ).toStrictEqual([[0, inner], 0, inner, undefined]);
        });

        it("does not visit `undefined` in a plain visit for a container the visitor returns `mapTo` for", () => {
          const rec = new Recorder();
          rec.onArray = (v) =>
            (v.length === 1) ? mapTo(undefined) : DO_RECURSE_VALUES;
          const inner = [1];

          expect(visit([0, inner], rec)).toBeUndefined();
          expect(
            rec.events.filter((e) => e[0] === "value").map((e) => e[1]),
          ).toStrictEqual([[0, inner], 0, inner]);
        });
      });
    });
  });
});
