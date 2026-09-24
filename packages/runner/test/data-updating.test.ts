import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { JSONSchema } from "../src/builder/types.ts";
import { createRef } from "../src/create-ref.ts";
import {
  applyChangeSet,
  type ChangeSet,
  compactChangeSet,
  diffAndUpdate,
  normalizeAndDiff,
  schemaIfcOverlapsPath,
  writeAuthorizationCoversPath,
} from "../src/data-updating.ts";
import {
  areLinksSame,
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  isPrimitiveCellLink,
  isSigilLink,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { toURI } from "../src/uri-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("data-updating", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
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

  describe("setNestedValue", () => {
    it("should set a value at a path", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should set a value at a path 1",
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2 } });
      diffAndUpdate(
        runtime,
        tx,
        testCell.key("b").key("c").getAsNormalizedFullLink(),
        3,
      );
      expect(testCell.get()).toEqual({ a: 1, b: { c: 3 } });
    });

    it("should delete no longer used fields when setting a nested value", () => {
      const testCell = runtime.getCell<
        { a: number; b: { c: number; d?: number } }
      >(
        space,
        "should delete no longer used fields 1",
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2, d: 3 } });
      diffAndUpdate(runtime, tx, testCell.key("b").getAsNormalizedFullLink(), {
        c: 4,
      });
      expect(testCell.get()).toEqual({ a: 1, b: { c: 4 } });
    });

    it("should log no changes when setting a nested value that is already set", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should log no changes 1",
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2 } });
      const changes = normalizeAndDiff(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        {
          a: 1,
          b: { c: 2 },
        },
      );
      expect(changes.length).toEqual(0);
    });

    it("should log minimal changes when setting a nested value", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should log minimal changes 1",
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2 } });
      const changes = normalizeAndDiff(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        {
          a: 1,
          b: { c: 3 },
        },
      );
      expect(changes.length).toEqual(1);
      expect(changes[0].location.path).toEqual(["b", "c"]);
    });

    it("should correctly update with shorter arrays", () => {
      const testCell = runtime.getCell<{ a: number[] }>(
        space,
        "should correctly update with shorter arrays 1",
        undefined,
        tx,
      );
      testCell.set({ a: [1, 2, 3] });
      const success = diffAndUpdate(
        runtime,
        tx,
        testCell.key("a").getAsNormalizedFullLink(),
        [1, 2],
      );
      expect(success).toBe(true);
      expect(testCell.getAsQueryResult()).toEqual({ a: [1, 2] });
    });

    it("should correctly update with a longer arrays", () => {
      const testCell = runtime.getCell<{ a: number[] }>(
        space,
        "should correctly update with a longer arrays 1",
        undefined,
        tx,
      );
      testCell.set({ a: [1, 2, 3] });
      const success = diffAndUpdate(
        runtime,
        tx,
        testCell.key("a").getAsNormalizedFullLink(),
        [1, 2, 3, 4],
      );
      expect(success).toBe(true);
      expect(testCell.getAsQueryResult()).toEqual({ a: [1, 2, 3, 4] });
    });

    it("should overwrite an object with an array", () => {
      const testCell = runtime.getCell<{ a: any }>(
        space,
        "should overwrite an object with an array 1",
        undefined,
        tx,
      );
      testCell.set({ a: { b: 1 } });
      const success = diffAndUpdate(
        runtime,
        tx,
        testCell.key("a").getAsNormalizedFullLink(),
        [1, 2, 3],
      );
      expect(success).toBeTruthy();
      expect(testCell.get()).toHaveProperty("a");
      expect(testCell.get().a).toHaveLength(3);
      expect(testCell.getAsQueryResult().a).toEqual([1, 2, 3]);
    });

    it("should overwrite an array with an object", () => {
      const testCell = runtime.getCell<{ a: any }>(
        space,
        "should overwrite an array with an object 1",
        undefined,
        tx,
      );
      testCell.set({ a: [{ type: "x" }] });
      const success = diffAndUpdate(
        runtime,
        tx,
        testCell.key("a").getAsNormalizedFullLink(),
        { type: "cf-text" },
      );
      expect(success).toBeTruthy();
      expect(testCell.get()).toHaveProperty("a");
      expect(testCell.getAsQueryResult().a).toEqual({ type: "cf-text" });
    });
  });

  describe("normalizeAndDiff", () => {
    it("should detect simple value changes", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "normalizeAndDiff simple value changes",
        undefined,
        tx,
      );
      testCell.set({ value: 42 });
      const current = testCell.key("value").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, 100);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toBe(100);
    });

    it("should detect object property changes", () => {
      const testCell = runtime.getCell<{ user: { name: string; age: number } }>(
        space,
        "normalizeAndDiff object property changes",
        undefined,
        tx,
      );
      testCell.set({ user: { name: "John", age: 30 } });
      const current = testCell.key("user").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, {
        name: "Jane",
        age: 30,
      });

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("user").key("name").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe("Jane");
    });

    it("should detect added object properties", () => {
      const testCell = runtime.getCell<
        { user: { name: string; age?: number } }
      >(
        space,
        "normalizeAndDiff added object properties",
        undefined,
        tx,
      );
      testCell.set({ user: { name: "John" } });
      const current = testCell.key("user").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, {
        name: "John",
        age: 30,
      });

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("user").key("age").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(30);
    });

    it("should detect removed object properties", () => {
      const testCell = runtime.getCell<{ user: { name: string; age: number } }>(
        space,
        "normalizeAndDiff removed object properties",
        undefined,
        tx,
      );
      testCell.set({ user: { name: "John", age: 30 } });
      const current = testCell.key("user").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, { name: "John" });

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("user").key("age").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(undefined);
    });

    it("should handle array length changes", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array length changes",
        undefined,
        tx,
      );
      testCell.set({ items: [1, 2, 3] });
      const current = testCell.key("items").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, [1, 2]);

      // A shrink is explicit deletes of the truncated slots PLUS a length
      // change — deletes first, so they hit still-present slots (a delete
      // after truncation is a no-op the write layer elides).
      expect(changes.length).toBe(2);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("items").key("2").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(undefined);
      expect(changes[0].delete).toBe(true);
      expect(
        areNormalizedLinksSame(
          changes[1].location,
          testCell.key("items").key("length").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[1].value).toBe(2);
    });

    it("should emit the length change before element writes on growth", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array growth ordering",
        undefined,
        tx,
      );
      testCell.set({ items: [1, 2] });
      const current = testCell.key("items").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, [1, 2, 3]);

      // Length first: a slot write beyond the current end auto-extends the
      // array, which would turn a trailing length write into a no-op the
      // write layer elides from the journal.
      expect(changes.length).toBe(2);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("items").key("length").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(3);
      expect(
        areNormalizedLinksSame(
          changes[1].location,
          testCell.key("items").key("2").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[1].value).toBe(3);
    });

    it("should generate correct paths when setting array length to 0", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array length to zero",
        undefined,
        tx,
      );
      // Create array with 100 items
      const largeArray = Array.from({ length: 100 }, (_, i) => i);
      testCell.set({ items: largeArray });

      // Now set length to 0 through the length property
      const lengthLink = testCell.key("items").key("length")
        .getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, lengthLink, 0);

      // Should have 101 changes total
      expect(changes.length).toBe(101);

      // Find the length change
      const lengthChange = changes.find((c) =>
        c.location.path[c.location.path.length - 1] === "length"
      );
      expect(lengthChange).toBeDefined();
      expect(lengthChange!.value).toBe(0);

      // Verify all elements are marked undefined with correct paths
      const elementChanges = changes.filter((c) =>
        c.location.path[c.location.path.length - 1] !== "length"
      );
      expect(elementChanges.length).toBe(100);

      elementChanges.forEach((change, i) => {
        expect(change.location.path).toEqual(["items", i.toString()]);
        expect(change.value).toBe(undefined);
      });
    });

    it("should handle array element changes", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array element changes",
        undefined,
        tx,
      );
      testCell.set({ items: [1, 2, 3] });
      const current = testCell.key("items").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, [1, 5, 3]);

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("items").key(1).getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(5);
    });

    it("should no-op when writing the same write redirect alias twice", () => {
      const testCell = runtime.getCell<{
        alias: any;
      }>(
        space,
        "normalizeAndDiff test duplicate same alias",
        undefined,
        tx,
      );

      const aliasLink = { $alias: { path: ["some_value"] } };
      testCell.set({ alias: aliasLink });

      const current = testCell.getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, {
        alias: aliasLink,
      });

      expect(changes.length).toBe(0);
    });

    it("stores $alias-shaped records verbatim as plain data", () => {
      const testCell = runtime.getCell<any>(
        space,
        "normalizeAndDiff $alias plain data",
        undefined,
        tx,
      );

      const aliasRecord = { $alias: { path: ["target"] } };
      diffAndUpdate(runtime, tx, testCell.getAsNormalizedFullLink(), {
        alias: aliasRecord,
        target: 1,
      });

      // Stored verbatim: the record is plain data, not converted to a link.
      expect(testCell.getRaw()).toEqual({ alias: aliasRecord, target: 1 });
      expect(isSigilLink(testCell.key("alias").getRaw())).toBe(false);

      // Writing at the location holding the record writes there; the record
      // is not followed as a write redirect.
      const changes = normalizeAndDiff(
        runtime,
        tx,
        testCell.key("alias").getAsNormalizedFullLink(),
        100,
      );
      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("alias").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(100);
    });

    it("should follow aliases", () => {
      const testCell = runtime.getCell<{
        value: number;
        alias: any;
      }>(
        space,
        "normalizeAndDiff follow aliases",
        undefined,
        tx,
      );
      // Redirects in data are sigil links; `$alias` in data is plain data.
      testCell.setRaw({
        value: 42,
        alias: testCell.key("value").getAsWriteRedirectLink(),
      });
      const current = testCell.key("alias").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, 100);

      // Should follow alias to value and change it there
      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("value").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(100);
    });

    it("should update aliases", () => {
      const testCell = runtime.getCell<{
        value: number;
        value2: number;
        alias: any;
      }>(
        space,
        "normalizeAndDiff update aliases",
        undefined,
        tx,
      );
      testCell.setRaw({
        value: 42,
        value2: 200,
        alias: testCell.key("value").getAsWriteRedirectLink(),
      });
      const current = testCell.key("alias").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, 100);

      // Should follow alias to value and change it there
      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("value").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(100);

      applyChangeSet(tx, changes);

      const redirectToValue2 = testCell.key("value2").getAsWriteRedirectLink();
      const changes2 = normalizeAndDiff(runtime, tx, current, redirectToValue2);

      applyChangeSet(tx, changes2);

      expect(changes2.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes2[0].location,
          testCell.key("alias").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes2[0].value).toEqual(redirectToValue2);

      const changes3 = normalizeAndDiff(runtime, tx, current, 300);

      expect(changes3.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes3[0].location,
          testCell.key("value2").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes3[0].value).toBe(300);
    });

    it("should handle nested changes", () => {
      const testCell = runtime.getCell<{
        user: {
          profile: {
            details: {
              address: {
                city: string;
                zipcode: number;
              };
            };
          };
        };
      }>(
        space,
        "normalizeAndDiff nested changes",
        undefined,
        tx,
      );
      testCell.set({
        user: {
          profile: {
            details: {
              address: {
                city: "New York",
                zipcode: 10001,
              },
            },
          },
        },
      });
      const current = testCell.key("user").key("profile")
        .getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, {
        details: {
          address: {
            city: "Boston",
            zipcode: 10001,
          },
        },
      });

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("user").key("profile").key("details").key("address").key(
            "city",
          ).getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe("Boston");
    });

    it("should return empty array when no changes", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "normalizeAndDiff no changes",
        undefined,
        tx,
      );
      testCell.set({ value: 42 });
      const current = testCell.key("value").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, 42);

      expect(changes.length).toBe(0);
    });

    it("should handle doc and cell references", () => {
      const cellA = runtime.getCell<{ name: string }>(
        space,
        "normalizeAndDiff doc reference A",
        undefined,
        tx,
      );
      cellA.set({ name: "Doc A" });
      const cellB = runtime.getCell<{ value: { name: string } }>(
        space,
        "normalizeAndDiff doc reference B",
        undefined,
        tx,
      );
      cellB.set({ value: { name: "Original" } });

      const current = cellB.key("value").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, cellA);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(areLinksSame(changes[0].value, cellA, current)).toBe(true);
    });

    it("should handle doc and cell references that don't change", () => {
      const cellA = runtime.getCell<{ name: string }>(
        space,
        "normalizeAndDiff doc reference no change A",
        undefined,
        tx,
      );
      cellA.set({ name: "Doc A" });
      const cellB = runtime.getCell<{ value: { name: string } }>(
        space,
        "normalizeAndDiff doc reference no change B",
        undefined,
        tx,
      );
      cellB.set({ value: { name: "Original" } });

      const current = cellB.key("value").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, cellA);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(areLinksSame(changes[0].value, cellA, current)).toBe(true);

      applyChangeSet(tx, changes);

      const changes2 = normalizeAndDiff(runtime, tx, current, cellA);

      expect(changes2.length).toBe(0);
    });

    it("should handle data: URI links by writing their contents", () => {
      // Create a data cell with some content using getImmutableCell
      // This creates a cell with an actual data: URI that should trigger the data URI handling
      const dataCell = runtime.getImmutableCell<
        { message: string; count: number }
      >(
        space,
        { message: "Hello from data", count: 42 },
        undefined,
        tx,
      );

      // Create a target cell to write to
      const targetCell = runtime.getCell<{ value: any }>(
        space,
        "normalizeAndDiff data URI target",
        undefined,
        tx,
      );
      targetCell.set({ value: "original" });

      const current = targetCell.key("value").getAsNormalizedFullLink();

      // Write the data cell link to the target
      const changes = normalizeAndDiff(runtime, tx, current, dataCell);

      // Should write the contents of the data cell, not the link itself
      // The data URI handling writes each property individually
      expect(changes.length).toBe(3);

      // Find the changes for each property
      const messageChange = changes.find((c) =>
        c.location.path.includes("message")
      );
      const countChange = changes.find((c) =>
        c.location.path.includes("count")
      );
      const objectChange = changes.find((c) => c.location.path.length === 1);

      expect(messageChange).toBeDefined();
      expect(messageChange!.value).toBe("Hello from data");
      expect(countChange).toBeDefined();
      expect(countChange!.value).toBe(42);
      expect(objectChange).toBeDefined();
      expect(objectChange!.value).toEqual({});
    });

    it("should handle data: URI links with nested paths", () => {
      // Create a data cell with nested content using getImmutableCell
      const dataCell = runtime.getImmutableCell<{
        nested: {
          deep: {
            value: string;
            numbers: number[];
          };
        };
      }>(
        space,
        {
          nested: {
            deep: {
              value: "nested value",
              numbers: [1, 2, 3],
            },
          },
        },
        undefined,
        tx,
      );

      // Create a target cell
      const targetCell = runtime.getCell<{ result: any }>(
        space,
        "normalizeAndDiff data URI nested target",
        undefined,
        tx,
      );
      targetCell.set({ result: "original" });

      const current = targetCell.key("result").getAsNormalizedFullLink();

      // Create a link to a nested path in the data cell
      const nestedDataLink = dataCell.key("nested").key("deep").getAsLink();

      // Write the nested data link to the target
      const changes = normalizeAndDiff(runtime, tx, current, nestedDataLink);

      // Should write the contents at the nested path
      // The data URI handling writes each property individually
      expect(changes.length).toBe(6);

      // Find the changes for each property
      const valueChange = changes.find((c) =>
        c.location.path.includes("value") &&
        !c.location.path.includes("numbers")
      );
      const numbersArrayChange = changes.find((c) =>
        c.location.path.length === 2 && c.location.path[1] === "numbers"
      );
      const numbersElements = changes.filter((c) =>
        c.location.path.length === 3 && c.location.path[1] === "numbers"
      );

      expect(valueChange).toBeDefined();
      expect(valueChange!.value).toBe("nested value");
      expect(numbersArrayChange).toBeDefined();
      expect(numbersArrayChange!.value).toEqual([]);
      expect(numbersElements).toHaveLength(3);
      expect(numbersElements[0].value).toBe(1);
      expect(numbersElements[1].value).toBe(2);
      expect(numbersElements[2].value).toBe(3);
    });

    it("should handle data: URI links that resolve to undefined", () => {
      // Create a data cell with some content using getImmutableCell
      const dataCell = runtime.getImmutableCell<{ exists: string }>(
        space,
        { exists: "this exists" },
        undefined,
        tx,
      );

      // Create a target cell
      const targetCell = runtime.getCell<{ value: any }>(
        space,
        "normalizeAndDiff data URI undefined target",
        undefined,
        tx,
      );
      targetCell.set({ value: "original" });

      const current = targetCell.key("value").getAsNormalizedFullLink();

      // Create a link to a non-existent path in the data cell
      // Use getAsLink() directly on the cell and then manually construct the path
      const dataLink = dataCell.getAsLink();
      const nonExistentLink = createSigilLinkFromParsedLink({
        ...parseLink(dataLink),
        path: ["doesNotExist"],
      });

      // Write the non-existent data link to the target
      const changes = normalizeAndDiff(runtime, tx, current, nonExistentLink);

      // Should write undefined since the path doesn't exist
      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toBeUndefined();
    });

    it("should handle data: URI links that contain nested links", () => {
      // Create a regular cell that will be referenced
      const referencedCell = runtime.getCell<{ name: string; value: number }>(
        space,
        "data URI nested link referenced",
        undefined,
        tx,
      );
      referencedCell.set({ name: "Referenced Cell", value: 100 });

      // Create a data cell that contains a link to the referenced cell
      const dataCell = runtime.getImmutableCell<{
        title: string;
        reference: any;
        metadata: { description: string };
      }>(
        space,
        {
          title: "Data with Link",
          reference: referencedCell.getAsLink(),
          metadata: { description: "Contains a nested link" },
        },
        undefined,
        tx,
      );

      // Create a target cell to write to
      const targetCell = runtime.getCell<{ result: any }>(
        space,
        "normalizeAndDiff data URI nested link target",
        undefined,
        tx,
      );
      targetCell.set({ result: "original" });

      const current = targetCell.key("result").getAsNormalizedFullLink();

      // Write the data cell link to the target
      const changes = normalizeAndDiff(runtime, tx, current, dataCell);
      // Should write the contents of the data cell, resolving nested links
      expect(changes.length).toBe(5);

      // Find the changes for each property
      const titleChange = changes.find((c) =>
        c.location.path.includes("title")
      );
      const referenceChange = changes.find((c) =>
        c.location.path.includes("reference")
      );
      const metadataChange = changes.find((c) =>
        c.location.path.length === 3 &&
        c.location.path[1] === "metadata" &&
        c.location.path[2] === "description"
      );
      const objectChange = changes.find((c) => c.location.path.length === 1);

      expect(titleChange).toBeDefined();
      expect(titleChange!.value).toBe("Data with Link");
      expect(referenceChange).toBeDefined();
      // The reference should be resolved to the actual cell link
      expect(isPrimitiveCellLink(referenceChange!.value)).toBe(true);
      expect(metadataChange).toBeDefined();
      expect(metadataChange!.value).toEqual("Contains a nested link");
      expect(objectChange).toBeDefined();
      expect(objectChange!.value).toEqual({});

      applyChangeSet(tx, changes);

      const value = targetCell.get();
      expect(value.result).toEqual({
        title: "Data with Link",
        reference: { name: "Referenced Cell", value: 100 },
        metadata: { description: "Contains a nested link" },
      });
    });
  });

  it("should handle data: URI links that contain nested links and references go through it", () => {
    // Create a regular cell that will be referenced
    const referencedCell = runtime.getCell(
      space,
      "data URI nested link referenced",
      {
        type: "object",
        properties: {
          name: { type: "string" },
          nested: { type: "object", properties: { value: { type: "number" } } },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    referencedCell.set({ name: "Referenced Cell", nested: { value: 100 } });

    // Create a data cell that contains a link to the referenced cell
    const dataCell = runtime.getImmutableCell<{
      title: string;
      reference: any;
      metadata: { description: string };
    }>(
      space,
      {
        title: "Data with Link",
        reference: referencedCell.key("nested").getAsLink(),
        metadata: { description: "Contains a nested link" },
      },
      undefined,
      tx,
    );

    // Create a target cell to write to
    const targetCell = runtime.getCell<{ result: any }>(
      space,
      "normalizeAndDiff data URI nested link target",
      undefined,
      tx,
    );
    targetCell.set({ result: "original" });

    const current = targetCell.key("result").getAsNormalizedFullLink();

    // Write the data cell link to the target
    const changes = normalizeAndDiff(
      runtime,
      tx,
      current,
      dataCell.key("reference").key("value").getAsLink(),
    );

    // Should write the contents of the data cell, resolving nested links
    expect(changes.length).toBe(1);

    applyChangeSet(tx, changes);

    const value = targetCell.get();
    expect(value.result).toBe(100);
  });

  it("should inline data URI containing redirect without writing redirect to wrong location", () => {
    // Setup: Create two separate cells - source and destination
    const sourceCell = runtime.getCell<{ value: number }>(
      space,
      "data URI redirect source value",
      undefined,
      tx,
    );
    sourceCell.set({ value: 99 });

    const destinationCell = runtime.getCell<{ value: number }>(
      space,
      "data URI redirect destination value",
      undefined,
      tx,
    );
    destinationCell.set({ value: 42 });

    // Create a data URI that contains a redirect pointing to sourceCell
    const redirectAlias = sourceCell.key("value").getAsWriteRedirectLink();
    const dataCell = runtime.getImmutableCell<any>(
      space,
      redirectAlias,
      undefined,
      tx,
    );

    // Create a target cell that currently has an alias to destinationCell
    const targetCell = runtime.getCell<{ result: any }>(
      space,
      "data URI redirect target cell",
      undefined,
      tx,
    );
    targetCell.setRaw({
      result: destinationCell.key("value").getAsWriteRedirectLink(),
    });

    const current = targetCell.key("result").getAsNormalizedFullLink();

    // Write the data cell (which contains a redirect to sourceCell) to the
    // target. The data URI is inlined ahead of the check for a redirect in the
    // current value, so the redirect it holds is written to `target.result`,
    // and the current value's redirect to `destinationCell` is not followed.
    const changes = normalizeAndDiff(
      runtime,
      tx,
      current,
      dataCell.getAsLink(),
    );

    // Should write the new redirect to target Cell.result
    // Note: The change writes a redirect (alias object with $alias key)
    expect(changes.length).toBe(1);
    expect(changes[0].location.id).toBe(
      targetCell.getAsNormalizedFullLink().id,
    );
    expect(changes[0].location.path).toEqual(["result"]);
    // The value should be the redirect link
    expect(isSigilLink(changes[0].value)).toBe(true);
    const parsedLink = parseLink(changes[0].value);
    expect(parsedLink?.overwrite).toBe("redirect");

    applyChangeSet(tx, changes);

    // Verify that targetCell now points to sourceCell's value (99), not destinationCell's (42)
    expect(targetCell.get().result).toBe(99);

    // Verify neither source nor destination cells were modified
    expect(sourceCell.get()).toEqual({ value: 99 });
    expect(destinationCell.get()).toEqual({ value: 42 });
  });

  describe("authoritative container re-assert in normalizeAndDiff", () => {
    // The two container re-assert branches, which are the ONLY places this
    // walk writes a container whole rather than by its members: a subtree that
    // emits nothing has to assert the container itself, or a completion
    // writeback of an equal `[]` against a doomed optimistic overlay commits
    // only its siblings and leaves the durable result torn.
    //
    // Writing a container whole is also what makes its frozenness the store's
    // business rather than the walk's, so these pin both at once: the write
    // happens, and what it carries is not something the caller can go on
    // mutating.

    /**
     * The transaction with the authoritative posture reported. The real setter
     * is gated on a configured seal destination, which is serving-posture
     * plumbing that has nothing to do with what is under test here: the walk
     * reads the posture as one boolean and this supplies it. Methods are bound
     * to the real transaction, whose private state they need.
     */
    function authoritative(): IExtendedStorageTransaction {
      return new Proxy(tx, {
        get(target, prop) {
          if (prop === "isAuthoritativeWrites") return () => true;
          const member = Reflect.get(target, prop, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    }

    it("asserts an equal array whole, frozen and unaliased", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "authoritative re-assert equal array",
        undefined,
        tx,
      );
      testCell.set({ items: [] });
      const current = testCell.key("items").getAsNormalizedFullLink();

      const written: number[] = [];
      const changes = normalizeAndDiff(
        runtime,
        authoritative(),
        current,
        written,
      );

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toEqual([]);
      // Frozen, and not the caller's own array: the caller may still be
      // holding `written` and may still push to it.
      expect(Object.isFrozen(changes[0].value)).toBe(true);
      expect(changes[0].value).not.toBe(written);
      expect(Object.isFrozen(written)).toBe(false);
    });

    it("asserts an equal record whole, frozen and unaliased", () => {
      const testCell = runtime.getCell<{ rec: Record<string, number> }>(
        space,
        "authoritative re-assert equal record",
        undefined,
        tx,
      );
      testCell.set({ rec: {} });
      const current = testCell.key("rec").getAsNormalizedFullLink();

      const written: Record<string, number> = {};
      const changes = normalizeAndDiff(
        runtime,
        authoritative(),
        current,
        written,
      );

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toEqual({});
      expect(Object.isFrozen(changes[0].value)).toBe(true);
      expect(changes[0].value).not.toBe(written);
      expect(Object.isFrozen(written)).toBe(false);
    });

    it("emits nothing for an equal array outside the authoritative posture", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "ordinary posture equal array",
        undefined,
        tx,
      );
      testCell.set({ items: [] });
      const current = testCell.key("items").getAsNormalizedFullLink();

      expect(normalizeAndDiff(runtime, tx, current, []).length).toBe(0);
    });
  });

  describe("array-element anchoring in normalizeAndDiff", () => {
    it("stores array-element objects inline when no anchor id source is supplied", () => {
      // A direct `diffAndUpdate` call with no id source: objects in arrays
      // stay inline rather than becoming documents. The `Cell` write paths
      // always pass one, so this shape is reached by a caller that builds the
      // walk itself.
      const testCell = runtime.getCell<unknown>(
        space,
        "no anchor source stores inline",
        undefined,
        tx,
      );
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        [{ name: "Ada" }],
        "no anchor source stores inline",
      );

      const raw = testCell.getRaw() as unknown[];
      expect(parseLink(raw[0])).toBe(undefined);
      expect(raw[0]).toEqual({ name: "Ada" });
    });

    it("stores each array-element object as a link when one is supplied", () => {
      // The positive half of the case above, over the same call: with an id
      // source each object leaves a link to a document of its own, and two
      // objects at two positions leave two distinct documents.

      const testCell = runtime.getCell<unknown>(
        space,
        "anchor source stores links",
        undefined,
        tx,
      );
      let seed = 0;
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        [{ name: "Ada" }, { name: "Grace" }],
        "anchor source stores links",
        undefined,
        () => seed++,
      );

      const raw = testCell.getRaw() as unknown[];
      const ids = raw.map((entry) => parseLink(entry)?.id);
      expect(ids).toEqual([expect.any(String), expect.any(String)]);
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids).not.toContain(testCell.getAsNormalizedFullLink().id);
    });

    it("leaves an element that arrives as a link alone", () => {
      // An element already carrying a link is stored as that link and draws
      // no id: nothing re-homes a value the writer addressed by reference.

      const target = runtime.getCell<unknown>(
        space,
        "link element target",
        undefined,
        tx,
      );
      const testCell = runtime.getCell<unknown>(
        space,
        "link element container",
        undefined,
        tx,
      );
      const link = createSigilLinkFromParsedLink(
        target.getAsNormalizedFullLink(),
      );
      let draws = 0;
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        [link],
        "link element container",
        undefined,
        () => `seed-${draws++}`,
      );

      expect(draws).toBe(0);
      const raw = testCell.getRaw() as unknown[];
      expect(parseLink(raw[0], testCell)?.id).toBe(
        target.getAsNormalizedFullLink().id,
      );
    });

    it("draws anchor ids pre-order: containing element before nested children", () => {
      // The id source is consumed for an anchored element BEFORE the
      // recursion into its content, so an element containing its own
      // objects-in-arrays draws a lower seed than they do. This pins the
      // sequence deliberately: a change to it would silently re-derive every
      // nested anchored id.
      const testCell = runtime.getCell<unknown>(
        space,
        "pre-order anchor ids",
        undefined,
        tx,
      );
      const seeds: string[] = [];
      let n = 0;
      const context = "pre-order anchor ids";
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        [{ kids: [{ x: 1 }], tag: "outer" }],
        context,
        undefined,
        () => {
          const seed = `seed-${n++}`;
          seeds.push(seed);
          return seed;
        },
      );
      expect(seeds.length).toBe(2);

      const rootLink = testCell.getAsNormalizedFullLink();
      const outerId = toURI(createRef({ id: "seed-0" }, {
        parent: { id: rootLink.id, space: rootLink.space },
        path: ["0"],
        context,
      }));
      const raw = testCell.getRaw() as unknown[];
      const outerLink = parseLink(raw[0], testCell);
      expect(outerLink?.id).toBe(outerId);

      const innerId = toURI(createRef({ id: "seed-1" }, {
        parent: { id: outerId, space: rootLink.space },
        path: ["kids", "0"],
        context,
      }));
      const outerDoc = runtime.getCellFromLink(outerLink!, undefined, tx);
      const outerRaw = outerDoc.getRaw() as { kids: unknown[] };
      expect(parseLink(outerRaw.kids[0], outerDoc)?.id).toBe(innerId);
    });

    it("converges repeated references on one document", () => {
      // The same object in two array slots is one entity: both slots link to
      // a single document and the id source is consumed once. Preserving the
      // written graph's aliasing is deliberate.
      const testCell = runtime.getCell<unknown>(
        space,
        "shared reference converges",
        undefined,
        tx,
      );
      const shared = { name: "Ada" };
      let draws = 0;
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        [shared, shared],
        "shared reference converges",
        undefined,
        () => `seed-${draws++}`,
      );
      expect(draws).toBe(1);
      const raw = testCell.getRaw() as unknown[];
      const first = parseLink(raw[0], testCell);
      const second = parseLink(raw[1], testCell);
      expect(first?.id).not.toBe(undefined);
      expect(second?.id).toBe(first?.id);
    });

    it("promotes an inline-then-array shared object into one document", () => {
      // When the same object appears first as an inline property and then in
      // an array, the array occurrence must not become a link into the
      // document's mutable interior (removing the inline property would
      // leave it dangling). Instead the object is promoted into an entity
      // document of its own -- one id drawn -- and BOTH occurrences link to
      // it, so the written graph's aliasing is preserved on a stable target.
      const testCell = runtime.getCell<unknown>(
        space,
        "inline alias promotes",
        undefined,
        tx,
      );
      const shared = { name: "Ada" };
      let draws = 0;
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        { first: shared, list: [shared] },
        "inline alias promotes",
        undefined,
        () => `seed-${draws++}`,
      );
      expect(draws).toBe(1);
      const raw = testCell.getRaw() as { first: unknown; list: unknown[] };
      const firstLink = parseLink(raw.first, testCell);
      const elementLink = parseLink(raw.list[0], testCell);
      expect(elementLink?.id).not.toBe(undefined);
      expect(elementLink?.path).toEqual([]);
      expect(firstLink?.id).toBe(elementLink?.id);
      const view = testCell.get() as {
        first: { name: string };
        list: { name: string }[];
      };
      expect(view.first).toEqual({ name: "Ada" });
      expect(view.list[0]).toEqual({ name: "Ada" });
    });

    it("promotes a shared object with nested content without creating a cycle", () => {
      // Promotion repoints the earlier inline location at the promoted
      // document -- so the document's own content must not link back through
      // that inline location. Descendants of the promoted object registered
      // under the inline path have to be re-derived under the document root,
      // or the read of the promoted content chases its own tail ("Link cycle
      // detected").
      const testCell = runtime.getCell<unknown>(
        space,
        "nested promotion no cycle",
        undefined,
        tx,
      );
      const shared = { name: "Ada", meta: { role: "pioneer" } };
      let draws = 0;
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        { first: shared, list: [shared] },
        "nested promotion no cycle",
        undefined,
        () => `seed-${draws++}`,
      );
      const view = testCell.get() as {
        first: { name: string; meta: { role: string } };
        list: { name: string; meta: { role: string } }[];
      };
      expect(view.first.meta.role).toBe("pioneer");
      expect(view.list[0].name).toBe("Ada");
      expect(view.list[0].meta.role).toBe("pioneer");
    });

    it("keeps an array occurrence alive after its inline alias is removed", () => {
      // The lifetime consequence of promotion: rewriting the container
      // without the inline property must leave the array element intact,
      // since it points at the shared document rather than at the removed
      // inline location.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "inline alias lifetime",
        reactives: new Set(),
      });
      try {
        const cell = runtime.getCell<{
          first?: { name: string };
          list: { name: string }[];
          // deno-lint-ignore no-explicit-any
        }>(space, "inline alias lifetime", undefined, tx) as any;
        const shared = { name: "Ada" };

        cell.set({ first: shared, list: [shared] });
        expect(cell.get().list[0]).toEqual({ name: "Ada" });

        const raw = cell.getRaw() as { list: unknown[] };
        cell.set({ list: raw.list });
        expect(cell.get().first).toBe(undefined);
        expect(cell.get().list[0]).toEqual({ name: "Ada" });
      } finally {
        popFrame(frame);
      }
    });

    it("normalizes addUnique candidates before stored-value comparison", () => {
      // The dedup comparison must see the candidate in its fabric form: a
      // repeated JS `Date` matches the stored `FabricEpochNsec` and
      // no-ops rather than throwing (or duplicating). The normalization is
      // comparison-only -- an ACCEPTED candidate writes the original value.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "addUnique normalization",
        reactives: new Set(),
      });
      try {
        const cell = runtime.getCell<unknown[]>(
          space,
          "addUnique normalization",
          undefined,
          tx,
        );
        cell.set([new Date(1234)]);
        cell.addUnique(new Date(1234));
        expect((cell.getRaw() as unknown[]).length).toBe(1);
      } finally {
        popFrame(frame);
      }
    });

    it("persists an array element's self-reference as a self-link", () => {
      // An anchored element that references itself stores the cycle as a
      // link back to its own document root.
      const testCell = runtime.getCell<unknown>(
        space,
        "self reference self-link",
        undefined,
        tx,
      );
      const loop: { tag: string; self?: unknown } = { tag: "loop" };
      loop.self = loop;
      let draws = 0;
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        [loop],
        "self reference self-link",
        undefined,
        () => `seed-${draws++}`,
      );
      expect(draws).toBe(1);
      const raw = testCell.getRaw() as unknown[];
      const elementLink = parseLink(raw[0], testCell);
      expect(elementLink?.id).not.toBe(undefined);
      const doc = runtime.getCellFromLink(elementLink!, undefined, tx);
      const docRaw = doc.getRaw() as { tag: string; self: unknown };
      expect(docRaw.tag).toBe("loop");
      const selfLink = parseLink(docRaw.self, doc);
      expect(selfLink?.id).toBe(elementLink?.id);
      expect(selfLink?.path).toEqual([]);
    });

    it("anchors an element whose nested Cell awaits normalization", () => {
      // A written element is only SHALLOWLY normalized when anchoring
      // eligibility is decided; its nested contents (Cells here) convert
      // during the recursion that follows. The untouched-prefix check must
      // therefore never inspect the element's contents -- an equal-shaped
      // fresh element carrying a Cell must anchor and normalize, not trip a
      // premature deep comparison against the stored value.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "nested cell awaits normalization",
        reactives: new Set(),
      });
      try {
        const target = runtime.getCell<{ hello: string }>(
          space,
          "nested cell normalization target",
          undefined,
          tx,
        );
        target.set({ hello: "world" });

        const list = runtime.getCell<{ ref: unknown }[]>(
          space,
          "nested cell awaits normalization list",
          undefined,
          tx,
        );
        // Stored prefix shaped like the incoming write, inline.
        list.setRaw([{ ref: null }]);

        list.set([{ ref: target }]);

        const raw = list.getRaw() as unknown[];
        const elementLink = parseLink(raw[0], list);
        expect(elementLink?.id).not.toBe(undefined);
        const doc = runtime.getCellFromLink(elementLink!, undefined, tx);
        const docRaw = doc.getRaw() as { ref: unknown };
        const refLink = parseLink(docRaw.ref, doc);
        expect(refLink?.id).toBe(target.getAsNormalizedFullLink().id);
      } finally {
        popFrame(frame);
      }
    });

    it("pushing a reference to an untouched prefix's interior leaves the prefix alone", () => {
      // An untouched prefix element must not be descended: registering its
      // interior objects in the walk's seen map would let a pushed reference
      // to one of them alias -- and repoint -- content INSIDE the untouched
      // prefix, a write below the tail that the mergeable ops forbid. The
      // pushed reference anchors as a fresh document instead.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "untouched prefix interior",
        reactives: new Set(),
      });
      try {
        const cell = runtime.getCell<{ inner: { name: string } }[]>(
          space,
          "untouched prefix interior",
          undefined,
          tx,
        );
        // Deep-frozen seed: the stored tree keeps reference identity through
        // raw reads, so `inner` below IS the stored interior object. Frozen
        // as statements so the binding keeps its mutable type for `setRaw`.
        const innerSeed = { name: "Ada" };
        const seed = [{ inner: innerSeed }];
        Object.freeze(innerSeed);
        Object.freeze(seed[0]);
        Object.freeze(seed);
        cell.setRaw(seed);
        const stored = cell.getRaw() as { inner: { name: string } }[];
        const inner = stored[0].inner;
        expect(inner).toBe(innerSeed);

        cell.push(inner as unknown as { inner: { name: string } });

        const raw = cell.getRaw() as { inner: unknown }[];
        // The prefix element is byte-for-byte untouched: still inline, its
        // interior still an inline object, not a link.
        expect(parseLink(raw[0])).toBe(undefined);
        expect(parseLink((raw[0] as { inner: unknown }).inner)).toBe(
          undefined,
        );
        expect(raw[0]).toEqual({ inner: { name: "Ada" } });
        // The pushed element anchored as its own fresh document.
        const tailLink = parseLink(raw[1], cell);
        expect(tailLink?.id).not.toBe(undefined);
        const doc = runtime.getCellFromLink(tailLink!, undefined, tx);
        expect(doc.get()).toEqual({ name: "Ada" });
      } finally {
        popFrame(frame);
      }
    });

    it("pushing a reference into an untouched NESTED-array prefix leaves it alone", () => {
      // Same principle one level deeper: an untouched prefix element that is
      // itself an array descends (arrays are never anchored), but its object
      // elements hit the identity no-op before being registered -- so a
      // pushed reference to one of them anchors fresh rather than promoting
      // and repointing inside the untouched nested array.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "untouched nested-array prefix",
        reactives: new Set(),
      });
      try {
        const cell = runtime.getCell<{ name: string }[][]>(
          space,
          "untouched nested-array prefix",
          undefined,
          tx,
        );
        const innerSeed = { name: "Ada" };
        const nested = [innerSeed];
        const seed = [nested];
        Object.freeze(innerSeed);
        Object.freeze(nested);
        Object.freeze(seed);
        cell.setRaw(seed);
        const stored = cell.getRaw() as { name: string }[][];
        const innerObject = stored[0][0];
        expect(innerObject).toBe(innerSeed);

        cell.push(innerObject as unknown as { name: string }[]);

        const raw = cell.getRaw() as unknown[];
        // The nested-array prefix is byte-for-byte untouched.
        expect(parseLink(raw[0])).toBe(undefined);
        expect(parseLink((raw[0] as unknown[])[0])).toBe(undefined);
        expect(raw[0]).toEqual([{ name: "Ada" }]);
        // The pushed element anchored as its own fresh document.
        const tailLink = parseLink(raw[1], cell);
        expect(tailLink?.id).not.toBe(undefined);
        const doc = runtime.getCellFromLink(tailLink!, undefined, tx);
        expect(doc.get()).toEqual({ name: "Ada" });
      } finally {
        popFrame(frame);
      }
    });

    it("framed addUnique handles a deeply shared acyclic candidate", () => {
      // A diamond-shaped candidate (each level's object shared by two
      // parents) is acyclic but has exponentially many paths. The cycle
      // check must memoize completed nodes -- candidate values are
      // user-controlled, and without the memo this walk (not the write)
      // would hang the handler. This test simply completing is the guard.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "addUnique shared dag",
        reactives: new Set(),
      });
      try {
        const cell = runtime.getCell<unknown[]>(
          space,
          "addUnique shared dag",
          undefined,
          tx,
        );
        cell.set([]);
        let node: Record<string, unknown> = { leaf: true };
        for (let i = 0; i < 30; i++) {
          node = { a: node, b: node };
        }
        cell.addUnique(node);
        expect((cell.getRaw() as unknown[]).length).toBe(1);
      } finally {
        popFrame(frame);
      }
    });

    it("framed addUnique accepts a new self-referential candidate", () => {
      // A cyclic candidate can never equal a stored element -- stored fabric
      // values are acyclic (cycles persist as links) -- so the dedup must
      // treat it as new without attempting the strict normalization that a
      // cycle would break, and the write path then anchors it with the cycle
      // as a self-link.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "addUnique cyclic candidate",
        reactives: new Set(),
      });
      try {
        const cell = runtime.getCell<unknown[]>(
          space,
          "addUnique cyclic candidate",
          undefined,
          tx,
        );
        cell.set([]);
        const loop: { tag: string; self?: unknown } = { tag: "loop" };
        loop.self = loop;
        cell.addUnique(loop);

        const raw = cell.getRaw() as unknown[];
        expect(raw.length).toBe(1);
        const elementLink = parseLink(raw[0], cell);
        expect(elementLink?.id).not.toBe(undefined);
        const doc = runtime.getCellFromLink(elementLink!, undefined, tx);
        const docRaw = doc.getRaw() as { tag: string; self: unknown };
        expect(docRaw.tag).toBe("loop");
        expect(parseLink(docRaw.self, doc)?.id).toBe(elementLink?.id);
      } finally {
        popFrame(frame);
      }
    });

    it("derives position-independent ids over a stored array", () => {
      // Once an array is stored, the ancestor climb strips index segments,
      // so an anchored element's identity derives from the array's own
      // location -- the same seed and context yield the same document at any
      // index. This is load-bearing for re-runs: a handler reuses its frame
      // cause and counter sequence, and without index-stripping an element
      // whose stored position had shifted would silently fork a new
      // document.
      const testCell = runtime.getCell<unknown>(
        space,
        "position independent stored ids",
        undefined,
        tx,
      );
      testCell.setRaw(["x", "y"]);
      const context = "position independent stored ids";

      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        ["x", { name: "Ada" }],
        context,
        undefined,
        () => "probe-seed",
      );
      const idAtOne = parseLink(
        (testCell.getRaw() as unknown[])[1],
        testCell,
      )?.id;
      expect(idAtOne).not.toBe(undefined);

      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        [{ name: "Ada" }, "y"],
        context,
        undefined,
        () => "probe-seed",
      );
      const idAtZero = parseLink(
        (testCell.getRaw() as unknown[])[0],
        testCell,
      )?.id;
      expect(idAtZero).toBe(idAtOne);
    });

    it("draws no anchor id for an addUnique candidate rejected as duplicate", () => {
      // A candidate `addUnique` rejects never reaches the write, so it draws
      // no id.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "addUnique duplicate draws nothing",
        reactives: new Set(),
      });
      try {
        const c = runtime.getCell<{ v: number }[]>(
          space,
          "addUnique duplicate draws nothing",
          undefined,
          tx,
        );
        // Seed an INLINE element via a raw write, so a plain candidate can
        // match it by content.
        c.setRaw([{ v: 1 }]);
        c.addUnique({ v: 1 });
        expect(frame.generatedIdCounter).toBe(0);
        expect((c.getRaw() as unknown[]).length).toBe(1);

        // An accepted candidate draws exactly one id, and the existing
        // inline element passes through UNTOUCHED -- not anchored, not
        // rewritten. That restraint is load-bearing: addUnique's array read
        // is excluded from the commit's conflict set (mergeable op), which
        // is only safe while the op emits no writes below the tail.
        c.addUnique({ v: 2 });
        const raw = c.getRaw() as unknown[];
        expect(raw.length).toBe(2);
        expect(frame.generatedIdCounter).toBe(1);
        expect(parseLink(raw[0])).toBe(undefined);
        expect(raw[0]).toEqual({ v: 1 });
        expect(parseLink(raw[1], c)?.id).not.toBe(undefined);
      } finally {
        popFrame(frame);
      }
    });

    it("anchors an object written over an array element's write redirect", () => {
      // The element slot's current value is a write redirect. Writing a plain
      // object there under a frame must still anchor it into a document of
      // its own -- eligibility comes from the written tree's structure and
      // has to survive the alias-following re-entry -- with the redirect
      // target ending up as a link to that document.
      const targetCell = runtime.getCell<unknown>(
        space,
        "redirect anchor target",
        undefined,
        tx,
      );
      targetCell.set(undefined);
      const arrayCell = runtime.getCell<unknown[]>(
        space,
        "redirect anchor array",
        undefined,
        tx,
      );
      arrayCell.setRaw([targetCell.getAsWriteRedirectLink()]);

      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "redirect anchor context",
        reactives: new Set(),
      });
      arrayCell.set([{ name: "Ada" }]);
      popFrame(frame);

      // The redirect target holds a link to the anchored document, and the
      // content reads back through the array.
      const targetRaw = targetCell.getRaw();
      expect(parseLink(targetRaw, targetCell)?.id).not.toBe(undefined);
      expect((arrayCell.get() as { name: string }[])[0].name).toBe("Ada");
    });
  });

  describe("sparse array handling in normalizeAndDiff", () => {
    it("hole→hole: no changes emitted", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "sparse hole-to-hole",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const sparse: any[] = new Array(3);
      sparse[0] = 1;
      sparse[2] = 3;
      testCell.set({ arr: sparse });

      const current = testCell.key("arr").getAsNormalizedFullLink();
      // Same sparse array as new value
      // deno-lint-ignore no-explicit-any
      const newSparse: any[] = new Array(3);
      newSparse[0] = 1;
      newSparse[2] = 3;
      const changes = normalizeAndDiff(runtime, tx, current, newSparse);
      // No changes expected (hole→hole at index 1, same values at 0 and 2)
      expect(changes.length).toBe(0);
    });

    it("value→hole: emits delete for the index", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "sparse value-to-hole",
        undefined,
        tx,
      );
      testCell.set({ arr: [1, 2, 3] });

      const current = testCell.key("arr").getAsNormalizedFullLink();
      // New value has a hole at index 1
      // deno-lint-ignore no-explicit-any
      const newSparse: any[] = new Array(3);
      newSparse[0] = 1;
      newSparse[2] = 3;
      const changes = normalizeAndDiff(runtime, tx, current, newSparse);
      // Should emit a delete for index 1
      const deleteChange = changes.find((c) =>
        c.location.path[c.location.path.length - 1] === "1"
      );
      expect(deleteChange).toBeDefined();
      expect(deleteChange!.value).toBe(undefined);
    });

    it("hole→value: emits set for the index", () => {
      const testCell = runtime.getCell<{ arr: number[] }>(
        space,
        "sparse hole-to-value",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const sparse: any[] = new Array(3);
      sparse[0] = 1;
      sparse[2] = 3;
      testCell.set({ arr: sparse });

      const current = testCell.key("arr").getAsNormalizedFullLink();
      // New value fills the hole at index 1
      const changes = normalizeAndDiff(runtime, tx, current, [1, 2, 3]);
      // Should emit a set for index 1
      const setChange = changes.find((c) =>
        c.location.path[c.location.path.length - 1] === "1"
      );
      expect(setChange).toBeDefined();
      expect(setChange!.value).toBe(2);
    });
  });

  describe("getRaw followed by setRaw works", () => {
    it("should work", () => {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "getRaw followed by setRaw works",
      );
      cell.withTx(tx).setRaw({ value: 42 });
      const raw = cell.withTx(tx).getRaw();
      expect(raw?.value).toBe(42);
      cell.withTx(tx).setRaw(raw);
      expect(cell.withTx(tx).get().value).toBe(42);
    });
  });

  describe("writing back what a read handed out", () => {
    /** The list shape a search index or an autocomplete list has. */
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        label: `entry-${i}`,
        nested: { id: `id-${i}` },
      }));

    /** Writes a list back with one element replaced, counting reads. */
    const rewriteOneElement = (n: number) => {
      const cell = runtime.getCell<ReturnType<typeof list>>(
        space,
        `write back ${n}`,
        undefined,
        tx,
      );
      cell.set(list(n));

      const written = [...cell.get()];
      written[7] = { label: "changed", nested: { id: "changed" } };
      const before = tx.getReactivityLog!().reads.length;
      cell.set(written);
      const reads = tx.getReactivityLog!().reads.length - before;

      return { reads, value: cell.get() };
    };

    it("records the same reads however long the list is", () => {
      // Each element a read hands out is a query result, and the diff replaces
      // one with the link it names rather than reading into it. Nothing ahead
      // of the diff reads into one either, so what a write-back costs does not
      // follow the length: a member read resolves through the transaction and
      // is recorded on it as a dependency the commit has to check.
      const short = rewriteOneElement(50);
      const long = rewriteOneElement(500);

      expect(long.reads).toBe(short.reads);
      // And what it records is a handful, not a number that merely happens to
      // match at both lengths: fewer reads than the shorter list has
      // elements, and more than none. A write-back records the dependencies
      // its commit is checked against, so a count of zero is a write that
      // conflicts with nothing, which two equal counts alone would accept.
      expect(long.reads).toBeGreaterThan(0);
      expect(long.reads).toBeLessThan(50);
    });

    it("stores a value carrying `toCell` as the link it names", () => {
      // What the walk stops at, the diff replaces with a link -- which is
      // what makes an unchanged element of a read-back list cost nothing to
      // write, and is the property the walk stopping must not disturb. Both
      // kinds of value carry `toCell` and both land the same way: the live
      // view a schemaless read hands out, and the frozen result a read
      // through a schema annotates.
      const source = runtime.getCell<{ inner: { deep: number } }>(
        space,
        "toCell source",
        undefined,
        tx,
      );
      source.set({ inner: { deep: 1 } });
      const innerLink = source.key("inner").getAsNormalizedFullLink();

      const live = (source.get() as { inner: unknown }).inner;
      const frozen = (runtime.getCell(
        space,
        "toCell source",
        {
          type: "object",
          properties: { inner: { type: "object" } },
        } as JSONSchema,
        tx,
      ).get() as { inner: unknown }).inner;

      const storedFor = (name: string, held: unknown) => {
        const holder = runtime.getCell(space, name, undefined, tx);
        holder.set({ held });
        return (holder.getRaw() as { held: unknown }).held;
      };
      const fromLive = storedFor("toCell holder live", live);
      const fromFrozen = storedFor("toCell holder frozen", frozen);

      expect(isSigilLink(fromLive)).toBe(true);
      expect(areNormalizedLinksSame(parseLink(fromLive)!, innerLink)).toBe(
        true,
      );
      expect(fromFrozen).toEqual(fromLive);
    });

    it("writes the changed element and leaves its neighbor", () => {
      const { value } = rewriteOneElement(50);

      expect(value[7].label).toBe("changed");
      expect(value[8].label).toBe("entry-8");
    });
  });
});

