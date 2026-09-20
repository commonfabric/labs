// Cell array tests: element conversion plus optimized plain-schema traversal.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { DATA_URI_MEDIA_TYPE } from "@commonfabric/data-model/codec-data-uri";

import "@commonfabric/utils/equal-ignoring-symbols";

import { Writable } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { toCell } from "../src/back-to-cell.ts";
import { JSONSchema } from "../src/builder/types.ts";
import { type Cell, elementSchemaFor, isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isLinkResolutionProbe } from "../src/storage/reactivity-log.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Cell array element conversion", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("creates links to the elements for non-link array items", async () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { foo: { type: "number" } },
        asCell: ["cell"],
      },
    } as const satisfies JSONSchema;
    const refCell = runtime.getCell<{ foo: number }[]>(
      space,
      "array-cell-contents",
      schema,
      tx,
    );
    refCell.setRaw([{ foo: 1 }, { foo: 2 }, { foo: 3 }]);

    // Commit transaction to persist data
    await tx.commit();
    await runtime.idle();

    tx = runtime.edit();
    const { ok: entry } = tx.read({
      space,
      id: refCell.getAsNormalizedFullLink().id,
      path: ["value"],
    });
    expect(entry?.value).toEqual([{ foo: 1 }, { foo: 2 }, { foo: 3 }]);

    tx = runtime.edit();

    const result = refCell.get();

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      const first = result[0];
      expect(isCell(first)).toBe(true);
      const firstCell = first as Writable<{ foo: number }>;
      const link = firstCell.getAsNormalizedFullLink();
      expect(link.space).toBe(space);
      expect(typeof link.id).toBe("string");
      expect(link.id.startsWith("of:")).toBe(true);
      expect(link.id.length).toBeGreaterThan(3);
      expect(link.path).toEqual(["0"]);
      expect(link.schema).toEqual(
        { type: "object", properties: { foo: { type: "number" } } },
      );
    }
  });
});

type Row = {
  data: { id: string; label: string };
  label: string;
  aliases: string[];
};

const ROWS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
        },
      },
      label: { type: "string" },
      aliases: { type: "array", items: { type: "string" } },
    },
  },
} as const satisfies JSONSchema;

