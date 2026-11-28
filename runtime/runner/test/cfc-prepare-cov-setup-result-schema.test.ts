import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { writeResultSchemaMeta } from "../src/result-schema-meta.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcTrustSnapshot } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-setup-result-schema",
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

  const start = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcWriteFloor: "enforce",
    });
    return runtime;
  };

  // Stores a result document as a setup leaves it, its value beside the
  // result schema it declared, and then links it into the floored slot of
  // another document. Returns the reasons the preparation refused the link
  // for.
  const linkSetupResult = async (runtime: Runtime, schema: JSONSchema) => {
    const seed = runtime.edit();
    const result = runtime.getCell<string>(
      space,
      "setup-result",
      undefined,
      seed,
    );
    result.set("approved");
    expect(writeResultSchemaMeta(result, schema)).toBe(true);
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    setCfcTrustSnapshot(tx, { id: `trust-${space}`, actingPrincipal: space });
    const source = runtime.getCell(space, "setup-result", undefined, tx);
    runtime.getCell(space, "sink", FLOOR_SCHEMA, tx).set(
      { out: source } as never,
    );
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    tx.abort();
    return prepared.status === "invalidated" ? prepared.reasons : [];
  };

  describe("a link to the result of a setup with no stored label", () => {
    // The result schema the setup declared stands in for the label the
    // result's later writes will carry.

    it("meets the floor with the integrity the result schema mints", async () => {
      expect(
        await linkSetupResult(start(), {
          type: "string",
          ifc: { addIntegrity: [ADMIN_ATOM] },
        }),
      ).toEqual([]);
    });

    it("refuses the link where the result schema mints none", async () => {
      expect(await linkSetupResult(start(), { type: "string" })).toEqual([
        expect.stringContaining("write floor failed at /out"),
      ]);
    });
  });
});
