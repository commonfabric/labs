// Phase 7 — injected on-disk SQLite source (read-only v1).
//
// Two seams proven here without the websocket:
//   1. read-only ATTACH: a seeded on-disk file is attached read-only; SELECT
//      returns its rows, but any write to the alias is rejected at the engine.
//   2. DiskSourceRegistry: register/get a `{ disk: { path } }` descriptor keyed
//      by the handle cell id.
//
// Spec: docs/specs/sqlite-builtin/03-database-sources.md §03.3; plan
// docs/specs/sqlite-builtin/03-database-sources.md. Writes/reactivity for
// on-disk sources are deferred (Q12/Q13/Q14).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { ReadConnectionPool } from "../v2/sqlite/read-pool.ts";
import { DiskSourceRegistry } from "../v2/sqlite/disk-source.ts";
import { Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import type { SqliteDbRef } from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

function seedDiskDb(path: string): void {
  const seed = new Database(path);
  seed.exec("CREATE TABLE lookup (k TEXT, v TEXT)");
  seed.exec("INSERT INTO lookup (k, v) VALUES ('a', '1'), ('b', '2')");
  seed.close();
}

describe("ReadConnectionPool (read-only, unattached)", () => {
  let pool: ReadConnectionPool;
  let path: string;

  beforeEach(() => {
    pool = new ReadConnectionPool();
    path = Deno.makeTempFileSync({ suffix: ".sqlite" });
    seedDiskDb(path);
  });

  afterEach(() => {
    pool.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  });

  it("reads rows from the on-disk file on a pooled connection (reused)", () => {
    const rows = pool.query<{ v: string }>(
      path,
      "SELECT v FROM lookup ORDER BY k",
    );
    expect(rows).toEqual([{ v: "1" }, { v: "2" }]);
    // Same path → reuses the same pooled connection.
    const again = pool.query<{ v: string }>(path, "SELECT v FROM lookup");
    expect(again.length).toBe(2);
  });

  it("rejects a write through the pool (guard + read-only connection)", () => {
    expect(() => pool.query(path, "DELETE FROM lookup")).toThrow();
  });
});

describe("DiskSourceRegistry", () => {
  const SPACE_A = "did:key:z6Mk-a";
  const SPACE_B = "did:key:z6Mk-b";

  it("registers and resolves a disk descriptor by (space, id)", () => {
    const reg = new DiskSourceRegistry();
    expect(reg.get(SPACE_A, "of:bafy123")).toBeUndefined();
    reg.register(SPACE_A, "of:bafy123", { path: "/abs/reference-data.db" });
    expect(reg.get(SPACE_A, "of:bafy123")).toEqual({
      path: "/abs/reference-data.db",
    });
  });

  it("is keyed by space — a registration does not leak across spaces", () => {
    const reg = new DiskSourceRegistry();
    reg.register(SPACE_A, "of:x", { path: "/abs/x.db" });
    expect(reg.has(SPACE_A, "of:x")).toBe(true);
    // Same id, different space → NOT registered (no cross-space hijack).
    expect(reg.has(SPACE_B, "of:x")).toBe(false);
    expect(reg.get(SPACE_B, "of:x")).toBeUndefined();
  });

  it("caps total entries (rejects new keys past the cap; re-register ok)", () => {
    const reg = new DiskSourceRegistry(2);
    reg.register(SPACE_A, "of:1", { path: "/a/1.db" });
    reg.register(SPACE_A, "of:2", { path: "/a/2.db" });
    // A NEW (space,id) past the cap is rejected.
    expect(() => reg.register(SPACE_A, "of:3", { path: "/a/3.db" })).toThrow(
      "registry is full",
    );
    // Re-registering an existing key is always allowed (idempotent), even full.
    expect(() => reg.register(SPACE_A, "of:1", { path: "/a/1b.db" })).not
      .toThrow();
    expect(reg.get(SPACE_A, "of:1")).toEqual({ path: "/a/1b.db" });
  });
});

const SPACE = "did:key:z6Mk-sqlite-disk-source-test";

describe("server attaches a registered on-disk source (read-only v1)", () => {
  let server: Server;
  let client: Awaited<ReturnType<typeof connect>>;
  // deno-lint-ignore no-explicit-any
  let session: any;
  let diskPath: string;
  let handleId: string;

  beforeEach(async () => {
    diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
    seedDiskDb(diskPath);
    handleId = `of:disk-${crypto.randomUUID()}`;
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://sqlite-disk-source-test"),
    });
    client = await connect({ transport: loopback(server) });
    session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    try {
      Deno.removeSync(diskPath);
    } catch { /* ignore */ }
  });

  const dbRef = (): SqliteDbRef => ({ id: handleId });

  it("query reads rows from the registered on-disk file, not a cell-db", async () => {
    // No registration yet → falls back to the cell-derived db. It has never been
    // written, so there is no file and the read yields no rows (NOT the on-disk
    // file's rows).
    const before = await session.sqliteQuery(dbRef(), "SELECT v FROM lookup");
    expect(before.rows).toEqual([]);

    // Register the on-disk source for this handle id, then the same query
    // resolves against the on-disk file's rows.
    await session.registerSqliteDiskSource(handleId, diskPath);
    const r = await session.sqliteQuery(
      dbRef(),
      "SELECT v FROM lookup ORDER BY k",
    );
    expect(r.rows).toEqual([{ v: "1" }, { v: "2" }]);
  });

  it("rejects writes to an injected on-disk source (read-only v1)", async () => {
    await session.registerSqliteDiskSource(handleId, diskPath);
    // The only write path is the commit fold; a folded write to an injected
    // (read-only) source is rejected before any attach.
    await expect(
      session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "sqlite",
            db: dbRef(),
            sql: "INSERT INTO lookup (k, v) VALUES ('c', '3')",
          },
        ],
      }),
    ).rejects.toThrow();
    // The on-disk file is unchanged.
    const r = await session.sqliteQuery(
      dbRef(),
      "SELECT count(*) AS n FROM lookup",
    );
    expect(r.rows).toEqual([{ n: 2 }]);
  });

  it("rejects a non-absolute or missing path at registration", async () => {
    await expect(session.registerSqliteDiskSource(handleId, "relative/x.db"))
      .rejects.toThrow();
    await expect(
      session.registerSqliteDiskSource(handleId, "/no/such/file/here.db"),
    ).rejects.toThrow();
  });

  it("does not leak a registration across spaces (C2)", async () => {
    const session2 = await client.mount(
      "did:key:z6Mk-sqlite-disk-source-test-2",
      {},
      testSessionOpenAuthFactory,
    );
    // Register the on-disk source under SPACE (session), NOT the second space.
    await session.registerSqliteDiskSource(handleId, diskPath);
    // The second space's read of the same handle id is not governed by SPACE's
    // registration → it falls through to its own (never-written, empty)
    // cell-derived db and yields NO rows — crucially, not the injected file's
    // rows. No cross-space read of the injected file.
    const r = await session2.sqliteQuery(dbRef(), "SELECT v FROM lookup");
    expect(r.rows).toEqual([]);
  });
});
