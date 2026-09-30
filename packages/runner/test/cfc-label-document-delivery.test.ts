/**
 * A client is owed the label documents a version-2 CFC envelope references
 * wherever the envelope reaches it, and the two seams that deliver them are
 * driven here against a real memory server rather than the emulated
 * loopback: a direct load of a labeled document pulls its label documents
 * beside its schema document, and a frame that delivers a rewritten
 * envelope naming a label document the client does not hold kicks a pull
 * of it. The documents are seeded straight into the server's engine, or
 * written raw by a second client, so nothing in this process registers a
 * label ahead of the reading client: what it resolves, it fetched.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { SessionSync } from "@commonfabric/memory/v2";
import {
  cfcLabelDocumentHash,
  lookupCfcLabelDocument,
} from "../src/cfc/label-documents.ts";
import type { IFCLabel } from "../src/cfc/label-view-core.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { StoredCfcMetadata } from "../src/cfc/types.ts";
import type { URI } from "@commonfabric/memory/interface";
import { Runtime } from "../src/runtime.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  SEED_ENVELOPE_SCHEMA,
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-label-delivery");
const space = signer.did();

const FIRST_LABEL: IFCLabel = {
  confidentiality: [
    "https://commonfabric.org/cfc/atom/Public/room-general-chat-alpha",
    "https://commonfabric.org/cfc/atom/Public/room-general-chat-beta",
  ],
};
const SECOND_LABEL: IFCLabel = {
  confidentiality: [
    "https://commonfabric.org/cfc/atom/Public/room-general-chat-gamma",
    "https://commonfabric.org/cfc/atom/Public/room-general-chat-delta",
  ],
};
const THIRD_LABEL: IFCLabel = {
  confidentiality: [
    "https://commonfabric.org/cfc/atom/Public/room-general-chat-epsilon",
    "https://commonfabric.org/cfc/atom/Public/room-general-chat-zeta",
  ],
};
const firstHash = cfcLabelDocumentHash(FIRST_LABEL);
const secondHash = cfcLabelDocumentHash(SECOND_LABEL);
const thirdHash = cfcLabelDocumentHash(THIRD_LABEL);

const referencing = (hash: string): StoredCfcMetadata => ({
  version: 2,
  schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
  labelMap: {
    version: 1,
    entries: [{ path: ["secret"], label: { $ref: `cid:${hash}` } }],
  },
});

describe("CFC label document delivery", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let localSeq = 0;

  /** Lands `operations` on the server as a session no client shares. */
  const seed = async (
    operations: Array<{ id: string; value: unknown }>,
  ): Promise<void> => {
    const engine = await server.engineForSpace(space);
    localSeq += 1;
    Engine.applyCommit(engine, {
      sessionId: "seed-session",
      principal: signer.did(),
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: operations.map(({ id, value }) => ({
          op: "set",
          id: id as never,
          value: value as never,
        })),
      },
    });
  };

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    localSeq = 0;
  });

  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  it("pulls a synced document's label documents beside its schema document", async () => {
    const cell = runtime.getCell(space, "delivered");
    const id = cell.getAsNormalizedFullLink().id;
    // Nothing in this process holds the label: the client has to fetch it.
    expect(lookupCfcLabelDocument(firstHash)).toBeUndefined();
    await seed([
      {
        id: `cid:${SEED_ENVELOPE_SCHEMA_HASH}`,
        value: { value: SEED_ENVELOPE_SCHEMA },
      },
      { id: `cid:${firstHash}`, value: { value: FIRST_LABEL } },
      {
        id,
        value: { value: { secret: "sealed" }, cfc: referencing(firstHash) },
      },
    ]);

    await cell.sync();
    const replica = manager.open(space).replica;
    expect(replica.getDocument(`cid:${firstHash}`)).toBeDefined();
    const tx = runtime.edit();
    const resolved = readStoredCfcMetadata(tx, { space, id });
    expect(resolved?.labelMap.entries[0].label).toEqual(FIRST_LABEL);
    tx.abort();
  });

  it("resolves a label document a later frame's envelope introduces", async () => {
    // An end-to-end net over the relabel-arrives → label-resolves flow,
    // not a discriminator for the arrival hydration's kick: against this
    // server a watch frame carries the label documents its envelope
    // names, so the reader holds the document whether or not the kick
    // fired. The kick's discriminating case — a frame delivering `/cfc`
    // without the documents it names — is not constructible here, as the
    // schema-hydration pin in `speculation-overlay.test.ts` records.
    const cell = runtime.getCell(space, "rewritten", SEED_ENVELOPE_SCHEMA);
    const id = cell.getAsNormalizedFullLink().id;
    await seed([
      {
        id: `cid:${SEED_ENVELOPE_SCHEMA_HASH}`,
        value: { value: SEED_ENVELOPE_SCHEMA },
      },
      { id: `cid:${firstHash}`, value: { value: FIRST_LABEL } },
      {
        id,
        value: { value: { secret: "sealed" }, cfc: referencing(firstHash) },
      },
    ]);
    await cell.sync();
    // The event to wait on: the reader's watch observing the relabeled
    // value, which is the frame that carries the new envelope.
    let cancel = () => {};
    const relabeled = new Promise<void>((resolve) => {
      cancel = cell.sink((value) => {
        if ((value as { secret?: string } | undefined)?.secret === "resealed") {
          resolve();
        }
      });
    });
    // A second client relabels the document with a label new to the
    // space, writing the label document raw beside the envelope so nothing
    // registers it in the realm; the frame reaches the reader through its
    // watch, naming a document the reader does not hold.
    const writerManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerManager,
    });
    try {
      expect(lookupCfcLabelDocument(secondHash)).toBeUndefined();
      const tx = writer.edit();
      tx.writeOrThrow({
        space,
        scope: "space",
        id: `cid:${secondHash}` as URI,
        path: [],
      }, { value: SECOND_LABEL });
      seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
        value: { secret: "resealed" },
        cfc: referencing(secondHash),
      });
      expect((await tx.commit()).ok).toBeDefined();
      await writerManager.synced();
      await relabeled;
      // The arrival kicked a pull of the label document; `synced()` waits
      // for the loads in flight.
      await manager.synced();
      const replica = manager.open(space).replica;
      expect(replica.getDocument(`cid:${secondHash}`)).toBeDefined();
      const readTx = runtime.edit();
      const resolved = readStoredCfcMetadata(readTx, { space, id });
      expect(resolved?.labelMap.entries[0].label).toEqual(SECOND_LABEL);
      readTx.abort();
    } finally {
      cancel();
      await writer.dispose();
    }
  });

  it("kicks a pull for a label document an arrived envelope names", async () => {
    // The arrival hydration on its own: a frame naming a label document
    // the replica and the registry both lack kicks a pull of it, and one
    // naming a document the server does not hold completes empty. The
    // frame is handed to the replica directly, since a served frame here
    // carries the document already.
    await seed([
      {
        id: `cid:${SEED_ENVELOPE_SCHEMA_HASH}`,
        value: { value: SEED_ENVELOPE_SCHEMA },
      },
      { id: `cid:${thirdHash}`, value: { value: THIRD_LABEL } },
    ]);
    const provider = manager.open(space);
    const replica = provider.replica;
    expect(lookupCfcLabelDocument(thirdHash)).toBeUndefined();
    expect(replica.getDocument(`cid:${thirdHash}`)).toBeUndefined();
    const absentHash = cfcLabelDocumentHash({ confidentiality: ["never"] });
    const frame = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [
        // Skipped: a content-addressed document names nothing to pull.
        { branch: "", id: `cid:${thirdHash}`, doc: { value: THIRD_LABEL } },
        // Skipped: no envelope.
        { branch: "", id: "of:plain", doc: { value: {} } },
        {
          branch: "",
          id: "of:arrived",
          doc: { value: { secret: "sealed" }, cfc: referencing(thirdHash) },
        },
        {
          branch: "",
          id: "of:arrived-absent",
          doc: { value: { secret: "sealed" }, cfc: referencing(absentHash) },
        },
      ],
      removes: [],
    } as unknown as SessionSync;
    (replica as SpaceReplica).accessForTestingOnly
      .hydrateArrivedCfcSchemaRefs(frame);
    // A pull issued after the kicked ones on the same session settles
    // after them, so once it resolves the kicked pulls have too.
    await provider.sync(`cid:${SEED_ENVELOPE_SCHEMA_HASH}` as URI, {
      path: [],
      schema: false,
    });
    expect(replica.getDocument(`cid:${thirdHash}`)).toBeDefined();
    expect(replica.getDocument(`cid:${absentHash}`)).toBeUndefined();
    const tx = runtime.edit();
    seedStoredEnvelope(tx, {
      space,
      scope: "space",
      id: "of:arrived" as URI,
      path: [],
    }, {
      value: { secret: "sealed" },
      cfc: referencing(thirdHash),
    });
    const resolved = readStoredCfcMetadata(tx, { space, id: "of:arrived" });
    expect(resolved?.labelMap.entries[0].label).toEqual(THIRD_LABEL);
    tx.abort();
  });
});
