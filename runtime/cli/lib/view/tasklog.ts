/**
 * What the task dialog says, such as while a push runs, and how it lays that
 * out in rows, with a blank row between paragraphs. The viewer's own words
 * are drawn bright, with the names they interpolate, such as a branch's or a
 * pull request's number, in another bright color, and every web address and
 * pull request number links to its page. Text the dialog quotes, such as
 * git's output or the reason GitHub gave for refusing a request, is indented
 * two columns, in the dialog's ordinary color. A step, a line that says what
 * the task is doing, ends in "...", saying to wait for the viewer, unless it
 * waits for someone's action, and once it ends, in a mark that shows how.
 * The last step running has a spinner at its end, unless it waits for
 * someone's action. Once a step waits for the touch of a security key, the
 * dialog draws the key coming in from past the screen's edge and plugging
 * into its side, the light along the key's edges blinking until it is
 * touched.
 */

import { cpLen } from "./ansi.ts";
import { drawnCharacters, shownCells } from "./display.ts";
import {
  type DialogSpan,
  type DialogTone,
  KEY_PLUG_MS,
  type SecurityKey,
  webAddresses,
} from "./render.ts";

/** What a piece of the task dialog's text is: the viewer's own words, a
 * name they interpolate, or text another program wrote. */
export type TaskTone = "text" | "name" | "quote";

/** A piece of the task dialog's text, which links to `url` when it has
 * one. */
export interface TaskSpan {
  readonly text: string;
  readonly tone: TaskTone;
  readonly url?: string;
}

/** Text for the task dialog, a line or more, in pieces. */
export type TaskText = readonly TaskSpan[];

/** A name, such as a branch's, interpolated into the viewer's own words,
 * which links to `url` when there is one. */
export function name(text: string, url?: string): TaskText {
  return [
    url === undefined ? { text, tone: "name" } : { text, tone: "name", url },
  ];
}

/** The web address `url`, as a link to itself. */
export function link(url: string): TaskText {
  return name(url, url);
}

/** The number of a pull request, linking to its page at `url`. */
export function pullRequest(number: number, url: string): TaskText {
  return name(`${number}`, url);
}

/** Text another program wrote, such as the reason GitHub gave for refusing
 * a request, which the dialog quotes in a block of its own. */
export function quote(text: string): TaskText {
  return [{ text, tone: "quote" }];
}

/** The viewer's own words, given as a string. */
export function words(text: string): TaskText {
  return [{ text, tone: "text" }];
}

/**
 * The viewer's own words, from a template whose literal parts are those
 * words. Each string substituted into it is a name, and each text
 * substituted into it stays as it is. Neighboring pieces drawn alike join
 * into one, except quotes, each of which is a block of its own.
 */
export function say(
  literals: TemplateStringsArray,
  ...parts: ReadonlyArray<string | TaskText>
): TaskText {
  const spans: TaskSpan[] = [];
  const add = (text: TaskText) => {
    for (const span of text) {
      if (span.text === "") continue;
      const last = spans.at(-1);
      if (
        last?.tone === span.tone && last.url === span.url &&
        span.tone !== "quote"
      ) {
        spans[spans.length - 1] = { ...last, text: last.text + span.text };
      } else {
        spans.push(span);
      }
    }
  };
  literals.forEach((literal, i) => {
    add(words(literal));
    const part = parts[i];
    if (part !== undefined) add(typeof part === "string" ? name(part) : part);
  });
  return spans;
}

/** `text` as plain text on one line, as the status line shows it, each
 * line of a quote ending as a sentence does. */
export function plainText(text: TaskText): string {
  return text.map(({ text, tone }) =>
    tone !== "quote"
      ? text.replaceAll("\n", " ")
      : text.split("\n").flatMap((line) => {
        const words = line.trim().replace(/\s+/g, " ");
        return words === "" ? [] : [/[.!?]$/.test(words) ? words : `${words}.`];
      }).join(" ")
  ).join("");
}

/** What a step waits for: work the viewer does, someone's action, such as
 * opening a pull request, or the touch of a security key, which the task
 * dialog draws beside itself. */
export type StepKind = "work" | "person" | "touch";

/** Shows `text` as a step of a task, of `kind`, saying what it is doing,
 * until the function it returns is called, which shows that the step is
 * done. */
export type BeginStep = (text: TaskText, kind?: StepKind) => () => void;

/** Where a task says what it is doing, and shows what another program, such
 * as git, wrote. */
export interface TaskOutput {
  /** Shows `text` that another program wrote, as it wrote it. */
  readonly write: (text: string) => void;

  /** Shows a step that says what the task is doing. */
  readonly step: BeginStep;
}

