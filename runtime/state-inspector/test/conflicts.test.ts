// Hermetic test for conflict detection: a cell contested by two identities,
// with a constructed ANOMALOUS stale read — Bob reads X@1, Alice writes X@3,
// Bob commits at @4 having never seen Alice's write. Also checks the multi-user
// vs multi-session distinction, and that the engine-faithful conflict check does
// NOT fire across different scopes or for non-overlapping patch paths (the
// over-reporting the reviews flagged). session_ids use the real %-encoded form.

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  open as openEngine,
} from "@commonfabric/memory/v2/engine";
import { type ClientCommit, toDocumentPath } from "@commonfabric/memory/v2";
import {
  compactStore,
  isHollowedPayload,
} from "@commonfabric/memory/v2/compact";
import { encodeStoredCommit } from "@commonfabric/memory/v2/stored-commit";

import { openSpace } from "../db.ts";
import { contendedEntities, entityConflicts } from "../conflicts.ts";
import { listCommits } from "../queries.ts";
import { readCoherence } from "../oracle.ts";

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

  await t.step(
    "a set, a delete, or an undecodable patch after the read conflicts",
    () => {
      for (
        const [op, data] of [
          ["set", '{"value":{"v":2}}'],
          ["delete", null],
          ["patch", "{"],
        ] as const
      ) {
        const p = `${dir}/whole-${op}.sqlite`;
        {
          const { db, commit, setRev } = open(p);
          setRev(commit(SA, []));
          db.prepare(
            `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
             VALUES (?, ?, 0, ?, ?, ?)`,
          ).run(X, 2, op, data, commit(SA, []));
          commit(SB, [{ seq: 1, path: ["value", "unrelated"] }]);
          db.close();
        }
        const space = openSpace(p);
        try {
          const c = entityConflicts(space, X);
          expect(c.staleReads.map((r) => [r.missedWriteSeq, r.missedWriteOp]))
            .toEqual([[2, op]]);
          expect(c.staleReads[0].readerAlsoWrote).toBe(false);
        } finally {
          space.close();
        }
      }
    },
  );

  await t.step("an operation that is not a write never conflicts", () => {
    const p = `${dir}/unknown-op.sqlite`;
    {
      const { db, commit, setRev } = open(p);
      setRev(commit(SA, []));
      db.prepare(
        `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
         VALUES (?, 2, 0, 'touch', NULL, ?)`,
      ).run(X, commit(SA, []));
      commit(SB, [{ seq: 1 }]);
      db.close();
    }
    const space = openSpace(p);
    try {
      expect(entityConflicts(space, X).staleReads).toEqual([]);
    } finally {
      space.close();
    }
  });

  await t.step(
    "reads that cannot be decoded or resolved are skipped",
    () => {
      const p = `${dir}/unreadable.sqlite`;
      {
        const { db, commit, setRev } = open(p);
        setRev(commit(SA, []));
        setRev(commit(SA, []));
        const insert = db.prepare(
          `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
           VALUES (?, ?, 1, ?, '{}')`,
        );
        // An original that mentions X but is not JSON.
        insert.run(3, SB, `{"id":"${X}"`);
        // A user-scoped read from a session with no principal.
        insert.run(
          4,
          "anonymous",
          JSON.stringify({
            reads: { confirmed: [{ id: X, path: [], seq: 1, scope: "user" }] },
          }),
        );
        // The same read in the space scope does conflict.
        insert.run(
          5,
          "anonymous",
          JSON.stringify({
            reads: { confirmed: [{ id: X, path: [], seq: 1, scope: "space" }] },
          }),
        );
        db.close();
      }
      const space = openSpace(p);
      try {
        const c = entityConflicts(space, X);
        expect(c.staleReads.map((r) => r.readerCommitSeq)).toEqual([5]);
        // Commit 3's payload and commit 4's read went unchecked.
        expect(c.readSetsNotKept).toBe(2);
      } finally {
        space.close();
      }
    },
  );

  await Deno.remove(dir, { recursive: true });
});

