/**
 * The identity exemption against a compacted history.
 *
 * A commit refused as stale is accepted anyway when replaying its operations
 * on the reader's basis and on the stored document both yield the stored
 * document. The reader's basis is reconstructed from the store, and a basis
 * older than an instance's oldest row reads as absent whether that history
 * never existed or `cf space compact` deleted it. A patch applied to nothing
 * can equal the stored document while the same patch on the view the reader
 * actually held would not, so the second case must leave the basis unknown
 * and the refusal standing. Compaction marks the distinction by attributing
 * each truncated instance's boundary row to a `system` commit stamped with
 * COMPACTION_SESSION_PREFIX, and these cases apply that transformation by
 * hand the way the tool will (docs/plans/compact-space.md, §1 option (a)):
 * insert the compaction commit, materialize a patch boundary as a `set`,
 * re-attribute the boundary whatever its op, delete the rows and snapshots
 * below it, leave the rows above it, and advance the branch head.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  COMPACTION_SESSION_PREFIX,
  ConflictError,
  type Engine,
  open,
  read,
} from "../v2/engine.ts";
import { encodeMemoryBoundary } from "../v2.ts";

const DOC = "of:doc";
const OTHER = "of:other";

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;
const patchOp = (id: string, patches: unknown[]) =>
  ({ op: "patch", id, patches }) as never;
const commit = (localSeq: number, extra: Record<string, unknown>) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [],
    ...extra,
  }) as never;

type Row = { seq: number; op_index: number; op: string };

/**
 * Truncates `id`'s history by hand, as the compaction tool will: the rows
 * below `cutSeq` go (the whole history below the head when it is absent),
 * the oldest row kept becomes a `set` holding the document at exactly that
 * row if it was a patch, and it is attributed to a fresh compaction commit
 * whatever its op. Returns the engine reopened on the same file, so no
 * cache survives the transformation.
 */
