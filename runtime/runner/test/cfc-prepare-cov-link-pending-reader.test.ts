import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcTrustSnapshot } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-link-pending-reader",
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

// A source private to whoever creates it, which mints `integrity`.
const sourceSchema = (integrity: readonly string[]): JSONSchema => ({
  type: "string",
  ifc: {
    confidentiality: [{
      type: CFC_ATOM_TYPE.User,
      subject: { __ctCurrentPrincipal: true },
    }],
    addIntegrity: [...integrity],
  },
} as JSONSchema);

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const start = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcWriteFloor: "enforce",
    });
    return runtime;
  };

  // Writes the source under a schema minting `integrity`, and links it into
  // the floored slot of another document, in one transaction acting for the
  // signer. Returns the reasons the preparation refused it for.
  const writeAndLink = (runtime: Runtime, integrity: readonly string[]) => {
    const tx = runtime.edit();
    setCfcTrustSnapshot(tx, { id: `trust-${space}`, actingPrincipal: space });
    const source = runtime.getCell(
      space,
      "source",
      sourceSchema(integrity),
      tx,
    );
    source.set("value");
    runtime.getCell(space, "sink", FLOOR_SCHEMA, tx).set(
      { out: source } as never,
    );
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    tx.abort();
    return prepared.status === "invalidated" ? prepared.reasons : [];
  };

  describe("a link to a reader-private source this transaction writes", () => {
    // The source's declaration names its creator as its reader, which binds
    // before the link's evidence is read from it.

    it("meets the floor with the integrity the source's schema mints", () => {
      expect(writeAndLink(start(), [ADMIN_ATOM])).toEqual([]);
    });

    it("refuses the link where the source's schema mints none", () => {
      expect(writeAndLink(start(), [])).toEqual([
        expect.stringContaining("requiredIntegrity failed at /out"),
      ]);
    });

    it("meets the floor with the integrity the source's schema mints over the envelope it stores", async () => {
      const runtime = start();
      const seed = runtime.edit();
      setCfcTrustSnapshot(seed, {
        id: `trust-${space}`,
        actingPrincipal: space,
      });
      runtime.getCell(space, "source", sourceSchema([ADMIN_ATOM]), seed).set(
        "first",
      );
      expect((await seed.commit().settled).error).toBeUndefined();

      expect(writeAndLink(runtime, [ADMIN_ATOM])).toEqual([]);
    });
  });
});
