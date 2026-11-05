/**
 * Unit tests for the out-of-band line's other producers: what a connection
 * writes for itself, and what a pattern writes to its console.
 *
 * A case drives the console handler the way the runtime does — it asks the
 * handler where to write and writes there — because the handler names a
 * destination rather than writing to one, and what a case is asking about is
 * where the writing ends up.
 *
 * Nothing here escapes anything. The class a terminal acts on is held to at
 * the door these feed (`above`, `paint.ts`), where every producer meets it
 * whether or not it went through this module, and that is where the cases for
 * it are.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type ConsoleHandler, ConsoleMethod } from "@commonfabric/runner";

import { announcingOutput } from "../lib/shuttle/announce.ts";

/**
 * Helper for the cases below, which writes `args` through `handler` the way
 * the scheduler does: the handler names a console and a method, and the
 * arguments go to that method on that console (`scheduler/facade.ts`).
 */
function through(
  handler: ConsoleHandler,
  method: string,
  ...args: unknown[]
): unknown {
  const answered = handler(
    { metadata: undefined, method: method as ConsoleMethod, args },
  );
  const output = Array.isArray(answered)
    ? { method: method as ConsoleMethod, args: answered }
    : answered;
  const target = output.target ?? console;
  // deno-lint-ignore no-explicit-any
  (target as any)[output.method].apply(target, output.args);
  return target;
}

/** Helper for the cases below, which is an output collecting what it took. */
function collecting(): {
  lines: string[];
  output: ReturnType<
    typeof announcingOutput
  >;
} {
  const lines: string[] = [];
  return { lines, output: announcingOutput((text) => lines.push(text)) };
}

