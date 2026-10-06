import { isCommonFabricSymbol } from "@commonfabric/schema-generator/common-fabric-symbols";
import ts, { type Diagnostic, type Program, type SourceFile } from "typescript";

import {
  CompilerError,
  type DiagnosticMessageTransformer,
  ErrorDetails,
} from "./errors.ts";

export interface CheckerOptions {
  messageTransformer?: DiagnosticMessageTransformer;

  /**
   * Compiling durable STORED pattern source (see
   * `TypeScriptCompilerOptions.storedSource`): authoring-hygiene-only codes
   * ({@link isNonFatalDiagnosticCode}) are dropped instead of thrown.
   */
  storedSource?: boolean;
}

// These symbols are exported from commonfabric but TypeScript's declaration
// diagnostics have trouble with unique symbols in certain contexts.
// Filter out these known false positives.
// Note: TypeScript emits different phrasings for the same underlying issue:
//   - "private name 'X'" (TS4053/4054) for symbols used as property keys
//   - "name 'X' from external module" (TS4055) when the symbol type leaks into inferred declarations
const KNOWN_EXPORTED_SYMBOLS = [
  "CELL_BRAND",
  "CELL_INNER_TYPE",
  "DEFAULT_MARKER",
  "FABRIC_INSTANCE_PLUS_BRAND",
  "FABRIC_PRIMITIVE_BRAND",
  "SCOPE_BRAND",
  "SQLITE_DB_BRAND",
];

// TS2578 "Unused '@ts-expect-error' directive." must not fail STORED-source
// recompiles. Pattern sources are DURABLE: the same stored bytes are
// recompiled by every future toolchain, while the type environment they
// check against (vendored jsx.d.ts and friends) is supplied by the PLATFORM,
// not the author. A directive that suppressed a real error when authored
// becomes "unused" the moment the platform's types improve — treating that
// as fatal retroactively bricks every stored pattern that carried it
// (2026-07-28 estuary: loom-mobile patterns embedding a `cf-cell-link label`
// directive hard-failed to load after the vendored JSX types gained `label`,
// CT-1916). Authoring paths stay strict — there the author is present and
// removing the stale directive is the right fix.
const UNUSED_TS_EXPECT_ERROR = 2578;

