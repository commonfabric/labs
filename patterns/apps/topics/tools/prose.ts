/**
 * The Markdown a Topic holds, drawn for a terminal view of the board: laid
 * out by `cf view`'s Markdown renderer, so that both draw it alike, then
 * reflowed to the view's width. A paragraph's lines are joined and wrapped at
 * word boundaries, a list item's or a quote's further rows hang at its
 * indent, a code block's lines are cut into rows rather than reflowed, and
 * a table is laid out to the width, each cell wrapped in its column. A link
 * links to where it points, and a Topic cited as `top/42` links to that
 * Topic.
 */

import { renderMarkdownLines } from "@commonfabric/cli/view/markdown";
import { maxOf } from "@commonfabric/collections/math";
import type { Line, TableRow } from "@commonfabric/cli/view/model";
import { palette as C, styleFor } from "@commonfabric/cli/view/theme";

import {
  charColumns,
  columns,
  graphemes,
  printable,
  type Row,
  rowColumns,
  type Span,
  span,
  take,
  words,
  wrap,
} from "./text.ts";

/** A line that is a rule, as the renderer draws a thematic break. */
const RULE = /^─+$/;

/** How far apart tab stops are in code, as terminals set them. */
const TAB_STOPS = 8;

/** A Topic cited by its number, as `top/42`. */
const CITATION = /\btop\/(\d+)\b/g;

/** How a cited Topic is drawn. */
export const CITATION_STYLE = { fg: C.yellow, bold: true } as const;

/**
 * `text` as rows `width` wide, a Topic cited as `top/<number>` linking to
 * `topicHref(number)`.
 */
export function prose(
  text: string,
  width: number,
  topicHref: (number: string) => string,
): Row[] {
  const rows: Row[] = [];
  const laidOut = blocks(renderMarkdownLines(text), topicHref);
  for (let index = 0; index < laidOut.length; index++) {
    const block = laidOut[index];
    if (block.table !== undefined) {
      // A table's rows are laid out together, each cell in its column.
      const run: Block[] = [];
      while (laidOut[index]?.table !== undefined) run.push(laidOut[index++]);
      index--;
      const hang = block.hang === "" || columns(block.hang) >= width - 1
        ? []
        : [span(block.hang, styleFor("markdownQuote"))];
      for (const row of table(run, width - rowColumns(hang))) {
        rows.push([...hang, ...row]);
      }
      continue;
    }
    if (block.spans.length === 0) {
      // A blank line of a code block is kept; others collapse into one.
      if (block.preformatted || (rows.at(-1)?.length ?? 0) > 0) rows.push([]);
      continue;
    }
    const text = block.spans.map((s) => s.text).join("");
    if (RULE.test(text)) {
      // A rule is cut to the width, rather than wrapped.
      rows.push([{ ...block.spans[0], text: take(text, width) }]);
      continue;
    }
    // An indent that leaves no room for the text is not kept.
    const hang = block.hang === "" || columns(block.hang) >= width - 1
      ? []
      : [span(block.hang, styleFor("markdownQuote"))];
    const laid = block.preformatted
      ? cut(block.spans, width, hang)
      : wrap(block.spans, width, hang);
    for (const row of laid) rows.push(row);
  }
  while (rows.at(-1)?.length === 0) rows.pop();
  return rows;
}

/** One line as {@link prose} lays it out, its paragraph joined. */
interface Block {
  spans: Span[];
  hang: string;
  preformatted: boolean;

  /** For a row of a table, its cells, styled, and how its columns align. */
  table?: { cells?: Span[][]; align: TableRow["align"]; header: boolean };
}

/**
 * The lines of `lines` with each paragraph's lines joined into one, and the
 * renderer's spans styled as `cf view` styles them, a Topic cited outside
 * code linking to `topicHref` of its number.
 */
function blocks(
  lines: readonly Line[],
  topicHref: (number: string) => string,
): Block[] {
  const out: Block[] = [];
  for (const line of lines) {
    const hang = line.hang ?? "";
    const spans = styled(line, topicHref);
    const previous = out.at(-1);
    if (line.continues && previous !== undefined) {
      const rest = drop(spans, [...hang].length);
      if (rest.some((s) => s.text.trim() !== "")) {
        previous.spans.push({ text: " ", style: {} });
        for (const s of rest) previous.spans.push(s);
      }
      continue;
    }
    const table = line.table;
    out.push({
      spans: line.text.trim() === "" ? [] : spans,
      hang,
      preformatted: line.preformatted === true,
      ...(table === undefined ? {} : {
        table: {
          ...(table.cells === undefined ? {} : {
            cells: table.cells.map((cell) =>
              styled(cell, topicHref, table.header)
            ),
          }),
          align: table.align,
          header: table.header,
        },
      }),
    });
  }
  return out;
}

