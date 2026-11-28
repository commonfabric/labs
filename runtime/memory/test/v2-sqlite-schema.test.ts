// Tests for table()/cfLink() schema helpers and DDL generation
// (spec docs/specs/sqlite-builtin/01 + Phase 2 additive DDL).

import { expect } from "@std/expect";

import {
  cfLink,
  createIndexSQL,
  createTableSQL,
  linkColumnsOf,
  table,
} from "../v2/sqlite/schema.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("cfLink", () => {
  it("emits a string column marked as a cf link", () => {
    expect(cfLink()).toEqual({ type: "string", cfLink: true, sqlType: "text" });
  });
});

describe("table", () => {
  it("builds an object schema from shorthand + cfLink columns", () => {
    const t = table({
      id: "integer primary key",
      author_cf_link: cfLink(),
      body: "text",
      ts: "integer",
    });
    expect(t.type).toBe("object");
    expect(Object.keys(t.properties!)).toEqual([
      "id",
      "author_cf_link",
      "body",
      "ts",
    ]);
    expect(t.properties!.id).toEqual({
      type: "integer",
      sqlType: "integer primary key",
    });
    expect(t.properties!.body).toEqual({ type: "string", sqlType: "text" });
    expect((t.properties!.author_cf_link as Record<string, unknown>).cfLink)
      .toBe(true);
    expect(t.required).toEqual(["id", "author_cf_link", "body", "ts"]);
  });

  it("passes through an explicit column schema object", () => {
    const t = table({ subject: { type: "string", sqlType: "text" } });
    expect(t.properties!.subject).toEqual({ type: "string", sqlType: "text" });
  });

  it("throws when a cfLink column is not named *_cf_link", () => {
    expect(() => table({ author: cfLink() })).toThrow();
  });

  it("throws when a *_cf_link column is not a string/text type", () => {
    expect(() => table({ author_cf_link: "integer" })).toThrow();
  });
});

describe("linkColumnsOf", () => {
  it("returns the set of cf-link column names", () => {
    const t = table({
      id: "integer",
      author_cf_link: cfLink(),
      reviewer_cf_link: cfLink(),
    });
    expect(new Set(linkColumnsOf(t))).toEqual(
      new Set(["author_cf_link", "reviewer_cf_link"]),
    );
  });
});

describe("createTableSQL", () => {
  it("generates CREATE TABLE IF NOT EXISTS with sql types", () => {
    const t = table({
      id: "integer primary key",
      author_cf_link: cfLink(),
      body: "text",
    });
    const sql = createTableSQL("messages", t);
    expect(sql).toBe(
      'CREATE TABLE IF NOT EXISTS "messages" (\n' +
        '  "id" integer primary key,\n' +
        '  "author_cf_link" text,\n' +
        '  "body" text\n' +
        ")",
    );
  });

  it("rejects DDL-injection via column name or sqlType", () => {
    expect(() => table({ "evil) ; DROP TABLE x --": "integer" })).toThrow();
    expect(() => table({ id: "text); DROP TABLE secret;--" })).toThrow();
  });

  it("re-validates a wire-supplied TableSchema that bypassed table() (C1)", () => {
    // The server reaches createTableSQL with `db.tables` straight off the wire,
    // which never passed through table()/normalizeColumn. A hostile `sqlType`
    // with `;` must be rejected at the interpolation site, not executed.
    const malicious = {
      type: "object",
      required: ["c"],
      properties: {
        c: { type: "string", sqlType: "text); SELECT * FROM commit;--" },
      },
    } as unknown as Parameters<typeof createTableSQL>[1];
    expect(() => createTableSQL("t", malicious)).toThrow("invalid sqlType");

    const badName = {
      type: "object",
      required: [],
      properties: { "a) ;--": { type: "string", sqlType: "text" } },
    } as unknown as Parameters<typeof createTableSQL>[1];
    expect(() => createTableSQL("t", badName)).toThrow("invalid column name");
  });

  it("rejects a table with too many columns (DoS cap)", () => {
    const props: Record<string, { type: string; sqlType: string }> = {};
    for (let i = 0; i < 300; i++) {
      props[`c${i}`] = { type: "string", sqlType: "text" };
    }
    const huge = {
      type: "object",
      required: [],
      properties: props,
    } as unknown as Parameters<typeof createTableSQL>[1];
    expect(() => createTableSQL("t", huge)).toThrow("too many columns");
  });

  it("rejects a zero-column table", () => {
    const empty = {
      type: "object",
      required: [],
      properties: {},
    } as unknown as Parameters<typeof createTableSQL>[1];
    expect(() => createTableSQL("t", empty)).toThrow("at least one column");
  });
});

describe("createIndexSQL", () => {
  it("returns no statement for a table declaring no index", () => {
    expect(createIndexSQL("t", table({ a: "text" }))).toEqual([]);
  });

  it("generates one additive statement per declared index", () => {
    const schema = table({ a: "text", b: "integer" }, undefined, {
      indexes: [["a"], ["b", "a"]],
    });
    expect(createIndexSQL("t", schema)).toEqual([
      'CREATE INDEX IF NOT EXISTS "t__idx(a)" ON "t" ("a")',
      'CREATE INDEX IF NOT EXISTS "t__idx(b,a)" ON "t" ("b", "a")',
    ]);
  });

  it("names differently two indexes whose table and columns join to one string", () => {
    const [first] = createIndexSQL(
      "a",
      table({ b__c: "text" }, undefined, { indexes: [["b__c"]] }),
    );
    const [second] = createIndexSQL(
      "a__b",
      table({ c: "text" }, undefined, { indexes: [["c"]] }),
    );

    expect(first.split(" ON ")[0]).not.toBe(second.split(" ON ")[0]);
  });

  it("qualifies the index, not the table, with an attach alias", () => {
    const schema = table({ a: "text" }, undefined, { indexes: [["a"]] });
    expect(createIndexSQL("t", schema, "cell")).toEqual([
      'CREATE INDEX IF NOT EXISTS "cell"."t__idx(a)" ON "t" ("a")',
    ]);
  });

  it("throws at `table()` time on an index naming an undeclared column", () => {
    expect(() =>
      table({ a: "text" }, undefined, {
        indexes: [["b" as "a"]],
      })
    ).toThrow("undeclared column");
  });

  it("throws on a wire-supplied index that names no column", () => {
    const schema = { ...table({ a: "text" }), indexes: [[]] };
    expect(() => createIndexSQL("t", schema)).toThrow("names no column");
  });

  it("accepts up to 32 indexes and rejects a 33rd (DoS cap)", () => {
    const withIndexes = (count: number) => ({
      ...table({ a: "text" }),
      indexes: Array.from({ length: count }, () => ["a"]),
    });
    expect(createIndexSQL("t", withIndexes(32))).toHaveLength(32);
    expect(() => createIndexSQL("t", withIndexes(33))).toThrow(
      'table "t" declares too many indexes (limit 32)',
    );
  });
});
