/**
 * The prompt: a line read off the keyboard, handed to the dispatch, and its
 * outcome written above the line being typed next.
 *
 * This is where a run's output comes from. A verb returns what it did rather
 * than writing it, so everything a line puts on screen passes through here, in
 * the order the person caused it — which is what makes a transcript a record of
 * cause and effect rather than of whatever reached the terminal first. The one
 * thing shuttle writes outside this loop is the entry's own report of a run
 * that could not start.
 *
 * It is an event loop rather than a read-then-run: the keys are read
 * continuously and a running line is a task beside them, so a line that is
 * waiting on a server holds up neither the keyboard nor the screen. Two things
 * follow, and they are the whole reason for the shape. `ctrl-c` reaches a line
 * that is already running, which is the only way a shell whose server has gone
 * quiet is still a shell. And a key typed during that wait is drawn as it
 * arrives instead of being queued unseen and run blind afterwards. A `tab`
 * that reads is a second thing that runs beside the keys, and it runs beside
 * them the same way and under the same cancel.
 *
 * The line editor is the view substrate's rather than `node:readline`'s.
 * `EditBuffer` (`lib/view/editbuffer.ts`) holds the motions and `decodeKeys`
 * (`lib/view/keys.ts`) supplies the keys, so the bindings are a table — a
 * value, which a second table can stand beside. The table is `editing.ts`'s
 * rather than this module's, because a view's command line reads the same one
 * (`lens.ts`): a binding added to either is added to both.
 * `node:readline` has no supported place for one: the module exports an
 * interface, three cursor helpers and a keypress decoder, and that interface's
 * prototype carries one public method, `question()` — everything else on it,
 * the key dispatch `_ttyWrite` among them, is underscore-prefixed. A second
 * table behind it means replacing one of those, and the exported half that
 * would have helped, the keypress decoder, is the job `decodeKeys` already
 * does.
 *
 * Nothing here touches a terminal either: the keys arrive as decoded keys and
 * the writing goes through {@link PromptTerminal}, so a case drives the whole
 * loop with a scripted key stream and reads back what it produced.
 */

import { EditBuffer } from "../view/editbuffer.ts";
import type { Key } from "../view/keys.ts";
import { completeLine } from "./completion.ts";
import { apply, codePoints } from "./editing.ts";
import { LineHistory, recall } from "./history.ts";
import type { FrameCursor, ValueLens } from "./lens.ts";
import { ASSUMED_COLUMNS, ASSUMED_ROWS } from "./page.ts";
import { escapeControlCharacters, messageOf } from "./place.ts";
import { renderValue } from "./value.ts";
import { runLine } from "./verbs.ts";
import {
  measured,
  type Outcome,
  type Shuttle,
  type VerbDeps,
} from "./vocabulary.ts";

/** What the prompt opens every line with, before the place it carries. */
const PROMPT_NAME = "shuttle";

/**
 * What a line typed at a frame is told when it opened a view of its own.
 *
 * The line ran and is not taken back — a `watch` typed at a frame leaves a
 * watch armed, which `watches` lists and `unwatch` disarms. What it did not
 * get is the screen, one frame being what the prompt draws at a time.
 */
const ONE_FRAME = "One frame at a time, so this line's view was not opened.";

/** What a line that was cancelled leaves behind it. */
const INTERRUPTED = "Interrupted.";

/**
 * Where the prompt reads its keys and writes what it has to write.
 *
 * The three writes are different acts and not one. {@link PromptTerminal.edit}
 * shows a line that is still being typed, and may be called any number of
 * times for one line; {@link PromptTerminal.finish} ends that line, once; and
 * {@link PromptTerminal.announce} puts a line above the one being typed, which
 * is where everything a run has to say lands, whether or not a line is in
 * flight when it is said.
 */
export interface PromptTerminal {
  /**
   * The keys the person typed, in order, ending when their input does — which
   * ends the run.
   */
  readonly keys: AsyncIterable<Key>;

