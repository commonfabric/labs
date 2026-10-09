import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  parseShellCommandSegments,
  suggestionForPatternUserCommand,
} from "./pattern-user-post-bash.ts";

describe("pattern-user-post-bash", () => {
  describe("suggestionForPatternUserCommand()", () => {
    it("warns when a new piece omits attached tests", () => {
      expect(
        suggestionForPatternUserCommand("cf piece new main.tsx"),
      ).toContain("No tests were attached");
    });

    it("warns when a source update omits attached tests", () => {
      expect(
        suggestionForPatternUserCommand("cf piece setsrc main.tsx --piece ID"),
      ).toContain("No tests were attached");
    });

    it("reminds the agent that attached tests still need to run", () => {
      expect(
        suggestionForPatternUserCommand(
          "cf piece new main.tsx --test main.test.tsx",
        ),
      ).toContain("The command attaches tests for packaging");
    });

    it("does not count a bare trailing test option as an attachment", () => {
      for (
        const command of [
          "cf piece new main.tsx --test",
          "cf piece new main.tsx --test 2>/dev/null",
          "cf piece new main.tsx --test >output",
          "cf piece new main.tsx --test | head -1",
          'cf piece new main.tsx --test=""',
        ]
      ) {
        expect(suggestionForPatternUserCommand(command)).toContain(
          "No tests were attached",
        );
      }
    });

    it("accepts explicit and escaped test paths", () => {
      for (
        const command of [
          "cf piece new main.tsx --test=-smoke.test.tsx",
          String.raw`cf piece new main.tsx --test=\#smoke.test.tsx`,
          String.raw`cf piece new main.tsx --test \>smoke.test.tsx`,
        ]
      ) {
        expect(suggestionForPatternUserCommand(command)).toContain(
          "The command attaches tests for packaging",
        );
      }
    });

    it("does not treat a malformed diagnostic deployment as successful", () => {
      const suggestion = suggestionForPatternUserCommand(
        "cf piece new ./main.test.tsx --test",
      );

      expect(suggestion).toContain("No tests were attached");
      expect(suggestion).not.toContain("Test pattern deployed");
    });

    it("checks every deployment in a compound command", () => {
      const suggestion = suggestionForPatternUserCommand(
        "cf piece setsrc a.tsx --test a.test.tsx --piece A; " +
          "cf piece setsrc b.tsx --piece B",
      );

      expect(suggestion).toContain("The command attaches tests for packaging");
      expect(suggestion).toContain("No tests were attached");
    });

    it("checks every deployment separated by a background operator", () => {
      for (
        const command of [
          "cf piece setsrc a.tsx --test a.test.tsx --piece A & cf piece setsrc b.tsx --piece B",
          "cf piece setsrc a.tsx --piece A & cf piece setsrc b.tsx --test b.test.tsx --piece B",
        ]
      ) {
        const suggestion = suggestionForPatternUserCommand(command);
        expect(suggestion).toContain(
          "The command attaches tests for packaging",
        );
        expect(suggestion).toContain("No tests were attached");
      }
    });

    it("checks every deployment separated by a pipeline", () => {
      const suggestion = suggestionForPatternUserCommand(
        "cf piece setsrc a.tsx --test a.test.tsx --piece A | " +
          "cf piece setsrc b.tsx --piece B",
      );

      expect(suggestion).toContain("The command attaches tests for packaging");
      expect(suggestion).toContain("No tests were attached");
    });

    it("ignores deployments inside shell comments", () => {
      const suggestion = suggestionForPatternUserCommand(
        "cf piece new main.tsx --test main.test.tsx " +
          "# old note & cf piece setsrc old.tsx",
      );

      expect(suggestion).toContain("The command attaches tests for packaging");
      expect(suggestion).not.toContain("No tests were attached");
    });

    it("checks background deployments inside command substitutions", () => {
      const suggestion = suggestionForPatternUserCommand(
        'result="$(cf piece setsrc a.tsx --test a.test.tsx --piece A & ' +
          'cf piece setsrc b.tsx --piece B)"',
      );

      expect(suggestion).toContain("The command attaches tests for packaging");
      expect(suggestion).toContain("No tests were attached");
    });

    it("checks deployments inside backtick command substitutions", () => {
      const suggestion = suggestionForPatternUserCommand(
        "result=`cf piece setsrc main.tsx --piece ID`",
      );

      expect(suggestion).toContain("No tests were attached");
    });

    it("checks deployments inside top-level subshells", () => {
      const suggestion = suggestionForPatternUserCommand(
        "(cf piece setsrc a.tsx --test a.test.tsx --piece A & " +
          "cf piece setsrc b.tsx --piece B)",
      );

      expect(suggestion).toContain("The command attaches tests for packaging");
      expect(suggestion).toContain("No tests were attached");
    });

    it("ignores commands in heredoc bodies", () => {
      for (
        const opener of [
          "cat <<EOF",
          "cat <<'EOF'",
          'cat <<"EOF"',
          String.raw`cat <<\EOF`,
          'cat <<E"OF"',
        ]
      ) {
        const suggestion = suggestionForPatternUserCommand(
          `${opener}\ncf piece new ignored.tsx\nEOF\n` +
            "cf piece new main.tsx --test main.test.tsx",
        );

        expect(suggestion).toContain(
          "The command attaches tests for packaging",
        );
        expect(suggestion).not.toContain("No tests were attached");
      }
    });

    it("preserves ordinary backslashes in double-quoted delimiters", () => {
      const suggestion = suggestionForPatternUserCommand(
        String.raw`cat <<"E\OF"` +
          "\ncf piece new ignored.tsx\n" +
          String.raw`E\OF` +
          "\ncf piece new main.tsx --test main.test.tsx",
      );

      expect(suggestion).toContain("The command attaches tests for packaging");
      expect(suggestion).not.toContain("No tests were attached");
    });

    it("ignores heredoc markers in comments after shell operators", () => {
      expect(
        suggestionForPatternUserCommand(
          "true;# example: cat <<NEVER\ncf piece new main.tsx",
        ),
      ).toContain("No tests were attached");
    });

    it("ignores heredoc bodies inside double-quoted substitutions", () => {
      for (
        const command of [
          'result="$(cat <<EOF\ncf piece new ignored.tsx\nEOF\n)"',
          'result="`cat <<EOF\ncf piece new ignored.tsx\nEOF\n`"',
        ]
      ) {
        const suggestion = suggestionForPatternUserCommand(
          command + "\ncf piece new main.tsx --test main.test.tsx",
        );

        expect(suggestion).toContain(
          "The command attaches tests for packaging",
        );
        expect(suggestion).not.toContain("No tests were attached");
      }
    });

    it("checks substitutions in expandable heredoc bodies", () => {
      for (
        const body of [
          "$(cf piece new main.tsx)",
          "$(\ncf piece new main.tsx\n)",
          "$(\n# ) explanatory comment\ncf piece new main.tsx\n)",
          "$(\necho `echo )`\ncf piece new main.tsx\n)",
        ]
      ) {
        expect(
          suggestionForPatternUserCommand(`cat <<EOF\n${body}\nEOF`),
        ).toContain("No tests were attached");
      }
    });

    it("does not mistake arithmetic shifts for heredocs", () => {
      for (
        const expression of [
          "$((1 << 2))",
          "$((1<<2))",
          "$((\n1 << 2\n))",
        ]
      ) {
        expect(
          suggestionForPatternUserCommand(
            `mask=${expression}\ncf piece new main.tsx`,
          ),
        ).toContain("No tests were attached");
      }
    });

    it("does not mistake multiline quoted text for a heredoc", () => {
      expect(
        suggestionForPatternUserCommand(
          'echo "literal\n<<NEVER\n"\ncf piece new main.tsx',
        ),
      ).toContain("No tests were attached");
    });

    it("checks substitutions used as redirection targets", () => {
      const suggestion = suggestionForPatternUserCommand(
        'echo >"$(cf piece setsrc main.tsx --piece ID)"',
      );

      expect(suggestion).toContain("No tests were attached");
    });

    it("ignores substitutions quoted literally in redirection targets", () => {
      for (
        const command of [
          "echo >'$(cf piece new ignored.tsx)'",
          "echo >'`cf piece new ignored.tsx`'",
        ]
      ) {
        expect(suggestionForPatternUserCommand(command)).toBe("");
      }
    });

    it("ignores test-like text in quoted arguments and comments", () => {
      for (
        const command of [
          'cf piece new main.tsx "--test fake.test.tsx"',
          "cf piece new main.tsx # --test fake.test.tsx",
        ]
      ) {
        expect(suggestionForPatternUserCommand(command)).toContain(
          "No tests were attached",
        );
      }
    });

    it("keeps a line-continuation deployment in one command segment", () => {
      const suggestion = suggestionForPatternUserCommand(
        "cf piece new main.tsx \\\n  --test main.test.tsx",
      );

      expect(suggestion).toContain("The command attaches tests for packaging");
      expect(suggestion).not.toContain("No tests were attached");
    });

    it("keeps an even backslash run from continuing the next line", () => {
      const suggestion = suggestionForPatternUserCommand(
        "cf piece setsrc a.tsx --test a.test.tsx --piece A \\\\\n" +
          "cf piece setsrc b.tsx --piece B",
      );

      expect(suggestion).toContain("The command attaches tests for packaging");
      expect(suggestion).toContain("No tests were attached");
    });

    it("allows a test pattern to be the executable diagnostic entry", () => {
      for (
        const command of [
          "cf piece new ./main.test.tsx",
          "cf piece new --url https://host/space ./main.test.tsx",
          "cf piece new ./main.test.tsx -u https://host/space",
        ]
      ) {
        expect(suggestionForPatternUserCommand(command)).toContain(
          "Test pattern deployed as the executable diagnostic entry",
        );
      }
    });

    it("only exempts the positional diagnostic entry", () => {
      for (
        const command of [
          "cf piece new main.tsx --repository mirror.test.tsx",
          "cf piece new main.tsx 2>deploy.test.tsx",
        ]
      ) {
        const suggestion = suggestionForPatternUserCommand(command);
        expect(suggestion).toContain("No tests were attached");
        expect(suggestion).not.toContain("Test pattern deployed");
      }
    });

    it("keeps the recomputation guidance for state writes", () => {
      expect(
        suggestionForPatternUserCommand("cf cell set --piece ID title"),
      ).toContain("Run 'cf piece step'");
    });

    it("says nothing for a verb under a noun that does not carry it", () => {
      // The nouns and the verbs are matched as pairs, not as two independent
      // sets. Matched separately, every guided verb answers under every noun,
      // and the hook advises on lines the CLI refuses: `cf space set` gets the
      // recomputation note and `cf cell new` the deployment one.
      for (
        const command of [
          "cf space set x",
          "cf space new main.tsx",
          "cf space inspect --piece ID",
          "cf cell new main.tsx",
          "cf cell setsrc main.tsx",
          "cf piece set --piece ID title",
        ]
      ) {
        expect(suggestionForPatternUserCommand(command), command).toBe("");
      }
    });

    it("advises on both spellings of a command that moved", () => {
      // The bare `set` moved to `cf cell` and still answers at its old
      // spelling until its removal date, so the guidance follows the command
      // rather than the spelling a caller reached it by.
      for (const spelling of ["cf cell set", "cf set"]) {
        expect(
          suggestionForPatternUserCommand(`${spelling} --piece ID title`),
          spelling,
        ).toContain("State set.");
      }
    });

    it("still ignores a bare cf whose next word carries no guidance", () => {
      // The widened match must not swallow every `cf` invocation, and must not
      // claim a verb this hook has nothing to say about.
      expect(suggestionForPatternUserCommand("cf test")).toBe("");
      expect(suggestionForPatternUserCommand("cf wish '#topic'")).toBe("");
      expect(suggestionForPatternUserCommand("cf cell get --piece ID title")).toBe("");
    });

    it("returns no suggestion for unrelated commands", () => {
      expect(suggestionForPatternUserCommand("git status")).toBe("");
    });
  });

  describe("parseShellCommandSegments()", () => {
    it("does not split quoted or escaped ampersands", () => {
      expect(
        parseShellCommandSegments(String.raw`echo "a & b" & echo a\&b`),
      ).toEqual([["echo", "a & b"], ["echo", "a&b"]]);
    });

    it("does not split file-descriptor redirections", () => {
      expect(
        parseShellCommandSegments("one 2>&1; two >&2; three &>output"),
      ).toEqual([["one"], ["two"], ["three"]]);
    });

    it("preserves logical and line separators", () => {
      expect(
        parseShellCommandSegments("one && two || three;\r\nfour"),
      ).toEqual([["one"], ["two"], ["three"], ["four"]]);
    });
  });
});
