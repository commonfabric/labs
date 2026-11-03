/**
 * `deno task topics watch`: the board, live, on the whole terminal. The view
 * opens on the local copy as it stands, follows the board over a memory
 * session, and draws each change as it arrives; `screen.ts` decides what a
 * frame looks like, and this file runs the terminal, the session, and the
 * frames an animation needs.
 */

import { CSI, type Rgb, term } from "@commonfabric/cli/view/ansi";
import { palette } from "@commonfabric/cli/view/theme";
import { appViewToUrlPath, spaceViewRef } from "@commonfabric/navigation";
import { defaultDisplayFit } from "@commonfabric/html/display-fit-atoms";

import { changes, history, type TopicEvent } from "./events.ts";
import { redact } from "./labels.ts";
import { followBoard } from "./live.ts";
import type { MirrorData, Topic } from "./mirror.ts";
import {
  animating,
  type FeedItem,
  FRAME_MS,
  kindColor,
  render,
  type ScreenState,
} from "./screen.ts";
import {
  copySource,
  heldContent,
  loadMirror,
  type OpenedSession,
  refreshMirror,
  saveMirror,
} from "./sync.ts";

/** How many cards the feed keeps. */
const FEED_LENGTH = 60;

/**
 * What takes the terminal over for the view: the alternate screen, the
 * cursor hidden, no wrapping at the last column, and the view's background
 * around the grid.
 */
const TAKE = term.enterAltScreen + term.hideCursor + `${CSI}?7l` +
  term.setDefaultBg(palette.editorBg);

/** What gives the terminal back as it was. */
const GIVE = `${CSI}?7h` + term.showCursor + term.resetDefaultBg +
  term.leaveAltScreen;

/** The terminal the view takes over. */
export interface Terminal {
  write(text: string): void;
  size(): { columns: number; rows: number };
  setRaw(raw: boolean): void;

  /** The bytes typed, as they arrive, until the terminal closes. */
  input(): ReadableStream<Uint8Array>;

  /** Calls `act` whenever the process receives `signal`, until undone. */
  on(signal: Deno.Signal, act: () => void): () => void;

  /**
   * Holds what the process says on the console, rather than letting it
   * draw over the screen, calling `said` with each thing said as one line,
   * and whether it warns or errs, until undone, when what was held is said
   * after all.
   */
  hold(said: (text: string, error: boolean) => void): () => void;
}

/** The time, and a way to act after some of it. */
export interface Clock {
  now(): number;
  after(ms: number, act: () => void): () => void;
}

/** What the view needs from the world, injectable so a test can drive it. */
export interface WatchDeps {
  terminal: Terminal;
  clock: Clock;
  connect(): Promise<OpenedSession>;
}

/** The board the view follows, and where its copy is kept. */
export interface WatchBoard {
  /** The deployment the board's space is on, which opens a Topic. */
  apiUrl: string;

  /**
   * The DID of the person viewing, whose display admits what its default
   * ceiling admits to them; with none, only what names no one.
   */
  viewer?: string;
  board: string;
  space: string;
  mirror: string;
}

/** What `watch` shows, as it changes. */
interface WatchState extends ScreenState {
  touched: Map<string, { at: number; color: Rgb }>;
}

/**
 * A full-screen view of a board that {@link showBoard} runs: told of the
 * board's Topics as they change and of what is typed, and asked for frames.
 */
export interface BoardView {
  /**
   * What the view adds to taking the terminal over, such as asking for
   * mouse reports, and to giving it back.
   */
  readonly modes?: { take: string; give: string };

  /**
   * The board's Topics at `now`: first those the copy holds, with `live`
   * unset, then the board's as the session follows it, `held` being how
   * many documents the copy holds the content of.
   */
  update(
    topics: readonly Topic[],
    now: number,
    live: boolean,
    held: number,
  ): void;

  /** What was typed, at `now`; `true` ends the view. */
  input(bytes: Uint8Array, now: number): boolean;

  /**
   * The frame for a terminal `columns` by `rows` at `now`: one string per
   * row, each of which moves to the start of its row and paints all of it.
   */
  frame(columns: number, rows: number, now: number): string[];

  /**
   * How long after `now` a frame drawn then differs from one drawn at
   * `now`, or `undefined` when none does until something happens.
   */
  nextFrame(now: number): number | undefined;

  /**
   * Finishes what the view keeps, once it has ended and before the terminal
   * is given back, while a frame can still be drawn, giving up on what it
   * waits for once `abandon` settles: when the person asks to end again, or
   * the input ends. Failing ends the run with that failure, the terminal
   * restored.
   */
  close?(abandon: Promise<void>): Promise<void>;

  /**
   * Says, as one line, what the process said on the console while the
   * view had the screen, `error` when it warned or erred.
   */
  said?(text: string, error: boolean): void;
}

