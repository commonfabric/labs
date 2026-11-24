import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { ACLManager, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { deleteSpace } from "../lib/acl.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

describe("deleteSpace()", () => {
  let space: `did:${string}:${string}`;
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let pieces: PiecesController;

  beforeEach(async () => {
    const me = await Identity.fromPassphrase("cli delete-space tests");
    space = (await Identity.generate()).did();
    storageManager = StorageManager.emulate({ as: me });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    pieces = new PiecesController(
      createSession({ identity: me, spaceDid: space }),
      runtime,
    );
    resetWriteReceipts();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("throws the deletion's own failure, naming no write, for a space with no access list", async () => {
    let failure: unknown;
    const stderr = await captureStderr(async () => {
      try {
        await deleteSpace(
          { apiUrl: "https://toolshed.test", space, identity: "/keys/me.key" },
          space,
          { loadPieces: () => Promise.resolve(pieces) },
        );
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("No ACL initialized for space.");
    expect(String(failure)).not.toContain("cf acl remove");
    expect(stderr).toEqual([]);
    expect(await new ACLManager(runtime, space).get()).toBeNull();
  });
});
