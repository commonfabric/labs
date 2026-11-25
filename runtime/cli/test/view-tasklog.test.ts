import { expect } from "@std/expect";

import {
  link,
  name,
  plainText,
  pullRequest,
  quote,
  say,
  TaskLog,
  type TaskRow,
  words,
} from "../lib/view/tasklog.ts";
import { describe, it } from "@commonfabric/test-support/test";

const URL = "https://github.com/octo/repo/pull/7";

/** The rows `logs` lay out in `columns` columns, with spinners at `frame`. */
function rows(
  logs: TaskLog | readonly TaskLog[],
  columns = 40,
  frame = 0,
): TaskRow[] {
  return TaskLog.rows(logs instanceof TaskLog ? [logs] : logs, columns, frame);
}

/** The text of the rows `logs` lay out in `columns` columns. */
function texts(logs: TaskLog | readonly TaskLog[], columns = 40): string[] {
  return rows(logs, columns).map((row) => row.text);
}

/** A log holding what `fill` adds to it. */
function logOf(fill: (log: TaskLog) => void): TaskLog {
  const log = new TaskLog();
  fill(log);
  return log;
}

describe("view-tasklog", () => {
  describe("say()", () => {
    it("marks its literal parts as the viewer's words and each string substituted as a name", () => {
      expect(say`Pushing ${"feature"} to ${"origin"}`).toEqual([
        { text: "Pushing ", tone: "text" },
        { text: "feature", tone: "name" },
        { text: " to ", tone: "text" },
        { text: "origin", tone: "name" },
      ]);
    });

    it("keeps quotes that follow each other apart, each a block of its own", () => {
      expect(say`${quote("one")}${quote("two")}`).toEqual([
        { text: "one", tone: "quote" },
        { text: "two", tone: "quote" },
      ]);
    });

    it("keeps each span and text substituted as it is, and leaves out empty pieces", () => {
      expect(say`${link(URL)}: ${quote("refused")}${say`, ${"twice"}`}${""}`)
        .toEqual([
          { text: URL, tone: "name", url: URL },
          { text: ": ", tone: "text" },
          { text: "refused", tone: "quote" },
          { text: ", ", tone: "text" },
          { text: "twice", tone: "name" },
        ]);
    });
  });

  describe("plainText()", () => {
    it("returns the text of every piece, one after the other, each line of a quote ending as a sentence", () => {
      expect(plainText(say`Failed: ${quote(" no  way\n\nnot now ")} Again.`))
        .toBe("Failed: no way. not now. Again.");
      expect(plainText(say`Failed: ${quote("it broke!")}`)).toBe(
        "Failed: it broke!",
      );
      expect(plainText(say`Pushed ${"feature"}.`)).toBe("Pushed feature.");
      expect(plainText(say`Push?\nYes.`)).toBe("Push? Yes.");
    });
  });

  describe("name(), link(), pullRequest(), quote(), and words()", () => {
    it("return a name that links only when given an address, an address that links to itself, a pull request's number that links to its page, a quote, and the viewer's words", () => {
      expect(name("feature")).toEqual([{ text: "feature", tone: "name" }]);
      expect(name("feature", URL)).toEqual([
        { text: "feature", tone: "name", url: URL },
      ]);
      expect(link(URL)).toEqual([{ text: URL, tone: "name", url: URL }]);
      expect(pullRequest(7, URL)).toEqual([
        { text: "7", tone: "name", url: URL },
      ]);
      expect(quote("refused")).toEqual([{ text: "refused", tone: "quote" }]);
      expect(words("Pushed.")).toEqual([{ text: "Pushed.", tone: "text" }]);
    });
  });

  describe("TaskLog", () => {
    describe("instance members", () => {
      describe("complete()", () => {
        it("ends each running step as done, and leaves a step that has ended as it was, whatever ends it later", () => {
          const log = new TaskLog();
          const failing = log.step(say`Failing`);
          log.stop();
          const waiting = log.step(say`Waiting`);

          log.complete();
          failing();
          waiting();

          expect(texts(log)).toEqual(["Failing... ✗", "", "Waiting... ✓"]);
        });
      });

      describe("stop()", () => {
        it("shows the last running step as ended without being done, and leaves the steps running around it with no mark", () => {
          const log = logOf((log) => {
            log.step(say`Creating`);
            log.step(say`Touch the key`, "person");
          });

          log.stop();

          expect(texts(log)).toEqual(["Creating...", "", "Touch the key ✗"]);
          expect(TaskLog.spinning([log])).toBe(false);
        });
      });
    });

    describe("static members", () => {
      describe("rows()", () => {
        it("keeps a character whole whose code points fall in two pieces, drawing it as its first code point's piece", () => {
          const [row, ...rest] = rows(
            logOf((log) => log.say(say`ab${"c"}${words("\u0301")}`)),
            3,
          );

          expect(rest).toEqual([]);
          expect(row.text).toBe("abc\u0301");
          expect(row.spans).toEqual([
            { from: 0, to: 2, tone: "bright" },
            { from: 2, to: 4, tone: "name" },
          ]);
        });

        it("breaks a step too wide for its row before its dots, never inside them or before its spinner", () => {
          const log = logOf((log) => log.step(words("x".repeat(10))));

          for (const columns of [11, 12, 13, 14]) {
            expect(texts(log, columns)).toEqual(["x".repeat(10), "... ◐"]);
          }
        });

        it("indents a quote only as far as a narrow row leaves room for, and keeps what ends its lines other than spaces", () => {
          const log = logOf((log) => log.quote("ab\t  \n"));

          expect(texts(log, 1)).toEqual(["a", "b", "\t"]);
          expect(texts(log, 2)).toEqual([" a", " b", " \t"]);
          expect(texts(log, 6)).toEqual(["  ab\t"]);
        });

        it("adds no empty row after a line whose last character took a row of its own", () => {
          const log = logOf((log) => log.say(words("a漢\nb")));

          expect(texts(log, 1)).toEqual(["a", "漢", "b"]);
        });

        it("starts no row with the spaces after the space it wrapped at", () => {
          const log = logOf((log) => log.say(words("aaaa   bbbb")));

          expect(texts(log, 5)).toEqual(["aaaa", "bbbb"]);
        });

        it("links no address in the viewer's words that runs into a link of its own", () => {
          const [row] = rows(
            logOf((log) => log.say(say`see https://a.test/${name("x", URL)}`)),
            60,
          );

          expect(row.spans).toEqual([
            { from: 0, to: 19, tone: "bright" },
            { from: 19, to: 20, tone: "name", url: URL },
          ]);
        });

        it("wraps by the columns characters take, keeping each character's code points together, and counts each span in code points", () => {
          const accented = "e\u0301";
          const laidOut = rows(
            logOf((log) => {
              log.quote("漢字漢字");
              log.say(say`${words(accented)}${name("漢", URL)}`);
            }),
            6,
          );

          expect(laidOut.map((row) => row.text)).toEqual([
            "  漢字",
            "  漢字",
            "",
            `${accented}漢`,
          ]);
          expect(laidOut[3].spans).toEqual([
            { from: 0, to: 2, tone: "bright" },
            { from: 2, to: 3, tone: "name", url: URL },
          ]);
        });

        it("links each web address in the viewer's words to the whole address, and leaves a link it was given as it is", () => {
          const address = "https://relay.example.test/a";
          const [row, blank, named] = rows(
            logOf((log) => {
              log.say(words(`no ${address}.`));
              log.say(say`at ${name("relay", URL)}`);
            }),
            60,
          );

          expect(row.spans).toEqual([
            { from: 0, to: 3, tone: "bright" },
            { from: 3, to: 3 + address.length, tone: "bright", url: address },
            {
              from: 3 + address.length,
              to: 4 + address.length,
              tone: "bright",
            },
          ]);
          expect(blank.text).toBe("");
          expect(named.spans).toEqual([
            { from: 0, to: 3, tone: "bright" },
            { from: 3, to: 8, tone: "name", url: URL },
          ]);
        });

        it("ends a link at the address a step ends with, before the step's dots", () => {
          const address = "https://relay.example.test/a";
          const [row] = rows(
            logOf((log) => log.step(words(`Reading ${address}`))),
            60,
          );

          expect(row.text).toBe(`Reading ${address}... ◐`);
          expect(row.spans.filter((span) => span.url !== undefined)).toEqual([
            { from: 8, to: 8 + address.length, tone: "bright", url: address },
          ]);
        });

        it("keeps a step's spinner on the row of its last word", () => {
          const log = logOf((log) => log.step(say`Pushing the branch`));

          expect(texts(log, 22)).toEqual(["Pushing the", "branch... ◐"]);
          expect(texts(log, 23)).toEqual(["Pushing the branch... ◐"]);
        });

        it("indents what another program wrote two columns, drawn plain, with a blank row between it and what comes before and after", () => {
          const log = logOf((log) => {
            log.say(say`Before.`);
            log.quote("one\ntwo\n");
            log.say(say`After.`);
          });

          expect(texts(log)).toEqual([
            "Before.",
            "",
            "  one",
            "  two",
            "",
            "After.",
          ]);
          expect(rows(log)[2].spans).toEqual([
            { from: 0, to: 5, tone: "plain" },
          ]);
        });

        it("puts no blank row before a quote that starts the log, or after one that ends it", () => {
          expect(texts(logOf((log) => log.quote("only\n")))).toEqual([
            "  only",
          ]);
        });

        it("puts one blank row between quotes that follow each other", () => {
          const log = logOf((log) => {
            log.quote("git said this\n");
            log.say(say`${quote("GitHub said that")}`);
          });

          expect(texts(log)).toEqual([
            "  git said this",
            "",
            "  GitHub said that",
          ]);
        });

        it("lays a quote among the viewer's words out as a block of its own, with the words before and after it on lines of their own", () => {
          const log = logOf((log) =>
            log.say(say`Landing failed: ${quote("not mergeable")} Try again.`)
          );

          expect(texts(log)).toEqual([
            "Landing failed:",
            "",
            "  not mergeable",
            "",
            "Try again.",
          ]);
        });

        it("starts a quoted line over at a carriage return, and goes on with the quote while nothing else comes between", () => {
          const log = logOf((log) => {
            log.quote("Writing  50%\r");
            log.quote("Writing 100%\r\nTo origin");
            log.quote(" done\n");
          });

          expect(texts(log)).toEqual(["  Writing 100%", "  To origin done"]);
        });

        it("starts a new quote after anything else", () => {
          const log = logOf((log) => {
            log.quote("first");
            log.say(say`Between.`);
            log.quote("second");
          });

          expect(texts(log)).toEqual([
            "  first",
            "",
            "Between.",
            "",
            "  second",
          ]);
        });

        it("leaves out a quote that holds only blank lines, and the blank lines around a quote and the spaces ending its lines", () => {
          const log = logOf((log) => {
            log.quote("\n   \n");
            log.say(say`Words.`);
            log.say(say`${quote("\n\nreason   \n\n")}`);
          });

          expect(texts(log)).toEqual(["Words.", "", "  reason"]);
        });

        it("links each web address in a quote to the whole address, on each row it wraps onto", () => {
          const long = `https://example.test/${"a".repeat(30)}`;
          const log = logOf((log) => log.quote(`See ${long}.`));

          const laidOut = rows(log, 40);
          expect(laidOut.map((row) => row.text)).toEqual([
            "  See",
            `  ${long.slice(0, 38)}`,
            `  ${long.slice(38)}.`,
          ]);
          expect(laidOut[1].spans).toEqual([
            { from: 0, to: 2, tone: "plain" },
            { from: 2, to: 40, tone: "plain", url: long },
          ]);
          expect(laidOut[2].spans).toEqual([
            { from: 0, to: 2, tone: "plain" },
            { from: 2, to: 2 + long.length - 38, tone: "plain", url: long },
            {
              from: 2 + long.length - 38,
              to: 3 + long.length - 38,
              tone: "plain",
            },
          ]);
        });

        it("wraps a line after its last space that fits, and breaks a word wider than the row", () => {
          const log = logOf((log) => {
            log.say(say`one two three four`);
            log.say(say`${"x".repeat(12)}`);
          });

          expect(texts(log, 10)).toEqual([
            "one two",
            "three four",
            "",
            "x".repeat(10),
            "xx",
          ]);
        });

        it("starts a new line at each newline in the viewer's words, leaving out a line left empty", () => {
          const log = logOf((log) => log.say(say`First.\n\n  Second.\n`));

          expect(texts(log)).toEqual(["First.", "Second."]);
        });

        it("draws the viewer's words bright and the names in them as names, linking those that have an address", () => {
          const log = logOf((log) =>
            log.say(say`Pull request ${pullRequest(7, URL)} of ${"octo/repo"}`)
          );

          expect(rows(log)[0].spans).toEqual([
            { from: 0, to: 13, tone: "bright" },
            { from: 13, to: 14, tone: "name", url: URL },
            { from: 14, to: 18, tone: "bright" },
            { from: 18, to: 27, tone: "name" },
          ]);
        });

        it("ends a running step in three dots and a spinner whose frame turns with the frame number", () => {
          const log = logOf((log) => log.step(say`Pushing`));

          const frames = [0, 1, 2, 3, 4].map((frame) =>
            rows(log, 40, frame)[0]
          );
          expect(frames.map((row) => row.text)).toEqual([
            "Pushing... ◐",
            "Pushing... ◓",
            "Pushing... ◑",
            "Pushing... ◒",
            "Pushing... ◐",
          ]);
          expect(frames[0].spans).toEqual([
            { from: 0, to: 11, tone: "bright" },
            { from: 11, to: 12, tone: "busy" },
          ]);
        });

        it("shows a step that is done with a check mark, and one that ended without being done with a cross", () => {
          const log = logOf((log) => {
            log.step(say`Looking`)();
            log.step(say`Merging`);
            log.stop();
          });

          const laidOut = rows(log);
          expect(laidOut.map((row) => row.text)).toEqual([
            "Looking... ✓",
            "",
            "Merging... ✗",
          ]);
          expect(laidOut.map((row) => row.spans.at(-1)?.tone)).toEqual([
            "done",
            undefined,
            "failed",
          ]);
        });

        it("lays several logs out one after the other, with a blank row between paragraphs across them", () => {
          const first = logOf((log) => log.quote("output\n"));
          const second = logOf((log) => log.say(say`Summary.`));
          const third = logOf((log) => log.step(say`Watching`)());

          expect(texts([first, second, third])).toEqual([
            "  output",
            "",
            "Summary.",
            "",
            "Watching... ✓",
          ]);
        });

        it("puts a blank row between steps that follow each other, and between the viewer's words and a step", () => {
          const log = logOf((log) => {
            log.step(say`Looking`)();
            log.step(say`Pushing`)();
            log.say(say`Pushed.`);
            log.step(say`Watching`)();
          });

          expect(texts(log)).toEqual([
            "Looking... ✓",
            "",
            "Pushing... ✓",
            "",
            "Pushed.",
            "",
            "Watching... ✓",
          ]);
        });

        it("keeps the lines of one entry of the viewer's words together, with no blank row between them", () => {
          const log = logOf((log) => {
            log.say(say`Pushed ${"feature"}.\nOpen a pull request.`);
            log.say(say`Watching.`);
          });

          expect(texts(log)).toEqual([
            "Pushed feature.",
            "Open a pull request.",
            "",
            "Watching.",
          ]);
        });

        it("shows a spinner on the last running step alone, and three dots alone on a running step before it", () => {
          const first = logOf((log) => log.step(say`Pushing`));
          const second = logOf((log) => log.step(say`Watching`));

          const laidOut = rows([first, second]);
          expect(laidOut.map((row) => row.text)).toEqual([
            "Pushing...",
            "",
            "Watching... ◐",
          ]);
          expect(laidOut[0].spans).toEqual([
            { from: 0, to: 10, tone: "bright" },
          ]);
        });

        it("shows nothing after a running step that waits for a person, and no spinner at all when that step is the last running, even while a step before it runs", () => {
          const log = logOf((log) => {
            log.step(say`Merging`);
            log.step(say`Touch the key`, "person");
          });

          expect(texts(log)).toEqual(["Merging...", "", "Touch the key"]);
        });

        it("shows a spinner on the last running step that is work, once a step after it that waits for a person is done", () => {
          const log = new TaskLog();
          log.step(say`Merging`);
          const touched = log.step(say`Touch the key`, "person");
          touched();

          expect(texts(log)).toEqual([
            "Merging... ◐",
            "",
            "Touch the key ✓",
          ]);
        });

        it("adds nothing for empty text", () => {
          const log = logOf((log) => log.say([]));

          expect(texts(log)).toEqual([]);
        });
      });

      describe("spinning()", () => {
        it("returns `false` while no step is running", () => {
          const log = logOf((log) => {
            log.quote("output\n");
            log.say(say`Words.`);
            log.step(say`Step`)();
          });

          expect(TaskLog.spinning([log])).toBe(false);
          expect(TaskLog.spinning([])).toBe(false);
        });

        it("returns `true` while the last running step across the logs is work", () => {
          const first = logOf((log) => log.step(say`Pushing`, "person"));
          const second = logOf((log) => log.step(say`Watching`));

          expect(TaskLog.spinning([first, second])).toBe(true);
        });

        it("returns `false` while the last running step waits for a person, even while a work step before it runs, and `true` once that step is done", () => {
          const first = logOf((log) => log.step(say`Merging`));
          const second = new TaskLog();
          const touched = second.step(say`Touch the key`, "person");

          expect(TaskLog.spinning([first, second])).toBe(false);
          touched();

          expect(TaskLog.spinning([first, second])).toBe(true);
        });
      });
    });
  });
});
