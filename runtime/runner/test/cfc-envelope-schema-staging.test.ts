import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { CfcConfClause } from "../src/cfc/clause.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { lookupSchemaDocument } from "../src/schema-registry.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-envelope-staging");
const space = signer.did();

describe("CFC envelope schema documents ride the shared staging path", () => {
  // The CFC envelope store rides the transaction's shared schema-document
  // staging (`stageSchemaDocClosure`) rather than a bespoke write: the envelope
  // document registers in the realm registry, dedupes per transaction, and
  // elides once the space's server has confirmed it — while
  // `loadSchemaDocument`'s read side keeps verifying what the SPACE holds, so a
  // registry hit can never mask a missing document.

  const setup = async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // A seeding failure below never reaches the caller's `finally`, so the
    // resources are released here before it propagates.
    try {
      // A source doc whose stored metadata carries the authoritative label —
      // the link-write below then derives and persists an envelope on its
      // target (the same seeding shape cfc-label-metadata-persist uses).
      const sourceId = parseLink(
        runtime.getCell(space, "cfc-envelope-staging-source").getAsLink(),
      ).id!;
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        space,
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "classified" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [
              { path: [], label: { confidentiality: ["source-root"] } },
            ],
          },
        },
      });
      expect((await seed.commit().settled).ok).toBeDefined();
      return { storageManager, runtime, sourceId };
    } catch (error) {
      await runtime.dispose();
      await storageManager.close();
      throw error;
    }
  };

  /**
   * One labeled link-write to `targetName`; resolves with the `cid:`
   * document ids the transaction staged alongside it.
   */
  const labeledWrite = async (
    runtime: Runtime,
    sourceId: string,
    targetName: string,
  ): Promise<{ cidWrites: string[]; schemaHash: string | undefined }> => {
    const tx = runtime.edit();
    const target = runtime.getCell(space, targetName, undefined, tx);
    const targetId = target.getAsNormalizedFullLink().id;
    tx.markCfcRelevant("test");
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: targetId,
      path: ["field"],
    }, linkRefFrom({ space, id: sourceId, path: [] }));
    tx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: { space, scope: "space", id: targetId, path: ["field"] },
      source: { space, scope: "space", id: sourceId, path: [] },
      cfcLabelView: {
        version: 1,
        entries: [
          {
            path: [],
            label: { confidentiality: ["source-root" as CfcConfClause] },
          },
        ],
      },
    });
    tx.prepareCfc();
    const cidWrites = [...tx.getWriteDetails?.(space) ?? []]
      .map((detail) => detail.address.id)
      .filter((id) => id.startsWith("cid:"));
    expect((await tx.commit().settled).ok).toBeDefined();
    const stored = (runtime.storageManager.open(space).replica as unknown as {
      getDocument(id: string): { cfc?: { schemaHash?: string } } | undefined;
    }).getDocument(targetId);
    return { cidWrites, schemaHash: stored?.cfc?.schemaHash };
  };

  it("stages nothing for a hash the realm registry cannot supply", async () => {
    const { storageManager, runtime } = await setup();
    try {
      const tx = runtime.edit();
      tx.stageSchemaDocClosure(
        space,
        "fid1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      );
      const cidWrites = [...tx.getWriteDetails?.(space) ?? []]
        .map((detail) => detail.address.id)
        .filter((id) => id.startsWith("cid:"));
      expect(cidWrites).toEqual([]);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("stages the envelope once, registers it, and elides the confirmed repeat", async () => {
    const { storageManager, runtime, sourceId } = await setup();
    try {
      const first = await labeledWrite(runtime, sourceId, "envelope-target-a");
      expect(first.schemaHash).toBeDefined();
      // The envelope document rode the transaction as a staged cid write...
      expect(first.cidWrites).toContain(`cid:${first.schemaHash}`);
      // ...and registered in the realm registry on the way.
      expect(lookupSchemaDocument(first.schemaHash!)).toBeDefined();

      await storageManager.synced();

      // A second target deriving the same envelope: the metadata write
      // happens, the document write elides — the space's server confirmed
      // it, and content addressing makes that copy immutable.
      const second = await labeledWrite(runtime, sourceId, "envelope-target-b");
      expect(second.schemaHash).toBe(first.schemaHash);
      expect(second.cidWrites).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
