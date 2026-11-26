import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-writer-stamp",
);
const space = signer.did();

const BINDING = {
  __ctWriterIdentityOf: { file: "/main.tsx", path: ["setCount"] },
} as const;

// The writer the binding names, with the module identity its claim is
// stamped with, or with none.
const writer = (moduleIdentity: string): ImplementationIdentity => ({
  kind: "verified",
  moduleIdentity,
  symbol: "setCount",
  sourceFile: "/main.tsx",
  bindingPath: ["setCount"],
});

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Writes `{ count: 1 }` through a cell at `id` typed by a schema whose
  // `count` declares `ifc`, as `identity`, and commits.
  const commitAs = async (
    id: string,
    ifc: Record<string, unknown>,
    identity: ImplementationIdentity,
  ) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-writer-stamp",
        actingPrincipal: space,
      }),
    });
    const schema = {
      type: "object",
      properties: { count: { type: "number", ifc } },
      required: ["count"],
    } as JSONSchema;
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, identity);
    runtime.getCell(space, id, schema, tx).set({ count: 1 } as never);
    return await tx.commit().settled;
  };

  const refusalOf = (result: { error?: Error }): string => {
    expect(isCfcEnforcementRejection(result.error)).toBe(true);
    return String(result.error?.message);
  };

  describe("a `writeAuthorizedBy` binding claim", () => {
    // The binding's own writer stamps an unstamped claim with its module
    // identity, which is what the claim is then verified against.

    it("admits the writer it names, which stamps the claim", async () => {
      const result = await commitAs(
        "stamped",
        { writeAuthorizedBy: BINDING },
        writer("module:counter"),
      );
      expect(result.error).toBeUndefined();
    });

    it("refuses the writer it names where that writer has no module identity to stamp", async () => {
      const result = await commitAs(
        "unstamped",
        { writeAuthorizedBy: BINDING },
        writer(""),
      );
      expect(refusalOf(result)).toContain("writeAuthorizedBy failed at /count");
    });
  });

  describe("a `writePolicyAnyOf`", () => {
    it("admits the writer an alternative names", async () => {
      const result = await commitAs(
        "any-of",
        { writePolicyAnyOf: [{ writeAuthorizedBy: BINDING }] },
        writer("module:counter"),
      );
      expect(result.error).toBeUndefined();
    });

    it("refuses that writer where another alternative is not a record", async () => {
      const result = await commitAs(
        "any-of-malformed",
        { writePolicyAnyOf: ["setCount", { writeAuthorizedBy: BINDING }] },
        writer("module:counter"),
      );
      expect(refusalOf(result)).toContain(
        "malformed writePolicyAnyOf at /count",
      );
    });
  });
});
