/**
 * The out-of-band line's other producers: what a connection writes for itself,
 * and what a pattern writes to its console.
 *
 * Neither is shuttle's own output and neither passes through a verb. A
 * connect's cleanup warns, the navigate callback writes the line a script
 * greps for, and a pattern calls `console.log` from inside the runtime — all
 * of them while a prompt is painted, in raw mode, where a line written to the
 * process's own streams lands in the middle of the drawing without the
 * carriage return raw mode needs. So the connection is opened with these
 * instead, and everything they take goes where a line's outcome goes
 * (`prompt.ts`).
 *
 * What holds them to the class a terminal acts on is the door rather than this
 * module: `above` (`paint.ts`) glyphs every character of that class before any
 * of it is sent, which is what a producer authored by a user program needs and
 * what nothing here could be trusted to remember.
 */

import type { ConsoleHandler } from "@commonfabric/runner";

import { format, inspect } from "../deps.ts";
import type { ConnectionOutput } from "../piece.ts";

/** Where a line lands: the prompt's out-of-band write, or a case's record. */
export type Announce = (text: string) => void;

/**
 * The connection output that sends everything to `announce`.
 *
 * One sink for all of it, because all of it is the same thing to a person
 * reading a transcript: something happened that no line of theirs asked for.
 * Telling a warning from a pattern's own logging is what the text says, not
 * what the stream it arrived on says — and a shell holding one screen has one
 * stream anyway.
 */
export function announcingOutput(announce: Announce): ConnectionOutput {
  return { report: announce, consoleHandler: announcingConsole(announce) };
}

/**
 * Helper for {@link announcingOutput}, which is the handler that sends a
 * pattern's console output to `announce`.
 *
 * The console it names is a proxy rather than an object with methods on it,
 * and that is the whole of how this module keeps its promise. The promise is
 * that **nothing a pattern can call reaches a terminal except through
 * `announce`**, and a promise of that shape cannot be kept by handling the
 * methods somebody listed: the proxy answers *every* property with a function
 * that ends in `announce`, so there is no name — in `ConsoleMethod` or
 * outside it — that reaches anything else, and no method left over to be the
 * one nobody thought of.
 *
 * A real console cannot keep it. Node's writes some of its output through a
 * path of its own that no stream a caller supplies is on: `timeLog` and
 * `timeEnd` on a label no timer holds, `time` on one it already holds, and
 * `countReset` on a count that is not there each raise a *process warning*,
 * which goes to the process's stderr whatever console the message was written
 * to. The label is a pattern's own string, so a pattern that picked one
 * carrying an escape sequence would have written that sequence, raw and
 * unglyphed, straight onto the operator's terminal. Those four are the ones
 * that do it today, and the reason for the proxy is that the list is Node's
 * to change.
 *
 * So the state those methods read is held here, and an ask they cannot answer
 * becomes a line of shuttle's own — announced, and glyphed at the door like
 * everything else.
 */
function announcingConsole(announce: Announce): ConsoleHandler {
  const saying: Saying = {
    timers: new Map(),
    counts: new Map(),
    depth: 0,
    announce,
  };
  const console = new Proxy({}, {
    get: (_held, property) => (...args: unknown[]) =>
      said(String(property), args, saying),
  }) as unknown as Console;
  return ({ method, args }) => ({ target: console, method, args });
}

/** What a console call needs beside its arguments to say anything. */
interface Saying {
  /** When each running timer was started, by the label naming it. */
  readonly timers: Map<string, number>;

  /** How far each count has got, by the label naming it. */
  readonly counts: Map<string, number>;

  /** How many groups are open, which is how far a line is indented. */
  depth: number;

  /** Where the line goes. */
  readonly announce: Announce;
}

/**
 * Helper for {@link said}, which announces `text` at the depth the open
 * groups put it.
 *
 * The indent is this console's rather than the door's, so it is added here
 * and not in `above` (`paint.ts`): a line shuttle writes for itself is not
 * inside a pattern's group.
 *
 * The depth follows the calls and nothing bounds it, which is deliberate and
 * is what a console does with the same calls: a pattern that opens groups it
 * never closes indents every line it writes after them for the rest of the
 * run, and so reads here what it would read written anywhere else. What that
 * costs is a transcript whose pattern lines start further right the more
 * groups went unclosed, with no way back short of ending the run.
 *
 * The lines a connection writes for itself are not among them. They reach the
 * prompt through {@link announcingOutput}'s `report`, which is the sink
 * itself, so they stay at the left margin whatever a pattern has opened —
 * which is what keeps the indent a reading of a pattern's own nesting rather
 * than of the transcript.
 */
