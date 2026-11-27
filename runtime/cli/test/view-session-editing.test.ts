/**
 * Tests for `cf view`'s edit session over a diff and a CRLF file: the gates on
 * forward word and region kills, motion across a protected line ending,
 * resurrection under a policy without its own hunk lookup, moving a removed
 * first line's BOM past a removed line, and blame results that no longer
 * match.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import type { BlameLine } from "../lib/view/blame.ts";
import { parseDiff } from "../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
  realWorkspace,
} from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { type EditableSource, fileSource } from "../lib/view/editsource.ts";
import type { Key } from "../lib/view/keys.ts";
import { Session } from "../lib/view/session.ts";
import { describe, it } from "@commonfabric/test-support/test";

const BOM = "﻿";

function key(name: string, alt = false): Key {
  const char = name.length === 1 ? name : undefined;
  return { name, ...(char ? { char } : {}), ...(alt ? { alt: true } : {}) };
}

function press(session: Session, ...names: string[]): void {
  for (const name of names) session.handleKey(key(name));
}

/** A workspace in a fresh directory holding `files`, written as bytes so a
 * file can carry a BOM. */
function workspace(files: Record<string, string>): {
  root: string;
  ws: DiffWorkspace;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(join(root, ".git"));
  for (const [name, text] of Object.entries(files)) {
    const body = text.startsWith(BOM) ? text.slice(1) : text;
    const bytes = new TextEncoder().encode(body);
    Deno.writeFileSync(
      join(root, name),
      text.startsWith(BOM)
        ? new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])
        : bytes,
    );
  }
  return {
    root,
    ws: realWorkspace(root),
    done: () => Deno.removeSync(root, { recursive: true }),
  };
}

/** An editing session over `diff` against `ws`, with `source` in place of the
 * diff's own when given, and the cursor at the start of line `row`. */
function editAt(
  diff: string,
  ws: DiffWorkspace,
  row: number,
  wrap: (source: EditableSource) => EditableSource = (source) => source,
): Session {
  const built = buildDiffDocument(diff, parseDiff(diff)!, ws);
  const source = wrap(diffSource(ws, built.edit));
  const session = new Session(
    source.parse(diff),
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    source,
  );
  session.top = row;
  press(session, "e", "home");
  expect(session.view().cursor?.line).toBe(row);
  return session;
}

const FILE = "const x = 1;\nconst y = 2;\nconst z = 3;\n";

const DIFF = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 0;
+const y = 2;
 const z = 3;
`;

/** The row of DIFF's added line. */
const ADDED = 6;

describe("view-session-editing", () => {
  describe("forward word kill in a diff", () => {
    it("kills the first word past the marker from the marker column", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        const session = editAt(DIFF, ws, ADDED);
        session.handleKey(key("d", true));
        expect(session.doc.lines[ADDED].text).toBe("+ y = 2;");
        expect(session.view().message).toBe("");
      } finally {
        done();
      }
    });

    it("refuses a header line and leaves the text alone", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        const session = editAt(DIFF, ws, 3);
        const before = session.doc.text;
        session.handleKey(key("d", true));
        expect(session.doc.text).toBe(before);
        expect(session.view().message).toContain("isn't editable");
      } finally {
        done();
      }
    });
  });

  describe("region kill in a diff", () => {
    it("refuses a region whose mark is past the end of a shortened line", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        const session = editAt(DIFF, ws, ADDED);
        press(session, "end", "ctrl-space", "backspace", "backspace");
        const before = session.doc.text;
        expect(session.doc.lines[ADDED].text).toBe("+const y = ");
        press(session, "ctrl-w");
        expect(session.doc.text).toBe(before);
        expect(session.view().message).toBe(
          "To remove a line in a diff, press Backspace at the start of it.",
        );
      } finally {
        done();
      }
    });

    it("kills a region inside the line", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        const session = editAt(DIFF, ws, ADDED);
        press(session, "end", "ctrl-space", "left", "left", "ctrl-w");
        expect(session.doc.lines[ADDED].text).toBe("+const y = ");
      } finally {
        done();
      }
    });
  });

  describe("motion in a CRLF file", () => {
    function crlfSession(text: string): { session: Session; done: () => void } {
      const root = Deno.makeTempDirSync();
      const path = join(root, "f.txt");
      Deno.writeTextFileSync(path, text);
      const source = fileSource(path);
      const session = new Session(
        source.parse(text),
        { color: false, showLineNumbers: false },
        { width: 40, height: 10 },
        undefined,
        source,
      );
      press(session, "e");
      return {
        session,
        done: () => Deno.removeSync(root, { recursive: true }),
      };
    }

    it("moves right from a line's end to the start of the next line", () => {
      const { session, done } = crlfSession("ab\r\ncd\r\n");
      try {
        press(session, "end");
        expect(session.view().cursor).toMatchObject({ line: 0, col: 2 });
        press(session, "right");
        expect(session.view().cursor).toMatchObject({ line: 1, col: 0 });
      } finally {
        done();
      }
    });

    it("moves right within a line one character at a time", () => {
      const { session, done } = crlfSession("ab\r\ncd\r\n");
      try {
        press(session, "right");
        expect(session.view().cursor).toMatchObject({ line: 0, col: 1 });
      } finally {
        done();
      }
    });
  });

  describe("resurrection under a policy without a hunk lookup", () => {
    /** Replaces the diff's policy with one that finds hunks itself: added and
     * context lines are editable, removed lines resurrectable. */
    const ownPolicy = (source: EditableSource): EditableSource => ({
      ...source,
      policy: {
        editStart: (lines, row) =>
          lines[row]?.[0] === "+" || lines[row]?.[0] === " " ? 1 : null,
        regionKind: (lines, row) =>
          lines[row]?.[0] === "-"
            ? "removed"
            : lines[row]?.[0] === "+" || lines[row]?.[0] === " "
            ? "hunk"
            : null,
        insertPrefix: "+",
        messageIndent: "    ",
      },
    });

    it("turns a removed line into context and grows the hunk's new side", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        const session = editAt(DIFF, ws, 5, ownPolicy);
        press(session, "R");
        expect(session.doc.lines.slice(3, 9).map((line) => line.text))
          .toEqual([
            "@@ -1,3 +1,4 @@",
            " const x = 1;",
            " const y = 0;",
            "+const y = 2;",
            " const z = 3;",
            "",
          ]);
      } finally {
        done();
      }
    });

    it("throws for a removed line outside any hunk", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        // The policy takes the "--- a/m.ts" header for a removed line.
        const session = editAt(DIFF, ws, 1, ownPolicy);
        expect(() => press(session, "R")).toThrow(
          "the hunk header of a resurrectable line did not parse",
        );
      } finally {
        done();
      }
    });
  });

  describe("removing a first line that carries a BOM", () => {
    it("moves the BOM past a removed line to the next addition", () => {
      const { root, ws, done } = workspace({
        "value.ts": `${BOM}first\nsecond\n`,
      });
      try {
        const diff = `diff --git a/value.ts b/value.ts
