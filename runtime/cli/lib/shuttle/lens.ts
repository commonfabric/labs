/**
 * The value view: one cell rendered as structured JSON, scrollable, searchable,
 * and live for as long as it is open.
 *
 * It answers to the key table `views.md` gives a view, less the two that drill:
 * the motions and the two ways out, `/` with `n`/`N` to find text in the
 * rendering, `:` to run a shuttle line without leaving the frame, and `e` to
 * open the watched cell in an editor. `enter` and `backspace` need a cursor —
 * the row a view stands on — and this one has a scroll position instead, so
 * they arrive with the view that carries one
 * (`docs/plans/shuttle/build-sequence.md`). What the frame
 * offers along its bottom edge is what it answers to, so the two cannot part —
 * and the edge therefore says something different in each state this is in.
 *
 * It is a lens rather than a move (`docs/plans/shuttle/views.md`): opening one
 * changes no place, and `q` returns to the prompt exactly where it stood. What
 * it is a lens *onto* is a watch, and the two have different lifetimes — this
 * subscription is cancelled when the lens closes, and the watch's own goes on
 * firing (`watch.ts`).
 *
 * Everything here is a value and a decision about a value. The frame comes
 * back as lines and the keys arrive decoded, so a case drives the whole of it —
 * the scrolling, the rendering, the searching, and what each key does — with no
 * terminal. Where the lines land is the prompt's decision (`prompt.ts`), which
 * is what owns the keyboard while a lens is open.
 *
 * A line is the one thing this cannot carry out for itself. Running one is
 * asynchronous and is the prompt loop's work, so `:` and `e` leave the line
 * where the loop collects it ({@link ValueLens.asked}) and the loop hands back
 * what it produced ({@link ValueLens.answered}). That keeps the whole of this
 * module synchronous, and keeps one line at a time running under one cancel —
 * the loop's own, which is the cancel the prompt already offers.
 */

import { unicodeWidth } from "@std/cli/unicode-width";

import { EditBuffer } from "../view/editbuffer.ts";
import type { Key } from "../view/keys.ts";
import { apply } from "./editing.ts";
import { LineHistory } from "./history.ts";
import { quoteToken } from "./line.ts";
import { marker, wrapped } from "./page.ts";
import { renderValue } from "./value.ts";

/** What the frame shows before the cell it watches has settled once. */
const NOT_SETTLED = marker("nothing has settled yet");

/** What the bottom edge writes between the keys it offers. */
const SEPARATOR = " · ";

/**
 * The keys the bottom edge offers, one phrase each, and what it says about the
 * watch behind them.
 *
 * They are ordered on the edge by what a reader can least do without, because
 * a narrow terminal drops phrases from the right: the way out comes first, the
 * keys that open a line come last, and the one phrase that is not a key at all
 * comes after those. That last is what a person is least sure of on the way
 * out — the two lifetimes are separate, and `q` ends only the lens's
 * (`watch.ts`) — so a terminal narrow enough to drop a phrase drops it before
 * it drops anything the frame answers to.
 *
 * One record rather than a const each, so that the ordering above is a fact
 * about one declaration rather than a comment reaching over eleven.
 */
const PHRASE = {
  /** The way out of the frame. */
  back: "q back",

  /** The two motions, and the arrows that double for them. */
  scroll: "j/k scroll",

  /** The two ends of the value. */
  ends: "g/G ends",

  /** Opens the line that finds text in the rendering. */
  search: "/ search",

  /** Offered only once a search is standing, which is what `n` steps. */
  next: "n/N next",

  /** Opens the line that runs a shuttle command. */
  command: ": command",

  /** Opens the watched cell in an editor, through the `edit` verb. */
  edit: "e edit",

  /** Stops the line the frame asked for, offered only while one is running. */
  stop: "ctrl-c stop",

  /** Takes the shuttle line that is being typed. */
  run: "enter run",

  /** Takes the search that is being typed. */
  find: "enter search",

  /** Abandons whichever line is being typed, either key. */
  cancel: "ctrl-c/esc cancel",

  /** Not a key: what `q` leaves behind it. */
  armed: "(q leaves the watch armed)",
} as const;