function line(saying: Saying, text: string): void {
  saying.announce(`${"  ".repeat(saying.depth)}${text}`);
}

/**
 * Helper for the label-taking methods, which is the label `args` names.
 *
 * It is asked for by the five methods that take one and by nothing else. A
 * console coerces its label to a string, and a coercion is a thing a value
 * can refuse — `Object.create(null)` has no `toString` and throws rather than
 * converting — so a method that takes no label must never reach this. What it
 * takes instead is the formatter, which inspects such a value rather than
 * converting it.
 */
function labelOf(args: unknown[]): string {
  return args.length === 0 ? "default" : String(args[0]);
}

/**
 * Helper for {@link announcingConsole}, which says what a call to `method`
 * with `args` says.
 *
 * The formatting is `node:util`'s, which is what a console composes its own
 * line with, so what a pattern sees is what it would have seen written
 * anywhere else. What the arms below carry is the part formatting does not:
 * the methods whose meaning is more than "write the arguments".
 *
 * The survey behind them was measured against a real console rather than
 * remembered, and it divides that surface three ways.
 *
 * **Given its meaning here.** `assert` is silent when it holds and writes
 * `Assertion failed` when it does not; `dir` inspects its first argument
 * under the options its second gives and ignores the rest; `group` writes its
 * heading and indents what follows, `groupEnd` un-indents; `trace` carries
 * its `Trace:` prefix; and the five labelled methods keep the state they
 * read. Those are the ones a caller can tell apart from `log`.
 *
 * **Flattened on purpose.** `table` draws a box on a real console, and what
 * arrives here instead is the same rows as the formatter writes them — the
 * data is the same and a table renderer is not something a shell should be
 * carrying a second copy of. `trace`'s stack is dropped for a harder reason:
 * the runtime hands this a method and its arguments and no call site, so
 * there is no stack here to write. `dirxml` is not flattened at all — a
 * console's own is `log`, which is the arm it falls to.
 *
 * **Refused on purpose.** `clear` empties a terminal, and a pattern emptying
 * an operator's terminal is the harm this module exists to stop. It is
 * answered and does nothing, which is also what a console over a stream does.
 * `timeStamp` is a profiler mark that writes nowhere.
 *
 * Every other name — the rest of `ConsoleMethod`, and any name at all that is
 * not in it — falls to the last arm and is announced. That arm is what makes
 * the proxy's promise good: a method this function has never heard of is a
 * line, not a way out.
 */
function said(method: string, args: unknown[], saying: Saying): void {
  switch (method) {
    case "clear":
    case "timeStamp":
      return;
    case "group":
    case "groupCollapsed":
      if (args.length > 0) line(saying, format(...args));
      saying.depth += 1;
      return;
    case "groupEnd":
      saying.depth = Math.max(saying.depth - 1, 0);
      return;
    case "assert": {
      const [held, ...rest] = args;
      if (held) return;
      line(
        saying,
        rest.length === 0
          ? "Assertion failed"
          : `Assertion failed: ${format(...rest)}`,
      );
      return;
    }
    case "dir":
      line(
        saying,
        inspect(args[0], (args[1] ?? {}) as Parameters<typeof inspect>[1]),
      );
      return;
    case "trace":
      line(
        saying,
        args.length === 0 ? "Trace" : `Trace: ${format(...args)}`,
      );
      return;
    case "time": {
      // A console writes nothing for a timer it starts, so neither does this;
      // one it cannot start is the ask it cannot answer, and that is a line.
      const label = labelOf(args);
      if (saying.timers.has(label)) {
        line(saying, `A timer called \`${label}\` is already running.`);
        return;
      }
      saying.timers.set(label, performance.now());
      return;
    }
    case "timeLog":
    case "timeEnd": {
      const label = labelOf(args);
      const started = saying.timers.get(label);
      if (started === undefined) {
        line(saying, `No timer called \`${label}\` is running.`);
        return;
      }
      if (method === "timeEnd") saying.timers.delete(label);
      const rest = args.slice(1);
      line(
        saying,
        `${label}: ${(performance.now() - started).toFixed(3)}ms` +
          (rest.length === 0 ? "" : ` ${format(...rest)}`),
      );
      return;
    }
    case "count": {
      const label = labelOf(args);
      const next = (saying.counts.get(label) ?? 0) + 1;
      saying.counts.set(label, next);
      line(saying, `${label}: ${next}`);
      return;
    }
    case "countReset": {
      const label = labelOf(args);
      if (saying.counts.has(label)) saying.counts.set(label, 0);
      else line(saying, `No count called \`${label}\` is being kept.`);
      return;
    }
    default:
      line(saying, format(...args));
  }
}
