import ts from "typescript";
import { preserveSourceMapRange } from "../ast/utils.ts";
import { TransformationContext } from "./mod.ts";

export const CF_HELPERS_IDENTIFIER = "__cfHelpers";

const CF_HELPERS_SPECIFIER = "commonfabric";

// Runner pattern coverage line remapping treats this helper import as a
// one-line prelude. Changes to its line count need a matching update in
// patternCoverageOptionsForCompile.
const HELPERS_STMT =
  `import { ${CF_HELPERS_IDENTIFIER} } from "${CF_HELPERS_SPECIFIER}";`;

// Name of the forwarding JSX-factory shim appended after the source. It is
// also the module-scope binding name whose presence in the authored module
// moves the shim to `JSX_FACTORY_FALLBACK_SHIM_NAME` (see `injectCfHelpers`).
const JSX_FACTORY_SHIM_NAME = "h";
// Reserved like `__cfHelpers` (the authoring guard rejects it), so the
// fallback can never collide in turn.
const JSX_FACTORY_FALLBACK_SHIM_NAME = "__cfHelpersShim";

// The trailer is a forwarding function declaration. That shape is what the
// runner's module-body verifier admits at module scope (a direct function,
// which the hardening pass then closes with `__cfHardenFn(<name>)`); a bare
// expression statement such as `void __cfHelpers;` is rejected there as
// top-level executable code. The JavaScript variant, injected into authored
// `.js`/`.jsx` sources, drops the `: any[]` annotation, which would be a parse
// error there ("Type annotations can only be used in TypeScript files").
// Every variant is line-for-line identical so injection shifts source lines
// the same way regardless of file kind or shim name.
const usedStmtFor = (name: string, javascript: boolean): string =>
  `// @ts-ignore: Internals
function ${name}(${
    javascript ? "...args" : "...args: any[]"
  }) { return ${CF_HELPERS_IDENTIFIER}.h.apply(null, args); }
`;
const HELPERS_USED_STMT = usedStmtFor(JSX_FACTORY_SHIM_NAME, false);
const HELPERS_USED_STMT_JS = usedStmtFor(JSX_FACTORY_SHIM_NAME, true);
// Appended instead when the authored module already binds
// `JSX_FACTORY_SHIM_NAME` in its module scope, where a second declaration
// would be a duplicate identifier (TS2300, or TS2440 against an import).
// Keeping the helper import live is all the shim contributes to binding once
// JSX itself dispatches through `__cfHelpers.h`, so only the name changes.
const HELPERS_USED_STMT_FALLBACK = usedStmtFor(
  JSX_FACTORY_FALLBACK_SHIM_NAME,
  false,
);
const HELPERS_USED_STMT_FALLBACK_JS = usedStmtFor(
  JSX_FACTORY_FALLBACK_SHIM_NAME,
  true,
);

export class CFHelpers {
  #sourceFile: ts.SourceFile;
  #factory: ts.NodeFactory;
  #helperIdent?: ts.Identifier;

  constructor(params: Pick<TransformationContext, "sourceFile" | "factory">) {
    this.#sourceFile = params.sourceFile;
    this.#factory = params.factory;

    for (const stmt of this.#sourceFile.statements) {
      const helperSymbol = getCFHelpersIdentifier(stmt);
      if (helperSymbol) {
        this.#helperIdent = helperSymbol;
      }
    }
  }

  sourceHasHelpers(): boolean {
    return !!this.#helperIdent;
  }

  /**
   * Carries the source-map range of `originalNode` and the checker identity of
   * `identityNode` onto `node` without assigning a text range. The range and
   * identity nodes may differ or coincide.
   */
  preserveNodeSourceMap<T extends ts.Node>(
    node: T,
    originalNode: ts.Node,
    identityNode: ts.Node,
  ): T {
    return ts.setOriginalNode(
      preserveSourceMapRange(node, originalNode),
      identityNode,
    ) as T;
  }

