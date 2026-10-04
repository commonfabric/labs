import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  applyCommit,
  applyWaveCommit,
  close,
  DerivedAclDocumentWriteError,
  type Engine,
  open,
  ProtocolError,
  read,
  serverSeq,
} from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  type ClientCommit,
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-derived-acl-document-space";
const ACL_ID = `of:${SPACE}`;
const GENESIS_ACL = { "did:key:alice": "OWNER" };

/** A commit setting each of `ids` to `{ n: localSeq }`, whole. */
const setCommit = (localSeq: number, ids: string[]): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: ids.map((id) => ({
    op: "set" as const,
    id,
    value: { value: id === ACL_ID ? { "did:key:mallory": "OWNER" } : { n: 1 } },
  })),
});

describe("DerivedAclDocumentWriteError", () => {
  let engine: Engine;
  let holder: string;

  beforeEach(async () => {
    setServerExecutionConfig(true);
    engine = await open({
      url: new URL(`memory://derived-acl-document-${crypto.randomUUID()}`),
    });
    applyCommit(engine, {
      sessionId: "genesis-session",
      space: SPACE,
      principal: SPACE,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: ACL_ID, value: { value: GENESIS_ACL } }],
      },
    });
    holder = executionLeaseHolder(`service:${SPACE}`);
    expect(acquireExecutionLease(engine, { space: SPACE, holder })).toBe(true);
  });

  afterEach(() => {
    close(engine);
    resetServerExecutionConfig();
  });

  describe("constructor()", () => {
    it("names the operation and the document in its message", () => {
      const error = new DerivedAclDocumentWriteError(SPACE, 3);

      expect(error).toBeInstanceOf(ProtocolError);
      expect(error.name).toBe("DerivedAclDocumentWriteError");
      expect(error.message).toContain(`operation 3 writes ${ACL_ID}`);
    });
  });

  describe("instance members", () => {
    describe("operationIndex", () => {
      it("returns the index the instance was constructed with", () => {
        expect(new DerivedAclDocumentWriteError(SPACE, 3).operationIndex)
          .toBe(3);
      });
    });
  });

  describe("thrown by a derived commit's admission", () => {
    it("is thrown by `applyWaveCommit()` for an operation on the space's ACL document, naming it, and nothing is applied", () => {
      const seqBefore = serverSeq(engine);
      let thrown: unknown;
      try {
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, ["of:derived-data", ACL_ID]),
          commitClass: "derived",
          holder,
          waveBasis: { basisSeq: seqBefore, rebasedHeads: [] },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(DerivedAclDocumentWriteError);
      expect((thrown as DerivedAclDocumentWriteError).operationIndex).toBe(1);
      expect(serverSeq(engine)).toBe(seqBefore);
      expect(read(engine, { id: ACL_ID })?.value).toEqual(GENESIS_ACL);
      expect(read(engine, { id: "of:derived-data" })).toBeNull();
    });

    it("is thrown by `applyCommit()` for a derived commit writing only the ACL document", () => {
      const seqBefore = serverSeq(engine);

      expect(() =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, [ACL_ID]),
          commitClass: "derived",
          holder,
        })
      ).toThrow(DerivedAclDocumentWriteError);
      expect(serverSeq(engine)).toBe(seqBefore);
      expect(read(engine, { id: ACL_ID })?.value).toEqual(GENESIS_ACL);
    });

    it("is not thrown for a derived commit writing other documents", () => {
      const applied = applyWaveCommit(engine, {
        sessionId: holder,
        space: SPACE,
        commit: setCommit(1, ["of:derived-data"]),
        commitClass: "derived",
        holder,
        waveBasis: { basisSeq: serverSeq(engine), rebasedHeads: [] },
      });

      expect(applied.seq).toBe(2);
      expect(read(engine, { id: "of:derived-data" })?.value).toEqual({ n: 1 });
    });
  });
});
