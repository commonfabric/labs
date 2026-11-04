import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { hashOf } from "@commonfabric/data-model";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { entityIdFrom } from "../src/create-ref.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner entityIdFrom tests");
const space = signer.did();

describe("entityIdFrom", () => {
  const bare = hashOf({ probe: "entityIdFrom" }).taggedHashString;

  it("returns the bare tagged hash for a bare tagged hash", () => {
    expect(entityIdFrom(bare).taggedHashString).toBe(bare);
    expect(entityIdFrom(bare).tag).toBe("fid1");
  });

  it("returns the same entity id for a bare hash and its `of:` URI", () => {
    const fromUri = entityIdFrom(`of:${bare}`);
    expect(fromUri.taggedHashString).toBe(bare);
    expect(fromUri.bytes).toEqual(entityIdFrom(bare).bytes);
  });

  it("returns the `FabricHash` it is handed", () => {
    const hash = hashOf({ probe: "entityIdFrom passthrough" });
    expect(entityIdFrom(hash)).toBe(hash);
  });

  it("throws for a `computed:` id, naming the address it was given", () => {
    // Refused rather than stripped: `computed:fid1:H` and `of:fid1:H` share
    // hash bytes and name different entities, so the bare hash is not a
    // complete identity to fall back on.
    expect(() => entityIdFrom(`computed:${bare}`)).toThrow(
      `Kinded entity id \`computed:${bare}\``,
    );
  });

  it("throws for a string that is no kind of tagged hash", () => {
    expect(() => entityIdFrom("my-board")).toThrow();
    expect(() => entityIdFrom("of:my board")).toThrow();
  });

  describe("addressing a cell", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("reaches one cell through a bare hash and through its `of:` URI", async () => {
      const cell = runtime.getCell(
        space,
        { space, random: "entity-uri-intake" },
      );
      await runtime.editWithRetry((tx) => {
        cell.withTx(tx).set({ value: 1 });
      });
      const id = entityRefToString(cell.entityId!);

      const viaHash = runtime.getCellFromEntityId(space, entityIdFrom(id));
      const viaUri = runtime.getCellFromEntityId(
        space,
        entityIdFrom(`of:${id}`),
      );

      await viaHash.sync();
      await viaUri.sync();
      expect(viaUri.equals(viaHash)).toBe(true);
      expect(viaUri.get()).toEqual({ value: 1 });

      // A write through one spelling is visible through the other, which is
      // the claim a shared entity id actually has to support.
      await runtime.editWithRetry((tx) => {
        viaUri.withTx(tx).set({ value: 2 });
      });
      expect(viaHash.get()).toEqual({ value: 2 });
    });
  });
});
