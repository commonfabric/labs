/**
 * `readRevision` returns the state after exactly one stored row.
 *
 * A commit can carry several operations on one document, and a snapshot the
 * engine writes at that commit's seq holds the state after the last of them.
 * A reconstruction at an earlier row of the same commit must not start from
 * that snapshot, or the operations after the row count twice once the rows
 * above it are replayed — which is what a compaction's bounded cut does with
 * the boundary it materializes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  type Engine,
  open,
  read,
  readRevision,
} from "../v2/engine.ts";

const DOC = "of:list";

const commit = (localSeq: number, operations: unknown[]) =>
  ({ localSeq, reads: { confirmed: [], pending: [] }, operations }) as never;

/** Installs an empty list, then appends "a" and "b" as two operations of one
 * commit; returns that commit's seq. */
const installThenAppendTwice = (engine: Engine): number => {
  applyCommit(engine, {
    sessionId: "s:a",
    commit: commit(1, [{
      op: "set",
      id: DOC,
      value: { value: { items: [] } },
    }]),
  });
  return applyCommit(engine, {
    sessionId: "s:a",
    commit: commit(2, [
      {
        op: "patch",
        id: DOC,
        patches: [{ op: "add", path: "/value/items/-", value: "a" }],
      },
      {
        op: "patch",
        id: DOC,
        patches: [{ op: "add", path: "/value/items/-", value: "b" }],
      },
    ]),
  }).seq;
};

const withEngine = async (
  snapshotInterval: number,
  fn: (engine: Engine) => void,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), snapshotInterval });
  try {
    fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const items = (document: unknown): unknown =>
  (document as { value: { items: unknown } }).value.items;

describe("readRevision", () => {
  for (const [name, interval] of [["without", 100], ["with", 1]] as const) {
    it(`returns the state after exactly one row of a multi-operation commit, ${name} a snapshot at that seq`, async () => {
      await withEngine(interval, (engine) => {
        const seq = installThenAppendTwice(engine);
        const snapshots = engine.database.prepare(
          `SELECT count(*) AS n FROM snapshot WHERE id = ? AND seq = ?`,
        ).get<{ n: number }>(DOC, seq)!.n;
        expect(snapshots).toBe(interval === 1 ? 1 : 0);

        expect(items(read(engine, { id: DOC, seq } as never))).toEqual([
          "a",
          "b",
        ]);
        expect(items(readRevision(engine, { id: DOC, seq, opIndex: 0 })))
          .toEqual(["a"]);
        expect(items(readRevision(engine, { id: DOC, seq, opIndex: 1 })))
          .toEqual(["a", "b"]);
        expect(
          items(readRevision(engine, { id: DOC, seq: seq - 1, opIndex: 0 })),
        ).toEqual([]);
      });
    });
  }

  it("returns null for a delete and throws for a row that does not exist", async () => {
    await withEngine(100, (engine) => {
      const seq = installThenAppendTwice(engine);
      const deleted = applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(3, [{ op: "delete", id: DOC }]),
      }).seq;
      expect(readRevision(engine, { id: DOC, seq: deleted, opIndex: 0 }))
        .toBeNull();
      expect(() => readRevision(engine, { id: DOC, seq, opIndex: 7 })).toThrow(
        "no revision",
      );
    });
  });
});
