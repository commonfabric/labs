import { ChangeSet } from "@codemirror/state";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";
import { sha256 } from "@commonfabric/content-hash";
import { taggedHashStringOf } from "@commonfabric/data-model";

import {
  applyCommit,
  applyWaveCommit,
  close,
  ConflictError,
  type Engine,
  open,
  payloadDigest,
  serverSeq,
} from "../v2/engine.ts";
import { executionLeaseHolder } from "../v2/execution-lease.ts";
import { readGenesisRoot } from "../v2/genesis-root.ts";
import { CODEMIRROR_CHANGESET_CODEC } from "../v2/operation-codec.ts";
import {
  type ClientCommit,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  operationBaselineHash,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  toDocumentPath,
  toValuePath,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-derived-payload-space";
const SERVICE = `service:${SPACE}`;

const noReads = (): ClientCommit["reads"] => ({ confirmed: [], pending: [] });

const CONTENT = { type: "string" };
const CONTENT_ID = `cid:${taggedHashStringOf(CONTENT)}`;

/** What identifies a revision, without the fields replay leaves unset. */
const revisionKeys = (
  revisions: readonly {
    id: string;
    op: string;
    opIndex: number;
    seq: number;
  }[],
) => revisions.map(({ id, op, opIndex, seq }) => ({ id, op, opIndex, seq }));

describe("derived commit payload", () => {
  let engine: Engine;
  let holder: string;

  beforeEach(async () => {
    setServerExecutionConfig(true);
    engine = await open({
      url: new URL(`memory://derived-payload-${crypto.randomUUID()}`),
    });
    holder = executionLeaseHolder(SERVICE);
    expect(engine.executionLeases.acquire(SPACE, holder)).toBe(true);
    // An authored commit takes seq 1, so every derived commit a case applies
    // lands past the genesis receipt.
    applyCommit(engine, {
      sessionId: "session:author",
      commit: {
        localSeq: 1,
        reads: noReads(),
        operations: [{
          op: "set",
          id: "of:authored",
          value: { value: { n: 0 } },
        }],
      },
    });
  });

  afterEach(() => {
    close(engine);
    resetServerExecutionConfig();
  });

  /** The stored payload and class of the commit at `seq`. */
  const storedRow = (seq: number): { original: string; class: string } =>
    engine.database.prepare(
      `SELECT original, class FROM "commit" WHERE seq = ?`,
    ).get<{ original: string; class: string }>(seq)!;

  /** Rewrites the stored payload of the commit at `seq`. */
  const rewritePayload = (seq: number, original: string): void => {
    engine.database.prepare(`UPDATE "commit" SET original = ? WHERE seq = ?`)
      .run(original, seq);
  };

  const wave = (
    commit: ClientCommit,
    overrides: { holder?: string } = {},
  ) =>
    applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit,
      commitClass: "derived",
      holder: overrides.holder ?? holder,
      annotations: [],
      consequenceOf: [],
      waveBasis: { basisSeq: serverSeq(engine), rebasedHeads: [] },
    });

  /**
   * A derived commit of a `set`, a `patch` and a `delete`, and a
   * content-addressed `set` of stored content, which admission elides.
   */
  const mixedCommit = (localSeq: number, title = "first"): ClientCommit => ({
    localSeq,
    reads: {
      confirmed: [{ id: "of:authored", path: toDocumentPath([]), seq: 1 }],
      pending: [],
    },
    operations: [
      { op: "set", id: "of:derived", value: { value: { title } } },
      {
        op: "patch",
        id: "of:authored",
        patches: [{ op: "replace", path: "/value/n", value: localSeq }],
      },
      { op: "delete", id: "of:doomed" },
      { op: "set", id: CONTENT_ID, value: { value: CONTENT } },
    ],
  });

  /** Writes `of:doomed` and the content `mixedCommit()` sets again. */
  const seedDerived = (): void => {
    wave({
      localSeq: 1,
      reads: noReads(),
      operations: [
        { op: "set", id: "of:doomed", value: { value: { n: 1 } } },
        { op: "set", id: CONTENT_ID, value: { value: CONTENT } },
      ],
    });
  };

  describe("replay", () => {
    it("returns the stored seq, revisions and elided indexes for an exact resubmission", () => {
      seedDerived();
      const applied = wave(mixedCommit(2));
      expect(applied.seq).toBeGreaterThan(2);
      expect(applied.replayed).toBeUndefined();

      const replayed = wave(mixedCommit(2));

      expect(replayed.replayed).toBe(true);
      expect(replayed.seq).toBe(applied.seq);
      expect(revisionKeys(replayed.revisions)).toEqual(
        revisionKeys(applied.revisions),
      );
      expect(applied.elidedOpIndexes).toEqual([3]);
      expect(replayed.elidedOpIndexes).toEqual([3]);
    });

    it("throws `commit replay mismatch` for a resubmission that changes one value", () => {
      seedDerived();
      wave(mixedCommit(2));

      expect(() => wave(mixedCommit(2, "second"))).toThrow(
        "commit replay mismatch",
      );
    });

    it("throws the envelope mismatch for an exact resubmission under another holder", () => {
      seedDerived();
      wave(mixedCommit(2));

      expect(() => wave(mixedCommit(2), { holder: `${holder}:other` }))
        .toThrow("stored class/holder differ");
    });

    it("replays an exact resubmission against a derived row that holds the whole encoding, and refuses a changed one", () => {
      // A row the engine stored whole, as it stores a derived commit that
      // predates the digested form.
      seedDerived();
      const commit = mixedCommit(2);
      const applied = wave(commit);
      expect(payloadDigest(
        decodeTrustedMemoryBoundary(storedRow(applied.seq).original),
      )).toBeDefined();
      rewritePayload(applied.seq, encodeMemoryBoundary(commit));

      const replayed = wave(mixedCommit(2));

      expect(replayed.replayed).toBe(true);
      expect(replayed.seq).toBe(applied.seq);
      expect(() => wave(mixedCommit(2, "second"))).toThrow(
        "commit replay mismatch",
      );
    });
  });

  describe("stored form", () => {
    it("stores a derived commit of `set`, `patch` and `delete` past seq 1 as its digested payload", () => {
      seedDerived();
      const commit: ClientCommit = {
        ...mixedCommit(2),
        preconditions: [{ kind: "entity-absent", id: "of:never" }],
      };
      const encoded = new TextEncoder().encode(encodeMemoryBoundary(commit));

      const { seq } = wave(commit);

      const row = storedRow(seq);
      const { operations: _operations, ...kept } = commit;
      expect(row.class).toBe("derived");
      expect(decodeTrustedMemoryBoundary(row.original)).toEqual({
        ...kept,
        digest: {
          sha256: toUnpaddedBase64url(sha256(encoded)),
          bytes: encoded.length,
          operations: 4,
        },
      });
      expect(kept.reads.confirmed).toHaveLength(1);
    });

    it("writes each revision of a digested commit as the operation it carried", () => {
      seedDerived();
      const commit = mixedCommit(2);

      const { seq } = wave(commit);

      const revisions = engine.database.prepare(
        `SELECT op_index, op, data FROM revision WHERE commit_seq = ?
         ORDER BY op_index`,
      ).all<{ op_index: number; op: string; data: string | null }>(seq);
      expect(revisions.map((row) => ({
        opIndex: row.op_index,
        op: row.op,
        data: row.data === null ? null : decodeTrustedMemoryBoundary(row.data),
      }))).toEqual([
        { opIndex: 0, op: "set", data: { value: { title: "first" } } },
        {
          opIndex: 1,
          op: "patch",
          data: [{ op: "replace", path: "/value/n", value: 2 }],
        },
        { opIndex: 2, op: "delete", data: null },
      ]);
    });

    it("stores a derived commit at seq 1 whole", async () => {
      const fresh = await open({
        url: new URL(`memory://derived-payload-${crypto.randomUUID()}`),
      });
      try {
        const freshHolder = executionLeaseHolder(`${SERVICE}:fresh`);
        expect(fresh.executionLeases.acquire(SPACE, freshHolder)).toBe(true);
        const commit = mixedCommit(1);

        const { seq } = applyWaveCommit(fresh, {
          sessionId: freshHolder,
          space: SPACE,
          commit: { ...commit, operations: commit.operations.slice(0, 1) },
          commitClass: "derived",
          holder: freshHolder,
          waveBasis: { basisSeq: 0, rebasedHeads: [] },
        });

        expect(seq).toBe(1);
        expect(
          fresh.database.prepare(`SELECT original FROM "commit" WHERE seq = 1`)
            .get<{ original: string }>()!.original,
        ).toBe(
          encodeMemoryBoundary({
            ...commit,
            operations: commit.operations.slice(0, 1),
          }),
        );
        // The genesis receipt reads a commit at seq 1 back whole.
        expect(readGenesisRoot(fresh)).toBeUndefined();
      } finally {
        close(fresh);
      }
    });

    it("stores an authored commit past seq 1 whole", () => {
      const commit = mixedCommit(2);

      const { seq } = applyCommit(engine, {
        sessionId: "session:author",
        commit: { ...commit, operations: commit.operations.slice(0, 2) },
      });

      expect(storedRow(seq).original).toBe(
        encodeMemoryBoundary({
          ...commit,
          operations: commit.operations.slice(0, 2),
        }),
      );
    });

    it("stores a derived commit carrying an `apply-op` whole, and one carrying a `release-op-field`", () => {
      wave({
        localSeq: 1,
        reads: noReads(),
        operations: [{
          op: "set",
          id: "of:collaborative",
          value: { value: { body: "ac" } },
        }],
      });
      const commit: ClientCommit = {
        localSeq: 2,
        reads: noReads(),
        operations: [
          { op: "set", id: "of:derived", value: { value: { n: 1 } } },
          {
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "service:1",
            base: null,
            baselineHash: operationBaselineHash("ac"),
            payload: {
              updates: [{
                clientId: "service",
                changes: ChangeSet.of({ from: 1, insert: "b" }, 2).toJSON(),
              }],
            },
          },
        ],
      };

      const { seq } = wave(commit);
      const release: ClientCommit = {
        localSeq: 3,
        reads: noReads(),
        operations: [
          { op: "set", id: "of:derived", value: { value: { n: 2 } } },
          {
            op: "release-op-field",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            cursor: { epoch: 1, version: 1 },
          },
        ],
      };
      const released = wave(release);

      expect(storedRow(seq).original).toBe(encodeMemoryBoundary(commit));
      expect(storedRow(released.seq).original).toBe(
        encodeMemoryBoundary(release),
      );
    });
  });

  describe("reserved wire schema references", () => {
    it("throws for a derived commit whose `set` carries one", () => {
      seedDerived();

      expect(() =>
        wave({
          localSeq: 2,
          reads: noReads(),
          operations: [{
            op: "set",
            id: "of:reserved",
            value: {
              value: {
                $alias: {
                  id: "of:target",
                  path: [],
                  schema: "schema-ref@2:sha256:user-controlled",
                },
              },
            },
          }],
        })
      ).toThrow("reserved wire schema reference");
    });
  });

  describe("a pending read naming a digested layer", () => {
    // The holder's own commit at localSeq 1 writes `of:p` and is stored
    // digested. A later commit of the same session reads `of:p` through that
    // layer from the basis before it. A digested layer keeps no operations to
    // reconstruct the reader's view or prove an identity from, so it gives
    // the read neither identity rule (03-commit-model.md §3.6.1, §3.6.3), and
    // the read is judged from its declared basis alone.

    /** Applies the layer and returns the seq the read declares as its basis. */
    const layer = (): number => {
      const basisSeq = serverSeq(engine);
      const { seq } = wave({
        localSeq: 1,
        reads: noReads(),
        operations: [{ op: "set", id: "of:p", value: { value: { n: 1 } } }],
      });
      expect(
        payloadDigest(decodeTrustedMemoryBoundary(storedRow(seq).original)),
      )
        .toBeDefined();
      return basisSeq;
    };

    const reader = (basisSeq: number): ClientCommit => ({
      localSeq: 2,
      reads: {
        confirmed: [],
        pending: [{
          id: "of:p",
          path: toDocumentPath([]),
          localSeq: [1],
          basisSeq,
        }],
      },
      operations: [{ op: "set", id: "of:q", value: { value: { n: 2 } } }],
    });

    it("is accepted when nothing was written to the document after the layer", () => {
      const basisSeq = layer();

      const applied = wave(reader(basisSeq));

      expect(applied.replayed).toBeUndefined();
      expect(applied.revisions.map((revision) => revision.id)).toEqual([
        "of:q",
      ]);
    });

    it("throws `ConflictError` when a foreign write lies after the declared basis", () => {
      const basisSeq = layer();
      applyCommit(engine, {
        sessionId: "session:author",
        commit: {
          localSeq: 2,
          reads: noReads(),
          operations: [{ op: "set", id: "of:p", value: { value: { n: 9 } } }],
        },
      });

      expect(() => wave(reader(basisSeq))).toThrow(ConflictError);
    });

    it("throws `ConflictError` for a reader whose write would be an identity through the layer", () => {
      const basisSeq = layer();
      applyCommit(engine, {
        sessionId: "session:author",
        commit: {
          localSeq: 2,
          reads: noReads(),
          operations: [{ op: "set", id: "of:p", value: { value: { n: 2 } } }],
        },
      });

      expect(() =>
        wave({
          ...reader(basisSeq),
          operations: [{ op: "set", id: "of:p", value: { value: { n: 2 } } }],
        })
      ).toThrow(ConflictError);
    });

    it("throws `ConflictError` when the layer was accepted as an identity commit", () => {
      applyCommit(engine, {
        sessionId: "session:author",
        commit: {
          localSeq: 2,
          reads: noReads(),
          operations: [{ op: "set", id: "of:p", value: { value: { n: 1 } } }],
        },
      });
      const readSeq = serverSeq(engine);
      applyCommit(engine, {
        sessionId: "session:author",
        commit: {
          localSeq: 3,
          reads: noReads(),
          operations: [{ op: "set", id: "of:p", value: { value: { n: 2 } } }],
        },
      });
      // A stale read whose write the space already holds: admission accepts
      // the layer as an identity commit and elides its one operation.
      const identity = wave({
        localSeq: 1,
        reads: {
          confirmed: [{ id: "of:p", path: toDocumentPath([]), seq: readSeq }],
          pending: [],
        },
        operations: [{ op: "set", id: "of:p", value: { value: { n: 2 } } }],
      });
      expect(identity.elidedOpIndexes).toEqual([0]);
      expect(identity.revisions).toEqual([]);
      expect(payloadDigest(
        decodeTrustedMemoryBoundary(storedRow(identity.seq).original),
      )).toBeDefined();

      expect(() => wave(reader(readSeq))).toThrow(ConflictError);
    });
  });
});