/** What the modeline says where a search found nothing. */
const NO_MATCH = "no match";

/** The narrowest frame that has a column of its own to write in. */
const NARROWEST = 5;

/** Where the cursor stands on a frame that is being typed at. */
export interface FrameCursor {
  /** The row of the terminal, counted from one. */
  readonly row: number;

  /** The column of the terminal, counted from one. */
  readonly column: number;
}

/**
 * What the modeline writes in front of a line of the kind `opening` names.
 *
 * The space is the form [`views.md`](../../../../docs/plans/shuttle/views.md)
 * draws a command line in, and it is the form the prompt takes too — every
 * line shuttle reads opens with a mark and a space, so a line typed at a frame
 * reads as the same act as a line typed at the prompt.
 */
function prompting(opening: ":" | "/"): string {
  return `${opening} `;
}

/**
 * A search standing on the rendering: what was typed, and which match the view
 * is on.
 *
 * One field for the pattern and for whether a search is showing, because they
 * are one state: a search is showing exactly as long as there is something to
 * have searched for. Two would admit the pair that says a search is showing on
 * no pattern, which every reader of it would have to answer for and no key can
 * reach — an empty `/` is how a search is put away, so what it leaves is no
 * search rather than an empty one.
 */
interface Search {
  /** What was typed after the `/`, which is never empty. */
  readonly pattern: string;

  /**
   * The line of the rendering the view is standing on, and absent where the
   * search found none — or where the value changed under it and the line it
   * was standing on is no longer a match.
   */
  match: number | undefined;
}

/** A line being typed at the frame: what it opens with, and what it holds. */
interface Typing {
  /** `:` for a shuttle line, `/` for a search. */
  readonly opening: ":" | "/";

  /** The line itself. */
  readonly buffer: EditBuffer;

  /** The lines of this kind typed at this lens before it. */
  readonly history: LineHistory;
}

/**
 * A lens onto one cell: what it shows, where it is scrolled to, what is being
 * typed at it, and whether it is still open.
 */
export class ValueLens {
  #label: string;
  #reference: string;
  #shown: readonly string[] = [NOT_SETTLED];
  #top = 0;
  #repaint: (() => void) | undefined;
  #cancel: (() => void) | undefined;
  #closed = false;
  #typing: Typing | undefined;
  #commands = new LineHistory();
  #searches = new LineHistory();
  #asked: string | undefined;
  #running: string | undefined;
  #said = "";
  #search: Search | undefined;
  #wanted: number | undefined;

  /**
   * Constructs an instance titled `label`, which is the cell it is a lens onto
   * written the way the prompt writes a place, and standing on `reference`,
   * which is that same cell written the way a line names one.
   *
   * The two are both here because they answer different questions. The title
   * is read off the screen by a person, so it is the short form the prompt
   * carries; the reference is what `e` composes a line out of, so it is the
   * form the line grammar takes (`referenceForPlace`, `place.ts`).
   */
  constructor(label: string, reference: string) {
    this.#label = label;
    this.#reference = reference;
  }

  /** Whether it is still open, which `q` and the end of the keys change. */
  get open(): boolean {
    return !this.#closed;
  }

  /** What the frame is titled: the cell this is a lens onto. */
  get label(): string {
    return this.#label;
  }

  /**
   * Whether a line is being typed at the frame, which is what says where a
   * `ctrl-c` goes.
   *
   * The loop asks because it holds the third thing that key can mean: what is
   * being typed is this lens's, the way out is this lens's, and the line in
   * flight is the loop's own (`prompt.ts`). Innermost first, which is the
   * order the prompt already takes.
   */
  get typing(): boolean {
    return this.#typing !== undefined;
  }

  /**
   * Draws through `repaint` from now until the lens closes, and draws once
   * immediately so that the frame is on screen before anything changes.
   */
  drawnThrough(repaint: () => void): void {
    this.#repaint = repaint;
    repaint();
  }

  /**
   * Takes `cancel` as what stops this lens's own subscription, and stops it at
   * once where the lens closed while it was being taken.
   *
   * The subscription is this lens's and no watch's, which is the whole of what
   * {@link ValueLens.close} promises: a lens closed leaves every armed watch
   * firing and stops exactly the sink that was drawing this frame.
   */
  holding(cancel: () => void): void {
    if (this.#closed) {
      cancel();
      return;
    }
    this.#cancel = cancel;
  }

