// Hermetic test for the scope_key compatibility shim. Older space DBs predate
// the per-scope `scope_key` column on `revision`; openSpace shadows the table
// with a TEMP VIEW supplying a constant 'space' scope so scope-aware queries
// (which all filter `scope_key = 'space'`) work unchanged on those DBs.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { reconstructDocument } from "../reconstruct.ts";
import { listEntityModels } from "../model.ts";

// NOTE: no `scope_key` column on `revision` — the legacy schema.
const LEGACY_SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, seq, op_index)
);
-- a legacy snapshot table that ALSO predates scope_key
CREATE TABLE snapshot (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, seq INTEGER NOT NULL,
  value JSON NOT NULL, PRIMARY KEY (branch, id, seq)
);
`;

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(LEGACY_SCHEMA);
  db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (1, 'session:did:key:zX:u', 1, '{}', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES ('of:a', 1, 0, 'set', ?, 1)`,
  ).run(JSON.stringify({ value: { count: 7 } }));
  // a snapshot at seq 1 + a patch after it — exercises the snapshot-base read on
  // a pre-scope_key DB (the snapshot table is shimmed like revision).
  db.prepare(
    `INSERT INTO snapshot (id, seq, value) VALUES ('of:b', 1, ?)`,
  ).run(JSON.stringify({ value: { n: 1 } }));
  db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (2, 'session:did:key:zX:u', 2, '{}', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES ('of:b', 2, 0, 'patch', ?, 2)`,
  ).run(JSON.stringify([{ op: "replace", path: "/value/n", value: 2 }]));
  db.close();
}

Deno.test("scope_key shim: a DB without scope_key still inspects", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-db-" });
  const dbPath = `${dir}/legacy.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      // The shimmed column resolves to 'space', so the default scope finds it.
      const has = space.db
        .prepare(
          "SELECT scope_key, count(*) n FROM revision GROUP BY scope_key",
        )
        .all<{ scope_key: string; n: number }>();
      assertEquals(has, [{ scope_key: "space", n: 2 }]); // of:a set + of:b patch

      const doc = reconstructDocument(space, { id: "of:a" });
      assertEquals((doc?.value as { count: number }).count, 7);

      // Snapshot-base reconstruction works on a pre-scope_key DB (snapshot table
      // is shimmed too) — base = snapshot {n:1}, then the patch → {n:2}.
      const snapDoc = reconstructDocument(space, { id: "of:b" });
      assertEquals((snapDoc?.value as { n: number }).n, 2);

      const models = listEntityModels(space).entities;
      assertEquals(models.length, 2); // of:a, of:b
      assertEquals(models.map((m) => m.id).sort(), ["of:a", "of:b"]);
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("statements: a read issued per entity is prepared once per space", async () => {
  // A statement prepared per call stays alive until the database closes, so a
  // space-wide walk that prepares per entity holds millions of them.
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-db-" });
  const dbPath = `${dir}/legacy.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      const prepare = space.db.prepare.bind(space.db);
      const prepared = new Map<string, number>();
      space.db.prepare = ((sql: string) => {
        prepared.set(sql, (prepared.get(sql) ?? 0) + 1);
        return prepare(sql);
      }) as typeof space.db.prepare;
      for (let i = 0; i < 3; i++) {
        reconstructDocument(space, { id: "of:a" });
        reconstructDocument(space, { id: "of:b" });
      }
      assert(prepared.size > 0, "the reads went through the space");
      assertEquals(
        [...prepared].filter(([, count]) => count > 1),
        [],
      );
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("statements: a read after close is refused with an error", async () => {
  // The cached statements are finalized on close, and using one after that
  // crashes the process. The space refuses the read before it gets there.
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-db-" });
  const dbPath = `${dir}/legacy.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    reconstructDocument(space, { id: "of:a" });
    space.close();
    assertThrows(
      () => reconstructDocument(space, { id: "of:a" }),
      Error,
      "is closed",
    );
    space.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
