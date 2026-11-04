/**
 * Benchmarks Cell.set() for nested arrays in a local frame.
 *
 * Each array element is written as Writable.for(key).set(value), where key is
 * globally unique and stable across transactions. The parent array stores cell
 * links, while each array object lives in its own document.
 *
 * Environment controls:
 * - CELL_SET_NESTED_ARRAY_DEPTH: nested child-array levels, default 4
 * - CELL_SET_NESTED_ARRAY_WIDTH: objects per array level, default 4
 * - CELL_SET_NESTED_ARRAY_PAYLOAD_FIELDS: scalar fields per object, default 4
 * - CELL_SET_NESTED_ARRAY_RUNS: number of Cell.set() calls before commit, default 1
 * - CELL_SET_NESTED_ARRAY_UPDATE_TRANSACTIONS: update transactions, default 100
 * - CELL_SET_NESTED_ARRAY_UPDATE_PERCENT: percent of documents changed per update transaction, default 1
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { type Cell, type Frame } from "../src/builder/types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("bench nested array docs");
const space = signer.did();
const { commonfabric: { Writable } } = createBuilder();
const WRITABLE_FRAME_CAUSE = {
  type: "bench-cell-set-nested-array-docs-writable",
};

const DEPTH = readIntEnv("CELL_SET_NESTED_ARRAY_DEPTH", 4, 0);
const WIDTH = readIntEnv("CELL_SET_NESTED_ARRAY_WIDTH", 4, 1);
const PAYLOAD_FIELDS = readIntEnv("CELL_SET_NESTED_ARRAY_PAYLOAD_FIELDS", 4, 0);
const RUNS = readIntEnv("CELL_SET_NESTED_ARRAY_RUNS", 1, 1);
const UPDATE_TRANSACTIONS = readIntEnv(
  "CELL_SET_NESTED_ARRAY_UPDATE_TRANSACTIONS",
  100,
  1,
);
const UPDATE_PERCENT = readNumberEnv(
  "CELL_SET_NESTED_ARRAY_UPDATE_PERCENT",
  1,
  0,
);
const DOCUMENT_COUNT = countArrayObjects(DEPTH, WIDTH);
const SET_DOCUMENT_COUNT = DOCUMENT_COUNT * RUNS;
const UPDATE_COUNT = Math.min(
  DOCUMENT_COUNT,
  Math.floor(DOCUMENT_COUNT * (UPDATE_PERCENT / 100)),
);

type NestedArrayDocValue = {
  label: string;
  level: number;
  index: number;
  path: string;
  payload: Record<string, string | number | boolean>;
  children?: NestedArrayDocCell[];
};

type NestedArrayDocCell = Cell<any>;

type NestedArrayDocRef = {
  key: string;
  value: NestedArrayDocValue;
  container: NestedArrayDocCell[];
  index: number;
};

function readIntEnv(name: string, defaultValue: number, min: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      `${name} must be an integer >= ${min}; got ${JSON.stringify(raw)}`,
    );
  }

  return value;
}

function readNumberEnv(
  name: string,
  defaultValue: number,
  min: number,
): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return defaultValue;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(
      `${name} must be a number >= ${min}; got ${JSON.stringify(raw)}`,
    );
  }

  return value;
}

function countArrayObjects(depth: number, width: number): number {
  let total = 0;
  let levelCount = width;

  for (let level = 0; level <= depth; level++) {
    total += levelCount;
    levelCount *= width;
  }

  return total;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function chooseRandomDocs(
  docs: NestedArrayDocRef[],
  count: number,
  random: () => number,
): NestedArrayDocRef[] {
  const selected = new Set<number>();

  while (selected.size < count) {
    selected.add(Math.floor(random() * docs.length));
  }

  return [...selected].map((index) => docs[index]);
}

function makePayload(
  run: number,
  level: number,
  index: number,
): Record<string, string | number | boolean> {
  const payload: Record<string, string | number | boolean> = {};

  for (let field = 0; field < PAYLOAD_FIELDS; field++) {
    payload[`field${field}`] =
      `run-${run}:level-${level}:item-${index}:field-${field}`;
  }

  payload.run = run;
  payload.active = index % 2 === 0;
  return payload;
}

function makeDocumentKey(run: number, path: string): string {
  return `bench-cell-set-nested-array-docs:${run}:${path}`;
}

function makeNodes(
  run: number,
  level: number,
  maxDepth: number,
  path: string,
  docs: NestedArrayDocRef[] = [],
): NestedArrayDocCell[] {
  const cells: NestedArrayDocCell[] = [];

  for (let index = 0; index < WIDTH; index++) {
    const childPath = path === "" ? `${index}` : `${path}.${index}`;

    const value: NestedArrayDocValue = {
      label: `node-${run}-${childPath}`,
      level,
      index,
      path: childPath,
      payload: makePayload(run, level, index),
    };

    if (level < maxDepth) {
      value.children = makeNodes(
        run,
        level + 1,
        maxDepth,
        childPath,
        docs,
      );
    }

    const key = makeDocumentKey(run, childPath);
    const cell = Writable.for<any>(key).set(value) as NestedArrayDocCell;
    cells.push(cell);
    docs.push({ key, value, container: cells, index });
  }

  return cells;
}

function makeValueWithDocs(run: number): {
  value: NestedArrayDocCell[];
  docs: NestedArrayDocRef[];
} {
  const docs: NestedArrayDocRef[] = [];
  const value = makeNodes(run, 0, DEPTH, "", docs);
  return { value, docs };
}

function setup() {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx: IExtendedStorageTransaction,
) {
  if (tx.status().status === "ready") {
    tx.abort();
  }
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench({
  name:
    `Cell.set() nested array docs - depth=${DEPTH}, width=${WIDTH}, docs=${SET_DOCUMENT_COUNT}, runs=${RUNS}`,
  group: "cell-set-nested-array-docs",
  async fn(b) {
    const { runtime, storageManager, tx } = setup();
    const frame: Frame = pushFrame({
      cause: {
        ...WRITABLE_FRAME_CAUSE,
        operation: "set",
        depth: DEPTH,
        width: WIDTH,
        runs: RUNS,
      },
      runtime,
      tx,
      space,
      inHandler: true,
    });
    const cell = runtime.getCell<NestedArrayDocCell[]>(
      space,
      "bench-cell-set-nested-array-docs",
      undefined,
      tx,
    );
    const values = Array.from(
      { length: RUNS },
      (_, run) => makeNodes(run, 0, DEPTH, ""),
    );

    try {
      b.start();
      for (let run = 0; run < RUNS; run++) {
        cell.set(values[run]!);
      }
      await tx.commit().settled;
      b.end();
    } finally {
      popFrame(frame);
      await cleanup(runtime, storageManager, tx);
    }
  },
});

Deno.bench({
  name:
    `Cell.set() nested array docs update - depth=${DEPTH}, width=${WIDTH}, docs=${DOCUMENT_COUNT}, txs=${UPDATE_TRANSACTIONS}, root-sets=${UPDATE_TRANSACTIONS}, changed/tx=${UPDATE_COUNT}`,
  group: "cell-set-nested-array-docs",
  async fn(b) {
    const { runtime, storageManager, tx: setupTx } = setup();
    const setupFrame: Frame = pushFrame({
      cause: {
        ...WRITABLE_FRAME_CAUSE,
        operation: "update",
        depth: DEPTH,
        width: WIDTH,
      },
      runtime,
      tx: setupTx,
      space,
      inHandler: true,
    });
    const setupCell = runtime.getCell<NestedArrayDocCell[]>(
      space,
      "bench-cell-set-nested-array-docs-update",
      undefined,
      setupTx,
    );

    let currentValue: NestedArrayDocCell[] = [];
    let docs: NestedArrayDocRef[] = [];
    try {
      ({ value: currentValue, docs } = makeValueWithDocs(0));
      setupCell.set(currentValue);
      await setupTx.commit().settled;
    } finally {
      popFrame(setupFrame);
    }

    try {
      const random = makeRandom(0x5eed);
      const updates = Array.from(
        { length: UPDATE_TRANSACTIONS },
        () => chooseRandomDocs(docs, UPDATE_COUNT, random),
      );

      b.start();
      for (
        let transaction = 0;
        transaction < UPDATE_TRANSACTIONS;
        transaction++
      ) {
        const tx = runtime.edit();
        const frame = pushFrame({
          cause: {
            ...WRITABLE_FRAME_CAUSE,
            operation: "update",
          },
          runtime,
          tx,
          space,
          inHandler: true,
        });
        const cell = runtime.getCell<NestedArrayDocCell[]>(
          space,
          "bench-cell-set-nested-array-docs-update",
          undefined,
          tx,
        );

        try {
          for (let update = 0; update < updates[transaction].length; update++) {
            const doc = updates[transaction][update];
            doc.value.payload.mutation = `tx-${transaction}:update-${update}`;
            doc.container[doc.index] = Writable
              .for<any>(doc.key)
              .set(doc.value) as NestedArrayDocCell;
          }
          // Exercise the top-level Cell.set() diff path after mutating the
          // retained in-memory tree.
          cell.set(currentValue);
          await tx.commit().settled;
        } finally {
          popFrame(frame);
          if (tx.status().status === "ready") {
            tx.abort();
          }
        }
      }
      b.end();
    } finally {
      await cleanup(runtime, storageManager, setupTx);
    }
  },
});
