import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { checkSqliteWriteCeiling } from "../src/builtins/sqlite/write-ceiling.ts";

// Regression guard for paramless intra-db relabeling (audit S6 / W3.19).
//
// checkSqliteWriteCeiling skipped entirely when params === undefined, so a
// paramless column-to-column flow (INSERT…SELECT, UPDATE col = col) on a labeled
// db copied a labeled column's data into a column whose declared label is weaker
// — the data re-emerged under the destination column's (weaker) read-label. A
// labeled db must fail closed on these unverifiable relabeling shapes.
const labeledTables = {
  notes: {
    properties: {
      secret_col: { ifc: { confidentiality: ["secret"] } },
      pub: {},
    },
  },
  plain: { properties: { body: {} } },
} as unknown as Parameters<typeof checkSqliteWriteCeiling>[2];

const unlabeledTables = {
  plain: { properties: { body: {}, other: {} } },
} as unknown as Parameters<typeof checkSqliteWriteCeiling>[2];

const noConf = () => [];

describe("CFC sqlite paramless relabeling", () => {
  it("rejects a paramless INSERT…SELECT on a labeled db", () => {
    const v = checkSqliteWriteCeiling(
      "INSERT INTO plain(body) SELECT secret_col FROM notes",
      undefined,
      labeledTables,
      noConf,
    );
    expect(v).toBeDefined();
  });

  it("rejects a paramless UPDATE col = col on a labeled db", () => {
    const v = checkSqliteWriteCeiling(
      "UPDATE notes SET pub = secret_col",
      undefined,
      labeledTables,
      noConf,
    );
    expect(v).toBeDefined();
  });

  it("allows a paramless literal-only INSERT on a labeled db", () => {
    const v = checkSqliteWriteCeiling(
      "INSERT INTO plain(body) VALUES ('hello')",
      undefined,
      labeledTables,
      noConf,
    );
    expect(v).toBeUndefined();
  });

  it("allows a paramless literal-only UPDATE on a labeled db", () => {
    const v = checkSqliteWriteCeiling(
      "UPDATE notes SET pub = 'done'",
      undefined,
      labeledTables,
      noConf,
    );
    expect(v).toBeUndefined();
  });

  it("allows a paramless DELETE on a labeled db", () => {
    const v = checkSqliteWriteCeiling(
      "DELETE FROM notes WHERE pub = 'x'",
      undefined,
      labeledTables,
      noConf,
    );
    expect(v).toBeUndefined();
  });

  it("does not affect an unlabeled db (no ceilings/labels)", () => {
    expect(
      checkSqliteWriteCeiling(
        "INSERT INTO plain(body) SELECT other FROM plain",
        undefined,
        unlabeledTables,
        noConf,
      ),
    ).toBeUndefined();
  });

  it("treats an empty bound-param array as a paramless write (F7)", () => {
    expect(
      checkSqliteWriteCeiling(
        "INSERT INTO plain(body) SELECT secret_col FROM notes",
        [],
        labeledTables,
        noConf,
      ),
    ).toBeDefined();
  });

  it("rejects a paramless ON CONFLICT DO UPDATE col = col upsert (F6)", () => {
    expect(
      checkSqliteWriteCeiling(
        "INSERT INTO notes(secret_col) VALUES ('x') " +
          "ON CONFLICT(secret_col) DO UPDATE SET pub = secret_col",
        undefined,
        labeledTables,
        noConf,
      ),
    ).toBeDefined();
  });

  it("allows paramless literal UPDATEs with exponent/hex numerals (F8)", () => {
    expect(
      checkSqliteWriteCeiling(
        "UPDATE notes SET pub = 1e3, secret_col = 0xFF",
        undefined,
        labeledTables,
        noConf,
      ),
    ).toBeUndefined();
  });
});
