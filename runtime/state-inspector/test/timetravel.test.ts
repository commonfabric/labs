// Hermetic test for time travel: structural value diff, entity diff across
// seqs, entity timeline (write-by-write), and space-growth timeline. Seeds an
// entity edited by a patch and another that is created then deleted.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Database } from "@db/sqlite";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";

import { openSpace } from "../db.ts";
import {
  diffEntity,
  diffValues,
  type EntityDiff,
  entityTimeline,
  spaceTimeline,
} from "../timetravel.ts";

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

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, ?, ?, ?)`,
  );

  const sparse = new Array(10);
  sparse[5] = "before";

  // commit 1: create A and E
  commit.run(1, "session:did:key:zX:u", 1);
  rev.run(
    "of:A",
    1,
    "set",
    jsonFromFabricValue({
      value: {
        count: 0,
        title: "a",
        "a/b": { "": 1 },
        a: { b: { "": 10 } },
        storedUndefined: undefined,
        removedUndefined: undefined,
        sparse,
      },
    }),
    1,
  );
  rev.run(
    "of:E",
    1,
    "set",
    jsonFromFabricValue({ value: { n: 1, m: 1 } }),
    1,
  );
  // commit 2: create B and encounter an invalid E patch
  commit.run(2, "session:did:key:zX:u", 2);
  rev.run("of:B", 2, "set", JSON.stringify({ value: { x: 1 } }), 2);
  rev.run("of:E", 2, "patch", "{", 2);
  // commit 3: patch A and E
  commit.run(3, "session:did:key:zX:u", 3);
  rev.run(
    "of:A",
    3,
    "patch",
    JSON.stringify([
      { op: "replace", path: "/value/count", value: 2 },
      { op: "replace", path: "/value/a~1b/", value: 2 },
      {
        op: "replace",
        path: "/value/storedUndefined",
        value: { $undefined: true },
      },
      { op: "remove", path: "/value/removedUndefined" },
      { op: "replace", path: "/value/sparse/5", value: "after" },
    ]),
    3,
  );
  rev.run(
    "of:E",
    3,
    "patch",
    JSON.stringify([
      { op: "replace", path: "/value/n", value: 2 },
      { op: "replace", path: "/value/m", value: 2 },
    ]),
    3,
  );
  // commit 4: delete B and restore E with a complete value
  commit.run(4, "session:did:key:zX:u", 4);
  rev.run("of:B", 4, "delete", null, 4);
  rev.run(
    "of:E",
    4,
    "set",
    jsonFromFabricValue({ value: { n: 10, m: 10 } }),
    4,
  );
  // commit 5: a patch after the set can be reconstructed
  commit.run(5, "session:did:key:zX:u", 5);
  rev.run(
    "of:E",
    5,
    "patch",
    JSON.stringify([{ op: "replace", path: "/value/n", value: 11 }]),
    5,
  );
  // commit 6: another invalid patch makes E unknown again
  commit.run(6, "session:did:key:zX:u", 6);
  rev.run("of:E", 6, "patch", "{", 6);
  // commit 7: a delete establishes the complete state
  commit.run(7, "session:did:key:zX:u", 7);
  rev.run("of:E", 7, "delete", null, 7);
  // commit 8: a patch after the delete starts from an empty document
  commit.run(8, "session:did:key:zX:u", 8);
  rev.run(
    "of:E",
    8,
    "patch",
    JSON.stringify([
      { op: "add", path: "/value", value: { afterDelete: true } },
    ]),
    8,
  );

  db.close();
}

Deno.test("time travel: diff + timelines", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-tt-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      await t.step("diffValues classifies add/remove/change", () => {
        const legacyShape: EntityDiff = {
          id: "of:legacy",
          fromSeq: 1,
          toSeq: 2,
          fromExists: true,
          toExists: true,
          changes: [{ path: "value/count", kind: "changed" }],
        };
        assertEquals(legacyShape.changes[0].path, "value/count");

        const changes = diffValues(
          { a: 1, b: 2, list: [1, 2] },
          { a: 1, b: 3, c: 9, list: [1, 5] },
        );
        assertEquals(
          changes.map((change) => ({
            path: change.path,
            pathSegments: change.pathSegments,
            kind: change.kind,
          })),
          [
            { path: "b", pathSegments: ["b"], kind: "changed" },
            {
              path: "list/1",
              pathSegments: ["list", "1"],
              kind: "changed",
            },
            { path: "c", pathSegments: ["c"], kind: "added" },
          ],
        );
      });

      await t.step("diffValues preserves ambiguous path segments", () => {
        const changes = diffValues(
          { "a/b": 1, a: { b: 1 }, "": 1 },
          { "a/b": 2, a: { b: 2 }, "": 2 },
        );
        assertEquals(changes.map((change) => change.pathSegments), [
          ["a/b"],
          ["a", "b"],
          [""],
        ]);
        assertEquals(changes.map((change) => change.path), ["a/b", "a/b", ""]);
        assertEquals(
          diffValues(1, 2, ["a/b", ""])[0].pathSegments,
          ["a/b", ""],
        );
      });

      await t.step("diffValues preserves property and array presence", () => {
        assertEquals(diffValues({}, {}, [], 0), []);
        assertEquals(
          diffValues({ child: {} }, { child: {} }, [], 1),
          [],
        );
        assertEquals(diffValues({}, { toString: 1 }), [{
          path: "toString",
          pathSegments: ["toString"],
          kind: "added",
          after: 1,
        }]);
        assertEquals(diffValues({ valueOf: 1 }, {}), [{
          path: "valueOf",
          pathSegments: ["valueOf"],
          kind: "removed",
          before: 1,
        }]);
        assertEquals(diffValues({ stored: undefined }, {}), [{
          path: "stored",
          pathSegments: ["stored"],
          kind: "removed",
          before: { $undefined: true },
          beforeIsUndefined: true,
        }]);
        assertEquals(diffValues(1n, { $bigint: "1" }), [{
          path: "",
          pathSegments: [],
          kind: "changed",
          before: { $bigint: "1" },
          after: { $bigint: "1" },
          annotationCollision: true,
          beforeValueKind: "bigint",
          afterValueKind: "object",
        }]);
        assertEquals(diffValues({ $stream: true }, "$stream"), [{
          path: "",
          pathSegments: [],
          kind: "changed",
          before: "$stream",
          after: "$stream",
          annotationCollision: true,
          beforeValueKind: "stream",
          afterValueKind: "string",
        }]);
        assertEquals(
          diffValues(
            { nested: undefined },
            { nested: { $undefined: true } },
            [],
            0,
          ),
          [{
            path: "",
            pathSegments: [],
            kind: "changed",
            before: { nested: { $undefined: true } },
            after: { nested: { $undefined: true } },
            annotationCollision: true,
            beforeValueKind: "object",
            afterValueKind: "object",
          }],
        );

        const sparseBefore = new Array(1_000_000_000);
        const sparseAfter = new Array(1_000_000_001);
        const sparseChanges = diffValues(sparseBefore, sparseAfter);
        assertEquals(sparseChanges, [{
          path: "",
          pathSegments: [],
          kind: "changed",
          before: {
            $sparseArray: { length: 1_000_000_000, entries: {} },
          },
          after: {
            $sparseArray: { length: 1_000_000_001, entries: {} },
          },
        }]);
        assertEquals(
          JSON.stringify(sparseChanges).includes("null"),
          false,
        );

        const nestedBefore = new Array(1_000_000_000);
        const nestedAfter = new Array(1_000_000_000);
        nestedBefore[5] = undefined;
        nestedAfter[5] = undefined;
        assertEquals(
          diffValues({ items: nestedBefore }, { items: nestedAfter }),
          [],
        );

        const changedNestedBefore = new Array(1_000_000_000);
        const changedNestedAfter = new Array(1_000_000_000);
        changedNestedBefore[5] = "before";
        changedNestedAfter[5] = "after";
        assertEquals(
          diffValues(
            { items: changedNestedBefore },
            { items: changedNestedAfter },
          ),
          [{
            path: "items/5",
            pathSegments: ["items", "5"],
            kind: "changed",
            before: "before",
            after: "after",
          }],
        );
      });

      await t.step(
        "diffValues tells an array's holes from its elements",
        () => {
          assertEquals(diffValues({ a: [1, , 3] }, { a: [1, 2, 3] }), [{
            path: "a/1",
            pathSegments: ["a", "1"],
            kind: "added",
            after: 2,
          }]);
          assertEquals(diffValues({ a: [1, , 3] }, { a: [1, 2, ,] }), [
            { path: "a/1", pathSegments: ["a", "1"], kind: "added", after: 2 },
            {
              path: "a/2",
              pathSegments: ["a", "2"],
              kind: "removed",
              before: 3,
            },
          ]);
        },
      );

      await t.step("diffEntity across seqs shows the changed leaf", () => {
        // Default diffs the value; change paths are value-relative.
        const d = diffEntity(space, { id: "of:A", fromSeq: 1, toSeq: 3 });
        assert(d.fromExists && d.toExists);
        const c = d.changes.find((x) =>
          x.pathSegments.length === 1 && x.pathSegments[0] === "count"
        );
        assert(c, "expected value.count to change");
        assertEquals(c!.kind, "changed");
        assertEquals(c!.after, 2);
        // With --doc, paths are document-relative.
        const dd = diffEntity(space, {
          id: "of:A",
          fromSeq: 1,
          toSeq: 3,
          doc: true,
        });
        assert(
          dd.changes.some((x) =>
            x.pathSegments.length === 2 && x.pathSegments[0] === "value" &&
            x.pathSegments[1] === "count"
          ),
        );
        assertThrows(
          () =>
            diffEntity(space, {
              id: "of:A",
              doc: true,
              path: [],
            }),
          Error,
          "cannot be used together",
        );

        const exact = diffEntity(space, {
          id: "of:A",
          fromSeq: 1,
          toSeq: 3,
          path: ["a/b", ""],
        });
        assertEquals(exact.changes, [{
          path: "",
          pathSegments: [],
          kind: "changed",
          before: 1,
          after: 2,
        }]);

        const removedUndefined = diffEntity(space, {
          id: "of:A",
          fromSeq: 1,
          toSeq: 3,
          path: ["removedUndefined"],
        });
        assertEquals(removedUndefined.changes, [{
          path: "",
          pathSegments: [],
          kind: "removed",
          before: { $undefined: true },
          beforeIsUndefined: true,
        }]);

        const collision = diffEntity(space, {
          id: "of:A",
          fromSeq: 1,
          toSeq: 3,
          path: ["storedUndefined"],
        });
        assertEquals(collision.changes, [{
          path: "",
          pathSegments: [],
          kind: "changed",
          before: { $undefined: true },
          beforeIsUndefined: true,
          after: { $undefined: true },
          annotationCollision: true,
          beforeValueKind: "undefined",
          afterValueKind: "object",
        }]);

        const sparse = diffEntity(space, {
          id: "of:A",
          fromSeq: 1,
          toSeq: 3,
          path: ["sparse"],
        });
        assertEquals(sparse.changes, [{
          path: "5",
          pathSegments: ["5"],
          kind: "changed",
          before: "before",
          after: "after",
        }]);
      });

      await t.step("diffEntity birth→latest reports creation", () => {
        const d = diffEntity(space, { id: "of:A" });
        assertEquals(d.fromExists, false);
        assertEquals(d.toExists, true);
        assert(d.changes.length > 0);
      });

      await t.step("diffEntity captures a deletion", () => {
        const d = diffEntity(space, { id: "of:B", fromSeq: 2, toSeq: 4 });
        assertEquals(d.fromExists, true);
        assertEquals(d.toExists, false);
      });

      await t.step("diffEntity propagates reconstruction errors", () => {
        assertThrows(
          () =>
            diffEntity(space, {
              id: "of:E",
              fromSeq: 1,
              toSeq: 2,
            }),
          SyntaxError,
        );
        assertThrows(
          () =>
            diffEntity(space, {
              id: "of:E",
              fromSeq: 2,
              toSeq: 4,
            }),
          SyntaxError,
        );
      });

      await t.step("entityTimeline lists each write with change counts", () => {
        const steps = entityTimeline(space, { id: "of:A" });
        assertEquals(steps.length, 2);
        assertEquals(steps[0].op, "set");
        assertEquals(steps[1].op, "patch");
        // The patch changed count, the empty key below "a/b", both
        // undefined-valued properties, and the sparse array entry.
        assertEquals(steps[1].changes, 5);
      });

      await t.step("entityTimeline keeps state unknown until recovery", () => {
        const steps = entityTimeline(space, { id: "of:E" });
        assertEquals(steps.length, 8);
        assertEquals(steps[0].changes, 1);
        assertEquals(steps[1].changes, 0);
        assertEquals(steps[1].changesKnown, false);
        assertEquals(steps[1].stateKnown, false);
        assert(typeof steps[1].error === "string" && steps[1].error.length > 0);

        assertEquals(steps[2].changes, 0);
        assertEquals(steps[2].changesKnown, false);
        assertEquals(steps[2].stateKnown, false);
        assert(typeof steps[2].error === "string" && steps[2].error.length > 0);

        assertEquals(steps[3].exists, true);
        assertEquals(steps[3].changes, 0);
        assertEquals(steps[3].changesKnown, false);
        assertEquals(steps[3].stateKnown, undefined);
        assertEquals(steps[4].changes, 1);
        assertEquals(steps[4].changesKnown, undefined);

        assertEquals(steps[5].stateKnown, false);
        assertEquals(steps[6].exists, false);
        assertEquals(steps[6].changesKnown, false);
        assertEquals(steps[6].stateKnown, undefined);
        assertEquals(steps[7].exists, true);
        assertEquals(steps[7].changes, 1);
        assertEquals(steps[7].changesKnown, undefined);
      });

      await t.step("spaceTimeline tracks created + cumulative growth", () => {
        const t1 = spaceTimeline(space);
        assertEquals(t1.length, 8);
        assertEquals(t1[0].created, 2); // A and E
        assertEquals(t1[1].created, 1); // B
        assertEquals(t1[2].created, 0); // patch A
        assertEquals(t1[3].created, 0); // delete B and set E
        assertEquals(t1[7].created, 0); // patch E after its delete
        assertEquals(t1[7].cumulativeEntities, 3);
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
