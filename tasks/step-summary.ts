/**
 * What a job writes into its step summary.
 *
 * GitHub takes the file `GITHUB_STEP_SUMMARY` names whole or not at all.
 * A file past `SUMMARY_LIMIT` is refused and what it held is lost, so a
 * step that prints a list the size of its input costs the summary every
 * line written before the list as well. Everything written here stays
 * inside the bound: what does not fit is left out and a line says so.
 */

import { unicodeWidth } from "@std/cli/unicode-width";

/** The largest summary GitHub accepts. */
export const SUMMARY_LIMIT = 1024 * 1024;

/** What stands in the summary for the lines that did not fit. */
const ELIDED = "_Cut here: the rest of this is in the job log._";

const ENCODER = new TextEncoder();

/** How many bytes `text` occupies in the summary file. */
function bytes(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * As much of `text` as `room` bytes hold, cut between lines so that no
 * line and no character is split in half, and with `ELIDED` in place of
 * what was cut. Nothing at all where the room holds no whole line, so a
 * summary already at the bound gains nothing rather than a run of
 * markers saying so.
 */
export function fit(text: string, room: number): string {
  if (bytes(text) <= room) return text;
  const marker = `${ELIDED}\n`;
  let used = bytes(marker);
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const size = bytes(line) + 1;
    if (used + size > room) break;
    used += size;
    kept.push(line);
  }
  if (kept.length === 0) return "";
  return kept.map((line) => `${line}\n`).join("") + marker;
}

/**
 * Appends to the job summary, within what GitHub accepts. A run with no
 * summary file named is every run outside a GitHub job, and writes
 * nothing. Throws where the file is named and cannot be measured, since
 * a summary written past the bound is a summary lost.
 */
export function appendSummary(text: string): void {
  const at = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (at === undefined || at.length === 0) return;
  // The bound is on the file rather than on one write, so what is
  // already there comes off the room this call has. A file the first
  // write is about to create holds nothing.
  let spent = 0;
  try {
    spent = Deno.statSync(at).size;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const body = fit(text, SUMMARY_LIMIT - spent);
  if (body.length === 0) return;
  Deno.writeTextFileSync(at, body, { append: true });
}

/**
 * Says something both on the job's output and in its summary. The summary
 * renders Markdown and the log does not, so the log gets each table drawn.
 * `log` is where the output goes, for a command whose standard output is
 * an answer something else reads.
 */
export function say(
  lines: readonly string[],
  log: (text: string) => void = console.log,
): void {
  const text = `${lines.join("\n")}\n`;
  log(drawTables(text));
  appendSummary(text);
}

/**
 * `text` with each Markdown table in it drawn in box-drawing characters,
 * and everything else as it was. A table is a row of cells between pipes,
 * a row of dashes under it, and the rows of cells after that. What a code
 * fence holds is quoted rather than rendered, so it stays as it was.
 */
export function drawTables(text: string): string {
  const lines = text.split("\n");
  const drawn: string[] = [];
  let fenced = false;
  for (let at = 0; at < lines.length;) {
    if (/^\s*(```|~~~)/.test(lines[at]!)) fenced = !fenced;
    if (!fenced && isRow(lines[at]!) && isDelimiter(lines[at + 1])) {
      const rows = [cellsOf(lines[at]!)];
      at += 2;
      while (at < lines.length && isRow(lines[at]!)) {
        rows.push(cellsOf(lines[at++]!));
      }
      drawn.push(...box(rows));
    } else {
      drawn.push(lines[at++]!);
    }
  }
  return drawn.join("\n");
}

/** Whether `line` is a row of a Markdown table. */
function isRow(line: string): boolean {
  return line.trimStart().startsWith("|");
}

/** Whether `line` is the row of dashes under a Markdown table's header. */
function isDelimiter(line: string | undefined): boolean {
  return line !== undefined && isRow(line) &&
    cellsOf(line).every((cell) => /^:?-+:?$/.test(cell));
}

/** The cells of one row of a Markdown table, with their pipes unescaped. */
function cellsOf(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/**
 * `rows`, the first of them the header, drawn as a box. A row short of
 * cells is drawn with the rest empty.
 */
function box(rows: readonly string[][]): string[] {
  // In the columns a monospaced log gives each character: two for a wide
  // one, and none for a mark combining with the one before it.
  const width = unicodeWidth;
  const widths = Array.from(
    { length: Math.max(...rows.map((row) => row.length)) },
    (_, column) => Math.max(...rows.map((row) => width(row[column] ?? ""))),
  );
  const rule = (left: string, middle: string, right: string) =>
    left + widths.map((cells) => "─".repeat(cells + 2)).join(middle) + right;
  const line = (row: readonly string[]) =>
    "│" +
    widths.map((cells, column) => {
      const cell = row[column] ?? "";
      return ` ${cell}${" ".repeat(cells - width(cell))} `;
    }).join("│") +
    "│";
  const [header, ...body] = rows;
  return [
    rule("┌", "┬", "┐"),
    line(header!),
    rule("├", "┼", "┤"),
    ...body.map(line),
    rule("└", "┴", "┘"),
  ];
}

/**
 * What the command line writes, given its arguments and what it was
 * handed, and the status it exits with. A workflow step whose text is
 * some command's output rather than a task in this repository pipes it
 * through here, so that the one rule about what fits is the one every
 * caller applies. The step keeps whatever it wraps the text in, a
 * heading or a code fence, outside the room it asks for.
 */
export function cutToRoom(
  args: readonly string[],
  text: string,
): { out: string; code: number } {
  const room = args.length === 2 && args[0] === "--room"
    ? Number(args[1])
    : Number.NaN;
  if (!Number.isSafeInteger(room) || room < 0) {
    return {
      out: "usage: step-summary.ts --room <whole number of bytes>\n",
      code: 2,
    };
  }
  return { out: fit(text, room), code: 0 };
}

/**
 * Writes the whole of `bytes`. One `write` takes only as much as the
 * reader on the other end has room for, so a summary the size of a job
 * log takes several, and stopping after the first would cut it where
 * nothing decided to.
 *
 * Throws where a write takes nothing, which would otherwise be a loop
 * that never ends and never writes.
 */
export async function writeWhole(
  to: { write(bytes: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  for (let at = 0; at < bytes.length;) {
    const written = await to.write(bytes.subarray(at));
    if (written <= 0) {
      throw new Error(
        `wrote ${written} of the ${bytes.length - at} bytes left`,
      );
    }
    at += written;
  }
}

if (import.meta.main) {
  const { out, code } = cutToRoom(
    Deno.args,
    await new Response(Deno.stdin.readable).text(),
  );
  await writeWhole(code === 0 ? Deno.stdout : Deno.stderr, ENCODER.encode(out));
  Deno.exit(code);
}
