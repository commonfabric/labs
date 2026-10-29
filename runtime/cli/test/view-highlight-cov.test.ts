import { assertEquals } from "@std/assert";
import {
  renderLineColored,
  renderLinePlain,
  spanStyle,
} from "../lib/view/highlight.ts";
import type { Line } from "../lib/view/model.ts";
import { stripAnsi } from "../lib/view/ansi.ts";
import { parseDocument, SAMPLE } from "./view-helpers.ts";

Deno.test("renderLinePlain returns the verbatim line text, no color", () => {
  const line: Line = {
    text: "const x = 1;",
    spans: [
      { col: 0, text: "const ", cls: "storageKeyword" },
      { col: 6, text: "x", cls: "binding" },
      { col: 7, text: " = ", cls: "operator" },
      { col: 10, text: "1", cls: "number" },
      { col: 11, text: ";", cls: "punctuation" },
    ],
  };
  const out = renderLinePlain(line);
  assertEquals(out, "const x = 1;");
  // No ANSI escape sequences are introduced.
  assertEquals(stripAnsi(out), out);
});

Deno.test("renderLinePlain ignores spans and background tint entirely", () => {
  const line: Line = {
    text: "  +added line",
    spans: [
      { col: 0, text: "  ", cls: "whitespace" },
      { col: 2, text: "+", cls: "diffAdd" },
      { col: 3, text: "added line", cls: "plain" },
    ],
    bg: "add",
  };
  // Plain rendering never tints, never paints: identical to the raw text.
  assertEquals(renderLinePlain(line), "  +added line");
});

Deno.test("renderLinePlain handles an empty line", () => {
  assertEquals(renderLinePlain({ text: "", spans: [] }), "");
});

Deno.test("spanStyle renders comments in bright white", () => {
  for (const cls of ["comment", "docComment"] as const) {
    assertEquals(
      spanStyle({ col: 0, text: "comment", cls }).fg,
      [255, 255, 255],
    );
  }
});

Deno.test("renderLinePlain matches every parsed line of the sample blob", () => {
  const doc = parseDocument(SAMPLE);
  for (const line of doc.lines) {
    assertEquals(renderLinePlain(line), line.text);
  }
});

Deno.test("renderLinePlain equals stripAnsi of the colored render", () => {
  const doc = parseDocument(SAMPLE);
  for (const line of doc.lines) {
    const plain = renderLinePlain(line);
    const colored = renderLineColored(line, true);
    assertEquals(plain, stripAnsi(colored));
  }
});