/** What a {@link BoardView} can ask of the runner showing it. */
export interface ViewControl {
  /** Draws a frame, for a change the view made of its own accord. */
  redraw(): void;
}

/**
 * Shows the board `board` names, live, until `q` or Control-C is typed, the
 * terminal's input ends, or the process is signaled to end. The terminal is
 * given back before the session closes, however the view ends; the view
 * failing, or the session ending of its own accord, is an error.
 */
export function watchBoard(board: WatchBoard, deps: WatchDeps): Promise<void> {
  return showBoard(board, deps, () => watching(board));
}

/** The view `watch` shows: the board's Topics beside a feed of changes. */
function watching(board: WatchBoard): BoardView {
  const fit = defaultDisplayFit(board.viewer);
  const state: WatchState = {
    space: board.space,
    topicLinks: topicLinks(board),
    topics: [],
    feed: [],
    touched: new Map(),
    live: false,
    held: 0,
  };
  return {
    update(board, now, live, held) {
      const topics = redact(board, fit);
      if (state.live) {
        arrive(state, changes(state.topics, topics, now), now);
      } else {
        state.feed = past(topics);
        state.live = live;
      }
      state.topics = topics;
      state.held = held;
    },
    input: (bytes) => bytes.length > 0 && bytes.every((b) => QUIT_KEYS.has(b)),
    frame: (columns, rows, now) => render(state, columns, rows, now),
    nextFrame: (now) => animating(state, now) ? FRAME_MS : undefined,
  };
}

/**
 * Shows the board `board` names, live, in the view `make` makes, until the
 * view ends itself, the terminal's input ends, or the process is signaled to
 * end. The view opens on the local copy as it stands, follows the board over
 * a memory session, and is drawn whenever something changes or is still
 * moving, a row being written only when it differs from the last frame. The
 * terminal is given back before the session closes, however the view ends;
 * the view failing, or the session ending of its own accord, is an error.
 */
export async function showBoard(
  board: WatchBoard,
  deps: WatchDeps,
  make: (control: ViewControl) => BoardView,
): Promise<void> {
  const { terminal, clock } = deps;
  const data = await loadMirror(board.mirror);
  // Settles once the view is to end, failing when drawing a frame failed.
  const ended = Promise.withResolvers<void>();
  ended.promise.catch(() => {});
  const stop = new AbortController();
  let shown: string[] = [];
  let frame: (() => void) | undefined;
  // Set once the terminal is given back, after which nothing is drawn.
  let given = false;
  // Set once the view is finishing, when asking to end again abandons what
  // it waits for.
  let ending = false;
  const abandoned = Promise.withResolvers<void>();
  const end = () => {
    if (ending) abandoned.resolve();
    ended.resolve();
  };
  const draw = () => {
    frame?.();
    frame = undefined;
    if (given) return;
    try {
      const { columns, rows } = terminal.size();
      const now = clock.now();
      const drawn = view.frame(columns, rows, now);
      terminal.write(
        drawn.filter((row, index) => row !== shown[index]).join(""),
      );
      shown = drawn;
      const next = view.nextFrame(now);
      if (next !== undefined) frame = clock.after(next, draw);
    } catch (error) {
      ended.reject(error);
    }
  };
  const view = make({ redraw: draw });
  view.update(
    await copied(data, board.board),
    clock.now(),
    false,
    heldContent(data).length,
  );

  const undo: (() => void)[] = [];
  let release: (() => void) | undefined;
  let typed: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let connecting: Promise<OpenedSession> | undefined;
  let connection: OpenedSession | undefined;
  let following: Promise<void> | undefined;
  terminal.setRaw(true);
  try {
    terminal.write(TAKE + (view.modes?.take ?? ""));
    // A frame is drawn once what said it is done, which may be drawing.
    release = terminal.hold((text, error) => {
      view.said?.(text, error);
      queueMicrotask(draw);
    });
    const keys = terminal.input().getReader();
    typed = keys;
    // What is typed is read until the input ends, while the view finishes
    // too, so that asking to end again abandons what it waits for.
    (async () => {
      for (;;) {
        const { done, value } = await keys.read();
        if (done) return;
        if (view.input(value, clock.now())) end();
        else draw();
      }
    })().then(() => {
      abandoned.resolve();
      ended.resolve();
    }, (error) => {
      abandoned.resolve();
      ended.reject(error);
    });
    undo.push(terminal.on("SIGWINCH", () => {
      shown = [];
      draw();
    }));
    for (const signal of ENDING_SIGNALS) undo.push(terminal.on(signal, end));
    draw();
    connecting = deps.connect();
    connection = await Promise.race([
      connecting,
      ended.promise.then(() => undefined),
    ]);
    if (connection === undefined) return;
    following = followBoard(
      connection.session,
      connection.space,
      data,
      board.board,
      async ({ topics }) => {
        view.update(topics, clock.now(), true, heldContent(data).length);
        draw();
        await saveMirror(board.mirror, data);
      },
      stop.signal,
    );
    await Promise.race([ended.promise, following]);
  } finally {
    stop.abort();
    try {
      // The view finishes what it keeps while the screen is still its own,
      // so that it can show what it is waiting for.
      ending = true;
      await view.close?.(abandoned.promise);
    } finally {
      given = true;
      frame?.();
      for (const undone of undo) undone();
      try {
        await typed?.cancel();
      } catch {
        // Input that already failed has nothing to give back; the terminal
        // is restored all the same.
      }
      try {
        terminal.write((view.modes?.give ?? "") + GIVE);
      } finally {
        // The terminal leaves raw mode, says what was held, and the session
        // closes, each even when what came before it failed.
        try {
          terminal.setRaw(false);
        } finally {
          release?.();
          if (connection === undefined) {
            // A session that opens after the view has gone is closed unused,
            // and one that fails to open no longer matters.
            connecting?.then((late) => late.close()).catch(() => {});
          } else {
            await connection.close();
            await following;
          }
        }
      }
    }
  }
}