  /**
   * Shows `value` as what the cell has settled at, and draws the frame again.
   *
   * One call per quiet runtime is the subscription's promise rather than this
   * one's (`sinkCellValue`, `lib/piece.ts`), so what this owes is that a call
   * costs one repaint: several intermediate values do not reach here to be
   * drawn, and each that does is drawn once.
   *
   * Where the scroll sits is kept across a change, so a value that grew while
   * a reader was partway down it leaves them where they were reading rather
   * than at the top. A search is kept across one too, and the count the
   * modeline carries is worked out against what the cell holds now rather than
   * held from when the search was made: a value that changed under a search is
   * the one case where a remembered total would be a lie on screen.
   *
   * What the frame shows is the value, not a transition into it: that the cell
   * changed is the watch's line to say, above the prompt.
   */
  showing(value: unknown): void {
    if (this.#closed) return;
    this.#shown = renderValue(value).split("\n");
    this.#repaint?.();
  }

  /**
   * Acts on `key`, drawing the frame again where it changed anything.
   *
   * There are two tables and which one a key meets is whether a line is being
   * typed at the frame. With none, the keys are the view's: `q` back, `j`/`k`
   * and the arrows one line, `g` and `G` the two ends, `/` and `n`/`N` the
   * search, `:` a shuttle line, and `e` the watched cell in an editor.
   * `ctrl-c` closes as `q` does, because a full screen a person cannot get out
   * of by the key every terminal program answers is worse than one key too
   * many. With a line open, the keys are the line editor's — the same table
   * the prompt binds (`editing.ts`) — with `enter` taking the line and
   * `ctrl-c` or `escape` abandoning it.
   *
   * `ctrl-c` therefore means two things at one frame, and they are the two the
   * prompt already means by it: what is being typed where something is, and
   * the way out where nothing is. The third — stopping the line in flight — is
   * the loop's, which is what holds that line (`prompt.ts`).
   *
   * Everything else does nothing, and does nothing silently. That covers a key
   * this view has yet to grow — `enter` and `backspace` drill from a cursor
   * this one does not carry (`docs/plans/shuttle/build-sequence.md`) — and one
   * nothing takes at all. A frame offering only what it answers to is what
   * tells a reader which is which.
   */
  reads(key: Key): void {
    if (this.#closed) return;
    if (this.#typing !== undefined) {
      this.#typed(key);
      return;
    }
    if (this.#browsed(key.name)) this.#repaint?.();
  }

  /**
   * Takes the line this lens wants run, and is nothing where it wants none.
   *
   * It is taken rather than read, so a line is handed over once: the caller
   * that takes it is the one that runs it, and a second caller finds nothing
   * to run twice.
   */
  asked(): string | undefined {
    const line = this.#asked;
    this.#asked = undefined;
    return line;
  }

  /**
   * Records that the line this lens asked for produced `text`, and draws the
   * frame again.
   *
   * What it produced is the modeline's first line and no more of it. The rest
   * is not lost and is not this frame's to show: every line's output is
   * written above the prompt, which a frame holds back until it gives the
   * screen up, so what a `:` line said is read in the transcript where the
   * output of a line typed at the prompt is read (`announce`, `terminal.ts`).
   * The modeline is the acknowledgement — that the line came back, and what it
   * opened with — and it stands until something replaces it.
   */
  answered(text: string): void {
    if (this.#closed) return;
    this.#running = undefined;
    this.#said = text;
    this.#repaint?.();
  }

  /**
   * Closes the lens: its own subscription is cancelled, and every armed watch
   * is left firing.
   *
   * Closing twice cancels once, so a lens closed by a key and then again by
   * the run ending needs no test in front of it.
   */
  close(): void {
    this.#closed = true;
    const cancel = this.#cancel;
    this.#cancel = undefined;
    cancel?.();
  }

  /**
   * The frame this draws on a terminal `rows` tall and `columns` wide: the top
   * edge naming the cell, the value under it, the modeline where there is
   * something in it, and the bottom edge saying which keys it takes and how
   * much of the value is on screen.
   *
   * The value is broken at the frame's own inner width rather than the
   * terminal's, so a line of it never runs past the right edge and every row
   * of the frame is the same width. That is also what makes the scroll
   * position a row of the screen rather than a line of the rendering, which is
   * what a reader moving by one expects.
   *
   * The modeline is the row above the bottom edge, and it is there only when
   * it has something to say: a line being typed, a line in flight, where a
   * search stands, or what the last line said. What is left between the edges
   * is the value's to scroll within: the `rows - 2` the two edges leave, and
   * `rows - 3` for as long as the modeline is up. It costs that row only while
   * it is up, which is why it is not drawn empty — a frame that reserved the
   * row would be one row of the value short for the whole of a session that
   * never typed at it. A terminal with no room for it — two rows, which is the
   * two edges and nothing else — does not draw it, the edges being what a
   * frame promises.
   *
   * The frame is as tall as the terminal whatever the value is, its rows
   * filled out where the value does not reach the bottom: it is the screen
   * rather than a box on it, so the bottom edge stands where the screen ends
   * and a value that shrank leaves no rows of the one before it behind. A
   * frame with no room for a body is written all the same, as its two edges —
   * a terminal too short for a value is one a reader can still read the title
   * and the keys off.
   */
  frame(rows: number, columns: number): readonly string[] {
    const width = Math.max(columns, NARROWEST);
    const inner = width - 4;
    const modeline = rows >= 3 ? this.#modeline(inner) : undefined;
    // What the two edges and the modeline leave, which is the whole of what
    // the value gets: a frame drawn taller than the screen scrolls its own top
    // row away, and that row is the one naming the cell being watched.
    const room = modeline === undefined ? Math.max(rows - 2, 0) : rows - 3;
    const body = wrapped(this.#shown, inner);
    const top = this.#clamped(body.length, room, inner);
    const page = body.slice(top, top + room);
    const filled = [...page, ...Array(room - page.length).fill("")];
    const between = modeline === undefined ? filled : [...filled, modeline];
    return [
      edge("┌", "┐", [this.#label], width),
      ...between.map((line) => `│ ${padded(fit(line, inner), inner)} │`),
      edge(
        "└",
        "┘",
        this.#keys(),
        width,
        counted(top, page.length, body.length),
      ),
    ];
  }

  /**
   * Where the cursor stands on the frame this draws on a terminal `rows` tall
   * and `columns` wide, and nothing where the frame is not being typed at.
   *
   * A frame with no line open is read rather than typed at, and a cursor on
   * one would sit wherever the last row's drawing ended and read as a place a
   * person could type. A frame with a line open is typed at, and a line being
   * typed with no cursor on it is one a person cannot see where they are in.
   * So the cursor follows the modeline, which is the one row of a frame that
   * is ever typed at.
   *
   * It is a second call rather than a second return value because it is a
   * second question: what the frame looks like is asked on every repaint, and
   * where the cursor goes is asked by the one caller that can place one.
   */
  cursor(rows: number, columns: number): FrameCursor | undefined {
    if (this.#closed || this.#typing === undefined || rows < 3) {
      return undefined;
    }
    const inner = Math.max(columns, NARROWEST) - 4;
    // The modeline is the row above the bottom edge, and the frame is as tall
    // as the terminal, so it is the terminal's own second-to-last row. The
    // text starts two columns in, past the frame's left edge and the space
    // after it.
    return { row: rows - 1, column: 3 + this.#typedRow(inner).column };
  }

  /**
   * Helper for {@link ValueLens.reads}, which acts on the key named `name` at
   * a frame with no line open, and is whether it changed anything.
   */
  #browsed(name: string): boolean {
    switch (name) {
      case "q":
      case "ctrl-c":
        this.close();
        return false;
      case ":":
        return this.#opens(":", this.#commands);
      case "/":
        return this.#opens("/", this.#searches);
      case "e":
        return this.#asks(`edit ${quoteToken(this.#reference)}`);
      case "n":
        return this.#stepped(1);
      case "N":
        return this.#stepped(-1);
      default:
        return this.#scrolled(name);
    }
  }

  /**
   * Helper for {@link ValueLens.reads}, which acts on `key` at a frame with a
   * line open, and draws the frame again whatever it did.
   *
   * Every key draws, the line being on screen: a motion that moved nothing
   * still leaves the cursor where it was, and drawing again costs one frame
   * rather than a comparison this would otherwise have to make against the
   * whole of the buffer's state.
   */
  #typed(key: Key): void {
    const typing = this.#typing!;
    if (key.name === "enter") {
      this.#typing = undefined;
      this.#submits(typing);
    } else if (key.name === "ctrl-c" || key.name === "escape") {
      this.#typing = undefined;
    } else {
      apply({ buffer: typing.buffer, history: typing.history }, key);
    }
    this.#repaint?.();
  }

  /**
   * Helper for {@link ValueLens.#browsed}, which opens a line of the kind
   * `opening` names, recalling through `history`, and is whether it opened
   * one.
   *
   * A shuttle line is refused while one is in flight and a search is not. What
   * separates them is where the work happens: a line is run by the loop, which
   * holds one at a time under one cancel, and a search is this module's own
   * and costs a traversal of what is already on screen.
   */
  #opens(opening: ":" | "/", history: LineHistory): boolean {
    if (opening === ":" && this.#running !== undefined) return false;
    history.abandon();
    this.#typing = { opening, buffer: new EditBuffer(""), history };
    return true;
  }

  /**
   * Helper for {@link ValueLens.#typed}, which takes the line `typing` holds:
   * a shuttle line to be run, or a search to be made.
   *
   * An empty line does nothing but close the line it was typed on, which is
   * what `enter` at an empty prompt does. An empty search is the exception and
   * is the way to put a search away: it takes the pattern with it, and the
   * bottom edge stops offering `n` and `N` in the same drawing.
   *
   * What counts as empty differs, and it differs because the two read what was
   * typed differently. A shuttle line of nothing but spaces is a line with no
   * verb in it, so it is empty; a search of one space is a search for a space,
   * which the indentation of a rendering is full of.
   */
  #submits(typing: Typing): void {
    const line = typing.buffer.text();
    if (typing.opening === ":") {
      if (line.trim() === "") return;
      typing.history.record(line);
      this.#asks(line);
      return;
    }
    if (line === "") {
      this.#search = undefined;
      return;
    }
    typing.history.record(line);
    this.#search = { pattern: line, match: undefined };
    this.#stepped(1);
  }

  /**
   * Helper for {@link ValueLens.#browsed} and {@link ValueLens.#submits},
   * which leaves `line` for the loop to run, and is whether it did.
   *
   * One line at a time, which is the loop's own discipline seen from here: a
   * second asked for while the first is in flight would be a second cancel to
   * hold and a second answer to place in one modeline.
   */
  #asks(line: string): boolean {
    if (this.#running !== undefined) return false;
    this.#asked = line;
    this.#running = line;
    this.#said = "";
    return true;
  }

  /**
   * Helper for {@link ValueLens.#browsed} and {@link ValueLens.#submits},
   * which moves the search on by `step` matches, and is whether it changed
   * anything.
   *
   * It wraps, because a search that stopped at the last match would leave a
   * reader at the bottom of a value with no way back to the first but `g` and
   * a retype. Where the value changed under the search and the match it was
   * standing on is no longer one, the step starts again from the end it is
   * moving away from.
   */
  #stepped(step: number): boolean {
    const search = this.#search;
    if (search === undefined) return false;
    // What a line said is what the modeline carries where there is one, so a
    // search made after one takes the row by leaving nothing said rather than
    // by a second field saying which of the two is the newer.
    this.#said = "";
    const found = this.#matches(search.pattern);
    if (found.length === 0) {
      search.match = undefined;
      return true;
    }
    const at = search.match === undefined ? -1 : found.indexOf(search.match);
    const next = at < 0
      ? (step > 0 ? found[0]! : found[found.length - 1]!)
      : found[(at + step + found.length) % found.length]!;
    search.match = next;
    this.#wanted = next;
    return true;
  }

  /**
   * Helper for {@link ValueLens.#stepped} and {@link ValueLens.#standing},
   * which is where in the rendering the search pattern stands, in order.
   *
   * It is worked out where it is asked for rather than held, so a value that
   * settled under a search is searched as it is now. The match is a plain
   * substring of a line of the rendering: a pattern is what a person typed
   * rather than an expression, and a shell that read one would owe a reader a
   * dialect and a refusal for a pattern that would not compile.
   */
  #matches(pattern: string): number[] {
    const found: number[] = [];
    this.#shown.forEach((line, index) => {
      if (line.includes(pattern)) found.push(index);
    });
    return found;
  }

  /**
   * Helper for {@link ValueLens.frame}, which is what the modeline says on a
   * frame whose inner width is `inner`, and is nothing where it has nothing to
   * say.
   *
   * The four things it may carry are ordered by how immediate they are. A line
   * being typed is what the person is doing now; a line in flight is what they
   * just did and are waiting on; what a line said is what came back from that;
   * and a search is where they are in the value, which is the standing state
   * the other three cover over.
   *
   * The two that are neither being typed nor in flight take the row in the
   * order they happened rather than by rank, and that ordering is kept without
   * a flag saying which of them is the newer — a flag being a state that can
   * disagree with both. A search leaves nothing said, so it takes the row from
   * a line that spoke before it; a line that says something takes the row back
   * by being said.
   *
   * The two are not symmetrical, and the difference is what a reader acts on.
   * A search that loses the row is still standing: `n` and `N` go on stepping
   * it and the edge goes on offering them, because what a line said covers the
   * search rather than putting it away. Only an empty `/` puts one away.
   */
  #modeline(inner: number): string | undefined {
    if (this.#typing !== undefined) return this.#typedRow(inner).text;
    if (this.#running !== undefined) return `: ${this.#running}`;
    if (this.#said !== "") return oneLineOf(this.#said);
    const search = this.#search;
    if (search !== undefined) {
      return `${prompting("/")}${search.pattern}  ${this.#standing(search)}`;
    }
    return undefined;
  }

  /**
   * Helper for {@link ValueLens.#modeline}, which says where the search
   * stands: which match of how many, or that there is none.
   *
   * A value that changed under a search can leave the match it was standing on
   * no longer one, and there is no honest ordinal to give there — so what it
   * says instead is how many there are, which is the question a reader about
   * to press `n` is asking.
   */
  #standing(search: Search): string {
    const found = this.#matches(search.pattern);
    if (found.length === 0) return NO_MATCH;
    const at = search.match === undefined ? -1 : found.indexOf(search.match);
    if (at < 0) {
      return found.length === 1 ? "1 match" : `${found.length} matches`;
    }
    return `${at + 1} of ${found.length}`;
  }

  /**
   * Helper for {@link ValueLens.#modeline} and {@link ValueLens.cursor}, which
   * is the line being typed as the modeline shows it, and where the cursor
   * stands in that row, on a frame whose inner width is `inner`.
   *
   * A line longer than the row scrolls under the cursor rather than being cut
   * at the right edge. Cutting is what every other text on a frame does, and
   * it is wrong here for one reason: a cut line is still readable, and a line
   * being typed past the cut is one a person is typing where they cannot see.
   * So what the row shows is the window ending at the cursor, one column short
   * of the right edge so that the cursor itself has somewhere to stand — which
   * a line that fits does not need, the padding beside it being that column.
   */
  #typedRow(inner: number): { readonly text: string; readonly column: number } {
    const typing = this.#typing!;
    const typed = typing.buffer.text();
    const opening = prompting(typing.opening);
    const line = opening + typed;
    const before = opening + [...typed].slice(0, typing.buffer.col).join("");
    const room = Math.max(inner, 1);
    // A line as wide as the row is a line that fits: the cursor after its last
    // character stands in the column the padding holds, which is inside the
    // frame and beside the right edge rather than on it. Scrolling a line that
    // fits would drop its first character to make room for a column the row
    // already has.
    if (unicodeWidth(line) <= room) {
      return { text: line, column: unicodeWidth(before) };
    }
    const shown = tail(before, room - 1);
    return {
      text: fit(shown + line.slice(before.length), room),
      column: unicodeWidth(shown),
    };
  }

  /**
   * Helper for {@link ValueLens.frame}, which is what the bottom edge offers,
   * and is therefore every key this lens takes in the state it is in.
   *
   * Three states and three tables. A line open takes the line editor's keys,
   * and the two that end it are what the edge names — the rest of that table
   * is the one a person brought with them from the prompt. A line in flight
   * takes the view's keys less the two that would start a second, and gains
   * the one that stops the first. Everything else is the view's own.
   */
  #keys(): readonly string[] {
    if (this.#typing !== undefined) {
      return [
        this.#typing.opening === ":" ? PHRASE.run : PHRASE.find,
        PHRASE.cancel,
      ];
    }
    const running = this.#running !== undefined;
    return [
      ...(running ? [PHRASE.stop] : []),
      PHRASE.back,
      PHRASE.scroll,
      PHRASE.ends,
      PHRASE.search,
      ...(this.#search === undefined ? [] : [PHRASE.next]),
      ...(running ? [] : [PHRASE.command, PHRASE.edit]),
      PHRASE.armed,
    ];
  }

  /**
   * Helper for {@link ValueLens.#browsed}, which moves the scroll as `name`
   * says and is whether it named a motion.
   *
   * The bound is applied when the frame is drawn rather than here, because
   * only the frame knows how many rows the value takes: the same value is more
   * lines on a narrow terminal than on a wide one, and the position this holds
   * is the row a reader last moved to.
   */
  #scrolled(name: string): boolean {
    switch (name) {
      case "j":
      case "down":
        this.#top++;
        return true;
      case "k":
      case "up":
        this.#top = Math.max(this.#top - 1, 0);
        return true;
      case "g":
        this.#top = 0;
        return true;
      case "G":
        this.#top = Number.MAX_SAFE_INTEGER;
        return true;
      default:
        return false;
    }
  }

