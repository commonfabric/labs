import { assert } from "@std/assert";
import { dirname, join } from "@std/path";

import { StaticCache } from "@commonfabric/static";
import ts from "typescript";

import {
  CommonFabricTransformerPipeline,
  CrossStageState,
  TransformationDiagnostic,
  transformCfDirective,
} from "../src/mod.ts";

const ENV_TYPE_ENTRIES = ["es2023", "dom", "jsx"] as const;

type EnvTypeKey = (typeof ENV_TYPE_ENTRIES)[number];
let envTypesCache: Record<EnvTypeKey, string> | undefined;
let sourceFileCache: Map<string, ts.SourceFile> | undefined;

export interface TransformOptions {
  types?: Record<string, string>;
  typeCheck?: boolean;
  precomputedDiagnostics?: ts.Diagnostic[];

  /** If provided, pipeline diagnostics will be pushed into this array after transformation. */
  pipelineDiagnostics?: TransformationDiagnostic[];

  moduleIdentities?: ReadonlyMap<string, string>;
  policyManifests?: unknown[];
  state?: CrossStageState;
  assertDiagnostics?: boolean;
  canonicalWriterIdentityFile?: (fileName: string) => string;

  /** Compiles as a reload of durable stored source (`storedSource`). */
  storedSource?: boolean;
}

export interface BatchTypeCheckResult {
  /** Diagnostics grouped by file path */
  diagnosticsByFile: Map<string, ts.Diagnostic[]>;

  /** The TypeScript program used for type-checking (for debugging) */
  program: ts.Program;
}

/**
 * Batch type-checks multiple fixture files in a single TypeScript program.
 * This is much faster than creating separate programs for each fixture.
 *
 * @param files - Map of file paths to source code content
 * @param options - Configuration including type definitions
 * @returns Diagnostics grouped by input file
 */
