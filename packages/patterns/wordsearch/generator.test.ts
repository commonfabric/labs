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

/**
 * How many distinct sets of cells spell `word` along `directions`, counted by
 * brute force over every start and direction, independently of the generator.
 */
const copies = (
  ws: WordSearch,
  word: string,
  directions: { dRow: number; dCol: number }[],
): number => {
  const found = new Set<string>();
  for (let row = 0; row < ws.rows; row++) {
    for (let col = 0; col < ws.cols; col++) {
      for (const { dRow, dCol } of directions) {
        const cells = [...word].map((_, i) => [row + dRow * i, col + dCol * i]);
        const spelled = cells.every(([r, c], i) =>
          r >= 0 && r < ws.rows && c >= 0 && c < ws.cols &&
          ws.grid[r][c] === word[i]
        );
        if (spelled) {
          found.add(cells.map(([r, c]) => r * ws.cols + c).sort().join(","));
        }
      }
    }
  }
  return found.size;
};

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
      expect(ws.skipped).toEqual([]);
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
      options({ rows: 5, cols: 5, words: ["Too long word", "cat"] }),
    );
    expect(ws.skipped).toEqual([{ label: "Too long word", reason: "no-room" }]);
    expect(ws.placements.map((p) => p.word)).toEqual(["CAT"]);
  });

  it("reports a word with too few letters instead of dropping it", () => {
    const ws = generateWordSearch(
      options({ words: ["a", "123", "日本", "ox"] }),
    );
    expect(ws.skipped).toEqual([
      { label: "a", reason: "too-short" },
      { label: "123", reason: "too-short" },
      { label: "日本", reason: "too-short" },
    ]);
    expect(ws.placements.map((p) => p.word)).toEqual(["OX"]);
  });

  it("keeps each word as it was written for the list", () => {
    const ws = generateWordSearch(options({ words: ["Café au lait", "fig"] }));
    expect(ws.placements.map((p) => [p.word, p.label])).toEqual([
      ["CAFEAULAIT", "Café au lait"],
      ["FIG", "fig"],
    ]);
  });

  it("hides every word exactly once, however short", () => {
    const short = ["cat", "dog", "sun", "ant", "bee", "ox", "pop", "noon"];
    for (const [diagonals, backwards] of [[false, false], [true, true]]) {
      const directions = directionsFor({ diagonals, backwards });
      for (let seed = 0; seed < 60; seed++) {
        const ws = generateWordSearch(
          options({
            words: short,
            rows: 8,
            cols: 8,
            diagonals,
            backwards,
            seed,
          }),
        );
        for (const p of ws.placements) {
          expect({ seed, word: p.word, copies: copies(ws, p.word, directions) })
            .toEqual({ seed, word: p.word, copies: 1 });
        }
      }
    }
  });

  it("finds a word spelled inside a longer one there, not twice", () => {
    for (let seed = 0; seed < 30; seed++) {
      const ws = generateWordSearch(
        options({ words: ["catalog", "cat"], rows: 8, cols: 8, seed }),
      );
      const [catalog, cat] = ws.placements;
      expect(placementCells(cat, 8))
        .toEqual(placementCells(catalog, 8).slice(0, 3));
    }
  });

  it("lets words cross where their letters agree", () => {
    const crossed = Array.from(
      { length: 20 },
      (_, seed) => generateWordSearch(options({ seed, rows: 9, cols: 9 })),
    ).some((ws) => {
      const all = ws.placements.flatMap((p) => placementCells(p, ws.cols));
      return new Set(all).size < all.length;
    });
    expect(crossed).toBe(true);
  });

  it("fills the empty cells with varied letters", () => {
    const ws = generateWordSearch(options({ words: ["kiwi"] }));
    const used = new Set(placementCells(ws.placements[0], ws.cols));
    const filler = [...ws.grid.join("")].filter((_, i) => !used.has(i));
    expect(new Set(filler).size).toBeGreaterThan(15);
  });

  it("merges repeats after normalizing, keeping the first spelling", () => {
    const ws = generateWordSearch(
      options({ words: ["Kiwi", "kiwi!", "K I W I"] }),
    );
    expect(ws.placements.map((p) => [p.word, p.label])).toEqual([
      ["KIWI", "Kiwi"],
    ]);
  });

  it("refuses a size outside the supported range", () => {
    expect(() => generateWordSearch(options({ rows: 3 }))).toThrow(RangeError);
    expect(() => generateWordSearch(options({ cols: 31 }))).toThrow(RangeError);
    expect(() => generateWordSearch(options({ cols: 7.5 }))).toThrow(
      RangeError,
    );
  });
});
