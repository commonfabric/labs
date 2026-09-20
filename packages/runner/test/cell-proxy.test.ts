// Proxy tests: createProxy behavior, proxy access patterns, and link handling.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { isCellResult } from "../src/query-result-proxy.ts";
import { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("createProxy", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should create a proxy for nested objects", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should create a proxy for nested objects",
      undefined,
      tx,
    );
    c.set({ a: { b: { c: 42 } } });
    const proxy = c.getAsQueryResult();
    expect(proxy.a.b.c).toBe(42);
  });

  it("treats $alias records in data as plain data", () => {
    const c = runtime.getCell(
      space,
      "treats $alias records in data as plain data",
      undefined,
      tx,
    );
    // `$alias` is only meaningful inside Pattern objects; in data it is not
    // followed as a link.
    c.setRaw({ x: { $alias: { path: ["y"] } }, y: 42 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toEqual({ $alias: { path: ["y"] } });
  });

  it("does not record legacy $alias probe reads for $alias-shaped data", async () => {
    const c = runtime.getCell<{ x: any; y: number }>(
      space,
      "does not record legacy $alias probe reads",
      undefined,
      tx,
    );
    c.setRaw({ x: { $alias: { path: ["y"] } }, y: 42 });
    await tx.commit();
    tx = runtime.edit();

    const proxy = c.getAsQueryResult([], tx);
    const x = proxy.x;
    expect(proxy.y).toBe(42);

    // Snapshot the read log before traversing `x`: the removed legacy alias
    // resolver used to probe `[...path, "$alias", "path"]` on every read,
    // adding those paths to the read set. No read may end that way now.
    const readPaths = txToReactivityLog(tx).reads.map((r) => r.path);
    expect(readPaths.length).toBeGreaterThan(0);
    expect(
      readPaths.some((p) =>
        p[p.length - 2] === "$alias" && p[p.length - 1] === "path"
      ),
    ).toBe(false);

    // The record itself comes back as plain data.
    expect(x).toEqual({ $alias: { path: ["y"] } });
  });

  it("should handle nested cells", () => {
    const innerCell = runtime.getCell<number>(
      space,
      "should handle nested cells inner",
      undefined,
      tx,
    );
    innerCell.set(42);
    const outerCell = runtime.getCell<{ x: any }>(
      space,
      "should handle nested cells outer",
      undefined,
      tx,
    );
    outerCell.set({ x: innerCell });
    const proxy = outerCell.getAsQueryResult();
    expect(proxy.x).toBe(42);
  });

  it("should handle array results from array methods", () => {
    const c = runtime.getCell<{ array: number[] }>(
      space,
      "should handle array results from array methods",
      undefined,
      tx,
    );
    c.set({ array: [1, 2, 3, 4, 5] });
    const proxy = c.getAsQueryResult();

    // Methods that return arrays should return query result proxies
    const mapped = proxy.array.map((n: number) => n * 2);
    expect(isCellResult(mapped)).toBe(false);
    expect(mapped.length).toBe(5);
    expect(mapped[0]).toBe(2);
    expect(mapped[4]).toBe(10);

    const filtered = proxy.array.filter((n: number) => n % 2 === 0);
    expect(isCellResult(filtered)).toBe(false);
    expect(filtered.length).toBe(2);
    expect(filtered[0]).toBe(2);
    expect(filtered[1]).toBe(4);

    const sliced = proxy.array.slice(1, 4);
    expect(isCellResult(sliced)).toBe(false);
    expect(sliced.length).toBe(3);
    expect(sliced[0]).toBe(2);
    expect(sliced[2]).toBe(4);
  });

  it("should support spreading array query results with for...of", () => {
    const c = runtime.getCell<{ items: { name: string }[] }>(
      space,
      "should support spreading array query results",
      undefined,
      tx,
    );
    c.set({ items: [{ name: "a" }, { name: "b" }, { name: "c" }] });
    const proxy = c.getAsQueryResult();

    // Use for...of loop to iterate over the array
    const collected: any[] = [];
    for (const item of proxy.items) {
      collected.push(item);
    }

    expect(collected.length).toBe(3);

    // Each element should be a query result proxy (for objects)
    expect(isCellResult(collected[0])).toBe(true);
    expect(isCellResult(collected[1])).toBe(true);
    expect(isCellResult(collected[2])).toBe(true);

    // We can access properties through the proxies
    expect(collected[0].name).toBe("a");
    expect(collected[1].name).toBe("b");
    expect(collected[2].name).toBe("c");
  });

  it("should support spreading array query results with spread operator", () => {
    const c = runtime.getCell<{ items: { id: number }[] }>(
      space,
      "should support spreading array with spread operator",
      undefined,
      tx,
    );
    c.set({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const proxy = c.getAsQueryResult();

    // Spread the array into a new array
    const spread = [...proxy.items];

    expect(spread.length).toBe(3);

    // Each element should be a query result proxy (for objects)
    expect(isCellResult(spread[0])).toBe(true);
    expect(isCellResult(spread[1])).toBe(true);
    expect(isCellResult(spread[2])).toBe(true);

    // Verify we can access properties
    expect(spread[0].id).toBe(1);
    expect(spread[1].id).toBe(2);
    expect(spread[2].id).toBe(3);
  });

  it("should support spreading nested array query results", () => {
    const c = runtime.getCell<{ nested: { data: { value: number }[][] } }>(
      space,
      "should support spreading nested arrays",
      undefined,
      tx,
    );
    c.set({
      nested: {
        data: [[{ value: 1 }, { value: 2 }], [{ value: 3 }, { value: 4 }]],
      },
    });
    const proxy = c.getAsQueryResult();

    // Spread the outer array
    const outerSpread = [...proxy.nested.data];
    expect(outerSpread.length).toBe(2);

    // Each inner array should be a query result proxy
    expect(isCellResult(outerSpread[0])).toBe(true);
    expect(isCellResult(outerSpread[1])).toBe(true);

    // Spread an inner array
    const innerSpread = [...outerSpread[0]];
    expect(innerSpread.length).toBe(2);

    // Elements of the inner array should also be query result proxies (for objects)
    expect(isCellResult(innerSpread[0])).toBe(true);
    expect(isCellResult(innerSpread[1])).toBe(true);

    // Verify we can access properties
    expect(innerSpread[0].value).toBe(1);
    expect(innerSpread[1].value).toBe(2);
  });

  it("should support spreading arrays with cell references", () => {
    // Create individual cells to reference
    const cell1 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-1",
      undefined,
      tx,
    );
    cell1.set({ name: "first", value: 100 });

    const cell2 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-2",
      undefined,
      tx,
    );
    cell2.set({ name: "second", value: 200 });

    const cell3 = runtime.getCell<{ name: string; value: number }>(
      space,
      "ref-cell-3",
      undefined,
      tx,
    );
    cell3.set({ name: "third", value: 300 });

    // Create an array cell containing references to other cells
    const arrayCell = runtime.getCell<any[]>(
      space,
      "array-with-refs",
      undefined,
      tx,
    );
    arrayCell.set([cell1, cell2, cell3]);

    const proxy = arrayCell.getAsQueryResult();

    // Spread the array
    const spread = [...proxy];

    expect(spread.length).toBe(3);

    // Each element should be a query result proxy
    expect(isCellResult(spread[0])).toBe(true);
    expect(isCellResult(spread[1])).toBe(true);
    expect(isCellResult(spread[2])).toBe(true);

    // Verify we can access the referenced cells' data
    expect(spread[0].name).toBe("first");
    expect(spread[0].value).toBe(100);
    expect(spread[1].name).toBe("second");
    expect(spread[1].value).toBe(200);
    expect(spread[2].name).toBe("third");
    expect(spread[2].value).toBe(300);

    // Use for...of to iterate
    const names: string[] = [];
    for (const item of proxy) {
      names.push(item.name);
    }
    expect(names).toEqual(["first", "second", "third"]);
  });

  it("should support readonly array methods and log reads", async () => {
    // Seed the cell in its own committed transaction so the transaction under
    // test records only the reads done by the read-only method.
    const setupTx = runtime.edit();
    const c = runtime.getCell<number[]>(
      space,
      "should support readonly array methods and log reads",
      undefined,
      setupTx,
    );
    c.set([1, 2, 3]);
    await setupTx.commit();

    const proxy = c.withTx(tx).getAsQueryResult([], tx);
    const result = proxy.find((x: any) => x === 2);
    expect(result).toBe(2);
    expect(c.withTx(tx).get()).toEqual([1, 2, 3]);
    const log = txToReactivityLog(tx);
    const pathsRead = log.reads.map((r) => r.path.join("."));
    // Read-only array methods read the whole array recursively, which covers
    // every element; each element also gets a link-probe read.
    expect(pathsRead).toContain("value");
    expect(pathsRead).toContain("value.0./.link@1");
    expect(pathsRead).toContain("value.1./.link@1");
    expect(pathsRead).toContain("value.2./.link@1");
    expect(log.writes).toEqual([]);
  });

  it("should support mapping over a proxied array", async () => {
    // Seed the cell in its own committed transaction so the transaction under
    // test records only the reads done by map().
    const setupTx = runtime.edit();
    const c = runtime.getCell<{ a: number[] }>(
      space,
      "should support mapping over a proxied array",
      undefined,
      setupTx,
    );
    c.set({ a: [1, 2, 3] });
    await setupTx.commit();

    const proxy = c.withTx(tx).getAsQueryResult([], tx);
    const result = proxy.a.map((x: any) => x + 1);
    expect(result).toEqual([2, 3, 4]);
    const log = txToReactivityLog(tx);
    const pathsRead = log.reads.map((r) => r.path.join("."));
    // map() reads the whole array recursively, which covers every element;
    // each element also gets a link-probe read.
    expect(pathsRead).toContain("value.a");
    expect(pathsRead).toContain("value.a.0./.link@1");
    expect(pathsRead).toContain("value.a.1./.link@1");
    expect(pathsRead).toContain("value.a.2./.link@1");
    expect(log.writes).toEqual([]);
  });
});