/** Proves that every reachable result-brand key belongs to the native API. */
function hasOnlyNativeResultKeys(
  type: ts.Type,
  location: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  const seen = new Set<ts.Type>();
  const keys = new Set<ts.Symbol>();
  let complete = true;
  const add = (candidate: ts.Symbol | undefined) => {
    if (!candidate) return;
    const symbol = candidate.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(candidate)
      : candidate;
    if (symbol.getName() === "CELL_RESULT_TYPE") keys.add(symbol);
  };
  const walk = (value: ts.Type): void => {
    if (seen.has(value)) return;
    seen.add(value);
    if (value.flags & ts.TypeFlags.UniqueESSymbol) {
      add(value.getSymbol());
      return;
    }
    add(value.aliasSymbol);
    add(value.getSymbol());
    if (
      value.flags &
      (ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess |
        ts.TypeFlags.Substitution | ts.TypeFlags.Index)
    ) {
      complete = false;
      return;
    }
    if (value.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(value);
      if (constraint) walk(constraint);
      else complete = false;
      return;
    }
    if (value.isUnionOrIntersection()) {
      for (const member of value.types) walk(member);
    }
    if (
      !(value.flags &
        (ts.TypeFlags.Object | ts.TypeFlags.Union | ts.TypeFlags.Intersection |
          ts.TypeFlags.TypeParameter))
    ) return;
    for (const argument of value.aliasTypeArguments ?? []) walk(argument);
    if ((value as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      for (
        const argument of checker.getTypeArguments(value as ts.TypeReference)
      ) {
        walk(argument);
      }
    }
    const properties = value.getProperties();
    for (const property of properties) {
      for (const declaration of property.declarations ?? []) {
        const name = (declaration as ts.NamedDeclaration).name;
        if (name && ts.isComputedPropertyName(name)) {
          add(checker.getSymbolAtLocation(name.expression));
          const keyType = checker.getTypeAtLocation(name.expression);
          if (keyType.flags & ts.TypeFlags.UniqueESSymbol) {
            add(keyType.getSymbol());
          }
        }
      }
    }
    const symbols = [value.aliasSymbol, value.getSymbol()].filter(
      (symbol): symbol is ts.Symbol => symbol !== undefined,
    );
    // Native type arguments and keys are inspected, but expanding native Cell
    // methods would recursively instantiate fresh generic wrappers.
    if (symbols.some(isCommonFabricSymbol)) return;
    if ((value as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) {
      complete = false;
      return;
    }
    if (
      symbols.some((symbol) =>
        symbol.declarations?.some((declaration) =>
          declaration.getSourceFile().isDeclarationFile
        )
      )
    ) {
      complete = false;
      return;
    }
    for (const property of properties) {
      walk(checker.getTypeOfSymbolAtLocation(property, location));
    }
    for (
      const signature of [
        ...value.getCallSignatures(),
        ...value.getConstructSignatures(),
      ]
    ) {
      walk(signature.getReturnType());
      for (const parameter of signature.parameters) {
        walk(checker.getTypeOfSymbolAtLocation(parameter, location));
      }
      for (const parameter of signature.typeParameters ?? []) {
        const constraint = checker.getBaseConstraintOfType(parameter);
        if (constraint) walk(constraint);
      }
    }
    for (const index of checker.getIndexInfosOfType(value)) walk(index.type);
  };
  walk(type);
  return complete && keys.size > 0 && [...keys].every(isCommonFabricSymbol);
}

/** The exported value whose inferred type a declaration diagnostic reports. */
function declarationDiagnosticValue(
  diagnostic: Diagnostic,
  sourceFile: SourceFile,
): ts.Node | undefined {
  if (diagnostic.start === undefined) return undefined;
  const start = diagnostic.start;
  let location: ts.Node = sourceFile;
  const visit = (node: ts.Node): void => {
    if (node.pos <= start && start < node.end) {
      location = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  while (location !== sourceFile) {
    if (ts.isExportAssignment(location)) return location.expression;
    if (ts.isVariableDeclaration(location)) return location.name;
    if (
      ts.isFunctionDeclaration(location) || ts.isClassDeclaration(location)
    ) return location.name;
    location = location.parent;
  }
  return undefined;
}

/** Diagnostic codes dropped when compiling stored source (see
 * `CheckerOptions.storedSource`). */
export const isNonFatalDiagnosticCode = (code: number): boolean =>
  code === UNUSED_TS_EXPECT_ERROR;

export class Checker {
  #program: Program;
  #messageTransformer?: DiagnosticMessageTransformer;
  #storedSource: boolean;

  constructor(program: Program, options: CheckerOptions = {}) {
    this.#program = program;
    this.#messageTransformer = options.messageTransformer;
    this.#storedSource = options.storedSource === true;
  }

  typeCheck() {
    this.throwIfErrors(
      this.checkableSources().flatMap((sourceFile) =>
        this.collectSemanticErrors(sourceFile)
      ),
    );
  }

  declarationCheck() {
    this.throwIfErrors(
      this.checkableSources().flatMap((sourceFile) =>
        this.collectDeclarationErrors(sourceFile)
      ),
    );
  }

  /**
   * The source files {@link typeCheck}/{@link declarationCheck} cover, for
   * callers that step through them one file at a time (e.g. to yield to the
   * event loop between files) while keeping the same aggregate-then-throw
   * error semantics via {@link throwIfErrors}.
   */
  checkableSources(): SourceFile[] {
    return this.#sources();
  }

  /** Per-file semantic diagnostics, as the error details typeCheck throws. */
  collectSemanticErrors(sourceFile: SourceFile): ErrorDetails[] {
    return this.#program.getSemanticDiagnostics(sourceFile)
      .filter((diagnostic) =>
        !this.#storedSource || !isNonFatalDiagnosticCode(diagnostic.code)
      )
      .map(
        (diagnostic) => ({ diagnostic, source: sourceFile.text }),
      );
  }

  /**
   * Per-file syntactic diagnostics. With `noEmitOnError` off, TypeScript's
   * emit no longer refuses malformed source on its own — this collection is
   * what keeps a parse error fatal, on every path INCLUDING `noCheck` (which
   * skips type-checking, never parsing). No non-fatal filter: the suppressed
   * codes are semantic; a file that does not parse can never be loaded.
   */
  collectSyntacticErrors(sourceFile: SourceFile): ErrorDetails[] {
    return this.#program.getSyntacticDiagnostics(sourceFile).map(
      (diagnostic) => ({ diagnostic, source: sourceFile.text }),
    );
  }

  /** Program-level (options + global) diagnostics, same fatality contract. */
  collectProgramErrors(): ErrorDetails[] {
    return [
      ...this.#program.getOptionsDiagnostics(),
      ...this.#program.getGlobalDiagnostics(),
    ].map((diagnostic) => ({ diagnostic }));
  }

  /**
   * Per-file declaration diagnostics, filtered exactly as declarationCheck
   * filters them (known exported-symbol false positives skipped).
   */
  collectDeclarationErrors(sourceFile: SourceFile): ErrorDetails[] {
    const errors: ErrorDetails[] = [];
    for (
      const diagnostic of this.#program.getDeclarationDiagnostics(sourceFile)
    ) {
      // Skip "private name" errors for known exported symbols
      const message = typeof diagnostic.messageText === "string"
        ? diagnostic.messageText
        : diagnostic.messageText.messageText;
      const isKnownSymbol = KNOWN_EXPORTED_SYMBOLS.some((sym) =>
        message.includes(`private name '${sym}'`) ||
        message.includes(`name '${sym}' from external module`)
      );
      const nativeResultKey =
        (diagnostic.code === 4025 || diagnostic.code === 4082) &&
        message.includes("private name 'CELL_RESULT_TYPE'") &&
        declarationDiagnosticValue(diagnostic, sourceFile);
      const isNativeResultKey = nativeResultKey && hasOnlyNativeResultKeys(
        this.#program.getTypeChecker().getTypeAtLocation(nativeResultKey),
        nativeResultKey,
        this.#program.getTypeChecker(),
      );
      if (!isKnownSymbol && !isNativeResultKey) {
        errors.push({ diagnostic, source: sourceFile.text });
      }
    }
    return errors;
  }

  throwIfErrors(errors: ErrorDetails[]) {
    if (errors.length) {
      throw new CompilerError(errors, this.#messageTransformer);
    }
  }

  check(diagnostics: readonly Diagnostic[] | undefined) {
    // The emit path re-reports some semantic codes (TS surfaces 2578 through
    // per-file emit diagnostics), so the stored-source filter applies here
    // too.
    const fatal = (diagnostics ?? []).filter(
      (diagnostic) =>
        !this.#storedSource || !isNonFatalDiagnosticCode(diagnostic.code),
    );
    if (fatal.length === 0) {
      return;
    }
    throw new CompilerError(
      fatal.map((diagnostic) => ({ diagnostic })),
      this.#messageTransformer,
    );
  }

  #sources() {
    return this.#program.getSourceFiles().filter((source) =>
      !source.fileName.startsWith("$types/")
    );
  }
}
