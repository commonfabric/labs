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
});
