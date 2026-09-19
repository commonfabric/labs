import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Primitive } from "@commonfabric/utils/types";

import type { FabricPrimitive } from "@";
import {
  type BaselineVisitResult,
  BaseValueVisitor,
  type LeafVisitorResult,
  makeVisitValueFunction,
  RecursiveValueVisitor,
  visitValue,
} from "@/value-visit";

import { mainResult, Recorder } from "./Recorder.ts";

describe("value-visit/impl", () => {
  describe("visitValue()", () => {
    it("visits the value with the given visitor", () => {
      const rec = new Recorder();

      visitValue([1], rec);
      expect(rec.names).toEqual([
        "value",
        "container",
        "array",
        "value",
        "primitive",
        "visitedElement",
      ]);
    });

    it("returns `undefined` when no visitor produces a `mainResult`", () => {
      expect(visitValue({ a: [1] }, new Recorder())).toBeUndefined();
    });

    it("returns a `mainResult` typed by the visitor's `ResultType`", () => {
      class FirstNumber extends RecursiveValueVisitor<never, number> {
        override visitPrimitive(
          value: Primitive | FabricPrimitive,
        ): LeafVisitorResult<never, number> {
          return (typeof value === "number") ? mainResult(value) : undefined;
        }
      }

      const result: BaselineVisitResult<number> = visitValue(
        ["x", 7, 8],
        new FirstNumber(),
      );

      expect(result).toEqual(mainResult(7));
    });

    it("refuses, at compile time, a value outside the visitor's domain, and throws at runtime", () => {
      // The compile-time refusal is half the point of this test: were the
      // call to type-check, the directive would be reported as unused and
      // the file would fail to compile. The line still runs, and the runtime
      // half is that the engine, told by `isPlusType()` that the value is
      // outside the domain, throws the domain error rather than reaching
      // `visitPlusType()`, whose base implementation throws a different one.

      class Strict extends BaseValueVisitor<never, number> {}

      const vis = new Strict();
      const date = new Date(0);

      // @ts-expect-error A `Date` is not in a `never`-extra domain.
      expect(() => visitValue(date, vis)).toThrow(
        /Encountered a value outside of the visitor's domain: /,
      );
    });
  });

  describe("makeVisitValueFunction()", () => {
    it("returns a function that visits with the bound visitor", () => {
      const rec = new Recorder();
      const visit = makeVisitValueFunction(rec);

      expect(visit([1])).toBeUndefined();
      expect(rec.names).toContain("primitive");
    });
  });
});
