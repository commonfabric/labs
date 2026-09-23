import ts from "typescript";
import { StaticCache } from "@commonfabric/static";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { FabricPrimitive } from "@commonfabric/data-model";
import type { JSONSchemaObj } from "@commonfabric/api";

// Cache for TypeScript library definitions
let typeLibsCache: Record<string, string> | undefined;

const CELL_BRAND_PRELUDE = `
declare const CELL_BRAND: unique symbol;

declare interface BrandedCell<T, Brand extends string = "cell"> {
  readonly [CELL_BRAND]: Brand;
}

declare interface OpaqueCell<T> extends BrandedCell<T, "opaque"> {}
declare type Reactive<T> = T;
declare interface Cell<T> extends BrandedCell<T, "cell"> {}
declare type Writable<T> = Cell<T>; // Alias for Cell with clearer write-access semantics
declare const CELL_RESULT_TYPE: unique symbol;
// Mirrors the real \`Stream<E, R = void>\`: a verb's declared result rides a
// second type parameter, pinned by a property so it discriminates. The stub
// carried one parameter long after the real type grew two, which made every
// test here pass regardless of what the api declared.
declare interface Stream<E, R = void> extends BrandedCell<E, "stream"> {
  readonly [CELL_RESULT_TYPE]: R;
}
declare interface ComparableCell<T> extends BrandedCell<T, "comparable"> {}
declare interface ReadonlyCell<T> extends BrandedCell<T, "readonly"> {}
declare interface WriteonlyCell<T> extends BrandedCell<T, "writeonly"> {}
// Mirrors the real handle type: a nominal brand keyed by an exported unique
// symbol, which is what the emitted descriptor is recognized by.
declare const SQLITE_DB_BRAND: unique symbol;
declare type SqliteDatabase = { readonly [SQLITE_DB_BRAND]: true };
declare interface SqliteDb<T = SqliteDatabase>
  extends BrandedCell<T, "sqlite"> {}

declare const SCOPE_BRAND: unique symbol;
declare type PerSpace<T> = T & { readonly [SCOPE_BRAND]?: "space" };
declare type PerUser<T> = T & { readonly [SCOPE_BRAND]?: "user" };
declare type PerSession<T> = T & { readonly [SCOPE_BRAND]?: "session" };
declare type PerAny<T> = T & { readonly [SCOPE_BRAND]?: "any" };
`;

/**
 * The `"commonfabric"` module of a test program: each prelude type exported
 * under its own name, for a test that imports its wrappers rather than using
 * the global declarations.
 */
const COMMONFABRIC_MODULE_PRELUDE = `
declare module "commonfabric" {
  export type BrandedCell<T, Brand extends string = "cell"> =
    globalThis.BrandedCell<T, Brand>;
  export type OpaqueCell<T> = globalThis.OpaqueCell<T>;
  export type Reactive<T> = globalThis.Reactive<T>;
  export type Cell<T> = globalThis.Cell<T>;
  export type Writable<T> = globalThis.Writable<T>;
  export type Stream<E, R = void> = globalThis.Stream<E, R>;
  export type ComparableCell<T> = globalThis.ComparableCell<T>;
  export type ReadonlyCell<T> = globalThis.ReadonlyCell<T>;
  export type WriteonlyCell<T> = globalThis.WriteonlyCell<T>;
  export type SqliteDatabase = globalThis.SqliteDatabase;
  export type SqliteDb<T = SqliteDatabase> = globalThis.SqliteDb<T>;
  export type PerSpace<T> = globalThis.PerSpace<T>;
  export type PerUser<T> = globalThis.PerUser<T>;
  export type PerSession<T> = globalThis.PerSession<T>;
  export type PerAny<T> = globalThis.PerAny<T>;
}
`;

/**
 * The file a test program declares `CELL_BRAND_PRELUDE` in, as global
 * declarations every other file of the program sees, and the
 * `"commonfabric"` module in (`COMMONFABRIC_MODULE_PRELUDE`). It carries the
 * name `isCommonFabricDeclaration()` recognizes, so the prelude's wrappers
 * stand for `commonfabric`'s own, as a wrapper written in a test means them
 * to.
 */
const CELL_BRAND_PRELUDE_FILE = "commonfabric.d.ts";

