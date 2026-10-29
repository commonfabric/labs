// ATTACH layer: a cell-derived database is a separate file attached to the
// engine connection under an internal alias. DDL must target the alias (SQLite
// has no default-schema switch), while reads/writes stay unqualified and resolve
// to the attached db because `main` lacks those tables. (spec 04, Q6->A)

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { cfLink, table } from "../v2/sqlite/schema.ts";
import {
  attachDatabase,
  detachDatabase,
  ensureTables,
  runQuery,
  runWrite,
} from "../v2/sqlite/exec.ts";

describe("sqlite attach layer", () => {
  let db: Database;
  let path: string;

  beforeEach(() => {
    db = new Database(":memory:");
    path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  });

  afterEach(() => {
    db.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  });

  it("attaches a file, creates tables in the alias, R/W unqualified", () => {
    attachDatabase(db, "db_test", path);
    ensureTables(db, {
      messages: table({
        id: "integer primary key",
        author_cf_link: cfLink(),
        body: "text",
      }),
    }, "db_test");

    const w = runWrite(
      db,
      "INSERT INTO messages (author_cf_link, body) VALUES (?, ?)",
      ["sigil", "hi"],
    );
    expect(w.changes).toBe(1);

    // Unqualified name resolves to the attached db (main has no `messages`).
    const rows = runQuery<{ body: string }>(db, "SELECT body FROM messages");
    expect(rows).toEqual([{ body: "hi" }]);

    detachDatabase(db, "db_test");
  });

  it("persists across detach/re-attach (file-backed)", () => {
    attachDatabase(db, "db_a", path);
    ensureTables(db, { kv: table({ k: "text", v: "text" }) }, "db_a");
    runWrite(db, "INSERT INTO kv (k, v) VALUES (?, ?)", ["x", "1"]);
    detachDatabase(db, "db_a");

    attachDatabase(db, "db_b", path);
    const rows = runQuery<{ v: string }>(db, "SELECT v FROM kv WHERE k = ?", [
      "x",
    ]);
    expect(rows).toEqual([{ v: "1" }]);
    detachDatabase(db, "db_b");
  });

  it("rejects an unsafe attach alias", () => {
    expect(() => attachDatabase(db, "bad alias;", path)).toThrow();
    expect(() => attachDatabase(db, "main", path)).toThrow();
  });
});
