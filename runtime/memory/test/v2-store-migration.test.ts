/**
 * The store migration: converting a store whose rows are in text form to the
 * compact form, in batches that survive interruption, beside live writes, in
 * the background, with the `scheduler_basis` setting and the closing
 * `VACUUM`; and the compaction sweep of objects nothing references.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import {
  applyCommit,
  close,
  type Engine,
  open,
  read,
  settleStores,
  stageStores,
} from "../v2/engine.ts";
import { hashStringOf } from "@commonfabric/data-model";
import { encodeMemoryBoundary } from "../v2.ts";
import { readStoredValueText } from "../v2/value-store.ts";
import { readCommitOriginalText, resolutionText } from "../v2/commit-record.ts";
import {
  replaceSchedulerBasisRows,
  selectStaleBasisInstances,
} from "../v2/scheduler-basis.ts";
import {
  readStoreMigrationStatus,
  runStoreMigrationStep,
  runStoreMigrationToCompletion,
  startStoreMigration,
  type StoreMigrationOptions,
} from "../v2/store-migration.ts";
import { sweepUnreferencedObjects } from "../v2/compact.ts";
import { Server } from "../v2/server.ts";
import { authorizeLoopbackSessionOpen } from "../v2/session-open-auth.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

const SESSION = "session:store-migration";
const SPACE = "did:key:z6MkStoreMigrationSpace";
const FOREIGN = "did:key:z6MkStoreMigrationForeign";

/** A synthetic document well over the inline limit, sharing a long list. */
const largeDocument = (n: number) => ({
  value: {
    title: `synthetic title ${n} `.repeat(4),
    items: Array.from({ length: 6 }, (_, index) => ({
      index,
      label: `a shared item label number ${index} of the list`,
    })),
  },
});

const setCommit = (
  localSeq: number,
  id: string,
  value: unknown,
  confirmed: unknown[] = [],
) =>
  ({
    localSeq,
    reads: { confirmed, pending: [] },
    operations: [{ op: "set", id, value }],
  }) as never;

const patchCommit = (localSeq: number, id: string, n: number) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "patch",
      id,
      patches: [{
        op: "replace",
        path: "/value/title",
        value: `a patched title long enough to be stored as an object ${n}`,
      }],
    }],
  }) as never;

/** Every stored payload as text, in primary-key order. */
type Texts = {
  revisions: Array<[string, string | null]>;
  snapshots: Array<[string, string | null]>;
  commits: Array<[number, string, string]>;
};

const textsOf = (engine: Engine): Texts => {
  const db = engine.database;
  return {
    revisions: db.prepare(
      `SELECT branch, id, scope_key, seq, op_index, data FROM revision
       ORDER BY branch, id, scope_key, seq, op_index`,
    ).all<
      {
        branch: string;
        id: string;
        scope_key: string;
        seq: number;
        op_index: number;
        data: string | number | null;
      }
    >().map((
      row,
    ) => [
      `${row.branch}|${row.id}|${row.scope_key}|${row.seq}|${row.op_index}`,
      readStoredValueText(db, row.data),
    ]),
    snapshots: db.prepare(
      `SELECT branch, id, scope_key, seq, value FROM snapshot
       ORDER BY branch, id, scope_key, seq`,
    ).all<
      {
        branch: string;
        id: string;
        scope_key: string;
        seq: number;
        value: string | number;
      }
    >().map((row) => [
      `${row.branch}|${row.id}|${row.scope_key}|${row.seq}`,
      readStoredValueText(db, row.value),
    ]),
    commits: db.prepare(
      `SELECT seq, session_id, original, resolution, digest, reads
       FROM "commit" ORDER BY seq`,
    ).all<
      {
        seq: number;
        session_id: string;
        original: string | Uint8Array;
        resolution: string | Uint8Array;
        digest: Uint8Array | null;
        reads: Uint8Array | null;
      }
    >().map((row) => [
      row.seq,
      readCommitOriginalText(db, engine.values, row),
      resolutionText(row.resolution, row.seq),
    ]),
  };
};

