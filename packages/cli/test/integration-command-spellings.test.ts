/**
 * Every `cf` command the integration drills run is written in the spelling the
 * surface blesses.
 *
 * Each command sits under the noun it acts on, and the spelling it replaced is
 * still mounted — hidden from help and from completion, carrying a notice, and
 * guaranteed only until the date `COMMAND_SPELLING_END_DATE` names in
 * `packages/cli/lib/deprecated-spelling.ts`. That mount is what makes a drill's
 * own result no evidence about the spellings it writes: a drill that went back
 * to a superseded one passes every assertion it makes, and keeps passing until
 * the mount is removed, at which point it fails on a day nothing about it
 * changed. So this reads the text of the scripts instead of a run of them.
 *
 * `packages/cli/README.md` carries the same table under "Superseded spellings",
 * as the surface's own record of what to write instead.
 *
 * The scan does not tell a command from a comment, and that is deliberate:
 * prose in a drill that teaches a superseded spelling wants the same edit as a
 * line that runs one.
 *
 * TODO(mike): Delete this file once `cf` mounts no superseded spelling. The
 * scan has nothing left to find then, and a check whose subject is gone reads
 * as a rule about something the CLI still does.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

/** The directory holding the drills. */
const DRILLS = new URL("../integration/", import.meta.url);

/**
 * A superseded command spelling and the one that replaced it, each written as
 * the words that follow `cf`.
 */
type Spelling = readonly [superseded: string, blessed: string];

/** Every spelling a moved command still answers to, against what to write. */
const SUPERSEDED: readonly Spelling[] = [
  ["get", "cell get"],
  ["set", "cell set"],
  ["call", "piece call"],
  ["piece get-label", "cell get-label"],
  ["piece set-label", "cell set-label"],
  ["piece recreate-root", "space recreate-root"],
];

/**
 * How a drill names the CLI. Some write the word, which those scripts bind to
 * a shell function; the rest write `$CF`, or `${CF}`. A pattern that saw
 * only the word finds nothing at all in a drill of the second kind, and reports
 * one that had gone back to the old spellings everywhere as clean.
 */
const INVOCATION = String.raw`(?:cf|\$\{?CF\}?)`;

/**
 * The pattern that finds one spelling.
 *
 * The boundaries are `(?![\w-])` rather than `\b`, because `\b` sits between
 * `set` and the `-` of `set-label`: a word boundary would read every
 * `cf cell set-label` as a use of the superseded `cf set`. The words of a
 * spelling are joined by `\s+` so a command recovered from a wrap, whose words
 * are several spaces apart, reads the same as one written on a single line.
 */
function spellingPattern(superseded: string): RegExp {
  const words = superseded.split(" ").join(String.raw`\s+`);
  return new RegExp(
    String.raw`(?<![\w-])${INVOCATION}\s+${words}(?![\w-])`,
    "g",
  );
}

/**
 * The script with its line breaks turned into whitespace, so a command wrapped
 * across lines reads as the one run of words it is.
 *
 * One character replaces one character, so an index into the result still names
 * a position in the script it came from. A backslash continuation loses its
 * backslash as well, since the backslash stands where the space between two
 * words would otherwise be.
 */
function flatten(script: string): string {
  return script.replace(/\\\n/g, "  ").replaceAll("\n", " ");
}

/** The line the character at `index` sits on, counting from one. */
function lineOf(script: string, index: number): number {
  let line = 1;
  for (let at = 0; at < index; at++) {
    if (script[at] === "\n") line += 1;
  }
  return line;
}

/** Where in `script` each invocation of `spelling` begins. */
function invocationsOf(script: string, spelling: string): number[] {
  return [...flatten(script).matchAll(spellingPattern(spelling))]
    .map((match) => match.index ?? 0);
}

/**
 * Every superseded spelling `script` invokes, each reported with the line it
 * sits on and the spelling to write in its place, in the order they appear.
 */
function findSupersededSpellings(
  name: string,
  script: string,
  table: readonly Spelling[] = SUPERSEDED,
): string[] {
  const found: { at: number; report: string }[] = [];
  for (const [superseded, blessed] of table) {
    for (const at of invocationsOf(script, superseded)) {
      found.push({
        at,
        report: `${name}:${lineOf(script, at)}: 'cf ${superseded}' is ` +
          `superseded; spell it 'cf ${blessed}'`,
      });
    }
  }
  return found.sort((one, other) => one.at - other.at)
    .map((finding) => finding.report);
}

/** The drills the checks below name, and so must have been read. */
const WATCHED = [
  "bulk-survey-drill.sh",
  "completion-over-the-cli.sh",
  "verb-session-gaps.sh",
];

/** Every drill in the integration directory, by name, with its text. */
const drills: { name: string; text: string }[] = [];
for await (const entry of Deno.readDir(DRILLS)) {
  if (!entry.isFile || !entry.name.endsWith(".sh")) continue;
  drills.push({
    name: entry.name,
    text: await Deno.readTextFile(new URL(entry.name, DRILLS)),
  });
}
drills.sort((one, other) => one.name.localeCompare(other.name));

