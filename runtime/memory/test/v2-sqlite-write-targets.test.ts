// Unit tests for parseWriteParamColumns: maps each positional `?` to its target
// column for the CFC write-ceiling check. Security-critical → fail closed on
// anything it can't confidently attribute.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  parseWriteParamColumns,
  parseWriteTable,
} from "../v2/sqlite/write-targets.ts";

describe("parseWriteParamColumns — determinable shapes", () => {
  it("INSERT with explicit column list", () => {
    expect(parseWriteParamColumns("INSERT INTO t (a, b) VALUES (?, ?)"))
      .toEqual(["a", "b"]);
  });

  it("INSERT cycles columns across multi-row VALUES", () => {
    expect(
      parseWriteParamColumns("INSERT INTO t (a, b) VALUES (?, ?), (?, ?)"),
    ).toEqual(["a", "b", "a", "b"]);
  });

  it("UPDATE SET maps SET params; WHERE params are null", () => {
    expect(
      parseWriteParamColumns("UPDATE t SET a = ?, b = ? WHERE id = ?"),
    ).toEqual(["a", "b", null]);
  });

  it("UPDATE with a COMPLEX WHERE — SET still mapped, all WHERE params null", () => {
    expect(
      parseWriteParamColumns(
        "UPDATE t SET body = ? WHERE id = ? AND (score > ? OR tag IN (?, ?))",
      ),
    ).toEqual(["body", null, null, null, null]);
  });

  it("UPDATE with quoted/bracketed SET identifiers", () => {
    expect(parseWriteParamColumns('UPDATE t SET "wei rd" = ? WHERE id = ?'))
      .toEqual(["wei rd", null]);
  });

  it("DELETE — every param is a filter (null), no column write", () => {
    expect(parseWriteParamColumns("DELETE FROM t WHERE a = ? AND b = ?"))
      .toEqual([null, null]);
  });

  it("no placeholders → empty mapping", () => {
    expect(parseWriteParamColumns("DELETE FROM t WHERE a = 1")).toEqual([]);
  });

  it("is not fooled by `?`/keywords/commas inside string literals", () => {
    expect(
      parseWriteParamColumns(
        "UPDATE t SET a = ? WHERE note = 'x, where set ? y' AND id = ?",
      ),
    ).toEqual(["a", null]);
  });
});

describe("parseWriteParamColumns — fail closed (undefined)", () => {
  const failsClosed = (sql: string) =>
    expect(parseWriteParamColumns(sql)).toBeUndefined();

  it("columnless INSERT", () => failsClosed("INSERT INTO t VALUES (?, ?)"));
  it("INSERT … SELECT", () =>
    failsClosed("INSERT INTO t (a) SELECT x FROM u WHERE y = ?"));
  it("upsert DO UPDATE binds in the conflict clause", () =>
    failsClosed(
      "INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET b = ?",
    ));
  it("UPDATE with a non-`?` SET expression", () =>
    failsClosed("UPDATE t SET a = b + ? WHERE id = ?"));
  it("UPDATE with a subquery in SET", () =>
    failsClosed("UPDATE t SET a = (SELECT x FROM u WHERE z = ?) WHERE id = ?"));
  it("UPDATE tuple assignment", () =>
    failsClosed("UPDATE t SET (a, b) = (?, ?) WHERE id = ?"));
  it("named params (positional attribution unsafe)", () =>
    failsClosed("UPDATE t SET a = :a WHERE id = :id"));
  it("numbered params", () =>
    failsClosed("INSERT INTO t (a, b) VALUES (?1, ?2)"));
  it("WITH-prefixed write (unparsed shape)", () =>
    failsClosed("WITH c AS (SELECT 1) UPDATE t SET a = ? WHERE id = ?"));

  // A VALUES tuple with an interleaved literal/expression breaks positional
  // `?`→column attribution (the `?` no longer lines up with the column list).
  it("INSERT with a literal interleaved in VALUES", () =>
    failsClosed("INSERT INTO t (a, b) VALUES ('hi', ?)"));
  it("INSERT with a numeric literal interleaved in VALUES", () =>
    failsClosed("INSERT INTO t (a, b) VALUES (?, 1)"));
  it("INSERT with an expression in VALUES", () =>
    failsClosed("INSERT INTO t (a) VALUES (lower(?))"));
});