/** How a step stands: running; done; ended without being done; or left
 * unfinished when the step running inside it ended without being done. */
type StepState = "busy" | "done" | "failed" | "left";

/** An entry in a task's log: what another program wrote, a line at a time,
 * the last still being written; something the viewer says; or a step. */
type TaskEntry =
  | { readonly kind: "quote"; readonly lines: string[] }
  | { readonly kind: "text"; readonly text: TaskText }
  | {
    readonly kind: "step";
    readonly text: TaskText;
    readonly waits: StepKind;
    state: StepState;
  };

/** A row of the task dialog's body, with how each piece of it is drawn. */
export interface TaskRow {
  readonly text: string;
  readonly spans: readonly DialogSpan[];
}

/** The frames of a running step's spinner, one after the other. */
export const SPINNER: readonly string[] = [..."◐◓◑◒"];

/** What a step that has ended shows in place of its spinner. */
const ENDED: Readonly<Record<Exclude<StepState, "busy">, string>> = {
  done: "✓",
  failed: "✗",
  left: "",
};

/** What a step that waits for work the viewer does ends in, saying that the
 * person should wait. */
const WAIT = "...";

/** How often the security key is drawn anew as it comes in, in
 * milliseconds. */
const KEY_FRAME_MS = 16;

/** How long the security key's light stays on, and then off, while it
 * blinks, in milliseconds. */
const KEY_BLINK_MS = 300;

/** A task's log: what it said, and what the programs it ran wrote. */
export class TaskLog {
  #entries: TaskEntry[] = [];

  /** Whether the last text quoted ended in a carriage return, so that the
   * next starts its line over. */
  #returned = false;

  /** Adds `text` that another program wrote, such as git. A carriage return
   * starts the line over, which is how git redraws a progress report in
   * place. */
  quote(text: string): void {
    const last = this.#entries.at(-1);
    const lines = last?.kind === "quote" ? last.lines : [""];
    if (last?.kind !== "quote") this.#entries.push({ kind: "quote", lines });
    for (const part of text.split(/(\r\n|\n|\r)/)) {
      if (part === "\r") {
        this.#returned = true;
      } else if (part === "\n" || part === "\r\n") {
        lines.push("");
        this.#returned = false;
      } else if (part !== "") {
        lines[lines.length - 1] = (this.#returned ? "" : lines.at(-1)) + part;
        this.#returned = false;
      }
    }
  }

  /** Adds `text`, unless it is empty. */
  say(text: TaskText): void {
    if (text.length > 0) this.#entries.push({ kind: "text", text });
  }

  /** Adds `text` as a running step of `kind`, which the function returned
   * shows is done, unless the log has stopped it first. */
  step(text: TaskText, kind: StepKind = "work"): () => void {
    const entry: TaskEntry = { kind: "step", text, waits: kind, state: "busy" };
    this.#entries.push(entry);
    return () => {
      if (entry.state === "busy") entry.state = "done";
    };
  }

  /** Shows each step still running as done. */
  complete(): void {
    for (const entry of this.#entries) {
      if (entry.kind === "step" && entry.state === "busy") entry.state = "done";
    }
  }

  /** Shows the last step still running as having ended without being done,
   * and each step running around it as left unfinished. */
  stop(): void {
    const last = this.#entries.findLastIndex((entry) =>
      entry.kind === "step" && entry.state === "busy"
    );
    this.#entries.forEach((entry, i) => {
      if (entry.kind === "step" && entry.state === "busy") {
        entry.state = i === last ? "failed" : "left";
      }
    });
  }

  /**
   * The security key that the task dialog showing this log draws beside
   * itself, `time` milliseconds after the last step that waits for its
   * touch began, or null when no step waits for one. While the step waits,
   * the key comes in from past the screen's edge and plugs in over the first
   * {@link KEY_PLUG_MS} milliseconds, and then its light blinks. Once the
   * step has ended, the key is plugged in, its light showing that it was
   * touched when the step is done, and off otherwise.
   */
  securityKey(time: number): SecurityKey | null {
    const state = this.#touchState();
    if (state === null) return null;
    if (state !== "busy") {
      return {
        time: KEY_PLUG_MS,
        light: state === "done" ? "touched" : "off",
      };
    }
    const blink = Math.floor((time - KEY_PLUG_MS) / KEY_BLINK_MS);
    return { time, light: blink >= 0 && blink % 2 === 0 ? "on" : "off" };
  }

  /** How long after `time` the security key that {@link securityKey} gives
   * is next drawn anew, in milliseconds, or null when it holds still: every
   * {@link KEY_FRAME_MS} milliseconds until it is plugged in, and then each
   * time its light blinks on or off. */
  keyFrameDelay(time: number): number | null {
    if (this.#touchState() !== "busy") return null;
    return time < KEY_PLUG_MS
      ? Math.min(KEY_FRAME_MS, KEY_PLUG_MS - time)
      : KEY_BLINK_MS;
  }

  /** How the last step that waits for the touch of a security key stands,
   * or null when none does. */
  #touchState(): StepState | null {
    return this.#entries.findLast(
      (entry): entry is Extract<TaskEntry, { kind: "step" }> =>
        entry.kind === "step" && entry.waits === "touch",
    )?.state ?? null;
  }

  /** Whether `logs`, one after the other, show a spinner. */
  static spinning(logs: readonly TaskLog[]): boolean {
    return TaskLog.#spinner(logs.flatMap((log) => log.#entries)) >= 0;
  }

  /** The index in `entries` of the step whose spinner turns: the last step
   * running, unless it waits for someone's action, or -1 for none. */
  static #spinner(entries: readonly TaskEntry[]): number {
    const last = entries.findLastIndex((entry) =>
      entry.kind === "step" && entry.state === "busy"
    );
    const step = entries[last];
    return step?.kind === "step" && step.waits === "work" ? last : -1;
  }

  /** The rows that `logs`, one after the other, lay out in at most
   * `columns` columns, a blank row between paragraphs, with the spinner of
   * the last running step, unless it waits for someone's action, at
   * `frame`. */
  static rows(
    logs: readonly TaskLog[],
    columns: number,
    frame: number,
  ): TaskRow[] {
    const entries = logs.flatMap((log) => log.#entries);
    const spinner = TaskLog.#spinner(entries);
    const rows: TaskRow[] = [];
    for (
      const block of entries.flatMap((entry, i) =>
        entryBlocks(entry, i === spinner ? SPINNER[frame % SPINNER.length] : "")
      )
    ) {
      const laidOut = blockRows(block, columns);
      if (laidOut.length === 0) continue;
      if (rows.length > 0) rows.push({ text: "", spans: [] });
      for (const row of laidOut) rows.push(toRow(row));
    }
    return rows;
  }
}

