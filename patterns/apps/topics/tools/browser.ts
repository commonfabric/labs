/**
 * `deno task topics browse`: the Topics board for a person to read and write,
 * in the manner of Turbo Vision. A menu bar runs along the top and a status
 * line of keys along the bottom; between them a window lists the board's
 * Topics, filtered as a search is typed, beside a window reading one Topic
 * whole: its body, links, the Topics it refers to and that refer to it, the
 * Topics most like it, and its thread. Everything a person can click runs
 * when clicked, and a link opens where it points.
 *
 * The view stays live: a Topic that changes lights up, and the one being read
 * is drawn again as it stands. What a person writes is kept as a draft until
 * it is saved, whatever happens to the Topic meanwhile, and survives quitting;
 * saving a body or a title someone else has changed since asks first. Which
 * Topics have activity the person has not seen is remembered between runs.
 *
 * The browser is a {@link BoardView}: `watch.ts` runs the terminal and the
 * session, and a {@link Host} makes writes and reaches the world outside.
 */

import type { Style } from "@commonfabric/cli/view/ansi";
import { decodeKeys, type Key } from "@commonfabric/cli/view/keys";
import { palette as C } from "@commonfabric/cli/view/theme";
import {
  defaultDisplayFit,
  type LabelDisplayFit,
} from "@commonfabric/html/worker";
import { maxOf, minOf } from "@commonfabric/collections/math";
import { describeFailure } from "@commonfabric/js-values/describe-failure";

import { Canvas, inside, type Rect } from "./canvas.ts";
import { changes } from "./events.ts";
import { Field } from "./field.ts";
import { admits, type PartLabels, redact, shortDid } from "./labels.ts";
import type { SearchHit, Topic, TopicComment, TopicLink } from "./mirror.ts";
import { CITATION_STYLE, prose } from "./prose.ts";
import {
  answer,
  type Author,
  authors,
  byQuery,
  families,
  parseQuery,
  type References,
  references,
  settled,
} from "./query.ts";
import { FRAME_MS, GLOW_MS, kindColor } from "./screen.ts";
import { similarTopics } from "./similar.ts";
import {
  center,
  clip,
  columns,
  darken,
  fade,
  graphemes,
  linkable,
  mix,
  type Row,
  rowColumns,
  type Span,
  span,
  wrap,
} from "./text.ts";
import type { BoardView } from "./watch.ts";
import {
  button,
  dialogBox,
  frame,
  type Hint,
  type Menu,
  menuBar,
  menuColumn,
  pullDown,
  type Scroll,
  scrollBar,
  statusLine,
} from "./widgets.ts";
import {
  capitalize,
  describe,
  firstLine,
  mergeSaved,
  type Told,
  Writes,
} from "./writes.ts";

//
// What the browser asks of the world
//

/** A write the browser asks its host to make. */
export type WriteRequest =
  | { verb: "new"; title: string; body: string }
  | { verb: "comment" | "body" | "title"; topic: string; text: string }
  | { verb: "link"; topic: string; url: string; label: string; kind: string }
  | { verb: "unlink"; topic: string; url: string }
  | { verb: "mention" | "unmention"; topic: string; other: string };

/**
 * How a write went: made, with what to report; made, and reading back
 * otherwise than it was made; possibly made, its invocation to be named
 * again to settle it; or failed before it was dispatched.
 */
export type WriteOutcome =
  | { result: "written"; report: string }
  | { result: "unconfirmed" | "unsettled" | "failed"; message: string };

/** A draft of what a person is writing, kept until it is saved. */
export interface Draft {
  /** The text of each of the editor's fields. */
  fields: string[];

  /** What the board held when the draft began, for a body or a title. */
  base: string;

  /** When the draft last changed. */
  at: number;
}

/** A write asked for and not yet known to have landed. */
export interface Pending {
  request: WriteRequest;

  /** The name the write is signed with, the same on every attempt. */
  agentName: string;

  /** How many times it has been sent, counted before each is made. */
  attempts: number;

  /**
   * The draft the write saves, and where it was kept, given back should
   * the write certainly fail.
   */
  draft?: { key: string; fields: string[]; base: string };

  /** What went wrong with a write of it that may have landed. */
  failure?: string;

  /** When it last changed: when it was asked for, or last sent. */
  at: number;
}

/** A draft or pending write thrown away. */
export interface Dropped {
  /** The moment the newest version thrown away last changed. */
  at: number;

  /** When it was thrown away. */
  when: number;
}

/** What the browser remembers between runs. */
export interface Saved {
  /** When the browser was first run, before which nothing is unread. */
  since: number;

  /** The last activity each Topic had when the person last read it. */
  seen: Record<string, number>;

  /** Drafts, by what they are drafts of: `comment:42`, `body:42`, `new`. */
  drafts: Record<string, Draft>;

  /** Writes not yet known to have landed, by their invocations. */
  pending: Record<string, Pending>;

  /**
   * The drafts and pending writes thrown away, by their keys, so that
   * merging what another browser saved brings back no version of one that
   * did not change since.
   */
  dropped: Record<string, Dropped>;

  /** The name the person's writes are signed with. */
  agentName?: string;

  /** Whether settled Topics are left out of the list. */
  hideSettled: boolean;
}

/** A Topic to open once the board holds it. */
export interface Opening {
  /** How a message names it: `top/42`, or the reference given, quoted. */
  name: string;

  /**
   * It among the board's Topics `topics`, if they hold it.
   *
   * @throws Error saying why it names none of them, such as being part of
   * the address of more than one.
   */
  find: (topics: readonly Topic[]) => Topic | undefined;
}

/** What the browser needs from outside itself. */
export interface Host {
  /**
   * Makes `request`, signed as `agentName`, as the invocation `invocation`:
   * once, however many times it is asked, settling on the first outcome.
   */
  write(
    request: WriteRequest,
    agentName: string,
    invocation: string,
  ): Promise<WriteOutcome>;

  /** Opens `url` in a web browser. */
  open(url: string): Promise<void>;

  /** Puts `text` on the clipboard. */
  copy(text: string): Promise<void>;

  /** Keeps `saved` for the next run. */
  save(saved: Saved): void;

  /** Waits for every save asked for, failing when the last one did. */
  persisted(): Promise<void>;
}

//
// Commands
//

/** The two windows. */
type Pane = "list" | "reader";

/** What a person can write. */
const COMPOSE_KINDS = ["comment", "body", "title", "new"] as const;
type ComposeKind = typeof COMPOSE_KINDS[number];

/** Something a key, a click, or a menu item does. */
type Command =
  | { do: "quit" }
  | { do: "help" }
  | { do: "about" }
  | { do: "menu"; index: number }
  | { do: "focus"; pane: Pane }
  | { do: "zoom"; pane?: Pane }
  | { do: "swap" }
  | { do: "open"; number: string }
  | { do: "row"; index: number }
  | { do: "back" }
  | { do: "forward" }
  | { do: "compose"; kind: ComposeKind }
  | { do: "link" }
  | { do: "mention" }
  | { do: "unlink"; url: string }
  | { do: "unmention"; number: string }
  | { do: "web" }
  | { do: "copy" }
  | { do: "authors" }
  | { do: "labels" }
  | { do: "goto" }
  | { do: "search" }
  | { do: "filter"; query: string }
  | { do: "settled" }
  | { do: "sort" }
  | { do: "unread" }
  | { do: "step"; by: 1 | -1 }
  | { do: "readAll" }
  | { do: "scroll"; pane: Pane | "dialog"; by: number }
  | { do: "thumb"; pane: Pane | "dialog" }
  | { do: "field"; id: number }
  | { do: "button"; index: number }
  | { do: "pick"; index: number }
  | { do: "close" }
  | { do: "next" }
  | { do: "families" }
  | { do: "unfinished" };

/** How the list is ordered. */
const SORTS = ["activity", "number", "comments"] as const;
type Sort = typeof SORTS[number];

//
// Dialogs
//

/** What submitting a form does. */
type Purpose =
  | {
    to: "compose";
    kind: ComposeKind;
    number?: string;

    /** What the board held when the editing began, for a body or a title. */
    base: string;
  }
  | { to: "link"; number: string }
  | { to: "mention"; number: string }
  | { to: "goto" }
  | { to: "agent"; then: () => void }
  | { to: "confirm"; then: () => void }
  | { to: "unfinished"; invocation: string };

/** A button of a form, and what pressing it does. */
interface FormButton {
  label: string;

  /**
   * The letter that presses it, drawn highlighted in its label: alone
   * where no field has the keys, and with Alt anywhere.
   */
  hotkey: string;
  act: "submit" | "alternate" | "cancel" | "discard" | "theirs" | "forget";
}

/** A dialog of fields and buttons. */
interface Form {
  kind: "form";
  title: string;
  purpose: Purpose;

  /** Lines the form says above its fields. */
  message: string[];
  fields: { label: string; field: Field; multiline: boolean }[];
  buttons: FormButton[];

  /** The field or button keys go to: fields first, then buttons. */
  focus: number;
}

/** A dialog of text to read. */
interface Reading {
  kind: "text";
  title: string;
  rows: (width: number) => Row<Command>[];
  top: number;

  /**
   * The most rows it has been drawn with, which it keeps while open, so
   * that what it shows shrinking never moves its buttons from the pointer.
   */
  tallest: number;
}

/** The dialog of everyone who has written on the board. */
interface Authors {
  kind: "authors";
  selected: number;
  top: number;

  /** Whether authors are gathered into their families. */
  families: boolean;

  /**
   * The most rows it has been drawn with, which it keeps while open, so
   * that what it shows shrinking never moves its buttons from the pointer.
   */
  tallest: number;
}

type Dialog = Form | Reading | Authors;

//
// The browser
//

/** The menus of the menu bar. */
const MENUS: Menu<Command>[] = [
  {
    label: "File",
    hotkey: "F",
    items: [
      {
        label: "New topic…",
        hotkey: "N",
        shortcut: "Ctrl-N",
        act: { do: "compose", kind: "new" },
      },
      {
        label: "Go to topic…",
        hotkey: "G",
        shortcut: "Ctrl-G",
        act: { do: "goto" },
      },
      {
        label: "Unfinished writes…",
        hotkey: "U",
        act: { do: "unfinished" },
      },
      "-",
      { label: "Exit", hotkey: "x", shortcut: "Alt-X", act: { do: "quit" } },
    ],
  },
  {
    label: "Topic",
    hotkey: "T",
    items: [
      {
        label: "Comment…",
        hotkey: "C",
        shortcut: "F2",
        act: { do: "compose", kind: "comment" },
      },
      {
        label: "Edit body…",
        hotkey: "E",
        shortcut: "F4",
        act: { do: "compose", kind: "body" },
      },
      {
        label: "Rename…",
        hotkey: "R",
        shortcut: "R",
        act: { do: "compose", kind: "title" },
      },
      { label: "Add link…", hotkey: "L", shortcut: "L", act: { do: "link" } },
      {
        label: "Mention a topic…",
        hotkey: "M",
        shortcut: "M",
        act: { do: "mention" },
      },
      "-",
      {
        label: "Open in web browser",
        hotkey: "O",
        shortcut: "O",
        act: { do: "web" },
      },
      {
        label: "Copy reference",
        hotkey: "y",
        shortcut: "Y",
        act: { do: "copy" },
      },
    ],
  },
  {
    label: "View",
    hotkey: "V",
    items: [
      { label: "Authors…", hotkey: "A", shortcut: "A", act: { do: "authors" } },
      {
        label: "CFC labels…",
        hotkey: "C",
        shortcut: "I",
        act: { do: "labels" },
      },
      "-",
      {
        // `#menus()` says "Show" here while settled Topics are hidden.
        label: "Hide settled topics",
        hotkey: "H",
        shortcut: "Ctrl-T",
        act: { do: "settled" },
      },
      { label: "Mark all read…", hotkey: "M", act: { do: "readAll" } },
      {
        label: "Change order",
        hotkey: "o",
        shortcut: "Ctrl-O",
        act: { do: "sort" },
      },
      "-",
      {
        label: "Zoom",
        hotkey: "Z",
        shortcut: "F5",
        act: { do: "zoom" },
      },
      {
        label: "Next window",
        hotkey: "w",
        shortcut: "F6",
        act: { do: "swap" },
      },
    ],
  },
  {
    label: "Go",
    hotkey: "G",
    items: [
      { label: "Back", hotkey: "B", shortcut: "Alt-←", act: { do: "back" } },
      {
        label: "Forward",
        hotkey: "F",
        shortcut: "Alt-→",
        act: { do: "forward" },
      },
      {
        label: "Next topic",
        hotkey: "T",
        shortcut: "Alt-↓",
        act: { do: "step", by: 1 },
      },
      {
        label: "Previous topic",
        hotkey: "P",
        shortcut: "Alt-↑",
        act: { do: "step", by: -1 },
      },
      {
        label: "Next unread",
        hotkey: "N",
        shortcut: "N",
        act: { do: "unread" },
      },
      { label: "Search", hotkey: "S", shortcut: "F3", act: { do: "search" } },
    ],
  },
  {
    label: "Help",
    hotkey: "H",
    items: [
      {
        label: "Keys and search…",
        hotkey: "K",
        shortcut: "F1",
        act: { do: "help" },
      },
      { label: "About…", hotkey: "A", act: { do: "about" } },
    ],
  },
];

/** How far a wheel step scrolls. */
const WHEEL = 3;

/** How many Topics most like the one being read it lists. */
const SIMILAR = 5;

/** How long a note in the status line stays. */
const NOTE_MS = 6000;

/** How long the spinner shows each of its turns. */
const SPIN_MS = 150;

/**
 * The colors authors are drawn in, one for each name: never the green of
 * the mark naming who integrity says wrote it, which a name could imitate.
 */
const AUTHOR_COLORS = [C.blue, C.cyan, C.purple, C.orange, C.yellow];

/** The board a browser shows, and who is looking. */
export interface BrowserBoard {
  /** The board's space, as its name. */
  space: string;

  /** The address that opens a Topic in a web browser, less its number. */
  topicLinks: string;

  /**
   * The DID of the person viewing, who reads and writes as that identity;
   * a display with none admits only what names no one.
   */
  viewer?: string;
}

/** The Topics browser. */
export class Browser implements BoardView {
  readonly modes = {
    // Mouse presses, drags, and the wheel, reported as SGR, and pastes
    // bracketed.
    take: "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h",
    give: "\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l",
  };

  readonly #board: BrowserBoard;
  readonly #host: Host;
  readonly #saved: Saved;
  readonly #redraw: () => void;
  readonly #now: () => number;
  readonly #fit: LabelDisplayFit;

  #topics: readonly Topic[] = [];
  #byNumber = new Map<string, Topic>();
  #refs: References = { out: new Map(), in: new Map() };
  #authors: Author[] | undefined;
  #live = false;
  #held = 0;
  #lastChange: number | undefined;
  #touched = new Map<string, { at: number; color: Style["fg"] }>();

  #search = new Field("");
  #hits: SearchHit[] = [];
  #hidden = 0;
  #sort: Sort = "activity";
  #selected = 0;
  #listTop = 0;

  #reading: string | undefined;
  #readerTop = 0;
  #target = -1;
  #newSince = 0;
  #back: string[] = [];
  #forward: string[] = [];
  #similar = new Map<string, { number: string; score: number }[]>();

