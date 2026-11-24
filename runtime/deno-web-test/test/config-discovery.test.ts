import { assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  findDenoConfigPath,
  readConfigIfExists,
  resolveWorkspacePackageImports,
} from "../utils.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-web-test-config-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("findDenoConfigPath prefers deno.json, matching Deno's own resolution", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(join(dir, "deno.jsonc"), "{}");
    assertEquals(await findDenoConfigPath(dir), join(dir, "deno.json"));
  });
});

Deno.test("findDenoConfigPath falls back to deno.jsonc when only it exists", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "deno.jsonc"), "{}");
    assertEquals(await findDenoConfigPath(dir), join(dir, "deno.jsonc"));
  });
});

Deno.test("findDenoConfigPath returns deno.json when only it exists", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    assertEquals(await findDenoConfigPath(dir), join(dir, "deno.json"));
  });
});

Deno.test("findDenoConfigPath returns undefined when no config is present", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await findDenoConfigPath(dir), undefined);
  });
});

Deno.test("readConfigIfExists parses a JSONC config, comments and all", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "deno.jsonc");
    await Deno.writeTextFile(
      configPath,
      `{
  // a workspace package with imports
  "name": "pkg",
  "imports": { "x": "./x.ts" }
}
`,
    );
    const config = await readConfigIfExists(configPath);
    assertEquals(config?.name, "pkg");
    assertEquals(config?.imports, { x: "./x.ts" });
  });
});

Deno.test("readConfigIfExists returns undefined for a missing path", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await readConfigIfExists(join(dir, "deno.jsonc")),
      undefined,
    );
  });
});

Deno.test("readConfigIfExists returns undefined when given no path", async () => {
  assertEquals(await readConfigIfExists(undefined), undefined);
});

Deno.test("findDenoConfigPath rethrows errors that are not NotFound", async () => {
  await withTempDir(async (dir) => {
    // A regular file in a config-name position makes `stat` fail with
    // NotADirectory rather than NotFound, which must propagate.
    const notADir = join(dir, "file");
    await Deno.writeTextFile(notADir, "x");
    await assertRejects(() => findDenoConfigPath(notADir));
  });
});

Deno.test("readConfigIfExists rethrows errors that are not NotFound", async () => {
  await withTempDir(async (dir) => {
    // Reading a directory as a file fails with something other than NotFound.
    await assertRejects(() => readConfigIfExists(dir));
  });
});

Deno.test("resolveWorkspacePackageImports maps member names, exports, and imports", async () => {
  await withTempDir(async (root) => {
    const writeMember = async (
      name: string,
      config: Record<string, unknown>,
    ) => {
      await Deno.mkdir(join(root, name), { recursive: true });
      await Deno.writeTextFile(
        join(root, name, "deno.jsonc"),
        JSON.stringify(config),
      );
    };

    // String export + own imports.
    await writeMember("a", {
      name: "@scope/a",
      exports: "./mod.ts",
      imports: { dep: "npm:dep@1" },
    });
    // Object exports, including a non-string target that must be skipped.
    await writeMember("b", {
      name: "@scope/b",
      exports: { ".": "./b.ts", "./sub": "./sub.ts", "./bad": 123 },
    });
    // No name: imports still merge, but no export mapping is added.
    await writeMember("c", { imports: { other: "npm:other@1" } });
    // Named, but no exports: skipped after the name check.
    await writeMember("d", { name: "@scope/d" });

    const workspaceConfigPath = join(root, "deno.jsonc");
    const imports = await resolveWorkspacePackageImports(workspaceConfigPath, {
      // A non-string entry and a missing member are both skipped.
      workspace: [123, "./a", "./b", "./c", "./d", "./missing"],
    });

    assertEquals(
      imports["@scope/a"],
      toFileUrl(join(root, "a", "mod.ts")).href,
    );
    assertEquals(imports.dep, "npm:dep@1");
    assertEquals(imports["@scope/b"], toFileUrl(join(root, "b", "b.ts")).href);
    assertEquals(
      imports["@scope/b/sub"],
      toFileUrl(join(root, "b", "sub.ts")).href,
    );
    assertEquals("@scope/b/bad" in imports, false);
    assertEquals(imports.other, "npm:other@1");
    assertEquals("@scope/d" in imports, false);
  });
});
