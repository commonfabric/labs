/**
 * The `--only` filter shared by the pattern gates.
 *
 * A gate given `--only` checks only the paths that contain one of the terms. A
 * lane passes one exact path for each unit it chose.
 *
 * A missing or empty term is an error. A run that ignored it would check
 * everything while its lane was charged for one unit. A term that starts with
 * `-` is also an error, because it is the caller's next flag rather than a
 * path.
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
    if (value.startsWith("-")) {
      return {
        error: `--only needs a value, and was given ${JSON.stringify(value)}`,
      };
    }
    only.push(value);
  }
  return { only, rest };
}
