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
    ];

    for (const [description, expression, expected] of cases) {
      it(description, async () => {
        const code = `
          type Brand = string & { topic: unknown };
          type Folded = (string & { a: 1 }) | (number & { b: 2 });
          type A = { a: 1 };
          type B = { b: 2 };
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
});