const QUOTE_INDENT = "  ";

/** A character of the task dialog's text, as a reader sees it, how it is
 * drawn, and the address it links to, when it links to one. */
interface Cell {
  readonly ch: string;
  readonly tone: DialogTone;
  readonly url?: string;

  /** Whether a row never starts with this cell, as inside a step's "..."
   * and before its spinner. */
  readonly glued?: boolean;
}

/** A paragraph of the viewer's words, a line or more, or text another
 * program wrote, which is laid out as a block of its own. */
type Block =
  | { readonly kind: "paragraph"; readonly lines: readonly (readonly Cell[])[] }
  | { readonly kind: "quote"; readonly text: string };

/** The rows `block` lays out in, at most `columns` wide: each line of a
 * paragraph wrapped, or each line of a quote indented, as far as a row of
 * one column leaves room for, and wrapped, leaving out the blank lines
 * around a quote and the spaces ending its lines. */
function blockRows(block: Block, columns: number): Cell[][] {
  if (block.kind === "paragraph") {
    return block.lines.flatMap((line) => wrap(line, columns));
  }
  const lines = block.text.split("\n").map((line) => line.replace(/ +$/, ""));
  const first = lines.findIndex((line) => line !== "");
  const last = lines.findLastIndex((line) => line !== "");
  const indent = [...QUOTE_INDENT].slice(0, Math.max(0, columns - 1))
    .map((ch): Cell => ({ ch, tone: "plain" }));
  const width = columns - indent.length;
  return lines.slice(first, last + 1).flatMap((line) =>
    wrap(
      linkAddresses(
        drawnCharacters(line).map((ch): Cell => ({ ch, tone: "plain" })),
      ),
      width,
    ).map((row) => [...indent, ...row])
  );
}

/** The blocks that `entry` lays out in: its paragraph, with any quote in it
 * breaking out into a block of its own, and a step ending in "...", unless it
 * waits for someone's action, and then `spinner`, when it is running, or the
 * mark of how it ended. Each line
 * of the viewer's words loses the spaces at its ends, so that a quote can
 * follow a colon and a space, and words follow a quote after a space, and a
 * line left empty is dropped. */