/** The text of `CELL_BRAND_PRELUDE_FILE`. */
const CELL_BRAND_PRELUDE_FILE_TEXT =
  `${CELL_BRAND_PRELUDE}\n${COMMONFABRIC_MODULE_PRELUDE}`;

/**
 * Load TypeScript environment types (es2023, dom, jsx)
 * Same functionality as js-compiler but implemented independently
 */
async function getTypeScriptEnvironmentTypes(): Promise<
  Record<string, string>
> {
  if (typeLibsCache) {
    return typeLibsCache;
  }

  const cache = StaticCache.fromFileSystem();
  const es2023 = await cache.getText("types/es2023.d.ts");
  const jsx = await cache.getText("types/jsx.d.ts");
  const dom = await cache.getText("types/dom.d.ts");

  typeLibsCache = {
    es2023,
    dom,
    jsx,
  };
  return typeLibsCache;
}

function getLibSourceText(
  name: string,
  typeLibs: Record<string, string>,
): string | undefined {
  if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
    return typeLibs.es2023;
  }

  const libName = name.toLowerCase().replace(".d.ts", "");
  return typeLibs[libName];
}

export async function createTestProgram(
  code: string,
): Promise<
  { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
> {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ES2023,
    true,
  );
  const preludeFile = ts.createSourceFile(
    CELL_BRAND_PRELUDE_FILE,
    CELL_BRAND_PRELUDE_FILE_TEXT,
    ts.ScriptTarget.ES2023,
    true,
  );

  // Load TypeScript library definitions
  const typeLibs = await getTypeScriptEnvironmentTypes();

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === fileName) {
        return sourceFile;
      }
      if (name === CELL_BRAND_PRELUDE_FILE) {
        return preludeFile;
      }

      // Map lib.d.ts requests to es2023 definitions (same as js-compiler)
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return ts.createSourceFile(
          name,
          typeLibs.es2023 || "",
          ts.ScriptTarget.ES2023,
          true,
        );
      }

      // Handle other library files (map case-insensitive)
      const libName = name.toLowerCase().replace(".d.ts", "");
      if (typeLibs[libName]) {
        return ts.createSourceFile(
          name,
          typeLibs[libName],
          ts.ScriptTarget.ES2023,
          true,
        );
      }

      return undefined;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => {
      if (name === fileName || name === CELL_BRAND_PRELUDE_FILE) return true;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) return true;

      // Check library files (case-insensitive)
      const libName = name.toLowerCase().replace(".d.ts", "");
      if (typeLibs[libName]) return true;

      return false;
    },
    readFile: (name) => {
      if (name === fileName) return code;
      if (name === CELL_BRAND_PRELUDE_FILE) return CELL_BRAND_PRELUDE_FILE_TEXT;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return typeLibs.es2023;
      }

      // Handle library files (case-insensitive)
      const libName = name.toLowerCase().replace(".d.ts", "");
      if (typeLibs[libName]) return typeLibs[libName];

      return undefined;
    },
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram([fileName, CELL_BRAND_PRELUDE_FILE], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    // Add proper lib configuration (key difference from broken version)
    lib: ["ES2023", "DOM", "JSX"],
    strict: true,
    strictNullChecks: true,
  }, compilerHost);

  return {
    program,
    checker: program.getTypeChecker(),
    sourceFile: sourceFile!,
  };
}

export async function createTestProgramFromFiles(
  files: Record<string, string>,
  entryFile: string,
): Promise<
  { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
> {
  const normalizePath = (path: string) =>
    path.startsWith("/") ? path : `/${path}`;
  const normalizedEntry = normalizePath(entryFile);
  const filesWithPrelude: Record<string, string> = {
    [normalizePath(CELL_BRAND_PRELUDE_FILE)]: CELL_BRAND_PRELUDE_FILE_TEXT,
  };
  for (const [path, code] of Object.entries(files)) {
    filesWithPrelude[normalizePath(path)] = code;
  }

  const typeLibs = await getTypeScriptEnvironmentTypes();

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    lib: ["ES2023", "DOM", "JSX"],
    strict: true,
    strictNullChecks: true,
  };

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (name) => {
      const normalizedName = normalizePath(name);
      const sourceText = filesWithPrelude[normalizedName] ??
        getLibSourceText(name, typeLibs);
      return sourceText === undefined ? undefined : ts.createSourceFile(
        name,
        sourceText,
        compilerOptions.target!,
        true,
      );
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) =>
      filesWithPrelude[normalizePath(name)] !== undefined ||
      getLibSourceText(name, typeLibs) !== undefined,
    readFile: (name) =>
      filesWithPrelude[normalizePath(name)] ?? getLibSourceText(name, typeLibs),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram(
    Object.keys(filesWithPrelude),
    compilerOptions,
    compilerHost,
  );
  const sourceFile = program.getSourceFile(normalizedEntry);
  if (!sourceFile) {
    throw new Error(`Entry file ${entryFile} not found in test program`);
  }

  return {
    program,
    checker: program.getTypeChecker(),
    sourceFile,
  };
}

