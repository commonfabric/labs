/**
 * Tests for the frozen proxy target fix in `query-result-proxy.ts`.
 *
 * Stored objects are deep-frozen at commit time. After commit, reads in a new
 * transaction return direct references to these frozen objects. The proxy
 * creation function must still wrap them (using an unfrozen stub as the proxy
 * target) so that link resolution and all proxy traps work correctly.
 *
 * These tests now go through a real commit/reopen cycle. The v2 transaction
 * core isolates caller-owned values on write, so pre-freezing inputs is no
 * longer a faithful simulation of post-commit frozen storage state.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test frozen proxy");
const space = signer.did();

/**
 * Helper: write a value into a cell via the normal `Cell.set()` path, then return a
 * NormalizedFullLink for reading it back through the proxy after commit.
 */
function writeCell(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cellName: string,
  value: unknown,
): NormalizedFullLink {
  const cell = runtime.getCell(space, cellName, undefined, tx);
  const link = cell.getAsNormalizedFullLink();
  cell.set(value as any);
  return link;
}

async function commitAndReopen(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
): Promise<IExtendedStorageTransaction> {
  const result = await tx.commit().settled;
  if (result.error) {
    throw new Error(result.error.message);
  }
  return runtime.edit();
}

describe("frozen proxy target: link resolution through frozen objects", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
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

  it("resolves sigil links inside a frozen stored object (regression)", async () => {
    // Set up a target cell with a value to be linked to.
    const targetCell = runtime.getCell<{ answer: number }>(
      space,
      "frozen-link-target",
      undefined,
      tx,
    );
    targetCell.set({ answer: 42 });

    // Set up a cell whose value contains a sigil link to the target.
    // Write it deep-frozen to simulate post-commit state.
    const sourceLink = writeCell(
      runtime,
      tx,
      "frozen-link-source",
      {
        ref: targetCell.key("answer").getAsWriteRedirectLink(),
      },
    );

    tx = await commitAndReopen(runtime, tx);

    // Verify the stored value is indeed frozen (precondition).
    const rawValue = tx.readValueOrThrow(sourceLink);
    expect(Object.isFrozen(rawValue)).toBe(true);

    // The bug: createQueryResultProxy returns frozen objects raw (no proxy),
    // so link structures inside them are never resolved.
    const proxy = createQueryResultProxy<{ ref: number }>(
      runtime,
      tx,
      sourceLink,
      0,
    );

    // With the fix, the proxy should resolve the link and return 42.
    // Without the fix, proxy IS the raw frozen object and proxy.ref is the
    // unresolved sigil link structure.
    const refValue = proxy.ref;
    expect(refValue).toBe(42);
  });
});

