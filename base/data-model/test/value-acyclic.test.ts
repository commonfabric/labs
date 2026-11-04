import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { assertAcyclicFabricValue, deepFreeze, type FabricValue } from "@";
import { UnknownValue } from "@/codec-common";

describe("assertAcyclicFabricValue", () => {
  it("accepts shared frozen subtrees without changing them", () => {
    const child = deepFreeze({ n: 1 });
    const root = { a: child, b: child };
    expect(() => assertAcyclicFabricValue(root)).not.toThrow();
    expect(Object.isFrozen(root)).toBe(false);
    expect(root.a).toBe(root.b);
    deepFreeze(root);
    expect(() => assertAcyclicFabricValue(root)).not.toThrow();
    expect(() => assertAcyclicFabricValue(root)).not.toThrow();
  });

  it("rejects mutable and frozen cycles including instance state", () => {
    const cyclic: Record<string, FabricValue> = {};
    cyclic.self = cyclic;
    expect(() => assertAcyclicFabricValue(cyclic)).toThrow(/cyclic/);
    deepFreeze(cyclic);
    expect(() => assertAcyclicFabricValue(cyclic)).toThrow(/cyclic/);
    const state: Record<string, FabricValue> = {};
    const instance = new UnknownValue("Test@1", state);
    state.self = instance;
    deepFreeze(instance);
    expect(() => assertAcyclicFabricValue(instance)).toThrow(/cyclic/);
  });

  it("rechecks mutable graphs after a successful validation", () => {
    const value: Record<string, FabricValue> = {};
    assertAcyclicFabricValue(value);
    value.self = value;
    expect(() => assertAcyclicFabricValue(value)).toThrow(/cyclic/);
  });
});
