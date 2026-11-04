import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseDiff } from "../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
} from "../../../lib/view/diffdoc.ts";
import { diffSource } from "../../../lib/view/diffedit.ts";
import { decodeKeys } from "../../../lib/view/keys.ts";
import { Session } from "../../../lib/view/session.ts";
import { wrappedRowAt } from "../../../lib/view/wrap.ts";

const FIRST = "commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND = "commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EMPTY = "commit cccccccccccccccccccccccccccccccccccccccc";
const FILE = [
  "diff --git a/app.ts b/app.ts",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1 +1 @@",
  "-old();",
  "+new();",
  "",
].join("\n");
const LOG = [
  FIRST,
  "Author: A <a@example.com>",
  "",
  "    Update the app",
  "",
  FILE,
  "diff --git a/app.test.ts b/app.test.ts",
  "--- a/app.test.ts",
  "+++ b/app.test.ts",
  "@@ -1,2 +1 @@",
  "-oldTest();",
  "-otherTest();",
  "+newTest();",
  "",
  SECOND,
  "Author: B <b@example.com>",
  "",
  "    Update it again",
  "",
  FILE.replace("-old();", "-new();").replace("+new();", "+final();"),
  EMPTY,
  "Author: C <c@example.com>",
  "",
  "    Empty commit",
  "",
].join("\n");

/** Creates a diff session with no files available on disk. */
function session(text = LOG, height = 12): Session {
  const workspace: DiffWorkspace = { resolve: () => null, read: () => null };
  const { doc, edit } = buildDiffDocument(text, parseDiff(text)!, workspace);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(workspace, edit),
  );
}

/** Sends keys through the session's public event handler. */
function press(s: Session, ...names: string[]): void {
  for (const name of names) {
    s.handleKey(name.length === 1 ? { name, char: name } : { name });
  }
}

/** Returns the text of the document line at the top of the viewport. */
function topLine(s: Session): string {
  const view = s.view();
  const row = view.wrapPlan
    ? wrappedRowAt(view.wrapPlan, view.top)!.line
    : view.top;
  return s.displayDoc().lines[row].text;
}

/** Returns whether each selectable index row uses the hidden-file style. */
function hiddenRows(s: Session): boolean[] {
  return s.view().overlay!.lines.slice(0, 6).map((line) =>
    line.spans.every((span) => span.cls === "comment")
  );
}