  /**
   * Shows `text` as the line being edited, with the cursor `column` code
   * points into it. Both are the whole line, prompt included, because where
   * the prompt ends and the typing begins is nothing a terminal needs to know.
   *
   * The count is an index into `text` rather than a place on the screen, so
   * an implementation that draws on one works out where those code points put
   * the cursor — `paint.ts` is where the one this package uses does it.
   */
  edit(text: string, column: number): void;

  /** Ends the line being edited, leaving it where it was shown. */
  finish(): void;

  /**
   * Writes `text` above the line being edited, and draws that line again
   * beneath it.
   *
   * This is the out-of-band line, and it is one door with three producers: a
   * line's own outcome, written when the line settles rather than when it was
   * typed; the runtime's console and the warnings a connection writes for
   * itself (`announce.ts`); and, when watches arrive, an event line per
   * settled change. What the last two carry is a user program's own output,
   * which passed no door of shuttle's, so an implementation holds `text` to
   * the class a terminal acts on before any of it is sent — `above`
   * (`paint.ts`) is where the one this package uses does it. A line feed in
   * `text` is a row, and every other character of that class is shown as the
   * glyph naming it.
   */
  announce(text: string): void;

  /**
   * Draws `rows` as a full-screen frame, one row of the terminal each from the
   * top, taking the screen over on the first call and holding it until
   * {@link PromptTerminal.unframe}.
   *
   * Taking the screen is what keeps the transcript append-only: a frame is
   * drawn somewhere else, so nothing already written scrolls or is rewritten
   * while one is up, and giving the screen back puts the transcript on screen
   * as the frame found it.
   *
   * `rows` is the whole frame, already fitted to the terminal by whatever
   * composed it (`lens.ts`), so an implementation places the rows and decides
   * nothing about what is in them.
   *
   * `cursor` is where in the frame a person is typing, and is absent where
   * nobody is: a frame with a command line open on it is typed at, and one
   * without is read. An implementation shows the cursor there and hides it
   * otherwise, which is what stops a frame that is only read from carrying a
   * cursor that reads as a place to type.
   */
  frame(rows: readonly string[], cursor?: FrameCursor): void;

  /**
   * Gives the screen back, and writes whatever {@link PromptTerminal.announce}
   * was handed while the frame held it. Where no frame has the screen it does
   * nothing, so a caller putting a terminal back on its way out needs no test
   * in front of it.
   *
   * Those lines are kept rather than dropped, because a run's out-of-band
   * writing is a record: a pattern's console output and an armed watch's event
   * lines go on arriving while a frame is up, and a transcript missing them
   * would be missing exactly the changes a person opened the frame to watch.
   * Kept is the promise rather than written here: an implementation that hands
   * the terminal to a program ({@link PromptTerminal.suspend}) can reach no
   * screen while it does, and owes those lines when it can write again.
   */
  unframe(): void;

  /**
   * Runs `body` with the terminal handed over to whatever it starts, and is
   * what `body` answered.
   *
   * It is for the one thing shuttle does that is not shuttle drawing: a
   * person's own editor, which draws a whole screen of its own and reads the
   * keyboard on its own terms. Everything the prompt holds the terminal in for
   * its own drawing has to come off around such a program and go back on
   * after, whatever the program did, and only what opened the terminal knows
   * what it is holding.
   *
   * A line drawn before is not drawn again on the way out. The program had the
   * screen, so the next line is drawn where the cursor stands rather than over
   * a line that may no longer be there.
   *
   * A frame is the exception, and it is one because a frame is the whole
   * screen rather than a line on it. An implementation that has one gives the
   * screen back before the program and takes it again after, and draws the
   * frame again on the screen it took — so what the program left goes with the
   * screen it was drawn on, and the frame a reader was looking at is the frame
   * they get back.
   */
  suspend<T>(body: () => Promise<T>): Promise<T>;
}

