/**
 * The YAML language used by `cf view`. Tests cover direct files, diffs, live
 * edits, common scalar forms, flow collections, and state that crosses lines.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createYamlHighlighter,
  yamlDocument,
  yamlHighlightLines,
} from "../lib/view/languages/yaml/yaml.ts";
import { languageForFile } from "../lib/view/languages/language.ts";
import type { Line, TokenClass } from "../lib/view/model.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { createDiffHighlighter, diffSource } from "../lib/view/diffedit.ts";

function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

function classesOf(lines: readonly Line[], token: string): Set<TokenClass> {
  const classes = new Set<TokenClass>();
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text === token) classes.add(span.cls);
    }
  }
  return classes;
}

Deno.test("yaml: path matching recognizes yml and yaml", () => {
  assertEquals(languageForFile("config.yaml").id, "yaml");
  assertEquals(
    languageForFile("/repo/.github/workflows/check.yml").id,
    "yaml",
  );
  assertEquals(languageForFile("UPPER.YAML").id, "yaml");
  assertEquals(languageForFile("config.json").id, "json");
  assertEquals(languageForFile("yaml.ts").id, "typescript");
  assertEquals(languageForFile(undefined).id, "plain-text");
});

Deno.test("yaml: keys and scalar types receive distinct classes", () => {
  const lines = yamlHighlightLines([
    "name: widget",
    "count: 42",
    "ratio: -2.5e-3",
    "enabled: true",
    "disabled: FALSE",
    "missing: null",
    "empty: ~",
  ].join("\n"));

  for (
    const key of [
      "name",
      "count",
      "ratio",
      "enabled",
      "disabled",
      "missing",
      "empty",
    ]
  ) {
    assertEquals([...classesOf(lines, key)], ["propertyName"]);
  }
  assertEquals([...classesOf(lines, "widget")], ["string"]);
  assertEquals([...classesOf(lines, "42")], ["number"]);
  assertEquals([...classesOf(lines, "-2.5e-3")], ["number"]);
  assertEquals([...classesOf(lines, "true")], ["boolean"]);
  assertEquals([...classesOf(lines, "FALSE")], ["boolean"]);
  assertEquals([...classesOf(lines, "null")], ["keyword"]);
  assertEquals([...classesOf(lines, "~")], ["keyword"]);
  assert(classesOf(lines, ":").has("punctuation"));
});

Deno.test("yaml: core scalar resolution uses exact YAML 1.2 spellings", () => {
  const typed: [string, TokenClass][] = [
    ["True", "boolean"],
    ["FALSE", "boolean"],
    ["Null", "keyword"],
    ["NULL", "keyword"],
    ["~", "keyword"],
    ["01", "number"],
    ["+01", "number"],
    ["01.2", "number"],
    [".5", "number"],
    ["12e3", "number"],
    ["0o17", "number"],
    ["0x2A", "number"],
    ["-.Inf", "number"],
    [".NaN", "number"],
  ];
  const strings = [
    "TrUe",
    "NuLl",
    "0b101",
    "1_000",
    "-.nan",
    ".iNf",
    "0XFF",
    "0x_1",
    "1_",
    "1__2",
    "+0xFF",
    "+0o7",
  ];
  const lines = yamlHighlightLines([
    ...typed.map(([value], index) => `typed_${index}: ${value}`),
    ...strings.map((value, index) => `string_${index}: ${value}`),
  ].join("\n"));

  for (const [value, cls] of typed) {
    assertEquals([...classesOf(lines, value)], [cls], value);
  }
  for (const value of strings) {
    assertEquals([...classesOf(lines, value)], ["string"], value);
  }
});

Deno.test("yaml: quoted keys and values keep escapes and doubled quotes", () => {
  const source = [
    `"quoted key": "a \\"value\\" # still a value"`,
    "'single key': 'it''s # data'",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf(lines, '"quoted key"')], ["propertyName"]);
  assertEquals(
    [...classesOf(lines, '"a \\"value\\" # still a value"')],
    ["string"],
  );
  assertEquals([...classesOf(lines, "'single key'")], ["propertyName"]);
  assertEquals([...classesOf(lines, "'it''s # data'")], ["string"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: explicit multiline quoted keys retain key styling", () => {
  // YAML restricts implicit keys to one line, so multiline keys use `?`.
  for (
    const [source, fragments] of [
      [
        [
          '? "multi',
          "",
          '  line"',
          ": value",
        ].join("\n"),
        ['"multi', '  line"'],
      ],
      [
        [
          "mapping: { ? 'multi",
          "  line' : value }",
        ].join("\n"),
        ["'multi", "  line'"],
      ],
    ] as const
  ) {
    const lines = yamlHighlightLines(source);
    for (const fragment of fragments) {
      assertEquals([...classesOf(lines, fragment)], ["propertyName"], source);
    }
    assertEquals([...classesOf(lines, "value")], ["string"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: comments require separation and do not consume URLs", () => {
  const source = [
    "url: https://example.test/a#fragment",
    "label: value # trailing comment",
    "# whole-line comment",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals(
    [...classesOf(lines, "https://example.test/a#fragment")],
    ["string"],
  );
  assertEquals([...classesOf(lines, "# trailing comment")], ["comment"]);
  assertEquals([...classesOf(lines, "# whole-line comment")], ["comment"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: flow collections use punctuation and rainbow brackets", () => {
  const lines = yamlHighlightLines(
    `root: {items: [1, 0x2a, 0o17, 0b101], ready: false}`,
  );
  const brackets = lines[0].spans.filter((span) => span.cls === "bracket");
  assertEquals(
    brackets.map((span) => [span.text, span.bracketDepth]),
    [["{", 0], ["[", 1], ["]", 1], ["}", 0]],
  );
  assertEquals([...classesOf(lines, "items")], ["propertyName"]);
  assertEquals([...classesOf(lines, "ready")], ["propertyName"]);
  assertEquals([...classesOf(lines, "0x2a")], ["number"]);
  assertEquals([...classesOf(lines, "0o17")], ["number"]);
  assertEquals([...classesOf(lines, "0b101")], ["string"]);
  assertEquals([...classesOf(lines, "false")], ["boolean"]);
  assert(classesOf(lines, ",").has("punctuation"));
});

Deno.test("yaml: flow delimiters only terminate plain scalars inside flow", () => {
  const block = yamlHighlightLines("foo:[bar]");
  assertEquals([...classesOf(block, "foo:[bar]")], ["string"]);
  assert(!block[0].spans.some((span) => span.cls === "propertyName"));
  assert(!block[0].spans.some((span) => span.cls === "bracket"));

  const flow = yamlHighlightLines("{foo:[bar]}");
  assertEquals([...classesOf(flow, "foo")], ["propertyName"]);
  assertEquals([...classesOf(flow, "bar")], ["string"]);
  assertEquals(
    flow[0].spans.filter((span) => span.cls === "bracket").map((span) =>
      span.text
    ),
    ["{", "[", "]", "}"],
  );

  const adjacent = yamlHighlightLines(
    "{[a, b]:value, {a: b}:other}",
  );
  assertEquals([...classesOf(adjacent, "value")], ["string"]);
  assertEquals([...classesOf(adjacent, "other")], ["string"]);
  assert(!adjacent[0].spans.some((span) => span.text === ":value"));
  assert(!adjacent[0].spans.some((span) => span.text === ":other"));
});

Deno.test("yaml: sequence markers, tags, anchors, and aliases are highlighted", () => {
  const source = [
    "---",
    "defaults: &defaults",
    "  image: !!str app:latest",
    "services:",
    "  - <<: *defaults",
    "    custom: !include config.yml",
    "tagged_value: !foo: value",
    "source: &key name",
    "*key : value",
    "colon_anchor: &foo: value",
    "colon_alias: *foo:",
    "...",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf(lines, "---")], ["sectionHeader"]);
  assertEquals([...classesOf(lines, "...")], ["sectionHeader"]);
  assertEquals([...classesOf(lines, "&defaults")], ["keyword"]);
  assertEquals([...classesOf(lines, "&key")], ["keyword"]);
  assertEquals([...classesOf(lines, "*key")], ["keyword"]);
  assertEquals([...classesOf(lines, "&foo:")], ["keyword"]);
  assertEquals([...classesOf(lines, "*foo:")], ["keyword"]);
  assertEquals([...classesOf(lines, "*defaults")], ["keyword"]);
  assertEquals([...classesOf(lines, "!!str")], ["keyword"]);
  assertEquals([...classesOf(lines, "!include")], ["keyword"]);
  assertEquals([...classesOf(lines, "!foo:")], ["keyword"]);
  assert(
    !lines.some((line) => line.spans.some((span) => span.text === "!foo")),
  );
  assertEquals([...classesOf(lines, "<<")], ["propertyName"]);
  const aliasKey = lines.find((line) => line.text === "*key : value")!;
  assert(
    aliasKey.spans.some((span) =>
      span.text === ":" && span.cls === "punctuation"
    ),
  );
  assert(!aliasKey.spans.some((span) => span.text === "*key:"));
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: an alias can be an explicit mapping key", () => {
  const source = "? *alias\n: value";
  const lines = yamlHighlightLines(source);

  assertEquals([...classesOf(lines, "*alias")], ["keyword"]);
  assertEquals([...classesOf(lines, "value")], ["string"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: verbatim tags and property-only lines remain lossless", () => {
  const source = [
    "tagged: !<tag:example.org,2026:widget> value",
    "unfinished: !<tag:example.org,2026:widget",
    "first:",
    "  !foo &anchor  ",
    "  value",
    "second:",
    "  !bar &other # properties",
    "  value",
  ].join("\n");
  const lines = yamlHighlightLines(source);

  assertEquals(
    [...classesOf(lines, "!<tag:example.org,2026:widget>")],
    ["keyword"],
  );
  assertEquals(
    [...classesOf(lines, "!<tag:example.org,2026:widget")],
    ["keyword"],
  );
  assertEquals([...classesOf(lines, "# properties")], ["comment"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: adjacent flow mapping values follow complete key tokens", () => {
  const source = [
    '[foo":bar]',
    '{"foo" :bar}',
    "{[a,b] :value}",
    "[? !foo, true, false]",
    "[[? !foo]: true]",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf(lines, 'foo":bar')], ["string"]);
  assertEquals([...classesOf(lines, '"foo"')], ["propertyName"]);
  assertEquals([...classesOf(lines, "bar")], ["string"]);
  assertEquals([...classesOf(lines, "value")], ["string"]);
  assertEquals([...classesOf(lines, "true")], ["boolean"]);
  assertEquals([...classesOf(lines, "false")], ["boolean"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: flow collection block keys retain their mapping indent", () => {
  for (
    const source of [
      "[a, b]:\n  |2\n  child: inside\nnext: done",
      "- [a, b]:\n    |2\n    child: inside\n- done",
      "{? a: b}: |2\n  child: inside\nnext: done",
      "{outer: {? inner: value}}: |2\n  child: inside\nnext: done",
      "{? &anchor }: |2\n  child: inside\nnext: done",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    if (source.includes("next: done")) {
      assertEquals([...classesOf(lines, "next")], ["propertyName"], source);
    }
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: completed block flow nodes do not leak into later keys", () => {
  for (
    const source of [
      'outer:\n  first: [a]\n"root":\n  |2\n  child: inside\nnext: done',
      "outer:\n  first: [a]\n:\n  |2\n  child: inside\nnext: done",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    assertEquals([...classesOf(lines, "next")], ["propertyName"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: empty block keys establish their own mapping indent", () => {
  for (
    const source of [
      ":\n  |2\n  child: inside\nnext: done",
      "outer:\n  :\n    |2\n    child: inside\n  next: done",
      "- :\n    |2\n    child: inside\n- done",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: document markers start at the stream's first column", () => {
  const withBom = "\uFEFF---\nkey: value";
  const bomLines = yamlHighlightLines(withBom);
  assertEquals([...classesOf(bomLines, "---")], ["sectionHeader"]);
  assertEquals(verbatim(bomLines), withBom);

  const indented = yamlHighlightLines("  ---");
  assertEquals([...classesOf(indented, "---")], ["string"]);
  assertEquals(verbatim(indented), "  ---");

  const stream = "--- one\n...\n\uFEFF--- two";
  const streamLines = yamlHighlightLines(stream);
  assertEquals([...classesOf([streamLines[2]], "---")], ["sectionHeader"]);
  assertEquals(verbatim(streamLines), stream);

  const prefixedComment = yamlHighlightLines("\uFEFF# prefix\n---");
  assertEquals(
    [...classesOf([prefixedComment[0]], "# prefix")],
    ["comment"],
  );

  const laterPrefix = "a: b\n\uFEFF# next document\n\n---\nc: d";
  const laterPrefixLines = yamlHighlightLines(laterPrefix);
  assertEquals(
    [...classesOf([laterPrefixLines[1]], "# next document")],
    ["comment"],
  );
  assertEquals(verbatim(laterPrefixLines), laterPrefix);

  const trailingPrefix = "a: b\n\uFEFF# trailing";
  const trailingPrefixLines = yamlHighlightLines(trailingPrefix);
  assertEquals(
    [...classesOf([trailingPrefixLines[1]], "# trailing")],
    ["comment"],
  );
  assertEquals(verbatim(trailingPrefixLines), trailingPrefix);

  const directive = "%TAG !yaml! tag:yaml.org,2002: # primary\n---";
  const directiveLines = yamlHighlightLines(directive);
  assertEquals([...classesOf(directiveLines, "%TAG")], ["keyword"]);
  assertEquals([...classesOf(directiveLines, "!yaml!")], ["keyword"]);
  assertEquals(
    [...classesOf(directiveLines, "tag:yaml.org,2002:")],
    ["string"],
  );
  assertEquals([...classesOf(directiveLines, "# primary")], ["comment"]);
  assertEquals(verbatim(directiveLines), directive);

  const embeddedBom = yamlHighlightLines("key: foo\uFEFF#bar");
  assertEquals([...classesOf(embeddedBom, "foo\uFEFF#bar")], ["string"]);
});

Deno.test("yaml: a BOM only starts a document prefix before a marker", () => {
  const content = "first: value\n\uFEFFsecond: value";
  assertEquals(verbatim(yamlHighlightLines(content)), content);

  const prefix = [
    "first: value",
    "\uFEFF# next document",
    "# another prefix comment",
    "---",
    "second: value",
  ].join("\n");
  const lines = yamlHighlightLines(prefix);
  assertEquals(
    [...classesOf(lines, "# another prefix comment")],
    ["comment"],
  );
  assertEquals([...classesOf(lines, "---")], ["sectionHeader"]);
  assertEquals(verbatim(lines), prefix);
});

Deno.test("yaml: block scalar content stays string until it dedents", () => {
  const source = [
    "script: |2- # shell text",
    "  echo '# not a YAML comment'",
    "  key: still text",
    "",
    "next: >",
    "  folded text",
    "done: true",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf(lines, "|2-")], ["punctuation"]);
  assertEquals([...classesOf(lines, "# shell text")], ["comment"]);
  assertEquals(
    lines[1].spans.map((span) => span.cls),
    ["whitespace", "string"],
  );
  assertEquals(
    lines[2].spans.map((span) => span.cls),
    ["whitespace", "string"],
  );
  assertEquals([...classesOf(lines, "folded text")], ["string"]);
  assertEquals([...classesOf(lines, "done")], ["propertyName"]);
  assertEquals([...classesOf(lines, "true")], ["boolean"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: block scalars accept blank content and reject bad headers", () => {
  const source = [
    "literal: |",
    "  ",
    "  text",
    "empty: |",
    "after: true",
    "invalid: |x",
  ].join("\n");
  const lines = yamlHighlightLines(source);

  assertEquals(lines[1].spans.map((span) => span.cls), ["whitespace"]);
  assertEquals([...classesOf(lines, "text")], ["string"]);
  assertEquals([...classesOf(lines, "after")], ["propertyName"]);
  assertEquals([...classesOf(lines, "true")], ["boolean"]);
  assertEquals([...classesOf(lines, "|x")], ["string"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: a stream BOM does not add logical indentation", () => {
  const source = "\uFEFFscript: |1\n child: inside\nnext: true";
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf(lines, "child: inside")], ["string"]);
  assertEquals([...classesOf(lines, "next")], ["propertyName"]);
  assertEquals([...classesOf(lines, "true")], ["boolean"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: explicit block indentation follows compact sequence mappings", () => {
  const source = [
    "outer:",
    "  - key: |2",
    "      first",
    "    next: done",
    "  - key: >2",
    "      second",
    "    final: true",
    "!!str tagged: |2",
    "  tagged content",
    "after_tag: done",
    "&anchor anchored: |2",
    "  anchored content",
    "after_anchor: done",
    "separate:",
    "  |2",
    "  child: inside",
    "after_separate: done",
    "-",
    "  |2",
    "  sequence content",
    "? explicit",
    ":",
    "  |2",
    "  explicit content",
    "after_explicit: done",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf(lines, "first")], ["string"]);
  assertEquals([...classesOf(lines, "second")], ["string"]);
  assertEquals([...classesOf(lines, "next")], ["propertyName"]);
  assertEquals([...classesOf(lines, "final")], ["propertyName"]);
  assertEquals([...classesOf(lines, "tagged content")], ["string"]);
  assertEquals([...classesOf(lines, "anchored content")], ["string"]);
  assertEquals([...classesOf(lines, "child: inside")], ["string"]);
  assertEquals([...classesOf(lines, "sequence content")], ["string"]);
  assertEquals([...classesOf(lines, "explicit content")], ["string"]);
  assertEquals([...classesOf(lines, "after_tag")], ["propertyName"]);
  assertEquals([...classesOf(lines, "after_anchor")], ["propertyName"]);
  assertEquals([...classesOf(lines, "after_separate")], ["propertyName"]);
  assertEquals([...classesOf(lines, "after_explicit")], ["propertyName"]);
  assertEquals([...classesOf(lines, "true")], ["boolean"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: node properties preserve a pending block scalar indent", () => {
  for (
    const source of [
      "folded:\n   !foo\n  >1\n child: inside\nnext: done",
      "folded: !foo\n  |2\n  child: inside\nnext: done",
      "- !foo\n  |2\n  child: inside\n- done",
      "!foo :\n  |2\n  child: inside\nnext: done",
      "&anchor :\n  |2\n  child: inside\nnext: done",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: a standalone explicit key carries state across lines", () => {
  const source = [
    "?",
    "  key",
    ":",
    "  |2",
    "  child: inside",
    "next: done",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf(lines, "key")], ["propertyName"]);
  assertEquals([...classesOf(lines, "child: inside")], ["string"]);
  assertEquals([...classesOf(lines, "next")], ["propertyName"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: explicit flow collection keys carry state to their value", () => {
  for (
    const source of [
      "?\n  [a, b]\n:\n  |2\n  child: inside\nnext: done",
      "?\n  {a: b}\n:\n  |2\n  child: inside\nnext: done",
      "?\n  [a,\n    {b: c}]\n:\n  |2\n  child: inside\nnext: done",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    assertEquals([...classesOf(lines, "next")], ["propertyName"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: nested explicit keys retain their outer value scope", () => {
  for (
    const source of [
      "?\n  {? [a, b]: c}\n:\n  |2\n  child: inside\nnext: done",
      "?\n  - a\n  - b\n:\n  |2\n  child: inside\nnext: done",
      "?\n- a\n- b\n:\n  |2\n  child: inside\nnext: done",
      "?\n  a: one\n  b: two\n:\n  |2\n  child: inside\nnext: done",
      "? !foo\n:\n  |2\n  child: inside\nnext: done",
      "? |-\n  key\n:\n  |2\n  child: inside\nnext: done",
      "?\n|-\n  key\n:\n  |2\n  child: inside\nnext: done",
      '?\n  "quoted\n  key"\n:\n  |2\n  child: inside\nnext: done',
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    assertEquals([...classesOf(lines, "next")], ["propertyName"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: compact mappings inside explicit keys use local indentation", () => {
  for (
    const source of [
      "? : value\n: outer",
      "? :\n    |2\n    child: inside\n: outer",
      "? key:\n    |2\n    child: inside\n  next: value\n: outer",
      "? : inner\n  : mid\n: outer",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    if (source.includes("value")) {
      assertEquals([...classesOf(lines, "value")], ["string"], source);
    }
    if (source.includes("child: inside")) {
      assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    }
    if (source.includes("next: value")) {
      assertEquals([...classesOf(lines, "next")], ["propertyName"], source);
    }
    if (source.includes("mid")) {
      assertEquals([...classesOf(lines, "inner")], ["string"], source);
      assertEquals([...classesOf(lines, "mid")], ["string"], source);
    }
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: explicit value colons consume pending empty keys", () => {
  for (
    const source of [
      "?\n: |2\n  child: inside\nnext: done",
      "?\n: plain\n  continuation\nnext: done",
      '?\n: "value"\nnext: done',
      "?\n!foo\n: value\nnext: done",
      "? !foo : |2\n    child: inside\n  next: done\n: outer",
      "? &anchor : true\n  next: done\n: outer",
      "? !foo &anchor : value\n  next: done\n: outer",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    if (source.includes("child: inside")) {
      assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    }
    if (source.includes("plain")) {
      assertEquals([...classesOf(lines, "plain")], ["string"], source);
      assertEquals([...classesOf(lines, "continuation")], ["string"], source);
    }
    if (source.includes('"value"')) {
      assertEquals([...classesOf(lines, '"value"')], ["string"], source);
    }
    if (source.includes(": true")) {
      assertEquals([...classesOf(lines, "true")], ["boolean"], source);
    }
    if (source.includes(": value") && !source.includes('"value"')) {
      assertEquals([...classesOf(lines, "value")], ["string"], source);
    }
    assertEquals([...classesOf(lines, "next")], ["propertyName"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: compact empty keys retain their mapping indentation", () => {
  for (
    const source of [
      "- : true\n  next: done",
      "- : |2\n    child: inside\n  next: done",
      "outer:\n  - : true\n    next: done",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    if (source.includes("true")) {
      assertEquals([...classesOf(lines, "true")], ["boolean"], source);
    }
    if (source.includes("child: inside")) {
      assertEquals([...classesOf(lines, "child: inside")], ["string"], source);
    }
    assertEquals([...classesOf(lines, "next")], ["propertyName"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: nested explicit keys accept indentless sequence nodes", () => {
  const source = [
    "outer:",
    "  ?",
    "  - a",
    "  - b",
    "  :",
    "    |2",
    "    child: inside",
    "next: done",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf(lines, "child: inside")], ["string"]);
  assertEquals([...classesOf(lines, "next")], ["propertyName"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: explicit block scalar key content uses key styling", () => {
  for (
    const source of [
      "? |-\n  key text\n: value",
      "?\n|-\n  key text\n: value",
      "?\n  |-\n  key text\n: value",
      "?\n  |2\n  key text\n: value",
      "outer:\n  ?\n    |2\n    key text\n  : value",
      "- ? |2\n    key text\n  : value",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "key text")], ["propertyName"], source);
    assertEquals([...classesOf(lines, "value")], ["string"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: multiline plain explicit keys retain key styling", () => {
  for (
    const source of [
      "? multi\n  line\n: value",
      "?\n  multi\n  line\n: value",
      "?\n  multi\n    line\n: value",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "multi")], ["propertyName"], source);
    assertEquals([...classesOf(lines, "line")], ["propertyName"], source);
    assertEquals([...classesOf(lines, "value")], ["string"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: multiline plain scalars resolve as strings", () => {
  const source = [
    "boolean: true",
    "  continued",
    "number: 12",
    "  units",
    "nothing: null",
    "",
    "  continued",
    "sequence:",
    "  - FALSE",
    "    continued",
    "flow: [true",
    "  continued, false]",
    "done: true",
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals([...classesOf([lines[0]], "true")], ["string"]);
  assertEquals([...classesOf([lines[2]], "12")], ["string"]);
  assertEquals([...classesOf([lines[4]], "null")], ["string"]);
  assertEquals([...classesOf([lines[8]], "FALSE")], ["string"]);
  assertEquals([...classesOf([lines[10]], "true")], ["string"]);
  assertEquals([...classesOf([lines[11]], "continued")], ["string"]);
  assertEquals([...classesOf([lines[11]], "false")], ["boolean"]);
  assertEquals([...classesOf([lines[12]], "true")], ["boolean"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: multiline plain scalars preserve whitespace and comments", () => {
  const block = [
    "message: first",
    "  \t",
    "  second   # trailing comment",
    "next: true",
  ].join("\n");
  const blockLines = yamlHighlightLines(block);
  assertEquals(
    blockLines[1].spans.map((span) => span.cls),
    ["whitespace"],
  );
  assertEquals([...classesOf(blockLines, "second")], ["string"]);
  assertEquals(
    [...classesOf(blockLines, "# trailing comment")],
    ["comment"],
  );
  assertEquals([...classesOf(blockLines, "next")], ["propertyName"]);
  assertEquals(verbatim(blockLines), block);

  for (
    const flow of [
      [
        "values: [first",
        "  ",
        "  second]",
      ].join("\n"),
      "values: [first\r\n\r\n  second]\r\n",
    ]
  ) {
    const flowLines = yamlHighlightLines(flow);
    assertEquals(flowLines[1].spans.map((span) => span.cls), ["whitespace"]);
    assertEquals([...classesOf(flowLines, "second")], ["string"]);
    assertEquals(verbatim(flowLines), flow);
  }
});

Deno.test("yaml: structural lines end plain scalar continuation", () => {
  for (
    const source of [
      "value: true\n  # separate comment",
      "value: [true\n # comment",
      "value: [true\n , false]",
      "value: [true\n ]",
      "value: {key: true\n }",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    assertEquals([...classesOf(lines, "true")], ["boolean"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: separate nodes retain multiline plain scalar state", () => {
  for (
    const source of [
      "key:\n  true\n  continued\nnext: false",
      "-\n  true\n  continued\n- false",
      "key:\n  !foo\n  true\n  continued\nnext: false",
      "key: !foo\n  true\n  continued\nnext: false",
      "- !foo\n  true\n  continued\n- false",
    ]
  ) {
    const lines = yamlHighlightLines(source);
    const typed = lines.find((line) => line.text.trim() === "true")!;
    assertEquals([...classesOf([typed], "true")], ["string"], source);
    assertEquals([...classesOf(lines, "continued")], ["string"], source);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("yaml: multiline quoted strings resume normal syntax after closing", () => {
  const source = [
    'message: "first line',
    '  second # data": value # comment',
  ].join("\n");
  const lines = yamlHighlightLines(source);
  assertEquals(lines[0].spans.at(-1)?.cls, "string");
  assertEquals(lines[1].spans[0].cls, "string");
  assertEquals([...classesOf(lines, "value")], ["string"]);
  assertEquals([...classesOf(lines, "# comment")], ["comment"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("yaml: document and incremental highlighting are lossless", () => {
  const before = "emoji: 🎉\nready: false\n";
  const after = "emoji: 🎉\nready: true\ncount: .inf\n";
  const document = yamlDocument(before);
  assertEquals(verbatim(document.lines), before);
  assertEquals(document.structure, []);

  const highlighter = createYamlHighlighter(before);
  assertEquals(highlighter.lines, yamlHighlightLines(before));
  assertEquals(highlighter.update(after), yamlHighlightLines(after));
  assertEquals(verbatim(highlighter.lines), after);
});

Deno.test("yaml: incomplete syntax remains lossless", () => {
  for (
    const source of [
      'key: "unterminated',
      "key: 'unterminated",
      "flow: {nested: [1, 2",
      "script: |",
      "  # block content",
      "😀: value\r\nnext: true\r\n",
    ]
  ) {
    assertEquals(verbatim(yamlHighlightLines(source)), source);
  }
});

Deno.test("yaml: a YAML diff uses YAML highlighting on both sides", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = "name: gadget\ncount: 2\n";
    Deno.writeTextFileSync(join(root, "config.yaml"), file);
    const workspace: DiffWorkspace = {
      resolve: (path) => join(root, path),
      read: (path) => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      },
    };
    const diff = `diff --git a/config.yaml b/config.yaml
--- a/config.yaml
+++ b/config.yaml
@@ -1,2 +1,2 @@
-name: widget
+name: gadget
 count: 2
`;
    const model = parseDiff(diff)!;
    const { doc } = buildDiffDocument(diff, model, workspace);
    const nameSpans = doc.lines.filter((line) => line.text.includes("name:"))
      .flatMap((line) => line.spans);
    assert(
      nameSpans.some((span) =>
        span.text === "name" && span.cls === "propertyName"
      ),
    );
    assert(
      nameSpans.some((span) => span.text === "widget" && span.cls === "string"),
    );
    assert(
      nameSpans.some((span) => span.text === "gadget" && span.cls === "string"),
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("yaml: an unavailable old diff side carries context into deletions", () => {
  const diff = [
    "--- a/config.yml",
    "+++ b/config.yml",
    "@@ -1,2 +1 @@",
    " script: |",
    "-  child: old",
    "",
  ].join("\n");
  const workspace: DiffWorkspace = {
    resolve: () => null,
    read: () => null,
  };
  const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);
  const removed = doc.lines.find((line) => line.text.includes("child: old"))!;
  assert(
    removed.spans.some((span) =>
      span.text === "child: old" && span.cls === "string"
    ),
  );
  assert(!removed.spans.some((span) => span.cls === "propertyName"));
});

Deno.test("yaml: editing a YAML diff line re-applies YAML highlighting", () => {
  const diff = [
    "diff --git a/config.yml b/config.yml",
    "--- a/config.yml",
    "+++ b/config.yml",
    "@@ -1 +1 @@",
    " count: 1",
    "",
  ].join("\n");
  const highlighter = createDiffHighlighter(diff);
  const updated = highlighter.update(diff.replace("count: 1", "count: 42"));
  const line = updated.find((candidate) => candidate.text.includes("count:"))!;
  assert(
    line.spans.some((span) =>
      span.text === "count" && span.cls === "propertyName"
    ),
  );
  assert(
    line.spans.some((span) => span.text === "42" && span.cls === "number"),
  );
});

Deno.test("yaml: live diff edits preserve and update cross-line state", () => {
  const diff = [
    "diff --git a/config.yml b/config.yml",
    "--- a/config.yml",
    "+++ b/config.yml",
    "@@ -1,5 +1,5 @@",
    " script: |",
    "   child: old",
    " next: true",
    ' message: "first',
    '   nested: old"',
    "",
  ].join("\n");
  const highlighter = createDiffHighlighter(diff);

  const insideBlock = diff.replace("child: old", "child: new");
  let lines = highlighter.update(insideBlock);
  let line = lines.find((candidate) => candidate.text.includes("child:"))!;
  assert(
    line.spans.some((span) =>
      span.text === "child: new" && span.cls === "string"
    ),
  );
  assert(!line.spans.some((span) => span.cls === "propertyName"));

  const insideQuote = insideBlock.replace("nested: old", "nested: new");
  lines = highlighter.update(insideQuote);
  line = lines.find((candidate) => candidate.text.includes("nested:"))!;
  assert(
    line.spans.some((span) =>
      span.text.includes("nested: new") && span.cls === "string"
    ),
  );
  assert(!line.spans.some((span) => span.cls === "propertyName"));

  const withoutBlock = insideQuote.replace("script: |", "script:");
  lines = highlighter.update(withoutBlock);
  line = lines.find((candidate) => candidate.text.includes("child:"))!;
  assert(
    line.spans.some((span) =>
      span.text === "child" && span.cls === "propertyName"
    ),
  );

  const withoutQuote = withoutBlock.replace(
    'message: "first',
    "message:",
  );
  lines = highlighter.update(withoutQuote);
  line = lines.find((candidate) => candidate.text.includes("nested:"))!;
  assert(
    line.spans.some((span) =>
      span.text === "nested" && span.cls === "propertyName"
    ),
  );
});

Deno.test("yaml: live diff edits retain state that begins above the hunk", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "config.yml"),
      "script: |\n  intro\n  child: new\nnext: true\n",
    );
    const workspace: DiffWorkspace = {
      resolve: (path) => join(root, path),
      read: (path) => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      },
    };
    const diff = [
      "diff --git a/config.yml b/config.yml",
      "--- a/config.yml",
      "+++ b/config.yml",
      "@@ -3 +3 @@",
      "-  child: old",
      "+  child: new",
      "",
    ].join("\n");
    const { doc, edit } = buildDiffDocument(
      diff,
      parseDiff(diff)!,
      workspace,
    );
    const source = diffSource(workspace, edit);
    const highlighter = source.createHighlighter!(diff, doc.lines);
    const updated = highlighter.update(
      diff.replace("+  child: new", "+  child: newer"),
    );
    for (const value of ["child: old", "child: newer"]) {
      const line = updated.find((candidate) => candidate.text.includes(value))!;
      assert(
        line.spans.some((span) => span.text === value && span.cls === "string"),
      );
      assert(!line.spans.some((span) => span.cls === "propertyName"));
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

function assertLiveDiffLineOffsets(
  repeatedFileSection: boolean,
  reverseFileSections = false,
): void {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "config.yml"),
      [
        "script: |",
        "  intro",
        "  middle one",
        "  middle two",
        "  target: new",
        "next: true",
        "",
      ].join("\n"),
    );
    const workspace: DiffWorkspace = {
      resolve: (path) => join(root, path),
      read: (path) => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      },
    };
    const header = [
      "diff --git a/config.yml b/config.yml",
      "--- a/config.yml",
      "+++ b/config.yml",
    ];
    const introHunk = [
      "@@ -2 +2 @@",
      "-  old intro",
      "+  intro",
    ];
    const targetHunk = [
      "@@ -5 +5 @@",
      "-  target: old",
      "+  target: new",
    ];
    const body = !repeatedFileSection
      ? [...header, ...introHunk, ...targetHunk]
      : reverseFileSections
      ? [...header, ...targetHunk, ...header, ...introHunk]
      : [...header, ...introHunk, ...header, ...targetHunk];
    const diff = [
      ...body,
      "",
    ].join("\n");
    const { doc, edit } = buildDiffDocument(
      diff,
      parseDiff(diff)!,
      workspace,
    );
    const source = diffSource(workspace, edit);
    const highlighter = source.createHighlighter!(
      diff,
      doc.lines,
    );
    const edited = diff
      .replace("@@ -2 +2 @@", "@@ -2 +2,2 @@")
      .replace("+  intro", "+  intro\n+  inserted");
    const updated = highlighter.update(edited);
    const target = updated.find((line) => line.text === "+  target: new")!;
    assert(
      target.spans.some((span) =>
        span.text === "target: new" && span.cls === "string"
      ),
    );
    assert(!target.spans.some((span) => span.cls === "propertyName"));

    source.save(
      edited,
      source.lineEndingProvenance!(edited),
      diff,
    );
    const afterSave = highlighter.update(
      edited.replace("+  target: new", "+  target: newer"),
    );
    const savedTarget = afterSave.find((line) =>
      line.text === "+  target: newer"
    )!;
    assert(
      savedTarget.spans.some((span) =>
        span.text === "target: newer" && span.cls === "string"
      ),
    );
    assert(!savedTarget.spans.some((span) => span.cls === "propertyName"));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}

Deno.test("yaml: live diff line insertions shift later complete-file spans", () => {
  assertLiveDiffLineOffsets(false);
});

Deno.test("yaml: live diff offsets cross repeated file sections", () => {
  assertLiveDiffLineOffsets(true);
});

Deno.test("yaml: live diff offsets follow file coordinates", () => {
  assertLiveDiffLineOffsets(true, true);
});

Deno.test("yaml: a touched path rehighlights every repeated section", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "config.yml"),
      [
        "script:",
        "  intro",
        "  middle one",
        "  middle two",
        "  target: new",
        "next: true",
        "",
      ].join("\n"),
    );
    const workspace: DiffWorkspace = {
      resolve: (path) => join(root, path),
      read: (path) => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      },
    };
    const diff = [
      "diff --git a/config.yml b/config.yml",
      "--- a/config.yml",
      "+++ b/config.yml",
      "@@ -1 +1 @@",
      "-script: old",
      "+script:",
      "diff --git a/config.yml b/config.yml",
      "--- a/config.yml",
      "+++ b/config.yml",
      "@@ -5 +5 @@",
      "-  target: old",
      "+  target: new",
      "",
    ].join("\n");
    const { doc, edit } = buildDiffDocument(
      diff,
      parseDiff(diff)!,
      workspace,
    );
    const highlighter = diffSource(workspace, edit).createHighlighter!(
      diff,
      doc.lines,
    );
    const updated = highlighter.update(
      diff.replace("+script:", "+script: |"),
    );
    const target = updated.find((line) => line.text === "+  target: new")!;
    assert(
      target.spans.some((span) =>
        span.text === "target: new" && span.cls === "string"
      ),
    );
    assert(!target.spans.some((span) => span.cls === "propertyName"));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("yaml: live diff highlighting leaves other files unchanged", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "config.yml"),
      "script:\n  child: new\n",
    );
    Deno.writeTextFileSync(
      join(root, "other.yml"),
      "enabled: true\n",
    );
    const workspace: DiffWorkspace = {
      resolve: (path) => join(root, path),
      read: (path) => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      },
    };
    const diff = [
      "diff --git a/config.yml b/config.yml",
      "--- a/config.yml",
      "+++ b/config.yml",
      "@@ -1 +1 @@",
      "-script: old",
      "+script:",
      "diff --git a/other.yml b/other.yml",
      "--- a/other.yml",
      "+++ b/other.yml",
      "@@ -1 +1 @@",
      "-enabled: false",
      "+enabled: true",
      "",
    ].join("\n");
    const { doc, edit } = buildDiffDocument(
      diff,
      parseDiff(diff)!,
      workspace,
    );
    const originalOther = doc.lines.find((line) =>
      line.text === "+enabled: true"
    )!;
    const highlighter = diffSource(workspace, edit).createHighlighter!(
      diff,
      doc.lines,
    );
    const updated = highlighter.update(
      diff.replace("+script:", "+script: |"),
    );
    const other = updated.find((line) => line.text === "+enabled: true")!;
    assertStrictEquals(other, originalOther);
    assert(
      other.spans.some((span) =>
        span.text === "enabled" && span.cls === "propertyName"
      ),
    );
    assert(
      other.spans.some((span) =>
        span.text === "true" && span.cls === "boolean"
      ),
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
