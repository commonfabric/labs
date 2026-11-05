// Covers the Fabric-aware equality of `mapsEqual`. The helper compares stored
// read-value maps with `valueEqual`, the content equality: a `FabricPrimitive`
// keeps its state in private `#fields` with zero enumerable own-props, so only
// a content-aware comparison can tell two distinct same-class instances apart.
// These tests pin that maps differing only in a `FabricBytes` value are
// unequal, and equal-content ones equal.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { mapsEqual } from "../src/scheduler/topology.ts";

describe("mapsEqual", () => {
  it("treats maps equal when values are structurally equal", () => {
    const a = new Map<string, FabricValue>([["k", 1]]);
    const b = new Map<string, FabricValue>([["k", 1]]);
    expect(mapsEqual(a, b)).toBe(true);
  });

  it("treats maps unequal when a plain value differs", () => {
    const a = new Map<string, FabricValue>([["k", 1]]);
    const b = new Map<string, FabricValue>([["k", 2]]);
    expect(mapsEqual(a, b)).toBe(false);
  });

  it("is Fabric-aware: equal FabricBytes values keep the maps equal", () => {
    const a = new Map<string, FabricValue>([
      ["k", new FabricBytes(new Uint8Array([1, 2, 3]))],
    ]);
    const b = new Map<string, FabricValue>([
      ["k", new FabricBytes(new Uint8Array([1, 2, 3]))],
    ]);
    expect(mapsEqual(a, b)).toBe(true);
  });

  it("is Fabric-aware: a differing FabricBytes value makes the maps unequal (CT-1770)", () => {
    // The two maps differ only in the (private `#fields`) byte content of a
    // `FabricBytes` value: a real change, which the content comparison must
    // report as unequal.
    const a = new Map<string, FabricValue>([
      ["k", new FabricBytes(new Uint8Array([1, 2, 3]))],
    ]);
    const b = new Map<string, FabricValue>([
      ["k", new FabricBytes(new Uint8Array([4, 5, 6]))],
    ]);
    expect(mapsEqual(a, b)).toBe(false);
  });
});
