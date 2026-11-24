import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shellQuote, shellWord } from "../lib/shell-quote.ts";

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

  describe("shellWord()", () => {
    it("leaves a plain path as it is, which is how a person reads it", () => {
      expect(shellWord("./data/notes.txt")).toBe("./data/notes.txt");
    });

    it("quotes a path a shell would split or expand", () => {
      expect(shellWord("./my team's notes.txt")).toBe(
        "'./my team'\\''s notes.txt'",
      );
      expect(shellWord("./$HOME.txt")).toBe("'./$HOME.txt'");
    });

    it("quotes an empty value, which would otherwise be no word at all", () => {
      expect(shellWord("")).toBe("''");
    });
  });
});
