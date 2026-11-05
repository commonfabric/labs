/** Checks warnings for unresolved defaults and successful fallback extraction. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type SchemaGenerationDiagnostic,
  SchemaGenerator,
} from "../../src/index.ts";
import { asObjectSchema, getTypeFromCode, getTypeFromFiles } from "../utils.ts";

describe("default diagnostics", () => {
  describe("DeepDefault", () => {
    for (
      const payload of [
        '{ nested: { label: string }; known: "yes" }',
        '{ nested: { values: [0, string] }; known: "yes" }',
      ]
    ) {
      it(`warns when ${payload} cannot be fully extracted`, async () => {
        const { type, checker, typeNode } = await getTypeFromCode(
          `interface DeepDefault<V> {}
           interface Config {
             known: string;
             nested: { label: string; values: unknown[] };
           }
           type Root = Config | DeepDefault<${payload}>;`,
          "Root",
        );
        const diagnostics: SchemaGenerationDiagnostic[] = [];
        const schema = asObjectSchema(
          new SchemaGenerator().generateSchema(type, checker, typeNode, {
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
          }),
        );

        expect(schema).not.toHaveProperty("default");
        expect(schema).not.toHaveProperty("properties");
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
          severity: "warning",
          type: "schema-default:unresolved",
        });
        expect(diagnostics[0]?.message).toContain("DeepDefault<>");
        expect(diagnostics[0]?.node).toBeDefined();
      });
    }
  });

  for (const form of ["union member", "two arguments"]) {
    for (
      const [valueType, payload] of [
        ["Record<string, unknown>", '{ known: "yes"; unresolved: string }'],
        ["unknown[]", '["yes", string]'],
        ["Record<string, unknown>", '{ nested: { items: ["yes", number] } }'],
        ["unknown[]", "[{ known: 1; nested: { unresolved: boolean } }]"],
        ["Record<string, unknown>", "{ known: 1; [key: string]: unknown }"],
      ]
    ) {
      it(`warns instead of emitting a partial ${form} default for ${payload}`, async () => {
        const wrapped = form === "union member"
          ? `${valueType} | Default<${payload}>`
          : `Default<${valueType}, ${payload}>`;
        const { type, checker, typeNode } = await getTypeFromCode(
          `interface Default<T, V extends T = T> {}
           type Root = ${wrapped};`,
          "Root",
        );
        const diagnostics: SchemaGenerationDiagnostic[] = [];
        const schema = asObjectSchema(
          new SchemaGenerator().generateSchema(type, checker, typeNode, {
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
          }),
        );

        expect(schema).not.toHaveProperty("default");
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.type).toBe("schema-default:unresolved");
      });
    }

    it(`preserves a complete nested ${form} default without warning`, async () => {
      const payload =
        '{ nested: { values: [null, false, 0, "", {}, []]; "": 0; "__proto__": false } }';
      const wrapped = form === "union member"
        ? `Record<string, unknown> | Default<${payload}>`
        : `Default<Record<string, unknown>, ${payload}>`;
      const { type, checker, typeNode } = await getTypeFromCode(
        `interface Default<T, V extends T = T> {}
         type Root = ${wrapped};`,
        "Root",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode, {
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      );

      expect(schema.default).toEqual({
        nested: {
          values: [null, false, 0, "", {}, []],
          "": 0,
          ["__proto__"]: false,
        },
      });
      expect(diagnostics).toEqual([]);
    });
  }

  for (
    const declaration of [
      "Default<string>",
      "Default<string, string>",
      "string | Default<string>",
      "Default<object, Record<string, string>>",
    ]
  ) {
    it(`warns when ${declaration} cannot supply a value`, async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `interface Default<T, V extends T = T> {}
         type Root = ${declaration};`,
        "Root",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode, {
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      );

      expect(schema).not.toHaveProperty("default");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        type: "schema-default:unresolved",
        severity: "warning",
      });
      expect(diagnostics[0]?.message).toContain("supplies no schema default");
      expect(diagnostics[0]?.node).toBeDefined();
    });
  }

  for (
    const [valueType, payload] of [
      ["string", "string"],
      ["string", '"first" | "second"'],
      ["object", "Record<string, string>"],
    ]
  ) {
    it(`warns for an expanded default with payload ${payload}`, async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `declare const DEFAULT_MARKER: unique symbol;
         type Marker<V> = { readonly [DEFAULT_MARKER]: V };
         type Root = ${valueType} | (${valueType} & Marker<${payload}>);`,
        "Root",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode, {
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      );

      expect(schema).not.toHaveProperty("default");
      expect(diagnostics).toHaveLength(1);
    });
  }

  it("preserves imported empty-object aliases without warning", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/types.ts": "export type Empty = {}; export type Alias = Empty;",
        "/main.ts": `
        import type { Alias } from "./types.ts";
        interface Default<T, V extends T = T> {}
        interface Root {
          direct: Default<Alias>;
          union: Record<string, unknown> | Default<Alias>;
          two: Default<Record<string, unknown>, Alias>;
        }
      `,
      },
      "/main.ts",
      "Root",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );

    for (const name of ["direct", "union", "two"]) {
      expect(schema.properties?.[name]).toHaveProperty("default", {});
    }
    expect(diagnostics).toEqual([]);
  });

  it("does not warn for ordinary unions or falsy defaults", async () => {
    const { type, checker } = await getTypeFromCode(
      `interface Default<T, V extends T = T> {}
       interface Root {
         object: {} | string;
         array: string[] | [];
         text: Default<"">;
         number: Default<0>;
         flag: Default<false>;
         missing: Default<null>;
       }`,
      "Root",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );

    expect(schema.properties?.text).toHaveProperty("default", "");
    expect(schema.properties?.number).toHaveProperty("default", 0);
    expect(schema.properties?.flag).toHaveProperty("default", false);
    expect(schema.properties?.missing).toHaveProperty("default", null);
    expect(diagnostics).toEqual([]);
  });
});
