// Default value handling tests: verifying that schemas with default values
// produce correct output when data is missing or incomplete.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema - Default Values", () => {
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
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Default Values", () => {
    it("should use the default value when property is undefined", () => {
      const c = runtime.getCell<{
        name: string;
        // age is not defined
      }>(
        space,
        "should use the default value when property is undefined 1",
        undefined,
        tx,
      );
      c.set({
        name: "John",
        // age is not defined
      });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", default: 30 },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(value.age).toBe(30);
    });

    it("processes tuple (prefixItems) defaults against their slot schemas", () => {
      // CT-1895: prefixItems-only schemas skipped array default processing
      // entirely, so nested defaults inside tuple elements never resolved.
      const c = runtime.getCell<{ name: string }>(
        space,
        "tuple defaults slot processing 1",
        undefined,
        tx,
      );
      c.set({ name: "t" });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          pair: {
            type: "array",
            default: [{}, {}],
            prefixItems: [
              {
                type: "object",
                properties: { x: { type: "number", default: 1 } },
              },
              {
                type: "object",
                properties: { y: { type: "number", default: 2 } },
              },
            ],
          },
        },
      } as const satisfies JSONSchema;

      const value = c.asSchema(schema).get();
      expect(value.pair).toEqual([{ x: 1 }, { y: 2 }]);
    });

    it("resolves $ref tuple slots against the document's $defs", () => {
      // The selected slot schema is passed to recursive default processing
      // carrying the document's `$defs`, so a `$ref` slot resolves and its
      // nested defaults are filled.
      const c = runtime.getCell<{ name: string }>(
        space,
        "tuple defaults ref slot 1",
        undefined,
        tx,
      );
      c.set({ name: "t" });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          pair: {
            type: "array",
            default: [{}],
            prefixItems: [{ $ref: "#/$defs/P" }],
          },
        },
        $defs: {
          P: {
            type: "object",
            properties: { x: { type: "number", default: 1 } },
          },
        },
      } as const satisfies JSONSchema;

      const value = c.asSchema(schema).get();
      expect(value.pair).toEqual([{ x: 1 }]);
    });

    it("allows any value in boolean-true tuple slots", () => {
      const c = runtime.getCell<{ name: string }>(
        space,
        "tuple defaults true slot 1",
        undefined,
        tx,
      );
      c.set({ name: "t" });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          pair: {
            type: "array",
            default: [5],
            prefixItems: [true],
          },
        },
      } as unknown as JSONSchema;

      const value = c.asSchema(schema).get() as { pair?: unknown };
      expect(value.pair).toEqual([5]);
    });

    it("rejects default elements past the slots of a closed tuple", () => {
      const c = runtime.getCell<{ name: string }>(
        space,
        "tuple defaults closed 1",
        undefined,
        tx,
      );
      c.set({ name: "t" });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          pair: {
            type: "array",
            default: ["a", "b"],
            prefixItems: [{ type: "string" }],
            items: false,
          },
        },
      } as unknown as JSONSchema;

      expect(() => c.asSchema(schema).get()).toThrow(
        /items: false conflicts/,
      );
    });

    it("should resolve defaults when using $ref in property schemas", () => {
      const schema = {
        $defs: {
          Settings: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              label: { type: "string" },
            },
            default: { enabled: true, label: "from ref" },
          },
        },
        type: "object",
        properties: {
          config: {
            $ref: "#/$defs/Settings",
            default: { enabled: false, label: "from property" },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{
        config?: { enabled: boolean; label: string };
      }>(
        space,
        "should resolve defaults when using $ref in property schemas",
        undefined,
        tx,
      );
      c.set({});

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.config).toEqualIgnoringSymbols({
        enabled: false,
        label: "from property",
      });
    });

    it("should resolve defaults in $ref when using $ref in property schemas", () => {
      const schema = {
        $defs: {
          Settings: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              label: { type: "string" },
            },
            default: { enabled: true, label: "from ref" },
          },
          SettingsWithDefault: {
            $ref: "#/$defs/Settings",
            default: { enabled: false, label: "from default" },
          },
        },
        type: "object",
        properties: {
          config: {
            $ref: "#/$defs/SettingsWithDefault",
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{
        config?: { enabled: boolean; label: string };
      }>(
        space,
        "should resolve defaults in $ref when using $ref in property schemas",
        undefined,
        tx,
      );
      c.set({});

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.config).toEqualIgnoringSymbols({
        enabled: false,
        label: "from default",
      });
    });

    it("should use the default value with asCell for objects", () => {
      const c = runtime.getCell<{
        name: string;
        // profile is not defined
      }>(
        space,
        "should use the default value with asCell for objects 1",
        undefined,
        tx,
      );
      c.set({
        name: "John",
        // profile is not defined
      });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          profile: {
            type: "object",
            properties: {
              bio: { type: "string" },
              avatar: { type: "string" },
            },
            default: { bio: "Default bio", avatar: "default.png" },
            asCell: ["cell"],
          },
        },
        required: ["name", "profile"],
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.profile)).toBe(true);
      expect(value.profile.get()).toEqualIgnoringSymbols({
        bio: "Default bio",
        avatar: "default.png",
      });

      // Verify the profile cell can be updated
      value.profile.set({ bio: "Updated bio", avatar: "new.png" });
      expect(value.profile.get()).toEqualIgnoringSymbols({
        bio: "Updated bio",
        avatar: "new.png",
      });
    });

    it("should use the default value with asCell for arrays", () => {
      const c = runtime.getCell<{
        name: string;
        // tags is not defined
      }>(
        space,
        "should use the default value with asCell for arrays 1",
        undefined,
        tx,
      );
      c.set({
        name: "John",
        // tags is not defined
      });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" },
            default: ["default", "tags"],
            asCell: ["cell"],
          },
        },
        required: ["name", "tags"],
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.tags)).toBe(true);
      expect(value.tags.get()).toEqualIgnoringSymbols([
        "default",
        "tags",
      ]);

      // Verify the tags cell can be updated
      value.tags.set(["updated", "tags", "list"]);
      expect(value.tags.get()).toEqualIgnoringSymbols([
        "updated",
        "tags",
        "list",
      ]);
    });

    it("should handle nested default values with asCell", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                properties: {
                  theme: {
                    type: "object",
                    properties: {
                      mode: { type: "string" },
                      color: { type: "string" },
                    },
                    default: { mode: "dark", color: "blue" },
                    asCell: ["cell"],
                  },
                  notifications: { type: "boolean", default: true },
                },
                default: {
                  theme: { mode: "light", color: "red" },
                  notifications: true,
                },
                asCell: ["cell"],
              },
            },
            required: ["name", "settings"],
          },
        },
        required: ["user"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{
        user: {
          name: string;
          // settings is not defined
        };
      }>(
        space,
        "should use the default value with nested schema 1",
        undefined,
        tx,
      );
      c.set({
        user: {
          name: "John",
          // settings is not defined
        },
      });

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.user.name).toBe("John");
      expect(isCell(value.user.settings)).toBe(true);

      const settings = value.user.settings.get();
      expect(settings.notifications).toBe(true);
      expect(isCell(settings.theme)).toBe(true);
      expect(isCell(settings.theme.get())).toBe(false);
      expect(settings.theme.get()).toEqualIgnoringSymbols({
        mode: "light",
        color: "red",
      });

      const c2 = runtime.getCell<{
        user: {
          name: string;
          // settings is set, but theme is not
          settings: { notifications: boolean };
        };
      }>(
        space,
        "should use the default value with nested schema 2",
        undefined,
        tx,
      );
      c2.set({
        user: {
          name: "John",
          // settings is set, but theme is not
          settings: { notifications: false },
        },
      });

      const cell2 = c2.asSchema(schema);
      const value2 = cell2.get();

      expect(value2.user.name).toBe("John");
      expect(isCell(value2.user.settings)).toBe(true);

      const settings2 = value2.user.settings.get();
      expect(settings2.notifications).toBe(false);
      expect(isCell(settings2.theme)).toBe(true);
      expect(settings2.theme.get()).toEqualIgnoringSymbols({
        mode: "dark",
        color: "blue",
      });
    });

    it("should handle default values with asCell in arrays", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                title: { type: "string", default: "Default Title" },
                metadata: {
                  type: "object",
                  properties: {
                    createdAt: { type: "string" },
                  },
                  asCell: ["cell"],
                },
              },
            },
            default: [
              {
                id: 1,
                title: "First Item",
                metadata: { createdAt: "2023-01-01" },
              },
              {
                id: 2,
                metadata: { createdAt: "2023-01-02" },
              },
            ],
          },
        },
        default: {},
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{
        items: Array<{ id: number; title?: string }>;
      }>(
        space,
        "should use the default value for array items 1",
        undefined,
        tx,
      );
      c.set({
        items: [
          { id: 1, title: "First Item" },
          // Second item has missing properties
          { id: 2 },
        ],
      });
      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.items?.[0].title).toBe("First Item");
      expect(value.items?.[1].title).toBe("Default Title");
      // Our newly set values don't have a metadata property
      expect(value.items?.[0].metadata).toBeUndefined();
      expect(value.items?.[1].metadata).toBeUndefined();

      const c2 = runtime.getCell<any>(
        space,
        "should use the default value for array items 2",
        undefined,
        tx,
      );
      c2.set(undefined);
      const cell2 = c2.asSchema(schema);
      const value2 = cell2.get();

      expect(value2.items?.length).toBe(2);
      expect(value2.items?.[0].title).toBe("First Item");
      expect(value2.items?.[1].title).toBe("Default Title");

      expect(isCell(value2.items?.[0].metadata)).toBe(true);
      expect(isCell(value2.items?.[1].metadata)).toBe(true);

      expect(value2.items?.[0].metadata?.get()).toEqualIgnoringSymbols(
        {
          createdAt: "2023-01-01",
        },
      );
      expect(value2.items?.[1].metadata?.get()).toEqualIgnoringSymbols(
        {
          createdAt: "2023-01-02",
        },
      );
    });

    it("should handle default values with additionalProperties", () => {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              knownProp: { type: "string" },
            },
            additionalProperties: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                value: { type: "string" },
              },
              default: { enabled: true, value: "default" },
              asCell: ["cell"],
            },
            default: {
              knownProp: "default",
              feature1: { enabled: true, value: "feature1" },
              feature2: { enabled: false, value: "feature2" },
            },
          },
        },
        default: {}, // this makes us walk down for other defaults
        required: ["config"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "should handle default values with additionalProperties 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.config.knownProp).toBe("default");

      // These come from the default and should be processed as cells because of asCell in additionalProperties
      expect(isCell(value.config.feature1)).toBe(true);
      expect(isCell(value.config.feature2)).toBe(true);

      expect(value.config.feature1?.get()).toEqualIgnoringSymbols({
        enabled: true,
        value: "feature1",
      });
      expect(value.config.feature2?.get()).toEqualIgnoringSymbols({
        enabled: false,
        value: "feature2",
      });
    });

    it("should drop values blocked by additionalProperties: false", () => {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              allowed: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        required: ["config"],
      } as const satisfies JSONSchema;

      const source = runtime.getCell<any>(
        space,
        "should drop values blocked by additionalProperties false",
        undefined,
        tx,
      );
      source.set({
        config: {
          allowed: "ok",
          forbidden: "nope",
        },
      });

      const value = source.asSchema(schema).get();

      expect(value.config.allowed).toBe("ok");
      expect(
        Object.prototype.hasOwnProperty.call(value.config, "forbidden"),
      ).toBe(false);
    });

    it(
      "should transform explicit additionalProperties objects from data",
      () => {
        const schema = {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                knownProp: { type: "string" },
              },
              additionalProperties: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                  value: { type: "string" },
                },
                asCell: ["cell"],
              },
              required: ["knownProp"],
            },
          },
          required: ["config"],
        } as const satisfies JSONSchema;

        const source = runtime.getCell<any>(
          space,
          "should transform explicit additionalProperties objects from data",
          undefined,
          tx,
        );
        source.set({
          config: {
            knownProp: "in schema",
            featureFlag: {
              enabled: true,
              value: "beta",
            },
          },
        });

        const value = source.asSchema(schema).get();

        expect(value.config.knownProp).toBe("in schema");
        expect(isCell(value.config.featureFlag)).toBe(true);
        expect(value.config.featureFlag?.get()).toEqualIgnoringSymbols(
          {
            enabled: true,
            value: "beta",
          },
        );
      },
    );

    it("should handle default at the root level with asCell", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          settings: {
            type: "object",
            properties: {
              theme: { type: "string" },
            },
          },
        },
        default: {
          name: "Default User",
          settings: { theme: "light" },
        },
        asCell: ["cell"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "should use the default value at the root level 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);

      // The whole document should be a cell containing the default
      expect(isCell(cell)).toBe(true);
      const cellValue = cell.get();
      expect(isCell(cellValue)).toBe(true);
      const value = cellValue.get();
      expect(value).toEqualIgnoringSymbols({
        name: "Default User",
        settings: { theme: "light" },
      });

      // Verify it can be updated
      cell.set(
        runtime.getImmutableCell(space, {
          name: "Updated User",
          settings: { theme: "dark" },
        }),
      );
      expect(cell.get().get()).toEqualIgnoringSymbols({
        name: "Updated User",
        settings: { theme: "dark" },
      });
    });

    it("should make immutable cells if they provide the default value", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", default: "Default Name", asCell: ["cell"] },
        },
        default: {},
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "should make immutable cells if they provide the default value 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);
      const value = cell.get();
      expect(isCell(value.name)).toBe(true);
      expect(value?.name?.get()).toBe("Default Name");

      cell.set(
        runtime.getImmutableCell(space, { name: "Updated Name" }),
      );

      // Expect the cell to be immutable
      expect(value?.name?.get()).toBe("Default Name");
    });

    it("should make mutable cells if parent provides the default value", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", default: "Default Name", asCell: ["cell"] },
        },
        default: { name: "First default name" },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "should make mutable cells if parent provides the default value 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);
      const value = cell.get();
      expect(isCell(value.name)).toBe(true);
      expect(value.name.get()).toBe("First default name");

      cell.set({ name: runtime.getImmutableCell(space, "Updated Name") });

      // Expect the cell to be immutable
      expect(value.name.get()).toBe("Updated Name");
    });

    it("should make immutable cells if a $ref target provides the default value", () => {
      const schema = {
        $defs: {
          NameEntry: {
            type: "string",
            default: "Default Name",
            asCell: ["cell"],
          },
        },
        type: "object",
        properties: {
          name: { $ref: "#/$defs/NameEntry" },
        },
        default: {},
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "should make immutable cells if a $ref target provides the default value 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);
      const value = cell.get();
      expect(isCell(value.name)).toBe(true);
      expect(value?.name?.get()).toBe("Default Name");

      cell.set(
        runtime.getImmutableCell(space, { name: "Updated Name" }),
      );

      // Expect the cell to be immutable
      expect(value?.name?.get()).toBe("Default Name");
    });
  });
});
