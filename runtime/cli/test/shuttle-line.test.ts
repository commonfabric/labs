/**
 * Unit tests for the line split and the printer that inverts it. Both halves
 * are pure functions over strings, so a case hands one a string and reads the
 * value back: no connection, no terminal, and no line loop stands behind any
 * of it.
 *
 * Each case is written against one mutation of `src/line.ts` — the one its
 * description forbids — so that a case which stops discriminating stops
 * passing. A case pinning a refusal pins the whole sentence rather than a
 * fragment of it, since a fragment lets a rewording through that says
 * something else.
 *
 * Two of them are checked over a construction rather than over listed
 * outcomes, because a list is a slice of a class and the rest of the class is
 * where a gap hides: that every character the grammar reserves forces
 * quoting, and that a printed value splits back into the one value it was
 * printed from. The construction is where a value nobody would have listed
 * gets driven.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  quoteToken,
  RESERVED_CHARACTERS,
  separatesTokens,
  splitLine,
  tailOfLine,
} from "../lib/shuttle/line.ts";

/**
 * Helper for the cases below, which divides every code point into the ones
 * the split separates on and the ones it does not.
 *
 * The division is the split's own predicate rather than a list written here,
 * which is what lets a case over either side close the class: a character the
 * expression starts or stops matching moves between the two sides, and the
 * case that then fails is the one whose claim stopped holding.
 *
 * The lone surrogates are left out because neither side is a claim about
 * them: they are not characters, and a line carrying one is not a line
 * anything typed.
 */
function classified(): { separators: string[]; others: string[] } {
  const separators: string[] = [];
  const others: string[] = [];
  for (let code = 0; code <= 0x10ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const character = String.fromCodePoint(code);
    (separatesTokens(character) ? separators : others).push(character);
  }
  return { separators, others };
}

