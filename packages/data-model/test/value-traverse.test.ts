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
