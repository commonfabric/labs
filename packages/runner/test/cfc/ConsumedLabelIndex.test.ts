import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { canonicalizeLogicalPath } from "../../src/cfc/canonical.ts";
import { ConsumedLabelIndex } from "../../src/cfc/consumed-label-index.ts";
import { isPrefix } from "../../src/cfc/path-prefix-index.ts";
import type { LabelMapEntry } from "../../src/cfc/types.ts";
import { PATH_INDEX_GRID, pathIndexCorpus } from "./path-index-corpus.ts";

const entry = (path: string[], ordinal: number): LabelMapEntry => ({
  path,
  label: { confidentiality: [String(ordinal)] },
});

describe("ConsumedLabelIndex", () => {
  it("retains canonical payload paths and duplicate covering entries", () => {
    const paths = [
      [],
      ["value"],
      ["value", "*"],
      ["value", "field"],
      ["value", "field"],
      ["value", "field", "child"],
      ["field"],
    ];
    const entries = paths.map(entry);
    const index = new ConsumedLabelIndex(entries);
    paths[3].push("changed");
    expect(
      index.overlapping(["value", "field"], false).map((item) => item.ordinal),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(index.overlapping([], false).map((item) => item.ordinal)).toEqual([
      0,
    ]);
    expect(index.overlapping(["value", "*"], false).map((item) => item.ordinal))
      .toEqual([0, 1, 2, 3, 4]);
  });

  it("limits a trailing wildcard cover to its child depth while retaining ancestor sources", () => {
    const entries = [
      ["root", "child", "deep"],
      ["*"],
      ["root", "*"],
      ["root", "sibling"],
      ["root"],
      ["elsewhere", "*"],
      ["root", "*", "deep"],
      [],
      ["*", "*"],
    ].map(entry);
    const index = new ConsumedLabelIndex(entries);
    for (const descendants of [true, false]) {
      const query = ["root", "*"];
      expect(index.overlapping(query, descendants).map(({ entry }) => entry))
        .toEqual(entries.filter(({ path }) =>
          isPrefix(path, query) ||
          (descendants && isPrefix(query, path))
        ));
    }
  });

  for (const { size, fraction } of PATH_INDEX_GRID) {
    it(`retains scan order for ${size} sources with ${fraction} wildcard fraction`, () => {
      const { sources, queries } = pathIndexCorpus(size, fraction);
      const entries = sources.map(entry);
      const index = new ConsumedLabelIndex(entries);
      for (const query of queries) {
        const expected = entries.filter((item) =>
          isPrefix(item.path, query) || isPrefix(query, item.path)
        );
        expect(index.overlapping(query).map((item) => item.entry)).toEqual(
          expected,
        );
        expect(index.overlapping(query, false).map((item) => item.entry))
          .toEqual(entries.filter((item) => isPrefix(item.path, query)));
      }
    });
  }

  it("retains label-map order across ancestors, descendants, and duplicate paths", () => {
    const entries = [
      ["a", "b", "child"],
      [],
      ["other"],
      ["a", "b"],
      ["a"],
      ["a", "b"],
      ["value", "a", "b"],
    ].map(entry);
    const index = new ConsumedLabelIndex(entries);

    expect(index.overlapping(["a", "b"]).map((item) => item.entry)).toEqual([
      entries[0],
      entries[1],
      entries[3],
      entries[4],
      entries[5],
    ]);
    expect(index.overlapping([]).map((item) => item.entry)).toEqual(entries);
    expect(index.overlapping(["missing"]).map((item) => item.entry)).toEqual([
      entries[1],
    ]);
    expect(new ConsumedLabelIndex([]).overlapping(["a"])).toEqual([]);
  });

  it("agrees with the prefix predicate across concrete and wildcard paths", () => {
    const paths: string[][] = [[], ["a/b"], ["a", "b"], ["~1"], ["value", "a"]];
    let level: string[][] = [[]];
    for (let depth = 1; depth <= 3; depth++) {
      level = level.flatMap((path) =>
        ["a", "b", "", "*"].map((part) => [
          ...path,
          part,
        ])
      );
      paths.push(...level);
    }
    for (const withWildcards of [false, true]) {
      const entries = paths.filter((path) =>
        withWildcards || !path.includes("*")
      ).reverse().map(entry);
      const index = new ConsumedLabelIndex(entries);
      for (const query of paths) {
        const path = canonicalizeLogicalPath(query);
        const expected = entries.filter((item) => {
          const source = canonicalizeLogicalPath(item.path);
          return isPrefix(source, path) || isPrefix(path, source);
        });
        expect(index.overlapping(path).map((item) => item.entry)).toEqual(
          expected,
        );
        expect(index.overlapping(path, false).map((item) => item.entry))
          .toEqual(
            entries.filter((item) =>
              isPrefix(canonicalizeLogicalPath(item.path), path)
            ),
          );
      }
    }
  });

  it("keeps a payload field named value after the storage prefix is removed", () => {
    const wanted = entry(["value", "value", "field"], 0);
    const unrelated = entry(["field"], 1);
    const index = new ConsumedLabelIndex([wanted, unrelated]);
    const logicalPath = canonicalizeLogicalPath(["value", "value", "field"]);

    expect(index.overlapping(logicalPath).map((item) => item.entry)).toEqual([
      wanted,
    ]);
  });

  it("matches wildcard tails and shorter queries in label-map order", () => {
    const entries = [
      ["a", "*", "tail", "*"],
      ["a", "b", "leaf"],
      ["*", "b", "other"],
      ["a", "b", "*"],
      ["a", "*", "tail", "*"],
      [],
      ["elsewhere", "*"],
    ].map(entry);
    const index = new ConsumedLabelIndex(entries);
    for (
      const query of [
        [],
        ["a"],
        ["a", "b"],
        ["a", "b", "tail"],
        ["a", "b", "tail", "c", "d"],
        ["a", "b", "other"],
        ["a", "b", "missing"],
        ["missing"],
        ["a", "*", "tail"],
      ]
    ) {
      const expected = entries.filter((item) =>
        isPrefix(item.path, query) || isPrefix(query, item.path)
      );
      expect(index.overlapping(query).map((item) => item.entry)).toEqual(
        expected,
      );
    }
  });
  describe("constructor()", () => {
    it("keeps a leading `value` segment of an entry's path as a field name", () => {
      const entries = [["value", "field"], ["field"], []].map(entry);
      const index = new ConsumedLabelIndex(entries);
      expect(index.overlapping(["value", "field"]).map((item) => item.entry))
        .toEqual([entries[0], entries[2]]);
      expect(index.overlapping(["field"]).map((item) => item.entry))
        .toEqual([entries[1], entries[2]]);
    });

    it("retains a supplied path when its caller reuses the input array", () => {
      const path = ["value", "*"];
      const original = entry(path, 0);
      const index = new ConsumedLabelIndex([original]);
      path[0] = "other";
      expect(index.overlapping(["value", "field"]).map((item) => item.entry))
        .toEqual([original]);
      expect(index.overlapping(["other", "field"])).toEqual([]);
    });
  });

  describe("instance members", () => {
    describe("overlapping()", () => {
      it("returns only prefix entries when descendants are excluded", () => {
        const paths = [
          [],
          ["a"],
          ["a", "*"],
          ["a", "*", "c"],
          ["a", "b"],
          ["a", "b", "c"],
          ["a", "b", "*"],
          ["other"],
        ];
        const entries = paths.map(entry);
        const index = new ConsumedLabelIndex(entries);
        for (const path of [...paths, ["missing"], ["*"], ["a", "*", "*"]]) {
          expect(index.overlapping(path, false).map((item) => item.entry))
            .toEqual(entries.filter((item) => isPrefix(item.path, path)));
        }
      });
    });
  });
});
