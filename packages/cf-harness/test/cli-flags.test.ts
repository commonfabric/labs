import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseArgs } from "@std/cli/parse-args";

import {
  nearestDeclaredFlag,
  recordUndeclaredFlags,
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

    it("records no negative number, leaving the flag it follows empty", () => {
      const undeclared: string[] = [];
      const parsed = parseArgs(["--port", "-1"], {
        string: ["port"],
        unknown: recordUndeclaredFlags(undeclared),
      });

      expect(undeclared).toEqual([]);
      expect(parsed.port).toBe("");
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
  });
});
