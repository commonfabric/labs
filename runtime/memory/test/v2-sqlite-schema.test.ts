// Tests for table()/cfLink() schema helpers and DDL generation
// (spec docs/specs/sqlite-builtin/01 + Phase 2 additive DDL).

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  cfLink,
  createTableSQL,
  linkColumnsOf,
  table,
} from "../v2/sqlite/schema.ts";

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
