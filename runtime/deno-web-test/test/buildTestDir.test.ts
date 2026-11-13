/**
 * What `buildTestDir` puts on the static server for a project: the harness,
 * the files a config's `include` names, and the modules its `bundle` names.
 */

import { join, toFileUrl } from "@std/path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { removeDirectory } from "@commonfabric/test-support/remove-directory";

import { applyDefaults, type Config } from "../config.ts";
import { Manifest } from "../manifest.ts";
import { buildTestDir } from "../utils.ts";

/** A module the bundler leaves `/vendor/left-pad.js` unresolved in. */
const DISPOSING_MODULE = `
import { pad } from "/vendor/left-pad.js";
export function padded(): string {
  using _resource = { [Symbol.dispose]() {} };
  return pad("x");
}
`;

describe("buildTestDir()", () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "deno-web-test-build-" });
    projectDir = join(root, "project");
    await Deno.mkdir(projectDir);
  });

  afterEach(async () => {
    await removeDirectory(root);
  });

  /** Builds the server directory for `config`, returning where it is. */
  async function build(config: Config): Promise<string> {
    const runDir = join(root, "run");
    const manifest = new Manifest(
      projectDir,
      [],
      runDir,
      applyDefaults(config),
    );
    await Deno.mkdir(manifest.serverDir, { recursive: true });
    await buildTestDir(manifest);
    return manifest.serverDir;
  }

  it("deploys the harness to the server root", async () => {
    const serverDir = await build({});
    expect(await Deno.readTextFile(join(serverDir, "index.html")))
      .toContain('import { start } from "/harness.js"');
    expect(await Deno.readTextFile(join(serverDir, "harness.js")))
      .toContain("export function start(scope)");
  });

  describe("include", () => {
    it("copies a file, making the directories its destination needs", async () => {
      await Deno.writeTextFile(join(projectDir, "a.txt"), "a");
      const serverDir = await build({
        include: { "a.txt": "static/deep/a.txt" },
      });
      expect(await Deno.readTextFile(join(serverDir, "static/deep/a.txt")))
        .toBe("a");
    });

    it("copies a directory with everything under it", async () => {
      await Deno.mkdir(join(projectDir, "assets/nested"), { recursive: true });
      await Deno.writeTextFile(join(projectDir, "assets/top.txt"), "top");
      await Deno.writeTextFile(
        join(projectDir, "assets/nested/inner.txt"),
        "inner",
      );
      const serverDir = await build({ include: { "assets": "public" } });
      expect(await Deno.readTextFile(join(serverDir, "public/top.txt")))
        .toBe("top");
      expect(
        await Deno.readTextFile(join(serverDir, "public/nested/inner.txt")),
      ).toBe("inner");
    });

    it("copies what a symbolic link points to rather than the link", async () => {
      await Deno.mkdir(join(root, "elsewhere"));
      await Deno.writeTextFile(join(root, "elsewhere/target.txt"), "target");
      await Deno.symlink(
        join(root, "elsewhere/target.txt"),
        join(projectDir, "file-link"),
      );
      await Deno.symlink(join(root, "elsewhere"), join(projectDir, "dir-link"));
      const serverDir = await build({
        include: { "file-link": "file.txt", "dir-link": "dir" },
      });

      const file = join(serverDir, "file.txt");
      expect(Deno.lstatSync(file).isFile).toBe(true);
      expect(await Deno.readTextFile(file)).toBe("target");
      const dir = join(serverDir, "dir");
      expect(Deno.lstatSync(dir).isDirectory).toBe(true);
      expect(await Deno.readTextFile(join(dir, "target.txt"))).toBe("target");
    });
  });

  describe("bundle", () => {
    it("leaves an external import for the page to resolve", async () => {
      await Deno.writeTextFile(join(projectDir, "mod.ts"), DISPOSING_MODULE);
      const serverDir = await build({
        bundle: { "mod.ts": "mod.js" },
        esbuildConfig: { external: ["/vendor/left-pad.js"] },
      });
      const bundled = await Deno.readTextFile(join(serverDir, "mod.js"));
      expect(bundled).toContain('from "/vendor/left-pad.js"');
      expect(bundled).toContain("export {");
      // With `using` supported, the declaration is left as it is.
      expect(bundled).toMatch(/using _resource/);
    });

    it("resolves the workspace's packages and merges its compiler options", async () => {
      // The project is a member of a workspace at `root`, beside a package
      // it imports by name, and each level sets some compiler options.
      const writeJson = (file: string, value: unknown) =>
        Deno.writeTextFile(join(root, file), JSON.stringify(value));
      await Deno.mkdir(join(root, "lib"));
      await writeJson("deno.json", {
        workspace: ["./lib", "./project"],
        compilerOptions: { strict: true, jsx: "react", jsxFactory: "w" },
      });
      await writeJson("lib/deno.json", {
        name: "@example/lib",
        exports: { ".": "./mod.ts" },
      });
      await Deno.writeTextFile(
        join(root, "lib/mod.ts"),
        'export const greeting = "hello from lib";\n',
      );
      await writeJson("project/deno.json", {
        compilerOptions: { jsxFactory: "p", jsxFragmentFactory: "pf" },
      });
      await Deno.writeTextFile(
        join(projectDir, "mod.ts"),
        'import { greeting } from "@example/lib";\nconsole.log(greeting);\n',
      );

      const serverDir = await build({
        bundle: { "mod.ts": "mod.js" },
        esbuildConfig: {
          tsconfigRaw: { compilerOptions: { jsxFragmentFactory: "e" } },
        },
      });

      expect(await Deno.readTextFile(join(serverDir, "mod.js")))
        .toContain("hello from lib");
      const bundleConfig = JSON.parse(
        await Deno.readTextFile(join(serverDir, "deno-web-test.bundle.json")),
      );
      expect(bundleConfig.imports["@example/lib"]).toBe(
        toFileUrl(join(root, "lib/mod.ts")).href,
      );
      expect(bundleConfig.compilerOptions).toEqual({
        strict: true,
        jsx: "react",
        jsxFactory: "p",
        jsxFragmentFactory: "e",
      });
    });

    it("lowers `using` where the config says it is unsupported", async () => {
      await Deno.writeTextFile(join(projectDir, "mod.ts"), DISPOSING_MODULE);
      const serverDir = await build({
        bundle: { "mod.ts": "mod.js" },
        esbuildConfig: {
          external: ["/vendor/left-pad.js"],
          supported: { using: false },
        },
      });
      const bundled = await Deno.readTextFile(join(serverDir, "mod.js"));
      expect(bundled).not.toMatch(/using _resource/);
      expect(bundled).toContain("__addDisposableResource");
      expect(bundled).toContain('from "/vendor/left-pad.js"');
    });
  });
});
