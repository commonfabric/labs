// Hermetic test for cross-space replica classification. Builds two space DBs
// named by their DID; space A holds a link that points cross-space at entity X
// in space B, so X is a real replica (drift), while Y is a coincidental same-id
// instance (no cross-space link). Side-effect free.

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import {
  buildCrossSpaceLinkIndex,
  convergence,
  convergenceScanExact,
  openSpaces,
} from "../multispace.ts";

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

function makeSpace(path: string, entries: { id: string; value: unknown }[]) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, 1, '{}', ?)`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  entries.forEach((e, i) => {
    const seq = i + 1;
    commit.run(seq, `session-${i}`, JSON.stringify({ seq }));
    rev.run(e.id, seq, JSON.stringify({ value: e.value }), seq);
  });
  db.close();
}

const DID_A = "did:key:zSpaceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DID_B = "did:key:zSpaceBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

Deno.test("cross-space replica classification", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-classify-" });
  try {
    // Space A links cross-space to X@B (real replica). Both X and Y are shared and
    // divergent, but only X is reached by a cross-space link.
    const xLink = { "/": { "link@1": { id: "of:X", space: DID_B } } };
    makeSpace(`${dir}/${DID_A}.sqlite`, [
      { id: "of:X", value: { n: 1 } },
      { id: "of:Y", value: { n: 1 } },
      { id: "of:holder", value: { ref: xLink } },
    ]);
    makeSpace(`${dir}/${DID_B}.sqlite`, [
      { id: "of:X", value: { n: 2 } }, // diverges from A
      { id: "of:Y", value: { n: 2 } }, // diverges from A
    ]);

    const refs = openSpaces([
      `${dir}/${DID_A}.sqlite`,
      `${dir}/${DID_B}.sqlite`,
    ]);
    try {
      await t.step("link index finds the cross-space edge to X@B", () => {
        const index = buildCrossSpaceLinkIndex(refs);
        assertEquals(index.edges.length, 1);
        assertEquals(index.edges[0].toSpace, DID_B);
        assertEquals(index.edges[0].toId, "of:X");
        assertEquals(index.targets.has(`${DID_B} of:X`), true);
      });

      await t.step("X is classified cross-space-linked (real drift)", () => {
        const index = buildCrossSpaceLinkIndex(refs);
        const r = convergence(refs, { id: "of:X" }, index);
        assertEquals(r.verdict, "diverged");
        assertEquals(r.relationship, "cross-space-linked");
      });

      await t.step(
        "Y is classified no-cross-space-link (likely instance)",
        () => {
          const index = buildCrossSpaceLinkIndex(refs);
          const r = convergence(refs, { id: "of:Y" }, index);
          assertEquals(r.verdict, "diverged");
          assertEquals(r.relationship, "no-cross-space-link");
        },
      );

      await t.step("scan tallies one drift, one instance", () => {
        const scan = convergenceScanExact(refs);
        assertEquals(scan.crossSpaceLinkEdges, 1);
        assertEquals(scan.linkedFindings, 1);
        assertEquals(scan.unlinkedFindings, 1);
        assertEquals(scan.unknownFindings, 0);
      });
    } finally {
      for (const r of refs) r.space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
