/**
 * How much of a rendering one page shows, what it says about the rest, and how
 * a line that is shuttle's own words rather than the fabric's is written.
 *
 * A listing of a populated space and the result of a piece are each larger than
 * a screen, and a shell that wrote all of either would put its own prompt off
 * the top of the terminal along with everything the person was reading. So a
 * rendering is cut to what the terminal shows, and what was cut is held for
 * `more` to continue.
 *
 * Nothing here reads a terminal. The height arrives as a number, so a case
 * drives every page size — including the ones a real terminal rarely has —
 * with no terminal behind it, and the one module that measures a terminal
 * stays `terminal.ts`.
 */

import { unicodeWidth } from "@std/cli/unicode-width";

/**
 * The height assumed where nothing will say how tall the terminal is. It is
 * the rows a terminal has had since the VT100, which is what the pager
 * (`lib/view/pager.ts`) assumes for the same reason.
 */
export const ASSUMED_ROWS = 24;

/**
 * The width assumed where nothing will say how wide the terminal is. It is the
 * columns a terminal has had for as long, and what the pager assumes beside
 * the height.
 */
export const ASSUMED_COLUMNS = 80;

/** What fitting a rendering to one page produced. */
export interface Page {
  /** What the page shows, with no trailing break. */
  readonly text: string;

  /**
   * The lines it did not show, in order, which `more` continues. Empty where
   * the whole rendering fit, which is what says there is nothing to continue.
   */
  readonly rest: readonly string[];
}

/**
 * Returns `text` written as shuttle's own words rather than as something to
 * type — a whole line where that is all the line says, and a part of one
 * beside a name.
 *
 * The brackets delimit for a reader and not for a parser: a payload may hold
 * an angle bracket of its own and nothing escapes it. What the form buys is
 * that a reader tells a marker from a name by the first character: the grammar
 * reserves the angle bracket, so a name holding one prints quoted and a name
 * never opens with one. Wherever a marker may stand where a name would — a
 * listing's name column is the case — that first character is what says which
 * of the two is there.
 */
export function marker(text: string): string {
  return `<${text}>`;
}

/**
 * Returns the status line a page writes when it could not show everything on
 * the screen: how many lines it held back, the verb that continues them,
 * `hint` where the caller has a second way of narrowing what it asked for, and
 * whether what it did write ran past the screen anyway.
 *
 * It counts what is left rather than what a listing holds, so the same
 * sentence is true on the first page and on every continuation, and no caller
 * has to carry a total forward to keep it true.
 *
 * The overrun clause is what makes the page's promise the whole promise.
 * Something has to be shown or `more` could be asked forever, so an entry
 * taller than the whole page is shown taller than the whole page — and the
 * one thing that must not happen is that it is shown without saying so.
 */
export function statusLine(
  left: number,
  hint?: string,
  overran = false,
): string {
  const lines = left === 1 ? "1 line" : `${left} lines`;
  const held = left === 0 ? [] : [
    `${lines} not shown — more continues` +
    (hint === undefined ? "" : `, or ${hint}`),
  ];
  return marker(
    [...(overran ? ["what is above fills more than the screen"] : []), ...held]
      .join("; "),
  );
}

/**
 * How much of a rendering a page may show.
 *
 * The screen is measured in rows and the rendering is composed in lines, and
 * the two are not the same thing: a line wider than the terminal wraps, and
 * occupies as many rows as it takes. A bound is therefore a row count and a
 * width together, and {@link pageOf} converts one to the other. A page that
 * counted lines would let a single long value — a piece's result written as
 * one string, a slug the width of the screen — fill the terminal without ever
 * reaching the bound.
 */
export interface PageBound {
  /**
   * How many rows the page may fill, the status line included. Absent where
   * nothing bounds it, which is what `--limit` asks for: a person who asked
   * for forty rows on a screen showing twenty asked for forty.
   */
  readonly rows?: number;

  /** How wide the terminal is, which is what turns a line into rows. */
  readonly columns: number;

  /**
   * At most this many entries, whatever the rows allow. It counts entries
   * rather than lines or rows, because that is what a person asking for a
   * number of them means — the header is not one of them, and a wrapped entry
   * is still one entry.
   */
  readonly entries?: number;
}

/**
 * The bound a terminal of `rows` rows and `columns` columns puts on a page.
 *
 * One row is left for the prompt, which is drawn again under whatever a line
 * produced, so a page that used every row would push the prompt off the screen
 * and take the top of its own output with it. Nothing else is reserved here:
 * the status line is written into the same budget and pays for its own
 * wrapping, which is {@link pageOf}'s to work out.
 */
export function heightFit(rows: number, columns: number): PageBound {
  return { rows: rows - 1, columns };
}

/**
 * Returns the page `header` and `entries` fill within `bound`, and the entries
 * left over, with `status` writing the line that says how many were.
 *
 * The header is shown whatever the bound says: it is what a listing's own
 * account of itself goes in, and a page that dropped it would drop exactly the
 * line a reader of a partial listing most needs. Only the entries are cut, and
 * `more` continues those.
 *
 * A page always shows at least one entry, however small the bound. That is
 * what makes `more` terminate: a continuation that showed nothing would hand
 * back everything it was given and could be asked forever. What it costs is
 * that a screen too small for one entry is written past its height, which is a
 * screen too small to have shown the status line either.
 *
 * Room for the status line is measured at the widest it can be, which is the
 * line it writes when every entry is left: `left` only ever shrinks from
 * there, and a shorter count is never a wider line. So the reservation is
 * exact or one row generous, and never short — a page that measured it after
 * choosing what to show could choose one entry too many and overflow.
 */
