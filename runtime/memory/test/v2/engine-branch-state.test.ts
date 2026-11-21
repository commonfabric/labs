import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import type { BranchName } from "../../v2.ts";
import {
  applyCommit,
  close,
  createBranch,
  deleteBranch,
  type Engine,
  headSeq,
  open,
  read,
  runAtomicCommit,
} from "../../v2/engine.ts";

describe("engine", () => {
  // Each read resolves its branch before it reads the document, and the
  // engine keeps what it learned of each branch between reads. These cases
  // pin what a read returns and throws as the `branch` table changes under
  // it, through this connection and another one, and how many statements a
  // read of a known branch costs.

  let engine: Engine;
  let path: string;
  let localSeq: number;
  const sessionId = "session:branch-state";
  const id = "of:branch-state";

  const setValue = (value: string, branch?: BranchName): number =>
    applyCommit(engine, {
      sessionId,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value } }],
        ...(branch === undefined ? {} : { branch }),
      },
    }).seq;

  const valueAt = (options: { branch?: BranchName; seq?: number } = {}) =>
    read(engine, { id, ...options })?.value;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  describe("read()", () => {
    it("returns the value at the head and the value as of an older seq", () => {
      const first = setValue("first");
      const second = setValue("second");

      expect(headSeq(engine)).toBe(second);
      expect(valueAt()).toBe("second");
      expect(valueAt({ seq: first })).toBe("first");
    });

    it("returns the value a fork inherits from its parent as of the fork point", () => {
      setValue("before fork");
      createBranch(engine, "fork");
      setValue("after fork");

      expect(valueAt({ branch: "fork" })).toBe("before fork");
      expect(valueAt()).toBe("after fork");
    });

    it("returns a fork's own value over the one it inherits", () => {
      setValue("parent");
      createBranch(engine, "fork");
      setValue("fork", "fork");

      expect(valueAt({ branch: "fork" })).toBe("fork");
      expect(valueAt()).toBe("parent");
    });

    it("throws for an unknown branch, and reads the branch once it exists", () => {
      setValue("parent");

      expect(() => valueAt({ branch: "later" })).toThrow(
        "unknown branch: later",
      );
      createBranch(engine, "later");
      expect(valueAt({ branch: "later" })).toBe("parent");
    });

    it("throws for a seq past the head", () => {
      const seq = setValue("only");

      expect(() => valueAt({ seq: seq + 1 })).toThrow(
        `seq ${seq + 1} is out of range for branch `,
      );
    });

    it("throws for a seq before a fork was created", () => {
      const before = setValue("first");
      setValue("second");
      createBranch(engine, "fork");

      expect(() => valueAt({ branch: "fork", seq: before })).toThrow(
        `seq ${before} is out of range for branch fork`,
      );
    });

    it("returns the value each commit writes as the head advances", () => {
      for (const value of ["one", "two", "three"]) {
        const seq = setValue(value);
        expect(headSeq(engine)).toBe(seq);
        expect(valueAt()).toBe(value);
      }
    });
  });

  describe("rollback", () => {
    it("returns the head a rolled-back commit would have advanced past", () => {
      const committed = setValue("committed");
      expect(valueAt()).toBe("committed");

      let headInside: number | undefined;
      expect(() =>
        runAtomicCommit(engine, (apply) => {
          apply({
            sessionId,
            commit: {
              localSeq: ++localSeq,
              reads: { confirmed: [], pending: [] },
              operations: [{ op: "set", id, value: { value: "rolled back" } }],
            },
          });
          headInside = headSeq(engine);
          throw new Error("abandon the commit");
        })
      ).toThrow("abandon the commit");

      expect(headInside).toBe(committed + 1);
      expect(headSeq(engine)).toBe(committed);
      expect(valueAt()).toBe("committed");
      expect(() => valueAt({ seq: committed + 1 })).toThrow(
        `seq ${committed + 1} is out of range for branch `,
      );
    });

    it("throws for a branch whose creation rolled back", () => {
      setValue("parent");

      expect(() =>
        engine.database.transaction(() => {
          createBranch(engine, "fork");
          expect(valueAt({ branch: "fork" })).toBe("parent");
          throw new Error("abandon the branch");
        })()
      ).toThrow("abandon the branch");

      expect(() => valueAt({ branch: "fork" })).toThrow(
        "unknown branch: fork",
      );
    });

    it("keeps an outer transaction's branch when a savepoint inside it rolls back", () => {
      setValue("parent");

      engine.database.transaction(() => {
        createBranch(engine, "kept");
        expect(() =>
          engine.database.transaction(() => {
            createBranch(engine, "dropped");
            expect(valueAt({ branch: "dropped" })).toBe("parent");
            throw new Error("abandon the savepoint");
          })()
        ).toThrow("abandon the savepoint");
        expect(() => valueAt({ branch: "dropped" })).toThrow(
          "unknown branch: dropped",
        );
      })();

      expect(valueAt({ branch: "kept" })).toBe("parent");
      expect(() => valueAt({ branch: "dropped" })).toThrow(
        "unknown branch: dropped",
      );
    });
  });

  describe("deleteBranch()", () => {
    it("makes a commit to a branch read before its deletion throw", () => {
      setValue("parent");
      createBranch(engine, "fork");
      setValue("fork", "fork");
      expect(valueAt({ branch: "fork" })).toBe("fork");

      deleteBranch(engine, "fork");

      expect(() => setValue("after delete", "fork")).toThrow(
        "branch is not active: fork",
      );
    });
  });

  describe("statements per read", () => {
    it("reads no `branch` row for a read of a branch already read", () => {
      setValue("warm");
      expect(valueAt()).toBe("warm");

      using branchRows = spy(engine.statement("selectBranch"), "get");
      using documentRows = spy(engine.statement("selectCurrentLocal"), "get");
      expect(valueAt()).toBe("warm");

      expect(branchRows.calls).toHaveLength(0);
      expect(documentRows.calls).toHaveLength(1);
    });

    it("reads no `branch` row for a read at the head after a commit", () => {
      setValue("first");
      expect(valueAt()).toBe("first");
      setValue("second");

      using branchRows = spy(engine.statement("selectBranch"), "get");
      expect(valueAt()).toBe("second");

      expect(branchRows.calls).toHaveLength(0);
    });

    it("reads the `branch` row once for reads at a seq past the head it knew", () => {
      setValue("first");
      expect(valueAt()).toBe("first");
      const second = setValue("second");

      using branchRows = spy(engine.statement("selectBranch"), "get");
      expect(valueAt({ seq: second })).toBe("second");
      expect(valueAt({ seq: second })).toBe("second");

      expect(branchRows.calls).toHaveLength(1);
    });

    it("reads no `head` row for a read at a seq, even the head's", () => {
      // Another connection's commit between two statements of one read
      // moves the `head` table, so a read at a seq reads the revision rows
      // as of that seq.
      setValue("first");
      const second = setValue("second");
      expect(valueAt()).toBe("second");

      using headRows = spy(engine.statement("selectCurrentLocal"), "get");
      expect(valueAt({ seq: second })).toBe("second");

      expect(headRows.calls).toHaveLength(0);
    });

    it("reads no `branch` row for a warm read a fork inherits", () => {
      setValue("parent");
      createBranch(engine, "fork");
      expect(valueAt({ branch: "fork" })).toBe("parent");

      using branchRows = spy(engine.statement("selectBranch"), "get");
      expect(valueAt({ branch: "fork" })).toBe("parent");

      expect(branchRows.calls).toHaveLength(0);
    });
  });

  describe("another connection", () => {
    // The serving loop's worker and the memory server beside it are two
    // connections to one store, each committing what the other then reads.

    let other: Engine;

    const otherValueAt = (
      options: { branch?: BranchName; seq?: number } = {},
    ) => read(other, { id, ...options })?.value;

    beforeEach(async () => {
      other = await open({ url: toFileUrl(path) });
    });

    afterEach(() => {
      close(other);
    });

    it("returns the value as of a seq the other's commit passed, and the value at the new head", () => {
      const first = setValue("first");
      expect(otherValueAt()).toBe("first");
      const second = setValue("second");

      expect(otherValueAt({ seq: first })).toBe("first");
      expect(otherValueAt({ seq: second })).toBe("second");
      expect(otherValueAt()).toBe("second");
      expect(() => otherValueAt({ seq: second + 1 })).toThrow(
        `seq ${second + 1} is out of range for branch `,
      );
    });

    it("throws for a branch until the other creates it, then returns its parent's value as of the fork point", () => {
      setValue("before the other read");
      expect(otherValueAt()).toBe("before the other read");
      expect(() => otherValueAt({ branch: "fork" })).toThrow(
        "unknown branch: fork",
      );
      setValue("at the fork point");
      createBranch(engine, "fork");
      setValue("after the fork");

      expect(otherValueAt({ branch: "fork" })).toBe("at the fork point");
      expect(otherValueAt()).toBe("after the fork");
    });
  });
});
