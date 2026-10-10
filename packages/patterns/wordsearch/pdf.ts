/**
 * A printable word search as a PDF: the puzzle with its word list, then the
 * same grid with every hidden word banded as the answer key. A list too long
 * to share the puzzle's page at a readable size moves to pages of its own
 * between the two, rather than shrinking the grid.
 *
 * The PDF is written by hand rather than through a library because a pattern
 * cannot reach the browser's print dialog, and what it needs is small: text in
 * the three standard fonts every PDF reader carries, and stroked lines. The
 * output is plain ASCII, so it travels as an ordinary string to the
 * `cf-file-download` button, and byte offsets are string offsets.
 */
import { stripAccents, type WordSearch } from "./generator.ts";

// US Letter, in points, with half-inch margins.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
// PAGE_WIDTH - 2 * MARGIN, written out: the sandbox verifier refuses a
// module-level value computed from other bindings.
const CONTENT_WIDTH = 504;

const TITLE_SIZE = 22;
const MIN_TITLE_SIZE = 12;
const TITLE_GAP = 18;
// The page's top edge less the margin, the title and its gap.
const BODY_TOP = 698;
const LIST_SIZE = 11;
const LIST_LEADING = 16;
const LIST_GAP = 24;
const MAX_CELL = 30;
/** Below this a cell's letter is too small to circle with a pencil. */
const MIN_CELL = 14;

/**
 * Glyph widths of the standard 14 fonts, in thousandths of an em, from
 * Adobe's metrics: Helvetica for the word list (upper case only, as the list
 * prints) and Helvetica-Bold for the title (any case). A character missing
 * from a table is taken as wide as a capital M, so a measure never runs short.
 */
const HELVETICA: Readonly<Record<string, number>> = {
  " ": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
};
const HELVETICA_BOLD: Readonly<Record<string, number>> = {
  " ": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  A: 722,
  B: 722,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 556,
  K: 722,
  L: 611,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  a: 556,
  b: 611,
  c: 556,
  d: 611,
  e: 556,
  f: 333,
  g: 611,
  h: 611,
  i: 278,
  j: 278,
  k: 556,
  l: 278,
  m: 889,
  n: 611,
  o: 611,
  p: 611,
  q: 611,
  r: 389,
  s: 556,
  t: 333,
  u: 611,
  v: 556,
  w: 778,
  x: 556,
  y: 556,
  z: 500,
};
const WIDEST = 833;

/** What the standard fonts can print of `text`: ASCII, accents dropped. */
const printable = (text: string): string =>
  stripAccents(text).replace(/[^\x20-\x7e]/g, "");

/** How wide `text` prints in `font` at `size` points. */
export const textWidth = (
  text: string,
  font: "Helvetica" | "Helvetica-Bold",
  size: number,
): number => {
  const widths = font === "Helvetica" ? HELVETICA : HELVETICA_BOLD;
  return [...printable(text)].reduce(
    (sum, c) => sum + (widths[c] ?? WIDEST),
    0,
  ) * size / 1000;
};

/**
 * Text as a PDF string literal. The standard fonts here carry no glyphs past
 * ASCII, so accents are dropped and anything else unprintable is removed.
 */
const pdfString = (text: string): string =>
  "(" +
  printable(text).replace(/[\\()]/g, (c) => `\\${c}`) +
  ")";

const num = (n: number): string => n.toFixed(2);

const text = (
  font: string,
  size: number,
  x: number,
  y: number,
  value: string,
  spacing = 0,
): string =>
  `BT /${font} ${num(size)} Tf ${num(spacing)} Tc ${num(x)} ${num(y)} Td ${
    pdfString(value)
  } Tj ET`;

/** Where the grid sits: shared by the puzzle and the answer key. */
interface Grid {
  cell: number;
  left: number;
  top: number;
}

/** How the word list is laid out in columns. */
interface List {
  columns: number;
  columnWidth: number;
  left: number;
}

const listFor = (labels: readonly string[], grid?: Grid, cols = 0): List => {
  const widest = labels.reduce(
    (most, label) => Math.max(most, textWidth(label, "Helvetica", LIST_SIZE)),
    0,
  );
  // The widest label, plus a gutter between columns.
  const needed = widest + 18;
  const columns = Math.max(1, Math.min(4, Math.floor(CONTENT_WIDTH / needed)));
  // The list sits under the grid when its columns fit there, and otherwise
  // spans the margins.
  const gridWidth = grid ? grid.cell * cols : 0;
  return grid && gridWidth >= columns * needed
    ? { columns, columnWidth: gridWidth / columns, left: grid.left }
    : { columns, columnWidth: CONTENT_WIDTH / columns, left: MARGIN };
};

const gridAt = (ws: WordSearch, height: number): Grid => {
  const cell = Math.min(MAX_CELL, CONTENT_WIDTH / ws.cols, height / ws.rows);
  return { cell, left: (PAGE_WIDTH - cell * ws.cols) / 2, top: BODY_TOP };
};

const cellCenter = (grid: Grid, row: number, col: number) => ({
  x: grid.left + (col + 0.5) * grid.cell,
  y: grid.top - (row + 0.5) * grid.cell,
});

/** The title at the size that fits the line, cut short only past the floor. */
const titleOps = (title: string): string => {
  const shown = printable(title);
  const atOnePoint = textWidth(shown, "Helvetica-Bold", 1);
  const size = Math.max(
    MIN_TITLE_SIZE,
    Math.min(TITLE_SIZE, CONTENT_WIDTH / Math.max(atOnePoint, 1e-9)),
  );
  return text(
    "F1",
    size,
    MARGIN,
    PAGE_HEIGHT - MARGIN - TITLE_SIZE,
    fitted(shown, size),
  );
};

