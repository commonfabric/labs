import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcTrustSnapshot } from "../src/storage/extended-storage-transaction.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-link-reader-floor",
);
const space = signer.did();

const ADMIN_ATOM = "admin-approved";

const FLOOR_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Seeds a source the floor's atom endorses, whose stored label holds
  // `confidentiality`, then links it, through a cell typed by `linkSchema`,
  // into the floored slot of another document, and returns the reasons the
  // preparation refused it for.
  const linkEndorsedSource = async (
    linkSchema: JSONSchema | undefined,
    confidentiality: readonly FabricValue[] = [],
  ) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcWriteFloor: "enforce",
    });
    const seed = runtime.edit();
    const seeded = runtime.getCell(space, "source", undefined, seed);
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, {
      ...seeded.getAsNormalizedFullLink(),
      path: [],
    }, {
      value: "endorsed",
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: {
              integrity: [ADMIN_ATOM],
              ...(confidentiality.length > 0 &&
                { confidentiality: [...confidentiality] }),
            },
          }],
        },
      },
    });
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    setCfcTrustSnapshot(tx, { id: `trust-${space}`, actingPrincipal: space });
    const source = runtime.getCell(space, "source", linkSchema, tx);
    runtime.getCell(space, "sink", FLOOR_SCHEMA, tx).set(
      { out: source } as never,
    );
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    tx.abort();
    return prepared.status === "invalidated" ? prepared.reasons : [];
  };

  describe("a link into a floored slot", () => {
    it("meets the floor with the source's endorsement", async () => {
      expect(await linkEndorsedSource(undefined)).toEqual([]);
    });

    it("fails the floor for a link whose schema names the current principal as a reader the source does not store", async () => {
      // The link's evidence is undecided without a concrete reader, so the
      // floor over the slot has no endorsement to find.

      const reasons = await linkEndorsedSource({
        type: "string",
        ifc: {
          confidentiality: [{
            type: CFC_ATOM_TYPE.User,
            subject: { __ctCurrentPrincipal: true },
          }],
        },
      } as JSONSchema);
      expect(reasons).toEqual([
        expect.stringContaining("write floor failed at /out"),
      ]);
    });

    it("fails the floor for a link to a source whose stored label names the current principal unbound", async () => {
      // A stored placeholder cannot borrow the next writer's identity, so the
      // source's evidence cannot be read.

      const reasons = await linkEndorsedSource(undefined, [{
        type: CFC_ATOM_TYPE.User,
        subject: { __ctCurrentPrincipal: true },
      }]);
      expect(reasons).toEqual([
        expect.stringContaining("write floor failed at /out"),
      ]);
    });
  });
});
