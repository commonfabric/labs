import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import { hashStringOf } from "@commonfabric/data-model";
import {
  type ClientCommit,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import {
  compactStore,
  decodeHollowedPayload,
} from "@commonfabric/memory/v2/compact";
import {
  applyCommit,
  applyWaveCommit,
  close,
  type Engine,
  open,
  serverSeq,
} from "@commonfabric/memory/v2/engine";
import { executionLeaseHolder } from "@commonfabric/memory/v2/execution-lease";
import { storedOperationCount } from "@commonfabric/memory/v2/stored-commit";

import { verifyCompaction } from "../compaction.ts";
import { entityConflicts } from "../conflicts.ts";
import { openSpace } from "../db.ts";
import { describeCommitPayload, listCommits } from "../queries.ts";

const SPACE = "did:key:z6Mk-derived-payload-inspect";
const SERVICE = `service:${SPACE}`;

describe("derived-payload", () => {
  let dir: string;
  let path: string;
  let engine: Engine;
  let holder: string;
  let localSeq: number;
  let engineOpen: boolean;

  beforeEach(async () => {
    setServerExecutionConfig(true);
    dir = await Deno.makeTempDir({ prefix: "derived-payload-" });
    path = `${dir}/store.sqlite`;
    engine = await open({ url: toFileUrl(path) });
    holder = executionLeaseHolder(SERVICE);
    expect(engine.executionLeases.acquire(SPACE, holder)).toBe(true);
    localSeq = 0;
    engineOpen = true;
  });

  afterEach(async () => {
    if (engineOpen) close(engine);
    resetServerExecutionConfig();
    await Deno.remove(dir, { recursive: true });
  });

  const closeEngine = (): void => {
    close(engine);
    engineOpen = false;
  };

  const authored = (session: string, n: number, id = "of:x", local = 1) =>
    applyCommit(engine, {
      sessionId: session,
      commit: {
        localSeq: local,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: { n } } }],
      },
    });

  const wave = (commit: ClientCommit) =>
    applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit,
      commitClass: "derived",
      holder,
      annotations: [],
      consequenceOf: [],
      waveBasis: { basisSeq: serverSeq(engine), rebasedHeads: [] },
    });

  const derivedCommit = (
    reads: ClientCommit["reads"]["confirmed"],
  ): ClientCommit => ({
    localSeq: ++localSeq,
    reads: { confirmed: reads, pending: [] },
    operations: [{
      op: "patch",
      id: "computed:y",
      patches: [{ op: "replace", path: "/value/n", value: localSeq }],
    }],
  });

  const rewritePayload = (seq: number, original: string): void => {
    const db = new Database(path);
    try {
      db.prepare(`UPDATE "commit" SET original = ? WHERE seq = ?`)
        .run(original, seq);
    } finally {
      db.close();
    }
  };

  const conflictsOfX = () => {
    const space = openSpace(path);
    try {
      return entityConflicts(space, "of:x");
    } finally {
      space.close();
    }
  };

  describe("entityConflicts()", () => {
    // The scan replays a commit's reads, so the engine here keeps them.
    beforeEach(async () => {
      close(engine);
      engine = await open({ url: toFileUrl(path), storeReadsDigest: false });
      expect(engine.executionLeases.acquire(SPACE, holder)).toBe(true);
    });

    it("reports the same stale reads whether a derived commit that keeps its reads is stored with its operations or with a digest of them", () => {
      // Sessions a and b write `of:x` at seqs 1 and 2, and session c writes
      // `of:w` at seq 3. The derived commit at seq 4 reads `of:x` at seq 2.
      // Session c's later write of `of:x` is then moved to seq 3, inside the
      // read's interval, which is the anomaly the scan reports.
      authored("session:a", 1);
      authored("session:b", 2);
      authored("session:c", 3, "of:w");
      const reader: ClientCommit = {
        localSeq: ++localSeq,
        reads: {
          confirmed: [{ id: "of:x", path: toDocumentPath([]), seq: 2 }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "computed:y",
          value: { value: { n: 0 } },
        }],
      };
      const { seq } = wave(reader);
      const late = authored("session:c", 4, "of:x", 2);
      closeEngine();
      const db = new Database(path);
      db.prepare(
        `UPDATE revision SET seq = 3, commit_seq = 3
         WHERE id = 'of:x' AND seq = ?`,
      ).run(late.seq);
      const stored = db.prepare(`SELECT original FROM "commit" WHERE seq = ?`)
        .get<{ original: string }>(seq)!.original;
      db.close();
      expect(storedOperationCount(decodeTrustedMemoryBoundary(stored))?.kept)
        .toBe(false);

      const digested = conflictsOfX();
      rewritePayload(seq, encodeMemoryBoundary(reader));
      const whole = conflictsOfX();

      expect(digested.staleReads.map((read) => read.readerCommitSeq)).toEqual([
        seq,
      ]);
      expect(digested).toEqual(whole);
    });
  });

  describe("listCommits()", () => {
    const reader = (): ClientCommit => ({
      localSeq: ++localSeq,
      reads: {
        confirmed: [{ id: "of:x", path: toDocumentPath([]), seq: 1 }],
        pending: [],
      },
      operations: [
        { op: "set", id: "computed:y", value: { value: { n: 0 } } },
        { op: "delete", id: "computed:z" },
      ],
    });

    const listed = (seq: number) => {
      const space = openSpace(path);
      try {
        return listCommits(space).find((commit) => commit.seq === seq)!;
      } finally {
        space.close();
      }
    };

    it("lists a digested derived commit with the operation count its digest names, and its reads", () => {
      authored("session:a", 1);
      const { seq } = wave(reader());
      closeEngine();

      const commit = listed(seq);

      expect([commit.ops, commit.reads, commit.digested]).toEqual([2, 1, true]);
      expect(describeCommitPayload(commit)).toBe("ops=2 (digest)\treads=1");
    });

    it("lists a derived commit stored whole with its operation count and no digest mark", () => {
      authored("session:a", 1);
      const commit = reader();
      const { seq } = wave(commit);
      closeEngine();
      rewritePayload(seq, encodeMemoryBoundary(commit));

      const info = listed(seq);

      expect([info.ops, info.reads, info.digested]).toEqual([2, 1, undefined]);
      expect(describeCommitPayload(info)).toBe("ops=2\treads=1");
    });
  });

  describe("verifyCompaction()", () => {
    it("passes over a store whose derived commits lie outside the payload window", async () => {
      authored("session:a", 1);
      wave({
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "computed:y",
          value: { value: { n: 0 } },
        }],
      });
      for (let index = 0; index < 6; index++) wave(derivedCommit([]));
      closeEngine();
      const backup = `${dir}/backup.sqlite`;
      const result = `${dir}/result.sqlite`;
      await Deno.copyFile(path, backup);

      await compactStore({
        store: path,
        out: result,
        selection: { prefixes: ["computed:"] },
        keepPayloadsMs: 0,
        runId: "derived",
      });
      const verification = verifyCompaction({ result, against: backup });

      expect(
        verification.checks.filter((check) => !check.passed).map((check) =>
          check.name
        ),
      ).toEqual([]);
      expect(verification.ok).toBe(true);
      const derivedRows = (file: string) => {
        const db = new Database(file, { readonly: true });
        try {
          return db.prepare(
            `SELECT original FROM "commit" WHERE class = 'derived' ORDER BY seq`,
          ).all<{ original: string }>().map((row) => row.original);
        } finally {
          db.close();
        }
      };
      const before = derivedRows(backup);
      const after = derivedRows(result);
      expect(
        before.map((original) =>
          storedOperationCount(decodeTrustedMemoryBoundary(original))?.kept
        ),
      ).toEqual(Array(7).fill(false));
      expect(after.map((original) => decodeHollowedPayload(original)?.hash))
        .toEqual(before.map((original) => hashStringOf(original)));
    });
  });
});
