// A whole-value set stamps its destination as written (`assertedValueRoots` in
// `cfc/prepare.ts`): every position beneath it holds what the writer supplied.
// That holds only of the destination the writer's transaction saw. A peer that
// adds a member beneath it between the writer's read of its replica and its
// commit would otherwise sit under the writer's stamp, named as the writer's
// value. The commit must be refused instead, so the retry sets the destination
// over the member and removes it.
//
// Two Runtime clients share one in-process MemoryV2Server with manual fan-out
// (the harness of `linked-stale-read-conflict.test.ts`), so the writer's
// replica is stale by construction rather than by timing.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cfc-asserted-root-concurrency");
const space = signer.did();

const COMMIT: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: "module:conclave",
  symbol: "commitStances",
  bindingPath: ["commitStances"],
};

const SECRET_SCHEMA = {
  type: "object",
  ifc: { confidentiality: [cfcAtom.space(space)] },
} as const satisfies JSONSchema;

describe("a whole-value stamp over a destination a peer changed", () => {
  let server: MemoryV2Server.Server;
  let storageWriter: EmulatedStorageManager;
  let storagePeer: EmulatedStorageManager;
  let writer: Runtime;
  let peer: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storageWriter = EmulatedStorageManager.connectTo(server, { as: signer });
    storagePeer = EmulatedStorageManager.connectTo(server, { as: signer });
    const options = { cfcFlowLabels: "persist" } as const;
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageWriter,
      ...options,
    });
    peer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storagePeer,
      ...options,
    });
  });

  afterEach(async () => {
    await peer.dispose();
    await writer.dispose();
    await storagePeer.close();
    await storageWriter.close();
    await server.close();
  });

  it("refuses the writer's commit when a peer added a member beneath its destination", async () => {
    // The writer creates the room's note and the committed document.
    {
      const tx = writer.edit();
      writer.getCell(space, "note", SECRET_SCHEMA, tx).set({ text: "secret" });
      writer.getCell(space, "committed", undefined, tx).set({
        votes: ["reject"],
      });
      writer.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // The peer converges, adds a member, and publishes it; the writer's
    // replica is not told.
    const peerCommitted = peer.getCell<Record<string, unknown>>(
      space,
      "committed",
      undefined,
    );
    await peerCommitted.sync();
    await peerCommitted.pull();
    expect(peerCommitted.get()).toEqual({ votes: ["reject"] });
    {
      const tx = peer.edit();
      peerCommitted.withTx(tx).key("extra").set("planted");
      peer.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `peer: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // The writer, stale, sets the whole document from what it read of the
    // note alone. Its destination is one it did not read, so prepare would
    // stamp it whole; the peer's member must not end up beneath that stamp.
    const tx = writer.edit();
    setCfcImplementationIdentity(tx, COMMIT);
    writer.getCell(space, "note", SECRET_SCHEMA, tx).get();
    writer.getCell(space, "committed", undefined, tx).set({
      votes: ["approve", "reject"],
    });
    writer.prepareTxForCommit(tx);
    const res = await tx.commit({ resolveAt: "verdict" });
    expect(res.error, "a stale whole-value set must be refused")
      .toBeDefined();
    expect((res.error as { name?: string })?.name).toBe("ConflictError");

    await server.flushSessions([space]);
    await clock.settle();
    await writer.storageManager.synced();

    // Nothing of the refused set landed: the peer's member is still there.
    const settled = writer.getCell(space, "committed", undefined);
    await settled.sync();
    await settled.pull();
    expect(settled.get()).toEqual({ votes: ["reject"], extra: "planted" });
  });
});
