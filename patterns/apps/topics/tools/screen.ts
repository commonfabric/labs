/**
 * Draws the live view of a Topics board: a full-screen frame, in the dark
 * palette and double-line frames of `cf view`, of the board's most recently
 * active Topics beside a feed of what is happening to them. A frame is a pure
 * function of the state, the terminal's size, and the time, so an animation is
 * a series of frames drawn at different times: a new event's card types its
 * content in and glows as it arrives, and the Topic it happened to rises to
 * the top of the list with a highlight that fades.
 */

import { unicodeWidth } from "@std/cli/unicode-width";
import {
  RESET,
  type Rgb,
  sgr,
  type Style,
  term,
} from "@commonfabric/cli/view/ansi";
import { glyphFor } from "@commonfabric/cli/view/display";
import { palette as C } from "@commonfabric/cli/view/theme";

import type { Topic } from "./mirror.ts";
import type { TopicEvent } from "./events.ts";

/** A run of text drawn in one style. */
interface Span {
  text: string;
  style: Style;

  /** Where the text links to, as a terminal hyperlink. */
  href?: string;
}

/** One row of a region, as runs of text. */
type Row = Span[];

/** How each kind of event is labeled, and the color it is drawn in. */
const KINDS: Record<TopicEvent["kind"], { label: string; color: Rgb }> = {
  filed: { label: "new topic", color: C.green },
  comment: { label: "comment", color: C.blue },
  edited: { label: "comment edited", color: C.cyan },
  retracted: { label: "comment retracted", color: C.red },
  retitled: { label: "renamed", color: C.yellow },
  body: { label: "body rewritten", color: C.purple },
  link: { label: "link", color: C.cyan },
  unlinked: { label: "link removed", color: C.red },
  mention: { label: "mention", color: C.orange },
  unmentioned: { label: "mention removed", color: C.red },
};

/** How long a new card glows, and a changed Topic stays highlighted. */
export const GLOW_MS = 4000;

/** The widest a card is drawn, so that its lines stay readable. */
const CARD_WIDTH = 100;

/** The longest a new card takes to type its content in. */
const TYPE_MS = 1600;

/** The fewest characters a new card types in per millisecond. */
const TYPE_RATE = 0.12;

/** One card of the feed: an event, and when this view learned of it. */
export interface FeedItem {
  event: TopicEvent;

  /** When the event reached this view, in milliseconds. */
  arrived: number;

  /** Whether it arrived while the view was running, which animates it. */
  live: boolean;
}

/** What the live view shows. */
export interface ScreenState {
  /** The space the board is in, as its name. */
  space: string;

  /** The address that opens a Topic in a browser, less the Topic's number. */
  topicLinks: string;

  /** Every Topic on the board. */
  topics: readonly Topic[];

  /** The feed, newest first. */
  feed: readonly FeedItem[];

  /** When each Topic last changed while the view was running, by number. */
  touched: ReadonlyMap<string, { at: number; color: Rgb }>;

  /** Whether the view is following the board's changes yet. */
  live: boolean;

  /** How many documents the copy holds the content of. */
  held: number;

  /** When the last change arrived, if one has. */
  lastChange?: number;
}

/** The color an event kind is drawn in. */
export function kindColor(kind: TopicEvent["kind"]): Rgb {
  return KINDS[kind].color;
}

/**
 * Whether a frame drawn at `now` differs from one drawn later, because a card
 * is still typing or glowing or a Topic is still highlighted.
 */
export function animating(state: ScreenState, now: number): boolean {
  return state.feed.some((item) => item.live && now - item.arrived < GLOW_MS) ||
    [...state.touched.values()].some(({ at }) => now - at < GLOW_MS);
}

/**
 * The frame for `state` on a terminal `width` columns by `height` rows, at
 * `now`: one string per row, each of which moves to the start of its row and
 * paints every cell of it, so a frame is drawn by writing the rows that
 * differ from the last one.
 */
