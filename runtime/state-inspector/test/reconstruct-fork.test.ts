/**
 * Compares offline fork reconstruction with the engine that wrote the store,
 * including exact revision reads and the bases that stop inheritance.
 */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type { Operation } from "@commonfabric/memory/v2";
import {
  applyCommit,
  close,
  createBranch,
  open,
  read,
  readRevision,
} from "@commonfabric/memory/v2/engine";

import { openSpace } from "../db.ts";
import { reconstructDocument, reconstructRevision } from "../reconstruct.ts";

/** Constructs a temporary engine and removes its store when disposed. */
async function fixture() {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  let localSeq = 0;
  return {
    engine,
    path,
    commit(branch: string, operations: Operation[]) {
      return applyCommit(engine, {
        sessionId: "session:p:s",
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          branch,
          operations,
        },
      });
    },
    async [Symbol.asyncDispose]() {
      close(engine);
      await Deno.remove(path);
    },
  };
}

describe("reconstruct", () => {
  describe("reconstructDocument()", () => {
    it("inherits patches through nested forks at each fork's cut", async () => {
      await using f = await fixture();
      const id = "entity:forked";
      f.commit("", [{ op: "set", id, value: { value: { parent: 1 } } }]);
      createBranch(f.engine, "child", { parentBranch: "" });
      f.commit("child", [{
        op: "patch",
        id,
        patches: [{ op: "add", path: "/value/child", value: 2 }],
      }]);
      createBranch(f.engine, "grandchild", { parentBranch: "child" });
      f.commit("", [{ op: "set", id, value: { value: { parent: 9 } } }]);
      f.commit("child", [{
        op: "patch",
        id,
        patches: [{ op: "replace", path: "/value/child", value: 9 }],
      }]);
      const applied = f.commit("grandchild", [
        {
          op: "patch",
          id,
          patches: [{ op: "add", path: "/value/first", value: 3 }],
        },
        {
          op: "patch",
          id,
          patches: [{ op: "add", path: "/value/second", value: 4 }],
        },
      ]);
      const space = openSpace(f.path);
      try {
        expect(read(f.engine, { id, branch: "grandchild" })).toEqual({
          value: { parent: 1, child: 2, first: 3, second: 4 },
        });
        expect(reconstructDocument(space, { id, branch: "grandchild" }))
          .toEqual(
            read(f.engine, { id, branch: "grandchild" }),
          );
        const row = { id, branch: "grandchild", seq: applied.seq, opIndex: 0 };
        expect(reconstructRevision(space, row)).toEqual(
          readRevision(f.engine, row),
        );
        expect(reconstructRevision(space, row)).toEqual({
          value: { parent: 1, child: 2, first: 3 },
        });
      } finally {
        space.close();
      }
    });

    it("starts patches after a child deletion from an empty document", async () => {
      await using f = await fixture();
      const id = "entity:deleted";
      f.commit("", [{ op: "set", id, value: { value: { parent: 1 } } }]);
      createBranch(f.engine, "child", { parentBranch: "" });
      f.commit("child", [{ op: "delete", id }]);
      createBranch(f.engine, "grandchild", { parentBranch: "child" });
      for (const branch of ["child", "grandchild"]) {
        f.commit(branch, [{
          op: "patch",
          id,
          patches: [{ op: "add", path: "/value/child", value: 2 }],
        }]);
      }
      const space = openSpace(f.path);
      try {
        for (const branch of ["child", "grandchild"]) {
          expect(read(f.engine, { id, branch })).toEqual({
            value: { child: 2 },
          });
          expect(reconstructDocument(space, { id, branch })).toEqual(
            read(f.engine, { id, branch }),
          );
        }
      } finally {
        space.close();
      }
    });
  });
});