describe("Proxy", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should return a Sendable for stream aliases", async () => {
    const c = runtime.getCell(
      space,
      "should return a Sendable for stream aliases",
      {
        type: "object",
        properties: { stream: { asCell: ["stream"] } },
      } as const satisfies JSONSchema,
      tx,
    );
    c.set({});
    tx.commit();

    tx = runtime.edit();

    const streamCell = c.key("stream");

    expect(streamCell).toHaveProperty("send");

    let lastEventSeen: any = null;
    let eventCount = 0;

    runtime.scheduler.addEventHandler(
      (_tx: IExtendedStorageTransaction, event: any) => {
        eventCount++;
        lastEventSeen = event;
      },
      streamCell.getAsNormalizedFullLink(),
    );

    streamCell.send({ clicked: true });
    await runtime.idle();

    // The stream property is a Cell of stream kind, minted from the schema's
    // declaration: nothing is stored at the position.
    expect(c.get().stream).toHaveProperty("send");
    expect(eventCount).toBe(1);
    expect(lastEventSeen).toEqual({ clicked: true });
  });

  it("returns a stream cell for the retired stream sentinel a schema-less read reaches", async () => {
    // A document written before streams were declared by schema holds
    // `{ $stream: true }` as the value at the position, and a read that
    // brings no schema to it has nothing else to go on: the proxy reads the
    // value and mints the stream cell from the sentinel, so a send through
    // it still dispatches.
    const c = runtime.getCell<{ stream: { $stream: true } }>(
      space,
      "returns a stream cell for the retired stream sentinel",
      undefined,
      tx,
    );
    c.setRaw({ stream: { $stream: true } });
    tx.commit();
    tx = runtime.edit();

    const streamCell = c.key("stream");
    let lastEventSeen: unknown = null;
    let eventCount = 0;
    runtime.scheduler.addEventHandler(
      (_tx: IExtendedStorageTransaction, event: unknown) => {
        eventCount++;
        lastEventSeen = event;
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const held = c.get().stream as unknown as {
      send: (event: unknown) => void;
    };
    expect(held).toHaveProperty("send");
    held.send({ clicked: true });
    await runtime.idle();
    expect(eventCount).toBe(1);
    expect(lastEventSeen).toEqual({ clicked: true });
  });

  it("should convert cells and proxies to links when sending events", async () => {
    const c = runtime.getCell<any>(
      space,
      "should convert cells and proxies to links when sending events",
      {
        type: "object",
        properties: { stream: { asCell: ["stream"] } },
      } as const satisfies JSONSchema,
    );
    c.withTx(tx).set({});
    tx.commit();
    tx = runtime.edit();

    const streamCell = c.key("stream");

    let lastEventSeen: any = null;
    let eventCount = 0;

    runtime.scheduler.addEventHandler(
      (_tx: IExtendedStorageTransaction, event: any) => {
        eventCount++;
        lastEventSeen = event;
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const c2 = runtime.getCell(
      space,
      "should convert cells and proxies to links when sending events: payload",
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      tx,
    );
    c2.withTx(tx).set({ x: 1, y: 2 });
    tx.commit();
    tx = runtime.edit();

    // Create event, with cell, query result and circular reference.
    const event: any = { a: c2, b: c2.getAsQueryResult() };
    event.c = event;

    streamCell.send(event);

    await runtime.idle();

    expect(eventCount).toBe(1);
    const { id } = c2.getAsNormalizedFullLink();
    expect(lastEventSeen).toEqual(
      {
        a: { "/": { [LINK_V1_TAG]: { id, path: [], scope: "space", space } } },
        b: { "/": { [LINK_V1_TAG]: { id, path: [], scope: "space", space } } },
        c: { "/": { [LINK_V1_TAG]: { path: [] } } },
      },
    );
  });
});
