import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type BaselineVisitorMethodResult,
  DefaultValueVisitor,
  type LeafVisitorResult,
  makeVisitValueFunction,
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
      class FirstNumber extends DefaultValueVisitor<never, number> {
        override visitNumber(value: number): LeafVisitorResult<never, number> {
          return mainResult(value);
        }
      }

      const result: BaselineVisitorMethodResult<number> = visitValue(
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
      // outside the domain, hands it to the visitor with the tag `null`, which
      // `DefaultValueVisitor` answers by throwing.

      class Strict extends DefaultValueVisitor<never, number> {}

      const vis = new Strict();
      const date = new Date(0);

      // @ts-expect-error A `Date` is not in a `never`-extra domain.
      expect(() => visitValue(date, vis)).toThrow(
        /Cannot visit unrecognized value: /,
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
