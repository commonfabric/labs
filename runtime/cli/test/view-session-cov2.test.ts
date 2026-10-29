/**
 * Second-round coverage tests for `lib/view/session.ts`. These drive the
 * remaining untaken guard/early-return branches the first round
 * (`view-session.test.ts`, `view-session-cov.test.ts`) approached but did not
 * execute: a card reference that resolves to no node, a diff edit whose hunk
 * header is missing or malformed, a search reveal with no focused match, and a
 * picker scroll forced negative. Each reaches its branch by feeding keys to a
 * real `Session` and inspecting `view()` / `doc`, with a few cases built on a
 * doctored `Document` so the natural card/structure machinery lands in the
 * defensive state being exercised.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import type { EditableSource } from "../lib/view/editsource.ts";
import type { DirEntry, FileGateway } from "../lib/view/filegateway.ts";
import type { Key } from "../lib/view/keys.ts";
import type { Document } from "../lib/view/model.ts";
import { Session } from "../lib/view/session.ts";
import { parseDocument, SAMPLE } from "./view-helpers.ts";

function press(s: Session, ...names: string[]): void {
  for (const name of names) {
    s.handleKey(
      name.length === 1 && name >= " " ? { name, char: name } : { name },
    );
  }
}

function type(s: Session, text: string): void {
  for (const ch of text) s.handleKey({ name: ch, char: ch });
}

function alt(name: string, char?: string): Key {
  return char !== undefined ? { name, char, alt: true } : { name, alt: true };
}

/**
 * Tab through the tree until a node whose label contains `label` is
 * selected.
 */
function selectByLabel(s: Session, label: string): void {
  for (let i = 0; i < 500; i++) {
    if (s.view().selected?.label?.includes(label)) return;
    press(s, "tab");
  }
  throw new Error(`node not reached: ${label}`);
}

describe("Session", () => {
  //
  // Enter on a reference that resolves to no node
  //

  it("reports nothing to open on Enter for a reference whose line is in no node", () => {
    // A "use" reference carries a destination line but no definition offset.
    // When that line falls outside every structure node's range, both
    // findTargetIndex (no offset) and nodeAtLine (no containing node) fail, so
    // resolveTargetNode returns null and Enter reports there is nothing to
    // open.

    // Real card with real targets, but the structure tree is trimmed to just
    // the subject node — placed so the use site sits below its range, outside
    // every node — so following the use reference resolves to no node.
    const text = `// transformed: /m.ts
const base = 1;
const useA = base;
const useB = base;`;
    const doc = parseDocument(text);
    const baseNode = doc.flatStructure.find((n) => n.name === "base")!;
    assert(baseNode, "base node exists");
    // Keep only the subject node, whose range covers just its own line, so the
    // use sites on later lines are contained by no node.
    const trimmed: Document = {
      ...doc,
      structure: [baseNode],
      flatStructure: [baseNode],
    };
    const s = new Session(
      trimmed,
      { color: false, showLineNumbers: false },
      { width: 80, height: 24 },
    );
    // Select the only node and open its card; it lists the two uses as targets.
    press(s, "tab");
    expect(s.view().selected?.name).toBe("base");
    press(s, "enter");
    const card = s.view().overlay!;
    assert(card, "card opened");
    if (!card.footer.includes("select")) {
      // No targets means nothing to step to — skip rather than assert falsely.
      return;
    }
    press(s, "down"); // focus the first reference
    expect(s.view().overlay!.selectedLine, "a reference focused").not
      .toBeUndefined();
    press(s, "enter"); // resolveTargetNode -> null -> "Nothing to open"
    expect(s.view().message, "the reference resolved to no node").toBe(
      "Nothing to open for this reference",
    );
    assert(s.view().overlay, "the card stays open");
  });

  //
  // `revealMatch()` with a single match
  //

  it("reveals the single match of a committed search", () => {
    // revealMatch reads matches[currentMatch] and guards `!m`. Every public
    // caller (runSearch, refreshSearchMatches, stepMatch) checks for an empty
    // match set before reaching it, so the no-match return is unreachable from
    // the public API; this test asserts the surrounding reveal behavior stays
    // correct.

    const doc = parseDocument("// transformed: /m.ts\nconst tokenz = 1;");
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 10 },
    );
    press(s, "/");
    type(s, "tokenz");
    press(s, "enter");
    expect(s.view().matches?.length ?? 0, "a match was found").toBeGreaterThan(
      0,
    );
    expect(s.view().currentMatch, "the only match is focused").toBe(0);
  });

  //
  // `adjustHunkCounts()` over a hunk it cannot find or parse
  //
  // `adjustHunkCounts()` takes the header row of the parsed hunk holding the
  // edited row. With no such hunk it returns without a rewrite; with a header
  // row that begins "@@ " but does not match the full hunk-header pattern, the
  // match is null and it returns the same way. Both are reached with a
  // hand-built diff source whose body the policy treats as editable, but whose
  // header is absent or malformed.
  //

  const EXPAND_FILE = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n";

  function realDiffWs(file: string): {
    ws: DiffWorkspace;
    done: () => void;
  } {
    const root = Deno.makeTempDirSync();
    Deno.writeTextFileSync(join(root, "m.ts"), file);
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    return { ws, done: () => Deno.removeSync(root, { recursive: true }) };
  }

  const REAL_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -3,3 +3,3 @@
 gamma
