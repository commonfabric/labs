import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Lexer, type Tokens } from "marked";

import { HeadingIds } from "./heading-id.ts";

describe("heading-id", () => {
  // marked generated these ids itself until version 5, under a `headerIds`
  // option that defaulted to on, and dropped them in a later major. The
  // expected ids below are the ones marked 4 produced, because fragment links
  // written against the old output point at them.

  const idsOf = (markdown: string): string[] => {
    const ids = new HeadingIds();
    return Lexer.lex(markdown, { breaks: true, gfm: true })
      .filter((token): token is Tokens.Heading => token.type === "heading")
      .map((token) => ids.idFor(token.tokens));
  };

  it("gives a heading an id", () => {
    expect(idsOf("# Section")).toEqual(["section"]);
  });

  it("suffixes repeated headings so each id stays unique", () => {
    expect(idsOf("# Section\n\n# Section\n\n# Section")).toEqual([
      "section",
      "section-1",
      "section-2",
    ]);
  });

  it("counts headings that differ only by case as repeats", () => {
    expect(idsOf("# Section\n\n# section\n\n# SECTION")).toEqual([
      "section",
      "section-1",
      "section-2",
    ]);
  });

  it("skips a suffix that a later heading already claims", () => {
    // "Section 1" slugs to "section-1", which the second "Section" took, so
    // the suffix search moves past it rather than emitting a duplicate id.
    expect(idsOf("# Section\n\n# Section\n\n# Section 1")).toEqual([
      "section",
      "section-1",
      "section-1-1",
    ]);
  });

  it("restarts the suffixes on each render", () => {
    // The slugger is per-render, so re-rendering the same content gives the
    // same ids instead of continuing to count up.
    const markdown = "# Section\n\n# Section";
    expect(idsOf(markdown)).toEqual(["section", "section-1"]);
    expect(idsOf(markdown)).toEqual(["section", "section-1"]);
  });

  it("drops punctuation", () => {
    expect(idsOf("# What's New? (v2.0)")).toEqual(["whats-new-v20"]);
  });

  it("keeps non-ASCII letters", () => {
    expect(idsOf("# Café Münster")).toEqual(["café-münster"]);
    expect(idsOf("# 中文标题")).toEqual(["中文标题"]);
    expect(idsOf("# 🚀 Quick Start")).toEqual(["🚀-quick-start"]);
  });

  it("drops an ampersand and any entity around it", () => {
    expect(idsOf("# Q&A")).toEqual(["qa"]);
    expect(idsOf("# AT&T Integration")).toEqual(["att-integration"]);
    // An escaped ampersand slugs the same way a bare one does.
    expect(idsOf("# Tips &amp; Tricks")).toEqual(["tips--tricks"]);
  });

  it("drops an ampersand nested inside inline markup", () => {
    // The slug is built from the heading's tokens, so the text inside
    // emphasis, strikethrough, a link or an image has to be walked into and
    // escaped exactly as the text around it is. Reading a container token's
    // own text instead leaves the ampersand unescaped, and unescaping it
    // then eats the letter after it: `att-integration` becomes
    // `at-integration`.
    expect(idsOf("# **AT&T** Integration")).toEqual(["att-integration"]);
    expect(idsOf("# **Q&A**")).toEqual(["qa"]);
    expect(idsOf("# *Tips & Tricks*")).toEqual(["tips--tricks"]);
    expect(idsOf("# ~~R&D~~")).toEqual(["rd"]);
    expect(idsOf("# [Q&A](/faq)")).toEqual(["qa"]);
    expect(idsOf("# ![Q&A](/i.png)")).toEqual(["qa"]);
    expect(idsOf("# `a & b`")).toEqual(["a--b"]);
  });

  it("resolves a numeric entity but leaves an over-long one alone", () => {
    expect(idsOf("# &#65; letter")).toEqual(["a-letter"]);
    // Past marked's limits (7 decimal digits, 6 hex) the run is not an
    // entity, so the `&` and `;` are dropped and the digits stay.
    expect(idsOf("# &#12345678; tail")).toEqual(["12345678-tail"]);
    expect(idsOf("# &#x1234567; tail")).toEqual(["x1234567-tail"]);
  });

  it("resolves the named colon entity, then strips the colon", () => {
    // `&colon;` is the one named entity marked resolves — to `:` — instead of
    // dropping it whole the way it drops every other named entity. The colon
    // it produces is punctuation, so the slug then removes it: `a:b` becomes
    // `ab`, matching marked 4. Were `&colon;` left as literal text the slug
    // would keep the letters and read `acolonb` instead.
    expect(idsOf("# a&colon;b")).toEqual(["ab"]);
    expect(idsOf("# time&colon; now")).toEqual(["time-now"]);
  });

  it("slugs the heading's text, not its markup", () => {
    expect(idsOf("# Using **bold** and `code`")).toEqual([
      "using-bold-and-code",
    ]);
  });

  it("gives every heading level an id", () => {
    expect(idsOf("## Sub Section\n\n### Deep Section")).toEqual([
      "sub-section",
      "deep-section",
    ]);
  });
});
