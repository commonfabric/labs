/**
 * The JSON, JSONC, and JSON Lines language: a selected file is colored as data
 * with object keys apart from string values, numbers,
 * `true`/`false`/`null`, rainbow brackets, and JSONC comments. Object keys in a
 * single top-level value form the navigation tree. The highlighter is
 * hand-written and lenient: malformed input colors without throwing.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createJsonHighlighter,
  jsonDocument,
  jsonHighlightLines,
} from "../lib/view/languages/json/json.ts";
import {
  decodeLanguageInput,
  languageForFile,
  languageForSource,
} from "../lib/view/languages/language.ts";
import type { Line, TokenClass } from "../lib/view/model.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { createDiffHighlighter } from "../lib/view/diffedit.ts";

/** The verbatim text of a set of lines — coloring must never change it. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
}

/** The classes a token text is assigned, across every line. */
function classesOf(lines: readonly Line[], token: string): Set<TokenClass> {
  const out = new Set<TokenClass>();
  for (const l of lines) {
    for (const s of l.spans) if (s.text === token) out.add(s.cls);
  }
  return out;
}

Deno.test("json: language metadata selects JSON filenames", () => {
  assertEquals(languageForFile("deno.json").id, "json");
  assertEquals(languageForFile("/a/b/tsconfig.jsonc").id, "json");
  assertEquals(languageForFile("records.jsonl").id, "json-lines");
  assertEquals(languageForFile("events.ndjson").id, "json-lines");
  assertEquals(languageForFile("EVENTS.NDJSON").id, "json-lines");
  assertEquals(languageForFile("UPPER.JSON").id, "json");
  assertEquals(languageForFile("config.json.example").id, "json");
  assertEquals(languageForFile("main.ts").id, "typescript");
  assertEquals(languageForFile("README.md").id, "markdown");
  assertEquals(languageForFile(undefined).id, "plain-text");
});

Deno.test("json: language metadata selects JSON-shaped names without a JSON suffix", () => {
  assertEquals(
    languageForFile("packages/shell/public/manifest.webmanifest").id,
    "json",
  );
  assertEquals(languageForFile("packages/memory/memory.tldr").id, "json");
  assertEquals(languageForFile("/repo/deno.lock").id, "json");
  assertEquals(languageForFile("bay.code-workspace").id, "json");
  assertEquals(languageForFile("ios/Package.resolved").id, "json");
  assertEquals(languageForFile("Cargo.lock").id, "toml");
  assertEquals(languageForFile("package.resolved").id, "plain-text");
});

Deno.test("json: a shared .cfg extension needs an opening brace in the source", () => {
  const syzkaller = '{\n\t"name": "gvisor",\n\t"cover": false\n}\n';
  const tlc = "\\* A model.\nSPECIFICATION Spec\nCONSTANT Keys = {k1}\n";
  const ini = "[defaults]\nroles_path = roles\n";

  assertEquals(
    languageForSource("images/syzkaller/default-gvisor-config.cfg", syzkaller)
      .id,
    "json",
  );
  assertEquals(languageForSource("tlaplus/LeaseOps.cfg", tlc).id, "plain-text");
  assertEquals(languageForSource("ansible/ansible.cfg", ini).id, "plain-text");
  assertEquals(languageForSource("model.cfg", "").id, "plain-text");
  // The name alone never selects JSON, because a diff of a `.cfg` file shows
  // no source that could settle which syntax it holds.
  assertEquals(
    languageForFile("images/syzkaller/default-gvisor-config.cfg").id,
    "plain-text",
  );
  assertEquals(
    decodeLanguageInput(
      "images/syzkaller/default-gvisor-config.cfg",
      new TextEncoder().encode(syzkaller),
    ).language.id,
    "json",
  );
});

Deno.test("json: line-oriented files use JSON token classes", () => {
  const src = [
    '{"testId":"old","canonicalId":"new"}',
    '{"testId":"next","canonicalId":"current"}',
  ].join("\n");
  const lines = languageForFile("tasks/test-identity-aliases.jsonl")
    .highlightLines(src);

  assertEquals(classesOf(lines, '"testId"'), new Set(["propertyName"]));
  assertEquals(classesOf(lines, '"old"'), new Set(["string"]));
  assertEquals(classesOf(lines, '"current"'), new Set(["string"]));
  assertEquals(verbatim(lines), src);
});

