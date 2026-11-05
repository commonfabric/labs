/**
 * Unit tests for how the tokens after a verb divide into options and operands.
 *
 * The parse itself is `cf`'s — `parseFlags` is what `Command` reads a flag on
 * a `cf` line through — so what these cases pin is the composition around it:
 * which table the parse is handed, which of its three answers become the
 * operands and in what order, and what a refusal says past the parser's own
 * sentence. A case that looks as though it tests the parser is testing that
 * the parser is the one reading the line, which is the decision this module
 * carries.
 *
 * The predicate beside the parse is asked against the parse in every case that
 * uses it. Two readings of a token that disagreed would put a name on a
 * listing that `cd` no longer takes, and the pair is the only place that can
 * be seen.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  optionFlag,
  optionNumber,
  type OptionReading,
  optionString,
  readOptions,
  readsAsOption,
  type VerbOption,
} from "../lib/shuttle/options.ts";

/** A verb that declares one option taking a value, for the cases that need one. */
const SELECT: VerbOption = {
  name: "select",
  type: "string",
  description: "Project the value to these fields.",
};

/** A verb that declares one option taking none. */
const ALL: VerbOption = { name: "all", description: "List every one." };

/** A verb that declares one option taking a number. */
const LIMIT: VerbOption = {
  name: "limit",
  type: "number",
  description: "Write this many rows.",
};

/**
 * A verb that declares one option it requires, which is the shape the shared
 * help row has to answer over. A line leaving a required option out is refused
 * whole, and a line asking what a verb takes is exactly such a line, so this is
 * the only declaration under which the row's standalone half can be seen.
 */
const REQUIRED_SELECT: VerbOption = {
  name: "select",
  type: "string",
  required: true,
  description: "Project the value to these fields.",
};

/**
 * Helper for the cases below, which is the operands `tokens` came back as, and
 * nothing where the reading was not a read.
 */
function operandsOf(reading: OptionReading): readonly string[] | undefined {
  return reading.kind === "read" ? reading.operands : undefined;
}

/**
 * Helper for the cases below, which is the reason `tokens` were refused for,
 * and nothing where they were not refused.
 */
function reasonOf(reading: OptionReading): string | undefined {
  return reading.kind === "refused" ? reading.reason : undefined;
}

/**
 * Helper for the cases below, which is the section `tokens` came back with:
 * the words past the bare `--`, and nothing where the verb opens no section.
 */
function sectionOf(reading: OptionReading): readonly string[] | undefined {
  return reading.kind === "read" ? reading.section : undefined;
}

