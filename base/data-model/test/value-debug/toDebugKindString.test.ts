import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { toDebugKindString } from "@";
import { FabricError, FabricMap } from "@/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@/fabric-primitives";

describe("toDebugKindString()", () => {
  it("renders `null` and `undefined` literally", () => {
    expect(toDebugKindString(null)).toBe("null");
    expect(toDebugKindString(undefined)).toBe("undefined");
  });

  it("renders plain objects as 'object'", () => {
    expect(toDebugKindString({})).toBe("object");
    expect(toDebugKindString({ a: 1 })).toBe("object");
    expect(toDebugKindString(Object.create(null))).toBe("object");
  });

  it("renders arrays as 'array'", () => {
    expect(toDebugKindString([])).toBe("array");
    expect(toDebugKindString([1, 2, 3])).toBe("array");
  });

  it("renders JS primitives as their typeof", () => {
    expect(toDebugKindString(42)).toBe("number");
    expect(toDebugKindString(42n)).toBe("bigint");
    expect(toDebugKindString("hi")).toBe("string");
    expect(toDebugKindString(true)).toBe("boolean");
    expect(toDebugKindString(Symbol("s"))).toBe("symbol");
    expect(toDebugKindString(() => {})).toBe("function");
  });

  it("renders FabricInstance subclasses with their constructor name", () => {
    expect(toDebugKindString(FabricError.fromNativeError(new Error("x"))))
      .toBe("FabricInstance (FabricError)");
    expect(toDebugKindString(new FabricMap(new Map())))
      .toBe("FabricInstance (FabricMap)");
  });

  it("renders FabricPrimitive subclasses with their constructor name", () => {
    expect(toDebugKindString(new FabricEpochNsec(123n)))
      .toBe("FabricPrimitive (FabricEpochNsec)");
    expect(toDebugKindString(new FabricBytes(new Uint8Array([1, 2, 3]))))
      .toBe("FabricPrimitive (FabricBytes)");
    expect(toDebugKindString(new FabricRegExp(/abc/g)))
      .toBe("FabricPrimitive (FabricRegExp)");
  });

  it("renders a non-`FabricSpecialObject` instance with its constructor name", () => {
    expect(toDebugKindString(new Date())).toBe("Date");
    expect(toDebugKindString(new Map())).toBe("Map");
    expect(toDebugKindString(new Set())).toBe("Set");
    expect(toDebugKindString(new Error("oops"))).toBe("Error");
    expect(toDebugKindString(/abc/)).toBe("RegExp");

    class Foo {}
    expect(toDebugKindString(new Foo())).toBe("Foo");
  });

  it("falls back to 'object' when constructor name is unavailable", () => {
    // An object whose prototype was sliced out has no usable
    // `constructor` chain; the predicate returns "object" as a final
    // fallback.

    const weird = Object.create({ constructor: undefined as unknown });
    expect(toDebugKindString(weird)).toBe("object");
  });
});
