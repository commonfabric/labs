import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { CrossStageState } from "../src/core/mod.ts";
import {
  PatternCallbackLoweringTransformer,
  SchemaInjectionTransformer,
} from "../src/mod.ts";
import { ReactiveVariableForTransformer } from "../src/transformers/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { registerTrustedCommonFabricTestSources } from "./trusted-commonfabric-sources.ts";

interface SourceTransformer {
  toFactory(program: ts.Program): ts.TransformerFactory<ts.SourceFile>;
}

function transformWith(
  source: string,
  createTransformers: (state: CrossStageState) => SourceTransformer[],
): string {
  const fileName = "/test.tsx";
  const declarationName = "/commonfabric.d.ts";
  const files: Record<string, string> = {
    [fileName]: source,
    [declarationName]: COMMONFABRIC_TYPES["commonfabric.d.ts"],
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      files[name] === undefined ? undefined : ts.createSourceFile(
        name,
        files[name],
        languageVersion,
        true,
        name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) =>
        name === "commonfabric"
          ? {
            resolvedFileName: declarationName,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          }
          : undefined
      ),
  };
  const program = ts.createProgram([fileName, declarationName], options, host);
  registerTrustedCommonFabricTestSources(program, [declarationName]);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error("Expected source file");

  const transformers = createTransformers(new CrossStageState()).map((item) =>
    item.toFactory(program)
  );
  const result = ts.transform(sourceFile, transformers);
  const output = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
  }).printFile(result.transformed[0]!);
  result.dispose();
  return output;
}

function findPatternCall(source: string): ts.CallExpression {
  const sourceFile = ts.createSourceFile(
    "/output.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found && ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "pattern"
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error("Expected pattern call");
  return found;
}

function getCarrier(patternCall: ts.CallExpression): ts.CallExpression {
  const argument = patternCall.arguments[0];
  assert(argument && ts.isCallExpression(argument));
  assert(ts.isPropertyAccessExpression(argument.expression));
  assertEquals(argument.expression.name.text, "withPatternParamsSchema");
  return argument;
}

const WRAPPED_PATTERN = `
  import { __cfHelpers, pattern } from "commonfabric";
  const paramsSchema = { type: "object", properties: {
    offset: { type: "number" },
  }, required: ["offset"] } as const;
  export default pattern(__cfHelpers.withPatternParamsSchema(
    (input: { value: number }, params: { offset: number }) => ({
      value: input.value + params.offset,
    }),
    paramsSchema,
  ));
`;

const WRAPPED_REACTIVE_PATTERN = WRAPPED_PATTERN
  .replace(
    "import { __cfHelpers, pattern }",
    "import { __cfHelpers, computed, pattern }",
  )
  .replace(
    "value: input.value + params.offset",
    "value: computed(() => input.value + params.offset)",
  );

Deno.test("pattern callback lowering transforms through and preserves the params-schema carrier", () => {
  const output = transformWith(WRAPPED_PATTERN, (state) => [
    new PatternCallbackLoweringTransformer({ state }),
  ]);

  const carrier = getCarrier(findPatternCall(output));
  assertEquals(carrier.arguments.length, 2);
  assert(carrier.arguments[0] && ts.isArrowFunction(carrier.arguments[0]));
  assert(output.includes('input.key("value")'), output);
  assertEquals(carrier.arguments[1]?.getText(), "paramsSchema");
});

Deno.test("pattern schema injection reads through and preserves the params-schema carrier", () => {
  const output = transformWith(WRAPPED_PATTERN, (state) => [
    new SchemaInjectionTransformer({ state }),
  ]);

  const patternCall = findPatternCall(output);
  assertEquals(patternCall.arguments.length, 3);
  const carrier = getCarrier(patternCall);
  assertEquals(carrier.arguments.length, 2);
  assertEquals(carrier.arguments[1]?.getText(), "paramsSchema");
});

Deno.test("reactive cause traversal enters a params-schema-wrapped pattern callback", () => {
  const output = transformWith(WRAPPED_REACTIVE_PATTERN, (state) => [
    new ReactiveVariableForTransformer({ state }),
  ]);

  const patternCall = findPatternCall(output);
  getCarrier(patternCall);
  assert(
    output.includes('.for(["__patternResult", "value"], true)'),
    output,
  );
});
