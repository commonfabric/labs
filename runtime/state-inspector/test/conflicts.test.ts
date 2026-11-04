// Hermetic test for conflict detection: a cell contested by two identities,
// with a constructed ANOMALOUS stale read — Bob reads X@1, Alice writes X@3,
// Bob commits at @4 having never seen Alice's write. Also checks the multi-user
// vs multi-session distinction, and that the engine-faithful conflict check does
// NOT fire across different scopes or for non-overlapping patch paths (the
// over-reporting the reviews flagged). session_ids use the real %-encoded form.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { contendedEntities, entityConflicts } from "../conflicts.ts";

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

// Real on-disk form: the principal DID is %-encoded inside the session_id.
const SA = "session:did%3Akey%3AzAlice:s1";
const SB = "session:did%3Akey%3AzBob:s2";
const X = "of:X";

interface ReadSeed {
  seq: number;
  path?: string[];
  scope?: string;
}

function open(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  let nextSeq = 0;
  const commit = (session: string, reads: ReadSeed[]) => {
    const seq = ++nextSeq;
    db.prepare(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
       VALUES (?, ?, ?, ?, '{"seq":0}')`,
    ).run(
      seq,
      session,
      seq,
      JSON.stringify({
        operations: [{ op: "set" }],
        reads: {
          confirmed: reads.map((r) => ({
            id: X,
            path: r.path ?? [],
            seq: r.seq,
            ...(r.scope ? { scope: r.scope } : {}),
          })),
          pending: [],
        },
      }),
    );
    return seq;
  };
  // A set lays the whole document; a patch carries a REAL patch-op array.
  const setRev = (commitSeq: number, scope = "space") =>
    db.prepare(
      `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
       VALUES (?, ?, ?, 0, 'set', ?, ?)`,
    ).run(
      X,
      scope,
      commitSeq,
      JSON.stringify({ value: { v: commitSeq } }),
      commitSeq,
    );
  const patchRev = (commitSeq: number, pointer: string, scope = "space") =>
    db.prepare(
      `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
       VALUES (?, ?, ?, 0, 'patch', ?, ?)`,
    ).run(
      X,
      scope,
      commitSeq,
      JSON.stringify([{ op: "replace", path: pointer, value: commitSeq }]),
      commitSeq,
    );
  return { db, commit, setRev, patchRev };
}

Deno.test("conflicts: contention + anomalous stale-read detection", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-conf-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    {
      const { db, commit, setRev, patchRev } = open(dbPath);
      // 1 Alice creates X. 2 Bob patches /value/v (saw @1). 3 Alice patches
      // /value/v again. 4 Bob patches /value/v but still read @1 → missed @3.
      setRev(commit(SA, []));
      patchRev(commit(SB, [{ seq: 1 }]), "/value/v");
      patchRev(commit(SA, [{ seq: 2 }]), "/value/v");
      patchRev(commit(SB, [{ seq: 1 }]), "/value/v");
      db.close();
    }
    const space = openSpace(dbPath);
    try {
      await t.step("contendedEntities flags multi-user contention", () => {
        const rows = contendedEntities(space);
        assertEquals(rows.length, 1);
        const c = rows[0];
        assertEquals(c.id, X);
        assertEquals(c.sessions, 2);
        assertEquals(c.principals, 2); // Alice + Bob — real cross-user
        assert(c.multiUser);
        assert(c.interleaved); // A,B,A,B
      });

      await t.step("entityConflicts detects the anomalous stale read", () => {
        const c = entityConflicts(space, X);
        assertEquals(c.writerPrincipals, 2);
        assert(c.multiUser);
        assertEquals(c.staleReads.length, 1);
        const sr = c.staleReads[0];
        assertEquals(sr.readerCommitSeq, 4); // Bob's stale commit
        assertEquals(sr.readAtSeq, 1); // read X@1
        assertEquals(sr.missedWriteSeq, 3); // missed Alice's write @3
        assertEquals(sr.readScopeKey, "space");
        assert(sr.readerAlsoWrote); // Bob also wrote → lost-update risk
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("conflicts: engine-faithful checks do NOT over-report", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-conf2-" });

  await t.step("a write in a DIFFERENT scope is not a conflict", () => {
    const p = `${dir}/scope.sqlite`;
    {
      const { db, commit, setRev, patchRev } = open(p);
      // Bob reads X in the SPACE scope @1; Alice writes X in a USER scope @3.
      // Different scope_key → the engine would not conflict, nor should we.
      setRev(commit(SA, []));
      commit(SB, [{ seq: 1, scope: "space" }]); // reader, no write here
      patchRev(commit(SA, [{ seq: 2 }]), "/value/v", "user:did%3Akey%3AzAlice");
      patchRev(commit(SB, [{ seq: 1, scope: "space" }]), "/value/v");
      db.close();
    }
    const space = openSpace(p);
    try {
      const c = entityConflicts(space, X);
      // Bob's reads are space-scoped; Alice's only post-read write is user-scoped.
      assertEquals(c.staleReads.length, 0);
    } finally {
      space.close();
    }
  });

  await t.step("a non-overlapping patch path is not a conflict", () => {
    const p = `${dir}/path.sqlite`;
    {
      const { db, commit, setRev, patchRev } = open(p);
      // Bob reads only X/value/a; Alice patches X/value/b → disjoint paths.
      setRev(commit(SA, []));
      patchRev(commit(SA, [{ seq: 1 }]), "/value/b");
      patchRev(commit(SB, [{ seq: 1, path: ["value", "a"] }]), "/value/a");
      db.close();
    }
    const space = openSpace(p);
    try {
      const c = entityConflicts(space, X);
      assertEquals(c.staleReads.length, 0);
    } finally {
      space.close();
    }
  });

  await t.step(
    "an unqualified read resolves to the COMMIT's branch, not the inspected one",
    () => {
      const p = `${dir}/branch.sqlite`;
      {
        const db = new Database(p, { create: true });
        db.exec(SCHEMA);
        const ins = (
          seq: number,
          branch: string,
          session: string,
          reads: number[],
        ) =>
          db.prepare(
            `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
           VALUES (?, ?, ?, ?, ?, '{"seq":0}')`,
          ).run(
            seq,
            branch,
            session,
            seq,
            JSON.stringify({
              operations: [{ op: "set" }],
              reads: {
                confirmed: reads.map((s) => ({ id: X, path: [], seq: s })),
                pending: [],
              },
            }),
          );
        const rev = (seq: number, branch: string, op: string) =>
          db.prepare(
            `INSERT INTO revision (id, branch, scope_key, seq, op_index, op, data, commit_seq)
           VALUES (?, ?, 'space', ?, 0, ?, ?, ?)`,
          ).run(
            X,
            branch,
            seq,
            op,
            op === "set" ? JSON.stringify({ value: { v: seq } }) : null,
            seq,
          );
        // default branch: Alice creates X@1; Bob reads X@1 on default and commits @4.
        ins(1, "", SA, []);
        rev(1, "", "set");
        // a `feature` branch writes X@2 — must NOT count against Bob's default read.
        ins(2, "feature", SA, []);
        rev(2, "feature", "set");
        ins(4, "", SB, [1]);
        rev(4, "", "set");
        db.close();
      }
      const space = openSpace(p);
      try {
        // Inspecting `feature`: Bob's read was on default, so the feature write is
        // not a conflict for it. The old `rd.branch ?? inspectedBranch` bug flagged it.
        const c = entityConflicts(space, X, { branch: "feature" });
        assertEquals(c.staleReads.length, 0);
      } finally {
        space.close();
      }
    },
  );

  await Deno.remove(dir, { recursive: true });
});
