import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { isLinkRef } from "@commonfabric/data-model/cell-rep";
import { UnknownValue } from "@commonfabric/data-model/codec-common";
import {
  FabricError,
  FabricMap,
} from "@commonfabric/data-model/fabric-instances";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

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

    it("returns one `FabricError` for an error referenced twice", () => {
      const error = new Error("shared");
      const captured = stableFabricValue({ first: error, second: error }) as {
        first: FabricError;
        second: FabricError;
      };
      expect(captured.first).toBeInstanceOf(FabricError);
      expect(captured.second).toBe(captured.first);
      const distinct = stableFabricValue({
        first: error,
        second: new Error("shared"),
      }) as { first: FabricError; second: FabricError };
      expect(distinct.second).not.toBe(distinct.first);
    });
  });

  describe("given an array", () => {
    it("throws when it has an enumerable named property", () => {
      const named = Object.assign(["item"], { extra: true });
      expect(() => stableFabricValue(named)).toThrow(
        "Cannot store array with enumerable named properties",
      );
      expect(stableFabricValue(["item"])).toEqual(["item"]);
    });
  });

  describe("given an object with `toJSON()`", () => {
    it("throws when the conversion refers back to the object", () => {
      const looping = { toJSON: (): unknown => ({ back: looping }) };
      expect(() => stableFabricValue(looping)).toThrow(
        "Cannot store circular toJSON conversion",
      );
      const finite = { toJSON: () => ({ value: 1 }) };
      expect(stableFabricValue(finite)).toEqual({ value: 1 });
    });
  });

  describe("given a `FabricInstance`", () => {
    it("throws given an `UnknownValue` whose state refers back to it", () => {
      const state: { [key: string]: FabricValue } = {};
      const unknown = new UnknownValue("test@1", state);
      state.back = unknown;
      expect(() => stableFabricValue(unknown)).toThrow(
        "Cannot store circular reference",
      );
    });

    it("throws given a `FabricMap`, which cannot be deep-cloned yet", () => {
      const map = new FabricMap(new Map<FabricValue, FabricValue>([["a", 1]]));
      expect(() => stableFabricValue(map)).toThrow(
        "Cannot yet handle deep cloning of `FabricMap`",
      );
    });
  });

  describe("given a cell's query result", () => {
    it("returns a link to the cell", async () => {
      const signer = await Identity.fromPassphrase("stable value query result");
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const cell = runtime.getCell<{ value: number }>(signer.did(), {
          stableValueTest: "query-result",
        });
        await cell.sync();
        const tx = runtime.edit();
        cell.withTx(tx).set({ value: 1 });
        const committed = await tx.commit().settled;
        if (committed.error) throw committed.error;
        const captured = stableFabricValue({
          result: cell.getAsQueryResult(),
        }) as { result: unknown };
        expect(isLinkRef(captured.result)).toBe(true);
        expect(captured.result).toEqual(stableFabricValue(cell));
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