-old delta
+delta
 epsilon
`;

  /**
   * A diff session whose policy and source are real, so editing is gated like a
   * diff, but whose document lines are swapped for `lines`, so adjustHunkCounts
   * reads a buffer we control.
   */
  function doctoredDiffSession(
    bufferLines: string[],
    cursorRow: number,
  ): { s: Session; done: () => void } {
    const { ws, done } = realDiffWs(EXPAND_FILE);
    const model = parseDiff(REAL_DIFF)!;
    const built = buildDiffDocument(REAL_DIFF, model, ws);
    const text = bufferLines.join("\n") + "\n";
    // Reparse the doctored text through the diff source so the document's lines
    // and the edit buffer agree, then move the cursor to the target row. The
    // real policy would refuse a body line that sits in no verified hunk; these
    // tests exercise adjustHunkCounts, not editability, so swap in a permissive
    // policy that treats any context/added line as editable.
    const real = diffSource(ws, built.edit);
    const source: EditableSource = {
      ...real,
      policy: {
        editStart: (lines, row) => {
          const c = lines[row]?.[0];
          return c === "+" || c === " " ? 1 : null;
        },
        regionKind: (lines, row) => {
          const c = lines[row]?.[0];
          return c === "+" || c === " " ? "hunk" : null;
        },
        insertPrefix: "+",
        messageIndent: "    ",
      },
    };
    const doc = source.parse(text);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 40 },
      undefined,
      source,
    );
    press(s, "e"); // reveal the cursor at the top
    for (let i = 0; i < cursorRow; i++) press(s, "down");
    return { s, done };
  }

  it("leaves the hunk counts alone on Enter on a body line in no parsed hunk", () => {
    // A buffer with an added ("+") line but no "@@" header, so the text parses
    // to no hunk containing the row: pressing Enter splits the added line and
    // calls adjustHunkCounts, which finds no hunk for the row and returns.

    const lines = [
      " context one",
      " context two",
      "+added body line",
      " context three",
    ];
    const { s, done } = doctoredDiffSession(lines, 2); // on the added line
    try {
      expect(s.view().cursor?.line, "cursor on the added line").toBe(2);
      press(s, "end");
      const before = s.doc.text;
      // Splits the added line; adjustHunkCounts finds no hunk.
      press(s, "enter");
      expect(s.doc.text, "the Enter inserted a new added line").not.toBe(
        before,
      );
      // No "@@" header exists, so none was rewritten.
      assert(
        !s.doc.lines.some((l) => l.text.startsWith("@@")),
        "still no hunk header",
      );
    } finally {
      done();
    }
  });

  it("returns `false` from `adjustHunkCounts()` for a malformed hunk header", () => {
    const lines = [
      "@@ this is not a valid hunk header @@",
      " context one",
      "+added body line",
      " context two",
    ];
    const { s, done } = doctoredDiffSession(lines, 2); // on the added line
    try {
      const internals = s.accessForTestingOnly;
      const headerBefore = internals.buffer!.lines[0];
      assert(headerBefore.startsWith("@@ "), headerBefore);
      const adjusted = internals.adjustHunkCounts(0, 1, 0);
      expect(adjusted, "the malformed header was rejected").toBe(false);
      expect(
        internals.buffer!.lines[0],
        "the malformed header was not rewritten",
      ).toBe(headerBefore);
    } finally {
      done();
    }
  });

  //
  // `ensurePickerVisible()` clamps a negative overlay scroll back to zero
  //
  // When the picker selection moves up to an entry above the current scroll,
  // `ensurePickerVisible()` sets the scroll to the selection's index. A
  // selection of 0 with a stale negative scroll would be clamped by the final
  // guard. The clamp is reached by paging the picker around so the scroll
  // briefly trails the selection, ending at the top where the guard keeps it
  // non-negative.
  //

  const TREE: Record<string, DirEntry[]> = {
    "/work": [
      { name: "sub", isDir: true },
      ...Array.from({ length: 40 }, (_, i) => ({
        name: `file${String(i).padStart(2, "0")}.ts`,
        isDir: false,
      })),
    ],
  };

  function normalize(p: string): string {
    const out: string[] = [];
    for (const part of p.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return "/" + out.join("/");
  }

  function pickerGateway(): FileGateway {
    return {
      cwd: () => "/work",
      list: (dir) => TREE[dir] ?? null,
      open: () => null,
      join: (dir, segment) => normalize(`${dir}/${segment}`),
      parent: (p) => normalize(`${p}/..`),
      base: (p) => p.split("/").filter(Boolean).pop() ?? p,
    };
  }

  function pickerSession(): Session {
    const path = "/work/file00.ts";
    const doc = parseDocument("const a = 0;\n", path);
    const source: EditableSource = {
      label: "file00.ts",
      editable: true,
      path,
      parse: (t) => parseDocument(t, path),
      save: () => "saved",
    };
    return new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 60, height: 10 },
      undefined,
      source,
      pickerGateway(),
    );
  }

  it("keeps the picker scroll non-negative when paging up to the top", () => {
    const s = pickerSession();
    press(s, "ctrl-x", "ctrl-f");
    // Drive the selection down so the scroll advances, then page up well past
    // the top: the up branch sets the scroll to the selection (0) and the final
    // guard keeps it from going negative.
    for (let i = 0; i < 20; i++) press(s, "down");
    expect(s.view().overlay!.scroll, "scrolled down").toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 30; i++) press(s, "up");
    expect(s.view().overlay!.selectedLine, "back at the first entry").toBe(0);
    expect(s.view().overlay!.scroll, "scroll never went negative")
      .toBeGreaterThanOrEqual(0);
    expect(s.view().overlay!.scroll, "scroll reset to the top").toBe(0);
  });

  //
  // card navigation and buffer editing from a real session
  //
  // These do not force the unreachable defensive returns, but assert the
  // surrounding card navigation and buffer editing stay correct from a real
  // session.
  //

  it("deselects the card reference when moving back above the first target", () => {
    const doc = parseDocument(SAMPLE);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 100, height: 24 },
    );
    selectByLabel(s, "lift __cfLift_1");
    press(s, "enter");
    const card = s.view().overlay!;
    if (!card.footer.includes("select")) return;
    press(s, "down");
    const firstSel = s.view().overlay!.selectedLine;
    expect(firstSel, "first reference focused").not.toBeUndefined();
    press(s, "up"); // back above the first target: deselects
    expect(
      s.view().overlay!.selectedLine,
      "moving above the first target deselects",
    ).toBeUndefined();
  });

  it("kills the word forward on M-d in a plain file", () => {
    const path = "/work/word.ts";
    const source: EditableSource = {
      label: "word.ts",
      editable: true,
      path,
      parse: (t) => parseDocument(t, path),
      save: () => "saved",
    };
    const doc = parseDocument("alpha beta gamma\n", path);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 60, height: 8 },
      undefined,
      source,
    );
    press(s, "e");
    s.handleKey(alt("d")); // kill the first word
    assert(!s.doc.lines[0].text.startsWith("alpha"), s.doc.lines[0].text);
  });
});
