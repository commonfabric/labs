import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseDiff } from "../../../lib/view/diff.ts";
import { buildDiffDocument } from "../../../lib/view/diffdoc.ts";
import { diffSource } from "../../../lib/view/diffedit.ts";
import type { EditableSource } from "../../../lib/view/editsource.ts";
import type { FileGateway } from "../../../lib/view/filegateway.ts";
import { overlayBox } from "../../../lib/view/render.ts";
import { Session } from "../../../lib/view/session.ts";
import { parseDocument, SAMPLE } from "../../view-helpers.ts";

/** Sends printable characters and named keys through the public event handler. */
function press(session: Session, ...names: string[]): void {
  for (const name of names) {
    session.handleKey(
      name === "space"
        ? { name, char: " " }
        : name.length === 1
        ? { name, char: name }
        : { name },
    );
  }
}

/** Opens a short viewport on the sample's structured TypeScript. */
function session(source?: EditableSource, files?: FileGateway): Session {
  return new Session(
    parseDocument(SAMPLE),
    { color: false, showLineNumbers: false },
    { width: 80, height: 12 },
    undefined,
    source,
    files,
  );
}

/** Opens a diff index long enough to navigate by pages. */
function index(): Session {
  const text = Array.from({ length: 30 }, (_, i) =>
    [
      `diff --git a/file${i}.ts b/file${i}.ts`,
      `--- a/file${i}.ts`,
      `+++ b/file${i}.ts`,
      "@@ -1 +1 @@",
      "-old();",
      "+new();",
      "",
    ].join("\n")).join("\n");
  const workspace = { resolve: () => null, read: () => null };
  const { doc, edit } = buildDiffDocument(text, parseDiff(text)!, workspace);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 12 },
    undefined,
    diffSource(workspace, edit),
  );
  press(s, "i");
  return s;
}

/** A directory listing with no disk access. */
function picker(): Session {
  const files: FileGateway = {
    cwd: () => "/work",
    list: () =>
      Array.from({ length: 30 }, (_, i) => ({
        name: `file${i}.ts`,
        isDir: false,
      })),
    open: () => null,
    join: (dir, name) => `${dir}/${name}`,
    parent: () => "/work",
    base: (path) => path.split("/").at(-1)!,
  };
  const s = session(editableSource(), files);
  press(s, "ctrl-x", "ctrl-f");
  return s;
}

/** An editable file whose saves require no filesystem. */
function editableSource(): EditableSource {
  return {
    label: "sample.ts",
    path: "/work/sample.ts",
    editable: true,
    parse: (text) => parseDocument(text),
    save: () => "saved",
  };
}

/** Opens the sample's lift card, which contains selectable references. */
function card(): Session {
  const s = session();
  for (const _ of s.doc.flatStructure) {
    if (s.view().selected?.label === "lift __cfLift_1") break;
    press(s, "tab");
  }
  expect(s.view().selected?.label).toBe("lift __cfLift_1");
  press(s, "enter");
  return s;
}

