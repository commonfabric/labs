/**
 * These pin the walkthrough↔demo sync check to the four drift classes it
 * exists to catch, each of which shipped at least once: a composed command
 * the demo never runs (one was wrong from the day it was written and
 * survived four editing passes), an act reference gone stale under
 * renumbering (twice), a shape-table row pairing a verb with an act that
 * no longer shows it, and a write quoted with a value other than the one the
 * demo pipes — invisible for as long as the payload was dropped, and the
 * substance of every act a tour about writing narrates.
 *
 * The real files are checked too, so the gate's green on this repository is
 * itself a pinned fact — and so is the check's grip: each class is asserted
 * by injecting one violation into the real walkthrough and watching it
 * surface.
 */

import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  actReferences,
  BULK_DEMO_PATH,
  BULK_TOUR_PATH,
  commandMatches,
  DEMO_PATH,
  demoActs,
  demoCommands,
  demoFor,
  findViolations,
  joinContinuations,
  main,
  READ_WRITE_DEMO_PATH,
  READ_WRITE_TOUR_PATH,
  tokenize,
  TOUR_PATH,
  WALKTHROUGH_PATH,
  walkthroughCommands,
} from "./check-verb-session-sync.ts";
import { beforeAll, describe, it } from "@commonfabric/test-support/test";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

