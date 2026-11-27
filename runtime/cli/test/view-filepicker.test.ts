/**
 * The interactive file picker (C-x C-f): listing a directory, filtering by
 * typing, descending and stepping up, opening a file (which swaps the session's
 * buffer), and refusing to discard unsaved edits. A fake {@link FileGateway}
 * stands in for the filesystem so this stays pure.
 */

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { cellOf, drawnRows, mouseKey, parseDocument } from "./view-helpers.ts";
import { overlayBox } from "../lib/view/render.ts";
import { Session } from "../lib/view/session.ts";
import { buildView } from "../lib/view/mod.ts";
import type { EditableSource } from "../lib/view/editsource.ts";
import type { DirEntry, FileGateway } from "../lib/view/filegateway.ts";
import { describe, it, test } from "@commonfabric/test-support/test";

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

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

const TREE: Record<string, DirEntry[]> = {
  "/work": [
    { name: "sub", isDir: true },
    { name: "a.ts", isDir: false },
    { name: "b.ts", isDir: false },
  ],
  "/work/sub": [{ name: "c.ts", isDir: false }],
};

const FILES: Record<string, string> = {
  "/work/a.ts": "const a = 1;\n",
  "/work/b.ts": "const b = 2;\n",
  "/work/sub/c.ts": "const c = 3;\n",
};

function gateway(): FileGateway {
  const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  return {
    cwd: () => "/work",
    list: (dir) => TREE[dir] ?? null,
    open: (path) => {
      const text = FILES[path];
      if (text === undefined) return null;
      return { source: fakeSource(path), text };
    },
    join: (dir, segment) => normalize(`${dir}/${segment}`),
    parent: (p) => normalize(`${p}/..`),
    base,
  };
}

function fakeSource(path: string): EditableSource {
  return {
    label: path.split("/").filter(Boolean).pop() ?? path,
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
  };
}

/** A session viewing /work/a.ts, with the fake gateway wired in. */
function session(): Session {
  const path = "/work/a.ts";
  const doc = parseDocument(FILES[path], path);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 20 },
    undefined,
    fakeSource(path),
    gateway(),
  );
}

function openPicker(s: Session): void {
  press(s, "ctrl-x", "ctrl-f");
}

function entryText(s: Session): string[] {
  return s.view().overlay?.lines.map((l) => l.text) ?? [];
}

test("filepicker: lists the file's directory, dirs first, with a .. entry", () => {
  const s = session();
  openPicker(s);
  assertEquals(entryText(s), ["../", "sub/", "a.ts", "b.ts"]);
  assertEquals(s.view().inputLine, "find file: /work");
  assertEquals(s.view().overlay?.selectedLine, 0);
});

test("filepicker: pressing the mouse on an entry selects it", () => {
  const s = session();
  openPicker(s);
  s.handleKey(mouseKey(true, cellOf(drawnRows(s), "b.ts")));
  assertEquals(s.view().overlay?.selectedLine, 3);
  press(s, "enter");
  assertEquals(s.doc.text, FILES["/work/b.ts"]);
});

test("filepicker: pressing the mouse off the entries keeps the selection", () => {
  const s = session();
  openPicker(s);
  press(s, "down"); // ".." -> "sub/"
  const rows = drawnRows(s);
  s.handleKey(mouseKey(true, cellOf(rows, "Open file")));
  s.handleKey(mouseKey(true, cellOf(rows, "enter open")));
  const box = overlayBox(s.width, s.height);
  assert(box.innerH > 5, "the box shows rows below the four entries");
  s.handleKey(mouseKey(true, { x: box.x + 2, y: box.y + 1 + 5 }));
  assertEquals(s.view().overlay?.selectedLine, 1);
});

test("filepicker: typing filters the list and drops the .. entry", () => {
  const s = session();
  openPicker(s);
  type(s, "a");
  assertEquals(entryText(s), ["a.ts"]);
  assertEquals(s.view().inputLine, "find file: /work/a");
});

test("filepicker: enter on a directory descends into it", () => {
  const s = session();
  openPicker(s);
  press(s, "down"); // ".." -> "sub/"
  assertEquals(s.view().overlay?.selectedLine, 1);
  press(s, "enter");
  assertEquals(entryText(s), ["../", "c.ts"]);
});

