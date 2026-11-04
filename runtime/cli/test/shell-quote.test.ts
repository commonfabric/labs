import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shellQuote } from "../lib/shell-quote.ts";

describe("shell-quote", () => {
  describe("shellQuote()", () => {
    it("wraps a plain value in single quotes", () => {
      expect(shellQuote("/home/me/identity.key")).toBe(
        "'/home/me/identity.key'",
      );
    });

    it("closes, escapes, and reopens around each apostrophe", () => {
      expect(shellQuote("/Users/o'brien/x")).toBe("'/Users/o'\\''brien/x'");
    });

    it("quotes the empty string as an empty word", () => {
      expect(shellQuote("")).toBe("''");
    });
  });
});
