import ts from "typescript";
import { Program, ProgramResolver, Source } from "../interface.ts";

export type UnresolvedModuleHandling =
  | { type: "allow"; identifiers: string[] }
  | { type: "allow-all" }
  | { type: "deny" };

export interface ResolveModuleConfig {
  unresolvedModules: UnresolvedModuleHandling;
  resolveUnresolvedModuleTypes: boolean;
  target: ts.ScriptTarget;
}

export async function resolveProgram(
  graph: ProgramResolver,
  { unresolvedModules, target, resolveUnresolvedModuleTypes }:
    ResolveModuleConfig,
): Promise<Program> {
  const main = await graph.main();
  const sources = new Map([[main.name, main]]);
  const toProcess = [main.name];
  const processed: string[] = [];

  while (toProcess.length > 0) {
    const currentName = toProcess.shift()!;
    if (processed.includes(currentName)) {
      continue;
    }
    const current = sources.get(currentName)!;
    const specifiers = scanSource(current, target, false).imports;
    for (const specifier of specifiers) {
      // Refused here rather than resolved: past this point the `..` segments
      // are clamped away and every later error names a path that appears in
      // no source file.
      assertInsideRoot(specifier, current);
      const identifier = resolveSpecifier(specifier, current);
      if (sources.has(identifier)) {
        continue;
      }
      const newSource = await graph.resolveSource(identifier);
      if (!newSource) {
        isUnresolvedModuleOk(identifier, current, unresolvedModules);
        if (resolveUnresolvedModuleTypes) {
          const typeDefIdentifier = `${identifier}.d.ts`;
          if (!sources.has(typeDefIdentifier)) {
            const typeDef = await graph.resolveSource(typeDefIdentifier);
            if (typeDef) {
              sources.set(typeDefIdentifier, typeDef);
              toProcess.push(typeDefIdentifier);
            }
          }
        }
        continue;
      }
      sources.set(identifier, newSource as Source);
      toProcess.push(identifier);
    }
  }

  return {
    main: main.name,
    files: [...sources.values()],
  };
}

/**
 * Helper for `resolveProgram()`, which accepts a module no source was found
 * for when `config` allows it to go unresolved.
 *
 * @throws If `config` does not allow it. The message names `importer`, the
 *   first module found importing `identifier`, since an identifier alone does
 *   not say which file to go and fix.
 */
function isUnresolvedModuleOk(
  identifier: string,
  importer: Source,
  config: UnresolvedModuleHandling,
): void {
  switch (config.type) {
    case "allow-all":
      return;
    case "allow": {
      if (config.identifiers.includes(identifier)) {
        return;
      }
    }
    /* falls through */
    case "deny":
    default:
      throw new Error(
        `Could not resolve "${identifier}", imported by "${importer.name}".`,
      );
  }
}

// Moved to `../specifier.ts` (typescript-free) so runtime consumers can use it
// without pulling the compiler into their bundle; re-exported here for the
// existing compile-path importers.
export { resolveImportSpecifier } from "../specifier.ts";
import {
  assertImportInsideProgramRoot as assertInsideRoot,
  resolveDeclaredDataFile,
  resolveImportSpecifier as resolveSpecifier,
} from "../specifier.ts";

/**
 * What a module declares it depends on, read out of its source by
 * {@link scanModuleDeclarations}: the modules it imports and the data files it
 * reads.
 *
 * Both lists hold what the source writes, unresolved, so that a caller can
 * resolve them against whichever name it holds the module by. The scan reads
 * that name only to tell what kind of file the module is, which turns on its
 * base name alone, so one result holds for the module under every name with
 * that base name.
 */
export interface ModuleDeclarations {
  /** Every module specifier, as {@link collectImportSpecifiers} returns them. */
  readonly imports: readonly string[];

  /**
   * The path each `dataFile()` call names, as written. These are the calls
   * {@link collectDataFileNames} finds, before it resolves them.
   */
  readonly dataFiles: readonly string[];
}

