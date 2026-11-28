import { Database } from "@db/sqlite";
import { expect } from "@std/expect";

import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import { describe, it } from "@commonfabric/test-support/test";

import { openSpace, type SpaceDb } from "../db.ts";
import { reconstructOutcome } from "../reconstruct.ts";

/** One stored row of the parent branch, for the document the child inherits. */
type ParentRow = { op: string; data: string | null };

/**
 * Creates a store in which `child` holds one patch of `of:doc` and no base.
 * It forks from `parentBranch` at seq 2, or has no parent when that is `null`.
 * The default branch holds `parent` starting at seq 1.
 */
function inheritedFixture(
  parent: readonly ParentRow[],
  childPatch: Parameters<typeof encodeMemoryBoundary>[0],
  parentBranch: string | null = "",
): {
  /** Read-only store, closed when this fixture is disposed. */
  space: SpaceDb;

  /** Closes the reader and removes the disposable store. */
  [Symbol.dispose](): void;
} {
  const dir = Deno.makeTempDirSync({ prefix: "inspector-inherited-" });
  try {
    const path = `${dir}/space.sqlite`;
    const db = new Database(path);
    try {
      db.exec(`
        CREATE TABLE revision (
          branch TEXT, id TEXT, scope_key TEXT, seq INTEGER, op_index INTEGER,
          op TEXT, data TEXT, commit_seq INTEGER,
          PRIMARY KEY (branch, id, scope_key, seq, op_index)
        );
        CREATE TABLE branch (
          name TEXT PRIMARY KEY, parent_branch TEXT, fork_seq INTEGER
        );
        INSERT INTO branch VALUES ('', NULL, NULL);
      `);
      db.prepare("INSERT INTO branch VALUES ('child', ?, 2)").run(parentBranch);
      const row = db.prepare(
        "INSERT INTO revision VALUES (?, 'of:doc', 'space', ?, 0, ?, ?, ?)",
      );
      parent.forEach(({ op, data }, index) =>
        row.run("", index + 1, op, data, index + 1)
      );
      const childSeq = Math.max(3, parent.length + 1);
      row.run(
        "child",
        childSeq,
        "patch",
        encodeMemoryBoundary(childPatch),
        childSeq,
      );
    } finally {
      db.close();
    }
    const space = openSpace(path);
    return {
      space,
      [Symbol.dispose]() {
        space.close();
        Deno.removeSync(dir, { recursive: true });
      },
    };
  } catch (error) {
    Deno.removeSync(dir, { recursive: true });
    throw error;
  }
}

const set = (
  document: Parameters<typeof encodeMemoryBoundary>[0],
): ParentRow => ({
  op: "set",
  data: encodeMemoryBoundary(document),
});
const addChild = [{ op: "add", path: "/value/child", value: 2 }];
const read = { id: "of:doc", branch: "child" };

describe("reconstruct-inherited", () => {
  it("applies a branch's patch over the document its parent holds at the fork", () => {
    using fixture = inheritedFixture([
      set({ value: { parent: 1 } }),
      set({ value: { parent: 2 } }),
      set({ value: { parent: 99, afterFork: true } }),
    ], addChild);
    expect(reconstructOutcome(fixture.space, read)).toEqual({
      status: "present",
      document: { value: { parent: 2, child: 2 } },
    });
  });

  it("inherits a document the parent itself holds as patches", () => {
    using fixture = inheritedFixture([
      set({ value: { parent: 1 } }),
      {
        op: "patch",
        data: encodeMemoryBoundary([
          { op: "add", path: "/value/more", value: 3 },
        ]),
      },
    ], addChild);
    expect(reconstructOutcome(fixture.space, read)).toEqual({
      status: "present",
      document: { value: { parent: 1, more: 3, child: 2 } },
    });
  });

  it("inherits a document the parent created with a patch and no set", () => {
    using fixture = inheritedFixture([{
      op: "patch",
      data: encodeMemoryBoundary([
        { op: "add", path: "/value", value: { parent: 1 } },
      ]),
    }], addChild);

    expect(reconstructOutcome(fixture.space, read)).toEqual({
      status: "present",
      document: { value: { parent: 1, child: 2 } },
    });
  });

  it("starts from an empty document where the parent deleted the entity", () => {
    using fixture = inheritedFixture(
      [set({ value: { parent: 1 }, parentOnly: true }), {
        op: "delete",
        data: null,
      }],
      [{ op: "add", path: "/value", value: { child: 2 } }],
    );
    expect(reconstructOutcome(fixture.space, read)).toEqual({
      status: "present",
      document: { value: { child: 2 } },
    });
  });

  it("starts from an empty document where the parent has no revision of the entity", () => {
    using fixture = inheritedFixture([], [
      { op: "add", path: "/value", value: { child: 2 } },
    ]);

    expect(reconstructOutcome(fixture.space, read)).toEqual({
      status: "present",
      document: { value: { child: 2 } },
    });
  });

  it("starts from an empty document for a branch with no parent", () => {
    using fixture = inheritedFixture(
      [set({ value: { parent: 1 }, parentOnly: true })],
      [{ op: "add", path: "/value", value: { child: 2 } }],
      null,
    );

    expect(reconstructOutcome(fixture.space, read)).toEqual({
      status: "present",
      document: { value: { child: 2 } },
    });
  });

  it("starts from an empty document where the parent branch is absent", () => {
    using fixture = inheritedFixture(
      [set({ value: { parent: 1 }, parentOnly: true })],
      [{ op: "add", path: "/value", value: { child: 2 } }],
      "missing",
    );

    expect(reconstructOutcome(fixture.space, read)).toEqual({
      status: "present",
      document: { value: { child: 2 } },
    });
  });

  it("reports an inherited set that holds no payload as undecodable", () => {
    using fixture = inheritedFixture([{ op: "set", data: null }], addChild);
    expect(reconstructOutcome(fixture.space, read).status).toBe("undecodable");
  });

  it("reports an inherited set that does not decode as undecodable", () => {
    using fixture = inheritedFixture(
      [{ op: "set", data: "malformed" }],
      addChild,
    );
    expect(reconstructOutcome(fixture.space, read).status).toBe("undecodable");
  });
});
