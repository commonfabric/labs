import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseArgs } from "@std/cli/parse-args";

import {
  nearestDeclaredFlag,
  recordUndeclaredFlags,
  refuseFlagsWithoutValue,
  refuseUndeclaredFlags,
  undeclaredFlagMessage,
} from "../src/cli-flags.ts";
import { HarnessControlError } from "../src/control-errors.ts";

describe("cli-flags", () => {
  describe("nearestDeclaredFlag()", () => {
    it("returns the declared flag a misspelling most likely meant", () => {
      expect(
        nearestDeclaredFlag("allowed-tools", [
          "allow-skill-script",
          "allow-subagent-profile",
          "allow-tool",
        ]),
      ).toBe("allow-tool");
    });

    it("returns a flag one adjacent transposition away from a short name", () => {
      // Two substitutions apart, which a four-letter name is not allowed.
      expect(nearestDeclaredFlag("jsno", ["json", "device"])).toBe("json");
    });

    it("returns `undefined` when no declared flag is close", () => {
      expect(nearestDeclaredFlag("bogus", ["allow-tool", "prompt"]))
        .toBeUndefined();
    });

    it("returns `undefined` rather than a single-letter alias", () => {
      expect(nearestDeclaredFlag("x", ["h", "help"])).toBeUndefined();
    });

    it("returns a flag two edits from an eight-letter name, and none three edits from a seven-letter one", () => {
      // One edit is allowed for every four letters of the name.
      expect(nearestDeclaredFlag("alow-tol", ["allow-tool"])).toBe(
        "allow-tool",
      );
      expect(nearestDeclaredFlag("allowtl", ["allow-tool"])).toBeUndefined();
    });

    it("returns `undefined` rather than a flag of the opposite meaning", () => {
      expect(nearestDeclaredFlag("no-print-transcript", ["print-transcript"]))
        .toBeUndefined();
      expect(nearestDeclaredFlag("print-transcrpt", ["no-print-transcript"]))
        .toBeUndefined();
      expect(nearestDeclaredFlag("no-no-skill-catalog", ["no-skill-catalog"]))
        .toBeUndefined();
    });

    it("returns a negated flag for a slip that keeps the negation", () => {
      expect(nearestDeclaredFlag("no-skill-catalg", ["no-skill-catalog"]))
        .toBe("no-skill-catalog");
    });
  });

  describe("undeclaredFlagMessage()", () => {
    it("returns a sentence naming the flag and the declared flag it meant", () => {
      expect(
        undeclaredFlagMessage(
          "--allowed-tools",
          ["allow-tool"],
          "the batch CLI",
        ),
      ).toBe(
        "`--allowed-tools` is not a flag of the batch CLI. Did you mean " +
          "`--allow-tool`?",
      );
    });

    it("returns a sentence naming only the flag when no declared flag is close", () => {
      expect(undeclaredFlagMessage("-z", ["allow-tool"], "the console"))
        .toBe("`-z` is not a flag of the console.");
    });

    it("returns a sentence naming nothing for an argument that is not a flag name", () => {
      for (
        const argument of [
          "--Remember my password is hunter2",
          "---\ntitle: notes\n---",
          "- ",
          "--__proto__",
        ]
      ) {
        expect(undeclaredFlagMessage(argument, ["prompt"], "the batch CLI"))
          .toBe(
            "An argument starting with `-` is not a flag of the batch CLI. A " +
              "value starting with `-` needs the `--<flag>=<value>` spelling.",
          );
      }
    });
  });

  describe("recordUndeclaredFlags()", () => {
    it("records each undeclared flag once, by its name alone", () => {
      const undeclared: string[] = [];
      parseArgs(
        ["--api-key=sk-secret", "-z", "--api-key", "sk-other", "--prompt", "p"],
        { string: ["prompt"], unknown: recordUndeclaredFlags(undeclared) },
      );

      expect(undeclared).toEqual(["--api-key", "-z"]);
    });

    it("records a negated flag that no boolean declares", () => {
      const undeclared: string[] = [];
      parseArgs(["--no-transcript"], {
        boolean: ["print-transcript"],
        unknown: recordUndeclaredFlags(undeclared),
      });

      expect(undeclared).toEqual(["--no-transcript"]);
    });

    it("records a negative number standing alone as the flag `parseArgs()` reads it as", () => {
      const undeclared: string[] = [];
      parseArgs(["--port=8100", "-5x"], {
        string: ["port"],
        unknown: recordUndeclaredFlags(undeclared),
      });

      expect(undeclared).toEqual(["-5", "-x"]);
    });

    it("records a negated switch given a value by the name it was typed as", () => {
      // `parseArgs()` files `--no-x=true` under `x`, which nobody typed.
      const undeclared: string[] = [];
      parseArgs(["--no-skill-catalog=true"], {
        boolean: ["no-skill-catalog"],
        unknown: recordUndeclaredFlags(undeclared),
      });

      expect(undeclared).toEqual(["--no-skill-catalog"]);
    });

    it("leaves a dotted flag out of the parsed result, where it would write into a declared one", () => {
      const undeclared: string[] = [];
      const parsed = parseArgs(["--prompt", "hunter2", "--prompt.x", "y"], {
        string: ["prompt"],
        unknown: recordUndeclaredFlags(undeclared),
      });

      expect(parsed.prompt).toBe("hunter2");
      expect(undeclared).toEqual(["--prompt.x"]);
    });

    it("leaves positional arguments and undeclared flags in the parsed result", () => {
      const undeclared: string[] = [];
      const parsed = parseArgs(["--sandbox-runtime", "runsc", "some", "text"], {
        string: ["prompt"],
        unknown: recordUndeclaredFlags(undeclared),
      });

      expect(parsed._).toEqual(["some", "text"]);
      expect(parsed["sandbox-runtime"]).toBe("runsc");
      expect(undeclared).toEqual(["--sandbox-runtime"]);
    });
  });

  describe("refuseUndeclaredFlags()", () => {
    it("throws an `invalid-request` control error naming the first undeclared flag", () => {
      let thrown: unknown;
      try {
        refuseUndeclaredFlags(
          ["--allowed-tools", "--bogus"],
          ["allow-tool", "prompt"],
          "the batch CLI",
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(HarnessControlError);
      expect((thrown as HarnessControlError).code).toBe("invalid-request");
      expect((thrown as HarnessControlError).message).toBe(
        "`--allowed-tools` is not a flag of the batch CLI. Did you mean " +
          "`--allow-tool`?",
      );
    });

    it("returns without throwing when nothing is undeclared", () => {
      expect(() => refuseUndeclaredFlags([], ["prompt"], "the batch CLI"))
        .not.toThrow();
    });

    it("throws saying a declared switch takes no value", () => {
      expect(() =>
        refuseUndeclaredFlags(
          ["--no-skill-catalog"],
          ["no-skill-catalog"],
          "the batch CLI",
        )
      ).toThrow("`--no-skill-catalog` takes no value.");
    });
  });

  describe("refuseFlagsWithoutValue()", () => {
    /** The message `refuseFlagsWithoutValue()` throws for `argv`, if any. */
    const refusal = (argv: string[]): string | undefined => {
      try {
        refuseFlagsWithoutValue(argv, ["prompt", "port"]);
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(HarnessControlError);
        expect((error as HarnessControlError).code).toBe("invalid-request");
        return (error as Error).message;
      }
    };

    it("throws naming a flag followed by a word starting with `-`, and not the word", () => {
      for (
        const value of [
          "--Remember my password is hunter2",
          "---\ntitle: notes\n---\nbody",
          "- buy milk",
          "-1",
          "-",
        ]
      ) {
        expect(refusal(["--port", "8100", "--prompt", value])).toBe(
          "`--prompt` was given no value; a value starting with `-` needs " +
            "the `--prompt=<value>` spelling",
        );
      }
    });

    it("throws naming a flag with nothing after it, or only `--`", () => {
      expect(refusal(["--prompt"])).toBe("`--prompt` was given no value");
      expect(refusal(["--prompt", "--", "text"])).toBe(
        "`--prompt` was given no value",
      );
    });

    it("returns for values written with `=`, for other words, and for anything after `--`", () => {
      expect(
        refusal([
          "--prompt=--x",
          "--port",
          "8100",
          "--other",
          "--",
          "--prompt",
          "-y",
        ]),
      ).toBeUndefined();
    });
  });
});
