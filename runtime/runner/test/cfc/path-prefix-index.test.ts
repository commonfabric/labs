import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { isPrefix, PathPrefixIndex } from "../../src/cfc/path-prefix-index.ts";
import { PATH_INDEX_GRID, pathIndexCorpus } from "./path-index-corpus.ts";

function scan(sources: readonly string[][], path: readonly string[]): boolean {
  return sources.some((source) => isPrefix(source, path));
}

function indexOf(sources: readonly string[][]): PathPrefixIndex {
  const index = new PathPrefixIndex();
  for (const source of sources) index.add(source);
  return index;
}

describe("path-prefix-index", () => {
  for (const { size, fraction } of PATH_INDEX_GRID) {
    it(`agrees with a scan for ${size} sources with ${fraction} wildcard fraction`, () => {
      const { sources, queries } = pathIndexCorpus(size, fraction);
      const index = indexOf(sources);
      let hits = 0;
      for (const query of queries) {
        const expected = scan(sources, query);
        expect(index.hasPrefixOf(query)).toBe(expected);
        expect(index.overlaps(query)).toBe(
          sources.some((source) =>
            isPrefix(source, query) || isPrefix(query, source)
          ),
        );
        hits += Number(expected);
      }
      expect(hits).toBeGreaterThan(0);
      expect(hits).toBeLessThan(queries.length);
      expect(sources.filter((path) => path.includes("*")).length).toBe(
        Math.floor(size * fraction),
      );
    });
  }

  it("finds an exact path", () => {
    expect(indexOf([["a", "b"]]).hasPrefixOf(["a", "b"])).toBe(true);
  });

  it("finds a shorter path that prefixes the query", () => {
    expect(indexOf([["a"]]).hasPrefixOf(["a", "b", "c"])).toBe(true);
  });

  it("rejects a longer path, which cannot be a prefix", () => {
    expect(indexOf([["a", "b", "c"]]).hasPrefixOf(["a", "b"])).toBe(false);
  });

  it("rejects a path that diverges", () => {
    expect(indexOf([["a", "x"]]).hasPrefixOf(["a", "b", "c"])).toBe(false);
  });

  it("matches an empty source against anything, including an empty query", () => {
    expect(indexOf([[]]).hasPrefixOf(["a"])).toBe(true);
    expect(indexOf([[]]).hasPrefixOf([])).toBe(true);
  });

  it("finds nothing in an empty index", () => {
    expect(indexOf([]).hasPrefixOf(["a"])).toBe(false);
    expect(indexOf([]).hasPrefixOf([])).toBe(false);
    expect(indexOf([]).overlaps([])).toBe(false);
    expect(indexOf([]).overlaps(["*"])).toBe(false);
  });

  it("takes a wildcard in the source as matching any segment", () => {
    expect(indexOf([["a", "*"]]).hasPrefixOf(["a", "zzz", "c"])).toBe(true);
  });

  it("takes a wildcard in the query as matched by any segment", () => {
    expect(indexOf([["a", "b"]]).hasPrefixOf(["a", "*", "c"])).toBe(true);
  });

  it("follows a literal branch when a wildcard branch dead-ends", () => {
    // The wildcard child matches "b" at depth 1 and then stops; the literal
    // branch is the one that reaches a terminal. A walk that committed to the
    // wildcard would miss it.
    expect(indexOf([["*", "q"], ["b", "c"]]).hasPrefixOf(["b", "c"]))
      .toBe(true);
  });

  it("adds a repeated path once, so a wildcard query does not rescan it", () => {
    // `add` is documented as a no-op for a repeat, and the scanned copy the
    // wildcard fallback reads has to honour that too.
    const index = new PathPrefixIndex();
    index.add(["a", "b"]);
    index.add(["a", "b"]);
    expect(index.accessForTestingOnly.scannedPaths).toEqual([["a", "b"]]);
    expect(index.hasPrefixOf(["a", "*"])).toBe(true);
  });

  it("copies the path, so a caller reusing its array cannot change the set", () => {
    // The mutation has to be one the assertion can see. Mutating a LATER
    // segment is invisible: the trie captured every segment as a Map key at
    // add time, and a wildcard query matches the mutated segment anyway. So
    // mutate the FIRST segment and ask a wildcard query, which reads the
    // retained copy and cannot match a source whose head has changed.
    const mutable = ["a", "b"];
    const index = new PathPrefixIndex();
    index.add(mutable);
    mutable[0] = "zzz";

    expect(index.hasPrefixOf(["a", "*"])).toBe(true);
    expect(index.accessForTestingOnly.scannedPaths).toEqual([["a", "b"]]);
  });

  it("copies and deduplicates wildcard sources without hiding later concrete paths", () => {
    const index = new PathPrefixIndex();
    const path = ["a", "*", "tail", "*"];
    index.add(path);
    index.add(path);
    path[2] = "changed";
    index.add(["a", "b", "other"]);

    expect(index.accessForTestingOnly.scannedPaths).toEqual([
      ["a", "*", "tail", "*"],
      ["a", "b", "other"],
    ]);
    expect(index.hasPrefixOf(["a", "b", "tail", "c"])).toBe(true);
    expect(index.hasPrefixOf(["a", "b", "changed", "c"])).toBe(false);
    expect(index.hasPrefixOf(["a", "b", "other"])).toBe(true);
    expect(index.hasPrefixOf(["a", "b", "tail"])).toBe(false);
    expect(index.hasPrefixOf(["a"])).toBe(false);
    expect(index.hasPrefixOf(["a", "*", "tail", "c"])).toBe(true);
  });

  it("agrees with a linear scan across a generated corpus", () => {
    const segments = ["a", "b", "c", "*"];
    const paths: string[][] = [[]];
    for (const one of segments) {
      paths.push([one]);
      for (const two of segments) {
        paths.push([one, two]);
        for (const three of segments) paths.push([one, two, three]);
      }
    }
    // Every source set of a manageable size, against every query path.
    let compared = 0;
    for (let i = 0; i < paths.length; i += 3) {
      const sources = [
        paths[i],
        paths[(i + 11) % paths.length],
        paths[(i + 29) % paths.length],
      ];
      const index = indexOf(sources);
      for (const path of paths) {
        expect(index.hasPrefixOf(path)).toBe(scan(sources, path));
        expect(index.overlaps(path)).toBe(
          sources.some((source) =>
            isPrefix(source, path) || isPrefix(path, source)
          ),
        );
        compared++;
      }
    }
    // Guard the guard: a loop that compared nothing would pass silently.
    expect(compared).toBeGreaterThan(2000);
  });
});
