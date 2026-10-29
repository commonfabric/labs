/**
 * `deno task topics watch`: the board, live, on the whole terminal. The view
 * opens on the local copy as it stands, follows the board over a memory
 * session, and draws each change as it arrives; `screen.ts` decides what a
 * frame looks like, and this file runs the terminal, the session, and the
 * frames an animation needs.
 */

import { CSI, type Rgb, term } from "@commonfabric/cli/view/ansi";
import { palette } from "@commonfabric/cli/view/theme";

import { changes, history, type TopicEvent } from "./events.ts";
import { followBoard } from "./live.ts";
import type { MirrorData, Topic } from "./mirror.ts";
import {
  animating,
  type FeedItem,
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

/** The gap between frames while something on screen is still moving. */
const FRAME_MS = 33;

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
  board: string;
  space: string;
  mirror: string;
}

/** What the view shows, as it changes. */
interface WatchState extends ScreenState {
  touched: Map<string, { at: number; color: Rgb }>;
}

/**
 * Shows the board `board` names, live, until `q` or Control-C is typed, the
 * terminal's input ends, or the process is signaled to end. The terminal is
 * given back before the session closes, however the view ends; the view
 * failing, or the session ending of its own accord, is an error.
 */
export async function watchBoard(
  board: WatchBoard,
  deps: WatchDeps,
): Promise<void> {
  const { terminal, clock } = deps;
  const data = await loadMirror(board.mirror);
  const start = await copied(data, board.board);
  const state: WatchState = {
    space: board.space,
    topicLinks: new URL(
      `${encodeURIComponent(board.space)}/top/`,
      board.apiUrl.endsWith("/") ? board.apiUrl : `${board.apiUrl}/`,
    ).href,
    topics: start,
    feed: past(start),
    touched: new Map(),
    live: false,
    held: heldContent(data).length,
  };
  // Settles once the view is to end, failing when drawing a frame failed.
  const ended = Promise.withResolvers<void>();
  ended.promise.catch(() => {});
  const stop = new AbortController();
  let shown: string[] = [];
  let frame: (() => void) | undefined;
  const draw = () => {
    frame?.();
    frame = undefined;
    try {
      const { columns, rows } = terminal.size();
      const now = clock.now();
      const drawn = render(state, columns, rows, now);
      terminal.write(
        drawn.filter((row, index) => row !== shown[index]).join(""),
      );
      shown = drawn;
      if (animating(state, now)) frame = clock.after(FRAME_MS, draw);
    } catch (error) {
      ended.reject(error);
    }
  };

  const undo: (() => void)[] = [];
  let typed: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let connecting: Promise<OpenedSession> | undefined;
  let connection: OpenedSession | undefined;
  let following: Promise<void> | undefined;
  terminal.setRaw(true);
  try {
    terminal.write(TAKE);
    const keys = terminal.input().getReader();
    typed = keys;
    (async () => {
      for (;;) {
        const { done, value } = await keys.read();
        if (done) return;
        if (value.length > 0 && value.every((byte) => QUIT_KEYS.has(byte))) {
          return;
        }
      }
    })().then(ended.resolve, ended.reject);
    undo.push(terminal.on("SIGWINCH", () => {
      shown = [];
      draw();
    }));
    for (const signal of ENDING_SIGNALS) {
      undo.push(terminal.on(signal, ended.resolve));
    }
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
        const now = clock.now();
        if (state.live) {
          arrive(state, changes(state.topics, topics, now), now);
        } else {
          state.feed = past(topics);
          state.live = true;
        }
        state.topics = topics;
        state.held = heldContent(data).length;
        draw();
        await saveMirror(board.mirror, data);
      },
      stop.signal,
    );
    await Promise.race([ended.promise, following]);
  } finally {
    stop.abort();
    frame?.();
    for (const undone of undo) undone();
    await typed?.cancel();
    try {
      terminal.write(GIVE);
    } finally {
      // The terminal leaves raw mode and the session closes even when
      // giving the terminal back failed.
      terminal.setRaw(false);
      if (connection === undefined) {
        // A session that opens after the view has gone is closed unused, and
        // one that fails to open no longer matters.
        connecting?.then((late) => late.close()).catch(() => {});
      } else {
        await connection.close();
        await following;
      }
    }
  }
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
export function consoleTerminal(io: {
  stdin: Pick<typeof Deno.stdin, "setRaw" | "readable">;
  stdout: Pick<typeof Deno.stdout, "writeSync">;
  consoleSize: typeof Deno.consoleSize;
  addSignalListener: typeof Deno.addSignalListener;
  removeSignalListener: typeof Deno.removeSignalListener;
}): Terminal {
  const encoder = new TextEncoder();
  return {
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
