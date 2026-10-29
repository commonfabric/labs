import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import {
  EVERY_FLAG_TAKES_A_VALUE,
  parseReadSection,
  readSectionAsksVerbHelp,
  refuseProjectionBeforeSection,
  sectionUnits,
  sectionWithVerbHelp,
} from "../lib/verb-section.ts";
import { parseExecArgs } from "../lib/exec-schema.ts";
import { pieceDataCommand } from "../commands/piece.ts";
import { exec } from "../commands/exec.ts";

/**
 * The verb opens the callable's section and `--` closes it, so a projection
 * has one place to stand and two it does not. Before the verb it names
 * positions in a result nothing has identified; past the marker a verb's own
 * flag is read as a projection. Each refusal prints the line that works,
 * which is what carries a change that lands at once.
 *
 * The helper tests hold the refusals to firing on the right words; the parse
 * tests below are what prove the words reach them on a real command, which a
 * unit test of the helper alone cannot see.
 */
describe("verb-section", () => {
  /** The message a refusal carried, or "" where none was thrown. */
  function messageFrom(run: () => void): string {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  }

  /** The same, for a refusal raised from an async parse. */
  async function asyncMessageFrom(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  }

  describe("sectionUnits()", () => {
    it("returns a flag holding the word after it where that word is its value", () => {
      expect(sectionUnits(["--title", "--select"], EVERY_FLAG_TAKES_A_VALUE))
        .toStrictEqual([{ flag: "title", tokens: ["--title", "--select"] }]);
    });

    it("returns each flag alone where none of them spends a word", () => {
      expect(sectionUnits(["--draft", "--select", "a"], () => false))
        .toStrictEqual([
          { flag: "draft", tokens: ["--draft"] },
          { flag: "select", tokens: ["--select"] },
          { tokens: ["a"] },
        ]);
    });

    it("returns the `=` spelling alone, which carries its value inside itself", () => {
      expect(sectionUnits(["--select=a", "b"], EVERY_FLAG_TAKES_A_VALUE))
        .toStrictEqual([
          { flag: "select", tokens: ["--select=a"] },
          { tokens: ["b"] },
        ]);
    });

    it("returns a trailing flag alone, without weighing it against nothing", () => {
      // The spend is asked about a word, so it is asked only where one is
      // there — which is what lets every spend read `next` without a guard.
      const asked: string[] = [];
      const spend = (_flag: string, next: string) => {
        asked.push(next);
        return true;
      };
      expect(sectionUnits(["--select"], spend))
        .toStrictEqual([{ flag: "select", tokens: ["--select"] }]);
      expect(asked).toStrictEqual([]);
    });

    it("returns a bare `--` as a word rather than a flag named nothing", () => {
      expect(sectionUnits(["--", "x"], EVERY_FLAG_TAKES_A_VALUE))
        .toStrictEqual([{ tokens: ["--"] }, { tokens: ["x"] }]);
    });

    it("passes the word in question to the spend, which may decline it", () => {
      // `--json` takes a payload and still refuses a flag-shaped one, and only
      // the word itself says which case this is.
      const spend = (_flag: string, next: string) => !next.startsWith("--");
      expect(sectionUnits(["--json", "--select", "a"], spend)).toStrictEqual([
        { flag: "json", tokens: ["--json"] },
        { flag: "select", tokens: ["--select", "a"] },
      ]);
    });
  });

  describe("refuseProjectionBeforeSection()", () => {
    it("returns for a line that writes no projection before the verb", () => {
      expect(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "--piece",
          "board",
          "addTopic",
        ], {})
      ).not.toThrow();
      // Past the marker is where the grammar puts it, so the same flag is
      // untouched there.
      expect(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "addTopic",
          "--",
          "--select",
          "topic.title",
        ], {})
      ).not.toThrow();
    });

    it("leaves a projection the command never parsed to the callable", () => {
      // Cliffy's `stopEarly` ends option parsing at the verb, so a `--select`
      // written after it reached the verb's own parser and means whatever
      // that verb says it means. Answering it here would report a position it
      // was not in, and would take the word away from a verb that declares a
      // field of that name.
      expect(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "--piece",
          "board",
          "addTopic",
          "--select",
          "topic.title",
        ], {})
      ).not.toThrow();
    });

    it("lifts the parsed occurrence, not a later one inside the section", () => {
      // The same name on both sides: the first is what the command parsed and
      // the second is the verb's, so only the first moves.
      const message = messageFrom(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "--select",
          "topic.title",
          "addTopic",
          "--select",
          "mine",
        ], { select: "topic.title" })
      );
      expect(message).toContain(
        "write:    cf piece call addTopic --select mine -- --select topic.title",
      );
    });

    it("writes the corrected line with the projection past a new marker", () => {
      const message = messageFrom(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "--piece",
          "board",
          "--select",
          "topic.title",
          "addTopic",
          '{"title":"Ship it"}',
        ], { select: "topic.title" })
      );
      expect(message).toContain(
        `written:  cf piece call --piece board --select topic.title addTopic ` +
          `'{"title":"Ship it"}'`,
      );
      expect(message).toContain(
        `write:    cf piece call --piece board addTopic '{"title":"Ship it"}' ` +
          `-- --select topic.title`,
      );
    });

    it("moves the old marker's words into the section the verb opens", () => {
      // The whole old grammar in one line: the projection led and the verb's
      // own flags followed a marker. Correcting one without the other would
      // print a line that is refused in turn.
      const message = messageFrom(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "--piece",
          "board",
          "--select",
          "item@",
          "addItem",
          "--",
          "--title",
          "Login rewrite",
        ], { select: "item@" })
      );
      expect(message).toContain(
        `write:    cf piece call --piece board addItem --title 'Login rewrite' ` +
          `-- --select item@`,
      );
      expect(message).not.toContain(
        "write:    cf piece call --piece board -- ",
      );
    });

    it("reads the `=` spelling, which carries its value inside the token", () => {
      const message = messageFrom(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "--select=topic.title",
          "addTopic",
        ], { select: "topic.title" })
      );
      expect(message).toContain(
        "write:    cf piece call addTopic -- --select=topic.title",
      );
    });

    it("names every read option the line wrote", () => {
      const message = messageFrom(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "--filter",
          ".done == false",
          "--select",
          "title",
          "listItems",
        ], { filter: ".done == false", select: "title" })
      );
      expect(message).toContain("--filter and --select shape the result");
    });

    it("names what opens the section, which differs between the two commands", () => {
      expect(
        messageFrom(() =>
          refuseProjectionBeforeSection("exec", "the mounted file", [
            "--select",
            "id",
            "/tmp/search.tool",
          ], { select: "id" })
        ),
      ).toContain("written after the mounted file");
      expect(
        messageFrom(() =>
          refuseProjectionBeforeSection("piece call", "the verb", [
            "--select",
            "id",
            "search",
          ], { select: "id" })
        ),
      ).toContain("written after the verb");
    });

    it("throws a ValidationError, so the CLI reports it as a usage error", () => {
      expect(() =>
        refuseProjectionBeforeSection("piece call", "the verb", [
          "--select",
          "a",
          "v",
        ], { select: "a" })
      ).toThrow(ValidationError);
    });
  });

  describe("parseReadSection()", () => {
    it("reads the three read options and nothing else", async () => {
      expect(
        await parseReadSection("piece call", ["v", "--", "--select", "a,b"], [
          "--select",
          "a,b",
        ]),
      ).toEqual({ select: "a,b" });
      expect(await parseReadSection("piece call", ["v"], [])).toEqual({});
    });

    it("refuses a verb's own flag past the marker, and drops the marker", async () => {
      // The migration from the spelling this replaces: the words belong in
      // the section the verb opened, so the corrected line takes the marker
      // out rather than describing where they go.
      const message = await asyncMessageFrom(() =>
        parseReadSection("piece call", [
          "--piece",
          "board",
          "search",
          "--",
          "--query",
          "milk",
        ], ["--query", "milk"])
      );
      expect(message).toContain('"--query" is not a read option');
      expect(message).toContain(
        "written:  cf piece call --piece board search -- --query milk",
      );
      expect(message).toContain(
        "write:    cf piece call --piece board search --query milk",
      );
      // A verb field is not a misspelled read option, so no name is offered.
      expect(message).not.toContain("Did you mean");
    });

    it("corrects a misspelled read option in place, keeping the marker", async () => {
      const message = await asyncMessageFrom(() =>
        parseReadSection("piece call", ["v", "--", "--selct", "a"], [
          "--selct",
          "a",
        ])
      );
      expect(message).toContain('Did you mean "--select"?');
      expect(message).toContain("write:    cf piece call v -- --select a");
    });

    it("corrects the `=` spelling with the caller's value still attached", async () => {
      const message = await asyncMessageFrom(() =>
        parseReadSection("piece call", ["v", "--", "--selct=a,b"], [
          "--selct=a,b",
        ])
      );
      expect(message).toContain("write:    cf piece call v -- --select=a,b");
    });

    it("corrects the occurrence past the marker, not one before it", async () => {
      // Nothing reserves a name, so the same word may be a field of the verb
      // in the section and a misspelled read option past the marker. Only the
      // second is this door's, and rewriting the first prints a line that
      // fails exactly as the one the caller wrote did.
      const message = await asyncMessageFrom(() =>
        parseReadSection(
          "piece call",
          ["add", "--selct", "verb-value", "--", "--selct", "a"],
          ["--selct", "a"],
        )
      );
      expect(message).toContain(
        "write:    cf piece call add --selct verb-value -- --select a",
      );
    });

    it("refuses a bare word past the marker", async () => {
      const message = await asyncMessageFrom(() =>
        parseReadSection("piece call", ["v", "--", "payload"], ["payload"])
      );
      expect(message).toContain('"payload" is not a read option');
    });

    it("refuses a second marker, which closes nothing", async () => {
      const message = await asyncMessageFrom(() =>
        parseReadSection(
          "piece call",
          ["v", "--", "--select", "a", "--", "--x"],
          ["--select", "a", "--", "--x"],
        )
      );
      expect(message).toContain("One boundary follows the callable's section");
      expect(message).toContain("write:    cf piece call v -- --select a --x");
    });

    it("refuses --schema beside --select from the declaration itself", async () => {
      // Not a rule written twice: the same `conflicts` the command declares
      // is what decides it on both sides of the marker.
      const message = await asyncMessageFrom(() =>
        parseReadSection(
          "piece call",
          ["v", "--", "--select", "a", "--schema", "{}"],
          ["--select", "a", "--schema", "{}"],
        )
      );
      expect(message).toContain("conflicts");
    });

    it("refuses a read option written with no value", async () => {
      const message = await asyncMessageFrom(() =>
        parseReadSection("piece call", ["v", "--", "--select"], ["--select"])
      );
      expect(message).not.toBe("");
    });
  });

  describe("readSectionAsksVerbHelp()", () => {
    it("recognizes the two spellings that reach the verb's own page", () => {
      expect(readSectionAsksVerbHelp(["--help"])).toBe(true);
      expect(readSectionAsksVerbHelp(["--help", "--json"])).toBe(true);
    });

    it("leaves everything else to the read step", () => {
      expect(readSectionAsksVerbHelp([])).toBe(false);
      expect(readSectionAsksVerbHelp(["--select", "a"])).toBe(false);
      // `--help` with a value is the verb's `help` FIELD, which the section
      // holds; it is not this command's page either way.
      expect(readSectionAsksVerbHelp(["--help", "x"])).toBe(false);
    });
  });

  describe("sectionWithVerbHelp()", () => {
    it("returns the help words at the head of a section that opens with a field", () => {
      expect(sectionWithVerbHelp([], ["--help"])).toEqual(["--help"]);
      expect(sectionWithVerbHelp(["--title", "x"], ["--help", "--json"]))
        .toEqual(["--help", "--json", "--title", "x"]);
    });

    it("returns a verb keyword still first, ahead of the help words", () => {
      expect(sectionWithVerbHelp(["invoke"], ["--help"]))
        .toEqual(["invoke", "--help"]);
      expect(sectionWithVerbHelp(["run"], ["--help", "--json"]))
        .toEqual(["run", "--help", "--json"]);
    });

    it("composes a section the callable's parser reads as a help request", () => {
      // The two halves are separately correct and can still disagree: the
      // callable reads `--help` at the head of its section or directly after
      // the keyword, and ahead of the keyword it is an argument to `--help`
      // — which a verb declaring no `help` field refuses outright.
      const spec = {
        callableKind: "handler",
        defaultVerb: "invoke",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      } as const;
      for (const section of [[], ["invoke"]]) {
        expect(
          parseExecArgs(spec, sectionWithVerbHelp(section, ["--help"])),
        ).toMatchObject({ showHelp: true, showHelpJson: false });
        expect(
          parseExecArgs(
            spec,
            sectionWithVerbHelp(section, ["--help", "--json"]),
          ),
        ).toMatchObject({ showHelp: true, showHelpJson: true });
      }
    });
  });

  describe("on the commands that have a callable section", () => {
    /**
     * Parse `args` and return what cliffy printed.
     *
     * A `ValidationError` reaches the caller as help output plus an exit, so
     * the refusal is read where a caller reads it — off stderr — rather than
     * as a thrown value. Same idiom as `section-marker.test.ts`.
     */
    async function outputFrom(
      // deno-lint-ignore no-explicit-any
      command: { parse: (args: string[]) => Promise<any> },
      args: string[],
    ): Promise<{ text: string; exitCode: number | null }> {
      const originalExit = Deno.exit;
      const originalLog = console.log;
      const originalError = console.error;
      const written: string[] = [];
      let exitCode: number | null = null;
      Deno.exit = ((code?: number): never => {
        exitCode = code ?? 0;
        throw new Error("exit sentinel");
      }) as typeof Deno.exit;
      console.log = (...parts: unknown[]) => written.push(parts.join(" "));
      console.error = (...parts: unknown[]) => written.push(parts.join(" "));
      try {
        await command.parse(args);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "exit sentinel") {
          written.push(String(error));
        }
      } finally {
        Deno.exit = originalExit;
        console.log = originalLog;
        console.error = originalError;
      }
      return { text: written.join("\n"), exitCode };
    }

    it("refuses a projection before the verb on `call`", async () => {
      const { text, exitCode } = await outputFrom(
        pieceDataCommand("call"),
        [
          "--piece",
          "board",
          "--select",
          "topic.title",
          "addTopic",
        ],
      );
      expect(text).toContain("--select shapes the result");
      expect(text).toContain(
        "write:    cf piece call --piece board addTopic -- --select topic.title",
      );
      expect(exitCode).toBe(2);
    });

    it("refuses a projection before the mounted file on `exec`", async () => {
      const { text, exitCode } = await outputFrom(exec, [
        "--select",
        "id,title",
        "/tmp/search.tool",
        "--query",
        "milk",
      ]);
      expect(text).toContain("--select shapes the result");
      expect(text).toContain(
        "write:    cf exec /tmp/search.tool --query milk -- --select id,title",
      );
      expect(exitCode).toBe(2);
    });

    it("leaves a projection after the verb to the callable's own parser", async () => {
      // It must reach the action and get past the grammar, so the refusal it
      // meets is about the identity it never named. `undeclaredFlagError` is
      // what answers it once a verb is resolved, with that verb's vocabulary
      // in hand.
      const { text } = await outputFrom(
        pieceDataCommand("call"),
        [
          "--piece",
          "board",
          "addTopic",
          "--select",
          "topic.title",
        ],
      );
      expect(text).not.toContain("shapes the result");
      expect(text).toContain("--identity");
    });

    it("refuses a verb's own flag past the marker on `call`", async () => {
      const { text } = await outputFrom(
        pieceDataCommand("call"),
        [
          "--piece",
          "board",
          "search",
          "--",
          "--query",
          "milk",
        ],
      );
      expect(text).toContain('"--query" is not a read option');
      expect(text).toContain(
        "write:    cf piece call --piece board search --query milk",
      );
    });

    it("lets a projection past the marker through to the read step", async () => {
      // It must reach the action, so the refusal it meets is about the
      // identity it never named rather than about the grammar.
      const { text } = await outputFrom(
        pieceDataCommand("call"),
        [
          "--piece",
          "board",
          "addTopic",
          "--",
          "--select",
          "topic.title",
        ],
      );
      expect(text).not.toContain("is not a read option");
      expect(text).not.toContain("shapes the result");
    });

    it("still refuses --no-wait beside a projection, now read past the marker", async () => {
      // The flags that decide this used to arrive on the options object and
      // now arrive from the read section, so the refusal has to be re-read
      // from where they land or it silently stops firing — and a detached
      // exit would return an unprojected value.
      const { text } = await outputFrom(
        pieceDataCommand("call"),
        [
          "--piece",
          "board",
          "--no-wait",
          "addTopic",
          "--",
          "--select",
          "topic.title",
        ],
      );
      expect(text).toContain("--select");
      expect(text).toContain("receipt readback that --no-wait skips");
    });

    it("reports a malformed projection as a data error, not a grammar one", async () => {
      const { text } = await outputFrom(
        pieceDataCommand("call"),
        [
          "--piece",
          "board",
          "addTopic",
          "--",
          "--select",
          "a..b",
        ],
      );
      expect(text).toContain('Invalid --select field path "a..b"');
    });
  });
});
