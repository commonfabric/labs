import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcCellLinkRefPayload } from "../src/cfc/link-label-view.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-carried-view",
);
const space = signer.did();

const ADMIN_ATOM = "admin-approved";
const REPRESENTS = { kind: "represents-principal", subject: space };

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Seeds a source the admin atom endorses, then links it, with a carried
  // view claiming that the signer represents it, into a slot whose floor
  // requires `floor`. Returns the reasons the preparation refused it for.
  const linkWithCarriedClaim = async (floor: unknown) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcWriteFloor: "enforce",
    });
    const seeded = runtime.getCell(space, "source");
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(
      seed,
      { ...seeded.getAsNormalizedFullLink(), path: [] },
      {
        value: "endorsed",
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { integrity: [ADMIN_ATOM] } }],
          },
        },
      },
    );
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    const source = runtime.getCell(space, "source", undefined, tx);
    const link = linkRefFrom<CfcCellLinkRefPayload>({
      ...linkRefPayload(source.getAsLink()),
      cfcLabelView: {
        version: 1,
        entries: [{ path: [], label: { integrity: [REPRESENTS] } }],
      },
    });
    runtime.getCell(space, "sink", {
      type: "object",
      properties: {
        out: { type: "string", ifc: { requiredIntegrity: [floor] } },
      },
      required: ["out"],
    } as JSONSchema, tx).set({ out: link } as never);
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    tx.abort();
    return prepared.status === "invalidated" ? prepared.reasons : [];
  };

  describe("a link whose carried view holds a principal claim", () => {
    // A carried view is the writer's to choose, so its principal claim is no
    // evidence of anyone's authorship.

    it("meets a floor the source's own label meets", async () => {
      expect(await linkWithCarriedClaim(ADMIN_ATOM)).toEqual([]);
    });

    it("meets no floor with the carried claim", async () => {
      expect(await linkWithCarriedClaim(REPRESENTS)).toEqual([
        expect.stringContaining("write floor failed at /out"),
      ]);
    });
  });
});