Deno.test("json: malformed records leave following records highlighted", () => {
  for (
    const malformed of [
      '{"broken":"unterminated',
      '{"broken":/* unterminated',
      '{"broken":[',
    ]
  ) {
    const src = `${malformed}\n{"next":true}`;
    const lines = languageForFile("events.jsonl").highlightLines(
      src,
      "events.jsonl",
    );
    const brackets = lines[1].spans.filter((span) => span.cls === "bracket");

    assertEquals(
      classesOf(lines.slice(1), '"next"'),
      new Set([
        "propertyName",
      ]),
    );
    assertEquals(classesOf(lines.slice(1), "true"), new Set(["boolean"]));
    assertEquals(brackets.map((span) => span.bracketDepth), [0, 0]);
    assertEquals(verbatim(lines), src);
  }
});

Deno.test("json: large line-oriented records highlight without throwing", () => {
  const properties = Array.from(
    { length: 40_000 },
    (_, index) => `"key${index}":${index}`,
  );
  const src = `{${properties.join(",")}}`;
  const lines = languageForFile("large.jsonl").highlightLines(
    src,
    "large.jsonl",
  );

  assertEquals(classesOf(lines, '"key39999"'), new Set(["propertyName"]));
  assertEquals(verbatim(lines), src);
});

Deno.test("json: line-oriented live edits preserve record isolation", () => {
  const before = '{"event":"created","sequence":1}\n';
  const after = [
    '{"event":"created","sequence":1}',
    '{"event":"updated","sequence":2}',
    "",
  ].join("\n");
  const highlighter = languageForFile("events.ndjson").createHighlighter(
    before,
    "events.ndjson",
  );
  const lines = highlighter.update(after);

  assertEquals(classesOf(lines, '"event"'), new Set(["propertyName"]));
  assertEquals(classesOf(lines, '"updated"'), new Set(["string"]));
  assertEquals(classesOf(lines, "2"), new Set(["number"]));
  assertEquals(verbatim(lines), after);

  const malformed = [
    '{"event":"unterminated',
    '{"event":"recovered","sequence":3}',
  ].join("\n");
  const recoveredLines = highlighter.update(malformed);

  assertEquals(
    classesOf(recoveredLines.slice(1), '"event"'),
    new Set(["propertyName"]),
  );
  assertEquals(
    classesOf(recoveredLines.slice(1), '"recovered"'),
    new Set(["string"]),
  );
  assertEquals(classesOf(recoveredLines.slice(1), "3"), new Set(["number"]));
  assertEquals(verbatim(recoveredLines), malformed);
});

Deno.test("json: line-oriented documents expose no partial structure", () => {
  const language = languageForFile("events.jsonl");
  const source = [
    '{"first":1}',
    '{"second":2}',
  ].join("\n");
  const doc = language.parseDocument(source, "events.jsonl");

  assertEquals(doc.structure, []);
  assertEquals(doc.definitions.size, 0);
});

Deno.test("json: one line-oriented record exposes its structure", () => {
  const language = languageForFile("event.jsonl");
  const source = '{"event":"created","sequence":1}\n';
  const doc = language.parseDocument(source, "event.jsonl");

  assertEquals(doc.structure.map((node) => node.label), [
    "event",
    "sequence",
  ]);
  assert(doc.definitions.has("event"));
  assert(doc.definitions.has("sequence"));
});

Deno.test("json: keys, values, and literals get distinct classes", () => {
  const lines = jsonHighlightLines(
    `{ "name": "widget", "count": 42, "on": true, "off": false, "x": null }`,
  );
  // A key is a propertyName; a string VALUE is a string.
  assertEquals([...classesOf(lines, '"name"')], ["propertyName"]);
  assertEquals([...classesOf(lines, '"widget"')], ["string"]);
  assertEquals([...classesOf(lines, "42")], ["number"]);
  assertEquals([...classesOf(lines, "true")], ["boolean"]);
  assertEquals([...classesOf(lines, "false")], ["boolean"]);
  assertEquals([...classesOf(lines, "null")], ["keyword"]);
  // `:` and `,` are punctuation.
  assert(classesOf(lines, ":").has("punctuation"));
  assert(classesOf(lines, ",").has("punctuation"));
});

Deno.test("json: brackets carry a nesting depth for rainbow coloring", () => {
  const lines = jsonHighlightLines(`{ "a": [ 1 ] }`);
  const brackets = lines[0].spans.filter((s) => s.cls === "bracket");
  const byText = new Map(brackets.map((s) => [s.text, s.bracketDepth]));
  // The object braces sit at depth 0, the array brackets nested at depth 1;
  // each pair matches (open and close share a depth).
  assertEquals(byText.get("{"), 0);
  assertEquals(byText.get("}"), 0);
  assertEquals(byText.get("["), 1);
  assertEquals(byText.get("]"), 1);
});

