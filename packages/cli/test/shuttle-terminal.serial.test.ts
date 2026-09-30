/**
 * Unit tests for the module that touches a terminal.
 *
 * There is no terminal behind them, and no process either: each case stands in
 * for the members of `Deno` the module reaches — the two streams, the signal
 * listeners, and the exit — and reads back what it did to them. That is what a
 * case can check about raw mode, which has no observable effect except on a
 * terminal, and about a signal, which no test process may deliver to itself
 * without ending: the calls are the whole of what this module owes, and
 * leaving one out is what the cases are for.
 *
 * What that leaves outside them, so nobody reads more into a green file than
 * it holds: no case delivers a real signal, and none puts a real terminal into
 * raw mode. A handler that the runtime never runs, and a `setRaw` that the
 * driver never honours, would both pass here.
 *
 * Standing in for a process-wide member means restoring it, and every case
 * restores in a `finally`, so a case that fails leaves the next one a `Deno`
 * that has not been edited.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  above,
  finish,
  NOTHING_PAINTED,
  repaint,
} from "../lib/shuttle/paint.ts";
import type { PromptTerminal } from "../lib/shuttle/prompt.ts";
import { ASSUMED_ROWS } from "../lib/shuttle/page.ts";
import { consoleRows, withPromptTerminal } from "../lib/shuttle/terminal.ts";
import type { Key } from "../lib/view/keys.ts";

/** What the terminal sends to take the screen for a frame, and to give it back. */
const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";

/** The members a case stands in for. */
interface Stubs {
  /** Whether standard input reports itself a terminal. */
  readonly inputIsTerminal?: () => boolean;

  /** Whether standard output reports itself a terminal. */
  readonly outputIsTerminal?: () => boolean;

  /** What the bytes of one read are, and `null` where the input ended. */
  readonly reads?: readonly (string | null)[];

  /**
   * Called as each read of standard input is issued, for a case that has to
   * see *when* one happens rather than what it returned.
   */
  readonly reading?: () => void;

  /**
   * What the `n`th read waits on before it answers, and nothing where it
   * answers at once.
   *
   * It is what lets a case put a read *in flight* across something else. A
   * stub that answers immediately never has one outstanding, so a case about
   * the read that was already going when a program took the terminal would
   * otherwise be a case about a read that had already finished.
   */
  readonly holdRead?: (nth: number) => Promise<void> | undefined;

  /** How wide the terminal says it is, or a throw where it will not say. */
  readonly consoleSize?: () => { columns: number; rows: number };

  /** What `COLUMNS` holds, and nothing where it holds nothing. */
  readonly columnsEnv?: string;

  /** How many of the bytes it is offered the terminal takes at a time. */
  readonly accepts?: (offered: number) => number;

  /** The signals this platform refuses to deliver, if any. */
  readonly unbindable?: readonly Deno.Signal[];

  /** A signal to deliver once the module is listening for it. */
  readonly raise?: Deno.Signal;

  /**
   * When that signal arrives, which is the half of the ordering a case picks.
   *
   * `entering` delivers it as raw mode goes on, so the handler restores and
   * the run's own way out finds it already done. `leaving` delivers it during
   * that way out's own restore, so the handler is the one that finds it
   * already done. `framed` delivers it as a full-screen frame takes the
   * screen, which is the state a signal costs the most: the process ends
   * without unwinding, so nothing but the handler is left to give that screen
   * back. `suspended` delivers it as a suspension gives that screen back to a
   * program, which is the state a signal costs the most *after* that one: the
   * program holds the terminal, so nothing this module writes goes out until
   * the hold is dropped, and the suspension that would have dropped it is not
   * something a signal unwinds into. `onCue` delivers it nowhere on its own and
   * hands the case the raiser instead, for an ordering that is a state rather
   * than a call: a frame given up *during* a suspension is reached by neither
   * a raw-mode call nor a write, both of them being what a hold suppresses.
   * All five are orderings the process can really be in, and the restore has
   * to be right from each of them.
   */
  readonly raiseWhen?:
    | "entering"
    | "leaving"
    | "framed"
    | "suspended"
    | "onCue";

  /** The raw-mode call that fails, where one does. */
  readonly rawThrowsOn?: boolean;

  /** Whether a listener refuses to come off. */
  readonly releaseThrows?: boolean;
}

/** What a case saw the module do. */
interface Watched {
  /** Every raw-mode call, in order, by the mode it asked for. */
  readonly raw: boolean[];

  /** How many reads of standard input were issued, which a case may sample. */
  reads(): number;

  /** Everything written, joined as the terminal would have received it. */
  written(): string;

  /**
   * What had been written when the module asked to end, and everything where
   * it never asked.
   *
   * It is what a real exit would have let out. The stand-in for `Deno.exit`
   * returns, so the run carries on and writes what a process that had gone
   * would not have — which is the difference a case about a signal has to read
   * against, or it passes on cleanup a person never sees.
   */
  writtenBeforeExit(): string;

  /**
   * What the run threw, and nothing where it returned.
   *
   * It is reported rather than raised so that a case about a run that refused
   * can read the rest of this record. A case that raised it instead would be
   * asserting on stand-ins the helper had already put back.
   */
  readonly thrown: unknown;

  /** Every signal listened for, in the order the module asked. */
  readonly listened: Deno.Signal[];

  /** Every signal stopped being listened for, in the order it asked. */
  readonly released: Deno.Signal[];

  /** The status of every exit it asked for, in order. */
  readonly exits: (number | undefined)[];

  /**
   * The raw-mode calls and the exits together, in the one order they
   * happened, which is the only place their relative order is readable.
   */
  readonly order: string[];
}

/**
 * Helper for the cases below, which runs `body` over a stood-in `Deno` and
 * returns what the module did to it.
 *
 * A read with nothing left to deliver ends the input, so a case that never
 * reads is served by the same helper as one that reads to the end.
 */
