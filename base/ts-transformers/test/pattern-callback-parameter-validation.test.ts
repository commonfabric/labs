import { assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { CrossStageState } from "../src/core/mod.ts";
import { PatternContextValidationTransformer } from "../src/transformers/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateSource } from "./utils.ts";

const AUTHORED_SECOND_PARAMETER = "pattern-callback:authored-second-parameter";
const AUTHORED_REST_INPUT = "pattern-callback:authored-rest-input";

async function secondParameterDiagnostics(
  callback: string,
): Promise<readonly TransformationDiagnostic[]> {
  const { diagnostics } = await validateSource(
    `
    import { pattern } from "commonfabric";

    export default pattern(${callback});
  `,
    {
      types: COMMONFABRIC_TYPES,
    },
  );

  return diagnostics.filter((diagnostic) =>
    diagnostic.type === AUTHORED_SECOND_PARAMETER
  );
}

function validateCompilerOutput(
  source: string,
): readonly TransformationDiagnostic[] {
  // validateSource() deliberately rejects authored uses of the reserved
  // __cfHelpers binding. Drive this validation stage directly to model IR
  // that an earlier compiler stage has already generated.
  const fileName = "/test.tsx";
  const typeFileName = "/commonfabric.d.ts";
  const files = new Map<string, string>([
    [fileName, source],
    [typeFileName, COMMONFABRIC_TYPES["commonfabric.d.ts"]!],
  ]);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2020,
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (name) => files.has(name);
  host.readFile = (name) => files.get(name);
  host.getSourceFile = (name, languageVersion) => {
    const text = files.get(name);
    return text === undefined
      ? undefined
      : ts.createSourceFile(name, text, languageVersion, true);
  };
  host.resolveModuleNames = (names) =>
    names.map((name) =>
      name === "commonfabric"
        ? {
          resolvedFileName: typeFileName,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        }
        : undefined
    );

  const program = ts.createProgram(
    [fileName, typeFileName],
    options,
    host,
  );
  const sourceFile = program.getSourceFile(fileName)!;
  const diagnosticsCollector: TransformationDiagnostic[] = [];
  const result = ts.transform(sourceFile, [
    new PatternContextValidationTransformer({
      diagnosticsCollector,
      state: new CrossStageState(),
    }).toFactory(program),
  ]);
  result.dispose();
  return diagnosticsCollector;
}

Deno.test("pattern callback rejects an authored required second parameter", async () => {
  const diagnostics = await secondParameterDiagnostics(
    `(input: any, params: any) => ({ input, params })`,
  );

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.line, 5);
  assertStringIncludes(diagnostics[0]!.message, "argument 1");
  assertStringIncludes(diagnostics[0]!.message, "compiler-generated");
});

Deno.test("pattern callback rejects an authored defaulted second parameter", async () => {
  const diagnostics = await secondParameterDiagnostics(
    `(input: any, params: any = {}) => ({ input, params })`,
  );

  assertEquals(diagnostics.length, 1);
});

Deno.test("pattern callback rejects an authored rest second parameter", async () => {
  const diagnostics = await secondParameterDiagnostics(
    `(input: any, ...params: any[]) => ({ input, params })`,
  );

  assertEquals(diagnostics.length, 1);
});

Deno.test("pattern callback rejects a rest public-input parameter", async () => {
  const { diagnostics } = await validateSource(
    `
    import { pattern } from "commonfabric";
    const prefix = "prefix";

    export default pattern(() => ({
      child: pattern((...args: [{ value: string }]) => ({
        value: args[0].value,
        prefix,
      })),
    }));
  `,
    { types: COMMONFABRIC_TYPES },
  );
  const matches = diagnostics.filter((diagnostic) =>
    diagnostic.type === AUTHORED_REST_INPUT
  );

  assertEquals(matches.length, 1);
  assertStringIncludes(matches[0]!.message, "argument 0");
  assertStringIncludes(matches[0]!.message, "rest parameter");
});

Deno.test("pattern callback rejects an as-any alias escape", async () => {
  const { diagnostics } = await validateSource(
    `
    import { pattern } from "commonfabric";

    const callback = (input: any, params: any = {}) => ({ input, params });
    export default pattern(callback as any);
  `,
    {
      types: COMMONFABRIC_TYPES,
    },
  );

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === AUTHORED_SECOND_PARAMETER
    ).length,
    1,
  );
});

Deno.test("compiler params-schema carrier may wrap a two-parameter callback", () => {
  const diagnostics = validateCompilerOutput(`
    import { __cfHelpers, pattern } from "commonfabric";
    export default pattern(
      __cfHelpers.withPatternParamsSchema(
        (argument: any, params: any) => ({ argument, params }),
        { type: "object", properties: {} },
      ) as any,
    );
  `);

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === AUTHORED_SECOND_PARAMETER
    ).length,
    0,
  );
});
