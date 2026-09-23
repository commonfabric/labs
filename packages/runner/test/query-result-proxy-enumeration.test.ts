/**
 * Query result proxy ownKeys / enumeration: `Object.keys()`, spread,
 * `Object.entries()`, and `JSON.stringify()` work correctly on query result
 * proxies.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  createQueryResultProxy,
  ViewDriftError,
} from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("query result proxy enumeration", () => {
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

  it("Object.keys() returns correct keys for a flat object", () => {
    const cell = runtime.getCell<{ a: number; b: string; c: boolean }>(
      space,
      "test-flat-keys",
      undefined,
      tx,
    );
    cell.set({ a: 1, b: "hello", c: true });

    const proxy = createQueryResultProxy<{ a: number; b: string; c: boolean }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    const keys = Object.keys(proxy);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).toContain("c");
    expect(keys.length).toBe(3);
  });

  it("spread copies all properties with correct values", () => {
    const cell = runtime.getCell<
      { method: string; url: string; headers: { auth: string } }
    >(
      space,
      "test-spread",
      undefined,
      tx,
    );
    cell.set({
      method: "POST",
      url: "https://example.com",
      headers: { auth: "Bearer tok" },
    });

    const proxy = createQueryResultProxy<
      { method: string; url: string; headers: { auth: string } }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    const spread = { ...proxy };
    expect(Object.keys(spread)).toContain("method");
    expect(Object.keys(spread)).toContain("url");
    expect(Object.keys(spread)).toContain("headers");
    // Values from spread should be accessible
    expect(String(spread.method)).toBe("POST");
    expect(String(spread.url)).toBe("https://example.com");
  });

  it("Object.entries() returns key-value pairs", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "test-entries",
      undefined,
      tx,
    );
    cell.set({ x: 10, y: 20 });

    const proxy = createQueryResultProxy<{ x: number; y: number }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    const entries = Object.entries(proxy);
    expect(entries.length).toBe(2);
    const keySet = entries.map(([k]) => k);
    expect(keySet).toContain("x");
    expect(keySet).toContain("y");
  });

  it("nested objects: spreading preserves sub-proxies", () => {
    const cell = runtime.getCell<
      { opts: { a: number; b: number }; extra: string }
    >(
      space,
      "test-nested-spread",
      undefined,
      tx,
    );
    cell.set({ opts: { a: 1, b: 2 }, extra: "hi" });

    const proxy = createQueryResultProxy<
      { opts: { a: number; b: number }; extra: string }
    >(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    const spread = { ...proxy };
    expect(Object.keys(spread)).toContain("opts");
    expect(Object.keys(spread)).toContain("extra");
    // The nested value should be accessible
    expect(Number(spread.opts.a)).toBe(1);
    expect(Number(spread.opts.b)).toBe(2);
  });

  it("JSON.stringify works on proxy", () => {
    const cell = runtime.getCell<{ name: string; count: number }>(
      space,
      "test-json-stringify",
      undefined,
      tx,
    );
    cell.set({ name: "test", count: 42 });

    const proxy = createQueryResultProxy<{ name: string; count: number }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    const json = JSON.stringify(proxy);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("test");
    expect(parsed.count).toBe(42);
  });

  it("array proxy: Object.keys() returns indices", () => {
    const cell = runtime.getCell<number[]>(
      space,
      "test-array-keys",
      undefined,
      tx,
    );
    cell.set([10, 20, 30]);

    const proxy = createQueryResultProxy<number[]>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    const keys = Object.keys(proxy);
    expect(keys).toContain("0");
    expect(keys).toContain("1");
    expect(keys).toContain("2");
  });

  it("array proxy refuses to enumerate after the stored shape changes kind", () => {
    // A view is bound to the kind it was built over. Enumerating an array
    // view once the document holds a record refuses (`ViewDriftError`)
    // rather than reporting an array's `length` alongside a record's keys; a
    // fresh read is a view over the record.
    const cell = runtime.getCell<unknown>(
      space,
      "test-array-shape-change",
      undefined,
      tx,
    );
    cell.set([10, 20]);

    const proxy = createQueryResultProxy<unknown[]>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    cell.set({ changed: true });

    expect(() => Reflect.ownKeys(proxy)).toThrow(ViewDriftError);
    expect(() => Object.keys(proxy)).toThrow(ViewDriftError);
    const fresh = createQueryResultProxy<{ changed: boolean }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );
    expect(Object.keys(fresh)).toEqual(["changed"]);
  });

  it("empty object returns empty keys", () => {
    const cell = runtime.getCell<Record<string, never>>(
      space,
      "test-empty-keys",
      undefined,
      tx,
    );
    cell.set({});

    const proxy = createQueryResultProxy<Record<string, never>>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    expect(Object.keys(proxy)).toEqual([]);
  });

  it("'in' operator returns true for existing keys and false for missing keys", () => {
    const cell = runtime.getCell<{ a: number; b: string }>(
      space,
      "test-has-trap",
      undefined,
      tx,
    );
    cell.set({ a: 1, b: "hello" });

    const proxy = createQueryResultProxy<{ a: number; b: string }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    expect("a" in proxy).toBe(true);
    expect("b" in proxy).toBe(true);
    expect("c" in proxy).toBe(false);
    expect("nonExistentKey" in proxy).toBe(false);
  });

  it("reflects a key added through the cell in `ownKeys`", () => {
    const cell = runtime.getCell<{ a: number; b?: number }>(
      space,
      "test-mutation-keys",
      undefined,
      tx,
    );
    cell.set({ a: 1 });

    const proxy = createQueryResultProxy<Record<string, number>>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    expect(Object.keys(proxy)).toEqual(["a"]);

    cell.key("b").set(2);

    const keysAfter = Object.keys(proxy);
    expect(keysAfter).toContain("a");
    expect(keysAfter).toContain("b");
  });

  it("getOwnPropertyDescriptor does not report inherited names as own", () => {
    // A trap that answers about OWN properties must not consult the prototype
    // chain. Were it to use `in`, every member of `Object.prototype` would come
    // back as an own property of the proxy while `ownKeys` listed none of them
    // -- two traps describing the same value, disagreeing. Downstream that
    // makes a read-back record unwritable: `unsafeObjectKeyIn()` refuses a
    // `FabricValue` with own `__proto__`/`constructor` and asks with
    // `Object.hasOwn()`, so writing a record back to a cell would be rejected
    // over keys it never had.

    const cell = runtime.getCell<{ a: number }>(
      space,
      "test-own-descriptor-not-inherited",
      undefined,
      tx,
    );
    cell.set({ a: 1 });

    const proxy = createQueryResultProxy<{ a: number }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    // The two names the FabricValue boundary reserves, plus enough of
    // `Object.prototype` to show this is about inheritance generally and not a
    // special case for those two.
    for (
      const inherited of [
        "__proto__",
        "constructor",
        "toString",
        "valueOf",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
      ]
    ) {
      expect(Object.hasOwn(proxy, inherited)).toBe(false);
      expect(Object.getOwnPropertyDescriptor(proxy, inherited)).toBe(undefined);
    }

    // A name that is genuinely absent stays absent, and a real own key is
    // still reported -- the answer is narrowed, not emptied.
    expect(Object.hasOwn(proxy, "definitelyNotAKeyAnywhere")).toBe(false);
    expect(Object.hasOwn(proxy, "a")).toBe(true);

    // The two traps agree.
    for (const key of Reflect.ownKeys(proxy)) {
      expect(Object.hasOwn(proxy, key as string)).toBe(true);
    }
  });

  it("the `in` operator still sees inherited names", () => {
    // `in` IS the `has` trap's own operator, so inherited names SHOULD be true
    // there. Pinned so a future cleanup does not "fix" both traps alike.

    const cell = runtime.getCell<{ a: number }>(
      space,
      "test-in-operator-still-inherits",
      undefined,
      tx,
    );
    cell.set({ a: 1 });

    const proxy = createQueryResultProxy<{ a: number }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    expect("toString" in proxy).toBe(true);
    expect("a" in proxy).toBe(true);
    expect("definitelyNotAKeyAnywhere" in proxy).toBe(false);
  });
});
