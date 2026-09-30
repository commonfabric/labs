import { type Diagnostic, type Program, type SourceFile } from "typescript";
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
      if (!isKnownSymbol) {
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
