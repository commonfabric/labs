// Hermetic test for the scoped-provenance search: given a value rendered from a
// user- or session-scoped cell, the overlay names every candidate scope, and
// each candidate's history holds the revision whose value at a path matches
// that rendering. The overlay reports only each candidate's latest value, so
// the search reads each candidate's full history and reconstructs the value at
// every revision. This is the procedure the agent sessions debug console prints
// for a scoped raw value. Two identities write the same entity, and both
// overwrite their first value.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { entityHistory } from "../queries.ts";
import { getValueAt } from "../reconstruct.ts";
import { scopeOverlay } from "../scopes.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
`;

const ENTITY = "of:session";
const ALICE = "user:did%3Akey%3Aalice"; // stored, %-encoded
const BOB = "user:did%3Akey%3Abob";

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const put = (seq: number, scope: string, payload: string) => {
    db.prepare(
      `INSERT INTO "commit"
        (seq, branch, session_id, local_seq, original, resolution, created_at)
       VALUES (?, '', ?, ?, '{}', '{}', ?)`,
    ).run(seq, `session-${seq}`, seq, `2026-07-27T00:00:0${seq}.000Z`);
    db.prepare(
      `INSERT INTO revision
        (branch, id, scope_key, seq, op_index, op, data, commit_seq)
       VALUES ('', ?, ?, ?, 0, 'set', ?, ?)`,
    ).run(ENTITY, scope, seq, JSON.stringify({ value: { payload } }), seq);
  };
  // Alice wrote the rendered page, then both identities wrote again, so no
  // candidate's latest value is the one being traced.
  put(1, ALICE, "page snapshot");
  put(2, BOB, "other snapshot");
  put(3, ALICE, "new Alice value");
  put(4, BOB, "new Bob value");
  db.close();
}

Deno.test("candidate histories recover a snapshot after every scope changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-candidate-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      const candidates = scopeOverlay(space, ENTITY).variants.filter(
        (variant) => variant.kind === "user",
      );
      assertEquals(
        new Set(candidates.map((candidate) => candidate.scope)),
        new Set([ALICE, BOB]),
      );
      assert(
        candidates.every((candidate) =>
          (candidate.value as { payload: string }).payload !== "page snapshot"
        ),
      );

      const matches = candidates.flatMap((candidate) =>
        entityHistory(space, {
          id: ENTITY,
          scope: candidate.scope,
          limit: -1,
        }).flatMap((revision) =>
          getValueAt(
              space,
              {
                id: ENTITY,
                scope: candidate.scope,
                atSeq: revision.seq,
              },
              ["payload"],
            ).value === "page snapshot"
            ? [{ scope: candidate.scope, seq: revision.seq }]
            : []
        )
      );
      assertEquals(matches, [{ scope: ALICE, seq: 1 }]);
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
