import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { taggedHashStringOf } from "@commonfabric/data-model";

import {
  applyCommit,
  applyWaveCommit,
  close,
  type Engine,
  open,
  serverSeq,
} from "../v2/engine.ts";
import { executionLeaseHolder } from "../v2/execution-lease.ts";
import {
  type ClientCommit,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  toDocumentPath,
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
});
