import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  defaultLabsRootFromModulePath,
  fileUrlToPath,
  formatCfLauncherUsage,
  parseCfLauncherArgs,
  readInitCwd,
} from "../launcher.ts";

const launcherPath = fileUrlToPath(
  new URL("../launcher.ts", import.meta.url).href,
);
const repoRoot = join(import.meta.dirname!, "..", "..", "..");

/** `parseCfLauncherArgs` from `cwd` with `argv`, refusing a help result. */
function parse(cwd: string, argv: string[]) {
  const parsed = parseCfLauncherArgs({
    argv,
    cwd,
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/runtime/cli/launcher.ts",
  });
  if ("help" in parsed) throw new Error("unexpected help result");
  return parsed;
}

describe("launcher-arguments", () => {
  describe("defaultLabsRootFromModulePath()", () => {
    it("climbs above a bare module name with `..` segments", () => {
      expect(defaultLabsRootFromModulePath("launcher.ts")).toBe("../..");
    });

    it("stops at the filesystem root", () => {
      expect(defaultLabsRootFromModulePath("/launcher.ts")).toBe("/");
    });

    it("stops at a drive root", () => {
      expect(defaultLabsRootFromModulePath("C:/launcher.ts")).toBe("C:/");
    });
  });

  describe("fileUrlToPath()", () => {
    it("throws for a URL that is not a file URL", () => {
      expect(() => fileUrlToPath("https://example.com/launcher.ts")).toThrow(
        "expected file URL, received https://example.com/launcher.ts",
      );
    });
  });

  describe("parseCfLauncherArgs()", () => {
    it("keeps the `..` segments a relative path climbs above its start", () => {
      expect(parse("work", ["--cwd", "../../elsewhere"]).cwd).toBe(
        "../elsewhere",
      );
    });

    it("resolves a path that climbs back to its start as `.`", () => {
      expect(parse("work", ["--cwd", ".."]).cwd).toBe(".");
    });

    it("resolves the filesystem root as itself", () => {
      expect(parse("/workspace", ["--cwd", "/"]).cwd).toBe("/");
    });

    it("resolves a relative option against nothing when the cwd is empty", () => {
      expect(parse("", ["--labs-root", "labs"]).configPath).toBe(
        "labs/deno.jsonc",
      );
    });
  });

  describe("readInitCwd()", () => {
    it("returns INIT_CWD when it is set", () => {
      expect(readInitCwd({ get: () => "/workspace/consumer" })).toBe(
        "/workspace/consumer",
      );
    });

    it("returns `undefined` for an unset or blank INIT_CWD", () => {
      expect(readInitCwd({ get: () => undefined })).toBeUndefined();
      expect(readInitCwd({ get: () => "  " })).toBeUndefined();
    });

    it("returns `undefined` when the environment cannot be read", () => {
      const env = {
        get: (): string | undefined => {
          throw new Deno.errors.NotCapable("Requires env access");
        },
      };
      expect(readInitCwd(env)).toBeUndefined();
    });
  });

  describe("main", () => {
    it("prints the launcher usage for --launcher-help and starts no child", async () => {
      const output = await runDenoCommandWithTemporaryLock({
        root: repoRoot,
        args: (lockPath) => [
          "run",
          `--lock=${lockPath}`,
          "--frozen=true",
          "--allow-env",
          "--allow-read",
          launcherPath,
          "--launcher-help",
        ],
      });

      expect(new TextDecoder().decode(output.stderr)).toBe("");
      expect(new TextDecoder().decode(output.stdout)).toBe(
        `${formatCfLauncherUsage()}\n`,
      );
      expect(output.code).toBe(0);
    });
  });
});
