/**
 * Unit tests for the package-root walk that anchors a test pattern's import
 * resolution when no explicit root is given. The boundary marker is a
 * deno.json(c) declaring a package `name`; a nameless config only wires tasks
 * and must not capture the walk.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { inferProgramRoot } from "../lib/program-root.ts";

describe("program-root", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "program_root_test_" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  async function write(path: string, contents: string): Promise<void> {
    const full = join(dir, path);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }

  it("returns the nearest ancestor whose deno.json declares a name", async () => {
    await write("pkg/deno.json", `{"name": "@cf-test/pkg"}`);
    await Deno.mkdir(join(dir, "pkg/a/b"), { recursive: true });
    expect(inferProgramRoot(join(dir, "pkg/a/b/main.test.tsx"))).toBe(
      join(dir, "pkg"),
    );
  });

  it("prefers a nearer named config over a farther one", async () => {
    await write("outer/deno.json", `{"name": "@cf-test/outer"}`);
    await write("outer/inner/deno.json", `{"name": "@cf-test/inner"}`);
    expect(inferProgramRoot(join(dir, "outer/inner/main.test.tsx"))).toBe(
      join(dir, "outer/inner"),
    );
  });

  it("skips a nameless config between the entry and a named ancestor", async () => {
    await write("pkg/deno.json", `{"name": "@cf-test/pkg"}`);
    await write("pkg/sub/deno.jsonc", `{"tasks": {"test": "echo none"}}`);
    expect(inferProgramRoot(join(dir, "pkg/sub/main.test.tsx"))).toBe(
      join(dir, "pkg"),
    );
  });

  it("reads a name from a deno.jsonc with comments", async () => {
    await write(
      "pkg/deno.jsonc",
      `{\n  // package marker\n  "name": "@cf-test/pkg",\n}`,
    );
    expect(inferProgramRoot(join(dir, "pkg/main.test.tsx"))).toBe(
      join(dir, "pkg"),
    );
  });

  it("ignores a config whose name is not a string", async () => {
    await write("pkg/deno.json", `{"name": "@cf-test/pkg"}`);
    await write("pkg/sub/deno.json", `{"name": 5}`);
    expect(inferProgramRoot(join(dir, "pkg/sub/main.test.tsx"))).toBe(
      join(dir, "pkg"),
    );
  });

  it("ignores a named deno.jsonc shadowed by a nameless deno.json", async () => {
    await write("pkg/deno.json", `{"name": "@cf-test/pkg"}`);
    await write("pkg/sub/deno.json", `{"tasks": {"test": "echo none"}}`);
    await write("pkg/sub/deno.jsonc", `{"name": "@cf-test/ignored"}`);
    expect(inferProgramRoot(join(dir, "pkg/sub/main.test.tsx"))).toBe(
      join(dir, "pkg"),
    );
  });

  it("anchors on a named deno.json beside a nameless deno.jsonc", async () => {
    await write("pkg/deno.json", `{"name": "@cf-test/pkg"}`);
    await write("pkg/deno.jsonc", `{"tasks": {"test": "echo none"}}`);
    expect(inferProgramRoot(join(dir, "pkg/main.test.tsx"))).toBe(
      join(dir, "pkg"),
    );
  });

  it("falls through to deno.jsonc when deno.json is a directory", async () => {
    // Deno's own discovery does the same: a non-file deno.json does not
    // shadow its companion, so the named deno.jsonc anchors here.
    await Deno.mkdir(join(dir, "pkg/deno.json"), { recursive: true });
    await write("pkg/deno.jsonc", `{"name": "@cf-test/pkg"}`);
    expect(inferProgramRoot(join(dir, "pkg/main.test.tsx"))).toBe(
      join(dir, "pkg"),
    );
  });

  it("continues past a config that does not parse", async () => {
    await write("pkg/deno.json", `{"name": "@cf-test/pkg"}`);
    await write("pkg/sub/deno.json", `{not json`);
    expect(inferProgramRoot(join(dir, "pkg/sub/main.test.tsx"))).toBe(
      join(dir, "pkg"),
    );
  });

  it("returns undefined when no ancestor declares a name", async () => {
    await Deno.mkdir(join(dir, "plain/nested"), { recursive: true });
    expect(inferProgramRoot(join(dir, "plain/nested/main.test.tsx")))
      .toBeUndefined();
  });
});
