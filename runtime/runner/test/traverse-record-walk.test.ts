/**
 * How `SchemaObjectTraverser` treats a walk that attributes what it reaches
 * by record (`TraversalContext.records`): which memoized results stand for a
 * position, and the position tokens it keeps in `RecordWalk.positions`.
 */

import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import type {
  Entity,
  MemorySpace,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import { describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  type AttributionEntry,
  createDefaultTraversalContext,
  createSchemaMemo,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  type MemoizedAttributions,
  type RecordWalk,
  type SchemaMemo,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const SPACE = "did:null:null" as MemorySpace;
const TYPE = "application/json" as const;
const ROOT = "of:record-walk-root" as URI;
const CHILD = "of:record-walk-child" as URI;

const IDENTITY = { principal: "did:test:alice", sessionId: "session-1" };

const SCHEMA: JSONSchema = internSchema<JSONSchema>({
  type: "object",
  properties: {
    child: { type: "object", properties: { n: { type: "number" } } },
  },
});

const ROOT_VALUE: FabricValue = {
  child: { "/": { [LINK_V1_TAG]: { id: CHILD, path: [] } } },
};

/** A store holding the root, which links to the child, and the child. */
function store(): Map<string, Revision<State>> {
  const docs: Record<string, FabricValue> = {
    [ROOT]: ROOT_VALUE,
    [CHILD]: { n: 1 },
  };
  const result = new Map<string, Revision<State>>();
  for (const [id, value] of Object.entries(docs)) {
    result.set(`${id}/${TYPE}`, {
      the: TYPE,
      of: id as Entity,
      is: { value },
      since: 1,
    });
  }
  return result;
}

/**
 * A record walk that keeps one list of attributions for every document,
 * calls `onPositionOf` as each position begins, and keeps every memoized
 * position it is asked to replay.
 */
function recordWalk(onPositionOf: () => void = () => {}) {
  const made: AttributionEntry[] = [];
  const replayed: MemoizedAttributions[] = [];
  const records: RecordWalk = {
    positions: [],
    positionOf: () => {
      onPositionOf();
      return { made, instance: undefined, replayable: true };
    },
    replay: (memoized) => {
      replayed.push(memoized);
      made.push(memoized);
      return true;
    },
  };
  return { records, replayed };
}

/**
 * Walks the root document as a query does, sharing `memo`, attributing by
 * `records` where given, and returns the result with the ids of the
 * documents the walk recorded in its schema tracker.
 */
function walk(memo: SchemaMemo, records?: RecordWalk) {
  const tracker = new MapSetStringToPathSelectors(true);
  const context = createDefaultTraversalContext(IDENTITY, true, tracker);
  if (records !== undefined) context.records = records;
  const traverser = new SchemaObjectTraverser(
    new ExtendedStorageTransaction(
      new ManagedStorageTransaction(new StoreObjectManager(store())),
    ),
    { path: ["value"], schema: SCHEMA },
    context,
    undefined,
    memo,
  );
  const { ok } = traverser.traverse({
    address: { space: SPACE, id: ROOT, type: TYPE, path: ["value"] },
    value: ROOT_VALUE,
  });
  const reached = [...new Set([...tracker].map(([key]) => key))]
    .map((key) => key.split("/").at(-1))
    .sort();
  return { ok, reached };
}

describe("traverse-record-walk", () => {
  describe("a schema memo shared between walks", () => {
    it("traverses again a position a walk that attributes nothing memoized, reaching the linked document", () => {
      const memo = createSchemaMemo();
      expect(walk(memo).reached).toEqual([CHILD, ROOT]);

      const { records, replayed } = recordWalk();
      expect(walk(memo, records)).toEqual({
        ok: { child: { n: 1 } },
        reached: [CHILD, ROOT],
      });
      expect(replayed).toEqual([]);
    });

    it("replays a position a walk that attributes memoized, without reaching the linked document", () => {
      const memo = createSchemaMemo();
      walk(memo, recordWalk().records);

      const { records, replayed } = recordWalk();
      expect(walk(memo, records)).toEqual({
        ok: { child: { n: 1 } },
        reached: [ROOT],
      });
      expect(replayed.length).toBeGreaterThan(0);
    });
  });

  describe("a position whose beginning throws", () => {
    it("removes the position's token before the error reaches the caller", () => {
      const { records } = recordWalk(() => {
        throw new Error("no position for this record");
      });

      expect(() => walk(createSchemaMemo(), records)).toThrow(
        "no position for this record",
      );
      expect(records.positions).toEqual([]);
    });
  });
});
