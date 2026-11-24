// Engine-layer atomicity: a `sqlite` write op folded into a commit lands in the
// SAME BEGIN…COMMIT as the cell ops, so a failure rolls back BOTH. (spec 04;
// plans/atomic-writes.md.)

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, open, read } from "../v2/engine.ts";
import {
  aliasForDbId,
  attachDatabase,
  detachDatabase,
  ensureTables,
  runQuery,
} from "../v2/sqlite/exec.ts";
import { table } from "../v2/sqlite/schema.ts";

const DB_ID = "of:atomic-db";
const TABLES = { messages: table({ id: "integer primary key", body: "text" }) };

async function freshEngine() {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  return await open({ url: toFileUrl(path) });
}

Deno.test("commit with a cell op + a sqlite op lands both atomically", async () => {
  const engine = await freshEngine();
  const alias = aliasForDbId(DB_ID);
  attachDatabase(
    engine.database,
    alias,
    await Deno.makeTempFile({ suffix: ".sqlite" }),
  );
  ensureTables(engine.database, TABLES, alias);
  try {
    applyCommit(engine, {
      sessionId: "session:a",
      principal: "did:key:alice",
      space: "did:key:space",
      sqliteAttachments: new Map([[DB_ID, alias]]),
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "entity:c", value: { value: { ok: true } } },
          {
            op: "sqlite",
            db: { id: DB_ID, tables: TABLES },
            sql: "INSERT INTO messages (body) VALUES (?)",
            params: ["hi"],
          },
        ],
      },
    });
    assertEquals(read(engine, { id: "entity:c" }), { value: { ok: true } });
    assertEquals(
      runQuery(engine.database, "SELECT body FROM messages"),
      [{ body: "hi" }],
    );
  } finally {
    detachDatabase(engine.database, alias);
  }
});

Deno.test("a failing commit rolls back BOTH the cell and the row", async () => {
  const engine = await freshEngine();
  const alias = aliasForDbId(DB_ID);
  attachDatabase(
    engine.database,
    alias,
    await Deno.makeTempFile({ suffix: ".sqlite" }),
  );
  ensureTables(engine.database, TABLES, alias);
  try {
    // A trailing guard-violating sqlite op throws AFTER the good INSERT, so the
    // engine has executed the row write when it throws and must roll back.
    assertThrows(() =>
      applyCommit(engine, {
        sessionId: "session:a",
        principal: "did:key:alice",
        space: "did:key:space",
        sqliteAttachments: new Map([[DB_ID, alias]]),
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "entity:c", value: { value: { ok: true } } },
            {
              op: "sqlite",
              db: { id: DB_ID },
              sql: "INSERT INTO messages (body) VALUES (?)",
              params: ["hi"],
            },
            { op: "sqlite", db: { id: DB_ID }, sql: "DROP TABLE messages" },
          ],
        },
      })
    );
    assertEquals(read(engine, { id: "entity:c" }), null);
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM messages"),
      [{ n: 0 }],
    );
  } finally {
    detachDatabase(engine.database, alias);
  }
});