/**
 * Returns the modules `source` imports and the data files it reads, from one
 * parse. {@link collectImportSpecifiers} and {@link collectDataFileNames} each
 * return one half of this and parse to do it, so a caller needing both halves,
 * or needing one under several names, scans here and resolves from the result.
 */
export function scanModuleDeclarations(
  source: Source,
  target: ts.ScriptTarget,
): ModuleDeclarations {
  return scanSource(source, target, true);
}

/**
 * Collect every import/`export … from` specifier referenced by a source file,
 * including type-only imports (`import type`, type-only named specifiers) and
 * inline import-type references (`import("./mod").Foo`). Type edges are
 * intentionally retained: in Common Fabric the transformer lowers types into
 * generated schemas, so a changed imported type can change runtime behavior.
 * Dynamic `import()` *expressions* and `require()` are not supported and are
 * ignored.
 *
 * This is a superset of {@link resolveProgram}'s graph discovery: it adds
 * inline import-type edges so module identity does not miss schema-bearing type
 * dependencies. It deliberately does not influence which sources are fetched
 * for compilation.
 */
export function collectImportSpecifiers(
  source: Source,
  target: ts.ScriptTarget,
): string[] {
  return scanSource(source, target, true).imports;
}

/** The module an authored pattern takes the runtime's own names from. */
const FABRIC_MODULE = "commonfabric";

/** The runtime function that reads a data file stored with the program. */
const DATA_FILE_READER = "dataFile";

/**
 * Returns the data-file names `source` declares, as the paths its `dataFile()`
 * calls name, each resolved against `source` the way an import specifier is.
 *
 * A pattern declares the code it depends on by importing it and the data it
 * depends on by reading it, so this is the data-side counterpart of the import
 * scan: both read a declaration out of the source rather than take one from a
 * caller, and both resolve what they read against the module that wrote it.
 * The runtime resolves a read the same way, so a file is attached under the
 * name it is later looked up by.
 *
 * Only a call to the runtime's own `dataFile` counts, and only where the
 * argument is a string literal. The binding is followed through a renaming
 * import and through a namespace import, so `df("./x.json")` and
 * `cf.dataFile("./x.json")` are the same declaration as the plain call. A
 * type-only import binds no value and so declares nothing. A computed path
 * cannot be read from the source at all, and stays the caller's to name.
 */
export function collectDataFileNames(
  source: Source,
  target: ts.ScriptTarget,
): string[] {
  // Every form recognized below names the reader as the contiguous characters
  // `dataFile`, in an identifier or in a string literal, unless an escape
  // breaks them up, and every escape starts with a backslash. A source holding
  // neither declares nothing, and is not parsed.
  if (
    !source.contents.includes(DATA_FILE_READER) &&
    !source.contents.includes("\\")
  ) {
    return [];
  }
  return scanSource(source, target, true).dataFiles.map((path) =>
    resolveDeclaredDataFile(path, source)
  );
}

/**
 * Helper for the scans above, which parses `source` once and collects both the
 * module specifiers it names and the paths its `dataFile()` calls name.
 *
 * An inline import-type reference, `import("./mod").Foo`, counts as an import
 * only when `includeImportTypeNodes` is set. It is load-bearing for schema
 * generation but is not a module-graph edge for resolution, so only the
 * identity scan opts in.
 */
function scanSource(
  source: Source,
  target: ts.ScriptTarget,
  includeImportTypeNodes: boolean,
): { imports: string[]; dataFiles: string[] } {
  const sourceFile = ts.createSourceFile(
    source.name,
    source.contents,
    target,
    true,
  );
  const readers = dataFileReaders(sourceFile);

  const imports: string[] = [];
  const dataFiles: string[] = [];

  function visit(node: ts.Node) {
    // Handle import declarations: import { foo } from 'module'
    // We intentionally skip dynamic imports and require statements. Unsupported.
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        imports.push(moduleSpecifier.text);
      }
    }
    // `export * from "specifier";`
    if (ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        imports.push(moduleSpecifier.text);
      }
    }
    // Inline import-type references in type position: `import("./mod").Foo`.
    if (includeImportTypeNodes && ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)
      ) {
        imports.push(argument.literal.text);
      }
    }
    if (readers !== undefined && ts.isCallExpression(node)) {
      const path = dataFileReadPath(node, readers);
      if (path !== undefined) dataFiles.push(path);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { imports: [...new Set(imports)], dataFiles };
}

