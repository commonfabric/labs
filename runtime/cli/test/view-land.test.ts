import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { stripAnsi } from "../lib/view/ansi.ts";
import type { MergeRequest } from "../lib/view/github.ts";
import type { Key } from "../lib/view/keys.ts";
import { helpOverlay, Session } from "../lib/view/session.ts";
import { say } from "../lib/view/tasklog.ts";
import { drawnRows, parseDocument } from "./view-helpers.ts";

/** A session over a line wider than its 80 by 12 screen. */
function session(color = false): Session {
  return new Session(
    parseDocument(`const a = "${"x".repeat(200)}";\n`),
    { color, showLineNumbers: false },
    { width: 80, height: 12 },
  );
}

/** The key that types `char`. */
function typed(char: string): Key {
  return { name: char, char };
}

const LANDING: MergeRequest = {
  repository: "octo/repo",
  number: 7,
  method: "squash",
  sha: "c0ffee",
};

describe("view-land", () => {
  describe("the land key", () => {
    it("asks to land on `L`, and leaves panning right to `l`", () => {
      const s = session();

      s.handleKey(typed("L"));
      expect(s.landRequested).toBe(true);
      expect(s.view().left).toBe(0);
      s.handleKey(typed("l"));

      expect(s.view().left).toBeGreaterThan(0);
    });

    it("lists `L` in the help", () => {
      expect(helpOverlay(false).info.map((line) => line.text)).toContain(
        "  L".padEnd(22) +
          " land: link to, open, or merge the branch's pull request",
      );
    });
  });

  describe("the land dialog", () => {
    /** A session whose task dialog, looking for the pull request, asks
     * whether to merge {@link LANDING}. */
    function asking(): Session {
      const s = session();
      s.beginTask("Land", () => {});
      s.beginTaskStep(say`Looking`)();
      s.confirmLand(LANDING);
      return s;
    }

    /** The rows the dialog shows, without the blank rows. */
    const shown = (s: Session) =>
      s.view().dialog!.body.filter((row) => row !== "");

    it("asks under what the task found whether to merge the pull request, saying how and at which commit as GitHub's merge button does, with no button as its default", () => {
      const bodies = [
        ["squash", "Squash and merge pull request 7 of octo/repo,"],
        ["merge", "Merge pull request 7 of octo/repo,"],
        ["rebase", "Rebase and merge pull request 7 of octo/repo,"],
      ] as const;
      for (const [method, line] of bodies) {
        const s = session();
        s.beginTask("Land", () => {});
        s.beginTaskStep(say`Looking`)();
        s.confirmLand({ ...LANDING, method });

        const dialog = s.view().dialog!;
        expect(dialog.title).toBe("Land");
        expect(shown(s)).toEqual([
          "Looking... ✓",
          line,
          "if its head is still c0ffee?",
        ]);
        const spans = dialog.spans![dialog.body.indexOf(line)];
        expect(spans.find((span) => span.tone === "name")).toEqual({
          from: line.indexOf("7"),
          to: line.indexOf("7") + 1,
          tone: "name",
          url: "https://github.com/octo/repo/pull/7",
        });
        expect(dialog.buttons.map((b) => b.label)).toEqual([
          "Merge",
          "Cancel",
        ]);
        expect(dialog.buttons.some((b) => b.kind === "default")).toBe(false);
        expect(dialog.focus).toBe(-1);
      }
    });

    it("asks nothing unless a task is running in the task dialog", () => {
      const s = session();
      s.confirmLand(LANDING);
      expect(s.view().dialog).toBeNull();
      s.beginTask("Land", () => {});
      s.finishTask(say`Done.`);

      s.confirmLand(LANDING);
      expect(s.view().dialog!.buttons.map((b) => b.label)).toEqual([
        "Close",
        "Quit",
      ]);
    });

    it("asks for no merge on the `L` that opened it, pressed again", () => {
      const s = asking();

      s.handleKey(typed("L"));
      s.handleKey(typed("l"));

      expect(s.mergeRequested).toBeNull();
      expect(s.view().dialog!.title).toBe("Land");
    });

    it("asks for the merge on Merge, keeping the dialog up for it, and for none on Enter until a button has the focus", () => {
      for (
        const keys of [
          [typed("m")],
          [typed("M")],
          [{ name: "enter" }, { name: "tab" }, { name: "enter" }],
        ]
      ) {
        const s = asking();

        for (const key of keys) {
          expect(s.mergeRequested).toBeNull();
          s.handleKey(key);
        }

        expect(s.mergeRequested).toEqual(LANDING);
        expect(s.view().dialog!.title).toBe("Land");
      }
    });

    it("keeps what it found and what it asked when the merge continues the dialog, which then offers Abort", () => {
      const s = asking();
      s.resize(80, 24);
      s.handleKey(typed("m"));

      s.continueTask(() => {});
      s.beginTaskStep(say`Merging`);

      expect(shown(s)).toEqual([
        "Looking... ✓",
        "Squash and merge pull request 7 of octo/repo,",
        "if its head is still c0ffee?",
        "Merging... ◐",
      ]);
      expect(s.view().dialog!.buttons.map((b) => b.label)).toEqual(["Abort"]);
    });

    it("asks for no merge on Cancel or Escape, which take the dialog down", () => {
      for (const key of [typed("c"), { name: "escape" }]) {
        const s = asking();

        s.handleKey(key);

        expect(s.mergeRequested).toBeNull();
        expect(s.view().dialog).toBeNull();
      }
    });
  });

  describe("the task dialog", () => {
    /** A session whose task dialog, titled `title`, holds `count` numbered
     * lines of output, with the task ended. */
    function withOutput(count: number, title = "Land"): Session {
      const s = session();
      s.beginTask(title, () => {});
      for (let i = 1; i <= count; i++) s.appendTaskOutput(`line ${i}\n`);
      s.finishTask(say`Done.`);
      return s;
    }

    /** The output rows the dialog shows, without the blank rows. */
    const shown = (s: Session) =>
      s.view().dialog!.body.filter((row) => row !== "");

    it("is titled for its task", () => {
      expect(withOutput(1, "Land").view().dialog!.title).toBe("Land");
      expect(withOutput(1, "Push").view().dialog!.title).toBe("Push");
    });

    it("scrolls its output back with Up and Page Up and to its start with Home, and forward to its end with Down and End", () => {
      const s = withOutput(20);
      const end = shown(s);
      expect(end.at(-1)).toBe("Done.");

      s.handleKey({ name: "up" });
      expect(shown(s).at(-1)).toBe("  line 20");
      s.handleKey({ name: "home" });
      expect(shown(s)[0]).toBe("  line 1");
      s.handleKey({ name: "up" });
      expect(shown(s)[0]).toBe("  line 1");
      s.handleKey({ name: "down" });
      expect(shown(s)[0]).toBe("  line 2");
      s.handleKey({ name: "end" });
      expect(shown(s)).toEqual(end);
      s.handleKey({ name: "pageup" });
      expect(shown(s).at(-1)).not.toBe("Done.");
      s.handleKey({ name: "down" });
      s.handleKey({ name: "pagedown" });

      expect(shown(s)).toEqual(end);
    });

    it("moves the focus between its buttons with Left and Right", () => {
      const s = withOutput(20);

      s.handleKey({ name: "right" });
      expect(s.view().dialog!.focus).toBe(1);
      s.handleKey({ name: "left" });

      expect(s.view().dialog!.focus).toBe(0);
      expect(shown(s).at(-1)).toBe("Done.");
    });

    it("holds still as the output grows while it is scrolled back, and follows the output again once scrolled to its end", () => {
      const s = session();
      s.beginTask("Land", () => {});
      for (let i = 1; i <= 20; i++) s.appendTaskOutput(`line ${i}\n`);
      s.handleKey({ name: "home" });

      s.appendTaskOutput("line 21\n");
      expect(shown(s)[0]).toBe("  line 1");
      s.handleKey({ name: "end" });
      s.appendTaskOutput("line 22\n");

      expect(shown(s).at(-1)).toBe("  line 22");
    });

    it("shows the end of its output again when asked to, however far it was scrolled back", () => {
      const s = withOutput(20);
      s.handleKey({ name: "home" });

      s.showTaskEnd();

      expect(shown(s).at(-1)).toBe("Done.");
    });

    it("scrolls its output with the mouse wheel", () => {
      const s = withOutput(20);
      const end = shown(s);

      s.handleKey({ name: "wheel-up" });
      expect(shown(s).at(-1)).toBe("  line 19");
      s.handleKey({ name: "wheel-up" });
      s.handleKey({ name: "wheel-down" });
      expect(shown(s).at(-1)).toBe("  line 19");
      s.handleKey({ name: "wheel-down" });

      expect(shown(s)).toEqual(end);
    });

    it("draws the viewer's own words brighter than the text it quotes, and the names they interpolate in a color of their own", () => {
      const s = new Session(
        parseDocument("const a = 1;\n"),
        { color: true, showLineNumbers: false },
        { width: 80, height: 24 },
      );
      s.beginTask("Push", () => {});
      s.appendTaskOutput("quoted text\n");
      s.beginTaskStep(say`Touching ${"laptop"} now`);
      s.appendTaskOutput("more quoted\n");

      const rows = drawnRows(s);
      const style = (text: string) => {
        const row = rows.find((r) => r.includes(text))!;
        return row.slice(0, row.indexOf(text)).split("\x1b[").at(-1);
      };
      expect(style("Touching")).not.toBe(style("quoted text"));
      expect(style("laptop")).not.toBe(style("Touching"));
      expect(style("laptop")).not.toBe(style("quoted text"));
      expect(style("more quoted")).toBe(style("quoted text"));
    });

    it("offers a button that asks to try the task again, when it ended saying so, and none otherwise", () => {
      const s = session();
      s.beginTask("Push", () => {});
      s.finishTask(say`Failed. To retry, press ${"Create PR"}.`, "Create PR");

      expect(s.view().dialog!.buttons.map((b) => b.label)).toEqual([
        "Close",
        "Create PR",
        "Quit",
      ]);
      s.handleKey(typed("P"));
      expect(s.retryRequested).toBe(true);
      expect(s.view().dialog!.title).toBe("Push");

      const plain = withOutput(1);
      expect(plain.view().dialog!.buttons.map((b) => b.label)).toEqual([
        "Close",
        "Quit",
      ]);
      plain.handleKey(typed("p"));
      expect(plain.retryRequested).toBe(false);
    });

    it("starts at the end of the output each time it opens", () => {
      const s = withOutput(20);
      s.handleKey({ name: "home" });
      s.handleKey(typed("c"));

      s.beginTask("Push", () => {});
      for (let i = 1; i <= 20; i++) s.appendTaskOutput(`row ${i}\n`);

      expect(shown(s).at(-1)).toBe("  row 20");
    });
  });

  describe("the status line", () => {
    const status = (s: Session) => drawnRows(s).at(-1)!;
    const url = "https://github.com/octo/repo/pull/7";

    /** Each link in `row`, as the address it goes to and the text it shows. */
    const links = (row: string) =>
      row.split("\x1b]8;;").filter((_, i) => i % 2 === 1).map((part) => {
        const [target, text] = part.split("\x07");
        return [target, stripAnsi(text)];
      });

    it("makes each web address in a message a link to it while color is on", () => {
      const s = session(true);

      s.showMessage(`At ${url}, or (https://x.test/b).`);

      expect(links(status(s))).toEqual([
        [url, url],
        ["https://x.test/b", "https://x.test/b"],
      ]);
    });

    it("links the part of an address that fits to the whole address", () => {
      const s = session(true);
      const long = `https://example.test/${"a".repeat(80)}`;

      s.showMessage(`See ${long}`);

      const [[target, text]] = links(status(s));
      expect(target).toBe(long);
      expect(long.startsWith(text)).toBe(true);
      expect(text.length).toBeLessThan(long.length);
    });

    it("links no address that starts beyond the part of the message that fits", () => {
      const s = session(true);

      s.showMessage(`At ${url}, ${"then ".repeat(20)}https://x.test/b`);

      expect(links(status(s))).toEqual([[url, url]]);
      expect(status(s)).not.toContain("x.test");
    });

    it("shows each control character in a message as its picture", () => {
      for (const color of [true, false]) {
        const s = session(color);

        s.showMessage("refused: \x1b]2;owned\x07 and \x1b[2J");

        expect(status(s)).toContain("refused: ␛]2;owned␇ and ␛[2J");
        expect(status(s)).not.toContain("\x1b]2;");
      }
    });

    it("draws no link while color is off", () => {
      const s = session(false);

      s.showMessage(`Pull request 7: ${url}`);

      expect(status(s)).toContain(url);
      expect(links(status(s))).toEqual([]);
    });
  });
});
