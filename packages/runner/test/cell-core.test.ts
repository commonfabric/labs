// Basic cell operations: creating cells, getting/setting values, path navigation,
// raw access, source cells, and cell utility functions.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { isCell } from "../src/cell.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { isCellResult } from "../src/query-result-proxy.ts";
import { JSONSchema, type Pattern } from "../src/builder/types.ts";
import {
  getMetaLink,
  isPrimitiveCellLink,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type IExtendedStorageTransaction,
  type IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import { setResultCell } from "../src/result-utils.ts";
import { trustPattern } from "./support/trusted-builder.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const rawSigner = await Identity.fromPassphrase("test raw");
const rawSpace = rawSigner.did();

describe("Cell", () => {
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

  it("should create a cell with initial value", () => {
    const c = runtime.getCell<number>(
      space,
      "should create a cell with initial value",
      undefined,
      tx,
    );
    c.set(10);
    expect(c.get()).toBe(10);
  });

  it("delegates unrecognized symbol reads on a reactive proxy to the target", () => {
    const c = runtime.getCell<{ a: number }>(
      space,
      "reactive proxy delegates unrecognized symbols",
      undefined,
      tx,
    );
    c.set({ a: 1 });

    // String and number properties become nested cells, and a handful of
    // well-known symbols get bespoke answers -- but any other symbol falls
    // through to the proxied target itself, rather than being treated as
    // data navigation.
    const marked = Object.assign(() => undefined, {
      [Symbol.for("cf.test.marker")]: "on-target",
    });
    const proxy = c.getAsReactiveProxy(marked) as unknown as Record<
      symbol,
      unknown
    >;
    expect(proxy[Symbol.for("cf.test.marker")]).toBe("on-target");
    expect(proxy[Symbol.for("cf.test.absent")]).toBe(undefined);
  });

  it("should update cell value using send", () => {
    const c = runtime.getCell<number>(
      space,
      "should update cell value using send",
      undefined,
      tx,
    );
    c.set(10);
    c.send(20);
    expect(c.get()).toBe(20);
  });

  it("should wrap Error instances in FabricError on set", async () => {
    const sm = StorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const localTx = rt.edit();
    const c = rt.getCell<unknown>(
      space,
      "should wrap Error instances in FabricError on set",
      undefined,
      localTx,
    );
    const error = new TypeError("something went wrong");
    c.set(error);

    // Error is stored as a `FabricError`-shaped value. `c.get()` returns a
    // proxy view of the stored wrapper — its observable fields (`type`,
    // `name`, `message`, `stack`, etc.) are exposed directly on the
    // projection.
    const result = c.get() as {
      message: string;
      stack: string;
    };
    expect(result.message).toBe("something went wrong");
    expect(typeof result.stack).toBe("string");
    await localTx.commit();
    await rt.dispose();
    await sm.close();
  });

  it("should preserve Error cause property on set", async () => {
    const sm = StorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const localTx = rt.edit();
    const c = rt.getCell<unknown>(
      space,
      "should preserve Error cause property on set",
      undefined,
      localTx,
    );
    const cause = new Error("root cause");
    const error = new Error("wrapper error", { cause });
    c.set(error);

    // Outer error is a `FabricError`-shaped value; its cause is also
    // `FabricError`-shaped (recursively wrapped at conversion time). The
    // proxy view exposes the wrapper's observable fields directly.
    const result = c.get() as {
      message: string;
      cause: { message: string; stack: string };
    };
    expect(result.message).toBe("wrapper error");
    expect(result.cause.message).toBe("root cause");
    expect(typeof result.cause.stack).toBe("string");
    await localTx.commit();
    await rt.dispose();
    await sm.close();
  });

  it("Error set through a nested write-redirect lands on the target", async () => {
    const sm = StorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const localTx = rt.edit();

    const target = rt.getCell<unknown>(
      space,
      "nested redirect target",
      undefined,
      localTx,
    );
    target.set("initial");

    // `parent.slot` holds a write-redirect that aliases writes to `target`.
    // `Cell.set` pre-resolves its top-level link, so to exercise
    // `normalizeAndDiff`'s redirect-resolution branch we need the redirect
    // at a nested key — that's the path it actually fires on, during the
    // per-key recursion in the `isObjectOrArray(newValue)` branch.
    const parent = rt.getCell<{ slot: unknown }>(
      space,
      "nested redirect parent",
      undefined,
      localTx,
    );
    parent.setRawUntyped({
      slot: target.getAsWriteRedirectLink(),
    });

    // Writing a `FabricInstance` (here, a JS `Error` that gets wrapped
    // into `FabricError`) through the redirect must land at the target,
    // not clobber the redirect link at `parent.slot`. Target started as
    // `"initial"`; under the bug, target stays as `"initial"` because the
    // FabricError clobbered the redirect at `parent.slot`.
    parent.set({ slot: new TypeError("through nested redirect") });

    const targetResult = target.get() as {
      message: string;
    };
    expect(targetResult.message).toBe("through nested redirect");

    await localTx.commit();
    await rt.dispose();
    await sm.close();
  });

  it("should reject plain objects carrying a toJSON method during set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should reject plain objects carrying a toJSON method during set",
      undefined,
      tx,
    );
    const objWithToJSON = {
      secret: "internal",
      toJSON() {
        return { exposed: true };
      },
    };

    // `toJSON` is not a serializer the write path recognizes, so the method is
    // read as the member it is: a function, which no stored record may hold.
    expect(() => c.set({ data: objWithToJSON })).toThrow(
      "Not representable as a `FabricValue`: function",
    );
  });

  it("should preserve sparse arrays during set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should preserve sparse arrays during set",
      undefined,
      tx,
    );
    const sparse: unknown[] = [];
    sparse[0] = "a";
    sparse[2] = "c"; // hole at index 1
    c.set({ arr: sparse });

    const result = c.get() as { arr: unknown[] } | undefined;
    // Sparse array holes should be preserved
    expect(result?.arr[0]).toBe("a");
    expect(1 in (result?.arr ?? [])).toBe(false);
    expect(result?.arr[2]).toBe("c");
    expect(result?.arr.length).toBe(3);
  });

  it("should preserve shared sparse arrays with structural equality", async () => {
    const sm = StorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const localTx = rt.edit();
    const c = rt.getCell<unknown>(
      space,
      "sparse sharing",
      undefined,
      localTx,
    );
    const sparse: unknown[] = [];
    sparse[0] = 1;
    sparse[3] = 2; // holes at indices 1 and 2
    // Same sparse array referenced twice
    c.set([sparse, sparse]);

    const result = c.get() as unknown[][] | undefined;
    // Both should preserve holes
    expect(result?.[0][0]).toBe(1);
    expect(1 in (result?.[0] ?? [])).toBe(false);
    expect(2 in (result?.[0] ?? [])).toBe(false);
    expect(result?.[0][3]).toBe(2);
    expect(result?.[0].length).toBe(4);
    // Both should be structurally equal
    expect(result?.[0]).toEqual(result?.[1]);
    await localTx.commit();
    await rt.dispose();
    await sm.close();
  });

  it("should preserve holes and anchor objects in sparse arrays", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should preserve holes and anchor objects in sparse arrays",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const sparse: any[] = new Array(4);
    sparse[0] = "hello";
    sparse[1] = { name: "Alice" };
    // index 2 is a hole
    sparse[3] = { name: "Bob" };
    c.set(sparse);

    // deno-lint-ignore no-explicit-any
    const result = c.get() as any[];
    expect(result[0]).toBe("hello");
    // Objects should have their properties
    expect(result[1]).toHaveProperty("name", "Alice");
    // Hole at index 2 should be preserved
    expect(2 in result).toBe(false);
    // Object at index 3 should have its properties
    expect(result[3]).toHaveProperty("name", "Bob");
    expect(result.length).toBe(4);
  });

  it("should reject arrays carrying a toJSON method during set", () => {
    const c = runtime.getCell<unknown>(
      space,
      "should reject arrays carrying a toJSON method during set",
      undefined,
      tx,
    );
    const arrWithToJSON = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
    arrWithToJSON.toJSON = () => "custom-array-value";

    // An array is handled by the array rule whatever it carries, and `toJSON`
    // is a named own property, which that rule rejects. Converting by it would
    // mean storing an array by the very property that disqualifies it.
    expect(() => c.set({ arr: arrWithToJSON })).toThrow(
      "Not representable as a `FabricValue`: array that is not an inert array",
    );
  });

  it("should create a proxy for the cell", () => {
    const c = runtime.getCell<{ x: number; y: number }>(
      space,
      "should create a proxy for the cell",
      undefined,
      tx,
    );
    c.set({ x: 1, y: 2 });
    const proxy = c.getAsQueryResult();
    expect(proxy.x).toBe(1);
    expect(proxy.y).toBe(2);
  });

  it("should get value at path", () => {
    const c = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should get value at path",
      undefined,
      tx,
    );
    c.set({ a: { b: { c: 42 } } });
    expect(c.key("a").key("b").key("c").get()).toBe(42);
  });

  it("should expose only the debug value alias", () => {
    const cell = runtime.getCell<number>(
      space,
      "should expose only the debug value alias",
      undefined,
      tx,
    );
    cell.set(42);

    expect(
      (cell as unknown as { __debugValue: number }).__debugValue,
    ).toBe(42);
    expect("value" in cell).toBe(false);
  });

  it("should get raw value using getRaw", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should get raw value using getRaw",
      undefined,
      tx,
    );
    cell.set({ x: 1, y: 2 });
    expect(cell.getRaw()).toEqual({ x: 1, y: 2 });
  });

  it("should let getRaw control whether the final link is followed", () => {
    const source = runtime.getCell<{ value: number }>(
      space,
      "getRaw lastNode source",
      undefined,
      tx,
    );
    source.set({ value: 42 });

    const regularLink = runtime.getCell<unknown>(
      space,
      "getRaw lastNode regular link",
      undefined,
      tx,
    );
    regularLink.setRaw(source.key("value").getAsLink());

    const writeRedirectLink = runtime.getCell<unknown>(
      space,
      "getRaw lastNode write redirect link",
      undefined,
      tx,
    );
    writeRedirectLink.setRaw(source.key("value").getAsWriteRedirectLink());

    const regularRaw = regularLink.getRaw();
    expect(parseLink(regularRaw, regularLink)?.id).toBe(
      source.getAsNormalizedFullLink().id,
    );
    expect(regularLink.getRaw({ lastNode: "value" })).toBe(42);
    expect(
      parseLink(
        regularLink.getRaw({ lastNode: "writeRedirect" }),
        regularLink,
      )?.id,
    ).toBe(source.getAsNormalizedFullLink().id);

    expect(parseLink(writeRedirectLink.getRaw(), writeRedirectLink)?.id).toBe(
      source.getAsNormalizedFullLink().id,
    );
    expect(writeRedirectLink.getRaw({ lastNode: "writeRedirect" })).toBe(42);
  });

  it("should set raw value using setRaw", () => {
    const cell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should set raw value using setRaw",
      undefined,
      tx,
    );
    cell.set({ x: 1, y: 2 });
    cell.setRaw({ x: 10, y: 20 });
    expect(cell.getRaw()).toEqual({ x: 10, y: 20 });
  });

  it("should work with primitive values in getRaw/setRaw", () => {
    const cell = runtime.getCell<number>(
      space,
      "should work with primitive values in getRaw/setRaw",
      undefined,
      tx,
    );
    cell.set(42);

    expect(cell.getRaw()).toBe(42);

    cell.setRaw(100);
    expect(cell.getRaw()).toBe(100);
  });

  it("should work with arrays in getRaw/setRaw", () => {
    const cell = runtime.getCell<number[]>(
      space,
      "should work with arrays in getRaw/setRaw",
      undefined,
      tx,
    );
    cell.set([1, 2, 3]);

    expect(cell.getRaw()).toEqual([1, 2, 3]);

    cell.setRaw([4, 5, 6]);
    expect(cell.getRaw()).toEqual([4, 5, 6]);
  });

  it("should respect path in getRaw/setRaw for nested properties", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "should respect path in getRaw/setRaw for nested properties",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    // getRaw should return only the nested value
    expect(nestedCell.getRaw()).toBe(42);

    // same for setRaw, should update only the nested value
    nestedCell.setRaw(100);
    expect(nestedCell.getRaw()).toBe(100);

    // Verify the document structure is preserved
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should set and get the source cell", () => {
    // Create two cells
    const resultCell = runtime.getCell<{ foo: number }>(
      space,
      "result cell for result metadata test",
      undefined,
      tx,
    );
    resultCell.set({ foo: 123 });

    const targetCell = runtime.getCell<{ bar: string }>(
      space,
      "target cell for result metadata test",
      undefined,
      tx,
    );
    targetCell.set({ bar: "baz" });

    // Initially, result metadata should be unset
    expect(getMetaLink(targetCell, "result")).toBeUndefined();

    // Set the result cell
    setResultCell(targetCell, resultCell);

    // Now getMetaLink should return a link to resultCell
    const retrievedResultLink = getMetaLink(targetCell, "result");
    expect(retrievedResultLink).toBeDefined();
    const retrievedResult = runtime.getCellFromLink(
      retrievedResultLink!,
      undefined,
      tx,
    );
    expect(isCell(retrievedResult)).toBe(true);
    expect(retrievedResult?.get()).toEqual({ foo: 123 });

    // Changing the source cell's value should be reflected
    resultCell.set({ foo: 456 });
    expect(retrievedResult?.get()).toEqual({ foo: 456 });
  });

  it("should sink metadata field changes", async () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "sink meta field changes",
      undefined,
      tx,
    );
    cell.set({ value: 1 });
    cell.setMetaRaw("slug", "first", rawMetaWriteAuthorization);
    await tx.commit();
    tx = runtime.edit();

    const seen: unknown[] = [];
    const cleaned: unknown[] = [];
    const cancel = cell.withTx(tx).sinkMeta("slug", (value) => {
      seen.push(value);
      return () => cleaned.push(value);
    });
    await runtime.idle();
    expect(seen).toEqual(["first"]);

    const metaTx = runtime.edit();
    cell.withTx(metaTx).setMetaRaw("slug", "second", rawMetaWriteAuthorization);
    await metaTx.commit();
    await runtime.idle();

    expect(seen).toEqual(["first", "second"]);
    expect(cleaned).toEqual(["first"]);

    const valueTx = runtime.edit();
    cell.withTx(valueTx).set({ value: 2 });
    await valueTx.commit();
    await runtime.idle();

    expect(seen).toEqual(["first", "second"]);
    cancel();
    expect(cleaned).toEqual(["first", "second"]);
  });

  it("should update pattern output when argument is changed via getArgumentCell", async () => {
    // Create a simple doubling pattern
    const doublePattern = trustPattern(runtime, {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
        required: ["input"],
      },
      resultSchema: {
        type: "object",
        properties: { output: { type: "number" } },
      },
      result: { output: { $alias: { partialCause: "doubled", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number }) => (args.input * 2),
          },
          inputs: { input: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: { $alias: { partialCause: "doubled", path: [] } },
        },
      ],
    } as Pattern);

    // Instantiate the pattern with initial argument
    const resultCell = runtime.getCell(space, "doubling pattern instance");
    runtime.setup(undefined, doublePattern, { input: 5 }, resultCell);
    runtime.start(resultCell);

    // Verify initial output (use pull to trigger computation)
    const initial = (await resultCell.pull()) as { output: number };
    expect(initial?.output).toEqual(10);

    // Get the argument cell and update it
    const argumentCell = resultCell.getArgumentCell<{ input: number }>();
    expect(argumentCell).toBeDefined();
    expect(argumentCell?.get()).toEqual({ input: 5 });

    // Update the argument via the argument cell
    const updateTx = runtime.edit();
    argumentCell!.withTx(updateTx).set({ input: 7 });
    updateTx.commit();

    // Verify the output has changed (use pull to trigger re-computation)
    const updated = await resultCell.pull();
    expect(updated).toEqual({ output: 14 });

    // Update again to verify reactivity
    const updateTx2 = runtime.edit();
    argumentCell!.withTx(updateTx2).set({ input: 100 });
    updateTx2.commit();

    // Verify final output
    const final = await resultCell.pull();
    expect(final).toEqual({ output: 200 });
  });

  it("should resolve getArgumentCell from argument metadata after reload", async () => {
    const argumentSchema = {
      type: "object",
      properties: { input: { type: "number" } },
      required: ["input"],
    } as const;
    const doublePattern = trustPattern(runtime, {
      argumentSchema,
      resultSchema: {
        type: "object",
        properties: { output: { type: "number" } },
      },
      result: { output: { $alias: { partialCause: "doubled", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number }) => args.input * 2,
          },
          inputs: { input: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: { $alias: { partialCause: "doubled", path: [] } },
        },
      ],
    } as Pattern);
    const resultCell = runtime.getCell(
      space,
      "getArgumentCell after reload",
      undefined,
      tx,
    );
    runtime.setup(tx, doublePattern, { input: 11 }, resultCell);
    await tx.commit();
    tx = runtime.edit();

    const reloadedResultCell = resultCell.withTx(tx);
    const argumentLink = getMetaLink(reloadedResultCell, "argument");
    expect(resolvedSchema(argumentLink?.schema)).toEqual(argumentSchema);

    const argumentCell = reloadedResultCell.getArgumentCell<{ input: number }>(
      argumentSchema,
    );
    expect(argumentCell?.get()).toEqual({ input: 11 });
    expect(argumentCell?.getAsNormalizedFullLink().id).toBe(argumentLink?.id);
    expect(argumentCell?.getAsNormalizedFullLink().scope).toBe(
      argumentLink?.scope,
    );
  });
});

