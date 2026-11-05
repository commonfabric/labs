/**
 * The JSON registry before any fabric class is added to it: what it already
 * knows, and what it deliberately does not.
 *
 * It carries only the types JSON itself cannot express, and marks JSON's own
 * scalars as needing no codec at all. No fabric class is in it, which is what
 * leaves the choice of participating classes to whoever extends it. Each call
 * builds a fresh registry and hands it back frozen, so extending means
 * deriving a new one rather than adding to something shared.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { SELF_REP } from "@/codec-common/CodecRegistry.ts";
import { createBaseJsonRegistry } from "@/codec-json";
import { FabricError } from "@/fabric-instances";

describe("createBaseJsonRegistry", () => {
  it("returns a frozen registry", () => {
    expect(Object.isFrozen(createBaseJsonRegistry())).toBe(true);
  });

  it("returns a registry that refuses further registration", () => {
    expect(() => createBaseJsonRegistry().registerSelfRep("string"))
      .toThrow("Cannot modify frozen `CodecRegistry`");
  });

  it("returns a fresh registry on each call", () => {
    expect(createBaseJsonRegistry()).not.toBe(createBaseJsonRegistry());
  });

  it("registers the four types JSON cannot carry", () => {
    const registry = createBaseJsonRegistry();

    expect(registry.codecFromValue(1n)).toBeDefined();
    expect(registry.codecFromValue(NaN)).toBeDefined();
    expect(registry.codecFromValue(Symbol.for("florp"))).toBeDefined();
    expect(registry.codecFromValue(undefined)).toBeDefined();
  });

  it("reports the JSON scalars as self-representing", () => {
    const registry = createBaseJsonRegistry();

    expect(registry.codecFromValue(null)).toBe(SELF_REP);
    expect(registry.codecFromValue(true)).toBe(SELF_REP);
    expect(registry.codecFromValue(1)).toBe(SELF_REP);
    expect(registry.codecFromValue("florp")).toBe(SELF_REP);
  });

  it("registers no fabric class", () => {
    const registry = createBaseJsonRegistry();
    const value = FabricError.fromNativeError(new Error("boom"));

    expect(registry.codecFromValue(value)).toBe(undefined);
  });
});
