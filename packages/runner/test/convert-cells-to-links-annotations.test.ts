/**
 * A schema-bearing read attaches a non-enumerable `toCell` symbol to the
 * values it returns (see `schema.ts`). That annotation is not content, so it
 * must not reach -- and be rejected by -- the fabric-conversion gate inside
 * `convertCellsToLinks()`.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { toCell } from "../src/back-to-cell.ts";
import { type CellLinkInput, convertCellsToLinks } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("convertCellsToLinks() with runtime-annotated arrays", () => {
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
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  const listSchema = {
    type: "object",
    properties: { list: { type: "array", items: { type: "number" } } },
  } as const;

  it("converts a schema-read array under `doNotConvertCellResults`", () => {
    // This is the path taken by the HTML reconciler for every array-valued
    // element prop, and by the runtime client for cell gets and sink updates.
    const cell = runtime.getCell(space, "annotated-nested", listSchema, tx);
    cell.set({ list: [1, 2, 3] });

    const list = (cell.get() as { list: number[] }).list;

    expect(
      convertCellsToLinks(list, {
        doNotConvertCellResults: true,
        includeSchema: true,
      }),
    ).toEqual([1, 2, 3]);
  });

  it("converts a schema-read top-level array under `doNotConvertCellResults`", () => {
    const arraySchema = { type: "array", items: { type: "number" } } as const;
    const cell = runtime.getCell(space, "annotated-top", arraySchema, tx);
    cell.set([4, 5]);

    expect(
      convertCellsToLinks(cell.get(), {
        doNotConvertCellResults: true,
        includeSchema: true,
      }),
    ).toEqual([4, 5]);
  });

  it("returns a plain array from an annotated `Array` subclass", () => {
    // An annotated container is rebuilt through its own `map()`, which on a
    // subclass would return a subclass instance. The prototype guard is what
    // keeps such a value on the cleaning path instead.
    class Tagged extends Array<number> {}
    const tagged = Tagged.from([1, 2]);
    Object.defineProperty(tagged, toCell, {
      value: () => runtime.getCell(space, "annotated-subclass", undefined, tx),
      enumerable: false,
    });

    const converted = convertCellsToLinks(tagged as CellLinkInput, {
      doNotConvertCellResults: true,
      includeSchema: true,
    });

    expect(converted).toEqual([1, 2]);
    expect(Object.getPrototypeOf(converted)).toBe(Array.prototype);
  });

  it("converts a schemaless read, which is a proxy, under `doNotConvertCellResults`", () => {
    // A schemaless read serves the annotation from a trap rather than as an
    // own property, and its `map()` is the proxy's. Its content still comes
    // through as plain containers.
    const cell = runtime.getCell<unknown>(
      space,
      "annotated-proxy",
      undefined,
      tx,
    );
    cell.set({ list: [1, 2, 3], nested: { a: 1 } });

    const converted = convertCellsToLinks(cell.get() as CellLinkInput, {
      doNotConvertCellResults: true,
      includeSchema: true,
    });

    expect(converted).toEqual({ list: [1, 2, 3], nested: { a: 1 } });
    expect(Object.getOwnPropertySymbols(converted)).toEqual([]);
  });

  it("still rejects an array carrying a genuine named property", () => {
    // Dropping runtime annotations must not become a licence to drop content.
    const arr = [1, 2] as unknown[] & { foo?: string };
    arr.foo = "bar";

    // The cast is the point of the test: `CellLinkInput` already refuses this
    // array, and what is being pinned is that the runtime refuses it too,
    // rather than dropping the named property on the way through.
    expect(() =>
      convertCellsToLinks(arr as CellLinkInput, {
        doNotConvertCellResults: true,
        includeSchema: true,
      })
    ).toThrow(
      "Not representable as a `FabricValue`: array that is not an inert array",
    );
  });
});
