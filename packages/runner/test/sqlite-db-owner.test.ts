// The sqlite db handle's `owner` (CFC Phase 3: resolves the row rule's
// dbOwner() and {__ctDbOwner} ceiling placeholders) is minted ONCE, by the
// initialization that CREATES the handle. The sqliteDatabase builtin re-runs
// its init in every runtime that opens the piece (the action's `initialized`
// guard is per scoped instance), so a re-initialization must preserve the
// committed owner rather than re-mint the CURRENT acting principal — last
// opener wins would rotate row-read authority to whoever opened the piece
// most recently. Companion multi-runtime repro:
// packages/patterns/integration/sqlite-db-owner-multi-runtime.test.ts.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("sqliteDatabase handle owner", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  // Swappable acting principal: models a DIFFERENT user's runtime re-running
  // the builtin without needing a second realm.
  let acting: string;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    acting = "did:test:alice";
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: `principal:${acting}`,
        actingPrincipal: acting,
        revision: "test",
      }),
    });
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("mints owner at creation and keeps it across re-initialization by another principal", async () => {
    const dbPattern = cf.pattern(() =>
      cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      })
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "sqlite-db-owner",
      dbPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, dbPattern, {}, resultCell);
    await tx.commit().settled;

    const minted = await waitForCellValue<SqliteDbRef>(
      runtime,
      result,
      (v) => v?.owner !== undefined,
    );
    expect(minted.owner).toBe("did:test:alice");

    // Re-initialization: stop the piece and run the same pattern into the
    // same result cell (same causal ids → same committed handle) with a
    // fresh builtin instance acting as ANOTHER principal — the single-realm
    // equivalent of a second user's runtime opening the piece.
    runtime.runner.stop(result);
    acting = "did:test:bob";
    const tx2 = runtime.edit();
    runtime.run(tx2, dbPattern, {}, resultCell);
    await tx2.commit().settled;

    // A correct re-initialization leaves the handle value UNCHANGED, so there
    // is no value transition to wait for — a `waitForCellValue(owner defined)`
    // would be satisfied by the pre-restart state before the re-run executes.
    // Instead drive the fresh builtin action under observation (pull-mode
    // runs effects only while observed) and wait for full quiescence
    // (red-checked: an unconditional re-mint IS observed after this wait).
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      await runtime.settled();
    } finally {
      cancel();
    }

    expect((result.get() as SqliteDbRef).owner).toBe("did:test:alice");
  });
});