--- a/value.ts
+++ b/value.ts
@@ -1,2 +1,2 @@
-${BOM}old one
+${BOM}first
-old two
+second
`;
        const session = editAt(diff, ws, 5);
        press(session, "ctrl-k", "backspace");
        expect(session.doc.lines.slice(4, 7).map((line) => line.text))
          .toEqual([`-${BOM}old one`, "-old two", `+${BOM}second`]);
        press(session, "f3");
        expect(session.view().message).toBe("Saved 1 file");
        expect(Deno.readFileSync(join(root, "value.ts"))).toEqual(
          new Uint8Array([
            0xef,
            0xbb,
            0xbf,
            ...new TextEncoder().encode("second\n"),
          ]),
        );
      } finally {
        done();
      }
    });
  });

  describe("blame of a diff", () => {
    const SHA = "c".repeat(40);
    const COMMIT_DIFF = `commit ${SHA}
Author: A <a@example.com>
Date:   Mon Jan 5 10:00:00 2026 +0000

    change y

${DIFF}`;
    /** The rows of COMMIT_DIFF's added line and the context line after it. */
    const ADDED_ROW = 12;
    const CONTEXT_ROW = 13;

    function blameLine(text: string): BlameLine {
      return { commit: SHA, author: "Alice", time: 0, text };
    }

    function blamedSession(): { session: Session; done: () => void } {
      const { ws, done } = workspace({ "m.ts": FILE });
      const built = buildDiffDocument(
        COMMIT_DIFF,
        parseDiff(COMMIT_DIFF)!,
        ws,
      );
      const session = new Session(
        built.doc,
        { color: false, showLineNumbers: false, now: () => 0 },
        { width: 100, height: 30 },
        undefined,
        diffSource(ws, built.edit),
      );
      press(session, "b");
      return { session, done };
    }

    it("shows no attribution for a line whose blamed text differs", () => {
      const { session, done } = blamedSession();
      try {
        session.view();
        const [load] = session.takeBlameLoads();
        expect(load.request.rev).toBe(SHA);
        session.finishBlameLoad(load, [
          blameLine("const x = 1;"),
          blameLine("const y = 2;"),
          blameLine("something else"),
        ]);
        const lines = session.view().blame!.lines;
        expect(lines[ADDED_ROW]?.text).toBe("const y = 2;");
        expect(lines[CONTEXT_ROW]).toBeNull();
      } finally {
        done();
      }
    });

    it("drops a failure for a load the session no longer wants", () => {
      const { session, done } = blamedSession();
      try {
        session.view();
        const [stale] = session.takeBlameLoads();
        session.failBlameLoad({ request: stale.request }, "gone");
        expect(session.view().message).not.toContain("Blame:");
        expect(session.takeBlameLoads()).toEqual([]);
        session.failBlameLoad(stale, "no such path");
        expect(session.view().message).toBe("Blame: no such path");
      } finally {
        done();
      }
    });
  });
});