describe("announce", () => {
  describe("announcingOutput()", () => {
    it("takes each line the connection writes for itself", () => {
      const { lines, output } = collecting();
      output.report?.("loadPieces cleanup failed: the socket was gone");
      expect(lines).toEqual(["loadPieces cleanup failed: the socket was gone"]);
    });

    it("takes what a pattern wrote to its console", () => {
      const { lines, output } = collecting();
      through(output.consoleHandler!, ConsoleMethod.Log, "counted", 3);
      expect(lines).toEqual(["counted 3"]);
    });

    it("answers every method a pattern's console can call, on one console of its own", () => {
      // `ConsoleMethod` is the whole surface a pattern reaches, so the claim
      // is about all twenty rather than the handful anybody logs with. But
      // twenty is still a list, and a list is what a console's own surface
      // stops being the moment Node adds to it — so the last row is a name
      // that is in no enum at all, and it has to be answered too. That is the
      // property the proxy has and an object with methods on it does not.
      //
      // The console each answer names is compared, not merely counted: an
      // assertion over what `through` returned reads as a set of one however
      // the routing behaves if what it returns is nothing.

      const { lines, output } = collecting();
      const targets = new Set<unknown>();
      for (
        const method of [...Object.values(ConsoleMethod), "notAConsoleMethod"]
      ) {
        let target: unknown = "never called";
        expect(() => {
          target = through(output.consoleHandler!, method, "x");
        }, `console.${method}`).not.toThrow();
        targets.add(target);
      }
      expect(targets.size).toBe(1);
      expect([...targets][0]).not.toBe(console);
      expect([...targets][0]).not.toBe(undefined);
      // And the ones that do write wrote here: a handler naming one console
      // that writes nothing would pass every assertion above.
      expect(lines.length).toBeGreaterThan(0);
    });

    it("writes a value that refuses to be a string, rather than throwing on it", () => {
      // A null-prototype object has no `toString`, so coercing one throws —
      // and a console does not coerce, it inspects. Asking every method for a
      // label was what put a coercion in front of `log`, where a value that
      // is perfectly loggable then announced nothing at all.

      const { lines, output } = collecting();
      const held = Object.create(null);
      held.a = 1;
      expect(() => through(output.consoleHandler!, ConsoleMethod.Log, held))
        .not.toThrow();
      expect(lines).toEqual(["[Object: null prototype] { a: 1 }"]);
    });

    it("says nothing for an assertion that holds, and names one that does not", () => {
      // `assert` is the method whose meaning is a condition. Formatting its
      // arguments the way `log` does turns a silent success into the line
      // `true should be silent`, which is worse than losing it: it reads as
      // something a pattern chose to say.

      const { lines, output } = collecting();
      through(output.consoleHandler!, ConsoleMethod.Assert, true, "silent");
      expect(lines).toEqual([]);
      through(output.consoleHandler!, ConsoleMethod.Assert, false, "loud");
      through(output.consoleHandler!, ConsoleMethod.Assert, false);
      expect(lines).toEqual(["Assertion failed: loud", "Assertion failed"]);
    });

    it("gives each method whose meaning is more than its arguments that meaning", () => {
      // The survey, as the rows a caller can tell apart from `log`. Each was
      // measured against a real console rather than remembered, and each is
      // here because a blanket answer got it wrong: a blanket answer with the
      // two that were caught patched into it would be the same defect with
      // two fewer instances.

      const { lines, output } = collecting();
      // `dir` inspects its first argument and ignores what follows it.
      through(
        output.consoleHandler!,
        ConsoleMethod.Dir,
        { a: { b: 1 } },
        {},
        "ignored",
      );
      // `trace` carries its prefix.
      through(output.consoleHandler!, ConsoleMethod.Trace, "why");
      // `group` writes its heading, then indents what follows until the end.
      through(output.consoleHandler!, ConsoleMethod.Group, "heading");
      through(output.consoleHandler!, ConsoleMethod.Log, "inside");
      through(output.consoleHandler!, ConsoleMethod.GroupEnd);
      through(output.consoleHandler!, ConsoleMethod.Log, "outside");
      expect(lines).toEqual([
        "{ a: { b: 1 } }",
        "Trace: why",
        "heading",
        "  inside",
        "outside",
      ]);
    });

    it("writes nothing for the two a pattern must not be able to write with", () => {
      // `clear` empties a terminal, and a pattern emptying an operator's
      // terminal is the harm this module exists to stop, so it is answered
      // and does nothing. `timeStamp` is a profiler mark that writes nowhere
      // on any console. Both are refusals rather than omissions.

      const { lines, output } = collecting();
      through(output.consoleHandler!, ConsoleMethod.Clear);
      through(output.consoleHandler!, ConsoleMethod.TimeStamp);
      expect(lines).toEqual([]);
    });

    it("flattens a table to the rows the formatter writes, which is deliberate", () => {
      // Recorded rather than implemented: a console draws a box, and the same
      // rows written by the formatter carry the same data. A table renderer
      // is not a thing a shell should hold a second copy of, and this case is
      // here so that the flattening is a decision somebody made.

      const { lines, output } = collecting();
      through(output.consoleHandler!, ConsoleMethod.Table, [{ a: 1 }, {
        a: 2,
      }]);
      expect(lines).toEqual(["[ { a: 1 }, { a: 2 } ]"]);
    });

    it("keeps the label state Node would have warned about, and says so itself", () => {
      // The path that reached a terminal without passing the door. Node's
      // console raises a *process warning* for a label it has no timer or
      // count for, and a process warning goes to the process's stderr
      // whatever console the call was made on — carrying the label, which is
      // a pattern's own string. A pattern picking a label made of an escape
      // sequence would have cleared the operator's screen with it.
      //
      // So the state is held here and the ask that cannot be answered is a
      // line of shuttle's own. Each row below is an ask Node warns for.

      for (
        const [method, said] of [
          ["timeEnd", "No timer called `missing` is running."],
          ["timeLog", "No timer called `missing` is running."],
          ["countReset", "No count called `missing` is being kept."],
        ] as const
      ) {
        const { lines, output } = collecting();
        through(output.consoleHandler!, method, "missing");
        expect({ method, lines }).toEqual({ method, lines: [said] });
      }

      // The fourth: a timer started twice. The first start says nothing, as a
      // console says nothing for one it takes.
      const { lines, output } = collecting();
      through(output.consoleHandler!, "time", "twice");
      through(output.consoleHandler!, "time", "twice");
      expect(lines).toEqual(["A timer called `twice` is already running."]);
    });

    it("announces a label carrying an escape rather than letting it out", () => {
      // The harm the case above prevents, named as the thing it is: the label
      // is the pattern's, it reaches the announce line, and the door glyphs
      // it there (`above`, `paint.ts`). What must not happen is that it goes
      // anywhere else, which is what a warning did.

      const { lines, output } = collecting();
      through(output.consoleHandler!, "timeLog", "missing\u001b[2J");
      expect(lines).toEqual(["No timer called `missing\u001b[2J` is running."]);
    });

    it("keeps a timer and a count for a pattern that uses them properly", () => {
      // The other side of the state: holding it is not only about the ask
      // that fails, and a pattern timing its own work still gets its line.

      const { lines, output } = collecting();
      through(output.consoleHandler!, "time", "work");
      through(output.consoleHandler!, "timeEnd", "work");
      through(output.consoleHandler!, "count", "hits");
      through(output.consoleHandler!, "count", "hits");
      expect(lines.length).toBe(3);
      expect(lines[0]).toMatch(/^work: [0-9]+\.[0-9]{3}ms$/);
      expect(lines.slice(1)).toEqual(["hits: 1", "hits: 2"]);
    });

    it("takes one line per console call, with no ending of its own", () => {
      // The destination separates its own lines, so the break the console put
      // at the end of the message would be a blank row under every one of
      // them.

      const { lines, output } = collecting();
      through(output.consoleHandler!, ConsoleMethod.Log, "one");
      through(output.consoleHandler!, ConsoleMethod.Log, "two");
      expect(lines).toEqual(["one", "two"]);
    });

    it("keeps a break inside a message, which is the message's own", () => {
      const { lines, output } = collecting();
      through(output.consoleHandler!, ConsoleMethod.Log, "one\ntwo");
      expect(lines).toEqual(["one\ntwo"]);
    });

    it("formats what a pattern passed the way a console does", () => {
      // The arguments are whatever a pattern handed `console.log`, and turning
      // those into a line is a console's own job rather than a job this
      // module should be doing a second way.

      const { lines, output } = collecting();
      through(output.consoleHandler!, ConsoleMethod.Log, { a: 1 }, [2, 3]);
      expect(lines[0]).toContain("a: 1");
      expect(lines[0]).toContain("2");
    });

    it("answers a `timeStamp`, which a console over a stream has none of", () => {
      // A profiler mark is not a write, and Node's console over a stream
      // carries no method for it — so a pattern calling it would find nothing
      // there and the runtime would throw inside its own console dispatch.

      const { lines, output } = collecting();
      expect(() => through(output.consoleHandler!, ConsoleMethod.TimeStamp))
        .not.toThrow();
      expect(lines).toEqual([]);
    });
  });
});
