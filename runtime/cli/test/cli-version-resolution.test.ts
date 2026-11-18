import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  buildInfo,
  gitShaForCliLibDir,
  relateShasIn,
  resolveCliVersion,
} from "../lib/build-info.ts";

describe("cli-version-resolution", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir({ prefix: "cli-version-resolution-" });
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  describe("gitShaForCliLibDir()", () => {
    it("returns `null` for a directory that does not exist", async () => {
      expect(await gitShaForCliLibDir(join(tempDir, "absent"))).toBeNull();
    });

    it("returns `null` for a repository with no `runtime/cli/lib` tree", async () => {
      const git = (...args: string[]) =>
        new Deno.Command("git", {
          args: [
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@test.invalid",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          cwd: tempDir,
          stdout: "null",
          stderr: "null",
        }).output();
      expect((await git("init")).code).toBe(0);
      expect((await git("commit", "--allow-empty", "-m", "initial")).code)
        .toBe(0);

      expect(await gitShaForCliLibDir(tempDir)).toBeNull();
    });
  });

  describe("relateShasIn()", () => {
    it("returns `unknown` when git cannot start in the directory", async () => {
      expect(
        await relateShasIn(
          join(tempDir, "absent"),
          "a".repeat(40),
          "b".repeat(40),
        ),
      ).toEqual({ kind: "unknown" });
    });
  });

  describe("resolveCliVersion()", () => {
    it("returns the baked commit and no checkout for a compiled binary", async () => {
      expect(await resolveCliVersion(true)).toEqual({
        sha: buildInfo.commitSha,
        checkoutDir: null,
      });
    });

    it("returns nothing for a module loaded from a URL that is not a file", async () => {
      expect(
        await resolveCliVersion(
          false,
          "https://example.com/runtime/cli/lib/build-info.ts",
        ),
      ).toEqual({ sha: null, checkoutDir: null });
    });

    it("returns this checkout's HEAD and directory for a source run", async () => {
      const lib = join(import.meta.dirname!, "..", "lib");
      const head = await new Deno.Command("git", {
        args: ["rev-parse", "HEAD"],
        cwd: lib,
        stdout: "piped",
        stderr: "null",
      }).output();
      expect(head.code).toBe(0);

      const version = await resolveCliVersion(false);

      expect(version.sha).toBe(new TextDecoder().decode(head.stdout).trim());
      expect(version.checkoutDir).toBe(lib);
    });
  });
});