  /**
   * Helper for {@link ValueLens.frame}, which is the row the body starts at
   * where it holds `lines` and `room` of them fit on a frame whose inner width
   * is `inner`.
   *
   * A match the search moved to is taken here rather than where the key was
   * read, and for the reason the bound is: a line of the rendering is as many
   * rows as the frame is narrow, so which row it starts at is a question only
   * the drawing can answer. It is taken once, so a window resized afterwards
   * leaves the reader where they were rather than jumping them back.
   *
   * It is clamped rather than refused, so `G` on a value that then shrank
   * shows the end of what is there rather than an empty frame, and the
   * clamping is recorded so that a `k` after it moves from where the reader
   * is looking rather than from where they had scrolled to.
   */
  #clamped(lines: number, room: number, inner: number): number {
    if (this.#wanted !== undefined) {
      this.#top = wrapped(this.#shown.slice(0, this.#wanted), inner).length;
      this.#wanted = undefined;
    }
    const last = Math.max(lines - room, 0);
    this.#top = Math.min(Math.max(this.#top, 0), last);
    return this.#top;
  }
}

/**
 * Helper for {@link ValueLens.frame}, which is an edge of the frame `columns`
 * wide: the corners, the phrases of `left` beside the opening one, `right`
 * beside the closing one where there is one, and the rule that fills between
 * them.
 *
 * Nothing is allowed to widen the frame, because every row of a frame is the
 * same width and a title that pushed one out would leave the frame's right
 * edge in two columns.
 *
 * The right-hand text is fitted first, so what a narrow terminal drops is the
 * left: the right of an edge carries what the frame is doing now — how much of
 * a value is on screen — and the left carries a reminder of the keys, which is
 * the half a reader can do without.
 *
 * What is dropped from the left is whole phrases, from the last. Half a phrase
 * is worse than none of it on an edge that is read as a list of what the frame
 * answers to: a key cut in two offers nothing, and the separator left hanging
 * after it promises a phrase that is not there. Where not even the first
 * phrase fits it is cut, there being nothing else to show: a cut title still
 * names the cell, and a cut key is what a frame too narrow for its shortest
 * phrase has instead of an empty edge — the width being what a frame promises
 * before it promises anything it says.
 */
