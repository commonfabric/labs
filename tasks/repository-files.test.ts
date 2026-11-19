import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import {
  defaultBase,
  git as gitHere,
  gitIn,
  repositoryFiles,
} from "./repository-files.ts";

/** Runs git in `root`, failing the test when git does. */
async function git(root: string, ...args: string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command("git", {
    args: ["-C", root, ...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `\`git ${args.join(" ")}\` failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

/** A fresh repository holding `files`, each with empty content. */
async function repository(files: readonly string[]): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "repository-files-" });
  for (const file of files) {
    const at = `${root}/${file}`;
    await Deno.mkdir(at.slice(0, at.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(at, "");
  }
  await git(root, "init", "--quiet");
  return root;
}

describe("repositoryFiles()", () => {
  it("lists tracked and untracked files and leaves out ignored ones", async () => {
    const root = await repository([
      ".claude/scripts/hook.ts",
      ".claude/worktrees/copy/runtime/oven/oven.ts",
      "runtime/oven/node_modules/dep/index.ts",
      "runtime/oven/oven.ts",
    ]);
    try {
      await Deno.writeTextFile(
        `${root}/.gitignore`,
        ".claude/worktrees/\nnode_modules/\n",
      );
      await git(root, "add", "runtime/oven/oven.ts");
      expect(await repositoryFiles(root)).toEqual([
        ".claude/scripts/hook.ts",
        ".gitignore",
        "runtime/oven/oven.ts",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("leaves out a tracked file the working tree no longer holds", async () => {
    const root = await repository(["kept.ts", "removed.ts"]);
    try {
      await git(root, "add", ".");
      await Deno.remove(`${root}/removed.ts`);
      expect(await repositoryFiles(root)).toEqual(["kept.ts"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("throws outside a git working tree", async () => {
    const root = await Deno.makeTempDir({ prefix: "not-a-repository-" });
    try {
      await expect(repositoryFiles(root)).rejects.toThrow("git ls-files");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("gitIn()", () => {
  // These run the real `git` against this checkout, which is the only thing
  // the runner does.

  const tasks = fromFileUrl(new URL(".", import.meta.url));

  it("returns git's standard output, run in the directory it names", async () => {
    expect(await gitIn(tasks)("rev-parse", "--show-prefix")).toBe("tasks/\n");
  });

  it("throws naming the command and the directory where git fails", async () => {
    // Only the part this file writes is matched, since git words its own
    // complaint in the machine's language.
    await expect(
      gitIn(tasks)("rev-parse", "--verify", "refs/no/such/ref"),
    ).rejects.toThrow(
      `\`git rev-parse --verify refs/no/such/ref\` failed in ${tasks}: `,
    );
  });
});

describe("git", () => {
  it("returns git's standard output", async () => {
    expect(await gitHere("--version")).toMatch(/^git version /);
  });

  it("throws naming the command, and no directory, where git fails", async () => {
    await expect(gitHere("rev-parse", "--verify", "refs/no/such/ref"))
      .rejects.toThrow(
        /^`git rev-parse --verify refs\/no\/such\/ref` failed: /,
      );
  });
});

describe("defaultBase()", () => {
  let root: string;

  beforeEach(async () => {
    root = await repository(["a.ts"]);
    await git(root, "add", ".");
    await git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "-m",
      "a",
    );
    await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  it("returns `origin/main` where the checkout has no `upstream/main`", async () => {
    expect(await defaultBase(gitIn(root))).toBe("refs/remotes/origin/main");
  });

  it("returns `upstream/main` where the checkout has one", async () => {
    await git(root, "update-ref", "refs/remotes/upstream/main", "HEAD");
    expect(await defaultBase(gitIn(root))).toBe("refs/remotes/upstream/main");
  });

  it("returns `origin/main` where only a local branch is named `upstream/main`", async () => {
    await git(root, "branch", "upstream/main");
    expect(await defaultBase(gitIn(root))).toBe("refs/remotes/origin/main");
  });

  it("names `upstream/main` so that a local branch of that name does not stand in for it", async () => {
    await git(root, "update-ref", "refs/remotes/upstream/main", "HEAD");
    await git(root, "branch", "upstream/main");
    const base = await defaultBase(gitIn(root));
    expect(await gitIn(root)("rev-parse", "--symbolic-full-name", base))
      .toBe("refs/remotes/upstream/main\n");
  });

  it("throws where git fails", async () => {
    const outside = await Deno.makeTempDir({ prefix: "not-a-repository-" });
    try {
      await expect(defaultBase(gitIn(outside))).rejects.toThrow(
        "git for-each-ref",
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});