describe("Cell circular references", () => {
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

  it("should translate circular references into links", () => {
    const schema = {
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { $ref: "#/$defs/Root" },
          },
          required: ["x", "y", "z"],
        },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell(
      space,
      "should translate circular references into links",
      schema,
      tx,
    );
    const data: any = { x: 1, y: 2 };
    data.z = data;
    c.set(data);

    const proxy = c.getAsQueryResult();
    expect(proxy.z).toBe(proxy);

    const value = c.get();
    expect(value.z.z.z).toBe(value.z.z);

    const raw = c.getRaw();
    expect(raw?.z).toMatchObject({ "/": { [LINK_V1_TAG]: { path: [] } } });
  });

  it("should translate circular references into links across cells", () => {
    const schema = {
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          type: "object",
          properties: {
            list: {
              type: "array",
              items: {
                type: "object",
                properties: { parent: { $ref: "#/$defs/Root" } },
                asCell: ["cell"],
                required: ["parent"],
              },
            },
          },
          required: ["list"],
        },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell(
      space,
      "should translate circular references into links",
      schema,
      tx,
    );
    // Anchoring turns the array element into a separate cell document.
    const inner: any = { anchored: true };
    const outer: any = { list: [inner] };
    inner.parent = outer;
    c.set(outer);

    const proxy = c.getAsQueryResult();
    expect(proxy.list[0].parent).toBe(proxy);

    const { id } = c.getAsNormalizedFullLink();
    const innerCell = c.get().list[0];
    const raw = innerCell.getRaw();
    expect(raw).toMatchObject({
      parent: { "/": { [LINK_V1_TAG]: { id } } },
    });
  });
});

