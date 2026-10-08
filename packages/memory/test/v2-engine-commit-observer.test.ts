import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  applyCommit,
  close,
  type CommitDecision,
  type Engine,
  open,
  runAtomicCommit,
} from "../v2/engine.ts";

const space = "did:key:z6Mk-engine-commit-observer-space";

const setOperation = (id: string) => ({
  op: "set" as const,
  id,
  value: { value: { written: true } },
});

const commit = (localSeq: number, ids: string[], extra = {}) => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: ids.map(setOperation),
  ...extra,
});

describe("engine", () => {
  describe("commitObserver", () => {
    let engine: Engine;
    let decisions: CommitDecision[];

    beforeEach(async () => {
      decisions = [];
      engine = await open({
        url: new URL("memory:///engine-commit-observer"),
        commitObserver: (decision) => decisions.push(decision),
      });
    });

    afterEach(() => {
      close(engine);
    });

    it("reports an applied commit as accepted, with what the caller named", () => {
      applyCommit(engine, {
        sessionId: "session:a",
        space,
        principal: "did:key:z6Mk-engine-commit-observer-principal",
        commit: commit(1, ["of:one", "of:two"]),
      });
      expect(decisions).toStrictEqual([{
        space,
        sessionId: "session:a",
        principal: "did:key:z6Mk-engine-commit-observer-principal",
        accepted: true,
        operations: 2,
      }]);
    });

    it("omits the space and the principal the caller did not name", () => {
      applyCommit(engine, {
        sessionId: "session:a",
        commit: commit(1, ["of:one"]),
      });
      expect(decisions).toStrictEqual([{
        sessionId: "session:a",
        accepted: true,
        operations: 1,
      }]);
    });

    it("reports a commit the engine refused as rejected, after the throw", () => {
      applyCommit(engine, {
        sessionId: "session:a",
        commit: commit(1, ["of:one"]),
      });
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:a",
          commit: commit(2, ["of:two"], {
            preconditions: [{ kind: "entity-absent", id: "of:one" }],
          }),
        })
      ).toThrow();
      expect(decisions.map((decision) => decision.accepted)).toEqual([
        true,
        false,
      ]);
      expect(decisions[1].operations).toBe(1);
    });

    it("counts no operations for a refused commit whose operations are not a list", () => {
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:a",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: undefined as never,
          },
        })
      ).toThrow();
      expect(decisions).toStrictEqual([{
        sessionId: "session:a",
        accepted: false,
        operations: 0,
      }]);
    });

    it("reports every commit of one atomic operation once the transaction settles", () => {
      runAtomicCommit(engine, (apply) => {
        apply({ sessionId: "session:a", commit: commit(1, ["of:one"]) });
        expect(decisions).toEqual([]);
        apply({ sessionId: "session:b", commit: commit(1, ["of:two"]) });
      });
      expect(decisions.map((decision) => decision.sessionId)).toEqual([
        "session:a",
        "session:b",
      ]);
      expect(decisions.every((decision) => decision.accepted)).toBe(true);
    });

    it("reports a failed apply the operation caught as rejected, beside the ones that applied", () => {
      applyCommit(engine, {
        sessionId: "session:a",
        commit: commit(1, ["of:one"]),
      });
      runAtomicCommit(engine, (apply) => {
        try {
          apply({
            sessionId: "session:b",
            commit: commit(1, ["of:two"], {
              preconditions: [{ kind: "entity-absent", id: "of:one" }],
            }),
          });
        } catch {
          // The operation carries on past the refused apply.
        }
        apply({ sessionId: "session:c", commit: commit(1, ["of:three"]) });
      });
      expect(
        decisions.map((decision) => [decision.sessionId, decision.accepted]),
      ).toEqual([
        ["session:a", true],
        ["session:b", false],
        ["session:c", true],
      ]);
    });

    it("reports every commit of an atomic operation that rolled back as rejected", () => {
      expect(() =>
        runAtomicCommit(engine, (apply) => {
          apply({ sessionId: "session:a", commit: commit(1, ["of:one"]) });
          throw new Error("rolled back");
        })
      ).toThrow("rolled back");
      expect(decisions).toStrictEqual([{
        sessionId: "session:a",
        accepted: false,
        operations: 1,
      }]);
    });

    it("keeps a commit durable when the observer throws", async () => {
      let calls = 0;
      const throwing = await open({
        url: new URL("memory:///engine-commit-observer-throwing"),
        commitObserver: () => {
          calls++;
          throw new Error("observer failed");
        },
      });
      try {
        const applied = applyCommit(throwing, {
          sessionId: "session:a",
          commit: commit(1, ["of:one"]),
        });
        expect(applied.seq).toBe(1);
        expect(calls).toBe(1);
      } finally {
        close(throwing);
      }
    });
  });
});
