/**
 * Covers the stderr budget the CLI tests hold a command to:
 * `relevantStderr()`, which says which of the lines a command wrote to stderr
 * a test has business counting, and `checkStderr()`, which holds that count
 * to the one line `deno task` echoes.
 *
 * What the budget counts is a record rather than a line, because a console
 * handed a value too wide for one line writes it back across several. So the
 * fixtures come from a real logger rather than being written out here: the
 * prefix a logger writes and the shape a console gives a spilled value are
 * the two things the budget reads, and a string composed here would pin these
 * tests to a guess at that shape instead of to the shape itself.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { decode } from "@commonfabric/utils/encoding";
import { getLogger } from "@commonfabric/utils/logger";
import { captureStderr, checkStderr, relevantStderr } from "./utils.ts";

// The line `deno task` echoes before it runs the CLI. Every command the tests
// spawn goes through that task, so it is the one line a passing budget holds.
const TASK_ECHO =
  "Task cli-no-pwd-override CF_CLI_NAME=cf deno run --allow-net ./mod.ts 'id'";

/**
 * Emits `key` and `messages` through a real logger named `loggerName` at
 * `level`, and returns the stderr lines it writes.
 *
 * The prefix carries a timestamp and a shape only the logger knows, and a
 * console inspects a value too wide for a line across several, so both come
 * from the real thing rather than being written out here.
 *
 * A logger writes straight to stderr under `LOG_TO_STDERR` and through a
 * console otherwise, and both are captured, so what these tests hold is the
 * same either way. On the console path `%c` heads the prefix and its CSS
 * follows as a separate argument, which a console consumes to color what comes
 * next; rendering the rest is what the logger's own stderr path does with it.
 */
function logLines(
  level: "warn" | "error",
  loggerName: string,
  key: string,
  ...messages: unknown[]
): string[] {
  const logger = getLogger(loggerName, { enabled: true, level: "warn" });
  const lines: string[] = [];
  const originalConsole = console[level];
  const originalWrite = Deno.stderr.writeSync;
  console[level] = (...args: unknown[]) => {
    const [prefix, _color, ...rest] = args as [string, string, ...unknown[]];
    lines.push(render(prefix.replace("%c", ""), rest));
  };
  Deno.stderr.writeSync = (bytes: Uint8Array) => {
    lines.push(decode(bytes).trimEnd());
    return bytes.byteLength;
  };
  try {
    logger[level](key, ...messages);
  } finally {
    console[level] = originalConsole;
    Deno.stderr.writeSync = originalWrite;
  }
  return lines.join("\n").split("\n");
}

// Renders one log record the way the logger renders it for stderr: each value
// that is not already a string inspected, and the lot joined by spaces.
function render(prefix: string, values: unknown[]): string {
  return [
    prefix,
    ...values.map((value) =>
      typeof value === "string" ? value : Deno.inspect(value, { colors: false })
    ),
  ].join(" ");
}

// A slow-traversal report as a console renders it, its prefix wrapped in the
// escapes that color it. The prefix is the first space-delimited token of the
// line, which is what the logger hands the console separately from the rest.
function coloredSlowTraverseLine(): string {
  const [prefix, ...rest] = logLines(
    "warn",
    "traverse",
    "slow-traverse",
    "321ms",
  )[0].split(" ");
  return `\x1b[36m${prefix}\x1b[0m ${rest.join(" ")}`;
}

// A line of a stack trace, which is indented and holds a balanced pair of
// parentheses, so nothing about its own shape says whether it continues the
// line above it.
const STACK_LINE = "    at executeCommand (cli.ts:42:7)";

// The link a slow-`Cell.get` report names. It is too wide for one line, so a
// console inspects it across several.
const REPORTED_LINK = {
  id: "of:baedreiaddonutdonutdonutdonutdonutdonutdonutdonutdonutdonut",
  path: ["value", "items", "0", "label"],
  space: "did:key:z6MkdonutdonutdonutdonutdonutdonutdonutdonutdonutXY",
  type: "application/json",
};

// The same link, with a path segment that is a bracket. A segment is
// arbitrary text, and a console prints this one in its quotes, indented, on a
// line of the record's own.
const LINK_WITH_A_BRACKET_IN_ITS_PATH = { ...REPORTED_LINK, path: ["["] };

// A link narrow enough for a console to print on one line, holding the same
// bracket.
const NARROW_LINK_WITH_A_BRACKET = { path: ["["] };

