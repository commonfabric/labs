import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  cfcLabelViewFromMetadata,
  readCfcDocumentLabels,
} from "../../src/cfc/label-view-state.ts";
import {
  readStoredCfcMetadata,
  StoredCfcMetadataError,
  UnknownCfcMetadataVersionError,
} from "../../src/cfc/metadata.ts";
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
    it("returns no view without metadata", () => {
      expect(cfcLabelViewFromMetadata(undefined, [])).toBeUndefined();
    });

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

    it("returns the same index for labels that have not changed", () => {
      const tx = runtime.edit();
      const first = readCfcDocumentLabels(tx, address);
      expect(first).toBeDefined();
      expect(readCfcDocumentLabels(tx, address)).toBe(first);
      tx.abort();
    });

    it("returns no labels through a transaction whose reads fail", () => {
      const tx = runtime.edit();
      tx.abort();
      // The read itself fails, with an error that is not a stored-metadata
      // error, so the labeled document answers with no view.
      let failure: unknown;
      try {
        readStoredCfcMetadata(tx, address);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof StoredCfcMetadataError).toBe(false);
      expect(readCfcDocumentLabels(tx, address)).toBeUndefined();
    });

    it("rethrows a stored-metadata error rather than answering no labels", async () => {
      const tx = runtime.edit();
      seedStoredEnvelope(tx, address, {
        value: { body: "sealed" },
        cfc: {
          version: 999,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: ["body"], label: { confidentiality: ["s"] } }],
          },
        },
      });
      expect((await tx.commit().settled).error).toBeUndefined();
      const reader = runtime.edit();
      expect(() => readCfcDocumentLabels(reader, address)).toThrow(
        UnknownCfcMetadataVersionError,
      );
      reader.abort();
    });
  });
});
