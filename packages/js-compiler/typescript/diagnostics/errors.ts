// Type-only: this module is boot-eager in the runtime worker (CompilerError is
// the `instanceof` contract for compile failures, imported by runner builtins),
// so it must not carry a value edge into the TypeScript compiler.
import type { Diagnostic, DiagnosticMessageChain } from "typescript";
import { renderInline } from "./render.ts";

/**
 * Mirror of `ts.flattenDiagnosticMessageText` (same output, byte for byte):
 * a chain node renders its text at two spaces per indent level, children one
 * level deeper. Local so this module stays typescript-value-free (above).
 */
function flattenDiagnosticMessageText(
  diag: string | DiagnosticMessageChain | undefined,
  newLine: string,
  indent = 0,
): string {
  if (typeof diag === "string") return diag;
  if (diag === undefined) return "";
  let result = "";
  if (indent) {
    result += newLine;
    for (let i = 0; i < indent; i++) result += "  ";
  }
  result += diag.messageText;
  indent++;
  if (diag.next) {
    for (const kid of diag.next) {
      result += flattenDiagnosticMessageText(kid, newLine, indent);
    }
  }
  return result;
}

/**
 * Rewrites a diagnostic error message, converting confusing TypeScript errors
 * into clearer ones. Takes the original TypeScript diagnostic message and
 * returns the replacement, or null when no rewrite applies.
 */
export type DiagnosticMessageTransformer = (message: string) => string | null;

export interface ErrorDetails {
  readonly diagnostic: Diagnostic;
  source?: string;
}

/**
 * The authored text behind a compiler input, and how far its lines sit from
 * the compiler input's. A caller that adds lines to a source before compiling
 * it supplies these, so that a diagnostic names the line the author wrote and
 * its frame quotes the author's text.
 */
export interface AuthoredSource {
  readonly contents: string;
  /** Added to a line of the compiler input to give the authored line. */
  readonly lineOffset: number;
}

/** The authored source behind a compiler input, looked up by file name. */
export type AuthoredSourceLookup = (
  fileName: string,
) => AuthoredSource | undefined;

/**
 * A line of a compiler input as the author sees it, with the text to quote
 * around it. Only a line the shift carries over unchanged maps: a line the
 * caller added, or one whose text it rewrote, keeps the compiler input's line
 * and text, so a column always points into the text quoted with it.
 */
export function authoredLocation(
  fileName: string,
  line: number,
  compilerSource: string,
  lookup: AuthoredSourceLookup | undefined,
): { line: number; source: string } {
  const authored = lookup?.(fileName);
  if (authored === undefined) return { line, source: compilerSource };
  const authoredLine = line + authored.lineOffset;
  const authoredText = authored.contents.split("\n")[authoredLine - 1];
  const compilerText = compilerSource.split("\n")[line - 1];
  if (authoredText === undefined || authoredText !== compilerText) {
    return { line, source: compilerSource };
  }
  return { line: authoredLine, source: authored.contents };
}

/**
 * Represents a diagnostic from the Common Fabric transformer pipeline.
 * This mirrors TransformationDiagnostic from @commonfabric/ts-transformers.
 */
export interface TransformerDiagnosticInfo {
  readonly severity: "error" | "warning";
  readonly type: string;
  readonly message: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly length: number;
}

export type CompilationErrorType = "MODULE_NOT_FOUND" | "ERROR";

export class CompilationError {
  source?: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  type: CompilationErrorType;

  constructor(
    { diagnostic, source }: ErrorDetails,
    messageTransformer?: DiagnosticMessageTransformer,
    authoredSource?: AuthoredSourceLookup,
  ) {
    const { file, start } = diagnostic;
    const { message, type } = this.#parseMessage(
      diagnostic.messageText,
      messageTransformer,
    );

    this.source = source;
    this.message = message;
    this.type = type;