async function watching(
  stubs: Stubs,
  body: (terminal: PromptTerminal, raise: () => void) => Promise<void>,
): Promise<Watched> {
  const raw: boolean[] = [];
  const order: string[] = [];
  const chunks: string[] = [];
  let deliver: (() => void) | undefined;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reads = [...(stubs.reads ?? [])];
  let issued = 0;
  const original = {
    inputIsTerminal: Deno.stdin.isTerminal,
    outputIsTerminal: Deno.stdout.isTerminal,
    setRaw: Deno.stdin.setRaw,
    read: Deno.stdin.read,
    consoleSize: Deno.consoleSize,
    writeSync: Deno.stdout.writeSync,
    addSignalListener: Deno.addSignalListener,
    removeSignalListener: Deno.removeSignalListener,
    exit: Deno.exit,
  };
  // Both are stood in for whether or not a case says so: a test process is
  // ordinarily attached to neither, so the default is what every case but the
  // two about redirection needs.
  Deno.stdin.isTerminal = stubs.inputIsTerminal ?? (() => true);
  Deno.stdout.isTerminal = stubs.outputIsTerminal ?? (() => true);
  let gaveScreen = false;
  Deno.stdin.setRaw = (mode: boolean) => {
    raw.push(mode);
    order.push(mode ? "raw" : "cooked");
    // Cooked, with a frame's screen already given back: that pair is a
    // suspension and nothing else, and it is the one moment at which a program
    // holds the terminal. Delivered from here rather than from the write that
    // gave the screen back, because the hold is taken between the two.
    if (
      stubs.raiseWhen === "suspended" && !mode && gaveScreen &&
      deliver !== undefined
    ) {
      const arrived = deliver;
      deliver = undefined;
      arrived();
    }
    if (stubs.rawThrowsOn === mode) {
      throw new Deno.errors.BadResource("stdin is gone");
    }
    // Delivered from inside a raw-mode call because that is where the two
    // orderings differ: on the way in, before anything has restored, or from
    // inside the restore on the way out. Once either way — a signal arrives
    // once, and a second delivery would be the harness inventing a case.
    if (
      stubs.raiseWhen !== "framed" && stubs.raiseWhen !== "suspended" &&
      stubs.raiseWhen !== "onCue" &&
      mode === (stubs.raiseWhen !== "leaving") && deliver !== undefined
    ) {
      const arrived = deliver;
      deliver = undefined;
      arrived();
    }
  };
  Deno.stdin.read = async (buffer: Uint8Array) => {
    issued++;
    stubs.reading?.();
    const waiting = stubs.holdRead?.(issued);
    if (waiting !== undefined) await waiting;
    const next = reads.shift();
    if (next === undefined || next === null) return null;
    const bytes = encoder.encode(next);
    buffer.set(bytes);
    return bytes.length;
  };
  if (stubs.consoleSize !== undefined) Deno.consoleSize = stubs.consoleSize;
  Deno.stdout.writeSync = (bytes: Uint8Array) => {
    const taken = stubs.accepts?.(bytes.length) ?? bytes.length;
    const sent = decoder.decode(bytes.subarray(0, Math.max(taken, 0)));
    chunks.push(sent);
    // The screen going back is a step of the restore, and the only one that
    // shows in the bytes rather than in a `Deno` call, so it is recorded
    // beside the raw-mode calls: what a case about a signal asks is which of
    // them happened first.
    if (sent.includes(LEAVE_ALT)) order.push("screen");
    // Delivered as the frame takes the screen, which is the moment the
    // handler is the only thing left that would give it back.
    if (
      stubs.raiseWhen === "framed" && sent.includes(ENTER_ALT) &&
      deliver !== undefined
    ) {
      const arrived = deliver;
      deliver = undefined;
      arrived();
    }
    // Noted rather than acted on: a suspension gives the screen back before it
    // takes the hold, so this is the near side of the window a `suspended`
    // signal wants, and the raw-mode call after it is the far side.
    if (sent.includes(LEAVE_ALT)) gaveScreen = true;
    return taken;
  };
  const listened: Deno.Signal[] = [];
  const released: Deno.Signal[] = [];
  const exits: (number | undefined)[] = [];
  const handlers = new Map<Deno.Signal, () => void>();
  const unbindable = new Set(stubs.unbindable ?? []);
  Deno.addSignalListener = (signal: Deno.Signal, handler: () => void) => {
    if (unbindable.has(signal)) {
      throw new TypeError(`Binding to signal '${signal}' is not allowed`);
    }
    listened.push(signal);
    handlers.set(signal, handler);
  };
  Deno.removeSignalListener = (signal: Deno.Signal) => {
    released.push(signal);
    if (stubs.releaseThrows) throw new TypeError("no such listener");
  };
  // The stand-in returns where the real one does not, which is what lets a
  // case read what the handler did after asking to end.
  //
  // What that costs is that the run carries on past the ask, where a process
  // would be gone: a suspension the signal arrived inside of goes on to its
  // own way out and writes what it owes, which a real exit never reaches. So a
  // case about what the handler itself managed to write reads
  // {@link Watched.writtenBeforeExit} rather than everything written, the two
  // differing by exactly the cleanup a real exit would have cut off.
  Deno.exit = ((status?: number) => {
    exits.push(status);
    order.push(`exit ${status}`);
    if (wroteAtExit === undefined) wroteAtExit = chunks.length;
  }) as unknown as typeof Deno.exit;
  const priorColumns = Deno.env.get("COLUMNS");
  if (stubs.columnsEnv === undefined) Deno.env.delete("COLUMNS");
  else Deno.env.set("COLUMNS", stubs.columnsEnv);
  let thrown: unknown;
  let wroteAtExit: number | undefined;
  if (stubs.raise !== undefined) {
    const signal = stubs.raise;
    deliver = () => handlers.get(signal)?.();
  }
  try {
    await withPromptTerminal((terminal) =>
      body(terminal, () => {
        const arrived = deliver;
        deliver = undefined;
        arrived?.();
      })
    );
  } catch (error) {
    thrown = error;
  } finally {
    if (priorColumns === undefined) Deno.env.delete("COLUMNS");
    else Deno.env.set("COLUMNS", priorColumns);
    Deno.stdin.isTerminal = original.inputIsTerminal;
    Deno.stdout.isTerminal = original.outputIsTerminal;
    Deno.stdin.setRaw = original.setRaw;
    Deno.stdin.read = original.read;
    Deno.consoleSize = original.consoleSize;
    Deno.stdout.writeSync = original.writeSync;
    Deno.addSignalListener = original.addSignalListener;
    Deno.removeSignalListener = original.removeSignalListener;
    Deno.exit = original.exit;
  }
  return {
    raw,
    written: () => chunks.join(""),
    writtenBeforeExit: () =>
      chunks.slice(0, wroteAtExit ?? chunks.length).join(""),
    reads: () => issued,
    thrown,
    listened,
    released,
    exits,
    order,
  };
}

/** Helper for the cases below, which is the message `thrown` carries. */
function message(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : `not thrown: ${thrown}`;
}

/** Helper for the cases below, which is a terminal `columns` wide. */
function wide(columns: number): () => { columns: number; rows: number } {
  return () => ({ columns, rows: 24 });
}

/**
 * Helper for the cases below, which is what `written` sent after the frame last
 * gave the screen back, and a sentence no case expects where it never did.
 */
function afterFrame(written: string): string {
  const gave = written.lastIndexOf(LEAVE_ALT);
  return gave < 0
    ? "<the screen was never given back>"
    : written.slice(gave + LEAVE_ALT.length);
}