describe("line", () => {
  describe("RESERVED_CHARACTERS", () => {
    it("holds the pipe, the local escape, the redirections, `#` and `%`, and nothing else", () => {
      expect(RESERVED_CHARACTERS).toBe("!#%<>|");
    });
  });

  describe("splitLine()", () => {
    it("returns one token per run of characters between separators", () => {
      expect(splitLine("cd slugs/board")).toEqual({
        kind: "split",
        tokens: ["cd", "slugs/board"],
      });
    });

    it("separates on a whitespace character that is not the space", () => {
      // Every separator here is written as an escape, and none of them is
      // a line break: an invisible character in a fixture is unreadable,
      // and a line break would tie this case to the one below it.

      expect(splitLine("a\tb\rc\vd\fe")).toEqual({
        kind: "split",
        tokens: ["a", "b", "c", "d", "e"],
      });
    });

    it("separates on a no-break space and on the Unicode line separator, neither of which a reader sees", () => {
      // The realistic way an operand acquires one is a paste out of a
      // document. The pair stays consistent about them either way: what
      // separates here is what the printer quotes, so a value holding one
      // still round-trips.

      expect(splitLine("a\u00a0b")).toEqual({
        kind: "split",
        tokens: ["a", "b"],
      });
      expect(splitLine("a\u2028b")).toEqual({
        kind: "split",
        tokens: ["a", "b"],
      });
    });

    it("returns no tokens for a line holding separators alone", () => {
      expect(splitLine("  \t ")).toEqual({ kind: "split", tokens: [] });
    });

    it("returns no empty token for a run of separators, or for one at either edge", () => {
      expect(splitLine("  cd   board  ")).toEqual({
        kind: "split",
        tokens: ["cd", "board"],
      });
    });

    it("returns what single quotes hold as one token, whitespace and all", () => {
      expect(splitLine("get 'a b'")).toEqual({
        kind: "split",
        tokens: ["get", "a b"],
      });
    });

    it("returns a backslash inside single quotes as a character of the token, even before one double quotes would escape", () => {
      // The character after the backslash is what makes this discriminate.
      // Before an ordinary one the two quote rules agree, so a fixture
      // there would pass whether or not single quotes escape.

      expect(splitLine("'a\\\"b'")).toEqual({
        kind: "split",
        tokens: ['a\\"b'],
      });
      expect(splitLine("'a\\b'")).toEqual({
        kind: "split",
        tokens: ["a\\b"],
      });
    });

    it("returns what double quotes hold as one token, whitespace and all", () => {
      expect(splitLine('get "a b"')).toEqual({
        kind: "split",
        tokens: ["get", "a b"],
      });
    });

    it("returns the character after a backslash inside double quotes, and not the backslash", () => {
      expect(splitLine('"a\\"b"')).toEqual({
        kind: "split",
        tokens: ['a"b'],
      });
      expect(splitLine('"a\\\\b"')).toEqual({
        kind: "split",
        tokens: ["a\\b"],
      });
    });

    it("returns a backslash inside double quotes as a character of the token where it escapes neither quote nor backslash", () => {
      expect(splitLine('"C:\\path"')).toEqual({
        kind: "split",
        tokens: ["C:\\path"],
      });
    });

    it("returns a reserved character between double quotes as a character of the token", () => {
      // The construction at the end of this file cannot reach this: a value
      // takes the double-quoted form only where it holds a `\'`, and no value
      // that construction builds pairs one with a reserved character. So the
      // grouping half of the double-quote rule is driven here or nowhere.

      for (const character of RESERVED_CHARACTERS) {
        expect(splitLine(`"a${character}b"`)).toEqual({
          kind: "split",
          tokens: [`a${character}b`],
        });
      }
      expect(splitLine('a"b#c"d')).toEqual({
        kind: "split",
        tokens: ["ab#cd"],
      });
    });

    it("returns the character after a backslash outside quotes, and not the backslash", () => {
      expect(splitLine("a\\ b")).toEqual({ kind: "split", tokens: ["a b"] });
    });

    it("returns quoted and bare runs that touch as one token", () => {
      expect(splitLine('a"b c"d')).toEqual({
        kind: "split",
        tokens: ["ab cd"],
      });
    });

    it("returns an empty pair of quotes as a token that is the empty string", () => {
      expect(splitLine("set x ''")).toEqual({
        kind: "split",
        tokens: ["set", "x", ""],
      });
    });

    it("returns one run of tokens for text carrying a line break, the break separating like any other", () => {
      // A terminator is the caller's to strip, and a paste of two lines is
      // one caller's problem rather than two commands here.

      expect(splitLine("set x 1\nset y 2")).toEqual({
        kind: "split",
        tokens: ["set", "x", "1", "set", "y", "2"],
      });
    });

    describe("a JSON value on the line", () => {
      // The case the split exists for. A JSON object holds a space after
      // every comma and colon a person writes, so the value it is written as
      // survives only where quoting is what bounds the token.

      it("returns a quoted JSON value as one token", () => {
        expect(splitLine('set draft \'{"title": "a b"}\'')).toEqual({
          kind: "split",
          tokens: ["set", "draft", '{"title": "a b"}'],
        });
      });

      it("returns an unquoted JSON value as one token per run, its quotes taken off", () => {
        expect(splitLine('set draft {"title": "a b"}')).toEqual({
          kind: "split",
          tokens: ["set", "draft", "{title:", "a b}"],
        });
      });
    });

    describe("refusals", () => {
      it("refuses a line whose `'` is never closed", () => {
        expect(splitLine("cd 'a b")).toEqual({
          kind: "refused",
          reason: "The `'` opened at column 4 is never closed.",
        });
      });

      it('refuses a line whose `"` is never closed, naming that quote', () => {
        expect(splitLine('"a b')).toEqual({
          kind: "refused",
          reason: 'The `"` opened at column 1 is never closed.',
        });
      });

      it("names the column the unclosed quote opened at", () => {
        expect(splitLine('get "a b')).toEqual({
          kind: "refused",
          reason: 'The `"` opened at column 5 is never closed.',
        });
      });

      it("counts the column in code points, so a character stored as two code units counts one", () => {
        expect(splitLine("\u{1f369} 'a b")).toEqual({
          kind: "refused",
          reason: "The `'` opened at column 3 is never closed.",
        });
      });

      it("refuses a line ending in a backslash", () => {
        expect(splitLine("cd a\\")).toEqual({
          kind: "refused",
          reason: "The line ends in a `\\`, which has nothing to escape.",
        });
      });

      it("refuses a line ending in a backslash inside a quote, naming the quote rather than the backslash", () => {
        // Both faults are one token with no end, and the quote is the one
        // that says where it started.

        expect(splitLine('"a\\')).toEqual({
          kind: "refused",
          reason: 'The `"` opened at column 1 is never closed.',
        });
      });
    });
  });

  describe("quoteToken()", () => {
    it("returns a value holding nothing that needs quoting unchanged", () => {
      expect(quoteToken("of:fid1:abcdefghijklmnop@space")).toBe(
        "of:fid1:abcdefghijklmnop@space",
      );
      expect(quoteToken("topics/3")).toBe("topics/3");
      expect(quoteToken("--json")).toBe("--json");
    });

    it("returns a value holding a separator in single quotes", () => {
      expect(quoteToken("a b")).toBe("'a b'");
    });

    it("returns the empty value as an empty pair of quotes", () => {
      expect(quoteToken("")).toBe("''");
    });

    it("returns a value holding a syntax character in single quotes", () => {
      // Neither value holds a separator or a reserved character, so each
      // rests on the syntax character alone. A fixture that also holds a
      // space passes whether or not the quote is in the set.

      expect(quoteToken('a"b')).toBe("'a\"b'");
      expect(quoteToken("a\\b")).toBe("'a\\b'");
    });

    it("returns a value holding a single quote in double quotes, its own quotes escaped", () => {
      expect(quoteToken("a'b")).toBe('"a\'b"');
      expect(quoteToken('it\'s "x"')).toBe('"it\'s \\"x\\""');
    });

    it("escapes a backslash in the double-quoted form", () => {
      expect(quoteToken("it's a\\b")).toBe('"it\'s a\\\\b"');
    });

    it("quotes a value holding a reserved character, wherever in the value it sits", () => {
      for (const character of RESERVED_CHARACTERS) {
        expect(quoteToken(`a${character}b`)).toBe(`'a${character}b'`);
        expect(quoteToken(`${character}ab`)).toBe(`'${character}ab'`);
      }
    });

    it("returns text that splits back into the value it was printed from, for every value the construction drives", () => {
      // What the two halves owe each other, held over a construction rather
      // than over a list: a listed set is a slice of the class, and the
      // values nobody lists are the ones that break a printer.
      //
      // One crossing it cannot reach, however long it runs: a value takes
      // the double-quoted form only where it holds a `'`, and no mark here
      // pairs one with a reserved character. The splitting case above
      // drives that crossing directly.

      const marks = [
        "",
        " ",
        "\t",
        "\n",
        "\r",
        "\v",
        "\f",
        "\u00a0",
        "\u2028",
        "\u2029",
        "\ufeff",
        "'",
        '"',
        "\\",
        "\\'",
        "'\"",
        "~",
        ".",
        "-",
        "..",
        "/",
        "@",
        ":",
        "%1",
        "€",
        "🍩",
        ...RESERVED_CHARACTERS,
      ];
      const values: string[] = [];
      for (const mark of marks) {
        values.push(mark, `a${mark}`, `${mark}b`, `a${mark}b`, mark + mark);
      }
      for (const value of values) {
        expect(splitLine(quoteToken(value))).toEqual({
          kind: "split",
          tokens: [value],
        });
      }
    });
  });

  describe("tailOfLine()", () => {
    it("returns the token the line ends in, and the head up to where it opens", () => {
      expect(tailOfLine("cd a b"))
        .toEqual({ before: ["cd", "a"], head: "cd a ", prefix: "b" });
    });

    it("returns the whole line as the token where it holds no separator", () => {
      expect(tailOfLine("cd"))
        .toEqual({ before: [], head: "", prefix: "cd" });
    });

    it("returns an empty prefix where the line ends in a separator", () => {
      expect(tailOfLine("cd "))
        .toEqual({ before: ["cd"], head: "cd ", prefix: "" });
    });

    it("returns an empty pair for the empty line", () => {
      expect(tailOfLine("")).toEqual({ before: [], head: "", prefix: "" });
    });

    it("returns a head carrying the separators exactly as they were written", () => {
      expect(tailOfLine("  cd   sl"))
        .toEqual({ before: ["cd"], head: "  cd   ", prefix: "sl" });
    });

    it("returns the token the split reads, not the run after the last separator", () => {
      // The finding this exists for. A backslash before a separator makes it a
      // character of its token, and the backslash then sits in the head rather
      // than in the run after it — so a reading that looked at that run alone
      // would find `sl`, call it an operand, and hand a completion the option's
      // value to rewrite.

      expect(tailOfLine("get --select a\\ sl")).toEqual({
        before: ["get", "--select"],
        head: "get --select ",
        prefix: "a sl",
      });
    });

    it("returns a quoted token as its value, opening where the quote does", () => {
      expect(tailOfLine("cd 'a b" + "'")).toEqual({
        before: ["cd"],
        head: "cd ",
        prefix: "a b",
      });
    });

    it("returns the tokens before it whole, and without it among them", () => {
      expect(tailOfLine("cd 'a b' c"))
        .toEqual({ before: ["cd", "a b"], head: "cd 'a b' ", prefix: "c" });
    });

    it("returns nothing where the line ends in a quote that never closes", () => {
      expect(tailOfLine("cd 'a b")).toBeUndefined();
    });

    it("returns nothing where the line ends in a backslash escaping nothing", () => {
      expect(tailOfLine("cd a\\")).toBeUndefined();
    });

    it("opens a token at every separator the split separates on", () => {
      // The claim ranges over a class, so the enumeration is derived from the
      // expression that defines it rather than sampled: `separatesTokens` is
      // the split's own test, and every code point is asked. A case listing
      // the separators it happened to think of would have said nothing about
      // the ones it did not — U+2028, U+2029 and U+FEFF among them.

      const separators = classified().separators;
      expect(separators.length).toBeGreaterThan(7);
      for (const separator of separators) {
        expect(tailOfLine(`cd${separator}sl`)).toEqual({
          before: ["cd"],
          head: `cd${separator}`,
          prefix: "sl",
        });
      }
    });

    it("opens a token at no character the split does not separate on", () => {
      // The other direction, and the one the case above does not reach: that
      // separators separate says nothing about whether anything else does.
      // It is the same scan with the predicate flipped, over the complement
      // the same pass already collected — so the pair closes the class in
      // both directions rather than in the one that is easy to ask.
      //
      // Two characters answer differently and are named rather than allowed
      // for: a quote opens a token nothing closes, so the line has no reading
      // at all. Every other character is data — the ones the grammar reserves
      // among them, and the backslash, which escapes the character after it
      // and still leaves one token.

      const { others } = classified();
      const refused: string[] = [];
      for (const character of others) {
        const tail = tailOfLine(`cd${character}sl`);
        if (tail === undefined) refused.push(character);
        else expect(tail.before).toEqual([]);
      }
      expect(refused.sort()).toEqual(['"', "'"]);
    });
  });
});
