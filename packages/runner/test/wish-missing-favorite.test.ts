import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

describe("wish favorite discovery", () => {
  it("excludes a confirmed missing favorite and selects the present match", async () => {
    const signer = await Identity.fromPassphrase("missing favorite discovery");
    const space = signer.did();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    let cancel: (() => void) | undefined;
    try {
      const tx = runtime.edit();
      const missing = runtime.getCell(space, "missing favorite");
      const present = runtime.getCell(space, "present favorite", undefined, tx);
      present.set({ version: 1, name: "Present provider" });
      runtime.getHomeSpaceCell(tx).key("defaultPattern").set({
        favorites: [
          { cell: missing, tags: ["resources"] },
          { cell: present, tags: ["resources"] },
        ],
      });
      expect((await tx.commit()).error).toBeUndefined();

      const { commonfabric } = createTrustedBuilder(runtime);
      const pattern = commonfabric.pattern(() => ({
        found: commonfabric.wish({
          query: "#resources",
          scope: ["~"],
          headless: true,
        }),
      }));
      const run = runtime.edit();
      const result = runtime.run(
        run,
        pattern,
        {},
        runtime.getCell<{
          found?: {
            candidates?: { name: string }[];
            result?: { name: string };
          };
        }>(space, "discovery consumer", undefined, run),
      );
      expect((await run.commit()).error).toBeUndefined();
      const found = result.key("found").resolveAsCell();
      cancel = found.sink(() => {});
      await result.pull();
      await storageManager.synced();
      await runtime.idle();
      expect(found.key("candidates").get()).toHaveLength(1);
      const selected = found.key("result").asSchema<
        { name: string }
      >({
        type: "object",
        properties: { name: { type: "string" } },
      });
      expect(selected.key("name").get()).toBe("Present provider");

      const favorites = runtime.getHomeSpaceCell().key("defaultPattern")
        .key("favorites");
      expect(favorites.get()).toHaveLength(2);

      const restore = runtime.edit();
      missing.withTx(restore).set({ version: 1, name: "Restored provider" });
      const rediscovered = runtime.run(
        restore,
        pattern,
        {},
        runtime.getCell(space, "fresh discovery consumer", undefined, restore),
      );
      expect((await restore.commit()).error).toBeUndefined();
      await rediscovered.pull();
      expect(rediscovered.key("found").key("candidates").get()).toHaveLength(2);
    } finally {
      cancel?.();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  it("reports no match when every tagged favorite is confirmed missing", async () => {
    const signer = await Identity.fromPassphrase("all missing favorites");
    const space = signer.did();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const setup = runtime.edit();
      runtime.getHomeSpaceCell(setup).key("defaultPattern").set({
        favorites: [{
          cell: runtime.getCell(space, "missing provider"),
          tags: ["resources"],
        }],
      });
      expect((await setup.commit()).error).toBeUndefined();
      const { commonfabric } = createTrustedBuilder(runtime);
      const pattern = commonfabric.pattern(() => ({
        found: commonfabric.wish({
          query: "#resources",
          scope: ["~"],
          headless: true,
        }),
      }));
      const tx = runtime.edit();
      const result = runtime.run(
        tx,
        pattern,
        {},
        runtime.getCell(space, "consumer", undefined, tx),
      );
      expect((await tx.commit()).error).toBeUndefined();
      await result.pull();
      await storageManager.synced();
      await runtime.idle();
      expect(
        result.key("found").key("error").asSchema({ type: "string" }).get(),
      ).toContain('No favorites found matching "#resources"');
      expect(result.key("found").key("candidates").get()).toHaveLength(0);
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });
});
