/** The pattern hash builtin uses the Fabric's canonical content addressing. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hashStringOf } from "@commonfabric/data-model";

import { createBuilder } from "../src/builder/factory.ts";
import { getRuntimeModuleExports } from "../src/sandbox/runtime-modules.ts";

describe("commonfabric hashStringOf builtin", () => {
  it("delivers the canonical hasher to authored patterns", () => {
    expect(createBuilder().commonfabric.hashStringOf).toBe(hashStringOf);
    expect(
      getRuntimeModuleExports().runtimeExports.commonfabric.hashStringOf,
    ).toBe(hashStringOf);
  });
});