export function render(
  state: ScreenState,
  width: number,
  height: number,
  now: number,
): string[] {
  if (width < 60 || height < 12) {
    const message = "Make the terminal at least 60 by 12 to watch the board.";
    return paintRows(
      Array.from(
        { length: height },
        (_, row) =>
          row === Math.floor(height / 2)
            ? [span(center(message, width), { fg: C.fg, bg: C.editorBg })]
            : [],
      ),
      width,
      C.editorBg,
    );
  }
  const body = height - 2;
  const listWidth = Math.min(56, Math.floor(width * 0.38));
  const feedWidth = width - listWidth - 1;
  const list = listRows(state, listWidth, body, now);
  const feed = feedRows(state, feedWidth, body, now);
  const rows: Row[] = [titleBar(state, width, now)];
  for (let row = 0; row < body; row++) {
    rows.push([
      ...fit(list[row] ?? [], listWidth, C.editorBg),
      span("│", { fg: C.panelHi, bg: C.editorBg }),
      ...fit(feed[row] ?? [], feedWidth, C.editorBg),
    ]);
  }
  rows.push(statusBar(state, width));
  return paintRows(rows, width, C.editorBg);
}

//
// The bars
//

function titleBar(state: ScreenState, width: number, now: number): Row {
  const bar = { bg: C.panel };
  const left: Row = [
    span(" ◆ ", { ...bar, fg: C.cyan, bold: true }),
    span("Topics", { ...bar, fg: C.fgBright, bold: true }),
    span(`  ${state.space}`, { ...bar, fg: C.fgDim }),
  ];
  const right: Row = [
    span(
      `${state.topics.length.toLocaleString("en-US")} ` +
        `${state.topics.length === 1 ? "topic" : "topics"}  `,
      { ...bar, fg: C.fgDim },
    ),
    ...pill(state, now),
    span(" ", bar),
  ];
  return spread(left, right, width, C.panel);
}

/** The pill saying whether the view is live, which flashes as changes land. */
function pill(state: ScreenState, now: number): Row {
  if (!state.live) {
    return [span(" ○ connecting ", { fg: C.ink, bg: C.yellow, bold: true })];
  }
  const flash = state.lastChange === undefined
    ? 0
    : fade(now - state.lastChange, GLOW_MS / 2);
  return [
    span(" ● LIVE ", {
      fg: C.ink,
      bg: mix(darken(C.green, 0.8), C.white, flash * 0.6),
      bold: true,
    }),
  ];
}

function statusBar(state: ScreenState, width: number): Row {
  const bar = { bg: C.panel };
  const left: Row = [
    span(" q ", { ...bar, fg: C.red, bold: true }),
    span("Quit", { ...bar, fg: C.fg }),
    span(
      `   holding ${state.held.toLocaleString("en-US")} documents`,
      { ...bar, fg: C.fgDim },
    ),
  ];
  const right: Row = state.lastChange === undefined
    ? [span("waiting for changes ", { ...bar, fg: C.fgDim })]
    : [
      span("last change ", { ...bar, fg: C.fgDim }),
      span(`${clock(state.lastChange)} `, { ...bar, fg: C.fg }),
    ];
  return spread(left, right, width, C.panel);
}

//
// The list of Topics
//

function listRows(
  state: ScreenState,
  width: number,
  height: number,
  now: number,
): Row[] {
  const rows: Row[] = [
    [],
    [span("  RECENT ACTIVITY", { fg: C.fgDim, bold: true })],
    [span(`  ${"─".repeat(width - 4)}`, { fg: C.panelHi })],
  ];
  const recent = [...state.topics].sort((a, b) =>
    (b.lastActivityAt - a.lastActivityAt) ||
    (Number(b.number) - Number(a.number))
  );
  for (const topic of recent.slice(0, height - rows.length)) {
    const touched = state.touched.get(topic.number);
    const glow = touched === undefined ? 0 : fade(now - touched.at, GLOW_MS);
    const bg = touched === undefined
      ? C.editorBg
      : mix(C.editorBg, darken(touched.color, 0.35), glow);
    const when = day(topic.lastActivityAt, now);
    const pad = " ".repeat(Math.max(0, 5 - topic.number.length));
    const titleWidth = width - 2 - (pad.length + topic.number.length) - 1 -
      when.length - 2;
    rows.push([
      span(
        glow > 0 ? "▌" : " ",
        { fg: touched?.color ?? C.editorBg, bg },
      ),
      span(` ${pad}`, { bg }),
      span(
        topic.number,
        { fg: glow > 0 ? C.yellow : darken(C.yellow, 0.75), bg },
        state.topicLinks + topic.number,
      ),
      span(" ", { bg }),
      ...fit(
        [
          span(clip(topic.title, titleWidth), {
            fg: glow > 0 ? C.fgBright : C.fg,
            bold: glow > 0,
            bg,
          }),
        ],
        titleWidth,
        bg,
      ),
      span(` ${when} `, { fg: C.fgDim, bg }),
    ]);
  }
  return rows;
}

