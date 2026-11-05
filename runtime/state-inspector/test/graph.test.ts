// Hermetic test for the entity graph. Seeds a modern piece (patternIdentity →
// module, argument → input, internal → owned cell) plus a free cell, then checks
// nodes, the pattern/argument/owns edges, neighborhood restriction, and DOT.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { buildSpaceGraph, graphToDot, subgraphAround } from "../graph.ts";

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

const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

function link(id: string) {
  return { "/": { "link@1": { id, path: [] } } };
}

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );

  commit.run(1, 1);
  rev.run(
    "of:mod",
    1,
    JSON.stringify({
      value: {
        kind: "source",
        identity: MODULE_IDENTITY,
        code: "export default () => null;\n",
        filename: "/api/patterns/system/notes/notebook.tsx",
        imports: [],
      },
    }),
    1,
  );

  commit.run(2, 2);
  rev.run(
    "of:piece",
    2,
    JSON.stringify({
      value: { $NAME: "My Notebook", $UI: {}, link: link("of:owned") },
      argument: link("of:input"),
      internal: [
        { partialCause: "q", link: link("of:owned") },
        { partialCause: "d", link: link("of:gone") },
      ],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: { type: "object", properties: {}, $defs: {} },
    }),
    2,
  );

  commit.run(3, 3);
  rev.run("of:input", 3, JSON.stringify({ value: { title: "t" } }), 3);
  commit.run(4, 4);
  rev.run(
    "of:owned",
    4,
    JSON.stringify({ value: "hi", result: link("of:piece") }),
    4,
  );
  commit.run(5, 5);
  rev.run("of:free", 5, JSON.stringify({ value: "x" }), 5);

  // A tombstone the piece links to. The enumeration drops it, so the only way
  // an edge into it can be labeled is by resolving the target on demand.
  const op = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, ?, ?, ?)`,
  );
  commit.run(6, 6);
  op.run("of:gone", 6, "set", JSON.stringify({ value: 1 }), 6);
  commit.run(7, 7);
  op.run("of:gone", 7, "delete", null, 7);

  db.close();
}

Deno.test("entity graph: nodes, edges, neighborhood, dot", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-graph-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      const g = buildSpaceGraph(space);

      await t.step("nodes carry fluent kinds + labels", () => {
        const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
        assertEquals(byId["of:piece"].kind, "piece");
        assertEquals(byId["of:piece"].label, "My Notebook");
        assertEquals(byId["of:mod"].kind, "module");
        assertEquals(byId["of:owned"].kind, "owned-cell");
        assertEquals(byId["of:free"].kind, "free-cell");
      });

      await t.step("structural edges resolve", () => {
        const has = (from: string, to: string, kind: string) =>
          g.edges.some((e) =>
            e.from === from && e.to === to && e.kind === kind
          );
        // patternIdentity → module
        assert(has("of:piece", "of:mod", "pattern"));
        // argument → input cell
        assert(has("of:piece", "of:input", "argument"));
        // internal manifest → owned cell
        assert(has("of:piece", "of:owned", "owns"));
        // a data link in the value → its target
        assert(has("of:piece", "of:owned", "link"));
        assertEquals(g.stats.edgesByKind.pattern, 1);
        assertEquals(g.stats.edgesByKind.argument, 1);
      });

      await t.step("subgraphAround restricts to a neighborhood", () => {
        const sub = subgraphAround(g, "of:input", 1);
        const ids = new Set(sub.nodes.map((n) => n.id));
        // input is reached only from the piece (argument edge) → both present.
        assert(ids.has("of:input"));
        assert(ids.has("of:piece"));
        // the unrelated free cell is not within 1 hop of the input cell.
        assert(!ids.has("of:free"));
      });

      await t.step("an absent target says which kind of absent", () => {
        const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
        // `visibleEntityRows` drops tombstones, so this target is not among the
        // rows the graph walked: the stub resolved it on demand, and says
        // `deleted` rather than the "(absent)" every absent target once shared.
        assertEquals(byId["of:gone"].kind, "deleted");
        assertEquals(byId["of:gone"].label, "(deleted)");
        assertEquals(byId["of:gone"].present, false);
      });

      await t.step("graphToDot emits a digraph with the piece node", () => {
        const dot = graphToDot(g);
        assert(dot.startsWith("digraph space {"));
        assert(dot.includes("of:piece"));
        assert(dot.includes("My Notebook"));
        assert(dot.trimEnd().endsWith("}"));
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
