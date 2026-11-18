import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { UnknownCfcMetadataVersionError } from "../src/cfc/metadata.ts";
import { processedClaimJoinIsForeign } from "../src/cfc/prepare.ts";
import { runOutcomeIsWithheld } from "../src/executor/processed-claim.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("processed-claim-underivable");
const space = signer.did() as MemorySpace;

describe("runOutcomeIsWithheld()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Stores the document `name` with an unlabeled envelope of `version`, and
   * returns a transaction that has read it.
   */
  const runThatRead = async (name: string, version: number) => {
    const id = runtime.getCell(space, name).getAsNormalizedFullLink().id as URI;
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: { note: "read" },
      cfc: {
        version,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [] },
      },
    });
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    expect(
      runtime.getCellFromLink({ space, scope: "space", id, path: [] }, {
        type: "object",
      }, tx).getRaw(),
    ).toEqual({ note: "read" });
    return tx;
  };

  it("returns `true` for a run whose join cannot be derived", async () => {
    const tx = await runThatRead("underivable-join", 3);

    expect(() => processedClaimJoinIsForeign(tx, space)).toThrow(
      UnknownCfcMetadataVersionError,
    );
    expect(runOutcomeIsWithheld(tx, space)).toBe(true);
    tx.abort();
  });

  it("returns `false` for a run that read the same document under an envelope it interprets", async () => {
    const tx = await runThatRead("derivable-join", 1);

    expect(runOutcomeIsWithheld(tx, space)).toBe(false);
    tx.abort();
  });
});
