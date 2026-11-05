import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  open,
  pruneOperationFieldHistory,
} from "@commonfabric/memory/v2/engine";
import {
  CODEMIRROR_CHANGESET_CODEC,
  encodeMemoryBoundary,
  operationAnchorsDocId,
  resolveScopeKey,
  toValuePath,
} from "@commonfabric/memory/v2";
import {
  operationBaselineHash,
  OperationCodecRegistry,
} from "@commonfabric/memory/v2/operation-codec";

import { openSpace } from "../db.ts";
import { inspectOperationFields } from "../operations.ts";

const append = (length: number, value: string) => [length, [0, value]];

describe("operation field inspection", () => {
  it("rejects invalid bounds before inspecting store capabilities", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    try {
      const space = openSpace(path);
      try {
        expect(() => inspectOperationFields(space, { fieldLimit: 0 }))
          .toThrow("between 1 and 1000");
        expect(() => inspectOperationFields(space, { historyLimit: 1001 }))
          .toThrow("between 1 and 1000");
      } finally {
        space.close();
      }
    } finally {
      await Deno.remove(path);
    }
  });

  it("treats a metadata-only document root as null", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({
      url: toFileUrl(path),
      operationCodecs: new OperationCodecRegistry([{
        id: "root-null@1",
        integrate: ({ submitted }) => ({
          materialized: null,
          operations: [submitted],
        }),
        mapAnchors: ({ anchors }) => anchors,
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
            id: "of:metadata-root",
            value: {},
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
            id: "of:metadata-root",
            path: toValuePath([]),
            codec: "root-null@1",
            submissionId: "root:1",
            base: null,
            baselineHash: operationBaselineHash(null),
            payload: null,
          }],
        },
      });
    } finally {
      close(engine);
    }

    try {
      const space = openSpace(path);
      try {
        expect(inspectOperationFields(space).fields[0].consistency)
          .toMatchObject({
            ordinaryMaterializedMatches: true,
            healthy: true,
          });
      } finally {
        space.close();
      }
    } finally {
      await Deno.remove(path);
    }
  });

  it("reports retained history and detects checkpoint corruption", async () => {
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
            id: "of:inspected",
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
            id: "of:inspected",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: append(1, "b") }],
            },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:inspected",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "bob:1",
            base: { epoch: 1, version: 1 },
            payload: {
              updates: [{ clientId: "bob", changes: append(2, "c") }],
            },
          }],
        },
      });
      pruneOperationFieldHistory(engine, {
        id: "of:inspected",
        path: toValuePath(["body"]),
      });
    } finally {
      close(engine);
    }

    try {
      const space = openSpace(path);
      try {
        const report = inspectOperationFields(space, { id: "of:inspected" });
        expect(report).toMatchObject({
          available: true,
          fieldsTruncated: false,
          fields: [{
            address: {
              branch: "",
              id: "of:inspected",
              scope: "space",
              path: ["body"],
              pathPointer: "/body",
            },
            active: true,
            codec: CODEMIRROR_CHANGESET_CODEC,
            cursor: { epoch: 1, version: 2 },
            materialized: "abc",
            retainedFrom: { epoch: 1, version: 2 },
            submissions: [{ submissionId: "alice:1" }, {
              submissionId: "bob:1",
            }],
            integrated: [],
            checkpoints: [{ version: 0 }, {
              version: 2,
              matchesCurrentHead: true,
            }],
            consistency: {
              baselineCheckpointPresent: true,
              retainedSuffixContiguous: true,
              ordinaryMaterializedMatches: true,
              currentCheckpointMatches: true,
              healthy: true,
            },
          }],
        });
      } finally {
        space.close();
      }

      const database = new Database(path);
      try {
        database.prepare(`
          UPDATE op_checkpoint SET materialized = ?
          WHERE id = 'of:inspected' AND epoch = 1 AND version = 2
        `).run(encodeMemoryBoundary("corrupt"));
      } finally {
        database.close();
      }
      const corrupted = openSpace(path);
      try {
        expect(inspectOperationFields(corrupted).fields[0].consistency)
          .toMatchObject({
            currentCheckpointMatches: false,
            healthy: false,
          });
      } finally {
        corrupted.close();
      }

      const materializedDatabase = new Database(path);
      try {
        materializedDatabase.prepare(`
          UPDATE op_field_epoch SET materialized = 'not-a-stored-value'
          WHERE id = 'of:inspected'
        `).run();
      } finally {
        materializedDatabase.close();
      }
      const malformedMaterialized = openSpace(path);
      try {
        const report = inspectOperationFields(malformedMaterialized, {
          id: "of:inspected",
          scope: "space",
        });
        expect(report.fields).toHaveLength(1);
        expect(report.fields[0].materialized).toMatchObject({
          stored: "not-a-stored-value",
        });
        expect(
          inspectOperationFields(malformedMaterialized, {
            scope: "other",
          }).fields,
        ).toEqual([]);
      } finally {
        malformedMaterialized.close();
      }

      const pointerDatabase = new Database(path);
      try {
        pointerDatabase.prepare(`
          UPDATE op_field_epoch SET path = 'not-a-json-pointer'
          WHERE id = 'of:inspected'
        `).run();
      } finally {
        pointerDatabase.close();
      }
      const malformedPointer = openSpace(path);
      try {
        expect(inspectOperationFields(malformedPointer).fields[0])
          .toMatchObject({
            address: {
              path: [],
              pathPointer: "not-a-json-pointer",
            },
            consistency: { healthy: false },
          });
      } finally {
        malformedPointer.close();
      }
    } finally {
      await Deno.remove(path);
    }
  });

  it("keeps every submission from a commit on the same page", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({ url: toFileUrl(path) });
    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:paged",
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
            id: "of:paged",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: append(1, "b") }],
            },
          }, {
            op: "apply-op",
            id: "of:paged",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:2",
            base: { epoch: 1, version: 1 },
            payload: {
              updates: [{ clientId: "alice", changes: append(2, "c") }],
            },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:paged",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "bob:1",
            base: { epoch: 1, version: 2 },
            payload: {
              updates: [{ clientId: "bob", changes: append(3, "d") }],
            },
          }],
        },
      });
    } finally {
      close(engine);
    }

    try {
      const space = openSpace(path);
      try {
        const first = inspectOperationFields(space, {
          id: "of:paged",
          historyLimit: 1,
        }).fields[0];
        expect(first.submissions.map((row) => row.submissionId)).toEqual([
          "alice:1",
          "alice:2",
        ]);
        expect(first.submissions[0].commitSeq).toBe(
          first.submissions[1].commitSeq,
        );
        expect(first.pagination.submissionsTruncated).toBe(true);
        expect(first.pagination.nextSubmissionAfterSeq).toBe(
          first.submissions[1].commitSeq,
        );

        const second = inspectOperationFields(space, {
          id: "of:paged",
          historyLimit: 1,
          submissionAfterSeq: first.pagination.nextSubmissionAfterSeq!,
        }).fields[0];
        expect(second.submissions.map((row) => row.submissionId)).toEqual([
          "bob:1",
        ]);
        expect(second.pagination.submissionsTruncated).toBe(false);
      } finally {
        space.close();
      }
    } finally {
      await Deno.remove(path);
    }
  });

  it("reports retained integrated history from prior epochs", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({ url: toFileUrl(path) });
    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:epochs",
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
            id: "of:epochs",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "epoch-1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{ clientId: "alice", changes: append(1, "b") }],
            },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:alice",
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "release-op-field",
            id: "of:epochs",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            cursor: { epoch: 1, version: 1 },
          }],
        },
      });
      applyCommit(engine, {
        sessionId: "session:bob",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:epochs",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "epoch-2",
            base: null,
            baselineHash: operationBaselineHash("ab"),
            payload: {
              updates: [{ clientId: "bob", changes: append(2, "c") }],
            },
          }],
        },
      });
    } finally {
      close(engine);
    }

    try {
      const space = openSpace(path);
      try {
        const field = inspectOperationFields(space, { id: "of:epochs" })
          .fields[0];
        expect(field.cursor).toEqual({ epoch: 2, version: 1 });
        expect(field.integrated.map((row) => row.epoch)).toEqual([1, 2]);
        expect(field.integrated.map((row) => row.submissionId)).toEqual([
          "epoch-1",
          "epoch-2",
        ]);
      } finally {
        space.close();
      }
    } finally {
      await Deno.remove(path);
    }
  });

  describe("a field's anchors", () => {
    const body = toValuePath(["body"]);

    /** An `apply-op` on `id`'s `body`, which holds `ab`, inserting `c` ahead. */
    const insertAhead = (id: string) => ({
      op: "apply-op" as const,
      id,
      path: body,
      codec: CODEMIRROR_CHANGESET_CODEC,
      submissionId: "alice:1",
      base: null,
      baselineHash: operationBaselineHash("ab"),
      payload: { updates: [{ clientId: "alice", changes: [[0, "c"], 2] }] },
    });

    /** The inspection of the one field of entity `id` in the store at `path`. */
    const inspectOnly = (path: string, id: string) => {
      const space = openSpace(path);
      try {
        const { fields } = inspectOperationFields(space, { id });
        expect(fields).toHaveLength(1);
        return fields[0];
      } finally {
        space.close();
      }
    };

    it("addresses a per-user field's anchors document by scope name and reports one that holds no anchor map", async () => {
      const principal = "did:key:z6MkAnchoredUser";
      const scopeKey = resolveScopeKey("user", { principal });
      const documentId = operationAnchorsDocId({
        id: "of:mine",
        scope: "user",
        path: ["body"],
      });
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      try {
        const engine = await open({ url: toFileUrl(path) });
        try {
          applyCommit(engine, {
            sessionId: "session:alice",
            principal,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: "of:mine",
                scope: "user",
                value: { value: { body: "ab" } },
              }, {
                op: "set",
                id: documentId,
                scope: "user",
                value: { value: { a: 0, b: 1 } },
              }],
            },
          });
          applyCommit(engine, {
            sessionId: "session:alice",
            principal,
            commit: {
              localSeq: 2,
              reads: { confirmed: [], pending: [] },
              operations: [{ ...insertAhead("of:mine"), scope: "user" }],
            },
          });
        } finally {
          close(engine);
        }

        const moved = inspectOnly(path, "of:mine");
        expect(moved.address.scope).toBe(scopeKey);
        expect(moved.anchors).toEqual({ a: 0, b: 2 });
        expect(moved).toMatchObject({
          anchorsCommitSeq: 2,
          anchorsDocumentId: documentId,
          consistency: { anchorsDocumentValid: true, healthy: true },
        });

        // The edit rewrote the document with a patch of its value, which is
        // the row that decides what the document holds.
        const corrupt = new Database(path);
        try {
          corrupt.prepare(
            "UPDATE revision SET data = :data WHERE id = :id AND op = 'patch'",
          ).run({
            id: documentId,
            data: encodeMemoryBoundary([{
              op: "replace",
              path: "/value",
              value: { a: { from: 0, to: 1 } },
            }]),
          });
        } finally {
          corrupt.close();
        }
        const malformed = inspectOnly(path, "of:mine");
        expect(malformed.anchors).toEqual({});
        expect(malformed.consistency).toMatchObject({
          anchorsDocumentValid: false,
          healthy: false,
        });
      } finally {
        await Deno.remove(path);
      }
    });

    it("reads the anchors from the document alone, with and without `anchors` columns in the operation tables", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      try {
        const engine = await open({
          url: toFileUrl(path),
          operationCheckpointInterval: 1,
        });
        try {
          applyCommit(engine, {
            sessionId: "session:alice",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: "of:columns",
                value: { value: { body: "ab" } },
              }, {
                op: "set",
                id: operationAnchorsDocId({
                  id: "of:columns",
                  path: ["body"],
                }),
                value: { value: { b: 1 } },
              }, insertAhead("of:columns")],
            },
          });
        } finally {
          close(engine);
        }
        const without = inspectOnly(path, "of:columns");
        expect(without.anchors).toEqual({ b: 2 });
        expect(without.checkpoints).toEqual([
          expect.objectContaining({ version: 0 }),
          expect.objectContaining({ version: 1, matchesCurrentHead: true }),
        ]);

        const columns = new Database(path);
        try {
          const stored = encodeMemoryBoundary([{ id: "c", from: 0, to: 1 }]);
          columns.exec("ALTER TABLE op_field_epoch ADD COLUMN anchors JSON");
          columns.exec(
            "ALTER TABLE op_field_epoch ADD COLUMN anchors_seq INTEGER",
          );
          columns.exec("ALTER TABLE op_checkpoint ADD COLUMN anchors JSON");
          columns.exec("ALTER TABLE op_submission ADD COLUMN anchors JSON");
          columns.prepare(
            "UPDATE op_field_epoch SET anchors = ?, anchors_seq = 9",
          ).run(stored);
          columns.prepare("UPDATE op_checkpoint SET anchors = ?").run(stored);
          columns.prepare("UPDATE op_submission SET anchors = ?").run(stored);
        } finally {
          columns.close();
        }

        expect(inspectOnly(path, "of:columns")).toEqual(without);
      } finally {
        await Deno.remove(path);
      }
    });

    it("reports no anchors for a field whose document was never written or was deleted, and the anchors a released field keeps", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const anchorsOf = (id: string) =>
        operationAnchorsDocId({ id, path: ["body"] });
      try {
        const engine = await open({ url: toFileUrl(path) });
        try {
          applyCommit(engine, {
            sessionId: "session:alice",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: ["of:unwritten", "of:released", "of:cleared"]
                .flatMap((id) => [{
                  op: "set" as const,
                  id,
                  value: { value: { body: "ab" } },
                }, insertAhead(id)]),
            },
          });
          applyCommit(engine, {
            sessionId: "session:alice",
            commit: {
              localSeq: 2,
              reads: { confirmed: [], pending: [] },
              operations: ["of:released", "of:cleared"].map((id) => ({
                op: "set" as const,
                id: anchorsOf(id),
                value: { value: { b: 2 } },
              })),
            },
          });
          applyCommit(engine, {
            sessionId: "session:alice",
            commit: {
              localSeq: 3,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "release-op-field",
                id: "of:released",
                path: body,
                codec: CODEMIRROR_CHANGESET_CODEC,
                cursor: { epoch: 1, version: 1 },
              }, { op: "delete", id: anchorsOf("of:cleared") }],
            },
          });
        } finally {
          close(engine);
        }

        const unwritten = inspectOnly(path, "of:unwritten");
        expect(unwritten).toMatchObject({
          active: true,
          anchorsCommitSeq: null,
          consistency: { anchorsDocumentValid: null, healthy: true },
        });
        expect(unwritten.anchors).toEqual({});
        const cleared = inspectOnly(path, "of:cleared");
        expect(cleared).toMatchObject({
          active: true,
          anchorsCommitSeq: 3,
          consistency: { anchorsDocumentValid: null, healthy: true },
        });
        expect(cleared.anchors).toEqual({});
        const released = inspectOnly(path, "of:released");
        expect(released).toMatchObject({
          active: false,
          anchorsCommitSeq: 2,
          consistency: { anchorsDocumentValid: true, healthy: true },
        });
        expect(released.anchors).toEqual({ b: 2 });
      } finally {
        await Deno.remove(path);
      }
    });
  });
});
