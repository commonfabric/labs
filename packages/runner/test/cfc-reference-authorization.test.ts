/// <reference path="./clock.d.ts" />

/**
 * Exercises reference verification against authoritative Memory admission
 * while policy changes remain remote or arrive under an open transaction.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model";
import { commitPreconditionValueHash } from "@commonfabric/memory/v2";
import type { Server } from "@commonfabric/memory/v2/server";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import type { SealedCommitVerdict } from "../src/storage/interface.ts";
import {
  authorizationRead,
  excludeReadFromConflict,
  getAuthorizationReadBasis,
  ignoreReadForCommit,
  internalVerifierRead,
  markUiInputBlindWriteTx,
  mergeableOpRead,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "../src/storage/reactivity-log.ts";
import { getDirectTransactionReadActivities } from "../src/storage/transaction-inspection.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import {
  createDefaultTraversalContext,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cfc-reference-authorization");
const space = signer.did();
const targetCause = "reference-evidence-target";
const holderCause = "reference-evidence-holder";

/** Returns target metadata with one content restriction. */
const targetMetadata = (restriction: string) => ({
  version: 1,
  schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
  labelMap: {
    version: 1,
    entries: [{
      path: [],
      label: { confidentiality: [restriction] },
    }],
  },
});

describe("cfc-reference-authorization", () => {
  let server: Server;
  let holderStorage: EmulatedStorageManager;
  let writerStorage: EmulatedStorageManager;
  let holderRuntime: Runtime;
  let writerRuntime: Runtime;

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    holderStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    holderRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: holderStorage,
    });
    writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });

    const target = holderRuntime.getCell(space, targetCause);
    const seed = holderRuntime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, {
      ...target.getAsNormalizedFullLink(),
      path: [],
    }, {
      value: "public constant",
      cfc: targetMetadata("original"),
    });
    target.withTx(seed).setMetaRaw(
      "schema",
      { type: "string" },
      rawMetaWriteAuthorization,
    );
    expect((await seed.commit({ resolveAt: "verdict" })).error).toBeUndefined();
    const peerTarget = writerRuntime.getCell(space, targetCause);
    await peerTarget.sync();
    await peerTarget.pull();
    expect(peerTarget.get()).toBe("public constant");
  });

  afterEach(async () => {
    await server.flushSessions([space]);
    await clock.settle();
    await holderRuntime.dispose();
    await writerRuntime.dispose();
    await holderStorage.close();
    await writerStorage.close();
    await server.close();
  });

  /** Stages a reference with separately recorded current-target evidence. */
  const prepareReference = (cause = targetCause) => {
    const tx = holderRuntime.edit();
    const target = holderRuntime.getCell(space, cause);
    const targetAddress = target.getAsNormalizedFullLink();
    const metadata = readStoredCfcMetadata(tx, targetAddress);
    expect(metadata?.labelMap.entries[0].label.confidentiality)
      .toEqual(["original"]);
    expect(tx.readOrThrow({ ...targetAddress, path: ["schema"] }, {
      meta: { ...authorizationRead, ...internalVerifierRead },
    })).toEqual({ type: "string" });
    const holder = holderRuntime.getCell(space, holderCause);
    holder.withTx(tx).set(target);
    const prepared = tx.prepareCfc();
    expect(typeof prepared).toBe("string");
    expect(
      tx.tx.getNativeCommit?.(space)?.operations.map((op) => op.id)
        .filter((id) => !id.startsWith("cid:")),
    )
      .toEqual([holder.getAsNormalizedFullLink().id]);
    return { tx, holder, targetAddress, prepared };
  };

  /** Changes target evidence without delivering its revision to the holder. */
  const changeEvidence = async (
    path: string[],
    value: FabricValue,
    cause = targetCause,
  ) => {
    // This peer represents the trusted producer of policy metadata. Use the
    // Memory transaction so the race changes exactly the evidence field.
    const tx = writerStorage.edit();
    const address = writerRuntime.getCell(space, cause)
      .getAsNormalizedFullLink();
    expect(tx.write({ ...address, path }, value).error).toBeUndefined();
    // The raw transaction's full promise includes coverage. Its verdict
    // signal lets the holder remain stale until the explicit fan-out.
    void tx.commit({ resolveAt: "verdict" });
    const result = await tx.commitVerdict?.();
    expect(result?.ok).toBeDefined();
  };

  for (
    const scenario of [
      { name: "CFC labels", path: ["cfc"], value: targetMetadata("changed") },
      { name: "schema", path: ["schema"], value: { type: "number" } },
    ]
  ) {
    it(`rejects a reference after authoritative ${scenario.name} change`, async () => {
      const { tx, holder, targetAddress, prepared } = prepareReference();
      await changeEvidence(scenario.path, scenario.value);
      const replica = holderStorage.open(space).replica as SpaceReplica;
      expect(replica.getDocument(targetAddress.id)?.cfc)
        .toEqual(targetMetadata("original"));
      expect(tx.prepareCfc()).toEqual(prepared);
      const result = await tx.commit({ resolveAt: "verdict" });
      expect(result.error?.name).toBe("ConflictError");
      await server.flushSessions([space]);
      await clock.settle();
      await holderStorage.synced();
      expect(holder.get()).toBeUndefined();
    });
  }

  it("rejects evidence that changes and returns to its observed value", async () => {
    const { tx, holder } = prepareReference();
    await changeEvidence(["cfc"], targetMetadata("changed"));
    await changeEvidence(["cfc"], targetMetadata("original"));
    const result = await tx.commit({ resolveAt: "verdict" });
    expect(result.error?.name).toBe("ConflictError");
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    expect(holder.get()).toBeUndefined();
  });

  it("retains its authorization basis after a restored policy reaches the replica", async () => {
    const { tx, holder, targetAddress } = prepareReference();
    const replica = holderStorage.open(space).replica as SpaceReplica;
    const observed = replica.getDocumentReadBasis(targetAddress.id);
    await changeEvidence(["cfc"], targetMetadata("changed"));
    await changeEvidence(["cfc"], targetMetadata("original"));
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    expect(replica.getDocument(targetAddress.id)?.cfc)
      .toEqual(targetMetadata("original"));
    expect(replica.getDocumentReadBasis(targetAddress.id).seq)
      .toBeGreaterThan(observed.seq);

    const result = await tx.commit({ resolveAt: "verdict" });
    expect(result.error?.name).toBe("ConflictError");
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    expect(holder.get()).toBeUndefined();
  });

  it("accepts unchanged authorization evidence after its pending layer is confirmed", async () => {
    const cause = "pending-reference-evidence";
    const target = holderRuntime.getCell(space, cause);
    const seed = holderRuntime.edit();
    seedStoredEnvelope(seed, {
      ...target.getAsNormalizedFullLink(),
      path: [],
    }, {
      value: "public constant",
      cfc: targetMetadata("original"),
    });
    target.withTx(seed).setMetaRaw(
      "schema",
      { type: "string" },
      rawMetaWriteAuthorization,
    );
    const seeded = seed.commit({ resolveAt: "verdict" });
    const { tx, holder, targetAddress } = prepareReference(cause);
    const replica = holderStorage.open(space).replica as SpaceReplica;
    expect(replica.getDocumentReadBasis(targetAddress.id).localSeqs.length)
      .toBeGreaterThan(0);
    expect((await seeded).error).toBeUndefined();
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    expect(replica.getDocumentReadBasis(targetAddress.id).localSeqs)
      .toEqual([]);

    expect((await tx.commit({ resolveAt: "verdict" })).error).toBeUndefined();
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    expect(holder.get()).toBe("public constant");
  });

  it("retains metadata authorization dependencies beside a value-hash pin", async () => {
    const { tx, holder, targetAddress } = prepareReference();
    tx.tx.addCommitPrecondition!(space, {
      kind: "entity-value-hash",
      id: targetAddress.id,
      scope: targetAddress.scope,
      valueHash: commitPreconditionValueHash("public constant"),
    });
    await changeEvidence(["cfc"], targetMetadata("changed"));
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    const replica = holderStorage.open(space).replica as SpaceReplica;
    expect(replica.getDocument(targetAddress.id)?.cfc)
      .toEqual(targetMetadata("changed"));
    expect(replica.getDocument(targetAddress.id)?.value).toBe(
      "public constant",
    );

    const result = await tx.commit({ resolveAt: "verdict" });
    expect(result.error?.name).toBe("ConflictError");
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    expect(holder.get()).toBeUndefined();
  });

  it("commits blind input after plain-schema authorization reads beneath a speculative layer", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    } as const;
    const listSchema = { type: "array", items: schema } as const;
    const cause = "blind-plain-schema-authorization";
    const target = holderRuntime.getCell(space, cause, schema);
    const list = holderRuntime.getCell(space, `${cause}-list`, listSchema);
    const address = target.getAsNormalizedFullLink();
    const seed = holderRuntime.edit();
    target.withTx(seed).set({ name: "durable" });
    list.withTx(seed).set([target.withTx(seed)]);
    expect((await seed.commit({ resolveAt: "verdict" })).error).toBeUndefined();
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();

    const replica = holderStorage.open(space).replica as SpaceReplica;
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const echo = replica.sealNative(
      {
        operations: [{
          op: "set",
          id: address.id,
          scope: address.scope,
          type: "application/json",
          value: {
            ...replica.getDocument(address.id, address.scope),
            value: { name: "speculative" },
          },
        }],
      },
      undefined,
      verdict.promise,
      { speculative: true },
    );
    try {
      expect(target.get()).toEqual({ name: "speculative" });
      const tx = holderRuntime.edit();
      markUiInputBlindWriteTx(tx);
      setBlindStructuralTarget(tx, { ...address, path: [] });
      const verified = tx.runWithAmbientReadMeta(
        { ...authorizationRead, ...internalVerifierRead },
        () => {
          const valueAddress = {
            ...list.getAsNormalizedFullLink(),
            path: ["value"] as const,
          };
          const value = tx.readOrThrow(valueAddress);
          return new SchemaObjectTraverser(
            tx,
            {
              path: ["value"],
              schema: listSchema,
            },
            createDefaultTraversalContext(
              holderRuntime.scopeKeyIdentity,
              false,
            ),
          )
            .traverse({ address: valueAddress, value });
        },
      );
      expect(verified).toEqual({ ok: [{ name: "durable" }] });
      const tracked = [...(getDirectTransactionReadActivities(tx) ?? [])]
        .filter((read) =>
          read.id === address.id && read.nonRecursive &&
          read.path.join("/") === "value/name" &&
          getAuthorizationReadBasis(read.meta) !== undefined
        );
      expect(tracked.length).toBeGreaterThan(0);
      target.withTx(tx).key("name").set("typed");
      unmarkUiInputBlindWriteTx(tx);
      holderRuntime.prepareTxForCommit(tx);
      expect((await tx.commit({ resolveAt: "verdict" })).error).toBeUndefined();
      for (const read of tracked) {
        expect(getAuthorizationReadBasis(read.meta)?.localSeqs).toEqual([]);
      }

      await server.flushSessions([space]);
      await clock.settle();
      const peer = writerRuntime.getCell(space, cause, schema);
      await peer.sync();
      await peer.pull();
      expect(peer.get()).toEqual({ name: "typed" });
    } finally {
      verdict.resolve({ withdrawn: { message: "test complete" } });
      await echo.settled;
    }
  });

  it("exports one authorization dependency for a pending layer with repeated document operations", async () => {
    const target = holderRuntime.getCell(space, targetCause);
    const address = target.getAsNormalizedFullLink();
    const replica = holderStorage.open(space).replica as SpaceReplica;
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const layer = replica.sealNative(
      {
        operations: ["first", "second"].map((value) => ({
          op: "set" as const,
          id: address.id,
          scope: address.scope,
          type: "application/json",
          value: { ...replica.getDocument(address.id, address.scope), value },
        })),
      },
      undefined,
      verdict.promise,
    );
    try {
      expect(replica.getDocumentReadBasis(address.id, address.scope).localSeqs)
        .toEqual([layer.localSeq]);
      const tx = holderRuntime.edit();
      expect(tx.readOrThrow({ ...address, path: ["value"] }, {
        meta: { ...authorizationRead, ...internalVerifierRead },
      })).toBe("second");
      const reads = replica.accessForTestingOnly.buildReads(
        tx.tx,
        layer.localSeq + 1,
      );
      expect(reads.pending).toHaveLength(1);
      expect(reads.pending[0].localSeq).toBe(layer.localSeq);
      expect(reads.pending[0].validation).toBe("required");
      tx.abort("inspection complete");
    } finally {
      verdict.resolve({ withdrawn: { message: "test complete" } });
      await layer.settled;
    }
  });

  it("commits a reference when its required evidence is unchanged", async () => {
    const { tx, holder } = prepareReference();
    const result = await tx.commit({ resolveAt: "verdict" });
    expect(result.error).toBeUndefined();
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    expect(holder.get()).toBe("public constant");
  });

  it("rejects a mergeable append when its authorization evidence changes", async () => {
    const cause = "reference-authorized-list";
    const list = holderRuntime.getCell<string[]>(space, cause);
    const address = list.getAsNormalizedFullLink();
    const seed = holderRuntime.edit();
    seedStoredEnvelope(seed, { ...address, path: [] }, {
      value: ["seed"],
      cfc: targetMetadata("original"),
    });
    expect((await seed.commit({ resolveAt: "verdict" })).error).toBeUndefined();
    const peerList = writerRuntime.getCell(space, cause);
    await peerList.sync();
    await peerList.pull();

    const tx = holderRuntime.edit();
    expect(readStoredCfcMetadata(tx, address)).toEqual(
      targetMetadata("original"),
    );
    list.withTx(tx).push("append");
    tx.prepareCfc();
    const replica = holderStorage.open(space).replica as SpaceReplica;
    const basis = replica.getDocumentReadBasis(address.id);
    await changeEvidence(["cfc"], targetMetadata("changed"), cause);
    // An outstanding seed layer masks the new confirmed metadata. Admission
    // must retain the revision basis of the verified snapshot underneath it.
    expect(replica.getDocument(address.id)?.cfc).toEqual(
      targetMetadata("original"),
    );
    expect(replica.getDocumentReadBasis(address.id).seq).toBeGreaterThan(
      basis.seq,
    );
    const result = await tx.commit({ resolveAt: "verdict" });
    expect(result.error?.name).toBe("ConflictError");
    await server.flushSessions([space]);
    await clock.settle();
    await holderStorage.synced();
    expect(list.get()).toEqual(["seed"]);
  });

  it("retains authorization reads when incidental read markers also apply", () => {
    const tx = holderRuntime.edit();
    const address = holderRuntime.getCell(space, targetCause)
      .getAsNormalizedFullLink();
    tx.readOrThrow({ ...address, path: ["cfc"] }, {
      meta: {
        ...authorizationRead,
        ...internalVerifierRead,
        ...ignoreReadForCommit,
        ...excludeReadFromConflict,
        ...mergeableOpRead,
      },
      nonRecursive: true,
    });
    const replica = holderStorage.open(space).replica as SpaceReplica;
    const reads = replica.accessForTestingOnly.buildReads(tx.tx, 100);
    expect(
      reads.confirmed.some((read) =>
        read.id === address.id && read.path.join("/") === "cfc"
      ),
    ).toBe(true);
  });

  it("excludes incidental metadata probes that carry no authorization decision", () => {
    const tx = holderRuntime.edit();
    const address = holderRuntime.getCell(space, targetCause)
      .getAsNormalizedFullLink();
    expect(readStoredCfcMetadata(tx, address, { meta: internalVerifierRead }))
      .toEqual(targetMetadata("original"));
    const replica = holderStorage.open(space).replica as SpaceReplica;
    const reads = replica.accessForTestingOnly.buildReads(tx.tx, 100);
    expect(
      reads.confirmed.some((read) =>
        read.id === address.id && read.path.join("/") === "cfc"
      ),
    ).toBe(false);
  });
});
