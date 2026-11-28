import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import { diffAndUpdate } from "../src/data-updating.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-link-only-write",
);
const space = signer.did();

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /**
   * Stores a document whose `field` is labeled, then writes `field` through
   * the raw write path, which records no schema for the write: a reference
   * to another document where `link` is set and a plain value otherwise.
   * Returns the target's id and the reasons the preparation refused the
   * write for.
   */
  const writeLabeledField = async (link: boolean) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const target = runtime.getCell(space, "target");
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(
      seed,
      { ...target.getAsNormalizedFullLink(), path: [] },
      {
        value: { field: "stored" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["field"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      },
    );
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    try {
      const source = runtime.getCell(space, "source", undefined, tx);
      source.set("linked");
      diffAndUpdate(
        runtime,
        tx,
        target.key("field").getAsNormalizedFullLink(),
        link ? source : "written",
      );
      tx.prepareCfc();
      const prepared = tx.getCfcState().prepare;
      return {
        target: target.getAsNormalizedFullLink().id,
        reasons: prepared.status === "invalidated" ? prepared.reasons : [],
      };
    } finally {
      tx.abort();
    }
  };

  describe("a write under no schema to a labeled field", () => {
    // Without a schema the write declares no policy for the field, so only
    // a reference, which carries its own label to the field, stands in for
    // one.

    it("is admitted where it writes a reference", async () => {
      expect((await writeLabeledField(true)).reasons).toEqual([]);
    });

    it("is refused as awaiting the schema where it writes a value", async () => {
      const { target, reasons } = await writeLabeledField(false);
      expect(reasons).toEqual([
        `missing schema write-policy input for ${target}`,
      ]);
    });
  });
});
