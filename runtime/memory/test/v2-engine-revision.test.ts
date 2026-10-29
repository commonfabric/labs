import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import { applyCommit, close, open, ProtocolError, read } from "../v2/engine.ts";

const createEngine = async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

Deno.test("memory v2 engine bootstraps the revision schema", async () => {
  const { engine, path } = await createEngine();

  try {
    const schemaRows = engine.database.prepare(
      `SELECT name, type
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND type = 'table'
       ORDER BY name`,
    ).all() as Array<{ name: string; type: string }>;

    assertEquals(
      schemaRows.map((row) => row.name),
      [
        "authorization",
        "blob_store",
        "branch",
        "commit",
        "execution_lease",
        "execution_outbox",
        "head",
        "invocation",
        "op_checkpoint",
        "op_field_epoch",
        "op_integrated",
        "op_submission",
        "revision",
        "scheduler_basis",
        "snapshot",
      ],
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine drops the observation tables and never backfills scheduler_basis", async () => {
  // Server-execution v2 Phase 1 stage C.2 (serving-loop.md §3b): a store that
  // carries any of the SEVEN observation-era tables — scheduler_context_floor
  // included, the one main's old CORE_SCHEDULER_TABLES constant omitted (D6) —
  // has them dropped at open, and scheduler_basis starts EMPTY (D10: rows are
  // never migrated; a warm start is lost once, by design).
  const { engine, path } = await createEngine();
  close(engine);
  try {
    const raw = await new Database(path);
    raw.exec(`
      CREATE TABLE scheduler_observation (
        observation_id INTEGER PRIMARY KEY,
        payload JSON NOT NULL
      );
      INSERT INTO scheduler_observation (observation_id, payload)
      VALUES (1, '{}');
      CREATE TABLE scheduler_context_floor (
        piece_id TEXT NOT NULL,
        floor_scope TEXT NOT NULL
      );
      CREATE TABLE scheduler_read_index (read_id TEXT NOT NULL);
      CREATE TABLE scheduler_write_index (write_id TEXT NOT NULL);
      CREATE TABLE scheduler_action_state (action_id TEXT NOT NULL);
      CREATE TABLE scheduler_action_snapshot (action_id TEXT NOT NULL);
      CREATE TABLE scheduler_observation_replay (local_seq INTEGER NOT NULL);
    `);
    raw.close();

    const reopened = await open({ url: toFileUrl(path) });
    try {
      const tables = reopened.database.prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'scheduler_%'
         ORDER BY name`,
      ).all() as Array<{ name: string }>;
      assertEquals(tables.map((row) => row.name), ["scheduler_basis"]);
      const basisRows = reopened.database.prepare(
        `SELECT count(*) AS n FROM scheduler_basis`,
      ).get() as { n: number };
      assertEquals(basisRows.n, 0);
    } finally {
      close(reopened);
    }
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replays identical (sessionId, localSeq) commits and rejects mismatched originals", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:test",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
    };
    const authorization = { proof: "ok" };
    const firstCommit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set" as const,
        id: "of:doc:1",
        value: {
          value: {
            hello: "world",
          },
        },
      }],
    };

    const first = applyCommit(engine, {
      sessionId: "session:test",
      invocation,
      authorization,
      commit: firstCommit,
    });
    const replay = applyCommit(engine, {
      sessionId: "session:test",
      invocation,
      authorization,
      commit: firstCommit,
    });

    assertEquals(replay.seq, first.seq);
    assertEquals(read(engine, { id: "of:doc:1" }), {
      value: { hello: "world" },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:test",
          invocation,
          authorization,
          commit: {
            ...firstCommit,
            operations: [{
              op: "set",
              id: "of:doc:1",
              value: {
                value: {
                  hello: "different",
                },
              },
            }],
          },
        }),
      ProtocolError,
      "commit replay mismatch",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