describe("frozen proxy target: proxy wrapping and trap behavior", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
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

  it("wraps a deep-frozen stored object in a proxy (not returned raw)", async () => {
    const link = writeCell(runtime, tx, "frozen-wrap-check", {
      a: 1,
      b: "hello",
    });

    tx = await commitAndReopen(runtime, tx);

    const rawValue = tx.readValueOrThrow(link);
    expect(Object.isFrozen(rawValue)).toBe(true);

    const proxy = createQueryResultProxy<{ a: number; b: string }>(
      runtime,
      tx,
      link,
      0,
    );

    // The proxy should be an object and property access should work through
    // the get trap (returning sub-proxies or resolved values).
    expect(typeof proxy).toBe("object");
    expect(Number(proxy.a)).toBe(1);
    expect(String(proxy.b)).toBe("hello");
  });

  it("reflects inherited prototype members without treating them as stored paths", async () => {
    const link = writeCell(runtime, tx, "frozen-prototype-members", {
      value: 1,
    });

    tx = await commitAndReopen(runtime, tx);

    const proxy = createQueryResultProxy<{ value: number }>(
      runtime,
      tx,
      link,
      0,
    );

    expect(proxy.constructor).toBe(Object);
    expect(proxy.toString()).toBe("[object Object]");
  });

  it("resolves nested links multiple levels deep in a frozen tree", async () => {
    // Create a target cell.
    const innerCell = runtime.getCell<{ deep: string }>(
      space,
      "frozen-nested-target",
      undefined,
      tx,
    );
    innerCell.set({ deep: "found it" });

    // Create a cell with nested structure containing a link.
    const outerLink = writeCell(
      runtime,
      tx,
      "frozen-nested-source",
      {
        level1: {
          level2: {
            link: innerCell.key("deep").getAsWriteRedirectLink(),
          },
        },
      },
    );

    tx = await commitAndReopen(runtime, tx);

    const proxy = createQueryResultProxy<any>(
      runtime,
      tx,
      outerLink,
      0,
    );

    expect(String(proxy.level1.level2.link)).toBe("found it");
  });

  it("iterates frozen arrays via Symbol.iterator with link resolution", async () => {
    // Create target cells for each array element to link to.
    const cell1 = runtime.getCell<number>(
      space,
      "arr-target-1",
      undefined,
      tx,
    );
    cell1.set(10 as any);
    const cell2 = runtime.getCell<number>(
      space,
      "arr-target-2",
      undefined,
      tx,
    );
    cell2.set(20 as any);

    // Write frozen array of links.
    const arrLink = writeCell(
      runtime,
      tx,
      "frozen-array-iter",
      [
        cell1.getAsWriteRedirectLink(),
        cell2.getAsWriteRedirectLink(),
      ],
    );

    tx = await commitAndReopen(runtime, tx);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      arrLink,
      0,
    );

    // Iterate via for...of (uses Symbol.iterator).
    const values: number[] = [];
    for (const item of proxy) {
      values.push(Number(item));
    }
    expect(values).toEqual([10, 20]);
  });

  it("Array.isArray returns true for proxied frozen arrays", async () => {
    const link = writeCell(
      runtime,
      tx,
      "frozen-array-isarray",
      [1, 2, 3],
    );

    tx = await commitAndReopen(runtime, tx);

    const rawValue = tx.readValueOrThrow(link);
    expect(Object.isFrozen(rawValue)).toBe(true);
    expect(Array.isArray(rawValue)).toBe(true);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      link,
      0,
    );

    expect(Array.isArray(proxy)).toBe(true);
  });

  it("returns the same proxy instance for the same frozen value (cache hit)", async () => {
    const link = writeCell(runtime, tx, "frozen-cache-check", {
      x: 99,
    });

    tx = await commitAndReopen(runtime, tx);

    const proxy1 = createQueryResultProxy<{ x: number }>(
      runtime,
      tx,
      link,
      0,
    );
    const proxy2 = createQueryResultProxy<{ x: number }>(
      runtime,
      tx,
      link,
      0,
    );

    // Cache should return the same proxy object.
    expect(proxy1).toBe(proxy2);
  });

  it("Object.keys returns correct keys for a proxied frozen object", async () => {
    const link = writeCell(runtime, tx, "frozen-ownkeys", {
      name: "Alice",
      age: 30,
    });

    tx = await commitAndReopen(runtime, tx);

    const proxy = createQueryResultProxy<{ name: string; age: number }>(
      runtime,
      tx,
      link,
      0,
    );

    const keys = Object.keys(proxy);
    expect(keys).toContain("name");
    expect(keys).toContain("age");
    expect(keys.length).toBe(2);
  });

  it("'in' operator works correctly for proxied frozen objects", async () => {
    const link = writeCell(runtime, tx, "frozen-has-trap", {
      present: true,
    });

    tx = await commitAndReopen(runtime, tx);

    const proxy = createQueryResultProxy<{ present: boolean }>(
      runtime,
      tx,
      link,
      0,
    );

    expect("present" in proxy).toBe(true);
    expect("missing" in proxy).toBe(false);
  });

  it("spread operator works on proxied frozen objects", async () => {
    const link = writeCell(runtime, tx, "frozen-spread", {
      a: 1,
      b: 2,
    });

    tx = await commitAndReopen(runtime, tx);

    const proxy = createQueryResultProxy<{ a: number; b: number }>(
      runtime,
      tx,
      link,
      0,
    );

    const spread = { ...proxy };
    expect(Object.keys(spread)).toContain("a");
    expect(Object.keys(spread)).toContain("b");
    expect(Number(spread.a)).toBe(1);
    expect(Number(spread.b)).toBe(2);
  });

  it("frozen array spread yields proxied elements", async () => {
    const link = writeCell(runtime, tx, "frozen-array-spread", [
      10,
      20,
      30,
    ]);

    tx = await commitAndReopen(runtime, tx);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      link,
      0,
    );

    const spread = [...proxy];
    expect(spread.length).toBe(3);
    expect(Number(spread[0])).toBe(10);
    expect(Number(spread[1])).toBe(20);
    expect(Number(spread[2])).toBe(30);
  });

  it("mixed frozen/unfrozen siblings both resolve correctly", async () => {
    // Create a target cell for links.
    const targetCell = runtime.getCell<string>(
      space,
      "mixed-link-target",
      undefined,
      tx,
    );
    targetCell.set("resolved" as any);

    // Write a frozen object with a link in the "kept" branch.
    writeCell(
      runtime,
      tx,
      "mixed-freeze-state",
      {
        kept: { link: targetCell.getAsWriteRedirectLink() },
        changed: { link: targetCell.getAsWriteRedirectLink() },
      },
    );

    tx = await commitAndReopen(runtime, tx);

    // Now overwrite the "changed" branch with an unfrozen direct value.
    // This simulates structural sharing after a write: "kept" stays frozen,
    // "changed" is a new unfrozen object.
    const cell = runtime.getCell<any>(
      space,
      "mixed-freeze-state",
      undefined,
      tx,
    );
    const link = cell.getAsNormalizedFullLink();
    tx.writeValueOrThrow(
      { ...link, path: [...link.path, "changed"] },
      { value: "direct" },
    );

    const proxy = createQueryResultProxy<any>(
      runtime,
      tx,
      link,
      0,
    );

    // "kept" sibling is still frozen; its link should resolve.
    expect(String(proxy.kept.link)).toBe("resolved");
    // "changed" sibling was rewritten and should return the direct value.
    expect(String(proxy.changed.value)).toBe("direct");
  });
});

