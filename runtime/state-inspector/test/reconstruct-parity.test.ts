// Parity harness: the inspector must reconstruct a (branch, seq) document
// IDENTICALLY to the real memory-v2 engine. Rather than assert against a
// hand-seeded fixture (which only proves the analyzer against our own
// assumptions), this drives the production engine to WRITE the DB, then opens it
// read-only and compares `reconstructDocument()` to `engine.read()` across the
// fidelity cases the reviews flagged: branch inheritance, child override, child
// delete tombstone, and patch-first reconstruction.

import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  createBranch,
  open,
  read,
} from "@commonfabric/memory/v2/engine";
import type { FabricValue } from "@commonfabric/api";

import { openSpace } from "../db.ts";
import { reconstructDocument } from "../reconstruct.ts";

const doc = (value: FabricValue) => ({ value });

function assertParity(
  path: string,
  id: string,
  branch: string,
  engineDoc: unknown,
) {
  const space = openSpace(path);
  try {
    const got = reconstructDocument(space, { id, branch }) ?? null;
    assertEquals(
      got,
      engineDoc,
      `reconstruct(${id}, branch=${
        JSON.stringify(branch)
      }) must match engine.read`,
    );
  } finally {
    space.close();
  }
}

Deno.test("reconstruct parity with memory-v2 engine", async (t) => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    // seq 1: set entity:shared on the default branch.
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "entity:shared", value: doc({ v: 1 }) }],
      },
    });

    // seq 2: a patch-first entity — its base revision is a patch, no prior set.
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:patchfirst",
          patches: [{ op: "add", path: "/value", value: { n: 1 } }],
        }],
      },
    });

    // Fork `feature` from the default branch at the current head.
    createBranch(engine, "feature", { parentBranch: "" });

    // On `feature`: write a child-only entity, override shared, leave a third
    // (entity:shared stays inherited until the override below).
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        branch: "feature",
        operations: [{
          op: "set",
          id: "entity:childonly",
          value: doc({ c: 1 }),
        }],
      },
    });

    await t.step("default-branch entity reconstructs identically", () => {
      assertParity(
        path,
        "entity:shared",
        "",
        read(engine, { id: "entity:shared" }),
      );
    });

    await t.step(
      "patch-first entity reconstructs (engine applies onto {})",
      () => {
        const e = read(engine, { id: "entity:patchfirst" });
        assertEquals(
          e,
          { value: { n: 1 } },
          "engine sanity: patch-first → {value:{n:1}}",
        );
        assertParity(path, "entity:patchfirst", "", e);
      },
    );

    await t.step("child branch INHERITS untouched parent entity", () => {
      const e = read(engine, { id: "entity:shared", branch: "feature" });
      assertEquals(
        e,
        { value: { v: 1 } },
        "engine sanity: feature inherits shared",
      );
      assertParity(path, "entity:shared", "feature", e);
    });

    await t.step("child-only entity is absent on the parent", () => {
      assertEquals(read(engine, { id: "entity:childonly" }), null);
      assertParity(path, "entity:childonly", "", null);
    });

    // A child-local PATCH on an inherited entity: the engine reconstructs it
    // within `feature` only (base = {} since feature has no own set), NOT onto
    // the inherited parent value. This is the case the prior log-merge got wrong.
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: 99,
        reads: { confirmed: [], pending: [] },
        branch: "feature",
        operations: [{
          op: "patch",
          id: "entity:patchonchild",
          patches: [{ op: "add", path: "/value", value: { child: 2 } }],
        }],
      },
    });
    // The same id, set on the PARENT before the fork would-be base — prove the
    // child patch does NOT inherit it.
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: 100,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:inheritedbase",
          value: doc({ parent: 1 }),
        }],
      },
    });
    createBranch(engine, "feat2", { parentBranch: "" });
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: 101,
        reads: { confirmed: [], pending: [] },
        branch: "feat2",
        operations: [{
          op: "patch",
          id: "entity:inheritedbase",
          patches: [{ op: "add", path: "/value/child", value: 2 }],
        }],
      },
    });

    await t.step(
      "child-local patch reconstructs within the child (not inherited base)",
      () => {
        const e = read(engine, { id: "entity:inheritedbase", branch: "feat2" });
        assertParity(path, "entity:inheritedbase", "feat2", e);
        // parent unaffected
        assertParity(
          path,
          "entity:inheritedbase",
          "",
          read(engine, { id: "entity:inheritedbase" }),
        );
      },
    );

    // seq 4: override shared on `feature`.
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        branch: "feature",
        operations: [{ op: "set", id: "entity:shared", value: doc({ v: 2 }) }],
      },
    });

    await t.step("child override diverges from inherited parent", () => {
      assertParity(
        path,
        "entity:shared",
        "feature",
        read(engine, { id: "entity:shared", branch: "feature" }),
      );
      assertParity(
        path,
        "entity:shared",
        "",
        read(engine, { id: "entity:shared" }),
      );
    });

    // seq 5: delete shared on `feature` (tombstone over an inherited base).
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        branch: "feature",
        operations: [{ op: "delete", id: "entity:shared" }],
      },
    });

    // Drive enough patches on ONE entity that the engine materializes a
    // `snapshot` row (interval = 10), so the inspector's snapshot-base path is
    // exercised — and assert parity at head AND at a mid-history seq.
    let ls = 200;
    applyCommit(engine, {
      sessionId: "session:p:s",
      commit: {
        localSeq: ++ls,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "entity:snap", value: doc({ n: 0 }) }],
      },
    });
    const snapSeqs: number[] = [];
    for (let i = 1; i <= 15; i++) {
      const applied = applyCommit(engine, {
        sessionId: "session:p:s",
        commit: {
          localSeq: ++ls,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:snap",
            patches: [{ op: "replace", path: "/value/n", value: i }],
          }],
        },
      });
      snapSeqs.push(applied.seq);
    }

    await t.step("snapshot-base reconstruction matches the engine", () => {
      // a `snapshot` row should now exist for this entity
      const space = openSpace(path);
      try {
        const hasSnap = space.db
          .prepare(
            "SELECT count(*) n FROM snapshot WHERE id = 'entity:snap'",
          )
          .get<{ n: number }>();
        assert(
          (hasSnap?.n ?? 0) > 0,
          "engine should have written a snapshot row",
        );
      } finally {
        space.close();
      }
      // head
      assertParity(
        path,
        "entity:snap",
        "",
        read(engine, { id: "entity:snap" }),
      );
      // a mid-history seq (after the snapshot, before head)
      const midSeq = snapSeqs[12];
      const space2 = openSpace(path);
      try {
        const got = reconstructDocument(space2, {
          id: "entity:snap",
          atSeq: midSeq,
        }) ?? null;
        assertEquals(got, read(engine, { id: "entity:snap", seq: midSeq }));
      } finally {
        space2.close();
      }
    });

    await t.step("child delete tombstones the inherited entity", () => {
      assertEquals(
        read(engine, { id: "entity:shared", branch: "feature" }),
        null,
      );
      assertParity(path, "entity:shared", "feature", null);
      // parent still sees its own value
      assertParity(
        path,
        "entity:shared",
        "",
        read(engine, { id: "entity:shared" }),
      );
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