//
// The feed
//

function feedRows(
  state: ScreenState,
  width: number,
  height: number,
  now: number,
): Row[] {
  const rows: Row[] = [
    [],
    [span("  AS IT HAPPENS", { fg: C.fgDim, bold: true })],
    [span(`  ${"─".repeat(width - 4)}`, { fg: C.panelHi })],
  ];
  if (state.feed.length === 0) {
    rows.push([
      span(
        center("Nothing has happened on the board yet.", width),
        { fg: C.fgDim },
      ),
    ]);
  }
  for (const item of state.feed) {
    if (rows.length >= height) break;
    for (
      const row of card(
        item,
        Math.min(width - 1, CARD_WIDTH),
        state.topicLinks,
        now,
      )
    ) {
      rows.push([span(" "), ...row]);
    }
  }
  return rows.slice(0, height);
}

/**
 * The card for `item`, `width` columns wide with its shadow: a frame naming
 * what happened and when, the Topic it happened to and who did it, and what
 * it says.
 */
function card(
  item: FeedItem,
  width: number,
  links: string,
  now: number,
): Row[] {
  const { event, live } = item;
  const kind = KINDS[event.kind];
  const age = now - item.arrived;
  const glow = live ? fade(age, GLOW_MS) : 0;
  const inner = width - 3;
  const bg = mix(C.panel, C.panelHi, glow);
  const border: Style = {
    fg: live ? mix(C.fg, kind.color, glow) : C.fgDim,
    bold: live,
    bg,
  };
  const textWidth = inner - 2;
  const content = details(event, textWidth, live ? 8 : 3, links);
  const typed = live
    ? Math.floor(
      Math.max(TYPE_RATE, characters(content) / TYPE_MS) * Math.max(0, age),
    )
    : Infinity;
  const shown = typeIn(content, typed, kind.color);
  const badge = ` ● ${kind.label} `;
  const time = ` ${clock(event.at)} `;
  const rule = Math.max(
    0,
    inner - 2 - columns(badge) - columns(time),
  );
  const top: Row = [
    span("╔═", border),
    span(badge, {
      fg: glow > 0.5 ? C.white : kind.color,
      bg: glow > 0 ? mix(bg, kind.color, glow * 0.8) : bg,
      bold: true,
    }),
    span("═".repeat(rule), border),
    span(time, { fg: C.fgDim, bg }),
    span("═╗", border),
  ];
  const line = (content: Row): Row => [
    span("║ ", border),
    ...fit(content, textWidth, bg),
    span(" ║", border),
  ];
  const heading: Row = [
    span(
      `top/${event.topic.number}`,
      { fg: C.yellow, bold: true, bg },
      links + event.topic.number,
    ),
    span("  ", { bg }),
    span(event.topic.title, { fg: C.fgBright, bold: true, bg }),
  ];
  const shadow = span(" ", { bg: C.shadow });
  const rows: Row[] = [
    [...top, span(" ", { bg: C.editorBg })],
    [...line(heading), shadow],
    [...line(byline(event, bg)), shadow],
    ...(shown.length === 0 ? [] : [[...line([]), shadow]]),
    ...shown.map((row) => [
      ...line(row.map((s) => ({ ...s, style: { bg, ...s.style } }))),
      shadow,
    ]),
    [span(`╚${"═".repeat(inner)}╝`, border), shadow],
    [
      span(" ", { bg: C.editorBg }),
      span(" ".repeat(width - 1), { bg: C.shadow }),
    ],
  ];
  return rows.map((row) =>
    row.map((s) => ({
      ...s,
      style: {
        bg,
        ...s.style,
        // An earlier event recedes, so that what arrives live stands out.
        ...(live || s.style.fg === undefined
          ? {}
          : { fg: mix(s.style.fg, bg, 0.3), bold: false }),
      },
    }))
  );
}