function edge(
  opening: string,
  closing: string,
  left: readonly string[],
  columns: number,
  right = "",
): string {
  const tailed = fit(right, columns - 6);
  const framing = tailed === "" ? 4 : 6;
  const room = Math.max(columns - framing - unicodeWidth(tailed), 0);
  const shown = offering(left, room);
  const rule = "─".repeat(Math.max(room - unicodeWidth(shown), 0));
  return tailed === ""
    ? `${opening} ${shown} ${rule}${closing}`
    : `${opening} ${shown} ${rule} ${tailed} ${closing}`;
}

/**
 * Helper for {@link edge}, which is as many of `phrases` as `room` columns
 * hold, in order and separated, and the first one cut where none of them fits
 * whole.
 */
function offering(phrases: readonly string[], room: number): string {
  let shown = "";
  for (const phrase of phrases) {
    const next = shown === "" ? phrase : shown + SEPARATOR + phrase;
    if (unicodeWidth(next) > room) break;
    shown = next;
  }
  return shown === "" ? fit(phrases[0] ?? "", room) : shown;
}

/**
 * Helper for {@link ValueLens.frame} and {@link edge}, which is as much of
 * `text` as `room` columns hold, and nothing where they hold none.
 *
 * The cut is by display width and at a character boundary, which is
 * {@link wrapped}'s (`page.ts`) — the one traversal every width in shuttle is
 * measured by, so a double-width character costs an edge what it costs a row.
 *
 * What {@link wrapped} gives back can still be wider than it was asked for: a
 * single character wider than the whole width is taken on its own and
 * overflows, there being nowhere narrower to put it. That is right for a page,
 * which must show something or `more` could be asked forever, and wrong here,
 * where every row of a frame is the same width and one column over puts the
 * frame's right edge in two columns. So a piece that came back too wide is
 * dropped: a column that cannot hold the character it was given holds nothing.
 */