  getHelperExpr(
    name: string,
    originalNode?: ts.Node,
  ): ts.PropertyAccessExpression {
    if (!this.sourceHasHelpers()) {
      throw new Error("Source file does not contain helpers.");
    }

    if (!originalNode) {
      return this.#factory.createPropertyAccessExpression(
        this.#helperIdent!,
        name,
      );
    }

    const helperIdent = this.preserveNodeSourceMap(
      this.#factory.createIdentifier(this.#helperIdent!.text),
      originalNode,
      this.#helperIdent!,
    );
    const helperName = preserveSourceMapRange(
      this.#factory.createIdentifier(name),
      originalNode,
    );
    return preserveSourceMapRange(
      this.#factory.createPropertyAccessExpression(
        helperIdent,
        helperName,
      ),
      originalNode,
    );
  }

  createHelperCall(
    name: string,
    originalNode: ts.Node,
    typeArguments: readonly ts.TypeNode[] | undefined,
    argumentsArray: readonly ts.Expression[],
  ): ts.CallExpression {
    return preserveSourceMapRange(
      this.#factory.createCallExpression(
        this.getHelperExpr(name, originalNode),
        typeArguments,
        argumentsArray,
      ),
      originalNode,
    );
  }

  /**
   * Returns a `QualifiedName` for the requested helper name, e.g.
   * `__cfHelpers.JSONSchema`.
   */
  getHelperQualified(
    name: string,
  ): ts.QualifiedName {
    if (!this.sourceHasHelpers()) {
      throw new Error("Source file does not contain helpers.");
    }
    return this.#factory.createQualifiedName(
      this.#helperIdent!,
      name,
    );
  }
}

// The first-content-line scan lives in runtime-contract.ts (typescript-free,
// runtime-importable); re-exported here for the existing compile-side callers.
export { findFirstContentLineIndex } from "./runtime-contract.ts";
import { findFirstContentLineIndex } from "./runtime-contract.ts";

// Inject helpers so the AST transformer pipeline has access to helpers like
// `lift`.
// This operates on strings, and to be used outside of
// the TypeScript transformer pipeline, since symbol binding
// occurs before transformers run.
//
// We must also inject a usage of the module before the AST transformer
// pipeline, otherwise the import is elided at emit and the helper module is
// not available in the compiled JS. By default that usage is a forwarding
// `h(...)` function delegating to `__cfHelpers.h`, which also lets authors
// call `h` explicitly without importing it. JSX itself does not depend on the
// shim: the js-compiler emits elements and fragments against `__cfHelpers.h`
// directly (its `jsxFactory` / `jsxFragmentFactory`). When the authored
// module already binds `h` in its module scope, the shim would collide with
// that binding, so the same function is appended under the reserved name
// `__cfHelpersShim` instead and the author's `h` keeps its meaning.
//
// Source maps are derived from this transformation.
// Take care in maintaining source lines from its input.
//
// This injected statement enables subsequent transformations.
export function transformCfDirective(
  source: string,
  // Authored file name; when it has a JavaScript extension the injected
  // helper statement uses JS-only syntax. Defaults to TypeScript syntax.
  fileName?: string,
): string {
  const lines = source.split("\n");
  const firstContentLineIndex = findFirstContentLineIndex(lines);
  if (firstContentLineIndex === null) {
    return source;
  }

  return injectCfHelpers(source, fileName);
}

const JS_FILE_RE = /\.(js|jsx|mjs|cjs)$/;

export function injectCfHelpers(source: string, fileName?: string): string {
  const sourceFile = parseAuthoredSource(source, fileName);
  checkCFHelperVar(sourceFile);
  const javascript = fileName !== undefined && JS_FILE_RE.test(fileName);
  const usedStmt = declaresTopLevelBinding(sourceFile, JSX_FACTORY_SHIM_NAME)
    ? (javascript ? HELPERS_USED_STMT_FALLBACK_JS : HELPERS_USED_STMT_FALLBACK)
    : (javascript ? HELPERS_USED_STMT_JS : HELPERS_USED_STMT);
  return [
    HELPERS_STMT,
    source,
    usedStmt,
  ].join("\n");
}

