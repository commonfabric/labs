// What the inspector says about a compacted store: the compaction commit and
// the hollowed payloads in the commit listing, and the ACL document's record
// in its classification.

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import { Database } from "@db/sqlite";

import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import {
  type CompactionReport,
  compactStore,
} from "@commonfabric/memory/v2/compact";
import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";

import { main } from "../cli.ts";
import { openSpace } from "../db.ts";
import { decodeStored } from "../decode.ts";
import { classifyDocument } from "../model.ts";
import { describeCommitPayload, listCommits } from "../queries.ts";
import { reconstructDocument } from "../reconstruct.ts";

const SPACE = "did:key:z6MkTestSpace";
const ACL = `of:${SPACE}`;

const commit = (localSeq: number, operations: unknown[]) =>
  ({ localSeq, reads: { confirmed: [], pending: [] }, operations }) as never;

Deno.test("the commit listing names a compaction run and the payloads it hollowed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "compaction-inspect-" });
  try {
    const store = `${dir}/space.sqlite`;
    const engine = await open({ url: toFileUrl(store) });
    applyCommit(engine, {
      sessionId: `session:${SPACE}:genesis`,
      principal: SPACE,
      commit: commit(1, [{
        op: "set",
        id: ACL,
        value: { value: { [SPACE]: "OWNER" } },
      }]),
    } as never);
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(1, [{
        op: "set",
        id: "computed:a",
        value: { value: { n: 0 } },
      }]),
    });
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(2, [{
        op: "patch",
        id: "computed:a",
        patches: [{ op: "replace", path: "/value/n", value: 1 }],
      }]),
    });
    close(engine);
    const run = await compactStore({
      store,
      out: `${dir}/result.sqlite`,
      selection: { prefixes: ["computed:"] },
      keepPayloadsMs: 0,
      runId: "2026-10-12T00:00:00.000Z",
    });

    const space = openSpace(`${dir}/result.sqlite`);
    try {
      const rows = listCommits(space);
      const bySeq = new Map(rows.map((row) => [row.seq, row]));
      const compaction = bySeq.get(run.commitSeq)!;
      assertEquals(compaction.compactionRun, "2026-10-12T00:00:00.000Z");
      assertEquals(compaction.hollowedBy, undefined);
      assertEquals([compaction.ops, compaction.reads], [0, 0]);
      assertEquals(
        describeCommitPayload(compaction),
        "compaction run 2026-10-12T00:00:00.000Z",
      );
      for (const seq of [2, 3]) {
        const hollowed = bySeq.get(seq)!;
        assertEquals(hollowed.hollowedBy, "2026-10-12T00:00:00.000Z");
        assertEquals(hollowed.compactionRun, undefined);
        assertEquals(
          describeCommitPayload(hollowed),
          "payload hollowed by compaction run 2026-10-12T00:00:00.000Z",
        );
      }
      // The genesis receipt is exempt and still reads as a client commit.
      const genesis = bySeq.get(1)!;
      assertEquals(genesis.compactionRun, undefined);
      assertEquals(genesis.hollowedBy, undefined);
      assertEquals(describeCommitPayload(genesis), "ops=1\treads=0");

      // The ACL document classifies as the free cell it is, with the record.
      const acl = reconstructDocument(space, { id: ACL })!;
      const classified = classifyDocument(acl, { id: ACL });
      assertEquals(classified.kind, "free-cell");
      assertEquals(classified.compaction, {
        runs: 1,
        lastCommitSeq: run.lastCommitSeq,
      });
      assert(
        classified.label.endsWith(
          `· compacted 1 run, history through seq ${run.lastCommitSeq} archived`,
        ),
        classified.label,
      );
      // A document without the member, or with one that is not a record,
      // classifies as before.
      assertEquals(
        classifyDocument({ value: { [SPACE]: "OWNER" } } as never).compaction,
        undefined,
      );
      assertEquals(
        classifyDocument({ value: 1, compaction: null } as never).compaction,
        undefined,
      );
      // A record without a finite `lastCommitSeq` is not a record: no
      // archive boundary is advertised that the store did not write.
      assertEquals(
        classifyDocument(
          { value: 1, compaction: { runs: [{ commitSeq: 9 }] } } as never,
        ).compaction,
        undefined,
      );
      assertEquals(
        classifyDocument(
          {
            value: 1,
            compaction: { runs: [], lastCommitSeq: Number.NaN },
          } as never,
        ).compaction,
        undefined,
      );
      // A compaction run's plan names the row's sequence and session, and
      // the row starts that session at local sequence 1.
      const planned = space.db.prepare(
        `SELECT original FROM "commit" WHERE seq = ?`,
      ).get<{ original: string }>(run.commitSeq)!.original;
      const payload = decodeStored(planned) as {
        compaction: { runId: string; report: CompactionReport };
      };
      const identity = payload.compaction.report.compactionCommit;
      for (
        const [name, seq, sessionId, localSeq] of [
          ["other-sequence", run.commitSeq + 1, identity.sessionId, 1],
          ["other-session", run.commitSeq, "compaction:other", 1],
          ["other-local-sequence", run.commitSeq, identity.sessionId, 2],
        ] as const
      ) {
        const malformedPath = `${dir}/${name}.sqlite`;
        await Deno.copyFile(`${dir}/result.sqlite`, malformedPath);
        const db = new Database(malformedPath);
        try {
          db.prepare(
            `UPDATE "commit" SET original = ?, local_seq = ? WHERE seq = ?`,
          ).run(
            encodeMemoryBoundary({
              compaction: {
                ...payload.compaction,
                report: {
                  ...payload.compaction.report,
                  compactionCommit: { ...identity, seq, sessionId },
                },
              },
            }),
            localSeq,
            run.commitSeq,
          );
        } finally {
          db.close();
        }
        const malformedSpace = openSpace(malformedPath);
        try {
          const row = listCommits(malformedSpace).find((row) =>
            row.seq === run.commitSeq
          );
          expect(row).toBeDefined();
          expect(row!.compactionRun).toBeUndefined();
          expect(describeCommitPayload(row!)).toBe("ops=0\treads=0");
        } finally {
          malformedSpace.close();
        }
      }
    } finally {
      space.close();
    }
    // The inspector's own CLI prints the same tail.
    assertEquals(main(["commits", `${dir}/result.sqlite`, "--limit", "5"]), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
