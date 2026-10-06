import { assert, assertEquals } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("memory-v2-confirm-pending");
const space = signer.did();
const type = "application/json" as const;

describe("concurrent commits via emulated v2 storage", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storage = StorageManager.emulate({
      as: signer,
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  it("two concurrent commits to different documents both succeed", async () => {
    // Commit A — writes doc A.
    const txA = storage.edit();
    txA.write(
      { space, id: "of:concurrent-A", type, path: [] },
      { a: 1 },
    );

    // Commit B — writes doc B.
    const txB = storage.edit();
    txB.write(
      { space, id: "of:concurrent-B", type, path: [] },
      { b: 2 },
    );

    // Fire both commits concurrently.
    const [resultA, resultB] = await Promise.all([
      txA.commit().settled,
      txB.commit().settled,
    ]);
    assert(resultA.ok, "commit A should succeed");
    assert(resultB.ok, "commit B should succeed");
  });

  it("concurrent write to the same document — second commit sees conflict", async () => {
    // Seed the document.
    const seedTx = storage.edit();
    seedTx.write(
      { space, id: "of:concurrent-same-doc", type, path: [] },
      { count: 0 },
    );
    await seedTx.commit().settled;

    // Both transactions read the same initial state.
    const txA = storage.edit();
    txA.read({ space, id: "of:concurrent-same-doc", type, path: [] });
    txA.write(
      { space, id: "of:concurrent-same-doc", type, path: ["count"] },
      1,
    );

    const txB = storage.edit();
    txB.read({ space, id: "of:concurrent-same-doc", type, path: [] });
    txB.write(
      { space, id: "of:concurrent-same-doc", type, path: ["count"] },
      2,
    );

    // Commit A first — it should succeed.
    const resultA = await txA.commit().settled;
    assert(resultA.ok, "commit A should succeed");

    // Commit B should fail because the document changed under it.
    const resultB = await txB.commit().settled;
    assert(
      resultB.error,
      "commit B should fail due to concurrent modification",
    );
    assertEquals(
      resultB.error.name,
      "StorageTransactionInconsistent",
    );
  });

  it("rejection of one transaction does not affect an independent one", async () => {
    // Seed doc A.
    const seedTx = storage.edit();
    seedTx.write(
      { space, id: "of:reject-independent-A", type, path: [] },
      { count: 0 },
    );
    await seedTx.commit().settled;

    // txA will conflict — read then another tx mutates before it commits.
    const txA = storage.edit();
    txA.read({ space, id: "of:reject-independent-A", type, path: [] });

    // Interleave a mutation to cause txA to conflict.
    const interleave = storage.edit();
    interleave.write(
      { space, id: "of:reject-independent-A", type, path: [] },
      { count: 999 },
    );
    await interleave.commit().settled;

    txA.write(
      { space, id: "of:reject-independent-A", type, path: ["count"] },
      42,
    );

    // txB is completely independent.
    const txB = storage.edit();
    txB.write(
      { space, id: "of:reject-independent-B", type, path: [] },
      { label: "independent" },
    );

    const resultA = await txA.commit().settled;
    assert(resultA.error, "commit A should fail");

    const resultB = await txB.commit().settled;
    assert(resultB.ok, "commit B should succeed independently");
  });

  it("three sequential commits where middle fails — first and third are ok", async () => {
    // Seed.
    const seedTx = storage.edit();
    seedTx.write(
      { space, id: "of:three-seq-A", type, path: [] },
      { version: 0 },
    );
    await seedTx.commit().settled;

    // Commit 1 — succeeds.
    const tx1 = storage.edit();
    tx1.write(
      { space, id: "of:three-seq-A", type, path: [] },
      { version: 1 },
    );
    const result1 = await tx1.commit().settled;
    assert(result1.ok, "commit 1 should succeed");

    // tx2 reads old state, then we interleave a mutation.
    const tx2 = storage.edit();
    tx2.read({ space, id: "of:three-seq-A", type, path: [] });

    const interleave = storage.edit();
    interleave.write(
      { space, id: "of:three-seq-A", type, path: [] },
      { version: 2 },
    );
    await interleave.commit().settled;

    tx2.write(
      { space, id: "of:three-seq-A", type, path: ["version"] },
      42,
    );
    const result2 = await tx2.commit().settled;
    assert(result2.error, "commit 2 should fail (conflict)");

    // Commit 3 to different doc — succeeds.
    const tx3 = storage.edit();
    tx3.write(
      { space, id: "of:three-seq-B", type, path: [] },
      { version: 3 },
    );
    const result3 = await tx3.commit().settled;
    assert(result3.ok, "commit 3 should succeed");
  });
});