describe("Cell utility functions", () => {
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

  it("should identify a cell", () => {
    const c = runtime.getCell(
      space,
      "should identify a cell",
      undefined,
      tx,
    );
    c.set(10);
    expect(isCell(c)).toBe(true);
    expect(isCell({})).toBe(false);
  });

  it("should identify a cell reference", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should identify a cell reference",
      undefined,
      tx,
    );
    c.set({ x: 10 });
    const ref = c.key("x").getAsLink();
    expect(isPrimitiveCellLink(ref)).toBe(true);
    expect(isPrimitiveCellLink({})).toBe(false);
  });

  it("should identify a cell proxy", () => {
    const c = runtime.getCell<{ x: number }>(
      space,
      "should identify a cell proxy",
      undefined,
      tx,
    );
    c.set({ x: 1 });
    const proxy = c.getAsQueryResult();
    expect(isCellResult(proxy)).toBe(true);
    expect(isCellResult({})).toBe(false);
  });

  describe("getRawUntyped / setRawUntyped", () => {
    it("getRawUntyped returns the same value as getRaw for typed data", () => {
      const cell = runtime.getCell<{ a: number }>(
        space,
        "getRawUntyped basic",
        undefined,
        tx,
      );
      cell.set({ a: 1 });
      expect(cell.getRawUntyped()).toEqual(cell.getRaw());
    });

    it("setRawUntyped accepts a link value that does not match T", () => {
      const target = runtime.getCell<number>(
        space,
        "setRawUntyped link target",
        undefined,
        tx,
      );
      target.set(99);

      const cell = runtime.getCell<string>(
        space,
        "setRawUntyped link source",
        undefined,
        tx,
      );
      cell.set("hello");

      // Write a sigil link via setRawUntyped — this would not type-check
      // with setRaw because a link object is not assignable to string.
      const link = target.getAsWriteRedirectLink();
      cell.setRawUntyped(link);

      // The raw untyped read should return the link structure.
      const raw = cell.getRawUntyped();
      expect(raw).toBeDefined();
      expect(isObjectOrArray(raw) && "/" in raw).toBe(true);
    });

    it("setRawUntyped accepts undefined", () => {
      const cell = runtime.getCell<number>(
        space,
        "setRawUntyped undefined",
        undefined,
        tx,
      );
      cell.set(42);
      cell.setRawUntyped(undefined);
      expect(cell.getRawUntyped()).toBeUndefined();
    });

    it("getRawUntyped({ frozen: false }) returns undefined for an empty cell", () => {
      const cell = runtime.getCell<{ x: number }>(
        space,
        "getRawUntyped frozen false empty",
        undefined,
        tx,
      );
      expect(cell.getRawUntyped({ frozen: false })).toBeUndefined();
    });

    it("getRawUntyped({ frozen: false }) returns a value equal to getRaw", () => {
      const cell = runtime.getCell<{ x: number; y: number }>(
        space,
        "getRawUntyped frozen false basic",
        undefined,
        tx,
      );
      cell.set({ x: 10, y: 20 });
      expect(cell.getRawUntyped({ frozen: false })).toEqual(cell.getRaw());
    });

    it("getRawUntyped({ frozen: false }) _does_ clone", () => {
      const cell = runtime.getCell<{ items: number[] }>(
        space,
        "getRawUntyped frozen false clone off",
        undefined,
        tx,
      );
      const orig = { items: [1, 2] };
      cell.set(orig);
      const result = cell.getRawUntyped({ frozen: false });
      expect(result).toEqual(orig);
      expect(result).not.toBe(orig);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("setRawUntyped accepts an array", () => {
      const cell = runtime.getCell<number[]>(
        space,
        "setRawUntyped array",
        undefined,
        tx,
      );
      cell.setRawUntyped([1, 2, 3]);
      expect(cell.getRawUntyped()).toEqual([1, 2, 3]);
    });

    it("setRawUntyped accepts a nested object", () => {
      const cell = runtime.getCell<{ a: { b: { c: number } } }>(
        space,
        "setRawUntyped nested",
        undefined,
        tx,
      );
      cell.setRawUntyped({ a: { b: { c: 42 } } });
      const raw = cell.getRawUntyped() as { a: { b: { c: number } } };
      expect(raw.a.b.c).toBe(42);
    });

    it("setRawUntyped accepts null", () => {
      const cell = runtime.getCell<number | null>(
        space,
        "setRawUntyped null",
        undefined,
        tx,
      );
      cell.set(10);
      cell.setRawUntyped(null);
      expect(cell.getRawUntyped()).toBe(null);
    });

    it("setRawUntyped accepts an empty array", () => {
      const cell = runtime.getCell<unknown[]>(
        space,
        "setRawUntyped empty array",
        undefined,
        tx,
      );
      cell.setRawUntyped([]);
      expect(cell.getRawUntyped()).toEqual([]);
    });

    it("setRawUntyped throws without a transaction", () => {
      const cell = runtime.getCell<number>(
        space,
        "setRawUntyped no tx",
      );
      expect(() => cell.setRawUntyped(42)).toThrow(
        "Transaction required",
      );
    });
  });
});

