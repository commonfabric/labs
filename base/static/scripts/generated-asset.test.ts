import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cliMain, type GeneratedAsset, runCli } from "./generated-asset.ts";

/**
 * Tests for the command line the generator scripts share.
 *
 * These write to temporary files, so they run under the Deno test runner only.
 * They live beside the module under `scripts/`, where the recursive deno-test
 * task finds them but the browser-bundled `test/*.test.ts` pass does not.
 */

const TEXT = "// generated\n";

function testAsset(target: string): GeneratedAsset {
  return {
    target,
    genTask: "deno task gen-thing",
    generate: () => TEXT,
  };
}

describe("generated-asset", () => {
  describe("runCli()", () => {
    it("returns 0 in check mode when the target matches", async () => {
      const target = await Deno.makeTempFile({ suffix: ".ts" });
      try {
        await Deno.writeTextFile(target, TEXT);
        expect(await runCli(["--check"], testAsset(target))).toBe(0);
      } finally {
        await Deno.remove(target);
      }
    });

    it("returns 1 in check mode when the target differs", async () => {
      const target = await Deno.makeTempFile({ suffix: ".ts" });
      try {
        await Deno.writeTextFile(target, "// stale\n");
        expect(await runCli(["--check"], testAsset(target))).toBe(1);
      } finally {
        await Deno.remove(target);
      }
    });

    it("returns 1 in check mode when the target does not exist", async () => {
      const dir = await Deno.makeTempDir();
      try {
        const target = `${dir}/does-not-exist.ts`;
        expect(await runCli(["--check"], testAsset(target))).toBe(1);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("writes the generated text when not in check mode", async () => {
      const target = await Deno.makeTempFile({ suffix: ".ts" });
      try {
        await Deno.writeTextFile(target, "// stale\n");
        expect(await runCli([], testAsset(target))).toBe(0);
        expect(await Deno.readTextFile(target)).toBe(TEXT);
      } finally {
        await Deno.remove(target);
      }
    });

    it("writes to the given target instead of the asset's own", async () => {
      const target = await Deno.makeTempFile({ suffix: ".ts" });
      try {
        const asset = testAsset("/nonexistent-directory/unwritable.ts");
        expect(await runCli([], asset, target)).toBe(0);
        expect(await Deno.readTextFile(target)).toBe(TEXT);
      } finally {
        await Deno.remove(target);
      }
    });
  });

  describe("cliMain()", () => {
    it("exits with the CLI's status when the module is the entry point", async () => {
      const target = await Deno.makeTempFile({ suffix: ".ts" });
      try {
        await Deno.writeTextFile(target, "// stale\n");
        let exitCode: number | undefined;
        // A fake `exit` captures the status rather than terminating the test
        // runner.
        await cliMain(testAsset(target), ["--check"], true, (code) => {
          exitCode = code;
        });
        expect(exitCode).toBe(1);
      } finally {
        await Deno.remove(target);
      }
    });

    it("does nothing when the module is not the entry point", async () => {
      const target = await Deno.makeTempFile({ suffix: ".ts" });
      try {
        await Deno.writeTextFile(target, "// stale\n");
        let exited = false;
        await cliMain(testAsset(target), ["--check"], false, () => {
          exited = true;
        });
        expect(exited).toBe(false);
      } finally {
        await Deno.remove(target);
      }
    });
  });
});
