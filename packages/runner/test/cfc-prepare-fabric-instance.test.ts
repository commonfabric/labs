import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";

import type { ImplementationIdentity } from "../src/cfc/mod.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc prepare fabric instance");
const space = signer.did();

type StoredEntry = { origin?: string; label: { confidentiality?: string[] } };

describe("cfc-prepare-fabric-instance", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });

    // A labeled source, so that a transaction reading it is one CFC prepares.
    const seed = runtime.edit();
    const sourceId = parseLink(
      runtime.getCell(space, "labeled source", undefined).getAsLink(),
    ).id!;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(
      seed,
      { space, scope: "space", id: sourceId, path: [] },
      {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      },
    );
    expect((await seed.commit()).ok).toBeDefined();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Writes `value` in a transaction that read the labeled source, running as
   * `identity` when one is given.
   */
  async function writeAfterLabeledRead(
    name: string,
    value: unknown,
    identity?: ImplementationIdentity,
  ) {
    const tx = runtime.edit();
    if (identity !== undefined) setCfcImplementationIdentity(tx, identity);
    const source = runtime.getCell(space, "labeled source", undefined, tx);
    expect((source.getRaw() as { secret?: string }).secret).toBe("s3cr3t");
    const target = runtime.getCell<unknown>(space, name, undefined, tx);
    target.set(value);
    tx.prepareCfc();
    const result = await tx.commit();
    return { result, id: target.getAsNormalizedFullLink().id };
  }

  /** The label entries stored on the document `id`. */
  function storedEntries(id: string): StoredEntry[] {
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  }

  it("commits a deep-frozen `FabricError` a labeled transaction writes, labeled as content", async () => {
    // Commit preparation classifies what a transaction wrote, and cannot
    // descend an instance; one holding nothing but fabric data is content, so
    // it is stamped with what the transaction read.
    const error = deepFreeze(FabricError.fromNativeError(new Error("boom")));

    for (const [name, value] of [["whole", error], ["nested", { error }]]) {
      const { result, id } = await writeAfterLabeledRead(
        `${name} write`,
        value,
      );

      expect(result.error).toBeUndefined();
      const derived = storedEntries(id).find((e) => e.origin === "derived");
      expect(derived?.label.confidentiality).toContainEqual("secret");
    }
  });

  it("commits a deep-frozen `FabricError` a named function writes whole", async () => {
    // A value a single implementation wrote whole is checked for the
    // references it holds; an instance holding nothing but fabric data holds
    // none.
    const error = deepFreeze(FabricError.fromNativeError(new Error("boom")));
    const writer = {
      kind: "verified",
      moduleIdentity: "sha256:instance-writer",
      symbol: "writeError",
      codeHash: "code:writeError",
    } satisfies ImplementationIdentity;

    for (const [name, value] of [["whole", error], ["nested", { error }]]) {
      const { result } = await writeAfterLabeledRead(
        `${name} named write`,
        value,
        writer,
      );

      expect(result.error).toBeUndefined();
    }
  });
});
