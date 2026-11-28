/**
 * These pin the recognizer that decides what counts as a merge-conflict
 * marker, which is a gate that fails CI and so has to be exact in both
 * directions.
 *
 * Most of the cases are the ones that must NOT match, since a false positive
 * blocks a pull request over ordinary text: a Markdown setext heading
 * underline, a run of the wrong length, and a marker anywhere but column
 * zero all look like the real thing to a loose pattern.
 */

import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { conflictMarkerAt, main, scan } from "./check-conflict-markers.ts";
import { describe, it } from "@commonfabric/test-support/test";

// Written out, not built. Detection is anchored at column 0, so these are inert
// where they sit -- and that is the point: this file is tracked, so the
// repo-wide check scans it on every run and passes. The check's own source is
// therefore a standing fixture proving it does not flag a marker that is not at
// the start of a line. The one rule is that no line here may BEGIN with one.
const OPEN = "<<<<<<<";
const ANCESTOR = "|||||||";
const CLOSE = ">>>>>>>";
const SEPARATOR = "=======";

/** Helper for the tests below, which makes a git repo holding one tracked file. */
async function fixtureRepo(contents: string): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-conflict-markers-" });
  const run = async (...args: string[]) => {
    const { success, stderr } = await new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(
      success,
      `git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`,
    );
  };
  await run("init", "-q");
  await Deno.writeTextFile(join(root, "subject.md"), contents);
  await run("add", "subject.md");
  return root;
}

/** Helper for the tests below, which runs `body` with console output captured. */
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("check-conflict-markers", () => {
  describe("conflictMarkerAt()", () => {
    it("returns the marker for each form git writes", () => {
      expect(conflictMarkerAt(`${OPEN} HEAD`)).toBe(OPEN);
      expect(conflictMarkerAt(`${CLOSE} some/branch`)).toBe(CLOSE);
      expect(conflictMarkerAt(`${ANCESTOR} merged common ancestors`))
        .toBe(ANCESTOR);
    });

    it("returns the marker for a bare one, with no label after it", () => {
      expect(conflictMarkerAt(OPEN)).toBe(OPEN);
    });

    it("returns `undefined` for a setext heading underline", () => {
      // Seven equals signs underline a Markdown heading. Flagging those would
      // make the check something people route around, so the separator is not
      // a marker here -- a real conflict brings an opener and a closer too.
      expect(conflictMarkerAt(SEPARATOR)).toBe(undefined);
      expect(conflictMarkerAt("=".repeat(40))).toBe(undefined);
    });

    it("returns `undefined` for a run that is not exactly seven long", () => {
      expect(conflictMarkerAt("<<<<")).toBe(undefined);
      // A longer run is a rule or an ASCII box, not a marker.
      expect(conflictMarkerAt(`${OPEN}<`)).toBe(undefined);
    });

    it("returns `undefined` for a marker away from column 0", () => {
      // Git never indents a marker, nor buries one mid-line.
      expect(conflictMarkerAt(`  ${OPEN} HEAD`)).toBe(undefined);
      expect(conflictMarkerAt(`text ${OPEN} HEAD`)).toBe(undefined);
    });

    it("returns `undefined` for an empty line", () => {
      expect(conflictMarkerAt("")).toBe(undefined);
    });
  });

  describe("scan()", () => {
    it("reports each marker with its file and line", async () => {
      const root = await fixtureRepo(
        [
          "intact",
          `${OPEN} HEAD`,
          "ours",
          SEPARATOR,
          "theirs",
          `${CLOSE} other`,
        ].join("\n"),
      );
      try {
        expect(await scan(root)).toEqual([
          { file: "subject.md", line: 2, marker: OPEN },
          { file: "subject.md", line: 6, marker: CLOSE },
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("reports nothing for a file that merely mentions the shapes", async () => {
      const root = await fixtureRepo(
        ["A heading", SEPARATOR, "", "and a rule:", "-".repeat(40), ""]
          .join("\n"),
      );
      try {
        expect(await scan(root)).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("skips a tracked file that is absent from the working tree", async () => {
      // A path can be tracked and yet not present -- a sparse checkout, an
      // uninitialized submodule. That is not this check's business, and it
      // must not take down the whole run.
      const root = await fixtureRepo("harmless");
      try {
        await Deno.remove(join(root, "subject.md"));
        expect(await scan(root)).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("skips a tracked file that is not valid UTF-8", async () => {
      // A binary file is not text to scan. Reading one as text throws rather
      // than returning replacement characters, so the skip is what keeps an
      // image or a fixture blob from failing the run.
      const root = await fixtureRepo("harmless");
      try {
        await Deno.writeFile(
          join(root, "subject.md"),
          new Uint8Array([0xff, 0xfe, 0x00, 0x80]),
        );
        expect(await scan(root)).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("throws for a tracked file it cannot read for any other reason", async () => {
      // A path that loops back on itself is neither binary nor absent, so
      // the run stops rather than passing a file it never read.
      const root = await fixtureRepo("harmless");
      try {
        await Deno.remove(join(root, "subject.md"));
        await Deno.symlink("subject.md", join(root, "subject.md"));
        await expect(scan(root)).rejects.toThrow(Deno.errors.FilesystemLoop);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("throws when the directory is not a git repository", async () => {
      // Every path here comes from `git ls-files`, so a failure to list means
      // the check saw nothing rather than that there was nothing to see.
      // Reporting success on that would be the worst possible answer.
      const root = await Deno.makeTempDir({ prefix: "check-not-a-repo-" });
      try {
        await expect(scan(root)).rejects.toThrow(/git ls-files failed/);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("main()", () => {
    it("returns 1 and names the file when a marker is present", async () => {
      const root = await fixtureRepo(`${OPEN} HEAD`);
      try {
        let code = 0;
        const { err } = await captureConsole(async () => {
          code = await main(root);
        });
        expect(code).toBe(1);
        expect(err).toContain("subject.md:1");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns 0 for a clean tree", async () => {
      const root = await fixtureRepo("nothing to see");
      try {
        let code = 1;
        const { out } = await captureConsole(async () => {
          code = await main(root);
        });
        expect(code).toBe(0);
        expect(out).toContain("No unresolved merge-conflict markers");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("as a command", () => {
    const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));

    /** Runs the script over `root` with only the permissions its task grants. */
    function runScript(root: string): Promise<Deno.CommandOutput> {
      return runDenoCommandWithTemporaryLock({
        root: REPO_ROOT,
        args: (lockPath) => [
          "run",
          "--config",
          join(REPO_ROOT, "deno.jsonc"),
          "--lock",
          lockPath,
          "--allow-read",
          "--allow-run=git",
          join(REPO_ROOT, "tasks/check-conflict-markers.ts"),
          root,
        ],
      });
    }

    it("exits 1 and names the file for the repository it is given", async () => {
      // The exit status is what fails CI, so the command must carry the
      // verdict of `main()` out of the process.
      const root = await fixtureRepo(["intact", `${CLOSE} other`].join("\n"));
      try {
        const output = await runScript(root);
        expect(output.code).toBe(1);
        expect(new TextDecoder().decode(output.stderr)).toContain(
          `subject.md:2: ${CLOSE}`,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("exits 0 for a clean repository it is given", async () => {
      const root = await fixtureRepo("nothing to see");
      try {
        const output = await runScript(root);
        const stderr = new TextDecoder().decode(output.stderr);
        expect(output.code, `exited non-zero:\n${stderr}`).toBe(0);
        expect(new TextDecoder().decode(output.stdout)).toContain(
          "No unresolved merge-conflict markers",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });
});