/**
 * Tests for compactChangeSet - a pure function that removes redundant child
 * path changes when a parent path change already includes that data.
 */
describe("compactChangeSet", () => {
  // Helper to create a change at a specific path
  const makeChange = (
    path: string[],
    value: unknown,
    docId: `${string}:${string}` = "test:doc",
    docSpace: `did:${string}:${string}` = "did:test:space",
  ): ChangeSet[0] => ({
    location: {
      id: docId,
      space: docSpace,
      scope: "space",
      path,
    },
    value: value as any,
  });

  describe("basic cases", () => {
    it("should return single change unchanged", () => {
      const changes: ChangeSet = [makeChange(["foo"], { a: 1 })];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(changes[0]);
    });

    it("should return empty array for empty input", () => {
      const result = compactChangeSet([]);
      expect(result).toHaveLength(0);
    });

    it("should return all changes when paths are siblings (no parent-child)", () => {
      const changes: ChangeSet = [
        makeChange(["a"], 1),
        makeChange(["b"], 2),
        makeChange(["c"], 3),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(3);
    });
  });

  describe("subsumption cases", () => {
    it("should subsume child when parent has matching content", () => {
      // Parent writes {a: 1} to 'foo', child writes 1 to 'foo.a'
      // Child write IS redundant because parent already sets 'a'
      const changes: ChangeSet = [
        makeChange(["foo"], { a: 1 }),
        makeChange(["foo", "a"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["foo"]);
    });

    it("does not subsume a child whose key the parent does not set", () => {
      // Parent writes {a: 1} to 'foo', child writes 99 to 'foo.b' (DIFFERENT key!)
      // Child write is NOT redundant - it sets a key not in parent!
      const changes: ChangeSet = [
        makeChange(["foo"], { a: 1 }),
        makeChange(["foo", "b"], 99),
      ];
      const result = compactChangeSet(changes);

      // Both changes are kept because parent doesn't include 'b'
      expect(result).toHaveLength(2);
      expect(result[0].location.path).toEqual(["foo"]);
      expect(result[1].location.path).toEqual(["foo", "b"]);
    });

    it("should subsume child when parent is deleted (undefined)", () => {
      // Deleting parent also deletes all children
      const changes: ChangeSet = [
        makeChange(["foo"], undefined),
        makeChange(["foo", "a"], 1),
        makeChange(["foo", "b", "c"], 2),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["foo"]);
      expect(result[0].value).toBeUndefined();
    });
  });

  describe("empty parent cases", () => {
    it("should NOT subsume when parent is empty object {}", () => {
      // Empty object doesn't include any children
      const changes: ChangeSet = [
        makeChange(["foo"], {}),
        makeChange(["foo", "a"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });

    it("should NOT subsume when parent is empty array []", () => {
      // Empty array doesn't include any children
      const changes: ChangeSet = [
        makeChange(["items"], []),
        makeChange(["items", "0"], "first"),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });

    it("should NOT subsume when parent is null", () => {
      const changes: ChangeSet = [
        makeChange(["foo"], null),
        makeChange(["foo", "a"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });

    it("should NOT subsume when parent is primitive", () => {
      // Primitive can't have children
      const changes: ChangeSet = [
        makeChange(["foo"], 42),
        makeChange(["foo", "a"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });
  });

  describe("multi-document cases", () => {
    it("should not subsume across different documents", () => {
      const changes: ChangeSet = [
        makeChange(["foo"], { a: 1 }, "test:doc1"),
        makeChange(["foo", "a"], 1, "test:doc2"),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });

    it("should not subsume across different spaces", () => {
      const changes: ChangeSet = [
        makeChange(["foo"], { a: 1 }, "test:doc", "did:test:space1"),
        makeChange(["foo", "a"], 1, "test:doc", "did:test:space2"),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });
  });

  describe("deep nesting", () => {
    it("should subsume grandchild when grandparent has content", () => {
      const changes: ChangeSet = [
        makeChange(["a"], { b: { c: 1 } }),
        makeChange(["a", "b"], { c: 1 }),
        makeChange(["a", "b", "c"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["a"]);
    });

    it("should handle mixed nesting depths correctly", () => {
      // Parent sets {x: 1}, children set other keys at various depths
      const changes: ChangeSet = [
        makeChange(["root"], { x: 1 }),
        makeChange(["root", "y"], 2), // NOT in parent - should be kept
        makeChange(["root", "z", "deep"], 3), // NOT in parent - should be kept
      ];
      const result = compactChangeSet(changes);

      // Only children whose paths exist in parent are subsumed
      // Parent {x: 1} doesn't contain 'y' or 'z', so all 3 changes are kept
      expect(result).toHaveLength(3);
      expect(result[0].location.path).toEqual(["root"]);
      expect(result[1].location.path).toEqual(["root", "y"]);
      expect(result[2].location.path).toEqual(["root", "z", "deep"]);
    });
  });

  describe("array index paths", () => {
    it("should handle array index paths correctly", () => {
      const changes: ChangeSet = [
        makeChange(["items"], [1, 2, 3]),
        makeChange(["items", "0"], 1),
        makeChange(["items", "1"], 2),
      ];
      const result = compactChangeSet(changes);
      // Parent array has content, so children should be subsumed
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["items"]);
    });

    it("should handle array length changes", () => {
      const changes: ChangeSet = [
        makeChange(["items"], [1, 2]),
        makeChange(["items", "length"], 2),
      ];
      const result = compactChangeSet(changes);
      // Array has content, length change is subsumed
      expect(result).toHaveLength(1);
    });

    it("should NOT subsume child with leading-zero index like '01'", () => {
      // Parent writes array [1, 2], child writes to index "01"
      // "01" is not a valid array index (has leading zero), so the child
      // path does NOT exist in the parent and should NOT be subsumed.
      // `isArrayIndexPropertyName()` decides, and it returns `false` for "01".
      const changes: ChangeSet = [
        makeChange(["items"], [1, 2]),
        makeChange(["items", "01"], 99),
      ];
      const result = compactChangeSet(changes);
      // Child should NOT be subsumed because "01" is not a valid array index
      expect(result).toHaveLength(2);
      expect(result[0].location.path).toEqual(["items"]);
      expect(result[1].location.path).toEqual(["items", "01"]);
    });
  });

  describe("order independence", () => {
    it("should work regardless of input order (child before parent)", () => {
      // Changes provided in child-first order
      const changes: ChangeSet = [
        makeChange(["foo", "a"], 1),
        makeChange(["foo"], { a: 1 }),
      ];
      const result = compactChangeSet(changes);
      // Should still compact to just the parent
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["foo"]);
    });
  });

  describe("sparse array hasPath", () => {
    it("should NOT subsume child at sparse hole index", () => {
      // Parent writes sparse array [1, <hole>, 3]
      // deno-lint-ignore no-explicit-any
      const sparse: any[] = new Array(3);
      sparse[0] = 1;
      sparse[2] = 3;
      const changes: ChangeSet = [
        makeChange(["items"], sparse),
        makeChange(["items", "1"], 99), // index 1 is a hole in the parent
      ];
      const result = compactChangeSet(changes);
      // Child at index "1" should NOT be subsumed because it's a hole in parent
      expect(result).toHaveLength(2);
      expect(result[0].location.path).toEqual(["items"]);
      expect(result[1].location.path).toEqual(["items", "1"]);
    });

    it("should subsume child at populated sparse index", () => {
      // Parent writes sparse array [1, <hole>, 3]
      // deno-lint-ignore no-explicit-any
      const sparse: any[] = new Array(3);
      sparse[0] = 1;
      sparse[2] = 3;
      const changes: ChangeSet = [
        makeChange(["items"], sparse),
        makeChange(["items", "0"], 1), // index 0 exists in parent
      ];
      const result = compactChangeSet(changes);
      // Child at index "0" should be subsumed because it exists in parent
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["items"]);
    });
  });

  describe("batched applyChangeSet", () => {
    const makeBatchChange = (
      path: string[],
      value: unknown,
    ): ChangeSet[0] => ({
      location: {
        id: "test:batched-doc",
        space: "did:test:space",
        scope: "space",
        path,
      },
      value: value as any,
    });

    it("prefers the transaction batch hook when applying a change set", () => {
      const batches: Array<
        Array<{ address: ChangeSet[0]["location"]; value: unknown }>
      > = [];
      const txWithBatch = {
        writeValueOrThrow() {
          throw new Error("applyChangeSet should use writeValuesOrThrow");
        },
        writeValuesOrThrow(
          writes: Iterable<{
            address: ChangeSet[0]["location"];
            value: unknown;
          }>,
        ) {
          batches.push([...writes]);
        },
      } as unknown as IExtendedStorageTransaction;

      applyChangeSet(txWithBatch, [
        makeBatchChange(["profile", "name"], "Ada"),
        makeBatchChange(["profile", "age"], 42),
      ]);

      expect(batches).toEqual([[
        {
          address: {
            id: "test:batched-doc",
            space: "did:test:space",
            scope: "space",
            path: ["profile", "name"],
          },
          value: "Ada",
        },
        {
          address: {
            id: "test:batched-doc",
            space: "did:test:space",
            scope: "space",
            path: ["profile", "age"],
          },
          value: 42,
        },
      ]]);
    });

    it("lets the v2 transaction batch hook materialize missing parents", async () => {
      const localStorageManager = StorageManager.emulate({ as: signer });
      const localRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: localStorageManager,
      });
      const localTx = localRuntime.edit();

      try {
        const testCell = localRuntime.getCell<{ profile?: { name?: string } }>(
          space,
          "batched applyChangeSet materializes parents",
          undefined,
          localTx,
        );

        localTx.writeValuesOrThrow?.([{
          address: testCell.key("profile").key("name")
            .getAsNormalizedFullLink(),
          value: "Ada",
        }]);

        expect(testCell.get()).toEqual({ profile: { name: "Ada" } });
      } finally {
        await localTx.commit();
        await localRuntime.dispose();
        await localStorageManager.close();
      }
    });
  });
});

describe("scope-isolation write guard", () => {
  // Scope-isolation write guard (docs/specs/scoped-cell-instances.md; pitfall 6
  // in docs/development/debugging/gotchas/scoped-cell-pitfalls.md): links do
  // not carry a principal, so a narrower-scoped link stored in a broader-scoped
  // slot resolves to a DIFFERENT instance for every reader — shared data
  // written that way can never propagate. The guard WARNS loudly at the write
  // site unless the slot's schema declares the scope (per-reader semantics
  // opted into by the author). It is a warn, not a throw, because the runtime's
  // own machinery legitimately writes scoped links into scope-silent slots
  // today (.asScope() result links, navigateTo result cells, updateArgument
  // setup wiring).

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  const warnCounts = (): number => {
    const logger = (globalThis as {
      commonfabric?: {
        logger?: Record<string, { counts: { warn: number } }>;
      };
    }).commonfabric?.logger?.["normalizeAndDiff"];
    expect(logger).toBeDefined();
    return logger!.counts.warn;
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
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  function scopedLinkValue(
    name: string,
    scope: "user" | "session",
  ): unknown {
    const base = runtime.getCell<string>(
      space,
      name,
      { type: "string" },
      tx,
    ).getAsNormalizedFullLink();
    return createSigilLinkFromParsedLink({ ...base, scope });
  }

  it("warns on a user-scoped link written into a scope-silent space slot (write still lands)", () => {
    const dest = runtime.getCell<{ profile?: unknown }>(
      space,
      "scope-guard-silent-dest",
      {
        type: "object",
        properties: { profile: { type: "object" } },
      } as const satisfies JSONSchema,
      tx,
    );
    dest.set({});

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("profile").getAsNormalizedFullLink(),
      scopedLinkValue("scope-guard-user-target", "user"),
    );
    expect(warnCounts()).toBe(before + 1);
    const stored = tx.readValueOrThrow(
      dest.key("profile").getAsNormalizedFullLink(),
    );
    expect(isSigilLink(stored)).toBe(true);
  });

  it("does not warn when the slot's schema declares the scope", () => {
    const dest = runtime.getCell<{ profile?: unknown }>(
      space,
      "scope-guard-declared-dest",
      {
        type: "object",
        properties: { profile: { type: "object", scope: "user" } },
      } as const satisfies JSONSchema,
      tx,
    );
    dest.set({});

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("profile").getAsNormalizedFullLink(),
      scopedLinkValue("scope-guard-declared-target", "user"),
    );
    expect(warnCounts()).toBe(before);
    const stored = tx.readValueOrThrow(
      dest.key("profile").getAsNormalizedFullLink(),
    );
    expect(isSigilLink(stored)).toBe(true);
    expect(parseLink(stored as any, dest.getAsNormalizedFullLink())?.scope)
      .toBe("user");
  });

  it("warns on a session link even when the slot declares only user scope", () => {
    const dest = runtime.getCell<{ draft?: unknown }>(
      space,
      "scope-guard-under-declared-dest",
      {
        type: "object",
        properties: { draft: { type: "object", scope: "user" } },
      } as const satisfies JSONSchema,
      tx,
    );
    dest.set({});

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("draft").getAsNormalizedFullLink(),
      scopedLinkValue("scope-guard-session-target", "session"),
    );
    expect(warnCounts()).toBe(before + 1);
  });

  it("does not warn when the slot's schema tolerates `undefined`", () => {
    // A slot that matches undefined degrades harmlessly for readers whose
    // resolution comes up empty — per-reader links there are a legitimate
    // pattern, not the blackout footgun.
    const dest = runtime.getCell<{ profile?: unknown }>(
      space,
      "scope-guard-undef-tolerant-dest",
      {
        type: "object",
        properties: { profile: { type: ["object", "undefined"] } },
      } as unknown as JSONSchema,
      tx,
    );
    dest.set({});

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("profile").getAsNormalizedFullLink(),
      scopedLinkValue("scope-guard-undef-tolerant-target", "user"),
    );
    expect(warnCounts()).toBe(before);
  });

  it("does not warn when the slot's schema carries a default", () => {
    const dest = runtime.getCell<{ profile?: unknown }>(
      space,
      "scope-guard-default-dest",
      {
        type: "object",
        properties: {
          profile: { type: "object", default: {} },
        },
      } as unknown as JSONSchema,
      tx,
    );
    dest.set({});

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("profile").getAsNormalizedFullLink(),
      scopedLinkValue("scope-guard-default-target", "user"),
    );
    expect(warnCounts()).toBe(before);
  });

  it("warns when the parent schema requires the slot (write through the parent)", () => {
    const dest = runtime.getCell<{ author?: string; profile?: unknown }>(
      space,
      "scope-guard-parent-required-dest",
      {
        type: "object",
        properties: {
          author: { type: "string" },
          profile: { type: "object" },
        },
        required: ["author", "profile"],
      } as const satisfies JSONSchema,
      tx,
    );

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.getAsNormalizedFullLink(),
      {
        author: "alice",
        profile: scopedLinkValue("scope-guard-parent-required-target", "user"),
      },
    );
    expect(warnCounts()).toBe(before + 1);
  });

  it("does not warn for an optional slot, even when strictly typed", () => {
    // The parent's `required` list is what makes a missing cell void the
    // read; an optional property is simply dropped and the object survives —
    // per-reader links there degrade harmlessly.
    const dest = runtime.getCell<{ author?: string; profile?: unknown }>(
      space,
      "scope-guard-parent-optional-dest",
      {
        type: "object",
        properties: {
          author: { type: "string" },
          profile: { type: "object" },
        },
        required: ["author"],
      } as const satisfies JSONSchema,
      tx,
    );

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.getAsNormalizedFullLink(),
      {
        author: "alice",
        profile: scopedLinkValue("scope-guard-parent-optional-target", "user"),
      },
    );
    expect(warnCounts()).toBe(before);
  });

  it("resolves $defs/$ref slot schemas before judging tolerance (still warns on strict refs)", () => {
    // CTS-emitted slot schemas routinely carry $defs + $ref; tolerance must be
    // judged on the resolved schema, not the ref wrapper.
    const dest = runtime.getCell<{ profile?: unknown }>(
      space,
      "scope-guard-ref-dest",
      {
        type: "object",
        properties: {
          profile: {
            $defs: { P: { type: "object" } },
            $ref: "#/$defs/P",
          },
        },
      } as unknown as JSONSchema,
      tx,
    );
    dest.set({});

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("profile").getAsNormalizedFullLink(),
      scopedLinkValue("scope-guard-ref-target", "user"),
    );
    expect(warnCounts()).toBe(before + 1);
  });

  it("does not warn when re-serializing the identical stored link (no-op route)", () => {
    // At-rest data must not start warning on unrelated rewrites: the same
    // link written twice takes the no-op branch, which precedes the guard.
    const dest = runtime.getCell<{ profile?: unknown }>(
      space,
      "scope-guard-noop-dest",
      {
        type: "object",
        properties: { profile: { type: "object" } },
      } as const satisfies JSONSchema,
      tx,
    );
    dest.set({});
    const value = scopedLinkValue("scope-guard-noop-target", "user");

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("profile").getAsNormalizedFullLink(),
      value,
    );
    expect(warnCounts()).toBe(before + 1);
    // Second, identical write: no-op, no additional warn.
    diffAndUpdate(
      runtime,
      tx,
      dest.key("profile").getAsNormalizedFullLink(),
      value,
    );
    expect(warnCounts()).toBe(before + 1);
  });

  it("warns despite a default of null (the read side skips null defaults)", () => {
    // Read-side default application uses a loose `!= undefined` check, so
    // `default: null` never fills the hole — the slot is NOT tolerant.
    const dest = runtime.getCell<{ profile?: unknown }>(
      space,
      "scope-guard-null-default-dest",
      {
        type: "object",
        properties: {
          profile: { type: "object", default: null },
        },
      } as unknown as JSONSchema,
      tx,
    );
    dest.set({});

    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("profile").getAsNormalizedFullLink(),
      scopedLinkValue("scope-guard-null-default-target", "user"),
    );
    expect(warnCounts()).toBe(before + 1);
  });

  it("does not warn for same-scope links (space into space)", () => {
    const dest = runtime.getCell<{ item?: unknown }>(
      space,
      "scope-guard-same-scope-dest",
      {
        type: "object",
        properties: { item: { type: "object" } },
      } as const satisfies JSONSchema,
      tx,
    );
    dest.set({});

    const base = runtime.getCell<string>(
      space,
      "scope-guard-space-target",
      { type: "string" },
      tx,
    ).getAsNormalizedFullLink();
    const before = warnCounts();
    diffAndUpdate(
      runtime,
      tx,
      dest.key("item").getAsNormalizedFullLink(),
      createSigilLinkFromParsedLink(base),
    );
    expect(warnCounts()).toBe(before);
    const stored = tx.readValueOrThrow(
      dest.key("item").getAsNormalizedFullLink(),
    );
    expect(isSigilLink(stored)).toBe(true);
  });
});

describe("a write into a slot whose schema names a scoped definition", () => {
  // The slot holds a `$ref`, and the scope sits on the definition it names,
  // which is where a recursive type puts it: the definition is what every
  // position of that type refers to.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  const scopedDefinitionSchema = {
    type: "object",
    properties: { nickname: { $ref: "#/$defs/Nickname" } },
    $defs: { Nickname: { type: "string", scope: "user" } },
  } as const satisfies JSONSchema;

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

  it("stores a redirect to the scoped instance rather than the value", () => {
    const dest = runtime.getCell<{ nickname: string }>(
      space,
      "scoped-definition-dest",
      scopedDefinitionSchema,
      tx,
    );

    dest.set({ nickname: "Alice" });

    const stored = tx.readValueOrThrow(
      dest.key("nickname").getAsNormalizedFullLink(),
    );
    expect(isSigilLink(stored)).toBe(true);
    expect(parseLink(stored as any, dest.getAsNormalizedFullLink())?.scope)
      .toBe("user");
  });
});

describe("schemaIfcOverlapsPath", () => {
  // The predicate decides whether a schema-policy write input might cover a
  // written path. An `ifc` label in a tuple slot overlaps at the slot's
  // concrete index.

  const tupleSchema = {
    type: "object",
    properties: {
      pair: {
        type: "array",
        prefixItems: [
          { type: "string", ifc: { confidentiality: ["x"] } },
          { type: "number" },
        ],
      },
    },
  } as const satisfies JSONSchema;

  it("overlaps a write into a labeled tuple slot", () => {
    expect(schemaIfcOverlapsPath(tupleSchema, [], ["pair", "0"])).toBe(true);
  });

  it("does not overlap the unlabeled slot", () => {
    expect(schemaIfcOverlapsPath(tupleSchema, [], ["pair", "1"])).toBe(false);
  });

  it("still overlaps items-covered elements via the wildcard", () => {
    const restSchema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "string", ifc: { confidentiality: ["x"] } },
        },
      },
    } as const satisfies JSONSchema;
    expect(schemaIfcOverlapsPath(restSchema, [], ["list", "3"])).toBe(true);
  });

  it("sees labels inside combinator branches (shared-walk descent)", () => {
    // Combinator branches descend at the same path, so an `ifc` label under an
    // `anyOf` branch overlaps a write to the field.
    const branchSchema = {
      type: "object",
      properties: {
        field: {
          anyOf: [
            { type: "string", ifc: { confidentiality: ["x"] } },
            { type: "number" },
          ],
        },
      },
    } as const satisfies JSONSchema;
    expect(schemaIfcOverlapsPath(branchSchema, [], ["field"])).toBe(true);
  });
});