describe("plain-schema array traversal", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    if (tx.status().status === "ready") tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  async function seed(id: string, value: unknown): Promise<void> {
    runtime.getCell(space, id, undefined, tx).set(value);
    await tx.commit();
    tx = runtime.edit();
  }

  async function seedRaw(id: string, value: FabricValue): Promise<void> {
    runtime.getCell(space, id, undefined, tx).setRawUntyped(value);
    await tx.commit();
    tx = runtime.edit();
  }

  it("accepts integer values in plain number schemas", async () => {
    await seed("plain-schema-numbers", {
      count: 1,
      values: [1, 1.5, 2],
    });

    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
        values: { type: "array", items: { type: "number" } },
      },
    } as const satisfies JSONSchema;
    const cell = runtime.getCell<{
      count: number;
      values: number[];
    }>(space, "plain-schema-numbers", schema, tx);

    expect(cell.get()).toEqual({
      count: 1,
      values: [1, 1.5, 2],
    });
  });

  it("materializes linked rows with projection, hooks, and stable mutation", async () => {
    await seed("plain-schema-rows", [{
      data: { id: "one", label: "First", ignored: "nested" },
      label: "First",
      aliases: ["one", "first"],
      ignored: "top-level",
    }, {
      data: { id: "two", label: "Second" },
      label: "Second",
      aliases: ["two"],
    }]);

    const cell = runtime.getCell<Row[]>(
      space,
      "plain-schema-rows",
      ROWS_SCHEMA,
      tx,
    );
    const rows = cell.get();

    expect(rows).toEqual([{
      data: { id: "one", label: "First" },
      label: "First",
      aliases: ["one", "first"],
    }, {
      data: { id: "two", label: "Second" },
      label: "Second",
      aliases: ["two"],
    }]);
    expect(toCell in rows).toBe(true);
    expect(toCell in rows[0]).toBe(true);
    expect(toCell in rows[0].data).toBe(true);
    expect(toCell in rows[0].aliases).toBe(true);

    const firstRowCell = (rows[0] as Row & {
      [toCell](): Cell<Row>;
    })[toCell]();
    expect(firstRowCell.getAsNormalizedFullLink().id).not.toBe(
      cell.getAsNormalizedFullLink().id,
    );

    firstRowCell.set({
      data: { id: "one", label: "Updated" },
      label: "Updated",
      aliases: ["one", "updated"],
    });
    expect(cell.get()[0]).toEqual({
      data: { id: "one", label: "Updated" },
      label: "Updated",
      aliases: ["one", "updated"],
    });
  });

  it("batches ordinary linked item scheduling reads", async () => {
    await seed("batched-plain-schema-rows", [{
      data: { id: "one", label: "First" },
      label: "First",
      aliases: ["one"],
    }, {
      data: { id: "two", label: "Second" },
      label: "Second",
      aliases: ["two"],
    }]);

    const cell = runtime.getCell<Row[]>(
      space,
      "batched-plain-schema-rows",
      ROWS_SCHEMA,
      tx,
    );
    const sourceId = cell.getAsNormalizedFullLink().id;
    const nativeTrackReadPaths = tx.trackReadPaths!.bind(tx);
    const sourceBatches: boolean[] = [];
    tx.trackReadPaths = (address, paths, options) => {
      if (address.id === sourceId && paths.length === 2) {
        sourceBatches.push(options?.nonRecursive === true);
      }
      return nativeTrackReadPaths(address, paths, options);
    };

    const rows = cell.get();
    expect(rows.map(({ label }) => label)).toEqual(["First", "Second"]);
    expect(sourceBatches).toEqual([true, false]);

    const batchedActivities = [...getTransactionReadActivities(tx)];
    const sourceItemActivities = batchedActivities.filter((activity) =>
      activity.id === sourceId && activity.path.length === 2
    );
    expect(
      sourceItemActivities.map((activity) => ({
        index: activity.path[1],
        shallow: activity.nonRecursive === true,
      })),
    ).toEqual([
      { index: "0", shallow: true },
      { index: "1", shallow: true },
      { index: "0", shallow: false },
      { index: "1", shallow: false },
    ]);

    const targetIds = rows.map((row) =>
      (row as Row & { [toCell](): Cell<Row> })[toCell]()
        .getAsNormalizedFullLink().id
    );
    const targetSequence = batchedActivities
      .filter((activity) => targetIds.includes(activity.id))
      .map((activity) => activity.id)
      .filter((id, index, ids) => index === 0 || id !== ids[index - 1]);
    expect(targetSequence).toEqual(targetIds);
    const firstTargetActivityIndex = batchedActivities.findIndex((activity) =>
      targetIds.includes(activity.id)
    );
    expect(firstTargetActivityIndex).toBeGreaterThanOrEqual(0);
    const lastSourceItemActivityIndex = batchedActivities.findLastIndex(
      (activity) => activity.id === sourceId && activity.path.length === 2,
    );
    expect(lastSourceItemActivityIndex).toBeLessThan(firstTargetActivityIndex);

    const fallbackTx = runtime.edit();
    const fallbackCell = runtime.getCell<Row[]>(
      space,
      "batched-plain-schema-rows",
      ROWS_SCHEMA,
      new TransactionWrapper(fallbackTx),
    );
    expect(fallbackCell.get().map(({ label }) => label)).toEqual([
      "First",
      "Second",
    ]);
    const batchedLog = tx.getReactivityLog!();
    const fallbackLog = fallbackTx.getReactivityLog!();
    // Compared as sets of addresses: the reactivity log is one, so a repeated
    // address adds no dependency. The wrapper carries no snapshot memo, so
    // the fallback walk journals the repeated sigil probes the memoized walk
    // does not.
    const addressOf = (read: { id: string; path: readonly string[] }) =>
      `${read.id}\0${read.path.join("\0")}`;
    const distinctByAddress = <
      Read extends { id: string; path: readonly string[] },
    >(reads: readonly Read[]): Read[] =>
      [...new Map(reads.map((read) => [addressOf(read), read])).values()]
        .sort((a, b) => addressOf(a).localeCompare(addressOf(b)));
    expect(distinctByAddress(batchedLog.reads)).toEqual(
      distinctByAddress(fallbackLog.reads),
    );
    expect(distinctByAddress(batchedLog.shallowReads)).toEqual(
      distinctByAddress(fallbackLog.shallowReads),
    );
    expect(batchedLog.writes).toEqual(fallbackLog.writes);
    fallbackTx.abort();
  });

  it("falls back to general traversal for schema defaults", async () => {
    await seed("schema-array-default", [{}]);
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", default: "fallback" },
        },
      },
    } as const satisfies JSONSchema;

    const cell = runtime.getCell<{ label: string }[]>(
      space,
      "schema-array-default",
      schema,
      tx,
    );
    expect(cell.get()).toEqual([{ label: "fallback" }]);
  });

  it("preserves primitive-array validation semantics", async () => {
    await seedRaw("undefined-items", [[1]]);
    const undefinedItems = runtime.getCell<undefined[][]>(
      space,
      "undefined-items",
      {
        type: "array",
        items: { type: "array", items: { type: "undefined" } },
      },
      tx,
    );
    expect(undefinedItems.get()).toEqual([[undefined]]);

    await seedRaw("null-items", [[1]]);
    const nullItems = runtime.getCell<null[][]>(
      space,
      "null-items",
      {
        type: "array",
        items: { type: "array", items: { type: "null" } },
      },
      tx,
    );
    expect(nullItems.get()).toEqual([[null]]);

    await seedRaw("invalid-string-items", [[1]]);
    const invalidStringItems = runtime.getCell<string[][]>(
      space,
      "invalid-string-items",
      {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
      tx,
    );
    expect(invalidStringItems.get()).toBeUndefined();
  });

  it("tracks every primitive-array index after an invalid item", async () => {
    await seedRaw("invalid-primitive-tail", [[1, "still-read"]]);
    const cell = runtime.getCell<string[][]>(
      space,
      "invalid-primitive-tail",
      {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
      tx,
    );
    const trackedDataPaths: string[][] = [];
    const nativeTrackReadPaths = tx.trackReadPaths!.bind(tx);
    tx.trackReadPaths = (address, paths, options) => {
      if (address.id.startsWith(`data:${DATA_URI_MEDIA_TYPE}`)) {
        trackedDataPaths.push(...paths.map((path) => [...path]));
      }
      return nativeTrackReadPaths(address, paths, options);
    };

    expect(cell.get()).toBeUndefined();
    expect(trackedDataPaths).toContainEqual(["value", "1"]);
  });

  it("falls back when primitive arrays contain links", async () => {
    await seed("linked-string", "linked");
    const linkedString = runtime.getCell<string>(
      space,
      "linked-string",
      undefined,
      tx,
    );
    runtime.getCell(space, "linked-string-array", undefined, tx).setRawUntyped(
      [[linkedString.getAsLink()]],
    );
    await tx.commit();
    tx = runtime.edit();

    const cell = runtime.getCell<string[][]>(
      space,
      "linked-string-array",
      {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
      tx,
    );
    expect(cell.get()).toEqual([["linked"]]);
  });

  it("falls back for a linked primitive array nested in a plain object", async () => {
    await seed("linked-alias", "linked");
    const linkedAlias = runtime.getCell<string>(
      space,
      "linked-alias",
      undefined,
      tx,
    );
    await seedRaw("nested-linked-aliases", [{
      data: { id: "one", label: "First" },
      label: "First",
      aliases: [linkedAlias.getAsLink()],
    }]);

    const cell = runtime.getCell<Row[]>(
      space,
      "nested-linked-aliases",
      ROWS_SCHEMA,
      tx,
    );
    expect(cell.get()).toEqual([{
      data: { id: "one", label: "First" },
      label: "First",
      aliases: ["linked"],
    }]);
  });

  it("preserves individual-read fallback transactions", async () => {
    await seed("wrapped-plain-schema-rows", [{
      data: { id: "one", label: "First" },
      label: "First",
      aliases: ["one"],
    }]);

    const wrapper = new TransactionWrapper(tx, { nonReactive: true });
    const directFallback = runtime.getCell<Row[]>(
      space,
      "wrapped-plain-schema-rows",
      ROWS_SCHEMA,
      wrapper,
    );
    expect(directFallback.get()[0].label).toBe("First");
  });

  it("falls back when a linked item has no stored target", async () => {
    const missing = runtime.getCell(
      space,
      "missing-linked-item",
      undefined,
      tx,
    );
    runtime.getCell(space, "missing-item-array", undefined, tx).setRawUntyped(
      [missing.getAsLink()],
    );
    await tx.commit();
    tx = runtime.edit();

    const cell = runtime.getCell<Record<string, never>[]>(
      space,
      "missing-item-array",
      { type: "array", items: { type: "object", properties: {} } },
      tx,
    );
    const missingTargetKicks: string[] = [];
    const originalEnsureLinkedDocLoaded = runtime.ensureLinkedDocLoaded;
    runtime.ensureLinkedDocLoaded = (link, sourceSpace) => {
      expect(sourceSpace).toBe(space);
      expect(link.path).toEqual([]);
      missingTargetKicks.push(link.id);
    };
    let value: readonly Record<string, never>[] | undefined;
    try {
      value = cell.get();
    } finally {
      runtime.ensureLinkedDocLoaded = originalEnsureLinkedDocLoaded;
    }
    expect(value).toBeUndefined();
    expect(missingTargetKicks).toEqual([
      missing.getAsNormalizedFullLink().id,
    ]);
  });

  it("does not duplicate reads for a missing target in a batched array", async () => {
    const missing = runtime.getCell(
      space,
      "batched-missing-linked-item",
      undefined,
      tx,
    );
    const present = runtime.getCell<{ label: string }>(
      space,
      "batched-present-linked-item",
      undefined,
      tx,
    );
    present.set({ label: "Present" });
    runtime.getCell(
      space,
      "batched-missing-item-array",
      undefined,
      tx,
    ).setRawUntyped([missing.getAsLink(), present.getAsLink()]);
    await tx.commit();
    tx = runtime.edit();

    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" } },
      },
    } as const satisfies JSONSchema;
    const cell = runtime.getCell<{ label: string }[]>(
      space,
      "batched-missing-item-array",
      schema,
      tx,
    );
    const sourceId = cell.getAsNormalizedFullLink().id;
    const nativeTrackReadPaths = tx.trackReadPaths!.bind(tx);
    let sourceBatchCount = 0;
    tx.trackReadPaths = (address, paths, options) => {
      if (address.id === sourceId && paths.length === 2) sourceBatchCount++;
      return nativeTrackReadPaths(address, paths, options);
    };

    const missingTargetKicks: string[] = [];
    const originalEnsureLinkedDocLoaded = runtime.ensureLinkedDocLoaded;
    runtime.ensureLinkedDocLoaded = (link, sourceSpace) => {
      expect(sourceSpace).toBe(space);
      expect(link.path).toEqual([]);
      missingTargetKicks.push(link.id);
    };
    let value: readonly { label: string }[] | undefined;
    try {
      value = cell.get();
    } finally {
      runtime.ensureLinkedDocLoaded = originalEnsureLinkedDocLoaded;
    }
    expect(value).toBeUndefined();
    expect(missingTargetKicks).toEqual([
      missing.getAsNormalizedFullLink().id,
    ]);
    expect(sourceBatchCount).toBe(2);
    const batchedActivities = [...getTransactionReadActivities(tx)];
    expect(
      batchedActivities.filter((activity) =>
        activity.id === missing.getAsNormalizedFullLink().id
      ),
    ).toHaveLength(2);

    const fallbackTx = runtime.edit();
    const fallbackCell = runtime.getCell<{ label: string }[]>(
      space,
      "batched-missing-item-array",
      schema,
      new TransactionWrapper(fallbackTx),
    );
    expect(fallbackCell.get()).toBeUndefined();
    const fallbackActivities = [...getTransactionReadActivities(fallbackTx)];
    // Compared as sets of addresses, each read class on its own: a repeated
    // address adds no dependency, and the wrapper carries no snapshot memo,
    // so the fallback walk journals the repeated sigil probes the memoized
    // walk does not.
    const withoutOrder = ({ journalIndex: _journalIndex, ...activity }: (
      typeof batchedActivities
    )[number]) => activity;
    const addressOf = (activity: ReturnType<typeof withoutOrder>) =>
      `${activity.id}\0${activity.path.join("\0")}\0` +
      `${activity.nonRecursive === true}\0` +
      `${isLinkResolutionProbe(activity.meta)}`;
    const distinctByAddress = (
      activities: readonly (typeof batchedActivities)[number][],
    ) =>
      [
        ...new Map(
          activities.map(withoutOrder).map((
            activity,
          ) => [addressOf(activity), activity]),
        ).values(),
      ].sort((a, b) => addressOf(a).localeCompare(addressOf(b)));
    expect(distinctByAddress(batchedActivities)).toEqual(
      distinctByAddress(fallbackActivities),
    );
    fallbackTx.abort();
  });

  it("preserves object-item leaf and invalid-type handling", async () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    await seed("special-object-items", [bytes]);
    const schema = {
      type: "array",
      items: { type: "object", properties: {} },
    } as const satisfies JSONSchema;
    const specialObjects = runtime.getCell<FabricBytes[]>(
      space,
      "special-object-items",
      schema,
      tx,
    );
    expect(specialObjects.get()).toEqual([bytes]);

    await seed("invalid-object-items", [1]);
    const invalidObjects = runtime.getCell<Record<string, never>[]>(
      space,
      "invalid-object-items",
      schema,
      tx,
    );
    expect(invalidObjects.get()).toBeUndefined();
  });
});

