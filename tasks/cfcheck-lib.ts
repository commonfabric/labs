/**
 * Deciding which patterns one `cfcheck` invocation takes: the command line
 * it was given, and the corpus that cuts down to.
 *
 * Separate from `cfcheck.ts` so a test can drive it. That script runs a
 * compiler over the whole pattern corpus and cannot be imported for the
 * sake of its argument handling, which is where the decisions that a lane
 * depends on are made: a lane is charged for the units it asked for, and
 * every way of widening what runs beyond them starts here.
 */

import { readOnlyArguments } from "./only-arguments.ts";
import { matchesPatternFilter } from "./pattern-files.ts";

/** What an error says, for a reader who has no stack to read. */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a caller who gave a command line this cannot read is told. */
export const USAGE = "usage: deno task cfcheck [--only <pattern>]...";

/**
 * The `--only` terms a command line carries.
 *
 * Throws on anything else, and on a `--only` carrying nothing: a term
 * dropped for being empty would leave the run looking unfiltered, so it
 * would check the whole corpus while its caller was charged for one
 * pattern. A value opening with `--` is the caller's next flag read as a
 * filter, which matches no pattern and would check nothing.
 */
export function parseOnly(argv: readonly string[]): string[] {
  const read = readOnlyArguments(argv);
  if ("error" in read) throw new Error(read.error);
  const { only, rest } = read;
  if (rest.length > 0) throw new Error(`Unknown argument: ${rest[0]}`);
  return only;
}

/**
 * The patterns one invocation checks: those any `--only` term matches. An
 * invocation given no term takes the whole corpus, which is what makes a
 * lane asking for every pattern the same run as a person typing the task
 * with no arguments.
 */
export function patternsToCheck(
  files: readonly string[],
  only: readonly string[],
): string[] {
  return only.length === 0
    ? [...files]
    : files.filter((file) =>
      only.some((match) => matchesPatternFilter(file, match))
    );
}

/**
 * The patterns one invocation checks, read from the command line it was
 * given.
 *
 * Throws where the command line cannot be read, so that a spelling nobody
 * intended stops the run rather than checking patterns other than the ones
 * the caller asked for.
 */
export function selectionFor(
  files: readonly string[],
  argv: readonly string[],
): string[] {
  return patternsToCheck(files, parseOnly(argv));
}