/**
 * Reads lines against `shuttle` until `terminal` runs out of keys, and returns
 * once it has and once the line it was running has settled.
 *
 * Every line goes to `runLine`, and what comes back is written above the line
 * being typed next: text a verb composed, a value the fabric holds, or the
 * reason a line was refused. A read that failed reaches here as a throw rather
 * than as an outcome, and is written the same way — the difference the seam
 * draws is that a shell whose server went away is still a shell, so this
 * reports it and reads the next line where a one-shot command would exit.
 *
 * One line runs at a time, and the keys keep arriving while it does. Four
 * keys mean something other than editing:
 *
 * - `enter` runs the line. Pressed while a line is in flight it is held,
 *   along with every key after it, and the held keys are replayed the moment
 *   the prompt is free — so a pasted script runs line by line, each against
 *   the place the line before it settled on, and nothing runs against a
 *   prompt that has already moved.
 * - `ctrl-d` on an empty line ends the run, which is the end-of-input every
 *   shell spells that way, and on a line with anything on it deletes forward
 *   instead. On an empty line while a line is in flight it is held, as
 *   `enter` is.
 * - `ctrl-c` cancels: the work in flight, or the line being typed where none
 *   is. It is never held, and it drops what was typed ahead of it, which is
 *   what a terminal does with type-ahead when the interrupt arrives.
 * - `tab` completes the token the line ends in (`completion.ts`), which is a
 *   read and therefore work in flight of its own: `enter` typed under one is
 *   held as it is under a line, and `ctrl-c` cancels it. It acts only at a
 *   prompt with no line in flight, since a line that is running is one that
 *   may be about to move the place a completion reads against, and only with
 *   the cursor at the end of the line.
 *
 * `up` and `down` are ordinary bindings rather than any of those: they walk
 * the lines this run typed (`history.ts`), which is a value the prompt holds
 * beside the line being edited and nothing reads.
 *
 * A line may open a **lens** instead of settling into text — the full-screen
 * value view `watch` opens (`lens.ts`). While one is up it has the keyboard
 * and the screen: every key goes to it, the line being typed is neither drawn
 * nor added to, and a line typed ahead of the frame waits for the prompt to
 * come back. Which key closes it is the lens's own decision, and closing it
 * gives the screen back and draws the prompt where it stood. It is a state of
 * this loop rather than a program beside it because the keys are read here:
 * one asked for is one a verb of its own could not have.
 *
 * A lens may ask for a line of its own — what `:` and `e` type at a frame —
 * and it runs here, through the same {@link start} a line typed at the prompt
 * runs through and under the same cancel. So one line is in flight at a time
 * whichever of the two took it, and what it produced goes to the transcript
 * the way every line's output does; the frame is told as well, and says so
 * until something replaces it. A line that opened a view of its own arrives
 * while one is up, and there its view is closed rather than adopted: one frame
 * at a time, the line itself standing.
 *
 * Cancelling is honest about what it can reach. The line is abandoned and the
 * prompt comes back, but a read already sent to the server is not something
 * this can call off: it finishes into nothing, and the checks along the way
 * are what stop it taking effect — a `cd` cancelled after its read returned
 * does not move (`verbs.ts`).
 */
