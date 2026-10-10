import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { generateWordSearch } from "./generator.ts";
import { wordSearchPdf } from "./pdf.ts";

const ws = generateWordSearch({
  words: ["apple", "banana", "cherry", "kiwi"],
  rows: 8,
  cols: 10,
  diagonals: true,
  backwards: true,
  seed: 3,
});

/** The content stream of each page, in page order. */
const streams = (pdf: string): string[] =>
  [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);

/** Every string a content stream draws with `Tj`, unescaped. */
const drawnText = (content: string): string[] =>
  [...content.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) =>
    m[1].replace(/\\(.)/g, "$1")
  );

describe("wordSearchPdf", () => {
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

  it("puts the puzzle and word list on page one", () => {
    const [puzzle] = streams(pdf);
    const drawn = drawnText(puzzle);
    expect(drawn[0]).toBe("Fruit (Cafe) \\ Search ");
    expect(drawn.slice(1, 1 + ws.rows * ws.cols).join(""))
      .toBe(ws.grid.join(""));
    expect(drawn.slice(1 + ws.rows * ws.cols))
      .toEqual(["APPLE", "BANANA", "CHERRY", "KIWI"]);
    // No answer bands on the puzzle page.
    expect(puzzle).not.toMatch(/ l S/);
  });

  it("marks one band per word on the answer key, and no word list", () => {
    const [, key] = streams(pdf);
    const drawn = drawnText(key);
    expect(drawn[0]).toBe("Fruit (Cafe) \\ Search  - Answer key");
    expect(drawn.slice(1).join("")).toBe(ws.grid.join(""));
    expect([...key.matchAll(/ l S/g)].length).toBe(ws.placements.length);
  });
});
