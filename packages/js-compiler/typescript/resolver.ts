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
    const specifiers = getImports(current, target);
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
  assertDataFileInsideProgramRoot,
  assertImportInsideProgramRoot as assertInsideRoot,
  resolveDataFilePath,
  resolveImportSpecifier as resolveSpecifier,
} from "../specifier.ts";

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
  return getImports(source, target, { includeImportTypeNodes: true });
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
  const sourceFile = ts.createSourceFile(
    source.name,
    source.contents,
    target,
    true,
  );
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
  if (direct.size === 0 && namespaces.size === 0) return [];

  const names: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const read = ts.isIdentifier(callee) && direct.has(callee.text)
        ? callee
        : ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            namespaces.has(callee.expression.text) &&
            callee.name.text === DATA_FILE_READER
        ? callee.expression
        : undefined;
      const argument = node.arguments[0];
      if (
        read !== undefined && argument !== undefined &&
        ts.isStringLiteral(argument) && !isShadowed(read)
      ) {
        // Refused before resolving, as an escaping import is: past the join
        // the climbing segments are clamped away and the name no longer
        // appears in any source file.
        assertDataFileInsideProgramRoot(argument.text, source);
        names.push(resolveDataFilePath(argument.text, source.name));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
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

function getImports(
  source: Source,
  target: ts.ScriptTarget,
  options: { includeImportTypeNodes?: boolean } = {},
): string[] {
  const sourceFile = ts.createSourceFile(
    source.name,
    source.contents,
    target,
    true,
  );

  const imports: string[] = [];

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
    // These are load-bearing for schema generation but are not module-graph
    // edges for resolution, so only the identity collector opts in.
    if (options.includeImportTypeNodes && ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)
      ) {
        imports.push(argument.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...new Set(imports)];
}