describe("frozen proxy target: v2 committed reads", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
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

  it("resolves sigil links and freezes raw tx reads", async () => {
    const targetCell = runtime.getCell<{ answer: number }>(
      space,
      "v2-rich-link-target",
      undefined,
      tx,
    );
    targetCell.set({ answer: 42 });

    const sourceLink = writeCell(runtime, tx, "v2-rich-link-source", {
      ref: targetCell.key("answer").getAsWriteRedirectLink(),
    });

    tx = await commitAndReopen(runtime, tx);

    const rawValue = tx.readValueOrThrow(sourceLink);
    expect(Object.isFrozen(rawValue)).toBe(true);

    const proxy = createQueryResultProxy<{ ref: number }>(
      runtime,
      tx,
      sourceLink,
      0,
    );

    expect(proxy.ref).toBe(42);
  });

  it("keeps array semantics for committed frozen query result proxies", async () => {
    const link = writeCell(runtime, tx, "v2-rich-array-source", [1, 2, 3]);

    tx = await commitAndReopen(runtime, tx);

    const rawValue = tx.readValueOrThrow(link);
    expect(Object.isFrozen(rawValue)).toBe(true);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      link,
      0,
    );

    expect(Array.isArray(proxy)).toBe(true);
    expect([...proxy]).toEqual([1, 2, 3]);
  });
});

describe("frozen proxy target: committed reads", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
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

  it("returns frozen committed objects", async () => {
    const link = writeCell(runtime, tx, "modern-frozen-raw", {
      a: 1,
      b: 2,
    });

    tx = await commitAndReopen(runtime, tx);
    const rawValue = tx.readValueOrThrow(link);
    expect(Object.isFrozen(rawValue)).toBe(true);

    const result = createQueryResultProxy<{ a: number; b: number }>(
      runtime,
      tx,
      link,
      0,
    );

    expect(Number(result.a)).toBe(1);
    expect(Number(result.b)).toBe(2);
  });
});