  #focus: Pane = "list";
  #zoom: Pane | undefined;
  #menu: { index: number; item: number } | undefined;
  #dialogs: Dialog[] = [];
  #note: { text: string; at: number; error: boolean } | undefined;
  /** The Topic to open once the board holds it. */
  #opening: Opening | undefined;

  /** Whether unfinished writes have been offered for settling. */
  #offered = false;

  /** Whether the selection moved since the list was last drawn. */
  #moved = false;

  /** The drafts and pending writes. */
  readonly #writes: Writes;

  /** Set once the view has ended and is finishing its writes. */
  #closing = false;
  #quit = false;
  #rest: Uint8Array = new Uint8Array();

  /** What the last frame drew, for clicks to be found in. */
  #canvas: Canvas<Command> | undefined;
  #rects = new Map<string, Rect>();
  #scrolls = new Map<string, Scroll>();
  /**
   * The scroll bar whose thumb is held, where the pointer took it, and
   * where it showed then.
   */
  #dragging: { pane: Pane | "dialog"; y: number; top: number } | undefined;

  /** Where the pointer last went down. */
  #pressedAt = 0;

  /**
   * What the pointer went down on and where, which a release over the same
   * thing does, where the pointer is while held, and the dialog and menu
   * on top then, without which the press means nothing.
   */
  #pointer:
    | {
      click?: Command;
      href?: string;
      from: { x: number; y: number };
      at: { x: number; y: number };
      dialog: Dialog | undefined;
      menu: number | undefined;
    }
    | undefined;

  /** Whether the held pointer is still over what it went down on. */
  #armed = false;

  /**
   * What the pointer went down on that has a selection of its own, an
   * item of the open menu, a row of the list, or one of a dialog's list,
   * and the dialog on top then: the selection follows the pointer while
   * it is held, as the keys move it, and a release on an item runs it.
   */
  #selecting:
    | { kind: "menu" | "row" | "pick"; dialog: Dialog | undefined }
    | undefined;

  /** Whether a button drew itself pushed down, as being pressed, this frame. */
  #pushed = false;

  /** The reader's content as last laid out, and what it was laid out for. */
  #content: { key: unknown[]; rows: Row<Command>[] } | undefined;

