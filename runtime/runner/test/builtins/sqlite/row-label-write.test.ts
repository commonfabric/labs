import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  all,
  constant,
  whenMatches,
} from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";

import {
  checkSqliteRowLabelWrite,
  type RowLabelWriteArgs,
} from "../../../src/builtins/sqlite/row-label-write.ts";

const OWNER = "did:key:zOwner";

// One rule input of each affinity, so a case can bind the same spelling to a
// column that keeps it as text and to one that converts it.
const tables = {
  codes: table(
    { id: "integer primary key", label: "text", number: "integer" },
    (f) => ({
      confidentiality: all(
        whenMatches(f.label, /^007$/, constant("did:code:label-007")),
        whenMatches(f.number, /^7$/, constant("did:code:number-7")),
      ),
    }),
  ),
};

const write = (
  sql: string,
  params: RowLabelWriteArgs["params"],
  overrides: Partial<RowLabelWriteArgs> = {},
) =>
  checkSqliteRowLabelWrite({
    sql,
    params,
    tables,
    owner: OWNER,
    confidentialityOf: () => [],
    ...overrides,
  });

describe("checkSqliteRowLabelWrite()", () => {
  it("returns the label computed from a numeric string bound to a TEXT rule input", () => {
    // A TEXT column stores the string as it was bound, so the rule reads the
    // same text the stored row will hold.
    expect(write("INSERT INTO codes (label) VALUES (?)", ["007"])).toEqual({
      policies: [{
        table: "codes",
        label: { confidentiality: ["did:code:label-007"], integrity: [] },
      }],
    });
    expect(write("INSERT INTO codes (number) VALUES (?)", ["007"])).toEqual({
      error: expect.stringMatching(/INTEGER affinity/),
    });
  });

  it("returns an error for a schema-qualified target table", () => {
    expect(write("INSERT INTO main.codes (label) VALUES (?)", ["x"]))
      .toEqual({
        error: expect.stringMatching(/cannot attribute this write's target/),
      });
    expect(write("INSERT INTO codes (label) VALUES (?)", ["x"])).not
      .toHaveProperty("error");
  });

  it("returns an error naming the table whose wire-supplied rule does not validate", () => {
    const invalid = {
      codes: { ...tables.codes, rowLabel: { version: 2 } },
    };
    expect(
      write("INSERT INTO codes (label) VALUES (?)", ["x"], {
        tables: invalid,
      }),
    ).toEqual({
      error: 'sqlite: table "codes" declares an invalid rowLabel rule — ' +
        "unsupported rowLabel version 2",
    });
  });

  it("returns an error for a statement that opens with neither INSERT, REPLACE, UPDATE nor DELETE", () => {
    expect(
      write(
        "WITH src AS (SELECT 1) INSERT INTO codes (label) VALUES (?)",
        ["x"],
      ),
    ).toEqual({
      error: "sqlite: unrecognized write shape on a rule-bearing table — " +
        "fail closed",
    });
  });

  it("returns an error for an upsert unless the server evaluates labels at commit", () => {
    const upsert = "INSERT INTO codes (id, label) VALUES (?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET label = excluded.label";
    expect(write(upsert, [1, "x"])).toEqual({
      error: expect.stringMatching(
        /^sqlite: this write to rule-bearing table "codes" is not attributable/,
      ),
    });
    expect(write(upsert, [1, "x"], { serverCommitEval: true })).toEqual({});
  });
});
