/**
 * Abandoning the post-commit effects a transaction staged and lost.
 *
 * A post-commit effect has two outcomes and runs exactly one of them: `flush`
 * when its transaction commits, `abandon` when no further attempt at that
 * commit is coming. The decision belongs to whoever owns the retries, so the
 * transaction's part is narrow: dispatch once, never after a commit succeeded,
 * and never through a wrapper standing for work whose outcome nobody acts on.
 */

import { expect } from "@std/expect";

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import { createDuplicateWorkTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { CommitError } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const refusal = {
  name: "StorageTransactionAborted",
  message: "CFC enforcement rejected commit: relevant transaction was not " +
    "prepared: writer-fit confidentiality misfit",
} as CommitError;

describe("transaction abandon", () => {
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
    await runtime.dispose();
    await storageManager.close();
  });

  /** Stage an effect that records which of its two outcomes ran. */
  function stageEffect(
    tx: ReturnType<Runtime["edit"]>,
    id: string,
    seen: string[],
    options: { throws?: boolean } = {},
  ): void {
    tx.enqueuePostCommitEffect({
      id,
      kind: "test-effect",
      flush: () => {
        seen.push(`flush:${id}`);
      },
      abandon: (error) => {
        if (options.throws) throw new Error("abandon failed");
        seen.push(`abandon:${id}:${(error as { message?: string })?.message}`);
      },
    });
  }

  it("abandons each staged effect once, with the error", () => {
    const tx = runtime.edit();
    const seen: string[] = [];
    stageEffect(tx, "a", seen);
    stageEffect(tx, "b", seen);
    tx.abort(new Error("rejected before storage"));

    tx.abandonStagedWork(refusal);
    tx.abandonStagedWork(refusal);

    expect(seen).toEqual([
      `abandon:a:${refusal.message}`,
      `abandon:b:${refusal.message}`,
    ]);
  });

  it("abandons the remaining effects when one throws", () => {
    const tx = runtime.edit();
    const seen: string[] = [];
    stageEffect(tx, "a", seen, { throws: true });
    stageEffect(tx, "b", seen);
    tx.abort(new Error("rejected before storage"));

    tx.abandonStagedWork(refusal);

    expect(seen).toEqual([`abandon:b:${refusal.message}`]);
  });

  it("abandons one effect per outbox key, however often it is staged", () => {
    const tx = runtime.edit();
    const seen: string[] = [];
    stageEffect(tx, "a", seen);
    stageEffect(tx, "a", seen);
    tx.abort(new Error("rejected before storage"));

    tx.abandonStagedWork(refusal);

    expect(seen).toEqual([`abandon:a:${refusal.message}`]);
  });

  it("abandons nothing once a commit of the transaction succeeded", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell<string>(space, "abandon-after-commit", {
      type: "string",
    }, tx);
    cell.withTx(tx).set("written");
    const seen: string[] = [];
    stageEffect(tx, "a", seen);

    runtime.prepareTxForCommit(tx);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    tx.abandonStagedWork(refusal);

    // The effect flushed, so its request was sent; reporting it as never sent
    // would be a lie about a commit that landed, and would run the second of
    // two outcomes that admit only one.
    expect(seen).toEqual(["flush:a"]);
  });

  it("does not abandon the wrapped transaction through duplicate work", () => {
    const tx = runtime.edit();
    const seen: string[] = [];
    stageEffect(tx, "a", seen);
    tx.abort(new Error("rejected before storage"));
    const duplicate = createDuplicateWorkTransaction(tx);

    duplicate.abandonStagedWork(refusal);

    expect(seen).toEqual([]);
    tx.abandonStagedWork(refusal);
    expect(seen).toEqual([`abandon:a:${refusal.message}`]);
  });
});