  /**
   * A browser of `board` that writes and reaches outside through `host`,
   * remembering `saved` between runs, calling `redraw` when something it
   * did of its own accord changes what it shows, reading the time from
   * `now`, opening Topic `open` once the board holds it, and signing its
   * writes as `agentName` when one is given.
   */
  constructor(options: {
    board: BrowserBoard;
    host: Host;
    saved: Saved;
    redraw: () => void;
    now: () => number;
    open?: Opening;
    agentName?: string;
  }) {
    this.#board = options.board;
    this.#host = options.host;
    this.#saved = options.saved;
    this.#redraw = options.redraw;
    this.#now = options.now;
    this.#fit = defaultDisplayFit(options.board.viewer);
    this.#writes = new Writes({
      saved: options.saved,
      write: (request, agentName, invocation) =>
        options.host.write(request, agentName, invocation),
      save: (saved) => options.host.save(saved),
      persisted: () => options.host.persisted(),
      now: options.now,
      tell: (told) => this.#told(told),
    });
    this.#opening = options.open;
    if (options.agentName !== undefined) {
      this.#saved.agentName = options.agentName;
    }
  }

  //
  // The board view
  //

  update(
    board: readonly Topic[],
    now: number,
    live: boolean,
    held: number,
  ): void {
    // What the display does not admit is gone before anything sees it.
    const topics = redact(board, this.#fit);
    // The reader's focus stays on what it does, wherever that moves.
    const before = this.#targets();
    const focused = before[this.#target];
    const focus = focused === undefined ? undefined : {
      does: doing(focused.span),
      nth:
        before.slice(0, this.#target).filter((target) =>
          doing(target.span) === doing(focused.span)
        ).length,
    };
    if (this.#live) {
      const happened = changes(this.#topics, topics, now);
      for (const event of happened) {
        this.#touched.set(event.topic.number, {
          at: now,
          color: kindColor(event.kind),
        });
      }
      if (happened.length > 0) this.#lastChange = now;
    }
    this.#live = live;
    this.#held = held;
    this.#topics = topics;
    this.#byNumber = new Map(topics.map((topic) => [topic.number, topic]));
    this.#refs = references(topics);
    this.#authors = undefined;
    this.#similar.clear();
    this.#content = undefined;
    if (focus !== undefined) {
      const same = this.#targets().flatMap((target, index) =>
        doing(target.span) === focus.does ? [index] : []
      );
      this.#target = same[focus.nth] ?? -1;
    }
    this.#answer();
    this.#openNamed(live);
    // Writes the last run left unfinished are offered for settling once,
    // when the board is first live.
    if (live && !this.#offered) {
      this.#offered = true;
      if (Object.keys(this.#saved.pending).length > 0) this.#unfinished();
    }
  }

  input(bytes: Uint8Array): boolean {
    const joined = new Uint8Array(this.#rest.length + bytes.length);
    joined.set(this.#rest);
    joined.set(bytes, this.#rest.length);
    const decoded = decodeKeys(joined);
    this.#rest = decoded.rest;
    // While it finishes, the browser takes nothing but asking to end again.
    if (this.#closing) {
      return decoded.keys.some((key) =>
        QUIT.has(keyName(this.#optionAsAlt(key)))
      );
    }
    // Each key is read as what it is once the keys before it have acted.
    for (const typed of decoded.keys) {
      const key = this.#optionAsAlt(typed);
      if (key.mouse !== undefined || key.at !== undefined) this.#mouse(key);
      else this.#key(key);
      if (this.#quit) return true;
    }
    return false;
  }

  /**
   * `key` as Alt and a letter, when it is a character a Mac's Option key
   * types with that letter and nothing is being typed: into a field, or a
   * search begun in the list. A terminal that leaves Option as Option, as
   * Terminal and iTerm2 do unless told otherwise, sends the character
   * rather than Alt.
   */
  #optionAsAlt(key: Key): Key {
    const letter = key.char === undefined
      ? undefined
      : OPTION_LETTERS[key.char];
    const top = this.#dialogs.at(-1);
    const typing = top === undefined
      ? this.#focus === "list" && this.#search.text !== ""
      : top.kind === "form" && top.focus < top.fields.length;
    return letter === undefined || typing
      ? key
      : { name: letter, char: letter, alt: true };
  }

  frame(columns: number, rows: number, now: number): string[] {
    this.#armed = this.#over();
    this.#pushed = false;
    const canvas = new Canvas<Command>(columns, rows, C.editorBg);
    this.#canvas = canvas;
    this.#rects.clear();
    this.#scrolls.clear();
    if (columns < 60 || rows < 15) {
      canvas.put(0, Math.floor(rows / 2), [
        span(
          center(
            "Make the terminal at least 60 by 15 to browse the board.",
            columns,
          ),
          {
            fg: C.fg,
          },
        ),
      ]);
      return canvas.paint();
    }
    this.#drawWindows(canvas, now);
    menuBar(
      canvas,
      this.#menus(),
      this.#menu?.index,
      (index): Command => ({ do: "menu", index }),
      this.#pill(now),
    );
    statusLine(canvas, this.#hints(), this.#statusRight(now));
    for (const dialog of this.#dialogs) this.#drawDialog(canvas, dialog);
    if (this.#menu !== undefined) {
      const menu = this.#menus()[this.#menu.index];
      this.#rects.set(
        "menu",
        pullDown(
          canvas,
          menuColumn(this.#menus(), this.#menu.index),
          1,
          menu,
          this.#menu.item,
        ),
      );
    }
    // What has no pushed look of its own shows pressed in turned colors.
    const pointer = this.#pointer;
    if (this.#armed && !this.#pushed && pointer !== undefined) {
      canvas.press(canvas.reach(pointer.from.x, pointer.from.y, doing), C.fg);
    }
    return canvas.paint();
  }

  nextFrame(now: number): number | undefined {
    const glowing =
      [...this.#touched.values()].some(({ at }) => now - at < GLOW_MS) ||
      (this.#lastChange !== undefined && now - this.#lastChange < GLOW_MS);
    const noted = this.#note !== undefined && now - this.#note.at < NOTE_MS;
    // A glow fades smoothly; the spinner turns, and a note goes, only now
    // and then.
    const waits = [
      ...(glowing ? [FRAME_MS] : []),
      ...(this.#writes.busy > 0 ? [SPIN_MS - now % SPIN_MS] : []),
      ...(noted && this.#note !== undefined
        ? [NOTE_MS - (now - this.#note.at)]
        : []),
    ];
    return waits.length === 0 ? undefined : minOf(waits);
  }

  /**
   * Takes in `theirs`, what another browser saved to the same file, so
   * that a draft or a write it finished or threw away is not offered here.
   */
  reconcile(theirs: Saved): void {
    const before = { ...this.#saved.drafts };
    Object.assign(this.#saved, mergeSaved(theirs, this.#saved));
    // An editor open on a draft another browser posted, threw away, or
    // changed follows it.
    for (const dialog of this.#dialogs) {
      if (dialog.kind !== "form" || dialog.purpose.to !== "compose") continue;
      const key = draftKey(dialog.purpose.kind, dialog.purpose.number);
      const was = before[key];
      const now = this.#saved.drafts[key];
      if (was !== undefined && now === undefined) {
        // A question asked of it goes with it.
        this.#dialogs = this.#dialogs.slice(0, this.#dialogs.indexOf(dialog));
        this.#say(
          "Your draft was posted or thrown away in another browser.",
          true,
        );
      } else if (now !== undefined && now.at !== was?.at) {
        dialog.fields.forEach((f, index) => {
          f.field.text = now.fields[index] ?? "";
        });
        dialog.purpose = { ...dialog.purpose, base: now.base };
        dialog.message = ["Took in a newer draft from another browser."];
      }
    }
    this.#redraw();
  }

  said(text: string, error: boolean): void {
    this.#say(text, error);
  }

  /** Says that saving what the browser remembers failed with `error`. */
  saveFailed(error: unknown): void {
    this.#say(
      `Could not save drafts and what you have read: ${describeFailure(error)}`,
      true,
    );
    this.#redraw();
  }

  /**
   * Finishes the writes under way, saying so while it waits, unless
   * `abandon` settles first, and keeps what is to be remembered; fails
   * naming every write still to settle, which the next run offers to
   * settle.
   */
  async close(abandon: Promise<void>): Promise<void> {
    this.#closing = true;
    // What the mouse held goes, since nothing it held can act now.
    this.#pointer = undefined;
    this.#selecting = undefined;
    const busy = this.#writes.busy;
    if (busy > 0) {
      this.#say(
        `Finishing ${busy} ${busy === 1 ? "write" : "writes"}… ` +
          "Alt-X again leaves them to the next run.",
      );
      this.#redraw();
    }
    const left = await this.#writes.finish(abandon);
    this.#host.save(this.#saved);
    if (left.length > 0) {
      throw new Error(
        "These writes may not have finished; run `deno task -q topics " +
          "browse` again to settle them:\n" +
          left.map((what) => `- ${what}`).join("\n"),
      );
    }
  }

  //
  // Answering the search
  //

  /** Lists the Topics the search asks for, keeping the selection. */
  #answer(): void {
    const chosen = this.#hits[this.#selected]?.topic.number;
    const { hits, hidden } = answer(
      this.#topics,
      parseQuery(this.#search.text),
      {
        unread: (topic) => this.#unread(topic),
        hideSettled: this.#saved.hideSettled,
      },
    );
    const named = parseQuery(this.#search.text).number;
    const pinned = hits[0]?.topic.number === named ? hits.slice(0, 1) : [];
    const rest = hits.slice(pinned.length);
    if (this.#sort === "number") {
      rest.sort((a, b) => Number(b.topic.number) - Number(a.topic.number));
    } else if (this.#sort === "comments") {
      rest.sort((a, b) => present(b.topic).length - present(a.topic).length);
    }
    this.#hits = [...pinned, ...rest];
    this.#hidden = hidden;
    const kept = this.#hits.findIndex((hit) => hit.topic.number === chosen);
    this.#selected = Math.max(0, kept);
  }

  /** Whether `topic` has activity the person has not seen. */
  #unread(topic: Topic): boolean {
    return topic.lastActivityAt >
      Math.max(this.#saved.since, this.#saved.seen[topic.number] ?? 0);
  }

  /** Records that the person has seen `topic` as it stands. */
  #see(topic: Topic): void {
    if (this.#saved.seen[topic.number] === topic.lastActivityAt) return;
    this.#saved.seen[topic.number] = topic.lastActivityAt;
    this.#host.save(this.#saved);
  }

  //
  // Keys
  //

  #key(key: Key): void {
    const name = keyName(key);
    // Quitting works from anywhere; an editor's text is kept as a draft as
    // it is typed.
    if (QUIT.has(name)) return this.#run({ do: "quit" });
    if (this.#menu !== undefined) return this.#menuKey(key);
    const top = this.#dialogs.at(-1);
    if (top !== undefined) return this.#dialogKey(top, key);
    const global: Record<string, Command> = {
      "f10": { do: "menu", index: 0 },
      "f1": { do: "help" },
      "f2": { do: "compose", kind: "comment" },
      "f3": { do: "search" },
      "f4": { do: "compose", kind: "body" },
      "f5": { do: "zoom" },
      "f6": { do: "swap" },
      "alt-left": { do: "back" },
      "alt-right": { do: "forward" },
      "alt-down": { do: "step", by: 1 },
      "alt-up": { do: "step", by: -1 },
      "ctrl-g": { do: "goto" },
      "ctrl-n": { do: "compose", kind: "new" },
      "ctrl-t": { do: "settled" },
      "ctrl-o": { do: "sort" },
      "alt-1": { do: "focus", pane: "list" },
      "alt-2": { do: "focus", pane: "reader" },
    };
    const command = global[name];
    if (command !== undefined) return this.#run(command);
    if (key.alt && key.name.length === 1) {
      const index = MENUS.findIndex((m) =>
        m.hotkey.toLowerCase() === key.name.toLowerCase()
      );
      if (index >= 0) return this.#run({ do: "menu", index });
    }
    if (this.#focus === "list") this.#listKey(key);
    else this.#readerKey(key);
  }

  #listKey(key: Key): void {
    const page = Math.max(1, (this.#rects.get("rows")?.height ?? 10) - 1);
    const move = (to: number) => {
      this.#selected = Math.max(0, Math.min(this.#hits.length - 1, to));
      this.#moved = true;
    };
    switch (key.name) {
      case "up":
        return move(this.#selected - 1);
      case "down":
        return move(this.#selected + 1);
      case "pageup":
        return move(this.#selected - page);
      case "pagedown":
        return move(this.#selected + page);
      // Home and End go to the top and bottom here as in every view that
      // scrolls, but move in a search begun, where Control-Home and
      // Control-End still go to the ends of the list.
      case "home":
        if (key.ctrl || this.#search.text === "") return move(0);
        break;
      case "end":
        if (key.ctrl || this.#search.text === "") {
          return move(this.#hits.length - 1);
        }
        break;
      case "enter": {
        const hit = this.#hits[this.#selected];
        if (hit === undefined) return;
        this.#open(hit.topic.number);
        this.#toReader();
        return;
      }
      case "tab":
        this.#toReader();
        return;
      case "escape":
        if (this.#search.text !== "") this.#filter("");
        return;
    }
    const before = this.#search.text;
    if (this.#search.key(key) && this.#search.text !== before) {
      this.#selected = 0;
      this.#listTop = 0;
      this.#answer();
    }
  }

  #readerKey(key: Key): void {
    const height = this.#rects.get("content")?.height ?? 10;
    const letters: Record<string, Command> = {
      c: { do: "compose", kind: "comment" },
      e: { do: "compose", kind: "body" },
      r: { do: "compose", kind: "title" },
      l: { do: "link" },
      m: { do: "mention" },
      o: { do: "web" },
      y: { do: "copy" },
      n: { do: "unread" },
      "]": { do: "step", by: 1 },
      "[": { do: "step", by: -1 },
      a: { do: "authors" },
      i: { do: "labels" },
      "/": { do: "search" },
    };
    const letter = key.char === undefined
      ? undefined
      : letters[key.char.toLowerCase()];
    if (letter !== undefined && !key.ctrl && !key.alt) {
      return this.#run(letter);
    }
    switch (key.name) {
      case "up":
      case "k":
        return this.#scroll("reader", -1);
      case "down":
      case "j":
        return this.#scroll("reader", 1);
      case "pageup":
        return this.#scroll("reader", -(height - 1));
      case "pagedown":
      case "space":
        return this.#scroll("reader", height - 1);
      case "home":
        this.#readerTop = 0;
        return;
      case "end":
        this.#readerTop = Number.MAX_SAFE_INTEGER;
        return;
      case "tab":
        return this.#step(1);
      case "shift-tab":
        return this.#step(-1);
      case "enter":
        return this.#activate();
      case "backspace":
        return this.#run({ do: "back" });
      case "escape":
        if (this.#target >= 0) this.#target = -1;
        else this.#focus = "list";
        return;
    }
  }

  /**
   * Whether the held pointer is over what it went down on, the same dialog
   * and menu still on top, as the screen last showed it.
   */
  #over(): boolean {
    const pointer = this.#pointer;
    const canvas = this.#canvas;
    if (pointer === undefined || canvas === undefined) return false;
    const { from, at } = pointer;
    return this.#dialogs.at(-1) === pointer.dialog &&
      this.#menu?.index === pointer.menu &&
      doing(canvas.at(from.x, from.y)) === doing(pointer) &&
      canvas.reach(from.x, from.y, doing).has(at.y * canvas.width + at.x);
  }

  /**
   * Whether the pointer is held down on the button running `act` whose
   * row is `y` and which starts at `x`, `label` wide.
   */
  #pressing(act: Command, x: number, y: number, label: string): boolean {
    const from = this.#pointer?.from;
    const pressing = this.#armed && from !== undefined &&
      doing(this.#pointer) === doing({ click: act }) && from.y === y &&
      from.x >= x && from.x <= x + columns(` ${label} `);
    if (pressing) this.#pushed = true;
    return pressing;
  }

  /**
   * Moves the selection of what the pointer is held on to the item at the
   * cell `x`, `y`, when one of the same kind is there.
   */
  #selectAt(x: number, y: number): void {
    const selecting = this.#selecting;
    if (selecting === undefined) return;
    if (selecting.kind === "menu") {
      const item = this.#menuItemAt(x, y);
      if (item !== undefined && this.#menu !== undefined) {
        this.#menu = { ...this.#menu, item };
      }
      return;
    }
    const hit = this.#canvas?.at(x, y).click;
    if (hit?.do === "row" && selecting.kind === "row") {
      this.#selected = hit.index;
      this.#moved = true;
    } else if (hit?.do === "pick" && selecting.kind === "pick") {
      const dialog = this.#dialogs.at(-1);
      if (dialog?.kind === "authors") dialog.selected = hit.index;
    }
  }

  /** Closes the open menu and runs its item `item`. */
  #runMenuItem(item: number): void {
    const menu = this.#menu;
    if (menu === undefined) return;
    const chosen = this.#menus()[menu.index].items[item];
    this.#menu = undefined;
    if (chosen !== undefined && chosen !== "-") this.#run(chosen.act);
  }

  /** The item of the open menu at the cell `x`, `y`, if one is there. */
  #menuItemAt(x: number, y: number): number | undefined {
    const menu = this.#menu;
    const rect = this.#rects.get("menu");
    if (menu === undefined || rect === undefined || !inside(rect, x, y)) {
      return undefined;
    }
    const index = y - rect.y - 1;
    const item = this.#menus()[menu.index].items[index];
    return item === undefined || item === "-" ? undefined : index;
  }

  /** The menus, each item saying what it does now. */
  #menus(): Menu<Command>[] {
    return MENUS.map((menu) => ({
      ...menu,
      items: menu.items.map((item) =>
        item !== "-" && item.act.do === "settled" && this.#saved.hideSettled
          ? { ...item, label: "Show settled topics" }
          : item
      ),
    }));
  }

  #menuKey(key: Key): void {
    const menu = this.#menu;
    if (menu === undefined) return;
    const items = this.#menus()[menu.index].items;
    const step = (by: number) => {
      let item = menu.item;
      do {
        item = (item + by + items.length) % items.length;
      } while (items[item] === "-");
      this.#menu = { ...menu, item };
    };
    const runItem = (item: number) => this.#runMenuItem(item);
    switch (key.name) {
      case "escape":
      case "f10":
        this.#menu = undefined;
        return;
      case "left":
        this.#menu = {
          index: (menu.index + MENUS.length - 1) % MENUS.length,
          item: 0,
        };
        return;
      case "right":
        this.#menu = { index: (menu.index + 1) % MENUS.length, item: 0 };
        return;
      case "up":
        return step(-1);
      case "down":
        return step(1);
      case "enter":
        return runItem(menu.item);
    }
    const char = (key.char ?? key.name).toLowerCase();
    const index = items.findIndex((item) =>
      item !== "-" && item.hotkey?.toLowerCase() === char
    );
    if (index >= 0) runItem(index);
  }

  #dialogKey(dialog: Dialog, key: Key): void {
    if (dialog.kind === "text") {
      const height = this.#rects.get("dialog-content")?.height ?? 10;
      switch (key.name) {
        case "up":
          return this.#scroll("dialog", -1);
        case "down":
          return this.#scroll("dialog", 1);
        case "pageup":
          return this.#scroll("dialog", -(height - 1));
        case "pagedown":
        case "space":
          return this.#scroll("dialog", height - 1);
        case "home":
          dialog.top = 0;
          return;
        case "end":
          dialog.top = Number.MAX_SAFE_INTEGER;
          return;
        case "escape":
        case "enter":
          this.#dialogs.pop();
          return;
      }
      // Its one button, Close, is pressed by its letter too.
      if ((key.char ?? key.name).toLowerCase() === "c" && !key.ctrl) {
        this.#dialogs.pop();
        return;
      }
      return;
    }
    if (dialog.kind === "authors") {
      const letter = key.char?.toLowerCase() ?? key.name;
      if (letter === (dialog.families ? "n" : "f")) {
        return this.#run({ do: "families" });
      }
      if (letter === "c") {
        this.#dialogs.pop();
        return;
      }
      const list = this.#authorList(dialog);
      const height = this.#rects.get("dialog-content")?.height ?? 10;
      const move = (to: number) => {
        dialog.selected = Math.max(0, Math.min(list.length - 1, to));
        if (dialog.selected < dialog.top) dialog.top = dialog.selected;
        if (dialog.selected >= dialog.top + height) {
          dialog.top = dialog.selected - height + 1;
        }
      };
      switch (key.name) {
        case "up":
          return move(dialog.selected - 1);
        case "down":
          return move(dialog.selected + 1);
        case "pageup":
          return move(dialog.selected - height);
        case "pagedown":
          return move(dialog.selected + height);
        case "home":
          return move(0);
        case "end":
          return move(list.length - 1);
        case "enter":
          return this.#run({ do: "pick", index: dialog.selected });
        case "escape":
          this.#dialogs.pop();
          return;
      }
      return;
    }
    const count = dialog.fields.length + dialog.buttons.length;
    const field = dialog.fields[dialog.focus];
    // A button's letter presses it: alone where no field has the keys, and
    // with Alt anywhere.
    const letter = (key.char ?? key.name).toLowerCase();
    const hot = !key.ctrl && (key.alt || field === undefined)
      ? dialog.buttons.find((b) => b.hotkey === letter)
      : undefined;
    if (hot !== undefined) return this.#press(dialog, hot.act);
    switch (key.name) {
      case "escape":
        return this.#press(dialog, "cancel");
      case "tab":
        dialog.focus = (dialog.focus + 1) % count;
        return;
      case "shift-tab":
        dialog.focus = (dialog.focus + count - 1) % count;
        return;
      case "left":
      case "right":
        // The buttons are in a row, which the arrows move along.
        if (field === undefined) {
          dialog.focus = Math.max(
            dialog.fields.length,
            Math.min(count - 1, dialog.focus + (key.name === "left" ? -1 : 1)),
          );
          return;
        }
        break;
      case "ctrl-s":
        return this.#press(dialog, "submit");
      case "enter":
        if (field === undefined) {
          const pressed = dialog.buttons[dialog.focus - dialog.fields.length];
          if (pressed !== undefined) this.#press(dialog, pressed.act);
          return;
        }
        if (!field.multiline) {
          const next = dialog.focus + 1;
          if (next < dialog.fields.length) dialog.focus = next;
          else this.#press(dialog, "submit");
          return;
        }
        break;
    }
    if (field !== undefined && field.field.key(key)) this.#keepDraft(dialog);
  }

  //
  // The mouse
  //

  #mouse(key: Key): void {
    if (key.at !== undefined) {
      const { x, y } = key.at;
      if (key.name === "drag") {
        if (this.#dragging !== undefined) this.#drag(y);
        if (this.#pointer !== undefined) {
          this.#pointer = { ...this.#pointer, at: { x, y } };
        }
        this.#selectAt(x, y);
        return;
      }
      const by = key.name === "wheel-up" ? -WHEEL : WHEEL;
      const top = this.#dialogs.at(-1);
      const field = top?.kind === "form" ? top.fields[top.focus] : undefined;
      if (field?.multiline) {
        // The wheel over an editor moves through its text.
        for (let step = 0; step < Math.abs(by); step++) {
          field.field.key({ name: by < 0 ? "up" : "down" });
        }
        return;
      }
      if (this.#dialogs.length > 0) return this.#scroll("dialog", by);
      for (const pane of ["list", "reader"] as const) {
        if (inside(this.#rects.get(pane) ?? NOWHERE, x, y)) {
          this.#scroll(pane, by);
        }
      }
      return;
    }
    const mouse = key.mouse;
    if (mouse === undefined) return;
    const { x, y } = mouse;
    if (!mouse.down) {
      // A press does what it went down on once released over it, and
      // nothing when the pointer left it first.
      this.#dragging = undefined;
      const selecting = this.#selecting;
      this.#selecting = undefined;
      if (selecting !== undefined) {
        if (selecting.kind === "menu") {
          const item = this.#menuItemAt(x, y);
          if (item !== undefined) this.#runMenuItem(item);
          return;
        }
        // A release on a row runs the row the selection is on, which is
        // the one that shows it, however the rows moved meanwhile.
        const hit = this.#canvas?.at(x, y).click;
        const top = this.#dialogs.at(-1);
        if (
          hit?.do !== selecting.kind || top !== selecting.dialog ||
          this.#menu !== undefined
        ) {
          return;
        }
        if (hit.do === "row") this.#run({ do: "row", index: this.#selected });
        else if (top?.kind === "authors") {
          this.#run({ do: "pick", index: top.selected });
        }
        return;
      }
      if (this.#pointer !== undefined) {
        this.#pointer = { ...this.#pointer, at: { x, y } };
      }
      const held = this.#over() ? this.#pointer : undefined;
      this.#pointer = undefined;
      if (held === undefined) return;
      if (held.click !== undefined) {
        if (
          held.click.do === "menu" && this.#menu?.index === held.click.index
        ) {
          this.#menu = undefined;
          return;
        }
        this.#menu = held.click.do === "menu" ? this.#menu : undefined;
        return this.#run(held.click);
      }
      if (held.href !== undefined) return this.#follow(held.href);
      return;
    }
    // A press starts afresh, whatever became of the last one's release.
    this.#pointer = undefined;
    this.#dragging = undefined;
    this.#selecting = undefined;
    this.#pressedAt = y;
    // On a menu's item, the press moves the menu's selection there.
    if (this.#menuItemAt(x, y) !== undefined) {
      this.#selecting = { kind: "menu", dialog: this.#dialogs.at(-1) };
      this.#selectAt(x, y);
      return;
    }
    const hit = this.#canvas?.at(x, y) ?? {};
    const menuRect = this.#rects.get("menu");
    if (
      this.#menu !== undefined &&
      (menuRect === undefined || !inside(menuRect, x, y))
    ) {
      if (hit.click?.do !== "menu") this.#menu = undefined;
    }
    // With a dialog open, only it and the status line, whose keys are the
    // dialog's, take clicks.
    const dialog = this.#rects.get("dialog");
    const status = y === (this.#canvas?.height ?? 0) - 1;
    if (
      this.#dialogs.length > 0 && dialog !== undefined &&
      !inside(dialog, x, y) && !status
    ) {
      return;
    }
    // Placing a cursor and taking a scroll bar's thumb act at once; the
    // rest waits for the release.
    if (hit.click?.do === "field") return this.#placeIn(hit.click.id, x, y);
    if (hit.click?.do === "thumb") return this.#run(hit.click);
    // On a list's row, the press moves the list's selection there, and the
    // keys with it.
    if (hit.click?.do === "row" || hit.click?.do === "pick") {
      if (hit.click.do === "row") this.#focus = "list";
      this.#selecting = { kind: hit.click.do, dialog: this.#dialogs.at(-1) };
      this.#selectAt(x, y);
      return;
    }
    if (hit.click !== undefined || hit.href !== undefined) {
      this.#pointer = {
        ...hit,
        from: { x, y },
        at: { x, y },
        dialog: this.#dialogs.at(-1),
        menu: this.#menu?.index,
      };
      return;
    }
    if (this.#dialogs.length > 0) return;
    for (const pane of ["list", "reader"] as const) {
      if (inside(this.#rects.get(pane) ?? NOWHERE, x, y)) this.#focus = pane;
    }
  }

  /** Places the cursor of the field `id` where the cell `x`, `y` shows. */
  #placeIn(id: number, x: number, y: number): void {
    const rect = this.#rects.get(`field-${id}`);
    if (rect === undefined) return;
    if (id < 0) {
      this.#focus = "list";
      this.#search.place(x - rect.x, y - rect.y);
      return;
    }
    const dialog = this.#dialogs.at(-1);
    if (dialog?.kind !== "form") return;
    dialog.focus = id;
    dialog.fields[id]?.field.place(x - rect.x, y - rect.y);
  }

  /** Moves a scroll bar's thumb to the row `y`. */
  #drag(y: number): void {
    const dragging = this.#dragging;
    if (dragging === undefined) return;
    const { pane } = dragging;
    const rect = this.#rects.get(`bar-${pane}`);
    const scroll = this.#scrolls.get(pane);
    if (rect === undefined || scroll === undefined) return;
    // The thumb keeps the point the pointer took it by: each row it moves
    // is as many rows of what it scrolls as the track holds of the whole.
    const track = rect.height - 2;
    const thumb = Math.max(
      1,
      Math.round(track * scroll.visible / scroll.total),
    );
    const each = (scroll.total - scroll.visible) / Math.max(1, track - thumb);
    const top = Math.max(
      0,
      Math.min(
        scroll.total - scroll.visible,
        Math.round(dragging.top + (y - dragging.y) * each),
      ),
    );
    if (pane === "list") this.#listTop = top;
    else if (pane === "reader") this.#readerTop = top;
    else {
      const dialog = this.#dialogs.at(-1);
      if (dialog !== undefined && dialog.kind !== "form") dialog.top = top;
    }
  }

  //
  // Commands
  //

  #run(command: Command): void {
    const topic = this.#reading === undefined
      ? undefined
      : this.#byNumber.get(this.#reading);
    switch (command.do) {
      case "quit":
        this.#quit = true;
        return;
      case "help":
        return this.#read("Keys and search", (width) => helpRows(width));
      case "about":
        return this.#read("About", (width) => this.#aboutRows(width));
      case "menu":
        this.#menu = {
          index: command.index,
          item: firstItem(MENUS[command.index]),
        };
        return;
      case "focus":
        this.#focus = command.pane;
        return;
      case "zoom": {
        const pane = command.pane ?? this.#focus;
        this.#zoom = this.#zoom === undefined ? pane : undefined;
        this.#focus = pane;
        return;
      }
      case "swap":
        this.#focus = this.#focus === "list" ? "reader" : "list";
        if (this.#zoom !== undefined) this.#zoom = this.#focus;
        return;
      case "open":
        this.#open(command.number);
        this.#toReader();
        return;
      case "row": {
        this.#selected = command.index;
        this.#focus = "list";
        const hit = this.#hits[command.index];
        if (hit !== undefined) this.#open(hit.topic.number, false);
        return;
      }
      case "back":
      case "forward": {
        const from = command.do === "back" ? this.#back : this.#forward;
        const to = command.do === "back" ? this.#forward : this.#back;
        const number = from.pop();
        if (number === undefined) return;
        if (this.#reading !== undefined) to.push(this.#reading);
        this.#show(number);
        return;
      }
      case "compose":
        return this.#compose(command.kind);
      case "link":
        if (topic === undefined) {
          return this.#say("Open a Topic to link from.", true);
        }
        this.#dialogs.push({
          kind: "form",
          title: `Add a link to top/${topic.number}`,
          purpose: { to: "link", number: topic.number },
          message: [
            "A pull request link is listed among the Topic's pull requests.",
          ],
          fields: [
            { label: "Address", field: new Field(""), multiline: false },
            {
              label: "Label (optional)",
              field: new Field(""),
              multiline: false,
            },
          ],
          buttons: [
            { label: "Add web link", hotkey: "w", act: "submit" },
            { label: "Add PR link", hotkey: "p", act: "alternate" },
            { label: "Cancel", hotkey: "c", act: "cancel" },
          ],
          focus: 0,
        });
        return;
      case "mention":
        if (topic === undefined) {
          return this.#say("Open a Topic to mention from.", true);
        }
        this.#dialogs.push({
          kind: "form",
          title: `top/${topic.number} mentions…`,
          purpose: { to: "mention", number: topic.number },
          message: ["Record that this Topic refers to another, by its number."],
          fields: [{ label: "Topic", field: new Field(""), multiline: false }],
          buttons: [
            { label: "Mention", hotkey: "m", act: "submit" },
            { label: "Cancel", hotkey: "c", act: "cancel" },
          ],
          focus: 0,
        });
        return;
      case "unlink":
        if (topic === undefined) return;
        return this.#confirm(
          `Take back the link to ${command.url}? The link stays recorded as taken back.`,
          ["Take back", "t"],
          ["Keep link", "k"],
          () => {
            // The board may have moved on while the question was asked.
            const now = this.#byNumber.get(topic.number);
            if (now === undefined || !this.#unlinkable(now, command.url)) {
              return this.#say(
                "That link can no longer be taken back from here.",
                true,
              );
            }
            this.#write(
              { verb: "unlink", topic: topic.number, url: command.url },
              undefined,
              () => this.#run(command),
            );
          },
        );
      case "unmention":
        if (topic === undefined) return;
        return this.#confirm(
          `Remove top/${topic.number}'s mention of top/${command.number}?`,
          ["Remove mention", "r"],
          ["Keep it", "k"],
          () => {
            const absent = this.#absent(topic.number);
            if (absent !== undefined) return this.#say(absent, true);
            this.#write(
              {
                verb: "unmention",
                topic: topic.number,
                other: command.number,
              },
              undefined,
              () => this.#run(command),
            );
          },
        );
      case "web": {
        if (topic !== undefined) {
          this.#outside(this.#host.open(this.#board.topicLinks + topic.number));
        }
        return;
      }
      case "copy":
        if (topic === undefined) return;
        this.#outside(
          this.#host.copy(`top/${topic.number}`),
          `Copied top/${topic.number}.`,
        );
        return;
      case "authors":
        this.#dialogs.push({
          kind: "authors",
          selected: 0,
          top: 0,
          families: false,
          tallest: 0,
        });
        return;
      case "labels":
        if (topic === undefined) {
          return this.#say("Open a Topic to see its labels.", true);
        }
        // Read as the board holds it when drawn, which a live change moves.
        return this.#read(`CFC labels of top/${topic.number}`, (width) => {
          const now = this.#byNumber.get(topic.number);
          return now === undefined
            ? wrap(
              [span(`top/${topic.number} is no longer on the board.`)],
              width,
            )
            : labelRows(now, width, this.#fit);
        });
      case "goto":
        this.#dialogs.push({
          kind: "form",
          title: "Go to topic",
          purpose: { to: "goto" },
          message: [],
          fields: [{ label: "Number", field: new Field(""), multiline: false }],
          buttons: [
            { label: "Go", hotkey: "g", act: "submit" },
            { label: "Cancel", hotkey: "c", act: "cancel" },
          ],
          focus: 0,
        });
        return;
      case "search":
        this.#focus = "list";
        if (this.#zoom !== undefined) this.#zoom = "list";
        return;
      case "filter":
        this.#filter(command.query);
        this.#focus = "list";
        return;
      case "settled":
        this.#saved.hideSettled = !this.#saved.hideSettled;
        this.#host.save(this.#saved);
        this.#answer();
        return this.#say(
          this.#saved.hideSettled
            ? "Settled Topics are hidden."
            : "Settled Topics are shown.",
        );
      case "sort":
        this.#sort = SORTS[(SORTS.indexOf(this.#sort) + 1) % SORTS.length];
        this.#answer();
        return;
      case "step": {
        // Where the list stands: at the Topic being read, unless it is not
        // listed or the list's own selection has moved off it, when the
        // selection is where it stands.
        if (this.#hits.length === 0) return this.#say("No Topic is listed.");
        const at = this.#hits.findIndex((hit) =>
          hit.topic.number === this.#reading
        );
        const from = at < 0 || (this.#focus === "list" && at !== this.#selected)
          ? this.#selected
          : at;
        // With nothing open yet, the selection itself is the next.
        const next =
          this.#hits[this.#reading === undefined ? from : from + command.by];
        if (next === undefined) {
          return this.#say(
            `This is the ${command.by > 0 ? "last" : "first"} Topic listed.`,
          );
        }
        return this.#open(next.topic.number, false);
      }
      case "readAll": {
        const unread = this.#topics.filter((topic) => this.#unread(topic));
        if (unread.length === 0) return this.#say("Nothing is unread.");
        return this.#confirm(
          `Mark ${unread.length.toLocaleString("en-US")} unread Topic${
            unread.length === 1 ? "" : "s"
          } as read?`,
          ["Mark read", "m"],
          ["Keep unread", "k"],
          () => {
            for (const topic of unread) {
              this.#saved.seen[topic.number] = Math.max(
                this.#saved.seen[topic.number] ?? 0,
                topic.lastActivityAt,
              );
            }
            this.#host.save(this.#saved);
            this.#say("Everything is read.");
          },
        );
      }
      case "unread": {
        // The next unread Topic the list shows, else the most recently
        // active of any.
        const wanted = (t: Topic) =>
          this.#unread(t) && t.number !== this.#reading;
        const next = this.#hits.find(({ topic }) => wanted(topic))?.topic ??
          this.#topics.filter(wanted).sort((a, b) =>
            b.lastActivityAt - a.lastActivityAt
          )[0];
        if (next === undefined) return this.#say("Nothing is unread.");
        this.#open(next.number);
        return;
      }
      case "scroll":
        return this.#scroll(command.pane, command.by);
      case "thumb":
        this.#dragging = {
          pane: command.pane,
          y: this.#pressedAt,
          top: this.#scrolls.get(command.pane)?.top ?? 0,
        };
        return;
      case "field":
        return;
      case "button": {
        const dialog = this.#dialogs.at(-1);
        if (dialog?.kind !== "form") {
          this.#dialogs.pop();
          return;
        }
        const pressed = dialog.buttons[command.index];
        if (pressed !== undefined) this.#press(dialog, pressed.act);
        return;
      }
      case "next": {
        const dialog = this.#dialogs.at(-1);
        if (dialog?.kind === "form") {
          dialog.focus = (dialog.focus + 1) %
            (dialog.fields.length + dialog.buttons.length);
        }
        return;
      }
      case "unfinished":
        return this.#unfinished();
      case "close": {
        const dialog = this.#dialogs.at(-1);
        if (dialog?.kind === "form") this.#press(dialog, "cancel");
        else this.#dialogs.pop();
        return;
      }
      case "pick": {
        const dialog = this.#dialogs.at(-1);
        if (dialog?.kind !== "authors") return;
        const author = this.#authorList(dialog)[command.index];
        this.#dialogs.pop();
        if (author !== undefined) {
          this.#run({
            do: "filter",
            query: byQuery(author.name, dialog.families),
          });
        }
        return;
      }
      case "families": {
        const dialog = this.#dialogs.at(-1);
        if (dialog?.kind !== "authors") return;
        dialog.families = !dialog.families;
        dialog.selected = 0;
        dialog.top = 0;
        return;
      }
    }
  }

  /** Sets the search to `query`. */
  #filter(query: string): void {
    this.#search.text = query;
    this.#selected = 0;
    this.#listTop = 0;
    this.#answer();
  }

  /** Opens Topic `number` in the reader, recording where it came from. */
  #open(number: string, focus = true): void {
    if (number === this.#reading) return;
    if (!this.#byNumber.has(number)) return;
    if (this.#reading !== undefined) this.#back.push(this.#reading);
    this.#forward = [];
    this.#show(number);
    if (focus) this.#toReader();
  }

  /** Gives the reader the keys, and the screen when the list has it. */
  #toReader(): void {
    this.#focus = "reader";
    if (this.#zoom === "list") this.#zoom = "reader";
  }

  /** Shows Topic `number` in the reader from its top. */
  #show(number: string): void {
    const topic = this.#byNumber.get(number);
    if (topic === undefined) return;
    this.#reading = number;
    this.#readerTop = 0;
    this.#target = -1;
    this.#newSince = Math.max(this.#saved.since, this.#saved.seen[number] ?? 0);
    this.#content = undefined;
    const index = this.#hits.findIndex((hit) => hit.topic.number === number);
    if (index >= 0) {
      this.#selected = index;
      this.#moved = true;
    }
  }

  /** Follows the link `href`: a Topic of the board opens here. */
  #follow(href: string): void {
    if (href.startsWith(this.#board.topicLinks)) {
      const number = href.slice(this.#board.topicLinks.length);
      if (this.#byNumber.has(number)) {
        return this.#run({ do: "open", number });
      }
    }
    if (linkable(href)) this.#outside(this.#host.open(href));
  }

  /**
   * Waits for `done`, something done outside the browser, saying `report`
   * once it is done or what went wrong when it fails.
   */
  #outside(done: Promise<void>, report?: string): void {
    done.then(
      () => {
        if (report !== undefined) this.#say(report);
      },
      (error) => {
        this.#say(describeFailure(error), true);
      },
    ).finally(this.#redraw);
  }

  /**
   * `top` for `pane`, no further down than where it shows its last row at
   * the bottom, as last drawn: End goes past it, and a frame draws it back.
   */
  #clamped(pane: Pane | "dialog", top: number): number {
    const scroll = this.#scrolls.get(pane);
    return scroll === undefined
      ? top
      : Math.min(top, Math.max(0, scroll.total - scroll.visible));
  }

  #scroll(pane: Pane | "dialog", by: number): void {
    // A scroll after End counts from the bottom, though no frame drew it.
    if (pane === "reader") {
      this.#readerTop = Math.max(0, this.#clamped(pane, this.#readerTop) + by);
      return;
    }
    if (pane === "list") {
      this.#listTop = Math.max(0, this.#clamped(pane, this.#listTop) + by);
      return;
    }
    const dialog = this.#dialogs.at(-1);
    if (dialog !== undefined && dialog.kind !== "form") {
      dialog.top = Math.max(0, this.#clamped(pane, dialog.top) + by);
    }
  }

  /** Moves the reader's focus `by` links, scrolling it into view. */
  #step(by: number): void {
    const targets = this.#targets();
    if (targets.length === 0) return;
    this.#target = this.#target < 0
      ? (by > 0 ? 0 : targets.length - 1)
      : (this.#target + by + targets.length) % targets.length;
    const row = targets[this.#target].row;
    const height = this.#rects.get("content")?.height ?? 10;
    if (row < this.#readerTop) this.#readerTop = row;
    if (row >= this.#readerTop + height) this.#readerTop = row - height + 1;
  }

  /** Follows or runs the reader's focused link. */
  #activate(): void {
    const target = this.#targets()[this.#target];
    if (target === undefined) return;
    if (target.span.click !== undefined) this.#run(target.span.click);
    else if (target.span.href !== undefined) {
      this.#follow(target.span.href);
    }
  }

  /**
   * The reader's links and buttons, in order: each run of spans doing the
   * same thing counts once, by its first span.
   */
  #targets(): { row: number; index: number; span: Span<Command> }[] {
    const topic = this.#reading === undefined
      ? undefined
      : this.#byNumber.get(this.#reading);
    const width = this.#rects.get("content")?.width;
    const rows = topic === undefined || width === undefined
      ? []
      : this.#readerRows(topic, width, this.#now());
    return rows.flatMap((row, at) =>
      row.flatMap((s, index) =>
        (s.click !== undefined || s.href !== undefined) &&
          doing(s) !== doing(row[index - 1])
          ? [{ row: at, index, span: s }]
          : []
      )
    );
  }

  /**
   * Opens the Topic named when the browser started once the board holds
   * it, saying so once the board is `live` and does not.
   */
  #openNamed(live: boolean): void {
    const opening = this.#opening;
    if (opening === undefined) return;
    let opened: Topic | undefined;
    try {
      opened = opening.find(this.#topics);
    } catch (error) {
      this.#opening = undefined;
      return this.#say(describeFailure(error), true);
    }
    if (opened !== undefined) {
      this.#opening = undefined;
      this.#show(opened.number);
      this.#toReader();
    } else if (live) {
      this.#opening = undefined;
      this.#say(`The board has no Topic ${opening.name}.`, true);
    }
  }

  /** Shows `text` in the status line. */
  #say(text: string, error = false): void {
    this.#note = { text, at: this.#now(), error };
  }

  /** Opens a dialog of text to read. */
  #read(title: string, rows: (width: number) => Row<Command>[]): void {
    this.#dialogs.push({ kind: "text", title, rows, top: 0, tallest: 0 });
  }

  /**
   * Asks `question`, its buttons saying in a few words what doing it and
   * not doing it do, each with the letter that presses it, and runs `then`
   * once it is done.
   */
  #confirm(
    question: string,
    [proceed, proceedKey]: [string, string],
    [refrain, refrainKey]: [string, string],
    then: () => void,
  ): void {
    this.#dialogs.push({
      kind: "form",
      title: "Are you sure?",
      purpose: { to: "confirm", then },
      message: [question],
      fields: [],
      buttons: [
        { label: proceed, hotkey: proceedKey, act: "submit" },
        { label: refrain, hotkey: refrainKey, act: "cancel" },
      ],
      focus: 1,
    });
  }

  #allAuthors(): Author[] {
    this.#authors ??= authors(this.#topics);
    return this.#authors;
  }

  /** The authors the dialog `dialog` lists, or their families. */
  #authorList(dialog: Authors): Author[] {
    return dialog.families ? families(this.#allAuthors()) : this.#allAuthors();
  }

  //
  // Writing
  //

  /** Opens the editor for `kind`, resuming its draft when there is one. */
  #compose(kind: ComposeKind): void {
    const topic = this.#reading === undefined
      ? undefined
      : this.#byNumber.get(this.#reading);
    if (kind !== "new" && topic === undefined) {
      return this.#say("Open a Topic first.", true);
    }
    if (
      (kind === "body" || kind === "title") && !this.#fits(topic?.labels)
    ) {
      return this.#say("This Topic is withheld from this display.", true);
    }
    const key = draftKey(kind, topic?.number);
    const writing = this.#writes.pendingFor(key);
    if (writing !== undefined) {
      const [invocation, pending] = writing;
      if (!this.#writes.inFlight(invocation)) {
        return this.#unfinished(invocation);
      }
      return this.#say(`Still ${describe(pending.request)}.`, true);
    }
    const draft = this.#writes.draft(key);
    const server = kind === "body"
      ? topic?.body ?? ""
      : kind === "title"
      ? topic?.title ?? ""
      : "";
    const texts = draft?.fields ??
      (kind === "new" ? ["", ""] : kind === "comment" ? [""] : [server]);
    const fields = kind === "new"
      ? [
        { label: "Title", field: new Field(texts[0] ?? ""), multiline: false },
        {
          label: "Body (Markdown)",
          field: new Field(texts[1] ?? "", true),
          multiline: true,
        },
      ]
      : kind === "title"
      ? [{ label: "Title", field: new Field(texts[0] ?? ""), multiline: false }]
      : [{
        label: kind === "comment" ? "Comment (Markdown)" : "Body (Markdown)",
        field: new Field(texts[0] ?? "", true),
        multiline: true,
      }];
    const where = topic === undefined ? "" : ` top/${topic.number}`;
    const titles: Record<ComposeKind, string> = {
      comment: `Comment on${where}`,
      body: `Edit the body of${where}`,
      title: `Rename${where}`,
      new: "File a new topic",
    };
    this.#dialogs.push({
      kind: "form",
      title: titles[kind],
      // A body or a title remembers what it began from, so that a change
      // the board makes meanwhile is noticed.
      purpose: {
        to: "compose",
        kind,
        number: topic?.number,
        base: draft?.base ?? server,
      },
      message: draft === undefined ? [] : ["Resumed your draft."],
      fields,
      buttons: [
        kind === "new"
          ? { label: "File", hotkey: "i", act: "submit" }
          : kind === "comment"
          ? { label: "Post", hotkey: "p", act: "submit" }
          : { label: "Save", hotkey: "s", act: "submit" },
        { label: "Close", hotkey: "c", act: "cancel" },
        // Not D, nor F for File, which an editor takes, with Alt, to
        // delete a word and move by one.
        { label: "Discard", hotkey: "a", act: "discard" },
        ...(kind === "body" || kind === "title"
          ? [{ label: "Theirs", hotkey: "t", act: "theirs" as const }]
          : []),
      ],
      focus: 0,
    });
  }

  /**
   * Keeps the text of `dialog`'s fields as its draft, once it says
   * something other than the draft, or what the editor began with.
   */
  #keepDraft(dialog: Dialog | undefined): void {
    if (dialog?.kind !== "form" || dialog.purpose.to !== "compose") return;
    const { kind, number, base } = dialog.purpose;
    const key = draftKey(kind, number);
    const fields = dialog.fields.map((f) => f.field.text);
    const kept = this.#writes.draft(key)?.fields ??
      fields.map(() => kind === "body" || kind === "title" ? base : "");
    if (fields.every((text, index) => text === kept[index])) return;
    this.#writes.keepDraft(key, fields, base);
  }

  /**
   * Whether `unlink` of `url` on `topic` takes back `link`, or any link
   * this display shows: the newest present link to that address, with no
   * withheld link after it, whose address this display cannot know.
   */
  #unlinkable(topic: Topic, url: string, link?: TopicLink): boolean {
    const present = topic.links.filter((l) => !l.removed);
    const newest = present.findLast((l) => l.url === url);
    const hidden = present.findLastIndex((l) => !this.#fits(l.labels));
    return newest !== undefined && (link === undefined || newest === link) &&
      present.indexOf(newest) > hidden;
  }

  /** Why Topic `number` cannot be written to, when it is gone. */
  #absent(number: string): string | undefined {
    return this.#byNumber.has(number)
      ? undefined
      : `top/${number} is no longer on the board.`;
  }

  /** What pressing `act` in the form `dialog` does. */
  #press(dialog: Form, act: FormButton["act"]): void {
    // Pressed again once a question is answered, it may have closed since.
    if (!this.#dialogs.includes(dialog)) return;
    const purpose = dialog.purpose;
    const again = () => this.#press(dialog, act);
    const text = (index: number) => dialog.fields[index]?.field.text ?? "";
    const close = () => {
      this.#dialogs = this.#dialogs.filter((d) => d !== dialog);
    };
    if (act === "cancel") {
      close();
      if (purpose.to === "compose") this.#closeDraft(purpose);
      return;
    }
    if (act === "discard" && purpose.to === "compose") {
      return this.#confirm(
        "Throw this draft away?",
        ["Throw away", "t"],
        ["Keep draft", "k"],
        () => {
          this.#writes.dropDraft(draftKey(purpose.kind, purpose.number));
          close();
        },
      );
    }
    if (act === "theirs" && purpose.to === "compose") {
      const number = purpose.number ?? "";
      const absent = this.#absent(number);
      if (absent !== undefined) return this.#say(absent, true);
      // Read as the board holds it when drawn, which a live change moves.
      return this.#read(`What top/${number} holds now`, (width) => {
        const topic = this.#byNumber.get(number);
        const theirs = !this.#fits(topic?.labels)
          ? "*Withheld from this display.*"
          : purpose.kind === "title"
          ? topic?.title ?? ""
          : topic?.body ?? "";
        return prose(theirs, width, (n) => this.#board.topicLinks + n);
      });
    }
    if (act === "forget" && purpose.to === "unfinished") {
      return this.#confirm(
        "Forget this write? It may or may not have landed, and its text " +
          "goes with it.",
        ["Forget write", "f"],
        ["Keep it", "k"],
        () => {
          this.#writes.forget(purpose.invocation);
          close();
        },
      );
    }
    switch (purpose.to) {
      case "compose": {
        const kind = purpose.kind;
        const key = draftKey(kind, purpose.number);
        // Another browser may be writing it, or have written it.
        const writing = this.#writes.pendingFor(key);
        if (writing !== undefined) {
          return this.#say(`Already ${describe(writing[1].request)}.`, true);
        }
        if (kind === "new") {
          if (text(0).trim() === "" || text(1).trim() === "") {
            return this.#say("A topic needs a title and a body.", true);
          }
          if (
            this.#write(
              { verb: "new", title: text(0), body: text(1) },
              key,
              again,
            )
          ) {
            close();
          }
          return;
        }
        const absent = this.#absent(purpose.number ?? "");
        if (absent !== undefined) return this.#say(absent, true);
        const topic = this.#byNumber.get(purpose.number ?? "");
        if (topic === undefined) return;
        if (kind !== "comment" && !this.#fits(topic.labels)) {
          return this.#say(
            `top/${topic.number} is withheld from this display now.`,
            true,
          );
        }
        if (text(0).trim() === "") {
          return this.#say("There is nothing to save.", true);
        }
        const request: WriteRequest = {
          verb: kind,
          topic: topic.number,
          text: text(0),
        };
        const current = kind === "title"
          ? topic.title
          : kind === "body"
          ? topic.body
          : "";
        const base = purpose.base;
        if (kind !== "comment" && base !== current) {
          // Once answered, everything is asked again of the board as it
          // stands then, now taken as what the edit began from.
          return this.#confirm(
            `Someone changed the ${kind} of top/${topic.number} after you ` +
              "began. Replace their version with yours?",
            ["Replace theirs", "r"],
            ["Keep editing", "k"],
            () => {
              dialog.purpose = { ...purpose, base: current };
              again();
            },
          );
        }
        if (this.#write(request, key, again)) close();
        return;
      }
      case "link": {
        if (text(0).trim() === "") {
          return this.#say("A link needs an address.", true);
        }
        const request: WriteRequest = {
          verb: "link",
          topic: purpose.number,
          url: text(0).trim(),
          label: text(1),
          kind: act === "alternate" ? "pr" : "web",
        };
        if (this.#write(request, undefined, again)) close();
        return;
      }
      case "mention": {
        const other = /(\d+)\s*$/.exec(text(0))?.[1];
        if (other === undefined || !this.#byNumber.has(other)) {
          return this.#say("Name a Topic on the board by its number.", true);
        }
        const request: WriteRequest = {
          verb: "mention",
          topic: purpose.number,
          other,
        };
        if (this.#write(request, undefined, again)) close();
        return;
      }
      case "goto": {
        const number = /(\d+)\s*$/.exec(text(0))?.[1];
        if (number === undefined || !this.#byNumber.has(number)) {
          return this.#say("The board has no such Topic.", true);
        }
        close();
        return this.#run({ do: "open", number });
      }
      case "agent": {
        const name = text(0).trim();
        if (name === "") {
          return this.#say("Writes are signed with a name.", true);
        }
        this.#saved.agentName = name;
        this.#host.save(this.#saved);
        close();
        return purpose.then();
      }
      case "confirm":
        close();
        return purpose.then();
      case "unfinished":
        close();
        return this.#writes.send(purpose.invocation);
    }
  }

  /**
   * Keeps the draft of an editor that closed without saving, unless it
   * says nothing beyond what it began from.
   */
  #closeDraft(purpose: Extract<Purpose, { to: "compose" }>): void {
    const key = draftKey(purpose.kind, purpose.number);
    const draft = this.#writes.draft(key);
    if (draft === undefined) return;
    if (draft.fields.every((text) => text === draft.base || text === "")) {
      this.#writes.dropDraft(key);
      return;
    }
    this.#say("Your draft is kept; open the editor again to finish it.");
  }

  /**
   * Makes `request`, signed with the person's name, asked for first when
   * there is none, saving the draft `key` names.
   */
  #write(
    request: WriteRequest,
    key: string | undefined,
    again: () => void,
  ): boolean {
    const agentName = this.#saved.agentName;
    if (agentName === undefined) {
      this.#dialogs.push({
        kind: "form",
        title: "Sign your writes",
        purpose: { to: "agent", then: again },
        message: [
          "Every write to the board is signed with a name, as the agent or " +
          "person making it. It is remembered for later writes.",
        ],
        fields: [{ label: "Name", field: new Field(""), multiline: false }],
        buttons: [
          { label: "Sign", hotkey: "s", act: "submit" },
          { label: "Cancel", hotkey: "c", act: "cancel" },
        ],
        focus: 0,
      });
      return false;
    }
    this.#writes.write(request, agentName, key);
    return true;
  }

  /** Tells the person how a write goes. */
  #told(told: Told): void {
    if (told.kind === "note") {
      this.#say(told.text, told.error);
    } else {
      this.#say(told.text, true);
      if (this.#dialogs.length === 0 && !this.#closing) {
        this.#unfinished(told.invocation);
      }
    }
    this.#redraw();
  }

  /**
   * Opens the dialog settling the unfinished write `invocation` names, or
   * the first one not under way.
   */
  #unfinished(invocation?: string): void {
    const [chosen, pending] =
      (invocation === undefined
        ? this.#writes.pending().find(([id]) => !this.#writes.inFlight(id))
        : this.#writes.pending().find(([id]) => id === invocation)) ?? [];
    if (chosen === undefined || pending === undefined) {
      return this.#say("No write is unfinished.");
    }
    const text = pending.draft?.fields.join("\n").trim() ?? "";
    this.#dialogs.push({
      kind: "form",
      title: "An unfinished write",
      purpose: { to: "unfinished", invocation: chosen },
      message: [
        `${capitalize(describe(pending.request))} may or may not have landed:`,
        pending.failure === undefined
          ? "a browser made it and stopped, or is making it still."
          : firstLine(pending.failure),
        "Settling it finishes it without writing it twice.",
        ...(text === "" ? [] : ["", ...text.split("\n")]),
      ],
      fields: [],
      buttons: [
        { label: "Settle it", hotkey: "s", act: "submit" },
        { label: "Later", hotkey: "l", act: "cancel" },
        { label: "Forget it", hotkey: "f", act: "forget" },
      ],
      focus: 1,
    });
  }

  //
  // Drawing
  //

  #drawWindows(canvas: Canvas<Command>, now: number): void {
    const top = 1;
    const height = canvas.height - 2;
    const narrow = canvas.width < 100;
    const zoomed = this.#zoom ?? (narrow ? this.#focus : undefined);
    const listWidth = zoomed !== undefined
      ? canvas.width
      : Math.max(40, Math.min(72, Math.round(canvas.width * 0.38)));
    const list = { x: 0, y: top, width: listWidth, height };
    const reader = zoomed !== undefined
      ? { x: 0, y: top, width: canvas.width, height }
      : { x: listWidth, y: top, width: canvas.width - listWidth, height };
    if (zoomed !== "reader") {
      this.#drawList(canvas, list, now, zoomed !== undefined);
    }
    if (zoomed !== "list") {
      this.#drawReader(canvas, reader, now, zoomed !== undefined);
    }
  }

  #drawList(
    canvas: Canvas<Command>,
    rect: Rect,
    now: number,
    zoomed: boolean,
  ): void {
    const active = this.#focus === "list" && this.#dialogs.length === 0;
    this.#rects.set("list", rect);
    canvas.fill(rect, " ", { bg: C.editorBg }, { do: "focus", pane: "list" });
    frame(canvas, rect, {
      title: "Topics",
      active,
      bg: C.editorBg,
      number: 1,
      zoom: { zoomed, act: { do: "zoom", pane: "list" } },
      focus: { do: "focus", pane: "list" },
    });
    const x = rect.x + 2;
    const width = rect.width - 4;
    // The search field.
    const label = " Find ";
    canvas.put(
      x,
      rect.y + 1,
      [span(label, { fg: C.cyan, bold: true })],
      columns(label),
    );
    const fieldX = x + columns(label);
    const fieldWidth = width - columns(label);
    this.#rects.set("field--1", {
      x: fieldX,
      y: rect.y + 1,
      width: fieldWidth,
      height: 1,
    });
    const fieldRow = this.#search.draw(
      fieldWidth,
      1,
      { bg: C.panelHi, fg: C.fgBright },
      active ? { bg: C.fgBright, fg: C.ink } : undefined,
    )[0].map((s) => ({
      ...s,
      click: { do: "field", id: -1 } satisfies Command,
    }));
    canvas.put(fieldX, rect.y + 1, fieldRow, fieldWidth);
    if (this.#search.text === "") {
      canvas.put(
        fieldX + 1,
        rect.y + 1,
        [{
          ...span("words, by:name, is:unread, #42", {
            bg: C.panelHi,
            fg: C.fgDim,
          }),
          click: { do: "field", id: -1 },
        }],
        fieldWidth - 1,
      );
    }
    // The chips.
    const chip = (text: string, act: Command): Span<Command> => ({
      ...span(text, { fg: C.fg, bg: C.editorBg }),
      click: act,
    });
    const count = (n: number) => n.toLocaleString("en-US");
    const left: Row<Command> = [
      chip(this.#saved.hideSettled ? "[■] open only" : "[ ] open only", {
        do: "settled",
      }),
      span("  "),
      chip(`↕ ${this.#sort}`, { do: "sort" }),
    ];
    const right: Row<Command> = [
      span(`${count(this.#hits.length)}/${count(this.#topics.length)}`, {
        fg: C.fgDim,
      }),
      ...(this.#hidden > 0 && this.#saved.hideSettled
        ? [{
          ...span(` +${count(this.#hidden)}`, { fg: C.fgDim }),
          click: { do: "settled" } satisfies Command,
        }]
        : []),
    ];
    const rightWidth = columns(right.map((s) => s.text).join(""));
    canvas.put(x, rect.y + 2, left, width - rightWidth);
    canvas.put(x + width - rightWidth, rect.y + 2, right, rightWidth);
    canvas.put(
      x,
      rect.y + 3,
      [span("─".repeat(width), { fg: C.panelHi })],
      width,
    );
    // The rows.
    const rows = {
      x: rect.x + 1,
      y: rect.y + 4,
      width: rect.width - 2,
      height: rect.height - 5,
    };
    this.#rects.set("rows", rows);
    // The list follows the selection when it moves, and is otherwise
    // left where the wheel or the scroll bar put it.
    if (this.#moved) {
      this.#moved = false;
      if (this.#selected < this.#listTop) this.#listTop = this.#selected;
      if (this.#selected >= this.#listTop + rows.height) {
        this.#listTop = this.#selected - rows.height + 1;
      }
    }
    this.#listTop = Math.max(
      0,
      Math.min(this.#listTop, this.#hits.length - rows.height),
    );
    const terms = parseQuery(this.#search.text).terms;
    for (let row = 0; row < rows.height; row++) {
      const index = this.#listTop + row;
      const hit = this.#hits[index];
      if (hit === undefined) {
        if (index === 0) {
          canvas.put(rows.x, rows.y, [
            span(
              center(
                this.#topics.length === 0
                  ? "Reading the board…"
                  : "No Topic matches.",
                rows.width,
              ),
              { fg: C.fgDim },
            ),
          ], rows.width);
        }
        continue;
      }
      canvas.put(
        rows.x,
        rows.y + row,
        this.#listRow(hit.topic, index, rows.width, terms, now, active),
        rows.width,
      );
    }
    const scroll = {
      total: this.#hits.length,
      top: this.#listTop,
      visible: rows.height,
    };
    this.#scrolls.set("list", scroll);
    this.#rects.set("bar-list", {
      x: rect.x + rect.width - 1,
      y: rows.y,
      width: 1,
      height: rows.height,
    });
    scrollBar(canvas, rect.x + rect.width - 1, rows.y, rows.height, scroll, {
      up: { do: "scroll", pane: "list", by: -1 },
      down: { do: "scroll", pane: "list", by: 1 },
      pageUp: { do: "scroll", pane: "list", by: -rows.height },
      pageDown: { do: "scroll", pane: "list", by: rows.height },
      thumb: { do: "thumb", pane: "list" },
    }, C.editorBg);
  }

  /** One row of the list. */
  #listRow(
    topic: Topic,
    index: number,
    width: number,
    terms: readonly RegExp[],
    now: number,
    active: boolean,
  ): Row<Command> {
    const click: Command = { do: "row", index };
    const touched = this.#touched.get(topic.number);
    const glow = touched === undefined ? 0 : fade(now - touched.at, GLOW_MS);
    const picked = index === this.#selected;
    const base = picked
      ? (active ? mix(C.editorBg, C.blue, 0.35) : C.selectionBg)
      : topic.number === this.#reading
      ? C.selectionBg
      : C.editorBg;
    const bg = glow > 0 && touched?.color !== undefined
      ? mix(base, darken(touched.color, 0.4), glow)
      : base;
    const unread = this.#unread(topic);
    const drafted = Object.keys(this.#saved.drafts).some((key) =>
      key.endsWith(`:${topic.number}`)
    );
    const mark = drafted
      ? span("✎", { fg: C.orange, bg })
      : unread
      ? span("●", { fg: C.blue, bg })
      : span(" ", { bg });
    const restricted = marked(topic.labels);
    const shown = this.#fits(topic.labels);
    const count = present(topic).length;
    const when = day(topic.lastActivityAt, now);
    const tail = `${when} ${count === 0 ? "   " : String(count).padStart(3)}`;
    const numberText = topic.number.padStart(5);
    const titleWidth = Math.max(4, width - 2 - 6 - 2 - columns(tail) - 1);
    const dim = settled(topic);
    const titleStyle: Style = {
      bg,
      fg: dim ? C.fgDim : unread || picked ? C.fgBright : C.fg,
      bold: unread,
    };
    const title = shown
      ? highlight(clip(topic.title, titleWidth), terms, titleStyle)
      : [span("withheld from this display", { ...titleStyle, italic: true })];
    return [
      { ...mark, click },
      { ...span(restricted ? "◈" : " ", { fg: C.purple, bg }), click },
      {
        ...span(numberText, {
          fg: picked ? C.yellow : darken(C.yellow, 0.75),
          bg,
          bold: picked,
        }),
        click,
      },
      { ...span(" ", { bg }), click },
      ...title.map((s) => ({ ...s, click })),
      {
        ...span(
          " ".repeat(Math.max(
            1,
            titleWidth - columns(title.map((s) => s.text).join("")) + 1,
          )),
          { bg },
        ),
        click,
      },
      { ...span(tail, { fg: C.fgDim, bg }), click },
      { ...span(" ".repeat(width), { bg }), click },
    ];
  }

  #drawReader(
    canvas: Canvas<Command>,
    rect: Rect,
    now: number,
    zoomed: boolean,
  ): void {
    const active = this.#focus === "reader" && this.#dialogs.length === 0;
    this.#rects.set("reader", rect);
    canvas.fill(rect, " ", { bg: C.editorBg }, { do: "focus", pane: "reader" });
    const topic = this.#reading === undefined
      ? undefined
      : this.#byNumber.get(this.#reading);
    // A Topic is read once the reader shows it, as it stands.
    if (topic !== undefined) this.#see(topic);
    frame(canvas, rect, {
      title: topic === undefined ? "Reader" : `top/${topic.number}`,
      active,
      bg: C.editorBg,
      number: 2,
      zoom: { zoomed, act: { do: "zoom", pane: "reader" } },
      focus: { do: "focus", pane: "reader" },
    });
    const navStyle = (enabled: boolean): Style => ({
      bg: C.editorBg,
      fg: enabled ? C.cyan : C.panelHi,
      bold: enabled,
    });
    canvas.put(rect.x + 2, rect.y, [
      { ...span(" ◄", navStyle(this.#back.length > 0)), click: { do: "back" } },
      {
        ...span(" ► ", navStyle(this.#forward.length > 0)),
        click: { do: "forward" },
      },
    ], 6);
    const content = {
      x: rect.x + 2,
      y: rect.y + 1,
      width: rect.width - 5,
      height: rect.height - 2,
    };
    this.#rects.set("content", content);
    if (topic === undefined) {
      const lines = [
        "Pick a Topic from the list to read it here.",
        "",
        "F3 searches · F1 lists every key · F10 opens the menus",
      ];
      lines.forEach((line, index) =>
        canvas.put(
          content.x,
          content.y + Math.floor(content.height / 2) - 1 + index,
          [
            span(center(line, content.width), { fg: C.fgDim }),
          ],
          content.width,
        )
      );
      return;
    }
    const rows = this.#readerRows(topic, content.width, now);
    const maxTop = Math.max(0, rows.length - content.height);
    this.#readerTop = Math.min(this.#readerTop, maxTop);
    const targets = this.#targets();
    const focused = active ? targets[this.#target] : undefined;
    for (let row = 0; row < content.height; row++) {
      const at = this.#readerTop + row;
      const line = rows[at];
      if (line === undefined) break;
      const shown = focused?.row === at
        ? line.map((s, index) =>
          index === focused.index
            ? { ...s, style: { ...s.style, bg: C.fgBright, fg: C.ink } }
            : s
        )
        : line;
      canvas.put(content.x, content.y + row, shown, content.width);
    }
    const scroll = {
      total: rows.length,
      top: this.#readerTop,
      visible: content.height,
    };
    this.#scrolls.set("reader", scroll);
    this.#rects.set("bar-reader", {
      x: rect.x + rect.width - 1,
      y: content.y,
      width: 1,
      height: content.height,
    });
    scrollBar(
      canvas,
      rect.x + rect.width - 1,
      content.y,
      content.height,
      scroll,
      {
        up: { do: "scroll", pane: "reader", by: -1 },
        down: { do: "scroll", pane: "reader", by: 1 },
        pageUp: { do: "scroll", pane: "reader", by: -content.height },
        pageDown: { do: "scroll", pane: "reader", by: content.height },
        thumb: { do: "thumb", pane: "reader" },
      },
      C.editorBg,
    );
  }

  /** The reader's content for `topic`, `width` columns wide. */
  #readerRows(topic: Topic, width: number, now: number): Row<Command>[] {
    const key = [
      topic,
      width,
      this.#newSince,
      this.#refs,
      Object.keys(this.#saved.drafts).length,
      // What the reader says of times, such as `active 5m ago`, moves on
      // by the minute.
      Math.floor(now / 60_000),
    ];
    const cached = this.#content;
    if (
      cached !== undefined &&
      cached.key.every((part, index) => part === key[index])
    ) {
      return cached.rows;
    }
    const rows = this.#layOut(topic, width, now);
    this.#content = { key, rows };
    return rows;
  }

  #layOut(topic: Topic, width: number, now: number): Row<Command>[] {
    const rows: Row<Command>[] = [];
    const links = (number: string) => this.#board.topicLinks + number;
    const push = (more: readonly Row<Command>[]) => {
      for (const row of more) rows.push(row);
    };
    const heading = (text: string) => {
      rows.push([]);
      rows.push([
        span("── ", { fg: C.panelHi }),
        span(text, { fg: C.cyan, bold: true }),
        span(` ${"─".repeat(Math.max(0, width - columns(text) - 4))}`, {
          fg: C.panelHi,
        }),
      ]);
    };
    const topicLine = (
      mark: string,
      other: Topic,
      extra: Row<Command> = [],
    ): Row<Command> => {
      const open: Command = { do: "open", number: other.number };
      const room = width - columns(`${mark} top/${other.number}  `) -
        columns(extra.map((s) => s.text).join(""));
      return [
        { ...span(`${mark} `, { fg: C.fgDim }), click: open },
        {
          ...span(`top/${other.number}`, CITATION_STYLE, links(other.number)),
          click: open,
        },
        { ...span("  "), click: open },
        {
          ...(this.#fits(other.labels)
            ? span(clip(other.title, Math.max(8, room)), {
              fg: settled(other) ? C.fgDim : C.fg,
            })
            : span("withheld", { fg: C.purple, italic: true })),
          click: open,
        },
        ...extra,
      ];
    };
    // The title and what is known of the Topic.
    const shown = this.#fits(topic.labels);
    push(wrap([
      span(`top/${topic.number}  `, { ...CITATION_STYLE }, links(topic.number)),
      shown
        ? span(topic.title, { fg: C.fgBright, bold: true })
        : span("withheld from this display", { fg: C.purple, italic: true }),
    ], width));
    if (shown) {
      push(wrap([
        span("filed by ", { fg: C.fgDim }),
        ...this.#byline(topic.createdBy, topic.labels),
        span(
          ` · ${stamp(topic.createdAt)} · active ${
            ago(topic.lastActivityAt, now)
          }`,
          { fg: C.fgDim },
        ),
      ], width));
      if (marked(topic.labels)) push(wrap(restriction(topic.labels), width));
    }
    // The buttons.
    const buttons: [string, Command][] = [
      ["Comment", { do: "compose", kind: "comment" }],
      ["Edit", { do: "compose", kind: "body" }],
      ["Rename", { do: "compose", kind: "title" }],
      ["Link", { do: "link" }],
      ["Mention", { do: "mention" }],
      ["Web ↗", { do: "web" }],
      ["Copy", { do: "copy" }],
      ["Labels", { do: "labels" }],
    ];
    rows.push([]);
    let row: Row<Command> = [];
    let used = 0;
    for (const [label, act] of buttons) {
      const drafted = (act.do === "compose" &&
          this.#saved.drafts[draftKey(act.kind, topic.number)] !== undefined)
        ? "✎"
        : "";
      const text = ` ${label}${drafted} `;
      if (used + columns(text) + 1 > width) {
        rows.push(row);
        row = [];
        used = 0;
      }
      row.push(
        { ...span(text, { bg: C.button, fg: C.ink, bold: true }), click: act },
        span(" "),
      );
      used += columns(text) + 1;
    }
    rows.push(row);
    // The body.
    rows.push([]);
    if (!shown) {
      rows.push(withheld(topic.labels));
    } else if (topic.body.trim() === "") {
      rows.push([span("(no body)", { fg: C.fgDim, italic: true })]);
    } else {
      push(prose(topic.body, width, links));
    }
    // The links.
    const present_links = topic.links.filter((l) => !l.removed);
    if (present_links.length > 0) {
      heading(`Links (${present_links.length})`);
      // Only a link `unlink` would take back offers to be taken back.
      for (const link of present_links) {
        if (!this.#fits(link.labels)) {
          rows.push([span("↗ ", { fg: C.fgDim }), ...withheld(link.labels)]);
          continue;
        }
        const label = link.label === "" || link.label === link.url
          ? link.url
          : link.label;
        push(wrap(
          [
            span(link.kind === "pr" ? "⇄ " : "↗ ", {
              fg: link.kind === "pr" ? C.green : C.blue,
            }),
            span(label, { fg: C.blue, underline: true }, link.url),
            ...(label === link.url
              ? []
              : [span(`  ${link.url}`, { fg: C.fgDim }, link.url)]),
            ...(link.addedBy === "" ? [] : [
              span("  ", {}),
              ...this.#byline(link.addedBy, link.labels, true),
            ]),
            ...(marked(link.labels) ? [span("  "), ...mark(link.labels)] : []),
            ...(this.#unlinkable(topic, link.url, link)
              ? [span("  "), {
                ...span("✕", { fg: C.red }),
                click: { do: "unlink", url: link.url } satisfies Command,
              }]
              : []),
          ],
          width,
          [span("  ")],
        ));
      }
    }
    // The references.
    const out = [...this.#refs.out.get(topic.number) ?? []];
    const into = [...this.#refs.in.get(topic.number) ?? []];
    const mentioned = new Set(
      topic.mentions.flatMap((id) =>
        this.#topics.filter((t) => t.address === id || t.piece === id).map((
          t,
        ) => t.number)
      ),
    );
    if (out.length + into.length > 0) {
      // A Topic referred to both ways is listed once, as both.
      const both = new Set(out.filter((number) => into.includes(number)));
      const counts = [
        [out.length - both.size, "out"],
        [into.length - both.size, "in"],
        [both.size, "two-way"],
      ] as const;
      heading(
        `References (${
          counts.filter(([n]) => n > 0).map(([n, way]) => `${n} ${way}`)
            .join(", ")
        })`,
      );
      for (const number of out) {
        const other = this.#byNumber.get(number);
        if (other === undefined) continue;
        rows.push(
          topicLine(
            both.has(number) ? "↔" : "→",
            other,
            mentioned.has(number)
              ? [span("  "), {
                ...span("✕", { fg: C.red }),
                click: { do: "unmention", number },
              }]
              : [],
          ),
        );
      }
      for (const number of into) {
        const other = this.#byNumber.get(number);
        if (other !== undefined && !both.has(number)) {
          rows.push(topicLine("←", other));
        }
      }
    }
    // The Topics most like this one.
    const similar = this.#similarTo(topic);
    if (similar.length > 0) {
      heading("Most like this");
      for (const { number, score } of similar) {
        const other = this.#byNumber.get(number);
        if (other !== undefined) {
          rows.push(
            topicLine("≈", other, [
              span(`  ${score.toFixed(2)}`, { fg: C.fgDim }),
            ]),
          );
        }
      }
    }
    // The thread.
    const comments = present(topic);
    heading(
      comments.length === 1 ? "1 comment" : `${comments.length} comments`,
    );
    if (comments.length === 0) {
      rows.push([
        span("No comments yet. Press C to write one.", {
          fg: C.fgDim,
          italic: true,
        }),
      ]);
    }
    comments.forEach((comment, index) => {
      rows.push([]);
      if (!this.#fits(comment.labels)) {
        rows.push([
          span(`${index + 1}. `, { fg: C.fgDim }),
          ...withheld(comment.labels),
        ]);
        return;
      }
      const fresh = comment.sentAt > this.#newSince ||
        (comment.editedAt ?? 0) > this.#newSince;
      push(wrap([
        span(`${index + 1}. `, { fg: C.fgDim }),
        ...this.#byline(comment.author, comment.labels),
        span(` · ${stamp(comment.sentAt)}`, { fg: C.fgDim }),
        ...(comment.editedAt === undefined ? [] : [
          span(` · edited ${ago(comment.editedAt, now)}`, {
            fg: C.fgDim,
            italic: true,
          }),
        ]),
        ...(fresh
          ? [
            span("  "),
            // Padded with spaces that wrapping keeps, so the badge is whole.
            span("\u00a0NEW\u00a0", { bg: C.blue, fg: C.ink, bold: true }),
          ]
          : []),
        ...(marked(comment.labels)
          ? [span("  "), ...mark(comment.labels)]
          : []),
      ], width));
      for (const line of prose(comment.body, width - 2, links)) {
        rows.push([span("  ", {}), ...line]);
      }
    });
    rows.push([]);
    return rows;
  }

  /**
   * The name a writer typed, colored for them, clicking it listing what
   * they wrote; and, apart from it, what CFC says of who wrote: the
   * principal integrity names (✓), that the labels cannot be read (⚠), or
   * that nothing vouches for the name (◇).
   */
  #byline(
    name: string,
    labels: PartLabels | undefined,
    small = false,
  ): Row<Command> {
    const shown = name === "" ? "someone" : name;
    const named: Span<Command> = {
      ...span(shown, { fg: authorColor(shown), bold: !small }),
      ...(name === ""
        ? {}
        : { click: { do: "filter", query: byQuery(name, false) } }),
    };
    const labelsCommand = { do: "labels" } satisfies Command;
    const vouched = labels?.authors ?? [];
    if (vouched.length === 0) return [named, span(" ◇", { fg: C.fgDim })];
    return [named, span(" · ", { fg: C.fgDim }), {
      ...span(`✓ written by ${vouched.map(shortDid).join(", ")}`, {
        fg: C.green,
      }),
      click: labelsCommand,
    }];
  }

  /**
   * Whether the default display ceiling admits a part labeled `labels`
   * to the person viewing, as a display no authored policy covers fits
   * it; a part whose labels cannot be read is not admitted.
   */
  #fits(labels: PartLabels | undefined): boolean {
    return admits(this.#fit, labels);
  }

  /** The Topics most like `topic`, by the words they share. */
  #similarTo(topic: Topic): { number: string; score: number }[] {
    const known = this.#similar.get(topic.number);
    if (known !== undefined) return known;
    const found = similarTopics(this.#topics, `${topic.title}\n${topic.body}`)
      .filter((hit) => hit.topic.number !== topic.number)
      .slice(0, SIMILAR)
      .map((hit) => ({ number: hit.topic.number, score: hit.similarity }));
    this.#similar.set(topic.number, found);
    return found;
  }

  #drawDialog(canvas: Canvas<Command>, dialog: Dialog): void {
    const top = dialog === this.#dialogs.at(-1);
    if (dialog.kind === "form") return this.#drawForm(canvas, dialog, top);
    const width = Math.min(
      canvas.width - 6,
      dialog.kind === "authors" ? 96 : 84,
    );
    const rows = dialog.kind === "text"
      ? dialog.rows(width - 5)
      : this.#authorRows(dialog, width - 5);
    // As tall as what it shows, up to the screen's height.
    const height = Math.min(
      canvas.height - 4,
      Math.max(dialog.tallest, rows.length + 5),
    );
    dialog.tallest = height;
    const rect = centered(canvas, width, height);
    if (top) this.#rects.set("dialog", rect);
    dialogBox(
      canvas,
      rect,
      dialog.kind === "authors" ? "Authors" : dialog.title,
    );
    const content = {
      x: rect.x + 2,
      y: rect.y + 1,
      width: rect.width - 5,
      height: rect.height - 5,
    };
    if (top) this.#rects.set("dialog-content", content);
    const body = dialog.kind === "authors" ? rows.slice(1) : rows;
    if (dialog.kind === "authors") {
      canvas.put(content.x, content.y, rows[0], content.width, C.panel);
      content.y += 1;
      content.height -= 1;
    }
    dialog.top = Math.max(
      0,
      Math.min(dialog.top, body.length - content.height),
    );
    for (let row = 0; row < content.height; row++) {
      const line = body[dialog.top + row];
      if (line !== undefined) {
        canvas.put(content.x, content.y + row, line, content.width, C.panel);
      }
    }
    const scroll = {
      total: body.length,
      top: dialog.top,
      visible: content.height,
    };
    if (top) {
      this.#scrolls.set("dialog", scroll);
      this.#rects.set("bar-dialog", {
        x: rect.x + rect.width - 2,
        y: content.y,
        width: 1,
        height: content.height,
      });
    }
    scrollBar(
      canvas,
      rect.x + rect.width - 2,
      content.y,
      content.height,
      scroll,
      {
        up: { do: "scroll", pane: "dialog", by: -1 },
        down: { do: "scroll", pane: "dialog", by: 1 },
        pageUp: { do: "scroll", pane: "dialog", by: -content.height },
        pageDown: { do: "scroll", pane: "dialog", by: content.height },
        thumb: { do: "thumb", pane: "dialog" },
      },
      C.panel,
    );
    const label = "Close";
    const buttonX = rect.x + rect.width - columns(label) - 6;
    const close: Command = { do: "button", index: 0 };
    button(
      canvas,
      buttonX,
      rect.y + rect.height - 3,
      label,
      true,
      close,
      C.panel,
      this.#pressing(close, buttonX, rect.y + rect.height - 3, label),
      "c",
    );
    if (dialog.kind === "authors") {
      const toggle = dialog.families ? "Names" : "Families";
      button(
        canvas,
        buttonX - columns(toggle) - 5,
        rect.y + rect.height - 3,
        toggle,
        false,
        { do: "families" },
        C.panel,
        this.#pressing(
          { do: "families" },
          buttonX - columns(toggle) - 5,
          rect.y + rect.height - 3,
          toggle,
        ),
        toggle === "Names" ? "n" : "f",
      );
      canvas.put(
        rect.x + 2,
        rect.y + rect.height - 3,
        [span("Enter lists what one wrote · F gathers families", {
          fg: C.fgDim,
          bg: C.panel,
        })],
        Math.max(0, buttonX - columns(toggle) - 7 - rect.x - 2),
        C.panel,
      );
    }
  }

  /** The authors dialog's rows: a heading, then one row per author. */
  #authorRows(dialog: Authors, width: number): Row<Command>[] {
    const list = this.#authorList(dialog);
    const nameWidth = Math.max(10, width - 40);
    const head = `${"Name".padEnd(nameWidth)} ${"Filed".padStart(6)} ${
      "Comments".padStart(9)
    } ${"Links".padStart(6)}  Last`;
    return [
      [span(head, { fg: C.cyan, bold: true, bg: C.panel })],
      ...list.map((author, index): Row<Command> => {
        const picked = index === dialog.selected;
        const bg = picked ? C.button : C.panel;
        const fg = picked ? C.ink : C.fg;
        const name = clip(author.name, nameWidth);
        const text = `${name}${" ".repeat(nameWidth - columns(name))} ${
          String(author.filed).padStart(6)
        } ${String(author.comments).padStart(9)} ${
          String(author.links).padStart(6)
        }  ${day(author.last, this.#now()).trim()}`;
        return [
          {
            ...span(text, { bg, fg: picked ? fg : authorColor(author.name) }),
            click: { do: "pick", index },
          },
          { ...span(" ".repeat(width), { bg }), click: { do: "pick", index } },
        ];
      }),
    ];
  }

  #drawForm(canvas: Canvas<Command>, form: Form, top: boolean): void {
    const editor = form.fields.some((f) => f.multiline);
    // A form of no fields is a message box: as wide as what it says, its
    // text set off from its frame and its buttons centered beneath.
    const box = form.fields.length === 0;
    // Each button is its label, its shadow, and a column apart.
    const buttonsWidth = form.buttons.reduce(
      (total, b) => total + columns(` ${b.label} `) + 2,
      -1,
    );
    const widest = editor
      ? Math.min(canvas.width - 4, 132)
      : Math.min(canvas.width - 6, 72);
    const conflict = this.#conflict(form);
    const single = form.fields.filter((f) => !f.multiline).length;
    // What the form says has the room its fields and buttons leave, an
    // editor keeping a few rows to edit in.
    const room = Math.max(
      1,
      canvas.height - 2 - (2 + 1 + single * 3 + 3 + (editor ? 4 : 0)),
    );
    // A blank line is kept, to set apart what it separates.
    const wrapped = form.message.flatMap((line) => {
      const rows = wrap(
        [span(line, { fg: C.fg, bg: C.panel })],
        widest - (box ? 8 : 4),
      );
      return rows.length > 0 ? rows : [[]];
    });
    const messageRows = wrapped.length <= room ? wrapped : [
      ...wrapped.slice(0, room - 1),
      [span("…", { fg: C.fgDim, bg: C.panel })],
    ];
    // A message box is as wide as the rows it draws need.
    const width = box
      ? Math.min(
        widest,
        maxOf([
          36,
          columns(form.title) + 10,
          buttonsWidth + 8,
          ...messageRows.map((row) => rowColumns(row) + 8),
        ]),
      )
      : widest;
    const height = editor
      ? canvas.height - 2
      : box
      ? 6 + messageRows.length
      : 2 + messageRows.length + (messageRows.length > 0 ? 1 : 0) + single * 3 +
        3;
    const rect = centered(canvas, width, height);
    if (top) this.#rects.set("dialog", rect);
    dialogBox(canvas, rect, form.title);
    const x = rect.x + 2;
    const inner = rect.width - 4;
    let y = rect.y + (box ? 2 : 1);
    // A message box's text is centered as a block.
    const textX = box
      ? rect.x +
        Math.floor(
          (rect.width - maxOf([0, ...messageRows.map(rowColumns)])) / 2,
        )
      : x;
    for (const row of messageRows) {
      canvas.put(textX, y++, row, rect.x + rect.width - 2 - textX, C.panel);
    }
    if (conflict !== undefined) {
      canvas.put(
        x,
        y++,
        [
          span(` ⚠ ${conflict} `, { bg: C.delBg, fg: C.yellow, bold: true }),
        ],
        inner,
        C.panel,
      );
    }
    if (messageRows.length > 0 || conflict !== undefined) y++;
    const buttonsY = rect.y + rect.height - 3;
    form.fields.forEach((entry, index) => {
      const focused = top && form.focus === index;
      canvas.put(x, y++, hotLabelRow(entry.label, focused), inner, C.panel);
      const rows = entry.multiline ? Math.max(3, buttonsY - 1 - y) : 1;
      const preview = entry.multiline && inner >= 100;
      const fieldWidth = preview ? Math.floor((inner - 1) / 2) : inner;
      const drawn = entry.field.draw(
        fieldWidth,
        rows,
        { bg: C.editorBg, fg: C.fgBright },
        focused ? { bg: C.fgBright, fg: C.ink } : undefined,
      );
      if (top) {
        this.#rects.set(`field-${index}`, {
          x,
          y,
          width: fieldWidth,
          height: rows,
        });
      }
      drawn.forEach((row, at) =>
        canvas.put(
          x,
          y + at,
          row.map((s) => ({
            ...s,
            click: { do: "field", id: index } satisfies Command,
          })),
          fieldWidth,
        )
      );
      if (preview) {
        const previewX = x + fieldWidth + 1;
        const previewWidth = inner - fieldWidth - 1;
        canvas.put(
          previewX - 1,
          y - 1,
          [span(" Preview", { fg: C.cyan, bold: true })],
          previewWidth,
          C.panel,
        );
        const shown = prose(
          entry.field.text,
          previewWidth - 2,
          (n) => this.#board.topicLinks + n,
        );
        for (let at = 0; at < rows; at++) {
          canvas.put(
            previewX,
            y + at,
            [span(" "), ...(shown[at] ?? [])],
            previewWidth,
            C.editorBg,
          );
        }
      }
      y += rows + 1;
    });
    let bx = box
      ? Math.max(x, rect.x + Math.floor((rect.width - buttonsWidth) / 2))
      : x;
    form.buttons.forEach((b, index) => {
      const act: Command = { do: "button", index };
      bx += button(
        canvas,
        bx,
        buttonsY,
        b.label,
        top && form.focus === form.fields.length + index,
        act,
        C.panel,
        this.#pressing(act, bx, buttonsY, b.label),
        b.hotkey,
      ) + 1;
    });
    if (editor) {
      canvas.put(
        bx + 1,
        buttonsY,
        [span("Ctrl-S saves · Esc closes, keeping a draft · Tab moves", {
          fg: C.fgDim,
          bg: C.panel,
        })],
        rect.x + rect.width - bx - 3,
        C.panel,
      );
    }
  }

  /** What changed on the board under a draft of a body or a title. */
  #conflict(form: Form): string | undefined {
    const purpose = form.purpose;
    if (
      purpose.to !== "compose" ||
      (purpose.kind !== "body" && purpose.kind !== "title")
    ) {
      return undefined;
    }
    const absent = this.#absent(purpose.number ?? "");
    if (absent !== undefined) return absent;
    const topic = this.#byNumber.get(purpose.number ?? "");
    if (topic === undefined) return undefined;
    if (!this.#fits(topic.labels)) {
      return `top/${topic.number} is withheld from this display now; it cannot be saved.`;
    }
    const current = purpose.kind === "body" ? topic.body : topic.title;
    return current === purpose.base
      ? undefined
      : `The ${purpose.kind} changed on the board after you began; Theirs shows it, and saving replaces it.`;
  }

  /** The live pill and what is being written, at the menu bar's right. */
  #pill(now: number): Row<Command> {
    const out: Row<Command> = [];
    if (this.#writes.busy > 0) {
      const spin = "◐◓◑◒"[Math.floor(now / SPIN_MS) % 4];
      out.push(
        span(` ${spin} writing `, { bg: C.panel, fg: C.orange, bold: true }),
      );
    }
    if (!this.#live) {
      out.push(span(" ○ connecting ", { fg: C.ink, bg: C.yellow, bold: true }));
    } else {
      const flash = this.#lastChange === undefined
        ? 0
        : fade(now - this.#lastChange, GLOW_MS / 2);
      out.push(span(" ● LIVE ", {
        fg: C.ink,
        bg: mix(darken(C.green, 0.8), C.white, flash * 0.6),
        bold: true,
      }));
    }
    out.push(span(" ", { bg: C.panel }));
    return out;
  }

  #hints(): Hint<Command>[] {
    const top = this.#dialogs.at(-1);
    if (top !== undefined) {
      // A dialog's buttons are listed with the keys that press them, with
      // Alt where a field has the keys and a letter alone would be typed.
      if (top.kind === "text") {
        return [{ key: "C", label: "Close", act: { do: "button", index: 0 } }];
      }
      if (top.kind === "authors") {
        return [
          top.families
            ? { key: "N", label: "Names", act: { do: "families" } }
            : { key: "F", label: "Families", act: { do: "families" } },
          { key: "C", label: "Close", act: { do: "close" } },
        ];
      }
      const typing = top.focus < top.fields.length;
      return [
        ...top.buttons.map((b, index): Hint<Command> => ({
          key: `${typing ? "Alt-" : ""}${b.hotkey.toUpperCase()}`,
          label: b.label,
          act: { do: "button", index },
        })),
        { key: "Tab", label: "Next", act: { do: "next" } },
      ];
    }
    return [
      { key: "F1", label: "Help", act: { do: "help" } },
      { key: "F2", label: "Comment", act: { do: "compose", kind: "comment" } },
      { key: "F3", label: "Search", act: { do: "search" } },
      { key: "F4", label: "Edit", act: { do: "compose", kind: "body" } },
      { key: "F5", label: "Zoom", act: { do: "zoom" } },
      { key: "F6", label: "Window", act: { do: "swap" } },
      { key: "Alt-←", label: "Back", act: { do: "back" } },
      { key: "F10", label: "Menu", act: { do: "menu", index: 0 } },
      { key: "Alt-X", label: "Exit", act: { do: "quit" } },
    ];
  }

  #statusRight(now: number): Row<Command> {
    const note = this.#note;
    if (note !== undefined && now - note.at < NOTE_MS) {
      return [span(` ${note.text} `, {
        bg: C.panel,
        fg: note.error ? C.red : C.fgBright,
        bold: note.error,
      })];
    }
    // A dialog's keys have the room the counts would take.
    if (this.#dialogs.length > 0) return [];
    const name = this.#saved.agentName;
    return [span(
      `${this.#held.toLocaleString("en-US")} documents${
        name === undefined ? "" : ` · writing as ${name}`
      } `,
      { bg: C.panel, fg: C.fgDim },
    )];
  }

  #aboutRows(width: number): Row<Command>[] {
    const lines = [
      "# Topics",
      "",
      "The Common Fabric team's Topics board, read and written from the terminal.",
      "",
      `- Space: \`${this.#board.space}\``,
      `- You: \`${this.#board.viewer ?? "unknown"}\``,
      `- Writes signed as: ${
        this.#saved.agentName ?? "(asked at the first write)"
      }`,
      `- Topics: ${this.#topics.length.toLocaleString("en-US")}, from ${
        this.#held.toLocaleString("en-US")
      } documents`,
    ];
    return prose(lines.join("\n"), width, (n) => this.#board.topicLinks + n);
  }
}