describe("writeAuthorizationCoversPath", () => {
  // The predicate decides whether a write authorization arriving with a
  // transaction protects the location a link is written to, so the link is
  // held to the same source check it meets once the claim is stored.
  const writeAuthorizedBy = ["writer"];

  it("covers an element of a protected list", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object" },
          ifc: { writeAuthorizedBy },
        },
      },
    } as const satisfies JSONSchema;
    expect(writeAuthorizationCoversPath(schema, [], ["items", "0"])).toBe(
      true,
    );
  });

  it("does not cover a sibling of the protected field", () => {
    const schema = {
      type: "object",
      properties: {
        items: { type: "array", ifc: { writeAuthorizedBy } },
        notes: { type: "array" },
      },
    } as const satisfies JSONSchema;
    expect(writeAuthorizationCoversPath(schema, [], ["notes", "0"])).toBe(
      false,
    );
  });

  it("covers through allOf, which every value is held to", () => {
    const schema = {
      type: "array",
      allOf: [{ ifc: { writeAuthorizedBy } }],
    } as const satisfies JSONSchema;
    expect(writeAuthorizationCoversPath(schema, [], ["0"])).toBe(true);
  });

  it("does not cover through an anyOf branch, which holds only some values", () => {
    const schema = {
      type: "array",
      items: {
        anyOf: [
          { type: "object", ifc: { writeAuthorizedBy } },
          { type: "string" },
        ],
      },
    } as const satisfies JSONSchema;
    expect(writeAuthorizationCoversPath(schema, [], ["0"])).toBe(false);
  });

  it("covers a list whose claim is reached through a reference", () => {
    const schema = {
      type: "object",
      properties: { items: { $ref: "#/$defs/Protected" } },
      $defs: {
        Protected: {
          type: "array",
          items: { type: "object" },
          ifc: { writeAuthorizedBy },
        },
      },
    } as const satisfies JSONSchema;
    expect(writeAuthorizationCoversPath(schema, [], ["items", "0"])).toBe(
      true,
    );
  });

  it("does not hold a named property to the additionalProperties claim", () => {
    const schema = {
      type: "object",
      properties: { open: { type: "array" } },
      additionalProperties: { type: "array", ifc: { writeAuthorizedBy } },
    } as const satisfies JSONSchema;
    expect(writeAuthorizationCoversPath(schema, [], ["open", "0"])).toBe(
      false,
    );
  });

  it("covers a key only the additionalProperties schema describes", () => {
    const schema = {
      type: "object",
      additionalProperties: { type: "array", ifc: { writeAuthorizedBy } },
    } as const satisfies JSONSchema;
    expect(writeAuthorizationCoversPath(schema, [], ["any", "0"])).toBe(true);
  });

  it("covers a claim whose schema document arrives after a first ask", () => {
    const decomposed = decomposeSchema({
      type: "object",
      properties: { lateItems: { $ref: "#/$defs/LateProtected" } },
      $defs: {
        LateProtected: {
          type: "array",
          items: { type: "object" },
          ifc: { writeAuthorizedBy },
        },
      },
    });
    const schema = internSchema({ $ref: decomposed.rootRef });

    // The first ask resolves nothing, so it must not be remembered.
    expect(writeAuthorizationCoversPath(schema, [], ["lateItems", "0"])).toBe(
      false,
    );
    for (const [hash, document] of decomposed.documents) {
      registerSchemaDocument(hash, document);
    }
    expect(writeAuthorizationCoversPath(schema, [], ["lateItems", "0"])).toBe(
      true,
    );
  });

  it("ignores claims that are not write authorizations", () => {
    const schema = {
      type: "object",
      properties: {
        title: {
          type: "string",
          ifc: { uiContract: { helper: "UiAction", action: "Save" } },
        },
      },
    } as const satisfies JSONSchema;
    expect(writeAuthorizationCoversPath(schema, [], ["title"])).toBe(false);
  });
});
