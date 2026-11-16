import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";
import { sha256 } from "@commonfabric/content-hash";
import {
  type ClientCommit,
  encodeMemoryBoundary,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import {
  compactStore,
  isHollowedPayload,
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

import { verifyCompaction } from "../compaction.ts";
import { entityConflicts } from "../conflicts.ts";
import { openSpace } from "../db.ts";

const SPACE = "did:key:z6Mk-derived-payload-inspect";
const SERVICE = `service:${SPACE}`;

/**
 * The digested form of `commit`, built here from the format rather than by
 * the engine's own helper.
 */
const digestedForm = (commit: ClientCommit): string => {
  const encoded = encodeMemoryBoundary(commit);
  const bytes = new TextEncoder().encode(encoded);
  const { operations, ...kept } = commit;
  return encodeMemoryBoundary({
    ...kept,
    digest: {
      sha256: toUnpaddedBase64url(sha256(bytes)),
      bytes: bytes.length,
      operations: operations.length,
    },
  });
};

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

  const authored = (session: string, n: number) =>
    applyCommit(engine, {
      sessionId: session,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:x", value: { value: { n } } }],
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
    it("reports the same stale reads whether a derived commit's payload is stored whole or digested", () => {
      // Session a writes `of:x` at seq 1 and session b at seq 2. The derived
      // commit at seq 4 is rewritten to read `of:x` at seq 1, so b's write
      // lies inside the read's interval.
      authored("session:a", 1);
      authored("session:b", 2);
      wave({
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "computed:y",
          value: { value: { n: 0 } },
        }],
      });
      const reader = derivedCommit([{
        id: "of:x",
        path: toDocumentPath([]),
        seq: 2,
      }]);
      const { seq } = wave(reader);
      closeEngine();
      const stale: ClientCommit = {
        ...reader,
        reads: {
          confirmed: [{ id: "of:x", path: toDocumentPath([]), seq: 1 }],
          pending: [],
        },
      };

      rewritePayload(seq, encodeMemoryBoundary(stale));
      const whole = conflictsOfX();
      rewritePayload(seq, digestedForm(stale));
      const digested = conflictsOfX();

      expect(whole.staleReads.map((read) => read.readerCommitSeq)).toEqual([
        seq,
      ]);
      expect(digested).toEqual(whole);
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
      const db = new Database(result, { readonly: true });
      const derivedRows = db.prepare(
        `SELECT original FROM "commit" WHERE class = 'derived'`,
      ).all<{ original: string }>();
      db.close();
      expect(derivedRows.map((row) => isHollowedPayload(row.original)))
        .toEqual(Array(7).fill(true));
    });
  });
});