export async function batchTypeCheckFixtures(
  files: Record<string, string>,
  options: { types?: Record<string, string> } = {},
): Promise<BatchTypeCheckResult> {
  const { types = {} } = options;

  if (!envTypesCache) {
    envTypesCache = await loadEnvironmentTypes();
  }
  if (!sourceFileCache) {
    sourceFileCache = new Map();
  }

  // Apply transformCfDirective to all input files (like transformFiles does)
  const transformedFiles = Object.entries(files).reduce((acc, [key, value]) => {
    acc[key] = transformCfDirective(value);
    return acc;
  }, {} as Record<string, string>);

  // JSX emit and module kind mirror the js-compiler's getCompilerOptions()
  // (packages/js-compiler/typescript/options.ts) so the factory bindings match
  // production; the target and strictness flags below are the harness's own.
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "__cfHelpers.h",
    jsxFragmentFactory: "__cfHelpers.h.fragment",
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    strictBindCallApply: true,
    strictPropertyInitialization: true,
    noImplicitThis: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
  };

  // Merge environment types and custom types
  const allTypes: Record<string, string> = {
    ...types,
  };

  // Add environment types with .d.ts extension
  for (const [key, value] of Object.entries(envTypesCache)) {
    allTypes[`${key}.d.ts`] = value;
  }

  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      // Check cache first for type definition files
      const isTypeDefFile = !transformedFiles[name] && (
        name === "lib.d.ts" ||
        name.endsWith("/lib.d.ts") ||
        allTypes[name] ||
        (baseNameFromPath(name) && allTypes[baseNameFromPath(name)!])
      );

      if (isTypeDefFile && sourceFileCache!.has(name)) {
        return sourceFileCache!.get(name);
      }

      // Determine source text
      let sourceText: string | undefined;

      if (transformedFiles[name] !== undefined) {
        sourceText = transformedFiles[name];
      } else if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        sourceText = allTypes["es2023.d.ts"] || "";
      } else if (allTypes[name]) {
        sourceText = allTypes[name];
      } else {
        const baseName = baseNameFromPath(name);
        if (baseName && allTypes[baseName]) {
          sourceText = allTypes[baseName];
        }
      }

      if (sourceText === undefined) {
        return undefined;
      }

      // Create SourceFile
      const sourceFile = ts.createSourceFile(
        name,
        sourceText,
        compilerOptions.target!,
        true,
      );

      // Cache type definition files (not fixture input files)
      if (isTypeDefFile) {
        sourceFileCache!.set(name, sourceFile);
      }

      return sourceFile;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => {
      if (transformedFiles[name] !== undefined) return true;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) return true;
      if (allTypes[name]) return true;
      const baseName = baseNameFromPath(name);
      if (baseName && allTypes[baseName]) return true;
      return false;
    },
    readFile: (name) => {
      if (transformedFiles[name] !== undefined) return transformedFiles[name];
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return allTypes["es2023.d.ts"];
      }
      if (allTypes[name]) return allTypes[name];
      const baseName = baseNameFromPath(name);
      if (baseName && allTypes[baseName]) return allTypes[baseName];
      return undefined;
    },
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    resolveModuleNames: (moduleNames, containingFile) => {
      return moduleNames.map((name) => {
        if (name === "commonfabric" && types["commonfabric.d.ts"]) {
          return {
            resolvedFileName: "commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "commonfabric/cfc" && types["cfc.ts"]) {
          return {
            resolvedFileName: "cfc.ts",
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }
        if (
          name === "commonfabric/schema" && types["commonfabric-schema.d.ts"]
        ) {
          return {
            resolvedFileName: "commonfabric-schema.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "@commonfabric/common" && types["commonfabric.d.ts"]) {
          return {
            resolvedFileName: "commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "./cfc.ts" && types["cfc.ts"]) {
          return {
            resolvedFileName: "cfc.ts",
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }
        if (name.startsWith(".")) {
          const resolvedFileName = join(dirname(containingFile), name);
          if (transformedFiles[resolvedFileName] !== undefined) {
            return {
              resolvedFileName,
              extension: resolvedFileName.endsWith(".tsx")
                ? ts.Extension.Tsx
                : ts.Extension.Ts,
              isExternalLibraryImport: false,
            };
          }
        }
        return undefined;
      });
    },
    resolveTypeReferenceDirectives: (typeDirectiveNames) =>
      typeDirectiveNames.map((directive) => {
        const name = typeof directive === "string"
          ? directive
          : directive.fileName;
        if (allTypes[name]) {
          return {
            primary: true,
            resolvedFileName: name,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        return undefined;
      }),
  };

  // Include type definition files in the program
  const typeDefFiles = Object.keys(allTypes).filter((name) =>
    name.endsWith(".d.ts")
  );
  const rootFiles = [...Object.keys(transformedFiles), ...typeDefFiles];

  const program = ts.createProgram(rootFiles, compilerOptions, host);

  // Get all diagnostics
  const diagnostics = ts.getPreEmitDiagnostics(program);

  // Filter diagnostics to exclude type definition files
  // Note: Some diagnostics might not have a file (global errors), we keep those as they may be relevant
  const filteredDiagnostics = diagnostics.filter((diagnostic) =>
    !diagnostic.file || // Keep diagnostics without a file
    (!diagnostic.file.fileName.startsWith("$types/") &&
      !diagnostic.file.fileName.endsWith(".d.ts"))
  );

  // Initialize map with empty arrays for all input files
  const diagnosticsByFile = new Map<string, ts.Diagnostic[]>();
  for (const fileName of Object.keys(files)) {
    diagnosticsByFile.set(fileName, []);
  }

  // Group diagnostics by file name
  for (const diagnostic of filteredDiagnostics) {
    if (diagnostic.file) {
      const fileName = diagnostic.file.fileName;
      if (!diagnosticsByFile.has(fileName)) {
        diagnosticsByFile.set(fileName, []);
      }
      diagnosticsByFile.get(fileName)!.push(diagnostic);
    }
  }

  return { diagnosticsByFile, program };
}

export async function transformSource(
  source: string,
  options: TransformOptions = {},
): Promise<string> {
  const fileName = "/test.tsx";
  const output = await transformFiles({ [fileName]: source }, options);
  if (!output[fileName]) {
    throw new Error("Could not generate output.");
  }
  return output[fileName];
}

export async function transformFiles(
  inFiles: Record<string, string>,
  options: TransformOptions = {},
): Promise<Record<string, string>> {
  const {
    types = {},
    typeCheck = false,
  } = options;
  if (!envTypesCache) {
    envTypesCache = await loadEnvironmentTypes();
  }
  if (!sourceFileCache) {
    sourceFileCache = new Map();
  }

  // Pretransform
  const files = Object.entries(inFiles).reduce((files, [key, value]) => {
    files[key] = transformCfDirective(value);
    return files;
  }, {} as Record<string, string>);

  // JSX emit and module kind mirror the js-compiler's getCompilerOptions()
  // (packages/js-compiler/typescript/options.ts) so the factory bindings match
  // production; the target and strictness flags below are the harness's own.
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "__cfHelpers.h",
    jsxFragmentFactory: "__cfHelpers.h.fragment",
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    strictBindCallApply: true,
    strictPropertyInitialization: true,
    noImplicitThis: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
  };

  // Merge environment types and custom types
  // Store environment types with .d.ts extension for consistent TypeScript resolution
  const allTypes: Record<string, string> = {
    ...types,
  };

  // Add environment types with .d.ts extension
  for (const [key, value] of Object.entries(envTypesCache)) {
    allTypes[`${key}.d.ts`] = value;
  }

  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      // Check cache first for type definition files
      const isTypeDefFile = !files[name] && (
        name === "lib.d.ts" ||
        name.endsWith("/lib.d.ts") ||
        allTypes[name] ||
        (baseNameFromPath(name) && allTypes[baseNameFromPath(name)!])
      );

      if (isTypeDefFile && sourceFileCache!.has(name)) {
        return sourceFileCache!.get(name);
      }

      // Determine source text
      let sourceText: string | undefined;

      if (files[name] !== undefined) {
        sourceText = files[name];
      } else if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        sourceText = allTypes["es2023.d.ts"] || "";
      } else if (allTypes[name]) {
        sourceText = allTypes[name];
      } else {
        const baseName = baseNameFromPath(name);
        if (baseName && allTypes[baseName]) {
          sourceText = allTypes[baseName];
        }
      }

      if (sourceText === undefined) {
        return undefined;
      }

      // Create SourceFile
      const sourceFile = ts.createSourceFile(
        name,
        sourceText,
        compilerOptions.target!,
        true,
      );

      // Cache type definition files (not fixture input files)
      if (isTypeDefFile) {
        sourceFileCache!.set(name, sourceFile);
      }

      return sourceFile;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => {
      if (files[name] !== undefined) return true;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) return true;
      if (allTypes[name]) return true;
      const baseName = baseNameFromPath(name);
      if (baseName && allTypes[baseName]) return true;
      return false;
    },
    readFile: (name) => {
      if (files[name] !== undefined) return files[name];
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return allTypes["es2023.d.ts"];
      }
      if (allTypes[name]) return allTypes[name];
      const baseName = baseNameFromPath(name);
      if (baseName && allTypes[baseName]) return allTypes[baseName];
      return undefined;
    },
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    resolveModuleNames: (moduleNames, containingFile) => {
      return moduleNames.map((name) => {
        if (name === "commonfabric" && types["commonfabric.d.ts"]) {
          return {
            resolvedFileName: "commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "commonfabric/cfc" && types["cfc.ts"]) {
          return {
            resolvedFileName: "cfc.ts",
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }
        if (
          name === "commonfabric/schema" && types["commonfabric-schema.d.ts"]
        ) {
          return {
            resolvedFileName: "commonfabric-schema.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "@commonfabric/common" && types["commonfabric.d.ts"]) {
          return {
            resolvedFileName: "commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "./cfc.ts" && types["cfc.ts"]) {
          return {
            resolvedFileName: "cfc.ts",
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }
        if (name.startsWith(".")) {
          const resolvedFileName = join(dirname(containingFile), name);
          if (files[resolvedFileName] !== undefined) {
            return {
              resolvedFileName,
              extension: resolvedFileName.endsWith(".tsx")
                ? ts.Extension.Tsx
                : ts.Extension.Ts,
              isExternalLibraryImport: false,
            };
          }
        }
        return undefined;
      });
    },
    resolveTypeReferenceDirectives: (typeDirectiveNames) =>
      typeDirectiveNames.map((directive) => {
        const name = typeof directive === "string"
          ? directive
          : directive.fileName;
        if (allTypes[name]) {
          return {
            primary: true,
            resolvedFileName: name,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        return undefined;
      }),
  };

  // Include type definition files in the program so their global declarations are loaded
  // This is critical for JSX.IntrinsicElements and other global type augmentations
  const typeDefFiles = Object.keys(allTypes).filter((name) =>
    name.endsWith(".d.ts")
  );
  const rootFiles = [...Object.keys(files), ...typeDefFiles];

  const program = ts.createProgram(rootFiles, compilerOptions, host);

  // Type checking - only run diagnostics if needed
  if (typeCheck) {
    // Use precomputed diagnostics if provided, otherwise compute them
    const diagnostics = options.precomputedDiagnostics ??
      ts.getPreEmitDiagnostics(program);

    if (diagnostics.length > 0) {
      // Filter to only input file diagnostics (not from type definition files)
      const inputFileDiagnostics = diagnostics.filter((diagnostic) =>
        diagnostic.file &&
        !diagnostic.file.fileName.startsWith("$types/") &&
        !diagnostic.file.fileName.endsWith(".d.ts")
      );

      if (inputFileDiagnostics.length > 0) {
        const errors: string[] = ["\nInput fixture type checking failed:\n"];
        inputFileDiagnostics.forEach((diagnostic) => {
          if (diagnostic.file && diagnostic.start !== undefined) {
            const { line, character } = diagnostic.file
              .getLineAndCharacterOfPosition(diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n",
            );
            errors.push(
              `  ${diagnostic.file.fileName}:${line + 1}:${character + 1}`,
            );
            errors.push(`    Error TS${diagnostic.code}: ${message}\n`);

            // Show the source line
            const sourceLines = diagnostic.file.text.split("\n");
            if (sourceLines[line]) {
              const lineNumStr = String(line + 1);
              errors.push(`    ${lineNumStr}    ${sourceLines[line]}`);
              errors.push(
                `    ${" ".repeat(lineNumStr.length)}    ${
                  " ".repeat(character)
                }^^^^^\n`,
              );
            }
          } else {
            const message = ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n",
            );
            errors.push(`  Error TS${diagnostic.code}: ${message}\n`);
          }
        });
        errors.push(
          "\nThis input fixture contains invalid Common Fabric code.",
        );
        errors.push("To fix:");
        errors.push(
          "1. Update the input fixture to use valid Common Fabric patterns",
        );
        errors.push(
          "   (e.g., use Cell<T> for mutable state, Reactive<T> for references)",
        );
        errors.push(
          "2. Run with SKIP_INPUT_CHECK=1 to skip validation temporarily",
        );

        throw new Error(errors.join("\n"));
      }
    }
  }

  const pipeline = new CommonFabricTransformerPipeline({
    moduleIdentities: options.moduleIdentities,
    state: options.state,
    assertDiagnostics: options.assertDiagnostics,
    canonicalWriterIdentityFile: options.canonicalWriterIdentityFile,
    storedSource: options.storedSource,
  });

  const out: Record<string, string> = {};
  for (const fileName of Object.keys(files)) {
    const sourceFile = program.getSourceFile(fileName);
    assert(
      sourceFile,
      "Expected virtual source file to be present in program",
    );
    const result = ts.transform(sourceFile, pipeline.toFactories(program));
    const printer = ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    });
    const transformedFile = result.transformed[0];
    assert(
      transformedFile,
      "Expected transformer pipeline to return a source file",
    );
    const output = printer.printFile(transformedFile);
    result.dispose?.();

    out[fileName] = output;
  }
  if (options.pipelineDiagnostics) {
    options.pipelineDiagnostics.push(...pipeline.getDiagnostics());
  }
  if (options.policyManifests) {
    for (const manifests of pipeline.getPolicyManifests().values()) {
      options.policyManifests.push(...manifests);
    }
  }
  return out;
}

/**
 * Validates source code and returns any diagnostics from the transformer pipeline.
 * Unlike transformSource, this function does not throw on errors but returns them.
 */
export async function validateSource(
  source: string,
  options: TransformOptions = {},
): Promise<{
  diagnostics: readonly TransformationDiagnostic[];
  output: string;
}> {
  const fileName = "/test.tsx";
  const result = await validateFiles({ [fileName]: source }, options);
  return {
    diagnostics: result.diagnostics,
    output: result.outputs[fileName] ?? "",
  };
}

/**
 * Validates multiple files and returns diagnostics from the transformer pipeline.
 */
export async function validateFiles(
  inFiles: Record<string, string>,
  options: TransformOptions = {},
): Promise<{
  diagnostics: readonly TransformationDiagnostic[];
  outputs: Record<string, string>;
}> {
  const {
    types = {},
  } = options;
  if (!envTypesCache) {
    envTypesCache = await loadEnvironmentTypes();
  }
  if (!sourceFileCache) {
    sourceFileCache = new Map();
  }

  // Pretransform
  const files = Object.entries(inFiles).reduce((files, [key, value]) => {
    files[key] = transformCfDirective(value);
    return files;
  }, {} as Record<string, string>);

  // JSX emit and module kind mirror the js-compiler's getCompilerOptions()
  // (packages/js-compiler/typescript/options.ts) so the factory bindings match
  // production; the target and strictness flags below are the harness's own.
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "__cfHelpers.h",
    jsxFragmentFactory: "__cfHelpers.h.fragment",
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    strictBindCallApply: true,
    strictPropertyInitialization: true,
    noImplicitThis: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
  };

  // Merge environment types and custom types
  const allTypes: Record<string, string> = {
    ...types,
  };

  // Add environment types with .d.ts extension
  for (const [key, value] of Object.entries(envTypesCache)) {
    allTypes[`${key}.d.ts`] = value;
  }

  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const isTypeDefFile = !files[name] && (
        name === "lib.d.ts" ||
        name.endsWith("/lib.d.ts") ||
        allTypes[name] ||
        (baseNameFromPath(name) && allTypes[baseNameFromPath(name)!])
      );

      if (isTypeDefFile && sourceFileCache!.has(name)) {
        return sourceFileCache!.get(name);
      }

      let sourceText: string | undefined;

      if (files[name] !== undefined) {
        sourceText = files[name];
      } else if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        sourceText = allTypes["es2023.d.ts"] || "";
      } else if (allTypes[name]) {
        sourceText = allTypes[name];
      } else {
        const baseName = baseNameFromPath(name);
        if (baseName && allTypes[baseName]) {
          sourceText = allTypes[baseName];
        }
      }

      if (sourceText === undefined) {
        return undefined;
      }

      const sourceFile = ts.createSourceFile(
        name,
        sourceText,
        compilerOptions.target!,
        true,
      );

      if (isTypeDefFile) {
        sourceFileCache!.set(name, sourceFile);
      }

      return sourceFile;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => {
      if (files[name] !== undefined) return true;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) return true;
      if (allTypes[name]) return true;
      const baseName = baseNameFromPath(name);
      if (baseName && allTypes[baseName]) return true;
      return false;
    },
    readFile: (name) => {
      if (files[name] !== undefined) return files[name];
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return allTypes["es2023.d.ts"];
      }
      if (allTypes[name]) return allTypes[name];
      const baseName = baseNameFromPath(name);
      if (baseName && allTypes[baseName]) return allTypes[baseName];
      return undefined;
    },
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    resolveModuleNames: (moduleNames, containingFile) => {
      return moduleNames.map((name) => {
        if (name === "commonfabric" && types["commonfabric.d.ts"]) {
          return {
            resolvedFileName: "commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "commonfabric/cfc" && types["cfc.ts"]) {
          return {
            resolvedFileName: "cfc.ts",
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "@commonfabric/common" && types["commonfabric.d.ts"]) {
          return {
            resolvedFileName: "commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        if (name === "./cfc.ts" && types["cfc.ts"]) {
          return {
            resolvedFileName: "cfc.ts",
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }
        if (name.startsWith(".")) {
          const resolvedFileName = join(dirname(containingFile), name);
          if (files[resolvedFileName] !== undefined) {
            return {
              resolvedFileName,
              extension: resolvedFileName.endsWith(".tsx")
                ? ts.Extension.Tsx
                : ts.Extension.Ts,
              isExternalLibraryImport: false,
            };
          }
        }
        return undefined;
      });
    },
    resolveTypeReferenceDirectives: (typeDirectiveNames) =>
      typeDirectiveNames.map((directive) => {
        const name = typeof directive === "string"
          ? directive
          : directive.fileName;
        if (allTypes[name]) {
          return {
            primary: true,
            resolvedFileName: name,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        return undefined;
      }),
  };

  const typeDefFiles = Object.keys(allTypes).filter((name) =>
    name.endsWith(".d.ts")
  );
  const rootFiles = [...Object.keys(files), ...typeDefFiles];

  const program = ts.createProgram(rootFiles, compilerOptions, host);
  const pipeline = new CommonFabricTransformerPipeline({
    moduleIdentities: options.moduleIdentities,
    state: options.state,
    assertDiagnostics: options.assertDiagnostics,
    canonicalWriterIdentityFile: options.canonicalWriterIdentityFile,
    storedSource: options.storedSource,
  });

  const outputs: Record<string, string> = {};
  for (const fileName of Object.keys(files)) {
    const sourceFile = program.getSourceFile(fileName);
    assert(
      sourceFile,
      "Expected virtual source file to be present in program",
    );
    const result = ts.transform(sourceFile, pipeline.toFactories(program));
    const printer = ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    });
    const transformedFile = result.transformed[0];
    assert(
      transformedFile,
      "Expected transformer pipeline to return a source file",
    );
    outputs[fileName] = printer.printFile(transformedFile);
    result.dispose?.();
  }

  return {
    diagnostics: pipeline.getDiagnostics(),
    outputs,
  };
}

export async function loadFixture(path: string): Promise<string> {
  const fixturesDir = join(import.meta.dirname!, "fixtures");
  const fullPath = join(fixturesDir, path);
  const text = await Deno.readTextFile(fullPath);
  return text.trim();
}

export async function transformFixture(
  fixturePath: string,
  options?: TransformOptions,
): Promise<string> {
  const source = await loadFixture(fixturePath);
  const out = await transformSource(source, options);
  return out.trim();
}

export async function compareFixtureTransformation(
  inputPath: string,
  expectedPath: string,
  options?: TransformOptions,
): Promise<{ actual: string; expected: string; matches: boolean }> {
  const [actual, expected] = await Promise.all([
    transformFixture(inputPath, options),
    loadFixture(expectedPath),
  ]);

  const actualNormalized = actual.trim();
  const expectedNormalized = expected.trim();

  return {
    actual: actualNormalized,
    expected: expectedNormalized,
    matches: actualNormalized === expectedNormalized,
  };
}

async function loadEnvironmentTypes(): Promise<Record<EnvTypeKey, string>> {
  const cache = StaticCache.fromFileSystem();
  const entries = await Promise.all(
    ENV_TYPE_ENTRIES.map(async (key) =>
      [key, await cache.getText(`types/${key}.d.ts`)] as const
    ),
  );
  return Object.fromEntries(entries) as Record<EnvTypeKey, string>;
}

function baseNameFromPath(path: string): string | undefined {
  const segments = path.split("/");
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}
