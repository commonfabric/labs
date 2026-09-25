import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  linkProbeSubPath,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type JSONSchema } from "../src/builder/types.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import { resolveLink } from "../src/link-resolution.ts";
import {
  areNormalizedLinksSame,
  isSigilLink,
  parseLink,
  toMemorySpaceAddress,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type IExtendedStorageTransaction,
  type IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import { isLinkResolutionProbe } from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("link-resolution other"))
  .did();

describe("link-resolution", () => {
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

  describe("followWriteRedirects", () => {
    it("records dereference traces for followed value links but not raw final-slot reads", async () => {
      const sourceCell = runtime.getCell<string>(
        space,
        "dereference-trace-source",
        undefined,
        tx,
      );
      sourceCell.set("linked content");
      const targetCell = runtime.getCell<string>(
        space,
        "dereference-trace-target",
        undefined,
        tx,
      );
      targetCell.set(sourceCell);
      await tx.commit();
      tx = runtime.edit();

      const readTx = runtime.edit();
      const linked = runtime.getCell<string>(
        space,
        "dereference-trace-target",
        undefined,
        readTx,
      );
      expect(linked.get()).toBe("linked content");
      expect(readTx.getCfcState().dereferenceTraces).toContainEqual({
        source: expect.objectContaining({
          id: targetCell.getAsNormalizedFullLink().id,
          path: [],
        }),
        target: expect.objectContaining({
          id: sourceCell.getAsNormalizedFullLink().id,
          path: [],
        }),
        kind: "value",
      });
      readTx.abort();

      const rawTx = runtime.edit();
      const rawLinked = runtime.getCell<string>(
        space,
        "dereference-trace-target",
        undefined,
        rawTx,
      );
      // The stored link elides what it shares with the slot it sits in, so
      // the expected form has to be taken relative to that same base.
      expect(rawLinked.getRawUntyped()).toEqual(
        sourceCell.getAsLink({ base: rawLinked }),
      );
      expect(rawTx.getCfcState().dereferenceTraces).toEqual([]);
      rawTx.abort();
    });

    it("should follow a simple write redirect", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "should follow a simple alias 1",
        undefined,
        tx,
      );
      testCell.set({ value: 42 });
      const result = resolveLink(
        runtime,
        tx,
        {
          ...testCell.getAsNormalizedFullLink(),
          path: ["value"],
          overwrite: "redirect",
        },
        "writeRedirect",
      );
      expect(tx.readValueOrThrow(result)).toBe(42);
    });

    it("should follow nested write redirects", () => {
      const innerCell = runtime.getCell<{ inner: number }>(
        space,
        "should follow nested aliases 1",
        undefined,
        tx,
      );
      innerCell.set({ inner: 10 });
      const outerCell = runtime.getCell<{ outer: any }>(
        space,
        "should follow nested aliases 2",
        undefined,
        tx,
      );
      outerCell.setRaw({
        outer: innerCell.key("inner").getAsWriteRedirectLink(),
      });
      const result = resolveLink(
        runtime,
        tx,
        {
          ...outerCell.getAsNormalizedFullLink(),
          path: ["outer"],
          overwrite: "redirect",
        },
        "writeRedirect",
      );
      expect(
        areNormalizedLinksSame(
          result,
          innerCell.key("inner").getAsNormalizedFullLink(),
        ),
      ).toBe(
        true,
      );
      expect(tx.readValueOrThrow(result)).toBe(10);
    });

    it("should allow write redirects in redirected paths", () => {
      const testCell = runtime.getCell<any>(
        space,
        "should allow aliases in aliased paths 1",
        undefined,
        tx,
      );
      // Redirects stored in data must be sigil links; a `$alias` record in
      // data is plain data and is no longer followed.
      testCell.setRaw({
        a: {
          a: testCell.key("a").key("b").getAsWriteRedirectLink(),
          b: { c: 1 },
        },
      });
      const result = resolveLink(
        runtime,
        tx,
        {
          ...testCell.getAsNormalizedFullLink(),
          path: ["a", "a", "c"],
          overwrite: "redirect",
        },
        "writeRedirect",
      );
      expect(
        areNormalizedLinksSame(
          result,
          testCell.key("a").key("b").key("c").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(tx.readValueOrThrow(result)).toBe(1);
    });

    it("does not follow $alias-shaped records stored in data", () => {
      const testCell = runtime.getCell<any>(
        space,
        "does not follow $alias records in data 1",
        undefined,
        tx,
      );
      testCell.setRaw({
        alias: { $alias: { path: ["value"] } },
        value: 42,
      });
      const location = testCell.key("alias").getAsNormalizedFullLink();

      // Resolving a link to the location holding the `$alias` record returns
      // the location itself: the record is plain data, not a redirect.
      const redirectResolved = resolveLink(
        runtime,
        tx,
        location,
        "writeRedirect",
      );
      expect(areNormalizedLinksSame(redirectResolved, location)).toBe(true);

      const valueResolved = resolveLink(runtime, tx, location);
      expect(areNormalizedLinksSame(valueResolved, location)).toBe(true);

      // The value at the location is the record itself, verbatim.
      expect(tx.readValueOrThrow(valueResolved)).toEqual({
        $alias: { path: ["value"] },
      });
    });
  });

  describe("Schema handling in links", () => {
    it("should preserve schema when resolving links", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      } as const;

      const targetCell = runtime.getCell<{ name: string; age: number }>(
        space,
        "schema-target-cell",
        schema,
        tx,
      );
      targetCell.set({ name: "John", age: 30 });

      const sourceCell = runtime.getCell<any>(
        space,
        "schema-source-cell",
        undefined,
        tx,
      );

      // Create a link with schema included
      sourceCell.setRaw({
        link: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // When resolving a link to a cell that has a schema,
      // the resolved link should point to the target cell with its schema
      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);
      expect(resolvedSchema(resolved.schema)).toEqual(schema);
    });

    it("should adjust schema for nested paths", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      } as const satisfies JSONSchema;

      const targetCell = runtime.getCell<any>(
        space,
        "nested-schema-target",
        schema,
        tx,
      );
      targetCell.set({ user: { name: "Jane", email: "jane@example.com" } });

      const sourceCell = runtime.getCell<any>(
        space,
        "nested-schema-source",
        undefined,
        tx,
      );
      // Create a link pointing to targetCell/user with schema included
      sourceCell.setRaw({
        link: targetCell.key("user").getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // The resolved link should have the adjusted schema for the user object
      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);
      expect(resolvedSchema(resolved.schema)).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
      });
    });

    it("should preserve schema through write redirects", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const targetCell = runtime.getCell<{ value: number }>(
        space,
        "redirect-schema-target",
        schema,
        tx,
      );
      targetCell.set({ value: 42 });

      const sourceCell = runtime.getCell<any>(
        space,
        "redirect-schema-source",
        undefined,
        tx,
      );
      sourceCell.setRaw({
        alias: targetCell.getAsWriteRedirectLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // Resolve with writeRedirect mode
      const linkValue = sourceCell.key("alias").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink, "writeRedirect");
      expect(resolved.schema).toEqual(schema);
    });

    it("should handle undefined schemas gracefully", () => {
      // Cell without schema
      const targetCell = runtime.getCell<any>(
        space,
        "no-schema-target",
        undefined,
        tx,
      );
      targetCell.set({ data: "test" });

      const sourceCell = runtime.getCell<any>(
        space,
        "no-schema-source",
        undefined,
        tx,
      );
      sourceCell.set({ link: targetCell });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);
      expect(resolved.schema).toBeUndefined();
    });

    it("should preserve schema when available", () => {
      // Use a simple schema without $ref
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      } as const;

      const targetCell = runtime.getCell<any>(
        space,
        "rootschema-target",
        schema,
        tx,
      );
      targetCell.set({ name: "Test User" });

      // Create a link with setRaw to preserve schema
      const sourceCell = runtime.getCell<any>(
        space,
        "rootschema-source",
        undefined,
        tx,
      );
      const linkData = targetCell.getAsLink();
      // Manually set schema on the link
      if (isSigilLink(linkData)) {
        linkRefPayload(linkData).schema = schema;
      }
      sourceCell.setRaw({ link: linkData });
      tx.commit();
      tx = runtime.edit();

      const link = parseLink(sourceCell.get().link, sourceCell)!;
      const resolved = resolveLink(runtime, tx, link);
      expect(resolved.schema).toEqual(schema);
    });

    it("should handle schema through multiple link hops", () => {
      const schema1 = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
      };

      const schema2 = {
        type: "object",
        properties: {
          data: schema1,
        },
      };

      const cell1 = runtime.getCell<any>(
        space,
        "multi-hop-1",
        schema1,
        tx,
      );
      cell1.set({ nested: { value: "test" } });

      const cell2 = runtime.getCell<any>(
        space,
        "multi-hop-2",
        schema2,
        tx,
      );
      // Link to cell1's nested object with schema
      cell2.setRaw({
        data: cell1.key("nested").getAsLink({ includeSchema: true }),
      });

      const cell3 = runtime.getCell<any>(
        space,
        "multi-hop-3",
        undefined,
        tx,
      );
      // Link to cell2
      cell3.set({ ref: cell2 });
      tx.commit();
      tx = runtime.edit();

      // Following through cell3 -> cell2 -> cell1.nested
      // We need to resolve step by step since getAsNormalizedFullLink doesn't preserve schema
      const linkValue = cell2.key("data").get();
      const parsedLink = parseLink(linkValue, cell2)!;
      const resolved = resolveLink(runtime, tx, parsedLink);

      // Should have the schema of cell1.nested
      expect(resolvedSchema(resolved.schema)).toEqual({
        type: "object",
        properties: {
          value: { type: "string" },
        },
      });
    });

    it("should handle schema with array paths", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
              },
            },
          },
        },
      };

      const targetCell = runtime.getCell<any>(
        space,
        "array-schema-target",
        schema,
        tx,
      );
      targetCell.set({
        items: [
          { id: 1, name: "Item 1" },
          { id: 2, name: "Item 2" },
        ],
      });

      const sourceCell = runtime.getCell<any>(
        space,
        "array-schema-source",
        undefined,
        tx,
      );
      // Link to a specific array element with schema
      sourceCell.setRaw({
        link: targetCell.key("items").key(0).getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);

      // Should have the schema of an array item
      expect(resolvedSchema(resolved.schema)).toEqual({
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
        },
      });
    });

    it("should preserve schema when link has no schema but destination does", () => {
      const destinationSchema = {
        type: "object",
        properties: {
          status: { type: "string" },
        },
      } as const;

      const destCell = runtime.getCell<any>(
        space,
        "preserve-dest-schema",
        destinationSchema,
        tx,
      );
      destCell.set({ status: "active" });

      // Create another cell that links to destCell with schema
      const linkCell = runtime.getCell<any>(
        space,
        "link-without-schema",
        undefined,
        tx,
      );
      linkCell.setRaw(destCell.getAsLink({ includeSchema: true }));

      // Source cell links to linkCell
      const sourceCell = runtime.getCell<any>(
        space,
        "source-preserve-schema",
        undefined,
        tx,
      );
      sourceCell.set({ ref: linkCell });
      tx.commit();
      tx = runtime.edit();

      // Following the chain should preserve the destination schema
      const linkValue = sourceCell.key("ref").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);
      expect(resolvedSchema(resolved.schema)).toEqual(destinationSchema);
    });

    it("should treat empty schema objects as permissive links", () => {
      const emptySchema = {} as const;

      const targetCell = runtime.getCell<any>(
        space,
        "empty-schema-target",
        emptySchema,
        tx,
      );
      targetCell.set({ any: "value" });

      const sourceCell = runtime.getCell<any>(
        space,
        "empty-schema-source",
        undefined,
        tx,
      );
      sourceCell.setRaw({
        link: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);

      // Empty schema is equivalent to JSON Schema `true`; it should not make a
      // link schema-bearing.
      expect(resolved.schema).toBeUndefined();
    });

    it("should handle complex nested schemas with multiple levels", () => {
      const complexSchema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        deep: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      } as const;

      const targetCell = runtime.getCell<any>(
        space,
        "complex-nested-schema",
        complexSchema,
        tx,
      );
      targetCell.set({
        level1: {
          level2: {
            level3: [{ deep: "value1" }, { deep: "value2" }],
          },
        },
      });

      const sourceCell = runtime.getCell<any>(
        space,
        "complex-nested-source",
        undefined,
        tx,
      );

      // Link to a deeply nested path
      sourceCell.setRaw({
        link: targetCell.key("level1").key("level2").key("level3").key(0)
          .getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);

      // Should have the schema of the array item
      expect(resolvedSchema(resolved.schema)).toEqual({
        type: "object",
        properties: {
          deep: { type: "string" },
        },
      });
    });

    it("should handle schemas with additionalProperties", () => {
      const schemaWithAdditional = {
        type: "object",
        properties: {
          known: { type: "string" },
        },
        additionalProperties: { type: "number" },
      } as const;

      const targetCell = runtime.getCell<any>(
        space,
        "additional-props-target",
        schemaWithAdditional,
        tx,
      );
      targetCell.set({ known: "value", extra1: 42, extra2: 100 });

      const sourceCell = runtime.getCell<any>(
        space,
        "additional-props-source",
        undefined,
        tx,
      );
      sourceCell.setRaw({
        link: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);

      expect(resolvedSchema(resolved.schema)).toEqual(schemaWithAdditional);
    });

    it("should handle schemas with both top-level and nested links", () => {
      // Test case where a document has both regular properties and links
      const schema1 = {
        type: "object",
        properties: {
          name: { type: "string" },
          ref: { type: "object" }, // Will be a link
        },
      } as const;

      const schema2 = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const;

      const targetCell = runtime.getCell<any>(
        space,
        "mixed-schema-target",
        schema2,
        tx,
      );
      targetCell.set({ value: 42 });

      const sourceCell = runtime.getCell<any>(
        space,
        "mixed-schema-source",
        schema1,
        tx,
      );
      sourceCell.setRaw({
        name: "test",
        ref: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // Resolving the ref should give us the target schema
      const linkValue = sourceCell.key("ref").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(runtime, tx, parsedLink);
      expect(resolvedSchema(resolved.schema)).toEqual(schema2);
    });

    it("should remove schema when remaining path field is not in schema", () => {
      // This tests the corner case where:
      // 1. An intermediate link has a schema
      // 2. There's a remaining path to follow after the link
      // 3. The field in the remaining path is NOT defined in the schema
      // In this case, schema should become undefined (removed) rather than
      // keeping the parent schema
      //
      // We use an array schema and access .length - the array schema defines
      // items but not a "length" property, so getSchemaAtPath returns undefined.
      const schema = {
        type: "array",
        items: { type: "number" },
      } as const satisfies JSONSchema;

      const targetCell = runtime.getCell<any>(
        space,
        "undefined-schema-field-target",
        schema,
        tx,
      );
      targetCell.set([1, 2, 3]);

      const sourceCell = runtime.getCell<any>(
        space,
        "undefined-schema-field-source",
        undefined,
        tx,
      );

      // Create a link at "data" pointing to targetCell with schema included
      sourceCell.setRaw({
        data: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // First verify the link to targetCell has the schema
      const dataLink = parseLink(sourceCell.key("data"), sourceCell)!;
      const dataResolved = resolveLink(runtime, tx, dataLink);
      expect(resolvedSchema(dataResolved.schema)).toEqual(schema);

      // Now resolve a path that goes through the link to "length".
      // The resolver will:
      // 1. Try to resolve sourceCell/data/length
      // 2. Find that "length" doesn't exist (NotFoundError)
      // 3. Find the link at "data" (lastValid = ["data"])
      // 4. Calculate remainingPath = ["length"]
      // 5. Call getSchemaAtPath(schema, ["length"]) which returns undefined
      //    because array schema has no "length" property defined
      // 6. The fix ensures we DON'T spread the original schema back in
      const linkThroughToLength = {
        ...sourceCell.getAsNormalizedFullLink(),
        path: ["data", "length"],
        schema: undefined, // Start without schema to test inheritance
      };
      const resolved = resolveLink(runtime, tx, linkThroughToLength);

      // The resolved link should NOT have a schema since "length" is not
      // defined in the array schema
      expect(resolved.schema).toBeUndefined();
      // Verify we can still read the value
      expect(tx.readValueOrThrow(resolved)).toBe(3);
    });
  });

  describe("overwrite field removal", () => {
    it("should remove overwrite field from resolved links", () => {
      const sourceCell = runtime.getCell<{ value: number }>(
        space,
        "source-cell",
        undefined,
        tx,
      );
      sourceCell.set({ value: 42 });

      const targetCell = runtime.getCell<{ alias: any }>(
        space,
        "target-cell",
        undefined,
        tx,
      );

      // Create a write redirect link (which includes overwrite field)
      targetCell.setRaw({
        alias: sourceCell.key("value").getAsWriteRedirectLink(),
      });

      const link = parseLink(targetCell.key("alias"));
      const resolved = resolveLink(runtime, tx, link!, "writeRedirect");

      // Verify the resolved link doesn't have an overwrite field
      expect("overwrite" in resolved).toBe(false);
      expect(resolved.id).toBe(sourceCell.getAsNormalizedFullLink().id);
      expect(resolved.path).toEqual(["value"]);
    });

    it("should preserve other link properties while removing overwrite", () => {
      const cell = runtime.getCell<{ data: { nested: string } }>(
        space,
        "test-cell",
        undefined,
        tx,
      );
      cell.set({ data: { nested: "test" } });

      const aliasCell = runtime.getCell<{ ref: any }>(
        space,
        "alias-cell",
        undefined,
        tx,
      );

      // Create write redirect link
      aliasCell.setRaw({
        ref: cell.key("data").key("nested").getAsWriteRedirectLink(),
      });

      const link = parseLink(aliasCell.key("ref"));
      const resolved = resolveLink(runtime, tx, link!, "writeRedirect");

      // Check that all other properties are preserved
      expect(resolved.space).toBe(space);
      expect(resolved.id).toBe(cell.getAsNormalizedFullLink().id);
      expect(resolved.path).toEqual(["data", "nested"]);
      expect("overwrite" in resolved).toBe(false);
    });

    it("should remove overwrite field when following multiple write redirects", () => {
      const cellA = runtime.getCell<{ value: string }>(
        space,
        "cell-a",
        undefined,
        tx,
      );
      cellA.set({ value: "original" });

      const cellB = runtime.getCell<{ redirect: any }>(
        space,
        "cell-b",
        undefined,
        tx,
      );
      cellB.setRaw({
        redirect: cellA.key("value").getAsWriteRedirectLink(),
      });

      const cellC = runtime.getCell<{ alias: any }>(
        space,
        "cell-c",
        undefined,
        tx,
      );
      cellC.setRaw({
        alias: cellB.key("redirect").getAsWriteRedirectLink(),
      });

      const link = parseLink(cellC.key("alias"));
      const resolved = resolveLink(runtime, tx, link!, "writeRedirect");

      // Should resolve to the final destination without overwrite field
      expect("overwrite" in resolved).toBe(false);
      expect(resolved.id).toBe(cellA.getAsNormalizedFullLink().id);
      expect(resolved.path).toEqual(["value"]);
    });
  });

  describe("Cycle detection with circular references", () => {
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

    it("handles circular references correctly without overtriggering cycle detection", () => {
      // This test verifies that the cycle detection does NOT overtrigger.
      // The scenario described in the bug report works correctly:
      // - Two cells reference each other in a cycle
      // - We can still access properties through the cycle without errors
      // Create cellA with a reference to cellB and a non-cyclic property
      const schema = {
        $ref: "#/$defs/Root",
        $defs: {
          Root: {
            type: "object",
            properties: {
              foo: { $ref: "#/$defs/Root" },
              bar: { type: "string" },
            },
          },
        },
      } as const satisfies JSONSchema;
      const cellA = runtime.getCell(
        space,
        "cycle-detection-bug-cellA",
        schema,
        tx,
      );

      // Create cellB with a reference to cellA
      const cellB = runtime.getCell<any>(
        space,
        "cycle-detection-bug-cellB",
        undefined,
        tx,
      );

      // Set up the circular reference structure as described:
      // cellA.set({ foo: cellB, bar: "baz" })
      // cellB.set(cellA)
      cellA.set({ foo: cellB, bar: "baz" });
      cellB.set(cellA);

      // Test 1: A.get() should work
      const result = cellA.get();
      expect(result.bar).toBe("baz");
      // When we get(), cells are automatically dereferenced, so result.foo
      // is the actual value (not a cell)
      expect(result.foo?.bar).toBe("baz");
      expect(result.foo?.foo).toBeDefined();
      expect(result.foo?.foo?.foo).toEqual(result.foo?.foo);

      // Test 2: A.key("foo").get() should work and return the value of cellB (which is cellA)
      const fooResult = cellA.key("foo").get();
      expect(fooResult?.bar).toBe("baz");

      // Test 3: A.key("foo").key("bar").get() should work and return "baz"
      // This is where the overtrigger might happen - accessing bar through the cycle
      let barResult: string;
      try {
        barResult = cellA.key("foo").key("bar").get() as any;
        expect(barResult).toBe("baz");
      } catch (e) {
        // If this throws, we've hit the overtrigger bug
        console.error(
          "Overtrigger bug detected at A.key('foo').key('bar').get():",
          e,
        );
        throw e;
      }

      // Test 4: A.key("foo").key("foo").key("foo").get() should work
      // Multiple levels of following the references
      let deepResult: any;
      try {
        deepResult = cellA.key("foo").key("foo").key("foo").get();
        expect(deepResult.bar).toBe("baz");
      } catch (e) {
        // If this throws, we've hit the overtrigger bug
        console.error(
          "Overtrigger bug detected at A.key('foo').key('foo').key('foo').get():",
          e,
        );
        throw e;
      }
    });

    it("handles complex circular reference scenarios", () => {
      // More complex scenario with multiple cells and properties
      const cellA = runtime.getCell<{ b: any; c: any; value: string }>(
        space,
        "complex-cycle-cellA",
        undefined,
        tx,
      );

      const cellB = runtime.getCell<{ a: any; c: any; value: string }>(
        space,
        "complex-cycle-cellB",
        undefined,
        tx,
      );

      const cellC = runtime.getCell<{ a: any; b: any; value: string }>(
        space,
        "complex-cycle-cellC",
        undefined,
        tx,
      );

      // Create a triangle of references
      cellA.set({ b: cellB, c: cellC, value: "A" });
      cellB.set({ a: cellA, c: cellC, value: "B" });
      cellC.set({ a: cellA, b: cellB, value: "C" });

      // Test accessing values through different paths
      // A -> B -> C -> value
      expect(cellA.key("b").key("c").key("value").get()).toBe("C");

      // A -> C -> B -> A -> value
      expect(cellA.key("c").key("b").key("a").key("value").get()).toBe("A");

      // Multiple hops through the same cycle
      expect(cellA.key("b").key("a").key("b").key("a").key("value").get()).toBe(
        "A",
      );
    });

    it("handles deeply nested circular references with aliases", () => {
      // Test with a mix of direct cell references and aliases
      const cellA = runtime.getCell<any>(
        space,
        "deep-cycle-cellA",
        undefined,
        tx,
      );

      const cellB = runtime.getCell<any>(
        space,
        "deep-cycle-cellB",
        undefined,
        tx,
      );

      // Create a structure where cells reference each other at different depths
      cellA.set({
        direct: cellB,
        nested: {
          ref: cellB,
          data: "nested-a",
        },
        value: "a",
      });

      cellB.set({
        back: cellA,
        deep: {
          path: {
            to: {
              a: cellA,
            },
          },
        },
        value: "b",
      });

      // Test navigation through various paths
      expect(cellA.key("direct").key("back").key("value").get()).toBe("a");
      expect(
        cellA.key("nested").key("ref").key("deep").key("path").key("to").key(
          "a",
        )
          .key("value").get(),
      ).toBe("a");

      // This path should work even though it visits the same cells multiple times
      expect(
        cellA.key("direct").key("back").key("direct").key("back").key("nested")
          .key("data").get(),
      ).toBe("nested-a");
    });

    it("handles circular references with array elements", () => {
      // This test demonstrates the cycle detection overtrigger bug
      // The bug occurs when navigating through circular references multiple times
      // even when accessing different properties
      const cellA = runtime.getCell<{ items: any[]; name: string }>(
        space,
        "array-cycle-cellA",
        undefined,
        tx,
      );

      const cellB = runtime.getCell<{ parent: any; name: string }>(
        space,
        "array-cycle-cellB",
        undefined,
        tx,
      );

      const cellC = runtime.getCell<{ root: any; name: string }>(
        space,
        "array-cycle-cellC",
        undefined,
        tx,
      );

      // Create circular references through array
      cellA.set({ items: [cellB, cellC], name: "A" });
      cellB.set({ parent: cellA, name: "B" });
      cellC.set({ root: cellA, name: "C" });

      // Navigate through array indices and back
      expect(cellA.key("items").key(0).key("parent").key("name").get()).toBe(
        "A",
      );

      expect(
        cellA.key("items").key(1).key("root").key("items").key(0).key("name")
          .get(),
      ).toBe("B");

      // Complex path through multiple array elements
      // This is where the bug triggers: A → items[0] (B) → parent (A) → items[1] (C) → root (A) → name
      // The cycle detector sees we're visiting A multiple times and throws an error,
      // even though we're legitimately navigating through the structure to access "name"
      expect(
        cellA.key("items").key(0).key("parent").key("items").key(1).key("root")
          .key("name").get(),
      ).toBe("A");
    });

    it("properly detects true circular references", () => {
      // Test cases where circular references SHOULD be detected
      // When a cycle is detected, the system logs a warning and returns an empty document

      // Case 1: Direct circular reference A -> A
      const cellA = runtime.getCell<any>(
        space,
        "direct-cycle-A",
        undefined,
        tx,
      );
      // Using setRaw to circumvent cycle detection on write
      // This allows us to create the cycle for testing purposes
      cellA.setRaw(cellA.getAsLink());

      // When we resolve a circular reference, it should return undefined
      // (the empty document resolves to undefined)
      expect(() => cellA.get()).toThrow();

      // Case 2: Mutual references A -> B -> A
      const cellB = runtime.getCell<any>(
        space,
        "direct-cycle-B",
        undefined,
        tx,
      );

      // Using setRaw to circumvent cycle detection on write
      const linkToA = cellA.getAsLink();
      const linkToB = cellB.getAsLink();

      cellA.setRaw(linkToB);
      cellB.setRaw(linkToA);

      // Both should resolve to undefined
      expect(() => cellA.get()).toThrow();
      expect(() => cellB.get()).toThrow();
    });

    it("detects cycle when resolving link to its own subpath", () => {
      // Test case: A -> A/foo creates an infinite growing path. The
      // self-subpath shape is detected on the first hop.
      const cellA = runtime.getCell<any>(
        space,
        "self-subpath-cycle",
        undefined,
        tx,
      );

      // Create a link from A to A/foo
      cellA.setRaw(cellA.key("foo").getAsLink());

      expect(() => resolveLink(runtime, tx, cellA.getAsNormalizedFullLink()))
        .toThrow("Link cycle detected");
    });

    it("detects cycle for a self-subpath link below the document root", () => {
      // Test case: A/a -> A/a/b
      const cellA = runtime.getCell<any>(
        space,
        "nested-self-subpath-cycle",
        undefined,
        tx,
      );

      cellA.setRaw({ a: cellA.key("a").key("b").getAsLink() });

      expect(() =>
        resolveLink(runtime, tx, cellA.key("a").getAsNormalizedFullLink())
      )
        .toThrow("Link cycle detected");
    });

    it("reads of a self-subpath link fail deterministically", () => {
      // The Cell Inspector wedge shape: every read fails immediately with a
      // cycle error rather than burning the resolution iteration budget.
      const cellA = runtime.getCell<any>(
        space,
        "wedge-read-cycle",
        undefined,
        tx,
      );

      cellA.setRaw(cellA.key("x").getAsLink());

      expect(() => cellA.get()).toThrow("Link cycle detected");
    });

    it("follows same-document links to sibling paths", () => {
      // A link within a document targeting a non-overlapping path resolves.
      const cellA = runtime.getCell<any>(
        space,
        "same-doc-sibling-link",
        undefined,
        tx,
      );

      cellA.setRaw({ x: cellA.key("y").getAsLink(), y: 5 });

      expect(cellA.key("x").get()).toBe(5);
    });

    it("resolves same-document links to an ancestor path", () => {
      // A link at a deeper path targeting its own ancestor is not the
      // self-subpath shape (the target does not pass through the link's
      // position); resolution terminates at the ancestor.
      const cellA = runtime.getCell<any>(
        space,
        "same-doc-ancestor-link",
        undefined,
        tx,
      );

      cellA.setRaw({ a: { b: cellA.key("a").getAsLink() } });

      const resolved = resolveLink(
        runtime,
        tx,
        cellA.key("a").key("b").getAsNormalizedFullLink(),
      );
      expect(resolved.id).toBe(cellA.getAsNormalizedFullLink().id);
      expect(resolved.path).toEqual(["a"]);
    });

    it("bounds cross-document growing-path cycles by the iteration limit", () => {
      // Test case: A -> B, B -> A/foo. The path grows through two documents,
      // so the first-hop self-subpath check does not apply; the iteration
      // limit still backstops it.
      const cellA = runtime.getCell<any>(
        space,
        "cross-doc-growing-A",
        undefined,
        tx,
      );
      const cellB = runtime.getCell<any>(
        space,
        "cross-doc-growing-B",
        undefined,
        tx,
      );

      cellA.setRaw(cellB.getAsLink());
      cellB.setRaw(cellA.key("foo").getAsLink());

      expect(() => resolveLink(runtime, tx, cellA.getAsNormalizedFullLink()))
        .toThrow("Link resolution iteration limit reached");
    });

    it("detects cycles in nested paths", () => {
      // Test case: A/x -> B/y -> A/x (cycle at a specific path)
      const cellA = runtime.getCell<any>(
        space,
        "nested-cycle-A",
        undefined,
        tx,
      );
      const cellB = runtime.getCell<any>(
        space,
        "nested-cycle-B",
        undefined,
        tx,
      );

      // Create the cycle using setRaw to circumvent cycle detection on write
      const linkToAx = cellA.key("x").getAsLink();
      const linkToBy = cellB.key("y").getAsLink();

      cellA.setRaw({ x: linkToBy });
      cellB.setRaw({ y: linkToAx });

      expect(() => cellA.key("x").get()).toThrow();
    });

    it("shows data URI when resolving cyclic links", () => {
      // To see the data: URI, we need to use the lower-level resolveLink function
      const cellA = runtime.getCell<any>(
        space,
        "data-uri-cycle-A",
        undefined,
        tx,
      );

      // Create a self-referencing cycle using setRaw to circumvent cycle
      // detection on write
      cellA.setRaw(cellA.getAsLink());

      // When we resolve this link at a low level, it should return the empty document
      // with a data: URI indicating the cycle was detected
      expect(() =>
        resolveLink(
          runtime,
          tx,
          cellA.getAsNormalizedFullLink(),
          "value",
        )
      ).toThrow();
    });

    it("allows non-cyclic references to the same cell", () => {
      // This should NOT trigger cycle detection - accessing different properties
      const cellA = runtime.getCell<any>(
        space,
        "non-cycle-A",
        undefined,
        tx,
      );
      const cellB = runtime.getCell<any>(
        space,
        "non-cycle-B",
        undefined,
        tx,
      );

      // A has two different references to B at different paths
      cellA.set({
        ref1: cellB,
        ref2: cellB,
        data: "A data",
      });

      cellB.set({
        value: "B value",
        nested: { deep: "deep value" },
      });

      // These should all work without cycle detection
      expect(cellA.key("ref1").key("value").get()).toBe("B value");
      expect(cellA.key("ref2").key("nested").key("deep").get()).toBe(
        "deep value",
      );

      // The resolved links should NOT be data: URIs
      const link1 = cellA.key("ref1").key("value").getAsNormalizedFullLink();
      const link2 = cellA.key("ref2").key("nested").getAsNormalizedFullLink();

      expect(link1.id).not.toMatch(/^data:/);
      expect(link2.id).not.toMatch(/^data:/);
    });
  });

  describe("sigil probe memo", () => {
    // Every case reads through the link stored at `items/0` of a home
    // document and counts what the transaction journaled at that slot: the
    // probe that finds the link, and the read of the stored link behind it.
    // The counts are what separate a memoized probe from a repeated one.

    type Note = { title: string; content: string };

    const seedLinkedNote = async (suffix: string) => {
      const note = runtime.getCell<Note>(
        space,
        `probe-memo-note-${suffix}`,
        undefined,
        tx,
      );
      note.set({ title: "t", content: "c" });
      const home = runtime.getCell<{ items: Note[] }>(
        space,
        `probe-memo-home-${suffix}`,
        undefined,
        tx,
      );
      home.set({ items: [note] });
      await tx.commit();
      tx = runtime.edit();
      return { home, note, base: home.getAsNormalizedFullLink() };
    };

    const journaledAt = (
      address: IMemorySpaceAddress,
      probe: boolean,
    ): number =>
      [...(tx.getReadActivities?.() ?? [])].filter((read) =>
        read.id === address.id &&
        read.path.join("/") === address.path.join("/") &&
        isLinkResolutionProbe(read.meta) === probe
      ).length;

    it("journals the slot's probe and stored link once for reads of two sibling properties", async () => {
      const { base, note } = await seedLinkedNote("siblings");
      const title = resolveLink(runtime, tx, {
        ...base,
        path: ["items", "0", "title"],
      });
      const content = resolveLink(runtime, tx, {
        ...base,
        path: ["items", "0", "content"],
      });
      expect(title.id).toBe(note.getAsNormalizedFullLink().id);
      expect(title.path).toEqual(["title"]);
      expect(content.id).toBe(title.id);
      expect(content.path).toEqual(["content"]);

      const slot = toMemorySpaceAddress({ ...base, path: ["items", "0"] });
      const probe = toMemorySpaceAddress({
        ...base,
        path: ["items", "0", ...linkProbeSubPath()],
      });
      expect(journaledAt(probe, true)).toBe(1);
      expect(journaledAt(slot, false)).toBe(1);
    });

    it("follows a slot on a `value` resolution after a `top` resolution probed it", async () => {
      const { base, note } = await seedLinkedNote("top-then-value");
      const top = resolveLink(runtime, tx, {
        ...base,
        path: ["items", "0"],
      }, "top");
      expect(top.id).toBe(base.id);
      expect(top.path).toEqual(["items", "0"]);

      const value = resolveLink(runtime, tx, { ...base, path: ["items", "0"] });
      expect(value.id).toBe(note.getAsNormalizedFullLink().id);
      expect(value.path).toEqual([]);

      const probe = toMemorySpaceAddress({
        ...base,
        path: ["items", "0", ...linkProbeSubPath()],
      });
      expect(journaledAt(probe, true)).toBe(1);
    });

    it("probes the slot again once the transaction has written", async () => {
      const { base, home, note } = await seedLinkedNote("rewrite");
      const other = runtime.getCell<Note>(
        space,
        "probe-memo-note-other",
        undefined,
        tx,
      );
      other.set({ title: "o", content: "o" });

      const before = resolveLink(runtime, tx, {
        ...base,
        path: ["items", "0", "title"],
      });
      expect(before.id).toBe(note.getAsNormalizedFullLink().id);

      home.withTx(tx).set({ items: [other] });
      const after = resolveLink(runtime, tx, {
        ...base,
        path: ["items", "0", "title"],
      });
      expect(after.id).toBe(other.getAsNormalizedFullLink().id);

      const probe = toMemorySpaceAddress({
        ...base,
        path: ["items", "0", ...linkProbeSubPath()],
      });
      expect(journaledAt(probe, true)).toBe(2);
    });
  });

  describe("cross-space sync kicks", () => {
    // A resolution that crosses into another space kicks a sync of each hop
    // target so the value arrives. A caller resolving a link that another read
    // in the same pass already resolved turns the kick off, so the target is
    // not pulled twice.

    async function crossSpaceValueLink() {
      const targetTx = runtime.edit();
      const target = runtime.getCell<{ value: string }>(
        otherSpace,
        "cross-space kick target",
        undefined,
        targetTx,
      );
      target.set({ value: "ada@example.com" });
      await targetTx.commit();
      const homeTx = runtime.edit();
      const home = runtime.getCell<unknown[]>(
        space,
        "cross-space kick home",
        undefined,
        homeTx,
      );
      home.setRawUntyped([target.getAsLink()]);
      await homeTx.commit();
      return {
        targetId: target.getAsNormalizedFullLink().id,
        valueLink: home.key(0).key("value").getAsNormalizedFullLink(),
      };
    }

    function recordSyncedIds(): string[] {
      const synced: string[] = [];
      const syncCell = runtime.storageManager.syncCell.bind(
        runtime.storageManager,
      );
      runtime.storageManager.syncCell = ((cell, options) => {
        synced.push(cell.getAsNormalizedFullLink().id);
        return syncCell(cell, options);
      }) as typeof runtime.storageManager.syncCell;
      return synced;
    }

    it("kicks a sync of the target in another space by default", async () => {
      const { targetId, valueLink } = await crossSpaceValueLink();
      const synced = recordSyncedIds();

      resolveLink(runtime, runtime.edit(), valueLink);

      expect(synced).toContain(targetId);
    });

    it("kicks no sync of the target when kickCrossSpaceTargets is off, fresh or memoized", async () => {
      const { targetId, valueLink } = await crossSpaceValueLink();
      const synced = recordSyncedIds();
      const readTx = runtime.edit();

      const fresh = resolveLink(runtime, readTx, valueLink, "value", {
        kickCrossSpaceTargets: false,
      });
      const memoized = resolveLink(runtime, readTx, valueLink, "value", {
        kickCrossSpaceTargets: false,
      });

      expect(fresh.id).toBe(targetId);
      expect(memoized.id).toBe(targetId);
      expect(synced).not.toContain(targetId);
    });
  });
});
