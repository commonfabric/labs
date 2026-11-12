import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { prepareBoundaryCommit } from "../../src/cfc/prepare.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const alice = await Identity.fromPassphrase("cfc-creator-record-alice");
const bob = await Identity.fromPassphrase("cfc-creator-record-bob");

describe("prepareBoundaryCommit()", () => {
  // `prepareBoundaryCommit()` returns these reasons from the record of a
  // piece's creator, the `creator` meta field (specs#87, pending).

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: alice });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  /** A new document in `tx` that the transaction brings into being as a piece. */
  const newPiece = (name: string) => {
    const cell = runtime.getCell(alice.did(), name, undefined, tx);
    cell.set({ count: 0 });
    cell.setMetaRaw("patternIdentity", "pattern", rawMetaWriteAuthorization);
    return cell;
  };

  it("returns no reason for the creator the runtime recorded on a piece this transaction creates", () => {
    const cell = newPiece("recorded");
    cell.setMetaRaw("creator", alice.did(), rawMetaWriteAuthorization);
    const { space, id } = cell.getAsNormalizedFullLink();
    tx.markCfcPieceCreator(
      runtimeWritePolicyAuthorization,
      { space, id },
      alice.did(),
    );
    expect(prepareBoundaryCommit(tx)).toEqual([]);
  });

  it("returns a reason for a creator the runtime recorded no such record of", () => {
    const cell = newPiece("unrecorded");
    cell.setMetaRaw("creator", alice.did(), rawMetaWriteAuthorization);
    const { space, id } = cell.getAsNormalizedFullLink();
    // The runtime recorded another principal as the creator.
    tx.markCfcPieceCreator(
      runtimeWritePolicyAuthorization,
      { space, id },
      bob.did(),
    );
    expect(prepareBoundaryCommit(tx)).toContain(
      `cfc-verdict: creator record for ${id}: the runtime recorded no such creator`,
    );
  });

  it("returns a reason for a write to a part of the field", async () => {
    // A creator stored as a record, which a store written without
    // enforcement can hold, is the one a write can reach a part of.
    const unenforced = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const seed = unenforced.edit();
      const stored = unenforced.getCell(
        alice.did(),
        "partial",
        undefined,
        seed,
      );
      stored.set({ count: 0 });
      stored.setMetaRaw(
        "creator",
        { did: bob.did() },
        rawMetaWriteAuthorization,
      );
      expect((await seed.commit().settled).error).toBeUndefined();
    } finally {
      await unenforced.dispose({ closeStorage: false });
    }

    const cell = runtime.getCell(alice.did(), "partial", undefined, tx);
    const { space, id } = cell.getAsNormalizedFullLink();
    tx.writeOrThrow(
      { space, id, path: ["creator", "did"] },
      alice.did(),
      rawMetaWriteAuthorization,
    );
    expect(prepareBoundaryCommit(tx)).toEqual([
      `cfc-verdict: creator record for ${id}: the field is written whole or not at all`,
    ]);
  });
});
