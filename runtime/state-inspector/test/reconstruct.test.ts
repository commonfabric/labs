// Hermetic test: build a tiny space DB in a temp dir matching the memory v2
// schema, then exercise the read-only inspector against it. Side-effect free —
// the temp dir is removed in finally.
//
// Patch coverage intentionally includes the server dialect's `splice` op and
// `add`-creates-missing-key semantics, since reconstruction reuses the server's
// applier (`@commonfabric/memory/v2/patch`). A naive RFC-6902 applier would drop
// the splice and fail the nested add — these steps guard against regressing to
// a hand-rolled fork.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { annotate, parseSigilLink } from "../decode.ts";
import {
  getValueAt,
  reconstructDocument,
  reconstructOutcome,
} from "../reconstruct.ts";
import {
  entityHistory,
  hotEntities,
  listCommits,
  summarizeSpace,
} from "../queries.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY,
  branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  local_seq INTEGER NOT NULL,
  invocation_ref TEXT,
  authorization_ref TEXT,
  original JSON NOT NULL,
  resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space',
  seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL,
  op TEXT NOT NULL,
  data JSON,
  commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY,
  parent_branch TEXT,
  fork_seq INTEGER,
  created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq) VALUES ('', 8);
`;

const LINK = {
  "/": { "link@1": { id: "of:other", space: "did:key:zABC", path: [] } },
};

function seedDb(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);

  const commit = db.prepare(
    `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
     VALUES (?, '', ?, ?, ?, ?)`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES ('', ?, 'space', ?, 0, ?, ?, ?)`,
  );

  const mkOriginal = (ops: number) =>
    JSON.stringify({
      localSeq: ops,
      reads: { confirmed: [], pending: [] },
      operations: new Array(ops).fill({}),
    });

  // seq1: set A
  commit.run(1, "session-alice", 1, mkOriginal(1), JSON.stringify({ seq: 1 }));
  rev.run(
    "of:A",
    1,
    "set",
    JSON.stringify({ value: { count: 1, link: LINK } }),
    1,
  );
  // seq2: set B
  commit.run(2, "session-bob", 1, mkOriginal(1), JSON.stringify({ seq: 2 }));
  rev.run("of:B", 2, "set", JSON.stringify({ value: { x: true } }), 2);
  // seq3: patch A.count -> 2
  commit.run(3, "session-alice", 2, mkOriginal(1), JSON.stringify({ seq: 3 }));
  rev.run(
    "of:A",
    3,
    "patch",
    JSON.stringify([{ op: "replace", path: "/value/count", value: 2 }]),
    3,
  );
  // seq4: delete B
  commit.run(4, "session-bob", 2, mkOriginal(1), JSON.stringify({ seq: 4 }));
  rev.run("of:B", 4, "delete", null, 4);
  // seq5: set C with an array
  commit.run(5, "session-carol", 1, mkOriginal(1), JSON.stringify({ seq: 5 }));
  rev.run(
    "of:C",
    5,
    "set",
    JSON.stringify({ value: { list: [10, 20, 30] } }),
    5,
  );
  // seq6: splice C.list at index 1, remove 1, add [99, 98]  ->  [10, 99, 98, 30]
  commit.run(6, "session-carol", 2, mkOriginal(1), JSON.stringify({ seq: 6 }));
  rev.run(
    "of:C",
    6,
    "patch",
    JSON.stringify([{
      op: "splice",
      path: "/value/list",
      index: 1,
      remove: 1,
      add: [99, 98],
    }]),
    6,
  );
  // seq7: set D empty value
  commit.run(7, "session-carol", 3, mkOriginal(1), JSON.stringify({ seq: 7 }));
  rev.run("of:D", 7, "set", JSON.stringify({ value: {} }), 7);
  // seq8: add D.profile (creates the missing key)
  commit.run(8, "session-carol", 4, mkOriginal(1), JSON.stringify({ seq: 8 }));
  rev.run(
    "of:D",
    8,
    "patch",
    JSON.stringify([{
      op: "add",
      path: "/value/profile",
      value: { name: "x" },
    }]),
    8,
  );

  db.close();
}