describe("integration-command-spellings", () => {
  it("reads the drills its cases depend on", () => {
    // Names files rather than counting them. A scan of a directory it failed
    // to read reports nothing wrong with every script in it, and reads exactly
    // like a scan that found every script clean.

    const names = drills.map((drill) => drill.name);
    expect(WATCHED.filter((name) => !names.includes(name))).toEqual([]);
  });

  it("sees the blessed spellings those drills run", () => {
    // The pattern read against the scripts rather than against a fixture. One
    // blind to `$CF` finds nothing in a drill that writes every command
    // through the variable, and reports it clean; the check below cannot tell
    // that from a drill that is already right. Finding what these three do run
    // is what separates the two.

    expect(WATCHED.map((name) => {
      const text = drills.find((drill) => drill.name === name)?.text ?? "";
      const runs = invocationsOf(text, "cell get").length +
        invocationsOf(text, "piece call").length;
      return `${name} runs ${runs > 0 ? "a" : "no"} blessed spelling`;
    })).toEqual(WATCHED.map((name) => `${name} runs a blessed spelling`));
  });

  it("runs no superseded command spelling in any drill", () => {
    expect(
      drills.flatMap((drill) =>
        findSupersededSpellings(drill.name, drill.text)
      ),
    ).toEqual([]);
  });

  describe("findSupersededSpellings()", () => {
    // The cases the scan exists for, and the cases that would make it fire on
    // a drill that is already right. Without these the check above is a
    // comparison of two empty arrays, which holds whatever the pattern does.

    it("reports a spelling written through the `$CF` variable", () => {
      expect(
        findSupersededSpellings(
          "drill.sh",
          `$CF call -q --piece "$BOARD" addMember '{"title":"alpha"}'`,
        ),
      ).toEqual([
        "drill.sh:1: 'cf call' is superseded; spell it 'cf piece call'",
      ]);
    });

    it("reports a spelling written through the `${CF}` variable", () => {
      expect(findSupersededSpellings("drill.sh", "${CF} get --quiet name"))
        .toEqual([
          "drill.sh:1: 'cf get' is superseded; spell it 'cf cell get'",
        ]);
    });

    it("reports a spelling written as the literal command", () => {
      expect(
        findSupersededSpellings("drill.sh", "cf piece recreate-root --space x"),
      )
        .toEqual([
          "drill.sh:1: 'cf piece recreate-root' is superseded; spell it " +
          "'cf space recreate-root'",
        ]);
    });

    it("reports a spelling split across a backslash continuation", () => {
      // The wrap a shell script writes to keep a long command under the line
      // width. A line-based scan sees `$CF` on one line and `get` on the next
      // and reads neither half as a command.

      expect(
        findSupersededSpellings(
          "drill.sh",
          ["KIDS=$($CF \\", '  get --quiet --piece "$EPIC" children)']
            .join("\n"),
        ),
      ).toEqual([
        "drill.sh:1: 'cf get' is superseded; spell it 'cf cell get'",
      ]);
    });

    it("reports a spelling split across a bare line break", () => {
      expect(
        findSupersededSpellings(
          "drill.sh",
          ["run_step() {", "  $CF", "    piece get-label --piece board", "}"]
            .join("\n"),
        ),
      ).toEqual([
        "drill.sh:2: 'cf piece get-label' is superseded; spell it " +
        "'cf cell get-label'",
      ]);
    });

    it("reports each spelling against the line it sits on", () => {
      expect(
        findSupersededSpellings(
          "drill.sh",
          ["$CF piece survey --piece board", "", "$CF set --piece board x 1"]
            .join("\n"),
        ),
      ).toEqual([
        "drill.sh:3: 'cf set' is superseded; spell it 'cf cell set'",
      ]);
    });

    it("returns nothing for the spellings the surface blesses", () => {
      expect(
        findSupersededSpellings(
          "drill.sh",
          [
            "$CF cell get --quiet --piece board name",
            "$CF cell set --piece board name x",
            "$CF cell get-label --piece board",
            "$CF cell set-label --piece board",
            "$CF piece call --piece board addItem '{}'",
            "$CF space recreate-root --space x",
          ].join("\n"),
        ),
      ).toEqual([]);
    });

    it("returns nothing for a longer name a superseded spelling opens", () => {
      // `cf cell set-label` opens with the letters of `cf set` only after the
      // noun, but `cf get-label` and `cf set-home` open with them directly.
      // A `\b` boundary matches between `set` and `-`, so a pattern written
      // with one reads all three as a use of `cf get` or `cf set`.

      expect(
        findSupersededSpellings(
          "drill.sh",
          ["$CF get-label --piece board", "$CF set-home --reset", "$CF getter"]
            .join("\n"),
        ),
      ).toEqual([]);
    });

    it("returns nothing for a name the invocation is only part of", () => {
      expect(
        findSupersededSpellings(
          "drill.sh",
          ["$CFG get --piece board", "self-cf get --piece board"].join("\n"),
        ),
      ).toEqual([]);
    });
  });
});
