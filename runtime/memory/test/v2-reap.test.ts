import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import {
  applyCommit,
  close,
  type Engine,
  findSpaceDeletion,
  open,
  read,
  serverSeq,
} from "../v2/engine.ts";
import { planReap, ReapRefused, reapStore } from "../v2/reap.ts";
import { cellDatabaseFilePrefix } from "../v2/storage-path.ts";

const SPACE = "did:key:z6MkReapSpace";
const ALICE = "did:key:z6MkReapAlice";
const ACL = `of:${SPACE}`;

const commit = (localSeq: number, operations: unknown[]) => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations,
});

const setOp = (id: string, value: unknown) => ({
  op: "set",
  id,
  value: { value },
});

/** The rows `table` of the store at `path` holds. */
const rows = (path: string, table: string): Record<string, unknown>[] => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM "${table}"`).all();
  } finally {
    db.close();
  }
};

describe("reap", () => {
  let dir: string;
  let store: string;
  let out: string;
  const opened: Engine[] = [];

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "reap-" });
    store = `${dir}/space.sqlite`;
    out = `${dir}/space.reaped.sqlite`;
  });
  afterEach(async () => {
    for (const engine of opened) close(engine);
    opened.length = 0;
    await Deno.remove(dir, { recursive: true });
  });

  /**
   * Builds a space alice owns alone, with documents and history, and a table
   * no engine declares holding a row, as a pattern's private table would.
   * With `deleted`, alice then deletes it. Returns the deletion's seq, or 0.
   */
  const build = async (deleted = true): Promise<number> => {
    const engine = await open({ url: toFileUrl(store) });
    let local = 1;
    const apply = (operations: unknown[], principal = ALICE) =>
      applyCommit(engine, {
        sessionId: "session:alice",
        space: SPACE,
        principal,
        commit: commit(local++, operations),
      } as never).seq;
    apply([setOp(ACL, { [ALICE]: "OWNER" })]);
    apply([setOp("of:doc", { n: 1 })]);
    apply([setOp("of:doc", { n: 2 })]);
    apply([setOp("computed:x", { n: 3 })]);
    engine.database.exec(
      `CREATE TABLE private_rows (x TEXT); INSERT INTO private_rows VALUES ('kept?')`,
    );
    const seq = deleted ? apply([setOp(ACL, { deleted: { by: ALICE } })]) : 0;
    close(engine);
    return seq;
  };

  it("keeps the deletion commit and its tombstone, removes everything else, and leaves the store as it was", async () => {
    const seq = await build();
    const before = await Deno.readFile(store);

    const run = await reapStore({ store, out });

    expect(await Deno.readFile(store)).toEqual(before);
    expect(run.deletionSeq).toBe(seq);
    expect(run.deletedBy).toBe(ALICE);
    expect(rows(out, "commit").map((row) => row.seq)).toEqual([seq]);
    expect(rows(out, "revision").map((row) => [row.id, row.seq])).toEqual([
      [ACL, seq],
    ]);
    expect(rows(out, "head").map((row) => row.id)).toEqual([ACL]);
    expect(rows(out, "branch").map((row) => row.name)).toEqual([""]);
    expect(rows(out, "private_rows")).toEqual([]);
    expect(rows(out, "snapshot")).toEqual([]);
  });

  it("leaves a store the engine reads as the same deleted space, at the same server sequence", async () => {
    const seq = await build();
    await reapStore({ store, out });

    const engine = await open({ url: toFileUrl(out) });
    opened.push(engine);
    expect(serverSeq(engine)).toBe(seq);
    expect(findSpaceDeletion(engine, SPACE)).toEqual({
      space: SPACE,
      aclRevision: seq,
    });
    expect(read(engine, { id: "of:doc" } as never)).toBeNull();
  });

  it("plans, read-only, what it removes from each table, and names the space's cell databases", async () => {
    await build();
    const db = new Database(store, { readonly: true });
    try {
      const plan = planReap(db);
      expect(plan.removed["commit"]).toBe(4);
      expect(plan.removed["private_rows"]).toBe(1);
      expect(plan.removed["head"]).toBe(2);
      expect(plan.cellDatabaseFilePrefix).toBe(cellDatabaseFilePrefix(SPACE));
    } finally {
      db.close();
    }
  });

  it("refuses the store of a space that is not deleted", async () => {
    await build(false);
    await expect(reapStore({ store, out })).rejects.toThrow(ReapRefused);
    await expect(reapStore({ store, out })).rejects.toThrow(
      "holds no deletion tombstone",
    );
  });

  it("refuses a store holding a commit after its deletion, which no server writes", async () => {
    const seq = await build();
    const db = new Database(store);
    try {
      db.prepare(
        `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
         VALUES (?, 'session:stray', 1, '{}', '{}')`,
      ).run(seq + 1);
    } finally {
      db.close();
    }
    await expect(reapStore({ store, out })).rejects.toThrow(
      `follows the deletion commit ${seq}`,
    );
  });

  it("never overwrites a result", async () => {
    await build();
    await Deno.writeTextFile(out, "");
    await expect(reapStore({ store, out })).rejects.toThrow(
      "the result is never overwritten",
    );
  });
});