describe("options", () => {
  describe("readOptions()", () => {
    it("returns every token as an operand where none opens with `-`", () => {
      expect(operandsOf(readOptions("get", ["topics/3", "title"])))
        .toEqual(["topics/3", "title"]);
    });

    it("returns `-` on its own as an operand", () => {
      expect(operandsOf(readOptions("cd", ["-"]))).toEqual(["-"]);
    });

    it("returns the operands in the order written, with an option between them removed", () => {
      expect(
        operandsOf(readOptions("get", ["a", "--select", "x", "b"], [SELECT])),
      ).toEqual(["a", "b"]);
    });

    it("returns a declared option's value under the name it was declared by", () => {
      const reading = readOptions("get", ["--select", "title"], [SELECT]);
      expect(reading.kind === "read" ? reading.options : undefined)
        .toEqual({ select: "title" });
    });

    it("returns a token after a bare `--` as an operand though it opens with `-`", () => {
      expect(operandsOf(readOptions("cd", ["--", "-x"]))).toEqual(["-x"]);
    });

    it("returns the operands before and after a bare `--` in the order written", () => {
      expect(operandsOf(readOptions("cd", ["a", "--", "-x"])))
        .toEqual(["a", "-x"]);
    });

    it("returns no operand for a bare `--` on its own, the token being the terminator", () => {
      expect(operandsOf(readOptions("cd", ["--"]))).toEqual([]);
    });

    it("returns a second `--` as an operand, only the first ending the options", () => {
      expect(operandsOf(readOptions("cd", ["--", "--"]))).toEqual(["--"]);
    });

    it("returns the help reading for `--help`, which no verb declared", () => {
      expect(readOptions("cd", ["--help"])).toEqual({ kind: "help" });
    });

    it("returns the help reading for `-h`", () => {
      expect(readOptions("cd", ["-h"])).toEqual({ kind: "help" });
    });

    it("returns the help reading carrying no operand, where operands were written beside it", () => {
      expect(readOptions("cd", ["--help", "slugs"])).toEqual({ kind: "help" });
    });

    it("returns the help reading though a declared option the line leaves out is required", () => {
      expect(readOptions("get", ["--help"], [REQUIRED_SELECT]))
        .toEqual({ kind: "help" });
    });

    it("returns a refusal for `--help` written beside another option, which is what `cf` answers", () => {
      expect(
        reasonOf(readOptions("get", ["--select", "x", "--help"], [SELECT])),
      )
        .toContain('Option "--help" cannot be combined with other options.');
    });

    it("returns a refusal naming the option nobody declared", () => {
      expect(reasonOf(readOptions("get", ["-x"])))
        .toBe(
          'Unknown option "-x". Did you mean option "-h"? `get --help` says ' +
            "what `get` takes, and a bare `--` writes every token after it " +
            "as an operand, whatever it opens with.",
        );
    });

    it("returns a refusal naming the bare `--` for a value that opens with `-`", () => {
      // The line the escape exists for. A negative number has no spelling
      // that does not open with `-`, so the person is told they wrote an
      // option, and what the parser's own sentence cannot know to offer is
      // the token that makes theirs an operand.

      expect(reasonOf(readOptions("set", ["label", "-5"])))
        .toBe(
          'Unknown option "-5". Did you mean option "-h"? `set --help` says ' +
            "what `set` takes, and a bare `--` writes every token after it " +
            "as an operand, whatever it opens with.",
        );
    });

    it("returns a refusal naming the verb's page, for the verb the line named", () => {
      expect(reasonOf(readOptions("ls", ["-x"])))
        .toContain("`ls --help` says what `ls` takes,");
    });

    it("returns a refusal where a declared option that takes a value is given none", () => {
      expect(reasonOf(readOptions("get", ["--select"], [SELECT])))
        .toContain('Missing value for option "--select".');
    });

    it("returns a refusal where a declared option that takes no value is given one", () => {
      expect(reasonOf(readOptions("verbs", ["--all=yes"], [ALL])))
        .toContain('Option "--all" doesn\'t take a value, but got "yes".');
    });

    it("returns a refusal for a token no option can be written as", () => {
      expect(reasonOf(readOptions("cd", ["---"])))
        .toContain('Invalid option "---".');
    });

    it("raises where the verb's table names a type nothing registered, which is no fact about the line", () => {
      expect(() =>
        readOptions("get", ["--pick", "1"], [{
          name: "pick",
          type: "nope",
          description: "Pick one.",
        }])
      ).toThrow('Unknown type "nope"');
    });
  });

  describe("optionString()", () => {
    it("returns what the line wrote for a declared option", () => {
      const reading = readOptions("get", ["--select", "title"], [SELECT]);
      const options = reading.kind === "read" ? reading.options : {};
      expect(optionString(options, "select")).toBe("title");
    });

    it("returns nothing for an option the line did not write", () => {
      expect(optionString({}, "select")).toBeUndefined();
    });

    it("raises where the option holds something other than a string", () => {
      // Reachable only from a table and a reading that disagree — the parser
      // refuses a value of the wrong type long before this — so the raise is
      // the fault it names rather than a refusal the line earned.

      expect(() => optionString({ select: 3 }, "select"))
        .toThrow(
          "The option `--select` is declared to hold a string and holds a " +
            "number.",
        );
    });
  });

  describe("optionFlag()", () => {
    it("returns `true` for an option the line wrote", () => {
      const reading = readOptions("verbs", ["--all"], [ALL]);
      const options = reading.kind === "read" ? reading.options : {};
      expect(optionFlag(options, "all")).toBe(true);
    });

    it("returns `false` for an option the line did not write", () => {
      expect(optionFlag({}, "all")).toBe(false);
    });

    it("raises where the option holds something other than a boolean", () => {
      expect(() => optionFlag({ all: "yes" }, "all"))
        .toThrow(
          "The option `--all` is declared to hold a boolean and holds a " +
            "string.",
        );
    });
  });

  describe("optionNumber()", () => {
    it("returns the number the line wrote for a declared option", () => {
      const reading = readOptions("ls", ["--limit", "5"], [LIMIT]);
      const options = reading.kind === "read" ? reading.options : {};
      expect(optionNumber(options, "limit")).toBe(5);
    });

    it("returns nothing for an option the line did not write", () => {
      expect(optionNumber({}, "limit")).toBeUndefined();
    });

    it("returns a negative number the parser took, leaving the range to the verb", () => {
      // The parser's type test is what a number is, not what a count is:
      // `--limit -1` parses. So a verb wanting a count refuses the rest in
      // its own words, and this is the reading that hands it one to refuse.

      const reading = readOptions("ls", ["--limit", "-1"], [LIMIT]);
      const options = reading.kind === "read" ? reading.options : {};
      expect(optionNumber(options, "limit")).toBe(-1);
    });

    it("raises where the option holds something other than a number", () => {
      expect(() => optionNumber({ limit: "5" }, "limit"))
        .toThrow(
          "The option `--limit` is declared to hold a number and holds a " +
            "string.",
        );
    });
    describe("a verb that opens a section", () => {
      // The one verb whose operands carry somebody else's flags. What these
      // cases turn on is that the two readings of a token opening with `-`
      // are chosen by the verb rather than by the token: the same line is an
      // operand list under one and a refusal under the other.

      it("hands a token opening with `-` past the first operand over unread", () => {
        expect(
          operandsOf(
            readOptions(
              "call",
              ["topics/3", "search", "--query", "milk"],
              [],
              true,
            ),
          ),
        ).toEqual(["topics/3", "search", "--query", "milk"]);
      });

      it("refuses that same line for a verb that opens none", () => {
        // The pair is the whole of the difference, and it is worth seeing as
        // a pair: `--query` belongs to the callable and no table here names
        // it, so a verb reading its own flags to the end of the line is a
        // verb that cannot carry a section.

        expect(
          reasonOf(
            readOptions("call", ["topics/3", "search", "--query", "milk"]),
          ),
        ).toBe(
          'Unknown option "--query". Did you mean option "--help"? `call ' +
            "--help` says what `call` takes, and a bare `--` writes every " +
            "token after it as an operand, whatever it opens with.",
        );
      });

      it("still refuses an option nobody declared written before the first operand", () => {
        // The stop is at the first operand and not at the verb, so the
        // options a `call` line writes for itself are still its own and are
        // still held to its table.

        expect(reasonOf(readOptions("call", ["--nope", "topics/3"], [], true)))
          .toBe(
            'Unknown option "--nope". Did you mean option "--help"? `call ' +
              "--help` says what `call` takes.",
          );
      });

      it("closes the section at the bare `--`, keeping the two sides apart", () => {
        const reading = readOptions(
          "call",
          ["topics/3", "search", "--query", "milk", "--", "tail"],
          [],
          true,
        );
        expect({
          operands: operandsOf(reading),
          section: sectionOf(reading),
        }).toEqual({
          operands: ["topics/3", "search", "--query", "milk"],
          section: ["tail"],
        });
      });

      it("joins those two sides for a verb that opens no section", () => {
        // The same `--` read the other way, which is the reading every other
        // verb wants: a bare `--` quotes an operand that opens with `-`
        // rather than closing anything.

        expect(operandsOf(readOptions("cd", ["a", "--", "-x"])))
          .toEqual(["a", "-x"]);
      });

      it("returns an empty section where the line wrote no `--`", () => {
        // Empty rather than absent, and the difference is a claim: a verb
        // that opens a section and was written none carries one that ran to
        // the end of what was typed.

        expect(sectionOf(readOptions("call", ["topics/3"], [], true)))
          .toEqual([]);
      });

      it("returns no section at all for a verb that opens none", () => {
        expect(sectionOf(readOptions("cd", ["a", "--", "-x"]))).toBeUndefined();
      });

      it("reads `--help` written before the first operand", () => {
        expect(readOptions("call", ["--help"], [], true))
          .toEqual({ kind: "help" });
      });

      it("hands `--help` written after the first operand to the section", () => {
        // The page a person asks for after the verb name is the callable's,
        // not this one's, so the option is not read here at all.

        expect(
          operandsOf(readOptions("call", ["topics/3", "--help"], [], true)),
        )
          .toEqual(["topics/3", "--help"]);
      });
    });
  });

  describe("readsAsOption()", () => {
    // The predicate and the parse have to agree about a token standing on its
    // own, since `operandForChild` offers a name on the predicate's word and
    // the dispatch reads that name back on the parse's. Each case asks both,
    // and what makes the pair a real question is that the two are separate
    // readings of one rule.

    const AGREEMENTS: readonly (readonly [string, boolean])[] = [
      ["-", false],
      ["", false],
      ["ordinary", false],
      ["..", false],
      ["x-", false],
      ["/@did:key:z6Mk/of:fid1:abcdefghijklmnop@space/-x", false],
      ["--", true],
      ["-x", true],
      ["-1", true],
      ["-h", true],
      ["---", true],
    ];

    for (const [token, option] of AGREEMENTS) {
      it(
        `returns \`${option}\` for \`${token}\`, which the parse ${
          option ? "keeps out of" : "returns among"
        } the operands`,
        () => {
          expect(readsAsOption(token)).toBe(option);
          const sole = operandsOf(readOptions("cd", [token]))?.[0];
          expect(sole).toBe(option ? undefined : token);
        },
      );
    }
  });
});
