/**
 * `value` as one POSIX shell word: single-quoted, with each `'` inside it
 * closed, escaped, and reopened, so a line that carries a path a person will
 * paste stays one argument whatever the path holds.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `value` as one POSIX shell word, quoted only when a shell would otherwise
 * split or expand it, for a line a person reads as well as pastes.
 */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : shellQuote(value);
}
