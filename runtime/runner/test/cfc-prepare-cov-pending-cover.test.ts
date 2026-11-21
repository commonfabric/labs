import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import type { IFCLabel } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-pending-cover",
);
const space = signer.did();

const REPRESENTS = { kind: "represents-principal", subject: space };

const FLOOR_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [REPRESENTS] } },
  },
  required: ["out"],
} as JSONSchema;

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const seed = (
    runtime: Runtime,
    id: string,
    value: FabricValue,
    label: IFCLabel,
  ) => {
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      ...runtime.getCell(space, id).getAsNormalizedFullLink(),
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [{ path: [], label }] },
      },
    } as FabricValue);
    return tx.commit().settled;
  };

  // Seeds a profile whose stored label claims the signer represents it, and
  // another document labeled `aliasLabel`, then in one transaction re-points
  // the profile's `name` at that document and links `name` into a slot whose
  // floor requires the claim. Returns the reasons the preparation refused it
  // for.
  const relinkProfileName = async (aliasLabel: IFCLabel) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcWriteFloor: "enforce",
    });
    expect(
      (await seed(runtime, "profile", { name: "Ada" }, {
        integrity: [REPRESENTS],
      })).error,
    ).toBeUndefined();
    expect((await seed(runtime, "alias", "Mallory", aliasLabel)).error)
      .toBeUndefined();
    const tx = runtime.edit();
    const profile = runtime.getCell(space, "profile", undefined, tx);
    profile.key("name").set(
      runtime.getCell(space, "alias", undefined, tx) as never,
    );
    runtime.getCell(space, "sink", FLOOR_SCHEMA, tx).set(
      { out: profile.key("name") } as never,
    );
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    tx.abort();
    return prepared.status === "invalidated" ? prepared.reasons : [];
  };

  describe("a link to a field the transaction re-points at another document", () => {
    // The reference staged at the field supplies what lies there, so the
    // claim that counts is the one that document holds, and not the claim
    // the profile around the field holds.

    it("meets the floor with the claim the re-pointed document holds", async () => {
      expect(await relinkProfileName({ integrity: [REPRESENTS] })).toEqual([]);
    });

    it("meets no floor where only the profile around the field holds the claim", async () => {
      expect(await relinkProfileName({ integrity: ["alias"] })).toEqual([
        expect.stringContaining("requiredIntegrity failed at /out"),
      ]);
    });
  });
});
