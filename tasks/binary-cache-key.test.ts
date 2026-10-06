import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";

import { binaryCacheKey } from "./binary-cache-key.ts";
import { cachedBinaries } from "./ci-capabilities.ts";

/** Runs git in `root`, failing the test on anything but success. */
async function git(root: string, ...args: string[]): Promise<void> {
  const { success, stderr } = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
}

/** Writes `contents` at `at` under `root` and stages it. */
async function stage(root: string, at: string, contents: string) {
  await Deno.mkdir(join(root, at, ".."), { recursive: true });
  await Deno.writeTextFile(join(root, at), contents);
  await git(root, "add", at);
}

/** Runs `body` in a temporary directory, which it removes afterward. */
async function inTempDir(body: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "binary-cache-key-" });
  try {
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** Makes `root` a repository with one binary source and one other file. */
async function initRepository(root: string) {
  await git(root, "init", "--quiet");
  await stage(root, "packages/toolshed/index.ts", "export {};\n");
  await stage(root, "tasks/other.ts", "export {};\n");
}

describe("binary-cache-key", () => {
  it("returns the same hex digest each time for one checkout", async () => {
    await inTempDir(async (root) => {
      await initRepository(root);
      const key = await binaryCacheKey(root);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(await binaryCacheKey(root)).toBe(key);
    });
  });

  it("returns a different digest when a binary source changes", async () => {
    await inTempDir(async (root) => {
      await initRepository(root);
      const before = await binaryCacheKey(root);
      await stage(root, "packages/toolshed/index.ts", "export const x = 1;\n");
      expect(await binaryCacheKey(root)).not.toBe(before);
    });
  });

  it("returns a different digest when a source no import reaches changes", async () => {
    // A service worker and the Deno pin are neither TypeScript nor reached
    // by any import, and both end up in a binary.
    await inTempDir(async (root) => {
      await initRepository(root);
      const before = await binaryCacheKey(root);
      await stage(root, "packages/shell/public/sw.js", "self;\n");
      const withWorker = await binaryCacheKey(root);
      expect(withWorker).not.toBe(before);
      await stage(root, "mise.toml", '[tools]\ndeno = "2.0.0"\n');
      expect(await binaryCacheKey(root)).not.toBe(withWorker);
    });
  });

  it("returns a different digest when a cached binary's build variables change", async () => {
    // The two tables differ only in the define each Toolshed build bakes, and
    // no file under the sources changes between the two keys.
    await inTempDir(async (root) => {
      await initRepository(root);
      const on = await binaryCacheKey(root, cachedBinaries(true));
      expect(await binaryCacheKey(root, cachedBinaries(true))).toBe(on);
      expect(await binaryCacheKey(root, cachedBinaries(false))).not.toBe(on);
    });
  });

  it("returns the same digest when only a file outside the sources changes", async () => {
    await inTempDir(async (root) => {
      await initRepository(root);
      const before = await binaryCacheKey(root);
      await stage(root, "tasks/other.ts", "export const y = 2;\n");
      expect(await binaryCacheKey(root)).toBe(before);
    });
  });

  it("throws for a checkout holding no binary source", async () => {
    await inTempDir(async (root) => {
      await git(root, "init", "--quiet");
      await stage(root, "tasks/other.ts", "export {};\n");
      await expect(binaryCacheKey(root)).rejects.toThrow(
        "listed no binary source",
      );
    });
  });

  it("throws for a directory git cannot read", async () => {
    await inTempDir(async (root) => {
      // A `.git` file naming a missing directory fails git here, rather than
      // letting it search the directories above for a repository.
      await Deno.writeTextFile(join(root, ".git"), "gitdir: missing\n");
      await expect(binaryCacheKey(root)).rejects.toThrow(
        "git ls-files failed",
      );
    });
  });

  it("returns a hex digest for this repository", async () => {
    const root = fromFileUrl(new URL("../", import.meta.url));
    expect(await binaryCacheKey(root)).toMatch(/^[0-9a-f]{64}$/);
  });
});
