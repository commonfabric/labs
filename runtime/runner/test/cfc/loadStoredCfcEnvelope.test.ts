import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model";
import type { URI } from "@commonfabric/memory/interface";

import { loadStoredCfcEnvelope } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA,
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-load-stored-envelope");
const document = {
  space: signer.did(),
  id: "of:stored-envelope" as URI,
  scope: "space" as const,
};

/** An envelope labeling `v` secret, naming the schema `schemaHash`. */
const envelope = (schemaHash: string, version = 1): FabricValue => ({
  value: { v: "stored" },
  cfc: {
    version,
    schemaHash,
    labelMap: {
      version: 1,
      entries: [{ path: ["v"], label: { confidentiality: ["secret"] } }],
    },
  },
});

describe("loadStoredCfcEnvelope()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  it("returns `none` for a document with no envelope", () => {
    tx.writeValueOrThrow({ ...document, path: [] }, { v: "plain" });
    expect(loadStoredCfcEnvelope(tx, document)).toEqual({ status: "none" });
  });

  it("returns the envelope and the schema it names", () => {
    writeSeedEnvelopeDoc(tx, signer.did());
    seedStoredEnvelope(
      tx,
      { ...document, path: [] },
      envelope(SEED_ENVELOPE_SCHEMA_HASH),
    );
    expect(loadStoredCfcEnvelope(tx, document)).toMatchObject({
      status: "loaded",
      schema: SEED_ENVELOPE_SCHEMA,
      metadata: {
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          entries: [{ path: ["v"], label: { confidentiality: ["secret"] } }],
        },
      },
    });
  });

  it("returns `unreadable`, saying why, for an envelope whose schema is missing", () => {
    const missing = `fid1:${"A".repeat(43)}`;
    seedStoredEnvelope(tx, { ...document, path: [] }, envelope(missing));
    expect(loadStoredCfcEnvelope(tx, document)).toEqual({
      status: "unreadable",
      reason: `stored schemaHash ${missing} is missing or unreadable`,
    });
  });

  it("returns `unreadable` for an envelope of a version this build does not read", () => {
    writeSeedEnvelopeDoc(tx, signer.did());
    seedStoredEnvelope(
      tx,
      { ...document, path: [] },
      envelope(SEED_ENVELOPE_SCHEMA_HASH, 999),
    );
    expect(loadStoredCfcEnvelope(tx, document)).toEqual({
      status: "unreadable",
      reason: expect.stringContaining("version 999"),
    });
  });
});
