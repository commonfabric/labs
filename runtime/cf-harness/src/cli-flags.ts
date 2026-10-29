/**
 * Refusing a command-line flag that an entrypoint does not declare. A flag
 * nothing reads is a setting nobody applies, and where that setting is a
 * restriction the run goes ahead without it: `--allowed-tools read_file`, one
 * slip from `--allow-tool`, would leave every tool within the model's reach.
 * So an entrypoint that takes flags refuses every other one, naming it and,
 * where one is close, the declared flag it most likely meant.
 *
 * Only the flag's name reaches a refusal, never a value typed with it, since a
 * value can be a credential or a prompt. A value that starts with `-` is where
 * the two meet: `parseArgs()` never takes such a word as a flag's value, so it
 * leaves the flag empty and reads the word as flags of its own. That is
 * refused as a flag given no value, before any word of it could be named.
 */

import { HarnessControlError } from "./control-errors.ts";

/**
 * The edit distance between `left` and `right`. An adjacent transposition
 * counts as one edit rather than two, because it is the commonest slip in a
 * typed name.
 */
const editDistance = (left: string, right: string): number => {
  const rows: number[][] = [
    Array.from({ length: right.length + 1 }, (_, j) => j),
  ];
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    const previous = rows[i - 1];
    for (let j = 1; j <= right.length; j++) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]
        : 1 + Math.min(previous[j - 1], previous[j], current[j - 1]);
      if (
        i > 1 && j > 1 && left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        current[j] = Math.min(current[j], rows[i - 2][j - 2] + 1);
      }
    }
    rows.push(current);
  }
  return rows[left.length][right.length];
};

/** What a flag's name can be, and so the only kind of word a refusal names. */
const FLAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether `name`, written without its dashes, is one a refusal may repeat: it
 * could be a flag's name, and it does not start with a digit, since a word
 * that starts with `-` and then a digit is most likely a negative number.
 */
export const isNameable = (name: string): boolean =>
  FLAG_NAME.test(name) && !/^[0-9]/.test(name);

/**
 * Helper for `nearestDeclaredFlag()`, which returns whether `name` is negated:
 * an odd count of leading `no-`.
 */
const negated = (name: string): boolean => {
  let count = 0;
  while (name.startsWith("no-", count * 3)) count += 1;
  return count % 2 === 1;
};

/**
 * The declared flag `name` most likely meant, or `undefined` where none is
 * close enough to name. Both are written without their leading dashes. The
 * distance allowed grows with the length of `name`, one edit for every four
 * characters and never less than one, so a short name does not match an
 * unrelated short name merely by being short; a single-letter alias is never
 * offered, being one edit from every other single letter, and neither is a
 * flag that `no-` sets the other way, which would mean the opposite.
 */
