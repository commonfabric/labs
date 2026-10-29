import type { FabricValue } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { ChangeSet } from "@codemirror/state";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  type Engine,
  open,
  pruneOperationFieldHistory,
  queryOperationField,
} from "../v2/engine.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
  type OperationCodec,
  OperationCodecRegistry,
} from "../v2/operation-codec.ts";
import { toValuePath } from "../v2.ts";

const SOURCE_BYTES = 100_000;
const SUFFIX_OPERATIONS = 100;
const CHECKPOINT_REPLAY_OPERATIONS = 50;
const TEXT_ID = "of:operation-benchmark-text";
const STRUCTURED_ID = "of:operation-benchmark-structured";
const BODY_PATH = toValuePath(["body"]);

const createEngine = async (options: Parameters<typeof open>[0] = {
  url: new URL("memory:///unused"),
}) => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  return {
    engine: await open({ ...options, url: toFileUrl(path) }),
    path,
  };
};

const cleanupEngine = async (engine: Engine, path: string) => {
  close(engine);
  await Deno.remove(path);
};

const setText = (engine: Engine, text: string) => {
  applyCommit(engine, {
    sessionId: "session:setup",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: TEXT_ID,
        value: { value: { body: text } },
      }],
    },
  });
};

const appendTextOperations = (
  engine: Engine,
  baseline: string,
  count: number,
) => {
  let length = baseline.length;
  for (let version = 0; version < count; version++) {
    applyCommit(engine, {
      sessionId: "session:writer",
      commit: {
        localSeq: version + 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: TEXT_ID,
          path: BODY_PATH,
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: `writer:${version + 1}`,
          base: version === 0 ? null : { epoch: 1, version },
          ...(version === 0
            ? { baselineHash: operationBaselineHash(baseline) }
            : {}),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: length, insert: "x" }, length)
                .toJSON(),
            }],
          },
        }],
      },
    });
    length++;
  }
};

Deno.bench({
  name: `apply 100KB text operation over ${SUFFIX_OPERATIONS}-operation suffix`,
  group: "memory apply-op",
  n: 1,
  warmup: 0,
  async fn(benchmark) {
    const baseline = "a".repeat(SOURCE_BYTES);
    const { engine, path } = await createEngine();
    try {
      setText(engine, baseline);
      appendTextOperations(engine, baseline, SUFFIX_OPERATIONS);
      benchmark.start();
      applyCommit(engine, {
        sessionId: "session:stale",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: TEXT_ID,
            path: BODY_PATH,
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "stale:1",
            base: { epoch: 1, version: 0 },
            payload: {
              updates: [{
                clientId: "stale",
                changes: ChangeSet.of(
                  { from: SOURCE_BYTES / 2, insert: "!" },
                  SOURCE_BYTES,
                ).toJSON(),
              }],
            },
          }],
        },
      });
      benchmark.end();
    } finally {
      await cleanupEngine(engine, path);
    }
  },
});

Deno.bench({
  name: `query ${SUFFIX_OPERATIONS}-operation text suffix`,
  group: "memory apply-op",
  n: 1,
  warmup: 0,
  async fn(benchmark) {
    const baseline = "a".repeat(SOURCE_BYTES);
    const { engine, path } = await createEngine();
    try {
      setText(engine, baseline);
      appendTextOperations(engine, baseline, SUFFIX_OPERATIONS);
      benchmark.start();
      queryOperationField(engine, {
        id: TEXT_ID,
        path: BODY_PATH,
        after: { epoch: 1, version: 0 },
      });
      benchmark.end();
    } finally {
      await cleanupEngine(engine, path);
    }
  },
});

Deno.bench({
  name:
    `verify checkpoint and replay ${CHECKPOINT_REPLAY_OPERATIONS} text operations before pruning`,
  group: "memory apply-op",
  n: 1,
  warmup: 0,
  async fn(benchmark) {
    const baseline = "a".repeat(SOURCE_BYTES);
    const { engine, path } = await createEngine({
      url: new URL("memory:///unused"),
      operationCheckpointInterval: SUFFIX_OPERATIONS,
    });
    try {
      setText(engine, baseline);
      appendTextOperations(
        engine,
        baseline,
        SUFFIX_OPERATIONS + CHECKPOINT_REPLAY_OPERATIONS,
      );
      benchmark.start();
      pruneOperationFieldHistory(engine, { id: TEXT_ID, path: BODY_PATH });
      benchmark.end();
    } finally {
      await cleanupEngine(engine, path);
    }
  },
});

type StructuredDocument = {
  nodes: Array<{ id: string; text: string }>;
};

const structuredCodec: OperationCodec = {
  id: "synthetic-structured-document@1",
  integrate({ materialized, submitted }) {
    const document = materialized as StructuredDocument;
    const node = (submitted as { append?: FabricValue }).append;
    if (
      !Array.isArray(document?.nodes) || !isObjectNotArray(node) ||
      typeof (node as { id?: unknown }).id !== "string" ||
      typeof (node as { text?: unknown }).text !== "string"
    ) {
      throw new Error("structured benchmark operation is malformed");
    }
    const operation = { append: node } as FabricValue;
    return {
      materialized: {
        nodes: [...document.nodes, node],
      } as FabricValue,
      operations: [operation],
    };
  },
};

Deno.bench({
  name:
    `apply structured operation to 1000-node document over ${SUFFIX_OPERATIONS}-operation suffix`,
  group: "memory apply-op",
  n: 1,
  warmup: 0,
  async fn(benchmark) {
    const document: StructuredDocument = {
      nodes: Array.from({ length: 1_000 }, (_, index) => ({
        id: `node:${index}`,
        text: "x".repeat(100),
      })),
    };
    const { engine, path } = await createEngine({
      url: new URL("memory:///unused"),
      operationCodecs: new OperationCodecRegistry([structuredCodec]),
    });
    try {
      applyCommit(engine, {
        sessionId: "session:setup",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: STRUCTURED_ID,
            value: { value: { body: document } },
          }],
        },
      });
      for (let version = 0; version < SUFFIX_OPERATIONS; version++) {
        applyCommit(engine, {
          sessionId: "session:writer",
          commit: {
            localSeq: version + 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: STRUCTURED_ID,
              path: BODY_PATH,
              codec: structuredCodec.id,
              submissionId: `writer:${version + 1}`,
              base: version === 0 ? null : { epoch: 1, version },
              ...(version === 0
                ? { baselineHash: operationBaselineHash(document) }
                : {}),
              payload: {
                append: { id: `append:${version}`, text: "y".repeat(100) },
              },
            }],
          },
        });
      }
      benchmark.start();
      applyCommit(engine, {
        sessionId: "session:stale",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: STRUCTURED_ID,
            path: BODY_PATH,
            codec: structuredCodec.id,
            submissionId: "stale:1",
            base: { epoch: 1, version: 0 },
            payload: {
              append: { id: "stale", text: "z".repeat(100) },
            },
          }],
        },
      });
      benchmark.end();
    } finally {
      await cleanupEngine(engine, path);
    }
  },
});