Deno.test("conflicts: counts the later commits whose reads it could not check", async () => {
  // An engine storing digests: a read before of:x is first written, and one
  // after. Only the later one could have read of:x stale.
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await openEngine({
    url: toFileUrl(path),
    storeReadsDigest: true,
  });
  const reading = (
    localSeq: number,
    id: string,
    seq: number,
    write: string,
  ): ClientCommit => ({
    localSeq,
    reads: {
      confirmed: [{ id, path: toDocumentPath(["value"]), seq }],
      pending: [],
    },
    operations: [{ op: "set", id: write, value: { value: localSeq } }],
  });
  const setting = (localSeq: number, id: string): ClientCommit => ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id, value: { value: localSeq } }],
  });
  try {
    applyCommit(engine, { sessionId: "s:a", commit: setting(1, "of:y") });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: reading(2, "of:y", 1, "of:z"),
    });
    applyCommit(engine, { sessionId: "s:b", commit: setting(1, "of:x") });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: reading(3, "of:x", 3, "of:w"),
    });
  } finally {
    close(engine);
  }

  const space = openSpace(path);
  try {
    const x = entityConflicts(space, "of:x");
    expect(x.staleReads).toEqual([]);
    expect(x.readSetsNotKept).toBe(1);
    // No read of an entity nobody wrote can be stale, so none counts.
    expect(entityConflicts(space, "of:unwritten").readSetsNotKept).toBe(0);
    // `cf inspect commits` reads the counts from the digest.
    expect(
      listCommits(space).map(({ seq, reads }) => ({ seq, reads })),
    ).toEqual([
      { seq: 4, reads: 1 },
      { seq: 3, reads: 0 },
      { seq: 2, reads: 1 },
      { seq: 1, reads: 0 },
    ]);
  } finally {
    space.close();
    await Deno.remove(path);
  }
});