/** `text` with each tab spaces to the next tab stop, `column` columns in. */
function expandTabs(text: string, column: number): string {
  let out = "";
  let at = column;
  for (const char of graphemes(text)) {
    const expanded = char === "\t"
      ? " ".repeat(TAB_STOPS - at % TAB_STOPS)
      : char;
    out += expanded;
    at += columns(expanded);
  }
  return out;
}

/**
 * The spans of `line` styled as `cf view` styles them, bold too when
 * `bold`, a Topic cited outside code linking to `topicHref` of its number.
 */
function styled(
  line: Line,
  topicHref: (number: string) => string,
  bold = false,
): Span[] {
  // Code's tabs move to the next tab stop, as a terminal draws them.
  let column = 0;
  return line.spans.flatMap((s): Span[] => {
    const text = line.preformatted ? expandTabs(s.text, column) : s.text;
    column += columns(text);
    const one: Span = {
      text: printable(text),
      style: {
        ...styleFor(s.cls),
        ...(s.bold || bold ? { bold: true } : {}),
        ...(s.italic ? { italic: true } : {}),
        ...(s.underline ? { underline: true } : {}),
        ...(s.strikethrough ? { strikethrough: true } : {}),
      },
      ...(s.href === undefined ? {} : { href: s.href }),
    };
    // Code is shown as it is written.
    return line.preformatted || s.cls === "string"
      ? [one]
      : cite(one, topicHref);
  });
}

/**
 * The rows of a table `width` wide, laid out as a browser lays out an HTML
 * table: each column as wide as its widest cell when they all fit, and
 * otherwise each given, beyond room for its longest word, a share of what
 * is left in proportion to how much more it wants, its cells wrapped to
 * it. Rows are ruled apart once any cell takes more than one row.
 */
function table(run: readonly Block[], width: number): Row[] {
  const rule = styleFor("punctuation");
  const align = run[0]?.table?.align ?? [];
  const count = align.length;
  const rows = run.flatMap((block) =>
    block.table?.cells === undefined
      ? []
      : [{ cells: block.table.cells, header: block.table.header }]
  );
  // `│ ` before, ` │ ` between, and ` │` after the cells.
  const room = width - 3 * count - 1;
  const want = Array.from(
    { length: count },
    (_, column) =>
      maxOf([1, ...rows.map((row) => rowColumns(row.cells[column] ?? []))]),
  );
  // A column needs room for its longest word, and cannot do with less than
  // its widest character.
  const least = Array.from(
    { length: count },
    (_, column) =>
      maxOf([
        1,
        ...rows.flatMap((row) =>
          words(row.cells[column] ?? []).map(rowColumns)
        ),
      ]),
  );
  const floor = Array.from(
    { length: count },
    (_, column) =>
      maxOf([
        1,
        ...rows.flatMap((row) =>
          (row.cells[column] ?? []).flatMap((s) =>
            graphemes(s.text).map(charColumns)
          )
        ),
      ]),
  );
  // A table too wide for even that is cut, as the renderer drew it.
  if (floor.reduce((total, w) => total + w, 0) > room) {
    return run.flatMap((block) => cut(block.spans, width, []));
  }
  const widths = fitColumns(want, least, floor, room);
  const laid = rows.map((row) =>
    widths.map((cellWidth, column) => wrap(row.cells[column] ?? [], cellWidth))
  );
  const ruled = laid.some((cells) => cells.some((lines) => lines.length > 1));
  const line = (left: string, between: string, right: string): Row => [
    span(
      `${left}${widths.map((w) => "─".repeat(w + 2)).join(between)}${right}`,
      rule,
    ),
  ];
  const out: Row[] = [];
  laid.forEach((cells, index) => {
    if (index > 0 && (ruled || rows[index - 1].header)) {
      out.push(line("├", "┼", "┤"));
    }
    const height = maxOf([1, ...cells.map((lines) => lines.length)]);
    for (let at = 0; at < height; at++) {
      const row: Row = [span("│ ", rule)];
      cells.forEach((lines, column) => {
        const content = lines[at] ?? [];
        const missing = Math.max(0, widths[column] - rowColumns(content));
        const before = align[column] === "right"
          ? missing
          : align[column] === "center"
          ? Math.floor(missing / 2)
          : 0;
        row.push(span(" ".repeat(before)));
        for (const s of content) row.push(s);
        row.push(
          span(" ".repeat(missing - before)),
          span(column + 1 < count ? " │ " : " │", rule),
        );
      });
      out.push(row);
    }
  });
  return out;
}