describe("Cell raw methods: frozen-or-not", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: rawSigner });
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

  it("getRaw returns a frozen object", () => {
    const cell = runtime.getCell<{ a: number; b: number[] }>(
      rawSpace,
      "getRaw frozen",
      undefined,
      tx,
    );
    cell.set({ a: 1, b: [2, 3] });
    const raw = cell.getRaw();
    expect(raw).toBeDefined();
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen((raw as { b: readonly number[] }).b)).toBe(true);
  });

  it("getRawUntyped returns a frozen object", () => {
    const cell = runtime.getCell<{ x: number[] }>(
      rawSpace,
      "getRawUntyped frozen",
      undefined,
      tx,
    );
    cell.set({ x: [1, 2] });
    const raw = cell.getRawUntyped();
    expect(raw).toBeDefined();
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen((raw as { x: readonly number[] }).x)).toBe(true);
  });

  it("getRawUntyped({ frozen: false }) returns a mutable deep copy", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      rawSpace,
      "getRawUntyped frozen false mutable",
      undefined,
      tx,
    );
    cell.set({ items: [10, 20] });

    const mutable = cell.getRawUntyped({ frozen: false }) as {
      items: number[];
    };
    expect(mutable).toBeDefined();
    expect(Object.isFrozen(mutable)).toBe(false);
    expect(Object.isFrozen(mutable.items)).toBe(false);

    // Verify it's a copy — mutating doesn't affect the cell.
    mutable.items.push(30);
    expect((cell.getRaw() as { items: readonly number[] }).items).toEqual([
      10,
      20,
    ]);
  });

  it("getRaw and getRawUntyped agree, both frozen", () => {
    const cell = runtime.getCell<{ v: string }>(
      rawSpace,
      "raw agreement frozen",
      undefined,
      tx,
    );
    cell.set({ v: "hello" });
    const typed = cell.getRaw();
    const untyped = cell.getRawUntyped();
    expect(typed).toEqual(untyped);
    expect(Object.isFrozen(typed)).toBe(true);
    expect(Object.isFrozen(untyped)).toBe(true);
  });

  it("setRawUntyped stores arrays correctly", () => {
    const cell = runtime.getCell<number[]>(
      rawSpace,
      "setRawUntyped array",
      undefined,
      tx,
    );
    cell.setRawUntyped([10, 20, 30]);
    const raw = cell.getRawUntyped();
    expect(raw).toEqual([10, 20, 30]);
    expect(Object.isFrozen(raw)).toBe(true);
  });

  it("setRawUntyped stores nested objects correctly", () => {
    const cell = runtime.getCell<{ a: { b: number[] } }>(
      rawSpace,
      "setRawUntyped nested",
      undefined,
      tx,
    );
    cell.setRawUntyped({ a: { b: [1, 2] } });
    const raw = cell.getRawUntyped() as { a: { b: readonly number[] } };
    expect(raw.a.b).toEqual([1, 2]);
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen(raw.a)).toBe(true);
    expect(Object.isFrozen(raw.a.b)).toBe(true);
  });

  it("setRawUntyped stores null", () => {
    const cell = runtime.getCell<number | null>(
      rawSpace,
      "setRawUntyped null",
      undefined,
      tx,
    );
    cell.set(5);
    cell.setRawUntyped(null);
    expect(cell.getRawUntyped()).toBe(null);
  });

  it("getRawUntyped({ frozen: false }) returns mutable array copy", () => {
    const cell = runtime.getCell<number[]>(
      rawSpace,
      "getRawUntyped frozen false array",
      undefined,
      tx,
    );
    cell.set([10, 20, 30]);
    const mutable = cell.getRawUntyped({ frozen: false }) as number[];
    expect(Object.isFrozen(mutable)).toBe(false);
    mutable.push(40);
    expect(cell.getRaw() as readonly number[]).toEqual([10, 20, 30]);
  });

  it("getRawUntyped({ frozen: false }) returns mutable deeply nested copy", () => {
    const cell = runtime.getCell<{ a: { b: { c: number[] } } }>(
      rawSpace,
      "getRawUntyped frozen false deep nested",
      undefined,
      tx,
    );
    cell.set({ a: { b: { c: [1, 2] } } });
    const mutable = cell.getRawUntyped({ frozen: false }) as {
      a: { b: { c: number[] } };
    };
    expect(Object.isFrozen(mutable)).toBe(false);
    expect(Object.isFrozen(mutable.a)).toBe(false);
    expect(Object.isFrozen(mutable.a.b)).toBe(false);
    expect(Object.isFrozen(mutable.a.b.c)).toBe(false);
    mutable.a.b.c.push(3);
    const raw = cell.getRaw() as { a: { b: { c: readonly number[] } } };
    expect(raw.a.b.c).toEqual([1, 2]);
  });

  it("getRawUntyped({ frozen: false }) with empty array", () => {
    const cell = runtime.getCell<unknown[]>(
      rawSpace,
      "getRawUntyped frozen false empty array",
      undefined,
      tx,
    );
    cell.set([]);
    const mutable = cell.getRawUntyped({ frozen: false }) as unknown[];
    expect(mutable).toEqual([]);
    expect(Object.isFrozen(mutable)).toBe(false);
  });

  it("getRawUntyped({ frozen: false }) successive calls return independent copies", () => {
    const cell = runtime.getCell<{ val: number }>(
      rawSpace,
      "getRawUntyped frozen false independence",
      undefined,
      tx,
    );
    cell.set({ val: 1 });
    const copy1 = cell.getRawUntyped({ frozen: false }) as { val: number };
    const copy2 = cell.getRawUntyped({ frozen: false }) as { val: number };
    copy1.val = 99;
    expect(copy2.val).toBe(1);
  });

  it("getRawUntyped({ frozen: true }) returns frozen (same as default)", () => {
    const cell = runtime.getCell<{ x: number }>(
      rawSpace,
      "getRawUntyped frozen true",
      undefined,
      tx,
    );
    cell.set({ x: 42 });
    const frozen = cell.getRawUntyped({ frozen: true });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen).toEqual(cell.getRawUntyped());
  });

  it("getRawUntyped({ frozen: false }) with deeply nested structure", () => {
    const cell = runtime.getCell<{ a: { b: { c: number[] } } }>(
      rawSpace,
      "getRawUntyped frozen false deep",
      undefined,
      tx,
    );
    cell.set({ a: { b: { c: [1] } } });
    const mutable = cell.getRawUntyped({ frozen: false }) as {
      a: { b: { c: number[] } };
    };
    expect(Object.isFrozen(mutable)).toBe(false);
    expect(Object.isFrozen(mutable.a)).toBe(false);
    expect(Object.isFrozen(mutable.a.b)).toBe(false);
    expect(Object.isFrozen(mutable.a.b.c)).toBe(false);
  });

  it("getRawUntyped({ frozen: false }) successive calls are independent", () => {
    const cell = runtime.getCell<{ val: number }>(
      rawSpace,
      "getRawUntyped frozen false independence",
      undefined,
      tx,
    );
    cell.set({ val: 1 });
    const copy1 = cell.getRawUntyped({ frozen: false }) as { val: number };
    const copy2 = cell.getRawUntyped({ frozen: false }) as { val: number };
    copy1.val = 99;
    expect(copy2.val).toBe(1);
  });
});

