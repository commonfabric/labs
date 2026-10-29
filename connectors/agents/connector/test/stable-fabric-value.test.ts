import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";

import { stableFabricValue } from "../src/stable-fabric-value.ts";

describe("stableFabricValue()", () => {
  describe("given an `Error`", () => {
    it("returns a `FabricError` whose `cause` and extras are converted", () => {
      const error = Object.assign(
        new Error("outer", { cause: new Error("inner") }),
        { when: new Date(0) },
      );
      const captured = stableFabricValue(error) as FabricError;
      expect(captured).toBeInstanceOf(FabricError);
      expect(captured.cause).toBeInstanceOf(FabricError);
      expect((captured.cause as FabricError).message).toBe("inner");
      expect(captured.getExtra("when")).toBeInstanceOf(FabricEpochNsec);
    });

    it("throws given a cycle through `cause`", () => {
      const error = new Error("loop") as Error & { cause: unknown };
      error.cause = { back: error };
      expect(() => stableFabricValue(error)).toThrow("circular reference");
    });
  });
});
