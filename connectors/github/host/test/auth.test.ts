import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { resolveGithubToken } from "../src/auth.ts";

describe("auth", () => {
  describe("resolveGithubToken()", () => {
    it("returns `GH_TOKEN` without invoking `gh`", async () => {
      let invoked = false;
      const token = await resolveGithubToken(
        (key) => key === "GH_TOKEN" ? " secret " : undefined,
        () => {
          invoked = true;
          return Promise.resolve({ code: 0, stdout: "other", stderr: "" });
        },
      );

      expect(token).toBe("secret");
      expect(invoked).toBe(false);
    });

    it("returns the token printed by `gh auth token`", async () => {
      const token = await resolveGithubToken(
        () => undefined,
        () => Promise.resolve({ code: 0, stdout: "secret\n", stderr: "" }),
      );

      expect(token).toBe("secret");
    });

    it("reports a failed `gh auth token` without including stdout", async () => {
      try {
        await resolveGithubToken(
          () => undefined,
          () =>
            Promise.resolve({
              code: 1,
              stdout: "sensitive",
              stderr: "not logged in\nmore detail",
            }),
        );
        throw new Error("expected token resolution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "gh auth token failed: not logged in",
        );
        expect((error as Error).message.includes("sensitive")).toBe(false);
      }
    });

    it("falls back through both token variables", async () => {
      const token = await resolveGithubToken(
        (key) => key === "GITHUB_TOKEN" ? " fallback " : undefined,
        () => Promise.reject(new Error("must not invoke gh")),
      );
      expect(token).toBe("fallback");
    });

    it("reports unavailable and empty gh token results", async () => {
      await expect(resolveGithubToken(
        () => undefined,
        () => Promise.reject(new Error("gh missing")),
      )).rejects.toThrow("requires GH_TOKEN, GITHUB_TOKEN, or the gh CLI");
      await expect(resolveGithubToken(
        () => undefined,
        () => Promise.resolve({ code: 0, stdout: "  ", stderr: "" }),
      )).rejects.toThrow("gh auth token failed");
    });

    it("uses the default gh command", async () => {
      if (Deno.build.os === "windows") return;
      const directory = await Deno.makeTempDir();
      const executable = join(directory, "gh");
      const previousPath = Deno.env.get("PATH");
      try {
        await Deno.writeTextFile(
          executable,
          "#!/bin/sh\nprintf 'default-command-token\\n'\n",
          { mode: 0o700 },
        );
        await Deno.chmod(executable, 0o700);
        Deno.env.set("PATH", directory);
        expect(await resolveGithubToken(() => undefined)).toBe(
          "default-command-token",
        );
      } finally {
        if (previousPath === undefined) Deno.env.delete("PATH");
        else Deno.env.set("PATH", previousPath);
        await Deno.remove(directory, { recursive: true });
      }
    });
  });
});