const compactByHand = async (
  engine: Engine,
  path: string,
  id: string,
  cutSeq?: number,
): Promise<Engine> => {
  const db = engine.database;
  const next =
    db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM "commit"`)
      .get<{ seq: number }>()!.seq;
  const boundary = cutSeq === undefined
    ? db.prepare(
      `SELECT seq, op_index, op FROM revision WHERE id = ? ORDER BY seq DESC, op_index DESC LIMIT 1`,
    ).get<Row>(id)!
    : db.prepare(
      `SELECT seq, op_index, op FROM revision WHERE id = ? AND seq >= ? ORDER BY seq ASC, op_index ASC LIMIT 1`,
    ).get<Row>(id, cutSeq)!;
  db.exec(
    `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution, class)
     VALUES (${next}, '', '${COMPACTION_SESSION_PREFIX}test', 1, '{"compaction":true}', '{}', 'system')`,
  );
  if (boundary.op === "patch") {
    const document = read(engine, { id, seq: boundary.seq } as never);
    db.prepare(
      `UPDATE revision SET op = 'set', data = ?, commit_seq = ? WHERE id = ? AND seq = ? AND op_index = ?`,
    ).run(
      encodeMemoryBoundary(document as never),
      next,
      id,
      boundary.seq,
      boundary.op_index,
    );
    db.prepare(
      `UPDATE head SET op = 'set' WHERE id = ? AND seq = ? AND op_index = ?`,
    )
      .run(id, boundary.seq, boundary.op_index);
  } else {
    db.prepare(
      `UPDATE revision SET commit_seq = ? WHERE id = ? AND seq = ? AND op_index = ?`,
    ).run(next, id, boundary.seq, boundary.op_index);
  }
  db.prepare(
    `DELETE FROM revision WHERE id = ? AND (seq < ? OR (seq = ? AND op_index < ?))`,
  ).run(id, boundary.seq, boundary.seq, boundary.op_index);
  db.prepare(`DELETE FROM snapshot WHERE id = ? AND seq <= ?`).run(
    id,
    boundary.seq,
  );
  db.exec(`UPDATE branch SET head_seq = ${next} WHERE name = ''`);
  close(engine);
  return await open({ url: toFileUrl(path) });
};

describe("the identity exemption against a compacted history", () => {
  let path: string;
  let engine: Engine;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
  });
  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  /** Seeds `{x: 2, y: 3}` at seq 1, which session a's reads will name. */
  const seed = () =>
    applyCommit(engine, {
      sessionId: "s:seed",
      commit: commit(1, { operations: [setOp(DOC, { x: 2, y: 3 })] }),
    });

  /** Session b replaces the document with `{x: 1}` and, with `trailing`,
   * patches `x` to 1 again so the head is a patch. */
  const replace = (trailing: boolean) => {
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(1, { operations: [setOp(DOC, { x: 1 })] }),
    });
    if (trailing) {
      applyCommit(engine, {
        sessionId: "s:b",
        commit: commit(2, {
          operations: [
            patchOp(DOC, [{ op: "replace", path: "/value/x", value: 1 }]),
          ],
        }),
      });
    }
  };

  /** Session a's patch over its seed-1 confirmed read: on its real basis it
   * yields `{x: 1, y: 3}`, not the stored `{x: 1}`, so it conflicts; on an
   * absent basis it would yield `{x: 1}` and pass as an identity. */
  const staleConfirmedPatch = () =>
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        reads: { confirmed: [{ id: DOC, path: [], seq: 1 }], pending: [] },
        operations: [patchOp(DOC, [{ op: "add", path: "/value/x", value: 1 }])],
      }),
    });

  for (
    const [name, trailing, cut] of [
      ["a patch-headed instance", true, undefined],
      ["an instance whose boundary was already a set", false, undefined],
      ["a bounded cut that keeps rows above the boundary", true, 3],
    ] as const
  ) {
    it(`keeps refusing a confirmed read whose basis was compacted away, ${name}`, async () => {
      seed();
      replace(trailing);
      if (cut !== undefined) {
        // The row the cut keeps above the boundary changes nothing the
        // stale patch could not reproduce, so only the guard can refuse it.
        applyCommit(engine, {
          sessionId: "s:b",
          commit: commit(3, {
            operations: [
              patchOp(DOC, [{ op: "replace", path: "/value/x", value: 1 }]),
            ],
          }),
        });
      }
      expect(() => staleConfirmedPatch()).toThrow(ConflictError);

      engine = await compactByHand(engine, path, DOC, cut);

      expect(() => staleConfirmedPatch()).toThrow(ConflictError);
      const value =
        (read(engine, { id: DOC } as never) as { value: unknown }).value;
      expect(value).toEqual({ x: 1 });
    });
  }

  it("keeps refusing a pending read whose basis was compacted away", async () => {
    seed();
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, {
        operations: [patchOp(DOC, [{ op: "add", path: "/value/x", value: 2 }])],
      }),
    });
    replace(true);
    const stalePending = () =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, {
          reads: {
            confirmed: [],
            pending: [{ id: DOC, path: [], basisSeq: 1, localSeq: [1] }],
          },
          operations: [
            patchOp(DOC, [{ op: "add", path: "/value/x", value: 1 }]),
          ],
        }),
      });
    expect(() => stalePending()).toThrow(ConflictError);

    engine = await compactByHand(engine, path, DOC);

    expect(() => stalePending()).toThrow(ConflictError);
  });

  it("still proves identity from a genuine absence, and from a basis at or above the boundary", async () => {
    seed();
    replace(true);
    // Another instance, untouched by the compaction: session a read the
    // space before it existed, and submits exactly what is stored.
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(3, { operations: [setOp(OTHER, { n: 2 })] }),
    });
    const identityFromAbsence = () =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, {
          reads: { confirmed: [{ id: OTHER, path: [], seq: 1 }], pending: [] },
          operations: [setOp(OTHER, { n: 2 })],
        }),
      });
    expect(identityFromAbsence().elidedOpIndexes).toEqual([0]);

    engine = await compactByHand(engine, path, DOC);

    const again = applyCommit(engine, {
      sessionId: "s:c",
      commit: commit(1, {
        reads: { confirmed: [{ id: OTHER, path: [], seq: 1 }], pending: [] },
        operations: [setOp(OTHER, { n: 2 })],
      }),
    });
    expect(again.elidedOpIndexes).toEqual([0]);
    // On the compacted instance a reader whose basis is the boundary itself
    // still gets the exemption: that history survived.
    const boundarySeq = engine.database.prepare(
      `SELECT seq FROM head WHERE id = ?`,
    ).get<{ seq: number }>(DOC)!.seq;
    applyCommit(engine, {
      sessionId: "s:b",
      commit: commit(4, {
        operations: [patchOp(DOC, [{ op: "add", path: "/value/w", value: 1 }])],
      }),
    });
    const fromBoundary = applyCommit(engine, {
      sessionId: "s:d",
      commit: commit(1, {
        reads: {
          confirmed: [{ id: DOC, path: [], seq: boundarySeq }],
          pending: [],
        },
        operations: [setOp(DOC, { x: 1, w: 1 })],
      }),
    });
    expect(fromBoundary.elidedOpIndexes).toEqual([0]);
  });
});
