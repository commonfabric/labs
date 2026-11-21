import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import { WrittenValuePaths } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-written-value-paths");
const space = signer.did();

describe("WrittenValuePaths", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const newRuntime = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    return runtime;
  };

  const address = (id: string) => ({
    space,
    scope: "space" as const,
    id: `of:${id}` as URI,
    path: [] as string[],
  });

  describe("instance members", () => {
    describe("of()", () => {
      it("returns the value paths written on the target, in the order they were written", () => {
        const tx = newRuntime().edit();
        try {
          const first = address("first");
          const second = address("second");
          tx.writeOrThrow({ ...first, path: ["value", "b"] }, 1);
          tx.writeOrThrow({ ...second, path: ["value", "x"] }, 2);
          tx.writeOrThrow({ ...first, path: ["value", "a", "deep"] }, 3);
          const paths = new WrittenValuePaths(tx);

          expect(paths.of(first)).toEqual([["b"], ["a", "deep"]]);
          expect(paths.of(second)).toEqual([["x"]]);
        } finally {
          tx.abort();
        }
      });

      it("returns no path for a document the transaction did not write", () => {
        const tx = newRuntime().edit();
        try {
          tx.writeOrThrow({ ...address("written"), path: ["value"] }, 1);

          expect(new WrittenValuePaths(tx).of(address("other"))).toEqual([]);
        } finally {
          tx.abort();
        }
      });

      it("includes a path written after an earlier ask, and leaves what that ask returned as it was", () => {
        const tx = newRuntime().edit();
        try {
          const target = address("grows");
          tx.writeOrThrow({ ...target, path: ["value", "a"] }, 1);
          const paths = new WrittenValuePaths(tx);
          const before = paths.of(target);
          tx.writeOrThrow({ ...target, path: ["value", "b"] }, 2);

          expect(paths.of(target)).toEqual([["a"], ["b"]]);
          expect(before).toEqual([["a"]]);
        } finally {
          tx.abort();
        }
      });
    });
  });
});
