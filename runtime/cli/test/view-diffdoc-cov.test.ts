import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import type { DiffLine, DiffModel } from "../lib/view/diff.ts";
import { parseDiff } from "../lib/view/diff.ts";
import {
  _internal,
  buildDiffDocument,
  type DiffWorkspace,
  realWorkspace,
  type WorkspaceCache,
} from "../lib/view/diffdoc.ts";

/** A workspace stub over a prepared root directory. */
function stubWs(root: string): DiffWorkspace {
  return {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
}

const NO_WS: DiffWorkspace = { resolve: () => null, read: () => null };

//
// realWorkspace: read() error branch
//

Deno.test("realWorkspace: read of a bounded directory returns null (catch branch)", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    Deno.mkdirSync(join(root, "adir"));
    const ws = realWorkspace(root);
    // The path is inside the repo (bounded), but reading a directory throws
    // EISDIR, so read() takes the catch branch and returns null.
    assertEquals(
      ws.read(join(root, "adir")),
      null,
      "directory read returns null",
    );
    // A bounded but absent path: readTextFileSync throws ENOENT -> null.
    assertEquals(ws.read(join(root, "missing.ts")), null, "absent read null");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

describe("decoded workspace input", () => {
  it("keeps binary files out of editable source text", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const namedBinary = join(root, "asset.png");
      Deno.writeTextFileSync(namedBinary, "printable bytes without a NUL\n");
      const invalidBinary = join(root, "unknown.data");
      Deno.writeFileSync(invalidBinary, new Uint8Array([0x61, 0xff, 0x62]));
      const nulBinary = join(root, "nul.data");
      Deno.writeFileSync(nulBinary, new Uint8Array([0x61, 0x00, 0x62]));

      const ws = realWorkspace(root);
      expect(ws.read(namedBinary)).toBe(null);
      expect(ws.read(invalidBinary)).toBe(null);
      expect(ws.read(nulBinary)).toBe(null);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("retains the observed encoding when writing text", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.json");
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode('{"value": 1}\n'),
        ]),
      );

      const ws = realWorkspace(root);
      expect(ws.read(path)).toBe('{"value": 1}\n');
      ws.write!(path, '{"value": 2}\n');
      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode('{"value": 2}\n'),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("preserves a UTF-8 BOM during an uncached write", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const path = join(root, "value.json");
      Deno.writeFileSync(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode('{"value": 1}\n'),
        ]),
      );

      realWorkspace(root).write!(path, '{"value": 2}\n');

      expect(Deno.readFileSync(path)).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode('{"value": 2}\n'),
        ]),
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("rejects writes outside the workspace", () => {
    const outer = Deno.makeTempDirSync();
    const root = join(outer, "repo");
    const outside = join(outer, "outside.ts");
    try {
      Deno.mkdirSync(root);
      Deno.mkdirSync(join(root, ".git"));
      Deno.writeTextFileSync(outside, "sentinel\n");
      expect(() => realWorkspace(root).write!(outside, "replacement\n"))
        .toThrow(
          "Cannot write outside the workspace",
        );
      expect(Deno.readTextFileSync(outside)).toBe("sentinel\n");
    } finally {
      Deno.removeSync(outer, { recursive: true });
    }
  });

  it("rejects writes to named and detected binary files", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.mkdirSync(join(root, ".git"));
      const named = join(root, "asset.png");
      Deno.writeTextFileSync(named, "printable bytes\n");
      const detected = join(root, "asset.data");
      Deno.writeFileSync(detected, new Uint8Array([0x41, 0x00, 0x42]));
      const ws = realWorkspace(root);

      expect(() => ws.write!(named, "replacement")).toThrow(
        "Binary data is shown as a hex dump",
      );
      expect(() => ws.write!(detected, "replacement")).toThrow(
        "Binary data is shown as a hex dump",
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });

  it("skips Git batch objects that are not blobs", () => {
    const object = "a".repeat(40);
    const output = new TextEncoder().encode(`${object} tree 3\nabc\n`);

    expect(_internal.parseGitBatchOutput([object], output)).toEqual(new Map());
  });
});