describe(`Cell result-meta round-trip`, () => {
  // Result-meta round-trip across commit + fresh-tx reload. These tests assert
  // end-to-end correctness of the standard result meta link round-trip: the
  // round-trip preserves the result-link object, and a raw `tx.read` of
  // `path: ["result"]` returns it as an object link record (with own-property
  // `"/"`), never as a string.

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
    await runtime?.dispose();
    await storageManager?.close();
  });

  it(
    "result meta link round-trips correctly across a fresh tx",
    async () => {
      // Set up a result/target pair via the standard meta-link API.
      const resultCell = runtime.getCell<{ foo: number }>(
        space,
        "encoded source-cell round-trip: source",
        undefined,
        tx,
      );
      resultCell.set({ foo: 123 });

      const targetCell = runtime.getCell<{ bar: string }>(
        space,
        "encoded source-cell round-trip: target",
        undefined,
        tx,
      );
      targetCell.set({ bar: "baz" });
      setResultCell(targetCell, resultCell);

      // Commit, then start a fresh tx. This forces the `path: ["result"]`
      // read to go through the storage layer (rather than the in-tx
      // novelty cache, which short-circuits serialization), so
      // `fabricFromJsonValue()` runs as the actual decode step.
      await tx.commit();
      tx = runtime.edit();

      const retrievedResultLink = getMetaLink(
        targetCell.withTx(tx),
        "result",
      );
      expect(retrievedResultLink).toBeDefined();
      const retrievedResult = runtime.getCellFromLink(retrievedResultLink!);
      expect(isCell(retrievedResult)).toBe(true);
      expect(retrievedResult?.withTx(tx).get()).toEqual({ foo: 123 });
    },
  );

  it(
    "raw read of path: ['result'] returns an object link record",
    async () => {
      // Set up a result/target pair and commit.
      const resultCell = runtime.getCell<{ foo: number }>(
        space,
        "encoded source-cell raw read: source",
        undefined,
        tx,
      );
      resultCell.set({ foo: 123 });

      const targetCell = runtime.getCell<{ bar: string }>(
        space,
        "encoded source-cell raw read: target",
        undefined,
        tx,
      );
      targetCell.set({ bar: "baz" });
      setResultCell(targetCell, resultCell);

      await tx.commit();
      tx = runtime.edit();

      // Raw read of `path: ["result"]` exercises the same storage-layer
      // code path as `getMetaLink`'s underlying `readOrThrow`. The value
      // the storage layer surfaces should be an object link record (with
      // own-property `"/"`), never a JSON-stringified form, under both flag
      // states.
      const targetLink = targetCell.getAsNormalizedFullLink();
      const resultAddress = {
        space,
        id: targetLink.id,
        path: ["result"],
      } as IMemorySpaceAddress;
      const readResult = tx.read(resultAddress);
      expect(readResult.ok).toBeDefined();

      const value = readResult.ok!.value;
      expect(typeof value).not.toBe("string");
      expect(typeof value).toBe("object");
      expect(value).not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(value, "/")).toBe(true);
    },
  );
});

