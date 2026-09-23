/**
 * Interactive less-like controller. The only module that touches the TTY: it
 * reads keystrokes from `/dev/tty` (stdin is the piped source text), renders
 * frames to `Deno.stdout`, and restores the terminal on every exit path.
 *
 * All state and key handling live in {@link Session} (testable, no I/O); this
 * driver wires it to the terminal and the {@link renderFrame} renderer. The raw
 * terminal and process operations are reached through an injectable {@link
 * PagerDeps} so the driver's control flow can be exercised without a real TTY;
 * {@link realPagerDeps} supplies the genuine Deno calls.
 */

import { CSI, term } from "./ansi.ts";
import type { Document } from "./model.ts";
import { decodeKeys } from "./keys.ts";
import { cursorScreenPos, renderFrame, type ViewState } from "./render.ts";
import { Session, type SessionOptions } from "./session.ts";
import { ui } from "./theme.ts";
import { onGrammarLoad, type Semantics } from "./languages/language.ts";
import type { EditableSource } from "./editsource.ts";
import { realFileGateway } from "./filegateway.ts";
import { ViewError } from "./errors.ts";

const encoder = new TextEncoder();

/** Idle gap after the last keystroke before the deferred structure re-parse
 * runs. Highlighting is not deferred — it re-runs on every keystroke. */
const REPARSE_DEBOUNCE_MS = 150;

/** Gap between frames while the lines a Ctrl-L revealed land, one per frame. */
const REVEAL_FRAME_MS = 16;

/** How long a prompt button stays drawn pushed after it is activated, before
 * its action's result shows. Long enough to register as a press, short enough
 * not to hold up the answer. */
const PUSH_FRAME_MS = 90;

/** How long a status message that takes itself away stands before it goes. Long
 * enough to read twice over, short enough not to outstay what prompted it. */
const MESSAGE_LINGER_MS = 2000;

export type PagerOptions = SessionOptions;

/** The keyboard handle the pager reads from — satisfied by a `Deno.FsFile`. */
export interface PagerTty {
  read(buffer: Uint8Array): Promise<number | null>;
  setRaw(mode: boolean): void;
  close(): void;
}

/** The terminal/process operations the pager performs, injected so the driver
 * is testable without a real terminal. */
export interface PagerDeps {
  /** Open the controlling terminal for reading; throws when there is none. */
  openTty(): PagerTty;

  write(text: string): void;

  /** The terminal size; may throw when there is no console. */
  consoleSize(): { columns: number; rows: number };

  env(key: string): string | undefined;
  addSignalListener(signal: Deno.Signal, handler: () => void): void;
  removeSignalListener(signal: Deno.Signal, handler: () => void): void;
  exit(code: number): never;

  /** Schedule `handler` after `ms`; returns a function that cancels it. */
  setTimer(handler: () => void, ms: number): () => void;

  /** Resolve after `ms`. Used to hold a frame on screen for a moment on a path
   * that then tears the screen down, where a cancellable timer has nothing left
   * to run in. */
  delay(ms: number): Promise<void>;

  /**
   * Call `listener` each time a language's parser load ends, with the reason
   * when it failed; returns a function that stops the calls.
   */
  onGrammarLoad(listener: (failure?: string) => void): () => void;
}

