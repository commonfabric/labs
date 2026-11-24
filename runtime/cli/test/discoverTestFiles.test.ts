/**
 * The files `cf test` finds in a directory.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { discoverTestFiles } from "../lib/test-runner.ts";

describe("discoverTestFiles()", () => {
  it("returns the pattern tests in a directory and its subdirectories, and no other file", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(dir, "nested", "deeper"), { recursive: true });
      await Deno.writeTextFile(join(dir, "top.test.tsx"), "");
      await Deno.writeTextFile(join(dir, "helper.tsx"), "");
      await Deno.writeTextFile(
        join(dir, "nested", "deeper", "low.test.tsx"),
        "",
      );
      const found = await discoverTestFiles(dir);
      expect(found.toSorted()).toEqual([
        `${dir}/nested/deeper/low.test.tsx`,
        `${dir}/top.test.tsx`,
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("returns no files for a directory that does not exist", async () => {
    const dir = await Deno.makeTempDir();
    await Deno.remove(dir);
    expect(await discoverTestFiles(dir)).toEqual([]);
  });
});
