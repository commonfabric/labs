/**
 * `value` as one POSIX shell word: single-quoted, with each `'` inside it
 * closed, escaped, and reopened, so a line that carries a path a person will
 * paste stays one argument whatever the path holds.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