export async function runPrompt(
  shuttle: Shuttle,
  terminal: PromptTerminal,
  deps: VerbDeps = {},
): Promise<void> {
  const buffer = new EditBuffer("");
  const history = new LineHistory();
  let prompt = promptFor(shuttle);
  const show = () =>
    terminal.edit(
      `${prompt}${buffer.text()}`,
      codePoints(prompt) + buffer.col,
    );
  show();

  const keys = terminal.keys[Symbol.asyncIterator]();
  /** The key stream's next answer, once asked for and until it is used. */
  let typing: Promise<Arrival> | undefined;
  /** The line in flight, and the whole of what may cancel it. */
  let running: Running | undefined;
  /** The lens holding the screen, while one is open. */
  let lens: ValueLens | undefined;
  /** Keys read while a line was in flight, from the first line-ender on. */
  let held: Key[] = [];
  /** Whether the keys have run out, which ends the run once nothing is left. */
  let ended = false;

  /**
   * Draws `opened` at the size the screen has now, cursor and all.
   *
   * The size is asked for on every drawing rather than held, so a window
   * resized under an open lens is redrawn to fit it.
   */
  const draw = (opened: ValueLens): void => {
    const rows = measured(deps.rows?.(), ASSUMED_ROWS);
    const columns = measured(deps.columns?.(), ASSUMED_COLUMNS);
    terminal.frame(opened.frame(rows, columns), opened.cursor(rows, columns));
  };

  /**
   * Closes the lens and comes back to the prompt, which is what `q` does and
   * what the end of the keys does to a lens no key can now close.
   */
  const closeLens = (): void => {
    lens?.close();
    lens = undefined;
    terminal.unframe();
    prompt = promptFor(shuttle);
    show();
  };

  /** Acts on `key` at a prompt with no line in flight. */
  const act = (key: Key): void => {
    if (key.name === "ctrl-c") {
      terminal.finish();
      buffer.setText("");
      history.abandon();
    } else if (key.name === "tab") {
      // Only at the end of the line, and nothing is drawn either way. The
      // token a completion finishes is the one the line ends in, so a cursor
      // standing anywhere else is standing in a token this would not be
      // completing — and a line unchanged is a line already on the screen.
      // Both sides of the test are the buffer's own count, which is where the
      // cursor is in the line rather than where it lands on the screen.
      if (buffer.col === buffer.currentLineLength()) {
        running = startCompleting(buffer.text(), shuttle, deps);
      }
      return;
    } else if (endsLine(key, buffer)) {
      if (key.name === "ctrl-d") {
        ended = true;
        held = [];
        return;
      }
      const line = buffer.text();
      terminal.finish();
      buffer.setText("");
      // Recorded where the line is taken rather than where it settles, which
      // is what puts a line still running under the first `up`.
      history.record(line);
      running = start(line, shuttle, deps);
      // Nothing is drawn: the prompt for the next line appears when the line
      // settles, or when a key is typed before it does, so a line that
      // answers before anyone types looks exactly as it did when the loop
      // waited for it.
      return;
    } else {
      apply({ buffer, history }, key);
    }
    show();
  };

  try {
    while (
      !(ended && running === undefined && lens === undefined &&
        held.length === 0)
    ) {
      // A lens is closed by a key, and there are no more keys. Closing it here
      // is what stops a run ending with the screen still held.
      if (ended && lens !== undefined) {
        closeLens();
        continue;
      }
      if (running === undefined && lens === undefined && held.length > 0) {
        act(held.shift()!);
        continue;
      }
      if (!ended) typing ??= nextKey(keys);
      const arrival = await (
        ended
          ? running!.settled
          : running === undefined
          ? typing!
          : Promise.race([typing!, running.settled])
      );
      if (arrival.kind === "ran") {
        running = undefined;
        if (arrival.text !== "") terminal.announce(arrival.text);
        if (lens !== undefined) {
          // The line was typed at a frame that still has the screen, so the
          // prompt under it is not what comes next: the frame acknowledges the
          // line, and the whole of what it said is in the transcript the frame
          // is holding back.
          lens.answered(arrival.text);
          continue;
        }
        // After the line, not before it: `cd` is what moves the place, so the
        // prompt a line is typed at is the place it was read against.
        prompt = promptFor(shuttle);
        show();
        continue;
      }
      if (arrival.kind === "lens") {
        running = undefined;
        // Taken before anything that can throw, because it arrives already
        // holding a subscription: a lens this loop is not holding is one the
        // way out cannot close, and its sink would run for the rest of the
        // process with no frame on screen to say it is there.
        const opened = arrival.lens;
        if (lens !== undefined) {
          // One frame at a time. A line typed at a frame can be any line, and
          // one of them opens a view — so this is the arm where a second
          // arrives, and what it must not do is leave a subscription running
          // with no frame to draw it. The line itself ran and said what it
          // did; only its view is turned down, and the frame that is up says
          // so.
          opened.close();
          if (arrival.text !== "") terminal.announce(arrival.text);
          terminal.announce(ONE_FRAME);
          lens.answered(ONE_FRAME);
          continue;
        }
        lens = opened;
        // What the line produced is written before the frame takes the screen,
        // which is the order it happened in: the verb armed the watch and said
        // what is armed, and the lens opened onto it. Written after, it would
        // reach the transcript below the changes the frame was up for.
        if (arrival.text !== "") terminal.announce(arrival.text);
        // The frame is composed at the size the screen has each time it is
        // drawn, so a window resized under an open lens is redrawn to fit it.
        opened.drawnThrough(() => draw(opened));
        continue;
      }
      if (arrival.kind === "completed") {
        running = undefined;
        // Onto the line it was computed for and onto no other. A read cannot be
        // called off once sent, so what it answers may reach a line that has
        // moved on — a key typed while it was out, or a `ctrl-c` that emptied
        // it — and writing there would take back a character the person typed
        // after the `tab`.
        if (buffer.text() === arrival.from) recall(buffer, arrival.line);
        show();
        continue;
      }
      typing = undefined;
      if (arrival.step.done) {
        ended = true;
        continue;
      }
      const key = arrival.step.value;
      if (lens !== undefined) {
        // Every key goes to the lens while one is open, which is what makes it
        // full-screen: the line under it is not being typed at, so a key that
        // the lens does not take does nothing rather than editing something
        // nobody can see. What a key does to the frame is the lens's decision
        // and not this loop's, which is what keeps every key but one a rule
        // made where the keys are read.
        //
        // `ctrl-c` is the one, because it can mean three things and only two of
        // them are the frame's: abandoning what is being typed at it, and the
        // way out where nothing is. The third is stopping the line the frame
        // asked for, which this loop holds. Innermost first, which is the order
        // the prompt already takes — so a frame with nothing being typed at it
        // and a line in flight stops the line, and the frame stays up.
        //
        // A line already told to stop is not a line to stop again. The cancel
        // reaches the work through a signal and the outcome arrives some awaits
        // later, so a second `ctrl-c` typed in that window would find the line
        // still in flight and stop it twice, leaving the frame up. What a
        // person pressing it twice is asking for is the way out, which is what
        // the lens gives it once this arm declines.
        if (
          key.name === "ctrl-c" && !lens.typing && running !== undefined &&
          !running.stopped()
        ) {
          running.stop();
          held = [];
          buffer.setText("");
          history.abandon();
          continue;
        }
        lens.reads(key);
        if (key.name === "ctrl-c") {
          // What a `ctrl-c` drops is what was typed ahead of it, here as at the
          // prompt: a person who pressed it to leave the frame did not mean to
          // run whatever they had queued behind it.
          held = [];
          buffer.setText("");
          history.abandon();
        }
        if (!lens.open) {
          closeLens();
          continue;
        }
        // A line the frame asked for runs the way a line typed at the prompt
        // runs: the same start, the same signal, the same cancel. What differs
        // is where its answer lands, which is the `ran` arm above.
        const asked = lens.asked();
        if (asked !== undefined) running = start(asked, shuttle, deps);
        continue;
      }
      if (running === undefined) {
        act(key);
      } else if (key.name === "ctrl-c") {
        // A completion runs beside the line it is completing, which is still
        // being edited and so is still the line to end; a verb's line was ended
        // where it was taken, and what is being edited under it is the next
        // one.
        if (running.kind === "completion") terminal.finish();
        running.stop();
        held = [];
        buffer.setText("");
        history.abandon();
        show();
      } else if (held.length > 0 || endsLine(key, buffer)) {
        held.push(key);
      } else {
        apply({ buffer, history }, key);
        show();
      }
    }
  } finally {
    // Whatever ended the run — the keys running out, a line that ended it, or
    // a throw from anywhere in the loop — the screen goes back before this
    // returns. A frame left holding it is an alternate screen with a hidden
    // cursor and nothing drawing on it, which is the one way out of a run a
    // person cannot type their way back from. The lens is closed rather than
    // the frame merely dropped, so its own subscription stops with it, and it
    // is closed first because that costs no terminal. Nothing is drawn on the
    // way past: the prompt this ended at is the last thing a run has to say.
    lens?.close();
    // A line still in flight is stopped, and gives up every lens it opened,
    // including one it settled with that this loop never took. Both are
    // needed. Stopping is what keeps the line from opening a lens after this:
    // a subscription it is still taking comes back as an interruption rather
    // than being adopted (`guarded`, `vocabulary.ts`). Releasing is what closes
    // a lens it opened already, whose subscription a stop comes too late for,
    // and it does so whichever of the line's outcome and the key stream this
    // loop's last wait took.
    running?.stop();
    running?.release?.();
    // Each on its own rather than both under one `try`: giving the screen back
    // and ending the line are two things a run owes a terminal, and sharing
    // one would make the first the gate on the second — a terminal that
    // refuses the unframe would leave the last line unfinished as well.
    for (const putBack of [() => terminal.unframe(), () => terminal.finish()]) {
      try {
        putBack();
      } catch {
        // A terminal that will not take this writing is one nothing here could
        // put back, and a throw raised on the way out would replace whatever
        // ended the run — which is what a reader needs. What holds the screen
        // back either way is the restore the terminal's own owner makes on
        // every way out of a run (`withPromptTerminal`, `terminal.ts`).
      }
    }
  }
}