describe("Session", () => {
  describe("instance members", () => {
    describe("handleKey()", () => {
      describe("dialog navigation", () => {
        for (const kind of ["help", "card", "source"]) {
          it(`reaches and stops at both ends of the ${kind} dialog`, () => {
            const s = kind === "help" ? session() : card();
            if (kind === "help") press(s, "?");
            if (kind === "source") press(s, "tab");
            const last = s.view().overlay!.lines.length -
              overlayBox(80, 12).innerH;
            expect(last).toBeGreaterThan(0);
            const top = s.view().top;
            for (const [first, end] of [["g", "G"], ["home", "end"]]) {
              press(s, first);
              expect(s.view().overlay?.scroll).toBe(0);
              press(s, end, end);
              expect(s.view().overlay?.scroll).toBe(last);
              press(s, first, first);
              expect(s.view().overlay?.scroll).toBe(0);
              expect(s.view().overlay?.selectedLine).toBeUndefined();
            }
            expect(s.view().top).toBe(top);
            expect(s.quit).toBe(false);
          });
        }

        for (const kind of ["help", "index", "picker"]) {
          for (const height of [8, 12, 60]) {
            it(`shares navigation in the ${kind} at height ${height}`, () => {
              const s = kind === "help"
                ? session()
                : kind === "index"
                ? index()
                : picker();
              if (kind === "help") press(s, "?");
              s.resize(80, height);
              const rows = overlayBox(80, height).innerH;
              const page = Math.max(1, rows - 1);
              const position = () =>
                kind === "help"
                  ? s.view().overlay!.scroll
                  : s.view().overlay!.selectedLine;
              const last = kind === "help"
                ? s.view().overlay!.lines.length - rows
                : kind === "index"
                ? 29
                : 30;
              const lineKeys = [["down", "up"], ["ctrl-n", "ctrl-p"]];
              if (kind !== "picker") lineKeys.push(["j", "k"], ["J", "K"]);
              for (const [down, up] of lineKeys) {
                press(s, "home", down);
                expect(position()).toBe(1);
                press(s, up, up);
                expect(position()).toBe(0);
              }
              for (
                const [down, up] of [["pagedown", "pageup"], [
                  "ctrl-f",
                  "ctrl-b",
                ]]
              ) {
                press(s, down);
                expect(position()).toBe(Math.min(page, last));
                press(s, up);
                expect(position()).toBe(0);
              }
              press(s, "ctrl-d");
              expect(position()).toBe(
                Math.min(Math.max(1, Math.floor(rows / 2)), last),
              );
              press(s, "ctrl-u");
              expect(position()).toBe(0);
              if (kind !== "picker") {
                for (const up of ["b", "B"]) {
                  press(s, "space");
                  expect(position()).toBe(Math.min(page, last));
                  press(s, up);
                  expect(position()).toBe(0);
                }
              }
              press(s, "end", "down", "pagedown");
              expect(position()).toBe(last);
              press(s, "home", "left", "right");
              expect(position()).toBe(0);
            });
          }
        }

        for (const kind of ["index", "picker"]) {
          it(`preserves printable navigation keys as ${kind} filter text`, () => {
            const s = kind === "index" ? index() : picker();
            if (kind === "index") press(s, "/");
            press(s, ..."file");
            press(s, "end");
            expect(s.view().overlay?.selectedLine).toBe(29);
            press(s, "home");
            expect(s.view().overlay?.selectedLine).toBe(0);
            press(s, ..."gGjJkKbB", "space");
            expect(s.view().inputLine).toMatch(/filegGjJkKbB $/);
            press(s, "end", "down", "home", "up");
            expect(s.view().overlay?.selectedLine).toBeUndefined();
            expect(s.view().overlay?.scroll).toBe(0);
          });
        }

        it("scrolls a short card by half a page without selecting a reference", () => {
          const s = card();
          s.resize(80, 8);
          press(s, "ctrl-d");
          expect(s.view().overlay?.scroll).toBe(1);
          expect(s.view().overlay?.selectedLine).toBeUndefined();
          press(s, "ctrl-u", "ctrl-n");
          expect(s.view().overlay?.selectedLine).toBeDefined();
          press(s, "G");
          expect(s.view().overlay?.selectedLine).toBeUndefined();
          press(s, "g", "ctrl-n", "ctrl-p");
          expect(s.view().overlay?.scroll).toBe(0);
          expect(s.view().overlay?.selectedLine).toBeUndefined();
        });

        it("keeps definition lookup text separate from the underlying dialog", () => {
          const s = session();
          press(s, "?", "t", "g", "G");
          expect(s.view().inputLine).toBe("definition: gG");
          expect(s.view().overlay?.scroll).toBe(0);
        });

        for (const kind of ["save", "amend", "revert"]) {
          it(`moves ${kind} prompt focus without activating a button`, () => {
            let saved = false;
            const source = editableSource();
            source.save = () => {
              saved = true;
              return "saved";
            };
            if (kind === "amend") {
              source.pendingAmend = () => ({
                sha: "a".repeat(40),
                subject: "Change",
              });
            }
            const s = session(source);
            press(s, "e", "x");
            if (kind === "revert") press(s, "ctrl-r");
            else press(s, "escape", kind === "save" ? "q" : "f3");
            const last = s.view().dialog!.buttons.length - 1;
            for (const [first, end] of [["g", "G"], ["home", "end"]]) {
              press(s, end, end);
              expect(s.view().dialog?.focus).toBe(last);
              press(s, first, first);
              expect(s.view().dialog?.focus).toBe(0);
            }
            for (
              const [next, previous] of [
                ["down", "up"],
                ["j", "k"],
                ["J", "K"],
                ["ctrl-n", "ctrl-p"],
                ["right", "left"],
              ]
            ) {
              press(s, next);
              expect(s.view().dialog?.focus).toBe(1);
              press(s, previous, previous);
              expect(s.view().dialog?.focus).toBe(0);
            }
            expect(saved).toBe(false);
            expect(s.quit).toBe(false);
            press(s, "G", "space");
            expect(s.view().dialog).toBeNull();
            expect(saved).toBe(false);
            expect(s.quit).toBe(false);
          });
        }
      });
    });
  });
});
