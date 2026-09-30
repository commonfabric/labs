/**
 * The one module that touches a terminal: raw mode, the bytes that arrive on
 * it, and the bytes shuttle sends back.
 *
 * Everything else in shuttle is a value and a decision about a value, which is
 * what lets the prompt loop, the verbs and the place all run with nothing
 * behind them. Keeping the terminal in one module is what that costs and what
 * it buys, and it is the architecture the view substrate this borrows from
 * already proves out.
 *
 * Raw mode is why the prompt exists at all: it is what stops the terminal
 * echoing and line-buffering, so that a keystroke reaches the line editor
 * instead of the editor the terminal driver would otherwise be.
 */

import { decodeKeys, type Key } from "../view/keys.ts";
import type { FrameCursor } from "./lens.ts";
import { ASSUMED_COLUMNS, ASSUMED_ROWS } from "./page.ts";
import {
  above,
  cursorIn,
  finish,
  givingScreen,
  NOTHING_PAINTED,
  type PaintedLine,
  repaint,
  screenOf,
  takingScreen,
} from "./paint.ts";
import type { PromptTerminal } from "./prompt.ts";

/** A frame on the screen: the rows drawn, and where a cursor stands on them. */
interface Frame {
  /** The whole frame, one row of the terminal each from the top. */
  readonly rows: readonly string[];

  /** Where a person is typing on it, and absent where nobody is. */
  readonly cursor: FrameCursor | undefined;
}

/** How many bytes one read off the keyboard takes at a time. */
const READ_SIZE = 1024;

/**
 * The key that runs a line, and the one key not carried out of a suspension:
 * what was typed at another program may appear in the next line and may not
 * submit it.
 */
const SUBMIT = "enter";

/**
 * The signals that end a run, and the status each one reports.
 *
 * A signal ends the process without unwinding, so the `finally` that takes the
 * terminal back out of raw mode never runs and the person is left at a
 * terminal that neither echoes nor edits. Handling these is what puts it back.
 *
 * Each status is the 128 the shell convention adds to a signal's own number,
 * so a caller reading `$?` learns which one arrived. `SIGKILL` and `SIGSTOP`
 * are absent because no process may bind them — the runtime refuses with
 * `Binding to signal 'SIGKILL' is not allowed` — and a terminal left raw by
 * one of those is what `reset` is for.
 */
const ENDING_SIGNALS = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGQUIT", 131],
  ["SIGTERM", 143],
] as const satisfies readonly (readonly [Deno.Signal, number])[];

/**
 * Runs `body` over the terminal on standard input and output, and returns what
 * it returned.
 *
 * Raw mode is entered before `body` and left after it, whatever `body` does,
 * because a terminal left in raw mode is one the person's next command cannot
 * be typed at. The same holds of the screen a full-screen view takes: it goes
 * back on the way out too, and for a stronger reason — a person left on an
 * alternate screen with a hidden cursor sees nothing of what they type. A
 * signal never reaches that `finally`, so the ways of ending a run that a
 * process may bind are listened for and put both back themselves
 * ({@link ENDING_SIGNALS}); the listening starts before raw mode does, so
 * there is no moment where either is held and nothing would let it go.
 *
 * @throws Error if standard input or standard output is not a terminal. Both
 * halves are needed and for different reasons: the keys are what a terminal in
 * raw mode delivers, and what goes back is escape sequences that redraw a line
 * where it stands — which a file or a pipe records rather than obeys, leaving
 * a saved cursor and a clear-to-end-of-screen written into it as text. A shell
 * that half works is worse than one that says what it needs, and reading or
 * writing somewhere other than a terminal has an answer of its own that this
 * is not: deterministic behavior off a terminal arrives with the scripting
 * bundle (`docs/plans/shuttle/futures.md`), and nothing here stands in for it.
 */