//
// Helpers
//

const NOWHERE: Rect = { x: -1, y: -1, width: 0, height: 0 };

/** The keys that quit. */
const QUIT = new Set(["alt-x", "ctrl-q", "ctrl-c"]);

/**
 * What a Mac's Option key types, on the US and ABC layouts, with the keys
 * whose Alt bindings work from anywhere: the menus' letters, Exit's, and
 * the two windows' numbers. A dialog's buttons need no Alt where no field
 * has the keys, and where one does, Option types.
 */
const OPTION_LETTERS: Readonly<Record<string, string>> = {
  "ƒ": "f",
  "†": "t",
  "√": "v",
  "©": "g",
  "˙": "h",
  "≈": "x",
  "¡": "1",
  "™": "2",
};

/** `key` named with its modifiers: `alt-x`, `ctrl-home`, `f2`. */
function keyName(key: Key): string {
  return `${key.ctrl && !key.name.startsWith("ctrl-") ? "ctrl-" : ""}${
    key.alt ? "alt-" : ""
  }${key.name}`;
}

/** Where a draft of `kind` for Topic `number` is kept. */
function draftKey(kind: ComposeKind, number: string | undefined): string {
  return kind === "new" ? "new" : `${kind}:${number}`;
}

/** The comments of `topic` that are not retracted, oldest first. */
function present(topic: Topic): TopicComment[] {
  return topic.comments.filter((c) => !c.removed).toSorted((a, b) =>
    a.sentAt - b.sentAt
  );
}