    if (file) {
      this.file = file.fileName;
    }
    if (file && start !== undefined) {
      const result = file.getLineAndCharacterOfPosition(start);
      // TypeScript uses 0-based positions
      const location = authoredLocation(
        file.fileName,
        result.line + 1,
        source ?? file.text,
        authoredSource,
      );
      this.line = location.line;
      this.column = result.character + 1;
      if (source !== undefined || authoredSource !== undefined) {
        this.source = location.source;
      }
    }
  }

  #parseMessage(
    input: string | DiagnosticMessageChain,
    messageTransformer?: DiagnosticMessageTransformer,
  ): { type: CompilationErrorType; message: string } {
    const message = flattenDiagnosticMessageText(input, "\n");

    // Apply custom message transformer if configured
    if (messageTransformer) {
      const transformed = messageTransformer(message);
      if (transformed !== null) {
        return { type: "ERROR", message: transformed };
      }
    }

    // Detect module not found errors
    {
      const match = message.match(/^(Cannot find module '[^\']*'.)/);
      if (match && match.length >= 2) {
        // Strip out the extra message info on internal typescript
        // moduleResolution configuration
        return { type: "MODULE_NOT_FOUND", message: match[1] };
      }
    }
    return { type: "ERROR", message };
  }

  display(): string {
    const file = this.file ?? "";
    const location = this.line !== undefined && this.column !== undefined
      ? `:${this.line}:${this.column}`
      : "";
    const source = file ? ` [${file}${location}]` : "";
    return `[${this.type}] ${this.message}${source}`;
  }

  displayInline(): string {
    if (
      !this.source || this.line === undefined || this.column === undefined ||
      this.file === undefined
    ) {
      return this.display();
    }

    const inline = renderInline({
      source: this.source,
      line: this.line,
      column: this.column,
      contextLines: 2,
    });
    return `[${this.type}] ${this.message}\n${inline}`;
  }
}

export class CompilerError extends Error {
  override name = "CompilerError";
  #errors: CompilationError[];
  constructor(
    errorDetails: ErrorDetails[],
    messageTransformer?: DiagnosticMessageTransformer,
    authoredSource?: AuthoredSourceLookup,
  ) {
    const errors = errorDetails.map((d) =>
      new CompilationError(d, messageTransformer, authoredSource)
    );
    const message = errors.map((error) => error.displayInline()).join("\n");
    super(message);
    this.#errors = errors;
  }

  get errors(): CompilationError[] {
    return this.#errors;
  }
}

/**
 * Formats a transformer diagnostic with source context.
 * Returns a string like:
 * ```
 * /path/to/file.ts:10:5 - error: Message here
 *  8 | previous line
 *  9 | another line
 * 10 | error line
 *    |     ^
 * 11 | next line
 * ```
 */
export function formatTransformerDiagnostic(
  diagnostic: TransformerDiagnosticInfo,
  source: string,
  authoredSource?: AuthoredSourceLookup,
): string {
  const prefix = diagnostic.severity === "error" ? "error" : "warning";
  const location = authoredLocation(
    diagnostic.fileName,
    diagnostic.line,
    source,
    authoredSource,
  );
  const header =
    `${diagnostic.fileName}:${location.line}:${diagnostic.column} - ${prefix}: ${diagnostic.message}`;

  const inline = renderInline({
    source: location.source,
    line: location.line,
    column: diagnostic.column,
    contextLines: 2,
  });

  return `${header}\n${inline}`;
}

/**
 * Error thrown when the transformer pipeline reports errors. Its message names
 * authored lines where an {@link AuthoredSourceLookup} is supplied, while
 * `diagnostics` keep the compiler input's coordinates.
 */
export class TransformerError extends Error {
  override name = "TransformerError";
  readonly diagnostics: TransformerDiagnosticInfo[];

  constructor(
    diagnostics: TransformerDiagnosticInfo[],
    sources: Map<string, string>,
    authoredSource?: AuthoredSourceLookup,
  ) {
    const messages = diagnostics.map((d) => {
      const source = sources.get(d.fileName) ?? "";
      return formatTransformerDiagnostic(d, source, authoredSource);
    });
    super(messages.join("\n\n"));
    this.diagnostics = diagnostics;
  }
}