function entryBlocks(entry: TaskEntry, spinner: string): Block[] {
  if (entry.kind === "quote") {
    return [{ kind: "quote", text: entry.lines.join("\n") }];
  }
  const blocks: Block[] = [];
  let lines: Cell[][] = [];
  // The line's code points, each drawn as its span says, until the line
  // ends, when they are joined into characters, each drawn as its first code
  // point is.
  let line: Cell[] = [];
  const endLine = () => {
    const first = line.findIndex((cell) => cell.ch !== " ");
    const last = line.findLastIndex((cell) => cell.ch !== " ");
    if (first >= 0) {
      const points = line.slice(first, last + 1);
      let at = 0;
      const characters = drawnCharacters(points.map((cell) => cell.ch).join(""))
        .map((ch): Cell => {
          const cell = points[at];
          at += cpLen(ch);
          return { ...cell, ch };
        });
      lines.push(linkAddresses(characters));
    }
    line = [];
  };
  const endParagraph = () => {
    endLine();
    if (lines.length > 0) blocks.push({ kind: "paragraph", lines });
    lines = [];
  };
  for (const span of entry.text) {
    if (span.tone === "quote") {
      endParagraph();
      blocks.push({ kind: "quote", text: span.text });
      continue;
    }
    const tone = span.tone === "name" ? "name" : "bright";
    span.text.split("\n").forEach((piece, i) => {
      if (i > 0) endLine();
      for (const ch of piece) {
        line.push(
          span.url === undefined ? { ch, tone } : { ch, tone, url: span.url },
        );
      }
    });
  }
  if (entry.kind === "step") {
    const { state } = entry;
    if (entry.waits === "work") {
      [...WAIT].forEach((ch, i) =>
        line.push(
          i === 0 ? { ch, tone: "bright" } : {
            ch,
            tone: "bright",
            glued: true,
          },
        )
      );
    }
    const glyph = state === "busy" ? spinner : ENDED[state];
    if (glyph !== "" && state !== "left") {
      line.push(
        { ch: " ", tone: "bright", glued: true },
        { ch: glyph, tone: state, glued: true },
      );
    }
  }
  endParagraph();
  return blocks;
}

/** `cells`, with each web address in them that links nowhere linking to
 * the whole address. */
function linkAddresses(cells: readonly Cell[]): Cell[] {
  const text = cells.map((cell) => cell.ch).join("");
  const linked = [...cells];
  for (const match of webAddresses(text)) {
    const from = cpLen(text.slice(0, match.index));
    const to = from + cpLen(match[0]);
    const covered: number[] = [];
    let at = 0;
    cells.forEach((cell, i) => {
      if (at >= from && at < to) covered.push(i);
      at += cpLen(cell.ch);
    });
    // An address that runs into text with a link of its own is not one.
    if (covered.every((i) => cells[i].url === undefined)) {
      for (const i of covered) linked[i] = { ...cells[i], url: match[0] };
    }
  }
  return linked;
}

/**
 * `cells` in rows at most `columns` terminal columns wide. A line wider than
 * that wraps after its last space that fits, so that an address no wider
 * than the box stays on one row, and a word wider than the box is broken,
 * though never inside a character; a character wider than the box takes a
 * row of its own.
 */
function wrap(cells: readonly Cell[], columns: number): Cell[][] {
  const rows: Cell[][] = [];
  let at = 0;
  for (;;) {
    let fit = at;
    for (let used = 0; fit < cells.length; fit++) {
      used += shownCells(cells[fit].ch).length;
      if (used > columns) break;
    }
    if (fit === cells.length) break;
    fit = Math.max(at + 1, fit);
    let space = Math.min(fit, cells.length - 1);
    while (space >= at && (cells[space].ch !== " " || cells[space].glued)) {
      space--;
    }
    let words = space;
    while (words > at && cells[words - 1].ch === " ") words--;
    if (space >= at && words > at) {
      rows.push(cells.slice(at, words));
      at = space + 1;
      while (at < cells.length && cells[at].ch === " ") at++;
    } else {
      while (fit > at + 1 && cells[fit]?.glued) fit--;
      rows.push(cells.slice(at, fit));
      at = fit;
    }
  }
  // A last character wider than the row has taken a row of its own.
  if (at < cells.length || rows.length === 0) rows.push(cells.slice(at));
  return rows;
}

/** The row `cells` make, each run of cells drawn alike as one span, whose
 * offsets are counted in code points. */
function toRow(cells: readonly Cell[]): TaskRow {
  const spans: DialogSpan[] = [];
  let at = 0;
  for (const cell of cells) {
    const to = at + cpLen(cell.ch);
    const last = spans.at(-1);
    if (last && last.tone === cell.tone && last.url === cell.url) {
      spans[spans.length - 1] = { ...last, to };
    } else {
      spans.push(
        cell.url === undefined
          ? { from: at, to, tone: cell.tone }
          : { from: at, to, tone: cell.tone, url: cell.url },
      );
    }
    at = to;
  }
  return { text: cells.map((cell) => cell.ch).join(""), spans };
}