/** `title` as it fits the line at `size`: whole, or cut short with "...". */
const fitted = (title: string, size: number): string => {
  if (textWidth(title, "Helvetica-Bold", size) <= CONTENT_WIDTH) return title;
  const room = CONTENT_WIDTH - textWidth("...", "Helvetica-Bold", size);
  let end = title.length;
  while (
    end > 0 && textWidth(title.slice(0, end), "Helvetica-Bold", size) > room
  ) {
    end--;
  }
  return `${title.slice(0, end)}...`;
};

/** The frame and one line of text per row, spaced to the cell width. */
const gridOps = (ws: WordSearch, grid: Grid): string[] => {
  const size = grid.cell * 0.6;
  // Courier advances 0.6 em per letter, so the character spacing makes up
  // the rest of a cell; its capitals stand about 0.57 em, so these offsets
  // put each letter's middle on its cell's middle.
  const spacing = grid.cell - size * 0.6;
  const rows = ws.grid.map((line, row) => {
    const { x, y } = cellCenter(grid, row, 0);
    return text("F2", size, x - size * 0.3, y - size * 0.285, line, spacing);
  });
  const frame = `0.5 w ${num(grid.left)} ${
    num(grid.top - grid.cell * ws.rows)
  } ${num(grid.cell * ws.cols)} ${num(grid.cell * ws.rows)} re S`;
  return [frame, ...rows];
};

const listOps = (labels: readonly string[], list: List, top: number) => {
  const perColumn = Math.ceil(labels.length / list.columns);
  return labels.map((label, i) =>
    text(
      "F3",
      LIST_SIZE,
      list.left + Math.floor(i / perColumn) * list.columnWidth,
      top - (i % perColumn) * LIST_LEADING,
      label,
    )
  );
};

/** A rounded band under each placed word, drawn before the letters. */
const answerOps = (ws: WordSearch, grid: Grid): string[] => [
  `0.82 G 1 J ${num(grid.cell * 0.7)} w`,
  ...ws.placements.map((p) => {
    const start = cellCenter(grid, p.row, p.col);
    const last = p.word.length - 1;
    const end = cellCenter(grid, p.row + p.dRow * last, p.col + p.dCol * last);
    return `${num(start.x)} ${num(start.y)} m ${num(end.x)} ${num(end.y)} l S`;
  }),
  "0 G",
];

/** Assemble numbered objects into a PDF file with a correct xref table. */
const assemble = (objects: string[]): string => {
  const header = "%PDF-1.4\n";
  const offsets: number[] = [];
  const body = objects.reduce((out, object, i) => {
    offsets.push(header.length + out.length);
    return `${out}${i + 1} 0 obj\n${object}\nendobj\n`;
  }, "");
  const xrefAt = header.length + body.length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`),
  ].join("");
  return `${header}${body}${xref}trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
};

const stream = (ops: string[]): string => {
  const content = ops.join("\n");
  return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
};

/** The content of each page, in order. */
const pages = (ws: WordSearch, title: string): string[][] => {
  const labels = [...ws.placements]
    .sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .map((p) => stripAccents(p.label).toUpperCase());
  const bodyHeight = BODY_TOP - MARGIN;
  const rowsUnder = (list: List) => Math.ceil(labels.length / list.columns);

  // One page if the list fits under a grid of readable cells.
  const fullList = listFor(labels);
  const shared = gridAt(
    ws,
    bodyHeight - LIST_GAP - rowsUnder(fullList) * LIST_LEADING,
  );
  const key = [titleOps(`${title} - Answer key`)];
  if (labels.length === 0 || shared.cell >= MIN_CELL) {
    const list = listFor(labels, shared, ws.cols);
    const listTop = shared.top - shared.cell * ws.rows - LIST_GAP;
    return [
      [
        titleOps(title),
        ...gridOps(ws, shared),
        ...listOps(labels, list, listTop),
      ],
      [...key, ...answerOps(ws, shared), ...gridOps(ws, shared)],
    ];
  }

  // Otherwise the grid takes its page, and the list follows on its own.
  const grid = gridAt(ws, bodyHeight);
  const perPage = Math.floor(bodyHeight / LIST_LEADING) * fullList.columns;
  const listPages = Array.from(
    { length: Math.ceil(labels.length / perPage) },
    (_, i) => [
      titleOps(`${title} - Words`),
      ...listOps(
        labels.slice(i * perPage, (i + 1) * perPage),
        fullList,
        BODY_TOP,
      ),
    ],
  );
  return [
    [titleOps(title), ...gridOps(ws, grid)],
    ...listPages,
    [...key, ...answerOps(ws, grid), ...gridOps(ws, grid)],
  ];
};

/**
 * The PDF for `ws`: the puzzle under `title` with the hidden words listed as
 * they were written, alphabetically; then the answer key.
 */
export const wordSearchPdf = (ws: WordSearch, title: string): string => {
  const contents = pages(ws, title);
  // Objects 1–5 are the catalog, page tree and fonts; then each page is a
  // page object followed by its content stream.
  const pageRef = (i: number) => 6 + 2 * i;
  const font = (name: string) =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /${name} >>`;
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${
      contents.map((_, i) => `${pageRef(i)} 0 R`).join(" ")
    }] /Count ${contents.length} >>`,
    font("Helvetica-Bold"),
    font("Courier-Bold"),
    font("Helvetica"),
    ...contents.flatMap((ops, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${
        pageRef(i) + 1
      } 0 R >>`,
      stream(ops),
    ]),
  ]);
};
