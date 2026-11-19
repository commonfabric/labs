/**
 * The engine on the compact store: what it writes (vids, blobs, the format
 * mark and the migration rows), what it reads back, how a replay of a compact
 * commit is answered, what an open does to an existing store's schema, and the
 * guard that keeps pattern SQL off the `mem_` tables.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import {
  applyCommit,
  close,
  type Engine,
  open,
  read,
  selectPendingStreamEventDocs,
} from "../v2/engine.ts";
import { encodeMemoryBoundary, ProtocolError } from "../v2.ts";
import { readStoredValueText } from "../v2/value-store.ts";
import { readCommitOriginalText, resolutionText } from "../v2/commit-record.ts";
import {
  assertReadOnly,
  assertWriteSafe,
  classifyStatement,
  GuardError,
} from "../v2/sqlite/guard.ts";

const SESSION = "session:compact-store";

/** A synthetic document whose stored text is well over the inline limit. */
const largeDocument = (n: number) => ({
  value: {
    title: `synthetic title ${n} `.repeat(6),
    items: Array.from({ length: 8 }, (_, index) => ({
      index,
      label: `item label ${index} of a shared list`,
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

type CommitCells = {
  seq: number;
  session_id: string;
  original: string | Uint8Array;
  resolution: string | Uint8Array;
  digest: Uint8Array | null;
  reads: Uint8Array | null;
};

const commitRow = (engine: Engine, seq: number): CommitCells =>
  engine.database.prepare(
    `SELECT seq, session_id, original, resolution, digest, reads
     FROM "commit" WHERE seq = ?`,
  ).get<CommitCells>(seq)!;

const indexNames = (database: Database): string[] =>
  database.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`,
  ).all<{ name: string }>().map((row) => row.name);

describe("the compact store", () => {
  let dir: string;
  let path: string;
  const opened: Engine[] = [];

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "compact-store-" });
    path = `${dir}/space.sqlite`;
  });
  afterEach(async () => {
    for (const engine of opened) close(engine);
    opened.length = 0;
    await Deno.remove(dir, { recursive: true });
  });

  const openStore = async (): Promise<Engine> => {
    const engine = await open({ url: toFileUrl(path) });
    opened.push(engine);
    return engine;
  };

  const closeStore = (engine: Engine): void => {
    opened.splice(opened.indexOf(engine), 1);
    close(engine);
  };

  /** Writes three commits: a small one, a large set, and a large set that
   * confirms a read of the second. */
  const writeThree = (engine: Engine) => {
    applyCommit(engine, {
      sessionId: SESSION,
      commit: setCommit(1, "of:small", { value: 1 }),
    });
    applyCommit(engine, {
      sessionId: SESSION,
      commit: setCommit(2, "of:large", largeDocument(2)),
    });
    const third = setCommit(3, "of:other", largeDocument(3), [
      { id: "of:large", path: ["value"], seq: 2 },
    ]);
    applyCommit(engine, { sessionId: SESSION, commit: third });
    return third;
  };

  it("stores a large value as a vid and a commit as compact blobs", async () => {
    const engine = await openStore();
    const third = writeThree(engine);
    const database = engine.database;

    const data = (id: string) =>
      database.prepare(`SELECT data FROM revision WHERE id = ?`)
        .get<{ data: string | number }>(id)!.data;
    expect(typeof data("of:small")).toBe("string");
    expect(typeof data("of:large")).toBe("number");
    expect(readStoredValueText(database, data("of:large"))).toBe(
      encodeMemoryBoundary(largeDocument(2)),
    );
    const objects = database.prepare(
      `SELECT count(*) AS n FROM mem_value_object`,
    ).get<{ n: number }>()!.n;
    expect(objects).toBeGreaterThan(0);

    const genesis = commitRow(engine, 1);
    expect(typeof genesis.original).toBe("string");
    expect(genesis.digest).toBeNull();

    const row = commitRow(engine, 3);
    expect(row.original).toBeInstanceOf(Uint8Array);
    expect(row.digest).toBeInstanceOf(Uint8Array);
    expect(row.reads).toBeInstanceOf(Uint8Array);
    expect(row.resolution).toBeInstanceOf(Uint8Array);
    expect(readCommitOriginalText(database, engine.values, row)).toBe(
      encodeMemoryBoundary(third),
    );
    expect(resolutionText(row.resolution, row.seq)).toBe(
      encodeMemoryBoundary({ seq: 3 }),
    );
    expect(read(engine, { id: "of:large" })).toEqual(largeDocument(2));
  });

  it("reads every value back the same after the store is reopened", async () => {
    const first = await openStore();
    writeThree(first);
    closeStore(first);
    const engine = await openStore();
    expect(read(engine, { id: "of:small" })).toEqual({ value: 1 });
    expect(read(engine, { id: "of:large" })).toEqual(largeDocument(2));
    expect(read(engine, { id: "of:other" })).toEqual(largeDocument(3));
  });

  it("answers a replay of a compact commit as a replay and refuses a changed one", async () => {
    const engine = await openStore();
    const third = writeThree(engine);
    expect(commitRow(engine, 3).original).toBeInstanceOf(Uint8Array);

    const replay = applyCommit(engine, { sessionId: SESSION, commit: third });
    expect(replay.replayed).toBe(true);
    expect(replay.seq).toBe(3);

    const changed = setCommit(3, "of:other", largeDocument(4), [
      { id: "of:large", path: ["value"], seq: 2 },
    ]);
    expect(() => applyCommit(engine, { sessionId: SESSION, commit: changed }))
      .toThrow(ProtocolError);
  });

  it("marks a new store as format 1 with every migration phase done", async () => {
    const engine = await openStore();
    const database = engine.database;
    expect(
      database.prepare(`SELECT version FROM mem_store_format`).get(),
    ).toEqual({ version: 1 });
    expect(
      database.prepare(
        `SELECT phase, state FROM mem_store_migration ORDER BY phase`,
      ).all(),
    ).toEqual([
      { phase: "basis", state: "done" },
      { phase: "commits", state: "done" },
      { phase: "snapshots", state: "done" },
      { phase: "vacuum", state: "done" },
      { phase: "values", state: "done" },
    ]);
  });

  it("marks a store that already holds commits as pending, once", async () => {
    const first = await openStore();
    writeThree(first);
    first.database.exec(`DELETE FROM mem_store_migration`);
    closeStore(first);

    const engine = await openStore();
    const states = () =>
      engine.database.prepare(
        `SELECT DISTINCT state FROM mem_store_migration`,
      ).all<{ state: string }>().map((row) => row.state);
    expect(states()).toEqual(["pending"]);
    engine.database.exec(
      `UPDATE mem_store_migration SET state = 'done' WHERE phase = 'basis'`,
    );
    closeStore(engine);
    const again = await openStore();
    expect(
      again.database.prepare(
        `SELECT state FROM mem_store_migration WHERE phase = 'basis'`,
      ).get(),
    ).toEqual({ state: "done" });
  });

  it("refuses a store in a later format", async () => {
    const first = await openStore();
    first.database.exec(`UPDATE mem_store_format SET version = 2`);
    closeStore(first);
    await expect(open({ url: toFileUrl(path) })).rejects.toThrow(
      "The store is in format 2",
    );
  });

  it("refuses a store where a mem_ table has other columns", async () => {
    const database = new Database(path);
    database.exec(`CREATE TABLE mem_entity (name TEXT, note TEXT)`);
    database.close();
    await expect(open({ url: toFileUrl(path) })).rejects.toThrow(
      "The table mem_entity has the columns (name, note)",
    );
  });

  it("drops the redundant indexes an existing store holds", async () => {
    const first = await openStore();
    first.database.exec(`
      CREATE INDEX idx_head_branch ON head (branch);
      CREATE INDEX idx_revision_branch ON revision (branch, seq);
      CREATE INDEX idx_commit_invocation_ref ON "commit" (invocation_ref);
    `);
    closeStore(first);
    const engine = await openStore();
    const names = indexNames(engine.database);
    for (
      const dropped of [
        "idx_revision_branch_id_seq",
        "idx_revision_branch",
        "idx_head_branch",
        "idx_commit_branch",
        "idx_snapshot_lookup",
        "idx_commit_invocation_ref",
        "idx_scheduler_basis_entity",
      ]
    ) {
      expect(names).not.toContain(dropped);
    }
    expect(names).toContain("idx_commit_invocation_ref_present");
  });

  it("serves the effects and stream-event head scans from the primary key", async () => {
    const engine = await openStore();
    const plan = (sql: string, ...params: string[]) =>
      engine.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<
        { detail: string }
      >(...params).map((row) => row.detail).join("; ");
    expect(
      plan(
        `SELECT id, scope_key, op FROM head WHERE branch = ? AND id = ?`,
        "",
        "of:effects",
      ),
    ).toContain("SEARCH head USING INDEX sqlite_autoindex_head_1");
    expect(
      plan(
        `SELECT id, scope_key, op FROM head
         WHERE branch = ? AND id >= ? AND id < ?`,
        "",
        "of:stream-events:",
        "of:stream-events;",
      ),
    ).toContain("SEARCH head USING INDEX sqlite_autoindex_head_1");
    expect(selectPendingStreamEventDocs(engine)).toEqual([]);
  });
});

describe("the guard on mem_ tables", () => {
  const names = [
    "mem_value_object",
    "mem_value_hash",
    "mem_entity",
    "mem_read_shape",
    "mem_read_chunk",
    "mem_store_format",
    "mem_store_migration",
  ];

  it("marks a statement naming a mem_ table as a core reference", () => {
    for (const name of names) {
      expect(classifyStatement(`SELECT * FROM ${name}`).coreRef).toBe(true);
    }
  });

  it("refuses pattern reads and writes of mem_ tables", () => {
    for (const name of names) {
      expect(() => assertReadOnly(`SELECT * FROM ${name}`)).toThrow(GuardError);
      expect(() => assertWriteSafe(`DELETE FROM ${name}`)).toThrow(GuardError);
    }
  });
});
