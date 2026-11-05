// Engine-side execution against a real @db/sqlite database: guarded query/write
// and additive DDL. Proves the SQL half of Phase 1/2 without the websocket.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { GuardError } from "../v2/sqlite/guard.ts";
import { cfLink, table } from "../v2/sqlite/schema.ts";
import { ensureTables, runQuery, runWrite } from "../v2/sqlite/exec.ts";

describe("engine-side exec", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureTables(db, {
      messages: table({
        id: "integer primary key",
        author_cf_link: cfLink(),
        body: "text",
        ts: "integer",
      }),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("creates declared tables (additive)", () => {
    // The table exists iff querying it succeeds (sqlite_master is blocked by the
    // guard, which is correct — patterns must not introspect the schema catalog).
    const rows = runQuery<{ n: number }>(
      db,
      "SELECT count(*) AS n FROM messages",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("writes and reads back rows with positional params", () => {
    const w = runWrite(
      db,
      "INSERT INTO messages (author_cf_link, body, ts) VALUES (?, ?, ?)",
      ["sigil-string", "hello", 100],
    );
    expect(w.changes).toBe(1);
    expect(typeof w.lastInsertRowid).toBe("number");

    const rows = runQuery<{ body: string; ts: number }>(
      db,
      "SELECT body, ts FROM messages ORDER BY ts",
    );
    expect(rows).toEqual([{ body: "hello", ts: 100 }]);
  });

  it("supports named params", () => {
    runWrite(
      db,
      "INSERT INTO messages (author_cf_link, body, ts) VALUES (:a, :b, :ts)",
      { a: "s", b: "world", ts: 5 },
    );
    const rows = runQuery<{ body: string }>(
      db,
      "SELECT body FROM messages WHERE ts = :ts",
      { ts: 5 },
    );
    expect(rows).toEqual([{ body: "world" }]);
  });

  it("rejects a write through the read path and vice versa", () => {
    expect(() => runQuery(db, "INSERT INTO messages (body) VALUES ('x')"))
      .toThrow(GuardError);
    expect(() => runWrite(db, "SELECT * FROM messages")).toThrow(GuardError);
  });

  it("rejects references to core tables", () => {
    expect(() => runQuery(db, "SELECT * FROM commit")).toThrow(GuardError);
  });
});
