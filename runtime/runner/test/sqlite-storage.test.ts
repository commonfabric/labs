// Runner-side integration: the storage provider's read path (sqliteQuery) routes
// through the emulated in-process memory server (same loopback path the real
// websocket uses), and the write path is the commit fold (a `sqlite` op in a tx,
// applied atomically by the engine). There is no standalone write RPC. Proves
// the runner -> server SQLite path end to end, and that the statement guard
// rejects core-table access on both paths.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { cfLink, table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("storage provider sqlite passthrough (emulated server)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const dbRef = (): SqliteDbRef => ({
    id: `of:test-${crypto.randomUUID()}`,
    tables: {
      notes: table({ id: "integer primary key", body: "text" }),
      links: table({ id: "integer primary key", target_cf_link: cfLink() }),
    },
  });

  // Seed via the real write path: a folded `sqlite` op committed in a tx.
  const seedSqlite = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ) => {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    return await tx.commit().settled;
  };

  it("writes (folded commit) and queries (provider) end to end", async () => {
    const db = dbRef();

    const res = await seedSqlite(
      db,
      "INSERT INTO notes (body) VALUES (?)",
      ["hello from runner"],
    );
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(db, "SELECT body FROM notes");
    expect(r.rows).toEqual([{ body: "hello from runner" }]);
  });

  it("propagates guard rejections as errors (read + folded write)", async () => {
    const provider = storageManager.open(space);
    const db = dbRef();
    // Read guard: a core-table SELECT is rejected at the provider.
    await expect(provider.sqliteQuery!(db, "SELECT * FROM commit")).rejects
      .toThrow();
    // Write guard: a folded DDL op aborts the whole commit.
    const res = await seedSqlite(db, "DROP TABLE notes");
    expect(res.error).toBeDefined();
  });
});
