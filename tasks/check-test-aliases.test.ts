import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import {
  aliasDirectoryProblems,
  type AliasDirectoryState,
} from "./check-test-aliases.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const ALIAS_LINE = JSON.stringify({
  date: "2026-08-17",
  from: { k: "unit", s: "bakery", n: "old" },
  to: { k: "unit", s: "bakery", n: "new" },
});

const ALIAS_DIRECTORY = ["tasks", "test-identity-aliases"];

/** Writes alias files, by name, into a scratch repository's alias directory. */
async function writeAliasFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  await Deno.mkdir(join(dir, ...ALIAS_DIRECTORY), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, ...ALIAS_DIRECTORY, name), text);
  }
}

async function scratchRepo(
  committedAliases: Record<string, string> | undefined,
): Promise<{ dir: string; base: string }> {
  const dir = await Deno.makeTempDir({ prefix: "check-aliases-repo-" });
  const git = async (...args: string[]) => {
    const { code, stderr } = await new Deno.Command("git", {
      args,
      cwd: dir,
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
      stdout: "null",
      stderr: "piped",
    }).output();
    if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  };
  await git("init", "--initial-branch=main");
  await Deno.mkdir(join(dir, "tasks"), { recursive: true });
  if (committedAliases !== undefined) {
    await writeAliasFiles(dir, committedAliases);
  } else {
    await Deno.writeTextFile(join(dir, "README.md"), "scratch\n");
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  const revParse = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: dir,
    stdout: "piped",
  }).output();
  return { dir, base: new TextDecoder().decode(revParse.stdout).trim() };
}

async function runGate(
  dir: string,
  base: string,
): Promise<{ code: number; output: string }> {
  const result = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    cwd: dir,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--allow-read",
      "--allow-run=git",
      join(REPO_ROOT, "tasks", "check-test-aliases.ts"),
      base,
    ],
  });
  return {
    code: result.code,
    output: new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  };
}

const OTHER_LINE = ALIAS_LINE.replace("old", "older");
const COMMITTED = { "glaze.test.ts.jsonl": ALIAS_LINE + "\n" };

