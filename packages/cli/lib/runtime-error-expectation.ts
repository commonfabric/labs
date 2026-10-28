/**
 * What a pattern test requires of the runtime errors its run raises, the
 * descriptor's `expectRuntimeErrors`, for the single-user runner and for each
 * participant of a multi-user test.
 *
 * An expectation REQUIRES errors rather than tolerating them, so a throwing
 * refusal that reverts to a silent return fails the test: `true` requires at
 * least one, a count exactly that many, and a list of strings one error for
 * each string, the error's text containing it, in any order. A list pins what
 * each error says as well as how many there are, so an unrelated exception, or
 * a refusal giving another reason, does not stand in for the one expected.
 * The errors an expectation counts are tolerated. Requiring no errors is what
 * a test without an expectation already does, so a count of zero and an empty
 * list are not expectations.
 */

import { debugStr } from "@commonfabric/data-model";

/** A test's `expectRuntimeErrors`, as `runtimeErrorExpectation()` reads it. */
export type RuntimeErrorExpectation = true | number | readonly string[];

/**
 * The expectation a descriptor's `expectRuntimeErrors` states: `true`, a
 * positive whole count, or a non-empty list of strings, and `undefined` where
 * it is absent or `false`.
 *
 * @throws If it is anything else, `0` and `[]` included, naming the value: an
 *   expectation misread as none would let a test that requires errors pass
 *   without them.
 */
export function runtimeErrorExpectation(
  value: unknown,
): RuntimeErrorExpectation | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (
    Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === "string")
  ) {
    return [...value];
  }
  throw new Error(
    debugStr`\`expectRuntimeErrors\` is \`true\`, a positive whole count, or a non-empty list of strings, not $quote${value}`,
  );
}

/**
 * Why the runtime errors `errors` don't meet `expected`, for a person to read,
 * or `undefined` when they do. A list is met when its strings and the errors
 * pair off one to one, each string with an error containing it; the pairing
 * is searched for, so it is found whenever one exists. A string left unpaired
 * is reported as one no error contains, or, where errors contain it but each
 * is paired with another string, as one with no error left for it.
 */
export function unmetRuntimeErrorExpectation(
  expected: RuntimeErrorExpectation,
  errors: readonly string[],
): string | undefined {
  if (expected === true) {
    return errors.length > 0
      ? undefined
      : "expected some runtime error(s), saw 0";
  }
  if (typeof expected === "number") {
    return errors.length === expected
      ? undefined
      : `expected ${expected} runtime error(s), saw ${errors.length}`;
  }
  // Each error's string, by its index in `expected`: a matching grown one
  // string at a time, each by a path that may move earlier strings to other
  // errors of theirs.
  const holder: (number | undefined)[] = errors.map(() => undefined);
  const claim = (text: number, visited: Set<number>): boolean => {
    for (let error = 0; error < errors.length; error++) {
      if (visited.has(error) || !errors[error].includes(expected[text])) {
        continue;
      }
      visited.add(error);
      const held = holder[error];
      if (held === undefined || claim(held, visited)) {
        holder[error] = text;
        return true;
      }
    }
    return false;
  };
  const missing: string[] = [];
  for (let text = 0; text < expected.length; text++) {
    if (!claim(text, new Set())) missing.push(expected[text]);
  }
  const unclaimed = errors.filter((_, error) => holder[error] === undefined);
  if (missing.length === 0 && unclaimed.length === 0) return undefined;
  return [
    `expected ${expected.length} runtime error(s), saw ${errors.length}`,
    ...missing.map((text) =>
      errors.some((error) => error.includes(text))
        ? `no error left for ${JSON.stringify(text)}`
        : `none contains ${JSON.stringify(text)}`
    ),
    ...unclaimed.map((error) => `unexpected: ${error.split("\n")[0]}`),
  ].join("; ");
}