describe("stderr budget", () => {
  describe("relevantStderr()", () => {
    it("keeps a line the command itself wrote", () => {
      expect(relevantStderr([TASK_ECHO, "no such piece"])).toEqual([
        TASK_ECHO,
        "no such piece",
      ]);
    });

    it("drops the lines Deno writes for a cold module cache", () => {
      expect(relevantStderr([
        "Download https://jsr.io/@std/path/1.0.0/mod.ts",
        TASK_ECHO,
      ])).toEqual([TASK_ECHO]);
    });

    it("drops a slow-traversal report, which fires on wall time", () => {
      const report = logLines(
        "warn",
        "traverse",
        "slow-traverse",
        "321ms",
        "doc=of:donut/application/json",
      );

      expect(report.length).toBe(1);
      expect(relevantStderr([TASK_ECHO, ...report])).toEqual([TASK_ECHO]);
    });

    it("drops a report whose prefix a console colored", () => {
      expect(relevantStderr([TASK_ECHO, coloredSlowTraverseLine()])).toEqual([
        TASK_ECHO,
      ]);
    });

    it("keeps a line that follows a report whose prefix a console colored", () => {
      const colored = coloredSlowTraverseLine();

      expect(relevantStderr([TASK_ECHO, colored, "no such piece"])).toEqual([
        TASK_ECHO,
        "no such piece",
      ]);
    });

    it("drops every line of a report whose value a console inspected", () => {
      const report = logLines(
        "warn",
        "cell",
        "get >210ms",
        "get() took 213ms",
        REPORTED_LINK,
      );

      expect(report.length).toBeGreaterThan(1);
      expect(relevantStderr([TASK_ECHO, ...report])).toEqual([TASK_ECHO]);
    });

    it("drops every line of a report whose message closes a bracket it never opened", () => {
      const report = logLines(
        "warn",
        "cell",
        "get >210ms",
        "get() took 213ms)",
        REPORTED_LINK,
      );

      expect(report.length).toBeGreaterThan(1);
      expect(relevantStderr([TASK_ECHO, ...report])).toEqual([TASK_ECHO]);
    });

    it("keeps a command's line that follows an ignorable record", () => {
      const report = logLines("warn", "traverse", "slow-traverse", "321ms");

      expect(relevantStderr([...report, "no such piece"])).toEqual([
        "no such piece",
      ]);
    });

    it("keeps an indented line that follows a report closing on its own line", () => {
      const report = logLines("warn", "traverse", "slow-traverse", "321ms");

      expect(report.length).toBe(1);
      expect(relevantStderr([TASK_ECHO, ...report, STACK_LINE])).toEqual([
        TASK_ECHO,
        STACK_LINE,
      ]);
    });

    it("keeps an indented line that follows a report whose value holds a bracket", () => {
      const report = logLines(
        "warn",
        "cell",
        "get >210ms",
        "get() took 213ms",
        LINK_WITH_A_BRACKET_IN_ITS_PATH,
      );

      expect(report.length).toBeGreaterThan(1);
      expect(relevantStderr([TASK_ECHO, ...report, STACK_LINE])).toEqual([
        TASK_ECHO,
        STACK_LINE,
      ]);
    });

    it("keeps an indented line that follows a report holding a bracket on one line", () => {
      const report = logLines(
        "warn",
        "cell",
        "get >210ms",
        "get() took 213ms",
        NARROW_LINK_WITH_A_BRACKET,
      );

      expect(report.length).toBe(1);
      expect(relevantStderr([TASK_ECHO, ...report, STACK_LINE])).toEqual([
        TASK_ECHO,
        STACK_LINE,
      ]);
    });

    it("keeps an error a logger wrote under a perf-diagnostic key", () => {
      const report = logLines("error", "traverse", "slow-traverse", "321ms");

      expect(relevantStderr(report)).toEqual(report);
    });

    it("keeps a warning a logger wrote about behavior", () => {
      const report = logLines("warn", "cell", "pull", "no such document");

      expect(relevantStderr(report)).toEqual(report);
    });
  });

  describe("checkStderr()", () => {
    it("accepts stderr holding only the task echo", () => {
      checkStderr([TASK_ECHO]);
    });

    it("accepts a slow-traversal report beside the task echo", () => {
      const report = logLines("warn", "traverse", "slow-traverse", "321ms");

      checkStderr([TASK_ECHO, ...report]);
    });

    it("throws where the command wrote a line of its own", async () => {
      // `checkStderr` prints the whole of stderr before it rethrows, so the
      // failing call runs under a captured console.

      await captureStderr(() => {
        expect(() => checkStderr([TASK_ECHO, "no such piece"])).toThrow();
        return Promise.resolve();
      });
    });

    it("throws where an indented line follows a slow-traversal report", async () => {
      const report = logLines("warn", "traverse", "slow-traverse", "321ms");

      await captureStderr(() => {
        expect(() => checkStderr([TASK_ECHO, ...report, STACK_LINE]))
          .toThrow();
        return Promise.resolve();
      });
    });

    it("throws where an indented line follows a report whose value holds a bracket", async () => {
      const report = logLines(
        "warn",
        "cell",
        "get >210ms",
        "get() took 213ms",
        LINK_WITH_A_BRACKET_IN_ITS_PATH,
      );

      await captureStderr(() => {
        expect(() => checkStderr([TASK_ECHO, ...report, STACK_LINE]))
          .toThrow();
        return Promise.resolve();
      });
    });
  });
});
