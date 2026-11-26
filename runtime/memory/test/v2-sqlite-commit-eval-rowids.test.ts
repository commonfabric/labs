import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import type { SqliteParamsWire } from "../v2.ts";
import { applySqliteCommitWrite } from "../v2/sqlite/commit-eval.ts";
import { ensureTables, runQuery } from "../v2/sqlite/exec.ts";
import { all, dbOwner, match, principal } from "../v2/sqlite/row-label.ts";
import { table } from "../v2/sqlite/schema.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

// `email` is unique, so a REPLACE naming an email another row holds deletes
// that row as it inserts its own.
const contacts = table(
  { id: "integer primary key", email: "text unique" },
  (f) => ({
    confidentiality: all(principal("mailto", match(f.email, ADDR, { min: 1 }))),
  }),
);

// Declares no `rowid` column, while the file's table (created below) has one.
const legacy = table(
  { note: "text" },
  () => ({ confidentiality: all(dbOwner()) }),
);

const TABLES = { contacts, legacy };

const op = (sql: string, params?: SqliteParamsWire) => ({
  op: "sqlite" as const,
  db: {
    id: "of:commit-eval-rowids",
    tables: TABLES,
    owner: "did:key:owner",
  },
  sql,
  params,
});

describe("commit-eval", () => {
  describe("applySqliteCommitWrite()", () => {
    let db: Database;

    beforeEach(() => {
      db = new Database(":memory:");
      ensureTables(db, { contacts });
      db.exec('CREATE TABLE legacy ("rowid" TEXT, note TEXT)');
    });

    afterEach(() => {
      db.close();
    });

    it("returns both changes of a statement that writes one row twice, judging the row once", () => {
      const upsert = "INSERT INTO contacts (id, email) VALUES (1, ?), (1, ?) " +
        "ON CONFLICT(id) DO UPDATE SET email = excluded.email";
      const result = applySqliteCommitWrite(
        db,
        op(upsert, ["alice@a.example", "bob@b.example"]),
      );
      expect(result.changes).toBe(2);
      expect(runQuery(db, "SELECT id, email FROM contacts")).toEqual([
        { id: 1, email: "bob@b.example" },
      ]);
    });

    it("throws when the row a statement writes twice ends up violating the rule", () => {
      const upsert = "INSERT INTO contacts (id, email) VALUES (1, ?), (1, ?) " +
        "ON CONFLICT(id) DO UPDATE SET email = excluded.email";
      expect(() =>
        applySqliteCommitWrite(
          db,
          op(upsert, ["alice@a.example", "not an address"]),
        )
      ).toThrow("rowLabel rule rejected committed row (rowid 1)");
    });

    it("throws when a row the statement inserted is gone by the read-back", () => {
      // The second REPLACE takes the first row's email, deleting the row the
      // first one inserted, so one of the two affected rowids reads back
      // nothing.
      expect(() =>
        applySqliteCommitWrite(
          db,
          op("REPLACE INTO contacts (id, email) VALUES (1, ?), (2, ?)", [
            "alice@a.example",
            "alice@a.example",
          ]),
        )
      ).toThrow(
        'sqlite commit refused: read-back of rule-bearing table "contacts" ' +
          "found 1 of 2 affected rows",
      );
    });

    it("throws when an undeclared `rowid` column of the table holds no integer", () => {
      // The declaration leaves `rowid` unshadowed, so the evaluation reads
      // it, but the physical table's own `rowid` column answers instead.
      expect(() =>
        applySqliteCommitWrite(
          db,
          op("INSERT INTO legacy (note) VALUES (?)", ["hello"]),
        )
      ).toThrow(
        "sqlite commit refused: affected-row identification returned a " +
          'non-integer rowid for "legacy"',
      );
    });
  });
});
