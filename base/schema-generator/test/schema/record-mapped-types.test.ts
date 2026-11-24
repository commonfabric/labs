import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Record and mapped types", () => {
  const transformer = new SchemaGenerator();

  it("should generate correct schemas for Default<Record<union, primitive>>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `type Default<T, D> = T;
       type ColumnKey = "backlog" | "inProgress" | "review" | "done";
       interface Config {
         wipLimits: Default<Record<ColumnKey, number>, any>;
       }`,
      "Config",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.wipLimits).toBeDefined();

    const wipLimitsSchema = schema.properties!.wipLimits as any;
    expect(wipLimitsSchema.type).toBe("object");
    expect(wipLimitsSchema.properties).toBeDefined();

    // Each property should have the correct type schema
    expect(wipLimitsSchema.properties.backlog).toEqual({ type: "number" });
    expect(wipLimitsSchema.properties.inProgress).toEqual({ type: "number" });
    expect(wipLimitsSchema.properties.review).toEqual({ type: "number" });
    expect(wipLimitsSchema.properties.done).toEqual({ type: "number" });

    // All keys should be required
    expect(wipLimitsSchema.required).toEqual([
      "backlog",
      "inProgress",
      "review",
      "done",
    ]);

    // Should NOT have Record in $defs
    expect(schema.$defs?.Record).toBeUndefined();
  });

  it("should generate correct schemas for Record<union, primitive>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Config {
        settings: Record<"theme" | "language" | "timezone", string>;
      }`,
      "Config",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.settings).toBeDefined();

    const settingsSchema = schema.properties!.settings as any;
    expect(settingsSchema.type).toBe("object");
    expect(settingsSchema.properties).toBeDefined();

    // Each property should have the correct type schema, not 'true'
    expect(settingsSchema.properties.theme).toEqual({ type: "string" });
    expect(settingsSchema.properties.language).toEqual({ type: "string" });
    expect(settingsSchema.properties.timezone).toEqual({ type: "string" });

    // All keys should be required
    expect(settingsSchema.required).toEqual([
      "theme",
      "language",
      "timezone",
    ]);
  });

  it("should generate correct schemas for Record<union, number>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Config {
        limits: Record<"cpu" | "memory" | "disk", number>;
      }`,
      "Config",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    const limitsSchema = schema.properties!.limits as any;
    expect(limitsSchema.type).toBe("object");

    // Each property should have type: "number", not 'true'
    expect(limitsSchema.properties.cpu).toEqual({ type: "number" });
    expect(limitsSchema.properties.memory).toEqual({ type: "number" });
    expect(limitsSchema.properties.disk).toEqual({ type: "number" });
  });

  it("should generate correct schemas for Record<union, boolean>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Config {
        features: Record<"auth" | "api" | "ui", boolean>;
      }`,
      "Config",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    const featuresSchema = schema.properties!.features as any;
    expect(featuresSchema.type).toBe("object");

    // Each property should have type: "boolean", not 'true'
    expect(featuresSchema.properties.auth).toEqual({ type: "boolean" });
    expect(featuresSchema.properties.api).toEqual({ type: "boolean" });
    expect(featuresSchema.properties.ui).toEqual({ type: "boolean" });
  });

  it("should generate correct schemas for Record<union, object>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Registry {
        handlers: Record<"create" | "update" | "delete", { enabled: boolean }>;
      }`,
      "Registry",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    const handlersSchema = schema.properties!.handlers as any;
    expect(handlersSchema.type).toBe("object");

    // Each property should be an object with enabled: boolean
    expect(handlersSchema.properties.create).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    });
    expect(handlersSchema.properties.update).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    });
    expect(handlersSchema.properties.delete).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    });
  });

  it("should handle nested Record types", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Config {
        nested: Record<"outer", Record<"inner", string>>;
      }`,
      "Config",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    const nestedSchema = schema.properties!.nested as any;
    expect(nestedSchema.type).toBe("object");
    expect(nestedSchema.properties.outer).toBeDefined();

    const outerSchema = nestedSchema.properties.outer;
    expect(outerSchema.type).toBe("object");
    expect(outerSchema.properties.inner).toEqual({ type: "string" });
  });

  it("should handle Partial<T> mapped type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `type PartialConfig = Partial<{ name: string; age: number }>;`,
      "PartialConfig",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();

    // Properties should have correct types, not 'true'
    expect(schema.properties!.name).toEqual({ type: "string" });
    expect(schema.properties!.age).toEqual({ type: "number" });

    // Partial makes everything optional
    expect(schema.required).toBeUndefined();
  });

  it("should handle Pick<T, K> mapped type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface User { id: string; name: string; email: string; }
       type PickedUser = Pick<User, "id" | "name">;`,
      "PickedUser",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();

    // Only picked properties should exist
    expect(schema.properties!.id).toEqual({ type: "string" });
    expect(schema.properties!.name).toEqual({ type: "string" });
    expect(schema.properties!.email).toBeUndefined();

    // Picked properties are required (unless original was optional)
    expect(schema.required).toEqual(["id", "name"]);
  });

  it("should handle Required<T> mapped type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `type RequiredConfig = Required<{ name?: string; age?: number }>;`,
      "RequiredConfig",
    );
    const schema = asObjectSchema(
      transformer.generateSchema(type, checker, typeNode),
    );

    expect(schema.type).toBe("object");

    // Properties should have correct types
    expect(schema.properties!.name).toEqual({ type: "string" });
    expect(schema.properties!.age).toEqual({ type: "number" });

    // Required makes everything required
    expect(schema.required).toEqual(["name", "age"]);
  });

  describe("edge cases", () => {
    it("should handle Record<string, T> with additionalProperties", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `interface Config {
          metadata: Record<string, string>;
          data: Record<string, number>;
        }`,
        "Config",
      );
      const schema = asObjectSchema(
        transformer.generateSchema(type, checker, typeNode),
      );

      // Record<string, T> should use additionalProperties pattern
      const metadataSchema = schema.properties!.metadata as any;
      expect(metadataSchema.type).toBe("object");
      expect(metadataSchema.properties).toEqual({});
      expect(metadataSchema.additionalProperties).toEqual({ type: "string" });

      const dataSchema = schema.properties!.data as any;
      expect(dataSchema.type).toBe("object");
      expect(dataSchema.properties).toEqual({});
      expect(dataSchema.additionalProperties).toEqual({ type: "number" });
    });

    it("should handle generic with default type parameters", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `type Box<T = string> = { value: T };
         interface Config {
           box: Box;
           explicitBox: Box<number>;
         }`,
        "Config",
      );
      const schema = asObjectSchema(
        transformer.generateSchema(type, checker, typeNode),
      );

      console.log("box schema:", JSON.stringify(schema.properties?.box));
      console.log(
        "explicitBox schema:",
        JSON.stringify(schema.properties?.explicitBox),
      );
      console.log("$defs keys:", Object.keys(schema.$defs || {}));

      // Box without explicit param uses default (string)
      const boxSchema = schema.properties!.box as any;
      expect(boxSchema.type).toBe("object");
      expect(boxSchema.properties.value).toEqual({ type: "string" });

      // Box with explicit param uses that type
      const explicitBoxSchema = schema.properties!.explicitBox as any;
      expect(explicitBoxSchema.type).toBe("object");
      expect(explicitBoxSchema.properties.value).toEqual({ type: "number" });

      // Neither should create "Box" in $defs
      expect(schema.$defs?.Box).toBeUndefined();
    });

    it("should handle distributive conditional types as unions", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `type MaybeRecord<T extends string> = T extends string ? Record<T, number> : never;
         interface Config {
           data: MaybeRecord<"foo" | "bar">;
         }`,
        "Config",
      );
      const schema = asObjectSchema(
        transformer.generateSchema(type, checker, typeNode),
      );

      // TypeScript distributes the conditional over the union, resulting in:
      // Record<"foo", number> | Record<"bar", number>
      // This is correct behavior for distributive conditional types
      const dataSchema = schema.properties!.data as any;
      expect(dataSchema.anyOf).toBeDefined();
      expect(dataSchema.anyOf).toHaveLength(2);

      // The distributed union is the checker's, which no node writes, so
      // its members are listed in canonical order: by the `Record` key
      // each instantiates, `"bar"` before `"foo"`.
      expect(dataSchema.anyOf[0]).toEqual({
        type: "object",
        properties: { bar: { type: "number" } },
        required: ["bar"],
      });
      expect(dataSchema.anyOf[1]).toEqual({
        type: "object",
        properties: { foo: { type: "number" } },
        required: ["foo"],
      });

      // Should not create MaybeRecord or Record in $defs
      expect(schema.$defs?.MaybeRecord).toBeUndefined();
      expect(schema.$defs?.Record).toBeUndefined();
    });

    it("reads an object with a numeric index signature as a map, not an array", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `interface Config {
          byIndex: { [index: number]: string };
          numbered: { 0: number; [index: number]: number };
        }`,
        "Config",
      );
      const schema = asObjectSchema(
        transformer.generateSchema(type, checker, typeNode),
      );

      expect(schema.properties?.byIndex).toEqual({
        type: "object",
        properties: {},
        additionalProperties: { type: "string" },
      });
      expect(schema.properties?.numbered).toEqual({
        type: "object",
        properties: { 0: { type: "number" } },
        additionalProperties: { type: "number" },
        required: ["0"],
      });
    });

    for (
      const [shape, declaration] of [
        ["a tuple", "type Value = [number, number];"],
        ["a `readonly` array", "type Value = readonly number[];"],
        ["an `ArrayLike`", "type Value = ArrayLike<number>;"],
        [
          "an interface that extends `Array`",
          "interface Value extends Array<number> { extra: number }",
        ],
      ] as const
    ) {
      it(`reads ${shape} as an array`, async () => {
        const { type, checker, typeNode } = await getTypeFromCode(
          `${declaration}
           interface Config { value: Value }`,
          "Config",
        );
        const schema = asObjectSchema(
          transformer.generateSchema(type, checker, typeNode),
        );
        const value = schema.properties!.value as { $ref?: string };
        const resolved = value.$ref
          ? schema.$defs![value.$ref.slice("#/$defs/".length)]
          : value;

        expect(resolved).toEqual({ type: "array", items: { type: "number" } });
      });
    }

    for (
      const [mapping, mapped] of [
        ["`Pick`", `Pick<Window, "from">`],
        ["`Omit`", `Omit<Window, "id">`],
        ["`Partial`", "Partial<Window>"],
      ] as const
    ) {
      it(`reads a member ${mapping} maps as its declaration reads it`, async () => {
        const { type, checker, typeNode } = await getTypeFromCode(
          `type Anchor = { before: string } | { after: string };
           interface Window { id: string; from?: Anchor }
           interface Config { window: Window; mapped: ${mapped} }`,
          "Config",
        );
        const schema = asObjectSchema(
          transformer.generateSchema(type, checker, typeNode),
        );
        const mappedSchema = asObjectSchema(schema.properties!.mapped!);

        expect(mappedSchema.properties?.from).toEqual({
          $ref: "#/$defs/Anchor",
        });
      });
    }
  });
});
