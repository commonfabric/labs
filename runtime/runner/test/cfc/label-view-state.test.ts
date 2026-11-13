import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import {
  cfcLabelViewFromMetadata,
  readCfcDocumentLabels,
} from "../../src/cfc/label-view-state.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc label view state");
const space = signer.did();

describe("label-view-state", () => {
  describe("cfcLabelViewFromMetadata()", () => {
    it("returns a view without an entry of the label-metadata class", () => {
      expect(cfcLabelViewFromMetadata({
        labelMap: {
          version: 1,
          entries: [
            { path: ["body"], label: { confidentiality: ["kept"] } },
            {
              path: ["body"],
              label: { confidentiality: ["template"] },
              observes: "labelMetadata",
            },
          ],
        },
      }, [])).toEqual({
        version: 1,
        entries: [{ path: ["body"], label: { confidentiality: ["kept"] } }],
      });
    });
  });

  describe("readCfcDocumentLabels()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    const id = "of:label-view-state" as URI;
    const address = { space, id, scope: "space" as const, path: [] };

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, address, {
        value: { body: "sealed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: ["body"], label: { confidentiality: ["s"] } }],
          },
        },
      });
      expect((await tx.commit().settled).error).toBeUndefined();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    it("returns the stored entries through a transaction that can read", () => {
      const tx = runtime.edit();
      expect(readCfcDocumentLabels(tx, address)?.entries).toEqual([
        { path: ["body"], label: { confidentiality: ["s"] } },
      ]);
      tx.abort();
    });
  });
});
