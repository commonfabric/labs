import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { buildCallableScript } from "./callables.ts";

describe("callables", () => {
  describe("buildCallableScript()", () => {
    it("runs the launcher on the script and its arguments when both paths hold a space, an emoji and a quote", async () => {
      // A shebang line ends its interpreter at the first space, so a
      // launcher under such a directory runs only if the script reaches it
      // through the shell.

      const dir = await Deno.makeTempDir({ prefix: "callables " });
      try {
        const launcherDir = join(dir, "cf 🦆 it's");
        await Deno.mkdir(launcherDir);
        const launcher = join(launcherDir, "cf");
        await Deno.writeTextFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$@"\n`, {
          mode: 0o755,
        });
        const script = join(dir, "search 🦆.tool");
        await Deno.writeFile(script, buildCallableScript(launcher, {}, "x"), {
          mode: 0o755,
        });

        const { success, stdout } = await new Deno.Command(script, {
          args: ["--query", "oat milk"],
        }).output();

        expect(success).toBe(true);
        expect(new TextDecoder().decode(stdout)).toBe(
          `exec\n${script}\n--query\noat milk\n`,
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
