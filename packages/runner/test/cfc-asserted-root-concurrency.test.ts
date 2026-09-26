// A whole-value set stamps its destination as written (`assertedValueRoots` in
// `cfc/prepare.ts`): every position beneath it holds what the writer supplied.
// A member a peer added beside that destination, in the same document, is not
// the writer's, and must keep the peer's own stamp once the writer's commit
// lands over the document around it.
//
// Two Runtime clients share one in-process MemoryV2Server with manual fan-out
// (the harness of `linked-stale-read-conflict.test.ts`). The writer converges
// with the peer's write before it commits, so its commit is not refused as
// stale and the outcome under test is the stamp itself. A stale writer is
// refused by commit-time conflict detection whatever the stamp does, which is
// what this file used to pin and what it no longer relies on.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cfc-asserted-root-concurrency");
const space = signer.did();

const verified = (symbol: string): ImplementationIdentity => ({
  kind: "verified",
  moduleIdentity: "module:conclave",
  symbol,
  bindingPath: [symbol],
});
const COMMIT = verified("commitStances");
const PEER = verified("plantExtra");

const SECRET_SCHEMA = {
  type: "object",
  ifc: { confidentiality: [cfcAtom.space(space)] },
} as const satisfies JSONSchema;

describe("a whole-value stamp beside a peer's member", () => {
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

  it("leaves a converged peer's member beside the destination under the peer's stamp", async () => {
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

    // The peer converges and, from the note, adds a member beside the votes.
    const peerCommitted = peer.getCell<Record<string, unknown>>(
      space,
      "committed",
      undefined,
    );
    const peerNote = peer.getCell(space, "note", SECRET_SCHEMA);
    await peerCommitted.sync();
    await peerNote.sync();
    await peerCommitted.pull();
    expect(peerCommitted.get()).toEqual({ votes: ["reject"] });
    {
      const tx = peer.edit();
      setCfcImplementationIdentity(tx, PEER);
      peerNote.withTx(tx).get();
      peerCommitted.withTx(tx).key("extra").set("planted");
      peer.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `peer: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // The writer converges with the peer's write before it commits.
    await server.flushSessions([space]);
    await clock.settle();
    await writer.storageManager.synced();
    const committed = writer.getCell<Record<string, unknown>>(
      space,
      "committed",
      undefined,
    );
    await committed.sync();
    await committed.pull();
    expect(committed.get()).toEqual({ votes: ["reject"], extra: "planted" });

    // The writer sets the votes whole from what it read of the note alone.
    {
      const tx = writer.edit();
      setCfcImplementationIdentity(tx, COMMIT);
      writer.getCell(space, "note", SECRET_SCHEMA, tx).get();
      committed.withTx(tx).key("votes").set(["approve", "reject"]);
      writer.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `writer: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
    }

    // The votes carry the writer's stamp; the peer's member keeps the peer's
    // and carries none of the writer's.
    const writersAt = (path: readonly string[]): unknown[] => {
      const tx = writer.edit();
      const metadata = readStoredCfcMetadata(
        tx,
        committed.getAsNormalizedFullLink(),
      );
      tx.abort();
      const entries = metadata?.labelMap.entries ?? [];
      // The derived value stamp that resolves at `path`: the deepest one at
      // or above it.
      const covering = entries
        .filter((entry) =>
          entry.origin === "derived" && entry.observes === "value" &&
          entry.path.length <= path.length &&
          entry.path.every((segment, index) => segment === path[index])
        )
        .sort((left, right) => right.path.length - left.path.length)[0];
      return (covering?.label.integrity ?? [])
        .filter((atom) =>
          (atom as { type?: string }).type === CFC_ATOM_TYPE.TransformedBy &&
          (atom as { inputWitness?: unknown }).inputWitness === undefined
        )
        .map((atom) =>
          (atom as { identity: { symbol: string } }).identity.symbol
        );
    };
    expect(writersAt(["votes"])).toEqual(["commitStances"]);
    expect(writersAt(["extra"])).toEqual(["plantExtra"]);
  });
});