Deno.test("conflicts: counts an unchecked read of a write outside the selected scope", async () => {
  // 1 Alice (s1) writes X in her user scope. 2 Alice (s9) commits a read of
  // X in that scope at seq 0, missing write 1. 3 Bob writes X in the space
  // scope, which the inspector selects by default.
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-conf-" });
  const dbPath = `${dir}/space.sqlite`;
  const SA9 = "session:did%3Akey%3AzAlice:s9";
  try {
    {
      const { db, commit, setRev } = open(dbPath);
      setRev(commit(SA, []), "user:did%3Akey%3AzAlice");
      commit(SA9, [{ seq: 0, scope: "user" }]);
      setRev(commit(SB, []));
      db.close();
    }
    const read = () => {
      const space = openSpace(dbPath);
      try {
        return entityConflicts(space, X);
      } finally {
        space.close();
      }
    };
    expect(read().staleReads.map((r) => r.readerCommitSeq)).toEqual([2]);

    // The same reader commit, stored with a digest in place of its reads.
    const db = new Database(dbPath);
    try {
      const { original } = db.prepare(
        `SELECT original FROM "commit" WHERE seq = 2`,
      ).get<{ original: string }>()!;
      db.prepare(`UPDATE "commit" SET original = ? WHERE seq = 2`).run(
        encodeStoredCommit(JSON.parse(original) as ClientCommit, false),
      );
    } finally {
      db.close();
    }

    const digested = read();
    expect(digested.staleReads).toEqual([]);
    expect(digested.readSetsNotKept).toBe(1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("conflicts: counts commits compaction hollowed as unchecked", async () => {
  // As above: a read before of:x is first written, and one after, each
  // stored with a digest; then compaction hollows every payload but seq 1's.
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-conf-" });
  const store = `${dir}/store.sqlite`;
  const out = `${dir}/compacted.sqlite`;
  const engine = await openEngine({
    url: toFileUrl(store),
    storeReadsDigest: true,
  });
  const reading = (
    localSeq: number,
    id: string,
    seq: number,
    write: string,
  ): ClientCommit => ({
    localSeq,
    reads: {
      confirmed: [{ id, path: toDocumentPath(["value"]), seq }],
      pending: [],
    },
    operations: [{ op: "set", id: write, value: { value: localSeq } }],
  });
  const setting = (localSeq: number, id: string): ClientCommit => ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id, value: { value: localSeq } }],
  });
  try {
    applyCommit(engine, { sessionId: "s:a", commit: setting(1, "of:y") });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: reading(2, "of:y", 1, "of:z"),
    });
    applyCommit(engine, { sessionId: "s:b", commit: setting(1, "of:x") });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: reading(3, "of:x", 3, "of:w"),
    });
    // A second write to of:x, so compaction squashes its history into the
    // compaction commit.
    applyCommit(engine, { sessionId: "s:b", commit: setting(2, "of:x") });
  } finally {
    close(engine);
  }
  try {
    await compactStore({
      store,
      out,
      selection: { prefixes: ["of:"] },
      keepPayloadsMs: 0,
      runId: "hollow",
    });
    const space = openSpace(out);
    try {
      const hollowed = space.db.prepare(
        `SELECT seq, original FROM "commit" ORDER BY seq`,
      ).all<{ seq: number; original: string }>()
        .filter(({ original }) => isHollowedPayload(original))
        .map(({ seq }) => seq);
      expect(hollowed).toEqual([2, 3, 4, 5]);
      // Compaction left of:x's history no first write before its own
      // commit, so every hollowed commit may have read it.
      expect(entityConflicts(space, "of:x").readSetsNotKept).toBe(4);
      expect(readCoherence(space).readSetsNotKept).toBe(4);
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("conflicts: keeps the ACL document's first write when compaction only appends its audit revision", async () => {
  // A digest-storing engine: of:y written at 1, read at 2 (stored with a
  // digest), the ACL document first written at 3. A compaction run that
  // truncates nothing still writes the ACL document's audit revision, at 4.
  const SPACE = "did:key:z6MkInspectedSpace";
  const ACL = `of:${SPACE}`;
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-conf-" });
  const store = `${dir}/store.sqlite`;
  const out = `${dir}/compacted.sqlite`;
  const engine = await openEngine({
    url: toFileUrl(store),
    storeReadsDigest: true,
  });
  const commit = (
    localSeq: number,
    confirmed: ClientCommit["reads"]["confirmed"],
    id: string,
    value: number | Record<string, string>,
  ): ClientCommit => ({
    localSeq,
    reads: { confirmed, pending: [] },
    operations: [{ op: "set", id, value: { value } }],
  });
  try {
    applyCommit(engine, { sessionId: "s:a", commit: commit(1, [], "of:y", 1) });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(
        2,
        [{ id: "of:y", path: toDocumentPath(["value"]), seq: 1 }],
        "of:z",
        2,
      ),
    });
    applyCommit(engine, {
      sessionId: `session:${SPACE}:owner`,
      principal: SPACE,
      commit: commit(1, [], ACL, { [SPACE]: "OWNER" }),
    });
  } finally {
    close(engine);
  }
  try {
    const count = (path: string) => {
      const space = openSpace(path);
      try {
        return entityConflicts(space, ACL).readSetsNotKept;
      } finally {
        space.close();
      }
    };
    expect(count(store)).toBe(0);
    await compactStore({
      store,
      out,
      selection: { prefixes: ["computed:"] },
      runId: "audit-only",
    });
    const space = openSpace(out);
    try {
      expect(
        space.db.prepare(
          `SELECT seq, commit_seq FROM revision WHERE id = ? ORDER BY seq`,
        ).all(ACL),
      ).toEqual([{ seq: 3, commit_seq: 3 }, { seq: 4, commit_seq: 4 }]);
    } finally {
      space.close();
    }
    // Seq 2's read set is a digest, but it came before the ACL document's
    // first write, which compaction kept.
    expect(count(out)).toBe(0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
