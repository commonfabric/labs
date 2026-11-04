/**
 * The incremental highlighter ({@link createHighlighter}) must produce exactly
 * the same colored lines as a full {@link highlightDocument} parse — it keeps
 * the TypeScript source file warm and re-highlights only the region an edit
 * touches, so its result has to match a from-scratch parse at every step of a
 * realistic edit. These tests drive it through the edits a person makes: typing
 * a file out and deleting it one character at a time, and opening then closing
 * the multi-line constructs (block comment, template, string) whose color
 * spills onto later lines.
 */

import { assert, assertEquals } from "@std/assert";
import {
  createHighlighter,
  highlightDocument,
} from "../lib/view/languages/typescript/parse.ts";
import type { Line } from "../lib/view/model.ts";
import { SAMPLE, TS_PARSER_REGRESSION } from "./view-helpers.ts";

/** The index of the first line that differs in text or spans, or -1. Spans are
 * compared on every field the renderer reads. */
function firstDiff(a: readonly Line[], b: readonly Line[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]?.text !== b[i]?.text) return i;
    const sa = a[i].spans;
    const sb = b[i].spans;
    if (sa.length !== sb.length) return i;
    for (let j = 0; j < sa.length; j++) {
      if (
        sa[j].col !== sb[j].col || sa[j].text !== sb[j].text ||
        sa[j].cls !== sb[j].cls ||
        sa[j].bracketDepth !== sb[j].bracketDepth ||
        sa[j].exactDefinitionName !== sb[j].exactDefinitionName ||
        sa[j].exactDefinitionDisplayName !== sb[j].exactDefinitionDisplayName
      ) {
        return i;
      }
    }
  }
  return -1;
}

/** Drive the highlighter through a sequence of texts, asserting that each
 * incremental result equals a full parse of the same text. */
function checkSequence(label: string, steps: string[]): void {
  const hl = createHighlighter(steps[0], "m.ts");
  assertEquals(
    firstDiff(hl.lines, highlightDocument(steps[0], "m.ts")),
    -1,
    `${label}: initial highlight differs from a full parse`,
  );
  for (let i = 1; i < steps.length; i++) {
    const inc = hl.update(steps[i]);
    const full = highlightDocument(steps[i], "m.ts");
    const d = firstDiff(inc, full);
    assertEquals(
      d,
      -1,
      `${label}: step ${i} line ${d} differs\n  inc : ${
        JSON.stringify(inc[d]?.spans)
      }\n  full: ${JSON.stringify(full[d]?.spans)}`,
    );
  }
}

Deno.test("highlighter: typing a file out one character at a time matches a full parse", () => {
  const steps: string[] = [""];
  for (let i = 1; i <= SAMPLE.length; i++) steps.push(SAMPLE.slice(0, i));
  checkSequence("type-forward", steps);
});

Deno.test("highlighter: deleting a file one character at a time matches a full parse", () => {
  const steps: string[] = [];
  for (let i = SAMPLE.length; i >= 0; i--) steps.push(SAMPLE.slice(0, i));
  checkSequence("delete-backward", steps);
});

Deno.test("highlighter: opening and closing multi-line constructs matches a full parse", () => {
  const mid = SAMPLE.indexOf("export const myPattern");
  const head = SAMPLE.slice(0, mid);
  const tail = SAMPLE.slice(mid);
  const at = (s: string) => head + s + tail;
  // A block comment, a template literal, and a string, each grown one keystroke
  // at a time from unterminated to closed — the states that recolor the lines
  // below the cursor.
  checkSequence("open-close-constructs", [
    SAMPLE,
    at("/"),
    at("/*"),
    at("/* note"),
    at("/* note\n"),
    at("/* note\nmore"),
    at("/* note\nmore */"),
    at("`"),
    at("`abc"),
    at("`abc${"),
    at("`abc${x"),
    at("`abc${x}"),
    at("`abc${x}def`"),
    at('"'),
    at('"open'),
    at('"open"'),
    SAMPLE,
  ]);
});

Deno.test("highlighter: inserting and deleting at every position matches a full parse", () => {
  const hl = createHighlighter(SAMPLE, "m.ts");
  let cur = SAMPLE;
  for (let p = 0; p < SAMPLE.length; p += 5) {
    cur = cur.slice(0, p) + "Z" + cur.slice(p);
    assertEquals(
      firstDiff(hl.update(cur), highlightDocument(cur, "m.ts")),
      -1,
      `insert at ${p} differs`,
    );
    cur = cur.slice(0, p) + cur.slice(p + 1);
    assertEquals(
      firstDiff(hl.update(cur), highlightDocument(cur, "m.ts")),
      -1,
      `delete at ${p} differs`,
    );
  }
});

Deno.test("highlighter: an edit re-baselines correctly across a multi-line comment", () => {
  // Opening a block comment recolors the lines it now swallows; closing it
  // restores them. The incremental result must track a full parse through both.
  const hl = createHighlighter(
    "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    "m.ts",
  );
  const opened = "/* const a = 1;\nconst b = 2;\nconst c = 3;\n";
  const inc = hl.update(opened);
  assert(
    inc[1].spans.every((s) => s.cls === "comment" || s.cls === "whitespace"),
    "line inside the open comment is comment-colored",
  );
  assertEquals(firstDiff(inc, highlightDocument(opened, "m.ts")), -1);
  const closed = "/* const a = 1;\nconst b = 2; */\nconst c = 3;\n";
  assertEquals(
    firstDiff(hl.update(closed), highlightDocument(closed, "m.ts")),
    -1,
    "closing the comment restores the lines below",
  );
});

Deno.test("highlighter: parser failures fall back and later edits recover", () => {
  const valid = "const view = <div>ready</div>;\n";

  const highlighter = createHighlighter(valid, "fixture.tsx");
  assertEquals(
    firstDiff(
      highlighter.update(TS_PARSER_REGRESSION),
      highlightDocument(TS_PARSER_REGRESSION, "fixture.tsx"),
    ),
    -1,
    "an incremental parse failure uses the full-parse fallback",
  );
  assertEquals(
    firstDiff(
      highlighter.update(valid),
      highlightDocument(valid, "fixture.tsx"),
    ),
    -1,
    "a later valid edit restores syntax highlighting",
  );

  const failedInitially = createHighlighter(
    TS_PARSER_REGRESSION,
    "fixture.tsx",
  );
  assertEquals(
    firstDiff(
      failedInitially.lines,
      highlightDocument(TS_PARSER_REGRESSION, "fixture.tsx"),
    ),
    -1,
    "an initial parse failure uses the full-parse fallback",
  );
  assertEquals(
    firstDiff(
      failedInitially.update(valid),
      highlightDocument(valid, "fixture.tsx"),
    ),
    -1,
    "an initially failed highlighter recovers",
  );
});
