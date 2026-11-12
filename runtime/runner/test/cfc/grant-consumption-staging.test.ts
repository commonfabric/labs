import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import {
  cfcGrantConsumedReceiptId,
  createTxCfcGrantResolver,
} from "../../src/cfc/grants.ts";
import { prepareBoundaryCommit } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc-grant-consumption-staging");
const bob = "did:key:bob";
const resource = "of:photo";

describe("prepareBoundaryCommit()", () => {
  // A transaction that consumes a single-use grant stages the grant's
  // consumption receipt as it is prepared (§6.5.2), and a receipt that cannot
  // be staged refuses the commit rather than releasing without consuming.

  /**
   * Prepares a transaction that consumes a single-use grant, after `before`
   * has staged what it likes into it, and returns the reasons and whether the
   * receipt was staged.
   */
  async function consume(
    before: (tx: IExtendedStorageTransaction) => void,
  ): Promise<{ reasons: readonly string[]; receipt: unknown }> {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      experimental: { commitPreconditions: true },
    });
    try {
      const grant = runtime.edit();
      setCfcImplementationIdentity(grant, {
        kind: "builtin",
        builtinId: "cfc-grant-writer",
      });
      const { id: grantId } = grant.writeCfcGrant({
        kind: "ShareGrant",
        owner: signer.did(),
        resource,
        audience: [cfcAtom.user(bob)],
        grantedAt: 1000,
        singleUse: true,
      });
      expect((await grant.commit().settled).error).toBeUndefined();

      const tx = runtime.edit();
      try {
        before(tx);
        expect(
          createTxCfcGrantResolver(tx)({
            kind: "ShareGrant",
            fields: { owner: signer.did(), resource },
            consumption: "consuming",
          }),
        ).toHaveLength(1);
        const reasons = prepareBoundaryCommit(tx);
        const receipt = tx.readOrThrow({
          space: signer.did(),
          id: cfcGrantConsumedReceiptId(grantId) as URI,
          type: "application/json",
          path: ["value"],
        });
        return { reasons, receipt };
      } finally {
        tx.abort();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  }

  it("returns no reason, and stages the receipt, for a transaction that can write it", async () => {
    const { reasons, receipt } = await consume(() => {});
    expect(reasons).toEqual([]);
    expect(receipt).toMatchObject({ grantConsumed: {} });
  });

  it("returns a reason for a receipt the transaction cannot stage", async () => {
    // A transaction already writing another space cannot also write the
    // receipt into the owner's.
    const { reasons, receipt } = await consume((tx) =>
      tx.writeOrThrow({
        space: bob as MemorySpace,
        id: "of:elsewhere" as URI,
        type: "application/json",
        path: ["value"],
      }, { elsewhere: true })
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(
      /^cfc-grant: staging consumption receipt for single-use grant \S+ failed/,
    );
    expect(receipt).toBeUndefined();
  });
});
