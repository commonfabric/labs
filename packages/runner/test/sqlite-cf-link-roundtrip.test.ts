// End-to-end _cf_link round-trip THROUGH real SQLite storage: a Cell is encoded
// to a sigil-link string, written into a `*_cf_link` TEXT column via the storage
// provider (emulated server -> engine), read back, and decoded to a live Cell
// with the same identity. (The codec unit test covers encode/decode in
// isolation; this proves it survives the actual store + protocol.)

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";
import {
  decodeCfLinkValue,
  encodeCfLinkValue,
} from "../src/builtins/sqlite/cf-link.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("_cf_link round-trip through SQLite storage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
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

  it("stores a cell link as TEXT and reads it back as the same cell", async () => {
    const target = runtime.getCell<{ name: string }>(
      space,
      "cf-link-roundtrip-target",
      undefined,
      tx,
    );

    const db: SqliteDbRef = {
      id: `of:roundtrip-${crypto.randomUUID()}`,
      tables: {
        links: table({ id: "integer primary key", target_cf_link: "text" }),
      },
    };
    // Encode the cell -> absolute sigil-link string, store it in the TEXT column.
    const encoded = encodeCfLinkValue(target);
    await seedSqlite(
      db,
      "INSERT INTO links (target_cf_link) VALUES (?)",
      [encoded],
    );

    // Read it back and decode -> a live Cell pointing at the same entity.
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      db,
      "SELECT target_cf_link FROM links",
    );
    expect(r.rows.length).toBe(1);
    const stored = (r.rows[0] as { target_cf_link: string }).target_cf_link;
    const decoded = decodeCfLinkValue(stored, runtime, undefined, tx);
    expect(decoded).not.toBeNull();
    expect(
      areNormalizedLinksSame(
        decoded!.getAsNormalizedFullLink(),
        target.getAsNormalizedFullLink(),
      ),
    ).toBe(true);
  });
});
