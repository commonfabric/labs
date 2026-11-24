/**
 * Pins the KNOWN QUIRK in mapping spec §2/§16.7: the two analysis paths
 * encode literals differently for the SAME authored type.
 *   type path  (generateSchema):                 { type, enum: [v] }
 *   node path  (generateSchemaFromSyntheticTypeNode, schema-generator.ts
 *               ~:879-896):                      { type, const: v }
 * For literal unions the divergence is structural, not just spelling:
 *   type path:  { enum: [a, b] }
 *   node path:  { anyOf: [{ const: a }, { const: b }] }
 * The consumer (ts-transformers SchemaGeneratorTransformer) routes a type
 * arg to the node path whenever it is synthetic-and-any OR contains an
 * `any`/`unknown` keyword anywhere, so adding `data: unknown` to a type
 * flips sibling literal encodings. Runner validation treats const and enum
 * equivalently (runner/src/schema.ts matchesConcreteValue), but structural
 * schema equality (runner/src/cfc/prepare.ts schemasEqualIgnoringWriterStamp)
 * does not — the spellings are different schemas to deepEqual.
 *
 * These tests pin today's divergence so a canonicalization fix (e.g. the
 * node path emitting enum-spelling) flips them consciously.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgram, getTypeFromCode } from "./utils.ts";

describe("literal encoding across analysis paths", () => {
  it("same authored literal alias: enum on the type path, const on the node path", async () => {
    const code = `type One = "x";`;
    const generator = new SchemaGenerator();
    const { type, checker, typeNode } = await getTypeFromCode(code, "One");

    const viaType = generator.generateSchema(type, checker, typeNode);
    expect(viaType).toEqual({ type: "string", enum: ["x"] });

    const viaNode = generator.generateSchemaFromSyntheticTypeNode(
      typeNode!,
      checker,
    );
    expect(viaNode).toEqual({ type: "string", const: "x" });
  });

  it("same authored literal union: one enum vs anyOf-of-consts", async () => {
    const code = `type Status = "active" | "archived";`;
    const generator = new SchemaGenerator();
    const { type, checker, typeNode } = await getTypeFromCode(code, "Status");

    expect(generator.generateSchema(type, checker, typeNode)).toEqual({
      enum: ["active", "archived"],
    });
    expect(
      generator.generateSchemaFromSyntheticTypeNode(typeNode!, checker),
    ).toEqual({
      anyOf: [
        { type: "string", const: "active" },
        { type: "string", const: "archived" },
      ],
    });
  });

  it("preserves nullable booleans across both analysis paths", async () => {
    const code = `type MaybeBoolean = boolean | null;`;
    const generator = new SchemaGenerator();
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "MaybeBoolean",
    );
    const expected = {
      anyOf: [{ type: "boolean" }, { type: "null" }],
    };

    expect(generator.generateSchema(type, checker, typeNode)).toEqual(expected);
    expect(
      generator.generateSchemaFromSyntheticTypeNode(typeNode!, checker),
    ).toEqual(expected);
  });

  it("preserves null beside explicit boolean literals on both paths", async () => {
    const code = `type MaybeBoolean = true | false | null;`;
    const generator = new SchemaGenerator();
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "MaybeBoolean",
    );

    expect(generator.generateSchema(type, checker, typeNode)).toEqual({
      anyOf: [{ type: "boolean" }, { type: "null" }],
    });
    expect(
      generator.generateSchemaFromSyntheticTypeNode(typeNode!, checker),
    ).toEqual({
      anyOf: [
        { type: "boolean", const: true },
        { type: "boolean", const: false },
        { type: "null" },
      ],
    });
  });

  it("keeps nullable single boolean literals narrow on both paths", async () => {
    for (const literal of ["true", "false"] as const) {
      const code = `type MaybeBoolean = ${literal} | null;`;
      const generator = new SchemaGenerator();
      const { type, checker, typeNode } = await getTypeFromCode(
        code,
        "MaybeBoolean",
      );
      const value = literal === "true";

      expect(generator.generateSchema(type, checker, typeNode)).toEqual({
        anyOf: [
          { type: "boolean", enum: [value] },
          { type: "null" },
        ],
      });
      expect(
        generator.generateSchemaFromSyntheticTypeNode(typeNode!, checker),
      ).toEqual({
        anyOf: [
          { type: "boolean", const: value },
          { type: "null" },
        ],
      });
    }
  });

  it("preserves undefined in nullable booleans on both paths", async () => {
    const code = `type MaybeBoolean = boolean | null | undefined;`;
    const generator = new SchemaGenerator();
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "MaybeBoolean",
    );

    expect(generator.generateSchema(type, checker, typeNode)).toEqual({
      anyOf: [
        { type: ["null", "undefined"] },
        { type: "boolean" },
      ],
    });
    expect(
      generator.generateSchemaFromSyntheticTypeNode(typeNode!, checker),
    ).toEqual({
      anyOf: [
        { type: "boolean" },
        { type: "null" },
        { type: "undefined" },
      ],
    });
  });

  it("bound object nodes converge (property literals re-resolve onto the type path)", async () => {
    const code = `type Shape = { kind: "point"; x: number };`;
    const generator = new SchemaGenerator();
    const { type, checker, typeNode } = await getTypeFromCode(code, "Shape");

    const expected = {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["point"] },
        x: { type: "number" },
      },
      required: ["kind", "x"],
    };
    expect(generator.generateSchema(type, checker, typeNode)).toEqual(expected);
    // A REAL (bound) node's property types resolve through the checker, so
    // even the node-path entry converges back to enum spelling here.
    expect(
      generator.generateSchemaFromSyntheticTypeNode(typeNode!, checker),
    ).toEqual(expected);
  });

  it("truly synthetic object nodes stay on the node path: const properties", async () => {
    const { checker } = await createTestProgram(`type Unused = string;`);
    const generator = new SchemaGenerator();
    const f = ts.factory;
    const synthObj = f.createTypeLiteralNode([
      f.createPropertySignature(
        undefined,
        f.createIdentifier("kind"),
        undefined,
        f.createLiteralTypeNode(f.createStringLiteral("point")),
      ),
      f.createPropertySignature(
        undefined,
        f.createIdentifier("x"),
        undefined,
        f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      ),
    ]);

    expect(
      generator.generateSchemaFromSyntheticTypeNode(synthObj, checker),
    ).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", const: "point" }, // const, not enum
        x: { type: "number" },
      },
      required: ["kind", "x"],
    });
  });
});