Deno.test("state-inspector autopsy core", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-test-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seedDb(dbPath);
    const space = openSpace(dbPath);
    try {
      await t.step("reconstruct at seq replays set then patch", () => {
        assertEquals(
          getValueAt(space, { id: "of:A", atSeq: 1 }, ["count"]).value,
          1,
        );
        assertEquals(
          getValueAt(space, { id: "of:A", atSeq: 2 }, ["count"]).value,
          1,
        );
        assertEquals(
          getValueAt(space, { id: "of:A", atSeq: 3 }, ["count"]).value,
          2,
        );
        // latest (no seq) sees the patch
        assertEquals(getValueAt(space, { id: "of:A" }, ["count"]).value, 2);
      });

      await t.step("delete tombstones the entity", () => {
        assert(getValueAt(space, { id: "of:B", atSeq: 2 }).exists);
        assertEquals(getValueAt(space, { id: "of:B", atSeq: 4 }).exists, false);
      });

      await t.step("server splice op is applied (not dropped)", () => {
        assertEquals(
          getValueAt(space, { id: "of:C", atSeq: 5 }, ["list"]).value,
          [10, 20, 30],
        );
        assertEquals(getValueAt(space, { id: "of:C" }, ["list"]).value, [
          10,
          99,
          98,
          30,
        ]);
      });

      await t.step("add creates a missing object key", () => {
        assertEquals(
          getValueAt(space, { id: "of:D", atSeq: 7 }, ["profile"]).value,
          undefined,
        );
        assertEquals(
          getValueAt(space, { id: "of:D" }, ["profile", "name"]).value,
          "x",
        );
      });

      await t.step("links are recognized and annotated", () => {
        const res = getValueAt(space, { id: "of:A" }, ["link"]);
        const link = parseSigilLink(res.value);
        assert(link, "expected a sigil link");
        assertEquals(link.id, "of:other");
        assertEquals(link.space, "did:key:zABC");
        const ann = annotate(res.value) as { $link: { id: string } };
        assertEquals(ann.$link.id, "of:other");
      });

      await t.step("absent entity reconstructs to undefined", () => {
        assertEquals(
          reconstructDocument(space, { id: "of:missing" }),
          undefined,
        );
      });

      await t.step("an outcome names why there is no document", () => {
        // `reconstructDocument` answers "no document" for both of these; only
        // the outcome separates a deletion from an entity that was never here.
        assertEquals(
          reconstructOutcome(space, { id: "of:B" }).status,
          "deleted",
        );
        assertEquals(
          reconstructOutcome(space, { id: "of:missing" }).status,
          "absent",
        );
        const live = reconstructOutcome(space, { id: "of:B", atSeq: 2 });
        assertEquals(live.status, "present");
        assert(live.status === "present");
        assertEquals(live.document.value, { x: true });
      });

      await t.step("summary counts match the seed", () => {
        const s = summarizeSpace(space);
        assertEquals(s.commits, 8);
        assertEquals(s.sessions, 3);
        assertEquals(s.entities, 4);
        assertEquals(s.revisions, 8);
        assertEquals(s.ops, { set: 4, patch: 3, delete: 1 });
        assertEquals(s.hasSchedulerBasisTable, false);
      });

      await t.step("commits and history list the right rows", () => {
        assertEquals(listCommits(space).length, 8);
        assertEquals(
          listCommits(space, { session: "session-alice" }).length,
          2,
        );
        const histA = entityHistory(space, { id: "of:A" });
        assertEquals(histA.map((h) => h.op), ["set", "patch"]);
        const hot = hotEntities(space);
        assertEquals(hot.find((h) => h.id === "of:A")?.writes, 2);
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Every boundary a reconstruction crosses is a place corruption can be laundered
 * into a document that looks current. A malformed base, snapshot, or patch is
 * rejected by memory-v2 at the boundary it appears on — never absorbed and built
 * over — so reconstruction has to reach the same verdict rather than reporting a
 * document no read from the engine can produce.
 */
const BOUNDARY_SCHEMA = `
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
CREATE TABLE snapshot (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  value JSON NOT NULL, PRIMARY KEY (branch, id, scope_key, seq)
);
`;

Deno.test("a malformed boundary is not laundered by a later valid one", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-boundary-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    const db = new Database(dbPath, { create: true });
    db.exec(BOUNDARY_SCHEMA);
    const commit = db.prepare(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
       VALUES (?, 'sess', ?, '{}', '{}')`,
    );
    const rev = db.prepare(
      `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
       VALUES (?, ?, 0, ?, ?, ?)`,
    );
    const snap = db.prepare(
      `INSERT INTO snapshot (id, seq, value) VALUES (?, ?, ?)`,
    );
    const setRoot = (value: unknown) =>
      JSON.stringify([{ op: "replace", path: "", value }]);

    // A snapshot that is not a document, then a patch replacing the root with
    // one. The snapshot is the base, so reading it unchecked yields a document.
    commit.run(1, 1);
    rev.run("of:snap", 1, "set", JSON.stringify({ value: { n: 0 } }), 1);
    snap.run("of:snap", 2, "[]");
    commit.run(2, 2);
    commit.run(3, 3);
    rev.run("of:snap", 3, "patch", setRoot({ value: { n: 1 } }), 3);

    // A patch replacing the root with a scalar, then one restoring an object.
    // Only the intermediate step is invalid, so checking the final result alone
    // reports this current.
    commit.run(4, 4);
    rev.run("of:mid", 4, "set", JSON.stringify({ value: { n: 0 } }), 4);
    commit.run(5, 5);
    rev.run("of:mid", 5, "patch", setRoot(0), 5);
    commit.run(6, 6);
    rev.run("of:mid", 6, "patch", setRoot({ value: { n: 2 } }), 6);

    // The same chain with every boundary valid still reconstructs.
    commit.run(7, 7);
    rev.run("of:ok", 7, "set", JSON.stringify({ value: { n: 0 } }), 7);
    commit.run(8, 8);
    rev.run("of:ok", 8, "patch", setRoot({ value: { n: 3 } }), 8);
    db.close();

    const space = openSpace(dbPath);
    try {
      await t.step("a snapshot that is not a document is rejected", () => {
        assertEquals(
          reconstructOutcome(space, { id: "of:snap" }).status,
          "undecodable",
        );
      });

      await t.step("a patch leaving a non-document is rejected", () => {
        assertEquals(
          reconstructOutcome(space, { id: "of:mid" }).status,
          "undecodable",
        );
      });

      await t.step("a chain whose every boundary holds reconstructs", () => {
        const ok = reconstructOutcome(space, { id: "of:ok" });
        assertEquals(ok.status, "present");
        assert(ok.status === "present");
        assertEquals(ok.document.value, { n: 3 });
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("getValueAt reports a document that holds no value", async () => {
  // A stored document is a tree of top-level paths, and `value` is only one
  // of them: a document holding, say, only `source` exists, and has no path
  // under `value` to select.
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-no-value-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    const db = new Database(dbPath, { create: true });
    db.exec(`
CREATE TABLE "commit" (seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL, original JSON NOT NULL,
  resolution JSON NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE revision (branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL, op_index INTEGER NOT NULL,
  op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index));
INSERT INTO "commit" (seq, session_id, local_seq, original, resolution) VALUES (1, 's', 1, '{}', '{}');
INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
  VALUES ('of:sourced', 1, 0, 'set', '{"source":{"/":{"link@1":{"id":"of:origin","path":[]}}}}', 1);`);
    db.close();
    const space = openSpace(dbPath);
    try {
      const result = getValueAt(space, { id: "of:sourced" }, ["anything"]);
      assertEquals(result.exists, true);
      assertEquals(result.pathExists, false);
      assertEquals(result.value, undefined);
      assert(result.document !== undefined && "source" in result.document);
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