export const nearestDeclaredFlag = (
  name: string,
  declared: Iterable<string>,
): string | undefined => {
  let nearest: string | undefined;
  let nearestDistance = Infinity;
  for (const candidate of declared) {
    if (candidate.length < 2 || negated(candidate) !== negated(name)) continue;
    const distance = editDistance(name, candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= Math.max(1, Math.floor(name.length / 4))
    ? nearest
    : undefined;
};

/**
 * The sentence refusing `flag`, written with its leading dashes, as a flag
 * `surface` does not take, followed by the nearest of `declared` where one is
 * close. `declared` is written without dashes. A declared flag here is a
 * switch that was given a value, which is said instead. A word that could not
 * be a flag's name, one with a space in it, say, is not repeated, and neither
 * is one that starts with a digit, since what starts with `-` and is no flag
 * is most likely a value, a negative number among them.
 */
export const undeclaredFlagMessage = (
  flag: string,
  declared: Iterable<string>,
  surface: string,
): string => {
  const name = flag.replace(/^-+/, "");
  if (!isNameable(name)) {
    return `An argument starting with \`-\` is not a flag of ${surface}. A ` +
      "value starting with `-` needs the `--<flag>=<value>` spelling.";
  }
  const names = [...declared];
  if (names.includes(name)) return `\`${flag}\` takes no value.`;
  const nearest = nearestDeclaredFlag(name, names);
  return `\`${flag}\` is not a flag of ${surface}.` +
    (nearest === undefined ? "" : ` Did you mean \`--${nearest}\`?`);
};

/**
 * A callback for the `unknown` option of `parseArgs()` that records, in
 * `into`, each undeclared flag once, as the word it was typed as up to any
 * `=`. That is the name `parseArgs()` was handed, which is not always the one
 * it files the flag under: `--no-x=true` goes under `x`, and `-hidden` is
 * taken letter by letter. The callback keeps the flag in the parsed result, so
 * a surface that refuses one particular flag with a message of its own still
 * finds it there, and it leaves positional arguments as they are. A dotted
 * flag, `--prompt.x`, is the exception: `parseArgs()` would write it into the
 * flag before the dot, and, where that holds a string, throw a TypeError
 * quoting it. Every `parseArgs()` over a caller's arguments is handed this,
 * and what it records is refused.
 */
export const recordUndeclaredFlags =
  (into: string[]) => (arg: string, key?: string): boolean => {
    if (key === undefined) return true;
    const flag = arg.split("=")[0];
    if (!into.includes(flag)) into.push(flag);
    return !key.includes(".");
  };

/** The words that ask an entrypoint for its usage. */
export const HELP_SPELLINGS: readonly string[] = ["--help", "-h"];

/**
 * Whether `argv`, up to its first `--`, holds one of `spellings` as a word of
 * its own, which is how help is asked for. A `-h` inside another word asks for
 * nothing: `parseArgs()` would read the value `-hidden` as `-h` and five more
 * letters, where what its flag needs is the refusal of a flag given no value.
 */
export const argvHolds = (
  argv: readonly string[],
  spellings: readonly string[],
): boolean => {
  const end = argv.indexOf("--") === -1 ? argv.length : argv.indexOf("--");
  return argv.slice(0, end).some((argument) => spellings.includes(argument));
};

/**
 * The refusal of the first flag named in `valued` that is written with no
 * value, or `undefined` where there is none. A flag has no value when it is
 * last before the end of `argv` or its first `--`, or when the word after it
 * starts with `-`: `parseArgs()` never takes such a word as a value, so it
 * leaves the flag empty and reads the word as flags. The word, which may be a
 * whole prompt, is not repeated. A value written `--name=<value>` is not
 * refused here, whatever it starts with or however empty it is. `valued` is
 * written without dashes.
 */
export const flagWithoutValue = (
  argv: readonly string[],
  valued: Iterable<string>,
): string | undefined => {
  const names = new Set(valued);
  const end = argv.indexOf("--") === -1 ? argv.length : argv.indexOf("--");
  for (let index = 0; index < end; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") || !names.has(argument.slice(2))) continue;
    if (index + 1 === end) return `\`${argument}\` was given no value`;
    if (argv[index + 1].startsWith("-")) {
      return `\`${argument}\` was given no value; a value starting with ` +
        `\`-\` needs the \`${argument}=<value>\` spelling`;
    }
  }
  return undefined;
};

/**
 * Refuses the first flag named in `valued` that is written with no value, as
 * `flagWithoutValue()` finds it. A caller that answers `--help` does this
 * first, since the `-h` a missing value leaves behind is not a question.
 *
 * @throws HarnessControlError `invalid-request` for the first such flag.
 */
export const refuseFlagsWithoutValue = (
  argv: readonly string[],
  valued: Iterable<string>,
): void => {
  const refusal = flagWithoutValue(argv, valued);
  if (refusal !== undefined) {
    throw new HarnessControlError("invalid-request", refusal);
  }
};

/**
 * The flag list of a usage text: the flags taking a value, then the switches,
 * one to a line and each with its dashes. Both are written without dashes.
 */
export const flagUsageLines = (
  valued: Iterable<string>,
  switches: Iterable<string>,
): string[] => [
  "Flags that take a value, written `--name <value>`, or `--name=<value>` for",
  "a value starting with `-`:",
  ...[...valued].map((name) => `  --${name}`),
  "Switches:",
  ...[...switches].map((name) => `  --${name}`),
];

/**
 * Refuses the first flag of `undeclared` as one `surface` does not take.
 * `declared` is written without dashes, and supplies the suggestion.
 *
 * @throws HarnessControlError `invalid-request` when `undeclared` holds a flag,
 * so that a host reporting structured failures passes the flag's name on.
 */
export const refuseUndeclaredFlags = (
  undeclared: readonly string[],
  declared: Iterable<string>,
  surface: string,
): void => {
  if (undeclared.length === 0) return;
  throw new HarnessControlError(
    "invalid-request",
    undeclaredFlagMessage(undeclared[0], declared, surface),
  );
};