/** The first item of `menu` that is not a separator. */
function firstItem<C>(menu: Menu<C>): number {
  return Math.max(0, menu.items.findIndex((item) => item !== "-"));
}

/** A rectangle `width` by `height` in the middle of `canvas`. */
function centered<C>(canvas: Canvas<C>, width: number, height: number): Rect {
  return {
    x: Math.max(0, Math.floor((canvas.width - width) / 2)),
    y: Math.max(1, Math.floor((canvas.height - height) / 2)),
    width,
    height: Math.min(height, canvas.height - 2),
  };
}

/** A field's label, bright when the field has the keys. */
function hotLabelRow(label: string, focused: boolean): Row<Command> {
  return [
    span(label, {
      fg: focused ? C.fgBright : C.fg,
      bold: focused,
      bg: C.panel,
    }),
  ];
}

/** `text` with what `terms` match in it highlighted. */
function highlight(
  text: string,
  terms: readonly RegExp[],
  style: Style,
): Row<Command> {
  // A match is widened to whole characters, so that none is drawn apart.
  const bounds = [0];
  let offset = 0;
  for (const char of graphemes(text)) bounds.push(offset += char.length);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const global = new RegExp(term.source, `${term.flags.replace("g", "")}g`);
    for (const match of text.matchAll(global)) {
      if (match[0] !== "") {
        const end = match.index + match[0].length;
        ranges.push([
          bounds.findLast((at) => at <= match.index) ?? 0,
          bounds.find((at) => at >= end) ?? text.length,
        ]);
      }
    }
  }
  if (ranges.length === 0) return [span(text, style)];
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Row<Command> = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    if (from > at) out.push(span(text.slice(at, from), style));
    out.push(
      span(text.slice(from, end), { ...style, fg: C.yellow, underline: true }),
    );
    at = end;
  }
  if (at < text.length) out.push(span(text.slice(at), style));
  return out;
}