describe(
  `Cell special-number storage`,
  () => {
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

    it("preserves the sign of -0 on set", () => {
      const c = runtime.getCell<unknown>(
        space,
        "preserve -0",
        undefined,
        tx,
      );
      c.set({ value: -0 });
      const result = c.get() as { value: number } | undefined;
      expect(Object.is(result?.value, -0)).toBe(true);
      expect(Object.is(result?.value, 0)).toBe(false);
    });

    it("stores NaN", () => {
      const c = runtime.getCell<unknown>(
        space,
        "store NaN",
        undefined,
        tx,
      );
      c.set({ value: NaN });
      const result = c.get() as { value: number } | undefined;
      expect(Number.isNaN(result?.value)).toBe(true);
    });

    it("stores +Infinity and -Infinity", () => {
      const c = runtime.getCell<unknown>(
        space,
        "store infinities",
        undefined,
        tx,
      );
      c.set({ pos: Infinity, neg: -Infinity });
      const result = c.get() as
        | { pos: number; neg: number }
        | undefined;
      expect(result?.pos).toBe(Infinity);
      expect(result?.neg).toBe(-Infinity);
    });

    it("projects a bare NaN through a number schema", () => {
      // Non-finite numbers are first-class stored values; the schema read
      // projection must classify them as numbers rather than hiding them.
      const c = runtime.getCell<number>(
        space,
        "schema'd bare NaN",
        { type: "number" },
        tx,
      );
      c.set(NaN);
      expect(Number.isNaN(c.get())).toBe(true);
    });

    it("projects a NaN property through an object schema", () => {
      const c = runtime.getCell<{ x: number }>(
        space,
        "schema'd NaN property",
        { type: "object", properties: { x: { type: "number" } } },
        tx,
      );
      c.set({ x: NaN });
      expect(Number.isNaN(c.get()?.x)).toBe(true);
    });

    it("projects NaN, infinities, and -0 through an array schema", () => {
      const c = runtime.getCell<number[]>(
        space,
        "schema'd weird-number array",
        { type: "array", items: { type: "number" } },
        tx,
      );
      c.set([1, NaN, Infinity, -Infinity, -0, 2]);
      const result = c.get();
      expect(result?.length).toBe(6);
      expect(result?.[0]).toBe(1);
      expect(Number.isNaN(result?.[1])).toBe(true);
      expect(result?.[2]).toBe(Infinity);
      expect(result?.[3]).toBe(-Infinity);
      expect(Object.is(result?.[4], -0)).toBe(true);
      expect(result?.[5]).toBe(2);
    });

    it("does not project NaN through an integer schema", () => {
      // `NaN` is a number but not an integer, so an `integer` schema still
      // rejects it.
      const c = runtime.getCell<number>(
        space,
        "integer schema vs NaN",
        { type: "integer" },
        tx,
      );
      c.set(NaN);
      expect(c.get()).toBe(undefined);
    });
  },
);

