import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { checkSqliteWriteCeiling } from "../../../src/builtins/sqlite/write-ceiling.ts";

type Tables = Parameters<typeof checkSqliteWriteCeiling>[2];

const labeled: Tables = {
  notes: {
    properties: {
      secret_col: { ifc: { confidentiality: ["secret"] } },
      pub: {},
    },
  },
};

const unlabeled: Tables = {
  notes: { properties: { secret_col: {}, pub: {} } },
};

const unlabeledValues = () => [];

const check = (sql: string, tables: Tables = labeled) =>
  checkSqliteWriteCeiling(sql, undefined, tables, unlabeledValues);

describe("checkSqliteWriteCeiling()", () => {
  describe("a paramless write on a labeled database", () => {
    // With nothing bound, the check reads the statement itself: a write that
    // could copy column data into a stored position is refused, and one that
    // stores only literals is not.

    it("returns a refusal for an UPDATE with no SET clause", () => {
      expect(check("UPDATE notes")).toMatch(/paramless write moves column/);
    });

    it("returns a refusal for a SET list that assigns a column, whatever clause follows it", () => {
      expect(check("UPDATE notes SET pub = secret_col WHERE pub = 1"))
        .toMatch(/paramless write moves column/);
    });

    it("returns a refusal for a parenthesized expression in the SET list", () => {
      expect(check("UPDATE notes SET pub = coalesce(secret_col, 0)"))
        .toMatch(/paramless write moves column/);
      expect(check("UPDATE notes SET pub = 1, secret_col = (1)"))
        .toMatch(/paramless write moves column/);
    });

    it("returns a refusal for a SET list whose parentheses do not balance", () => {
      expect(check("UPDATE notes SET pub = (1 WHERE pub = 1")).toMatch(
        /paramless write moves column/,
      );
    });

    it("returns `undefined` for a literal assigned to a quoted column whose name holds a comma", () => {
      // The comma splits the assignment in two, and the half holding no `=`
      // stores nothing.
      expect(check('UPDATE notes SET "pub,x" = 1')).toBeUndefined();
      expect(check('UPDATE notes SET "pub,x" = secret_col')).toMatch(
        /paramless write moves column/,
      );
    });

    it("returns a refusal for a statement that is neither INSERT, REPLACE, UPDATE nor DELETE", () => {
      const sql = "WITH src AS (SELECT secret_col FROM notes) " +
        "INSERT INTO notes (pub) SELECT secret_col FROM src";
      expect(check(sql)).toMatch(/paramless write moves column/);
      expect(check(sql, unlabeled)).toBeUndefined();
    });
  });
});