/** The real terminal and process operations. */
export function realPagerDeps(): PagerDeps {
  return {
    openTty: () => Deno.openSync("/dev/tty", { read: true }),
    write: (text) => {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    consoleSize: Deno.consoleSize,
    env: (key) => Deno.env.get(key),
    addSignalListener: Deno.addSignalListener,
    removeSignalListener: Deno.removeSignalListener,
    exit: Deno.exit,
    setTimer: (handler, ms) => {
      const id = setTimeout(handler, ms);
      return () => clearTimeout(id);
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onGrammarLoad,
  };
}

export async function runPager(
  doc: Document,
  options: PagerOptions,
  semantics: Semantics | undefined,
  editSource?: EditableSource,
  deps: PagerDeps = realPagerDeps(),
): Promise<void> {
  let tty: PagerTty;
  try {
    tty = deps.openTty();
  } catch (error) {
    throw new ViewError(
      `cf view: cannot open /dev/tty for keyboard input (${
        error instanceof Error ? error.message : String(error)
      }). Pipe through a real terminal, or use --plain.`,
    );
  }

  // The terminal fills the area outside the character grid (the sub-cell padding
  // below the last row) with its default background. Set that to the status
  // bar's color so the strip beneath the last line blends in instead of showing
  // the terminal's own background; restore it on exit. Only with color on.
  const padBg = options.color ? ui.statusBar.bg : undefined;

  const session = new Session(
    doc,
    options,
    consoleSize(deps),
    semantics,
    editSource,
    realFileGateway(),
  );

  const paint = (doc: Document, view: ViewState) => {
    const rows = renderFrame(doc, view);
    // Re-assert the padding background every frame. Some terminals drop the
    // OSC 11 default set at startup after the first repaint, so setting it once
    // is not enough; re-sending the same value is a no-op where it already holds.
    let out = (padBg ? term.setDefaultBg(padBg) : "") +
      `${CSI}?7l${term.hideCursor}`; // disable autowrap while drawing
    for (let i = 0; i < rows.length; i++) {
      out += term.moveTo(i + 1, 1) + term.clearLine + rows[i];
    }
    out += `${CSI}?7h`;
    // Show the text cursor at its cell when edit mode has one; otherwise the
    // terminal cursor stays hidden.
    const cur = cursorScreenPos(doc, view);
    if (cur) out += term.moveTo(cur.row, cur.col) + term.showCursor;
    deps.write(out);
  };

  const draw = () => paint(session.displayDoc(), session.view());

  // Ctrl-L leaves the session at the finished state; these frames walk the lines
  // it revealed in one at a time so where they land is visible. Any key, or a
  // resize, drops the frames left and the draw that follows shows the finish.
  let cancelReveal: (() => void) | undefined;
  const stopReveal = () => {
    if (cancelReveal) {
      cancelReveal();
      cancelReveal = undefined;
    }
  };
  const startReveal = (): boolean => {
    const reveal = session.pendingReveal;
    if (!reveal || reveal.count < 2) return false; // one line lands on its own
    let shown = 1;
    const step = () => {
      const frame = shown < reveal.count ? session.revealFrame(shown) : null;
      if (!frame) {
        cancelReveal = undefined;
        draw();
        // What it says stands from when the lines finish landing, not from
        // before they started.
        startExpiry();
        return;
      }
      paint(frame.doc, frame.view);
      shown++;
      cancelReveal = deps.setTimer(step, REVEAL_FRAME_MS);
    };
    cancelReveal = deps.setTimer(step, REVEAL_FRAME_MS);
    return true;
  };

  // A prompt button press shows the button pushed for a moment before its result
  // lands. The captured pushed frame is painted before the button's synchronous
  // action starts. A timer then draws the real state (the dialog closed, or the
  // next prompt up). Any key drops the wait.
  let cancelPush: (() => void) | undefined;
  const stopPush = () => {
    if (cancelPush) {
      cancelPush();
      cancelPush = undefined;
    }
  };
  const startPush = (): boolean => {
    const push = session.pendingPush;
    if (!push) return false;
    paint(push.doc, push.view);
    cancelPush = deps.setTimer(() => {
      cancelPush = undefined;
      session.pendingPush = null;
      draw();
      startExpiry();
    }, PUSH_FRAME_MS);
    return true;
  };

  // Ctrl-L pressed where the bar does not offer it says why, and the key changed
  // nothing else. The reason has served its purpose once it has been read, so it
  // stands for a moment and then goes rather than sitting in the bar describing
  // a keypress the user has long since moved on from.
  let cancelExpiry: (() => void) | undefined;
  const stopExpiry = () => {
    if (cancelExpiry) {
      cancelExpiry();
      cancelExpiry = undefined;
    }
  };
  const startExpiry = () => {
    if (!session.transientMessage) return;
    cancelExpiry = deps.setTimer(() => {
      cancelExpiry = undefined;
      session.expireMessage();
      draw();
    }, MESSAGE_LINGER_MS);
  };

  // The session re-highlights on every keystroke but defers the full parse;
  // run it once typing pauses so the structure tree and cross-references catch
  // up without making each keystroke pay for the whole-AST build.
  let cancelReparse: (() => void) | undefined;
  const scheduleReparse = () => {
    if (cancelReparse) {
      cancelReparse();
    }
    cancelReparse = deps.setTimer(() => {
      cancelReparse = undefined;
      session.reparse();
      draw();
    }, REPARSE_DEBOUNCE_MS);
  };

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      tty.setRaw(false);
    } catch { /* ignore */ }
    try {
      deps.write(
        `${term.disableMouse}${CSI}?7h${term.showCursor}` +
          (padBg ? term.resetDefaultBg : "") + term.leaveAltScreen,
      );
    } catch { /* ignore */ }
    try {
      tty.close();
    } catch { /* ignore */ }
  };

  const onResize = () => {
    const s = consoleSize(deps);
    stopReveal(); // the frames left were laid out for the old size
    stopExpiry();
    stopPush(); // the captured pushed frame was laid out for the old size
    session.resize(s.width, s.height);
    draw();
    // A message that takes itself away is still up after the redraw, so start
    // its clock again — the one just cancelled would have left it there for good.
    startExpiry();
  };
  const terminate = (code: number) => {
    cleanup();
    deps.exit(code);
  };
  // A SIGINT (Ctrl+C reaching us as a signal rather than the in-band 0x03 byte,
  // e.g. a forwarded interrupt) routes through the save prompt when there are
  // unsaved edits; the read loop then handles the y/n/c answer. A second
  // interrupt, or a clean buffer, terminates.
  const onInterrupt = () => {
    stopReveal();
    stopExpiry();
    stopPush();
    if (session.requestQuitFromSignal()) draw();
    else terminate(130);
  };
  const onTerminate = () => terminate(143);

  try {
    deps.addSignalListener("SIGWINCH", onResize);
  } catch { /* not on this platform */ }
  deps.addSignalListener("SIGINT", onInterrupt);
  deps.addSignalListener("SIGTERM", onTerminate);
  // A file opened in a language whose parser has not loaded is drawn as plain
  // text and starts the load; once it loads, parse the document again.
  const stopParserListener = deps.onGrammarLoad((failure) => {
    if (failure === undefined) {
      session.reparse({ force: true });
    } else {
      session.showMessage(`${failure} Its files are shown as plain text.`);
    }
    draw();
  });

  const buf = new Uint8Array(4096);
  let leftover: Uint8Array = new Uint8Array(0);
  try {
    tty.setRaw(true);
    deps.write(
      `${term.enterAltScreen}${term.enableMouse}${term.hideCursor}` +
        (padBg ? term.setDefaultBg(padBg) : ""),
    );
    draw();
    // Warm the TypeScript program after the first frame is on screen, while the
    // user is reading it and before any keypress arrives, so the first info card
    // does not pay the one-time build cost on the interactive path.
    if (semantics) deps.setTimer(() => semantics.prewarm(), 0);
    while (!session.quit) {
      const n = await tty.read(buf);
      if (n === null) {
        break;
      }
      const chunk = concat(leftover, buf.subarray(0, n));
      const { keys, rest } = decodeKeys(chunk);
      leftover = rest;
      // A partial key sequence has not changed the session. Keep any active
      // animation on screen while its remaining bytes arrive.
      if (keys.length === 0) continue;
      let pushStarted = false;
      for (const key of keys) {
        // A new key ends animations and short-lived messages left by the
        // previous key, including an earlier key decoded from this same read.
        stopReveal();
        stopExpiry();
        stopPush();
        pushStarted = false;
        session.handleKey(key, () => {
          // activateButton calls this after capturing the pushed frame and
          // before running the action, so a slow synchronous save leaves the
          // button visibly depressed for the duration of the work.
          pushStarted = startPush();
        });
        if (session.quit) break;
      }
      if (session.quit) {
        stopReveal();
        stopExpiry();
        // A committing button can set quit as its action. Its pressed frame is
        // already on screen. Hold it for the rest of the press moment before
        // tearing the screen down. A bare `q` exits at once.
        if (pushStarted) {
          stopPush();
          await deps.delay(PUSH_FRAME_MS);
        }
        break;
      }
      // A reveal or a button press draws its own frames, ending on the finished
      // one; otherwise draw the new state now.
      if (!startReveal() && !pushStarted) {
        draw();
        startExpiry(); // starts the clock on the message the draw put up
      }
      if (session.needsReparse) scheduleReparse();
    }
  } finally {
    stopParserListener();
    stopReveal();
    stopExpiry();
    stopPush();
    if (cancelReparse) {
      cancelReparse();
    }
    try {
      deps.removeSignalListener("SIGINT", onInterrupt);
      deps.removeSignalListener("SIGTERM", onTerminate);
      deps.removeSignalListener("SIGWINCH", onResize);
    } catch { /* ignore */ }
    cleanup();
  }
}

function consoleSize(deps: PagerDeps): { width: number; height: number } {
  try {
    const { columns, rows } = deps.consoleSize();
    if (columns > 0 && rows > 0) return { width: columns, height: rows };
  } catch { /* fall through to env / defaults */ }
  const envW = Number.parseInt(deps.env("COLUMNS") ?? "", 10);
  const envH = Number.parseInt(deps.env("LINES") ?? "", 10);
  return {
    width: Number.isFinite(envW) && envW > 0 ? envW : 80,
    height: Number.isFinite(envH) && envH > 0 ? envH : 24,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
