// Storage-level proof that a folded SQLite write commits ATOMICALLY with cell
// ops in the same transaction (the seam db.exec is built on): one commit carries
// cell ops + a `sqlite` op; on SQL failure the whole commit aborts and the
// sibling cell write rolls back. (Engine rollback is proven in
// packages/memory/test/v2-sqlite-atomic.test.ts; this proves the RUNNER wires
// recordSqliteWrite -> getNativeCommit -> buildCommit.)

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";

describe("folded sqlite write (commit atomicity at the runner)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let signer: Identity;
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(`fold-${crypto.randomUUID()}`);
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("commits a cell write and a folded INSERT together (both visible)", async () => {
    const db: SqliteDbRef = {
      id: `of:fold-ok-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };

    const tx = runtime.edit();
    const marker = runtime.getCell<{ ok: boolean }>(
      space,
      "fold-marker",
      undefined,
      tx,
    );
    marker.withTx(tx).set({ ok: true });
    tx.recordSqliteWrite!(space, {
      op: "sqlite",
      db,
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["hi"],
    });
    const res = await tx.commit().settled;
    expect(res.error).toBeUndefined();

    // The row landed.
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(db, "SELECT body FROM notes");
    expect(r.rows).toEqual([{ body: "hi" }]);

    // The sibling cell write landed (read in a fresh tx).
    const tx2 = runtime.edit();
    const m = runtime.getCell<{ ok: boolean }>(
      space,
      "fold-marker",
      undefined,
      tx2,
    )
      .withTx(tx2).get();
    expect(m).toEqual({ ok: true });
    await tx2.commit().settled;
  });

  it("commits a sqlite-only transaction (no cell ops dropped)", async () => {
    const db: SqliteDbRef = {
      id: `of:fold-only-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, {
      op: "sqlite",
      db,
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["solo"],
    });
    const res = await tx.commit().settled;
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(db, "SELECT body FROM notes");
    expect(r.rows).toEqual([{ body: "solo" }]);
  });

  it("aborts the whole commit on SQL failure (sibling cell write rolls back)", async () => {
    const db: SqliteDbRef = {
      id: `of:fold-fail-${crypto.randomUUID()}`,
      tables: {
        notes: table({ id: "integer primary key", body: "text not null" }),
      },
    };

    const tx = runtime.edit();
    const marker = runtime.getCell<{ touched: boolean }>(
      space,
      "rollback-marker",
      undefined,
      tx,
    );
    marker.withTx(tx).set({ touched: true });
    // NOT NULL violation -> the sqlite op throws inside applyCommit -> abort.
    tx.recordSqliteWrite!(space, {
      op: "sqlite",
      db,
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: [null],
    });
    const res = await tx.commit().settled;
    expect(res.error).toBeDefined();

    // The sibling cell write did NOT persist.
    const tx2 = runtime.edit();
    const m = runtime.getCell<{ touched: boolean }>(
      space,
      "rollback-marker",
      undefined,
      tx2,
    ).withTx(tx2).get();
    expect(m).toBeUndefined();

    // No row landed.
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      db,
      "SELECT count(*) AS c FROM notes",
    );
    expect((r.rows[0] as { c: number }).c).toBe(0);
    await tx2.commit().settled;
  });
});
