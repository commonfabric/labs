import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";

import {
  resolveRunscSandboxConfig,
  RunscSandboxRuntime,
  verifyPrivateScratchParent,
} from "../src/sandbox/runsc.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";

/** Names of the entries in the directory at `path`. */
const entriesOf = async (path: string): Promise<string[]> => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names;
};

describe("runsc", () => {
  /** Real path of this case's tree, which holds everything the case makes. */
  let root: string;

  /** A directory of this user with mode 0700, as a scratch parent has to be. */
  let parent: string;

  /** The user that owns what this process makes. */
  let mine: number;

  beforeEach(async () => {
    root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "runsc-scratch-parent-" }),
    );
    parent = join(root, "cf-harness-runsc");
    await Deno.mkdir(parent, { mode: 0o700 });
    await Deno.chmod(parent, 0o700);
    mine = (await Deno.lstat(parent)).uid!;
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  describe("verifyPrivateScratchParent()", () => {
    it("creates an absent parent with mode 0700 and nothing in it", async () => {
      const absent = join(root, "fresh", "cf-harness-runsc");
      await verifyPrivateScratchParent(absent);
      const info = await Deno.lstat(absent);
      expect(info.isDirectory).toBe(true);
      expect(info.mode! & 0o777).toBe(0o700);
      expect(await entriesOf(absent)).toEqual([]);
    });

    it("resolves for a private directory of this user and leaves nothing in it", async () => {
      await verifyPrivateScratchParent(parent);
      expect(await entriesOf(parent)).toEqual([]);
    });

    it("resolves under read and write permission alone", async () => {
      // Neither the `sys` permission nor a subprocess: whose the directory
      // is comes from what this process makes in it.
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-lock",
          "--no-check",
          "--no-prompt",
          "--allow-read",
          "--allow-write",
          fromFileUrl(
            new URL(
              "./fixtures/verify-private-scratch-parent.ts",
              import.meta.url,
            ),
          ),
          parent,
        ],
        env: { NO_COLOR: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const decoder = new TextDecoder();
      expect({
        code: result.code,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      }).toEqual({ code: 0, stdout: "verified\n", stderr: "" });
      expect(await entriesOf(parent)).toEqual([]);
    });

    describe("given owners that differ", () => {
      // No test can make a directory another user owns without being
      // privileged, so the owners come from a stand-in for the reading of
      // them. The two cases are the two ways round: the parent is someone
      // else's, and what this process makes is.

      it("rejects for a parent another user owns, naming both owners", async () => {
        const theirs = mine + 1;
        await expect(
          verifyPrivateScratchParent(
            parent,
            (path) => Promise.resolve(path === parent ? theirs : mine),
          ),
        ).rejects.toThrow(
          new RegExp(
            `not a private directory of this user \\(owner ${theirs}, mode 700; what this process makes there is owned by ${mine}\\)`,
          ),
        );
        expect(await entriesOf(parent)).toEqual([]);
      });

      it("rejects when what this process makes belongs to another user than the parent does", async () => {
        const effective = mine + 1;
        await expect(
          verifyPrivateScratchParent(
            parent,
            (path) => Promise.resolve(path === parent ? mine : effective),
          ),
        ).rejects.toThrow(
          new RegExp(
            `\\(owner ${mine}, mode 700; what this process makes there is owned by ${effective}\\)`,
          ),
        );
        expect(await entriesOf(parent)).toEqual([]);
      });

      it("rejects for a parent it created itself", async () => {
        const absent = join(root, "fresh", "cf-harness-runsc");
        await expect(
          verifyPrivateScratchParent(
            absent,
            (path) => Promise.resolve(path === absent ? mine + 1 : mine),
          ),
        ).rejects.toThrow("not a private directory of this user");
        expect(await entriesOf(absent)).toEqual([]);
      });
    });

    it("rejects with the reader's own error when an owner cannot be read, leaving nothing in the parent", async () => {
      await expect(
        verifyPrivateScratchParent(
          parent,
          () => Promise.reject(new Error("the owner could not be read")),
        ),
      ).rejects.toThrow("the owner could not be read");
      expect(await entriesOf(parent)).toEqual([]);
    });

    it("rejects for a parent with access for group or others, making nothing in it", async () => {
      for (const mode of [0o755, 0o750, 0o705, 0o770, 0o701]) {
        await Deno.chmod(parent, mode);
        await expect(verifyPrivateScratchParent(parent)).rejects.toThrow(
          `mode ${
            mode.toString(8)
          }); remove it or set TMPDIR to a private directory`,
        );
        expect(await entriesOf(parent)).toEqual([]);
      }
    });

    it("rejects for a symbolic link to a private directory, making nothing in that directory", async () => {
      const link = join(root, "link");
      await Deno.symlink(parent, link);
      await expect(verifyPrivateScratchParent(link)).rejects.toThrow(
        "not a private directory of this user (a symbolic link, ",
      );
      expect(await entriesOf(parent)).toEqual([]);
    });

    it("rejects for a symbolic link whose target does not exist", async () => {
      const link = join(root, "link");
      await Deno.symlink(join(root, "nowhere"), link);
      await expect(verifyPrivateScratchParent(link)).rejects.toThrow(
        "not a private directory of this user (a symbolic link, ",
      );
      await expect(Deno.lstat(join(root, "nowhere"))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    });

    it("rejects for a file", async () => {
      const file = join(root, "file");
      await Deno.writeTextFile(file, "");
      await Deno.chmod(file, 0o600);
      await expect(verifyPrivateScratchParent(file)).rejects.toThrow(
        "not a private directory of this user (not a directory, ",
      );
    });
  });

  describe("RunscSandboxRuntime", () => {
    /** A runner that records what it is asked to run, and runs nothing. */
    class RecordingRunner implements ProcessRunner {
      readonly runs: ProcessRunRequest[] = [];

      run(request: ProcessRunRequest): Promise<ProcessRunResult> {
        this.runs.push(request);
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      }
    }

    let savedTmpdir: string | undefined;

    beforeEach(() => {
      savedTmpdir = Deno.env.get("TMPDIR");
      Deno.env.set("TMPDIR", root);
    });

    afterEach(() => {
      if (savedTmpdir === undefined) Deno.env.delete("TMPDIR");
      else Deno.env.set("TMPDIR", savedTmpdir);
    });

    const runtimeOnTheDefaultScratch = (runner: ProcessRunner) => {
      const config = resolveRunscSandboxConfig({
        workspaceHostPath: join(root, "ws"),
        runscBinary: join(root, "bin", "runsc"),
        rootfs: join(root, "rootfs"),
        platform: "linux",
      });
      expect(config.scratchParentToVerify).toBe(parent);
      return new RunscSandboxRuntime(config, runner);
    };

    it("rejects a call, having started no container and written nothing, when the default scratch parent is not private", async () => {
      await Deno.chmod(parent, 0o755);
      const runner = new RecordingRunner();
      const runtime = runtimeOnTheDefaultScratch(runner);
      await expect(runtime.run({ argv: ["true"] })).rejects.toThrow(
        "not a private directory of this user",
      );
      await expect(runtime.run({ argv: ["true"], session: "s" })).rejects
        .toThrow("not a private directory of this user");
      expect(runner.runs.filter((r) => r.command === "/bin/sh")).toEqual([]);
      expect(await entriesOf(parent)).toEqual([]);
      await runtime.close();
    });

    it("writes a call's bundle under a scratch parent that is private", async () => {
      const runner = new RecordingRunner();
      const runtime = runtimeOnTheDefaultScratch(runner);
      try {
        await runtime.run({ argv: ["true"] });
        const wrapped = runner.runs.filter((r) => r.command === "/bin/sh");
        expect(wrapped.length).toBe(1);
        const bundle = wrapped[0]!
          .args[wrapped[0]!.args.indexOf("--bundle") + 1]!;
        expect(bundle.startsWith(`${parent}/`)).toBe(true);
      } finally {
        await runtime.close();
      }
    });
  });
});