/**
 * The address that opens a Topic of `board` in a browser, less its number.
 * The shell's own writer writes the path, so the shell reads back the space
 * and the Topic that went in. The path is resolved as a relative one, which
 * keeps it under any path `apiUrl` has and keeps a space DID's `did:` from
 * being read as the scheme of a URL.
 */
export function topicLinks(
  board: Pick<WatchBoard, "apiUrl" | "space">,
): string {
  const space = spaceViewRef(board.space, undefined);
  if (!space) {
    throw new Error("A board's Topics cannot be linked to without a space.");
  }
  return new URL(
    `.${appViewToUrlPath({ ...space, pieceSlug: "top" })}/`,
    board.apiUrl.endsWith("/") ? board.apiUrl : `${board.apiUrl}/`,
  ).href;
}

/**
 * The keys that quit, `q` and Control-C, typed without anything else. Escape
 * is not one, since it also starts what an arrow key or a mouse wheel sends.
 */
const QUIT_KEYS = new Set([0x71, 0x03]);

/**
 * The signals that end the view, which the process would otherwise die of
 * with the terminal still taken over.
 */
const ENDING_SIGNALS: readonly Deno.Signal[] = [
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGTERM",
];

/**
 * The terminal `deno` runs in, read and written through `io`, which is
 * `Deno` itself outside a test.
 */
export function consoleTerminal(
  io: {
    stdin: Pick<typeof Deno.stdin, "setRaw" | "readable">;
    stdout: Pick<typeof Deno.stdout, "writeSync">;
    stderr: Pick<typeof Deno.stderr, "writeSync">;
    consoleSize: typeof Deno.consoleSize;
    addSignalListener: typeof Deno.addSignalListener;
    removeSignalListener: typeof Deno.removeSignalListener;
  },
  out: Pick<Console, ConsoleMethod> = console,
): Terminal {
  const encoder = new TextEncoder();
  // Counts and timers outlast a hold, as the console's own do.
  const counting = counter();
  return {
    hold(said) {
      // Each thing said, to say it again once the hold is undone.
      const held: (() => void)[] = [];
      const undo: (() => void)[] = [];
      const { info, warn } = out;
      for (const method of CONSOLE_METHODS) {
        const original = out[method];
        out[method] = (...args: unknown[]) => {
          const told = counting(method, args);
          if (told === undefined) return;
          const [as, what] = told;
          const speak = as === method ? original : as === "info" ? info : warn;
          held.push(() => Reflect.apply(speak, out, what));
          // An assertion that holds, and the end of a group, say nothing.
          if (as === "assert" ? what[0] : as === "groupEnd") return;
          said(
            consoleLine(as === "assert" ? what.slice(1) : what),
            ERRING.has(as),
          );
        };
        // Each method takes its own arguments, which only reflection can
        // put back as one.
        undo.push(() => Reflect.set(out, method, original));
      }
      // What writes to standard error itself, as the logger can.
      const write = io.stderr.writeSync;
      io.stderr.writeSync = (bytes) => {
        const copy = bytes.slice();
        held.push(() => Reflect.apply(write, io.stderr, [copy]));
        said(new TextDecoder().decode(copy).replace(/\s+/g, " ").trim(), true);
        return bytes.length;
      };
      undo.push(() => io.stderr.writeSync = write);
      return () => {
        for (const undone of undo) undone();
        for (const again of held) again();
      };
    },
    write(text) {
      const bytes = encoder.encode(text);
      for (let at = 0; at < bytes.length;) {
        at += io.stdout.writeSync(bytes.subarray(at));
      }
    },
    size: () => io.consoleSize(),
    setRaw: (raw) => io.stdin.setRaw(raw),
    input: () => io.stdin.readable,
    on(signal, act) {
      io.addSignalListener(signal, act);
      return () => io.removeSignalListener(signal, act);
    },
  };
}

