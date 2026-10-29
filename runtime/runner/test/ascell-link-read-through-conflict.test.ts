// Verification for review feedback (ubik2/robin) on #4220's Half A
// (excludeReadFromConflict): excluding the asCell *reference-resolution* read
// from the commit-conflict set must NOT exclude a value read *through* the link.
// A holder that reads a linked value and branches on it still depends on that
// value — a concurrent change to it must invalidate the holder's commit.
//
// Scenario (robin's example):
//   cellB = { isAdmin: true }
//   cellA = { isAdmin -> link to cellB.isAdmin }   (read via an asCell schema)
//   holder reads cellA.isAdmin THROUGH the link (consuming `true`) and writes.
//   A concurrent writer sets cellB.isAdmin = false.
//   => the holder's commit must conflict.

import { assert } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "ascell-link-read-through-conflict",
);
const space = signer.did();

const asCellSchema = {
  type: "object",
  properties: { isAdmin: { asCell: ["cell"] } },
  required: ["isAdmin"],
} as const satisfies JSONSchema;

describe("asCell link: value read-through stays a commit-conflict dependency", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    tx = runtime.edit();
  });
  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storage?.close();
  });

  // Seed cellB = { isAdmin: true } and cellA = { isAdmin: <link to cellB.isAdmin> }.
  const seed = async () => {
    const cellB = runtime.getCell<{ isAdmin: boolean }>(
      space,
      "cellB",
      undefined,
      tx,
    );
    cellB.set({ isAdmin: true });
    const cellA = runtime.getCell(space, "cellA", true, tx);
    cellA.setRaw({ isAdmin: cellB.key("isAdmin").getAsLink() });
    await tx.commit().settled;
    tx = runtime.edit();
    return { cellA, cellB };
  };

  it("the read-through lands in the commit-conflict set", async () => {
    const { cellA, cellB } = await seed();

    const holder = cellA.withTx(tx).asSchema(asCellSchema).get() as unknown as {
      isAdmin: { get: () => boolean };
    };
    expect(holder.isAdmin.get()).toBe(true);

    const replica = storage.open(space).replica as SpaceReplica;
    const confirmed = replica.accessForTestingOnly.buildReads(tx.tx, 1)
      .confirmed;
    const cellBId = cellB.getAsNormalizedFullLink().id;
    assert(
      confirmed.some((r) => r.id === cellBId && r.path.includes("isAdmin")),
      "cellB.isAdmin (the linked value) must be a commit-conflict dependency; " +
        `confirmed = ${
          confirmed.map((r) => r.id.slice(-6) + "/" + r.path.join("."))
        }`,
    );
  });

  it("a concurrent change to the linked value conflicts the holder's commit", async () => {
    const { cellA, cellB } = await seed();
    const cellC = runtime.getCell<string>(space, "cellC", undefined, tx);

    // Holder: read isAdmin through the link, branch, write — keep tx open.
    const holder = cellA.withTx(tx).asSchema(asCellSchema).get() as unknown as {
      isAdmin: { get: () => boolean };
    };
    const isAdmin = holder.isAdmin.get();
    expect(isAdmin).toBe(true);
    if (isAdmin) cellC.withTx(tx).set("allowed because isAdmin was true");

    // Concurrent writer flips the linked value.
    const writerTx = runtime.edit();
    cellB.withTx(writerTx).key("isAdmin").set(false);
    expect((await writerTx.commit().settled).ok).toBeDefined();

    // The holder's late commit must be rejected — it read a value that changed.
    const committed = await tx.commit().settled;
    assert(
      committed.error !== undefined,
      "holder's commit must conflict (it read cellB.isAdmin, which changed); " +
        `got ok=${JSON.stringify(committed.ok)}`,
    );
    tx = runtime.edit();
  });
});
