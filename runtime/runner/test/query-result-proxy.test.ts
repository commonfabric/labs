import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { getCellOrThrow } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("query-result-proxy");
const space = signer.did();

type Nested = { n?: Nested };

describe("query-result-proxy", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("nested views", () => {
    /** Returns the view `depth` levels below `view`. */
    const descend = (view: Nested, depth: number): Nested => {
      let current = view;
      for (let level = 0; level < depth; level++) current = current.n!;
      return current;
    };

    it("throws past the maximum depth of 100 nested views", () => {
      const value: Nested = {};
      let leaf = value;
      for (let level = 0; level < 102; level++) leaf = leaf.n = {};
      const cell = runtime.getCell<Nested>(space, "deep", undefined, tx);
      cell.set(value);
      const view = cell.getAsQueryResult();

      expect(descend(view, 100)).toBeDefined();
      expect(() => descend(view, 101)).toThrow(
        "Maximum recursion depth of 100 exceeded",
      );
    });
  });

  describe("getCellOrThrow()", () => {
    it("returns the cell behind a view", () => {
      const cell = runtime.getCell<{ a: number }>(
        space,
        "named",
        undefined,
        tx,
      );
      cell.set({ a: 1 });

      expect(getCellOrThrow(cell.getAsQueryResult()).getAsNormalizedFullLink())
        .toEqual(cell.getAsNormalizedFullLink());
    });

    it("throws for a value that is not a view", () => {
      expect(() => getCellOrThrow({ a: 1 })).toThrow(
        "Value is not a cell proxy",
      );
    });
  });
});