/** The cells still in text form that the compact form would hold otherwise. */
const textCells = (engine: Engine) => {
  const count = (sql: string) =>
    engine.database.prepare(sql).value<[number]>()![0];
  return {
    revisions: count(
      `SELECT count(*) FROM revision WHERE typeof(data) = 'text'
         AND length(CAST(data AS BLOB)) >= 64`,
    ),
    snapshots: count(
      `SELECT count(*) FROM snapshot WHERE typeof(value) = 'text'
         AND length(CAST(value AS BLOB)) >= 64`,
    ),
    commits: count(
      `SELECT count(*) FROM "commit" WHERE typeof(original) = 'text'`,
    ),
  };
};

const failedPhases = (engine: Engine): string[] =>
  readStoreMigrationStatus(engine).phases.filter((phase) =>
    phase.state === "failed"
  ).map((phase) => `${phase.phase}: ${phase.error}`);

/** Every head's document through the engine, as codec text. */
const answersOf = (engine: Engine): string[] =>
  engine.database.prepare(
    `SELECT id, scope_key FROM head ORDER BY branch, id, scope_key`,
  ).all<{ id: string; scope_key: string }>().map((head) =>
    `${head.id}|${
      encodeMemoryBoundary(
        read(engine, {
          id: head.id as never,
          scopeKey: head.scope_key,
        }) as never,
      )
    }`
  );