export async function withPromptTerminal<T>(
  body: (terminal: PromptTerminal) => Promise<T>,
): Promise<T> {
  const redirected = !Deno.stdin.isTerminal()
    ? "input"
    : !Deno.stdout.isTerminal()
    ? "output"
    : undefined;
  if (redirected !== undefined) {
    throw new Error(
      `Shuttle reads its lines off a terminal and draws them back onto one, ` +
        `and standard ${redirected} is not one. Run it from a terminal.`,
    );
  }
  // Built before the listeners so that they can put its screen back, and
  // before raw mode for the reason the listeners are: constructing one enters
  // no mode and takes no screen, so there is still no moment where something
  // is held and nothing would let it go.
  const terminal = new StandardTerminal();
  const restore = restorer(terminal);
  const listening = listenFor(restore);
  try {
    // Inside the `try` because the listeners are already on: raw mode failing
    // is a way this call can end, and every way it ends takes them off again.
    Deno.stdin.setRaw(true);
    return await body(terminal);
  } finally {
    restore();
    for (const [signal, handler] of listening) {
      try {
        Deno.removeSignalListener(signal, handler);
      } catch {
        // Nothing else can be done about a listener that will not come off,
        // and the run is already over.
      }
    }
  }
}

/**
 * Helper for {@link withPromptTerminal}, which is a function putting the
 * terminal back the way it was found — the screen a frame took, and then raw
 * mode — and doing so once however many times it is called.
 *
 * Two things call it and either may be first: a signal handler, and the run's
 * own way out. Once is what the terminal needs, and calling it again after the
 * process has begun to end is the case the memory is for.
 *
 * Both halves are here because a signal ends the process without unwinding,
 * so neither the prompt's own way out nor any `finally` under it runs. A
 * person signalled out of an open view would otherwise be left on an alternate
 * screen with a hidden cursor: their next command's output goes to a screen
 * that is thrown away, and nothing they type is drawn. Giving the screen back
 * writes out what was announced while the frame held it, so the record ends
 * where the run did.
 *
 * The screen goes back before the mode. Neither restoration needs the other,
 * so this is a convention rather than a dependency, and it is the one a
 * reader can hold the pair to: what the person is looking at, and then what
 * the terminal does with their keys.
 *
 * Each half swallows what it throws, because every caller is already on its
 * way out and a terminal that will not be put back is not a thing a message
 * about it could fix — and because the second half must run whatever the first
 * one did.
 */
function restorer(terminal: StandardTerminal): () => void {
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      // Before the screen goes back, because a program may be holding the
      // terminal — an editor a line opened — and nothing this object writes
      // goes out while one is. What that would cost here is the whole of what
      // a frame was holding back, since the suspension that would have written
      // it is not something a signal unwinds into.
      terminal.ending();
      terminal.unframe();
    } catch {
      // The terminal is gone, which is the other way of not holding a screen.
    }
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // The terminal is gone, which is the other way of not being raw.
    }
  };
}

/**
 * Helper for {@link withPromptTerminal}, which asks to hear about each of
 * {@link ENDING_SIGNALS} and returns the ones that are now listened for.
 *
 * A handler restores the terminal before it ends the process, and in that
 * order on purpose: the restore is the part that must happen, so nothing that
 * could throw is allowed to precede it. What is left after it — ending the
 * process — is allowed to throw, because by then the screen and the mode the
 * person's next command is typed at are both back.
 *
 * A signal the platform will not deliver is skipped rather than fatal: what it
 * costs is one way of ending that this run cannot restore from, and refusing
 * to start over it would cost every way.
 */
function listenFor(
  restore: () => void,
): readonly (readonly [Deno.Signal, () => void])[] {
  const listening: (readonly [Deno.Signal, () => void])[] = [];
  for (const [signal, status] of ENDING_SIGNALS) {
    const handler = () => {
      restore();
      Deno.exit(status);
    };
    try {
      Deno.addSignalListener(signal, handler);
      listening.push([signal, handler]);
    } catch {
      // Not a signal this platform delivers.
    }
  }
  return listening;
}

/**
 * The prompt's terminal, over standard input and standard output.
 *
 * It writes synchronously, which is what keeps a line and what it produced in
 * the order they happened rather than in the order two writes settled.
 */
class StandardTerminal implements PromptTerminal {
  #painted: PaintedLine = NOTHING_PAINTED;
  #encoder = new TextEncoder();

  /**
   * Pending exactly while a program holds the terminal, and absent otherwise.
   *
   * It is one field for both halves of holding it, which is what keeps them
   * from parting: the reader awaits it before every read, and every write
   * checks it, so a program that has the terminal has all of it.
   */
  #held: Promise<void> | undefined;

