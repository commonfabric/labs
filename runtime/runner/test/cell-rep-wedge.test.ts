/**
 * Exercises the modern-cell-rep flag end to end at the `Cell.entityId` →
 * `createRef`/`hashOf` boundary that the `map`/`filter`/`flatMap` builtins use
 * to derive result-cell addresses. The serialized entity-id reference's shape
 * is itself a hash input, so flipping the flag re-points those derived
 * addresses — the storage-affecting change the flag gates.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import {
  type EntityRef,
  entityRefToString,
  resetModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { Runtime } from "../src/runtime.ts";
import { createRef } from "../src/create-ref.ts";

const signer = await Identity.fromPassphrase("cell-rep wedge");
const space = signer.did();

describe("modern-cell-rep wedge", () => {
  afterEach(() => {
    resetModernCellRepConfig();
  });

  /** Builds a runtime in the requested regime and reads a fixed cell's id. */
  async function withCellEntityId<T>(
    modernCellRep: boolean,
    fn: (entityId: EntityRef) => T,
  ): Promise<T> {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { modernCellRep },
    });
    const tx = runtime.edit();
    try {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "wedge-fixed-id",
        undefined,
        tx,
      );
      return fn(cell.entityId);
    } finally {
      await tx.commit().settled;
      await runtime.dispose();
      await storageManager.close();
    }
  }

  it('flag OFF: entityId is a plain `{ "/": string }` object', async () => {
    await withCellEntityId(false, (entityId) => {
      expect(entityId).not.toBeInstanceOf(FabricHash);
      expect(typeof (entityId as { "/": string })["/"]).toBe("string");
    });
  });

  it("flag ON: entityId is a straight FabricHash", async () => {
    await withCellEntityId(true, (entityId) => {
      expect(entityId).toBeInstanceOf(FabricHash);
    });
  });

  it("names the same cell in both regimes (same tagged hash)", async () => {
    const legacyTagged = await withCellEntityId(false, entityRefToString);
    const modernTagged = await withCellEntityId(true, entityRefToString);
    expect(modernTagged).toBe(legacyTagged);
  });

  it("re-points derived addresses when the flag flips", async () => {
    const cause = "fixed-cause";
    const legacyDerived = await withCellEntityId(
      false,
      (entityId) => createRef({ map: entityId }, cause).taggedHashString,
    );
    const modernDerived = await withCellEntityId(
      true,
      (entityId) => createRef({ map: entityId }, cause).taggedHashString,
    );
    // Same underlying cell, same cause — only the reference form differs, and
    // that difference must propagate into the derived address.
    expect(modernDerived).not.toBe(legacyDerived);
  });
});
