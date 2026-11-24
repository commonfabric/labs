import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { discoverGitCheckoutDirectories } from "../src/checkout-discovery.ts";

describe("discoverGitCheckoutDirectories", () => {
  it("finds worktrees and does not descend into a checkout", async () => {
    const directory = await Deno.makeTempDir();
    try {
      const repository = join(directory, "repository");
      const linkedWorktree = join(directory, "nested", "linked-worktree");
      const linkedGitDirectory = join(
        directory,
        "gitdirs",
        "linked-worktree",
      );
      const stale = join(directory, "stale");
      const nestedCheckout = join(directory, "stale", "nested-checkout");
      await Deno.mkdir(join(repository, ".git"), { recursive: true });
      await Deno.writeTextFile(
        join(repository, ".git", "HEAD"),
        "ref: main",
      );
      await Deno.mkdir(linkedWorktree, { recursive: true });
      await Deno.mkdir(linkedGitDirectory, { recursive: true });
      await Deno.writeTextFile(join(linkedGitDirectory, "HEAD"), "ref: main");
      await Deno.writeTextFile(
        join(linkedWorktree, ".git"),
        "gitdir: ../../gitdirs/linked-worktree",
      );
      await Deno.mkdir(join(repository, "ignored", ".git"), {
        recursive: true,
      });
      await Deno.mkdir(join(stale, ".git"), { recursive: true });
      await Deno.writeTextFile(join(stale, ".git", "HEAD"), "invalid");
      await Deno.mkdir(join(nestedCheckout, ".git"), { recursive: true });
      await Deno.writeTextFile(
        join(nestedCheckout, ".git", "HEAD"),
        "ref: main",
      );

      expect(
        await discoverGitCheckoutDirectories(
          [directory],
          undefined,
          (candidate) => Promise.resolve(candidate !== stale),
        ),
      ).toEqual([linkedWorktree, repository, nestedCheckout]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("rejects a search root that is not a directory", async () => {
    const directory = await Deno.makeTempDir();
    const file = join(directory, "file");
    try {
      await Deno.writeTextFile(file, "not a directory");
      await expect(
        discoverGitCheckoutDirectories(
          [file],
          undefined,
          () => Promise.resolve(true),
        ),
      ).rejects.toThrow(
        `checkout search root is not a directory: ${file}`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("does not count a .git that names no Git directory", async () => {
    const directory = await Deno.makeTempDir();
    try {
      const real = join(directory, "real");
      await Deno.mkdir(join(real, ".git"), { recursive: true });
      await Deno.writeTextFile(join(real, ".git", "HEAD"), "ref: main");
      const symlinked = join(directory, "symlinked");
      await Deno.mkdir(symlinked);
      await Deno.symlink(join(real, ".git"), join(symlinked, ".git"));
      const unlabelled = join(directory, "unlabelled");
      await Deno.mkdir(unlabelled);
      await Deno.writeTextFile(join(unlabelled, ".git"), "not a gitdir line");
      await Deno.mkdir(join(directory, "headless", ".git"), {
        recursive: true,
      });
      const validated: string[] = [];
      expect(
        await discoverGitCheckoutDirectories(
          [directory],
          undefined,
          (candidate) => {
            validated.push(candidate);
            return Promise.resolve(true);
          },
        ),
      ).toEqual([real]);
      expect(validated).toEqual([real]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("reports a gitdir it cannot inspect", async () => {
    const directory = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(directory, ".git"),
        `gitdir: ${"x".repeat(300)}`,
      );
      const failure = await discoverGitCheckoutDirectories(
        [directory],
        undefined,
        () => Promise.resolve(true),
      ).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(Deno.errors.NotFound);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
