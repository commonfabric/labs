import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { gitUncommitted } from "../commands/pattern.ts";

const git = async (cwd: string, ...args: string[]) => {
  const { code } = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    stdout: "null",
    stderr: "null",
  }).output();
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
};

describe("pattern", () => {
  describe("gitUncommitted()", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir();
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    it("returns the edited and the untracked paths, and not the committed one", async () => {
      await git(dir, "init", "-q");
      for (const name of ["clean.tsx", "edited.tsx"]) {
        await Deno.writeTextFile(join(dir, name), "export {};\n");
      }
      await git(dir, "add", ".");
      await git(
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-qm",
        "x",
      );
      await Deno.writeTextFile(
        join(dir, "edited.tsx"),
        "export const x = 1;\n",
      );
      await Deno.writeTextFile(join(dir, "new.tsx"), "export {};\n");

      expect(
        await gitUncommitted(
          ["clean.tsx", "edited.tsx", "new.tsx"].map((n) => join(dir, n)),
        ),
      ).toEqual([join(dir, "edited.tsx"), join(dir, "new.tsx")]);
    });

    it("returns undefined outside a git working tree", async () => {
      await Deno.writeTextFile(join(dir, "a.tsx"), "export {};\n");

      expect(await gitUncommitted([join(dir, "a.tsx")])).toBeUndefined();
    });
  });
});
