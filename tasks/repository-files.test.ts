import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { repositoryFiles } from "./repository-files.ts";

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
      ".claude/worktrees/copy/packages/oven/oven.ts",
      "packages/oven/node_modules/dep/index.ts",
      "packages/oven/oven.ts",
    ]);
    try {
      await Deno.writeTextFile(
        `${root}/.gitignore`,
        ".claude/worktrees/\nnode_modules/\n",
      );
      await git(root, "add", "packages/oven/oven.ts");
      expect(await repositoryFiles(root)).toEqual([
        ".claude/scripts/hook.ts",
        ".gitignore",
        "packages/oven/oven.ts",
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