/**
 * Widths for columns that want `want` columns, need `least`, and cannot do
 * with less than `floor`, together `room` wide, which holds `floor`: what
 * they want when it fits; otherwise what they need, and of what is left,
 * shares in proportion to how much more each wants; and when even what they
 * need does not fit, what each needs up to a level as high as the room
 * allows, so that a column of short words keeps them whole and only the
 * longest are broken.
 */
export function fitColumns(
  want: readonly number[],
  least: readonly number[],
  floor: readonly number[],
  room: number,
): number[] {
  const sum = (values: readonly number[]) =>
    values.reduce((total, value) => total + value, 0);
  if (sum(want) <= room) return [...want];
  const needs = least.map((value, index) => Math.min(value, want[index]));
  if (sum(needs) > room) {
    const upTo = (level: number) =>
      needs.map((need, index) => Math.max(floor[index], Math.min(need, level)));
    let level = 0;
    while (level < maxOf(needs) && sum(upTo(level + 1)) <= room) level++;
    const widths = upTo(level);
    // What the level could not take whole goes a column at a time to those
    // that need more.
    let left = room - sum(widths);
    for (let index = 0; index < widths.length && left > 0; index++) {
      if (widths[index] < needs[index]) {
        widths[index]++;
        left--;
      }
    }
    return widths;
  }
  const wanted = want.map((value, index) => value - needs[index]);
  const spare = room - sum(needs);
  const more = sum(wanted);
  const widths = needs.map((value, index) =>
    value + (more === 0 ? 0 : Math.floor(spare * wanted[index] / more))
  );
  // What rounding down left over goes to the columns that want the most.
  let left = room - sum(widths);
  for (
    const index of wanted.map((_, i) => i).sort((a, b) => wanted[b] - wanted[a])
  ) {
    if (left <= 0) break;
    widths[index]++;
    left--;
  }
  return widths;
}

/** `spans` less their first `count` code points. */
function drop(spans: readonly Span[], count: number): Span[] {
  let left = count;
  return spans.flatMap((s) => {
    const chars = [...s.text];
    if (left >= chars.length) {
      left -= chars.length;
      return [];
    }
    const rest = chars.slice(left).join("");
    left = 0;
    return [{ ...s, text: rest }];
  });
}

/**
 * `s` with each Topic it cites as `top/<number>` linking to that Topic,
 * unless `s` already links somewhere.
 */
function cite(s: Span, topicHref: (number: string) => string): Span[] {
  if (s.href !== undefined) return [s];
  const out: Span[] = [];
  let at = 0;
  for (const match of s.text.matchAll(CITATION)) {
    if (match.index > at) {
      out.push({ ...s, text: s.text.slice(at, match.index) });
    }
    out.push({
      text: match[0],
      style: { ...s.style, ...CITATION_STYLE },
      href: topicHref(match[1]),
    });
    at = match.index + match[0].length;
  }
  if (at === 0) return [s];
  if (at < s.text.length) out.push({ ...s, text: s.text.slice(at) });
  return out;
}

/**
 * `spans` cut into rows `width` wide, character by character, each row
 * after the first starting with `hang`.
 */
function cut(spans: readonly Span[], width: number, hang: Row): Row[] {
  const rows: Row[] = [];
  let row: Row = [];
  let used = 0;
  const indent = rowColumns(hang);
  for (const s of spans) {
    let piece = "";
    for (const char of graphemes(s.text)) {
      const wide = charColumns(char);
      if (used > indent && used + wide > width) {
        if (piece !== "") row.push({ ...s, text: piece });
        rows.push(row);
        row = [...hang];
        piece = "";
        used = indent;
      }
      piece += char;
      used += wide;
    }
    if (piece !== "") row.push({ ...s, text: piece });
  }
  rows.push(row);
  return rows;
}
