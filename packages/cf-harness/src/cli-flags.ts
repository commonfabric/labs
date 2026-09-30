/**
 * Refusing a command-line flag that an entrypoint does not declare. A flag
 * nothing reads is a setting nobody applies, and where that setting is a
 * restriction the run goes ahead without it: `--allowed-tools read_file`, one
 * slip from `--allow-tool`, would leave every tool within the model's reach.
 * So an entrypoint that takes flags refuses every other one, naming it and,
 * where one is close, the declared flag it most likely meant.
 *
 * Only the flag's name reaches a refusal, never a value typed with it, since a
 * value can be a credential.
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

/**
 * The declared flag `name` most likely meant, or `undefined` where none is
 * close enough to name. Both are written without their leading dashes. The
 * distance allowed grows with the length of `name`, one edit for every four
 * characters and never less than one, so a short name does not match an
 * unrelated short name merely by being short; a single-letter alias is never
 * offered, being one edit from every other single letter.
 */
export const nearestDeclaredFlag = (
  name: string,
  declared: Iterable<string>,
): string | undefined => {
  let nearest: string | undefined;
  let nearestDistance = Infinity;
  for (const candidate of declared) {
    if (candidate.length < 2) continue;
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
 * close. `declared` is written without dashes.
 */
export const undeclaredFlagMessage = (
  flag: string,
  declared: Iterable<string>,
  surface: string,
): string => {
  const nearest = nearestDeclaredFlag(flag.replace(/^-+/, ""), declared);
  return `\`${flag}\` is not a flag of ${surface}.` +
    (nearest === undefined ? "" : ` Did you mean \`--${nearest}\`?`);
};

/**
 * A callback for the `unknown` option of `parseArgs()` that records, in
 * `into`, each undeclared flag once, as its name with the dashes it was typed
 * with and without any value. It keeps the flag in the parsed result, so a
 * surface that refuses one particular flag with a message of its own still
 * finds it there, and it leaves positional arguments as they are.
 *
 * A negative number such as `-5` is not recorded. `parseArgs()` reads it as a
 * flag, but it is a value typed for the flag before it, which `parseArgs()`
 * then leaves empty, and it is left to that flag's own check, which can say
 * that a negative value needs the `--name=<value>` spelling.
 */
export const recordUndeclaredFlags =
  (into: string[]) => (arg: string, key?: string): boolean => {
    if (key !== undefined && !/^-\d/.test(arg)) {
      const flag = `${arg.startsWith("--") ? "--" : "-"}${key}`;
      if (!into.includes(flag)) into.push(flag);
    }
    return true;
  };

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
