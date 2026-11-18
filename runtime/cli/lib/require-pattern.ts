import { isObjectOrArray } from "@commonfabric/js-values/types";
import { isPattern, type Pattern } from "@commonfabric/runner";

/**
 * `value`, which a test file names as a pattern.
 *
 * @throws If `value` is not a pattern function, with a message that states
 *   `requirement` and then what `value` is instead.
 */
export function requirePattern(value: unknown, requirement: string): Pattern {
  if (typeof value !== "function") {
    throw new Error(`${requirement}, got ${typeof value}`);
  }
  if (!isPattern(value)) {
    throw new Error(`${requirement}, got a function that is not a pattern`);
  }
  return value;
}

/** What a participant entry names: the entry itself, or its `pattern`. */
function participantFactoryOf(entry: unknown): unknown {
  return isObjectOrArray(entry) ? entry.pattern : entry;
}

/**
 * Whether `entry` has the shape of a multi-user descriptor's participant: a
 * function, or a `{ pattern, user?, access? }` entry whose `pattern` is one.
 */
export function isParticipantEntry(entry: unknown): boolean {
  return typeof participantFactoryOf(entry) === "function";
}

/**
 * The pattern a multi-user descriptor's participant `name` runs: `entry`
 * itself, or the `pattern` of a `{ pattern, user?, access? }` entry. Returns
 * `undefined` for an entry of neither shape.
 *
 * @throws If that function is not a pattern.
 */
export function participantPatternOf(
  name: string,
  entry: unknown,
): Pattern | undefined {
  if (!isParticipantEntry(entry)) return undefined;
  return requirePattern(
    participantFactoryOf(entry),
    `Participant \`${name}\` must be a pattern function`,
  );
}
