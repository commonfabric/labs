import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  directionsFor,
  generateWordSearch,
  normalizeWord,
  parseWordList,
  placementCells,
  type WordSearch,
  type WordSearchOptions,
} from "./generator.ts";

const WORDS = [
  "apple",
  "banana",
  "cherry",
  "date",
  "elderberry",
  "fig",
  "grape",
  "kiwi",
];

const options = (
  overrides: Partial<WordSearchOptions> = {},
): WordSearchOptions => ({
  words: WORDS,
  rows: 12,
  cols: 12,
  diagonals: true,
  backwards: true,
  seed: 1,
  ...overrides,
});

/** The letters a placement covers, read back off the grid. */
const readBack = (ws: WordSearch, index: number): string =>
  placementCells(ws.placements[index], ws.cols)
    .map((cell) => ws.grid[Math.floor(cell / ws.cols)][cell % ws.cols])
    .join("");

const key = (d: { dRow: number; dCol: number }) => `${d.dRow},${d.dCol}`;

describe("directionsFor", () => {
  it("gives right and down when both switches are off", () => {
    expect(directionsFor({ diagonals: false, backwards: false }).map(key))
      .toEqual(["0,1", "1,0"]);
  });

  it("adds the two left-to-right diagonals, and nothing backwards", () => {
    expect(directionsFor({ diagonals: true, backwards: false }).map(key))
      .toEqual(["0,1", "1,0", "1,1", "-1,1"]);
  });

  it("adds left and up, and no diagonal", () => {
    expect(directionsFor({ diagonals: false, backwards: true }).map(key))
      .toEqual(["0,1", "1,0", "0,-1", "-1,0"]);
  });

  it("gives all eight distinct directions when both are on", () => {
    const all = directionsFor({ diagonals: true, backwards: true }).map(key);
    expect(new Set(all).size).toBe(8);
    expect(all).not.toContain("0,0");
  });
});

describe("normalizeWord and parseWordList", () => {
  it("drops accents, spaces and punctuation and upper-cases", () => {
    expect(normalizeWord("Café au lait!")).toBe("CAFEAULAIT");
    expect(normalizeWord("  ")).toBe("");
  });

  it("splits on lines and commas, keeping a phrase on its line whole", () => {
    expect(parseWordList("ice cream\n fig, kiwi ,,\n\n")).toEqual([
      "ice cream",
      "fig",
      "kiwi",
    ]);
  });
});

describe("generateWordSearch", () => {
  it("hides every word so it reads back off the grid", () => {
    for (const seed of [1, 2, 3, 42, 99999]) {
      const ws = generateWordSearch(options({ seed }));
      expect(ws.unplaced).toEqual([]);
      expect(ws.placements.map((p) => p.word).sort()).toEqual(
        WORDS.map(normalizeWord).sort(),
      );
      ws.placements.forEach((p, i) => expect(readBack(ws, i)).toBe(p.word));
    }
  });

  it("fills a rows × cols grid with only A–Z", () => {
    const ws = generateWordSearch(options({ rows: 9, cols: 14 }));
    expect(ws.grid.length).toBe(9);
    for (const row of ws.grid) expect(row).toMatch(/^[A-Z]{14}$/);
  });

  it("uses only the permitted directions", () => {
    for (const diagonals of [false, true]) {
      for (const backwards of [false, true]) {
        const allowed = directionsFor({ diagonals, backwards }).map(key);
        for (let seed = 0; seed < 20; seed++) {
          const ws = generateWordSearch(
            options({ diagonals, backwards, seed }),
          );
          for (const p of ws.placements) expect(allowed).toContain(key(p));
        }
      }
    }
  });

  it("uses the extra directions once they are allowed", () => {
    const used = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      generateWordSearch(options({ seed })).placements.forEach((p) =>
        used.add(key(p))
      );
    }
    expect(used.size).toBe(8);
  });

  it("is a pure function of its options", () => {
    expect(generateWordSearch(options({ seed: 7 })))
      .toEqual(generateWordSearch(options({ seed: 7 })));
    expect(generateWordSearch(options({ seed: 7 })).grid)
      .not.toEqual(generateWordSearch(options({ seed: 8 })).grid);
  });

  it("reports a word too long for the grid instead of dropping it", () => {
    const ws = generateWordSearch(
      options({ rows: 5, cols: 5, words: ["toolongword", "cat"] }),
    );
    expect(ws.unplaced).toEqual(["TOOLONGWORD"]);
    expect(ws.placements.map((p) => p.word)).toEqual(["CAT"]);
  });

  it("merges repeats and blanks after normalizing", () => {
    const ws = generateWordSearch(
      options({ words: ["Kiwi", "kiwi!", " ", "K I W I"] }),
    );
    expect(ws.placements.map((p) => p.word)).toEqual(["KIWI"]);
  });

  it("refuses a size outside the supported range", () => {
    expect(() => generateWordSearch(options({ rows: 3 }))).toThrow(RangeError);
    expect(() => generateWordSearch(options({ cols: 31 }))).toThrow(RangeError);
    expect(() => generateWordSearch(options({ cols: 7.5 }))).toThrow(
      RangeError,
    );
  });
});
