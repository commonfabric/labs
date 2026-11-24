/**
 * Coverage-focused behavioral tests for the Markdown highlighter
 * (`lib/view/languages/markdown/markdown.ts`). Each test drives a specific code path —
 * the whole-document `Highlighter` wrapper, the empty/non-empty single-span
 * helper, the horizontal-rule branch, mismatched and unclosed inline-code
 * backtick runs, and a heading tree that opens on a deeper-than-top level —
 * and asserts the real output rather than merely touching the lines.
 */

import { assert, assertEquals } from "@std/assert";
import {
  createMarkdownHighlighter,
  highlightMarkdownLines,
  markdownDocument,
} from "../lib/view/languages/markdown/markdown.ts";

Deno.test("markdown: createMarkdownHighlighter exposes lines and re-highlights on update", () => {
  const hl = createMarkdownHighlighter("# First\n\nplain prose\n");
  // The getter returns the initial highlighting: the heading is a section
  // header span, matching a direct highlightMarkdownLines call.
  assertEquals(hl.lines[0].spans.map((s) => s.cls), ["sectionHeader"]);
  assertEquals(hl.lines, highlightMarkdownLines("# First\n\nplain prose\n"));

  // update() swaps in fresh highlighting for the new text and returns it; the
  // getter then reflects the same new lines.
  const next = "## Second\n\nmore\n";
  const updated = hl.update(next);
  assertEquals(updated, highlightMarkdownLines(next));
  assertEquals(updated[0].spans.map((s) => s.cls), ["sectionHeader"]);
  assertEquals(updated[0].text, "## Second");
  assertEquals(hl.lines, updated, "the getter tracks the last update");
});

Deno.test("markdown: oneSpan yields an empty span list for a blank fence-closing line and a span for a non-empty one", () => {
  // A fenced block whose closing fence is the empty string is impossible, so
  // drive both oneSpan branches through the fence path: an opener line is
  // non-empty (one punctuation span), and an empty line *inside* the open fence
  // takes the empty-text branch (no spans). The closing fence is non-empty.
  const lines = highlightMarkdownLines("```\n\ncode\n```\n");
  // Opener: non-empty -> a single punctuation span (oneSpan non-empty branch).
  assertEquals(lines[0].text, "```");
  assertEquals(lines[0].spans.map((s) => s.cls), ["punctuation"]);
  // Blank line inside the fence: empty text -> no spans (oneSpan empty branch).
  assertEquals(lines[1].text, "");
  assertEquals(lines[1].spans, []);
  // Body line inside the fence is a string.
  assertEquals(lines[2].spans.map((s) => s.cls), ["string"]);
  // Closing fence is punctuation.
  assertEquals(lines[3].spans.map((s) => s.cls), ["punctuation"]);
});

Deno.test("markdown: a horizontal rule line is a single punctuation span", () => {
  for (const rule of ["---", "***", "___", "- - -", "  ***  "]) {
    const [line] = highlightMarkdownLines(rule);
    assertEquals(
      line.spans.map((s) => s.cls),
      ["punctuation"],
      `the rule ${JSON.stringify(rule)} is one punctuation span`,
    );
    assertEquals(line.text, rule);
  }
  // A line that merely starts with a dash is a list, not a rule, so it keeps
  // its marker-plus-prose coloring rather than collapsing to one span.
  const [list] = highlightMarkdownLines("- a real list item");
  assert(
    list.spans.length > 1,
    "a list item is not collapsed into a single rule span",
  );
});

Deno.test("markdown: inline code with an interior backtick run of a different length still closes correctly", () => {
  // Opener is a single backtick (n=1). Inside there is a run of two backticks
  // (m=2, mismatched, so the scan steps past it via `j += m`). The closing
  // single backtick (m=1==n) ends the span. Everything from the opener through
  // the close is one string run.
  const [line] = highlightMarkdownLines("see `a``b` ok");
  const code = line.spans.find((s) => s.cls === "string");
  assert(code, "the inline code is a string span");
  assertEquals(code!.text, "`a``b`", "the whole run, interior `` included");
  // The trailing prose after the closing backtick is plain, not swallowed.
  assert(
    line.spans.some((s) => s.cls === "plain" && s.text.includes("ok")),
    "prose after the closed span is plain",
  );
});

Deno.test("markdown: an unclosed inline backtick run does not color the rest of the line", () => {
  // A lone opening backtick with no matching close: the scan finds no close,
  // advances past the run (`i += n`), and the rest of the line stays plain.
  const [line] = highlightMarkdownLines("an `unclosed run of prose");
  assert(
    !line.spans.some((s) => s.cls === "string"),
    "no string span when the backtick never closes",
  );
  // The text after the stray backtick is still plain prose.
  assert(
    line.spans.some((s) => s.cls === "plain" && s.text.includes("unclosed")),
    "prose after a stray backtick is plain",
  );

  // A multi-backtick opener that never closes takes the same path (n>1).
  const [line2] = highlightMarkdownLines("a ``double opener never closed");
  assert(
    !line2.spans.some((s) => s.cls === "string"),
    "no string span for an unclosed multi-backtick run",
  );
});

Deno.test("markdown: a document that opens on a deeper heading attaches it at the top depth", () => {
  // The first heading is level 2 with no level-1 parent above it. The tree
  // builder's "deeper heading with no parent at this level" branch attaches it
  // at depth 0 rather than nesting it under a phantom level-1 section.
  const doc = markdownDocument(
    `## Deep first\n\nbody\n\n# Later top\n\nmore\n`,
  );
  assertEquals(
    doc.flatStructure.map((n) => n.label),
    ["## Deep first", "# Later top"],
  );
  // Both sit at the root depth: the orphan level-2 heading is not nested.
  assertEquals(doc.structure.map((n) => n.label), [
    "## Deep first",
    "# Later top",
  ]);
  assertEquals(doc.flatStructure[0].depth, 0, "the orphan deep heading");
  assertEquals(doc.flatStructure[1].depth, 0, "the later top heading");
  assert(
    doc.structure.every((n) => n.children.length === 0),
    "neither root heading nests the other",
  );
});

Deno.test("markdown: a deeper-then-shallower opening keeps each heading navigable at the same depth", () => {
  // Open even deeper: a level-3 heading first, then a level-2, then a level-1.
  // The orphan-attachment branch recurses for the deeper-than-current heads and
  // keeps the structure flat at the root.
  const doc = markdownDocument(`### Third\n\na\n\n## Second\n\nb\n\n# First\n`);
  assertEquals(doc.structure.map((n) => n.label), [
    "### Third",
    "## Second",
    "# First",
  ]);
  // Pre-order depth never jumps by more than one (wasd navigation relies on it).
  let prev = -1;
  for (const n of doc.flatStructure) {
    assert(
      n.depth <= prev + 1,
      `depth jump at ${n.label}: ${prev} -> ${n.depth}`,
    );
    prev = n.depth;
  }
});
