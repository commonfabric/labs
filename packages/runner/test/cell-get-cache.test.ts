// Per-transaction memoization of Cell.get(): within one ready transaction, a
// repeated read with no intervening write reuses the prior result; any write
// clears the cache so a stale value can never be served.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcLabelView } from "../src/cfc/label-view.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cell-get-cache test");
const space = signer.did();

const OBJECT_SCHEMA = {
  type: "object",
  properties: { x: { type: "number" } },
  additionalProperties: false,
} as const satisfies JSONSchema;

const Y_ONLY_SCHEMA = {
  type: "object",
  properties: { y: { type: "number" } },
  additionalProperties: false,
} as const satisfies JSONSchema;

describe("Cell.get() per-transaction cache", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  const cacheStats = () => {
    const stats = tx.getReadResultCacheStats?.();
    expect(stats).toBeDefined();
    return stats!;
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("serves a repeated read from cache (identical result object, no write between)", () => {
    const c = runtime.getCell(space, "cache-hit", OBJECT_SCHEMA, tx);
    c.set({ x: 1 });

    const first = c.get();
    const second = c.get();

    // Without caching, validateAndTransform builds a fresh object per call, so
    // reference identity is the observable signal that the cache served it.
    expect(second).toBe(first);
    expect(first).toEqual({ x: 1 });
    expect(cacheStats()).toEqual({
      hits: 1,
      misses: 1,
      sets: 1,
      entries: 1,
    });
  });

  it("shares a cached read across equivalent wrappers for the same view", () => {
    const firstWrapper = runtime.getCell(
      space,
      "equivalent-wrapper",
      OBJECT_SCHEMA,
      tx,
    );
    const secondWrapper = runtime.getCell(
      space,
      "equivalent-wrapper",
      OBJECT_SCHEMA,
      tx,
    );
    firstWrapper.set({ x: 1 });

    const first = firstWrapper.get();
    const second = secondWrapper.get();

    expect(second).toBe(first);
    expect(second).toEqual({ x: 1 });
    expect(cacheStats()).toEqual({
      hits: 1,
      misses: 1,
      sets: 1,
      entries: 1,
    });
  });

  it("does not collide equivalent wrappers with different schemas", () => {
    const c = runtime.getCell<{ x: number; y: number }>(
      space,
      "schema-split",
      { type: "object", additionalProperties: true },
      tx,
    );
    c.set({ x: 1, y: 2 });

    const xOnly = c.asSchema(OBJECT_SCHEMA);
    const yOnly = c.asSchema(Y_ONLY_SCHEMA);
    const x = xOnly.get();
    const y = yOnly.get();

    expect(x).not.toBe(y);
    expect(x).toEqual({ x: 1 });
    expect(y).toEqual({ y: 2 });
    expect(xOnly.get()).toBe(x);
    expect(yOnly.get()).toBe(y);
    expect(cacheStats()).toEqual({
      hits: 2,
      misses: 2,
      sets: 2,
      entries: 2,
    });
  });

  it("does not collide equivalent wrappers with different CFC label views", () => {
    const c = runtime.getCell(space, "cfc-label-split", OBJECT_SCHEMA, tx);
    c.set({ x: 1 });
    const link = c.getAsNormalizedFullLink();
    const labelViewA: CfcLabelView = {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["a"] },
      }],
    };
    const labelViewB: CfcLabelView = {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["b"] },
      }],
    };
    const viewA = runtime.getCellFromLink(
      link,
      OBJECT_SCHEMA,
      tx,
      labelViewA,
    );
    const viewB = runtime.getCellFromLink(
      link,
      OBJECT_SCHEMA,
      tx,
      labelViewB,
    );

    const a = viewA.get();
    const b = viewB.get();

    expect(a).not.toBe(b);
    expect(a).toEqual({ x: 1 });
    expect(b).toEqual({ x: 1 });
    expect(viewA.get()).toBe(a);
    expect(viewB.get()).toBe(b);
    expect(cacheStats()).toEqual({
      hits: 2,
      misses: 2,
      sets: 2,
      entries: 2,
    });
  });

  it("recomputes after an intervening write to the same cell", () => {
    const c = runtime.getCell(space, "self-write", OBJECT_SCHEMA, tx);
    c.set({ x: 1 });

    const first = c.get();
    expect(first).toEqual({ x: 1 });

    c.set({ x: 2 });
    expect(cacheStats().entries).toBe(0);
    const second = c.get();

    expect(second).not.toBe(first);
    expect(second).toEqual({ x: 2 });
  });

  it("recomputes after a write to a different cell (clear-on-any-write)", () => {
    const a = runtime.getCell(space, "other-write-a", OBJECT_SCHEMA, tx);
    const b = runtime.getCell(space, "other-write-b", OBJECT_SCHEMA, tx);
    a.set({ x: 1 });
    b.set({ x: 9 });

    const first = a.get();
    b.set({ x: 10 }); // unrelated write clears the whole per-tx cache
    expect(cacheStats().entries).toBe(0);

    const second = a.get();
    expect(second).not.toBe(first); // recomputed
    expect(second).toEqual({ x: 1 }); // ...but value is unchanged and correct
  });

  it("keys cache entries by read options (traverseCells does not collide)", () => {
    const c = runtime.getCell(space, "variant", OBJECT_SCHEMA, tx);
    c.set({ x: 1 });

    const plain = c.get();
    const traversed = c.get({ traverseCells: true });

    // Different option variants are cached separately; each is internally
    // stable.
    expect(traversed).not.toBe(plain);
    expect(c.get()).toBe(plain);
    expect(c.get({ traverseCells: true })).toBe(traversed);
    expect(plain).toEqual({ x: 1 });
    expect(traversed).toEqual({ x: 1 });
    expect(cacheStats()).toEqual({
      hits: 2,
      misses: 2,
      sets: 2,
      entries: 2,
    });
  });

  it("does not let the non-reactive sample() path pollute the get() cache", () => {
    const c = runtime.getCell(space, "sample-isolation", OBJECT_SCHEMA, tx);
    c.set({ x: 7 });

    // sample() runs through a non-reactive wrapper tx that exposes no cache, so
    // it neither reads from nor writes to the get() cache.
    const sampled = c.sample();
    const sampledAgain = c.sample();
    expect(sampled).toEqual({ x: 7 });
    expect(sampledAgain).toEqual({ x: 7 });
    expect(sampledAgain).not.toBe(sampled);
    expect(cacheStats()).toEqual({
      hits: 0,
      misses: 0,
      sets: 0,
      entries: 0,
    });

    const got = c.get();
    expect(got).toEqual({ x: 7 });
    expect(c.get()).toBe(got); // get() still caches normally
    expect(cacheStats()).toEqual({
      hits: 1,
      misses: 1,
      sets: 1,
      entries: 1,
    });
  });

  it("distinguishes a cached undefined value from a cache miss", () => {
    const c = runtime.getCell<undefined>(
      space,
      "undefined-value",
      undefined,
      tx,
    );
    c.set(undefined);

    expect(c.get()).toBeUndefined();
    expect(cacheStats()).toEqual({
      hits: 0,
      misses: 1,
      sets: 1,
      entries: 1,
    });
    expect(c.get()).toBeUndefined();
    expect(cacheStats()).toEqual({
      hits: 1,
      misses: 1,
      sets: 1,
      entries: 1,
    });
  });

  it("keeps reactive reads stable across a cached get()", () => {
    const c = runtime.getCell(space, "reactive-read", { type: "number" }, tx);
    c.set(5);

    c.get(); // real read: registers the dependency on the tx
    const afterReal = [...(tx.getReactivityLog?.().reads ?? [])].length;
    c.get(); // served from cache
    const afterCached = [...(tx.getReactivityLog?.().reads ?? [])].length;

    // The first get() registered the reactive dependency, and the cached second
    // get() neither dropped it nor needed to re-add it -- so an action that
    // reads a cell twice still depends on it exactly as before.
    expect(afterReal).toBeGreaterThan(0);
    expect(afterCached).toBe(afterReal);
  });

  it("bypasses the cache once CFC is prepared (preserves read-after-prepare invalidation)", () => {
    const c = runtime.getCell(space, "cfc-prepared", OBJECT_SCHEMA, tx);
    c.set({ x: 1 });

    const before = c.get(); // caches under the un-prepared tx
    tx.prepareCfc();
    expect(tx.getCfcState().prepare.status).toBe("prepared");

    const after = c.get(); // must go through the real read path, not the cache
    expect(after).not.toBe(before);
    // The real read path performed the read-after-prepare invalidation that a
    // cache hit would have skipped.
    expect(tx.getCfcState().prepare.status).toBe("invalidated");
  });
});