// Parses the authored source with the script kind its file name implies, so a
// `.ts` module keeps angle-bracket assertions and generic arrows as
// TypeScript instead of mis-parsing them as JSX, which would swallow the
// statements after them and hide their bindings from the scans below. An
// absent or unrecognized name parses as TSX, the historical default.
function parseAuthoredSource(
  source: string,
  fileName?: string,
): ts.SourceFile {
  return ts.createSourceFile(
    fileName ?? "source.tsx",
    source,
    ts.ScriptTarget.ES2023,
    false,
    scriptKindFor(fileName),
  );
}

function scriptKindFor(fileName?: string): ts.ScriptKind {
  if (fileName === undefined) return ts.ScriptKind.TSX;
  if (/\.(ts|mts|cts)$/.test(fileName)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (JS_FILE_RE.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TSX;
}

/**
 * Exact-envelope detector for LEGACY stored pattern sources (CT-1838).
 *
 * Pre-#4158 pipelines persisted the helper-INJECTED pretransform form as the
 * source-of-record: `[HELPERS_STMT, source, usedStmt].join("\n")`. Such a
 * document is byte-recognizable — its first line is exactly
 * {@link HELPERS_STMT} and it ends with the {@link HELPERS_USED_STMT} (or
 * {@link HELPERS_USED_STMT_JS}) trailer. The current authoring guard
 * (`checkCFHelperVar`) rejects the reserved `__cfHelpers` identifier, so
 * without tolerance every pre-#4158 stored pattern bricks on cold load —
 * and, via the default pattern, all piece creation in aged spaces.
 *
 * Match rules (deliberately exact — see the runner's cold-load call sites):
 * - prefix: line 1 must be byte-exactly `HELPERS_STMT`;
 * - trailer: the document must end with `"\n" + HELPERS_USED_STMT` or
 *   `"\n" + HELPERS_USED_STMT_JS` (both constants end in `"\n"`; a stripped
 *   final newline is tolerated);
 * - the prefix and trailer must not overlap.
 *
 * The fallback-shim trailers ({@link HELPERS_USED_STMT_FALLBACK} and its
 * JavaScript form) postdate #4158 and are never persisted, so they are
 * deliberately not legacy trailers.
 *
 * Interior `__cfHelpers` occurrences inside a valid envelope DO match: the
 * predicate is prefix+suffix only. That is chosen behavior — `__cfHelpers`
 * grants nothing beyond what injection gives every pattern, and tolerance is
 * only ever applied to Merkle-verified stored input, never to authored
 * writes (all authoring paths keep throwing via `checkCFHelperVar`).
 *
 * NOTE: the export name and home (this module, next to the constants it
 * matches) are a compatibility contract — downstream vendoring gates import
 * `isLegacyInjectedEnvelope` from `cf-helpers.ts` to probe whether a runtime
 * candidate tolerates legacy stored envelopes. Do not rename or move.
 */
export function isLegacyInjectedEnvelope(source: string): boolean {
  const prefix = HELPERS_STMT + "\n";
  if (!source.startsWith(prefix)) return false;
  for (const stmt of [HELPERS_USED_STMT, HELPERS_USED_STMT_JS]) {
    // `stmt` ends with "\n": accept the stored form both with and without
    // that final newline (storage/tooling may have trimmed it).
    for (const trailer of ["\n" + stmt, ("\n" + stmt).slice(0, -1)]) {
      if (
        source.length >= prefix.length + trailer.length &&
        source.endsWith(trailer)
      ) {
        return true;
      }
    }
  }
  return false;
}

// The authoring guard: throws if a reserved helper identifier (`__cfHelpers`,
// or the fallback shim name) appears anywhere in the parsed source (see
// `isLegacyInjectedEnvelope` for the one tolerated, storage-fed exception).
function checkCFHelperVar(sourceFile: ts.SourceFile) {
  checkReservedHelperVar(
    sourceFile,
    new Set([CF_HELPERS_IDENTIFIER, JSX_FACTORY_FALLBACK_SHIM_NAME]),
  );
}

function checkReservedHelperVar(
  sourceFile: ts.SourceFile,
  identifiers: ReadonlySet<string>,
) {
  const visitor = (node: ts.Node): ts.Node => {
    if (ts.isIdentifier(node) && identifiers.has(node.text)) {
      throw new Error(
        `Source cannot contain reserved helper symbol '${node.text}'.`,
      );
    }
    return ts.visitEachChild(node, visitor, undefined);
  };
  ts.visitNode(sourceFile, visitor);
}

// Whether the module scope of `sourceFile` declares a value binding named
// `name`: a top-level function, class, enum, or namespace declaration, a
// top-level variable declaration (destructuring included), an import binding,
// or a `var` hoisted out of a nested block or loop. Type-only declarations
// (`interface`, `type`) do not count: they occupy no value declaration space,
// so the function shim coexists with them. Block-scoped bindings in nested
// statements and anything inside a function or class body do not count
// either; they merely shadow the shim. An import binding named `name` counts
// whatever its `type` modifier: whether it conflicts with the shim (TS2440)
// depends on the imported target's meaning, which this string-level scan
// cannot resolve, and counting a non-conflicting one costs only the implicit
// `h(...)` alias.
function declaresTopLevelBinding(
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  const isName = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isIdentifier(node) && node.text === name;
  const bindsName = (binding: ts.BindingName): boolean => {
    if (ts.isIdentifier(binding)) return binding.text === name;
    for (const element of binding.elements) {
      if (!ts.isOmittedExpression(element) && bindsName(element.name)) {
        return true;
      }
    }
    return false;
  };
  // `var` declarations hoist through blocks, loops, `try`, `switch`, and
  // labels up to the nearest function or module scope. Walk exactly those
  // containers; stop at everything else (expressions, functions, classes).
  const hoistsVar = (node: ts.Node): boolean => {
    if (ts.isVariableDeclarationList(node)) {
      if ((node.flags & ts.NodeFlags.BlockScoped) !== 0) return false;
      for (const declaration of node.declarations) {
        if (bindsName(declaration.name)) return true;
      }
      return false;
    }
    if (ts.isVariableStatement(node)) return hoistsVar(node.declarationList);
    if (
      ts.isBlock(node) || ts.isIfStatement(node) || ts.isForStatement(node) ||
      ts.isForInStatement(node) || ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) || ts.isDoStatement(node) ||
      ts.isTryStatement(node) || ts.isCatchClause(node) ||
      ts.isSwitchStatement(node) || ts.isCaseBlock(node) ||
      ts.isCaseClause(node) || ts.isDefaultClause(node) ||
      ts.isLabeledStatement(node) || ts.isWithStatement(node)
    ) {
      return ts.forEachChild(node, hoistsVar) === true;
    }
    return false;
  };
  for (const stmt of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt)
    ) {
      if (isName(stmt.name)) return true;
    } else if (ts.isVariableStatement(stmt)) {
      for (const declaration of stmt.declarationList.declarations) {
        if (bindsName(declaration.name)) return true;
      }
    } else if (hoistsVar(stmt)) {
      return true;
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const { name, namedBindings } = stmt.importClause;
      if (isName(name)) return true;
      if (namedBindings === undefined) continue;
      if (ts.isNamespaceImport(namedBindings)) {
        if (isName(namedBindings.name)) return true;
      } else {
        for (const element of namedBindings.elements) {
          if (isName(element.name)) return true;
        }
      }
    }
  }
  return false;
}

function getCFHelpersIdentifier(
  statement: ts.Statement,
): ts.Identifier | undefined {
  if (!ts.isImportDeclaration(statement)) return;
  const { importClause, moduleSpecifier } = statement;

  // Check specifier is "commonfabric"
  if (!ts.isStringLiteral(moduleSpecifier)) return;
  if (moduleSpecifier.text !== CF_HELPERS_SPECIFIER) return;

  // Check it imports the internal `__cfHelpers` binding from commonfabric.
  if (!importClause || !ts.isImportClause(importClause)) return;
  const { namedBindings } = importClause;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
  for (const element of namedBindings.elements) {
    const bindingName = element.propertyName ?? element.name;
    if (bindingName.text === CF_HELPERS_IDENTIFIER) {
      return element.name;
    }
  }
  return;
}
