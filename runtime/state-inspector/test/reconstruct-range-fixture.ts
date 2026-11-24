import { Database } from "@db/sqlite";

import { encodeMemoryBoundary } from "@commonfabric/memory/v2";

import { openSpace, type SpaceDb } from "../db.ts";

/** Creates an offline fixture whose target has both exact-row and latest reads. */
export function replayRangeFixture(
  historyLength: number,
  options: {
    /** Whether snapshots cover the base and target sequences. */
    snapshots?: boolean;

    /** Makes the latest set base malformed underneath the snapshots. */
    corruptBase?: boolean;
  } = {},
): {
  /** Read-only store, closed when this fixture is disposed. */
  space: SpaceDb;

  /** Sequence containing two patches and a whole-commit snapshot. */
  targetSeq: number;

  /** Closes the reader and removes the disposable store. */
  [Symbol.dispose](): void;
} {
  const dir = Deno.makeTempDirSync({ prefix: "inspector-replay-range-" });
  try {
    const path = `${dir}/space.sqlite`;
    const db = new Database(path);
    const targetSeq = historyLength + 2;
    try {
      db.exec(`
        CREATE TABLE revision (
          branch TEXT, id TEXT, scope_key TEXT, seq INTEGER, op_index INTEGER,
          op TEXT, data TEXT, commit_seq INTEGER,
          PRIMARY KEY (branch, id, scope_key, seq, op_index)
        );
        CREATE TABLE snapshot (
          branch TEXT, id TEXT, scope_key TEXT, seq INTEGER, value TEXT,
          PRIMARY KEY (branch, id, scope_key, seq)
        );
        BEGIN;
      `);
      const row = db.prepare(
        "INSERT INTO revision VALUES ('', 'of:range', 'space', ?, ?, ?, ?, ?)",
      );
      const base = encodeMemoryBoundary({ value: { items: ["base"] } });
      const patch = (item: string) =>
        encodeMemoryBoundary([{
          op: "add",
          path: "/value/items/-",
          value: item,
        }]);
      for (let seq = 1; seq <= historyLength; seq++) {
        row.run(
          seq,
          0,
          seq === 1 ? "set" : "patch",
          seq === 1 ? base : patch("old"),
          seq,
        );
      }
      row.run(
        targetSeq - 1,
        0,
        "set",
        options.corruptBase ? "malformed" : base,
        targetSeq - 1,
      );
      row.run(targetSeq, 0, "patch", patch("first"), targetSeq);
      row.run(targetSeq, 1, "patch", patch("second"), targetSeq);
      row.run(
        targetSeq + 1,
        0,
        "set",
        encodeMemoryBoundary({ value: { items: ["future"] } }),
        targetSeq + 1,
      );
      if (options.snapshots !== false) {
        const snap = db.prepare(
          "INSERT INTO snapshot VALUES ('', 'of:range', 'space', ?, ?)",
        );
        snap.run(targetSeq - 1, base);
        snap.run(
          targetSeq,
          encodeMemoryBoundary({
            value: { items: ["base", "first", "second"] },
          }),
        );
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const space = openSpace(path);
    return {
      space,
      targetSeq,
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
