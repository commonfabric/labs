import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseDebugStrDirective } from "@/value-debug/parseDebugStrDirective.ts";

describe("parseDebugStrDirective()", () => {
  it("returns the one word of a one-word directive", () => {
    expect(parseDebugStrDirective("value: $quote"))
      .toEqual({ length: 6, words: ["quote"] });
  });

  it("returns the words of a directive in the order written", () => {
    expect(parseDebugStrDirective("value: $quote,long,indent"))
      .toEqual({ length: 18, words: ["quote", "long", "indent"] });
  });

  it("returns a directive which is the whole string", () => {
    expect(parseDebugStrDirective("$long"))
      .toEqual({ length: 5, words: ["long"] });
  });

  it("returns a word no directive can hold, as written", () => {
    expect(parseDebugStrDirective("$qoute,long"))
      .toEqual({ length: 11, words: ["qoute", "long"] });
  });

  it("returns `undefined` for a string which ends in no directive", () => {
    const strings = [
      "",
      "plain text",
      "$",
      "$quote ",
      "$quote and more",
      "$5",
      "$Quote",
      "$quote,",
      "$,quote",
      "$quote,,long",
      "$quote-long",
    ];
    for (const raw of strings) {
      expect(parseDebugStrDirective(raw)).toBeUndefined();
    }
  });

  it("returns `undefined` when an odd number of backslashes precedes the dollar sign", () => {
    expect(parseDebugStrDirective("value: \\$quote")).toBeUndefined();
    expect(parseDebugStrDirective("value: \\\\\\$quote")).toBeUndefined();
  });

  it("returns the directive when an even number of backslashes precedes the dollar sign", () => {
    expect(parseDebugStrDirective("value: \\\\$quote"))
      .toEqual({ length: 6, words: ["quote"] });
  });
});