test("filepicker: enter on a file opens it and swaps the buffer", () => {
  const s = session();
  openPicker(s);
  press(s, "down", "down"); // ".." -> "sub/" -> "a.ts"
  press(s, "enter");
  assertEquals(s.view().overlay, null, "picker closed");
  assertEquals(s.doc.text, FILES["/work/a.ts"]);
  assert(s.view().message.includes("Opened"));
  // The opened file is now editable in its own right.
  press(s, "e"); // reveal the cursor
  assertEquals(s.view().cursor, { line: 0, col: 0 });
});

test("filepicker: opening a file from a subdirectory works", () => {
  const s = session();
  openPicker(s);
  press(s, "down", "enter"); // into sub/
  press(s, "down", "enter"); // ".." -> "c.ts", open it
  assertEquals(s.doc.text, FILES["/work/sub/c.ts"]);
});

describe("filepicker view modes", () => {
  it("applies the rendered default when opening a binary source", () => {
    const opened = buildView(
      new Uint8Array([0x41, 0x00, 0xff]),
      "/work/payload.png",
    );
    const files: FileGateway = {
      cwd: () => "/work",
      list: () => [{ name: "payload.png", isDir: false }],
      open: () => ({ source: opened.editSource, text: opened.doc.text }),
      join: (dir, segment) => normalize(`${dir}/${segment}`),
      parent: (path) => normalize(`${path}/..`),
      base: (path) => path.split("/").filter(Boolean).pop() ?? path,
    };
    const path = "/work/a.ts";
    const s = new Session(
      parseDocument(FILES[path], path),
      { color: false, showLineNumbers: false },
      { width: 80, height: 20 },
      undefined,
      fakeSource(path),
      files,
    );

    openPicker(s);
    press(s, "down", "enter");

    assert(s.doc.lines[0].text.endsWith("|A␀␦|"));
    expect(s.doc.lines.at(-1)?.text).toBe("00000003");
  });

  it("preserves rendered mode when opening another renderable file", () => {
    const initial = buildView("# First\n", "/work/a.md");
    const opened = buildView("# Second\n", "/work/b.md");
    const files: FileGateway = {
      cwd: () => "/work",
      list: () => [{ name: "b.md", isDir: false }],
      open: () => ({ source: opened.editSource, text: opened.doc.text }),
      join: (dir, segment) => normalize(`${dir}/${segment}`),
      parent: (path) => normalize(`${path}/..`),
      base: (path) => path.split("/").filter(Boolean).pop() ?? path,
    };
    const s = new Session(
      initial.doc,
      { color: false, showLineNumbers: false, viewMode: "rendered" },
      { width: 80, height: 20 },
      undefined,
      initial.editSource,
      files,
    );

    openPicker(s);
    press(s, "down", "enter");

    expect(s.view().viewMode).toBe("rendered");
    expect(s.doc.text).toBe("# Second\n");
  });
});

test("filepicker: the .. entry steps back up", () => {
  const s = session();
  openPicker(s);
  press(s, "down", "enter"); // into sub/
  assertEquals(entryText(s), ["../", "c.ts"]);
  press(s, "enter"); // selection is "..", step up
  assertEquals(entryText(s), ["../", "sub/", "a.ts", "b.ts"]);
});

test("filepicker: backspace on an empty filter steps up", () => {
  const s = session();
  openPicker(s);
  press(s, "down", "enter"); // into sub/
  press(s, "backspace");
  assertEquals(entryText(s), ["../", "sub/", "a.ts", "b.ts"]);
});

test("filepicker: escape cancels and leaves the buffer untouched", () => {
  const s = session();
  openPicker(s);
  press(s, "escape");
  assertEquals(s.view().overlay, null);
  assertEquals(s.view().message, "Cancelled");
  assertEquals(s.doc.text, FILES["/work/a.ts"]);
});

test("filepicker: opening from pager mode preserves the viewport", () => {
  const path = "/work/a.ts";
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const s = new Session(
    parseDocument(text, path),
    { color: false, showLineNumbers: false },
    { width: 60, height: 5 },
    undefined,
    fakeSource(path),
    gateway(),
  );
  for (let i = 0; i < 8; i++) press(s, "down");
  assertEquals(s.view().top, 8);
  openPicker(s);
  press(s, "escape");
  assertEquals(s.view().top, 8);
});

test("filepicker: refuses to open with unsaved edits", () => {
  const s = session();
  press(s, "e"); // reveal cursor
  type(s, "X"); // dirty the buffer
  openPicker(s);
  press(s, "down", "down", "down"); // select b.ts
  press(s, "enter");
  assert(
    s.view().message.includes("Save or discard"),
    s.view().message,
  );
  assert(s.doc.text.startsWith("X"), "still the edited a.ts, not b.ts");
});
