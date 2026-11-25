/**
 * The list of tests an invocation is not to run. A run's owner writes it to
 * a file and names that file in `CF_TEST_SKIP_LIST`; the test module
 * (`../testing.ts`) reads it when a test file loads and registers each listed
 * test as skipped, so the test still appears in the run's output and in its
 * records.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

/** Variable naming the file holding this invocation's skip list. */
export const SKIP_LIST_VARIABLE = "CF_TEST_SKIP_LIST";

/**
 * A skip list: the names this invocation is not to run, under the
 * repository-relative file that registers them. Keyed by file as well as
 * name because the same test name occurs in more than one file. A name
 * that encloses others, such as a `describe` holding several tests, skips
 * everything it encloses.
 */
export type SkipList = Record<string, string[]>;

/** Serializes a skip list for the file the environment points at. */
export function serializeSkipList(skips: SkipList): string {
  return JSON.stringify(skips, null, 2) + "\n";
}

/**
 * Parses a skip list. Returns undefined for anything that is not one, so
 * that the reader can refuse it rather than run an arbitrary subset.
 */
export function parseSkipList(text: string): SkipList | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObjectNotArray(parsed)) return undefined;
  const skips: SkipList = {};
  for (const [file, names] of Object.entries(parsed)) {
    if (!Array.isArray(names)) return undefined;
    const strings: string[] = [];
    for (const name of names) {
      if (typeof name !== "string") return undefined;
      strings.push(name);
    }
    skips[file] = strings;
  }
  return skips;
}
