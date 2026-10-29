// `_cf_link` query-result behavior at the storage/provider level.
//
// An UNTYPED query returns a `*_cf_link` column as the stored sigil-link STRING
// (decodable on demand via `decodeCfLinkValue`), and NULL as null — both pinned
// here. The TYPED `db.query<Row>` path that surfaces the column as a live Cell
// automatically (transformer `rowSchema` injection + runtime decode + consumer
// asCell read) is covered at the runtime level in
// sqlite-query-rowschema-decode.test.ts and end to end through `cf check` + the
// real server in integration/sqlite-db-query-decode.test.ts.
//
// Writes here are seeded via the storage provider (the server `sqlite.execute`
// verb stays); pattern writes are the imperative `SqliteDb.exec` (sqlite-db-exec
// .test.ts), a folded commit, not a declarative builtin.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  decodeCfLinkValue,
  encodeCfLinkValue,
} from "../src/builtins/sqlite/cf-link.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";

describe("sqlite query result _cf_link behavior", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let signer: Identity;
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    // Unique space per test => unique (space, db-id) => fresh cell-db temp file
    // (no row leakage across runs; see plans/reactivity.md).
    signer = await Identity.fromPassphrase(`decode-${crypto.randomUUID()}`);
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Seed rows through the real write path (a folded `sqlite` op committed via a
  // tx) — there is no standalone write RPC.
  const seedSqlite = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<void> => {
    const seedTx = runtime.edit();
    seedTx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    const res = await seedTx.commit().settled;
    if (res.error) throw res.error;
  };

  it("returns the stored sigil-link string, decodable via decodeCfLinkValue", async () => {
    const author = runtime.getCell<{ name: string }>(
      space,
      "author",
      undefined,
      tx,
    );
    author.set({ name: "Ada" });
    const encoded = encodeCfLinkValue(author);

    const db: SqliteDbRef = {
      id: `of:decode-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    await seedSqlite(
      db,
      "INSERT INTO people (author_cf_link) VALUES (?)",
      [encoded],
    );

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      db,
      "SELECT author_cf_link FROM people ORDER BY id",
    );
    expect(r.rows.length).toBe(1);
    const stored = (r.rows[0] as { author_cf_link: string }).author_cf_link;
    // Current behavior: the column is the stored sigil-link STRING.
    expect(typeof stored).toBe("string");
    // ...and it decodes to a live Cell pointing at the same entity.
    const decoded = decodeCfLinkValue(stored, runtime, undefined, tx);
    expect(decoded).not.toBeNull();
    expect(
      areNormalizedLinksSame(
        decoded!.getAsNormalizedFullLink(),
        author.getAsNormalizedFullLink(),
      ),
    ).toBe(true);
    expect(decoded!.get()).toEqual({ name: "Ada" });
  });

  it("returns a NULL link column as null", async () => {
    const db: SqliteDbRef = {
      id: `of:decode-null-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    await seedSqlite(
      db,
      "INSERT INTO people (author_cf_link) VALUES (NULL)",
    );
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      db,
      "SELECT author_cf_link FROM people ORDER BY id",
    );
    expect(r.rows.length).toBe(1);
    expect((r.rows[0] as { author_cf_link: unknown }).author_cf_link)
      .toBeNull();
    // The typed `db.query<Row>` -> live-Cell path (transformer rowSchema
    // injection + runtime decode + consumer asCell read) is exercised at the
    // runtime level in sqlite-query-rowschema-decode.test.ts and end to end
    // through `cf check` + the real server in
    // integration/sqlite-db-query-decode.test.ts.
  });
});
