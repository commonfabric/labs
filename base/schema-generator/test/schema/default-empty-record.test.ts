/** Checks default extraction from aliased records through both formatters. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("default-empty-record", () => {
  for (const form of ["union member", "two arguments"]) {
    describe(form, () => {
      for (
        const value of [
          "{}",
          "Record<string, never>",
          "Record<number, never>",
          "Record<symbol, never>",
          "Record<PropertyKey, never>",
          "Record<string, never> & Record<number, never>",
          "{ [K in PropertyKey]: never }",
          "{ [key: string]: never }",
        ]
      ) {
        it(`emits an empty object default for an alias of \`${value}\``, async () => {
          const wrapped = form === "union member"
            ? "Record<string, unknown> | Default<Value>"
            : "Default<Record<string, unknown>, Value>";
          const { type, checker, typeNode } = await getTypeFromCode(
            `
            interface Default<T, V extends T = T> {}
            type Original = ${value};
            type Value = Original;
            type SchemaRoot = ${wrapped};
            `,
            "SchemaRoot",
          );
          const schema = asObjectSchema(
            new SchemaGenerator().generateSchema(type, checker, typeNode),
          );

          expect(schema.default).toEqual({});
        });
      }

      for (
        const value of [
          "object",
          ...(form === "two arguments"
            ? ["{ (): void }", "{ new (): object }"]
            : []),
          "Record<string, string>",
          "Record<string, unknown>",
          'Record<"required", never>',
          "Record<string, never[]>",
          "Record<string, never> & Record<symbol, string>",
          "true & Record<string, never>",
          "string & Record<string, never>",
          "{ [K in PropertyKey]: K extends string ? never : string }",
        ]
      ) {
        it(`omits the default for an alias of \`${value}\``, async () => {
          const wrapped = form === "union member"
            ? "Record<string, unknown> | Default<Value>"
            : "Default<Record<string, unknown>, Value>";
          const { type, checker, typeNode } = await getTypeFromCode(
            `
            interface Default<T, V extends T = T> {}
            type Value = ${value};
            type SchemaRoot = ${wrapped};
            `,
            "SchemaRoot",
          );
          const schema = asObjectSchema(
            new SchemaGenerator().generateSchema(type, checker, typeNode),
          );

          expect(schema).not.toHaveProperty("default");
        });
      }

      it("omits primitive-intersection defaults without boxed primitive members", () => {
        // A custom type library need not declare `Boolean.valueOf`. Primitive
        // intersections must be rejected independently of those named members.
        const fileName = "default.ts";
        const wrapped = form === "union member"
          ? "{ [key: string]: unknown } | Default<Value>"
          : "Default<{ [key: string]: unknown }, Value>";
        const sourceFile = ts.createSourceFile(
          fileName,
          `
          interface Array<T> { [index: number]: T; }
          interface Boolean {}
          interface CallableFunction {}
          interface Function {}
          interface IArguments {}
          interface NewableFunction {}
          interface Number {}
          interface Object {}
          interface RegExp {}
          interface String {}
          interface Default<T, V extends T = T> {}
          type Value = true & { [key: string]: never };
          type SchemaRoot = ${wrapped};
          `,
          ts.ScriptTarget.ES2023,
          true,
        );
        const options: ts.CompilerOptions = { noLib: true, strict: true };
        const host = ts.createCompilerHost(options);
        host.getSourceFile = (name) =>
          name === fileName ? sourceFile : undefined;
        const program = ts.createProgram([fileName], options, host);
        expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
        const checker = program.getTypeChecker();
        const root = sourceFile.statements.find((node) =>
          ts.isTypeAliasDeclaration(node) && node.name.text === "SchemaRoot"
        );
        if (!root || !ts.isTypeAliasDeclaration(root)) {
          throw new Error("SchemaRoot type alias is missing");
        }
        const schema = asObjectSchema(
          new SchemaGenerator().generateSchema(
            checker.getTypeFromTypeNode(root.type),
            checker,
            root.type,
          ),
        );

        expect(schema).not.toHaveProperty("default");
      });
    });
  }

  it("emits an empty object default for an aliased `typeof` value", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
      interface Default<T, V extends T = T> {}
      const emptyObject = {};
      type EmptyObject = typeof emptyObject;
      type SchemaRoot = Default<Record<string, unknown>, EmptyObject>;
      `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );
    expect(schema.default).toEqual({});
  });
});
