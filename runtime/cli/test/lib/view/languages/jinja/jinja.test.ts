import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { jinjaSyntax } from "../../../../../lib/view/languages/jinja/jinja.ts";
import { languageForName } from "../../../../../lib/view/languages/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

/** Every distinct class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return [
    ...new Set(
      lines.flatMap((line) =>
        line.spans.filter((span) => span.text === text).map((span) => span.cls)
      ),
    ),
  ];
}

/** Each colored span of `source` other than white space, as `class:text`. */
function spans(source: string): string[] {
  return languageForName("jinja")!.highlightLines(source).flatMap((line) =>
    line.spans.filter((span) => span.cls !== "whitespace").map((span) =>
      `${span.cls}:${span.text}`
    )
  );
}

/** The text of each region of `source` and what the host reads in its place. */
function regions(source: string): [string, string][] {
  return jinjaSyntax.scan(source).regions.map(({ start, end, fill }) => [
    source.slice(start, end),
    fill,
  ]);
}

describe("jinja", () => {
  describe("regions", () => {
    it("puts a value in place of an expression, and nothing in place of a tag or a comment", () => {
      expect(regions("a {{ b }} {% if c %}d{% endif %} {# e #}")).toEqual([
        ["{{ b }}", "_"],
        ["{% if c %}", " "],
        ["{% endif %}", " "],
        ["{# e #}", " "],
      ]);
    });

    it("leaves a lone brace and the text between regions to the host", () => {
      expect(regions("f() { x; } ${#y} {")).toEqual([["{#y} {", " "]]);
      expect(regions("f() { x; }")).toEqual([]);
    });

    it("ends an expression at a closing delimiter outside strings and brackets only", () => {
      expect(regions('{{ "}}" }}x')).toEqual([['{{ "}}" }}', "_"]]);
      expect(regions("{{ {'a': {'b': 1}} }}x")).toEqual([
        ["{{ {'a': {'b': 1}} }}", "_"],
      ]);
      expect(regions("{% set a = ']%}' %}x")).toEqual([
        ["{% set a = ']%}' %}", " "],
      ]);
    });

    it("runs a region that is not closed to the end of the source", () => {
      expect(regions("{{ a\nb")).toEqual([["{{ a\nb", "_"]]);
      expect(regions("{# a\nb")).toEqual([["{# a\nb", " "]]);
      expect(regions("{{ ) }} x")).toEqual([["{{ ) }}", "_"]]);
    });

    it("ends an expression at a closing delimiter inside an unclosed parenthesis or bracket", () => {
      expect(regions("{{ f( }}\necho hi\n{{ y[ }}x")).toEqual([
        ["{{ f( }}", "_"],
        ["{{ y[ }}", "_"],
      ]);
      expect(regions("{% if f(x %}y")).toEqual([["{% if f(x %}", " "]]);
    });

    it("leaves the text of a raw block to the host", () => {
      expect(
        regions("{% raw %}{{ kept }}{%- endraw -%} {{ v }}"),
      ).toEqual([
        ["{% raw %}", " "],
        ["{%- endraw -%}", " "],
        ["{{ v }}", "_"],
      ]);
      expect(regions("{% raw %}{{ kept }}")).toEqual([["{% raw %}", " "]]);
    });
  });

  describe("highlighting", () => {
    it("colors the delimiters with their white space markers", () => {
      expect(spans("{{- a +}} {%+ b -%}")).toEqual([
        "template:{{-",
        "identifier:a",
        "template:+}}",
        "template:{%+",
        "identifier:b",
        "template:-%}",
      ]);
    });

    it("colors tags, operators spelled as words, and literals", () => {
      expect(
        spans(
          '{% if a is defined and not b %} {{ "s" ~ 1.5e3 if true else none }} {% endif %}',
        ),
      ).toEqual([
        "template:{%",
        "controlKeyword:if",
        "identifier:a",
        "keyword:is",
        "callName:defined",
        "keyword:and",
        "keyword:not",
        "identifier:b",
        "template:%}",
        "template:{{",
        'string:"s"',
        "operator:~",
        "number:1.5e3",
        "controlKeyword:if",
        "boolean:true",
        "controlKeyword:else",
        "keyword:none",
        "template:}}",
        "template:{%",
        "controlKeyword:endif",
        "template:%}",
      ]);
    });

    it("colors filters, calls, attributes, and the brackets and punctuation between them", () => {
      expect(spans("{{ item.name | default(x[0], true) }}")).toEqual([
        "template:{{",
        "identifier:item",
        "punctuation:.",
        "propertyName:name",
        "operator:|",
        "callName:default",
        "bracket:(",
        "identifier:x",
        "bracket:[",
        "number:0",
        "bracket:]",
        "punctuation:,",
        "boolean:true",
        "bracket:)",
        "template:}}",
      ]);
      expect(classesOf(
        languageForName("jinja")!.highlightLines(
          "{{ lookup ('env', 'HOME') }}",
        ),
        "lookup",
      )).toEqual(["callName"]);
    });

    it("colors a test's name after `is` and `is not`, and `not` as a keyword", () => {
      expect(spans("{% if a is not defined or not b %}")).toEqual([
        "template:{%",
        "controlKeyword:if",
        "identifier:a",
        "keyword:is",
        "keyword:not",
        "callName:defined",
        "keyword:or",
        "keyword:not",
        "identifier:b",
        "template:%}",
      ]);
    });

    it("colors the names a tag binds up to its `=` or `in`", () => {
      expect(spans("{% for k, v in d %} {% set x = y %}")).toEqual([
        "template:{%",
        "controlKeyword:for",
        "binding:k",
        "punctuation:,",
        "binding:v",
        "keyword:in",
        "identifier:d",
        "template:%}",
        "template:{%",
        "keyword:set",
        "binding:x",
        "operator:=",
        "identifier:y",
        "template:%}",
      ]);
    });

    it("colors names written in any script as names", () => {
      expect(spans("{{ café | upper }}")).toEqual([
        "template:{{",
        "identifier:café",
        "operator:|",
        "callName:upper",
        "template:}}",
      ]);
    });

    it("colors each name a `with` tag's assignments bind", () => {
      expect(spans("{% with a = f(1, 2), b = 3 %}")).toEqual([
        "template:{%",
        "keyword:with",
        "binding:a",
        "operator:=",
        "callName:f",
        "bracket:(",
        "number:1",
        "punctuation:,",
        "number:2",
        "bracket:)",
        "punctuation:,",
        "binding:b",
        "operator:=",
        "number:3",
        "template:%}",
      ]);
    });

    it("colors the name a macro or block declares", () => {
      expect(spans("{% macro row(cell) %} {% block body %}")).toEqual([
        "template:{%",
        "keyword:macro",
        "functionName:row",
        "bracket:(",
        "identifier:cell",
        "bracket:)",
        "template:%}",
        "template:{%",
        "keyword:block",
        "functionName:body",
        "template:%}",
      ]);
    });

    it("colors a comment, and an unclosed quote as a character of its own", () => {
      expect(spans("{# a {{ b }} #}")).toEqual(["comment:{# a {{ b }} #}"]);
      expect(spans('{{ "a }}')).toEqual([
        "template:{{",
        'plain:"',
        "identifier:a",
        "template:}}",
      ]);
    });

    it("colors expressions that span lines", () => {
      expect(spans("{{ a\n  | b }}")).toEqual([
        "template:{{",
        "identifier:a",
        "operator:|",
        "callName:b",
        "template:}}",
      ]);
    });
  });
});