/** Who did what to the Topic, under its title. */
function byline(event: TopicEvent, bg: Rgb): Row {
  const dim: Style = { fg: C.fgDim, bg };
  switch (event.kind) {
    case "comment":
    case "edited":
    case "retracted":
      return [span(event.comment.author || "someone", dim)];
    case "filed":
      return [span(`filed by ${event.topic.createdBy || "someone"}`, dim)];
    case "link":
      return [
        span(`${event.link.kind} link`, dim),
        ...(
          event.link.addedBy === ""
            ? []
            : [span(` added by ${event.link.addedBy}`, dim)]
        ),
      ];
    case "unlinked":
      return [span(`${event.link.kind} link taken back`, dim)];
    case "mention":
      return [span("now references", dim)];
    case "unmentioned":
      return [span("no longer references", dim)];
    case "retitled":
      return [
        span("was ", dim),
        span(event.before, { ...dim, strikethrough: true }),
      ];
    case "body":
      return [span("the body was replaced", dim)];
  }
}

/** What each event's card says, laid out once for the width it was drawn at. */
const laidOut = new WeakMap<TopicEvent, { key: string; rows: Row[] }>();

/**
 * What a card says about its event, at most `lines` rows `width` wide, a
 * Topic's number linking to `links` with the number after it.
 */
function details(
  event: TopicEvent,
  width: number,
  lines: number,
  links: string,
): Row[] {
  const key = `${width} ${lines} ${links}`;
  const done = laidOut.get(event);
  if (done?.key === key) return done.rows;
  const rows = layOut(event, width, lines, links);
  laidOut.set(event, { key, rows });
  return rows;
}

/** Helper for {@link details}, which lays the card's content out. */
function layOut(
  event: TopicEvent,
  width: number,
  lines: number,
  links: string,
): Row[] {
  switch (event.kind) {
    case "comment":
    case "edited":
      return clipRows(markdown(event.comment.body, width), lines);
    case "retracted":
      return clipRows(markdown(event.comment.body, width).map(struck), lines);
    case "filed":
      return clipRows(markdown(event.topic.body, width), lines);
    case "link":
    case "unlinked": {
      const row = [
        span(event.link.label || event.link.url, { fg: C.fgBright }),
        ...(event.link.label === "" || event.link.label === event.link.url
          ? []
          : [
            span("  "),
            span(event.link.url, { fg: C.blue, underline: true }),
          ]),
      ];
      return [event.kind === "link" ? row : struck(row)];
    }
    case "mention":
    case "unmentioned": {
      const row = [
        span(
          `top/${event.other.number}`,
          { fg: C.yellow, bold: true },
          links + event.other.number,
        ),
        span("  "),
        span(event.other.title, { fg: C.fgBright }),
      ];
      return [event.kind === "mention" ? row : struck(row)];
    }
    case "retitled":
      return [[span(event.topic.title, { fg: C.green, bold: true })]];
    case "body":
      return clipRows(bodyChange(event.before, event.topic.body, width), lines);
  }
}

/** `row` dimmed and struck through, as what was taken back is. */
function struck(row: Row): Row {
  return row.map((s) => ({
    ...s,
    style: { ...s.style, fg: C.fgDim, strikethrough: true },
  }));
}

/** The lines a body gained and lost, tinted as a diff is. */
function bodyChange(before: string, after: string, width: number): Row[] {
  const old = new Set(before.split("\n"));
  const fresh = new Set(after.split("\n"));
  const lines = [
    ...after.split("\n").filter((line) => line.trim() !== "" && !old.has(line))
      .map((line) => ({ line, mark: "+", fg: C.green, bg: C.addBg })),
    ...before.split("\n").filter((line) =>
      line.trim() !== "" && !fresh.has(line)
    ).map((line) => ({ line, mark: "−", fg: C.red, bg: C.delBg })),
  ];
  return lines.map(({ line, mark, fg, bg }) => [
    span(`${mark} `, { fg, bg, bold: true }),
    span(clip(line, width - 2), { fg: C.fg, bg }),
  ]);
}

/** `rows`, at most `count` of them, the last saying so when some were cut. */
function clipRows(rows: Row[], count: number): Row[] {
  if (rows.length <= count) return rows;
  return [...rows.slice(0, count - 1), [span("…", { fg: C.fgDim })]];
}

/** The characters `rows` hold. */
function characters(rows: readonly Row[]): number {
  return rows.reduce(
    (sum, row) => sum + row.reduce((n, s) => n + graphemes(s.text).length, 0),
    0,
  );
}

/**
 * The first `count` characters of `rows`, as typed so far, with a cursor in
 * `color` after the last while some are still to come.
 */
