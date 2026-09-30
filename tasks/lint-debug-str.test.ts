/// <reference lib="deno.unstable" />

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import plugin from "./lint-debug-str.ts";

function diagnose(source: string): string[] {
  return Deno.lint.runPlugin(plugin, "sample.ts", source)
    .map((d) => d.message);
}

/** Distinguishing phrase of the message for a word no directive can hold. */
const UNKNOWN = "directive cannot hold";

/** Distinguishing phrase of the message for more than one size word. */
const SIZES = "no more than one size word";

describe("lint-debug-str", () => {
  it("reports nothing for a template whose directives are all valid", () => {
    const messages = diagnose(
      "debugStr`a ${x} b $quote${y} c $indent,quote,xlong${z} d $short${w}`;",
    );
    expect(messages).toEqual([]);
  });

  it("reports a directive holding a word no directive can hold", () => {
    const messages = diagnose("debugStr`value: $qoute,long${x}`;");
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(UNKNOWN);
    expect(messages[0]).toContain("`qoute`");
    expect(messages[0]).not.toContain("`long`, `qoute`");
  });

  it("reports each bad directive of one template", () => {
    const messages = diagnose("debugStr`$foo${x} and $bar${y}`;");
    expect(messages.length).toBe(2);
    expect(messages[0]).toContain("`foo`");
    expect(messages[1]).toContain("`bar`");
  });

  it("reports a directive holding two size words", () => {
    const messages = diagnose("debugStr`value: $long,xlong${x}`;");
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(SIZES);
  });

  it("reports nothing for an escaped directive", () => {
    expect(diagnose("debugStr`value: \\$qoute${x}`;")).toEqual([]);
  });

  it("reports a directive after an escaped backslash", () => {
    const messages = diagnose("debugStr`value: \\\\$qoute${x}`;");
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(UNKNOWN);
  });

  it("reports nothing for directive-like text at the end of a template", () => {
    expect(diagnose("debugStr`${x} costs $qoute`;")).toEqual([]);
  });

  it("reports nothing for text which merely holds a dollar sign", () => {
    expect(diagnose("debugStr`costs $5${x} or $${y}`;")).toEqual([]);
  });

  it("reports nothing for a template under another tag, or under none", () => {
    expect(diagnose("html`value: $qoute${x}`;")).toEqual([]);
    expect(diagnose("`value: $qoute${x}`;")).toEqual([]);
    expect(diagnose("obj.debugStr`value: $qoute${x}`;")).toEqual([]);
  });
});
