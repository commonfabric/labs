import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type JSONSchema } from "../src/builder/types.ts";
import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Nested Cell Array", () => {
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

  it("should show the difference between array with and without asCell on items", () => {
    // Schema WITHOUT asCell on items
    const normalArraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
        },
        required: ["name", "value"],
        // Note: NO asCell: ["cell"] here
      },
      default: [],
    } as const satisfies JSONSchema;

    // Schema WITH asCell on items
    const cellArraySchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
        },
        required: ["name", "value"],
        asCell: ["cell"], // This wraps each item in a Cell
      },
      default: [],
    } as const satisfies JSONSchema;

    // Create cells with each schema
    const normalArray = runtime.getCell(
      space,
      "normal-array",
      normalArraySchema,
      tx,
    );
    const cellArray = runtime.getCell(space, "cell-array", cellArraySchema, tx);

    // Add the same data to both
    const testData = { name: "test", value: 42 };
    normalArray.push(testData);
    cellArray.push(testData as any);

    // Compare behavior
    const normalItems = normalArray.get();
    const cellItems = cellArray.get();

    // Both are arrays
    expect(Array.isArray(normalItems)).toBe(true);
    expect(Array.isArray(cellItems)).toBe(true);

    // Normal array: items are plain objects
    expect(isCell(normalItems[0])).toBe(false);
    expect(normalItems[0]).toEqualIgnoringSymbols(testData);

    // Cell array: items are cells containing objects
    expect(isCell(cellItems[0])).toBe(true);
    expect(cellItems[0].get()).toEqualIgnoringSymbols(testData);

    // cellItems[0].get() should NOT be a cell
    expect(isCell(cellItems[0].get())).toBe(false);
  });

  it("pushed objects convert to entities via anchoring", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
        },
        required: ["name", "value"],
        asCell: ["cell"],
      },
      default: [],
    } as const satisfies JSONSchema;
    const arrayCell = runtime.getCell(space, "test-array-with-id", schema, tx);

    // Both pushes anchor automatically under the ambient frame.
    arrayCell.push({
      name: "first",
      value: 1,
    });
    arrayCell.push({
      name: "second",
      value: 2,
    } as any);

    const items = arrayCell.get();
    expect(isCell(items[0])).toBe(true);
    expect(isCell(items[0].get())).toBe(false);

    expect(isCell(items[1])).toBe(true);
    expect(isCell(items[1].get())).toBe(false);
  });
});