describe("Session", () => {
  describe("instance members", () => {
    describe("handleKey()", () => {
      describe("commit navigation", () => {
        it("moves between commit headers and stops at either end", () => {
          const s = session();
          press(s, "<");
          expect(topLine(s)).toBe(FIRST);
          press(s, ">");
          expect(topLine(s)).toBe(SECOND);
          press(s, ">");
          expect(topLine(s)).toBe(EMPTY);
          press(s, ">");
          expect(topLine(s)).toBe(EMPTY);
          press(s, "<");
          expect(topLine(s)).toBe(SECOND);
          press(s, "<");
          expect(topLine(s)).toBe(FIRST);
        });

        it("returns to the current header from inside its commit", () => {
          const s = session();
          press(s, ">", "j", "<");
          expect(topLine(s)).toBe(SECOND);
          press(s, "<");
          expect(topLine(s)).toBe(FIRST);
        });

        it("returns to the first screen row of a wrapped commit header", () => {
          const decorated = SECOND +
            " (HEAD -> feature/commit-navigation, origin/feature/commit-navigation)";
          const s = session(LOG.replace(SECOND, decorated));
          press(s, "\\", ">");
          const top = s.view().top;
          expect(topLine(s)).toBe(decorated);
          press(s, "j");
          expect(s.view().top).toBe(top + 1);
          expect(topLine(s)).toBe(decorated);
          press(s, "<");
          expect(s.view().top).toBe(top);
          press(s, "<");
          expect(topLine(s)).toBe(FIRST);
        });

        for (const folded of [false, true]) {
          it(`reaches short final commits in a tall viewport with files ${folded ? "hidden" : "shown"}`, () => {
            const headers = ["a", "b", "c", "d"].map((sha) =>
              `${sha.repeat(40)} Commit ${sha}`
            );
            const text = headers.map((header) => `${header}\n${FILE}`).join(
              "\n",
            );
            const s = session(text, 80);
            if (folded) press(s, "F");
            for (const header of headers.slice(1)) {
              press(s, ">");
              expect(topLine(s)).toBe(header);
            }
            press(s, ">");
            expect(topLine(s)).toBe(headers[3]);
            s.resize(40, 100);
            expect(topLine(s)).toBe(headers[3]);
            press(s, "\\");
            expect(topLine(s)).toBe(headers[3]);
            for (const header of headers.slice(0, -1).reverse()) {
              press(s, "<");
              expect(topLine(s)).toBe(header);
            }
            press(s, "i", "G", "up", "enter");
            expect(topLine(s)).toBe(headers[3]);
          });
        }

        it("maps headers through folded files and wrapped lines", () => {
          const s = session(
            LOG.replace("Update the app", "Long subject ".repeat(40)),
          );
          press(s, "\\", "F", ">");
          expect(topLine(s)).toBe(SECOND);
          press(s, ">");
          expect(topLine(s)).toBe(EMPTY);
          press(s, "<", "<");
          expect(topLine(s)).toBe(FIRST);
        });

        it("clears horizontal scrolling and structure selection on a jump", () => {
          const s = session(
            LOG.replace("Update the app", "Long subject ".repeat(40)),
          );
          press(s, "tab", "L");
          expect(s.view().selected).not.toBeNull();
          expect(s.view().left).toBeGreaterThan(0);
          press(s, ">");
          expect(topLine(s)).toBe(SECOND);
          expect(s.view().selected).toBeNull();
          expect(s.view().left).toBe(0);
        });

        it("selects commit rows without closing or moving the main view", () => {
          const s = session();
          press(s, "i", "<");
          expect(s.view().overlay?.selectedLine).toBe(0);
          press(s, ">");
          expect(s.view().overlay?.selectedLine).toBe(3);
          press(s, ">");
          expect(s.view().overlay?.selectedLine).toBe(5);
          press(s, ">");
          expect(s.view().overlay?.selectedLine).toBe(5);
          press(s, "<");
          expect(s.view().overlay?.selectedLine).toBe(3);
          expect(topLine(s)).toBe(FIRST);
          press(s, "enter");
          expect(s.view().overlay).toBeNull();
          expect(topLine(s)).toBe(SECOND);
        });

        it("selects the containing commit from a file row", () => {
          const s = session();
          press(s, "i", ">", "down", "<");
          expect(s.view().overlay?.selectedLine).toBe(3);
          press(s, "<");
          expect(s.view().overlay?.selectedLine).toBe(0);
        });

        it("leaves a raw diff at its current file in both views", () => {
          const s = session(FILE);
          press(s, "j");
          const top = s.view().top;
          press(s, ">", "<");
          expect(s.view().top).toBe(top);
          press(s, "i", ">", "<");
          expect(s.view().overlay?.selectedLine).toBe(0);
        });

        for (const format of ["compact", "email"]) {
          it(`navigates ${format} commit headers in both views`, () => {
            const header = (sha: string, subject: string) =>
              format === "compact"
                ? `${sha} ${subject}`
                : `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: A <a@example.com>\nDate: Mon, 21 Jul 2026 12:00:00 +0000\nSubject: [PATCH] ${subject}\n`;
            const first = header("a".repeat(40), "One");
            const second = header("b".repeat(40), "Two");
            const s = session([first, FILE, second, FILE].join("\n"));
            press(s, ">");
            expect(topLine(s)).toBe(second.split("\n")[0]);
            press(s, "<");
            expect(topLine(s)).toBe(first.split("\n")[0]);
            press(s, "i", ">");
            expect(s.view().overlay?.selectedLine).toBe(2);
            press(s, "<");
            expect(s.view().overlay?.selectedLine).toBe(0);
          });
        }
      });

      describe("index navigation", () => {
        for (const [first, last] of [["g", "G"], ["home", "end"]]) {
          it(`selects and reveals the list's ends with \`${first}\` and \`${last}\``, () => {
            const s = session();
            press(s, "i", last);
            expect(s.view().overlay?.selectedLine).toBe(5);
            expect(s.view().overlay?.scroll).toBeGreaterThan(0);
            press(s, first);
            expect(s.view().overlay?.selectedLine).toBe(0);
            expect(s.view().overlay?.scroll).toBe(0);
            expect(topLine(s)).toBe(FIRST);
          });
        }

        it("types navigation and visibility keys into the filter", () => {
          const s = session();
          press(s, "i", "/", "g", "G", "<", ">", "f");
          expect(s.view().inputLine).toBe("jump to: gG<>f");
          expect(s.view().overlay?.selectedLine).toBeUndefined();
          press(s, "escape");
          expect(hiddenRows(s)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
          ]);
        });

        it("limits Home and End to filtered rows", () => {
          const s = session();
          press(s, "i", "/", "a", "p", "p", "end");
          expect(s.view().overlay?.selectedLine).toBe(3);
          press(s, "home");
          expect(s.view().overlay?.selectedLine).toBe(0);
          expect(s.view().inputLine).toBe("jump to: app");
        });
      });

      describe("commit rows", () => {
        it("totals each commit separately, including repeated files and empty commits", () => {
          const s = session();
          press(s, "i");
          const lines = s.view().overlay!.lines;
          expect([lines[0].text, lines[3].text, lines[5].text]).toEqual([
            "● commit aaaaaaaaa  +2 −3  Update the app",
            "● commit bbbbbbbbb  +1 −1  Update it again",
            "● commit ccccccccc  +0 −0  Empty commit",
          ]);
          expect(lines[0].spans.filter((span) => span.cls === "diffAdd"))
            .toEqual([
              { col: 20, text: "+2", cls: "diffAdd" },
            ]);
          expect(lines[0].spans.filter((span) => span.cls === "diffDel"))
            .toEqual([
              { col: 23, text: "−3", cls: "diffDel" },
            ]);
        });

        it("updates commit totals when the count policy changes", () => {
          const s = session([
            FIRST,
            "",
            "    Whitespace",
            "",
            FILE.replace("+new();", "+ old ( );"),
            SECOND,
            "",
            "    Comments",
            "",
            FILE.replace("+new();", "+old(); // note"),
          ].join("\n"));
          press(s, "i");
          const counts = () =>
            s.view().overlay!.lines
              .filter((line) => line.text.startsWith("●"))
              .map((line) => line.text.match(/\+\d+ −\d+/)![0]);
          expect(counts()).toEqual(["+1 −1", "+1 −1"]);
          press(s, "D");
          expect(counts()).toEqual(["+0 −0", "+1 −1"]);
          press(s, "D");
          expect(counts()).toEqual(["+0 −0", "+0 −0"]);
          press(s, "D");
          expect(counts()).toEqual(["+1 −1", "+1 −1"]);
        });

        it("hides and shows all files of only the highlighted commit", () => {
          const s = session();
          press(s, "i", "f");
          expect(hiddenRows(s)).toEqual([
            true,
            true,
            true,
            false,
            false,
            false,
          ]);
          expect(s.view().overlay?.selectedLine).toBe(0);
          expect(s.view().overlay!.lines.at(-1)!.text).toBe(
            "All files +3 −4 · Shown files +1 −1",
          );
          expect(
            s.displayDoc().lines.filter((line) => line.text.startsWith("▸")),
          )
            .toHaveLength(2);
          press(s, "f");
          expect(hiddenRows(s)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
          ]);
          expect(s.displayDoc().text).toBe(LOG);
          press(s, ">", "f");
          expect(hiddenRows(s)).toEqual([
            false,
            false,
            false,
            true,
            true,
            false,
          ]);
          expect(s.view().overlay?.selectedLine).toBe(3);
        });

        it("hides a mixed commit and expands it when every file is hidden", () => {
          const s = session();
          press(s, "i", "T");
          expect(hiddenRows(s)).toEqual([
            false,
            false,
            true,
            false,
            false,
            false,
          ]);
          press(s, "f");
          expect(hiddenRows(s)).toEqual([
            true,
            true,
            true,
            false,
            false,
            false,
          ]);
          press(s, "F");
          expect(hiddenRows(s)).toEqual([true, true, true, true, true, false]);
          press(s, "f");
          expect(hiddenRows(s)).toEqual([
            false,
            false,
            false,
            true,
            true,
            false,
          ]);
          press(s, "E");
          expect(hiddenRows(s)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
          ]);
        });

        it("keeps empty commits visible when their visibility is toggled", () => {
          const s = session();
          press(s, "i", ">", ">", "f");
          expect(hiddenRows(s)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
          ]);
          expect(s.view().overlay?.selectedLine).toBe(5);
          expect(s.view().message).toBe("No commit ccccccccc files.");
        });

        it("ignores `Alt+f` in an empty filter and folds after clearing it", () => {
          const s = session();
          const altF = decodeKeys(Uint8Array.of(0x1b, 0x66)).keys[0];
          press(s, "i", "/", ..."commit a");
          expect(s.view().overlay?.selectedLine).toBe(0);
          expect(s.view().overlay!.lines[0].text).toBe(
            "● commit aaaaaaaaa  +2 −3  Update the app",
          );
          press(s, "f");
          expect(s.view().inputLine).toBe("jump to: commit af");
          expect(s.view().overlay!.lines[0].text).toBe("(no matches)");
          press(s, "f", "enter");
          s.handleKey(altF);
          expect(s.view().inputLine).toBe("jump to: commit aff");
          expect(s.view().overlay?.selectedLine).toBeUndefined();
          expect(s.view().overlay!.lines[0].text).toBe("(no matches)");
          expect(s.displayDoc().text).toBe(LOG);
          press(s, "escape");
          expect(s.view().overlay?.selectedLine).toBe(0);
          expect(hiddenRows(s)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
          ]);
          s.handleKey(altF);
          expect(hiddenRows(s)).toEqual([
            true,
            true,
            true,
            false,
            false,
            false,
          ]);
        });
      });
    });
  });
});