  /**
   * The frame as its composer last drew it, and absent where no frame has the
   * screen.
   *
   * One field for both, because they are one state: a frame has the screen
   * exactly as long as there is a frame to draw. Two would admit the pair that
   * says a frame holds the screen and there is nothing to draw on it, which is
   * a state the restore below would have to answer for and no caller can
   * reach.
   *
   * It is kept as well as sent because the screen a frame holds can be taken
   * from it: a program this prompt hands the terminal to draws where it likes,
   * and what puts the frame back afterwards is drawing it again
   * ({@link StandardTerminal.suspend}).
   */
  #frame: Frame | undefined;

  /** Ends {@link StandardTerminal.#held}, held by the suspension that made it. */
  #release: (() => void) | undefined;

  /**
   * The lines announced while a frame had the screen, in the order they
   * arrived, and empty otherwise.
   *
   * They are kept rather than dropped, on the reasoning
   * {@link StandardTerminal.suspend} carries out keys typed at another
   * program: a line that appears somewhere is one a person can read, and a
   * dropped one is invisible. What a frame differs in is that this terminal
   * knows exactly when the screen comes back, so nothing is lost rather than
   * merely delayed.
   */
  #waiting: string[] = [];

  #keys = typedKeys(() => this.#held);

  /**
   * The keys typed on standard input — one stream for the life of the
   * instance, because two readers of one keyboard would each take some of
   * the keys and neither would see them all.
   */
  get keys(): AsyncIterable<Key> {
    return this.#keys;
  }

