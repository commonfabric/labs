import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import { validateAndCheckReactives } from "../src/runner.ts";
import { isReactiveMarker } from "../src/builder/types.ts";
import { normalizeSandboxResult } from "../src/sandbox/result-normalization.ts";

describe("normalizeSandboxResult", () => {
  it("canonicalizes native leaves into `FabricValue`s", () => {
    const input = {
      bytes: new Uint8Array([1, 2, 3]),
      date: new Date(1_234),
      regexp: /fabric/gi,
      error: new TypeError("fabric"),
    };

    const normalized = normalizeSandboxResult(input);
    const value = normalized.value as Record<string, unknown>;
    expect(normalized.hasReactive).toBe(false);
    expect(value).not.toBe(input);
    expect(Object.isFrozen(value)).toBe(true);
    expect(value.bytes).toBeInstanceOf(FabricBytes);
    expect(Array.from((value.bytes as FabricBytes).slice())).toEqual([1, 2, 3]);
    expect(value.date).toBeInstanceOf(FabricEpochNsec);
    expect((value.date as FabricEpochNsec).value).toBe(1_234_000_000n);
    expect(value.regexp).toBeInstanceOf(FabricRegExp);
    expect((value.regexp as FabricRegExp).source).toBe("fabric");
    expect((value.regexp as FabricRegExp).flags).toBe("gi");
    expect(value.error).toBeInstanceOf(FabricError);
    expect((value.error as FabricError).type).toBe("TypeError");
  });

  it("preserves opaque leaves while normalizing their siblings", () => {
    const reactive = { [isReactiveMarker]: true };
    const cellLink = linkRefFrom({ id: "of:test" });
    const input = {
      reactive,
      cellLink,
      nested: { date: new Date(0) },
    };

    const normalized = normalizeSandboxResult(input);
    const value = normalized.value as Record<string, unknown>;
    expect(normalized.hasReactive).toBe(true);
    expect(value.reactive).toBe(reactive);
    expect(value.cellLink).toBe(cellLink);
    expect(
      (value.nested as Record<string, unknown>).date,
    ).toBeInstanceOf(FabricEpochNsec);
  });

  it("preserves shared references while copying realm containers", () => {
    const shared = { value: 1 };
    const normalized = normalizeSandboxResult({
      first: shared,
      second: shared,
    });
    const value = normalized.value as Record<string, unknown>;
    expect(value.first).toBe(value.second);
    expect(value.first).not.toBe(shared);
  });

  it("re-roots a bare null-prototype record, nested included", () => {
    // `Object.create(null)` is an ordinary way to build a dictionary, and a
    // pattern may return one. This boundary is a canonicalizing copy, so it
    // leaves in the one shape a `FabricPlainObject` has, rather than being
    // carried across intact and refused later by the conversion functions.
    const inner = Object.create(null) as Record<string, unknown>;
    inner.v = 42;
    const outer = Object.create(null) as Record<string, unknown>;
    outer.child = inner;
    outer.a = 1;

    const normalized = normalizeSandboxResult(outer);
    const value = normalized.value as Record<string, unknown>;

    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value.a).toBe(1);
    const child = value.child as Record<string, unknown>;
    expect(Object.getPrototypeOf(child)).toBe(Object.prototype);
    expect(child.v).toBe(42);
  });

  it("rejects custom instances with null-rooted prototypes", () => {
    class NullRooted {
      value = 1;
    }
    Object.setPrototypeOf(NullRooted.prototype, null);

    expect(() => normalizeSandboxResult(new NullRooted())).toThrow(
      /Action returned a NullRooted/,
    );
  });

  it("rejects enumerable state on realm-native leaves", () => {
    const date = new Date(0) as Date & { extra?: boolean };
    date.extra = true;
    expect(() => normalizeSandboxResult({ nested: date })).toThrow(
      /Action returned a Date at path "nested"[\s\S]*extra enumerable properties/,
    );

    const regexp = /fabric/ as RegExp & { extra?: boolean };
    regexp.extra = true;
    expect(() => normalizeSandboxResult({ nested: regexp })).toThrow(
      /Action returned a RegExp at path "nested"[\s\S]*extra enumerable properties/,
    );
  });

  it("does not trust spoofed intrinsic brands", () => {
    class FakeDate {
      get [Symbol.toStringTag](): string {
        return "Date";
      }
    }
    expect(() => normalizeSandboxResult(new FakeDate())).toThrow(
      /Action returned a FakeDate/,
    );

    class FakeRegExp {
      get [Symbol.toStringTag](): string {
        return "RegExp";
      }
    }
    expect(() => normalizeSandboxResult(new FakeRegExp())).toThrow(
      /Action returned a FakeRegExp/,
    );
  });

  it("rejects values whose intrinsic brand cannot be inspected", () => {
    class ThrowingBrand {
      get [Symbol.toStringTag](): string {
        throw new Error("brand unavailable");
      }
    }

    expect(() => normalizeSandboxResult(new ThrowingBrand())).toThrow(
      /Action returned a ThrowingBrand/,
    );
  });
});