describe("check-test-aliases", () => {
  // The gate run whole, against scratch repositories: an append passes, a
  // rewrite fails, a bad line fails, a file no reader loads fails, and a
  // missing merge base is a setup error. Spawned through the frozen-lock
  // helper with the repository's own config, since the scratch checkout has
  // neither.

  it("passes a line appended to a committed file", async () => {
    const repo = await scratchRepo(COMMITTED);
    try {
      await writeAliasFiles(repo.dir, {
        "glaze.test.ts.jsonl": ALIAS_LINE + "\n" + OTHER_LINE + "\n",
      });
      const result = await runGate(repo.dir, repo.base);
      expect(result.output).toContain(
        "2 alias(es) in 1 file(s), append-only and acyclic",
      );
      expect(result.code).toBe(0);
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  it("passes a file created after the base", async () => {
    const beside = await scratchRepo(COMMITTED);
    const first = await scratchRepo(undefined);
    try {
      await writeAliasFiles(beside.dir, {
        "crumb.test.ts.jsonl": OTHER_LINE + "\n",
      });
      const grown = await runGate(beside.dir, beside.base);
      expect(grown.output).toContain("2 alias(es) in 2 file(s)");
      expect(grown.code).toBe(0);

      await writeAliasFiles(first.dir, COMMITTED);
      const fresh = await runGate(first.dir, first.base);
      expect(fresh.output).toContain("1 alias(es) in 1 file(s)");
      expect(fresh.code).toBe(0);
    } finally {
      await Deno.remove(beside.dir, { recursive: true }).catch(() => {});
      await Deno.remove(first.dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails a rewrite of committed history", async () => {
    const repo = await scratchRepo(COMMITTED);
    try {
      await writeAliasFiles(repo.dir, {
        "glaze.test.ts.jsonl": ALIAS_LINE.replace("2026-08-17", "2026-08-16") +
          "\n",
      });
      const result = await runGate(repo.dir, repo.base);
      expect(result.code).toBe(1);
      expect(result.output).toContain("glaze.test.ts.jsonl rewrites history");
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails a committed file that went missing", async () => {
    const repo = await scratchRepo(COMMITTED);
    try {
      // The lines moved to another file, so the set of aliases is unchanged.
      await Deno.rename(
        join(repo.dir, ...ALIAS_DIRECTORY, "glaze.test.ts.jsonl"),
        join(repo.dir, ...ALIAS_DIRECTORY, "icing.test.ts.jsonl"),
      );
      const result = await runGate(repo.dir, repo.base);
      expect(result.code).toBe(1);
      expect(result.output).toContain("glaze.test.ts.jsonl rewrites history");
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails a malformed appended line, naming its file and line", async () => {
    const repo = await scratchRepo(COMMITTED);
    try {
      await writeAliasFiles(repo.dir, {
        "glaze.test.ts.jsonl": ALIAS_LINE + "\n" + JSON.stringify({
          date: "2026-02-31",
          from: { k: "unit", s: "bakery", n: "x" },
          to: { k: "unit", s: "bakery", n: "y" },
        }) + "\n",
      });
      const result = await runGate(repo.dir, repo.base);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        "glaze.test.ts.jsonl line 2 has an impossible calendar date",
      );
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails an identity mapped in two files", async () => {
    const repo = await scratchRepo(COMMITTED);
    try {
      await writeAliasFiles(repo.dir, {
        "crumb.test.ts.jsonl": ALIAS_LINE.replace("new", "newer") + "\n",
      });
      const result = await runGate(repo.dir, repo.base);
      expect(result.code).toBe(1);
      expect(result.output).toContain("two mappings from");
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails an entry of the directory that no reader loads", async () => {
    const repo = await scratchRepo(COMMITTED);
    try {
      await writeAliasFiles(repo.dir, { "glaze.test.ts.json": OTHER_LINE });
      const result = await runGate(repo.dir, repo.base);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        "tasks/test-identity-aliases/glaze.test.ts.json is not a `.jsonl` file",
      );
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails a `.jsonl` file of the directory's name beside it", async () => {
    const repo = await scratchRepo(COMMITTED);
    try {
      await Deno.writeTextFile(
        join(repo.dir, "tasks", "test-identity-aliases.jsonl"),
        OTHER_LINE + "\n",
      );
      const result = await runGate(repo.dir, repo.base);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        "tasks/test-identity-aliases.jsonl is outside",
      );
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  describe("aliasDirectoryProblems()", () => {
    /** A state with one committed file, unchanged, overridden per test. */
    function state(
      overrides: Partial<AliasDirectoryState> = {},
    ): AliasDirectoryState {
      return {
        current: {
          files: [{ name: "glaze.test.ts.jsonl", text: ALIAS_LINE + "\n" }],
          unread: [],
        },
        committed: new Map([["glaze.test.ts.jsonl", ALIAS_LINE + "\n"]]),
        mergeBase: "0123456789abcdef",
        strayFile: false,
        ...overrides,
      };
    }

    it("returns no problems and every alias for an unchanged directory", () => {
      const { problems, aliases } = aliasDirectoryProblems(state());
      expect(problems).toEqual([]);
      expect(aliases).toEqual([JSON.parse(ALIAS_LINE)]);
    });

    it("returns no problems for an appended line and for a new file", () => {
      const { problems, aliases } = aliasDirectoryProblems(state({
        current: {
          files: [
            { name: "crumb.test.ts.jsonl", text: OTHER_LINE + "\n" },
            {
              name: "glaze.test.ts.jsonl",
              text: ALIAS_LINE + "\n" + ALIAS_LINE.replace("old", "oldest") +
                "\n",
            },
          ],
          unread: [],
        },
      }));
      expect(problems).toEqual([]);
      expect(aliases).toHaveLength(3);
    });

    it("returns a problem naming a committed file that was edited", () => {
      const { problems } = aliasDirectoryProblems(state({
        current: {
          files: [{ name: "glaze.test.ts.jsonl", text: OTHER_LINE + "\n" }],
          unread: [],
        },
      }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(
        "tasks/test-identity-aliases/glaze.test.ts.jsonl rewrites history: " +
          "the content at 0123456789ab is",
      );
    });

    it("returns a problem naming a committed file that went missing", () => {
      const { problems } = aliasDirectoryProblems(state({
        current: {
          files: [{ name: "icing.test.ts.jsonl", text: ALIAS_LINE + "\n" }],
          unread: [],
        },
      }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("glaze.test.ts.jsonl rewrites history");
    });

    it("returns a problem naming the file and line that does not parse", () => {
      const { problems, aliases } = aliasDirectoryProblems(state({
        current: {
          files: [{
            name: "glaze.test.ts.jsonl",
            text: ALIAS_LINE + "\n\nnot json\n",
          }],
          unread: [],
        },
      }));
      expect(problems).toEqual(["glaze.test.ts.jsonl line 3 is not JSON"]);
      expect(aliases).toHaveLength(1);
    });

    it("returns a problem for an identity mapped in two files", () => {
      const { problems } = aliasDirectoryProblems(state({
        current: {
          files: [
            {
              name: "crumb.test.ts.jsonl",
              text: ALIAS_LINE.replace("new", "newer") + "\n",
            },
            { name: "glaze.test.ts.jsonl", text: ALIAS_LINE + "\n" },
          ],
          unread: [],
        },
      }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("two mappings from");
    });

    it("returns a problem naming each entry that no reader loads", () => {
      const { problems } = aliasDirectoryProblems(state({
        current: { ...state().current, unread: ["README.md", "nested"] },
        strayFile: true,
      }));
      expect(problems).toHaveLength(3);
      expect(problems[0]).toContain(
        "tasks/test-identity-aliases/README.md is not a `.jsonl` file",
      );
      expect(problems[1]).toContain("tasks/test-identity-aliases/nested is");
      expect(problems[2]).toContain(
        "tasks/test-identity-aliases.jsonl is outside",
      );
    });
  });

  it("treats a missing merge base as a setup error", async () => {
    const repo = await scratchRepo(COMMITTED);
    try {
      const result = await runGate(repo.dir, "no-such-ref");
      expect(result.code).toBe(2);
      expect(result.output).toContain("Cannot find the merge base");
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });
});