Deno.test("json: JSONC line and block comments are colored, not rejected", () => {
  const src = [
    "{",
    "  // a line comment",
    '  "a": 1, /* trailing block */',
    "  /* a block",
    "     over two lines */",
    '  "b": 2,', // a trailing comma is fine
    "}",
  ].join("\n");
  const lines = jsonHighlightLines(src);
  assertEquals(lines[1].spans.map((s) => s.cls), ["whitespace", "comment"]);
  // The block comment spans two lines; both are colored as comment.
  assert(lines[3].spans.some((s) => s.cls === "comment"));
  assert(lines[4].spans.some((s) => s.cls === "comment"));
  // The trailing comma after `2` is punctuation, and coloring is lossless.
  assert(classesOf(lines, ",").has("punctuation"));
  assertEquals(verbatim(lines), src);
});

Deno.test("json: a bare non-BMP character stays one span", () => {
  // Outside a string a lone astral char is invalid JSON, but reachable mid-edit;
  // it must not split at the UTF-16 surrogate boundary into two glyphs.
  const spans = jsonHighlightLines("😀").flatMap((l) => l.spans);
  assertEquals(spans.length, 1);
  assertEquals(spans[0].text, "😀");
});

Deno.test("json: coloring is byte-for-byte lossless", () => {
  const src = `{
  "emoji": "🎉 é ✓",
  "nums": [1, -2.5, 3e10],
  "nested": { "deep": { "x": true } }
}`;
  assertEquals(verbatim(jsonHighlightLines(src)), src);
});

Deno.test("json: strings with escapes and signed-exponent numbers tokenise", () => {
  // A backslash escapes the next character, so an embedded quote does not end
  // the string; signed exponents scan their sign.
  const src = '{ "path": "a\\"b\\\\c", "big": 1e+9, "small": -2.5e-3 }';
  const lines = jsonHighlightLines(src);
  assertEquals([...classesOf(lines, '"a\\"b\\\\c"')], ["string"]);
  assertEquals([...classesOf(lines, "1e+9")], ["number"]);
  assertEquals([...classesOf(lines, "-2.5e-3")], ["number"]);
  assertEquals(verbatim(lines), src);
});

Deno.test("json: a comment between a key and its colon still marks the key", () => {
  // `nextSignificantIs` skips block and line comments while looking for the `:`
  // that proves a string is an object key.
  const src = '{\n  "a" /* c */: 1,\n  "b" // note\n  : 2\n}';
  const lines = jsonHighlightLines(src);
  assertEquals([...classesOf(lines, '"a"')], ["propertyName"]);
  assertEquals([...classesOf(lines, '"b"')], ["propertyName"]);
  assertEquals(verbatim(lines), src);
});

Deno.test("json: a non-string object key is skipped, not treated as a member", () => {
  // `{ 42: 1 }` is invalid JSON; the structure walk skips the number where a key
  // is expected rather than wedging, so the object contributes no members.
  const doc = jsonDocument('{ 42: 1, "ok": 2 }');
  assertEquals(doc.structure.map((n) => n.label), ["ok"]);
});

Deno.test("json: pathologically deep nesting degrades to no structure", () => {
  // Deep enough to overflow the structure walk's recursion; `jsonDocument`
  // catches it and returns coloring with an empty tree rather than throwing.
  const deep = "[".repeat(100000);
  const doc = jsonDocument(deep);
  assertEquals(doc.structure, []);
  assertEquals(doc.lines.length, 1);
});

Deno.test("json: object keys form the navigation tree", () => {
  const src = `{
  "name": "widget",
  "tags": ["a", "b"],
  "nested": { "x": 1, "y": [{ "z": 2 }] }
}`;
  const doc = jsonDocument(src);
  // Top-level: scalar members are `variable`, container members are `object`.
  assertEquals(
    doc.structure.map((n) => `${n.label}:${n.kind}`),
    ["name:variable", "tags:object", "nested:object"],
  );
  const nested = doc.structure.find((n) => n.label === "nested")!;
  assertEquals(nested.children.map((n) => n.label), ["x", "y"]);
  // An array's container elements are navigable as `[i]`; its scalars are not.
  const tags = doc.structure.find((n) => n.label === "tags")!;
  assertEquals(tags.children, []);
  const y = nested.children.find((n) => n.label === "y")!;
  assertEquals(y.children.map((n) => `${n.label}:${n.kind}`), ["[0]:object"]);
  assertEquals(y.children[0].children.map((n) => n.label), ["z"]);
  // Keys are indexed as definitions (for `t` peeks).
  assert(doc.definitions.has("name"));
  assert(doc.definitions.has("z"));
});

Deno.test("json: a heading node's range points at its key", () => {
  const src = `{\n  "name": "widget"\n}`;
  const doc = jsonDocument(src);
  const name = doc.structure[0];
  assertEquals(name.startLine, 1);
  // The name offset addresses the key token, so a peek lands on the key.
  assertEquals(src.slice(name.nameOffset!, name.nameOffset! + 6), '"name"');
});

