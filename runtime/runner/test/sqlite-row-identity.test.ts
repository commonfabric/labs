import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteResultColumn } from "@commonfabric/memory/v2";

import { resultRowKeys } from "../src/builtins/sqlite/row-identity.ts";

const tables = {
  notes: table({
    id: "integer primary key",
    body: {
      type: "string",
      sqlType: "text",
      ifc: { confidentiality: ["secret"] },
    },
  }),
};

const notesColumns: SqliteResultColumn[] = [
  { output: "id", table: "notes", column: "id" },
  { output: "body", table: "notes", column: "body" },
];

const rows = [
  { id: 1, body: "a" },
  { id: 2, body: "b" },
];

const never = () => undefined;

const database = { space: "did:key:zTestSpace", id: "of:notes-db" };

const salt = "row-salt";

/** The key of a labeled `row` under `projection`. */
const labeled = (
  projection: readonly SqliteResultColumn[],
  row: unknown,
  label?: unknown,
) => ({
  salt,
  database,
  projection,
  tables,
  row,
  ...(label !== undefined && { label }),
});

describe("resultRowKeys()", () => {
  it("keys a row carrying no confidentiality on the salt and its content", () => {
    expect(
      resultRowKeys({
        salt,
        rows,
        columns: undefined,
        tables: undefined,
        database,
        columnLabeled: false,
        rowLabel: never,
      }),
    ).toEqual([{ salt, row: rows[0] }, { salt, row: rows[1] }]);
  });

  it("keys a column-labeled row on the salt, its content and what decides its label", () => {
    expect(
      resultRowKeys({
        salt,
        rows,
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      }),
    ).toEqual([labeled(notesColumns, rows[0]), labeled(notesColumns, rows[1])]);
  });

  it("keys a column-labeled row on the same key at another position", () => {
    const keysOf = (ordered: readonly unknown[]) =>
      resultRowKeys({
        salt,
        rows: ordered,
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      });
    const [first, second] = keysOf(rows);
    expect(keysOf([rows[1], rows[0]])).toEqual([second, first]);
  });

  it("keys rows of equal content under different row labels on different keys", () => {
    const bob = { confidentiality: ["did:mailto:bob@b.example"] };
    const eve = { confidentiality: ["did:mailto:eve@e.example"] };
    const [first, second] = resultRowKeys({
      salt,
      rows: [rows[0], rows[0]],
      columns: notesColumns,
      tables,
      database,
      columnLabeled: false,
      rowLabel: (index) => index === 0 ? bob : eve,
    });
    expect(first).toEqual(labeled(notesColumns, rows[0], bob));
    expect(second).toEqual(labeled(notesColumns, rows[0], eve));
  });

  it("keys a row under a row label on the salt, its content and its label", () => {
    const label = { confidentiality: ["did:mailto:bob@b.example"] };
    expect(
      resultRowKeys({
        salt,
        rows,
        columns: notesColumns,
        tables,
        database,
        columnLabeled: false,
        rowLabel: (index) => index === 1 ? label : undefined,
      }),
    ).toEqual([{ salt, row: rows[0] }, labeled(notesColumns, rows[1], label)]);
  });

  it("keys the same row of another database on a different key", () => {
    const other = { space: database.space, id: "of:other-db" };
    const [first] = resultRowKeys({
      salt,
      rows: [rows[0]],
      columns: notesColumns,
      tables,
      database,
      columnLabeled: true,
      rowLabel: never,
    });
    const [second] = resultRowKeys({
      salt,
      rows: [rows[0]],
      columns: notesColumns,
      tables,
      database: other,
      columnLabeled: true,
      rowLabel: never,
    });
    expect(first).toEqual(labeled(notesColumns, rows[0]));
    expect(second).not.toEqual(first);
  });

  it("keys the same row of another projection on a different key", () => {
    const aliased: SqliteResultColumn[] = [
      { output: "id", table: "notes", column: "id" },
      { output: "value", table: "notes", column: "body" },
    ];
    const [first] = resultRowKeys({
      salt,
      rows: [rows[0]],
      columns: notesColumns,
      tables,
      database,
      columnLabeled: true,
      rowLabel: never,
    });
    const [second] = resultRowKeys({
      salt,
      rows: [{ id: 1, value: "a" }],
      columns: aliased,
      tables,
      database,
      columnLabeled: true,
      rowLabel: never,
    });
    expect(second).toEqual(labeled(aliased, { id: 1, value: "a" }));
    expect(second).not.toEqual(first);
  });

  it("keys the same row under another salt on a different key", () => {
    const keyUnder = (rowSalt: string) =>
      resultRowKeys({
        salt: rowSalt,
        rows: [rows[0]],
        columns: notesColumns,
        tables,
        database,
        columnLabeled: true,
        rowLabel: never,
      })[0];
    expect(keyUnder("one")).not.toEqual(keyUnder("two"));
  });
});