describe("check-verb-session-sync", () => {
  let sh = "";
  let md = "";
  let tour = "";
  let readWriteDemo = "";
  let readWriteTour = "";
  beforeAll(async () => {
    sh = await Deno.readTextFile(join(REPO_ROOT, DEMO_PATH));
    md = await Deno.readTextFile(join(REPO_ROOT, WALKTHROUGH_PATH));
    tour = await Deno.readTextFile(join(REPO_ROOT, TOUR_PATH));
    readWriteDemo = await Deno.readTextFile(
      join(REPO_ROOT, READ_WRITE_DEMO_PATH),
    );
    readWriteTour = await Deno.readTextFile(
      join(REPO_ROOT, READ_WRITE_TOUR_PATH),
    );
  });

  describe("tokenize", () => {
    it("keeps a quoted span as one token without its quotes", () => {
      expect(
        tokenize(
          `cf piece call addItem --title "Login rewrite" -- --select 'item@'`,
        ),
      )
        .toEqual([
          "cf",
          "piece",
          "call",
          "addItem",
          "--title",
          "Login rewrite",
          "--",
          "--select",
          "item@",
        ]);
    });
  });

  describe("joinContinuations", () => {
    it("folds a backslash-continued line into its successor", () => {
      expect(joinContinuations("a \\\nb\nc")).toEqual(["a  b", "c"]);
    });

    it("keeps a continuation the text ends on", () => {
      expect(joinContinuations("a \\")).toEqual(["a  "]);
    });
  });

  describe("demoCommands", () => {
    it("extracts a command out of an assignment's substitution", () => {
      expect(demoCommands(`X=$(cf cell get --piece a title | jq -r .)`))
        .toEqual([["cf", "cell", "get", "--piece", "a", "title"]]);
    });

    it("reads past a helper's own leading arguments", () => {
      // `run_stdin` carries the piped value ahead of the argv, so a rule that
      // read the second token would take the payload for the command and
      // report every write in a tour as invented. The payload comes back in
      // the document's own spelling for it, which is what holds the two to
      // each other.
      expect(demoCommands(`run_stdin '25' cf cell set --piece a target`))
        .toEqual([[
          "echo",
          "25",
          "|",
          "cf",
          "cell",
          "set",
          "--piece",
          "a",
          "target",
        ]]);
    });

    it("does not mistake a payload spelled `cf` for the command", () => {
      // Searching for the `cf` token found the payload first and read the
      // rest as the argv, recording `cf cf cell set …` — a command no demo runs,
      // against which the honest quote of the write reads as invented. The
      // helper's shape says where the command starts; nothing is searched.
      expect(demoCommands(`run_stdin 'cf' cf cell set --piece a target`))
        .toEqual([[
          "echo",
          "cf",
          "|",
          "cf",
          "cell",
          "set",
          "--piece",
          "a",
          "target",
        ]]);
    });

    it("reads a refusal's own claim and signature past, not through", () => {
      // The same hazard on the helper carrying two arguments: either can be
      // spelled `cf`, and only the table knows the command is the third.
      expect(demoCommands(`refused 'why' 'cf' cf cell get --piece a x`))
        .toEqual([["cf", "cell", "get", "--piece", "a", "x"]]);
    });

    it("reads a `pending` line's first argument as the command it promises, without its space flag", () => {
      expect(
        demoCommands(`pending 'cf cell get -s home --piece a x' 'not yet'`),
      )
        .toEqual([["cf", "cell", "get", "--piece", "a", "x"]]);
    });

    it("finds no command in a `pending` line that names none", () => {
      expect(demoCommands("pending")).toEqual([]);
    });

    it("ignores a helper it does not know", () => {
      // The head list is the whole of what makes a line a command the demo
      // ran; a new helper that executes one has to be added to it.
      expect(demoCommands(`frobnicate cf cell set --piece a target`)).toEqual(
        [],
      );
    });
  });

  describe("walkthroughCommands", () => {
    const block = (line: string) => ["```bash", line, "```"].join("\n");

    it("reads a piped value as part of the command it feeds", () => {
      // The document's spelling of a demo's `run_stdin`, asserted here as
      // tokens rather than only through the violations it produces.
      expect(
        walkthroughCommands(block("echo '25' | cf cell set --piece a target"))
          .map((command) => command.tokens),
      ).toEqual([[
        "echo",
        "25",
        "|",
        "cf",
        "cell",
        "set",
        "--piece",
        "a",
        "target",
      ]]);
    });

    it("finds no command in a line piping into anything but cf", () => {
      // The payload rule's boundary: `echo`, a value, the bar, and then `cf`
      // — all four, or the line is not a command at all. Dropping the last
      // of those requirements would make every `echo … | jq` in a document
      // a command the demo is then asked to have run.
      expect(walkthroughCommands(block("echo '25' | jq -r .")))
        .toEqual([]);
      expect(walkthroughCommands(block("echo '25' | cfx set --piece a x")))
        .toEqual([]);
    });
  });

  describe("commandMatches", () => {
    it("returns true across variable and placeholder tokens", () => {
      expect(commandMatches(
        tokenize(`cf piece call "$EPIC" blockOn --on "$OTHER"`),
        tokenize(`cf piece call <cookies-address> blockOn --on <csrf-address>`),
      )).toBe(true);
    });

    it("returns false for a differing literal token", () => {
      expect(commandMatches(
        tokenize("cf cell get --piece board items"),
        tokenize("cf cell get --piece board title"),
      )).toBe(false);
    });

    it("returns false when the token counts differ", () => {
      expect(commandMatches(
        tokenize("cf cell get --piece board"),
        tokenize("cf cell get --piece board items"),
      )).toBe(false);
    });
  });

  describe("extraction from the real files", () => {
    it("collects a double-digit command count from the demo", () => {
      expect(demoCommands(sh).length).toBeGreaterThanOrEqual(10);
    });

    it("collects walkthrough commands and act references", () => {
      expect(walkthroughCommands(md).length).toBeGreaterThanOrEqual(5);
      expect(actReferences(md).length).toBeGreaterThanOrEqual(5);
    });

    it("collects an act reference whatever its case", () => {
      expect(actReferences("Act 12, then act 13").map((r) => r.act))
        .toEqual([12, 13]);
    });

    it("maps every demo act number to a nonempty section", () => {
      const acts = demoActs(sh);
      expect(acts.size).toBeGreaterThanOrEqual(13);
      for (const body of acts.values()) expect(body.length).toBeGreaterThan(0);
    });
  });

  describe("findViolations", () => {
    it("returns nothing for the repository's own files", () => {
      expect(findViolations(sh, md)).toEqual([]);
    });

    it("catches a composed command the demo does not run", () => {
      // The case this exists for: a read option drifting back ahead of the
      // verb, where a projection names positions in a result nothing has
      // identified and the command stops working.
      const broken = md.replace(
        'cf piece call --piece board addItem --title "Login rewrite" \\',
        "cf piece call --piece board --select 'item@' addItem " +
          '--title "Login rewrite" \\',
      );
      expect(broken).not.toEqual(md);
      const found = findViolations(sh, broken);
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found[0]).toContain("a command the demo does not run");
    });

    it("catches an act reference the demo does not have", () => {
      // The first "act 12" in the tour, wherever it sits, renumbered past the
      // demo's range. The tour carries the act narrative; the walkthrough
      // references acts too, and either would exercise this.
      const stale = tour.replace("act 12", "act 99");
      expect(stale).not.toEqual(tour);
      const found = findViolations(sh, stale, TOUR_PATH);
      expect(found.some((v) => v.includes("act 99"))).toBe(true);
    });

    it("catches a shape-table row paired with the wrong act", () => {
      // The verb shape table lives in the tour, beside the fixture it
      // describes.
      const mispaired = tour.replace("| act 9 |", "| act 3 |");
      expect(mispaired).not.toEqual(tour);
      expect(findViolations(sh, mispaired, TOUR_PATH).length)
        .toBeGreaterThanOrEqual(1);
    });

    it("checks a console transcript, not only a bash block", () => {
      const block = [
        "```console",
        "$ cf frobnicate --nothing-like-this",
        "```",
      ].join("\n");
      expect(findViolations(sh, block).length).toBe(1);
    });

    it("drops an -s space pair before matching a transcript command", () => {
      // A transcript shows the space it really ran against; the demo passes
      // its own. Without the drop these differ by two tokens and no command
      // in a transcript would ever match.
      const block = [
        "```console",
        "$ cf cell get -s demo $EPIC children --select @,title",
        "```",
      ].join("\n");
      expect(findViolations(sh, block)).toEqual([]);
    });

    it("lets an exempted line differ from every demo command", () => {
      const block = [
        "```bash",
        "# not in the demo — synthetic case for this test",
        "cf frobnicate --nothing-like-this",
        "```",
      ].join("\n");
      expect(findViolations(sh, block)).toEqual([]);
    });

    it("returns 0 through main() for the repository's own files", async () => {
      const lines: string[] = [];
      expect(await main({ log: (l) => lines.push(l) })).toBe(0);
      expect(lines.length).toBe(1);
    });

    describe("as a program", () => {
      /**
       * Runs the script with the task's permissions, from a directory holding
       * `tour.md`, a document quoting `cf frobnicate`, and `demo.sh`, a demo
       * running `demoLine`, with `args` as its command line. Returns its exit
       * code and what it printed.
       */
      async function runScript(demoLine: string, args: string[]) {
        const dir = await Deno.makeTempDir();
        try {
          await Deno.writeTextFile(
            join(dir, "tour.md"),
            "```bash\ncf frobnicate --nothing-like-this\n```\n",
          );
          await Deno.writeTextFile(
            join(dir, "demo.sh"),
            `#!/usr/bin/env bash\nrun ${demoLine}\n`,
          );
          const output = await runDenoCommandWithTemporaryLock({
            root: REPO_ROOT,
            cwd: dir,
            args: (lockPath) => [
              "run",
              "--config",
              join(REPO_ROOT, "deno.jsonc"),
              "--lock",
              lockPath,
              "--allow-read",
              join(REPO_ROOT, "tasks/check-verb-session-sync.ts"),
              ...args,
            ],
          });
          return {
            code: output.code,
            stdout: new TextDecoder().decode(output.stdout),
            stderr: new TextDecoder().decode(output.stderr),
          };
        } finally {
          await Deno.remove(dir, { recursive: true });
        }
      }

      it("exits 1 and names the violation for a document its demo does not run", async () => {
        const { code, stdout, stderr } = await runScript("cf piece ls", [
          "tour.md",
          "demo.sh",
        ]);
        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("verb-session sync: 1 violation(s)");
      });

      it("exits 0 and says so for a document quoting only what its demo runs", async () => {
        const { code, stdout, stderr } = await runScript(
          "cf frobnicate --nothing-like-this",
          ["tour.md", "demo.sh"],
        );
        expect(stderr).toBe("");
        expect(code).toBe(0);
        expect(stdout).toBe(
          "Commands and act references in 1 document(s) all match the demo.\n",
        );
      });

      it("exits 2 and prints the usage for an option or a third argument", async () => {
        for (
          const args of [["--help"], ["tour.md", "demo.sh", "extra.md"]]
        ) {
          expect(
            await runScript("cf frobnicate --nothing-like-this", args),
          ).toEqual({
            code: 2,
            stdout: "",
            stderr: "usage: check-verb-session-sync.ts [doc [demo]]\n",
          });
        }
      });
    });

    it("returns 1 through main() when the walkthrough composes", async () => {
      const mdPath = await Deno.makeTempFile({ suffix: ".md" });
      try {
        await Deno.writeTextFile(
          mdPath,
          "```bash\ncf frobnicate --nothing-like-this\n```\n",
        );
        const errors: string[] = [];
        // A document the table does not name says which demo it is held to.
        expect(
          await main({
            mdPath,
            shPath: DEMO_PATH,
            error: (l) => errors.push(l),
          }),
        ).toBe(1);
        expect(errors.length).toBeGreaterThanOrEqual(2);
      } finally {
        await Deno.remove(mdPath);
      }
    });

    it("holds a document to the demo shPath names", async () => {
      // The pairing is the injectable unit: the same document is a violation
      // against the default demo and clean against the demo that runs it.
      const dir = await Deno.makeTempDir();
      try {
        const mdPath = `${dir}/tour.md`;
        const shPath = `${dir}/demo.sh`;
        await Deno.writeTextFile(
          mdPath,
          "```bash\ncf frobnicate --nothing-like-this\n```\n",
        );
        await Deno.writeTextFile(
          shPath,
          "#!/usr/bin/env bash\nrun cf frobnicate --nothing-like-this\n",
        );
        const lines: string[] = [];
        expect(await main({ mdPath, shPath, log: (l) => lines.push(l) }))
          .toBe(0);
        // The same document against the verb demo, which does not run it.
        expect(await main({ mdPath, shPath: DEMO_PATH, error: () => {} }))
          .toBe(1);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("refuses a demo that names no document to check against it", async () => {
      // Silently ignoring it would leave the caller believing the run used
      // the demo they passed.
      await expect(main({ shPath: "/nowhere/demo.sh" })).rejects.toThrow(
        /pass both/,
      );
    });

    it("gives a named document the demo the table pairs it with", async () => {
      // Not a default: the bulk tour quotes commands the verb demo never
      // runs, so defaulting would report every one of them as invented.
      const lines: string[] = [];
      expect(
        await main({ mdPath: BULK_TOUR_PATH, log: (l) => lines.push(l) }),
      ).toBe(0);
      expect(lines.join("\n")).toContain("1 document(s)");
      expect(demoFor(BULK_TOUR_PATH)).toBe(BULK_DEMO_PATH);
      expect(demoFor(TOUR_PATH)).toBe(DEMO_PATH);
    });

    it("holds the read/write tour to the demo that runs it", async () => {
      // Every command in the tour is one read-write-demo.sh runs, and none of
      // them is one the verb demo runs — so the pairing is what makes the
      // document check at all, and the wrong demo says so loudly.
      const lines: string[] = [];
      expect(
        await main({ mdPath: READ_WRITE_TOUR_PATH, log: (l) => lines.push(l) }),
      ).toBe(0);
      expect(demoFor(READ_WRITE_TOUR_PATH)).toBe(READ_WRITE_DEMO_PATH);
      expect(
        await main({
          mdPath: READ_WRITE_TOUR_PATH,
          shPath: DEMO_PATH,
          error: () => {},
        }),
      ).toBe(1);
    });

    it("refuses a document no demo is paired with", async () => {
      // The other half of the same rule: half a pairing that names nothing
      // is refused rather than sent to whichever demo happens to be first.
      await expect(main({ mdPath: "docs/nowhere.md" })).rejects.toThrow(
        /No demo is paired with/,
      );
    });

    it("catches a write the document shows a different value for", () => {
      // The drift class this pairing exists to catch, and the one a rule
      // that dropped the payload missed: a tour ABOUT writing can narrate
      // setting 250 beside the answer the session got for 25, and every
      // claim around it still reads as verified.
      const demo = `run_stdin '25' cf cell set --piece a target\n`;
      const quoted = "```bash\necho '25' | cf cell set --piece a target\n```";
      const drifted = "```bash\necho '250' | cf cell set --piece a target\n```";
      expect(findViolations(demo, quoted)).toEqual([]);
      expect(findViolations(demo, drifted).length).toBe(1);
    });

    it("catches a write the document quotes without its value", () => {
      // The other half: a document that quotes only the command half leaves
      // a reader with a `cf cell set` that hangs waiting on stdin.
      const demo = `run_stdin '25' cf cell set --piece a target\n`;
      const halved = "```bash\ncf cell set --piece a target\n```";
      expect(findViolations(demo, halved).length).toBe(1);
    });

    it("keeps a value holding a bar as one value on both sides", () => {
      // Splitting the raw line at its first bar split INSIDE the quotes, so
      // a document showing `a|b` matched a demo piping `a`: the separator is
      // the bar that stands alone as a token, never the first bar character.
      const pipesA = `run_stdin 'a' cf cell set --piece a target\n`;
      const showsAB = "```bash\necho 'a|b' | cf cell set --piece a target\n```";
      expect(findViolations(pipesA, showsAB).length).toBe(1);
      const pipesAB = `run_stdin 'a|b' cf cell set --piece a target\n`;
      expect(findViolations(pipesAB, showsAB)).toEqual([]);
    });

    it("keeps a value holding the word cf out of the command", () => {
      // The document side reads its command positionally for the same
      // reason the demo side does: found in the raw text, the first `cf `
      // a value spells is taken for the start of the command.
      const demo = `run_stdin 'x cf y' cf cell set --piece a target\n`;
      const quoted =
        "```bash\necho 'x cf y' | cf cell set --piece a target\n```";
      expect(findViolations(demo, quoted)).toEqual([]);
      const drifted =
        "```bash\necho 'x cf y' | cf cell set --piece a label\n```";
      expect(findViolations(demo, drifted).length).toBe(1);
    });

    it("keeps every write in the read/write tour matched to its demo", () => {
      // Against the real files: each of the four writes must be quoted with
      // the value the demo pipes, and changing any one of them is caught.
      const values = ["25", "100", "15", "30"];
      for (const value of values) {
        const drifted = readWriteTour.replace(
          `echo '${value}' |`,
          `echo '${value}0' |`,
        );
        expect(drifted).not.toBe(readWriteTour);
        expect(findViolations(readWriteDemo, drifted, READ_WRITE_TOUR_PATH))
          .toHaveLength(1);
      }
    });

    it("does not let a reasonless marker exempt anything", () => {
      const block = [
        "```bash",
        "# not in the demo",
        "cf frobnicate --nothing-like-this",
        "```",
      ].join("\n");
      expect(findViolations(sh, block).length).toBe(1);
    });

    it("still flags the line after an exemption is spent", () => {
      const block = [
        "```bash",
        "# not in the demo — covers only the next line",
        "cf frobnicate --nothing-like-this",
        "cf also-not-a-command",
        "```",
      ].join("\n");
      expect(findViolations(sh, block).length).toBe(1);
    });
  });
});
