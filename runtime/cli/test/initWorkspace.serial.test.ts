/**
 * Calls `initWorkspace()` in-process on a temporary directory, with a
 * documentation directory of the test's own. Serial, since it replaces
 * `console.warn` to read the warning.
 */

import { expect } from "@std/expect";
import { exists } from "@std/fs/exists";
import { join } from "@std/path";

import { initWorkspace } from "../commands/init.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

describe("initWorkspace()", () => {
  let dir: string;
  let warnings: string[];
  const originalWarn = console.warn;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "cf-init-" });
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
  });

  afterEach(async () => {
    console.warn = originalWarn;
    await Deno.remove(dir, { recursive: true });
  });

  it("copies each file of the documentation directory to `.cf-docs`, leaving out its subdirectories", async () => {
    const docs = join(dir, "docs");
    await Deno.mkdir(join(docs, "nested"), { recursive: true });
    await Deno.writeTextFile(join(docs, "guide.md"), "# Guide\n");
    await Deno.writeTextFile(join(docs, "nested", "deep.md"), "# Deep\n");
    const workspace = join(dir, "workspace");
    await Deno.mkdir(workspace);

    await initWorkspace(workspace, docs);

    const copied = [];
    for await (const entry of Deno.readDir(join(workspace, ".cf-docs"))) {
      copied.push(entry.name);
    }
    expect(copied).toEqual(["guide.md"]);
    expect(await Deno.readTextFile(join(workspace, ".cf-docs", "guide.md")))
      .toBe("# Guide\n");
    expect(warnings).toEqual([]);
  });

  it("warns, still writing the types and `tsconfig.json`, when the documentation directory cannot be read", async () => {
    const missing = join(dir, "no-docs");

    await initWorkspace(dir, missing);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^Warning: Could not copy pattern documentation: .*no-docs/,
    );
    expect(await exists(join(dir, "tsconfig.json"))).toBe(true);
    expect(
      await exists(join(dir, ".cf-types", "commonfabric", "index.d.ts")),
    ).toBe(true);
  });
});