/**
 * What the loop is waiting on: the next key, or the work it started beside
 * them.
 */
type Arrival =
  /** The key stream answered, with a key or with the end of the keys. */
  | { readonly kind: "typed"; readonly step: IteratorResult<Key> }
  /** The line in flight settled, and `text` is what it produced. */
  | { readonly kind: "ran"; readonly text: string }
  /**
   * The line in flight opened `lens`, having produced `text` on the way — the
   * two in that order, which is the order they happened in.
   */
  | {
    readonly kind: "lens";
    readonly lens: ValueLens;
    readonly text: string;
  }
  /** A completion answered, for the line `from` and with `line` to write. */
  | {
    readonly kind: "completed";
    readonly from: string;
    readonly line: string | undefined;
  };

/** Work in flight beside the keys: what it will produce, and how to stop it. */
interface Running {
  /**
   * Which of the two the prompt runs beside the keys, which is what says
   * whether the line being edited is the one it came from: a verb's line was
   * ended where it was taken, and a completion's is still being typed.
   */
  readonly kind: "line" | "completion";

  /** Settles with what it produced, cancelled or not. */
  readonly settled: Promise<Arrival>;

  /** Cancels it, which settles it with what a cancelled one says. */
  stop(): void;

  /**
   * Whether it has already been told to stop, which is not the same as having
   * settled: a cancel reaches the work through a signal, and the outcome it
   * settles with arrives some awaits later.
   *
   * What reads it is the second `ctrl-c` at a frame. The first stops the line;
   * the second, arriving before the first has settled, would otherwise stop a
   * line that is already stopping and leave the frame up — where what a person
   * pressing it twice is asking for is the way out.
   */
  stopped(): boolean;