describe("the store migration", () => {
  let dir: string;
  let oldStore: string;
  const opened: Engine[] = [];

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "store-migration-" });
    oldStore = `${dir}/old.sqlite`;
  });
  afterEach(async () => {
    for (const engine of opened) close(engine);
    opened.length = 0;
    await Deno.remove(dir, { recursive: true });
  });

  const openStore = async (path: string): Promise<Engine> => {
    const engine = await open({
      url: toFileUrl(path),
      snapshotInterval: 2,
    });
    opened.push(engine);
    return engine;
  };

  const closeStore = (engine: Engine): void => {
    opened.splice(opened.indexOf(engine), 1);
    close(engine);
  };

  /**
   * Writes a store through the engine, then rewrites every row to text form
   * and every phase back to pending: a store as an engine that knew only the
   * text form left it.
   */
  const writeOldStore = async (
    path: string,
    { documents = 6, basis = false } = {},
  ): Promise<void> => {
    const engine = await openStore(path);
    let localSeq = 0;
    for (let n = 0; n < documents; n++) {
      applyCommit(engine, {
        sessionId: SESSION,
        commit: setCommit(++localSeq, `of:doc-${n}`, largeDocument(n)),
      });
    }
    applyCommit(engine, {
      sessionId: SESSION,
      commit: setCommit(++localSeq, "of:small", { value: 1 }),
    });
    for (let n = 0; n < 5; n++) {
      applyCommit(engine, {
        sessionId: SESSION,
        commit: patchCommit(++localSeq, "of:doc-0", n),
      });
    }
    applyCommit(engine, {
      sessionId: SESSION,
      commit: setCommit(++localSeq, "of:reader", largeDocument(100), [
        { id: "of:doc-1", path: ["value"], seq: 3 },
        { id: "of:doc-2", path: ["value"], seq: 4 },
        { id: "of:doc-1", path: ["value", "items"], seq: 3 },
      ]),
    });
    // A compaction commit, and commit 2 hollowed under it in the marker form
    // the compaction tool writes.
    const compaction = applyCommit(engine, {
      sessionId: "compaction:run-1",
      commit: setCommit(1, "of:compaction-audit", { value: 2 }),
    });
    if (basis) writeBasisRows(engine);
    const db = engine.database;
    const texts = textsOf(engine);
    const hollowedText = texts.commits[1][1];
    texts.commits[1][1] = encodeMemoryBoundary({
      hollowed: {
        hash: hashStringOf(hollowedText),
        bytes: new TextEncoder().encode(hollowedText).length,
        commitSeq: compaction.seq,
        runId: "run-1",
      },
    });
    db.transaction(() => {
      for (
        const row of db.prepare(
          `SELECT rowid, data FROM revision WHERE typeof(data) = 'integer'`,
        ).all<{ rowid: number; data: number }>()
      ) {
        db.prepare(`UPDATE revision SET data = ? WHERE rowid = ?`).run(
          readStoredValueText(db, row.data),
          row.rowid,
        );
      }
      for (
        const row of db.prepare(
          `SELECT rowid, value FROM snapshot WHERE typeof(value) = 'integer'`,
        ).all<{ rowid: number; value: number }>()
      ) {
        db.prepare(`UPDATE snapshot SET value = ? WHERE rowid = ?`).run(
          readStoredValueText(db, row.value),
          row.rowid,
        );
      }
      for (const [seq, original, resolution] of texts.commits) {
        db.prepare(
          `UPDATE "commit" SET original = ?, resolution = ?, digest = NULL,
             reads = NULL WHERE seq = ?`,
        ).run(original, resolution, seq);
      }
      for (
        const table of [
          "mem_value_object",
          "mem_value_hash",
          "mem_entity",
          "mem_read_shape",
          "mem_read_chunk",
        ]
      ) db.exec(`DELETE FROM ${table}`);
      db.exec(
        `UPDATE mem_store_migration SET state = 'pending', cursor = NULL,
           detail = NULL`,
      );
      db.exec(
        `CREATE INDEX idx_scheduler_basis_entity ON scheduler_basis
           (branch, entity_space, entity, entity_scope_key)`,
      );
      db.exec(`
        DROP INDEX idx_commit_invocation_ref_present;
        CREATE INDEX idx_commit_invocation_ref ON "commit" (invocation_ref);
      `);
    }).immediate();
    closeStore(engine);
  };

  const invocationRefIndexes = (engine: Engine): string[] =>
    engine.database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name LIKE 'idx_commit_invocation_ref%'
       ORDER BY name`,
    ).all<{ name: string }>().map((row) => row.name);

  /**
   * Four instances: one with a home read behind its head, one current, one
   * whose only stale read is foreign, one reading a document with no head.
   */
  const writeBasisRows = (engine: Engine) => {
    const instance = (
      action: string,
      rows: Array<[string, string, number]>,
    ) =>
      replaceSchedulerBasisRows(engine, {
        branch: "",
        action,
        actionScopeKey: "space",
        rows: rows.map(([entitySpace, entity, seq]) => ({
          entitySpace,
          entity,
          entityScopeKey: "space",
          seq,
        })),
      });
    instance("action:stale", [[SPACE, "of:doc-0", 1], [SPACE, "of:doc-1", 3]]);
    instance("action:current", [[SPACE, "of:doc-1", 3]]);
    // The foreign read names an id this store holds a later head for, which
    // the home predicate must not judge.
    instance("action:foreign", [[FOREIGN, "of:doc-0", 1]]);
    instance("action:headless", [[SPACE, "of:nowhere", 0]]);
  };

  const basisInstances = (engine: Engine): string[] =>
    engine.database.prepare(
      `SELECT DISTINCT action FROM scheduler_basis ORDER BY action`,
    ).all<{ action: string }>().map((row) => row.action);

  const hasEntityIndex = (engine: Engine): boolean =>
    engine.database.prepare(
      `SELECT 1 FROM sqlite_master WHERE name = 'idx_scheduler_basis_entity'`,
    ).get() !== undefined;

  it("converts every row and reads back the same texts and answers", async () => {
    await writeOldStore(oldStore);
    const engine = await openStore(oldStore);
    const before = textsOf(engine);
    const answers = answersOf(engine);
    expect(textCells(engine).revisions).toBeGreaterThan(0);
    expect(textCells(engine).snapshots).toBeGreaterThan(0);
    expect(readStoreMigrationStatus(engine).complete).toBe(false);

    const status = runStoreMigrationToCompletion(engine, { batchRows: 4 });

    expect(status.complete).toBe(true);
    expect(textCells(engine)).toEqual({
      revisions: 0,
      snapshots: 0,
      commits: 2,
    });
    const phase = (name: string) =>
      status.phases.find((entry) => entry.phase === name)!;
    expect(phase("values").converted).toBeGreaterThan(0);
    expect(phase("values").kept).toBeGreaterThan(0);
    expect(phase("snapshots").converted).toBeGreaterThan(0);
    expect(phase("commits").converted).toBe(before.commits.length - 2);
    expect(phase("commits").kept).toBe(2);
    expect(phase("commits").detail.hollowed).toBe(1);
    expect(textsOf(engine)).toEqual(before);
    expect(answersOf(engine)).toEqual(answers);
  });

  it("reaches the same rows when interrupted at any batch boundary", async () => {
    await writeOldStore(oldStore);
    const options: StoreMigrationOptions = { batchRows: 3, vacuum: "off" };
    const reference = `${dir}/reference.sqlite`;
    await Deno.copyFile(oldStore, reference);
    const whole = await openStore(reference);
    let steps = 0;
    while (!runStoreMigrationStep(whole, options).complete) {
      expect(failedPhases(whole)).toEqual([]);
      steps++;
    }
    const expected = textsOf(whole);
    const expectedCells = textCells(whole);
    closeStore(whole);
    expect(steps).toBeGreaterThan(5);

    for (let k = 0; k <= steps; k++) {
      const copy = `${dir}/interrupted-${k}.sqlite`;
      await Deno.copyFile(oldStore, copy);
      const first = await openStore(copy);
      for (let step = 0; step < k; step++) {
        runStoreMigrationStep(first, options);
      }
      closeStore(first);
      const second = await openStore(copy);
      runStoreMigrationToCompletion(second, options);
      expect(textsOf(second)).toEqual(expected);
      expect(textCells(second)).toEqual(expectedCells);
      closeStore(second);
    }
  });

  it("ends a batch whose time is spent at the row in hand, and resumes after it", async () => {
    await writeOldStore(oldStore, { basis: true });
    const engine = await openStore(oldStore);
    const before = textsOf(engine);
    // With no time to spend, every batch takes exactly one row or instance.
    const options: StoreMigrationOptions = {
      batchMs: 0,
      batchRows: 100,
      schedulerBasis: "all",
      vacuum: "off",
    };
    const phase = (name: string) =>
      readStoreMigrationStatus(engine).phases.find((entry) =>
        entry.phase === name
      )!;
    const valuesTaken = () => phase("values").converted + phase("values").kept;

    runStoreMigrationStep(engine, options);
    expect(phase("basis").detail.instancesVisited).toBe(1);
    while (phase("basis").state !== "done") {
      runStoreMigrationStep(engine, options);
    }
    expect(phase("basis").detail.instancesVisited).toBe(4);
    expect(phase("basis").detail.batches).toBe(5);
    runStoreMigrationStep(engine, options);
    expect(valuesTaken()).toBe(1);
    runStoreMigrationStep(engine, options);
    expect(valuesTaken()).toBe(2);

    const status = runStoreMigrationToCompletion(engine, options);
    expect(status.complete).toBe(true);
    expect(textsOf(engine)).toEqual(before);
    expect(phase("values").detail.batches).toBe(valuesTaken() + 1);
    expect(phase("commits").detail.batches).toBe(
      phase("commits").converted + phase("commits").kept + 1,
    );
  });

  it("keeps an old store's full `invocation_ref` index until the run builds the partial one", async () => {
    await writeOldStore(oldStore);
    const engine = await openStore(oldStore);
    expect(invocationRefIndexes(engine)).toEqual(["idx_commit_invocation_ref"]);

    runStoreMigrationToCompletion(engine, { vacuum: "off" });

    expect(invocationRefIndexes(engine)).toEqual([
      "idx_commit_invocation_ref_present",
    ]);
    closeStore(engine);
    const reopened = await openStore(oldStore);
    expect(invocationRefIndexes(reopened)).toEqual([
      "idx_commit_invocation_ref_present",
    ]);
  });

  it("serves and replays a commit applied between two batches", async () => {
    await writeOldStore(oldStore);
    const engine = await openStore(oldStore);
    const options = { batchRows: 2 };
    runStoreMigrationStep(engine, options);
    runStoreMigrationStep(engine, options);
    const commit = setCommit(1, "of:between", largeDocument(7), [
      { id: "of:doc-3", path: ["value"], seq: 5 },
    ]);
    applyCommit(engine, { sessionId: "session:between", commit });
    expect(read(engine, { id: "of:between" as never })).toEqual(
      largeDocument(7),
    );
    runStoreMigrationStep(engine, options);

    const replay = applyCommit(engine, {
      sessionId: "session:between",
      commit,
    });

    expect(replay.replayed).toBe(true);
    runStoreMigrationToCompletion(engine, options);
    expect(read(engine, { id: "of:between" as never })).toEqual(
      largeDocument(7),
    );
    expect(textCells(engine).revisions).toBe(0);
  });

  it("stops a background run on request and resumes it at the next start", async () => {
    await writeOldStore(oldStore, { documents: 30 });
    const engine = await openStore(oldStore);
    const before = textsOf(engine);

    const first = startStoreMigration(engine, { batchRows: 2 });
    await first.stop();
    const stopped = await first.done;

    expect(stopped.complete).toBe(false);
    const second = startStoreMigration(engine, { batchRows: 2 });
    const finished = await second.done;
    expect(finished.complete).toBe(true);
    expect(textsOf(engine)).toEqual(before);
  });

  it("ends a background run when the engine closes", async () => {
    await writeOldStore(oldStore, { documents: 30 });
    const engine = await openStore(oldStore);

    const run = startStoreMigration(engine, { batchRows: 1 });
    closeStore(engine);
    const status = await run.done;

    expect(status.complete).toBe(false);
    const reopened = await openStore(oldStore);
    expect(readStoreMigrationStatus(reopened).complete).toBe(false);
    expect(runStoreMigrationToCompletion(reopened).complete).toBe(true);
  });

  it("keeps every basis row and the entity index under `keep`", async () => {
    await writeOldStore(oldStore, { basis: true });
    const engine = await openStore(oldStore);
    const before = basisInstances(engine);

    runStoreMigrationToCompletion(engine, { schedulerBasis: "keep" });

    expect(basisInstances(engine)).toEqual(before);
    expect(hasEntityIndex(engine)).toBe(true);
  });

  it("deletes exactly the home-stale instances under `stale`", async () => {
    await writeOldStore(oldStore, { basis: true });
    const engine = await openStore(oldStore);
    const { stale } = selectStaleBasisInstances(engine, {
      branch: "",
      space: SPACE,
    });
    expect(stale.map((instance) => instance.action)).toEqual([
      "action:stale",
    ]);

    const status = runStoreMigrationToCompletion(engine, {
      schedulerBasis: "stale",
      space: SPACE,
      batchRows: 1,
    });

    expect(basisInstances(engine)).toEqual([
      "action:current",
      "action:foreign",
      "action:headless",
    ]);
    expect(status.phases[0].deleted).toBe(2);
    expect(hasEntityIndex(engine)).toBe(false);
  });

  it("keeps every basis row under `stale` when the store names no space", async () => {
    await writeOldStore(oldStore, { basis: true });
    const engine = await openStore(oldStore);

    const status = runStoreMigrationToCompletion(engine, {
      schedulerBasis: "stale",
    });

    expect(basisInstances(engine)).toHaveLength(4);
    expect(status.phases[0].detail.mode).toBe("keep");
    expect(hasEntityIndex(engine)).toBe(true);
  });

  it("deletes every visited instance under `all`", async () => {
    await writeOldStore(oldStore, { basis: true });
    const engine = await openStore(oldStore);

    const status = runStoreMigrationToCompletion(engine, {
      schedulerBasis: "all",
    });

    expect(basisInstances(engine)).toEqual([]);
    expect(status.phases[0].deleted).toBe(5);
    expect(hasEntityIndex(engine)).toBe(false);
  });

  it("vacuums a store whose freed pages pass the bound, once", async () => {
    // Over 64 MiB of text, two thirds of it in values the conversion stores
    // as one object each, so the freed pages pass both bounds.
    const engine = await openStore(oldStore);
    const filler = "synthetic filler text ".repeat(48_000);
    engine.database.transaction(() => {
      for (let n = 0; n < 80; n++) {
        engine.database.prepare(
          `INSERT INTO scheduler_basis (branch, action, action_scope_key,
             entity_space, entity, entity_scope_key, seq)
           VALUES ('', ?, 'space', ?, 'of:filler', 'space', 0)`,
        ).run(`action:${n}`, `${filler}${n}`);
      }
    }).immediate();
    applyCommit(engine, {
      sessionId: SESSION,
      commit: setCommit(1, "of:doc", largeDocument(1)),
    });
    engine.database.exec(
      `UPDATE mem_store_migration SET state = 'pending'`,
    );
    engine.database.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    const bytesBefore = (await Deno.stat(oldStore)).size;
    expect(bytesBefore).toBeGreaterThan(64 * 1024 * 1024);

    const status = runStoreMigrationToCompletion(engine, {
      schedulerBasis: "all",
    });

    const vacuum = status.phases.find((phase) => phase.phase === "vacuum")!;
    expect(vacuum.state).toBe("done");
    expect(vacuum.detail.vacuumed).toBe(true);
    expect((await Deno.stat(oldStore)).size).toBeLessThan(4 * 1024 * 1024);
    const again = runStoreMigrationToCompletion(engine);
    expect(again.phases.find((phase) => phase.phase === "vacuum")!.detail)
      .toEqual(vacuum.detail);
  });

  it("finds a new store complete and schedules nothing for it", async () => {
    const engine = await openStore(`${dir}/new.sqlite`);
    applyCommit(engine, {
      sessionId: SESSION,
      commit: setCommit(1, "of:doc", largeDocument(1)),
    });

    const run = startStoreMigration(engine);
    const status = await run.done;

    expect(status.complete).toBe(true);
    expect(
      status.phases.every((phase) =>
        phase.state === "done" && phase.cursor === null
      ),
    ).toBe(true);
    expect(runStoreMigrationStep(engine)).toEqual({
      phase: null,
      complete: true,
    });
  });

  it("reads each phase's key range through its primary key", async () => {
    const engine = await openStore(oldStore);
    const plan = (sql: string) =>
      engine.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<
        { detail: string }
      >().map((row) => row.detail).join("; ");

    expect(plan(
      `SELECT data FROM revision WHERE typeof(data) = 'text'
         AND (branch, id, scope_key, seq, op_index) > ('', 'a', 'b', 1, 0)
       ORDER BY branch, id, scope_key, seq, op_index`,
    )).toContain("USING INDEX sqlite_autoindex_revision_1");
    expect(plan(
      `SELECT value FROM snapshot WHERE typeof(value) = 'text'
         AND (branch, id, scope_key, seq) > ('', 'a', 'b', 1)
       ORDER BY branch, id, scope_key, seq`,
    )).toContain("USING INDEX sqlite_autoindex_snapshot_1");
  });

  /** An old store at the place a server keeps `space`'s store under `dir`. */
  const serverStore = async () => {
    const store = toFileUrl(`${dir}/server/`);
    const space = (await Identity.generate()).did();
    const path = fromFileUrl(resolveSpaceStoreUrl(store, space));
    await Deno.mkdir(dirname(path), { recursive: true });
    await writeOldStore(path);
    return { store, space, path };
  };

  it("has the memory server convert a file store it opens in the background", async () => {
    const { store, space, path } = await serverStore();
    const server = new Server({
      store,
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: space },
    });
    try {
      expect(await server.readDocument(space, "of:doc-1")).toEqual(
        largeDocument(1),
      );
      const status = await server.storeMigrationDone(space);
      expect(status?.complete).toBe(true);
      expect(await server.readDocument(space, "of:doc-1")).toEqual(
        largeDocument(1),
      );
    } finally {
      await server.close();
    }
    const engine = await openStore(path);
    expect(textCells(engine)).toEqual({
      revisions: 0,
      snapshots: 0,
      commits: 2,
    });
  });

  it("leaves a file store as it is when the server's migration is off", async () => {
    const { store, space, path } = await serverStore();
    const server = new Server({
      store,
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: space },
      storeMigration: "off",
    });
    try {
      await server.readDocument(space, "of:doc-1");
      expect(server.storeMigrationDone(space)).toBeUndefined();
    } finally {
      await server.close();
    }
    const engine = await openStore(path);
    expect(readStoreMigrationStatus(engine).complete).toBe(false);
    expect(textCells(engine).revisions).toBeGreaterThan(0);
  });

  it("sweeps the objects and chunks no row references", async () => {
    await writeOldStore(oldStore);
    const engine = await openStore(oldStore);
    runStoreMigrationToCompletion(engine);
    const before = textsOf(engine);
    const db = engine.database;
    const count = (table: string) =>
      db.prepare(`SELECT count(*) FROM ${table}`).value<[number]>()![0];
    const objects = count("mem_value_object");
    const chunks = count("mem_read_chunk");
    db.transaction(() => {
      stageStores(engine);
      engine.values.storeRowText(
        encodeMemoryBoundary({
          value: { orphan: "an orphaned value nothing references ".repeat(4) },
        }),
      );
      db.prepare(
        `INSERT INTO mem_read_chunk (hash, body) VALUES (x'00', x'00')`,
      ).run();
      settleStores(engine, true);
    }).immediate();

    const swept = db.transaction(() => sweepUnreferencedObjects(engine))
      .immediate();

    expect(swept.chunks).toBe(1);
    expect(swept.objects).toBeGreaterThan(0);
    expect(count("mem_value_object")).toBe(objects);
    expect(count("mem_read_chunk")).toBe(chunks);
    expect(count("mem_value_hash")).toBe(objects);
    expect(textsOf(engine)).toEqual(before);
  });
});