describe("terminal", () => {
  describe("withPromptTerminal()", () => {
    it("throws where standard input is not a terminal", async () => {
      const watched = await watching(
        { inputIsTerminal: () => false },
        () => Promise.resolve(),
      );
      expect(message(watched.thrown)).toContain("standard input is not one");
    });

    it("throws where standard output is not a terminal", async () => {
      // Redirecting the output alone leaves the keys arriving and the drawing
      // going into a file, which would record a saved cursor and a
      // clear-to-end-of-screen as text.

      const watched = await watching(
        { outputIsTerminal: () => false },
        () => Promise.resolve(),
      );
      expect(message(watched.thrown)).toContain("standard output is not one");
    });

    it("puts standard input in no mode at all where a stream is redirected", async () => {
      // The raw-mode calls read here are the helper's own record. A case that
      // stood in for `setRaw` itself would be replaced by the helper before
      // the run began, and would then see nothing whatever the run did.

      const watched = await watching(
        { outputIsTerminal: () => false },
        () => Promise.resolve(),
      );
      expect(watched.raw).toEqual([]);
    });

    it("puts standard input into raw mode and takes it back out", async () => {
      const watched = await watching({}, () => Promise.resolve());
      expect(watched.raw).toEqual([true, false]);
    });

    it("takes standard input back out of raw mode after a body that threw", async () => {
      // A terminal left in raw mode is one the person's next command cannot
      // be typed at, so what the body did decides nothing about this.

      const watched = await watching(
        {},
        () => Promise.reject(new Error("The body.")),
      );
      expect(message(watched.thrown)).toBe("The body.");
      expect(watched.raw).toEqual([true, false]);
    });

    it("listens for every signal a run can be ended by", async () => {
      // The four a process may bind. `SIGKILL` and `SIGSTOP` are not among
      // them because no process may bind either, which is a fact about the
      // platform rather than a choice this module made.

      const watched = await watching({}, () => Promise.resolve());
      expect(watched.listened).toEqual([
        "SIGHUP",
        "SIGINT",
        "SIGQUIT",
        "SIGTERM",
      ]);
    });

    it("stops listening for every one of them when the run is over", async () => {
      // A listener outliving the run would answer for a terminal this call no
      // longer holds, and take a later one out of a mode it had put it in.

      const watched = await watching({}, () => Promise.resolve());
      expect(watched.released).toEqual(watched.listened);
    });

    it("keeps listening for the rest where the platform refuses one", async () => {
      // One way of ending that cannot be restored from is what it costs;
      // refusing to start would cost every way.

      const watched = await watching(
        { unbindable: ["SIGQUIT"] },
        () => Promise.resolve(),
      );
      expect(watched.listened).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
      expect(watched.thrown).toBe(undefined);
    });

    it("takes standard input back out of raw mode on a signal", async () => {
      // The failure this is for: a signal ends the process without unwinding,
      // so the `finally` never runs and the person is left at a terminal that
      // neither echoes nor edits until they type `reset` into the dark.

      const watched = await watching(
        { raise: "SIGTERM" },
        () => Promise.resolve(),
      );
      expect(watched.raw).toEqual([true, false]);
    });

    it("restores the terminal before it asks to end, not after", async () => {
      // The order is the whole guarantee, and it is why the restore is not
      // left to whatever the exit does: what follows the restore is allowed to
      // fail, and what precedes it is not.

      const watched = await watching(
        { raise: "SIGHUP" },
        () => Promise.resolve(),
      );
      expect(watched.order).toEqual(["raw", "cooked", "exit 129"]);
    });

    it("gives the screen back where a signal ended the run, before the mode", async () => {
      // A signal ends the process without unwinding, so nothing but the
      // handler is left to put the screen back — and a person left on an
      // alternate screen with a hidden cursor has their next command's output
      // thrown away with it. Both restorations happen, in the order the
      // handler makes them.

      const watched = await watching(
        { raise: "SIGINT", raiseWhen: "framed" },
        async (terminal) => {
          terminal.frame(["a"]);
          await Promise.resolve();
        },
      );
      expect(watched.order).toEqual(["raw", "screen", "cooked", "exit 130"]);
    });

    it("restores from a signal that arrived during a suspension", async () => {
      // A program holding the terminal is the one state in which nothing this
      // object writes goes out, and a signal is the one ending that does not
      // unwind into the suspension that would have let the hold go. So the
      // handler has to drop it itself, and everything the restore owes — the
      // screen, and the lines the frame was holding back — rides on that.
      //
      // Read off the order rather than off the bytes, and this is why: the
      // giving-back is the one step of the restore that shows as a write, so a
      // handler that could not write made none. The bytes cannot tell the two
      // apart here, because the exit a real signal ends the process with is
      // stood in for — the run carries on afterwards, and the suspension's own
      // way out writes the same lines a moment later. A case reading only the
      // bytes would pass either way.
      //
      // Kills: restoring without letting go of the hold, which drops the
      // giving-back and leaves one `screen` where there are two.

      const watched = await watching(
        { raise: "SIGINT", raiseWhen: "suspended" },
        async (terminal) => {
          terminal.frame(["a"]);
          terminal.announce("a watch said so");
          await terminal.suspend(() => Promise.resolve());
          await Promise.resolve();
        },
      );
      const ended = watched.order.indexOf("exit 130");
      expect(ended).toBeGreaterThan(-1);
      // Two: the one the suspension made as it handed the terminal over, and
      // the one the handler made because it could write at all.
      expect(watched.order.slice(0, ended).filter((at) => at === "screen"))
        .toEqual(["screen", "screen"]);
      // What the frame was holding, which is the whole point of the restore
      // being able to write. It reaches the output either way in this harness,
      // for the reason above, so it is stated rather than relied on.
      expect(watched.written()).toContain("a watch said so");
    });

    it("writes what a frame held back where the frame went first", async () => {
      // The hole the case above leaves, and a signal is the only way into it.
      // Keys already decoded out of one read reach the prompt while a program
      // holds the terminal, so a `q` behind the key that started an editor
      // closes the view mid-suspension: the frame is gone, and the writing
      // that would have flushed what it was holding was dropped like every
      // write during a hold. Nothing later writes them either — the restore
      // has no frame left to answer for, and the suspension that would have
      // flushed them is not something a signal unwinds into.
      //
      // Kills: flushing on the way out only where a frame is still up, which
      // strands every line the frame was holding.

      const watched = await watching(
        { raise: "SIGINT", raiseWhen: "onCue" },
        async (terminal, raise) => {
          terminal.frame(["a"]);
          terminal.announce("a watch said so");
          await terminal.suspend(() => {
            terminal.unframe();
            raise();
            return Promise.resolve();
          });
          await Promise.resolve();
        },
      );
      // Read against what the exit cut off, because the stand-in for it
      // returns: without that bound the suspension's own way out writes these
      // lines a moment later and the case passes either way.
      expect(watched.writtenBeforeExit()).toContain("a watch said so");
    });

    it("ends with the status the shell convention gives the signal", async () => {
      for (
        const [signal, status] of [
          ["SIGHUP", 129],
          ["SIGINT", 130],
          ["SIGQUIT", 131],
          ["SIGTERM", 143],
        ] as const
      ) {
        const watched = await watching({ raise: signal }, () => {
          return Promise.resolve();
        });
        expect(watched.exits).toEqual([status]);
      }
    });

    it("takes the terminal out of raw mode once where the signal restored", async () => {
      // The signal handler and the run's own way out both restore, and this
      // is the ordering where the handler is first: what the `finally` finds
      // is a terminal already put back, and calling again would take a mode
      // off that something after this run had put on.

      const watched = await watching(
        { raise: "SIGINT" },
        () => Promise.resolve(),
      );
      expect(watched.raw.filter((mode) => !mode)).toEqual([false]);
    });

    it("takes it out once where the signal arrived during the restore", async () => {
      // The other ordering, and it is not the same case read backwards. Here
      // the run's own way out is restoring when the signal lands, so what has
      // to hold is that the handler finds the work already claimed — which is
      // why the memory is written before the call it guards and not after it.
      // Written after, this ordering restores twice and the one above still
      // passes, so only a case on this side can tell.

      const watched = await watching(
        { raise: "SIGTERM", raiseWhen: "leaving" },
        () => Promise.resolve(),
      );
      expect(watched.raw.filter((mode) => !mode)).toEqual([false]);
      expect(watched.order).toEqual(["raw", "cooked", "exit 143"]);
      expect(watched.released).toEqual(watched.listened);
    });

    it("stops listening though raw mode is what failed", async () => {
      // The listeners go on before raw mode does, so raw mode failing is a way
      // out that has them on and a body that never ran. Leaving them behind
      // here would be the leak the release exists to stop, on the one path
      // where nothing else went right either.

      const watched = await watching(
        { rawThrowsOn: true },
        () => Promise.resolve(),
      );
      expect(message(watched.thrown)).toBe("stdin is gone");
      expect(watched.released).toEqual(watched.listened);
    });

    it("takes the mode back though the screen will not go back", async () => {
      // The two halves of the restore are two `try`s because neither needs the
      // other and the second must run whatever the first did. A terminal that
      // will not take the give-back is the other way of not holding a screen,
      // and the mode a person's next command is typed at goes back regardless.

      let accepting = true;
      const watched = await watching({
        consoleSize: wide(40),
        accepts: (offered) => accepting ? offered : 0,
      }, (terminal) => {
        terminal.frame(["a"]);
        accepting = false;
        return Promise.resolve();
      });
      expect(watched.order).toEqual(["raw", "cooked"]);
      expect(watched.thrown).toBe(undefined);
    });

    it("returns though the terminal will not come out of raw mode", async () => {
      // A terminal that has gone away is the other way of not being raw, and
      // the run has already finished. Raising here would replace whatever the
      // run was about to report with a complaint about the cleanup.

      const watched = await watching(
        { rawThrowsOn: false },
        () => Promise.resolve(),
      );
      expect(watched.raw).toEqual([true, false]);
      expect(watched.thrown).toBe(undefined);
      expect(watched.released.length).toBe(4);
    });

    it("returns though a listener will not come off", async () => {
      // Same reasoning one step later, and it is why the release sits in its
      // own `try`: one listener refusing must not keep the other three on.

      const watched = await watching(
        { releaseThrows: true },
        () => Promise.resolve(),
      );
      expect(watched.released).toEqual(watched.listened);
      expect(watched.thrown).toBe(undefined);
    });

    it("writes nothing at all where the body wrote nothing", async () => {
      const watched = await watching({}, () => Promise.resolve());
      expect(watched.written()).toBe("");
    });

    it("writes what the painter composes for a line", async () => {
      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("ab", 2);
        return Promise.resolve();
      });
      expect(watched.written())
        .toBe(
          repaint(NOTHING_PAINTED, { text: "ab", column: 2, columns: 40 }),
        );
    });

    it("ends a line with what the painter composes for the ending", async () => {
      // Half of what a terminal is asked for is ending a line, and no case
      // above asks for it: every one of them draws and returns.

      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("ab", 2);
        terminal.finish();
        return Promise.resolve();
      });
      expect(watched.written()).toBe(
        repaint(NOTHING_PAINTED, { text: "ab", column: 2, columns: 40 }) +
          finish({ text: "ab", column: 2, columns: 40 }),
      );
    });

    it("writes an out-of-band line above the line it is drawing", async () => {
      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("ab", 2);
        terminal.announce("gone");
        return Promise.resolve();
      });
      const drawn = { text: "ab", column: 2, columns: 40 };
      expect(watched.written()).toBe(
        repaint(NOTHING_PAINTED, drawn) + above(drawn, "gone"),
      );
    });

    it("leaves the line drawn after writing above it", async () => {
      // The whole log rather than its tail: the second announcement is
      // composed against the line the first one redrew, so a terminal that
      // forgot the line was still there would climb over a line it thinks is
      // gone and write the second one a row too high.

      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("a".repeat(45), 45);
        terminal.announce("one");
        terminal.announce("two");
        return Promise.resolve();
      });
      const drawn = { text: "a".repeat(45), column: 45, columns: 40 };
      expect(watched.written()).toBe(
        repaint(NOTHING_PAINTED, drawn) + above(drawn, "one") +
          above(drawn, "two"),
      );
    });

    it("draws the line after a finished one from the top of the screen", async () => {
      // What a finished line leaves behind is nothing to draw over. Were it
      // still thought to be on screen, the next drawing would open by climbing
      // over the rows it had wrapped to, and land a row above where it writes.

      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("a".repeat(45), 45);
        terminal.finish();
        terminal.edit("b", 1);
        return Promise.resolve();
      });
      // The whole log rather than its tail: were the finished line still
      // thought to be drawn, the last drawing would open with a move up, and
      // a tail that ends with the right bytes would end with those too.
      const wrapped = { text: "a".repeat(45), column: 45, columns: 40 };
      expect(watched.written()).toBe(
        repaint(NOTHING_PAINTED, wrapped) +
          finish(wrapped) +
          repaint(NOTHING_PAINTED, { text: "b", column: 1, columns: 40 }),
      );
    });

    it("draws the second line over the first, from where the first left the cursor", async () => {
      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("a".repeat(45), 45);
        terminal.edit("b", 1);
        return Promise.resolve();
      });
      expect(watched.written()).toContain(
        repaint({ text: "a".repeat(45), column: 45, columns: 40 }, {
          text: "b",
          column: 1,
          columns: 40,
        }),
      );
    });

    it("draws at the width the terminal reports", async () => {
      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("a".repeat(45), 45);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b[1B");
    });

    it("draws at the width the environment declares where the terminal will not", async () => {
      const watched = await watching({
        consoleSize: () => {
          throw new Deno.errors.NotFound("No console.");
        },
        columnsEnv: "20",
      }, (terminal) => {
        terminal.edit("a".repeat(25), 25);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b8\x1b[1B\x1b[5C");
    });

    it("draws at the assumed width where the terminal reports no columns", async () => {
      // A terminal that cannot measure itself reports zero, which is not a
      // width to divide rows by: dividing at it puts `Infinity` into a cursor
      // parameter, which no terminal reads as a number of rows.

      const watched = await watching({
        consoleSize: () => ({ columns: 0, rows: 0 }),
      }, (terminal) => {
        terminal.edit("a".repeat(85), 85);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b8\x1b[1B\x1b[5C");
    });

    it("draws at the assumed width where the environment declares no number", async () => {
      const watched = await watching({
        consoleSize: () => {
          throw new Deno.errors.NotFound("No console.");
        },
        columnsEnv: "wide",
      }, (terminal) => {
        terminal.edit("a".repeat(85), 85);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b8\x1b[1B\x1b[5C");
    });

    it("writes every byte, where the terminal takes them a few at a time", async () => {
      // A write is allowed to accept part of what it is offered. Dropping the
      // rest would cut an escape sequence in half, and half a sequence is text
      // on the screen rather than a cursor move.

      const watched = await watching({
        consoleSize: wide(40),
        accepts: (offered) => Math.min(offered, 3),
      }, (terminal) => {
        terminal.edit("abcdefghij", 10);
        return Promise.resolve();
      });
      expect(watched.written())
        .toBe(repaint(NOTHING_PAINTED, {
          text: "abcdefghij",
          column: 10,
          columns: 40,
        }));
    });

    it("throws where the terminal accepts no bytes at all", async () => {
      const watched = await watching({
        consoleSize: wide(40),
        accepts: () => 0,
      }, (terminal) => {
        terminal.edit("ab", 2);
        return Promise.resolve();
      });
      expect(message(watched.thrown))
        .toBe("The terminal accepted none of what shuttle wrote.");
    });

    it("draws at an assumed width where the terminal will not report one", async () => {
      // A line 85 columns long wraps at the assumed 80 and not at anything
      // wider, so what the cursor move says is which width was used.

      const watched = await watching({
        consoleSize: () => {
          throw new Deno.errors.NotFound("No console.");
        },
      }, (terminal) => {
        terminal.edit("a".repeat(85), 85);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b8\x1b[1B\x1b[5C");
    });

    it("reads the keys the bytes on standard input decode to", async () => {
      const keys: Key[] = [];
      await watching({ reads: ["ab"] }, async (terminal) => {
        for await (const key of terminal.keys) keys.push(key);
      });
      expect(keys).toEqual([
        { name: "a", char: "a" },
        { name: "b", char: "b" },
      ]);
    });

    it("carries an escape sequence split across two reads into the second", async () => {
      // The decoder returns the bytes it could not finish with, and they open
      // the next read rather than being decoded as the keys they are not.

      const keys: Key[] = [];
      await watching({ reads: ["\x1b[", "A"] }, async (terminal) => {
        for await (const key of terminal.keys) keys.push(key);
      });
      expect(keys).toEqual([{ name: "up" }]);
    });
  });

  describe("frame()", () => {
    it("takes the alternate screen once and draws the rows on it", async () => {
      // The whole of what a run holding a frame sends, the run's own way out
      // included: the screen goes back before this returns, whatever the run
      // did with it.
      //
      // Each drawing ends by saying where the cursor goes, hiding it here
      // because neither of these frames is being typed at. It is sent with
      // every drawing rather than once, because a drawing positions each row
      // from the top and leaves the cursor wherever the last of them ended.

      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"]);
        terminal.frame(["b"]);
        await Promise.resolve();
      });
      expect(watched.written()).toBe(
        "\x1b[?1049h\x1b[?25l" +
          "\x1b[?7l\x1b[1;1H\x1b[2Ka\x1b[?7h\x1b[?25l" +
          "\x1b[?7l\x1b[1;1H\x1b[2Kb\x1b[?7h\x1b[?25l" +
          "\x1b[?25h\x1b[?1049l",
      );
    });

    it("gives the screen back around a program and draws the frame again", async () => {
      // A terminal keeps no stack of alternate screens. A full-screen editor
      // takes one and leaves it, which puts this terminal back on its primary
      // screen — where the transcript is — while the frame is still this
      // object's as far as it knows. The next drawing would then paint the
      // frame over the transcript, which is the one thing taking the screen
      // exists to prevent.
      //
      // Drawn again rather than left for whatever comes next, because what
      // comes next is a verb settling, which can be a write to a server away.
      //
      // Kills: handing the terminal over with the frame's screen still taken,
      // which sends no `?1049l` before the program and no `?1049h` after it.

      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"]);
        await terminal.suspend(() => Promise.resolve());
        await Promise.resolve();
      });
      const written = watched.written();
      const took = written.indexOf("\x1b[?1049h");
      const gave = written.indexOf("\x1b[?1049l", took);
      const retook = written.indexOf("\x1b[?1049h", gave);
      expect(gave).toBeGreaterThan(took);
      expect(retook).toBeGreaterThan(gave);
      // The frame is on the screen it was given back, drawn from what the last
      // `frame()` was handed rather than from whatever the program left.
      expect(written.slice(retook)).toContain("\x1b[1;1H\x1b[2Ka");
    });

    it("leaves the screen given up where the frame went during the program", async () => {
      // Keys already decoded out of one read go on reaching the prompt while a
      // program holds the terminal, so a `q` typed behind the key that started
      // an editor closes the view from under it. The `unframe` that would have
      // left the alternate screen is dropped as every write during a hold is —
      // this one already gave the screen back on the way in, so what is left to
      // get right is not taking it again.
      //
      // Kills: restoring on what the frame was before the program rather than
      // on what it is now, which ends on an alternate screen nothing is drawing
      // on and nothing will leave.

      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"]);
        await terminal.suspend(() => {
          terminal.unframe();
          return Promise.resolve();
        });
        await Promise.resolve();
      });
      const written = watched.written();
      // One taking and one giving, in that order, and nothing after them.
      expect(written.split("\x1b[?1049h").length - 1).toBe(1);
      expect(written.split("\x1b[?1049l").length - 1).toBe(1);
      expect(written.indexOf("\x1b[?1049l"))
        .toBeGreaterThan(written.indexOf("\x1b[?1049h"));
    });

    it("writes what the frame held back where it went during the program", async () => {
      // Those lines are a run's record — a pattern's console output and an
      // armed watch's event lines — and a frame given up during a suspension
      // would otherwise take the whole of what it was holding with it: the
      // writing that flushes them is dropped like every other.
      //
      // Kills: flushing in `unframe` whatever the terminal is doing, which
      // sends them into a write nobody receives.

      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"]);
        terminal.announce("a watch said so");
        await terminal.suspend(() => {
          terminal.unframe();
          return Promise.resolve();
        });
        await Promise.resolve();
      });
      expect(watched.written()).toContain("a watch said so");
    });

    it("holds the frame's lines back across a suspension it came back from", async () => {
      // The other side of the two cases above, and the one that says the
      // flushing is decided by what the frame is rather than by the suspension
      // ending. A frame that is still up when the program gives the terminal
      // back is a frame that goes on holding: written then, those lines would
      // land on an alternate screen the frame repaints over a moment later,
      // which loses them exactly as dropping them would.
      //
      // Which guard holds it is worth naming, because it is not the one the
      // suspension's own branch looks like it is. Flushing on every way out of
      // a suspension does not break this: the flush goes back through
      // {@link StandardTerminal.announce}, which buffers again while a frame
      // is up, so the lines return to where they were. That buffering is the
      // guard, and this case fails when it goes — measured both ways.

      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"]);
        terminal.announce("a watch said so");
        await terminal.suspend(() => Promise.resolve());
        terminal.unframe();
        await Promise.resolve();
      });
      const written = watched.written();
      const said = written.indexOf("a watch said so");
      // The last giving-up of the screen is the frame's own, on the way out.
      // Held across the suspension, the line lands after it; flushed inside
      // the suspension, it would land before — on the screen the frame is
      // about to repaint.
      // Two givings-up, and which one the line comes after is the whole
      // question: the first is the suspension handing the screen to the
      // program, the second is the frame giving it up for good. Both are
      // located, and a third is refused, because "after the last of however
      // many there are" is satisfied by the suspension's alone if the frame's
      // never happens — the ordering would then say only that the line was
      // written, which the bound above it already says.
      const first = written.indexOf(LEAVE_ALT);
      const second = written.indexOf(LEAVE_ALT, first + LEAVE_ALT.length);
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(-1);
      expect(written.indexOf(LEAVE_ALT, second + LEAVE_ALT.length)).toBe(-1);
      expect(said).toBeGreaterThan(-1);
      expect(said).toBeGreaterThan(second);
    });

    it("draws nothing again where no frame held the screen", async () => {
      // A `suspend` at the prompt hands over a terminal with nothing on the
      // alternate screen, so there is no screen to give back and none to take.

      const watched = await watching({}, async (terminal) => {
        await terminal.suspend(() => Promise.resolve());
        await Promise.resolve();
      });
      expect(watched.written()).not.toContain("\x1b[?1049");
    });

    it("puts the cursor where a frame being typed at says", async () => {
      // A frame with a command line open on it is typed at, and a line being
      // typed with no cursor on it is one a person cannot see where they are
      // in. The move comes before the show, so the cursor never appears at the
      // place the rows left it on the way to the place it belongs.

      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"], { row: 2, column: 5 });
        await Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b[2;5H\x1b[?25h");
    });

    it("draws no line being edited while it has the screen", async () => {
      // A drawing of a line that is not on screen has nothing to be kept for,
      // where a line written above the prompt is a record.

      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"]);
        terminal.edit("shuttle> ", 9);
        terminal.finish();
        await Promise.resolve();
      });
      expect(watched.written().includes("shuttle> ")).toBe(false);
    });

    it("keeps what was announced while it had the screen, and writes it after", async () => {
      // A watch's event lines and a pattern's console go on arriving while a
      // frame is up, and a transcript missing them would be missing exactly
      // the changes a person opened the frame to watch. So neither is drawn
      // over the frame and neither is lost: both land once the screen is back,
      // in the order they arrived.

      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"]);
        terminal.announce("one");
        terminal.announce("two");
        await Promise.resolve();
      });
      const written = watched.written();
      const gave = written.indexOf(LEAVE_ALT);
      expect(gave).toBeGreaterThan(-1);
      expect(written.indexOf("one")).toBeGreaterThan(gave);
      expect(written.indexOf("two")).toBeGreaterThan(written.indexOf("one"));
    });
  });

  describe("unframe()", () => {
    it("gives the screen back and writes what was announced, in order", async () => {
      const watched = await watching({}, async (terminal) => {
        terminal.frame(["a"]);
        terminal.announce("one");
        terminal.announce("two");
        terminal.unframe();
        await Promise.resolve();
      });
      const written = watched.written();
      const gave = written.indexOf(LEAVE_ALT);
      expect(gave).toBeGreaterThan(-1);
      expect(written.indexOf("one")).toBeGreaterThan(gave);
      expect(written.indexOf("two")).toBeGreaterThan(written.indexOf("one"));
    });

    it("does nothing where no frame has the screen", async () => {
      const watched = await watching({}, async (terminal) => {
        terminal.unframe();
        await Promise.resolve();
      });
      expect(watched.written()).toBe("");
    });

    it("draws the next line from where the line before the frame was drawn", async () => {
      // Giving the alternate screen back restores the cursor the terminal
      // saved on taking it, which is where the last drawing left it: a line
      // wrapped onto a second row leaves the cursor back on that row. So the
      // next drawing climbs to the line's first row, as any repaint does, and
      // clears the whole of the old line rather than leaving its first row
      // standing above the new one.
      //
      // Kills: forgetting what was drawn when the frame gives the screen back,
      // which starts the next line on the wrapped row with no cursor-up.

      const watched = await watching({ consoleSize: wide(20) }, async (t) => {
        t.edit("a".repeat(25), 25);
        t.frame(["f"]);
        t.unframe();
        t.edit("b", 1);
        await Promise.resolve();
      });
      expect(afterFrame(watched.written()))
        .toBe("\x1b[1A\r\x1b7\x1b[0Jb\x1b8\x1b[1C");
    });

    it("measures the next line against the line before the frame, not one edited during it", async () => {
      // Nothing reaches this screen while a frame holds it, so an edit or an
      // ending asked for then changes nothing on it, and what was drawn has
      // to say so: the next drawing climbs by the rows of the line that is
      // actually there.
      //
      // Kills: recording an edit or an ending made while framed, which
      // measures the next repaint against a line that was never drawn.

      const watched = await watching({ consoleSize: wide(20) }, async (t) => {
        t.edit("a".repeat(25), 25);
        t.frame(["f"]);
        t.edit("x", 1);
        t.finish();
        t.unframe();
        t.edit("b", 1);
        await Promise.resolve();
      });
      expect(afterFrame(watched.written()))
        .toBe("\x1b[1A\r\x1b7\x1b[0Jb\x1b8\x1b[1C");
    });

    it("writes a line announced during the frame above the line drawn before it", async () => {
      // The other write a frame holds back. It lands once the screen is given
      // back, above the line the frame was drawn over, so it climbs to that
      // line's first row and draws the line again beneath it.
      //
      // Kills: forgetting what was drawn when the frame gives the screen back,
      // which writes the announced line on the wrapped row and draws an empty
      // line under it.

      const watched = await watching({ consoleSize: wide(20) }, async (t) => {
        t.edit("a".repeat(25), 25);
        t.frame(["f"]);
        t.announce("one");
        t.unframe();
        await Promise.resolve();
      });
      expect(afterFrame(watched.written())).toBe(
        "\x1b[1A\r\x1b[0Jone\r\n" +
          `\r\x1b7\x1b[0J${"a".repeat(25)}\x1b8\x1b[1B\x1b[5C`,
      );
    });
  });

  describe("suspend()", () => {
    // A program that takes the terminal takes all of it. Raw mode is the half
    // that is easy to see; the other half is that this prompt stops reading
    // and stops drawing, and a case for each is what keeps the two together.

    it("draws nothing while a program holds the terminal", async () => {
      // Every write goes through one door, so the three of them are asserted
      // through whichever a case picks: what a person sees is that the screen
      // the program drew is not written over.

      let during = "";
      const watched = await watching({}, async (terminal) => {
        terminal.edit("before> ", 8);
        const already = { length: 0 };
        await terminal.suspend(() => {
          already.length = 1;
          terminal.edit("held> ", 6);
          terminal.announce("held");
          terminal.finish();
          return Promise.resolve();
        });
        during = String(already.length);
      });
      // Nothing between the line drawn before the trip and the trip's end.
      expect(watched.written()).not.toContain("held");
      expect(watched.written()).toContain("before> ");
      expect(during).toBe("1");
    });

    it("draws again once the program gives it back", async () => {
      // The other side of the same rule: suspension is for the trip and not
      // for the rest of the run.

      const watched = await watching({}, async (terminal) => {
        await terminal.suspend(() => Promise.resolve());
        terminal.edit("after> ", 7);
      });
      expect(watched.written()).toContain("after> ");
    });

    /**
     * Helper for the two cases below, which is every key the reader delivered
     * when a read that was already in flight answered from inside a trip.
     *
     * The trip is started from inside the read itself, which is the only
     * arrangement that puts the bytes in the window this is about: the reader
     * is pull-driven, so the read exists only once something is pulling, and a
     * trip started before the pull would be a trip with nothing outstanding.
     * `reading` fires as the read is issued and the trip begins there; the
     * read then answers while the terminal is held.
     */
    async function acrossATrip(caught: string): Promise<string[]> {
      const seen: string[] = [];
      let release = () => {};
      const answered = new Promise<void>((resolve) => {
        release = resolve;
      });
      let terminal: PromptTerminal | undefined;
      let trip: Promise<void> | undefined;
      let issued = 0;
      await watching(
        {
          reads: ["a", caught, "z"],
          reading: () => {
            if (++issued !== 2 || terminal === undefined) return;
            trip = terminal.suspend(async () => {
              release();
              for (let turn = 0; turn < 12; turn++) await Promise.resolve();
            });
          },
          holdRead: (nth) => (nth === 2 ? answered : undefined),
        },
        async (opened) => {
          terminal = opened;
          const keys = opened.keys[Symbol.asyncIterator]();
          const named = (r: IteratorResult<unknown>) =>
            (r.value as { name?: string } | undefined)?.name ?? "";
          seen.push(named(await keys.next()));
          const pending = keys.next();
          const after = await pending;
          if (after.done !== true) seen.push(named(after));
          await trip;
          // And what the reader has left, so a key the trip should have held
          // back shows here rather than sitting unpulled. One key pulled would
          // hide it: the reader yields what it kept before it reads again.
          for (let more = 0; more < 2; more++) {
            const next = await keys.next();
            if (next.done === true) break;
            seen.push(named(next));
          }
          await keys.return?.(undefined);
        },
      );
      return seen;
    }

    it("carries what a read already in flight caught out of the suspension", async () => {
      // The one thing holding the terminal cannot take back: those bytes have
      // left the stream whatever this does. Dropping them is the answer a
      // person cannot see — the key reached neither the program nor the prompt
      // and nothing says so — so they are carried out instead.

      expect(await acrossATrip("b")).toEqual(["a", "b", "z"]);
    });

    it("holds back the submit from what it carries out, and keeps the rest", async () => {
      // Both halves in one read, which is what tells the rule from a reader
      // that simply drops everything: the ordinary key is carried out and the
      // submit is not. A submit on its own would look the same either way,
      // the reader going on to the next read for something to deliver.

      expect(await acrossATrip("x\r")).toEqual(["a", "x", "z"]);
    });

    it("issues no read from the moment a program holds the terminal", async () => {
      // What leaves the keys typed at the program on the stream for it to
      // read. The reader is pulled continuously here, as the prompt pulls it,
      // because a reader nobody is pulling issues no read whatever this does —
      // a case that let the pulling stop would pass on a terminal with no gate
      // at all, which is what the last number below rules out.
      //
      // The count starts at the instant the terminal is taken, not after a
      // settling delay: `suspend` sets the hold in the turn it is called in,
      // and the statement before it is the last thing that runs before that,
      // so a read issued from the trip's first turn onwards is inside the
      // window this is about. A case that let turns pass before counting
      // would let the read it exists to catch land unseen.

      let issued = 0;
      let before = 0;
      let duringTheTrip = 0;
      let afterIt = 0;
      await watching(
        {
          // Long enough that the reader is still going when the trip starts.
          // A list it had already drained would leave a finished generator
          // issuing no reads for a reason that has nothing to do with the
          // gate, and the case would pass with no gate at all.
          reads: Array.from({ length: 4000 }, (_, at) => `k${at % 9}`),
          reading: () => issued++,
        },
        async (terminal) => {
          let pulling = true;
          const puller = (async () => {
            for await (const _key of terminal.keys) if (!pulling) break;
          })();
          for (let turn = 0; turn < 10; turn++) await Promise.resolve();
          before = issued;
          await terminal.suspend(async () => {
            for (let turn = 0; turn < 40; turn++) await Promise.resolve();
            duringTheTrip = issued - before;
          });
          const resumed = issued;
          for (let turn = 0; turn < 40; turn++) await Promise.resolve();
          afterIt = issued - resumed;
          pulling = false;
          await Promise.race([puller, Promise.resolve()]);
        },
      );
      // The reader was demonstrably going before the trip and demonstrably
      // going after it, and issued nothing at all in between — so the middle
      // number is a gate rather than a reader that had already stopped.
      expect(before).toBeGreaterThan(0);
      expect(duringTheTrip).toBe(0);
      expect(afterIt).toBeGreaterThan(0);
    });

    it("issues no read for a key pulled while a program holds the terminal", async () => {
      // The half of that rule the case above cannot reach. A reader parked
      // between reads when the trip begins has nothing in flight, so a pull
      // arriving during the trip is a read the gate is the only thing
      // stopping — and the key it would take is one typed at the program.

      let issued = 0;
      let duringTheTrip = 0;
      let afterwards: string | undefined;
      await watching(
        { reads: ["a", "b", "c"], reading: () => issued++ },
        async (terminal) => {
          const keys = terminal.keys[Symbol.asyncIterator]();
          await keys.next();
          // Parked at the yield with its read finished, which is the state
          // this case is about: what happens next is a read or it is not.
          const before = issued;
          let pulled: Promise<IteratorResult<Key>> | undefined;
          await terminal.suspend(async () => {
            pulled = keys.next();
            for (let turn = 0; turn < 40; turn++) await Promise.resolve();
            duringTheTrip = issued - before;
          });
          const arrived = await pulled;
          if (arrived?.done !== true) afterwards = arrived?.value.name;
          await keys.return?.(undefined);
        },
      );
      // None while it was held, and the pull answered once it was given back
      // — so the first number is a read deferred rather than a pull dropped.
      expect(duringTheTrip).toBe(0);
      expect(afterwards).toBe("b");
    });

    it("issues none from any turn the hold can fall on across one pull", async () => {
      // What a suspension can catch is a reader that has decided it may read
      // and has not yet read, so where the hold falls relative to that
      // decision is what this varies — and it is the *only* thing it varies,
      // which is what makes the set closed. One pull, reads that answer at
      // once, and the trip started after each of seven microtask turns. Every
      // scheduling this reader can be in is not a set anything here could
      // enumerate; where the hold falls across one pull is.
      //
      // Seven is measured rather than round. The reader resumes and reads
      // within two microtask turns of the pull — one read stands counted
      // before the hold on the first two rows and two from the third on — and
      // the span brackets that: the hold falls before the reader has read, on
      // the turn it reads, and four turns past it. Which turn that is belongs
      // to the reader's own composition rather than to anything a case may
      // assume, so the bracket is what keeps the row that matters inside the
      // range when the composition moves.
      //
      // Each row's count starts at the instant the terminal is taken — the
      // statement before `suspend`, which sets the hold in the turn it is
      // called in — so a read the reader had already issued is on the far
      // side of the line and a read it issues from the trip's first turn
      // onwards is inside it.

      const leaked: number[] = [];
      for (let turns = 0; turns <= 6; turns++) {
        let issued = 0;
        let during = 0;
        await watching(
          {
            // One key per read, so that a pull is a read. A two-character
            // read decodes to two keys and the second pull is served from
            // what the first one left, which is a pull that issues no read
            // for a reason that has nothing to do with the hold.
            reads: Array.from(
              { length: 40 },
              (_, at) => String.fromCharCode(97 + (at % 26)),
            ),
            reading: () => issued++,
          },
          async (terminal) => {
            const keys = terminal.keys[Symbol.asyncIterator]();
            await keys.next();
            const pending = keys.next();
            for (let turn = 0; turn < turns; turn++) await Promise.resolve();
            const before = issued;
            await terminal.suspend(async () => {
              for (let turn = 0; turn < 20; turn++) await Promise.resolve();
              during = issued - before;
            });
            await pending;
            await keys.return?.(undefined);
          },
        );
        if (during !== 0) leaked.push(turns);
      }
      // Named rather than counted, so a failure says which row let a read
      // through instead of only that one did.
      expect(leaked).toEqual([]);
    });
  });

  describe("consoleRows()", () => {
    // The height a page is bounded by, asked the way the width is: what the
    // terminal says, then what the environment declares, then an assumption.
    // Every source is stood in for, so the case says which one was read
    // rather than what this machine's terminal happens to be.

    /**
     * Helper for the cases below, which is the rows read with `size` standing
     * in for the terminal's own report and `lines` for `LINES`.
     */
    function rowsWith(
      size: () => { columns: number; rows: number },
      lines?: string,
    ): number {
      const priorSize = Deno.consoleSize;
      const priorLines = Deno.env.get("LINES");
      Deno.consoleSize = size;
      if (lines === undefined) Deno.env.delete("LINES");
      else Deno.env.set("LINES", lines);
      try {
        return consoleRows();
      } finally {
        Deno.consoleSize = priorSize;
        if (priorLines === undefined) Deno.env.delete("LINES");
        else Deno.env.set("LINES", priorLines);
      }
    }

    /** Helper for the cases below, which is a terminal that will not answer. */
    function silent(): never {
      throw new Deno.errors.NotFound("No console.");
    }

    it("returns the rows the terminal reports", () => {
      expect(rowsWith(() => ({ columns: 80, rows: 40 }), "12")).toBe(40);
    });

    it("returns what `LINES` declares where the terminal will not answer", () => {
      expect(rowsWith(silent, "12")).toBe(12);
    });

    it("returns what `LINES` declares where the terminal reports no rows", () => {
      // A terminal that cannot measure itself reports zero, which is no count
      // of rows: a page bounded by it would write a line at a time forever.

      expect(rowsWith(() => ({ columns: 80, rows: 0 }), "12")).toBe(12);
    });

    it("returns the assumed height where the environment declares no number", () => {
      expect(rowsWith(silent, "tall")).toBe(ASSUMED_ROWS);
    });

    it("returns the assumed height where nothing says at all", () => {
      expect(rowsWith(silent)).toBe(ASSUMED_ROWS);
    });

    it("reads `LINES` rather than `COLUMNS`", () => {
      // The two dimensions read two variables, and the shared helper is where
      // one could be read for the other. `COLUMNS` is set to a number this
      // case would notice.

      const priorColumns = Deno.env.get("COLUMNS");
      Deno.env.set("COLUMNS", "99");
      try {
        expect(rowsWith(silent, "12")).toBe(12);
      } finally {
        if (priorColumns === undefined) Deno.env.delete("COLUMNS");
        else Deno.env.set("COLUMNS", priorColumns);
      }
    });
  });
});
