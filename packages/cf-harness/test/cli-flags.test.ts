import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseArgs } from "@std/cli/parse-args";

import { fromFileUrl, join, relative } from "@std/path";

import {
  argvHolds,
  nearestDeclaredFlag,
  recordUndeclaredFlags,
  refuseFlagsWithoutValue,
  refuseUndeclaredFlags,
  undeclaredFlagMessage,
} from "../src/cli-flags.ts";
import { HarnessControlError } from "../src/control-errors.ts";

/** Every TypeScript source under `directory`, tests and built pages aside. */
async function* walkSources(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      if (!["test", "dist", "public", "fixtures"].includes(entry.name)) {
        yield* walkSources(path);
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield path;
    }
  }
}

/**
 * The text of a call's arguments, from `start`, just past its opening
 * parenthesis, to the parenthesis that closes it.
 */
const callText = (text: string, start: number): string => {
  let depth = 1;
  let index = start;
  while (depth > 0 && index < text.length) {
    if (text[index] === "(") depth += 1;
    if (text[index] === ")") depth -= 1;
    index += 1;
  }
  return text.slice(start, index);
};

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
          "-15",
          "--5x",
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

    it("records a word after a single dash whole, not letter by letter", () => {
      const undeclared: string[] = [];
      parseArgs(["--port=8100", "-5x", "-hidden", "-15"], {
        string: ["port"],
        boolean: ["help"],
        alias: { h: "help" },
        unknown: recordUndeclaredFlags(undeclared),
      });

      expect(undeclared).toEqual(["-5x", "-hidden", "-15"]);
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

  describe("argvHolds()", () => {
    it("returns whether one of the spellings stands as a word of its own before `--`", () => {
      const spellings = ["--help", "-h"];

      expect(argvHolds(["--port", "1", "-h"], spellings)).toBe(true);
      expect(argvHolds(["--help"], spellings)).toBe(true);
      expect(argvHolds(["--store", "-hidden"], spellings)).toBe(false);
      expect(argvHolds(["--prompt=-h"], spellings)).toBe(false);
      expect(argvHolds(["--", "--help"], spellings)).toBe(false);
    });
  });

  describe("every parseArgs() over a caller's arguments in the package", () => {
    it("records the flags it does not declare and refuses them", async () => {
      // Without a callback, a dotted flag makes `parseArgs()` throw a
      // TypeError quoting the value of the flag before the dot, and without
      // the refusal an undeclared flag goes unapplied.
      const root = fromFileUrl(new URL("..", import.meta.url));
      const unrefused: string[] = [];
      for (const tree of ["src", "console", "scripts", "audit"]) {
        for await (const file of walkSources(join(root, tree))) {
          const text = await Deno.readTextFile(file);
          for (const call of text.matchAll(/\bparseArgs\((?!\))/g)) {
            const recorded = callText(text, call.index + call[0].length)
              .match(/unknown: recordUndeclaredFlags\((\w+)\)/)?.[1];
            if (
              recorded === undefined ||
              !new RegExp(`refuseUndeclaredFlags\\(\\s*${recorded}\\b`).test(
                text,
              )
            ) {
              unrefused.push(relative(root, file));
            }
          }
        }
      }

      expect(unrefused).toEqual([]);
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
