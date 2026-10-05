// SqliteDb `.exec` — the sync, commit-folded write method on a "sqlite"-kind
// cell. Tested by minting a "sqlite"-kind cell directly (the ergonomic
// pattern->handler path, where the transformer lowers SqliteDb to asCell:
// ["sqlite"], is integration-level). Proves: exec folds into the cell's tx
// atomically with sibling cell writes; throws on undefined params (null ok);
// encodes _cf_link cell params; SQL failure aborts the whole commit.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import { createCell } from "../src/cell.ts";
import { encodeSqliteParams } from "../src/index.ts";
import { decodeCfLinkValue } from "../src/builtins/sqlite/cf-link.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

type SqliteDbCell = {
  exec(
    sql: string,
    params?: ReadonlyArray<unknown> | Record<string, unknown>,
  ): void;
  get(): unknown;
};

describe("SqliteDb .exec (commit-folded write)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let signer: Identity;
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(`dbexec-${crypto.randomUUID()}`);
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Mint a "sqlite"-kind cell whose value is the db handle ref.
  function sqliteDb(
    dbRef: SqliteDbRef,
    tx: IExtendedStorageTransaction,
    label: string,
  ): SqliteDbCell {
    const handle = runtime.getCell(space, label, undefined, tx);
    handle.set(dbRef);
    return createCell(
      runtime,
      handle.getAsNormalizedFullLink(),
      tx,
      false,
      "sqlite",
    ) as unknown as SqliteDbCell;
  }

  it("exports the parameter encoder used by remote SQLite callers", () => {
    expect(encodeSqliteParams("SELECT :value", { value: null })).toEqual({
      value: null,
    });
  });

  it("preserves reserved names in named SQLite parameters", () => {
    const params = Object.fromEntries([
      ["constructor", 1],
      ["__proto__", 2],
    ]);

    const encoded = encodeSqliteParams(
      "SELECT :constructor, :__proto__",
      params,
    ) as Record<string, unknown>;

    expect(Object.hasOwn(encoded, "constructor")).toBe(true);
    expect(Object.hasOwn(encoded, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(encoded, "constructor")?.value)
      .toBe(1);
    expect(Object.getOwnPropertyDescriptor(encoded, "__proto__")?.value)
      .toBe(2);
  });

  it("folds a write atomically with a sibling cell write", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    const marker = runtime.getCell<{ ok: boolean }>(
      space,
      "exec-marker",
      undefined,
      tx,
    );
    marker.set({ ok: true });
    db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
    const res = await tx.commit();
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(dbRef, "SELECT body FROM notes");
    expect(r.rows).toEqual([{ body: "hi" }]);

    const tx2 = runtime.edit();
    expect(
      runtime.getCell<{ ok: boolean }>(space, "exec-marker", undefined, tx2)
        .withTx(tx2).get(),
    ).toEqual({ ok: true });
    await tx2.commit();
  });

  it("reads the handle via getRaw even when the cell schema shapes it to {}", async () => {
    // A pattern compiled before the handle descriptor landed declares the
    // handle as an object type with NO properties, and handler-input
    // materialization delivers the handle cell under that schema. A
    // schema-shaped `get()` projects the handle down to `{}` and drops
    // `id`/`tables`; `.exec` must read the raw handle (getRaw, lastNode:"value")
    // and still fold the write. Regression guard for the get()->getRaw() fix.
    const dbRef: SqliteDbRef = {
      id: `of:exec-shaped-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const handle = runtime.getCell(space, "db-shaped", undefined, tx);
    handle.set(dbRef);
    const db = createCell(
      runtime,
      {
        ...handle.getAsNormalizedFullLink(),
        schema: { type: "object", properties: {} },
      },
      tx,
      false,
      "sqlite",
    ) as unknown as SqliteDbCell;
    // Sanity: a schema-shaped read drops the handle fields...
    expect(db.get()).toEqual({});
    // ...but exec still records the write from the raw handle.
    db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
    const res = await tx.commit();
    expect(res.error).toBeUndefined();
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(dbRef, "SELECT body FROM notes");
    expect(r.rows).toEqual([{ body: "hi" }]);
  });

  it("reads back id/rev/tables through the emitted handle descriptor", async () => {
    // The schema a pattern now declares for a `SqliteDb` position (the
    // descriptor emitted by `packages/schema-generator`). A read through it
    // must return the handle, not `{}` — including the table schemas whose
    // per-column `ifc` labels a pattern needs to write a query.
    const dbRef: SqliteDbRef & { rev: number } = {
      id: `of:exec-descriptor-${crypto.randomUUID()}`,
      rev: 3,
      tables: {
        notes: table({ id: "integer primary key", body: "text" }),
      },
    };
    const tx = runtime.edit();
    const handle = runtime.getCell(space, "db-descriptor", undefined, tx);
    handle.set(dbRef);
    const db = createCell(
      runtime,
      {
        ...handle.getAsNormalizedFullLink(),
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            tables: { type: "object", additionalProperties: true },
            rev: { type: "number" },
          },
          additionalProperties: true,
        },
      },
      tx,
      false,
      "sqlite",
    ) as unknown as SqliteDbCell;
    const value = db.get() as typeof dbRef;
    expect(value.id).toBe(dbRef.id);
    expect(value.rev).toBe(3);
    expect(value.tables).toEqual(dbRef.tables);
    await tx.commit();
  });

  it("throws on an undefined param, allows null", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-undef-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    expect(() => db.exec("INSERT INTO notes (body) VALUES (?)", [undefined]))
      .toThrow();
    // null is allowed (SQL NULL).
    db.exec("INSERT INTO notes (body) VALUES (?)", [null]);
    const res = await tx.commit();
    expect(res.error).toBeUndefined();
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      dbRef,
      "SELECT count(*) AS c FROM notes",
    );
    expect((r.rows[0] as { c: number }).c).toBe(1);
  });

  it("encodes a _cf_link cell param (round-trips to the same entity)", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-link-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    const tx = runtime.edit();
    const author = runtime.getCell<{ name: string }>(
      space,
      "author",
      undefined,
      tx,
    );
    author.set({ name: "Ada" });
    const db = sqliteDb(dbRef, tx, "db-h");
    db.exec("INSERT INTO people (author_cf_link) VALUES (?)", [author]);
    const res = await tx.commit();
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      dbRef,
      "SELECT author_cf_link FROM people",
    );
    const stored = (r.rows[0] as { author_cf_link: string }).author_cf_link;
    expect(typeof stored).toBe("string");
    const tx2 = runtime.edit();
    const decoded = decodeCfLinkValue(stored, runtime, undefined, tx2);
    expect(decoded).not.toBeNull();
    expect(
      areNormalizedLinksSame(
        decoded!.getAsNormalizedFullLink(),
        author.getAsNormalizedFullLink(),
      ),
    ).toBe(true);
    await tx2.commit();
  });

  it("encodes nested cells before a JSON bind reaches storage", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-nested-link-${crypto.randomUUID()}`,
      tables: {
        documents: table({ id: "integer primary key", payload: "text" }),
      },
    };
    const tx = runtime.edit();
    const author = runtime.getCell<{ name: string }>(
      space,
      "nested-author",
      undefined,
      tx,
    );
    author.set({ name: "Ada" });
    const db = sqliteDb(dbRef, tx, "db-h");
    db.exec("INSERT INTO documents (payload) VALUES (:payload)", {
      payload: { links: [author] },
    });

    const res = await tx.commit();
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const rows = await provider.sqliteQuery!(
      dbRef,
      "SELECT payload FROM documents",
    );
    const payload = JSON.parse((rows.rows[0] as { payload: string }).payload);
    expect(payload).toEqual({ links: [author.toJSON()] });
  });

  it("encodes nested cells in positional statements without a column list", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-nested-positional-${crypto.randomUUID()}`,
      tables: {
        documents: table({ id: "integer primary key", payload: "text" }),
      },
    };
    const tx = runtime.edit();
    const author = runtime.getCell<{ name: string }>(
      space,
      "nested-positional-author",
      undefined,
      tx,
    );
    author.set({ name: "Ada" });
    const db = sqliteDb(dbRef, tx, "db-h");
    db.exec("INSERT INTO documents VALUES (?, ?)", [
      1,
      { links: [author] },
    ]);

    const res = await tx.commit();
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const rows = await provider.sqliteQuery!(
      dbRef,
      "SELECT payload FROM documents",
    );
    const payload = JSON.parse((rows.rows[0] as { payload: string }).payload);
    expect(payload).toEqual({ links: [author.toJSON()] });
  });

  it("rejects nested undefined in positional statements without a column list", () => {
    expect(() => encodeSqliteParams("SELECT ?", [{ value: undefined }]))
      .toThrow("sqlite: param is undefined");
  });

  it("encodes link cells across a multi-row INSERT (cols cycle per tuple)", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-multi-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    const tx = runtime.edit();
    const a = runtime.getCell<{ n: string }>(space, "a", undefined, tx);
    a.set({ n: "A" });
    const b = runtime.getCell<{ n: string }>(space, "b", undefined, tx);
    b.set({ n: "B" });
    const db = sqliteDb(dbRef, tx, "db-h");
    // Both positional cells target author_cf_link; the second tuple must reuse
    // the parsed column list (previously cols[1] was undefined -> wrongly threw).
    db.exec(
      "INSERT INTO people (author_cf_link) VALUES (?), (?)",
      [a, b],
    );
    const res = await tx.commit();
    expect(res.error).toBeUndefined();
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      dbRef,
      "SELECT count(*) AS c FROM people",
    );
    expect((r.rows[0] as { c: number }).c).toBe(2);
  });

  it("refuses a bound cell whose label cannot be read under a column ceiling", async () => {
    // A user-scoped instance whose own envelope this build cannot read,
    // beside a space instance labeled outside the column's ceiling.
    const seed = runtime.edit();
    const link = runtime.getCell(space, "ceiling-scoped", undefined, seed)
      .getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { ...toMemorySpaceAddress(link), path: [] }, {
      value: "slot",
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["secret"] } }],
        },
      },
    });
    seedStoredEnvelope(seed, {
      ...toMemorySpaceAddress({ ...link, scope: "user" }),
      path: [],
    }, {
      value: "narrowed",
      cfc: {
        version: 99,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [] },
      },
    });
    expect((await seed.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    const db = sqliteDb(
      {
        id: `of:exec-ceiling-${crypto.randomUUID()}`,
        tables: {
          people: table({
            id: "integer primary key",
            author_cf_link: {
              sqlType: "text",
              type: "string",
              ifc: { maxConfidentiality: ["support"] },
            },
          }),
        },
      },
      tx,
      "db-h",
    );
    const scoped = runtime.getCell(
      space,
      "ceiling-scoped",
      undefined,
      tx,
      "user",
    );
    expect(() =>
      db.exec("INSERT INTO people (author_cf_link) VALUES (?)", [scoped])
    ).toThrow(/maxConfidentiality/);
    tx.abort();
  });

  it("rejects a Cell bound where the target column can't be verified", () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-unverif-${crypto.randomUUID()}`,
      tables: {
        notes: table({ id: "integer primary key", body: "text" }),
      },
    };
    const tx = runtime.edit();
    const cell = runtime.getCell<{ n: string }>(space, "c", undefined, tx);
    cell.set({ n: "x" });
    const db = sqliteDb(dbRef, tx, "db-h");
    // UPDATE has no explicit column list, so a Cell's target column is unknown.
    // Previously this silently sigil-encoded the cell into the plain `body`
    // column (corruption); now it throws an actionable error.
    expect(() => db.exec("UPDATE notes SET body = ? WHERE id = ?", [cell, 1]))
      .toThrow("target column can't be determined");
    // Columnless INSERT likewise can't verify the column for a Cell.
    expect(() => db.exec("INSERT INTO notes VALUES (?, ?)", [1, cell])).toThrow(
      "target column can't be determined",
    );
    tx.abort();
  });

  it("allows non-cell positional params in columnless/UPDATE statements", () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-plain-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    // Encoding runs synchronously at db.exec(); with no cell params, a columnless
    // INSERT and an UPDATE must NOT false-throw at the encode layer (the column
    // can't be resolved, but that only matters for Cell bindings).
    expect(() => db.exec("INSERT INTO notes VALUES (?, ?)", [1, "hi"])).not
      .toThrow();
    expect(() => db.exec("UPDATE notes SET body = ? WHERE id = ?", ["bye", 1]))
      .not.toThrow();
    tx.abort();
  });

  it(".exec is only available on a sqlite-kind cell", () => {
    const tx = runtime.edit();
    const plain = runtime.getCell<{ x: number }>(space, "plain", undefined, tx);
    plain.set({ x: 1 });
    // .exec is a runtime write that requires a "sqlite"-kind cell (a handler's
    // db input). (.query is a build-time node constructor like .map, so it has
    // no _kind guard — `this` is an opaque builder ref at pattern-build time.)
    expect(() =>
      (plain as unknown as SqliteDbCell).exec("INSERT INTO t VALUES (1)")
    ).toThrow("SqliteDb");
  });

  it("aborts the whole commit on SQL failure (sibling rolls back)", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-fail-${crypto.randomUUID()}`,
      tables: {
        notes: table({ id: "integer primary key", body: "text not null" }),
      },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    const marker = runtime.getCell<{ touched: boolean }>(
      space,
      "fail-marker",
      undefined,
      tx,
    );
    marker.set({ touched: true });
    // null into a NOT NULL column -> fails inside applyCommit -> abort.
    db.exec("INSERT INTO notes (body) VALUES (?)", [null]);
    const res = await tx.commit();
    expect(res.error).toBeDefined();

    const tx2 = runtime.edit();
    expect(
      runtime.getCell<{ touched: boolean }>(
        space,
        "fail-marker",
        undefined,
        tx2,
      )
        .withTx(tx2).get(),
    ).toBeUndefined();
    await tx2.commit();
  });
});
