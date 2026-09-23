/**
 * The `--only` filter the pattern gates share, read one way for all of
 * them.
 *
 * Each gate restricts itself to the paths holding any of the terms, and a
 * lane hands it one exact path per unit it chose. A term that is missing
 * or empty is refused rather than dropped: dropped, it would leave the run
 * looking unfiltered, so the gate would check everything while its lane
 * was charged for one unit. A value opening with `--` is the caller's
 * next flag read as a filter, which matches nothing and would check
 * nothing, so it is refused too.
 */

/** The `--only` terms a command line carries, and every other argument. */
export interface OnlyArguments {
  only: string[];
  rest: string[];
}

const PREFIX = "--only=";

/**
 * Separates the `--only` terms from the rest, or says why a term cannot
 * be read.
 */
export function readOnlyArguments(
  argv: readonly string[],
): OnlyArguments | { error: string } {
  const only: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    let value: string | undefined;
    if (argument === "--only") value = argv[++i];
    else if (argument.startsWith(PREFIX)) value = argument.slice(PREFIX.length);
    else {
      rest.push(argument);
      continue;
    }
    if (value === undefined || value.length === 0) {
      return { error: "--only needs a value" };
    }
    if (value.startsWith("--")) {
      return {
        error: `--only needs a value, and was given ${JSON.stringify(value)}`,
      };
    }
    only.push(value);
  }
  return { only, rest };
}