describe(
  "Cell symbol storage",
  () => {
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

    it("round-trips an interned symbol with stable identity", () => {
      const c = runtime.getCell<unknown>(
        space,
        "interned symbol round-trip",
        undefined,
        tx,
      );
      c.set({ tag: Symbol.for("status") });
      const result = c.get() as { tag: symbol } | undefined;
      // Same registry key in the same realm yields the same symbol
      // instance, so the round-tripped value is `Object.is` to the
      // constructed sentinel.
      expect(Object.is(result?.tag, Symbol.for("status"))).toBe(true);
    });

    it("round-trips an interned symbol with an empty key", () => {
      const c = runtime.getCell<unknown>(
        space,
        "interned empty-key symbol",
        undefined,
        tx,
      );
      c.set({ tag: Symbol.for("") });
      const result = c.get() as { tag: symbol } | undefined;
      expect(Object.is(result?.tag, Symbol.for(""))).toBe(true);
    });

    it("throws on a unique (uninterned) symbol", () => {
      const c = runtime.getCell<unknown>(
        space,
        "throw on unique symbol",
        undefined,
        tx,
      );
      expect(() => c.set({ value: Symbol("nope") })).toThrow(
        "Not representable as a `FabricValue`: unique (uninterned) symbol",
      );
    });
  },
);
