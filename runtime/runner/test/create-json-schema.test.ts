import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isInternedSchema } from "@commonfabric/data-model-schema";

import { createJsonSchema } from "../src/builder/create-json-schema.ts";
import { type JSONSchema, type JSONSchemaObj } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("create-json-schema", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("createJsonSchema", () => {
    function testSchemaForType(typeName: string, example: unknown) {
      describe(`basics for type \`${typeName}\``, () => {
        it("should create schema for direct value", () => {
          const schema = createJsonSchema(example);
          expect(schema).toEqual({ type: typeName });
          expect(isInternedSchema(schema)).toBe(true);
        });

        it("should create schema for single-element array", () => {
          const schema = createJsonSchema([example]);
          expect(schema).toEqual({
            type: "array",
            items: { type: typeName },
          });
          expect(isInternedSchema(schema)).toBe(true);
        });

        it("should create schema for single-property object", () => {
          const schema = createJsonSchema({ prop: example });
          expect(schema).toEqual({
            type: "object",
            properties: { prop: { type: typeName } },
          });
          expect(isInternedSchema(schema)).toBe(true);
        });

        it("should set default with addDefaults", () => {
          const schema = createJsonSchema(example, true);
          expect(schema).toEqual({
            type: typeName,
            default: example,
          });
          expect(isInternedSchema(schema)).toBe(true);
        });
      });
    }

    testSchemaForType("string", "test");
    testSchemaForType("integer", 42);
    testSchemaForType("number", 3.14);
    testSchemaForType("boolean", true);
    testSchemaForType("null", null);

    describe("basics for type `undefined`", () => {
      it("should create schema for direct value", () => {
        const schema = createJsonSchema(undefined);
        expect(schema).toEqual({});
        expect(isInternedSchema(schema)).toBe(true);
      });

      it("should create schema for single-element array", () => {
        const schema = createJsonSchema([undefined]);
        expect(schema).toEqual({
          type: "array",
          items: {},
        });
        expect(isInternedSchema(schema)).toBe(true);
      });

      it("should create schema for single-property object", () => {
        // The key is still enumerated, but analyzeType(undefined)
        // produces an empty schema
        const schema = createJsonSchema({ prop: undefined });
        expect(schema).toEqual({
          type: "object",
          properties: { prop: {} },
        });
        expect(isInternedSchema(schema)).toBe(true);
      });

      it("should not set default with addDefaults", () => {
        const schema = createJsonSchema(undefined, true);
        expect(schema).toEqual({});
        expect(schema).not.toHaveProperty("default");
        expect(isInternedSchema(schema)).toBe(true);
      });
    });

    it("should create schema for arrays", () => {
      const arraySchema = createJsonSchema(["a", "b", "c"]);
      expect(arraySchema).toEqual({
        type: "array",
        items: {
          type: "string",
        },
      });
      expect(isInternedSchema(arraySchema)).toBe(true);

      const mixedArraySchema = createJsonSchema([{ name: "item1" }, {
        name: "item2",
        value: 42,
      }]);
      expect(mixedArraySchema).toEqual(
        {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
              },
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: { type: "integer" },
                },
              },
            ],
          },
        } satisfies JSONSchema,
      );
      expect(isInternedSchema(mixedArraySchema)).toBe(true);
    });

    it("should handle single-element array", () => {
      const schema = createJsonSchema([42]);
      expect(schema).toEqual({
        type: "array",
        items: { type: "integer" },
      });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should deduplicate mixed types with repeats in arrays", () => {
      const schema = createJsonSchema(["hello", 1, "world", 2, true]);
      expect(schema).toEqual({
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            { type: "integer" },
            { type: "boolean" },
          ],
        },
      });
    });

    it("should create schema for objects", () => {
      const objectSchema = createJsonSchema({
        string: "text",
        number: 123,
        boolean: true,
        nested: {
          array: [1, 2, 3],
          value: null,
        },
      });

      expect(objectSchema).toEqual({
        type: "object",
        properties: {
          string: { type: "string" },
          number: { type: "integer" },
          boolean: { type: "boolean" },
          nested: {
            type: "object",
            properties: {
              array: {
                type: "array",
                items: {
                  type: "integer",
                },
              },
              value: { type: "null" },
            },
          },
        },
      });
      expect(isInternedSchema(objectSchema)).toBe(true);
    });

    it("should handle empty objects and arrays", () => {
      expect(createJsonSchema({})).toEqual({
        type: "object",
        properties: {},
      });

      expect(createJsonSchema([])).toEqual({
        type: "array",
        items: {},
      });
    });

    it("should handle complex nested structures", () => {
      const complexData = {
        users: [
          { id: 1, name: "Alice", active: true },
          { id: 2, name: "Bob", active: false },
        ],
        settings: {
          theme: "dark",
          notifications: {
            email: true,
            push: false,
          },
        },
      };

      const schema = createJsonSchema(complexData);

      expect(schema).toEqual({
        type: "object",
        properties: {
          users: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                active: { type: "boolean" },
              },
            },
          },
          settings: {
            type: "object",
            properties: {
              theme: { type: "string" },
              notifications: {
                type: "object",
                properties: {
                  email: { type: "boolean" },
                  push: { type: "boolean" },
                },
              },
            },
          },
        },
      });

      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should use cell schema when available", () => {
      const cellWithSchema = runtime.getImmutableCell(
        space,
        "cell@value.com",
        { type: "string", format: "email" },
      );

      const schema = createJsonSchema(cellWithSchema, false, runtime);
      expect(schema).toEqual({ type: "string", format: "email" });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should analyze cell value when no schema is provided", () => {
      const cellWithoutSchema = runtime.getImmutableCell(
        space,
        {
          name: "John",
          age: 30,
          isActive: true,
        },
      );

      const schema = createJsonSchema(cellWithoutSchema, false, runtime);
      expect(schema).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          isActive: { type: "boolean" },
        },
      });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should handle array cell without schema", () => {
      const arrayCell = runtime.getImmutableCell(
        space,
        [1, 2, 3, 4],
      );

      const schema = createJsonSchema(arrayCell, false, runtime);

      expect(schema).toEqual({
        type: "array",
        items: {
          type: "integer",
        },
      });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should handle nested cells with and without schema", () => {
      const userCell = runtime.getImmutableCell(
        space,
        { id: 1, name: "Alice" },
      );

      const prefsSchema = {
        type: "object",
        properties: {
          darkMode: { type: "boolean" },
          fontSize: { type: "integer" },
        },
      } as const satisfies JSONSchema;

      const prefsCell = runtime.getImmutableCell(
        space,
        { darkMode: true, fontSize: 14 },
        prefsSchema,
      );

      const nestedObject = {
        user: userCell,
        preferences: prefsCell,
      };

      const schema = createJsonSchema(nestedObject, false, runtime);
      expect(schema).toEqual({
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
            },
          },
          preferences: {
            type: "object",
            properties: {
              darkMode: { type: "boolean" },
              fontSize: { type: "integer" },
            },
          },
        },
      });
    });

    it("should return cached schema when the same cell link appears twice", () => {
      const cell = runtime.getImmutableCell(
        space,
        { x: 1, y: 2 },
      );

      // The same cell link in two object properties. The second encounter should
      // hit the `seen.has(linkAsStr)` branch and return a deep copy.
      const schema = createJsonSchema(
        { first: cell, second: cell },
        false,
        runtime,
      );

      const expectedCellSchema = {
        type: "object",
        properties: {
          x: { type: "integer" },
          y: { type: "integer" },
        },
      };

      expect(schema).toEqual({
        type: "object",
        properties: {
          first: expectedCellSchema,
          second: expectedCellSchema,
        },
      });
    });

    it("should deduplicate array items that are identical cell links", () => {
      const cell = runtime.getImmutableCell(
        space,
        { name: "Alice" },
      );

      // An array where every element is the same cell link. All elements produce
      // the same schema, so deduplication should yield a single `items` schema.
      const schema = createJsonSchema([cell, cell], false, runtime);

      expect(schema).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should produce anyOf for arrays with different cell links", () => {
      const cellA = runtime.getImmutableCell(
        space,
        { name: "Alice" },
      );
      const cellB = runtime.getImmutableCell(
        space,
        { count: 42 },
      );

      const schema = createJsonSchema([cellA, cellB], false, runtime);

      expect(schema).toEqual({
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: { name: { type: "string" } },
            },
            {
              type: "object",
              properties: { count: { type: "integer" } },
            },
          ],
        },
      });
    });

    it("should deduplicate an array type that is derived from a cell and a non-cell", () => {
      const itemsSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      const expectSchema = {
        type: "array",
        items: itemsSchema,
      };

      const nonCell = { name: "Zamboni" };
      const sansSchema = runtime.getImmutableCell(
        space,
        { name: "Philo" },
      );
      const avecSchema = runtime.getImmutableCell(
        space,
        { name: "Damian" },
        {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      );

      // `createJsonSchema()` accepts cells as well as `FabricValue`s -- which
      // is exactly what these cases exercise -- so this cannot be
      // `FabricValue`.
      const create = (value: unknown) =>
        createJsonSchema(value, false, runtime);

      // Preflight expectations.
      const schema1 = create(nonCell);
      const schema2 = create(sansSchema);
      const schema3 = create(avecSchema);
      expect(schema1).toEqual(itemsSchema);
      expect(schema2).toBe(schema1);
      expect(schema3).toBe(schema1);

      // The main tests.
      const schema4 = create([sansSchema, nonCell]);
      const schema5 = create([avecSchema, nonCell]);
      const schema6 = create([nonCell, sansSchema, avecSchema]);
      expect(schema4).toEqual(expectSchema);
      expect(schema5).toBe(schema4);
      expect(schema6).toBe(schema4);
    });

    it("should analyze object properties that mix plain values and cell links", () => {
      const cell = runtime.getImmutableCell(
        space,
        [10, 20, 30],
      );

      const schema = createJsonSchema(
        { label: "stats", data: cell },
        false,
        runtime,
      );

      expect(schema).toEqual({
        type: "object",
        properties: {
          label: { type: "string" },
          data: {
            type: "array",
            items: { type: "integer" },
          },
        },
      });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should handle multidimensional array of numbers", () => {
      const data = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
      const schema = createJsonSchema(data);
      expect(schema).toEqual({
        type: "array",
        items: {
          type: "array",
          items: {
            type: "integer",
          },
        },
      });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should handle nested array of strings", () => {
      const data = {
        "recipes": [{
          "name": "Pasta Carbonara",
          "ingredients": [
            "200g spaghetti",
            "100g pancetta",
            "2 eggs",
            "50g pecorino cheese",
            "50g parmesan",
            "black pepper",
          ],
          "instructions":
            "Cook pasta. Fry pancetta. Mix eggs and cheese. Combine all ingredients while pasta is hot.",
        }],
      };
      const schema = createJsonSchema(data);
      expect(schema).toEqual({
        "type": "object",
        "properties": {
          "recipes": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                },
                "ingredients": {
                  "type": "array",
                  "items": {
                    "type": "string",
                  },
                },
                "instructions": {
                  "type": "string",
                },
              },
            },
          },
        },
      });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("should not set default on object schemas when addDefaults is true", () => {
      const schema = createJsonSchema({ name: "Alice", age: 30 }, true);
      expect(schema).toEqual({
        type: "object",
        properties: {
          name: { type: "string", default: "Alice" },
          age: { type: "integer", default: 30 },
        },
      });
      // The object itself must not have a default
      expect(schema).not.toHaveProperty("default");
    });

    it("should set default on array schemas when addDefaults is true", () => {
      // Each element gets its own default, so elements with different values
      // produce different schemas and collapse into anyOf.
      expect(createJsonSchema([1, 2, 3], true)).toEqual({
        type: "array",
        items: {
          anyOf: [
            { type: "integer", default: 1 },
            { type: "integer", default: 2 },
            { type: "integer", default: 3 },
          ],
        },
        default: [1, 2, 3],
      });

      // A single-element array produces a single items schema with default.
      expect(createJsonSchema([42], true)).toEqual({
        type: "array",
        items: { type: "integer", default: 42 },
        default: [42],
      });

      // Duplicate values in the array deduplicate to one items schema.
      expect(createJsonSchema(["a", "a", "a"], true)).toEqual({
        type: "array",
        items: { type: "string", default: "a" },
        default: ["a", "a", "a"],
      });
    });

    it("should set defaults on leaves but not intermediate objects in nested structures", () => {
      const schema = createJsonSchema({
        user: {
          name: "Bob",
          active: true,
        },
        scores: [10, 20],
      }, true);

      expect(schema).toEqual({
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string", default: "Bob" },
              active: { type: "boolean", default: true },
            },
          },
          scores: {
            type: "array",
            items: {
              anyOf: [
                { type: "integer", default: 10 },
                { type: "integer", default: 20 },
              ],
            },
            default: [10, 20],
          },
        },
      });

      // Appease the TS type system.
      const schemaObj: JSONSchemaObj = schema as JSONSchemaObj;

      // Neither the root nor the nested object should have defaults
      expect(schemaObj).not.toHaveProperty("default");
      expect(schemaObj.properties!["user"]).not.toHaveProperty("default");
    });
  });
});