function typeIn(rows: readonly Row[], count: number, color: Rgb): Row[] {
  if (count >= characters(rows)) return [...rows];
  // Characters still to type, or -1 once the cursor is placed.
  let left = count;
  const typed: Row[] = [];
  for (const row of rows) {
    if (left < 0) break;
    typed.push(row.flatMap((s) => {
      const chars = graphemes(s.text);
      if (left < 0) return [];
      if (left >= chars.length) {
        left -= chars.length;
        return [s];
      }
      const cut = { ...s, text: chars.slice(0, left).join("") };
      left = -1;
      return [cut, span("▌", { fg: color, bold: true })];
    }));
  }
  // The rows still to come are held open, so that the card keeps its height.
  while (typed.length < rows.length) typed.push([]);
  return typed;
}

//
// Markdown, lightly
//

/**
 * `text` as rows `width` wide, with headings, emphasis, code, links, quotes,
 * and lists drawn rather than marked up.
 */
export function markdown(text: string, width: number): Row[] {
  const rows: Row[] = [];
  let fenced = false;
  // The lines of the paragraph being read, which wrap as one.
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    for (const row of wrap(inline(paragraph.join(" "), { fg: C.fg }), width)) {
      rows.push(row);
    }
    paragraph = [];
  };
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const plain = !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(raw) &&
      raw.trim() !== "";
    if (plain && !fenced) {
      paragraph.push(raw.trim());
      continue;
    }
    flush();
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      rows.push([
        span(take(printable(raw.replaceAll("\t", "  ")), width), {
          fg: C.cyan,
        }),
      ]);
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      for (
        const row of wrap(
          inline(heading[1], { fg: C.fgBright, bold: true }),
          width,
        )
      ) {
        rows.push(row);
      }
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) {
      const indent = Math.min(item[1].length, 6);
      const marker = /\d/.test(item[2]) ? clip(item[2], 6) : "•";
      const bullet = `${" ".repeat(indent)}${marker} `;
      wrap(inline(item[3], { fg: C.fg }), width - bullet.length).forEach(
        (row, index) =>
          rows.push([
            span(index === 0 ? bullet : " ".repeat(bullet.length), {
              fg: C.cyan,
            }),
            ...row,
          ]),
      );
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      for (const row of wrap(inline(quote[1], { fg: C.fgDim }), width - 2)) {
        rows.push([span("▎ ", { fg: C.panelHi }), ...row]);
      }
      continue;
    }
    if ((rows.at(-1)?.length ?? 0) > 0) rows.push([]);
  }
  flush();
  while (rows.at(-1)?.length === 0) rows.pop();
  return rows;
}

/** `text`'s inline markup drawn: `code`, **strong**, *emphasis*, links. */
function inline(text: string, base: Style): Row {
  const spans: Row = [];
  const pattern =
    /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) spans.push(span(text.slice(at, match.index), base));
    const [, code, strong, emphasis, label] = match;
    if (code !== undefined) spans.push(span(code, { ...base, fg: C.cyan }));
    else if (strong !== undefined) {
      spans.push(span(strong, { ...base, fg: C.fgBright, bold: true }));
    } else if (emphasis !== undefined) {
      spans.push(span(emphasis, { ...base, italic: true }));
    } else {
      spans.push(span(label, { ...base, fg: C.blue, underline: true }));
    }
    at = match.index + match[0].length;
  }
  if (at < text.length) spans.push(span(text.slice(at), base));
  return spans;
}

/** `spans` wrapped at word boundaries into rows `width` wide. */
function wrap(spans: Row, width: number): Row[] {
  const rows: Row[] = [];
  let row: Row = [];
  let used = 0;
  const end = () => {
    rows.push(trimEnd(row));
    row = [];
    used = 0;
  };
  for (const s of spans) {
    for (const word of s.text.split(/(\s+)/)) {
      if (word === "") continue;
      if (/^\s/.test(word)) {
        if (used > 0) {
          row.push(span(" ", s.style));
          used += 1;
        }
        continue;
      }
      if (used > 0 && used + columns(word) > width) end();
      // A word wider than a row is cut where each row ends, every row taking
      // at least one character, however wide.
      let piece = "";
      for (const char of graphemes(word)) {
        const wide = columns(char);
        if (used > 0 && used + wide > width) {
          if (piece !== "") row.push(span(piece, s.style));
          piece = "";
          end();
        }
        piece += char;
        used += wide;
      }
      row.push(span(piece, s.style));
    }
  }
  if (row.length > 0) rows.push(trimEnd(row));
  return rows;
}

function trimEnd(row: Row): Row {
  const last = row.at(-1);
  return last !== undefined && last.text === " " ? row.slice(0, -1) : row;
}