Deno.test("json: the incremental highlighter matches a whole re-highlight", () => {
  const before = `{ "a": 1, "b": 2 }`;
  const after = `{ "a": 10, "b": 2, "c": [true] }`;
  const hl = createJsonHighlighter(before);
  assertEquals(
    hl.lines.map((l) => l.spans.map((s) => s.cls)),
    jsonHighlightLines(before).map((l) => l.spans.map((s) => s.cls)),
  );
  const updated = hl.update(after);
  assertEquals(
    updated.map((l) => l.spans.map((s) => `${s.cls}:${s.text}`)),
    jsonHighlightLines(after).map((l) =>
      l.spans.map((s) => `${s.cls}:${s.text}`)
    ),
  );
});

Deno.test("json: malformed input colors without throwing", () => {
  for (
    const bad of [
      '{ "unterminated: 1',
      "{ /* unterminated block comment",
      "}{][:,@#$%",
      '{ "a": ',
      "",
      "   ",
    ]
  ) {
    const doc = jsonDocument(bad);
    // Never throws, always covers the text verbatim, structure is at worst empty.
    assertEquals(verbatim(doc.lines), bad);
    assert(Array.isArray(doc.structure));
  }
});

Deno.test("json: a .json file in a diff is colored and navigated as JSON", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = `{\n  "name": "widget",\n  "count": 2\n}\n`;
    Deno.writeTextFileSync(join(root, "config.json"), file);
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
    const diff = `diff --git a/config.json b/config.json
--- a/config.json
+++ b/config.json
@@ -1,4 +1,4 @@
 {
-  "name": "widget",
+  "name": "gadget",
   "count": 2
 }
`;
    const model = parseDiff(diff)!;
    const { doc } = buildDiffDocument(diff, model, ws);
    // The context line for the key is colored as JSON: the key is a
    // propertyName, proving the JSON language (not TypeScript) ran.
    const keyLine = doc.lines.find((l) =>
      l.spans.some((s) => s.text === '"count"')
    )!;
    assert(
      keyLine.spans.some((s) =>
        s.text === '"count"' && s.cls === "propertyName"
      ),
    );
    // The removed line uses the old side's JSON language too.
    const removed = doc.lines.find((l) => l.text.startsWith('-  "name"'))!;
    assert(
      removed.spans.some((s) =>
        s.text === '"name"' && s.cls === "propertyName"
      ),
    );
    // The hunk's structure exposes the file's keys, projected into the diff.
    const labels: string[] = [];
    const walk = (ns: typeof doc.structure) => {
      for (const n of ns) {
        labels.push(n.label);
        walk(n.children);
      }
    };
    walk(doc.structure);
    assert(labels.includes("name"), `structure labels: ${labels.join(", ")}`);
    assert(labels.includes("count"));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("json: a .jsonl file in a diff uses JSON token classes", () => {
  const diff = [
    "diff --git a/events.jsonl b/events.jsonl",
    "--- a/events.jsonl",
    "+++ b/events.jsonl",
    "@@ -1 +1 @@",
    '-{"event":"created","sequence":1}',
    '+{"event":"updated","sequence":2}',
    "",
  ].join("\n");
  const model = parseDiff(diff)!;
  const workspace: DiffWorkspace = {
    resolve: () => null,
    read: () => null,
  };
  const { doc } = buildDiffDocument(diff, model, workspace);
  const removed = doc.lines.find((line) => line.bg === "del")!;
  const added = doc.lines.find((line) => line.bg === "add")!;

  assert(
    removed.spans.some((span) =>
      span.text === '"event"' && span.cls === "propertyName"
    ),
  );
  assert(
    added.spans.some((span) =>
      span.text === '"updated"' && span.cls === "string"
    ),
  );
  assertEquals(verbatim(doc.lines), diff);
});

Deno.test("json: editing a line in a json diff recolors it as json", () => {
  const diff = [
    "diff --git a/c.json b/c.json",
    "--- a/c.json",
    "+++ b/c.json",
    "@@ -1,3 +1,3 @@",
    " {",
    '   "n": 1',
    " }",
    "",
  ].join("\n");
  const hl = createDiffHighlighter(diff);
  const out = hl.update(diff.replace('"n": 1', '"n": 42'));
  const edited = out.find((l) => l.text.includes('"n"'))!;
  // The key stays a propertyName and the value is a number — the JSON line
  // renderer ran, not the TypeScript one.
  assert(
    edited.spans.some((s) => s.text === '"n"' && s.cls === "propertyName"),
  );
  assert(edited.spans.some((s) => s.text === "42" && s.cls === "number"));
});
