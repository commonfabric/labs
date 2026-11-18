/** One diagnostic from a failed `compileAndRun` compile. */
export interface CompileDiagnostic {
  line: number;
  column: number;
  message: string;
}

/**
 * What went wrong with a `compileAndRun`, as text, or `undefined` when nothing
 * did. Structured diagnostics carry the source location and detail; the error
 * message supplies the failure when no diagnostics are available.
 */
export const compileFailure = (
  error: string | undefined,
  errors: readonly CompileDiagnostic[] | undefined,
): string | undefined =>
  errors?.length
    ? errors.map(({ line, column, message }) => `${line}:${column} ${message}`)
      .join("\n")
    : error;
