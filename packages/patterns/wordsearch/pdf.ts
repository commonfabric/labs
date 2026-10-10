/**
 * A printable word search as a two-page PDF: the puzzle with its word list,
 * then the same grid with every hidden word circled as the answer key.
 *
 * The PDF is written by hand rather than through a library because a pattern
 * cannot reach the browser's print dialog, and what it needs is small: text in
 * the three standard fonts every PDF reader carries, and stroked lines. The
 * output is plain ASCII, so it travels as an ordinary string to the
 * `cf-file-download` button, and byte offsets are string offsets.
 */
import { type WordSearch } from "./generator.ts";

// US Letter, in points, with half-inch margins.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const TITLE_SIZE = 22;
const TITLE_GAP = 18;
const LIST_SIZE = 11;
const LIST_LEADING = 16;
const LIST_GAP = 24;
const MAX_CELL = 30;

/**
 * Text as a PDF string literal. The standard fonts here carry no glyphs past
 * ASCII, so accents are dropped and anything else unprintable is removed.
 */
const pdfString = (text: string): string =>
  "(" +
  text.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[\\()]/g, (c) => `\\${c}`) +
  ")";

const num = (n: number): string => n.toFixed(2);

const text = (
  font: string,
  size: number,
  x: number,
  y: number,
  value: string,
): string =>
  `BT /${font} ${num(size)} Tf ${num(x)} ${num(y)} Td ${
    pdfString(value)
  } Tj ET`;

/** Where the grid and word list sit on a page, shared by both pages. */
interface Layout {
  cell: number;
  left: number;
  top: number;
  listLeft: number;
  listColumns: number;
  listColumnWidth: number;
  listTop: number;
}

const layoutFor = (ws: WordSearch, words: readonly string[]): Layout => {
  const longest = Math.max(1, ...words.map((w) => w.length));
  // Helvetica capitals average about 0.7 em, plus a gutter between columns.
  const columnWidth = longest * LIST_SIZE * 0.7 + 18;
  const listColumns = Math.max(
    1,
    Math.min(4, Math.floor(CONTENT_WIDTH / columnWidth)),
  );
  const listHeight = words.length === 0
    ? 0
    : LIST_GAP + Math.ceil(words.length / listColumns) * LIST_LEADING;
  const top = PAGE_HEIGHT - MARGIN - TITLE_SIZE - TITLE_GAP;
  const cell = Math.min(
    MAX_CELL,
    CONTENT_WIDTH / ws.cols,
    (top - MARGIN - listHeight) / ws.rows,
  );
  const left = (PAGE_WIDTH - cell * ws.cols) / 2;
  // The list sits under the grid, and widens to the margins only when its
  // columns would not fit under a narrow grid.
  const underGrid = cell * ws.cols >= listColumns * columnWidth;
  return {
    cell,
    left,
    top,
    listLeft: underGrid ? left : MARGIN,
    listColumns,
    listColumnWidth: (underGrid ? cell * ws.cols : CONTENT_WIDTH) /
      listColumns,
    listTop: top - cell * ws.rows - LIST_GAP,
  };
};

const cellCenter = (layout: Layout, row: number, col: number) => ({
  x: layout.left + (col + 0.5) * layout.cell,
  y: layout.top - (row + 0.5) * layout.cell,
});

const titleOps = (title: string): string =>
  text(
    "F1",
    TITLE_SIZE,
    MARGIN,
    PAGE_HEIGHT - MARGIN - TITLE_SIZE,
    title,
  );

const gridOps = (ws: WordSearch, layout: Layout): string[] => {
  const size = layout.cell * 0.6;
  // Courier is monospaced at 0.6 em, and its capitals stand about 0.57 em,
  // so these offsets put each letter's middle on the cell's middle.
  const letters = ws.grid.flatMap((line, row) =>
    [...line].map((letter, col) => {
      const { x, y } = cellCenter(layout, row, col);
      return text("F2", size, x - size * 0.3, y - size * 0.285, letter);
    })
  );
  const frame = `0.5 w ${num(layout.left)} ${
    num(layout.top - layout.cell * ws.rows)
  } ${num(layout.cell * ws.cols)} ${num(layout.cell * ws.rows)} re S`;
  return [frame, ...letters];
};

const wordListOps = (words: readonly string[], layout: Layout): string[] => {
  const perColumn = Math.ceil(words.length / layout.listColumns);
  return words.map((word, i) =>
    text(
      "F3",
      LIST_SIZE,
      layout.listLeft + Math.floor(i / perColumn) * layout.listColumnWidth,
      layout.listTop - (i % perColumn) * LIST_LEADING,
      word,
    )
  );
};

/** A rounded band under each placed word, drawn before the letters. */
const answerOps = (ws: WordSearch, layout: Layout): string[] => [
  `0.82 G 1 J ${num(layout.cell * 0.7)} w`,
  ...ws.placements.map((p) => {
    const start = cellCenter(layout, p.row, p.col);
    const last = p.word.length - 1;
    const end = cellCenter(
      layout,
      p.row + p.dRow * last,
      p.col + p.dCol * last,
    );
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

/**
 * The PDF for `ws`: page one is the puzzle under `title` with the placed words
 * listed alphabetically below it; page two is the answer key.
 */
export const wordSearchPdf = (ws: WordSearch, title: string): string => {
  const words = ws.placements.map((p) => p.word).sort();
  const layout = layoutFor(ws, words);
  const puzzle = [
    titleOps(title),
    ...gridOps(ws, layout),
    ...wordListOps(words, layout),
  ];
  const key = [
    titleOps(`${title} - Answer key`),
    ...answerOps(ws, layout),
    ...gridOps(ws, layout),
  ];
  const font = (name: string) =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /${name} >>`;
  const page = (contents: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contents} 0 R >>`;
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [6 0 R 8 0 R] /Count 2 >>",
    font("Helvetica-Bold"),
    font("Courier-Bold"),
    font("Helvetica"),
    page(7),
    stream(puzzle),
    page(9),
    stream(key),
  ]);
};