/** The ways of saying something on the console. */
const CONSOLE_METHODS = [
  "assert",
  "clear",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "trace",
  "warn",
] as const;
type ConsoleMethod = typeof CONSOLE_METHODS[number];

/**
 * What each thing said on the console says, as a method and its arguments
 * that say it again as it was, or nothing: a count or a timer is said as
 * what it says when asked, since asking again later would count or time it
 * again, and clearing the screen is dropped, there being no screen of its
 * own to clear once the view is gone.
 */
function counter(): (
  method: ConsoleMethod,
  args: unknown[],
) => [ConsoleMethod, unknown[]] | undefined {
  const counts = new Map<string, number>();
  const started = new Map<string, number>();
  return (method, args) => {
    if (!COUNTING.has(method)) return [method, args];
    const [label = "default", ...data] = args;
    const name = String(label);
    switch (method) {
      case "clear":
        return undefined;
      case "count": {
        const count = (counts.get(name) ?? 0) + 1;
        counts.set(name, count);
        return ["info", [`${name}: ${count}`]];
      }
      case "countReset":
        counts.delete(name);
        return undefined;
      case "time":
        started.set(name, performance.now());
        return undefined;
      case "timeLog":
      case "timeEnd": {
        const at = started.get(name);
        if (method === "timeEnd") started.delete(name);
        return at === undefined
          ? ["warn", [`Timer '${name}' does not exist`]]
          : ["info", [
            `${name}: ${(performance.now() - at).toFixed(3)}ms`,
            ...(method === "timeLog" ? data : []),
          ]];
      }
    }
    return [method, args];
  };
}

/** The ways of saying something on the console that count or time. */
const COUNTING: ReadonlySet<ConsoleMethod> = new Set([
  "clear",
  "count",
  "countReset",
  "time",
  "timeLog",
  "timeEnd",
]);

/** The ways of saying something on the console that warn or err. */
const ERRING: ReadonlySet<ConsoleMethod> = new Set([
  "assert",
  "error",
  "trace",
  "warn",
]);

/**
 * What `args` say on the console, as one line: the first, when it is a
 * string, a format whose `%s`, `%d`, `%i`, `%f`, `%o`, `%O`, and `%c` take
 * the values after it, a style dropped, and each value not a string
 * inspected.
 */
export function consoleLine(args: readonly unknown[]): string {
  const inspect = (value: unknown) =>
    typeof value === "string" ? value : Deno.inspect(value, { colors: false });
  const [first, ...rest] = args;
  let parts = args;
  if (typeof first === "string") {
    let next = 0;
    const text = first.replace(/%[sdifoOc%]/g, (spec) => {
      if (spec === "%%") return "%";
      if (next >= rest.length) return spec;
      const value = rest[next++];
      return spec === "%c"
        ? ""
        : spec === "%d" || spec === "%i"
        ? String(Math.trunc(Number(value)))
        : spec === "%f"
        ? String(Number(value))
        : inspect(value);
    });
    parts = [text, ...rest.slice(next)];
  }
  return parts.map(inspect).join(" ").replace(/\s+/g, " ").trim();
}

/** The clock `Date.now` reads, acting through `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, act) {
    const timer = setTimeout(act, ms);
    return () => clearTimeout(timer);
  },
};

/** The Topics the copy at hand holds, without asking the server. */
async function copied(data: MirrorData, board: string): Promise<Topic[]> {
  if (data.space === undefined) return [];
  const copy = structuredClone(data);
  return (await refreshMirror(copy, board, copySource(data.space))).topics;
}

/** The feed a board's recent history makes, newest first. */
function past(topics: readonly Topic[]): FeedItem[] {
  return history(topics, FEED_LENGTH).reverse().map((event) => ({
    event,
    arrived: event.at,
    live: false,
  }));
}

/**
 * Puts `events`, which arrived at `now`, at the top of the feed, and lights
 * the Topics they happened to.
 */
function arrive(
  state: WatchState,
  events: readonly TopicEvent[],
  now: number,
): void {
  if (events.length === 0) return;
  const arrived = events.toReversed().map((event) => ({
    event,
    arrived: now,
    live: true,
  }));
  state.feed = [...arrived, ...state.feed].slice(0, FEED_LENGTH);
  for (const event of events) {
    state.touched.set(event.topic.number, {
      at: now,
      color: kindColor(event.kind),
    });
  }
  state.lastChange = now;
}
