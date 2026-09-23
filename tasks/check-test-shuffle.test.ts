/**
 * These pin what the gate calls a test runner and what it calls a
 * command carrying a seed, in both directions: a false positive blocks a
 * pull request over a command that runs no tests, and a false negative
 * lets a runner reach the tree in declaration order, which is the one
 * thing the gate exists to stop.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  commandsOf,
  main,
  problemWith,
  scan,
  staleRecords,
  writtenCommands,
} from "./check-test-shuffle.ts";

const SHUFFLE = "--shuffle=$(deno task -q test-seed)";

/** The fixture repositories a test made, removed once it finishes. */
const made: string[] = [];

/** A temporary directory, recorded so that it is removed after the test. */
async function fixtureDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "check-test-shuffle-" });
  made.push(dir);
  return dir;
}

/** Makes a git repository holding one workspace member's manifest. */
async function fixtureRepo(memberTask: unknown): Promise<string> {
  return await fixtureMember({ test: memberTask });
}

/**
 * Makes a git repository holding one member with the tasks given, and any
 * other files named, each tracked.
 */
async function fixtureMember(
  memberTasks: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const root = await fixtureDir();
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
  await Deno.writeTextFile(
    join(root, "deno.jsonc"),
    JSON.stringify({ workspace: ["./member"], tasks: {} }, null, 2),
  );
  await Deno.mkdir(join(root, "member"));
  await Deno.writeTextFile(
    join(root, "member", "deno.jsonc"),
    JSON.stringify({ tasks: memberTasks }, null, 2),
  );
  for (const [path, contents] of Object.entries(files)) {
    await Deno.mkdir(join(root, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, path), contents);
  }
  await run("add", "deno.jsonc", "member/deno.jsonc", ...Object.keys(files));
  return root;
}

