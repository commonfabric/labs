import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FABRIC_VALUE_PLUS_TAGS,
  type FabricValuePlusTag,
  JS_PRIMITIVE_TYPE_VALUE_TAGS,
  type JsPrimitiveTypeValueTag,
} from "@";
import { FabricMap } from "@/fabric-instances";
import { FABRIC_PRIMITIVE_VALUE_TAGS } from "@/fabric-primitives";
import { FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY } from "@/for-testing-only.ts";
import {
  DefaultValueVisitor,
  DO_RECURSE_VALUES,
  type VisitResult,
  visitValue,
} from "@/value-visit";

import { mainResult } from "./Recorder.ts";

/** One recorded call: the method's name, then its arguments. */
type Call = [name: string, ...args: unknown[]];

/**
 * Every `visit*()` method `DefaultValueVisitor` defines other than
 * `visitValue()` itself: one per tag, one for an unrecognized value, and the
 * categories those roll up to.
 */
const TRACED_METHODS = [
  "visitAnyValue",
  "visitBigint",
  "visitBoolean",
  "visitFabricArray",
  "visitFabricBytes",
  "visitFabricContainerValue",
  "visitFabricEpochDay",
  "visitFabricEpochNsec",
  "visitFabricHash",
  "visitFabricInstance",
  "visitFabricKeyPair",
  "visitFabricPlainObject",
  "visitFabricPrimitiveValue",
  "visitFabricRegExp",
  "visitFabricUnavailable",
  "visitJsPrimitiveValue",
  "visitNull",
  "visitNumber",
  "visitPlusType",
  "visitPrimitiveValue",
  "visitString",
  "visitSymbol",
  "visitUndefined",
  "visitUnrecognizedValue",
] as const;

type TracedMethod = typeof TRACED_METHODS[number];

// deno-lint-ignore no-explicit-any
type AnyMethod = (this: Tracing, ...args: any[]) => unknown;

/**
 * Visitor whose domain is `FabricValue` plus `Date`, and which records each
 * call to a traced method before deferring to the default implementation.
 */
class Tracing extends DefaultValueVisitor<Date, unknown> {
  readonly calls: Call[] = [];

  override isPlusType(value: unknown): value is Date {
    return value instanceof Date;
  }
}

for (const name of TRACED_METHODS) {
  const original = DefaultValueVisitor.prototype[name] as AnyMethod;
  const traced: AnyMethod = function (...args) {
    this.calls.push([name, ...args]);
    return original.apply(this, args);
  };

  (Tracing.prototype as unknown as Record<TracedMethod, AnyMethod>)[name] =
    traced;
}

/** Calls `visitValue()` on a fresh `Tracing`, returning it and the result. */
function trace(
  value: unknown,
  tag: FabricValuePlusTag | null,
): { vis: Tracing; result: VisitResult<Date, unknown> } {
  const vis = new Tracing();
  const result = vis.visitValue(value as Date, tag);

  return { vis, result };
}

/** The part of a primitive's chain after its category method. */
function primitiveTail(value: unknown, tag: string): Call[] {
  return [
    ["visitPrimitiveValue", value, tag],
    ["visitAnyValue", value, tag],
  ];
}

/**
 * For each JS primitive tag: a value, the specific method it goes to, and the
 * arguments that method takes. Held to the tag table by `satisfies`, so a tag
 * added there fails to compile until it has a row here.
 */
const JS_PRIMITIVE_CASES = {
  bigint: [123n, "visitBigint", [123n]],
  boolean: [true, "visitBoolean", [true]],
  null: [null, "visitNull", []],
  number: [5, "visitNumber", [5]],
  string: ["x", "visitString", ["x"]],
  symbol: [Symbol.for("s"), "visitSymbol", [Symbol.for("s")]],
  undefined: [undefined, "visitUndefined", []],
} satisfies Record<
  JsPrimitiveTypeValueTag,
  [value: unknown, method: TracedMethod, args: unknown[]]
>;

/**
 * One case per tag: a label, a value, its tag, the calls expected in order, and
 * the expected result.
 */
const CASES: [string, unknown, FabricValuePlusTag, Call[], unknown][] = [];

for (const tag of Object.values(JS_PRIMITIVE_TYPE_VALUE_TAGS)) {
  const [value, method, args] = JS_PRIMITIVE_CASES[tag];

  CASES.push([`the tag \`${tag}\``, value, tag, [
    [method, ...args],
    ["visitJsPrimitiveValue", value, tag],
    ...primitiveTail(value, tag),
  ], undefined]);
}

for (
  const [name, [value]] of Object.entries(
    FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY,
  )
) {
  const tag = FABRIC_PRIMITIVE_VALUE_TAGS[
    name as keyof typeof FABRIC_PRIMITIVE_VALUE_TAGS
  ];

  CASES.push([`the tag \`${tag}\``, value, tag, [
    [`visit${name}`, value],
    ["visitFabricPrimitiveValue", value, tag],
    ...primitiveTail(value, tag),
  ], undefined]);
}

