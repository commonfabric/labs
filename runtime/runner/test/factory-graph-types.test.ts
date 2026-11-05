import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createFactoryShell } from "@commonfabric/data-model/fabric-factory";
import type { Node, Pattern } from "../src/builder/types.ts";

const factory = createFactoryShell({
  kind: "module",
  ref: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "factory",
  },
});

const node: Node = {
  module: { type: "passthrough" },
  inputs: factory,
  outputs: { nested: factory },
};

const patternResult: Pattern["result"] = { factory };

describe("factory graph payload types", () => {
  it("admit branded callable Fabric values without JSON casts", () => {
    expect(node.inputs).toBe(factory);
    expect(patternResult).toEqual({ factory });
  });
});