describe("validateAndCheckReactives", () => {
  describe("valid values", () => {
    it("accepts null", () => {
      expect(validateAndCheckReactives(null)).toBe(false);
    });

    it("accepts undefined", () => {
      expect(validateAndCheckReactives(undefined)).toBe(false);
    });

    it("accepts primitives", () => {
      expect(validateAndCheckReactives("hello")).toBe(false);
      expect(validateAndCheckReactives(42)).toBe(false);
      expect(validateAndCheckReactives(true)).toBe(false);
      expect(validateAndCheckReactives(false)).toBe(false);
    });

    it("accepts every primitive admitted by the data model", () => {
      expect(validateAndCheckReactives(1n)).toBe(false);
      expect(validateAndCheckReactives(NaN)).toBe(false);
      expect(validateAndCheckReactives(Infinity)).toBe(false);
      expect(validateAndCheckReactives(-Infinity)).toBe(false);
      expect(validateAndCheckReactives(Symbol.for("action-result"))).toBe(
        false,
      );
    });

    it("accepts materializable special and JS objects", () => {
      expect(
        validateAndCheckReactives(
          new FabricBytes(new Uint8Array([1, 2, 3])),
        ),
      ).toBe(false);
      expect(validateAndCheckReactives(new Uint8Array([4, 5, 6]))).toBe(false);
      expect(validateAndCheckReactives(new Date(0))).toBe(false);
      expect(validateAndCheckReactives(/fabric/gi)).toBe(false);
      expect(validateAndCheckReactives(new Error("fabric"))).toBe(false);
    });

    it("accepts plain objects", () => {
      expect(validateAndCheckReactives({})).toBe(false);
      expect(validateAndCheckReactives({ a: 1, b: "hello" })).toBe(false);
    });

    it("accepts arrays", () => {
      expect(validateAndCheckReactives([])).toBe(false);
      expect(validateAndCheckReactives([1, 2, 3])).toBe(false);
      expect(validateAndCheckReactives([{ a: 1 }, { b: 2 }])).toBe(false);
    });

    it("accepts nested structures", () => {
      expect(
        validateAndCheckReactives({
          a: { b: { c: [1, 2, { d: "hello" }] } },
        }),
      ).toBe(false);
    });

    it("accepts cell links", () => {
      const cellLink = { "/": { [Symbol.for("cell-link")]: { id: "test" } } };
      expect(validateAndCheckReactives(cellLink)).toBe(false);
    });
  });

  describe("invalid values", () => {
    it("rejects Map", () => {
      expect(() => validateAndCheckReactives(new Map())).toThrow(
        /Action returned a Map[\s\S]*Consider using a plain object/,
      );
    });

    it("rejects Set", () => {
      expect(() => validateAndCheckReactives(new Set())).toThrow(
        /Action returned a Set[\s\S]*Consider using an array/,
      );
    });

    it("rejects functions", () => {
      expect(() => validateAndCheckReactives(() => {})).toThrow(
        /Action returned a function/,
      );
    });

    it("rejects unique Symbol", () => {
      expect(() => validateAndCheckReactives(Symbol("test"))).toThrow(
        /Action returned a Symbol[\s\S]*Consider removing this property/,
      );
    });

    it("rejects class instances without convertible-JS conversion", () => {
      class Unsupported {}
      expect(() => validateAndCheckReactives({ value: new Unsupported() }))
        .toThrow(/Action returned a Unsupported at path "value"/);
    });

    it("rejects circular references through data-model authority", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => validateAndCheckReactives(circular)).toThrow(
        /Actions must return FabricValues, Reactives, or Cells\.[\s\S]*Conversion refuses a circular reference/,
      );
    });

    it("rejects nested Map with path info", () => {
      expect(() => validateAndCheckReactives({ data: { items: new Map() } }))
        .toThrow(/Action returned a Map at path "data\.items"/);
    });

    it("rejects Map in array with path info", () => {
      expect(() => validateAndCheckReactives([1, 2, new Map()])).toThrow(
        /Action returned a Map at path "\[2\]"/,
      );
    });

    it("rejects Set in nested structure with path info", () => {
      expect(() =>
        validateAndCheckReactives({
          a: { b: [{ c: new Set() }] },
        })
      ).toThrow(/Action returned a Set at path "a\.b\.\[0\]\.c"/);
    });

    it("rejects function in object with path info", () => {
      expect(() => validateAndCheckReactives({ handler: () => {} })).toThrow(
        /Action returned a function at path "handler"/,
      );
    });

    it("states the FabricValue action contract", () => {
      expect(() => validateAndCheckReactives(new Map())).toThrow(
        /Actions must return FabricValues, Reactives, or Cells\./,
      );
    });
  });

  describe("action name in errors", () => {
    it("includes action name in error message", () => {
      expect(() =>
        validateAndCheckReactives(new Map(), "handleClick (src/app.ts:42)")
      ).toThrow(/in action: handleClick \(src\/app\.ts:42\)/);
    });

    it("includes action name with nested path", () => {
      expect(() =>
        validateAndCheckReactives(
          { data: new Set() },
          "onSubmit (components/Form.tsx:15)",
        )
      ).toThrow(
        /Action returned a Set at path "data".*in action: onSubmit \(components\/Form\.tsx:15\)/s,
      );
    });

    it("works without action name", () => {
      expect(() => validateAndCheckReactives(new Map())).toThrow(
        /Action returned a Map/,
      );
      // Should not include "in action:" when no name provided
      expect(() => validateAndCheckReactives(new Map())).not.toThrow(
        /in action:/,
      );
    });
  });

  describe("opaque ref detection", () => {
    it("returns true for opaque ref at top level", () => {
      const reactive = { [isReactiveMarker]: true };
      expect(validateAndCheckReactives(reactive)).toBe(true);
    });

    it("returns true when opaque ref is nested in object", () => {
      const reactive = { [isReactiveMarker]: true };
      expect(validateAndCheckReactives({ data: reactive })).toBe(true);
    });

    it("returns true when opaque ref is in array", () => {
      const reactive = { [isReactiveMarker]: true };
      expect(validateAndCheckReactives([1, reactive, 3])).toBe(true);
    });

    it("still rejects an invalid sibling after finding an opaque ref", () => {
      const reactive = { [isReactiveMarker]: true };
      expect(() => validateAndCheckReactives({ reactive, invalid: new Map() }))
        .toThrow(/Action returned a Map at path "invalid"/);
    });

    it("returns false when no opaque refs present", () => {
      expect(validateAndCheckReactives({ a: 1, b: "hello" })).toBe(false);
    });
  });
});
