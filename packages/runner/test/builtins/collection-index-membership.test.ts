import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  collectionKeyBucket,
  compareCollectionKeys,
  resolveCollectionKey,
} from "../../src/builtins/collection-index-key.ts";
import { readCollectionIndexKeys } from "../../src/builtins/collection-index-keys.ts";
import {
  type CollectionIndexMembership,
  maintainCollectionIndexMembership,
  type MaintainedCollectionIndex,
} from "../../src/builtins/collection-index-membership.ts";
import { createNodeFactory, lift } from "../../src/builder/module.ts";
import { type Cell, cellTx } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { getDirectTransactionReactivityLog } from "../../src/storage/transaction-inspection.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("index-membership");
const space = signer.did();

describe("collection-index-membership", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;
  let state: Cell<CollectionIndexMembership>;
  let index: Cell<MaintainedCollectionIndex>;
  let first: Cell<{ title: string }>;
  let second: Cell<{ title: string }>;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const tx = runtime.edit();
    state = runtime.getCell(space, "state", undefined, tx);
    state.set({ assignments: {}, members: {}, occupied: {} });
    index = runtime.getCell(space, "index", undefined, tx);
    index.set({
      kind: "collection-index",
      mode: "group",
      keys: [],
      buckets: {},
    });
    first = runtime.getCell(space, "first", undefined, tx);
    first.set({ title: "First" });
    second = runtime.getCell(space, "second", undefined, tx);
    second.set({ title: "Second" });
    expect((await tx.commit().settled).error).toBeUndefined();
    state = state.withTx();
    index = index.withTx();
    first = first.withTx();
    second = second.withTx();
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose({ closeStorage: false });
    await storage.close();
  });

  /** Applies one membership change through an ordinary transaction. */
  async function update(
    occurrence: string,
    key: unknown,
    element = first,
    mode: "group" | "key" = "group",
    abort = false,
  ) {
    const tx = runtime.edit();
    maintainCollectionIndexMembership(
      tx,
      state,
      index,
      mode,
      occurrence,
      resolveCollectionKey(runtime, tx, key),
      element,
    );
    const log = getDirectTransactionReactivityLog(tx)!;
    if (abort) tx.abort("membership rollback test");
    else expect((await tx.commit().settled).error).toBeUndefined();
    return log;
  }

  /** Reads the published bucket independently from membership records. */
  function readBucket(key: unknown): unknown {
    const tx = runtime.edit();
    try {
      const resolved = resolveCollectionKey(runtime, tx, key)!;
      return index.withTx(tx).key("buckets").key(
        collectionKeyBucket(resolved.identity),
      ).get();
    } finally {
      tx.abort("bucket assertion");
    }
  }

  /** Reads occupied membership through the enumeration projection. */
  function readKeys(): unknown[] {
    const tx = runtime.edit();
    try {
      return readCollectionIndexKeys(tx, state);
    } finally {
      tx.abort("key enumeration assertion");
    }
  }

  it("moves one occurrence between buckets and preserves linked source updates", async () => {
    await update("z", "B", first);
    await update("a", "A", second);
    await update("z", "A", first);
    expect(readBucket("B")).toBeUndefined();
    expect(readBucket("A")).toEqual([{ title: "Second" }, {
      title: "First",
    }]);
    expect(readKeys()).toEqual(["A"]);
    const tx = runtime.edit();
    first.withTx(tx).key("title").set("Changed");
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(readBucket("A")).toEqual([{ title: "Second" }, {
      title: "Changed",
    }]);
  });

  it("keeps group order through insertion, replacement, and an aborted move", async () => {
    await update("\u{10000}", "A", first);
    await update("\uE000", "A", second);
    expect(readBucket("A")).toEqual([{ title: "Second" }, { title: "First" }]);
    await update("\uE000", "A", first);
    expect(readBucket("A")).toEqual([{ title: "First" }, { title: "First" }]);
    await update("\uE000", "B", second, "group", true);
    expect(readBucket("B")).toBeUndefined();
    expect(readBucket("A")).toEqual([{ title: "First" }, { title: "First" }]);
    await update("\uE000", undefined);
    expect(readBucket("A")).toEqual([{ title: "First" }]);
  });

  it("rebuilds group order from durable members after its cache is absent", async () => {
    await update("z", "A", first);
    await update("a", "A", second);
    const tx = runtime.edit();
    state.withTx(tx).key("orders").set(undefined);
    expect((await tx.commit().settled).error).toBeUndefined();
    await update("m", "A", first, "group", true);
    expect(readBucket("A")).toEqual([{ title: "Second" }, { title: "First" }]);
    expect(state.key("orders").get()).toBeUndefined();
    await update("m", "A", first);
    expect(readBucket("A")).toEqual([
      { title: "Second" },
      { title: "First" },
      { title: "First" },
    ]);
  });

  it("restores a missing published group from its durable membership", async () => {
    await update("z", "A", first);
    await update("a", "A", second);
    const tx = runtime.edit();
    index.withTx(tx).key("buckets").set({});
    expect((await tx.commit().settled).error).toBeUndefined();
    await update("z", "A", first);
    expect(readBucket("A")).toEqual([{ title: "Second" }, { title: "First" }]);
  });

  it("retains duplicate occurrences and exposes the next unique winner on removal", async () => {
    const tx = runtime.edit();
    index.withTx(tx).key("mode").set("key");
    expect((await tx.commit().settled).error).toBeUndefined();
    await update("z", "A", first, "key");
    await update("a", "A", second, "key");
    expect(readBucket("A")).toEqual({ title: "Second" });
    await update("a", undefined, second, "key");
    expect(readBucket("A")).toEqual({ title: "First" });
    await update("z", undefined, first, "key");
    expect(readBucket("A")).toBeUndefined();
    expect(readKeys()).toEqual([]);
    await update("z", "A", first, "key");
    expect(readBucket("A")).toEqual({ title: "First" });
  });

  it("updates the winning occurrence's source without changing its key", async () => {
    await update("a", "A", first, "key");
    await update("a", "A", second, "key");
    expect(readBucket("A")).toEqual({ title: "Second" });
    expect(readKeys()).toEqual(["A"]);
  });

  it("orders unique winners by UTF-8 and rolls back a winning move", async () => {
    await update("\u{10000}", "A", first, "key");
    await update("\uE000", "A", second, "key");
    expect(readBucket("A")).toEqual({ title: "Second" });
    await update("\uE000", "B", second, "key", true);
    expect(readBucket("A")).toEqual({ title: "Second" });
    expect(readBucket("B")).toBeUndefined();
    await update("\uE000", "B", second, "key");
    expect(readBucket("A")).toEqual({ title: "First" });
    expect(readBucket("B")).toEqual({ title: "Second" });
  });

  it("rebuilds an absent winner cache without changing the selected member", async () => {
    await update("z", "A", first, "key");
    await update("a", "A", second, "key");
    const tx = runtime.edit();
    state.withTx(tx).key("winners").set(undefined);
    expect((await tx.commit().settled).error).toBeUndefined();
    await update("z", "A", first, "key", true);
    expect(state.key("winners").get()).toBeUndefined();
    expect(readBucket("A")).toEqual({ title: "Second" });
    await update("z", "A", first, "key");
    expect(readBucket("A")).toEqual({ title: "Second" });
    await update("a", undefined, second, "key");
    expect(readBucket("A")).toEqual({ title: "First" });
  });

  it("restores an absent published bucket from retained membership", async () => {
    await update("z", "A", first, "key");
    await update("a", "A", second, "key");
    const tx = runtime.edit();
    index.withTx(tx).key("buckets").set({});
    expect((await tx.commit().settled).error).toBeUndefined();
    await update("z", "A", first, "key");
    expect(readBucket("A")).toEqual({ title: "Second" });
  });

  it("rolls back both buckets and key enumeration with an aborted move", async () => {
    await update("a", "A");
    await update("a", "B", first, "group", true);
    expect(readBucket("A")).toEqual([{ title: "First" }]);
    expect(readBucket("B")).toBeUndefined();
    expect(readKeys()).toEqual(["A"]);
    await update("a", "B");
    expect(readBucket("A")).toBeUndefined();
    expect(readBucket("B")).toEqual([{ title: "First" }]);
    expect(readKeys()).toEqual(["B"]);
  });

  it("maintains an unwatched source bucket when only its future destination is observed", async () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const maintain = lift(
      ({ selectorKey, stored, output, element }: {
        selectorKey: string;
        stored: Cell<CollectionIndexMembership>;
        output: Cell<MaintainedCollectionIndex>;
        element: Cell<unknown>;
      }) => {
        const tx = runtime.readTx(cellTx(output));
        maintainCollectionIndexMembership(
          tx,
          stored,
          output,
          "group",
          "owned-occurrence",
          resolveCollectionKey(runtime, tx, selectorKey),
          element,
        );
        return true;
      },
      {
        type: "object",
        properties: {
          selectorKey: { type: "string" },
          stored: { type: "object", asCell: ["cell"] },
          output: { type: "object", asCell: ["cell"] },
          element: { type: "object", asCell: ["cell"] },
        },
        required: ["selectorKey", "stored", "output", "element"],
      },
      { type: "boolean" },
      {
        materializerWriteInputPaths: [["output", "buckets"], [
          "stored",
          "occupied",
        ]],
      },
    );
    const producer = pattern<{
      selectorKey: string;
      stored: CollectionIndexMembership;
      output: MaintainedCollectionIndex;
      element: unknown;
    }>(({ selectorKey, stored, output, element }) => ({
      index: output,
      maintenance: maintain({ selectorKey, stored, output, element }),
    }));
    let tx = runtime.edit();
    const selector = runtime.getCell<string>(space, "selector", undefined, tx);
    selector.set("B");
    const result = runtime.run(
      tx,
      producer,
      {
        selectorKey: selector,
        stored: state,
        output: index,
        element: first,
      },
      runtime.getCell<{ index: MaintainedCollectionIndex }>(
        space,
        "producer",
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const bucketA = collectionKeyBucket({ kind: "string", value: "A" });
    const observed: unknown[] = [];
    const cancel = result.key("index").key("buckets").key(bucketA).sink((
      value,
    ) => {
      observed.push(value);
    });
    try {
      await runtime.idle();
      expect(readBucket("B")).toEqual([{ title: "First" }]);
      expect(observed.at(-1)).toBeUndefined();
      tx = runtime.edit();
      selector.withTx(tx).set("A");
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toEqual([{ title: "First" }]);
      expect(readBucket("B")).toBeUndefined();
      expect(readKeys()).toEqual(["A"]);
    } finally {
      cancel();
    }
  });

  it("demands a tagged member child through an absent bucket and skips pending extraction", async () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const maintain = createNodeFactory({
      type: "ref",
      implementation: "collectionIndexMember",
    });
    const producer = pattern<
      {
        extracted: { isCell: boolean; value: unknown };
        state: CollectionIndexMembership;
        index: MaintainedCollectionIndex;
        element: unknown;
      }
    >(
      ({ extracted, state, index, element }) => ({
        maintenance: maintain({
          extracted,
          state,
          index,
          occurrence: "child-occurrence",
          element,
          mode: "group",
        }),
      }),
    );
    let tx = runtime.edit();
    const extracted = runtime.getCell<{ isCell: boolean; value: unknown }>(
      space,
      "extracted",
      undefined,
      tx,
    );
    runtime.run(
      tx,
      producer,
      { extracted, state, index, element: first },
      runtime.getCell(
        space,
        "member-producer",
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const bucketA = collectionKeyBucket({ kind: "string", value: "A" });
    const observed: unknown[] = [];
    const cancel = index.key("buckets").key(bucketA).sink((value) => {
      observed.push(value);
    });
    try {
      await runtime.idle();
      expect(state.key("assignments").get()).toEqual({});
      tx = runtime.edit();
      extracted.withTx(tx).set({ isCell: false, value: "B" });
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(readBucket("B")).toEqual([{ title: "First" }]);
      expect(observed.at(-1)).toBeUndefined();
      tx = runtime.edit();
      extracted.withTx(tx).set({ isCell: false, value: "A" });
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toEqual([{ title: "First" }]);
      expect(readBucket("B")).toBeUndefined();
      tx = runtime.edit();
      extracted.withTx(tx).set({ isCell: false, value: undefined });
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(observed.at(-1)).toBeUndefined();
      expect(readKeys()).toEqual([]);
    } finally {
      cancel();
    }
  });

  it("deletes retired records when one occurrence churns through keys", async () => {
    for (let n = 0; n < 12; n++) await update("one", `key-${n}`);
    expect(Object.keys(state.key("assignments").get())).toHaveLength(1);
    expect(Object.keys(state.key("members").get())).toHaveLength(1);
    expect(Object.keys(state.key("occupied").get())).toHaveLength(1);
    expect(Object.keys(index.key("buckets").get())).toHaveLength(1);
    await update("one", undefined);
    expect(state.get()).toEqual({
      assignments: {},
      members: {},
      occupied: {},
      orders: {},
    });
    expect(index.key("buckets").get()).toEqual({});
    expect(readKeys()).toEqual([]);
  });

  it("records deleted bucket targets without scheduling on maintenance reads", async () => {
    await update("one", "A");
    const log = await update("one", undefined);
    expect(log.reads).toEqual([]);
    expect(log.shallowReads).toEqual([]);
    expect(log.attemptedWrites).toContainEqual({
      space,
      scope: "space",
      id: index.getAsNormalizedFullLink().id,
      path: [
        "value",
        "buckets",
        collectionKeyBucket({ kind: "string", value: "A" }),
      ],
    });
  });

  it("retains repeated occurrences of the same linked element", async () => {
    await update("a", "A", first);
    await update("b", "A", first);
    expect(readBucket("A")).toEqual([{ title: "First" }, { title: "First" }]);
    await update("a", undefined, first);
    expect(readBucket("A")).toEqual([{ title: "First" }]);
  });

  it("rejects a stale same-bucket update and admits both members on a fresh transaction", async () => {
    const firstTx = runtime.edit();
    const secondTx = runtime.edit();
    for (
      const [tx, occurrence, element] of [
        [firstTx, "a", first],
        [secondTx, "b", second],
      ] as const
    ) {
      maintainCollectionIndexMembership(
        tx,
        state,
        index,
        "group",
        occurrence,
        resolveCollectionKey(runtime, tx, "A"),
        element,
      );
    }
    expect((await firstTx.commit().settled).error).toBeUndefined();
    expect((await secondTx.commit().settled).error).toBeDefined();
    await update("b", "A", second);
    expect(readBucket("A")).toEqual([{ title: "First" }, { title: "Second" }]);
  });

  it("keeps Cell identity and primitive key domains separate", async () => {
    await update("first", first, first);
    await update("second", second, second);
    await update("string", "1", first);
    await update("number", 1, second);
    await update("boolean", true, first);
    expect(readBucket(first)).toEqual([{ title: "First" }]);
    expect(readBucket(second)).toEqual([{ title: "Second" }]);
    expect(readBucket("1")).toEqual([{ title: "First" }]);
    expect(readBucket(1)).toEqual([{ title: "Second" }]);
    expect(readKeys().slice(0, 3)).toEqual([true, 1, "1"]);
    expect(readKeys().length).toBe(5);
    const tx = runtime.edit();
    try {
      const expected = [first, second].map((cell) =>
        resolveCollectionKey(runtime, tx, cell)!.identity
      ).sort(compareCollectionKeys);
      const actual = [3, 4].map((position) => {
        const cell = readCollectionIndexKeys(tx, state)[position];
        return resolveCollectionKey(runtime, tx, cell)!.identity;
      });
      expect(actual).toEqual(expected);
    } finally {
      tx.abort("enumerated identity assertion");
    }
  });
});
