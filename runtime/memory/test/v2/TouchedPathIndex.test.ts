/**
 * Holds `TouchedPathIndex` to a scan of the paths it was given under the
 * predicates it indexes, across every set of one or two paths drawn from a
 * generated corpus.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { isPrefixPath, pathsOverlap } from "../../v2/path.ts";
import { TouchedPathIndex } from "../../v2/touched-path-index.ts";

/** Returns every path over `segments` of each length up to `depth`. */
const pathsUpTo = (
  segments: readonly string[],
  depth: number,
): string[][] => {
  const paths: string[][] = [[]];
  let layer: string[][] = [[]];
  for (let length = 1; length <= depth; length++) {
    layer = layer.flatMap((path) =>
      segments.map((segment) => [...path, segment])
    );
    for (const path of layer) paths.push(path);
  }
  return paths;
};

// The empty segment is what `/` parses to, and `__proto__` is a key a plain
// object would treat specially.
const segments = ["a", "b", "", "__proto__"];
const added = pathsUpTo(segments, 2);
const queries = pathsUpTo(segments, 3);

/** A path added to an index, and the `seq` it is added with. */
type Entry = readonly [path: string[], seq: number];

/**
 * Every set of one or two added paths, with each order of their `seq`s and
 * with a tie, and one set holding all of `added` at scrambled `seq`s.
 */
const addedSets: (readonly Entry[])[] = [
  ...added.map((path): Entry[] => [[path, 1]]),
  ...added.flatMap((first) =>
    added.flatMap((second): Entry[][] => [
      [[first, 1], [second, 2]],
      [[first, 2], [second, 1]],
      [[first, 1], [second, 1]],
    ])
  ),
  added.map((path, index): Entry => [path, (index * 7) % added.length + 1]),
];

/** Returns the newest `seq` among `entries` whose path `accepts`. */
const newestAccepted = (
  entries: readonly Entry[],
  accepts: (path: readonly string[]) => boolean,
): number | undefined => {
  let newest: number | undefined;
  for (const [path, seq] of entries) {
    if (accepts(path) && (newest === undefined || seq > newest)) {
      newest = seq;
    }
  }
  return newest;
};

/** Returns an index holding `entries`. */
const indexOf = (entries: readonly Entry[]): TouchedPathIndex => {
  const index = new TouchedPathIndex();
  for (const [path, seq] of entries) index.add(path, seq);
  return index;
};

describe("TouchedPathIndex", () => {
  describe("instance members", () => {
    describe("newestPrefixOf()", () => {
      it("returns what a scan under `isPrefixPath()` returns, for every query over every set of one or two paths", () => {
        let checked = 0;
        for (const entries of addedSets) {
          const index = indexOf(entries);
          for (const query of queries) {
            expect({ entries, query, newest: index.newestPrefixOf(query) })
              .toEqual({
                entries,
                query,
                newest: newestAccepted(
                  entries,
                  (path) => isPrefixPath(path, query),
                ),
              });
            checked++;
          }
        }
        expect(checked).toBe(addedSets.length * queries.length);
      });
    });

    describe("newestOverlapping()", () => {
      it("returns what a scan under `pathsOverlap()` returns, for every query over every set of one or two paths", () => {
        let checked = 0;
        for (const entries of addedSets) {
          const index = indexOf(entries);
          for (const query of queries) {
            expect({ entries, query, newest: index.newestOverlapping(query) })
              .toEqual({
                entries,
                query,
                newest: newestAccepted(
                  entries,
                  (path) => pathsOverlap(path, query),
                ),
              });
            checked++;
          }
        }
        expect(checked).toBe(addedSets.length * queries.length);
      });
    });
  });
});
