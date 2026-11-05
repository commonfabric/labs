import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("memory-v2-trackread-validation");
const space = signer.did();
const type = "application/json" as const;

describe("trackReadWithoutLoad validation", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storage = StorageManager.emulate({
      as: signer,
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  it("rejects commit when a trackReadWithoutLoad document was concurrently modified", async () => {
    const docId = "of:trackread-validation-concurrent" as const;

    // Seed the document with an initial value.
    const seedTx = storage.edit();
    const seedWrite = seedTx.write(
      { space, id: docId, type, path: [] },
      { value: { count: 0 } },
    );
    assert(seedWrite.ok, "seed write should succeed");
    const seedCommit = await seedTx.commit().settled;
    assert(seedCommit.ok, "seed commit should succeed");

    // Start tx1 and do a trackReadWithoutLoad read.
    const tx1 = storage.edit();
    const readResult = tx1.read(
      { space, id: docId, type, path: [] },
      { trackReadWithoutLoad: true },
    );
    assert(readResult.ok, "trackReadWithoutLoad should succeed");

    // Concurrently modify the same document via tx2.
    const tx2 = storage.edit();
    const writeResult = tx2.write(
      { space, id: docId, type, path: [] },
      { value: { count: 999 } },
    );
    assert(writeResult.ok, "concurrent write should succeed");
    const tx2Commit = await tx2.commit().settled;
    assert(tx2Commit.ok, "concurrent commit should succeed");

    // Now write something in tx1 (to a different doc) so it has operations.
    const tx1Write = tx1.write(
      { space, id: "of:trackread-other-doc", type, path: [] },
      { value: { unrelated: true } },
    );
    assert(tx1Write.ok, "tx1 write should succeed");

    // tx1's commit should detect that the trackReadWithoutLoad document
    // was modified and reject with an inconsistency error.
    const tx1Commit = await tx1.commit().settled;
    assert(
      tx1Commit.error,
      "commit should fail because trackReadWithoutLoad document was concurrently modified",
    );
    assertEquals(
      tx1Commit.error.name,
      "StorageTransactionInconsistent",
      "error should be StorageTransactionInconsistent",
    );
  });
});

describe("multi-write previousValue tracking", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storage = StorageManager.emulate({
      as: signer,
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  it("preserves original previousValue across multiple writes to same path", async () => {
    const docId = "of:multi-write-prev" as const;

    // Seed with initial value — root document has { a: "original", b: 1 }.
    const seedTx = storage.edit();
    seedTx.write(
      { space, id: docId, type, path: [] },
      { a: "original", b: 1 },
    );
    await seedTx.commit().settled;

    // Start a new transaction, write to ["a"] twice.
    const tx = storage.edit();
    // Read first to load the document and mark it validated.
    tx.read({ space, id: docId, type, path: [] });

    tx.write(
      { space, id: docId, type, path: ["a"] },
      "first-write",
    );
    tx.write(
      { space, id: docId, type, path: ["a"] },
      "second-write",
    );

    // getWriteDetails gives direct access to the path-level write details.
    const details = [...(tx.getWriteDetails?.(space) ?? [])];
    const aDetail = details.find(
      (d) =>
        d.address.id === docId &&
        d.address.path.length === 1 &&
        d.address.path[0] === "a",
    );

    // previousValue should be "original" (the value before the transaction),
    // NOT "first-write" — multiple writes to the same path must preserve the
    // pre-transaction previousValue.
    expect(aDetail).toBeDefined();
    expect(aDetail!.previousValue).toBe("original");
    expect(aDetail!.value).toBe("second-write");

    // The journal history should also yield the original previousValue.
    const historyEntries = [...tx.journal.history(space)];
    const aHistory = historyEntries.find(
      (entry) =>
        entry.address.id === docId &&
        entry.address.path.length === 1 &&
        entry.address.path[0] === "a",
    );
    expect(aHistory).toBeDefined();
    expect(aHistory!.value).toBe("original");

    // The journal novelty should yield the latest written value.
    const noveltyEntries = [...tx.journal.novelty(space)];
    const aNovelty = noveltyEntries.find(
      (entry) =>
        entry.address.id === docId &&
        entry.address.path.length === 1 &&
        entry.address.path[0] === "a",
    );
    expect(aNovelty).toBeDefined();
    expect(aNovelty!.value).toBe("second-write");

    await tx.commit().settled;
  });
});
