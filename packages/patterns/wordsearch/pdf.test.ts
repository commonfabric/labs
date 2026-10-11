import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { generateWordSearch, type WordSearchOptions } from "./generator.ts";
import { textWidth, wordSearchPdf } from "./pdf.ts";

const puzzle = (overrides: Partial<WordSearchOptions> = {}) =>
  generateWordSearch({
    words: ["apple", "Banana", "Café au lait", "kiwi"],
    rows: 8,
    cols: 12,
    diagonals: true,
    backwards: true,
    seed: 3,
    ...overrides,
  });

/** The content stream of each page, in page order. */
const streams = (pdf: string): string[] =>
  [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);

/** Every string a content stream draws with `Tj`, unescaped. */
const drawnText = (content: string): string[] =>
  [...content.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) =>
    m[1].replace(/\\(.)/g, "$1")
  );

/** The size every `Tf` on a page sets, in order. */
const fontSizes = (content: string): number[] =>
  [...content.matchAll(/\/F\d ([\d.]+) Tf/g)].map((m) => Number(m[1]));

/** The side of a grid cell: the frame's width over the column count. */
const cellSide = (content: string, cols: number): number =>
  Number(
    content.match(/re S/) &&
      content.match(/[\d.]+ [\d.]+ ([\d.]+) [\d.]+ re S/)![1],
  ) /
  cols;

describe("wordSearchPdf", () => {
  const ws = puzzle();
  const pdf = wordSearchPdf(ws, "Fruit (Café) \\ Search ✓");

  it("is ASCII, so string offsets are byte offsets", () => {
    expect([...pdf].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it("has an xref table whose every offset lands on its object", () => {
    const startxref = Number(pdf.match(/startxref\n(\d+)\n%%EOF\n$/)![1]);
    expect(pdf.slice(startxref).startsWith("xref\n")).toBe(true);
    const offsets = [...pdf.slice(startxref).matchAll(/(\d{10}) 00000 n /g)]
      .map((m) => Number(m[1]));
    expect(offsets.length).toBe(9);
    offsets.forEach((offset, i) =>
      expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj\n`)).toBe(true)
    );
  });

  it("declares each stream's exact length", () => {
    for (const m of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = m.index! + m[0].length;
      expect(pdf.slice(start + Number(m[1]))).toMatch(/^\nendstream/);
    }
  });

  it("puts the puzzle and the words as written on page one", () => {
    const [page] = streams(pdf);
    const drawn = drawnText(page);
    expect(drawn[0]).toBe("Fruit (Cafe) \\ Search ");
    expect(drawn.slice(1, 1 + ws.rows)).toEqual(ws.grid);
    expect(drawn.slice(1 + ws.rows))
      .toEqual(["APPLE", "BANANA", "CAFE AU LAIT", "KIWI"]);
    // No answer bands on the puzzle page.
    expect(page).not.toMatch(/ l S/);
  });

  it("marks one band per word on the answer key, and no word list", () => {
    const [, key] = streams(pdf);
    const drawn = drawnText(key);
    expect(drawn[0]).toBe("Fruit (Cafe) \\ Search  - Answer key");
    expect(drawn.slice(1)).toEqual(ws.grid);
    expect([...key.matchAll(/ l S/g)].length).toBe(ws.placements.length);
  });
});

describe("wordSearchPdf with many words", () => {
  const words = Array.from(
    { length: 200 },
    (_, i) =>
      `w${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${
        "abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26)]
      }q`,
  );
  const ws = puzzle({ words, rows: 30, cols: 30 });
  const pages = streams(wordSearchPdf(ws, "Many"));

  it("keeps the grid readable and moves the list to pages of its own", () => {
    expect(ws.placements.length).toBeGreaterThan(150);
    expect(pages.length).toBeGreaterThan(2);
    expect(cellSide(pages[0], 30)).toBeGreaterThanOrEqual(14);
    expect(drawnText(pages[0]).slice(1)).toEqual(ws.grid);
  });

  it("lists every placed word once across the list pages", () => {
    const listed = pages.slice(1, -1).flatMap((page) =>
      drawnText(page).slice(1)
    );
    expect(listed.sort()).toEqual(
      ws.placements.map((p) => p.label.toUpperCase()).sort(),
    );
  });

  it("draws every list word on the page", () => {
    for (const page of pages.slice(1, -1)) {
      for (const m of page.matchAll(/([\d.]+) ([\d.]+) Td/g)) {
        expect(Number(m[2])).toBeGreaterThanOrEqual(54 - 16);
      }
    }
  });
});

/** Each `Tj` a page draws in `font`, with its x position and size. */
const placed = (content: string, font: string) =>
  [...content.matchAll(
    new RegExp(
      `/${font} ([\\d.]+) Tf [-\\d.]+ Tc ([\\d.]+) [\\d.]+ Td \\(((?:\\\\.|[^\\\\)])*)\\) Tj`,
      "g",
    ),
  )].map((m) => ({ size: Number(m[1]), x: Number(m[2]), text: m[3] }));

describe("wordSearchPdf measures text by its glyphs", () => {
  it("fits a title of wide letters on the line", () => {
    const [page] = streams(wordSearchPdf(puzzle(), "W".repeat(40)));
    const [title] = placed(page, "F1");
    expect(title.x + textWidth(title.text, "Helvetica-Bold", title.size))
      .toBeLessThanOrEqual(54 + 504);
  });

  it("keeps wide words in the list from running into the next column", () => {
    // 14 letters of M and W print wider than an average-width estimate.
    const words = Array.from(
      { length: 6 },
      (_, i) => "MW".repeat(6) + "M" + "ABCDEF"[i],
    );
    const ws = puzzle({ words, rows: 15, cols: 15, seed: 1 });
    expect(ws.placements.length).toBeGreaterThan(4);
    const [page] = streams(wordSearchPdf(ws, "Wide"));
    const labels = placed(page, "F3");
    const columns = [...new Set(labels.map((l) => l.x))].sort((a, b) => a - b);
    for (const label of labels) {
      const next = columns.find((x) => x > label.x);
      if (next === undefined) continue;
      expect(label.x + textWidth(label.text, "Helvetica", label.size))
        .toBeLessThan(next);
    }
  });
});

describe("wordSearchPdf titles", () => {
  it("shrinks a long title to fit, and cuts one past the smallest size", () => {
    const ws = puzzle();
    const long = "A".repeat(50);
    const [page] = streams(wordSearchPdf(ws, long));
    expect(fontSizes(page)[0]).toBeLessThan(22);
    expect(drawnText(page)[0]).toBe(long);

    const [cut] = streams(wordSearchPdf(ws, "B".repeat(200)));
    expect(fontSizes(cut)[0]).toBe(12);
    expect(drawnText(cut)[0]).toMatch(/^B+\.\.\.$/);
    expect(textWidth(drawnText(cut)[0], "Helvetica-Bold", 12))
      .toBeLessThanOrEqual(504);
  });
});