/** Runs `body` with console output captured. */
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("check-test-shuffle", () => {
  afterEach(async () => {
    for (const dir of made.splice(0)) {
      await Deno.remove(dir, { recursive: true });
    }
  });

  describe("commandsOf()", () => {
    it("separates the commands a task line joins", () => {
      expect(commandsOf("deno test -A && deno check .")).toEqual([
        "deno test -A",
        "deno check .",
      ]);
    });

    it("reads a command substitution's body as commands of their own", () => {
      // What the substitution produces is an argument to the command
      // around it, but the shell runs its body, so a runner written there
      // is held to the same rule as one written anywhere else.
      expect(
        commandsOf(
          'deno test --allow-run=$(deno eval "console.log(Deno.execPath())")',
        ),
      ).toEqual([
        "deno test --allow-run=",
        'deno eval "console.log(Deno.execPath())"',
      ]);
    });
  });

  describe("problemWith()", () => {
    it("accepts a `deno test` carrying a seed", () => {
      expect(problemWith(`deno test ${SHUFFLE} -A`)).toBeUndefined();
      expect(problemWith("ENV=test deno test --shuffle=20260922 -A"))
        .toBeUndefined();
    });

    it("refuses a `deno test` carrying none", () => {
      expect(problemWith("deno test -A")).toContain("--shuffle=");
      expect(problemWith("ENV=test deno test --no-check test/"))
        .toContain("--shuffle=");
    });

    it("refuses a runner that forwards its flags and is given none", () => {
      expect(
        problemWith(
          "deno run -A ../../tasks/run-sharded-test-files.ts X piece . -- -A",
        ),
      ).toContain("run-sharded-test-files.ts");
    });

    it("accepts that same runner once it is given one", () => {
      expect(
        problemWith(
          `deno run -A ../../tasks/run-sharded-test-files.ts X piece . -- ${SHUFFLE}`,
        ),
      ).toBeUndefined();
    });

    it("accepts a runner that shuffles in its own code", () => {
      expect(problemWith("deno run -A ../deno-web-test/cli.ts **/*.test.ts"))
        .toBeUndefined();
      expect(problemWith("deno run -A test/runner.ts")).toBeUndefined();
    });

    it("accepts a shell harness whose order is recorded as the test", () => {
      expect(problemWith("./integration/integration.sh")).toBeUndefined();
      expect(problemWith("timeout 600 ./integration/fuse-exec.sh"))
        .toBeUndefined();
    });

    it("refuses a shell harness nobody has decided about", () => {
      expect(problemWith("./integration/brand-new-drill.sh"))
        .toContain("EXEMPTIONS");
    });

    it("leaves a command that starts no test runner alone", () => {
      expect(problemWith("deno check .")).toBeUndefined();
      expect(problemWith("deno run -A perf/run-tsc.ts")).toBeUndefined();
      expect(problemWith("echo 'No tests defined.'")).toBeUndefined();
      // The word appears, but not as the command.
      expect(problemWith("deno run -A ./tasks/latest-deno-test-report.ts"))
        .toBeUndefined();
    });
  });

  describe("writtenCommands()", () => {
    it("names the line of each command in a script, skipping comments", () => {
      const found = writtenCommands(
        "set -e\n# deno test -A would run here\ndeno test -A && echo done\n",
      );
      expect(found).toEqual([
        { line: 1, command: "set -e" },
        { line: 3, command: "deno test -A" },
        { line: 3, command: "echo done" },
      ]);
    });

    it("reads a substitution nested inside another", () => {
      // The outer substitution runs `b` with its own substitution taken
      // out, and that one runs `c`.
      expect(commandsOf("a $(b $(c)) d")).toEqual(["a  d", "b", "c"]);
    });
  });

  describe("a runner written where it is easy to miss", () => {
    it("finds a `deno test` inside a command substitution", () => {
      const problems = commandsOf("echo $(deno test -A)")
        .map(problemWith)
        .filter((problem) => problem !== undefined);
      expect(problems).toHaveLength(1);
    });
  });

  describe("main()", () => {
    it("passes this repository", async () => {
      const { out } = await captureConsole(async () => {
        expect(await main()).toBe(0);
      });
      expect(out).toContain("shuffles its order");
    });

    it("fails a tree with an unshuffled runner, naming it and the fix", async () => {
      const root = await fixtureRepo("deno test -A");
      const { err } = await captureConsole(async () => {
        expect(await main(root)).toBe(1);
      });
      expect(err).toContain("member/deno.jsonc (task `test`)");
      expect(err).toContain("deno test -A");
      expect(err).toContain("--shuffle=$(deno task -q test-seed)");
      expect(err).toContain("deno task test-seed");
    });
  });

  describe("staleRecords()", () => {
    // What the real tree holds, so a case can take one thing away from
    // it and see only that thing reported.
    const TRACKED = [
      "tasks/run-sharded-test-files.ts",
      "packages/dashboard/test/runner.ts",
      "packages/deno-web-test/runner.ts",
      "packages/cli/lib/test-runner.ts",
      "packages/cli/integration/integration.sh",
      "packages/cli/integration/acl.sh",
      "packages/cli/integration/fuse-exec.sh",
    ];
    const WRITTEN = [
      "run-sharded-test-files.ts test/runner.ts deno-web-test/cli.ts cf test",
    ];

    it("says nothing while every record still describes the tree", () => {
      expect(staleRecords(TRACKED, WRITTEN)).toEqual([]);
    });

    it("names a runner no command starts any more", () => {
      const stale = staleRecords(
        TRACKED,
        ["test/runner.ts deno-web-test/cli.ts cf test"],
      );
      expect(stale).toHaveLength(1);
      expect(stale[0]!.command).toBe("run-sharded-test-files.ts");
    });

    it("names a runner whose implementation has moved", () => {
      const stale = staleRecords(
        TRACKED.filter((file) => file !== "packages/deno-web-test/runner.ts"),
        WRITTEN,
      );
      expect(stale).toHaveLength(1);
      expect(stale[0]!.command).toBe("packages/deno-web-test/runner.ts");
    });

    it("names an exemption for a harness the tree no longer holds", () => {
      const stale = staleRecords(
        TRACKED.filter((file) => file !== "packages/cli/integration/acl.sh"),
        WRITTEN,
      );
      expect(stale).toHaveLength(1);
      expect(stale[0]!.command).toBe("packages/cli/integration/acl.sh");
    });

    it("names an exemption a second harness of the same name would take", () => {
      const stale = staleRecords(
        [...TRACKED, "packages/oven/integration/acl.sh"],
        WRITTEN,
      );
      expect(stale).toHaveLength(1);
      expect(stale[0]!.problem).toContain("packages/oven/integration/acl.sh");
    });
  });

  describe("scan()", () => {
    it("passes a member whose test task carries a seed", async () => {
      const root = await fixtureRepo(`deno test ${SHUFFLE} -A`);
      expect(await scan(root)).toEqual([]);
    });

    it("fails a member whose test task carries none", async () => {
      const root = await fixtureRepo("deno test -A");
      const violations = await scan(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.where).toContain("member/deno.jsonc");
    });

    it("fails a member whose test task only echoes before its runner", async () => {
      // An `echo` beside a runner says nothing about whether the member
      // has tests; only the exact marker does.
      const root = await fixtureRepo("echo setup && node ./run-my-tests.js");
      const violations = await scan(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.problem).toContain("RUNNERS");
    });

    it("fails a workflow step that runs `deno test` with no seed", async () => {
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        ".github/workflows/ci.yml":
          "jobs:\n  test:\n    steps:\n      # deno test is fine in a comment\n" +
          "      - run: deno test -A\n",
      });
      const violations = await scan(root);
      expect(violations.map((violation) => violation.where)).toEqual([
        ".github/workflows/ci.yml:5",
      ]);
    });

    it("fails a shell script that runs `deno test` with no seed", async () => {
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        "scripts/run.sh": "#!/bin/sh\ndeno test -A\n",
      });
      const violations = await scan(root);
      expect(violations.map((violation) => violation.where)).toEqual([
        "scripts/run.sh:2",
      ]);
    });

    it("passes over a tracked script the working tree no longer holds", async () => {
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        "scripts/run.sh": "deno test -A\n",
      });
      await Deno.remove(join(root, "scripts/run.sh"));
      expect(await scan(root)).toEqual([]);
    });

    it("follows `deno task` into another of the member's tasks", async () => {
      const root = await fixtureMember({
        test: "deno task deno-test",
        "deno-test": { command: "deno test -A" },
      });
      const violations = await scan(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.where).toContain("`deno-test`");
    });

    it("follows a task that names itself only once", async () => {
      const root = await fixtureMember({
        test: `deno task test && deno test ${SHUFFLE} -A`,
      });
      expect(await scan(root)).toEqual([]);
    });

    it("passes over a member with no manifest of its own", async () => {
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        "deno.jsonc": JSON.stringify({
          workspace: ["./member", "./bare"],
          tasks: {},
        }),
        "bare/README.md": "no manifest here\n",
      });
      expect(await scan(root)).toEqual([]);
    });

    it("passes over a manifest that declares no tasks", async () => {
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        "tools/deno.jsonc": JSON.stringify({ imports: {} }),
      });
      expect(await scan(root)).toEqual([]);
    });

    it("passes over a tracked manifest the working tree no longer holds", async () => {
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        "tools/deno.jsonc": JSON.stringify({ tasks: { t: "deno test -A" } }),
      });
      await Deno.remove(join(root, "tools/deno.jsonc"));
      expect(await scan(root)).toEqual([]);
    });

    it("refuses a manifest that is not JSON rather than passing it", async () => {
      // A manifest this cannot read is one whose runners it cannot judge,
      // and passing it would claim they shuffle.
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        "tools/deno.jsonc": "{ not json",
      });
      await expect(scan(root)).rejects.toThrow();
    });

    it("refuses a member manifest that is not JSON", async () => {
      // The same holds for a member's own manifest, which the check reads
      // whether or not git tracks it.
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        "deno.jsonc": JSON.stringify({
          workspace: ["./member", "./broken"],
          tasks: {},
        }),
      });
      await Deno.mkdir(join(root, "broken"));
      await Deno.writeTextFile(join(root, "broken", "deno.json"), "{ nope");
      await expect(scan(root)).rejects.toThrow();
    });

    it("refuses a tracked script it cannot read", async () => {
      const root = await fixtureMember({ test: `deno test ${SHUFFLE} -A` }, {
        "scripts/run.sh": "deno test -A\n",
      });
      await Deno.remove(join(root, "scripts/run.sh"));
      await Deno.mkdir(join(root, "scripts/run.sh"));
      await expect(scan(root)).rejects.toThrow();
    });

    it("refuses to judge a tree git cannot list", async () => {
      await expect(scan(await fixtureDir())).rejects.toThrow("git ls-files");
    });

    it("passes a member that says it has no tests", async () => {
      const root = await fixtureRepo("echo 'No tests defined.'");
      expect(await scan(root)).toEqual([]);
    });

    it("fails a member whose test task reaches no runner it knows", async () => {
      const root = await fixtureRepo("node ./run-my-tests.js");
      const violations = await scan(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.problem).toContain("RUNNERS");
    });

    it("follows a test task built out of the member's other tasks", async () => {
      const root = await fixtureMember({
        test: { dependencies: ["deno-test"] },
        "deno-test": `deno test ${SHUFFLE} -A`,
      });
      expect(await scan(root)).toEqual([]);
    });

    it("follows the tasks a member's test script is told to run", async () => {
      const root = await fixtureMember({
        test: "deno run -A ../tasks/run-member-tests.ts deno-test browser-test",
        "deno-test": `deno test ${SHUFFLE} -A`,
        "browser-test": "deno run -A ../deno-web-test/cli.ts x.test.ts",
      });
      expect(await scan(root)).toEqual([]);
    });

    it("fails a member whose test script runs nothing it knows", async () => {
      const root = await fixtureMember({
        test: "deno run -A ../tasks/run-member-tests.ts deno-test",
        "deno-test": "node ./run-my-tests.js",
      });
      const violations = await scan(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.problem).toContain("RUNNERS");
    });
  });
});
