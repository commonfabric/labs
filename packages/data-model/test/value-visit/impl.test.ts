import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze } from "@/deep-freeze.ts";
import {
  DefaultValueVisitor,
  makeMapValueFunction,
  makeVisitValueFunction,
  mapValue,
  type VisitResult,
  visitValue,
} from "@/value-visit";
import {
  makeMutableMapValueFunction,
  mutableMapValue,
} from "@/value-visit/impl.ts";

import { mainResult, mapTo, Recorder } from "./Recorder.ts";

describe("value-visit/impl", () => {
  describe("mapValue()", () => {
    it("maps the value with the given visitor", () => {
      const rec = new Recorder();
      rec.onPrimitive = () => mapTo("one");

      expect(mapValue([1], rec)).toEqual(["one"]);
      expect(rec.names).toEqual([
        "value",
        "array",
        "visitingFabricArrayElement",
        "value",
        "primitive",
        "mappedFabricArrayElement",
      ]);
    });

    it("returns the value itself when the visitor changes nothing and the value is deeply frozen", () => {
      const value = deepFreeze({ a: [1] });

      expect(mapValue(value, new Recorder())).toBe(value);
    });

    it("returns a deeply frozen result", () => {
      const result = mapValue({ a: [1] }, new Recorder()) as { a: unknown };

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.a)).toBe(true);
    });
  });

  describe("makeMapValueFunction()", () => {
    it("returns a function that maps with the bound visitor", () => {
      const rec = new Recorder();
      rec.onPrimitive = () => mapTo("one");
      const map = makeMapValueFunction(rec);

      expect(map([1])).toEqual(["one"]);
      expect(map({ a: 2 })).toEqual({ a: "one" });
    });

    it("returns a function whose results are frozen", () => {
      const map = makeMapValueFunction(new Recorder());

      expect(Object.isFrozen(map([1]))).toBe(true);
    });
  });

  describe("mutableMapValue()", () => {
    it("maps the value with the given visitor", () => {
      const rec = new Recorder();
      rec.onPrimitive = () => mapTo("one");

      expect(mutableMapValue([1], rec)).toEqual(["one"]);
      expect(rec.names).toEqual([
        "value",
        "array",
        "visitingFabricArrayElement",
        "value",
        "primitive",
        "mappedFabricArrayElement",
      ]);
    });

    it("returns an unfrozen copy of each container when the visitor changes nothing, even when the value is deeply frozen", () => {
      const value = deepFreeze({ a: [1] });
      const result = mutableMapValue(value, new Recorder()) as { a: unknown };

      expect(result).not.toBe(value);
      expect(result).toEqual(value);
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.a).not.toBe(value.a);
      expect(Object.isFrozen(result.a)).toBe(false);
    });
  });

  describe("makeMutableMapValueFunction()", () => {
    it("returns a function that maps with the bound visitor", () => {
      const rec = new Recorder();
      rec.onPrimitive = () => mapTo("one");
      const map = makeMutableMapValueFunction(rec);

      expect(map([1])).toEqual(["one"]);
      expect(map({ a: 2 })).toEqual({ a: "one" });
    });

    it("returns a function whose results are not frozen", () => {
      const map = makeMutableMapValueFunction(new Recorder());

      expect(Object.isFrozen(map(Object.freeze([1])))).toBe(false);
    });
  });

  describe("visitValue()", () => {
    it("visits the value with the given visitor", () => {
      const rec = new Recorder();

      visitValue([1], rec);
      expect(rec.names).toEqual([
        "value",
        "array",
        "visitingFabricArrayElement",
        "value",
        "primitive",
      ]);
    });

    it("returns `undefined` when no visitor produces a `mainResult`", () => {
      expect(visitValue({ a: [1] }, new Recorder())).toBeUndefined();
    });

    it("returns a value of the visitor's `ResultType`", () => {
      class FirstNumber extends DefaultValueVisitor<never, number> {
        override visitNumber(value: number): VisitResult<never, number> {
          return mainResult(value);
        }

        override visitUnhandledValue(): VisitResult<never, number> {
          return undefined;
        }
      }

      const result: number = visitValue(
        ["x", 7, 8],
        new FirstNumber(),
      );

      expect(result).toBe(7);
    });

    it("refuses, at compile time, a value outside the visitor's domain, and throws at runtime", () => {
      // The compile-time refusal is half the point of this test: were the
      // call to type-check, the directive would be reported as unused and
      // the file would fail to compile. The line still runs, and the runtime
      // half is that the engine, told by `isPlusType()` that the value is
      // outside the domain, hands it to the visitor with the tag `null`, on
      // which `DefaultValueVisitor` throws.

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
