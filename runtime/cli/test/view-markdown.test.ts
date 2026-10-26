/**
 * The Markdown highlighter: a `.md` file (opened directly or seen in a diff) is
 * colored as Markdown — headings, fenced/inline code, lists, quotes, links —
 * not parsed as TypeScript, and its headings form the navigation tree.
 */

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import {
  highlightMarkdownLines,
  markdownDocument,
} from "../lib/view/languages/markdown/markdown.ts";
import { languageForFile } from "../lib/view/languages/language.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { createDiffHighlighter } from "../lib/view/diffedit.ts";
import { spanStyle } from "../lib/view/highlight.ts";

Deno.test("markdown: language metadata recognizes markdown extensions", () => {
  assertEquals(languageForFile("README.md").id, "markdown");
  assertEquals(languageForFile("/a/b/AGENTS.markdown").id, "markdown");
  assertEquals(languageForFile("notes.MD").id, "markdown");
  assertEquals(languageForFile("foo.ts").id, "typescript");
  assertEquals(languageForFile("foo.tsx").id, "typescript");
  assertEquals(languageForFile(undefined).id, "plain-text");
});

Deno.test("markdown: headings, code, lists, quotes and prose get distinct, non-TS colors", () => {
  const lines = highlightMarkdownLines(
    `# Title

- a list item with \`code\` and prose
\`\`\`bash
deno task cf
\`\`\`
> a quote
`,
  );
  // A heading is one sectionHeader span.
  assertEquals(lines[0].spans.map((s) => s.cls), ["sectionHeader"]);
  // The list line: marker punctuation, prose plain, inline code a string — and
  // crucially none of the TypeScript token classes that made it a mess.
  const list = lines[2].spans;
  assertEquals(list[0].cls, "punctuation", "the list marker");
  assert(
    list.some((s) => s.cls === "string" && s.text.includes("code")),
    "inline code is a string",
  );
  assert(
    list.some((s) => s.cls === "plain" && s.text.includes("prose")),
    "prose is plain",
  );
  assert(
    !list.some((s) => s.cls === "identifier" || s.cls === "operator"),
    "no TypeScript identifier/operator colors",
  );
  // The fenced code block: fences are punctuation, content is a string.
  assertEquals(lines[3].spans.map((s) => s.cls), ["punctuation"]); // ```bash
  assertEquals(lines[4].spans.map((s) => s.cls), ["string"]); // deno task cf
  assertEquals(lines[5].spans.map((s) => s.cls), ["punctuation"]); // ```
  // A block quote has its own muted style, separate from source comments.
  assertEquals(lines[6].spans.map((s) => s.cls), ["markdownQuote"]);
  assertEquals(spanStyle(lines[6].spans[0]).fg, [92, 99, 112]);
});

Deno.test("markdown: a link's URL is a string, brackets/parens punctuation", () => {
  const [line] = highlightMarkdownLines("see [docs](http://x) here");
  assert(line.spans.some((s) => s.cls === "string" && s.text === "http://x"));
  assert(line.spans.some((s) => s.cls === "punctuation" && s.text === "["));
});

Deno.test("markdown: headings become a nested navigation tree", () => {
  const doc = markdownDocument(`# A\n\ntext\n\n## B\n\nmore\n\n## C\n`);
  assertEquals(doc.flatStructure.map((n) => n.label), ["# A", "## B", "## C"]);
  assertEquals(doc.flatStructure[0].depth, 0);
  assertEquals(doc.flatStructure[1].depth, 1);
  assertEquals(doc.structure.length, 1, "one root heading");
  assertEquals(
    doc.structure[0].children.map((n) => n.label),
    ["## B", "## C"],
    "the level-2 headings nest under the level-1 one",
  );
});

Deno.test("markdown: heading-like lines inside fenced code blocks are not nav nodes", () => {
  // A `#` comment inside a ``` fence and a `###` line inside a ~~~ fence both
  // match the heading regex but are code, not document structure.
  const doc = markdownDocument(
    [
      "# Title",
      "",
      "```sh",
      "# this is a shell comment, not a heading",
      "echo hi",
      "```",
      "",
      "~~~",
      "### still inside a fence",
      "~~~",
      "",
      "## Real Section",
      "",
      "body",
      "",
    ].join("\n"),
  );
  assertEquals(doc.flatStructure.map((n) => n.label), [
    "# Title",
    "## Real Section",
  ]);
});

Deno.test("markdown: languageForFile dispatches on a .md filename", () => {
  const doc = languageForFile("notes.md").parseDocument(
    "# Heading\n\nplain prose\n",
    "notes.md",
  );
  assertEquals(doc.lines[0].spans.map((s) => s.cls), ["sectionHeader"]);
  // The same text as TypeScript would tokenise the prose into identifiers.
  const asTs = languageForFile("notes.ts").parseDocument(
    "# Heading\n\nplain prose\n",
    "notes.ts",
  );
  assert(
    asTs.lines[2].spans.some((s) => s.cls === "identifier"),
    "the .ts path still tokenises prose as code",
  );
});

Deno.test("markdown: editing a line in a markdown diff recolors it as markdown", () => {
  const diff = [
    "diff --git a/r.md b/r.md",
    "--- a/r.md",
    "+++ b/r.md",
    "@@ -1,2 +1,2 @@",
    " # Title",
    " text with `code`",
    "",
  ].join("\n");
  const hl = createDiffHighlighter(diff);
  const out = hl.update(diff.replace("`code`", "`codex`"));
  // The edited markdown line colors its inline code as a string (markdown),
  // not as a TypeScript template that swallows the rest.
  const edited = out[5];
  assert(
    edited.spans.some((s) => s.cls === "string" && s.text === "`codex`"),
    `edited markdown line: ${JSON.stringify(edited.spans)}`,
  );
});

