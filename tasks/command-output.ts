/**
 * What a command-line task decided to say, and how its entry point says it.
 *
 * A task returns a `CommandOutput` rather than printing, so a test can read
 * the text a run produces as well as the decision behind it, and its
 * `import.meta.main` block hands the result to `emit()`.
 */

/** Everything a command wants to say, and the code it wants to exit with. */
export interface CommandOutput {
  out?: string;
  err?: string;
  code: number;
}

/**
 * Print what a command decided to say, `out` to standard output and `err` to
 * standard error, and exit with the code it chose.
 *
 * `never` rather than `void`, so a change that let this return would be a
 * compile error here rather than a command falling through into whatever the
 * caller does next.
 */
export function emit(shown: CommandOutput): never {
  if (shown.out !== undefined) console.log(shown.out);
  if (shown.err !== undefined) console.error(shown.err);
  Deno.exit(shown.code);
}