export async function getTypeFromCode(
  code: string,
  typeName: string,
): Promise<{ type: ts.Type; checker: ts.TypeChecker; typeNode?: ts.TypeNode }> {
  const { checker, sourceFile } = await createTestProgram(code);

  let foundType: ts.Type | undefined;
  let foundTypeNode: ts.TypeNode | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) foundType = checker.getDeclaredTypeOfSymbol(symbol);
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = checker.getTypeFromTypeNode(node.type);
      foundTypeNode = node.type;
    }
  });

  if (!foundType) throw new Error(`Type ${typeName} not found in code`);
  return foundTypeNode
    ? { type: foundType, checker, typeNode: foundTypeNode }
    : { type: foundType, checker };
}

export async function getTypeFromFiles(
  files: Record<string, string>,
  entryFile: string,
  typeName: string,
): Promise<{ type: ts.Type; checker: ts.TypeChecker; typeNode?: ts.TypeNode }> {
  const { checker, sourceFile } = await createTestProgramFromFiles(
    files,
    entryFile,
  );

  let foundType: ts.Type | undefined;
  let foundTypeNode: ts.TypeNode | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) foundType = checker.getDeclaredTypeOfSymbol(symbol);
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      foundType = checker.getTypeFromTypeNode(node.type);
      foundTypeNode = node.type;
    }
  });

  if (!foundType) throw new Error(`Type ${typeName} not found in code`);
  return foundTypeNode
    ? { type: foundType, checker, typeNode: foundTypeNode }
    : { type: foundType, checker };
}

/**
 * Check TypeScript diagnostics for a code snippet.
 * Returns an array of diagnostic messages, empty if no errors.
 */
export async function checkTypeErrors(code: string): Promise<ts.Diagnostic[]> {
  const { program, sourceFile } = await createTestProgram(code);
  const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);
  return [...diagnostics];
}

/**
 * Batch type-check multiple fixture files in a single TypeScript program.
 * Returns a map from file path to diagnostics.
 */
export async function batchTypeCheckFixtures(
  fixtures: Record<string, string>,
): Promise<Map<string, ts.Diagnostic[]>> {
  const typeLibs = await getTypeScriptEnvironmentTypes();

  // Prepend Cell prelude to all fixture files
  const fixturesWithPrelude: Record<string, string> = {};
  for (const [path, code] of Object.entries(fixtures)) {
    fixturesWithPrelude[path] = `${CELL_BRAND_PRELUDE}\n${code}`;
  }

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    lib: ["ES2023", "DOM", "JSX"],
    strict: true,
    strictNullChecks: true,
  };

  // Cache for type definition source files
  const typeDefCache = new Map<string, ts.SourceFile>();

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (name) => {
      // Check if it's a fixture file
      if (fixturesWithPrelude[name] !== undefined) {
        return ts.createSourceFile(
          name,
          fixturesWithPrelude[name],
          compilerOptions.target!,
          true,
        );
      }

      // Check cache for type definition files
      if (typeDefCache.has(name)) {
        return typeDefCache.get(name);
      }

      let sourceText: string | undefined;

      // Map lib.d.ts requests to es2023 definitions
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        sourceText = typeLibs.es2023 || "";
      } else {
        // Handle other library files (map case-insensitive)
        const libName = name.toLowerCase().replace(".d.ts", "");
        if (typeLibs[libName]) {
          sourceText = typeLibs[libName];
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
      typeDefCache.set(name, sourceFile);
      return sourceFile;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => {
      if (fixturesWithPrelude[name] !== undefined) return true;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) return true;
      const libName = name.toLowerCase().replace(".d.ts", "");
      return !!typeLibs[libName];
    },
    readFile: (name) => {
      if (fixturesWithPrelude[name] !== undefined) {
        return fixturesWithPrelude[name];
      }
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return typeLibs.es2023;
      }
      const libName = name.toLowerCase().replace(".d.ts", "");
      return typeLibs[libName];
    },
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const fileNames = Object.keys(fixturesWithPrelude);
  const program = ts.createProgram(fileNames, compilerOptions, compilerHost);

  // Get all diagnostics
  const allDiagnostics = ts.getPreEmitDiagnostics(program);

  // Group diagnostics by file
  const diagnosticsByFile = new Map<string, ts.Diagnostic[]>();

  // Initialize empty arrays for all fixture files
  for (const filePath of fileNames) {
    diagnosticsByFile.set(filePath, []);
  }

  // Assign diagnostics to their respective files
  for (const diagnostic of allDiagnostics) {
    if (
      diagnostic.file &&
      fixturesWithPrelude[diagnostic.file.fileName] !== undefined
    ) {
      const existing = diagnosticsByFile.get(diagnostic.file.fileName) || [];
      existing.push(diagnostic);
      diagnosticsByFile.set(diagnostic.file.fileName, existing);
    }
  }

  return diagnosticsByFile;
}

