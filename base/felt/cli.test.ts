import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import { command, PORT_IN_USE_EXIT } from "./cli.ts";

const REPO_ROOT = fromFileUrl(new URL("../../", import.meta.url));

describe("cli", () => {
  let root: string;

  /** Writes a project into `root` whose config adds `extra` to its fields. */
  async function writeProject(extra = "") {
    await Deno.mkdir(join(root, "public"));
    await Deno.writeTextFile(
      join(root, "public", "index.html"),
      "<html><body></body></html>",
    );
    await Deno.writeTextFile(join(root, "main.ts"), `console.log("main");\n`);
    await Deno.writeTextFile(
      join(root, "felt.config.ts"),
      `export default {\n` +
        `  entries: [{ in: "main.ts", out: "scripts/main" }],\n` +
        `  outDir: "dist",\n` +
        `  hostname: "127.0.0.1",\n` +
        extra +
        `};\n`,
    );
  }

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "felt-cli-test-" });
  });

  afterEach(async () => {
    Deno.exitCode = 0;
    await Deno.remove(root, { recursive: true });
  });

  it("builds the project in the directory it is given, into its outDir", async () => {
    await writeProject();

    await command.parse(["build", root]);

    expect(await Deno.readTextFile(join(root, "dist", "scripts", "main.js")))
      .toContain(`console.log("main")`);
    expect(Deno.exitCode).toBe(0);
  });

  it("builds the project when run as a program", async () => {
    await writeProject();

    const output = await runDenoCommandWithTemporaryLock({
      root: REPO_ROOT,
      args: (lockPath) => [
        "run",
        "--config",
        join(REPO_ROOT, "deno.jsonc"),
        "--lock",
        lockPath,
        "--frozen",
        "--no-check",
        "--allow-all",
        fromFileUrl(new URL("./cli.ts", import.meta.url)),
        "build",
        root,
      ],
    });

    expect(new TextDecoder().decode(output.stderr)).toBe("");
    expect(output.code).toBe(0);
    expect(await Deno.readTextFile(join(root, "dist", "scripts", "main.js")))
      .toContain(`console.log("main")`);
  });

  it("rejects when the build fails, leaving the exit status alone", async () => {
    await writeProject();
    await Deno.remove(join(root, "main.ts"));

    await expect(command.parse(["build", root])).rejects.toThrow(
      "Build failed",
    );
    expect(Deno.exitCode).toBe(0);
  });

  it("rejects a directory with no felt.config.ts", async () => {
    await expect(command.parse(["build", root])).rejects.toThrow(
      "felt.config.ts",
    );
  });

  it("exits with the port-in-use status when the port is taken", async () => {
    using occupant = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    await writeProject(`  port: ${occupant.addr.port},\n`);

    await command.parse(["serve", root]);

    expect(Deno.exitCode).toBe(PORT_IN_USE_EXIT);
  });
});