export function pageOf(
  header: readonly string[],
  entries: readonly string[],
  bound: PageBound,
  status: (left: number, overran: boolean) => string,
): Page {
  const columns = Math.max(bound.columns, 1);
  const budget = bound.rows ?? Number.POSITIVE_INFINITY;
  const allowed = bound.entries ?? entries.length;
  const rows = (line: string) => rowsTaken(line, columns);
  const used = (lines: readonly string[]) =>
    lines.reduce((total, line) => total + rows(line), 0);

  if (allowed >= entries.length) {
    const whole = [...header, ...entries];
    if (used(whole) <= budget) return { text: whole.join("\n"), rest: [] };
  }

  // Room for the status line is measured at the sentence it will write if the
  // page keeps inside the screen, which is the sentence it writes unless the
  // first entry is taller than the whole page — and a page in that state has
  // already said it ran over, so a status line growing a clause there does not
  // make a true statement false. The measure is the one every other line here
  // is measured by, so a status line that wrapped early would be reserved for
  // early too.
  let taken = used(header) + rows(status(entries.length, false));
  const shown: string[] = [];
  for (const entry of entries) {
    if (shown.length >= allowed) break;
    const cost = rows(entry);
    if (shown.length > 0 && taken + cost > budget) break;
    taken += cost;
    shown.push(entry);
  }
  const rest = entries.slice(shown.length);
  // The bound the "at least one entry" rule states for itself: it may take
  // more of the screen than the page had, and where it does the page says so.
  // Silence there is the one thing the rule may not buy, since a page nobody
  // was told about is a page that floods the screen exactly as an unbounded
  // one does.
  const overran = taken > budget;
  return rest.length === 0 && !overran
    ? { text: [...header, ...shown].join("\n"), rest: [] }
    : {
      text: [...header, ...shown, status(rest.length, overran)].join("\n"),
      rest,
    };
}

/**
 * Returns `lines` broken at `columns`, so that no line among them takes more
 * than one row.
 *
 * A page cuts between entries, so an entry it cannot cut is one it must show
 * whole — and a value the fabric holds as one long string is exactly that: one
 * line, and as many rows as the terminal is narrow. Breaking it first is what
 * gives the page somewhere to cut, and what makes `more` able to continue it.
 *
 * It is the caller's decision rather than the page's, because what an entry is
 * differs by caller: a listing row is one row of a listing whatever it costs
 * on screen, and `--limit` counts those, while a rendered value has no unit
 * finer than the screen's own. What no caller may do is break a rendering
 * something else parses — a break inserted into a JSON string is a character
 * that was not in the value, and the reader of that form is a program
 * (`written`, `verbs.ts`).
 *
 * The break is by display width rather than by character count, so a line of
 * double-width characters breaks where the terminal would wrap it. A single
 * character wider than the whole width is taken on its own and overflows by
 * one column, there being nowhere narrower to put it. An empty line stays one
 * entry, since it is already one row.
 */
export function wrapped(
  lines: readonly string[],
  columns: number,
): readonly string[] {
  const width = Math.max(columns, 1);
  const broken: string[] = [];
  for (const line of lines) {
    let taken = "";
    let filled = 0;
    for (const point of line) {
      const cost = columnsTaken(point);
      if (taken !== "" && filled + cost > width) {
        broken.push(taken);
        taken = "";
        filled = 0;
      }
      taken += point;
      filled += cost;
    }
    broken.push(taken);
  }
  return broken;
}

/**
 * Helper for {@link pageOf}, which is how many rows a line takes on a terminal
 * `columns` wide.
 *
 * It counts the pieces {@link wrapped} breaks the line into rather than
 * dividing its width, because those are two answers to one question and only
 * one of them is the terminal's. A line breaks at a character boundary: where
 * the next character is two columns wide and one column is left, the terminal
 * leaves that column blank and moves down, so a width that divides evenly can
 * still need a row more than the division says. The division undercounts
 * exactly there, and undercounting is the direction that overflows.
 *
 * So there is one traversal and the count is what it produced. A second
 * implementation is what let the two disagree by a row per line, and the
 * arrangement that stops it recurring is having only one. What it costs is the
 * pieces themselves, built and dropped for a line the caller only wanted
 * measured — linear in the line either way, which is what measuring its width
 * already was.
 */
function rowsTaken(line: string, columns: number): number {
  return wrapped([line], columns).length;
}

/**
 * Helper for the two above, which is how many columns `text` occupies.
 *
 * It is the display width rather than a count of characters, because a
 * terminal wraps on the first and a page that measured the second would
 * *undercount* — a line of double-width characters is twice the rows a
 * character count says, so the page would write past the screen rather than
 * short of it. Underfilling is a page one row emptier than it could be;
 * overflowing is the thing this module exists to stop.
 *
 * `unicodeWidth` (`@std/cli`) is the measure, which reads the East Asian
 * Width property rather than guessing from a range. What it cannot know is
 * what a particular terminal does with a grapheme cluster its font composes
 * differently, and nothing that reads a string can.
 */
function columnsTaken(text: string): number {
  return unicodeWidth(text);
}