  /**
   * @inheritDoc
   *
   * What was drawn is recorded only where it was sent. A line edited while a
   * frame holds the screen reaches no screen, and the screen the frame gives
   * back still carries the line drawn before it, which is the line the next
   * drawing is measured against.
   */
  edit(text: string, column: number): void {
    const line = { text, column, columns: this.#columns() };
    if (this.#send(repaint(this.#painted, line))) this.#painted = line;
  }

  /**
   * @inheritDoc
   *
   * An ending is recorded only where it was sent, for the reason
   * {@link StandardTerminal.edit} gives.
   */
  finish(): void {
    if (this.#send(finish(this.#painted))) this.#painted = NOTHING_PAINTED;
  }

  /**
   * @inheritDoc
   *
   * The line stays as it was drawn, because what is written above it is
   * written above it: the drawing is composed against the same width and the
   * same cursor it already carries, so a run of these leaves one transcript
   * with the line being typed at the bottom of it.
   */
  announce(text: string): void {
    if (this.#frame !== undefined) {
      this.#waiting.push(text);
      return;
    }
    this.#send(above(this.#painted, text));
  }

  /**
   * @inheritDoc
   *
   * The screen is taken on the first call, so a redraw is a redraw rather than
   * a second taking: entering the alternate screen twice would save the
   * transcript's position over itself and leave nothing to go back to.
   *
   * It is held until {@link StandardTerminal.unframe} but for one stretch:
   * {@link StandardTerminal.suspend} gives it back to a program and takes it
   * again afterwards, a terminal keeping no stack of alternate screens. The
   * frame is this object's throughout, which is why what was drawn is kept and
   * drawn again rather than taken a second time from nothing.
   */
  frame(rows: readonly string[], cursor?: FrameCursor): void {
    // Held before it is taken, and the order is what a signal turns on: the
    // handler that restores runs from inside the write below, and a frame this
    // object does not yet call its own is one that handler gives nothing back
    // for — leaving the alternate screen held by a process that has ended.
    const taking = this.#frame === undefined;
    const drawn = { rows, cursor };
    this.#frame = drawn;
    if (taking) this.#write(takingScreen());
    this.#paint(drawn);
  }

  /**
   * @inheritDoc
   *
   * What was drawn before the frame is kept. Giving the alternate screen back
   * restores the cursor the terminal saved on taking it, which is where the
   * last drawing left it, and nothing reaches this screen while the frame
   * holds it ({@link StandardTerminal.edit}): the line last drawn is still the
   * line under the cursor, and the next drawing repaints it as any drawing
   * repaints the one before, climbing to its first row. A suspension is where
   * that differs, another program having drawn on this screen in between.
   *
   * What the frame was holding back is written here, except where a program
   * holds the terminal: nothing sent then arrives, so those lines wait for
   * {@link StandardTerminal.suspend} to let the hold go rather than being
   * written into a drop.
   */
  unframe(): void {
    if (this.#frame === undefined) return;
    this.#frame = undefined;
    this.#write(givingScreen());
    // Held back again where a program has the terminal, rather than written
    // into a write that is dropped. Those lines are a run's record, and a
    // frame given up during a suspension — which a key typed behind the one
    // that started the program does — would otherwise take the whole of what
    // it was holding with it. {@link StandardTerminal.suspend} is where they
    // land instead.
    if (this.#held === undefined) this.#flush();
  }

  /**
   * Lets go of a hold on the way out of the process.
   *
   * A suspension ends by giving the terminal back and writing what the frame
   * was holding, and a signal reaches neither: the handler restores what it can
   * and ends the process, so nothing unwinds. The hold outlives nothing but
   * this call, and dropping it here is what lets the restore that follows write
   * at all — which is the last chance the lines a frame was holding get.
   */
  ending(): void {
    this.#held = undefined;
    this.#release?.();
    this.#release = undefined;
    // What a frame was holding, where the frame is already gone. A key typed
    // behind the one that started the program closes the view while the
    // terminal is held, and the giving-up that would have written those lines
    // was dropped like every write during a hold — so nothing after this would
    // write them either: {@link StandardTerminal.unframe} has no frame left to
    // answer for, and the suspension that would have flushed them is not
    // something a signal unwinds into. Where a frame is still up, the restore
    // that follows this is what writes them, and flushing here would only put
    // them back where they are.
    if (this.#frame === undefined) this.#flush();
  }

  /**
   * Helper for the two that stop holding lines back, which writes what a frame
   * kept while it had the screen.
   *
   * It goes through {@link StandardTerminal.announce}, so a line written this
   * way is written exactly as one that never waited: the same glyphing, and
   * above the same line being edited.
   */
  #flush(): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const text of waiting) this.announce(text);
  }

  /**
   * @inheritDoc
   *
   * Raw mode is what the prompt has and what the program taking over must not:
   * it stops the terminal echoing and line buffering, and a full-screen editor
   * sets whatever mode it wants for itself. So it comes off before `body` and
   * goes back on after, whatever `body` did, because a prompt reading a cooked
   * terminal reads nothing until a whole line has been typed.
   *
   * Raw mode is the smaller half. The larger one is that this prompt reads
   * nothing and draws nothing for as long as `body` runs: the key loop issues
   * no read while the terminal is held, so what is typed stays on the stream
   * for the program to read, and every write is dropped, so nothing of this
   * prompt's appears under a screen the program is drawing.
   *
   * What it cannot take back is a read already in flight when `body` started.
   * `Deno.stdin.read` takes no signal, so that read finishes and its bytes
   * leave the stream whatever this does — most often catching the first key
   * typed at the program, which is then a key the program never sees. Where
   * they go is what is decided here: they are carried out of the suspension
   * into the next line rather than dropped, a keystroke that appears
   * somewhere being one a person can act on where a dropped one is invisible.
   * The submit is held back, so such a key may appear in a line and may never
   * run one.
   *
   * The line drawn before the trip is forgotten and a frame is not, and the
   * asymmetry is what each of them is. The program had the screen and may
   * have left anything on it, so where the last line was drawn says nothing
   * about where the cursor is now; drawing the next line as a repaint of that
   * one would clear whatever the program left above it. Forgetting leaves the
   * next drawing an ordinary first one, written where the cursor stands.
   *
   * A frame is the whole screen rather than a line on it, so it is neither
   * forgotten nor repainted over what the program left: the alternate screen
   * goes back before the program and is taken again after, and what the
   * program drew leaves with the screen it was drawn on. The frame is then
   * drawn again from what it was last given, which is why it is kept
   * ({@link StandardTerminal.#frame}). Whether it is taken back is decided on
   * the way out rather than remembered from the way in, because a frame can be
   * given up while the program runs.
   */
  async suspend<T>(body: () => Promise<T>): Promise<T> {
    // The alternate screen is given back before the program and taken again
    // after it, where a frame is holding one. A terminal keeps no stack of
    // alternate screens: a program that takes one and leaves it — which is
    // what a full-screen editor does — leaves this terminal on its primary
    // screen, where the transcript is. The frame is still this object's as far
    // as it knows, so the next drawing would paint over that transcript, which
    // is the one thing taking the screen exists to prevent. Written before the
    // hold rather than inside it, because nothing this object draws goes out
    // while the terminal is held.
    if (this.#frame !== undefined) this.#write(givingScreen());
    this.#held = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    Deno.stdin.setRaw(false);
    try {
      return await body();
    } finally {
      // The order is what the property needs: raw mode back first, then the
      // screen, then the reader let go, so the loop that wakes reads a terminal
      // in the mode it expects rather than one still cooked, and finds the
      // frame where it left it.
      Deno.stdin.setRaw(true);
      this.#painted = NOTHING_PAINTED;
      this.#held = undefined;
      // Asked again rather than remembered from before the program, because a
      // frame can be given up while one is running: keys already decoded out of
      // one read go on reaching the prompt during the hold, so a `q` typed
      // behind the key that started the editor closes the view from under it.
      // A frame taken back on a remembered answer would be an alternate screen
      // nothing is drawing on and nothing will leave, the `unframe` that would
      // have left it having been dropped as every write is.
      const frame = this.#frame;
      if (frame !== undefined) {
        // Taken and drawn in one, rather than left blank for whatever comes
        // next to repaint: what comes next is a verb settling, which can be a
        // write to a server away, and an empty screen for the length of one is
        // a frame a reader watches disappear.
        this.#write(takingScreen());
        this.#paint(frame);
      } else {
        // What the frame was holding back, where it stopped holding the screen
        // while this program had it: the writing that gives it up is dropped
        // like every other, so the lines it would have flushed are still here
        // and this is the first moment they can land.
        this.#flush();
      }
      this.#release?.();
      this.#release = undefined;
    }
  }

  /** Helper for the two that draw a frame, which sends `frame` to the screen. */
  #paint(frame: Frame): void {
    this.#write(`${screenOf(frame.rows)}${cursorIn(frame.cursor)}`);
  }

  /**
   * Helper for the writes, which is how wide the terminal is.
   *
   * It is asked per drawing rather than once, so a window resized between two
   * keystrokes is drawn at the width it has now.
   */
  #columns(): number {
    return consoleColumns();
  }

  /**
   * Helper for the three writes that draw the line being edited, which sends
   * `text` where a frame is not holding the screen, and is whether it did.
   *
   * It is the one check rather than one per write, so those three cannot
   * drift from each other about what a frame means. The answer is what keeps a
   * write's record of what was drawn in step with what was sent: a drawing a
   * frame held back changed nothing on the screen the frame gives back. What a
   * frame does with a line written above the prompt is
   * {@link StandardTerminal.announce}'s decision and a different one: it is
   * kept, where a drawing of a line that is not on screen has nothing to be
   * kept for.
   */
  #send(text: string): boolean {
    if (this.#frame !== undefined) return false;
    this.#write(text);
    return true;
  }

  /**
   * Helper for the writes, which sends the whole of `text` to the terminal.
   *
   * A write is allowed to accept part of what it is offered, so what is left
   * is offered again until none is: a drawing that went out in pieces would
   * be escape sequences cut in half, and half a sequence is text on the
   * screen. This is `lib/view/mod.ts`'s `writeAllSync` in the module that
   * needs it, as `lib/view/filegateway.ts` also keeps one.
   *
   * @throws Error if a write accepts nothing at all, which no number of
   * further attempts would improve on.
   */
  #write(text: string): void {
    // Nothing is drawn while a program holds the terminal. It is the one check
    // rather than one per write, so nothing this class draws — the line being
    // edited, or a frame — can drift from the rest about what holding the
    // terminal means.
    if (this.#held !== undefined) return;
    const bytes = this.#encoder.encode(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = Deno.stdout.writeSync(bytes.subarray(offset));
      if (written <= 0) {
        throw new Error("The terminal accepted none of what shuttle wrote.");
      }
      offset += written;
    }
  }
}

/**
 * How wide the terminal is: what it says, then `COLUMNS`, then an assumption.
 *
 * It is what a drawing is composed against, since a line wider than the
 * terminal occupies more rows than one and the redrawing has to know how many.
 */
export function consoleColumns(): number {
  return measured(
    (size) => size.columns,
    "COLUMNS",
    ASSUMED_COLUMNS,
  );
}

/**
 * How tall the terminal is: what it says, then `LINES`, then an assumption.
 *
 * It is what a page is bounded by (`page.ts`), so that a listing of a
 * populated space leaves the prompt and the rows above it on the screen. The
 * environment variable is `LINES`, which is the name the shell exports the
 * height under beside the `COLUMNS` the width goes by.
 */
export function consoleRows(): number {
  return measured((size) => size.rows, "LINES", ASSUMED_ROWS);
}

/**
 * Helper for the two above, which is the dimension `pick` reads: what the
 * terminal says, then what `variable` declares, then `assumed`.
 *
 * The three sources are the ones the pager (`lib/view/pager.ts`) asks in that
 * order, and a dimension is taken only where it is a finite count above zero,
 * so a terminal reporting none — which one that cannot measure itself does —
 * leads to the next source rather than into arithmetic over it. Each
 * dimension is decided on its own here, where the pager decides both on the
 * pair: a terminal answering with one usable dimension and one zero gives the
 * width from itself and the height from the environment, rather than both
 * from the environment.
 */
function measured(
  pick: (size: { columns: number; rows: number }) => number,
  variable: string,
  assumed: number,
): number {
  try {
    const measurement = pick(Deno.consoleSize());
    if (Number.isFinite(measurement) && measurement > 0) return measurement;
  } catch {
    // A terminal that will not answer is one of the ways of not knowing,
    // and the sources below are the rest.
  }
  const declared = Number.parseInt(Deno.env.get(variable) ?? "", 10);
  return Number.isFinite(declared) && declared > 0 ? declared : assumed;
}

/**
 * Helper for {@link StandardTerminal}, which is the keys typed on standard
 * input, ending when it does.
 *
 * The decoder is incremental: an escape sequence split across two reads leaves
 * its first bytes unconsumed, and they open the next read's bytes rather than
 * being decoded as the keys they are not.
 *
 * Nothing is read while a program holds the terminal, which is what leaves the
 * keys typed at it on the stream for it to read. That is
 * {@link readWhenFree}'s to keep rather than this loop's, because keeping it
 * is a question of what may sit between the ask and the read, and a loop is
 * exactly where something sits.
 */
async function* typedKeys(
  held: () => Promise<void> | undefined,
): AsyncGenerator<Key> {
  const buffer = new Uint8Array(READ_SIZE);
  let rest: Uint8Array = new Uint8Array(0);
  while (true) {
    const read = await readWhenFree(held, buffer);
    if (read === null) return;
    const arrived = new Uint8Array(rest.length + read);
    arrived.set(rest);
    arrived.set(buffer.subarray(0, read), rest.length);
    const decoded = decodeKeys(arrived);
    rest = decoded.rest;
    const during = held();
    if (during !== undefined) {
      // A read already in flight when the program took over is the one thing
      // holding the terminal cannot take back: `Deno.stdin.read` takes no
      // signal, so it finishes and its bytes leave the stream whatever this
      // does — most often catching the first key typed at the program, which
      // is then a key the program never sees.
      //
      // Where they go is decided here, and they are kept rather than dropped.
      // Dropping loses a keystroke with nothing to show for it, and a person
      // cannot tell that it happened; kept, it lands in the next line where it
      // can be seen and erased. The submit is the one key not kept, because it
      // is the one that would act rather than appear — so what was typed at
      // another program may reach the next line as text and may never run one.
      await during;
      yield* decoded.keys.filter((key) => key.name !== SUBMIT);
      continue;
    }
    yield* decoded.keys;
  }
}

/**
 * Helper for {@link typedKeys}, which is one read of standard input, issued
 * only from a turn in which nothing holds the terminal.
 *
 * A reader that asks whether it may read and then reads on the way back from
 * an `await` has asked a question whose answer expired: the terminal was free
 * when it was told so and a program had it by the time it read. That is the
 * rule {@link guarded} (`verbs.ts`) keeps for the same reason, and it is kept
 * the same way — the ask and the read stand in one turn with nothing awaited
 * between them, so no suspension can begin after the decision and before the
 * call. The waiting is on the other arm, and the ask is made again after it.
 *
 * The property that follows is the one the prompt owes a program it started:
 * from the moment a program holds the terminal, no read is issued at all, so
 * what is typed at it stays on the stream for it to read. The one read this
 * cannot promise anything about is the one already in flight, which
 * {@link StandardTerminal.suspend} accounts for.
 */
async function readWhenFree(
  held: () => Promise<void> | undefined,
  buffer: Uint8Array,
): Promise<number | null> {
  while (true) {
    const during = held();
    if (during === undefined) return await Deno.stdin.read(buffer);
    await during;
  }
}