describe("parseWriteParamColumns — RETURNING after all-? VALUES still maps", () => {
  it("attributes when the value tuples are bare ?", () => {
    expect(parseWriteParamColumns("INSERT INTO t (a) VALUES (?) RETURNING id"))
      .toEqual(["a"]);
  });
  it("tolerates a trailing semicolon", () => {
    expect(parseWriteParamColumns("INSERT INTO t (a, b) VALUES (?, ?);"))
      .toEqual(["a", "b"]);
  });
});

describe("parseWriteTable", () => {
  it("INSERT target", () =>
    expect(parseWriteTable("INSERT INTO emails (a) VALUES (?)")).toBe(
      "emails",
    ));
  it("INSERT OR REPLACE target", () =>
    expect(parseWriteTable("INSERT OR REPLACE INTO emails (a) VALUES (?)"))
      .toBe("emails"));
  it("UPDATE target", () =>
    expect(parseWriteTable("UPDATE emails SET a = ? WHERE id = ?"))
      .toBe("emails"));
  it("DELETE target", () =>
    expect(parseWriteTable("DELETE FROM emails WHERE id = ?")).toBe("emails"));
  it("quoted target", () =>
    expect(parseWriteTable('INSERT INTO "emails" (a) VALUES (?)'))
      .toBe("emails"));

  // UPDATE OR <action> must not capture the conflict-action keyword as the table.
  it("UPDATE OR REPLACE target", () =>
    expect(parseWriteTable("UPDATE OR REPLACE emails SET a = ? WHERE id = ?"))
      .toBe("emails"));
  it("UPDATE OR IGNORE target", () =>
    expect(parseWriteTable("UPDATE OR IGNORE emails SET a = ?")).toBe(
      "emails",
    ));

  // Schema-qualified targets fail closed (the column ceiling lookup can't be
  // trusted across an alias/schema we don't model).
  it("schema-qualified INSERT → undefined", () =>
    expect(parseWriteTable("INSERT INTO main.emails (a) VALUES (?)"))
      .toBeUndefined());
  it("schema-qualified UPDATE → undefined", () =>
    expect(parseWriteTable("UPDATE main.emails SET a = ?")).toBeUndefined());
  it("quoted schema-qualified → undefined", () =>
    expect(parseWriteTable('INSERT INTO "main"."emails" (a) VALUES (?)'))
      .toBeUndefined());

  it("no attributable target (malformed INTO) → undefined", () =>
    expect(parseWriteTable("INSERT INTO (bad) VALUES (?)")).toBeUndefined());
});

describe("blanking — comments and string escapes never fool the parsers", () => {
  it("line and block comments are blanked (decoy INTO/? inside)", () => {
    expect(
      parseWriteTable(
        "INSERT /* not INTO fake */ INTO emails -- INTO other\n" +
          "(a) VALUES (?)",
      ),
    ).toBe("emails");
    expect(
      parseWriteParamColumns(
        "INSERT INTO emails (a) -- a ? in a comment\nVALUES (?)",
      ),
    ).toEqual(["a"]);
  });

  it("a string literal with an '' escape hides its ? and -- from the scan", () => {
    // One real placeholder; the quoted text's `?`, `--`, and `,` are data.
    expect(
      parseWriteParamColumns(
        "UPDATE emails SET a = ? WHERE b = 'it''s a ?, not -- a param'",
      ),
    ).toEqual(["a"]);
  });

  it("columnless INSERT with placeholders stays unattributable", () =>
    expect(parseWriteParamColumns("INSERT INTO emails VALUES (?, ?)"))
      .toBeUndefined());

  it("an empty name in the column list fails closed", () =>
    expect(parseWriteParamColumns("INSERT INTO emails (a, ) VALUES (?, ?)"))
      .toBeUndefined());

  it("UPDATE without a SET clause fails closed", () =>
    expect(parseWriteParamColumns("UPDATE emails WHERE a = ?"))
      .toBeUndefined());
});