/** The color `name` is drawn in, the same every time. */
function authorColor(name: string): Style["fg"] {
  let hash = 0;
  for (const char of name.replace(/\s*\(.*\)$/, "")) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length];
}

/** What clicking `s` does, as a key: where it links, or what it runs. */
function doing(
  s: { click?: Command; href?: string } | undefined,
): string {
  return s === undefined ? "" : JSON.stringify([s.click, s.href]);
}

/** Whether `labels` say something a reader is to be told of. */
function marked(labels: PartLabels | undefined): boolean {
  return labels !== undefined &&
    (labels.unreadable === true || labels.confidentiality.length > 0);
}

/** The ◈ marking a part whose labels limit who may learn it. */
function mark(labels: PartLabels | undefined): Row<Command> {
  return marked(labels)
    ? [{
      ...span("◈", { fg: C.purple }),
      click: { do: "labels" },
    }]
    : [];
}

/** What a part's labels say of who may learn it, as a line. */
function restriction(labels: PartLabels | undefined): Row<Command> {
  return [...mark(labels), {
    ...span(` Only for ${cnf(labels?.confidentiality ?? [])}`, {
      fg: C.purple,
    }),
    click: { do: "labels" },
  }];
}

/** What stands for a part the display does not admit. */
function withheld(labels: PartLabels | undefined): Row<Command> {
  return [{
    ...span(
      labels?.unreadable
        ? "⚠ Withheld: its labels cannot be read."
        : "◈ Withheld: its labels do not admit it to this display.",
      { fg: C.purple, italic: true },
    ),
    click: { do: "labels" },
  }];
}

