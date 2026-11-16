import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  deepFreeze,
  estimateFabricValueSize,
  type FabricContainerValue,
  type FabricValue,
  forEachFabricContainerValue,
} from "@commonfabric/data-model";
import { UnknownValue } from "@commonfabric/data-model/codec-common";
import {
  FabricBytes,
  FabricEpochDay,
} from "@commonfabric/data-model/fabric-primitives";

describe("forEachFabricContainerValue", () => {
  it("weighs payloads and instance state without copying frozen graphs", () => {
    const payload = "x".repeat(100_000);
    const shared = deepFreeze({ payload });
    const root = deepFreeze({ left: shared, right: shared });
    const weight = estimateFabricValueSize(root);
    expect(weight).toBeGreaterThan(payload.length * 2);
    expect(weight).toBeLessThan(payload.length * 3);
    expect(estimateFabricValueSize(root)).toBe(weight);
    expect(estimateFabricValueSize(new UnknownValue("Size@1", payload)))
      .toBeGreaterThan(payload.length * 2);
    const mutable = { payload: "small" };
    const before = estimateFabricValueSize(mutable);
    mutable.payload = payload;
    expect(estimateFabricValueSize(mutable)).toBeGreaterThan(before);
  });

  describe("estimateFabricValueSize()", () => {
    it("returns the same fixed weight for every number, boolean, `null` and `undefined`", () => {
      const weight = estimateFabricValueSize(0);
      expect([1e300, true, null, undefined].map(estimateFabricValueSize))
        .toEqual([weight, weight, weight, weight]);
      expect(estimateFabricValueSize("")).not.toBe(weight);
    });

    it("returns a weight for a bigint growing with its digits", () => {
      expect(estimateFabricValueSize(0xffffn) - estimateFabricValueSize(0xfn))
        .toBe(3);
    });

    it("returns a weight for bytes growing with their length", () => {
      const bytes = (length: number) =>
        estimateFabricValueSize(new FabricBytes(new Uint8Array(length)));
      expect(bytes(1000) - bytes(0)).toBe(1000);
      expect(bytes(1000)).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });

    it("returns the largest safe integer for an opaque primitive", () => {
      expect(estimateFabricValueSize(new FabricEpochDay(1n))).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("returns a weight for a symbol growing with its registry key", () => {
      expect(
        estimateFabricValueSize(Symbol.for("abcd")) -
          estimateFabricValueSize(Symbol.for("")),
      ).toBe(8);
    });

    it("returns a weight for a cycle counting the reference back as nothing", () => {
      const cyclic: Record<string, FabricValue> = {};
      cyclic.self = cyclic;
      expect(estimateFabricValueSize(cyclic) + estimateFabricValueSize(null))
        .toBe(estimateFabricValueSize({ self: null }));
    });
  });

  it("visits shared containers once, including instance codec state", () => {
    const child = deepFreeze({ count: 1 });
    const state = deepFreeze({ child });
    const instance = new UnknownValue("TraversalFixture@1", state);
    const root = { left: child, right: child, instance };
    const visited: FabricContainerValue[] = [];
    forEachFabricContainerValue(root, (value) => visited.push(value));
    expect(visited.filter((value) => value === child)).toHaveLength(1);
    expect(visited).toContain(instance);
    expect(visited).toContain(state);
    expect(Object.isFrozen(root)).toBe(false);
  });

  it("visits each identity once when cycles are allowed", () => {
    const child: Record<string, FabricValue> = {};
    const value = { child, again: child };
    child.parent = value;
    const visited: FabricContainerValue[] = [];
    forEachFabricContainerValue(value, (node) => visited.push(node), {
      allowCycles: true,
    });
    expect(visited).toEqual([value, child]);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it("rejects cycles without mutating the graph", () => {
    const value: Record<string, FabricValue> = {};
    value.self = value;
    expect(() => forEachFabricContainerValue(value, () => {})).toThrow(
      /cyclic/,
    );
    expect(value.self).toBe(value);
    expect(Object.isFrozen(value)).toBe(false);
  });
});
