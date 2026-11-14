/** One diagnostic from a failed `compileAndRun` compile. */
export interface CompileDiagnostic {
  line: number;
  column: number;
  message: string;
}

/**
 * What went wrong with a `compileAndRun`, as text, or `undefined` when nothing
 * did. A compile failure arrives as structured `errors`, one per diagnostic;
 * `error` carries only failures that are not diagnostics.
 */
export const compileFailure = (
  error: string | undefined,
  errors: readonly CompileDiagnostic[] | undefined,
): string | undefined =>
  error ??
    errors?.map(({ line, column, message }) => `${line}:${column} ${message}`)
      .join("\n");
