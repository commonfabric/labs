import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("document member paths");
const space = signer.did();

const SOURCE_SCHEMA = {
  type: "object",
  properties: {
    secret: { type: "string", ifc: { confidentiality: ["secret"] } },
  },
} as const satisfies JSONSchema;

const TARGET_SCHEMA = {
  type: "object",
  properties: { note: { type: "string" }, slug: { type: "string" } },
} as const satisfies JSONSchema;

describe("document-member-paths", () => {
  // A document keeps its payload under `value`, and its other top-level
  // members, such as `slug` and `source`, are envelope metadata. A member and
  // a payload field of the same name are different places (spec §4.6.5).

  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  // Flow labels persist so a transaction's stamps reach the stored label map,
  // and writer-fit flags rather than refuses, since no target here declares a
  // ceiling for the secret it is handed.
  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
      trustSnapshotProvider: () => ({
        id: signer.did(),
        actingPrincipal: signer.did(),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /** Commits `value` under `schema` and returns the cell, read back synced. */
  const seed = async (name: string, schema: JSONSchema, value: unknown) => {
    const tx = runtime.edit();
    runtime.getCell(space, name, schema, tx).set(value as never);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const cell = runtime.getCell(space, name, schema);
    await cell.sync();
    return cell;
  };

  /** The paths of the label-map entries stored for `name`. */
  const storedEntryPaths = (name: string): string[][] => {
    const inspect = runtime.edit();
    const stored = readStoredCfcMetadata(
      inspect,
      runtime.getCell(space, name, TARGET_SCHEMA).getAsNormalizedFullLink(),
    );
    inspect.abort();
    return (stored?.labelMap.entries ?? []).map((entry) => [...entry.path]);
  };

  /**
   * Commits a transaction that reads the source's secret into the target's
   * `note`, and runs `alsoWrite` on the target in the same transaction.
   */
  const deriveIntoTarget = async (
    alsoWrite: (target: Cell<unknown>) => void,
  ) => {
    const source = await seed("member-source", SOURCE_SCHEMA, {
      secret: "s",
    });
    await seed("member-target", TARGET_SCHEMA, { note: "" });
    const tx = runtime.edit();
    const secret = String(source.withTx(tx).key("secret").get());
    const target = runtime.getCell(space, "member-target", TARGET_SCHEMA, tx);
    target.key("note").set(secret);
    alsoWrite(target as Cell<unknown>);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
  };

  it("labels no payload path for a write to the member `slug`", async () => {
    await deriveIntoTarget((target) => {
      target.setMetaRaw("slug", "a-slug", rawMetaWriteAuthorization);
    });

    const paths = storedEntryPaths("member-target");
    expect(paths).toContainEqual(["note"]);
    expect(paths).not.toContainEqual(["slug"]);
  });

  it("labels the payload field `slug` that the transaction writes", async () => {
    // The control: a payload write at the same name is labeled.

    await deriveIntoTarget((target) => {
      target.key("slug" as never).set("a-slug" as never);
    });

    expect(storedEntryPaths("member-target")).toContainEqual(["slug"]);
  });

  it("records a read of the member `slug` in the prepared digest apart from the payload field", async () => {
    await seed("member-target", TARGET_SCHEMA, { slug: "field" });
    const link = runtime.getCell(space, "member-target", TARGET_SCHEMA)
      .getAsNormalizedFullLink();
    const tx = runtime.edit() as ExtendedStorageTransaction;
    const address = {
      space: link.space,
      id: link.id,
      scope: link.scope,
      type: "application/json" as const,
    };
    tx.read({ ...address, path: ["slug"] });
    tx.read({ ...address, path: ["value", "slug"] });

    const reads = tx.accessForTestingOnly.buildPreparedDigestInput()
      .consumedReads.map(({ path, root }) => ({ path, root }));
    tx.abort();
    expect(reads).toEqual([
      { path: ["slug"], root: "document" },
      { path: ["slug"], root: undefined },
    ]);
  });
});