Deno.test("markdown: a diff's nav tree steps through the headings it shows", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "README.md"),
      "# Title\n\nintro\n\n## Section A\n\nbody a\n\n## Section B\n\nbody b\n",
    );
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
    // A hunk that only touches Section A — and shows its heading line.
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -5,3 +5,3 @@
 ## Section A

-body a OLD
+body a
`;
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, ws);
    const headings = doc.flatStructure.filter((n) =>
      n.kind === "section" && n.label.startsWith("#")
    );
    // The shown heading is navigable; the ancestor "# Title", whose heading line
    // is not in the diff, is not surfaced in its place.
    assertEquals(headings.map((n) => n.label), ["## Section A"]);
    // It anchors on the heading line (past the diff marker), not column 0.
    assertEquals(doc.lines[headings[0].startLine].text, " ## Section A");
    assertEquals(headings[0].startCol, 1);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

describe("decoded Markdown diff input", () => {
  it("keeps a BOM outside a heading anchor", () => {
    const bom = "\uFEFF";
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
 ${bom}# Title
-old
+body
`;
    const ws: DiffWorkspace = {
      resolve: () => "/README.md",
      read: () => "# Title\nbody\n",
      hasUtf8Bom: () => true,
    };
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, ws);
    const heading = doc.flatStructure.find((node) => node.label === "# Title");

    expect(heading).toBeDefined();
    expect(heading!.startCol).toBe(2);
    expect(heading!.startOffset).toBe(diff.indexOf("# Title"));
  });

  it("keeps rendered BOM text and spans aligned", () => {
    const bom = "\uFEFF";
    const diff = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -0,0 +1 @@
+${bom}plain text
`;
    const ws: DiffWorkspace = { resolve: () => null, read: () => null };
    const { doc } = buildDiffDocument(
      diff,
      parseDiff(diff)!,
      ws,
      new Map(),
      "rendered",
    );
    const line = doc.lines[4];

    expect(line.text).toBe(`+${bom}plain text`);
    expect(line.spans.map((span) => span.text).join("")).toBe(line.text);
  });

  it("retains heading syntax when restoring a rendered BOM line", () => {
    const bom = "\uFEFF";
    const diff = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -0,0 +1 @@
+${bom}# Heading
`;
    const ws: DiffWorkspace = { resolve: () => null, read: () => null };
    const { doc } = buildDiffDocument(
      diff,
      parseDiff(diff)!,
      ws,
      new Map(),
      "rendered",
    );
    const line = doc.lines[4];

    expect(line.text).toBe(`+${bom}# Heading`);
    expect(line.spans.map((span) => span.text).join("")).toBe(line.text);
    expect(
      line.spans.some((span) =>
        span.cls === "sectionHeader" && span.text === "# Heading"
      ),
    ).toBe(true);
  });
});

Deno.test("markdown: a deeper-then-shallower diff window keeps a navigable depth tree", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "h.md"),
      "# Top\nintro\n\n## Mid\nmidbody\n\n### Deep\ndeepbody\n\n## Mid2\nm2body\n",
    );
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
    // The window begins inside the "### Deep" subsection and spills into the
    // shallower "## Mid2": a deeper heading is shown before a shallower one.
    const diff = `diff --git a/h.md b/h.md
--- a/h.md
+++ b/h.md
@@ -7,5 +7,5 @@
 ### Deep
-deepbody OLD
+deepbody

 ## Mid2
 m2body
`;
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, ws);
    // wasd navigation walks flatStructure by depth and assumes a valid pre-order
    // sequence: the hunk's first child is depth 2, and no step jumps by more
    // than one. A global-minimum depth would have put "### Deep" at depth 3.
    let prev = -1;
    for (const n of doc.flatStructure) {
      assert(
        n.depth <= prev + 1,
        `depth jump at ${n.label}: ${prev} -> ${n.depth}`,
      );
      prev = n.depth;
    }
    const headings = doc.flatStructure.filter((n) =>
      n.kind === "section" && n.label.startsWith("#")
    );
    assertEquals(headings.map((n) => [n.label, n.depth]), [
      ["### Deep", 2],
      ["## Mid2", 2],
    ]);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("markdown: the last shown heading does not swallow trailing removed lines", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "z.md"), "# Heading\nbody\n");
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
    const diff = `diff --git a/z.md b/z.md
--- a/z.md
+++ b/z.md
@@ -1,5 +1,2 @@
 # Heading
 body
-deleted A
-deleted B
-deleted C
`;
    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, ws);
    const heading = doc.flatStructure.find((n) => n.label === "# Heading")!;
    const span = doc.text.slice(heading.startOffset, heading.endOffset);
    assert(
      !span.includes("deleted"),
      `the heading section spilled onto removed lines: ${JSON.stringify(span)}`,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("markdown: a .md file in a diff is highlighted as markdown", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "README.md"),
      "# Title\n\n- item with `code`\n",
    );
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
    const diff = `diff --git a/README.md b/README.md
index 0000000..1111111 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,3 @@
 # Title

-- item with \`old\`
+- item with \`code\`
`;
    const model = parseDiff(diff)!;
    const { doc } = buildDiffDocument(diff, model, ws);
    // The heading line, past its diff marker, is a section header.
    assert(
      doc.lines[5].spans.some((s) => s.cls === "sectionHeader"),
      "the heading is markdown-colored in the diff",
    );
    // The added line keeps its diff marker and colors the inline code green.
    const added = doc.lines[8];
    assertEquals(added.spans[0].cls, "diffAdd", "the + marker");
    assert(
      added.spans.some((s) => s.cls === "string" && s.text === "`code`"),
      "inline code is a string, not a runaway template",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
