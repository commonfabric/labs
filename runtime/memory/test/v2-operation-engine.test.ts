import { ChangeSet } from "@codemirror/state";
import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import type { FabricValue } from "@commonfabric/api";
import { taggedHashStringOf } from "@commonfabric/data-model";
import {
  applyCommit,
  applyWaveCommit,
  authoredSeqThrough,
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
import { anchorsSchemaHash } from "../v2/cfc-anchors-label.ts";
import { executionLeaseHolder } from "../v2/execution-lease.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  createDefaultOperationCodecRegistry,
  operationBaselineHash,
  OperationCodecRegistry,
} from "../v2/operation-codec.ts";
import {
  type ApplyOpOperation,
  type ConfirmedRead,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
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

  it("reports the highest authored commit at or below a captured head", async () => {
    const { engine, path } = await openTestEngine();
    try {
      expect(authoredSeqThrough(engine, 0)).toBe(0);
      for (const localSeq of [1, 2]) {
        applyCommit(engine, {
          sessionId: "session:authored",
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:authored-${localSeq}`,
              value: { value: localSeq },
            }],
          },
        });
      }
      expect(authoredSeqThrough(engine, 1)).toBe(1);
      expect(authoredSeqThrough(engine, 10)).toBe(2);
      expect(() => authoredSeqThrough(engine, -1)).toThrow(
        "nonnegative integer",
      );
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
        mapAnchors: ({ anchors }) => anchors,
        integrate: () => ({ materialized: "changed", operations: [] }),
      }, {
        id: "too-many@1",
        mapAnchors: ({ anchors }) => anchors,
        integrate: ({ materialized }) => ({
          materialized,
          operations: Array.from({ length: 257 }, () => "operation"),
        }),
      }, {
        id: "invalid-materialized@1",
        mapAnchors: ({ anchors }) => anchors,
        integrate: () => ({
          materialized: (() => {}) as never,
          operations: ["operation"],
        }),
      }, {
        id: "invalid-operation@1",
        mapAnchors: ({ anchors }) => anchors,
        integrate: ({ materialized }) => ({
          materialized,
          operations: [(() => {}) as never],
        }),
      }, {
        id: "large-materialized@1",
        mapAnchors: ({ anchors }) => anchors,
        integrate: () => ({
          materialized: "x".repeat(1_000_001),
          operations: ["operation"],
        }),
      }, {
        id: "large-operation@1",
        mapAnchors: ({ anchors }) => anchors,
        integrate: ({ materialized }) => ({
          materialized,
          operations: ["x".repeat(1_000_001)],
        }),
      }, {
        id: "multibyte-materialized@1",
        mapAnchors: ({ anchors }) => anchors,
        integrate: () => ({
          materialized: "é".repeat(600_000),
          operations: ["operation"],
        }),
      }, {
        id: "multibyte-operation@1",
        mapAnchors: ({ anchors }) => anchors,
        integrate: ({ materialized }) => ({
          materialized,
          operations: ["é".repeat(600_000)],
        }),
      }, {
        id: "throw-value@1",
        mapAnchors: ({ anchors }) => anchors,
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
          expect(engine.executionLeases.acquire(space, holder)).toBe(true);

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

  describe("a field's anchors document", () => {
    // Each case seeds an entity whose `body` is the collaborative field, and
    // reads the anchors back from the document or from the field's snapshot.

    const body = toValuePath(["body"]);
    let seq = 0;

    /** Commits `operations` from `session`, beside the `confirmed` reads. */
    const commit = (
      engine: Engine,
      operations: Operation[],
      options: { session?: string; confirmed?: ConfirmedRead[] } = {},
    ) =>
      applyCommit(engine, {
        sessionId: options.session ?? "session:alice",
        commit: {
          localSeq: ++seq,
          reads: { confirmed: options.confirmed ?? [], pending: [] },
          operations,
        },
      });
    const setup = (engine: Engine, id: string, text: string) =>
      commit(
        engine,
        [{ op: "set", id, value: { value: { body: text } } }],
        { session: "session:setup" },
      );

    /**
     * An `apply-op` on `id`'s `body`, stated at a cursor or, given the text
     * the field holds, with no base and that text's hash.
     */
    const applyOp = (
      id: string,
      submissionId: string,
      base: { epoch: number; version: number } | string,
      updates: ReturnType<ChangeSet["toJSON"]>[] = [],
      clientId = "alice",
    ): ApplyOpOperation => ({
      op: "apply-op",
      id,
      path: body,
      codec: CODEMIRROR_CHANGESET_CODEC,
      submissionId,
      ...(typeof base === "string"
        ? { base: null, baselineHash: operationBaselineHash(base) }
        : { base }),
      payload: {
        updates: updates.map((changes) => ({ clientId, changes })),
      },
    });
    const anchorsDoc = (id: string) =>
      operationAnchorsDocId({ id, path: ["body"] });

    /** A `set` of the anchors document of `id`'s `body` to `anchors`. */
    const setAnchors = (id: string, anchors: FabricValue): Operation => ({
      op: "set",
      id: anchorsDoc(id),
      value: { value: anchors },
    });

    /** A `patch` that puts `offset` under `anchor` in that document. */
    const addAnchor = (
      id: string,
      anchor: string,
      offset: FabricValue,
    ): Operation => ({
      op: "patch",
      id: anchorsDoc(id),
      patches: [{ op: "add", path: `/value/${anchor}`, value: offset }],
    });
    const storedAnchors = (engine: Engine, id: string) =>
      read(engine, { id: anchorsDoc(id) });
    const snapshot = (engine: Engine, id: string) =>
      queryOperationField(engine, { id, path: body });

    /** Each revision's id and op, and whether the engine derived it. */
    const written = (applied: ReturnType<typeof applyCommit>) =>
      applied.revisions.map(({ id, op, derived }) => [
        id,
        op,
        derived === true,
      ]);

    describe("a client's write", () => {
      it("stores the anchors a `set` writes, as a revision that is not derived", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:set", "hello");

          const applied = commit(engine, [
            setAnchors("of:set", { from: 1, to: 3 }),
          ]);

          expect(written(applied)).toEqual([
            [anchorsDoc("of:set"), "set", false],
          ]);
          expect(storedAnchors(engine, "of:set")).toEqual({
            value: { from: 1, to: 3 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("stores the anchor a `patch` adds beside those the document holds", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:patch", "hello");
          commit(engine, [setAnchors("of:patch", { from: 1, to: 3 })]);

          const applied = commit(engine, [addAnchor("of:patch", "end", 5)]);

          expect(written(applied)).toEqual([
            [anchorsDoc("of:patch"), "patch", false],
          ]);
          expect(storedAnchors(engine, "of:patch")).toEqual({
            value: { from: 1, to: 3, end: 5 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("holds no document and no anchors after a `delete`", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:delete", "hello");
          commit(engine, [setAnchors("of:delete", { from: 1, to: 3 })]);

          const applied = commit(engine, [
            { op: "delete", id: anchorsDoc("of:delete") },
          ]);

          expect(written(applied)).toEqual([
            [anchorsDoc("of:delete"), "delete", false],
          ]);
          expect(storedAnchors(engine, "of:delete")).toBeNull();
          expect(snapshot(engine, "of:delete").anchors).toEqual({});
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `ConflictError` when the field moved after the commit's confirmed read of it", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:field-read", "hello");
          const opened = commit(engine, [
            applyOp("of:field-read", "alice:1", "hello", [changes(5, 5, "!")]),
          ]);
          const moved = commit(engine, [
            applyOp("of:field-read", "alice:2", { epoch: 1, version: 1 }, [
              changes(6, 0, ">"),
            ]),
          ]);
          const writeAfterReadAt = (readSeq: number) =>
            commit(engine, [setAnchors("of:field-read", { a: 1 })], {
              session: "session:bob",
              confirmed: [{
                id: "of:field-read",
                path: toDocumentPath(["value", "body"]),
                seq: readSeq,
              }],
            });

          expect(() => writeAfterReadAt(opened.seq)).toThrow(ConflictError);
          expect(storedAnchors(engine, "of:field-read")).toBeNull();

          writeAfterReadAt(moved.seq);
          expect(storedAnchors(engine, "of:field-read")).toEqual({
            value: { a: 1 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `ConflictError` when the document moved after the commit's confirmed read of it", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:anchors-read", "hello");
          const stored = commit(engine, [
            setAnchors("of:anchors-read", { from: 1, to: 3 }),
          ]);
          // An edit ahead of both anchors moves them, which rewrites the
          // document.
          const moved = commit(engine, [
            applyOp("of:anchors-read", "alice:1", "hello", [
              changes(5, 0, ">"),
            ]),
          ]);
          const addAfterReadAt = (readSeq: number) =>
            commit(engine, [addAnchor("of:anchors-read", "end", 6)], {
              session: "session:bob",
              confirmed: [{
                id: anchorsDoc("of:anchors-read"),
                path: toDocumentPath(["value"]),
                seq: readSeq,
              }],
            });

          expect(() => addAfterReadAt(stored.seq)).toThrow(ConflictError);
          expect(storedAnchors(engine, "of:anchors-read")).toEqual({
            value: { from: 2, to: 4 },
          });

          addAfterReadAt(moved.seq);
          expect(storedAnchors(engine, "of:anchors-read")).toEqual({
            value: { from: 2, to: 4, end: 6 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `ProtocolError` for a document that is not a map from anchor id to non-negative integer offset", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:invalid", "hello");
          const notAMap = "is not a map from anchor id to offset";
          const badId = "an anchor id that is empty or longer than 256";
          const badOffset = "something other than a non-negative integer";
          const refused: [Operation, string][] = [
            [setAnchors("of:invalid", [1, 3]), notAMap],
            [setAnchors("of:invalid", "1,3"), notAMap],
            [setAnchors("of:invalid", null), notAMap],
            [setAnchors("of:invalid", { "": 1 }), badId],
            [setAnchors("of:invalid", { ["a".repeat(257)]: 1 }), badId],
            [setAnchors("of:invalid", { a: { from: 1, to: 3 } }), badOffset],
            [setAnchors("of:invalid", { a: -1 }), badOffset],
            [setAnchors("of:invalid", { a: 1.5 }), badOffset],
            [setAnchors("of:invalid", { a: "1" }), badOffset],
          ];

          for (const [operation, message] of refused) {
            const attempt = () => commit(engine, [operation]);
            expect(attempt).toThrow(ProtocolError);
            expect(attempt).toThrow(`commit operation 0: anchors document`);
            expect(attempt).toThrow(message);
          }
          expect(storedAnchors(engine, "of:invalid")).toBeNull();

          // A patch is checked by the document it leaves.
          commit(engine, [setAnchors("of:invalid", { a: 1 })]);
          expect(() => commit(engine, [addAnchor("of:invalid", "b", -1)]))
            .toThrow(badOffset);
          expect(storedAnchors(engine, "of:invalid")).toEqual({
            value: { a: 1 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("stores 1024 anchors and an id of 256 characters, and throws `ProtocolError` for one anchor more", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:full", "a");
          const longest = "a".repeat(256);
          const full = Object.fromEntries([
            [longest, 0],
            ...Array.from({ length: 1023 }, (_, index) => [`a${index}`, 1]),
          ]);

          commit(engine, [setAnchors("of:full", full)]);
          expect(snapshot(engine, "of:full").anchors).toEqual(full);

          // Replacing a held id keeps the count; a new id exceeds it.
          commit(engine, [addAnchor("of:full", longest, 1)]);
          const oneMore = () =>
            commit(engine, [addAnchor("of:full", "one-more", 0)]);
          expect(oneMore).toThrow(ProtocolError);
          expect(oneMore).toThrow("holds more than 1024 anchors");
          expect(snapshot(engine, "of:full").anchors).toEqual({
            ...full,
            [longest]: 1,
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("maps a write through an edit that follows it in the commit, and not through one that precedes it", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:write-first", "hello");
          const writeFirst = commit(engine, [
            setAnchors("of:write-first", { from: 1, to: 3 }),
            applyOp("of:write-first", "alice:1", "hello", [
              changes(5, 0, ">> "),
            ]),
          ]);

          expect(written(writeFirst)).toEqual([
            [anchorsDoc("of:write-first"), "set", false],
            ["of:write-first", "patch", false],
            [anchorsDoc("of:write-first"), "patch", true],
          ]);
          expect(storedAnchors(engine, "of:write-first")).toEqual({
            value: { from: 4, to: 6 },
          });

          setup(engine, "of:edit-first", "hello");
          const editFirst = commit(engine, [
            applyOp("of:edit-first", "alice:1", "hello", [
              changes(5, 0, ">> "),
            ]),
            setAnchors("of:edit-first", { from: 1, to: 3 }),
          ]);

          expect(written(editFirst)).toEqual([
            ["of:edit-first", "patch", false],
            [anchorsDoc("of:edit-first"), "set", false],
          ]);
          expect(storedAnchors(engine, "of:edit-first")).toEqual({
            value: { from: 1, to: 3 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });
    });

    describe("a document that holds no anchors", () => {
      it("takes a document written with no value as holding none", async () => {
        // A cell set to `undefined` writes the document with no value.

        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:cleared", "hello");
          commit(engine, [setAnchors("of:cleared", { h: 1 })]);

          commit(engine, [{
            op: "set",
            id: anchorsDoc("of:cleared"),
            value: {},
          }]);

          expect(snapshot(engine, "of:cleared").anchors).toEqual({});
          // The next edit has nothing to map, and lands.
          commit(engine, [
            applyOp("of:cleared", "alice:1", "hello", [changes(5, 0, "> ")]),
          ]);
          expect(snapshot(engine, "of:cleared")).toMatchObject({
            materialized: "> hello",
            anchors: {},
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("takes a stored document that is not a map of anchors as holding none, and leaves it for a write to replace", async () => {
        // Such a document was not written through the engine's check of
        // anchors documents; here it is put in place beneath the engine.

        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:foreign", "hello");
          commit(engine, [setAnchors("of:foreign", { h: 1 })]);
          const foreign = encodeMemoryBoundary({
            value: { epoch: 1, version: 0, anchors: [{ id: "h", from: 1 }] },
          });
          engine.database.prepare(
            `UPDATE revision SET data = :data WHERE id = :id`,
          ).run({ data: foreign, id: anchorsDoc("of:foreign") });

          expect(snapshot(engine, "of:foreign").anchors).toEqual({});
          const edited = commit(engine, [
            applyOp("of:foreign", "alice:1", "hello", [changes(5, 0, "> ")]),
          ]);
          expect(written(edited)).toEqual([["of:foreign", "patch", false]]);
          expect(snapshot(engine, "of:foreign").materialized).toBe("> hello");

          commit(engine, [setAnchors("of:foreign", { h: 3 })]);
          expect(snapshot(engine, "of:foreign").anchors).toEqual({ h: 3 });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("refuses an `apply-op` whose field is an anchors document", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:target", "hello");
          commit(engine, [setAnchors("of:target", { h: 1 })]);
          const aimed = () =>
            commit(engine, [{
              ...applyOp("of:target", "alice:1", "hello", [
                changes(5, 0, "> "),
              ]),
              id: anchorsDoc("of:target"),
              path: toValuePath(["h"]),
            }]);

          expect(aimed).toThrow(ProtocolError);
          expect(aimed).toThrow("apply-op cannot mutate an anchors document");
          expect(storedAnchors(engine, "of:target")).toEqual({
            value: { h: 1 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });
    });

    describe("the label of the anchors an edit moves", () => {
      const schemaHash = anchorsSchemaHash();
      const schemaDoc = `cid:${schemaHash}`;
      const secret = { confidentiality: ["secret"] };

      /** The CFC envelope of a document whose label map holds `entries`. */
      const envelope = (entries: FabricValue[], version = 1): FabricValue => ({
        version,
        schemaHash,
        labelMap: { version: 1, entries },
      });

      /**
       * Seeds `id` with the body `abc` under the CFC envelope `cfc`, and the
       * anchors `b` at 1 and `end` at 3. An insert at 2 then moves `end` and
       * leaves `b`.
       */
      const seed = (engine: Engine, id: string, cfc: FabricValue) => {
        commit(engine, [
          { op: "set", id: schemaDoc, value: { value: {} } },
          { op: "set", id, value: { value: { body: "abc" }, cfc } },
          setAnchors(id, { b: 1, end: 3 }),
        ], { session: "session:setup" });
      };
      const insert = (engine: Engine, id: string) =>
        commit(engine, [applyOp(id, "alice:1", "abc", [changes(3, 2, "X")])]);

      /** The entry the engine writes for the anchor `anchor`. */
      const moved = (anchor: string, confidentiality: FabricValue[]) => ({
        path: [anchor],
        origin: "derived",
        observes: "value",
        label: { confidentiality },
      });
      const labelEntries = (engine: Engine, id: string) =>
        (read(engine, { id: anchorsDoc(id) })?.cfc as {
          labelMap: { entries: FabricValue[] };
        } | undefined)?.labelMap.entries;

      it("writes no envelope for a field whose document holds no label", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:unlabeled", "abc");
          commit(engine, [setAnchors("of:unlabeled", { b: 1, end: 3 })]);

          const applied = insert(engine, "of:unlabeled");

          expect(written(applied)).toEqual([
            ["of:unlabeled", "patch", false],
            [anchorsDoc("of:unlabeled"), "patch", true],
          ]);
          expect(read(engine, { id: anchorsDoc("of:unlabeled") })).toEqual({
            value: { b: 1, end: 4 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("labels every anchor of the field, moved or not, with the confidentiality at the field's path, and no other", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(
            engine,
            "of:labeled",
            envelope([{ path: ["body"], origin: "declared", label: secret }]),
          );

          const applied = insert(engine, "of:labeled");

          expect(written(applied)).toEqual([
            ["of:labeled", "patch", false],
            [anchorsDoc("of:labeled"), "patch", true],
          ]);
          expect(read(engine, { id: anchorsDoc("of:labeled") })).toEqual({
            value: { b: 1, end: 4 },
            cfc: envelope([moved("b", ["secret"]), moved("end", ["secret"])]),
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("labels every anchor in a patch of the envelope alone for an edit that moves none", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(
            engine,
            "of:still",
            envelope([{ path: ["body"], origin: "declared", label: secret }]),
          );

          // Text inserted at `end`, the end of `abc`, lands after it.
          const applied = commit(engine, [
            applyOp("of:still", "alice:1", "abc", [changes(3, 3, "X")]),
          ]);

          expect(written(applied)).toEqual([
            ["of:still", "patch", false],
            [anchorsDoc("of:still"), "patch", true],
          ]);
          expect(applied.revisions[1].patches).toEqual([{
            op: "replace",
            path: "/cfc",
            value: envelope([moved("b", ["secret"]), moved("end", ["secret"])]),
          }]);
          expect(read(engine, { id: anchorsDoc("of:still") })).toEqual({
            value: { b: 1, end: 3 },
            cfc: envelope([moved("b", ["secret"]), moved("end", ["secret"])]),
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("stores the schema document the new envelope names where the store holds none, as a derived revision", async () => {
        const { engine, path } = await openTestEngine();
        try {
          // The field's envelope names another schema, so nothing has
          // stored the one an anchors document's envelope names.
          const other = taggedHashStringOf({ type: "object" });
          commit(engine, [
            {
              op: "set",
              id: `cid:${other}`,
              value: { value: { type: "object" } },
            },
            {
              op: "set",
              id: "of:first",
              value: {
                value: { body: "abc" },
                cfc: {
                  ...(envelope([{ path: ["body"], label: secret }]) as object),
                  schemaHash: other,
                },
              },
            },
            setAnchors("of:first", { b: 1, end: 3 }),
          ]);

          const applied = insert(engine, "of:first");
          commit(engine, [
            applyOp("of:first", "alice:2", { epoch: 1, version: 1 }, [
              changes(4, 0, ">"),
            ]),
          ]);

          expect(written(applied)).toEqual([
            ["of:first", "patch", false],
            [schemaDoc, "set", true],
            [anchorsDoc("of:first"), "patch", true],
          ]);
          expect(read(engine, { id: schemaDoc })).toEqual({ value: {} });
          expect(labelEntries(engine, "of:first")).toEqual([
            moved("b", ["secret"]),
            moved("end", ["secret"]),
          ]);
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("takes the confidentiality of entries at, above and inside the field's path, each clause once, and of none beside it", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(
            engine,
            "of:around",
            envelope([
              { path: [], label: { confidentiality: ["above"] } },
              { path: ["*"], label: { confidentiality: ["every"] } },
              { path: ["body"], label: { confidentiality: ["at", "above"] } },
              { path: ["body", "0"], label: { confidentiality: ["inside"] } },
              { path: ["title"], label: { confidentiality: ["beside"] } },
              { path: ["body"], label: {} },
              {
                path: ["cfc", "labels", "body"],
                origin: "label-metadata",
                observes: "labelMetadata",
                label: { confidentiality: ["template"] },
              },
            ]),
          );

          insert(engine, "of:around");

          expect(labelEntries(engine, "of:around")).toEqual([
            moved("b", ["above", "every", "at", "inside"]),
            moved("end", ["above", "every", "at", "inside"]),
          ]);
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("leaves the field's integrity out of the label", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(
            engine,
            "of:vouched",
            envelope([{
              path: ["body"],
              label: { confidentiality: ["secret"], integrity: ["reviewed"] },
            }, { path: ["body"], label: { integrity: ["signed"] } }]),
          );

          insert(engine, "of:vouched");

          expect(labelEntries(engine, "of:vouched")).toEqual([
            moved("b", ["secret"]),
            moved("end", ["secret"]),
          ]);
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("reads a label a version-2 envelope names by document", async () => {
        const { engine, path } = await openTestEngine();
        try {
          const label = { confidentiality: ["referenced"], integrity: ["x"] };
          const labelDoc = `cid:${taggedHashStringOf(label)}`;
          commit(engine, [{
            op: "set",
            id: labelDoc,
            value: { value: label },
          }]);
          seed(
            engine,
            "of:referenced",
            envelope([{ path: ["body"], label: { $ref: labelDoc } }], 2),
          );

          insert(engine, "of:referenced");

          expect(labelEntries(engine, "of:referenced")).toEqual([
            moved("b", ["referenced"]),
            moved("end", ["referenced"]),
          ]);
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("adds to the envelope the document holds, and writes none where it already holds the label", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(
            engine,
            "of:kept",
            envelope([{ path: ["body"], label: secret }]),
          );
          const held = {
            ...(envelope([
              { path: ["b"], origin: "derived", label: { integrity: ["i"] } },
            ], 2) as object),
            stampPlacement: "committed",
          };
          commit(engine, [{
            op: "set",
            id: anchorsDoc("of:kept"),
            value: { value: { b: 1, end: 3 }, cfc: held },
          }]);

          insert(engine, "of:kept");
          const again = commit(engine, [
            applyOp("of:kept", "alice:2", { epoch: 1, version: 1 }, [
              changes(4, 2, "Y"),
            ]),
          ]);

          expect(read(engine, { id: anchorsDoc("of:kept") })).toEqual({
            value: { b: 1, end: 5 },
            cfc: {
              ...held,
              labelMap: {
                version: 1,
                entries: [
                  // The integrity of `b`'s derived entry of no class meets
                  // the edit's, which holds none.
                  { path: ["b"], origin: "derived", label: {} },
                  moved("b", ["secret"]),
                  moved("end", ["secret"]),
                ],
              },
            },
          });
          expect(again.revisions[1].patches).toEqual([
            { op: "replace", path: "/value", value: { b: 1, end: 5 } },
          ]);
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("joins the move's label into one entry with the writer's, joining their confidentiality and meeting their integrity", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(
            engine,
            "of:written",
            envelope([{ path: ["body"], origin: "declared", label: secret }]),
          );
          const carols = { confidentiality: ["carol"], integrity: ["bob"] };
          const hash = taggedHashStringOf(carols);
          commit(engine, [
            { op: "set", id: `cid:${hash}`, value: { value: carols } },
            {
              op: "set",
              id: anchorsDoc("of:written"),
              value: {
                value: { b: 1, end: 3 },
                cfc: envelope([{
                  path: ["end"],
                  origin: "derived",
                  observes: "value",
                  label: { $ref: `cid:${hash}` },
                }], 2),
              },
            },
          ]);

          insert(engine, "of:written");

          expect(labelEntries(engine, "of:written")).toEqual([
            moved("end", ["carol", "secret"]),
            moved("b", ["secret"]),
          ]);
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("joins the confidentiality of the broader instances of a scoped field's document", async () => {
        const { engine, path } = await openTestEngine();
        const alice = "did:key:z6MkAnchorsLabelAlice";
        const scoped = (scope: "user" | "session") =>
          operationAnchorsDocId({ id: "of:scoped", scope, path: ["body"] });
        const commitAs = (operations: Operation[]) =>
          applyCommit(engine, {
            sessionId: "session:alice",
            principal: alice,
            commit: {
              localSeq: ++seq,
              reads: { confirmed: [], pending: [] },
              operations,
            },
          });
        const entity = (
          scope: "space" | "user" | "session",
          clause: string,
        ): Operation => ({
          op: "set",
          id: "of:scoped",
          ...(scope === "space" ? {} : { scope }),
          value: {
            value: { body: "abc" },
            cfc: envelope([{
              path: ["body"],
              label: { confidentiality: [clause] },
            }]),
          },
        });
        try {
          commitAs([
            { op: "set", id: schemaDoc, value: { value: {} } },
            entity("space", "of-space"),
            entity("user", "of-user"),
            entity("session", "of-session"),
            ...(["user", "session"] as const).map((scope): Operation => ({
              op: "set",
              id: scoped(scope),
              scope,
              value: { value: { end: 3 } },
            })),
          ]);

          for (const scope of ["user", "session"] as const) {
            commitAs([{
              ...applyOp("of:scoped", `alice:${scope}`, "abc", [
                changes(3, 0, ">"),
              ]),
              scope,
            }]);
          }

          const entriesIn = (scope: "user" | "session") =>
            (read(engine, {
              id: scoped(scope),
              scope,
              principal: alice,
              sessionId: "session:alice",
            })?.cfc as { labelMap: { entries: FabricValue[] } }).labelMap
              .entries;
          expect(entriesIn("user")).toEqual([
            moved("end", ["of-user", "of-space"]),
          ]);
          expect(entriesIn("session")).toEqual([
            moved("end", ["of-session", "of-user", "of-space"]),
          ]);
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `ProtocolError` for an edit that moves anchors of a field whose envelope it cannot read, and leaves both documents", async () => {
        const { engine, path } = await openTestEngine();
        try {
          const unreadable: [string, FabricValue, string][] = [
            [
              "of:version",
              { ...(envelope([]) as object), version: 3 },
              "is not of a version the engine reads",
            ],
            ["of:array", [envelope([])], "is not of a version"],
            [
              "of:schema",
              { version: 1, labelMap: { version: 1, entries: [] } },
              "names no schema",
            ],
            [
              "of:map",
              { version: 1, schemaHash, labelMap: { version: 2, entries: [] } },
              "holds no label map the engine reads",
            ],
            [
              "of:entries",
              { version: 1, schemaHash, labelMap: { version: 1 } },
              "holds no label map the engine reads",
            ],
            ["of:entry", envelope(["secret"]), "has no path"],
            [
              "of:path",
              envelope([{ path: "body", label: secret }]),
              "has no path",
            ],
            [
              "of:label",
              envelope([{ path: ["body"], label: "secret" }]),
              "is not one the engine reads",
            ],
            [
              "of:member",
              envelope([{
                path: ["body"],
                label: { confidentiality: ["secret"], sealed: true },
              }]),
              "is not one the engine reads",
            ],
            [
              "of:clauses",
              envelope([{ path: ["body"], label: { confidentiality: "s" } }]),
              "is not one the engine reads",
            ],
            [
              "of:atoms",
              envelope([{
                path: ["body"],
                label: { confidentiality: ["s"], integrity: "i" },
              }]),
              "is not one the engine reads",
            ],
            [
              "of:instance",
              envelope([{
                path: ["body"],
                label: (decodeMemoryBoundary(
                  'fvj1:{"x":{"/Bytes@1":"AQID"}}',
                ) as { x: FabricValue }).x,
              }]),
              "is not one the engine reads",
            ],
            [
              "of:beside",
              envelope([
                { path: ["body"], label: secret },
                { path: ["title"], label: "secret" },
              ]),
              "is not one the engine reads",
            ],
            [
              "of:reference",
              envelope([{ path: ["body"], label: { $ref: schemaDoc } }], 1),
              "of version 1, holds a label by reference",
            ],
            [
              "of:template",
              envelope([{
                path: ["body"],
                origin: "label-metadata",
                observes: "value",
                label: secret,
              }]),
              "template entry",
            ],
          ];
          for (const [id, cfc, fault] of unreadable) {
            seed(engine, id, cfc);

            const edit = () => insert(engine, id);

            expect(edit).toThrow(ProtocolError);
            expect(edit).toThrow(
              `commit operation 0: the anchors of ${id} cannot be labeled for its edit: `,
            );
            expect(edit).toThrow(fault);
            expect(snapshot(engine, id).materialized).toBe("abc");
            expect(read(engine, { id: anchorsDoc(id) })).toEqual({
              value: { b: 1, end: 3 },
            });
          }
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `ProtocolError` for a label reference the store holds no document for", async () => {
        const { engine, path } = await openTestEngine();
        try {
          // The commit boundary refuses an envelope whose label document is
          // absent, so these are put in place beneath the engine.
          const stored = (id: string, reference: string) => {
            seed(engine, id, envelope([{ path: ["body"], label: secret }], 2));
            engine.database.prepare(
              "UPDATE revision SET data = :data WHERE id = :id",
            ).run({
              id,
              data: encodeMemoryBoundary({
                value: { body: "abc" },
                cfc: envelope([{
                  path: ["body"],
                  label: { $ref: reference },
                }], 2),
              }),
            });
          };
          stored("of:dangling", `cid:${taggedHashStringOf(["absent"])}`);
          stored("of:elsewhere", "https://example.test/label");
          stored("of:nameless", "cid:");

          for (const id of ["of:dangling", "of:elsewhere", "of:nameless"]) {
            const edit = () => insert(engine, id);

            expect(edit).toThrow(ProtocolError);
            expect(edit).toThrow("names a label document");
            expect(edit).toThrow("the store does not hold");
          }
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `ProtocolError` for a label reference to a document that does not hold a label", async () => {
        const { engine, path } = await openTestEngine();
        try {
          // The commit boundary refuses an envelope whose label document is
          // not a label, so the reference is put in place beneath the engine.
          // The second content is a class instance, which shows no own
          // members for a check of members alone to refuse.
          const contents: [string, FabricValue][] = [
            ["of:content", { title: "not a label" }],
            [
              "of:instance-content",
              (decodeMemoryBoundary('fvj1:{"x":{"/Bytes@1":"AQID"}}') as {
                x: FabricValue;
              }).x,
            ],
          ];
          for (const [id, content] of contents) {
            const contentDoc = `cid:${taggedHashStringOf(content)}`;
            commit(engine, [{
              op: "set",
              id: contentDoc,
              value: { value: content },
            }]);
            seed(engine, id, envelope([{ path: ["body"], label: secret }], 2));
            engine.database.prepare(
              "UPDATE revision SET data = :data WHERE id = :id",
            ).run({
              id,
              data: encodeMemoryBoundary({
                value: { body: "abc" },
                cfc: envelope(
                  [{ path: ["body"], label: { $ref: contentDoc } }],
                  2,
                ),
              }),
            });

            const edit = () => insert(engine, id);

            expect(edit).toThrow(ProtocolError);
            expect(edit).toThrow(
              `the label document \`${contentDoc}\` the CFC envelope of the document ${id} names does not hold a label`,
            );
          }
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `ProtocolError` where the anchors document's own envelope cannot be read", async () => {
        const { engine, path } = await openTestEngine();
        try {
          seed(
            engine,
            "of:opaque",
            envelope([{ path: ["body"], label: secret }]),
          );
          commit(engine, [{
            op: "set",
            id: anchorsDoc("of:opaque"),
            value: { value: { b: 1, end: 3 }, cfc: { version: 3 } },
          }]);

          const edit = () => insert(engine, "of:opaque");

          expect(edit).toThrow(ProtocolError);
          expect(edit).toThrow(
            `the CFC envelope of the anchors document ${
              anchorsDoc("of:opaque")
            } is not of a version the engine reads`,
          );
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("returns the schema document and the labeled rewrite as derived again when the commit is sent a second time", async () => {
        const { engine, path } = await openTestEngine();
        try {
          // The field's envelope names a schema of its own, stored with it,
          // so that the store lacks the anchors schema document until the
          // engine writes it.
          const fieldSchema = { type: "object" };
          commit(engine, [{
            op: "set",
            id: `cid:${taggedHashStringOf(fieldSchema)}`,
            value: { value: fieldSchema },
          }, {
            op: "set",
            id: "of:label-resent",
            value: {
              value: { body: "abc" },
              cfc: {
                ...(envelope([{ path: ["body"], label: secret }]) as object),
                schemaHash: taggedHashStringOf(fieldSchema),
              },
            },
          }, setAnchors("of:label-resent", { end: 3 })]);
          const resent = {
            sessionId: "session:alice",
            commit: {
              localSeq: ++seq,
              reads: { confirmed: [], pending: [] },
              operations: [
                applyOp("of:label-resent", "alice:1", "abc", [
                  changes(3, 0, ">"),
                ]),
              ],
            },
          };

          const first = applyCommit(engine, resent);
          const second = applyCommit(engine, resent);

          expect(written(second)).toEqual(written(first));
          expect(written(second)).toEqual([
            ["of:label-resent", "patch", false],
            [schemaDoc, "set", true],
            [anchorsDoc("of:label-resent"), "patch", true],
          ]);
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });
    });

    describe("an edit to the field", () => {
      it("keeps an anchor ahead of text inserted at it and moves one past text inserted before it, in a derived patch of the document", async () => {
        // The anchors at 1 and 3 bound the `el` of `hello`. An insert at 1
        // lands after the first anchor, inside the two.

        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:inserted", "hello");
          commit(engine, [setAnchors("of:inserted", { from: 1, to: 3 })]);

          const applied = commit(engine, [
            applyOp("of:inserted", "alice:1", "hello", [changes(5, 1, "X")]),
          ]);

          expect(written(applied)).toEqual([
            ["of:inserted", "patch", false],
            [anchorsDoc("of:inserted"), "patch", true],
          ]);
          expect(applied.revisions[1].patches).toEqual([
            { op: "replace", path: "/value", value: { from: 1, to: 4 } },
          ]);
          expect(storedAnchors(engine, "of:inserted")).toEqual({
            value: { from: 1, to: 4 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("writes no revision of the document for an edit that moves no anchor", async () => {
        // An insert at 3 lands after the anchor there, so neither anchor
        // moves.

        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:unmoved", "hello");
          commit(engine, [setAnchors("of:unmoved", { from: 1, to: 3 })]);

          const inserted = commit(engine, [
            applyOp("of:unmoved", "alice:1", "hello", [changes(5, 3, "Y")]),
          ]);
          const nothing = commit(engine, [
            applyOp("of:unmoved", "alice:2", { epoch: 1, version: 1 }),
          ]);

          expect(written(inserted)).toEqual([["of:unmoved", "patch", false]]);
          expect(written(nothing)).toEqual([]);
          expect(snapshot(engine, "of:unmoved")).toMatchObject({
            cursor: { epoch: 1, version: 1 },
            materialized: "helYlo",
          });
          expect(storedAnchors(engine, "of:unmoved")).toEqual({
            value: { from: 1, to: 3 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("brings the anchors inside deleted text to where the deletion began", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:deleted-text", "hello world");
          commit(engine, [
            setAnchors("of:deleted-text", { h: 2, from: 6, mid: 8, to: 11 }),
          ]);

          // Deletes `o wor`, leaving `hellld`.
          commit(engine, [
            applyOp("of:deleted-text", "alice:1", "hello world", [
              ChangeSet.of({ from: 4, to: 9, insert: "" }, 11).toJSON(),
            ]),
          ]);

          expect(snapshot(engine, "of:deleted-text").materialized).toBe(
            "hellld",
          );
          expect(storedAnchors(engine, "of:deleted-text")).toEqual({
            value: { h: 2, from: 4, mid: 4, to: 6 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("maps the anchors through an operation as rebased over the edits integrated since its base", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:rebased", "abc");
          commit(engine, [
            applyOp("of:rebased", "alice:1", "abc", [changes(3, 0, "XX")]),
          ]);
          commit(engine, [setAnchors("of:rebased", { a: 2, b: 3, c: 4 })]);

          // Bob still holds `abc`, where his insert between `a` and `b` is at
          // 1; it integrates at 3 of `XXabc`.
          const applied = commit(engine, [
            applyOp(
              "of:rebased",
              "bob:1",
              { epoch: 1, version: 0 },
              [changes(3, 1, "Y")],
              "bob",
            ),
          ], { session: "session:bob" });

          expect(applied.operationResolutions?.[0]).toMatchObject({
            from: { epoch: 1, version: 1 },
            to: { epoch: 1, version: 2 },
          });
          expect(snapshot(engine, "of:rebased").materialized).toBe("XXaYbc");
          expect(storedAnchors(engine, "of:rebased")).toEqual({
            value: { a: 2, b: 3, c: 5 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("maps the anchors through every operation one submission integrates", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:batch", "abc");
          commit(engine, [setAnchors("of:batch", { a: 0, b: 1 })]);

          const applied = commit(engine, [
            applyOp("of:batch", "alice:1", "abc", [
              changes(3, 0, "X"),
              changes(4, 0, "Y"),
            ]),
          ]);

          expect(applied.operationResolutions?.[0].operations).toHaveLength(2);
          expect(snapshot(engine, "of:batch").materialized).toBe("YXabc");
          expect(storedAnchors(engine, "of:batch")).toEqual({
            value: { a: 0, b: 3 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("maps an offset past the end of the text as the end", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:past-end", "abc");
          commit(engine, [setAnchors("of:past-end", { far: 99 })]);

          commit(engine, [
            applyOp("of:past-end", "alice:1", "abc", [changes(3, 0, "x")]),
          ]);

          expect(storedAnchors(engine, "of:past-end")).toEqual({
            value: { far: 4 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("maps the anchors a field held before its first operation", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:inactive", "world");
          commit(engine, [setAnchors("of:inactive", { w: 0, end: 5 })]);
          expect(snapshot(engine, "of:inactive")).toMatchObject({
            active: false,
            cursor: null,
          });
          expect(snapshot(engine, "of:inactive").anchors).toEqual({
            w: 0,
            end: 5,
          });

          commit(engine, [
            applyOp("of:inactive", "alice:1", "world", [
              changes(5, 0, "hello "),
            ]),
          ]);

          expect(snapshot(engine, "of:inactive")).toMatchObject({
            active: true,
            cursor: { epoch: 1, version: 1 },
            materialized: "hello world",
          });
          expect(snapshot(engine, "of:inactive").anchors).toEqual({
            w: 0,
            end: 11,
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("keeps the other members of the document's envelope", async () => {
        const { engine, path } = await openTestEngine();
        try {
          const cfc = {
            version: 1,
            labelMap: {
              version: 1,
              entries: [{
                path: ["from"],
                label: { confidentiality: ["secret"] },
              }],
            },
          };
          setup(engine, "of:envelope", "hello");
          commit(engine, [{
            op: "set",
            id: anchorsDoc("of:envelope"),
            value: { value: { from: 1, to: 3 }, cfc },
          }]);

          commit(engine, [
            applyOp("of:envelope", "alice:1", "hello", [changes(5, 0, ">")]),
          ]);

          expect(storedAnchors(engine, "of:envelope")).toEqual({
            value: { from: 2, to: 4 },
            cfc,
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("leaves the anchors where the edit put them when its submission is sent again", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:resubmitted", "abc");
          commit(engine, [setAnchors("of:resubmitted", { b: 1 })]);
          const edit = applyOp("of:resubmitted", "alice:1", "abc", [
            changes(3, 0, ">"),
          ]);
          const first = commit(engine, [edit]);

          const again = commit(engine, [edit]);

          expect(again.operationResolutions?.[0]).toEqual({
            ...first.operationResolutions?.[0],
            duplicate: true,
          });
          expect(written(again)).toEqual([]);
          expect(storedAnchors(engine, "of:resubmitted")).toEqual({
            value: { b: 2 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("keeps a per-user field's anchors in that user's document", async () => {
        const { engine, path } = await openTestEngine();
        const alice = "did:key:z6MkAnchorsAlice";
        const bob = "did:key:z6MkAnchorsBob";
        const mine = operationAnchorsDocId({
          id: "of:mine",
          scope: "user",
          path: ["body"],
        });
        const commitAs = (principal: string, operations: Operation[]) =>
          applyCommit(engine, {
            sessionId: `session:${principal}`,
            principal,
            commit: {
              localSeq: ++seq,
              reads: { confirmed: [], pending: [] },
              operations,
            },
          });
        try {
          for (const principal of [alice, bob]) {
            commitAs(principal, [{
              op: "set",
              id: "of:mine",
              scope: "user",
              value: { value: { body: "abc" } },
            }, {
              op: "set",
              id: mine,
              scope: "user",
              value: { value: { b: 1 } },
            }]);
          }

          commitAs(alice, [{
            ...applyOp("of:mine", "alice:1", "abc", [changes(3, 0, ">")]),
            scope: "user",
          }]);

          const anchorsOf = (principal: string) =>
            read(engine, { id: mine, scope: "user", principal });
          expect(anchorsOf(alice)).toEqual({ value: { b: 2 } });
          expect(anchorsOf(bob)).toEqual({ value: { b: 1 } });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `OpCodecError` for a codec that cannot map the anchors, and a codec's own `ProtocolError` as it was thrown", async () => {
        const codemirror = createDefaultOperationCodecRegistry().require(
          CODEMIRROR_CHANGESET_CODEC,
        );
        const path = await Deno.makeTempFile({ suffix: ".sqlite" });
        const engine = await open({
          url: toFileUrl(path),
          operationCodecs: new OperationCodecRegistry([
            {
              id: "test-unmapping@1",
              integrate: (input) => codemirror.integrate(input),
              mapAnchors() {
                throw new Error("the codec holds no positions");
              },
            },
            {
              id: "test-strict@1",
              integrate: (input) => codemirror.integrate(input),
              mapAnchors() {
                throw new ProtocolError("the codec refused the anchors");
              },
            },
            {
              id: "test-refusing@1",
              mapAnchors: (input) => codemirror.mapAnchors(input),
              integrate() {
                throw new ProtocolError("the codec refused the payload");
              },
            },
          ]),
        });
        const edit = (id: string, codec: string) => () =>
          commit(engine, [{
            ...applyOp(id, "alice:1", "hello", [changes(5, 0, "> ")]),
            codec,
          }]);
        try {
          setup(engine, "of:unmapping", "hello");
          commit(engine, [setAnchors("of:unmapping", { h: 1 })]);
          const unmapping = edit("of:unmapping", "test-unmapping@1");
          expect(unmapping).toThrow(OpCodecError);
          expect(unmapping).toThrow(
            "could not map the field's anchors: the codec holds no positions",
          );
          expect(snapshot(engine, "of:unmapping")).toMatchObject({
            active: false,
            materialized: "hello",
          });
          expect(storedAnchors(engine, "of:unmapping")).toEqual({
            value: { h: 1 },
          });

          // With no anchors to map, the same codec's edit lands.
          setup(engine, "of:anchorless", "hello");
          edit("of:anchorless", "test-unmapping@1")();
          expect(snapshot(engine, "of:anchorless").materialized).toBe(
            "> hello",
          );

          setup(engine, "of:strict", "hello");
          commit(engine, [setAnchors("of:strict", { h: 1 })]);
          const strict = edit("of:strict", "test-strict@1");
          expect(strict).toThrow(ProtocolError);
          expect(strict).toThrow("the codec refused the anchors");

          setup(engine, "of:refusing", "hello");
          const refusing = edit("of:refusing", "test-refusing@1");
          expect(refusing).toThrow(ProtocolError);
          expect(refusing).toThrow("the codec refused the payload");
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("throws `OpCodecError` for a codec that maps the anchors to anything but anchors under the same ids", async () => {
        const codemirror = createDefaultOperationCodecRegistry().require(
          CODEMIRROR_CHANGESET_CODEC,
        );
        const path = await Deno.makeTempFile({ suffix: ".sqlite" });
        const engine = await open({
          url: toFileUrl(path),
          operationCodecs: new OperationCodecRegistry([
            {
              id: "test-negative@1",
              integrate: (input) => codemirror.integrate(input),
              mapAnchors: () => ({ h: -1 }),
            },
            {
              id: "test-renaming@1",
              integrate: (input) => codemirror.integrate(input),
              mapAnchors: () => ({ other: 1 }),
            },
          ]),
        });
        const edit = (id: string, codec: string) => () =>
          commit(engine, [{
            ...applyOp(id, "alice:1", "hello", [changes(5, 0, "> ")]),
            codec,
          }]);
        try {
          setup(engine, "of:negative", "hello");
          commit(engine, [setAnchors("of:negative", { h: 1 })]);
          const negative = edit("of:negative", "test-negative@1");
          expect(negative).toThrow(OpCodecError);
          expect(negative).toThrow(
            "did not map the field's anchors to anchors: the result holds anchor h at something other than a non-negative integer offset",
          );

          setup(engine, "of:renaming", "hello");
          commit(engine, [setAnchors("of:renaming", { h: 1 })]);
          const renaming = edit("of:renaming", "test-renaming@1");
          expect(renaming).toThrow(OpCodecError);
          expect(renaming).toThrow("mapped the field's anchors to other ids");

          // Neither edit landed, and the anchors are as their writer left them.
          for (const id of ["of:negative", "of:renaming"]) {
            expect(snapshot(engine, id)).toMatchObject({
              active: false,
              materialized: "hello",
            });
            expect(storedAnchors(engine, id)).toEqual({ value: { h: 1 } });
          }
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("returns the rewrite as derived again when the commit is sent a second time", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:resent", "abc");
          commit(engine, [setAnchors("of:resent", { c: 2 })]);
          const resent = {
            sessionId: "session:alice",
            commit: {
              localSeq: ++seq,
              reads: { confirmed: [], pending: [] },
              operations: [
                applyOp("of:resent", "alice:1", "abc", [changes(3, 0, ">")]),
              ],
            },
          };

          const first = applyCommit(engine, resent);
          const second = applyCommit(engine, resent);

          expect(written(second)).toEqual(written(first));
          expect(written(second)).toContainEqual([
            anchorsDoc("of:resent"),
            "patch",
            true,
          ]);
          expect(storedAnchors(engine, "of:resent")).toEqual({
            value: { c: 3 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });

      it("leaves the document as it was when a later operation rejects the commit", async () => {
        const { engine, path } = await openTestEngine();
        try {
          setup(engine, "of:atomic", "abc");
          commit(engine, [
            applyOp("of:atomic", "alice:1", "abc", [changes(3, 3, "d")]),
          ]);
          commit(engine, [setAnchors("of:atomic", { a: 1 })]);

          expect(() =>
            commit(engine, [
              addAnchor("of:atomic", "b", 2),
              applyOp("of:atomic", "alice:2", { epoch: 1, version: 1 }, [
                changes(4, 0, ">"),
              ]),
              {
                op: "patch",
                id: "of:atomic",
                patches: [{ op: "replace", path: "/value/body", value: "xyz" }],
              },
            ])
          ).toThrow(OpFieldWriteConflictError);

          expect(snapshot(engine, "of:atomic")).toMatchObject({
            cursor: { epoch: 1, version: 1 },
            materialized: "abcd",
          });
          expect(storedAnchors(engine, "of:atomic")).toEqual({
            value: { a: 1 },
          });
        } finally {
          close(engine);
          await Deno.remove(path);
        }
      });
    });

    it("returns the document's anchors in the field's snapshot, and none without the document", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:snapshot", "hello");
        expect(snapshot(engine, "of:snapshot").anchors).toEqual({});

        commit(engine, [setAnchors("of:snapshot", { from: 1, to: 3 })]);
        expect(snapshot(engine, "of:snapshot").anchors).toEqual({
          from: 1,
          to: 3,
        });

        commit(engine, [
          applyOp("of:snapshot", "alice:1", "hello", [changes(5, 0, ">")]),
        ]);
        expect(snapshot(engine, "of:snapshot").active).toBe(true);
        expect(snapshot(engine, "of:snapshot").anchors).toEqual({
          from: 2,
          to: 4,
        });
        const current = queryOperationField(engine, {
          id: "of:snapshot",
          path: body,
          after: { epoch: 1, version: 1 },
        });
        expect(current.operations).toEqual([]);
        expect(current.anchors).toEqual({ from: 2, to: 4 });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("keeps the anchors document when the field is released, for the writer that replaces the value to move", async () => {
      const { engine, path } = await openTestEngine();
      const release = (
        id: string,
        cursor: { epoch: number; version: number },
      ): Operation => ({
        op: "release-op-field",
        id,
        path: body,
        codec: CODEMIRROR_CHANGESET_CODEC,
        cursor,
      });
      try {
        setup(engine, "of:released", "abc");
        commit(engine, [
          applyOp("of:released", "alice:1", "abc", [changes(3, 3, "d")]),
        ]);
        commit(engine, [setAnchors("of:released", { c: 2 })]);

        const released = commit(engine, [
          release("of:released", { epoch: 1, version: 1 }),
        ]);

        expect(written(released)).toEqual([]);
        expect(snapshot(engine, "of:released")).toMatchObject({
          active: false,
          materialized: "abcd",
          anchors: { c: 2 },
        });

        // A released field takes an ordinary write, and the writer that
        // replaces its value states the anchors against what it wrote.
        commit(engine, [
          { op: "set", id: "of:released", value: { value: { body: "xyz c" } } },
          setAnchors("of:released", { c: 4 }),
        ]);
        expect(storedAnchors(engine, "of:released")).toEqual({
          value: { c: 4 },
        });

        // The next activation maps the anchors the field then holds.
        commit(engine, [
          applyOp("of:released", "alice:2", "xyz c", [changes(5, 0, ">")]),
        ]);
        expect(snapshot(engine, "of:released")).toMatchObject({
          cursor: { epoch: 2, version: 1 },
          materialized: ">xyz c",
          anchors: { c: 5 },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("keeps the anchors document when its entity is deleted, for the entity created anew", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:deleted", "abc");
        commit(engine, [
          applyOp("of:deleted", "alice:1", "abc", [changes(3, 3, "d")]),
        ]);
        commit(engine, [setAnchors("of:deleted", { a: 1 })]);

        const deleted = commit(engine, [{ op: "delete", id: "of:deleted" }]);

        expect(written(deleted)).toEqual([["of:deleted", "delete", false]]);
        expect(storedAnchors(engine, "of:deleted")).toEqual({
          value: { a: 1 },
        });
        setup(engine, "of:deleted", "abcd");
        expect(snapshot(engine, "of:deleted").anchors).toEqual({ a: 1 });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("deletes the anchors document that the commit deleting its entity deletes", async () => {
      const { engine, path } = await openTestEngine();
      try {
        setup(engine, "of:both", "abc");
        commit(engine, [
          applyOp("of:both", "alice:1", "abc", [changes(3, 3, "d")]),
        ]);
        commit(engine, [setAnchors("of:both", { a: 1 })]);

        const deleted = commit(engine, [
          { op: "delete", id: "of:both" },
          { op: "delete", id: anchorsDoc("of:both") },
        ]);

        expect(written(deleted)).toEqual([
          ["of:both", "delete", false],
          [anchorsDoc("of:both"), "delete", false],
        ]);
        expect(storedAnchors(engine, "of:both")).toBeNull();
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });

    it("keeps the document through history pruning, and maps it through the edits after", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await open({
        url: toFileUrl(path),
        operationCheckpointInterval: 2,
      });
      try {
        setup(engine, "of:pruned", "ab");
        commit(engine, [setAnchors("of:pruned", { b: 1 })]);
        commit(engine, [
          applyOp("of:pruned", "alice:1", "ab", [changes(2, 0, "x")]),
        ]);
        for (const [version, insert] of [[1, "y"], [2, "z"]] as const) {
          commit(engine, [
            applyOp("of:pruned", `alice:${version + 1}`, {
              epoch: 1,
              version,
            }, [changes(version + 2, 0, insert)]),
          ]);
        }

        expect(pruneOperationFieldHistory(engine, {
          id: "of:pruned",
          path: body,
        })).toEqual({ cursor: { epoch: 1, version: 2 }, prunedOperations: 2 });
        expect(storedAnchors(engine, "of:pruned")).toEqual({
          value: { b: 4 },
        });

        commit(engine, [
          applyOp("of:pruned", "alice:4", { epoch: 1, version: 3 }, [
            changes(5, 0, "w"),
          ]),
        ]);
        expect(snapshot(engine, "of:pruned").materialized).toBe("wzyxab");
        expect(snapshot(engine, "of:pruned").anchors).toEqual({ b: 5 });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });
  });
});