/** The local names a module binds the runtime's `dataFile` to. */
interface DataFileReaders {
  /** Names bound to `dataFile` itself, by a plain or a renaming import. */
  readonly direct: ReadonlySet<string>;

  /** Names bound to the runtime module as a namespace. */
  readonly namespaces: ReadonlySet<string>;
}

/**
 * Helper for `scanSource()`, which returns the names the imports of
 * `sourceFile` bind the runtime's `dataFile` to, or `undefined` when they bind
 * it to none. A type-only import binds no value, and so binds nothing here.
 */
function dataFileReaders(
  sourceFile: ts.SourceFile,
): DataFileReaders | undefined {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || specifier.text !== FABRIC_MODULE) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === DATA_FILE_READER) direct.add(element.name.text);
    }
  }
  return direct.size === 0 && namespaces.size === 0
    ? undefined
    : { direct, namespaces };
}

/**
 * Helper for `scanSource()`, which returns the path `call` reads when it calls
 * the runtime's `dataFile` through one of `readers` with a string literal, and
 * `undefined` for any other call.
 */
function dataFileReadPath(
  call: ts.CallExpression,
  readers: DataFileReaders,
): string | undefined {
  const callee = call.expression;
  const read = ts.isIdentifier(callee) && readers.direct.has(callee.text)
    ? callee
    : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        readers.namespaces.has(callee.expression.text) &&
        callee.name.text === DATA_FILE_READER
    ? callee.expression
    : undefined;
  const argument = call.arguments[0];
  return read !== undefined && argument !== undefined &&
      ts.isStringLiteral(argument) && !isShadowed(read)
    ? argument.text
    : undefined;
}

/**
 * Whether `use` names something other than the module's own import: a binding
 * of the same name declared in a scope between the two.
 *
 * The walk goes outward from the use until it reaches a scope that binds the
 * name, so an inner declaration wins over the import exactly as it does when
 * the code runs. Reaching the file without finding one means the import is
 * what the name refers to.
 */
function isShadowed(use: ts.Identifier): boolean {
  const name = use.text;
  let node: ts.Node = use.parent;
  while (!ts.isSourceFile(node)) {
    if (bindsName(node, name)) return true;
    node = node.parent;
  }
  return false;
}

/** Whether `scope` declares `name` directly, not counting nested scopes. */
function bindsName(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(scope)) {
    if (scope.parameters.some((p) => patternBinds(p.name, name))) return true;
  }
  if (
    (ts.isFunctionExpression(scope) || ts.isClassExpression(scope) ||
      ts.isClassDeclaration(scope) || ts.isFunctionDeclaration(scope)) &&
    scope.name?.text === name
  ) {
    return true;
  }
  if (ts.isCatchClause(scope)) {
    const declared = scope.variableDeclaration?.name;
    if (declared !== undefined && patternBinds(declared, name)) return true;
  }
  if (
    ts.isForStatement(scope) || ts.isForOfStatement(scope) ||
    ts.isForInStatement(scope)
  ) {
    const initializer = scope.initializer;
    if (
      initializer !== undefined &&
      ts.isVariableDeclarationList(initializer) &&
      initializer.declarations.some((d) => patternBinds(d.name, name))
    ) {
      return true;
    }
  }
  const statements = ts.isBlock(scope) || ts.isModuleBlock(scope)
    ? scope.statements
    : undefined;
  if (statements === undefined) return false;
  return statements.some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((d) =>
        patternBinds(d.name, name)
      );
    }
    if (
      ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
    ) {
      return statement.name?.text === name;
    }
    return false;
  });
}

/** Whether a binding name — plain, or destructured — binds `name`. */
function patternBinds(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) =>
    ts.isBindingElement(element) && patternBinds(element.name, name)
  );
}
