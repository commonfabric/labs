import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import type { JSONSchema } from "@commonfabric/api";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgram } from "./utils.ts";

/** The schema both paths give an intersection they merge but cannot support. */
const UNSUPPORTED_NON_OBJECT: JSONSchema = {
  type: "object",
  additionalProperties: true,
  $comment: "Unsupported intersection pattern: non-object constituent",
};

describe("SchemaGenerator", () => {
  describe("intersection source types", () => {
    const cases: [string, string, JSONSchema][] = [
      [
        "returns `true` for an opaque cell beside `any` and `string`",
        "any & OpaqueCell<any> & string & unknown",
        true,
      ],
      [
        "returns `false` for an opaque cell beside `any` and `undefined`",
        "any & OpaqueCell<any> & undefined & unknown",
        false,
      ],
      [
        "returns `false` for `void` beside `any` and `string`",
        "any & void & string & unknown",
        false,
      ],
      [
        "returns `true` for `void` beside `any` and `undefined`",
        "any & void & undefined & unknown",
        true,
      ],
      [
        "returns `false` for a named `void` beside `any` and `string`",
        "any & VoidAlias & string & unknown",
        false,
      ],
      [
        "returns `false` when opaque and void parts precede `undefined`",
        "any & OpaqueCell<any> & void & undefined & unknown",
        false,
      ],
      [
        "returns `false` when void and opaque parts precede `undefined`",
        "any & void & OpaqueCell<any> & undefined & unknown",
        false,
      ],
      [
        "returns `true` with an opaque-or-void union beside `any`",
        "any & (OpaqueCell<any> | void) & string & unknown",
        true,
      ],
      [
        "returns `true` with a void-or-opaque union beside `any`",
        "any & (void | OpaqueCell<any>) & string & unknown",
        true,
      ],
      [
        "returns `false` for contradictory flat branded primitives",
        "any & string & { topic: unknown } & number",
        false,
      ],
      [
        "returns `false` for contradictory nested branded primitives",
        "any & (string & { topic: unknown }) & number",
        false,
      ],
      [
        "returns `false` for contradictory named branded primitives",
        "any & Brand & number & unknown",
        false,
      ],
      [
        "returns `false` for a nested contradiction without `any`",
        "(string & { topic: unknown }) & number",
        false,
      ],
      [
        "returns `true` for compatible nested branded primitives beside `any`",
        "any & (string & { topic: unknown }) & string",
        true,
      ],
      [
        "returns `true` after an inner intersection reduces to `any`",
        "(any & null) & string & unknown",
        true,
      ],
      [
        "returns `false` for contradictory branded primitives within a union",
        "(Brand | number) & boolean & unknown",
        false,
      ],
      [
        "returns `true` with a branded primitive union beside `any`",
        "any & (Brand | number) & boolean & unknown",
        true,
      ],
      // Two branded primitives emit one fallback, so their union folds to it;
      // an intersection meeting the survivor still reads both arms.
      [
        "returns `true` when `any` meets a union whose arms fold to one fallback",
        "any & Folded & number",
        true,
      ],
      [
        "keeps the arm a union folded away when the other arm is refused",
        "Folded & number",
        UNSUPPORTED_NON_OBJECT,
      ],
      [
        "returns `true` when `any` meets a union the node path folded",
        "any & (((string & A) | (number & B)) & unknown) & number",
        true,
      ],
      [
        "keeps the arm the node path folded away when the other arm is refused",
        "(((string & A) | (number & B)) & unknown) & number",
        UNSUPPORTED_NON_OBJECT,
      ],
      [
        "returns `false` for disjoint folded unions with string literals first",
        '((("a" & A) | ("b" & B)) & unknown) & (((1 & C) | (2 & D)) & unknown)',
        false,
      ],
      [
        "returns `false` for disjoint folded unions with numeric literals first",
        '(((1 & C) | (2 & D)) & unknown) & ((("a" & A) | ("b" & B)) & unknown)',
        false,
      ],
    ];

    for (const [description, expression, expected] of cases) {
      it(description, async () => {
        const code = `
          type Brand = string & { topic: unknown };
          type Folded = (string & { a: 1 }) | (number & { b: 2 });
          type A = { a: 1 };
          type B = { b: 2 };
          type C = { c: 3 };
          type D = { d: 4 };
          type VoidAlias = void;
          type Result = ${expression};
        `;
        const { checker, program, sourceFile } = await createTestProgram(code);
        expect(program.getSemanticDiagnostics(sourceFile)).toEqual([]);
        const declaration = sourceFile.statements.find((statement) =>
          ts.isTypeAliasDeclaration(statement) &&
          statement.name.text === "Result"
        );
        if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
          throw new Error("Missing `Result` declaration");
        }
        const type = checker.getTypeFromTypeNode(declaration.type);
        expect(new SchemaGenerator().generateSchema(type, checker)).toEqual(
          expected,
        );

        // The separate syntax tree has no checker bindings; names resolve in
        // the authored file, as they do for transformer-created type nodes.
        const syntheticFile = ts.createSourceFile(
          "synthetic.ts",
          `type Result = ${expression};`,
          ts.ScriptTarget.Latest,
          true,
        );
        const synthetic = syntheticFile.statements[0];
        if (!synthetic || !ts.isTypeAliasDeclaration(synthetic)) {
          throw new Error("Missing synthetic `Result` declaration");
        }
        expect(new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
          synthetic.type,
          checker,
          undefined,
          undefined,
          sourceFile,
        )).toEqual(expected);
      });
    }
  });

  describe("properties several intersection constituents declare", () => {
    // Each case declares `M1` and `M2`, and reads `M1 & M2` by its type and
    // as a type node with no checker bindings, whose constituents are read
    // through their names.

    const conflictComment =
      "Conflicting docs across intersection constituents; using first";
    const cases: [string, string, JSONSchema][] = [
      [
        "returns the narrower schema for `unknown` beside `string`",
        `type M1 = { a: unknown }; type M2 = { a: string };`,
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      [
        "returns the narrower schema for `string` beside `unknown`",
        `type M1 = { a: string }; type M2 = { a: unknown };`,
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      [
        "returns the union member the other declaration narrows to",
        `type M1 = { a: string | number }; type M2 = { a: string };`,
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      [
        "returns `false` for disjoint declarations",
        `type M1 = { a: string }; type M2 = { a: number };`,
        { type: "object", properties: { a: false }, required: ["a"] },
      ],
      [
        "returns the merged members of object-typed declarations",
        `type M1 = { a: { x: unknown } }; type M2 = { a: { x: string; y: number } };`,
        {
          type: "object",
          properties: {
            a: {
              type: "object",
              properties: { x: { type: "string" }, y: { type: "number" } },
              required: ["x", "y"],
            },
          },
          required: ["a"],
        },
      ],
      [
        "lists the property in `required` when one declaration requires it",
        `type M1 = { a?: string }; type M2 = { a: string };`,
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      [
        "keeps the first declaration's description beside a narrower declaration",
        `
          interface M1 {
            /** First doc */
            a: unknown;
          }
          interface M2 {
            /** Second doc */
            a: string;
          }
        `,
        {
          type: "object",
          properties: {
            a: {
              type: "string",
              description: "First doc",
              $comment: conflictComment,
            },
          },
          required: ["a"],
        },
      ],
      [
        "keeps the first of two descriptions on declarations of one type",
        `
          interface M1 {
            /** First doc */
            a: string;
          }
          interface M2 {
            /** Second doc */
            a: string;
          }
        `,
        {
          type: "object",
          properties: {
            a: {
              type: "string",
              description: "First doc",
              $comment: conflictComment,
            },
          },
          required: ["a"],
        },
      ],
      // A documented branded primitive emits the unsupported-pattern
      // fallback, whose constituents are recorded; read without its
      // description, it still meets `number` as `string` would.
      [
        "returns `false` for a documented branded declaration beside a disjoint one",
        `
          interface M1 {
            /** Branded doc */
            a: string & { topic: unknown };
          }
          interface M2 {
            a: number;
          }
        `,
        { type: "object", properties: { a: false }, required: ["a"] },
      ],
    ];

    for (const [description, declarations, expected] of cases) {
      it(description, async () => {
        const code = `${declarations}\ntype Result = M1 & M2;`;
        const { checker, program, sourceFile } = await createTestProgram(code);
        expect(program.getSemanticDiagnostics(sourceFile)).toEqual([]);
        const declaration = sourceFile.statements.find((statement) =>
          ts.isTypeAliasDeclaration(statement) &&
          statement.name.text === "Result"
        );
        if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
          throw new Error("Missing `Result` declaration");
        }
        const type = checker.getTypeFromTypeNode(declaration.type);
        expect(new SchemaGenerator().generateSchema(type, checker)).toEqual(
          expected,
        );

        const syntheticFile = ts.createSourceFile(
          "synthetic.ts",
          `type Result = M1 & M2;`,
          ts.ScriptTarget.Latest,
          true,
        );
        const synthetic = syntheticFile.statements[0];
        if (!synthetic || !ts.isTypeAliasDeclaration(synthetic)) {
          throw new Error("Missing synthetic `Result` declaration");
        }
        expect(new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
          synthetic.type,
          checker,
          undefined,
          undefined,
          sourceFile,
        )).toEqual(expected);
      });
    }

    it("returns a union with `undefined` for an optional declaration beside `string | undefined`", async () => {
      // An optional declaration admits `undefined` as its `?` does, so the
      // property that declaration and `string | undefined` share admits it
      // too. The node path spells the union it settles as `anyOf`.

      const { checker, sourceFile } = await createTestProgram(`
        type M1 = { a: string | undefined };
        type M2 = { a?: string };
      `);
      const syntheticFile = ts.createSourceFile(
        "synthetic.ts",
        `type Result = M1 & M2;`,
        ts.ScriptTarget.Latest,
        true,
      );
      const synthetic = syntheticFile.statements[0] as ts.TypeAliasDeclaration;

      expect(new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
        synthetic.type,
        checker,
        undefined,
        undefined,
        sourceFile,
      )).toEqual({
        type: "object",
        properties: {
          a: { anyOf: [{ type: "string" }, { type: "undefined" }] },
        },
        required: ["a"],
      });
    });
  });
});