  /**
   * Closes every lens the work opened, including one it settled with that the
   * prompt has not taken, and is absent where the work opens none.
   */
  release?(): void;
}

/**
 * Helper for {@link runPrompt}, which asks `keys` for the next one.
 *
 * It is a function so that the answer is a value the loop holds until it uses
 * it: a key asked for while a line was running is still the next key when that
 * line settles, and asking twice would drop one.
 */
function nextKey(keys: AsyncIterator<Key>): Promise<Arrival> {
  return keys.next().then((step) => ({ kind: "typed", step }) as const);
}

/**
 * Helper for {@link runPrompt}, which starts `line` and returns what running
 * it is.
 *
 * The signal rides the deps bag the verbs already read their collaborators
 * through, so a verb honors it wherever it has a phase to stop between and
 * nothing else has to be threaded to reach one.
 *
 * Every lens the line opens is the line's from the moment it is opened
 * (`adoptLens`), and the line hands over at most one: the lens its outcome
 * carries. The rest are closed as it settles, which is what catches a lens
 * whose outcome lost its race to a cancel; the one handed over is closed by
 * {@link Running.release} where the prompt never took it.
 */
function start(line: string, shuttle: Shuttle, deps: VerbDeps): Running {
  const stopper = new AbortController();
  const opened: ValueLens[] = [];
  const reported = report(line, shuttle, {
    ...deps,
    signal: stopper.signal,
    adoptLens: (lens) => {
      opened.push(lens);
    },
  });
  return {
    kind: "line",
    stop: () => stopper.abort(),
    stopped: () => stopper.signal.aborted,
    release: () => closeLenses(opened),
    settled: reported.then((arrival) => {
      closeLenses(opened, arrival.kind === "lens" ? arrival.lens : undefined);
      return arrival;
    }),
  };
}

