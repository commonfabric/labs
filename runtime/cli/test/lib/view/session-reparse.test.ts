import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { EditableSource } from "../../../lib/view/editsource.ts";
import type { FileGateway } from "../../../lib/view/filegateway.ts";
import { Session } from "../../../lib/view/session.ts";
import { parseDocument } from "../../view-helpers.ts";

const TEXT = Array.from({ length: 60 }, (_, i) => `const n${i} = ${i};`)
  .join("\n");

/** A read-only source over TypeScript that counts its parses. */
function countingSource(): { source: EditableSource; parses: () => number } {
  let parses = 0;
  return {
    source: {
      label: null,
      editable: false,
      parse: (text) => {
        parses++;
        return parseDocument(text);
      },
      save: () => "Nothing to save.",
    },
    parses: () => parses,
  };
}

/** Opens a short viewport on `TEXT`, backed by `source`, which can open
 * `files`. */
function session(source: EditableSource, files?: FileGateway): Session {
  return new Session(
    parseDocument(TEXT),
    { color: false, showLineNumbers: false },
    { width: 80, height: 12 },
    undefined,
    source,
    files,
  );
}

describe("Session", () => {
  describe("instance members", () => {
    describe("reparse()", () => {
      it("leaves a view scrolled away from the start where it is", () => {
        const { source, parses } = countingSource();
        const shown = session(source);
        shown.handleKey({ name: "pagedown" });
        shown.handleKey({ name: "pagedown" });
        const top = shown.view().top;

        shown.reparse({ force: true });

        expect(parses()).toBe(1);
        expect(top).toBeGreaterThan(0);
        expect(shown.view().top).toBe(top);
      });

      it("brings an edit cursor scrolled out of view back into view", () => {
        const shown = session({
          label: null,
          editable: true,
          parse: (text) => parseDocument(text),
          save: () => "saved",
        });
        shown.handleKey({ name: "e", char: "e" });
        shown.top = 20;

        shown.reparse({ force: true });

        expect(shown.view().cursor?.line).toBe(0);
        expect(shown.view().top).toBe(0);
      });
    });

    describe("reparse() with a structure tree numbered differently", () => {
      it("keeps the selected node selected", () => {
        const doc = parseDocument(TEXT);
        const fewer = { ...doc, flatStructure: doc.flatStructure.slice(1) };
        const shown = session({
          label: null,
          editable: false,
          parse: () => fewer,
          save: () => "Nothing to save.",
        });
        shown.accessForTestingOnly.selectNode(3);
        const selected = shown.view().selected;

        shown.reparse({ force: true });

        expect(selected?.label).toBe(doc.flatStructure[3].label);
        expect(shown.view().selected).toEqual(selected);
      });

      it("selects nothing once the selected node is gone", () => {
        const doc = parseDocument(TEXT);
        const shown = session({
          label: null,
          editable: false,
          parse: () => ({ ...doc, structure: [], flatStructure: [] }),
          save: () => "Nothing to save.",
        });
        shown.accessForTestingOnly.selectNode(3);

        shown.reparse({ force: true });

        expect(shown.view().selected).toBeNull();
      });
    });

    describe("highlighting", () => {
      it("is true while highlighting progress is shown", () => {
        const shown = session(countingSource().source);

        shown.showHighlightProgress(0.5);
        const during = shown.highlighting;
        shown.showHighlightProgress(null);

        expect([during, shown.highlighting]).toEqual([true, false]);
      });

      it("becomes false once another file is opened", () => {
        const other = countingSource();
        const files: FileGateway = {
          cwd: () => "/work",
          list: () => [{ name: "other.ts", isDir: false }],
          open: () => ({ source: other.source, text: TEXT }),
          join: (dir, name) => `${dir}/${name}`,
          parent: () => "/work",
          base: (path) => path.split("/").at(-1)!,
        };
        const shown = session(countingSource().source, files);
        shown.showHighlightProgress(0.5);

        shown.handleKey({ name: "ctrl-x" });
        shown.handleKey({ name: "ctrl-f" });
        for (const char of "other") shown.handleKey({ name: char, char });
        shown.handleKey({ name: "enter" });

        expect(shown.highlighting).toBe(false);
        expect(shown.view().highlighting).toBeNull();
      });
    });
  });
});
