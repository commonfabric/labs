import { assertEquals, assertStrictEquals } from "@std/assert";
import ts from "typescript";

import { TransformationContext } from "../src/core/context.ts";
import { generateToSchemaValue } from "../src/transformers/schema-generator.ts";

const FILE_NAME = "/test.ts";
const SOURCE = `
export type CommuteMode = "drive" | "transit" | "bike";
declare function toSchema<T>(): unknown;
const schema = toSchema<{}>();
`;

function createProgram(): ts.Program {
  const options: ts.CompilerOptions = {
    noLib: true,
    strict: true,
    target: ts.ScriptTarget.ES2020,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) =>
      fileName === FILE_NAME
        ? ts.createSourceFile(
          fileName,
          SOURCE,
          options.target!,
          true,
          ts.ScriptKind.TS,
        )
        : undefined,
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (fileName) => fileName === FILE_NAME,
    readFile: (fileName) => fileName === FILE_NAME ? SOURCE : undefined,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };
  return ts.createProgram([FILE_NAME], options, host);
}

function syntheticSchemaCall(factory: ts.NodeFactory): ts.CallExpression {
  const paramsType = factory.createTypeLiteralNode([
    factory.createPropertySignature(
      undefined,
      "editCommuteMode",
      undefined,
      factory.createTypeReferenceNode("CommuteMode"),
    ),
  ]);
  return factory.createCallExpression(
    factory.createIdentifier("toSchema"),
    [paramsType],
    [],
  );
}

Deno.test("synthetic schema generation uses the program's canonical source", () => {
  const program = createProgram();
  const canonicalSource = program.getSourceFile(FILE_NAME)!;
  const transformedSource = ts.createSourceFile(
    FILE_NAME,
    SOURCE,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );

  let schemaSource: ts.SourceFile | undefined;
  ts.transform(transformedSource, [
    (tsContext) => (root) => {
      const schemaTransformer = {
        generateSchemaFromSyntheticTypeNode(
          _typeNode: ts.TypeNode,
          _checker: ts.TypeChecker,
          _typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
          _schemaHints: unknown,
          sourceFile: ts.SourceFile | undefined,
        ) {
          schemaSource = sourceFile;
          return true;
        },
      } as NonNullable<Parameters<typeof generateToSchemaValue>[2]>;
      generateToSchemaValue(
        syntheticSchemaCall(tsContext.factory),
        new TransformationContext({
          program,
          sourceFile: transformedSource,
          tsContext,
        }),
        schemaTransformer,
      );
      return root;
    },
  ]).dispose();

  assertStrictEquals(schemaSource, canonicalSource);
});

Deno.test("synthetic schemas resolve local definitions from the program source", () => {
  const program = createProgram();
  // Transformer stages rebuild the working SourceFile. It still has the same
  // file name and declarations, but it is not the SourceFile bound into the
  // Program and therefore has no checker-owned symbols.
  const transformedSource = ts.createSourceFile(
    FILE_NAME,
    SOURCE,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );

  let generated: ReturnType<typeof generateToSchemaValue> | undefined;
  ts.transform(transformedSource, [
    (tsContext) => (root) => {
      generated = generateToSchemaValue(
        syntheticSchemaCall(tsContext.factory),
        new TransformationContext({
          program,
          sourceFile: transformedSource,
          tsContext,
        }),
      );
      return root;
    },
  ]).dispose();

  assertEquals(generated, {
    resolved: true,
    value: {
      type: "object",
      properties: {
        editCommuteMode: { $ref: "#/$defs/CommuteMode" },
      },
      required: ["editCommuteMode"],
      $defs: {
        CommuteMode: { enum: ["drive", "transit", "bike"] },
      },
    },
  });
});
