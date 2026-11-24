/**
 * Unit tests for the lines a run typed, and the traversal `up` and `down`
 * make over them.
 *
 * The traversal is a value with no I/O behind it, so every case here drives
 * it directly: what the prompt does with what it returns is pinned where the
 * prompt is (`shuttle-prompt.test.ts`).
 *
 * A case reads the traversal by walking it, there being no other surface: a
 * position is what `earlier` and `later` hand back, and the text a case
 * passes in is what the traversal is being told the line now holds.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { EditBuffer } from "../lib/view/editbuffer.ts";
import { LineHistory, recall } from "../lib/shuttle/history.ts";

/** Helper for the cases below, which is a traversal over `lines`. */
function recorded(...lines: readonly string[]): LineHistory {
  const history = new LineHistory();
  for (const line of lines) history.record(line);
  return history;
}

/**
 * Helper for the cases below, which is what `up` reaches `presses` times over
 * from the line being typed, with nothing typed in between.
 */
function up(history: LineHistory, presses: number): string | undefined {
  let reached: string | undefined;
  for (let press = 0; press < presses; press++) {
    reached = history.earlier(reached ?? "");
  }
  return reached;
}

describe("history", () => {
  describe("LineHistory.record()", () => {
    it("records a line, which `up` then reaches", () => {
      expect(recorded("ls").earlier("")).toBe("ls");
    });

    it("records the lines in the order they were typed, newest first under `up`", () => {
      const history = recorded("pwd", "ls");
      expect(history.earlier("")).toBe("ls");
      expect(history.earlier("ls")).toBe("pwd");
    });

    it("records a line exactly as it was typed, its spacing included", () => {
      expect(recorded("cd  slugs ").earlier("")).toBe("cd  slugs ");
    });

    it("records a line that named no verb, which is the line `up` is for", () => {
      expect(recorded("lss").earlier("")).toBe("lss");
    });

    it("records nothing for an empty line", () => {
      expect(recorded("").earlier("")).toBeUndefined();
    });

    it("records nothing for a line that is only whitespace", () => {
      expect(recorded(" \t ").earlier("")).toBeUndefined();
    });

    it("records nothing for a line identical to the one recorded last", () => {
      const history = recorded("ls", "ls");
      expect(history.earlier("")).toBe("ls");
      expect(history.earlier("ls")).toBeUndefined();
    });

    it("records a line identical to an earlier one that is not the last", () => {
      // The comparison is against the last line alone. Comparing against every
      // line would drop this `ls` and leave `up` twice reaching `pwd`, which
      // is not the order the run typed.

      const history = recorded("ls", "pwd", "ls");
      expect(history.earlier("")).toBe("ls");
      expect(history.earlier("ls")).toBe("pwd");
      expect(history.earlier("pwd")).toBe("ls");
    });

    it("returns the traversal to the line being typed, wherever it stood", () => {
      const history = recorded("pwd", "ls");
      expect(history.earlier("")).toBe("ls");
      history.record("cd slugs");
      expect(history.later("")).toBeUndefined();
    });

    it("drops the edits the traversal was holding, so `up` walks the lines", () => {
      // The `draft` was held against the line being typed. The line just
      // recorded now stands at that position, and `up` reaches the line
      // rather than the text that was held there.

      const history = recorded("pwd", "ls");
      history.earlier("draft");
      history.record("cd slugs");
      expect(history.earlier("")).toBe("cd slugs");
    });
  });

  describe("LineHistory.abandon()", () => {
    it("returns the traversal to the line being typed, which `down` leaves alone", () => {
      const history = recorded("ls");
      history.earlier("");
      history.abandon();
      expect(history.later("")).toBeUndefined();
    });

    it("records nothing, so what `up` reaches is what was recorded", () => {
      const history = recorded("ls");
      history.earlier("");
      history.abandon();
      expect(history.earlier("thrown away")).toBe("ls");
    });

    it("drops an edit held against a line the traversal had reached", () => {
      // The edit has to be read at a position the traversal has not since
      // moved off: `up` holds the current text as it leaves a position, so a
      // case that walks back over the draft would overwrite the very edit it
      // is asking about and pass whether or not anything was dropped.

      const history = recorded("pwd", "ls");
      history.earlier("draft");
      history.earlier("ls --limit 2");
      history.abandon();
      expect(history.earlier("")).toBe("ls");
      expect(history.later("ls")).toBe("");
    });
  });

  describe("LineHistory.earlier()", () => {
    it("returns nothing where nothing was recorded", () => {
      expect(new LineHistory().earlier("half a line")).toBeUndefined();
    });

    it("returns nothing at the oldest line, rather than the newest again", () => {
      const history = recorded("pwd", "ls");
      expect(up(history, 3)).toBeUndefined();
    });

    it("holds the line being typed, which `down` then returns", () => {
      const history = recorded("ls");
      expect(history.earlier("cd sl")).toBe("ls");
      expect(history.later("ls")).toBe("cd sl");
    });

    it("holds an edit made to a recorded line, which coming back returns", () => {
      const history = recorded("pwd", "ls");
      expect(history.earlier("")).toBe("ls");
      expect(history.earlier("ls --limit 2")).toBe("pwd");
      expect(history.later("pwd")).toBe("ls --limit 2");
    });

    it("leaves what was recorded alone, so a later traversal walks the lines", () => {
      const history = recorded("pwd", "ls");
      history.earlier("");
      history.earlier("ls --limit 2");
      history.abandon();
      expect(up(history, 2)).toBe("pwd");
    });
  });

  describe("LineHistory.later()", () => {
    it("returns nothing at the line being typed, rather than the oldest", () => {
      expect(recorded("ls").later("half a line")).toBeUndefined();
    });

    it("returns the empty line where nothing was typed before the first `up`", () => {
      const history = recorded("ls");
      expect(history.earlier("")).toBe("ls");
      expect(history.later("ls")).toBe("");
    });

    it("holds an edit made to a recalled line, which coming back returns", () => {
      const history = recorded("pwd", "ls");
      expect(up(history, 2)).toBe("pwd");
      expect(history.later("pwd --all")).toBe("ls");
      expect(history.earlier("ls")).toBe("pwd --all");
    });
  });

  describe("recall()", () => {
    it("puts the line on the buffer", () => {
      const buffer = new EditBuffer("");
      recall(buffer, "cd slugs");
      expect(buffer.text()).toBe("cd slugs");
    });

    it("leaves the cursor at the end of the line", () => {
      const buffer = new EditBuffer("");
      recall(buffer, "cd slugs");
      expect(buffer.col).toBe(8);
    });

    it("counts the cursor in code points, so a line of pairs ends where it reads", () => {
      const buffer = new EditBuffer("");
      recall(buffer, "cd 𝄞𝄞");
      expect(buffer.col).toBe(5);
    });

    it("leaves the buffer alone where there is no line", () => {
      const buffer = new EditBuffer("cd sl");
      buffer.moveLineStart();
      recall(buffer, undefined);
      expect([buffer.text(), buffer.col]).toEqual(["cd sl", 0]);
    });
  });
});
