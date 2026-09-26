import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import {
  SQLITE_UNSENT_REFUSAL,
  sqliteAsksQuestion,
  sqliteQuery,
  sqliteQueryMemoDecision,
  sqliteRequestHash,
} from "../src/builtins/sqlite-builtins.ts";
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
   * look at the result cell while its query is in flight. A held read then
   * either answers or, given `"reject"`, fails.
   */
  function holdReads(
    outcome: "answer" | "reject" = "answer",
  ): { release: () => void } {
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
      if (outcome === "reject") throw new Error("sqlite read failed");
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

    it("keeps the previous rows through a second refresh issued while the first is pending", async () => {
      const { result, tick } = await runQuery("refresh-twice");
      await insertNote("lunch", "salad");
      const { release } = holdReads();

      await write(tick, 1);
      await runtime.idle();
      const firstRefresh = result.get().requestHash;
      await write(tick, 2);
      await runtime.idle();
      const during = result.get();
      expect(during.pending).toBe(true);
      expect(during.requestHash).not.toBe(firstRefresh);
      expect(during.result).toEqual([{ body: "soup" }]);

      release();
      await runtime.settled();
      const after = result.get();
      expect(after.pending).toBe(false);
      expect(after.requestHash).toBe(during.requestHash);
      expect(after.result).toEqual([{ body: "soup" }, { body: "salad" }]);
    });

    it("replaces the previous rows with the error when the refreshed query fails", async () => {
      const { result, tick } = await runQuery("refresh-fails");
      const { release } = holdReads("reject");

      await write(tick, 1);
      await runtime.idle();
      expect(result.get().result).toEqual([{ body: "soup" }]);

      release();
      await runtime.settled();
      const after = result.get();
      expect(after.pending).toBe(false);
      expect(after.error).toBeDefined();
      expect(after.result).toBeUndefined();
    });
  });

  describe("a new question, where the parameters changed", () => {
    it("clears the previous rows while the new query is pending", async () => {
      const { result, topic, first } = await runQuery("new-question");
      await insertNote("dinner", "steak");
      const { release } = holdReads();

      await write(topic, "dinner");
      await runtime.idle();
      const during = result.get();
      expect(during.pending).toBe(true);
      expect(during.requestHash).not.toBe(first.requestHash);
      expect(during.result).toBeUndefined();

      release();
      await runtime.settled();
      expect(result.get().result).toEqual([{ body: "steak" }]);
    });
  });

  describe("a refresh whose request is refused after its claim commits", () => {
    // The node is driven directly, which is what hands the case the refresh's
    // own transaction: its release check is made to fail by the prepared
    // state the commit reads, after the claim has landed.

    it("settles the refusal rather than staying pending", async () => {
      const setup = runtime.edit();
      const parent = runtime.getCell(space, "refused-parent", undefined, setup);
      parent.set({});
      const inputs = runtime.getCell<Record<string, unknown>>(
        space,
        "refused-inputs",
        undefined,
        setup,
      );
      inputs.set({ db, sql: NOTES_SQL, params: ["lunch"], reactOn: 0 });
      expect((await setup.commit()).error).toBeUndefined();

      let result: Cell<QueryState> | undefined;
      const builtin = sqliteQuery(
        inputs,
        (_tx, cell) => result = cell,
        () => {},
        [parent],
        parent,
        runtime,
      );

      const issue = runtime.edit();
      builtin.action(issue);
      runtime.prepareTxForCommit(issue);
      expect((await issue.commit()).error).toBeUndefined();
      await runtime.settled();
      expect(result!.get().result).toEqual([{ body: "soup" }]);

      const bump = runtime.edit();
      inputs.withTx(bump).key("reactOn").set(1);
      expect((await bump.commit()).error).toBeUndefined();

      const refresh = runtime.edit();
      builtin.action(refresh);
      refresh.prepareCfc();
      const state = refresh.getCfcState();
      const prepared = state.prepare;
      if (prepared.status !== "prepared") {
        throw new Error("the refresh's sink request was not prepared");
      }
      using _refused = stub(refresh, "getCfcState", () => ({
        ...state,
        prepare: {
          ...prepared,
          input: { ...prepared.input, writePolicyInputs: [] },
        },
      }));
      expect((await refresh.commit()).error).toBeUndefined();
      await runtime.settled();
      expect(result!.get()).toEqual({
        pending: false,
        error: SQLITE_UNSENT_REFUSAL,
      });
    });
  });

  describe("sqliteAsksQuestion()", () => {
    it("returns `true` for a request hash recording the question under another `reactOn`", () => {
      expect(sqliteAsksQuestion(sqliteRequestHash("q1", "r1"), "q1")).toBe(
        true,
      );
    });

    it("returns `false` for a question whose digest begins with the other one's", () => {
      expect(sqliteAsksQuestion(sqliteRequestHash("q12", "r1"), "q1")).toBe(
        false,
      );
    });

    it("returns `false` when no request hash is stored", () => {
      expect(sqliteAsksQuestion(undefined, "q1")).toBe(false);
    });
  });

  describe("sqliteQueryMemoDecision()", () => {
    it('returns `"issue"` for a refresh claim that keeps rows and has no request in flight here', () => {
      const hash = sqliteRequestHash("q1", "r2");
      const stored = { pending: true, requestHash: hash, result: [] };
      expect(sqliteQueryMemoDecision({
        stored,
        hash,
        inFlightHere: false,
        speculativeRun: false,
      })).toBe("issue");
    });
  });
});