//
// Text and color
//

/** The characters that set the direction text runs in, or break a line. */
const DIRECTING =
  /[\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A run of `text` in `style`, as {@link printable} draws it, linking to
 * `href` when there is one.
 */
function span(text: string, style: Style = {}, href?: string): Span {
  return {
    text: printable(text),
    style,
    ...(href === undefined ? {} : { href }),
  };
}

/**
 * `text` with a tab drawn as a space, and every other character a terminal
 * would act on rather than print, or that would turn the text around, drawn
 * as a glyph standing for it, so that what the board holds cannot drive the
 * terminal, and is measured as it is drawn.
 */
function printable(text: string): string {
  let shown = "";
  for (const char of text.replaceAll("\t", " ").replace(DIRECTING, "␦")) {
    shown += glyphFor(char);
  }
  return shown;
}

const segmenter = new Intl.Segmenter();

/** The characters of `text` as a reader sees them. */
function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/**
 * How many columns `text` takes. An emoji made of several code points, such
 * as one asking for emoji presentation, one with a skin tone, a flag, or
 * emoji joined into one, takes two, as terminals draw them.
 */
function columns(text: string): number {
  let total = 0;
  for (const char of graphemes(text)) {
    total += [...char].length > 1 && EMOJI.test(char) ? 2 : unicodeWidth(char);
  }
  return total;
}

/** A code point that makes a character of several an emoji. */
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F/u;

/** The longest start of `text` that fits in `width` columns. */
function take(text: string, width: number): string {
  let used = 0;
  let out = "";
  for (const char of graphemes(text)) {
    used += columns(char);
    if (used > width) break;
    out += char;
  }
  return out;
}

/** `text` cut to `width` columns, ending in an ellipsis when it was cut. */
function clip(text: string, width: number): string {
  const flat = printable(text).replace(/\s+/g, " ");
  if (columns(flat) <= width) return flat;
  return `${take(flat, Math.max(0, width - 1))}…`;
}

function center(text: string, width: number): string {
  const cut = clip(text, width);
  return " ".repeat(Math.max(0, Math.floor((width - columns(cut)) / 2))) +
    cut;
}

/** `row` cut or padded to exactly `width` columns, padding in `bg`. */
function fit(row: Row, width: number, bg: Rgb): Row {
  const out: Row = [];
  let used = 0;
  for (const s of row) {
    if (used + columns(s.text) <= width) {
      out.push(s);
      used += columns(s.text);
      continue;
    }
    const head = take(s.text, width - used);
    out.push({ ...s, text: head });
    used += columns(head);
    break;
  }
  if (used < width) {
    const last = out.at(-1)?.style.bg ?? bg;
    out.push(span(" ".repeat(width - used), { bg: last }));
  }
  return out;
}

/**
 * `left` and `right` at either end of a row `width` wide, on `bg`, `left`
 * cut short where both do not fit.
 */
function spread(left: Row, right: Row, width: number, bg: Rgb): Row {
  const room = width - right.reduce((n, s) => n + columns(s.text), 0);
  return fit([...fit(left, room, bg), ...right], width, bg);
}

/** How bright a glow `elapsed` into `duration` still is, from 1 down to 0. */
function fade(elapsed: number, duration: number): number {
  if (elapsed >= duration) return 0;
  const t = Math.max(elapsed, 0) / duration;
  return 1 - t * t;
}

/** The color `amount` of the way from `from` to `to`. */
function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

function darken(color: Rgb, amount: number): Rgb {
  return mix(color, C.editorBg, 1 - amount);
}

/** `14:02:31`, in local time. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour12: false });
}

/** `14:02` for a time today, else `Oct 24`, in local time. */
function day(at: number, now: number): string {
  if (at <= 0) return "      ";
  const date = new Date(at);
  return (date.toDateString() === new Date(now).toDateString()
    ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "2-digit" }))
    .padStart(6);
}

/**
 * `rows` painted from the top left, each padded to `width`, on `bg` wherever
 * a run names no background of its own.
 */
function paintRows(rows: readonly Row[], width: number, bg: Rgb): string[] {
  return rows.map((row, index) =>
    term.moveTo(index + 1, 1) + term.clearLine +
    fit(row, width, bg).map((s) =>
      RESET + sgr({ bg, ...s.style }) +
      (s.href === undefined ? s.text : term.hyperlink(s.href, s.text))
    ).join("") +
    RESET
  );
}