Deno.test("realWorkspace: resolve of a bounded directory falls through to null", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    Deno.mkdirSync(join(root, "adir"));
    const ws = realWorkspace(root);
    // A directory is bounded, but statSync(...).isFile is false, so resolve
    // returns null rather than the directory path.
    assertEquals(
      ws.resolve("adir"),
      null,
      "a directory is not a resolvable file",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// findRepoRoot: no .git ancestor walks to the filesystem root
//

Deno.test("realWorkspace: a cwd with no .git ancestor leaves only the cwd base", () => {
  // A temp dir with no `.git` anywhere up to `/` exercises the walk that ends
  // with `parent === dir` returning null, so the only base is the cwd itself.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "in.ts"), "export const a = 1;\n");
    const ws = realWorkspace(root);
    // No repo root found: the cwd is the sole base and still resolves files.
    assert(ws.resolve("in.ts")?.endsWith("in.ts"), "cwd base still resolves");
    // A traversal that climbs above the cwd is blocked (no repo-root base
    // widened the bound).
    assertEquals(ws.resolve("../../../etc/hosts"), null, "escape above cwd");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// loadFile: cache hit short-circuits
//

Deno.test("buildDiffDocument: a shared cache is reused across builds (cache hit)", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      "export const a = 1;\nexport const b = a;\n",
    );
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,2 @@
 export const a = 1;
+export const b = a;
`;
    const model = parseDiff(diff)!;
    const cache: WorkspaceCache = new Map();
    const ws = stubWs(root);
    // First build populates the cache for the resolved abs path.
    const first = buildDiffDocument(diff, model, ws, cache);
    assert(first.maps.rootFiles.size === 1, "first build resolved the file");
    const [absPath] = first.maps.rootFiles.keys();
    assert(cache.has(absPath), "cache populated after the first build");
    // Make read() throw if called again; the cache hit must avoid re-reading.
    const throwingWs: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: () => {
        throw new Error("read must not be called on a cache hit");
      },
    };
    const second = buildDiffDocument(diff, model, throwingWs, cache);
    // The second build reused the cached parse and still maps the file.
    assertEquals(
      [...second.maps.rootFiles.keys()],
      [absPath],
      "cache hit kept the mapping",
    );
    assert(
      second.maps.toFile(diff.indexOf("b = a")) !== null,
      "cached file still drives the maps",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// file header lines: an empty meta header line is skipped
//

Deno.test("buildDiffDocument: an empty header line is left untouched", () => {
  // A blank line sits among the file's header lines (between `index` and `---`).
  // It is classified `other` (not meta), so the header loop's meta filter skips
  // it; either way an empty line gets no spans.
  const diff = `diff --git a/m.ts b/m.ts
index 1111111..2222222 100644

--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`;
  const model = parseDiff(diff)!;
  const { doc } = buildDiffDocument(diff, model, NO_WS);
  // Verbatim still reconstructs the whole diff.
  assertEquals(
    doc.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n"),
    diff,
  );
  const blankIdx = diff.split("\n").indexOf("");
  assertEquals(
    doc.lines[blankIdx].spans,
    [],
    "the empty header line has no spans",
  );
});

//
// hunk body: meta line inside the hunk gets diffMeta spans
//

Deno.test("buildDiffDocument: a `\\ No newline` line in the hunk body is diffMeta", () => {
  // The `\ No newline at end of file` marker lands inside the hunk body range,
  // classified `meta`; with text it gets a diffMeta span.
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-old line
\\ No newline at end of file
+new line
\\ No newline at end of file
`;
  const model = parseDiff(diff)!;
  const { doc } = buildDiffDocument(diff, model, NO_WS);
  const lines = diff.split("\n");
  const noNl = lines.findIndex((l) => l.startsWith("\\"));
  assertEquals(doc.lines[noNl].spans.length, 1, "meta line spanned");
  assertEquals(
    doc.lines[noNl].spans[0].cls,
    "diffMeta",
    "meta line is diffMeta",
  );
  assertEquals(
    doc.lines[noNl].spans[0].text,
    lines[noNl],
    "verbatim meta text",
  );
});

//
// hunk body: an empty trailing line is left without spans
//

Deno.test("buildDiffDocument: a trailing empty line outside the hunk gets no spans", () => {
  // The text ends with a newline, so the split yields a final empty entry. It
  // is not part of any hunk; the body loop never assigns it spans.
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-x
+y
`;
  const model = parseDiff(diff)!;
  const { doc } = buildDiffDocument(diff, model, NO_WS);
  assertEquals(
    doc.lines[doc.lines.length - 1].spans,
    [],
    "final empty line bare",
  );
});

//
// Markdown hunk with a workspace file: shown headings drive the tree
//

Deno.test("buildDiffDocument: a Markdown hunk shows its heading as a section", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "doc.md"),
      "# Title\n\nIntro paragraph.\n\n## Section\n\nBody text here.\n",
    );
    const diff = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,7 +1,8 @@
 # Title

 Intro paragraph.

 ## Section

 Body text here.
+More body text.
`;
    const model = parseDiff(diff)!;
    const { doc } = buildDiffDocument(diff, model, stubWs(root));
    const sections = doc.flatStructure.filter((n) => n.kind === "section");
    const labels = sections.map((n) => n.label);
    assert(
      labels.some((l) => l.includes("# Title")),
      `Title heading: ${labels}`,
    );
    assert(
      labels.some((l) => l.includes("## Section")),
      `Section heading: ${labels}`,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// Markdown hunk where no heading line is shown -> empty heading tree
//

Deno.test("buildDiffDocument: a Markdown hunk showing only body has no sections", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(
      join(root, "doc.md"),
      "# Title\n\nfirst body line\nsecond body line\n",
    );
    // The hunk shows only the two body lines, never the `# Title` heading line,
    // so markdownHeadingNodes finds nothing shown and returns no sections.
    const diff = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -3,2 +3,3 @@
 first body line
 second body line
+third body line
`;
    const model = parseDiff(diff)!;
    const { doc } = buildDiffDocument(diff, model, stubWs(root));
    const file = doc.flatStructure.find((n) => n.label.startsWith("▸"))!;
    const hunk = doc.flatStructure.find((n) => n.kind === "hunk")!;
    // The file section and hunk exist, but the hunk owns no heading sections.
    assert(file, "file section present");
    assertEquals(
      doc.flatStructure.filter((n) => n.kind === "section").length,
      1,
      "only the file section; the hunk contributes no heading sections",
    );
    assertEquals(
      hunk.children.length,
      0,
      "no markdown sections under the hunk",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// Markdown hunk with NO workspace file: fragment heading tree
//

Deno.test("buildDiffDocument: a Markdown hunk with no workspace file builds heading sections from the fragment", () => {
  // No workspace file: ctx.fileDoc is null, so the heading tree comes from the
  // fragment parse of the new side, via the markdown fragment branch.
  const diff = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,3 +1,4 @@
 # Heading One

 prose line
+## Heading Two
`;
  const model = parseDiff(diff)!;
  const { doc } = buildDiffDocument(diff, model, NO_WS);
  const hunk = doc.flatStructure.find((n) => n.kind === "hunk")!;
  assert(hunk.label.includes("(no workspace file)"), `label: ${hunk.label}`);
  const sections = doc.flatStructure.filter((n) => n.kind === "section");
  const labels = sections.map((n) => n.label);
  assert(
    labels.some((l) => l.includes("# Heading One")),
    `fragment heading one: ${labels}`,
  );
  assert(
    labels.some((l) => l.includes("## Heading Two")),
    `fragment heading two: ${labels}`,
  );
});

//
// fileLineText: a hunk claiming a new-side line past EOF stays unverified -
//

Deno.test("buildDiffDocument: a hunk naming new-side lines past the workspace EOF cannot verify", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    // The workspace file has exactly two lines and no trailing newline, so its
    // line-starts array has length 2 (indices 0 and 1 only).
    Deno.writeTextFileSync(join(root, "m.ts"), "const a = 1;\nconst b = 2;");
    // The diff's context lines 0 and 1 match, so verification keeps going to the
    // added new-side line 2 — which is past the file's last line-start, so
    // fileLineText returns null there and the hunk fails verification.
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,3 @@
 const a = 1;
 const b = 2;
+const c = 3;
`;
    const model = parseDiff(diff)!;
    const { doc, maps } = buildDiffDocument(diff, model, stubWs(root));
    // Even the matching context line unmaps because the hunk failed.
    assertEquals(maps.toFile(diff.indexOf("a = 1;")), null, "hunk unverified");
    const hunk = doc.flatStructure.find((n) => n.kind === "hunk")!;
    assert(
      hunk.label.includes("(workspace differs)"),
      `label reports drift: ${hunk.label}`,
    );
    // Structure still comes from the fragment parse.
    assert(
      doc.flatStructure.some((n) => n.name === "a" || n.name === "b"),
      "fragment structure keeps the hunk navigable",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// buildMaps.fromFile: a file offset on a hidden line maps to nothing
//

Deno.test("buildDiffDocument: fromFile returns null for a file line the diff hides", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    // The workspace file has three lines; the diff only shows the first two.
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      "const a = 1;\nconst b = 2;\nconst hidden = 3;\n",
    );
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`;
    const model = parseDiff(diff)!;
    const { maps } = buildDiffDocument(diff, model, stubWs(root));
    const abs = join(root, "m.ts");
    // A visible line maps.
    assert(maps.fromFile(abs, 0) !== null, "the first visible line maps");
    // The third workspace line ("const hidden = 3;") is not shown in the diff,
    // so its new-side line number is absent from newToDiff -> fromFile null.
    const fileText = "const a = 1;\nconst b = 2;\nconst hidden = 3;\n";
    const hiddenOffset = fileText.indexOf("const hidden");
    assertEquals(
      maps.fromFile(abs, hiddenOffset),
      null,
      "a hidden file line maps to no diff line",
    );
    // An unknown path also returns null.
    assertEquals(maps.fromFile("/nope.ts", 0), null, "unknown path is null");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// lineEndOffset: a file section whose last line is the final text line
//

Deno.test("buildDiffDocument: the file section end offset reaches the end of the text", () => {
  // The diff has no trailing newline, so the file's endLine IS the last line of
  // the whole text; lineEndOffset returns text.length for that section.
  const diff =
    `diff --git a/m.ts b/m.ts\n--- a/m.ts\n+++ b/m.ts\n@@ -1,1 +1,1 @@\n-old\n+new`;
  const model = parseDiff(diff)!;
  const { doc } = buildDiffDocument(diff, model, NO_WS);
  const section = doc.flatStructure.find((n) => n.label.startsWith("▸"))!;
  assertEquals(
    section.endOffset,
    diff.length,
    "the final file section ends at the end of the diff text",
  );
});

//
// findRepoRoot: the 64-deep walk cap
//

Deno.test("realWorkspace: a path nested past the walk depth cap finds no repo root", () => {
  // findRepoRoot walks up at most 64 ancestors. A path nested deeper than that,
  // with no `.git` anywhere, exhausts the cap and returns null (so only the cwd
  // is a base). The temp root is the `.git`-free top.
  const root = Deno.makeTempDirSync();
  try {
    const parts: string[] = [];
    for (let i = 0; i < 70; i++) parts.push("d");
    const deep = join(root, ...parts);
    Deno.mkdirSync(deep, { recursive: true });
    Deno.writeTextFileSync(join(deep, "in.ts"), "export const a = 1;\n");
    const ws = realWorkspace(deep);
    // Cap exhausted with no repo root: the cwd remains a working base.
    assert(ws.resolve("in.ts")?.endsWith("in.ts"), "cwd base resolves files");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// crafted DiffModel: synthetic/defensive body and header branches
//

/**
 * Build a one-file, one-hunk {@link DiffModel} from a caller-supplied per-line
 * classification. The model interface is public, so a malformed or synthetic
 * model (a tool emitting one, or a future producer) must not crash the builder;
 * these exercise the defensive body/header branches.
 */
function craftedModel(
  lines: DiffLine[],
  headerLine: number,
  hunkHeaderLine: number,
  endLine: number,
): DiffModel {
  return {
    lines,
    files: [{
      oldPath: "m.ts",
      newPath: "m.ts",
      headerLine,
      endLine,
      hunks: [{
        headerLine: hunkHeaderLine,
        endLine,
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        context: "",
      }],
    }],
  };
}

Deno.test("buildDiffDocument: an empty meta header line is skipped", () => {
  // A model that classifies an EMPTY header line as `meta`. The header loop sees
  // kind === "meta" but t.length === 0, so it skips the line without spanning.
  const text =
    "diff --git a/m.ts b/m.ts\n\n--- a/m.ts\n@@ -1,1 +1,1 @@\n const a = 1;\n";
  const lines: DiffLine[] = [
    { kind: "meta" }, // 0: diff --git
    { kind: "meta" }, // 1: the EMPTY meta header line
    { kind: "meta" }, // 2: ---
    { kind: "hunk" }, // 3: @@
    { kind: "ctx", newLine: 0, oldLine: 0 }, // 4
    { kind: "other" }, // 5: trailing empty
  ];
  const model = craftedModel(lines, 0, 3, 4);
  const { doc } = buildDiffDocument(text, model, NO_WS);
  // The empty meta header line is left without spans (skipped by length === 0).
  assertEquals(doc.lines[1].spans, [], "empty meta header line not spanned");
  // A non-empty meta header line still gets a diffMeta span.
  assertEquals(
    doc.lines[2].spans[0].cls,
    "diffMeta",
    "non-empty header spanned",
  );
});

Deno.test("buildDiffDocument: a missing model entry inside the hunk body is skipped", () => {
  // A model whose `lines` array is shorter than the hunk's body range leaves an
  // in-range body line with an undefined entry; the builder skips it.
  const text =
    "diff --git a/m.ts b/m.ts\n--- a/m.ts\n@@ -1,1 +1,1 @@\n const a = 1;\n MISSING\n";
  const lines: DiffLine[] = [
    { kind: "meta" }, // 0
    { kind: "meta" }, // 1
    { kind: "hunk" }, // 2
    { kind: "ctx", newLine: 0, oldLine: 0 }, // 3
    // index 4 ("MISSING") deliberately absent -> model.lines[4] is undefined.
  ];
  const model = craftedModel(lines, 0, 2, 4);
  const { doc } = buildDiffDocument(text, model, NO_WS);
  // The hunk loop skips the entry-less body line (no diff coloring); it keeps
  // only the default plain span the top-level "other" pass assigned.
  assertEquals(
    doc.lines[4].spans.map((s) => s.cls),
    ["plain"],
    "the entry-less body line keeps only the default plain span",
  );
});

Deno.test("buildDiffDocument: a non-content body kind is skipped", () => {
  // A model that classifies an in-body line as `other` (not meta/ctx/add/del).
  // The body loop's content-kind guard skips it.
  const text =
    "diff --git a/m.ts b/m.ts\n--- a/m.ts\n@@ -1,1 +1,1 @@\n const a = 1;\nstray noise\n";
  const lines: DiffLine[] = [
    { kind: "meta" }, // 0
    { kind: "meta" }, // 1
    { kind: "hunk" }, // 2
    { kind: "ctx", newLine: 0, oldLine: 0 }, // 3
    { kind: "other" }, // 4: a non-content kind inside the body range
  ];
  const model = craftedModel(lines, 0, 2, 4);
  const { doc } = buildDiffDocument(text, model, NO_WS);
  // The non-content body line gets no diff spans from the hunk loop. (It does
  // get the default plain span from the top-level "other" pass.)
  assertEquals(
    doc.lines[4].spans.map((s) => s.cls),
    ["plain"],
    "a non-content body kind keeps only the default plain span",
  );
});
