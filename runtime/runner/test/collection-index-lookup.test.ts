import type { CollectionIndexData, GroupIndex } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  collectionKeyBucket,
  resolveCollectionKey,
} from "../src/builtins/collection-index-key.ts";
import { CellImpl } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("collection-index-lookup");
const space = signer.did();

describe("collection index lookup", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  it("rejects uncompiled callbacks and enumeration on ordinary data", () => {
    const tx = runtime.edit();
    try {
      const rows = runtime.getCell<string[]>(
        space,
        "direct-index-rows",
        undefined,
        tx,
      );
      rows.set(["a"]);
      expect(() => rows.groupBy(() => "a")).toThrow("groupByWithPattern");
      expect(() => rows.keyBy(() => "a")).toThrow("keyByWithPattern");
      expect(() => CellImpl.prototype.lookup.call(rows, "a")).toThrow(
        "lookup requires a collection index",
      );
      expect(() => CellImpl.prototype.keys.call(rows)).toThrow(
        "keys requires a collection index",
      );
      expect(() => CellImpl.prototype.keyEntries.call(rows)).toThrow(
        "keyEntries requires a collection index",
      );
    } finally {
      tx.abort();
    }
  });

  it("forwards index proxy methods while preserving ordinary same-named fields", () => {
    const tx = runtime.edit();
    const index = runtime.getCell<CollectionIndexData<string, number[]>>(
      space,
      "proxy-index",
      undefined,
      tx,
    );
    index.set({
      kind: "collection-index",
      mode: "group",
      keys: ["a"],
      keyEntries: [{ kind: "value", value: "a" }],
      buckets: {
        [collectionKeyBucket({ kind: "string", value: "a" })]: [1],
      },
    });
    const proxy = index.getAsReactiveProxy() as unknown as GroupIndex<
      string,
      number
    >;
    expect(proxy.lookup("a")).toEqual([1]);
    expect(proxy.keys()).toEqual(["a"]);
    expect(proxy.keyEntries()).toEqual([{ kind: "value", value: "a" }]);
    // The schema is supplied, so the gate resolves it and finds an object that
    // declares no index marker, which is the shape an ordinary typed record
    // with these field names has.
    const data = runtime.getCell<{ lookup: string; keys: string }>(
      space,
      "proxy-data",
      {
        type: "object",
        properties: { lookup: { type: "string" }, keys: { type: "string" } },
      },
      tx,
    );
    data.set({ lookup: "ordinary lookup", keys: "ordinary keys" });
    expect(
      (data.getAsReactiveProxy().lookup as unknown as { get(): string }).get(),
    ).toBe("ordinary lookup");
    expect(
      (data.getAsReactiveProxy().keys as unknown as { get(): string }).get(),
    ).toBe("ordinary keys");
    tx.abort();
  });

  it("compiles keyed reads and observes bucket and enumeration updates", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, GroupIndex } from "commonfabric";
        export default pattern<{index: GroupIndex<string, number>; selected: string}>(
          ({index, selected}) => ({ values: index.lookup(selected), keys: index.keys() })
        );
      `,
      }],
    });
    let tx = runtime.edit();
    const index = runtime.getCell<CollectionIndexData<string, number[]>>(
      space,
      "index",
      undefined,
      tx,
    );
    const a = collectionKeyBucket({ kind: "string", value: "a" });
    const b = collectionKeyBucket({ kind: "string", value: "b" });
    index.set({
      kind: "collection-index",
      mode: "group",
      keys: ["a", "b"],
      keyEntries: [{ kind: "value", value: "a" }, {
        kind: "value",
        value: "b",
      }],
      buckets: { [a]: [1], [b]: [2] },
    });
    const selected = runtime.getCell<string>(space, "selected", undefined, tx);
    selected.set("a");
    const output = runtime.getCell<{ values: number[]; keys: string[] }>(
      space,
      "output",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, { index, selected }, output);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(await result.key("values").pull()).toEqual([1]);
      expect(await result.key("keys").pull()).toEqual(["a", "b"]);
      tx = runtime.edit();
      index.withTx(tx).key("buckets").key(a).set([1, 3]);
      await tx.commit().settled;
      await runtime.idle();
      expect(await result.key("values").pull()).toEqual([1, 3]);
      tx = runtime.edit();
      selected.withTx(tx).set("b");
      await tx.commit().settled;
      await runtime.idle();
      expect(await result.key("values").pull()).toEqual([2]);
      tx = runtime.edit();
      selected.withTx(tx).set("missing");
      index.withTx(tx).key("keys").set(["b"]);
      index.withTx(tx).key("keyEntries").set([{ kind: "value", value: "b" }]);
      await tx.commit().settled;
      await runtime.idle();
      expect(await result.key("values").pull()).toEqual([]);
      expect(await result.key("keys").pull()).toEqual(["b"]);
      tx = runtime.edit();
      index.withTx(tx).key("buckets").key(
        collectionKeyBucket({ kind: "string", value: "missing" }),
      ).set([9]);
      await tx.commit().settled;
      await runtime.idle();
      expect(await result.key("values").pull()).toEqual([9]);
    } finally {
      cancel();
    }
  });
  it("returns an empty group while the group index descriptor has not been written", async () => {
    // The handle points at a spot that holds no value, which is how an index
    // reads before its descriptor is published there. The consumer gets what
    // an index with no occupants returns, and follows the descriptor once it
    // is written. A resumed `groupBy` reaching this state through its own
    // coordinator is covered in collection-index-resume.test.ts.

    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, GroupIndex, computed } from "commonfabric";
        export default pattern<{index: GroupIndex<string, number>}>(({index}) => {
          const bucket = index.lookup("a");
          const names = index.keys();
          return {
            size: computed(() => bucket.length),
            named: computed(() => names.length),
          };
        });
      `,
      }],
    });
    const errors: Error[] = [];
    runtime.scheduler.onError((error: Error) => errors.push(error));
    let tx = runtime.edit();
    const container = runtime.getCell<
      { index?: CollectionIndexData<string, number[]> }
    >(space, "unwritten-group-container", undefined, tx);
    container.set({});
    const index = container.key("index");
    const result = runtime.run(
      tx,
      compiled,
      { index },
      runtime.getCell<{ size: number; named: number }>(
        space,
        "unwritten-group-output",
        compiled.resultSchema,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(errors.map((error) => error.message)).toEqual([]);
      expect(await result.key("size").pull()).toBe(0);
      expect(await result.key("named").pull()).toBe(0);
      tx = runtime.edit();
      index.withTx(tx).set({
        kind: "collection-index",
        mode: "group",
        keys: ["a"],
        keyEntries: [{ kind: "value", value: "a" }],
        buckets: {
          [collectionKeyBucket({ kind: "string", value: "a" })]: [1, 2],
        },
      });
      await tx.commit().settled;
      await runtime.idle();
      expect(errors.map((error) => error.message)).toEqual([]);
      expect(await result.key("size").pull()).toBe(2);
      expect(await result.key("named").pull()).toBe(1);
    } finally {
      cancel();
    }
  });
  it("returns `undefined` while the key index descriptor has not been written", async () => {
    // `undefined` is both the right answer here and what a run that failed
    // leaves behind, so the empty `errors` and the `named` count are what
    // separate the two; `matched` alone could not.

    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, KeyIndex, computed } from "commonfabric";
        export default pattern<{index: KeyIndex<string, number>}>(({index}) => {
          const match = index.lookup("a");
          const names = index.keys();
          return {
            matched: computed(() => match !== undefined),
            named: computed(() => names.length),
          };
        });
      `,
      }],
    });
    const errors: Error[] = [];
    runtime.scheduler.onError((error: Error) => errors.push(error));
    let tx = runtime.edit();
    const container = runtime.getCell<
      { index?: CollectionIndexData<string, number | undefined> }
    >(space, "unwritten-key-container", undefined, tx);
    container.set({});
    const index = container.key("index");
    const result = runtime.run(
      tx,
      compiled,
      { index },
      runtime.getCell<{ matched: boolean; named: number }>(
        space,
        "unwritten-key-output",
        compiled.resultSchema,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(errors.map((error) => error.message)).toEqual([]);
      expect(await result.key("matched").pull()).toBe(false);
      expect(await result.key("named").pull()).toBe(0);
      tx = runtime.edit();
      index.withTx(tx).set({
        kind: "collection-index",
        mode: "key",
        keys: ["a"],
        keyEntries: [{ kind: "value", value: "a" }],
        buckets: { [collectionKeyBucket({ kind: "string", value: "a" })]: 4 },
      });
      await tx.commit().settled;
      await runtime.idle();
      expect(errors.map((error) => error.message)).toEqual([]);
      expect(await result.key("matched").pull()).toBe(true);
      expect(await result.key("named").pull()).toBe(1);
    } finally {
      cancel();
    }
  });
  it("refuses a lookup whose index type names neither mode while still enumerating keys", async () => {
    // `GroupIndex` and `KeyIndex` each name one mode; the descriptor interface
    // spelled directly names both, so an unpublished lookup through it cannot
    // tell an empty group from an absent match. Enumeration does not depend on
    // the mode and answers throughout.

    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, CollectionIndexHandle, CollectionIndexData, computed } from "commonfabric";
        export default pattern<
          {index: CollectionIndexHandle<CollectionIndexData<string, number[]>>}
        >(({index}) => {
          const bucket = index.lookup("a");
          const names = index.keys();
          return {
            size: computed(() => bucket.length),
            named: computed(() => names.length),
          };
        });
      `,
      }],
    });
    const errors: Error[] = [];
    runtime.scheduler.onError((error: Error) => errors.push(error));
    const tx = runtime.edit();
    const container = runtime.getCell<
      { index?: CollectionIndexData<string, number[]> }
    >(space, "unnamed-mode-container", undefined, tx);
    container.set({});
    const result = runtime.run(
      tx,
      compiled,
      { index: container.key("index") },
      runtime.getCell<{ size: number; named: number }>(
        space,
        "unnamed-mode-output",
        compiled.resultSchema,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(errors.map((error) => error.message)).toEqual([
        expect.stringContaining("lookup needs the index mode"),
      ]);
      expect(await result.key("named").pull()).toBe(0);
    } finally {
      cancel();
    }
  });
  it("reads a mode a schema pins with `const` rather than with `enum`", () => {
    // `const` is the other JSON Schema spelling for one admissible value. The
    // descriptor here is unwritten, so the schema is the only thing naming the
    // marker and the mode.

    const tx = runtime.edit();
    const index = runtime.getCell<CollectionIndexData<string, number[]>>(
      space,
      "const-schema-index",
      {
        type: "object",
        properties: {
          kind: { const: "collection-index" },
          mode: { const: "group" },
          keys: { type: "array", items: { type: "string" } },
          keyEntries: { type: "array" },
          buckets: { type: "object" },
        },
      },
      tx,
    );
    const proxy = index.getAsReactiveProxy() as unknown as GroupIndex<
      string,
      number
    >;
    expect(proxy.lookup("a")).toEqual([]);
    expect(proxy.keys()).toEqual([]);
    expect(proxy.keyEntries()).toEqual([]);
    tx.abort();
  });
  it("ignores unrelated buckets and key enumeration while following its selected bucket", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, KeyIndex } from "commonfabric";
        export default pattern<{index: KeyIndex<string, number | null>}>(
          ({index}) => ({ value: index.lookup("a") })
        );
      `,
      }],
    });
    let tx = runtime.edit();
    const index = runtime.getCell<CollectionIndexData<string, number | null>>(
      space,
      "isolated-index",
      undefined,
      tx,
    );
    const a = collectionKeyBucket({ kind: "string", value: "a" });
    const b = collectionKeyBucket({ kind: "string", value: "b" });
    index.set({
      kind: "collection-index",
      mode: "key",
      keys: ["b"],
      keyEntries: [{ kind: "value", value: "b" }],
      buckets: { [b]: 2 },
    });
    const output = runtime.getCell<{ value: number | null | undefined }>(
      space,
      "isolated-output",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, { index }, output);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = result.sink(() => {});
    let runs = 0;
    const collect = (event: Event) => {
      if (
        (event as RuntimeTelemetryEvent).marker.type ===
          "scheduler.run.complete"
      ) runs++;
    };
    try {
      await runtime.idle();
      expect(await result.key("value").pull()).toBeUndefined();
      runtime.telemetry.addEventListener("telemetry", collect);
      tx = runtime.edit();
      index.withTx(tx).key("buckets").key(b).set(20);
      index.withTx(tx).key("keys").set(["b", "c"]);
      index.withTx(tx).key("keyEntries").set([
        { kind: "value", value: "b" },
        { kind: "value", value: "c" },
      ]);
      await tx.commit().settled;
      await runtime.idle();
      expect(runs).toBe(0);
      tx = runtime.edit();
      index.withTx(tx).key("buckets").key(a).set(10);
      await tx.commit().settled;
      await runtime.idle();
      expect(runs).toBeGreaterThan(0);
      expect(await result.key("value").pull()).toBe(10);
      tx = runtime.edit();
      index.withTx(tx).key("buckets").key(a).set(null);
      await tx.commit().settled;
      await runtime.idle();
      expect(await result.key("value").pull()).toBeNull();
      tx = runtime.edit();
      index.withTx(tx).key("buckets").key(a).asSchema(true).set(undefined);
      await tx.commit().settled;
      await runtime.idle();
      expect(await result.key("value").pull()).toBeUndefined();
    } finally {
      runtime.telemetry.removeEventListener("telemetry", collect);
      cancel();
    }
  });
  it("preserves Cell key identity through compilation and reacts to alias retargeting", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, KeyIndex, Cell, Writable } from "commonfabric";
        export default pattern<{index: KeyIndex<Cell<string> | string, number>; selected: Cell<string>; data: Writable<{lookup: string; keys: string}>}>(
          ({index, selected, data}) => ({ value: index.lookup(selected), primitive: index.lookup("equal"), ordinary: data.get().lookup + data.get().keys })
        );
      `,
      }],
    });
    let tx = runtime.edit();
    const first = runtime.getCell<string>(space, "first-key", undefined, tx);
    const second = runtime.getCell<string>(space, "second-key", undefined, tx);
    const selected = runtime.getCell<string>(space, "alias-key", undefined, tx);
    first.set("equal");
    second.set("equal");
    selected.set(first);
    await tx.commit().settled;
    tx = runtime.edit();
    const a = collectionKeyBucket(
      resolveCollectionKey(runtime, tx, first)!.identity,
    );
    const b = collectionKeyBucket(
      resolveCollectionKey(runtime, tx, second)!.identity,
    );
    const index = runtime.getCell(space, "identity-index", undefined, tx);
    index.set({
      kind: "collection-index",
      mode: "key",
      keys: [first, second, "equal"],
      keyEntries: [
        { kind: "cell", cell: first },
        { kind: "cell", cell: second },
        { kind: "value", value: "equal" },
      ],
      buckets: {
        [a]: 1,
        [b]: 2,
        [collectionKeyBucket({ kind: "string", value: "equal" })]: 3,
      },
    });
    const output = runtime.getCell<
      { value: number | undefined; ordinary: string }
    >(space, "identity-output", compiled.resultSchema, tx);
    const result = runtime.run(tx, compiled, {
      index,
      selected,
      data: { lookup: "look", keys: "up" },
    }, output);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = result.sink(() => {});
    let runs = 0;
    const collect = (event: Event) => {
      if (
        (event as RuntimeTelemetryEvent).marker.type ===
          "scheduler.run.complete"
      ) runs++;
    };
    try {
      await runtime.idle();
      expect(await result.key("value").pull()).toBe(1);
      expect(await result.key("ordinary").pull()).toBe("lookup");
      expect(await result.key("primitive").pull()).toBe(3);
      runtime.telemetry.addEventListener("telemetry", collect);
      tx = runtime.edit();
      first.withTx(tx).set("changed");
      await tx.commit().settled;
      await runtime.idle();
      expect(runs).toBe(0);
      tx = runtime.edit();
      selected.withTx(tx).set(second);
      await tx.commit().settled;
      await runtime.idle();
      expect(runs).toBeGreaterThan(0);
      expect(await result.key("value").pull()).toBe(2);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", collect);
      cancel();
    }
  });
  it("preserves linked group rows without rerunning lookup on a non-key field edit", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import {pattern, GroupIndex} from "commonfabric";
        export default pattern<{index: GroupIndex<string, {name: string}>}>(
          ({index}) => ({values: index.lookup("a")})
        );
      `,
      }],
    });
    let tx = runtime.edit();
    const row = runtime.getCell<{ name: string }>(
      space,
      "linked-row",
      undefined,
      tx,
    );
    row.set({ name: "first" });
    const index = runtime.getCell(space, "linked-index", undefined, tx);
    index.set({
      kind: "collection-index",
      mode: "group",
      keys: ["a"],
      keyEntries: [{ kind: "value", value: "a" }],
      buckets: { [collectionKeyBucket({ kind: "string", value: "a" })]: [row] },
    });
    const result = runtime.run(
      tx,
      compiled,
      { index },
      runtime.getCell<{ values: { name: string }[] }>(
        space,
        "linked-output",
        compiled.resultSchema,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    const cancel = result.sink(() => {});
    let runs = 0;
    const collect = (event: Event) => {
      const marker = (event as RuntimeTelemetryEvent).marker;
      if (
        marker.type === "scheduler.run.complete" &&
        marker.actionInfo?.writes?.length
      ) runs++;
    };
    try {
      await runtime.idle();
      expect(await result.key("values").pull()).toEqual([{ name: "first" }]);
      runtime.telemetry.addEventListener("telemetry", collect);
      tx = runtime.edit();
      row.withTx(tx).key("name").set("second");
      await tx.commit().settled;
      await runtime.idle();
      expect(runs).toBe(0);
      expect(await result.key("values").pull()).toEqual([{ name: "second" }]);
      tx = runtime.edit();
      index.withTx(tx).key("buckets").key(
        collectionKeyBucket({ kind: "string", value: "a" }),
      ).set([]);
      await tx.commit().settled;
      await runtime.idle();
      expect(runs).toBeGreaterThan(0);
      expect(await result.key("values").pull()).toEqual([]);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", collect);
      cancel();
    }
  });
});
