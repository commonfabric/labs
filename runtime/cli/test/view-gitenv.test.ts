/**
 * Tests for the environment `cf view` runs git in for a directory's
 * repository: what it leaves out of the environment it was started with, and
 * what happens when git cannot say what to leave out.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import { repositoryEnv, repositoryIndependentEnv } from "../lib/view/gitenv.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A directory holding a `git` that prints `message` and fails. */
function brokenGit(message: string): string {
  const bin = Deno.makeTempDirSync();
  const git = join(bin, "git");
  Deno.writeTextFileSync(git, `#!/bin/sh\necho '${message}' >&2\nexit 1\n`);
  Deno.chmodSync(git, 0o755);
  return bin;
}

describe("gitenv", () => {
  describe("repositoryIndependentEnv()", () => {
    it("leaves out the variables that tie git to one repository, and no others", () => {
      const env = repositoryIndependentEnv({
        PATH: Deno.env.get("PATH") ?? "",
        GIT_DIR: "/somewhere/.git",
        GIT_WORK_TREE: "/somewhere",
        GIT_CONFIG_PARAMETERS: "'core.abbrev'='12'",
        GIT_AUTHOR_NAME: "Carol",
      });

      expect(env).toEqual({
        PATH: Deno.env.get("PATH") ?? "",
        GIT_CONFIG_PARAMETERS: "'core.abbrev'='12'",
        GIT_AUTHOR_NAME: "Carol",
      });
    });

    it("throws git's message when git cannot list them", () => {
      const bin = brokenGit("git: broken");
      try {
        expect(() => repositoryIndependentEnv({ PATH: bin })).toThrow(
          "git: broken",
        );
      } finally {
        Deno.removeSync(bin, { recursive: true });
      }
    });
  });

  describe("repositoryEnv()", () => {
    it("rejects with git's message when git cannot list them", async () => {
      const bin = brokenGit("git: broken");
      try {
        await expect(repositoryEnv({ PATH: bin }, bin)).rejects.toThrow(
          "git: broken",
        );
      } finally {
        Deno.removeSync(bin, { recursive: true });
      }
    });
  });
});