//
// The covering schema for a tuple element is index-determined —
// prefixItems[index] within the slots, `items` past them — so
// elementSchemaFor takes the index when the caller knows it. Without one
// (elementById is id-keyed), a tuple schema yields undefined: there is no
// principled per-element schema to pick, and the schema/$defs loss is the
// documented cost.
//

describe("elementSchemaFor tuple (prefixItems) schemas", () => {
  // Interned, as a cell's schema is: a slot with no local ref then comes back
  // without `$defs`. An unfrozen schema would have them attached unscanned.
  const tupleArraySchema = internSchema(
    {
      type: "array",
      prefixItems: [
        { $ref: "#/$defs/Point" },
        { type: "number" },
      ],
      items: { type: "string" },
      $defs: {
        Point: { type: "object", properties: { x: { type: "number" } } },
      },
    } as const satisfies JSONSchema,
  ) as JSONSchema;

  it("picks the slot schema for a covered index, threading $defs", () => {
    expect(elementSchemaFor(tupleArraySchema, 0)).toEqual({
      $ref: "#/$defs/Point",
      $defs: {
        Point: { type: "object", properties: { x: { type: "number" } } },
      },
    });
    // A slot with no local ref needs no definitions.
    expect(elementSchemaFor(tupleArraySchema, 1)).toEqual({ type: "number" });
  });

  it("picks items past the tuple slots", () => {
    expect(elementSchemaFor(tupleArraySchema, 2)).toEqual({ type: "string" });
  });

  it("treats an index-less element as rest-region (items)", () => {
    // elementById is id-keyed: tuple slots are positional and cannot be
    // id-addressed, so the element falls under `items`.
    expect(elementSchemaFor(tupleArraySchema)).toEqual({ type: "string" });
  });

  it("yields undefined for a pure tuple (no items) without an index", () => {
    expect(
      elementSchemaFor(
        {
          type: "array",
          prefixItems: [{ type: "number" }],
        } as const satisfies JSONSchema,
      ),
    ).toBeUndefined();
  });

  it("keeps items-only behavior without an index", () => {
    expect(
      elementSchemaFor(
        {
          type: "array",
          items: { type: "string" },
        } as const satisfies JSONSchema,
      ),
    ).toEqual({ type: "string" });
  });
});

describe("elementById on tuple (prefixItems) arrays", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("falls back to the rest items schema (index unknown by design)", () => {
    // elementById is id-keyed and deliberately never reads the array, so a
    // tuple slot cannot be selected; the element carries the rest `items`
    // schema. Callers that know the element's slot pass its schema
    // explicitly.
    const tupleSchema = {
      type: "array",
      prefixItems: [
        { type: "object", properties: { x: { type: "number" } } },
      ],
      items: { type: "string" },
    } as const satisfies JSONSchema;

    const c = runtime.getCell<unknown[]>(
      space,
      "tuple-element-by-id",
      tupleSchema,
      tx,
    );
    c.set([]);

    const el = c.elementById("k");
    expect(el.schema).toEqual({ type: "string" });
  });
});
