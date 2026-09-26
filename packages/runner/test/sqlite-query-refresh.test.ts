import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("sqlite query refresh");
const space = signer.did();

interface QueryState {
  pending: boolean;
  result?: Array<{ body: string }>;
  error?: unknown;
  requestHash?: string;
}

const NOTES_SQL = "SELECT body FROM notes WHERE topic = ?1 ORDER BY id";

describe("sqlite-query-refresh", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  let db: SqliteDbRef;
  let restoreReads: (() => void) | undefined;
  let cancelDemand: (() => void) | undefined;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
    db = {
      id: `of:refresh-${crypto.randomUUID()}`,
      tables: {
        notes: table({
          id: "integer primary key",
          topic: "text",
          body: "text",
        }),
      },
    };
    await insertNote("lunch", "soup");
  });

  afterEach(async () => {
    cancelDemand?.();
    cancelDemand = undefined;
    restoreReads?.();
    restoreReads = undefined;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Adds one note through the real write path, in a commit of its own. */
  async function insertNote(topic: string, body: string): Promise<void> {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, {
      op: "sqlite",
      db,
      sql: "INSERT INTO notes (topic, body) VALUES (?1, ?2)",
      params: [topic, body],
    });
    expect((await tx.commit()).error).toBeUndefined();
  }

  /**
   * Holds every later server read until `release()` is called, so a case can
   * look at the result cell while its query is in flight.
   */
  function holdReads(): { release: () => void } {
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...args: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.sqliteQuery = async (...args) => {
      await gate;
      return await original.apply(provider, args);
    };
    restoreReads = () => {
      provider.sqliteQuery = original;
    };
    return { release };
  }

  /**
   * A piece running `NOTES_SQL` over `db` for `topic`, re-issued whenever
   * `tick` changes, and demanded for the rest of the case. Returns once the
   * first answer has landed.
   */
  async function runQuery(label: string) {
    const tx = runtime.edit();
    const tick = runtime.getCell<number>(space, `${label}-tick`, undefined, tx);
    tick.set(0);
    const topic = runtime.getCell<string>(
      space,
      `${label}-topic`,
      undefined,
      tx,
    );
    topic.set("lunch");
    const queryPattern = cf.pattern<{ tick: number; topic: string }>(
      ({ tick, topic }) =>
        cf.sqliteQuery({
          // The raw handle stands in for a `sqliteDatabase` result.
          db: db as never,
          sql: NOTES_SQL,
          params: [topic],
          reactOn: tick,
        }),
    );
    const result = runtime.run(
      tx,
      queryPattern,
      { tick, topic },
      runtime.getCell(space, `${label}-result`, queryPattern.resultSchema, tx),
    ) as unknown as Cell<QueryState>;
    expect((await tx.commit()).error).toBeUndefined();
    cancelDemand = result.sink(() => {});
    const first = await waitForCellValue<QueryState>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    expect(first.result).toEqual([{ body: "soup" }]);
    return { result, tick, topic, first };
  }

  /** Writes `value` into `cell` in a commit of its own. */
  async function write<T>(cell: Cell<T>, value: T): Promise<void> {
    const tx = runtime.edit();
    cell.withTx(tx).set(value);
    expect((await tx.commit()).error).toBeUndefined();
  }

  describe("a refresh, where only `reactOn` changed", () => {
    it("keeps the previous rows readable while the refreshed query is pending", async () => {
      const { result, tick, first } = await runQuery("refresh-pending");
      await insertNote("lunch", "salad");
      const { release } = holdReads();

      await write(tick, 1);
      await runtime.idle();
      const during = result.get();
      expect(during.pending).toBe(true);
      expect(during.requestHash).not.toBe(first.requestHash);
      expect(during.error).toBeUndefined();
      expect(during.result).toEqual([{ body: "soup" }]);

      release();
      await runtime.settled();
    });

    it("replaces the previous rows once the refreshed answer lands", async () => {
      const { result, tick } = await runQuery("refresh-lands");
      await insertNote("lunch", "salad");
      const { release } = holdReads();

      await write(tick, 1);
      await runtime.idle();
      release();
      await runtime.settled();
      const after = result.get();
      expect(after.pending).toBe(false);
      expect(after.error).toBeUndefined();
      expect(after.result).toEqual([{ body: "soup" }, { body: "salad" }]);
    });
  });
});
