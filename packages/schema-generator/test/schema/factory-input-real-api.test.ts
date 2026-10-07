import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import ts from "typescript";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema } from "../utils.ts";

const REPO_ROOT = fromFileUrl(new URL("../../../../", import.meta.url));
const TEST_FILE = join(REPO_ROOT, "__schema_factory_input_real_api_test.ts");
const DEEP_FREEZE_STUB = join(
  REPO_ROOT,
  "__schema_factory_input_deep_freeze.d.ts",
);
const DATA_MODEL_API = join(REPO_ROOT, "packages/data-model/src/api.ts");

/**
 * The workspace specifiers `packages/api/index.ts` names, resolved by hand
 * because this program compiles without an import map. The
 * `@commonfabric/data-model` barrel is reached for one value, `deepFreeze()`
 * in `packages/api/cfc.ts`, which no part of the surface under test calls, so
 * a stub declaring just that function stands in for the whole module; the
 * fabric value declarations are part of that surface, so they resolve to the
 * real module.
 */
const WORKSPACE_MODULES: ReadonlyMap<string, ts.ResolvedModuleFull> = new Map([
  ["@commonfabric/data-model", {
    resolvedFileName: DEEP_FREEZE_STUB,
    extension: ts.Extension.Dts,
    isExternalLibraryImport: false,
  }],
  ["@commonfabric/data-model/api", {
    resolvedFileName: DATA_MODEL_API,
    extension: ts.Extension.Ts,
    isExternalLibraryImport: false,
  }],
]);

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    if (diagnostic.file && diagnostic.start !== undefined) {
      const position = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      return `${diagnostic.file.fileName}:${position.line + 1}:${
        position.character + 1
      }: ${message}`;
    }
    return message;
  }).join("\n");
}

function getTypeFromRealApiCode(
  code: string,
  typeName: string,
): {
  type: ts.Type;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    strictNullChecks: true,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  };

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const virtualFiles = new Map([
    [TEST_FILE, code],
    [
      DEEP_FREEZE_STUB,
      "export declare function deepFreeze<T>(value: T): T;",
    ],
  ]);

  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const virtualSource = virtualFiles.get(fileName);
    if (virtualSource !== undefined) {
      return ts.createSourceFile(
        fileName,
        virtualSource,
        languageVersion,
        true,
      );
    }
    return originalGetSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  host.fileExists = (fileName) =>
    virtualFiles.has(fileName) || originalFileExists(fileName);
  host.readFile = (fileName) =>
    virtualFiles.get(fileName) ?? originalReadFile(fileName);
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      const workspaceModule = WORKSPACE_MODULES.get(moduleName);
      if (workspaceModule !== undefined) {
        return workspaceModule;
      }
      return ts.resolveModuleName(
        moduleName,
        containingFile,
        compilerOptions,
        host,
      ).resolvedModule;
    });

  const program = ts.createProgram([TEST_FILE], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const errors = diagnostics.filter((diagnostic) =>
    diagnostic.category === ts.DiagnosticCategory.Error
  );
  if (errors.length > 0) {
    throw new Error(formatDiagnostics(errors));
  }

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(TEST_FILE);
  if (!sourceFile) {
    throw new Error(`Test source file not found`);
  }

  let foundType: ts.Type | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) {
        foundType = checker.getDeclaredTypeOfSymbol(symbol);
      }
    }
  });
  if (!foundType) {
    throw new Error(`Type ${typeName} not found`);
  }

  return { type: foundType, checker, sourceFile };
}

describe("Schema: real API FactoryInput", () => {
  it("formats the public FactoryInput alias after TypeScript expands it", () => {
    const code = `
      import type {
        FactoryInput,
        Reactive,
        Stream,
      } from "./packages/api/index.ts";

      interface LLMState {
        pending: boolean;
        result?: string;
        error: unknown;
        cancelGeneration: Stream<void>;
      }

      interface SchemaRoot {
        state: FactoryInput<Reactive<LLMState>>;
      }
    `;
    const { type, checker, sourceFile } = getTypeFromRealApiCode(
      code,
      "SchemaRoot",
    );
    const gen = new SchemaGenerator();
    const result = asObjectSchema(
      gen.generateSchema(
        type,
        checker,
        undefined,
        undefined,
        undefined,
        sourceFile,
      ),
    );

    const properties = result.properties as Record<string, unknown>;
    expect(properties.state).toEqual({
      $ref: "#/$defs/LLMState",
      asCell: ["opaque"],
    });

    const defs = result.$defs as Record<string, unknown>;
    const llmState = defs.LLMState as { properties?: Record<string, unknown> };
    expect(llmState.properties?.cancelGeneration).toEqual({
      asCell: ["stream", "opaque"],
    });
  });

  it("formats direct streaming results without traversing fabric error internals", () => {
    const code = `
      import type {
        AsyncStreamResult,
      } from "./packages/api/index.ts";

      interface SchemaRoot {
        result: AsyncStreamResult<{ title: string }, string>;
      }
    `;
    const { type, checker, sourceFile } = getTypeFromRealApiCode(
      code,
      "SchemaRoot",
    );
    const gen = new SchemaGenerator();

    expect(() =>
      gen.generateSchema(
        type,
        checker,
        undefined,
        undefined,
        undefined,
        sourceFile,
      )
    ).not.toThrow();
  });
});