/**
 * Helper for {@link start}, which closes every lens in `lenses` but `kept`.
 *
 * A lens closed twice is closed once (`ValueLens.close`), so one closed as its
 * line settled and again on the way out needs no test in front of it.
 */
function closeLenses(lenses: readonly ValueLens[], kept?: ValueLens): void {
  for (const lens of lenses) {
    if (lens !== kept) lens.close();
  }
}

/**
 * Helper for {@link runPrompt}, which starts a completion of `line` and
 * returns what running it is.
 *
 * The signal rides the deps bag as a verb's does, and for the same reason: a
 * completion reads, so a `ctrl-c` reaches the read it has not sent and the
 * answer it has not given (`completion.ts`).
 *
 * What the signal cannot reach is raced instead. A read already sent finishes
 * into nothing and may never finish at all, and a completion awaited rather
 * than raced would hold the prompt for the rest of the run against a server
 * that has gone quiet — which is the one thing `ctrl-c` at such a server is
 * for. The race delivers the prompt back and the read, whenever it lands, is
 * answering a completion nothing is waiting on.
 */
function startCompleting(
  line: string,
  shuttle: Shuttle,
  deps: VerbDeps,
): Running {
  const stopper = new AbortController();
  const completed = completeLine(shuttle, line, {
    ...deps,
    signal: stopper.signal,
  }).then((written) =>
    ({ kind: "completed", from: line, line: written }) as const
  );
  return {
    kind: "completion",
    stop: () => stopper.abort(),
    stopped: () => stopper.signal.aborted,
    settled: Promise.race([
      completed,
      whenAborted(
        stopper.signal,
        {
          kind: "completed",
          from: line,
          line: undefined,
        } as const,
      ),
    ]),
  };
}

/**
 * Helper for {@link runPrompt}, which is whether `key` ends the line `buffer`
 * holds rather than editing it.
 *
 * These are the two keys a prompt cannot honor while a line is in flight —
 * one would run a second line and the other would end the run under the first
 * — so they are the two that are held, and this is the one place that says
 * which they are.
 */
function endsLine(key: Key, buffer: EditBuffer): boolean {
  return key.name === "enter" ||
    (key.name === "ctrl-d" && buffer.text() === "");
}

/**
 * Helper for {@link runPrompt}, which is the prompt `shuttle` currently
 * carries.
 *
 * The place is carried short, and the shortening is the one that costs
 * nothing: the space is left out, because one connection serves one space and
 * a value that cannot change while you read it tells you nothing. Everything
 * else is written out — no name this process did not read, no id cut down to
 * a prefix that would print exactly as a whole one.
 *
 * So the prompt is not an address, and `pwd` is what to copy. The two halves
 * are separated by a space rather than joined, which is what keeps each of
 * them a word of its own: the scope qualifier sits last on every form here,
 * where a reference carries it on the piece, because a prompt wants it in the
 * same column on every line and a reference wants it where its grammar puts
 * it.
 */
function promptFor(shuttle: Shuttle): string {
  return `${PROMPT_NAME} ${shuttle.place.label()}> `;
}

