import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { resolveCollectionKey } from "../src/builtins/collection-index-key.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-collection-key-reference");
const space = signer.did();

describe("collection key reference confidentiality", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  it("retains a selected key's confidentiality after its acquisition transaction ends", async () => {
    const seed = runtime.edit();
    const target = runtime.getCell(space, "target", undefined, seed);
    target.set("public target");
    expect((await seed.commit()).error).toBeUndefined();

    const install = runtime.edit();
    const selected = runtime.getCell(space, "selected", undefined, install);
    writeSeedEnvelopeDoc(install, space);
    seedStoredEnvelope(install, {
      ...selected.getAsNormalizedFullLink(),
      path: [],
    }, {
      value: target.withTx(undefined).getAsLink(),
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            origin: "link",
            observes: "followRef",
            referenceAcquisition: "complete",
            label: { confidentiality: ["private-key-selection"] },
          }],
        },
      },
    });
    expect((await install.commit()).error).toBeUndefined();

    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell().withTx(undefined);
    acquire.abort();
    const lookup = runtime.edit();
    try {
      const resolved = resolveCollectionKey(runtime, lookup, held)!;
      expect(getCfcReferenceProvenance(resolved.key)?.confidentiality)
        .toContain("private-key-selection");
    } finally {
      lookup.abort();
    }
  });
});
