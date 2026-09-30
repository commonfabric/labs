/**
 * Unit tests for how the verbs are written down: the line `help` lists one on,
 * and the page `<verb> --help` writes.
 *
 * Every case drives the layout over verbs of its own rather than over the ones
 * shuttle has, so what is under test is the form and not the wording of any
 * verb: a summary reworded moves nothing here, and a column that stopped
 * lining up moves everything. What the real verbs say is asked in
 * `shuttle-verbs.serial.test.ts`, where the table that holds it is.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  renderVerbList,
  renderVerbPage,
  type VerbHelp,
} from "../lib/shuttle/help.ts";
import { readOptions, type VerbOption } from "../lib/shuttle/options.ts";

/**
 * The verbs every case below lays out. `help [<verb>]` is the longest usage of
 * the three, which is what the column is measured from, and no summary is a
 * substring of a usage, so a case reading one off a line reads it where it was
 * written.
 */
const VERBS: readonly VerbHelp[] = [
  { usage: "ls", summary: "Lists.", detail: "One." },
  { usage: "cd <ref>", summary: "Moves.", detail: "Two." },
  { usage: "help [<verb>]", summary: "Explains.", detail: "Three." },
];

/** The column {@link VERBS} puts a summary in: the longest usage, and a gap. */
const COLUMN = "help [<verb>]".length + 2;

/**
 * A verb declaring two options, one of them aliased, for the cases that read
 * an options block. The aliased one is the longer spelling, so a case reading
 * the column reads it off the row that set it.
 */
const WITH_OPTIONS: VerbHelp = {
  usage: "get [<ref>]",
  summary: "Reads.",
  detail: "Five.",
  options: [
    {
      name: "filter",
      type: "string",
      placeholder: "pred",
      description: "Keeps what matches.",
    },
    {
      name: "all",
      aliases: ["a"],
      type: "string",
      placeholder: "fields",
      description: "Keeps everything.",
    },
  ],
};

describe("help", () => {
  describe("renderVerbList()", () => {
    const LINES = renderVerbList(VERBS).split("\n");
    const ROWS = LINES.slice(0, VERBS.length);

    it("returns one row per verb, in the order given", () => {
      expect(ROWS.map((row) => row.split("  ")[0]))
        .toEqual(["ls", "cd <ref>", "help [<verb>]"]);
    });

    it("returns every summary starting at the one column", () => {
      expect(ROWS.map((row) => row.slice(COLUMN)))
        .toEqual(["Lists.", "Moves.", "Explains."]);
    });

    it("returns a column measured from the longest usage, so a longer one moves every summary", () => {
      const wider = [...VERBS, {
        usage: "describe <ref>!",
        summary: "Describes.",
        detail: "Four.",
      }];
      expect(renderVerbList(wider).split("\n")[0])
        .toBe(`ls${" ".repeat("describe <ref>!".length)}Lists.`);
    });

    it("returns the line naming `<verb> --help` last", () => {
      expect(LINES.at(-1)).toBe("`<verb> --help` says more about one verb.");
    });

    it("returns a blank line between the rows and that last line", () => {
      expect(LINES.at(-2)).toBe("");
    });

    it("returns no trailing line break, which leaves the caller ending the last line", () => {
      expect(renderVerbList(VERBS).endsWith("\n")).toBe(false);
    });
  });

  describe("renderVerbPage()", () => {
    const LINES = renderVerbPage(VERBS[1]).split("\n");

    it("returns the usage on the first line, under `Usage:`", () => {
      expect(LINES[0]).toBe("Usage: cd <ref>");
    });

    it("returns the summary under the usage, a blank line between them", () => {
      expect(LINES.slice(1, 3)).toEqual(["", "Moves."]);
    });

    it("returns the detail under the summary, a blank line between them", () => {
      expect(LINES.slice(3, 5)).toEqual(["", "Two."]);
    });

    it("returns the options block last, naming the `--help` every verb takes", () => {
      expect(LINES.slice(5)).toEqual([
        "",
        "Options:",
        "  -h, --help  Write this page instead of running the verb.",
      ]);
    });

    it("returns a verb's own options under that one, in the order declared", () => {
      expect(renderVerbPage(WITH_OPTIONS).split("\n").slice(-3)).toEqual([
        "  -h, --help          Write this page instead of running the verb.",
        "  --filter <pred>     Keeps what matches.",
        "  -a, --all <fields>  Keeps everything.",
      ]);
    });

    it("returns a spelling with no value for an option declaring no type", () => {
      expect(
        renderVerbPage({
          ...WITH_OPTIONS,
          options: [{
            name: "json",
            description: "Writes JSON.",
          }],
        }).split("\n").at(-1),
      ).toBe("  --json      Writes JSON.");
    });

    it("returns the type as the value's name where the option declares no placeholder", () => {
      expect(
        renderVerbPage({
          ...WITH_OPTIONS,
          options: [{
            name: "limit",
            type: "number",
            description: "Writes this many.",
          }],
        }).split("\n").at(-1),
      ).toBe("  --limit <number>  Writes this many.");
    });

    it("returns each name spelled the way the parse reads it, at either length", () => {
      // The claim the page rests on is that it lists the table the parse
      // reads, so the two cannot disagree about what a verb accepts. That
      // holds only if the page spells a name the way the parser spells it,
      // and the parser goes by length: one dash for a single character, two
      // for anything longer. An alias is `string` on a declaration, so both
      // lengths are declarable and both are asked here.
      //
      // The spellings are read off the page and fed back through the parse
      // rather than compared to literals, which is what makes the agreement
      // checkable rather than two functions asserted to match by hand.

      const declared: VerbOption[] = [{
        name: "all",
        aliases: ["a", "everything"],
        description: "Lists every one.",
      }];
      const page = renderVerbPage({ ...WITH_OPTIONS, options: declared });
      const spellings = page.split("\n").at(-1)!.trim().split("  ")[0]
        .split(", ");
      expect(spellings).toEqual(["-a", "--everything", "--all"]);
      for (const spelling of spellings) {
        const reading = readOptions("verbs", [spelling], declared);
        expect(reading.kind === "read" ? reading.options : undefined)
          .toEqual({ all: true });
      }
    });

    it("returns a column measured over the whole block, so a longer spelling moves every description", () => {
      // The shared `--help` row is inside the measurement rather than beside
      // it, which is what keeps one column down the block: a verb whose own
      // options are all shorter than `-h, --help` still lines up under it.

      const lines = renderVerbPage({
        ...WITH_OPTIONS,
        options: [{
          name: "x",
          description: "Short.",
        }],
      }).split("\n");
      expect(lines.slice(-2)).toEqual([
        "  -h, --help  Write this page instead of running the verb.",
        "  -x          Short.",
      ]);
    });

    it("returns no trailing line break, which leaves the caller ending the last line", () => {
      expect(renderVerbPage(VERBS[1]).endsWith("\n")).toBe(false);
    });
  });
});
