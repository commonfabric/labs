import { ChangeSet } from "@codemirror/state";
import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  applyWaveCommit,
  close,
  ConflictError,
  createBranch,
  type Engine,
  OpCodecError,
  OpCursorMismatchError,
  open,
  OpFieldBaselineMismatchError,
  OpFieldWriteConflictError,
  OpHistoryUnavailableError,
  OpSubmissionMismatchError,
  ProtocolError,
  pruneOperationFieldHistory,
  queryOperationField,
  read,
  UnsupportedOpCodecError,
  WaveCommitConflictError,
} from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
  OperationCodecRegistry,
} from "../v2/operation-codec.ts";
import {
  type AnchorOpOperation,
  type ApplyOpOperation,
  encodeMemoryBoundary,
  type FieldAnchor,
  type Operation,
  operationAnchorsDocId,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  streamEntriesDocId,
  toDocumentPath,
  toValuePath,
} from "../v2.ts";

const changes = (
  length: number,
  from: number,
  insert: string,
): ReturnType<ChangeSet["toJSON"]> =>
  ChangeSet.of({ from, insert }, length).toJSON();

const openTestEngine = async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

describe("v2-operation-engine", () => {
  it("validates operation configuration, addresses, and inactive pruning", async () => {
    await expect(open({
      url: new URL("memory://invalid-operation-checkpoint"),
      operationCheckpointInterval: 0,
    })).rejects.toThrow("positive safe integer");

    const { engine, path } = await openTestEngine();
    try {
      expect(() =>
        queryOperationField(engine, {
          id: "",
          path: toValuePath([]),
        })
      ).toThrow("id is malformed");
      expect(() =>
        queryOperationField(engine, {
          id: "of:missing",
          path: toValuePath([]),
          after: { epoch: 0, version: -1 },
        })
      ).toThrow("cursor is malformed");
      expect(queryOperationField(engine, {
        id: "of:missing",
        path: toValuePath(["absent"]),
      })).toMatchObject({ active: false, materialized: null });
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "",
          path: toValuePath([]),
        })
      ).toThrow("id is malformed");
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "of:missing",
          path: toValuePath([]),
        })
      ).toThrow("only active operation field history");
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("activates a field and atomically materializes its first operation", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "ac" } },
          }],
        },
      });

      const applied = applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("ac"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(2, 1, "b") }],
            },
          }],
        },
      });

      expect(applied.operationResolutions).toHaveLength(1);
      expect(applied.operationResolutions?.[0]).toMatchObject({
        operationIndex: 0,
        submissionId: "alice:1",
        from: { epoch: 1, version: 0 },
        to: { epoch: 1, version: 1 },
        duplicate: false,
      });
      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "abc" },
      });

      const field = queryOperationField(engine, {
        id: "of:collaborative",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      });
      expect(field).toMatchObject({
        active: true,
        codec: CODEMIRROR_CHANGESET_CODEC,
        cursor: { epoch: 1, version: 1 },
        materialized: "abc",
      });
      expect(field.operations).toHaveLength(1);
      expect(field.operations[0].opId).toMatch(/^op:/);
      expect(applied.operationResolutions?.[0].operations[0].opId).toBe(
        field.operations[0].opId,
      );
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("projects collaborative fields through array indexes", async () => {
    const { engine, path } = await openTestEngine();
    try {
      applyCommit(engine, {
        sessionId: "session:array-setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:array-field",
            value: { value: { items: ["a", "b"] } },
          }],
        },
      });
      const applied = applyCommit(engine, {
        sessionId: "session:array-writer",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:array-field",
            path: toValuePath(["items", "1"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "array:1",
            base: null,
            baselineHash: operationBaselineHash("b"),
            payload: {
              updates: [{
                clientId: "array-writer",
                changes: changes(1, 1, "!"),
              }],
            },
          }],
        },
      });

      expect(applied.operationResolutions?.[0].to).toEqual({
        epoch: 1,
        version: 1,
      });
      expect(read(engine, { id: "of:array-field" })).toEqual({
        value: { items: ["a", "b!"] },
      });
      expect(queryOperationField(engine, {
        id: "of:array-field",
        path: toValuePath(["items", "1"]),
      })).toMatchObject({ active: true, materialized: "b!" });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rebases clients that concurrently race to activate one baseline", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:activation-race",
            value: { value: { body: "abc" } },
          }],
        },
      });
      const baselineHash = operationBaselineHash("abc");

      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:activation-race",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash,
            payload: {
              updates: [{ clientId: "alice", changes: changes(3, 1, "X") }],
            },
          }],
        },
      });
      const bob = applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:activation-race",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "bob:1",
            base: null,
            baselineHash,
            payload: {
              updates: [{ clientId: "bob", changes: changes(3, 1, "Y") }],
            },
          }],
        },
      });

      expect(bob.operationResolutions?.[0]).toMatchObject({
        from: { epoch: 1, version: 1 },
        to: { epoch: 1, version: 2 },
      });
      expect(read(engine, { id: "of:activation-race" })).toEqual({
        value: { body: "aXYbc" },
      });
      expect(queryOperationField(engine, {
        id: "of:activation-race",
        path: toValuePath(["body"]),
      })).toMatchObject({
        cursor: { epoch: 1, version: 2 },
        materialized: "aXYbc",
        operations: [{
          cursor: { epoch: 1, version: 1 },
          submissionId: "alice:1",
        }, {
          cursor: { epoch: 1, version: 2 },
          submissionId: "bob:1",
        }],
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rebases stale operations and makes submission ids durable", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "ac" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("ac"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(2, 1, "X") }],
            },
          }],
        },
      });

      const bobCommit = {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op" as const,
          id: "of:collaborative",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "bob:1",
          base: { epoch: 1, version: 0 },
          payload: {
            updates: [{ clientId: "bob", changes: changes(2, 1, "Y") }],
          },
        }],
      };
      const first = applyCommit(engine, {
        sessionId: "session:bob",
        commit: bobCommit,
      });
      const replay = applyCommit(engine, {
        sessionId: "session:bob",
        commit: bobCommit,
      });

      expect(first.operationResolutions?.[0]).toMatchObject({
        from: { epoch: 1, version: 1 },
        to: { epoch: 1, version: 2 },
      });
      expect(replay.operationResolutions).toEqual(first.operationResolutions);
      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "aXYc" },
      });

      const duplicate = applyCommit(engine, {
        sessionId: "session:bob",
        commit: { ...bobCommit, localSeq: 2 },
      });
      expect(duplicate.operationResolutions?.[0]).toMatchObject({
        submissionId: "bob:1",
        to: { epoch: 1, version: 2 },
        duplicate: true,
      });
      expect(
        queryOperationField(engine, {
          id: "of:collaborative",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 0 },
        }).operations,
      ).toHaveLength(2);

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:bob",
          commit: {
            ...bobCommit,
            localSeq: 3,
            operations: [{
              ...bobCommit.operations[0],
              base: { epoch: 1, version: 1 },
            }],
          },
        })
      ).toThrow(OpSubmissionMismatchError);
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:bob",
          commit: {
            ...bobCommit,
            localSeq: 4,
            operations: [{
              ...bobCommit.operations[0],
              base: { epoch: 2, version: 0 },
            }],
          },
        })
      ).toThrow(OpSubmissionMismatchError);
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("checkpoints, prunes, resets stale readers, and rejects stale writers", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({
      url: toFileUrl(path),
      operationCheckpointInterval: 2,
    });

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:retained",
            value: { value: { body: "a" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "of:retained",
          path: toValuePath(["body"]),
        })
      ).toThrow(OpHistoryUnavailableError);
      expect(
        (engine.database.prepare(`
        SELECT COUNT(*) AS count FROM op_integrated
      `).get() as { count: number }).count,
      ).toBe(1);
      applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "bob:1",
            base: { epoch: 1, version: 1 },
            payload: {
              updates: [{ clientId: "bob", changes: changes(2, 2, "c") }],
            },
          }],
        },
      });

      expect(
        engine.database.prepare(`
        SELECT version FROM op_checkpoint ORDER BY version
      `).all(),
      ).toEqual([{ version: 0 }, { version: 2 }]);
      expect(pruneOperationFieldHistory(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
      })).toEqual({
        cursor: { epoch: 1, version: 2 },
        prunedOperations: 2,
      });
      expect(
        (engine.database.prepare(`
        SELECT COUNT(*) AS count FROM op_submission
      `).get() as { count: number }).count,
      ).toBe(2);
      const duplicate = applyCommit(engine, {
        sessionId: "session:duplicate",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      expect(duplicate.operationResolutions?.[0]).toMatchObject({
        duplicate: true,
        from: { epoch: 1, version: 0 },
        to: { epoch: 1, version: 1 },
      });
      expect(read(engine, { id: "of:retained" })).toEqual({
        value: { body: "abc" },
      });

      expect(queryOperationField(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      })).toMatchObject({
        cursor: { epoch: 1, version: 2 },
        materialized: "abc",
        retainedFrom: { epoch: 1, version: 2 },
        reset: true,
        operations: [],
      });
      expect(queryOperationField(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
      })).toMatchObject({
        retainedFrom: { epoch: 1, version: 2 },
        reset: true,
        operations: [],
      });
      expect(queryOperationField(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
        after: { epoch: 99, version: 0 },
      })).toMatchObject({
        reset: true,
        operations: [],
      });
      expect(() =>
        queryOperationField(engine, {
          id: "of:retained",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 3 },
        })
      ).toThrow(OpCursorMismatchError);

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:stale",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:retained",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "stale:1",
              base: { epoch: 1, version: 0 },
              payload: {
                updates: [{
                  clientId: "stale",
                  changes: changes(1, 1, "x"),
                }],
              },
            }],
          },
        })
      ).toThrow(OpHistoryUnavailableError);
      expect(read(engine, { id: "of:retained" })).toEqual({
        value: { body: "abc" },
      });
      expect(
        (engine.database.prepare(`
        SELECT COUNT(*) AS count FROM op_submission
      `).get() as { count: number }).count,
      ).toBe(2);

      applyCommit(engine, {
        sessionId: "session:fresh",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "fresh:1",
            base: { epoch: 1, version: 2 },
            payload: {
              updates: [{
                clientId: "fresh",
                changes: changes(3, 3, "d"),
              }],
            },
          }],
        },
      });
      expect(queryOperationField(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 2 },
      })).toMatchObject({
        cursor: { epoch: 1, version: 3 },
        materialized: "abcd",
        retainedFrom: { epoch: 1, version: 2 },
        operations: [{ cursor: { epoch: 1, version: 3 } }],
      });

      expect(pruneOperationFieldHistory(engine, {
        id: "of:retained",
        path: toValuePath(["body"]),
      })).toEqual({
        cursor: { epoch: 1, version: 2 },
        prunedOperations: 0,
      });
      const replay = engine.database.prepare(`
        SELECT payload FROM op_integrated WHERE id = ? AND version = 3
      `).get("of:retained") as { payload: string };
      engine.database.prepare(`
        UPDATE op_integrated SET payload = ? WHERE id = ? AND version = 3
      `).run(
        encodeMemoryBoundary({ updates: [] }),
        "of:retained",
      );
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "of:retained",
          path: toValuePath(["body"]),
        })
      ).toThrow("did not reproduce integrated history");
      engine.database.prepare(`
        UPDATE op_integrated SET payload = ? WHERE id = ? AND version = 3
      `).run(replay.payload, "of:retained");

      engine.database.prepare(`
        UPDATE op_field_epoch SET materialized = ? WHERE id = ?
      `).run(encodeMemoryBoundary("wrong"), "of:retained");
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "of:retained",
          path: toValuePath(["body"]),
        })
      ).toThrow("checkpoint diverged");
      engine.database.prepare(`
        UPDATE op_field_epoch SET materialized = ? WHERE id = ?
      `).run(encodeMemoryBoundary("abcd"), "of:retained");

      engine.database.prepare(`
        DELETE FROM op_integrated WHERE id = ? AND version = 3
      `).run("of:retained");
      expect(() =>
        pruneOperationFieldHistory(engine, {
          id: "of:retained",
          path: toValuePath(["body"]),
        })
      ).toThrow("not contiguous");
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("compacts one checkpoint behind without resetting current readers", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({
      url: toFileUrl(path),
      operationCheckpointInterval: 2,
    });

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:auto-retained",
            value: { value: { body: "" } },
          }],
        },
      });
      for (let version = 0; version < 4; version++) {
        applyCommit(engine, {
          sessionId: "session:writer",
          commit: {
            localSeq: version + 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:auto-retained",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: `writer:${version + 1}`,
              base: version === 0 ? null : { epoch: 1, version },
              ...(version === 0
                ? { baselineHash: operationBaselineHash("") }
                : {}),
              payload: {
                updates: [{
                  clientId: "writer",
                  changes: changes(version, version, String(version + 1)),
                }],
              },
            }],
          },
        });
      }

      expect(
        engine.database.prepare(`
          SELECT version FROM op_checkpoint ORDER BY version
        `).all(),
      ).toEqual([{ version: 0 }, { version: 2 }, { version: 4 }]);
      expect(
        engine.database.prepare(`
          SELECT version FROM op_integrated ORDER BY version
        `).all(),
      ).toEqual([{ version: 3 }, { version: 4 }]);
      expect(queryOperationField(engine, {
        id: "of:auto-retained",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 2 },
      })).toMatchObject({
        retainedFrom: { epoch: 1, version: 2 },
        operations: [{ cursor: { epoch: 1, version: 3 } }, {
          cursor: { epoch: 1, version: 4 },
        }],
      });
      expect(queryOperationField(engine, {
        id: "of:auto-retained",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 1 },
      })).toMatchObject({
        retainedFrom: { epoch: 1, version: 2 },
        reset: true,
        operations: [],
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rejects collaborative fields on child branches", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:branch",
            value: { value: { body: "a" } },
          }],
        },
      });
      createBranch(engine, "feature");

      expect(() =>
        queryOperationField(engine, {
          id: "of:branch",
          branch: "feature",
          path: toValuePath(["body"]),
        })
      ).toThrow(ProtocolError);
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:feature",
          commit: {
            branch: "feature",
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:branch",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "feature:1",
              base: null,
              baselineHash: operationBaselineHash("a"),
              payload: {
                updates: [{
                  clientId: "feature",
                  changes: changes(1, 1, "b"),
                }],
              },
            }],
          },
        })
      ).toThrow(ProtocolError);
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:feature-release",
          commit: {
            branch: "feature",
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "release-op-field",
              id: "of:branch",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              cursor: { epoch: 1, version: 1 },
            }],
          },
        })
      ).toThrow(ProtocolError);
      expect(queryOperationField(engine, {
        id: "of:branch",
        path: toValuePath(["body"]),
      })).toMatchObject({ active: false, operations: [] });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("requires release before an ordinary write changes an active field", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "ac", title: "Draft" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("ac"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(2, 1, "b") }],
            },
          }],
        },
      });

      const rejectApply = (
        sessionId: string,
        overrides: Partial<ApplyOpOperation>,
        error: new (message: string) => Error,
      ) => {
        expect(() =>
          applyCommit(engine, {
            sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "apply-op",
                id: "of:collaborative",
                path: toValuePath(["body"]),
                codec: CODEMIRROR_CHANGESET_CODEC,
                submissionId: sessionId,
                base: { epoch: 1, version: 1 },
                payload: {
                  updates: [{
                    clientId: sessionId,
                    changes: changes(3, 3, "!"),
                  }],
                },
                ...overrides,
              }],
            },
          })
        ).toThrow(error);
      };
      rejectApply(
        "session:apply-codec-change",
        { codec: "other@1" },
        OpCodecError,
      );
      rejectApply(
        "session:apply-baseline-mismatch",
        { base: null, baselineHash: operationBaselineHash("stale") },
        OpFieldBaselineMismatchError,
      );
      rejectApply(
        "session:apply-epoch-mismatch",
        { base: { epoch: 2, version: 1 } },
        OpCursorMismatchError,
      );
      rejectApply(
        "session:apply-future",
        { base: { epoch: 1, version: 2 } },
        OpCursorMismatchError,
      );

      const rejectRelease = (
        sessionId: string,
        overrides: Record<string, unknown>,
        error: new (message: string) => Error,
      ) => {
        expect(() =>
          applyCommit(engine, {
            sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "release-op-field",
                id: "of:collaborative",
                path: toValuePath(["body"]),
                codec: CODEMIRROR_CHANGESET_CODEC,
                cursor: { epoch: 1, version: 1 },
                ...overrides,
              } as never],
            },
          })
        ).toThrow(error);
      };
      rejectRelease(
        "session:release-malformed-cursor",
        { cursor: { epoch: 0, version: -1 } },
        OpCursorMismatchError,
      );
      rejectRelease(
        "session:release-malformed-codec",
        { codec: 1 },
        OpCodecError,
      );
      rejectRelease(
        "session:release-stale",
        { cursor: { epoch: 1, version: 0 } },
        OpCursorMismatchError,
      );
      rejectRelease(
        "session:release-codec",
        { codec: "other@1" },
        OpCodecError,
      );

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:ordinary-remove",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: "of:collaborative",
              patches: [{ op: "remove", path: "/value/body" }],
            }],
          },
        })
      ).toThrow(OpFieldWriteConflictError);

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:ordinary",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: "of:collaborative",
              patches: [{
                op: "replace",
                path: "/value/body",
                value: "overwritten",
              }],
            }],
          },
        })
      ).toThrow(OpFieldWriteConflictError);

      applyCommit(engine, {
        sessionId: "session:ordinary",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "of:collaborative",
            patches: [{
              op: "replace",
              path: "/value/title",
              value: "Ready",
            }],
          }],
        },
      });

      applyCommit(engine, {
        sessionId: "session:ordinary",
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "release-op-field",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            cursor: { epoch: 1, version: 1 },
          }, {
            op: "patch",
            id: "of:collaborative",
            patches: [{
              op: "replace",
              path: "/value/body",
              value: "released",
            }],
          }],
        },
      });

      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "released", title: "Ready" },
      });
      expect(
        queryOperationField(engine, {
          id: "of:collaborative",
          path: toValuePath(["body"]),
        }),
      ).toMatchObject({
        active: false,
        cursor: null,
        materialized: "released",
      });

      const reopened = applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            // Submission ids are epoch-local, so reusing one after deliberate
            // release starts a new operation rather than replaying epoch one.
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("released"),
            payload: {
              updates: [{
                clientId: "alice",
                changes: changes(8, 8, "!"),
              }],
            },
          }],
        },
      });
      expect(reopened.operationResolutions?.[0]).toMatchObject({
        from: { epoch: 2, version: 0 },
        to: { epoch: 2, version: 1 },
        duplicate: false,
      });
      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "released!", title: "Ready" },
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("releases active fields when their owning entity is deleted", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:deleted-collaboration",
            value: { value: { body: "a" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:deleted-collaboration",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:deleter",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "delete", id: "of:deleted-collaboration" }],
        },
      });

      expect(queryOperationField(engine, {
        id: "of:deleted-collaboration",
        path: toValuePath(["body"]),
      })).toMatchObject({
        active: false,
        cursor: null,
        materialized: null,
        operations: [],
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("applies operations against earlier results in the same commit", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "old" } },
          }],
        },
      });

      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "abc" } },
          }, {
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("abc"),
            payload: {
              updates: [{
                clientId: "alice",
                changes: changes(3, 3, "!"),
              }],
            },
          }],
        },
      });

      expect(read(engine, { id: "of:collaborative" })).toEqual({
        value: { body: "abc!" },
      });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rejects malformed operation inputs without mutating durable state", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:malformed",
            value: { value: { body: "abc", items: ["x"] } },
          }],
        },
      });
      const baselineHash = operationBaselineHash("abc");
      const counts = () => ({
        commits: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM "commit"`,
        ).get() as { count: number }).count,
        revisions: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM revision`,
        ).get() as { count: number }).count,
        fields: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM op_field_epoch`,
        ).get() as { count: number }).count,
        checkpoints: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM op_checkpoint`,
        ).get() as { count: number }).count,
        submissions: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM op_submission`,
        ).get() as { count: number }).count,
        integrated: (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM op_integrated`,
        ).get() as { count: number }).count,
      });
      const before = counts();
      const operation: ApplyOpOperation = {
        op: "apply-op",
        id: "of:malformed",
        path: toValuePath(["body"]),
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: "malformed:1",
        base: null,
        baselineHash,
        payload: {
          updates: [{ clientId: "client", changes: changes(3, 1, "X") }],
        },
      };
      const fail = (
        candidate: ApplyOpOperation,
        error: new (message: string) => Error,
      ) => {
        expect(() =>
          applyCommit(engine, {
            sessionId: "session:malformed",
            commitClass: "authored",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [candidate],
            },
          })
        ).toThrow(error);
        expect(counts()).toEqual(before);
        expect(read(engine, { id: "of:malformed" })).toEqual({
          value: { body: "abc", items: ["x"] },
        });
        expect(queryOperationField(engine, {
          id: "of:malformed",
          path: toValuePath(["body"]),
        })).toMatchObject({ active: false, cursor: null, operations: [] });
      };

      fail({ ...operation, codec: "unknown@1" }, UnsupportedOpCodecError);
      fail({ ...operation, id: "" }, ProtocolError);
      fail({ ...operation, codec: "codemirror" }, ProtocolError);
      fail({ ...operation, submissionId: "" }, ProtocolError);
      fail({
        ...operation,
        path: toValuePath(Array.from({ length: 257 }, () => "body")),
      }, ProtocolError);
      fail({
        ...operation,
        path: toValuePath(["items", "not-an-index"]),
      }, ProtocolError);
      fail({
        ...operation,
        base: { epoch: 0, version: 0 },
        baselineHash: undefined,
      }, OpCursorMismatchError);
      fail({ ...operation, baselineHash: "" }, OpFieldBaselineMismatchError);
      fail({
        ...operation,
        base: { epoch: 1, version: 0 },
      }, OpFieldBaselineMismatchError);
      fail(
        { ...operation, baselineHash: operationBaselineHash("stale") },
        OpFieldBaselineMismatchError,
      );
      fail({
        ...operation,
        base: { epoch: 1, version: 0 },
        baselineHash: undefined,
      }, OpCursorMismatchError);
      fail({
        ...operation,
        payload: {
          updates: [{ clientId: "client", changes: [999] }],
        },
      }, OpCodecError);
      fail({
        ...operation,
        payload: {
          updates: Array.from({ length: 257 }, (_, index) => ({
            clientId: `client:${index}`,
            changes: changes(3, 1, ""),
          })),
        },
      }, OpCodecError);
      fail({
        ...operation,
        payload: { oversized: "x".repeat(1_000_001) },
      }, OpCodecError);
      fail({
        ...operation,
        payload: { oversized: "é".repeat(600_000) },
      }, OpCodecError);
      const streamOperation: ApplyOpOperation = {
        ...operation,
        id: streamEntriesDocId({ id: "of:stream", path: ["events"] }),
        path: toValuePath([]),
        baselineHash: operationBaselineHash(null),
      };
      setServerExecutionConfig(true);
      try {
        expect(() =>
          applyCommit(engine, {
            sessionId: "session:malformed",
            commitClass: "authored",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [streamOperation],
            },
          })
        ).toThrow("apply-op cannot mutate a stream sidecar document");
      } finally {
        resetServerExecutionConfig();
      }
      expect(counts()).toEqual(before);
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rejects invalid codec results without mutating materialized state", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({
      url: toFileUrl(path),
      operationCodecs: new OperationCodecRegistry([{
        id: "empty-change@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: () => ({ materialized: "changed", operations: [] }),
      }, {
        id: "too-many@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: ({ materialized }) => ({
          materialized,
          operations: Array.from({ length: 257 }, () => "operation"),
        }),
      }, {
        id: "invalid-materialized@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: () => ({
          materialized: (() => {}) as never,
          operations: ["operation"],
        }),
      }, {
        id: "invalid-operation@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: ({ materialized }) => ({
          materialized,
          operations: [(() => {}) as never],
        }),
      }, {
        id: "large-materialized@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: () => ({
          materialized: "x".repeat(1_000_001),
          operations: ["operation"],
        }),
      }, {
        id: "large-operation@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: ({ materialized }) => ({
          materialized,
          operations: ["x".repeat(1_000_001)],
        }),
      }, {
        id: "multibyte-materialized@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: () => ({
          materialized: "é".repeat(600_000),
          operations: ["operation"],
        }),
      }, {
        id: "multibyte-operation@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: ({ materialized }) => ({
          materialized,
          operations: ["é".repeat(600_000)],
        }),
      }, {
        id: "throw-value@1",
        mapAnchors: ({ anchors }) => [...anchors],
        integrate: () => {
          throw "codec rejection";
        },
      }]),
    });

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:empty-change",
            value: { value: { body: "original" } },
          }],
        },
      });

      for (
        const codec of [
          "empty-change@1",
          "too-many@1",
          "invalid-materialized@1",
          "invalid-operation@1",
          "large-materialized@1",
          "large-operation@1",
          "multibyte-materialized@1",
          "multibyte-operation@1",
          "throw-value@1",
        ]
      ) {
        expect(() =>
          applyCommit(engine, {
            sessionId: `session:${codec}`,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "apply-op",
                id: "of:empty-change",
                path: toValuePath(["body"]),
                codec,
                submissionId: `submission:${codec}`,
                base: null,
                baselineHash: operationBaselineHash("original"),
                payload: {},
              }],
            },
          })
        ).toThrow(OpCodecError);
      }
      expect(read(engine, { id: "of:empty-change" })).toEqual({
        value: { body: "original" },
      });
      expect(queryOperationField(engine, {
        id: "of:empty-change",
        path: toValuePath(["body"]),
      })).toMatchObject({ active: false, cursor: null });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("detects durable entity divergence beneath an active field", async () => {
    const { engine, path } = await openTestEngine();
    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:diverged",
            value: { value: { body: "a" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:writer",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:diverged",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "writer:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "writer", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      engine.database.prepare(`
        UPDATE revision SET data = ?
        WHERE id = ? AND op = 'patch'
      `).run(
        encodeMemoryBoundary([{
          op: "replace",
          path: "/value/body",
          value: "corrupt",
        }]),
        "of:diverged",
      );
      expect(() =>
        applyCommit(engine, {
          sessionId: "session:writer",
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:diverged",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "writer:2",
              base: { epoch: 1, version: 1 },
              payload: { updates: [] },
            }],
          },
        })
      ).toThrow("materialization diverged");

      engine.database.prepare("DELETE FROM revision WHERE id = ?").run(
        "of:diverged",
      );
      expect(() =>
        queryOperationField(engine, {
          id: "of:diverged",
          path: toValuePath(["body"]),
        })
      ).toThrow("field path is missing");
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("rolls back integrated rows when a later operation rejects the commit", async () => {
    const { engine, path } = await openTestEngine();

    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:rollback",
            value: { value: { body: "abc" } },
          }],
        },
      });
      const count = (table: string): number =>
        (engine.database.prepare(
          `SELECT COUNT(*) AS count FROM ${table}`,
        ).get() as { count: number }).count;
      const before = {
        commits: count('"commit"'),
        revisions: count("revision"),
        fields: count("op_field_epoch"),
        checkpoints: count("op_checkpoint"),
        submissions: count("op_submission"),
        integrated: count("op_integrated"),
      };

      expect(() =>
        applyCommit(engine, {
          sessionId: "session:rollback",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:rollback",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "rollback:1",
              base: null,
              baselineHash: operationBaselineHash("abc"),
              payload: {
                updates: [{
                  clientId: "client",
                  changes: changes(3, 3, "!"),
                }],
              },
            }, {
              op: "patch",
              id: "of:rollback",
              patches: [{
                op: "replace",
                path: "/value/body",
                value: "overwritten",
              }],
            }],
          },
        })
      ).toThrow(OpFieldWriteConflictError);

      expect({
        commits: count('"commit"'),
        revisions: count("revision"),
        fields: count("op_field_epoch"),
        checkpoints: count("op_checkpoint"),
        submissions: count("op_submission"),
        integrated: count("op_integrated"),
      }).toEqual(before);
      expect(read(engine, { id: "of:rollback" })).toEqual({
        value: { body: "abc" },
      });
      expect(queryOperationField(engine, {
        id: "of:rollback",
        path: toValuePath(["body"]),
      })).toMatchObject({ active: false, cursor: null, operations: [] });
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });

  it("migrates integrated histories to stable operation ids", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const url = toFileUrl(path);
    let engine: Awaited<ReturnType<typeof open>> | undefined;

    try {
      engine = await open({ url });
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:migration",
            value: { value: { body: "a" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:migration",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(1, 1, "b") }],
            },
          }],
        },
      });
      const originalId = queryOperationField(engine, {
        id: "of:migration",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      }).operations[0].opId;
      close(engine);
      engine = undefined;

      const legacy = new Database(path);
      try {
        legacy.exec(`
          PRAGMA foreign_keys = OFF;
          ALTER TABLE op_integrated
            RENAME TO op_integrated_without_ids;
          CREATE TABLE op_integrated (
            branch         TEXT    NOT NULL DEFAULT '',
            id             TEXT    NOT NULL,
            scope_key      TEXT    NOT NULL DEFAULT 'space',
            path           JSON    NOT NULL,
            epoch          INTEGER NOT NULL,
            version        INTEGER NOT NULL,
            submission_id  TEXT    NOT NULL,
            payload        JSON    NOT NULL,
            commit_seq     INTEGER NOT NULL,
            PRIMARY KEY (branch, id, scope_key, path, epoch, version),
            FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
          );
          INSERT INTO op_integrated (
            branch, id, scope_key, path, epoch, version,
            submission_id, payload, commit_seq
          )
          SELECT branch, id, scope_key, path, epoch, version,
                 submission_id, payload, commit_seq
          FROM op_integrated_without_ids;
          DROP TABLE op_integrated_without_ids;
        `);
      } finally {
        legacy.close();
      }

      engine = await open({ url });
      const migrated = queryOperationField(engine, {
        id: "of:migration",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      });
      expect(migrated.operations[0].opId).toBe(originalId);
      expect(
        (engine.database.prepare(`PRAGMA table_info("op_integrated")`)
          .all() as Array<{ name: string; notnull: number }>).find((column) =>
            column.name === "op_id"
          ),
      ).toMatchObject({ notnull: 1 });
    } finally {
      if (engine !== undefined) close(engine);
      await Deno.remove(path);
    }
  });

  describe("an `apply-op` without a base", () => {
    // Each case but the last seeds `of:collaborative` with `body: "ac"`, opens
    // a field epoch on it with `alice` typing a `b`, and has `bob` type a `d`
    // at the end, so the field holds `abcd` at version 2 and a submission
    // written against version 1 would need rebasing.

    const seed = (engine: Awaited<ReturnType<typeof open>>): number => {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:collaborative",
            value: { value: { body: "ac" } },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("ac"),
            payload: {
              updates: [{ clientId: "alice", changes: changes(2, 1, "b") }],
            },
          }],
        },
      });
      return applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:collaborative",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "bob:1",
            base: { epoch: 1, version: 1 },
            payload: {
              updates: [{ clientId: "bob", changes: changes(3, 3, "d") }],
            },
          }],
        },
      }).seq;
    };

    /** An insertion of `insert` at the end of `computedFrom`, with no base. */
    const unbased = (
      submissionId: string,
      computedFrom: string,
      insert: string,
    ): ApplyOpOperation => ({
      op: "apply-op",
      id: "of:collaborative",
      path: toValuePath(["body"]),
      codec: CODEMIRROR_CHANGESET_CODEC,
      submissionId,
      payload: {
        updates: [{
          clientId: "agent",
          changes: changes(computedFrom.length, computedFrom.length, insert),
        }],
      },
    });

    /** A confirmed read of `path` in `of:collaborative` at `seq`. */
    const readAt = (
      seq: number,
      path: readonly string[] = ["value", "body"],
      nonRecursive?: true,
    ) => ({
      confirmed: [{
        id: "of:collaborative",
        path: toDocumentPath(path),
        seq,
        ...(nonRecursive ? { nonRecursive } : {}),
      }],
      pending: [],
    });

    it("applies at the field's current version beside a current read of the field", async () => {
      const { engine, path } = await openTestEngine();
      try {
        const seededSeq = seed(engine);
        const applied = applyCommit(engine, {
          sessionId: "session:agent",
          commit: {
            localSeq: 1,
            reads: readAt(seededSeq),
            operations: [unbased("agent:1", "abcd", "!")],
          },
        });

        expect(applied.operationResolutions?.[0]).toMatchObject({
          from: { epoch: 1, version: 2 },
          to: { epoch: 1, version: 3 },
          duplicate: false,
        });
        expect(read(engine, { id: "of:collaborative" })).toEqual({
          value: { body: "abcd!" },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("throws `ConflictError` from a stale read of the field before the operation is considered", async () => {
      const { engine, path } = await openTestEngine();
      try {
        const seededSeq = seed(engine);

        // The read predates `bob`'s `d`, and so does the payload.
        let thrown: unknown;
        try {
          applyCommit(engine, {
            sessionId: "session:agent",
            commit: {
              localSeq: 1,
              reads: readAt(seededSeq - 1),
              operations: [unbased("agent:1", "abc", "!")],
            },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ConflictError);
        expect(read(engine, { id: "of:collaborative" })).toEqual({
          value: { body: "abcd" },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("applies blind at the field's current version without a read or a hash", async () => {
      const { engine, path } = await openTestEngine();
      try {
        seed(engine);
        applyCommit(engine, {
          sessionId: "session:agent",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [unbased("agent:1", "abcd", "!")],
          },
        });

        expect(read(engine, { id: "of:collaborative" })).toEqual({
          value: { body: "abcd!" },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("applies beside a recursive pending read of the field", async () => {
      const { engine, path } = await openTestEngine();
      try {
        const seededSeq = seed(engine);
        applyCommit(engine, {
          sessionId: "session:agent",
          commit: {
            localSeq: 1,
            reads: readAt(seededSeq),
            operations: [unbased("agent:1", "abcd", "!")],
          },
        });
        applyCommit(engine, {
          sessionId: "session:agent",
          commit: {
            localSeq: 2,
            reads: {
              confirmed: [],
              pending: [{
                id: "of:collaborative",
                path: toDocumentPath(["value", "body"]),
                localSeq: 1,
              }],
            },
            operations: [unbased("agent:2", "abcd!", "?")],
          },
        });

        expect(read(engine, { id: "of:collaborative" })).toEqual({
          value: { body: "abcd!?" },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("applies after an earlier write to another field of the document", async () => {
      const { engine, path } = await openTestEngine();
      try {
        const seededSeq = seed(engine);
        applyCommit(engine, {
          sessionId: "session:agent",
          commit: {
            localSeq: 1,
            reads: readAt(seededSeq),
            operations: [
              {
                op: "patch",
                id: "of:collaborative",
                patches: [{ op: "replace", path: "/value/title", value: "T" }],
              },
              unbased("agent:1", "abcd", "!"),
            ],
          },
        });

        expect(read(engine, { id: "of:collaborative" })).toEqual({
          value: { body: "abcd!", title: "T" },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("activates an inactive field from the value it holds", async () => {
      const { engine, path } = await openTestEngine();
      try {
        const setup = applyCommit(engine, {
          sessionId: "session:setup",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:collaborative",
              value: { value: { body: "abcd" } },
            }],
          },
        });
        const applied = applyCommit(engine, {
          sessionId: "session:agent",
          commit: {
            localSeq: 1,
            reads: readAt(setup.seq),
            operations: [unbased("agent:1", "abcd", "!")],
          },
        });

        expect(applied.operationResolutions?.[0]).toMatchObject({
          from: { epoch: 1, version: 0 },
          to: { epoch: 1, version: 1 },
        });
        expect(
          queryOperationField(engine, {
            id: "of:collaborative",
            path: toValuePath(["body"]),
          }),
        ).toMatchObject({
          active: true,
          baselineHash: operationBaselineHash("abcd"),
          materialized: "abcd!",
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("applies blind to the value an earlier operation in the commit left at the field", async () => {
      const { engine, path } = await openTestEngine();
      try {
        const setup = applyCommit(engine, {
          sessionId: "session:setup",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:collaborative",
              value: { value: { body: "abcd" } },
            }],
          },
        });

        // The read holds, since nothing moved the field before the commit;
        // the edit was computed from `abcd`, and lands on what the patch left.
        applyCommit(engine, {
          sessionId: "session:agent",
          commit: {
            localSeq: 1,
            reads: readAt(setup.seq),
            operations: [
              {
                op: "patch",
                id: "of:collaborative",
                patches: [{
                  op: "replace",
                  path: "/value/body",
                  value: "wxyz",
                }],
              },
              unbased("agent:1", "abcd", "!"),
            ],
          },
        });

        expect(read(engine, { id: "of:collaborative" })).toEqual({
          value: { body: "wxyz!" },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("returns the stored result for a resend of its commit", async () => {
      const { engine, path } = await openTestEngine();
      try {
        const seededSeq = seed(engine);
        const commit = {
          localSeq: 1,
          reads: readAt(seededSeq),
          operations: [unbased("agent:1", "abcd", "!")],
        };
        const original = applyCommit(engine, {
          sessionId: "session:agent",
          commit,
        });
        const resent = applyCommit(engine, {
          sessionId: "session:agent",
          commit,
        });

        expect(resent.seq).toBe(original.seq);
        expect(resent.operationResolutions).toEqual(
          original.operationResolutions,
        );
        expect(read(engine, { id: "of:collaborative" })).toEqual({
          value: { body: "abcd!" },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("throws `OpSubmissionMismatchError` for its submission id in a later commit", async () => {
      const { engine, path } = await openTestEngine();
      try {
        const seededSeq = seed(engine);
        const operation = unbased("agent:1", "abcd", "!");
        const original = applyCommit(engine, {
          sessionId: "session:agent",
          commit: {
            localSeq: 1,
            reads: readAt(seededSeq),
            operations: [operation],
          },
        });

        // The id landed against version 2; the later commit's read stands for
        // version 3, the one the first submission left.
        expect(() =>
          applyCommit(engine, {
            sessionId: "session:agent",
            commit: {
              localSeq: 2,
              reads: readAt(original.seq),
              operations: [operation],
            },
          })
        ).toThrow(OpSubmissionMismatchError);
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    describe("with a baseline hash", () => {
      // The hash names the value the payload was computed from, so these
      // commits carry no read of the field.

      /** Like `unbased()`, with the hash of `computedFrom`. */
      const hashed = (
        submissionId: string,
        computedFrom: string,
        insert: string,
      ): ApplyOpOperation => ({
        ...unbased(submissionId, computedFrom, insert),
        baselineHash: operationBaselineHash(computedFrom),
      });

      it("applies at the field's current version when the hash names the value the field holds", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(engine);
          const applied = applyCommit(engine, {
            sessionId: "session:agent",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [hashed("agent:1", "abcd", "!")],
            },
          });

          expect(applied.operationResolutions?.[0]).toMatchObject({
            from: { epoch: 1, version: 2 },
            to: { epoch: 1, version: 3 },
          });
          expect(read(engine, { id: "of:collaborative" })).toEqual({
            value: { body: "abcd!" },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `OpFieldBaselineMismatchError` when the hash names a value the field no longer holds", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(engine);

          expect(() =>
            applyCommit(engine, {
              sessionId: "session:agent",
              commit: {
                localSeq: 1,
                reads: { confirmed: [], pending: [] },
                operations: [hashed("agent:1", "abc", "!")],
              },
            })
          ).toThrow(OpFieldBaselineMismatchError);
          expect(read(engine, { id: "of:collaborative" })).toEqual({
            value: { body: "abcd" },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("applies a second edit whose hash names the value the first one left", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(engine);
          applyCommit(engine, {
            sessionId: "session:agent",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [
                hashed("agent:1", "abcd", "!"),
                hashed("agent:2", "abcd!", "?"),
              ],
            },
          });

          expect(read(engine, { id: "of:collaborative" })).toEqual({
            value: { body: "abcd!?" },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `WaveCommitConflictError` naming the document when a wave commit's edit is stale", async () => {
        const { engine, path } = await openTestEngine();
        setServerExecutionConfig(true);
        try {
          const seededSeq = seed(engine);
          const space = "did:key:z6Mk-operation-wave-space";
          const holder = executionLeaseHolder(`service:${space}`);
          expect(acquireExecutionLease(engine, { space, holder })).toBe(true);

          let thrown: unknown;
          try {
            applyWaveCommit(engine, {
              sessionId: holder,
              space,
              commit: {
                localSeq: 1,
                reads: { confirmed: [], pending: [] },
                operations: [hashed("agent:1", "abc", "!")],
              },
              commitClass: "derived",
              holder,
              waveBasis: { basisSeq: seededSeq, rebasedHeads: [] },
            });
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(WaveCommitConflictError);
          expect((thrown as WaveCommitConflictError).conflictedDocs).toEqual([
            "of:collaborative space",
          ]);
          expect(read(engine, { id: "of:collaborative" })).toEqual({
            value: { body: "abcd" },
          });
        } finally {
          resetServerExecutionConfig();
          close(engine);
          await Deno.remove(path);
        }
      });
    });
  });

  describe("anchor-op", () => {
    const body = toValuePath(["body"]);
    const setup = (engine: Engine, id: string, text: string) =>
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: ++seq,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value: { value: { body: text } } }],
        },
      });
    const applyOp = (
      id: string,
      submissionId: string,
      base: { epoch: number; version: number } | string,
      changes: ReturnType<ChangeSet["toJSON"]>,
    ): ApplyOpOperation => ({
      op: "apply-op",
      id,
      path: body,
      codec: CODEMIRROR_CHANGESET_CODEC,
      submissionId,
      ...(typeof base === "string"
        ? { base: null, baselineHash: operationBaselineHash(base) }
        : { base }),
      payload: { updates: [{ clientId: "alice", changes }] },
    });
    const anchorOp = (
      id: string,
      base: { epoch: number; version: number } | string,
      edits: { add?: FieldAnchor[]; remove?: string[] },
    ): AnchorOpOperation => ({
      op: "anchor-op",
      id,
      path: body,
      codec: CODEMIRROR_CHANGESET_CODEC,
      ...(typeof base === "string"
        ? { base: null, baselineHash: operationBaselineHash(base) }
        : { base }),
      ...edits,
    });
    const anchorsDoc = (id: string) =>
      operationAnchorsDocId({ id, path: ["body"] });
    let seq = 0;
    const commit = (
      engine: Engine,
      operations: Operation[],
      session = "session:alice",
    ) =>
      applyCommit(engine, {
        sessionId: session,
        commit: {
          localSeq: ++seq,
          reads: { confirmed: [], pending: [] },
          operations,
        },
      });

    it("activates an inactive field, stores the anchors, and writes their document", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:anchored", "hello world");
        const applied = commit(engine, [
          anchorOp("of:anchored", "hello world", {
            add: [{ id: "w", from: 6, to: 11 }, { id: "h", from: 0, to: 5 }],
          }),
        ]);
        expect(applied.anchorResolutions).toEqual([{
          operationIndex: 0,
          address: {
            branch: "",
            id: "of:anchored",
            scopeKey: "space",
            path: body,
          },
          codec: CODEMIRROR_CHANGESET_CODEC,
          cursor: { epoch: 1, version: 0 },
          anchors: [{ id: "w", from: 6, to: 11 }, { id: "h", from: 0, to: 5 }],
          removed: [],
        }]);
        expect(applied.revisions.map((revision) => revision.id)).toEqual([
          anchorsDoc("of:anchored"),
        ]);
        const field = queryOperationField(engine, {
          id: "of:anchored",
          path: body,
        });
        expect(field).toMatchObject({
          active: true,
          cursor: { epoch: 1, version: 0 },
          materialized: "hello world",
          anchors: [{ id: "h", from: 0, to: 5 }, { id: "w", from: 6, to: 11 }],
        });
        expect(read(engine, { id: anchorsDoc("of:anchored") })).toEqual({
          value: {
            epoch: 1,
            version: 0,
            anchors: [{ id: "h", from: 0, to: 5 }, {
              id: "w",
              from: 6,
              to: 11,
            }],
          },
        });
        expect(
          engine.database.prepare(
            `SELECT version, anchors FROM op_checkpoint`,
          ).all(),
        ).toEqual([{
          version: 0,
          anchors: encodeMemoryBoundary([
            { id: "h", from: 0, to: 5 },
            { id: "w", from: 6, to: 11 },
          ]),
        }]);
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("maps an anchor stated at an older base through the integrated suffix", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:stale", "world");
        commit(engine, [
          applyOp("of:stale", "alice:1", "world", changes(5, 0, "hello ")),
        ]);
        // Stated against "world" at version 0: "world" is 0..5 there.
        const applied = commit(engine, [
          anchorOp("of:stale", { epoch: 1, version: 0 }, {
            add: [{ id: "w", from: 0, to: 5 }],
          }),
        ]);
        expect(applied.anchorResolutions?.[0]).toMatchObject({
          cursor: { epoch: 1, version: 1 },
          anchors: [{ id: "w", from: 6, to: 11 }],
        });
        expect(read(engine, { id: anchorsDoc("of:stale") })).toEqual({
          value: {
            epoch: 1,
            version: 1,
            anchors: [{ id: "w", from: 6, to: 11 }],
          },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("moves the stored anchors in the transaction that integrates an edit", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:moving", "hello world");
        commit(engine, [
          anchorOp("of:moving", "hello world", {
            add: [{ id: "w", from: 6, to: 11 }, { id: "h", from: 0, to: 5 }],
          }),
        ]);
        const inserted = commit(engine, [
          applyOp(
            "of:moving",
            "alice:1",
            { epoch: 1, version: 0 },
            changes(11, 0, ">> "),
          ),
        ]);
        expect(inserted.revisions.map((revision) => revision.id)).toEqual([
          "of:moving",
          anchorsDoc("of:moving"),
        ]);
        expect(read(engine, { id: anchorsDoc("of:moving") })).toEqual({
          value: {
            epoch: 1,
            version: 1,
            anchors: [{ id: "h", from: 3, to: 8 }, {
              id: "w",
              from: 9,
              to: 14,
            }],
          },
        });
        // An edit after every anchor moves none of them: the document is
        // left as it was, at the version the set was last restated at.
        const appended = commit(engine, [
          applyOp(
            "of:moving",
            "alice:2",
            { epoch: 1, version: 1 },
            changes(14, 14, "!"),
          ),
        ]);
        expect(appended.revisions.map((revision) => revision.id)).toEqual([
          "of:moving",
        ]);
        expect(queryOperationField(engine, { id: "of:moving", path: body }))
          .toMatchObject({
            cursor: { epoch: 1, version: 2 },
            anchors: [{ id: "h", from: 3, to: 8 }, {
              id: "w",
              from: 9,
              to: 14,
            }],
          });
        // A deletion covering "world" empties its anchor to a point.
        commit(engine, [
          applyOp(
            "of:moving",
            "alice:3",
            { epoch: 1, version: 2 },
            ChangeSet.of({ from: 8, to: 15, insert: "" }, 15).toJSON(),
          ),
        ]);
        expect(read(engine, { id: anchorsDoc("of:moving") })).toEqual({
          value: {
            epoch: 1,
            version: 3,
            anchors: [{ id: "h", from: 3, to: 8 }, { id: "w", from: 8, to: 8 }],
          },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("replaces a held id's range and reports which removed ids it held", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:merge", "hello world");
        commit(engine, [
          anchorOp("of:merge", "hello world", {
            add: [{ id: "w", from: 6, to: 11 }, { id: "h", from: 0, to: 5 }],
          }),
        ]);
        const applied = commit(engine, [
          anchorOp("of:merge", { epoch: 1, version: 0 }, {
            add: [{ id: "w", from: 6, to: 8 }],
            remove: ["h", "missing"],
          }),
        ]);
        expect(applied.anchorResolutions?.[0]).toMatchObject({
          anchors: [{ id: "w", from: 6, to: 8 }],
          removed: ["h"],
        });
        expect(queryOperationField(engine, { id: "of:merge", path: body }))
          .toMatchObject({ anchors: [{ id: "w", from: 6, to: 8 }] });
        // Removing the last anchor leaves the document holding an empty set.
        commit(engine, [
          anchorOp("of:merge", { epoch: 1, version: 0 }, { remove: ["w"] }),
        ]);
        expect(read(engine, { id: anchorsDoc("of:merge") })).toEqual({
          value: { epoch: 1, version: 0, anchors: [] },
        });
        expect(
          engine.database.prepare(`SELECT anchors FROM op_field_epoch`).get(),
        ).toEqual({ anchors: null });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("refuses a base below the retained floor and malformed anchors without changing state", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await open({
        url: toFileUrl(path),
        operationCheckpointInterval: 2,
      });
      try {
        setup(engine, "of:floor", "a");
        commit(engine, [
          applyOp("of:floor", "alice:1", "a", changes(1, 1, "b")),
        ]);
        commit(engine, [
          applyOp(
            "of:floor",
            "alice:2",
            { epoch: 1, version: 1 },
            changes(2, 2, "c"),
          ),
        ]);
        pruneOperationFieldHistory(engine, { id: "of:floor", path: body });
        const snapshot = () => ({
          field: engine.database.prepare(
            `SELECT version, anchors, anchors_seq FROM op_field_epoch`,
          ).get(),
          document: read(engine, { id: anchorsDoc("of:floor") }),
        });
        const before = snapshot();
        const refused = (
          operation: Operation,
          error: new (message: string) => Error,
          message?: string,
        ) => {
          const attempt = () => commit(engine, [operation], "session:refused");
          expect(attempt).toThrow(error);
          if (message !== undefined) expect(attempt).toThrow(message);
        };
        refused(
          anchorOp("of:floor", { epoch: 1, version: 1 }, {
            add: [{ id: "a", from: 0, to: 1 }],
          }),
          OpHistoryUnavailableError,
        );
        refused(
          anchorOp("of:floor", { epoch: 1, version: 3 }, {
            add: [{ id: "a", from: 0, to: 1 }],
          }),
          OpCursorMismatchError,
          "in the future",
        );
        refused(
          anchorOp("of:floor", { epoch: 1, version: 2 }, {
            add: [{ id: "a", from: 2, to: 1 }],
          }),
          ProtocolError,
          "anchor is malformed",
        );
        refused(
          anchorOp("of:floor", { epoch: 1, version: 2 }, {
            add: [{ id: "a", from: 0, to: 1 }, { id: "a", from: 1, to: 2 }],
          }),
          ProtocolError,
          "adds a twice",
        );
        refused(
          anchorOp("of:floor", { epoch: 1, version: 2 }, {
            add: [{ id: "a", from: 0, to: 1 }],
            remove: ["a"],
          }),
          ProtocolError,
          "both adds and removes a",
        );
        refused(
          anchorOp("of:floor", { epoch: 1, version: 2 }, {}),
          ProtocolError,
          "adds and removes nothing",
        );
        refused(
          anchorOp("of:floor", { epoch: 1, version: 2 }, {
            add: [{ id: "a", from: 0, to: 4 }],
          }),
          OpCodecError,
          "outside the field's 3 code units",
        );
        refused(
          anchorOp("of:floor", { epoch: 1, version: 2 }, {
            add: Array.from({ length: 1025 }, (_, index) => ({
              id: `a${index}`,
              from: 0,
              to: 1,
            })),
          }),
          OpCodecError,
          "anchor-count limit",
        );
        expect(snapshot()).toEqual(before);
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("deletes the anchors document when the field is released or its entity deleted", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:released", "abc");
        commit(engine, [
          anchorOp("of:released", "abc", {
            add: [{ id: "a", from: 0, to: 1 }],
          }),
        ]);
        const released = commit(engine, [{
          op: "release-op-field",
          id: "of:released",
          path: body,
          codec: CODEMIRROR_CHANGESET_CODEC,
          cursor: { epoch: 1, version: 0 },
        }]);
        expect(released.revisions).toMatchObject([{
          id: anchorsDoc("of:released"),
          op: "delete",
        }]);
        expect(read(engine, { id: anchorsDoc("of:released") })).toBeNull();
        // A later activation starts with no anchors.
        commit(engine, [
          applyOp("of:released", "alice:1", "abc", changes(3, 3, "d")),
        ]);
        expect(queryOperationField(engine, { id: "of:released", path: body }))
          .toMatchObject({ cursor: { epoch: 2, version: 1 }, anchors: [] });

        setup(engine, "of:deleted", "abc");
        commit(engine, [
          anchorOp("of:deleted", "abc", { add: [{ id: "a", from: 0, to: 1 }] }),
        ]);
        const deleted = commit(engine, [{ op: "delete", id: "of:deleted" }]);
        expect(deleted.revisions.map((revision) => [revision.id, revision.op]))
          .toEqual([
            [anchorsDoc("of:deleted"), "delete"],
            ["of:deleted", "delete"],
          ]);
        expect(read(engine, { id: anchorsDoc("of:deleted") })).toBeNull();
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("refuses a commit that writes an anchors document itself", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:guarded", "abc");
        expect(() =>
          commit(engine, [{
            op: "set",
            id: anchorsDoc("of:guarded"),
            value: { value: { epoch: 1, version: 0, anchors: [] } },
          }])
        ).toThrow("which only the field's operations can change");
        expect(read(engine, { id: anchorsDoc("of:guarded") })).toBeNull();
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("carries anchors into checkpoints and verifies them when pruning", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await open({
        url: toFileUrl(path),
        operationCheckpointInterval: 2,
      });
      try {
        setup(engine, "of:checkpointed", "ab");
        commit(engine, [
          anchorOp("of:checkpointed", "ab", {
            add: [{ id: "b", from: 1, to: 2 }],
          }),
        ]);
        commit(engine, [
          applyOp(
            "of:checkpointed",
            "alice:1",
            { epoch: 1, version: 0 },
            changes(2, 0, "x"),
          ),
        ]);
        commit(engine, [
          applyOp(
            "of:checkpointed",
            "alice:2",
            { epoch: 1, version: 1 },
            changes(3, 0, "y"),
          ),
        ]);
        expect(
          engine.database.prepare(
            `SELECT version, anchors FROM op_checkpoint ORDER BY version`,
          ).all(),
        ).toEqual([
          {
            version: 0,
            anchors: encodeMemoryBoundary([{ id: "b", from: 1, to: 2 }]),
          },
          {
            version: 2,
            anchors: encodeMemoryBoundary([{ id: "b", from: 3, to: 4 }]),
          },
        ]);
        commit(engine, [
          applyOp(
            "of:checkpointed",
            "alice:3",
            { epoch: 1, version: 2 },
            changes(4, 0, "z"),
          ),
        ]);
        expect(pruneOperationFieldHistory(engine, {
          id: "of:checkpointed",
          path: body,
        })).toEqual({ cursor: { epoch: 1, version: 2 }, prunedOperations: 2 });
        expect(read(engine, { id: anchorsDoc("of:checkpointed") })).toEqual({
          value: {
            epoch: 1,
            version: 3,
            anchors: [{ id: "b", from: 4, to: 5 }],
          },
        });

        // An anchor-op after the checkpoint restates the set, which the
        // checkpoint cannot know; pruning then trusts the head.
        commit(engine, [
          applyOp(
            "of:checkpointed",
            "alice:4",
            { epoch: 1, version: 3 },
            changes(5, 5, "!"),
          ),
        ]);
        commit(engine, [
          anchorOp("of:checkpointed", { epoch: 1, version: 4 }, {
            add: [{ id: "all", from: 0, to: 6 }],
          }),
        ]);
        commit(engine, [
          applyOp(
            "of:checkpointed",
            "alice:5",
            { epoch: 1, version: 4 },
            changes(6, 6, "?"),
          ),
        ]);
        expect(pruneOperationFieldHistory(engine, {
          id: "of:checkpointed",
          path: body,
        })).toEqual({ cursor: { epoch: 1, version: 4 }, prunedOperations: 2 });

        // A head whose anchors the checkpoint does not reproduce is refused.
        engine.database.prepare(
          `UPDATE op_field_epoch SET anchors = :anchors, anchors_seq = NULL`,
        ).run({
          anchors: encodeMemoryBoundary([{ id: "all", from: 1, to: 2 }]),
        });
        expect(() =>
          pruneOperationFieldHistory(engine, {
            id: "of:checkpointed",
            path: body,
          })
        ).toThrow("checkpoint anchors diverged");
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("replays an anchor-op commit from its stored resolution", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:replayed", "abc");
        const request = {
          sessionId: "session:replay",
          commit: {
            localSeq: 7,
            reads: { confirmed: [], pending: [] },
            operations: [
              anchorOp("of:replayed", "abc", {
                add: [{ id: "a", from: 0, to: 1 }],
              }),
            ],
          },
        };
        const first = applyCommit(engine, request);
        const again = applyCommit(engine, request);
        expect(again.replayed).toBe(true);
        expect(again.anchorResolutions).toEqual(first.anchorResolutions);
        expect(again.revisions.map((revision) => revision.id)).toEqual([
          anchorsDoc("of:replayed"),
        ]);
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("rolls back anchor changes when a later operation rejects the commit", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:atomic", "abc");
        commit(engine, [
          anchorOp("of:atomic", "abc", { add: [{ id: "a", from: 0, to: 1 }] }),
        ]);
        expect(() =>
          commit(engine, [
            anchorOp("of:atomic", { epoch: 1, version: 0 }, {
              add: [{ id: "b", from: 1, to: 2 }],
            }),
            {
              op: "patch",
              id: "of:atomic",
              patches: [{ op: "replace", path: "/value/body", value: "xyz" }],
            },
          ])
        ).toThrow(OpFieldWriteConflictError);
        expect(queryOperationField(engine, { id: "of:atomic", path: body }))
          .toMatchObject({ anchors: [{ id: "a", from: 0, to: 1 }] });
        expect(read(engine, { id: anchorsDoc("of:atomic") })).toEqual({
          value: {
            epoch: 1,
            version: 0,
            anchors: [{ id: "a", from: 0, to: 1 }],
          },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("reads a store from before the anchor columns as fields without anchors", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:migrated", "abc");
        commit(engine, [
          applyOp("of:migrated", "alice:1", "abc", changes(3, 3, "d")),
        ]);
        close(engine);
        const database = new Database(path);
        database.exec(`ALTER TABLE op_field_epoch DROP COLUMN anchors`);
        database.exec(`ALTER TABLE op_field_epoch DROP COLUMN anchors_seq`);
        database.exec(`ALTER TABLE op_checkpoint DROP COLUMN anchors`);
        database.close();
        const reopened = await open({ url: toFileUrl(path) });
        try {
          expect(
            queryOperationField(reopened, { id: "of:migrated", path: body }),
          )
            .toMatchObject({ cursor: { epoch: 1, version: 1 }, anchors: [] });
          commit(reopened, [
            anchorOp("of:migrated", { epoch: 1, version: 1 }, {
              add: [{ id: "d", from: 3, to: 4 }],
            }),
          ]);
          expect(
            queryOperationField(reopened, { id: "of:migrated", path: body }),
          )
            .toMatchObject({ anchors: [{ id: "d", from: 3, to: 4 }] });
        } finally {
          close(reopened);
        }
      } finally {
        try {
          close(engine);
        } catch {
          // Closed above when the columns were dropped.
        }
        await Deno.remove(path);
      }
    });
  });
});
