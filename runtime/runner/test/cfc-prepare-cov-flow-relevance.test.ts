import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { flowLabelWorkExists } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { schedulerDependencyRead } from "../src/storage/reactivity-log.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-flow-relevance",
);
const space = signer.did();

describe("flowLabelWorkExists()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Starts a runtime holding a document whose value carries a stored label.
  const startWithLabeledSource = async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    const source = runtime.getCell(space, "source");
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(
      seed,
      { ...source.getAsNormalizedFullLink(), path: [] },
      {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: ["secret"] } }],
          },
        },
      },
    );
    expect((await seed.commit().settled).error).toBeUndefined();
    return { runtime, source };
  };

  it("returns `true` for a transaction that read a labeled document", async () => {
    const { runtime, source } = await startWithLabeledSource();
    const tx = runtime.edit();
    expect(tx.readValueOrThrow(source.getAsNormalizedFullLink())).toEqual({
      secret: "s3cr3t",
    });
    expect(flowLabelWorkExists(tx)).toBe(true);
    tx.abort();
  });

  it("returns `false` for a transaction whose only read of it seeded scheduler dependencies", async () => {
    // Dependency seeding is scheduling machinery, not consumption by the
    // action (§8.10.1).

    const { runtime, source } = await startWithLabeledSource();
    const tx = runtime.edit();
    const read = tx.runWithAmbientReadMeta(
      schedulerDependencyRead,
      () => tx.readValueOrThrow(source.getAsNormalizedFullLink()),
    );
    expect(read).toEqual({ secret: "s3cr3t" });
    expect(flowLabelWorkExists(tx)).toBe(false);
    tx.abort();
  });
});
