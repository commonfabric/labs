/**
 * Coverage for the editable-source factories in `editsource.ts`: a plain
 * file's `dirtyLabels` and wholesale `revert`, and a read-only view's `parse`.
 * These paths are exercised directly on the returned EditableSource so each
 * conditional branch is asserted on its real output.
 */

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  fileSource,
  readonlySource,
  shortName,
} from "../lib/view/editsource.ts";
import { binaryLanguage } from "../lib/view/languages/binary/language.ts";

Deno.test("fileSource.dirtyLabels: empty when unchanged, the filename when changed", () => {
  const src = fileSource("/tmp/some/dir/example.ts");
  assert(src.dirtyLabels, "a plain file reports its dirty labels");

  const text = "const a = 1;\nconst b = 2;\n";
  assertEquals(
    src.dirtyLabels(text, text),
    [],
    "no label when original and current match",
  );
  assertEquals(
    src.dirtyLabels(text, text + "const c = 3;\n"),
    [shortName("/tmp/some/dir/example.ts")],
    "the short filename when they differ",
  );
  assertEquals(
    src.dirtyLabels(text, text + "const c = 3;\n"),
    ["example.ts"],
    "the short name strips the directory",
  );
});

Deno.test("fileSource.revert: null when unchanged, whole file otherwise", () => {
  const src = fileSource("/tmp/some/dir/example.ts");
  assert(src.revert, "a plain file supports revert");

  const original = "line0\nline1\nline2\n";
  assertEquals(
    src.revert(original, original, 1, "chunk"),
    null,
    "nothing to revert when current equals original",
  );

  const current = "line0\nEDITED\nline2\nEXTRA\n";
  const reverted = src.revert(original, current, 2, "file");
  assertEquals(
    reverted,
    { text: original, cursorLine: 2 },
    "reverts wholesale to the original text, cursor held in range",
  );
});

Deno.test("fileSource.revert: clamps the cursor to the reverted file's last line", () => {
  const src = fileSource("/tmp/x.ts");
  assert(src.revert);

  // original has 4 lines (indices 0..3 from the trailing newline split).
  const original = "a\nb\nc\n";
  const current = "a\nb\nc\nd\ne\nf\n";
  // Cursor sits beyond the original's extent; revert pins it to the last line.
  const reverted = src.revert(original, current, 5, "all");
  assertEquals(reverted, {
    text: original,
    cursorLine: original.split("\n").length - 1,
  });
  // The clamp index is the last index of the split, not the cursor we passed.
  assertEquals(reverted!.cursorLine, 3);
});

Deno.test("fileSource.revert: keeps an in-range cursor unchanged", () => {
  const src = fileSource("/tmp/y.ts");
  assert(src.revert);

  const original = "one\ntwo\nthree\nfour\n";
  const current = "one\ntwo\nCHANGED\nfour\n";
  const reverted = src.revert(original, current, 1, "chunk");
  assertEquals(reverted, { text: original, cursorLine: 1 });
});

describe("fileSource.save() with a read-only language", () => {
  it("leaves the file unchanged", () => {
    const dir = Deno.makeTempDirSync();
    const path = `${dir}/payload.data`;
    const bytes = new Uint8Array([0x41, 0x00, 0xff]);
    try {
      Deno.writeFileSync(path, bytes);
      const source = fileSource(path, binaryLanguage);

      expect(source.editable).toBe(false);
      expect(source.save("replacement", [])).toBe(
        "Binary data is shown as a hex dump and cannot be edited.",
      );
      expect(Deno.readFileSync(path)).toEqual(bytes);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });
});

Deno.test("readonlySource.parse: parses text into a Document without a path", () => {
  const reason =
    "This view is of a pipe — there is no underlying file to edit.";
  const src = readonlySource(reason);

  assertEquals(src.editable, false, "a read-only source is not editable");
  assertEquals(src.label, null);
  assertEquals(src.reason, reason);
  assertEquals(
    src.save("anything", []),
    reason,
    "save is a no-op returning reason",
  );

  const doc = src.parse("const a = 1;\nconst b = 2;\n");
  assertEquals(
    doc.text,
    "const a = 1;\nconst b = 2;\n",
    "round-trips the text",
  );
  assertEquals(doc.lines.length, 3, "lines include the trailing empty line");
  assert(
    doc.lines.every((l) => typeof l.text === "string"),
    "every line carries rendered text",
  );
});