/** A confidentiality label written out: `A and (B or C)`. */
function cnf(clauses: readonly string[][]): string {
  return clauses.map((alternatives) =>
    alternatives.length === 1
      ? alternatives[0]
      : `(${alternatives.join(" or ")})`
  ).join(" and ");
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

/** `2026-10-18 14:31`, in local time; `-` for no time. */
function stamp(at: number): string {
  if (at <= 0) return "-";
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${
    two(date.getDate())
  } ` +
    `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** How long before `now` the time `at` was: `just now`, `5m ago`, `3d ago`. */
function ago(at: number, now: number): string {
  if (at <= 0) return "never";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

/** The help dialog's rows. */
function helpRows(width: number): Row<Command>[] {
  const text = `# Finding Topics

Type in the **Find** box to list the Topics matching every word. A word is a
case-insensitive regular expression matched against a Topic's title, body,
comments, links, and authors. Besides words:

- \`by:name\` keeps the Topics someone whose name matches wrote on;
  \`by:"Egory L7 (agent)"\` names one author exactly.
- \`in:title\` or \`in:body,comments\` limits where words match.
- \`is:unread\` keeps the Topics with activity you have not seen;
  \`is:open\` and \`is:settled\` keep those whose titles do not or do begin
  with a mark such as \`[RESOLVED]\`.
- A number, \`42\`, \`#42\`, or \`top/42\`, puts that Topic first.

Click an author's name anywhere to list what they wrote, or open
**View ▸ Authors** to see everyone who has.

# Keys

Letters act in the reader; in the list they type into the search.

| Key | Does |
| --- | --- |
| F1 | this help |
| F2 or C | comment on the Topic being read |
| F3 or / | search |
| F4 or E | edit the body |
| R | rename |
| L | add a link |
| M | mention another Topic |
| O | open the Topic in a web browser |
| Y | copy its reference |
| N | the next unread Topic |
| A | everyone who has written on the board |
| I | the Topic's CFC labels |
| F5 | zoom the window that has the keys |
| F6 | the other window; Tab too, from the list |
| Alt-← and Alt-→, Backspace | back and forward |
| Alt-↓ and Alt-↑, ] and [ | the next and previous Topic listed |
| Home and End | the top and bottom; in a search, Ctrl too |
| Tab and Enter in the reader | step through links and follow one |
| Ctrl-G | go to a Topic by its number |
| Ctrl-N | file a new Topic |
| Ctrl-T | hide or show settled Topics |
| Ctrl-O | change the order of the list |
| F10, Alt and a letter | the menus |
| Alt-X, Ctrl-Q | quit |

In an editor, Ctrl-S saves, Esc closes keeping a draft, Ctrl-Z undoes,
and the cursor moves as in a shell. A draft is kept across quitting, and
an edit someone else made meanwhile is shown before it is replaced.

A dialog's button is pressed by its highlighted letter, alone where no
field has the keys and with Alt anywhere; the status line lists them.
Tab moves between a dialog's fields and buttons, and, while a button has
the focus, Left and Right move along its buttons.

# Marks

- ● the Topic has activity you have not seen; ✎ you have a draft for it.
- ◈ CFC confidentiality limits who may learn the Topic or a comment; what
  the default display ceiling does not admit to you is withheld.
- ✓ CFC integrity says who wrote it, the principal shown, apart from the
  name in the byline, which is what the writer typed.
- ◇ nothing vouches for the name in the byline.
- ⚠ the CFC labels cannot be read, so the part is withheld.
- In the reader, → a Topic this one refers to, ← one referring to it, ↔
  one referring both ways, ≈ one like it, and ⇄ a pull request.

# Writes

A write is kept until it is known to have landed. One that may have
landed, its answer lost, is settled from **File ▸ Unfinished writes**,
which finishes it without writing it twice, and is offered again when the
browser next starts.
`;
  return prose(text, width, () => "");
}

/** The rows of the dialog describing `topic`'s CFC labels. */
function labelRows(
  topic: Topic,
  width: number,
  fit: LabelDisplayFit,
): Row<Command>[] {
  // Built of spans rather than Markdown, since names, addresses, and atoms
  // are what writers typed, and must not read as lines of their own.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const atom = (text: string) => span(flat(text), { fg: C.cyan });
  const item = (...spans: Span<Command>[]) =>
    wrap([span("• "), ...spans], width, [span("  ")]);
  const joined = (groups: Span<Command>[][], between: string) =>
    groups.flatMap((group, index) =>
      index === 0 ? group : [span(between), ...group]
    );
  const describeLabels = (labels: PartLabels | undefined): Row<Command>[] => {
    if (labels?.unreadable) {
      return item(span("Withheld: its labels cannot be read."));
    }
    if (!admits(fit, labels)) {
      return item(
        span("Withheld: its labels do not admit it to this display."),
      );
    }
    if (labels === undefined) {
      return item(span(
        "No labels: nothing limits who may learn it, and nothing vouches for who wrote it.",
      ));
    }
    return [
      ...(labels.confidentiality.length === 0
        ? item(span("Confidentiality: none."))
        : item(
          span("Confidentiality: only for "),
          ...joined(
            labels.confidentiality.map((clause) =>
              joined(clause.map((a) => [atom(a)]), " or ")
            ),
            ", and ",
          ),
          span("."),
        )),
      ...(labels.integrity.length === 0 ? item(span("Integrity: none.")) : item(
        span("Integrity: "),
        ...joined(labels.integrity.map((a) => [atom(a)]), ", "),
        span("."),
      )),
    ];
  };
  const heading = (text: string): Row<Command>[] => [
    [],
    ...wrap([span(flat(text), { fg: C.fgBright, bold: true })], width),
    [],
  ];
  return [
    ...wrap([span(
      "Contextual Flow Control labels say who may learn a value (its confidentiality) and what vouches for it (its integrity). Integrity naming who wrote a part is the only proof of authorship: a name in a byline is what the writer typed.",
    )], width),
    ...heading("Title and body"),
    ...describeLabels(topic.labels),
    ...present(topic).flatMap((comment, index) => [
      ...heading(
        admits(fit, comment.labels)
          ? `Comment ${index + 1}, signed ${comment.author || "by no one"}`
          : `Comment ${index + 1}`,
      ),
      ...describeLabels(comment.labels),
    ]),
    ...topic.links.filter((l) => !l.removed).flatMap((link, index) => [
      ...heading(
        admits(fit, link.labels) ? `Link ${link.url}` : `Link ${index + 1}`,
      ),
      ...describeLabels(link.labels),
    ]),
  ];
}
