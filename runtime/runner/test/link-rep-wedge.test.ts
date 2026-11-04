/**
 * Exercises the modern-cell-rep flag end to end at the link boundary: the
 * representation a `Cell` hands out for `getAsLink`, and — crucially — that a
 * link written into storage round-trips and still resolves. In modern mode a
 * link is a {@link FabricLink} instance stored as one atomic leaf, so the
 * storage path-walk that link resolution relies on must find it without the
 * legacy `{ "/": { "link@1": … } }` sub-tree to descend into.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import {
  isLinkRef,
  linkRefPayload,
  resetModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("link-rep wedge");
const space = signer.did();

describe("modern-cell-rep link wedge", () => {
  afterEach(() => {
    // Runtime.dispose already resets, but guard against an early failure that
    // skips disposal from leaking the flag into the next test.
    resetModernCellRepConfig();
  });

  /** Runs `fn` against a runtime built in the requested regime. */
  async function withRuntime(
    modernCellRep: boolean,
    fn: (runtime: Runtime) => Promise<void>,
  ): Promise<void> {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { modernCellRep },
    });
    try {
      await fn(runtime);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  }

  it("flag ON: getAsLink() produces a FabricLink", async () => {
    await withRuntime(true, async (runtime) => {
      const tx = runtime.edit();
      const cell = runtime.getCell<{ value: number }>(
        space,
        "wedge-shape",
        undefined,
        tx,
      );
      cell.set({ value: 42 });

      const link = cell.getAsLink();
      expect(link).toBeInstanceOf(FabricLink);
      expect(isLinkRef(link)).toBe(true);
      expect(linkRefPayload(link).id).toMatch(/^of:/);

      await tx.commit().settled;
    });
  });

  it("flag OFF: getAsLink() produces the legacy envelope", async () => {
    await withRuntime(false, async (runtime) => {
      const tx = runtime.edit();
      const cell = runtime.getCell<{ value: number }>(
        space,
        "wedge-shape",
        undefined,
        tx,
      );
      cell.set({ value: 42 });

      const link = cell.getAsLink();
      expect(link).not.toBeInstanceOf(FabricLink);
      expect(isLinkRef(link)).toBe(true);
      expect(linkRefPayload(link).id).toMatch(/^of:/);

      await tx.commit().settled;
    });
  });

  it("flag ON: a stored FabricLink round-trips and resolves through storage", async () => {
    await withRuntime(true, async (runtime) => {
      const tx = runtime.edit();
      const target = runtime.getCell<string>(
        space,
        "wedge-target",
        undefined,
        tx,
      );
      target.set("linked content");
      const source = runtime.getCell<string>(
        space,
        "wedge-source",
        undefined,
        tx,
      );
      // The source cell's value is a link to the target.
      source.set(target);
      await tx.commit().settled;

      const readTx = runtime.edit();
      const sourceRead = runtime.getCell<string>(
        space,
        "wedge-source",
        undefined,
        readTx,
      );
      // The stored value decodes back to a FabricLink (an atomic leaf), not a
      // decomposed envelope.
      expect(sourceRead.getRawUntyped()).toBeInstanceOf(FabricLink);
      // Reading through follows the link — proving link resolution finds and
      // dereferences a modern FabricLink in the storage tree.
      expect(sourceRead.get()).toBe("linked content");
      readTx.abort();
    });
  });
});