function fit(text: string, room: number): string {
  if (room <= 0 || text === "") return "";
  const shown = wrapped([text], room)[0] ?? "";
  return unicodeWidth(shown) > room ? "" : shown;
}

/**
 * Helper for the line being typed, which is as much of the end of `text` as
 * `room` columns hold, and nothing where they hold none.
 *
 * It walks from the end rather than breaking the line and taking the last
 * piece. Those are two different answers: breaking from the left leaves a last
 * piece holding whatever was left over, which for a line one column past a
 * break is a single character — and a command line that showed one character
 * of what was typed is the defect this exists to avoid. The measure is
 * `unicodeWidth`, which is what every width on a frame is measured by, and the
 * cut is at a character boundary, which is what {@link wrapped} cuts at.
 */
function tail(text: string, room: number): string {
  if (room <= 0 || text === "") return "";
  const points = [...text];
  let taken = "";
  let filled = 0;
  for (let at = points.length - 1; at >= 0; at--) {
    const point = points[at]!;
    const cost = unicodeWidth(point);
    if (taken !== "" && filled + cost > room) break;
    taken = point + taken;
    filled += cost;
  }
  return taken;
}

/**
 * Helper for {@link ValueLens.frame}, which is `line` filled out to `inner`
 * columns, so that the frame's right edge stands in one column on every row.
 */
function padded(line: string, inner: number): string {
  return line + " ".repeat(Math.max(inner - unicodeWidth(line), 0));
}

/**
 * Helper for the modeline, which is the first line of `text`.
 *
 * What a line said reaches the transcript whole, so what the modeline owes a
 * reader is the acknowledgement rather than the answer. The first line is what
 * a refusal opens with and what a listing heads with, so it is the line that
 * says which of the two came back.
 */
function oneLineOf(text: string): string {
  return text.split("\n")[0] ?? "";
}

/**
 * Helper for {@link ValueLens.frame}, which says which rows of the value are
 * on screen where they are not all of it, and says nothing where they are.
 *
 * Numbered from one, as a listing's handles are and for the same reason: this
 * is read off a screen by a person rather than indexed by a program.
 */
function counted(top: number, shown: number, lines: number): string {
  if (shown >= lines) return "";
  // A screen with no room between the edges shows no row at all, and a range
  // from the first to the one before it reads as a span running backwards.
  // What is left to say there is how much of the value is out of sight.
  if (shown === 0) return `0 of ${lines}`;
  return `${top + 1}-${top + shown} of ${lines}`;
}