export function normalizeSchema<T extends Record<string, unknown> | boolean>(
  schema: T,
): T {
  // Boolean schemas are valid and should pass through unchanged
  if (typeof schema === "boolean") {
    return schema;
  }
  // Strip top-level $schema noise. Destructuring rather than deleting off a
  // copy keeps the input untouched without a clone; `deepCanonicalize` rebuilds
  // every object and array it returns, so nothing downstream aliases the input
  // either.
  const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
  return deepCanonicalize(rest) as T;
}

/**
 * Type assertion helper for tests that know they're working with object schemas.
 * Use this when the test context guarantees the schema is an object, not a boolean.
 */
export function asObjectSchema<T>(schema: T): T & JSONSchemaObj {
  if (typeof schema === "boolean") {
    throw new Error(
      `Expected object schema but got boolean: ${schema}`,
    );
  }
  return schema as T & JSONSchemaObj;
}

function normalizeAnyOf(node: any): any {
  if (!Array.isArray(node.anyOf)) return node;
  // If anyOf contains exactly one null and one non-null, put null first.
  if (node.anyOf.length === 2) {
    const a = node.anyOf[0];
    const b = node.anyOf[1];
    const isNull = (x: any) => isObjectOrArray(x) && x.type === "null";
    if (isNull(b) && !isNull(a)) {
      node.anyOf = [b, a];
    }
  }
  return node;
}

/**
 * Canonicalize the parts of a schema whose written order carries no meaning.
 *
 * This handles only the JSON-Schema-specific cases, all of them arrays whose
 * order is incidental: `required` and `enum` denote sets, and a two-member
 * nullable `anyOf` reads more naturally with the null arm first. Object key
 * order is deliberately NOT handled here — the golden encoder emits plain
 * objects in canonical key order per the fabric JSON encoding spec (§10), and
 * every other comparison against these values is key-order insensitive.
 */
function deepCanonicalize(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(deepCanonicalize);
  }
  // A `FabricPrimitive` (`FabricBytes` and the like) keeps its state in private
  // fields with no enumerable own properties, so walking it with
  // `Object.entries` would silently flatten it to `{}`. It is a leaf here.
  //
  // TODO(danfuzz): The other special-object class, `FabricInstance`,
  // is NOT a leaf -- it holds nested `FabricValue`s that this walk ought to
  // descend into. There is no faithful way to do that through `Object.entries`
  // either, so a `FabricInstance` still flattens to `{}` here. Handling it is
  // left for when the golden path needs to carry one.
  if (!isObjectOrArray(node) || node instanceof FabricPrimitive) return node;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = deepCanonicalize(v);
  }

  if (Array.isArray(out.required)) {
    out.required = [...out.required].sort();
  }
  if (Array.isArray(out.enum)) {
    out.enum = [...out.enum].sort();
  }

  normalizeAnyOf(out);

  return out;
}