/**
 * Helper for {@link start}, which runs `line` and returns what it did: what to
 * write above the next one — the empty string where it produced nothing to say
 * — and the lens it opened where it opened one.
 *
 * A value prints as indented JSON, and what cannot be written that way is
 * said rather than shown — by `renderValue` (`value.ts`) for a value the
 * writer declines, and by the catch here for one it cannot walk at all, a
 * cycle among them. Either way the line is answered and the run carries on,
 * which is what a read that failed gets too.
 *
 * The value arm writes a piece's `$UI` node out. What comes through it is what
 * a named entry point resolved to, which a person asked for by name and which
 * carries no page bound of its own; the verb that reads a cell writes its own
 * rendering, elides that node and bounds the page, because it is the verb a
 * person lands on by standing somewhere rather than by naming a target.
 *
 * Reading the message off a thrown value is `messageOf`'s and not this
 * expression's, because the obvious spelling of it throws on values a
 * rejection can carry, and a throw raised while answering a failure is the
 * failure this catch exists to stop.
 *
 * A cancelled line is answered by whichever of two things happens first, and
 * the answer is the same word either way. The line may reach a phase boundary
 * and stop there, which is the arm `runLine` returns; or it may be waiting on
 * a read that nothing can call off, and then the signal answers for it and the
 * read finishes into nothing. What the second delivers is the prompt, which is
 * what a person pressing `ctrl-c` at a server that has gone quiet is asking
 * for; what it does not deliver is a server that stopped working, and no
 * caller of a read here can deliver that.
 *
 * The two prose answers are escaped here rather than where they were written.
 * A refusal's reason and a thrown read's message both carry text the fabric
 * wrote, which passed no door and so was never held to the class a terminal
 * acts on; and both reach a person only by becoming a line of their own.
 * Escaping at that point covers a refusal built as a literal rather than
 * through `refuse`, and a message from a `throw` this module never sees, in a
 * way that escaping at each site cannot. It leaves the other two arms alone
 * because each owns a convention this one would undo: a rendered record and a
 * listing are laid out with line breaks that are structure rather than
 * content, and a serialized value is already escaped in JSON's own spelling.
 */
async function report(
  line: string,
  shuttle: Shuttle,
  deps: VerbDeps,
): Promise<Arrival> {
  try {
    const running = runLine(line, shuttle, deps);
    const outcome = await (deps.signal === undefined ? running : Promise.race([
      running,
      whenAborted<Outcome>(deps.signal, { kind: "interrupted" }),
    ]));
    switch (outcome.kind) {
      case "nothing":
      case "moved":
        return said("");
      case "interrupted":
        return said(INTERRUPTED);
      case "text":
        return said(outcome.text);
      case "refused":
        return said(escapeControlCharacters(outcome.reason));
      case "value":
        return said(renderValue(outcome.value, { ui: true }));
      case "watching":
        return {
          kind: "lens",
          lens: outcome.lens,
          text: outcome.armed,
        };
    }
  } catch (thrown) {
    return said(escapeControlCharacters(messageOf(thrown)));
  }
}

/** Helper for {@link report}, which is a line that produced `text` and no lens. */
function said(text: string): Arrival {
  return { kind: "ran", text };
}

/**
 * Helper for {@link report} and {@link startCompleting}, which settles with
 * `answer` once `signal` is aborted and never otherwise.
 *
 * A promise that never settles is exactly what is wanted for work nobody
 * cancels: it loses every race it is in and is collected with the controller
 * the work held. Nothing here waits on a clock, so work that is slow is work
 * that is still running.
 *
 * The two callers race it for one reason. A read already sent cannot be
 * called off, so this is what says the person has stopped waiting for it —
 * the line answered as interrupted, the completion as one with nothing to
 * write — and it is the answer either of them gets against a server that
 * never replies at all.
 */
function whenAborted<T>(signal: AbortSignal, answer: T): Promise<T> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(answer), { once: true });
  });
}
