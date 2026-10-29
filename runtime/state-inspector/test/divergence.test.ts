// Regression: the divergence verdict must compare the RAW stored value, not the
// display-annotated one. Annotating before hashing would (a) collapse two values
// that differ only BELOW the annotate depth cap, and (b) collapse a BigInt with
// the literal tag object it lowers to — both making genuinely-divergent scopes
// look "converged", the one thing a divergence tool must never do.

import { assert } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { scopeOverlay } from "../scopes.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
`;

const ID = "of:deep";
const USER = "user:did%3Akey%3AzUser";

/** A value that differs from its sibling only at depth ~11 (past annotate's 8). */
function deepValue(leaf: unknown) {
  let v: unknown = leaf;
  for (let i = 0; i < 11; i++) v = { d: v };
  return { value: v };
}

Deno.test("scopeOverlay detects divergence below the annotate depth cap", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-div-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    const db = new Database(dbPath, { create: true });
    db.exec(SCHEMA);
    const put = (seq: number, scope: string, value: unknown) => {
      db.prepare(
        `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
         VALUES (?, 'session:did:key:zUser:s', ?, '{}', '{}')`,
      ).run(seq, seq);
      db.prepare(
        `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
         VALUES (?, ?, ?, 0, 'set', ?, ?)`,
      ).run(ID, scope, seq, JSON.stringify(value), seq);
    };
    // space and user scopes hold the SAME structure differing only at the deep leaf.
    put(1, "space", deepValue("A"));
    put(2, USER, deepValue("B"));
    db.close();

    const space = openSpace(dbPath);
    try {
      const o = scopeOverlay(space, ID);
      assert(o.overridden, "two scopes hold the id");
      assert(
        o.divergent,
        "values differing only below depth 8 must be flagged divergent (raw-hash, not annotate-hash)",
      );
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