{
  const array = [1];
  const object = { a: 1 };
  const instance = new FabricMap(new Map());
  const date = new Date(0);

  CASES.push(
    ["the tag `Array`", array, "Array", [
      ["visitFabricArray", array],
      ["visitFabricContainerValue", array, "Array"],
    ], DO_RECURSE_VALUES],
    ["the tag `Object`", object, "Object", [
      ["visitFabricPlainObject", object],
      ["visitFabricContainerValue", object, "Object"],
    ], DO_RECURSE_VALUES],
    ["the tag `FabricInstance`", instance, "FabricInstance", [
      ["visitFabricInstance", instance],
      ["visitFabricContainerValue", instance, "FabricInstance"],
    ], DO_RECURSE_VALUES],
    ["the tag `PlusType`", date, "PlusType", [
      ["visitPlusType", date],
      ["visitAnyValue", date, "PlusType"],
    ], undefined],
  );
}

describe("DefaultValueVisitor", () => {
  describe("instance members", () => {
    describe("visitValue()", () => {
      it("has a case for every `FabricValuePlus` tag", () => {
        // The cases are the domain only while they cover every tag, so the two
        // are held equal rather than the table being trusted.

        expect(new Set(CASES.map(([, , tag]) => tag))).toEqual(
          new Set(Object.values(FABRIC_VALUE_PLUS_TAGS)),
        );
      });

      for (const [label, value, tag, calls, result] of CASES) {
        it(`calls the method for ${label}, which rolls up through its categories`, () => {
          const traced = trace(value, tag);

          expect(traced.vis.calls).toEqual(calls);
          expect(traced.result).toBe(result);
        });
      }

      it("calls `visitUnrecognizedValue()` for the tag `null`, which throws an error naming the value", () => {
        const vis = new Tracing();
        const fn = () => 1;

        expect(() => vis.visitValue(fn as unknown as Date, null)).toThrow(
          /Cannot visit unrecognized value: /,
        );
        expect(vis.calls).toEqual([["visitUnrecognizedValue", fn]]);
      });

      it("returns what an overridden specific method returns, without reaching its category", () => {
        class Override extends Tracing {
          override visitNumber(): VisitResult<Date, unknown> {
            return mainResult("number!");
          }
        }

        const vis = new Override();

        expect(vis.visitValue(5, "number")).toEqual(mainResult("number!"));
        expect(vis.calls).toEqual([]);
      });

      it("returns what an overridden category method returns, for each tag in the category", () => {
        class Override extends Tracing {
          override visitJsPrimitiveValue(): VisitResult<Date, unknown> {
            return mainResult("js");
          }
        }

        for (const tag of Object.values(JS_PRIMITIVE_TYPE_VALUE_TAGS)) {
          const [value] = JS_PRIMITIVE_CASES[tag];

          expect(new Override().visitValue(value, tag)).toEqual(
            mainResult("js"),
          );
        }
      });
    });

    describe("the `visited*()` methods", () => {
      it("return `undefined`", () => {
        const vis = new Tracing();

        expect(vis.visitedFabricArrayElement([1], 0, 1)).toBeUndefined();
        expect(vis.visitedFabricInstanceState(new FabricMap(new Map()), {}))
          .toBeUndefined();
        expect(vis.visitedFabricPlainObjectEntry({}, "k", 1)).toBeUndefined();
      });
    });

    describe("the `visiting*()` methods", () => {
      it("return `undefined`", () => {
        const vis = new Tracing();

        expect(vis.visitingFabricArrayElement([1], 0, 1)).toBeUndefined();
        expect(vis.visitingFabricArrayGap([], 0, 1)).toBeUndefined();
        expect(vis.visitingFabricInstanceState(new FabricMap(new Map()), {}))
          .toBeUndefined();
        expect(vis.visitingFabricPlainObjectEntry({}, "k", 1)).toBeUndefined();
      });
    });
  });

  describe("as a visitor", () => {
    it("recurses into every kind of container by default", () => {
      class Strings extends DefaultValueVisitor<never, unknown> {
        readonly seen: string[] = [];

        override visitString(value: string): undefined {
          this.seen.push(value);
        }
      }

      const vis = new Strings();

      expect(visitValue({ a: ["x", { b: "y" }], c: "z" }, vis)).toBeUndefined();
      expect(vis.seen).toEqual(["x", "y", "z"]);
    });

    it("routes a value `isPlusType()` claims to `visitPlusType()`", () => {
      const vis = new Tracing();
      const date = new Date(0);

      visitValue([date], vis);
      expect(vis.calls.filter(([name]) => name === "visitPlusType")).toEqual([
        ["visitPlusType", date],
      ]);
    });

    it("throws for a value `isPlusType()` does not claim", () => {
      expect(() => visitValue([() => 1] as unknown as Date[], new Tracing()))
        .toThrow(/Cannot visit unrecognized value: /);
    });

    it("throws on a cycle", () => {
      const value: unknown[] = [];
      value.push(value);

      expect(() => visitValue(value as Date[], new Tracing())).toThrow(
        /Cannot visit cyclic value: /,
      );
    });
  });
});
