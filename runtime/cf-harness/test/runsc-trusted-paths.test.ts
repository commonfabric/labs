/**
 * The runsc binary, the CFC policy and the rootfs decide how a sandbox is
 * built and what its trusted result says, so each is held to naming one file
 * for the check against the mounts and for every later use. The cases here
 * build real directory trees, links included, because the defects they guard
 * against live in the difference between a path's spelling and where the
 * filesystem takes it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  resolveRunscSandboxConfig,
  RunscSandboxRuntime,
} from "../src/sandbox/runsc.ts";
import type {
  ProcessHandle,
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
  ProcessSpawnRequest,
} from "../src/sandbox/process-runner.ts";

/** The three settings under test, by the option that carries each. */
const TRUSTED = [
  { option: "runscBinary", label: "runsc binary", leaf: "runsc" },
  { option: "cfcPolicyPath", label: "CFC policy", leaf: "policy.json" },
  { option: "rootfs", label: "sandbox rootfs", leaf: "rootfs" },
] as const;

type TrustedOption = typeof TRUSTED[number]["option"];

/**
 * A runner that records what it is asked to run and reports every container
 * as running, so a session starts. It runs nothing.
 */
class RecordingRunner implements ProcessRunner {
  readonly runs: ProcessRunRequest[] = [];
  readonly spawns: ProcessSpawnRequest[] = [];
  readonly specs: Array<{ root: { path: string } }> = [];

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.runs.push(request);
    this.#recordSpec(request.args);
    return Promise.resolve({
      stdout: '{"status": "running"}\n',
      stderr: "",
      exitCode: 0,
    });
  }

  spawn(request: ProcessSpawnRequest): ProcessHandle {
    this.spawns.push(request);
    this.#recordSpec(request.args);
    let end!: (status: { exitCode: number }) => void;
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      end = resolve;
    });
    return { pid: 1, exited, kill: () => end({ exitCode: 137 }) };
  }

  /** Reads the spec of the bundle `args` names, when they name one. */
  #recordSpec(args: readonly string[]): void {
    const bundleAt = args.indexOf("--bundle");
    if (bundleAt < 0) return;
    this.specs.push(JSON.parse(
      Deno.readTextFileSync(join(args[bundleAt + 1]!, "config.json")),
    ));
  }
}

/**
 * Whether this process searches a directory whose mode forbids it, as a
 * privileged one does. No mode makes a directory unsearchable to such a
 * process, so the case needing one cannot be set up for it.
 */
const searchesDespiteMode = (): boolean => {
  const dir = Deno.makeTempDirSync({ prefix: "runsc-trusted-paths-mode-" });
  try {
    Deno.mkdirSync(join(dir, "in"));
    Deno.chmodSync(dir, 0o000);
    try {
      Deno.lstatSync(join(dir, "in"));
      return true;
    } catch {
      return false;
    }
  } finally {
    Deno.chmodSync(dir, 0o700);
    Deno.removeSync(dir, { recursive: true });
  }
};

/** Writes an executable that appends its own path to `marker` when run. */
const writeProgram = async (path: string, marker: string): Promise<void> => {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\necho "$0" >> '${marker}'\nexit 0\n`,
  );
  await Deno.chmod(path, 0o755);
};

describe("runsc", () => {
  /** Real path of this case's tree, which holds everything the case makes. */
  let root: string;

  /** The writable mount: every file under it is the model's to write. */
  let workspace: string;

  /** Where the operator keeps the three files, outside every mount. */
  let outside: string;

  /** Options naming the operator's own files, for a case to override. */
  let base: Parameters<typeof resolveRunscSandboxConfig>[0];

  let savedCwd: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "runsc-trusted-paths-" }),
    );
    workspace = join(root, "ws");
    outside = join(root, "outside");
    await Deno.mkdir(workspace);
    await writeProgram(join(outside, "runsc"), join(root, "operator.log"));
    await Deno.writeTextFile(join(outside, "policy.json"), "{}");
    await Deno.mkdir(join(outside, "rootfs"));
    await Deno.mkdir(join(root, "scratch"));
    base = {
      workspaceHostPath: workspace,
      runscBinary: join(outside, "runsc"),
      cfcPolicyPath: join(outside, "policy.json"),
      rootfs: join(outside, "rootfs"),
      scratchDir: join(root, "scratch"),
      platform: "linux",
    };
    savedCwd = Deno.cwd();
    savedPath = Deno.env.get("PATH");
  });

  afterEach(async () => {
    Deno.chdir(savedCwd);
    if (savedPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", savedPath);
    await Deno.remove(root, { recursive: true });
  });

  /** What the model can write: a link, and its own copy of each file. */
  const modelPlantsLinkAndFiles = async (): Promise<void> => {
    const link = join(workspace, "tools");
    await Deno.mkdir(join(workspace, "a", "b"), { recursive: true });
    await Deno.remove(link).catch(() => undefined);
    await Deno.symlink(join(workspace, "a", "b"), link);
    await writeProgram(
      join(workspace, "outside", "runsc"),
      join(root, "planted.log"),
    );
    await Deno.writeTextFile(
      join(workspace, "outside", "policy.json"),
      '{"forged":true}',
    );
    await Deno.mkdir(join(workspace, "outside", "rootfs"));
  };

  /**
   * A spelling which reads as leaving the workspace and which the kernel takes
   * into it once `<workspace>/tools` is a link to a directory two levels down.
   */
  const throughTheWorkspace = (leaf: string): string =>
    `${workspace}/tools/../../outside/${leaf}`;

  const resolveWith = (option: TrustedOption, path: string) =>
    resolveRunscSandboxConfig({ ...base, [option]: path });

  describe("resolveRunscSandboxConfig()", () => {
    describe("given a binary that is not an absolute path", () => {
      for (
        const [given, plantedAt] of [
          ["./runsc", "runsc"],
          ["bin/runsc", "bin/runsc"],
          ["../ws/runsc", "runsc"],
        ] as const
      ) {
        it(`throws for \`${given}\` when it names a file in the workspace the process runs from`, async () => {
          await writeProgram(
            join(workspace, plantedAt),
            join(root, "planted.log"),
          );
          Deno.chdir(workspace);
          expect(() => resolveWith("runscBinary", given)).toThrow(
            "lies inside the writable mount",
          );
        });
      }

      it("returns the absolute path of a relative binary outside the mounts", () => {
        Deno.chdir(root);
        const config = resolveWith("runscBinary", "outside/../outside/runsc");
        expect(config.runscBinary).toBe(join(outside, "runsc"));
      });

      it("throws for a leading `~`, asking for an absolute path", async () => {
        const home = Deno.env.get("HOME");
        try {
          // Were the `~` expanded, it would name the planted file.
          Deno.env.set("HOME", workspace);
          await writeProgram(
            join(workspace, "runsc"),
            join(root, "planted.log"),
          );
          expect(() => resolveWith("runscBinary", "~/runsc")).toThrow(
            /`~`.*absolute path/,
          );
        } finally {
          if (home === undefined) Deno.env.delete("HOME");
          else Deno.env.set("HOME", home);
        }
      });

      it("throws for the default name when `PATH` finds it in the workspace", async () => {
        const bin = join(workspace, "node_modules", ".bin");
        await writeProgram(join(bin, "runsc"), join(root, "planted.log"));
        Deno.env.set("PATH", `${bin}:${outside}`);
        expect(() =>
          resolveRunscSandboxConfig({ ...base, runscBinary: undefined })
        ).toThrow("lies inside the writable mount");
      });

      it("throws for a bare name found through a relative `PATH` entry in the workspace", async () => {
        await writeProgram(
          join(workspace, "node_modules", ".bin", "runsc"),
          join(root, "planted.log"),
        );
        Deno.env.set("PATH", `node_modules/.bin:${outside}`);
        Deno.chdir(workspace);
        expect(() => resolveWith("runscBinary", "runsc")).toThrow(
          "lies inside the writable mount",
        );
      });

      it("throws for a bare name found through an empty `PATH` entry in the workspace", async () => {
        await writeProgram(join(workspace, "runsc"), join(root, "planted.log"));
        Deno.env.set("PATH", `:${outside}`);
        Deno.chdir(workspace);
        expect(() => resolveWith("runscBinary", "runsc")).toThrow(
          "lies inside the writable mount",
        );
      });

      it("throws for a bare name no `PATH` entry holds, naming what it searched for", () => {
        const empty = join(root, "empty");
        Deno.mkdirSync(empty);
        Deno.env.set("PATH", empty);
        expect(() => resolveWith("runscBinary", "runsc-nowhere")).toThrow(
          /runsc-nowhere was not found.*`PATH`/,
        );
      });

      it("returns the file the first `PATH` entry holding an executable of that name gives", async () => {
        // The first entry holds the name as a file nobody can execute, which
        // a search passes over. The third holds an executable as well, and
        // comes too late to be the one.
        const notExecutable = join(root, "first");
        const later = join(root, "third");
        await Deno.mkdir(notExecutable);
        await Deno.writeTextFile(join(notExecutable, "runsc"), "");
        await Deno.chmod(join(notExecutable, "runsc"), 0o644);
        await writeProgram(join(later, "runsc"), join(root, "later.log"));
        Deno.env.set("PATH", `${notExecutable}:${outside}:${later}`);
        const config = resolveWith("runscBinary", "runsc");
        expect(config.runscBinary).toBe(join(outside, "runsc"));
      });

      it("returns the real path of a bare name found through a link", async () => {
        const bin = join(root, "bin");
        await Deno.mkdir(bin);
        await Deno.symlink(join(outside, "runsc"), join(bin, "runsc"));
        Deno.env.set("PATH", bin);
        const config = resolveWith("runscBinary", "runsc");
        expect(config.runscBinary).toBe(join(outside, "runsc"));
      });
    });

    for (const { option, label, leaf } of TRUSTED) {
      describe(`given the ${label}`, () => {
        it("throws for a path in the workspace, naming the setting", () => {
          expect(() => resolveWith(option, join(workspace, leaf))).toThrow(
            new RegExp(`^${label} .*lies inside the writable mount`),
          );
        });

        it("throws for a path whose `..` follows a link into the workspace", async () => {
          // A resolver that folded `..` out of the spelling before reading
          // the link would find the operator's file, which exists too.
          await modelPlantsLinkAndFiles();
          expect(() => resolveWith(option, throughTheWorkspace(leaf))).toThrow(
            "lies inside the writable mount",
          );
        });

        it("returns a path naming no workspace component when its `..` follows a workspace directory", async () => {
          await Deno.mkdir(join(workspace, "tools"));
          const config = resolveWith(option, throughTheWorkspace(leaf));
          expect(config[option]).toBe(join(outside, leaf));
        });

        it("throws for a path whose `..` follows a component that does not exist", () => {
          expect(() => resolveWith(option, throughTheWorkspace(leaf))).toThrow(
            /does not exist.*`\.\.`/,
          );
        });

        it("throws for a link outside the mounts whose target in the workspace does not exist", async () => {
          const link = join(outside, "dangling");
          await Deno.symlink(join(workspace, "not-yet"), link);
          expect(() => resolveWith(option, link)).toThrow(
            "whose target does not exist",
          );
        });

        it("throws for a path through a link whose target does not exist", async () => {
          await Deno.symlink(
            join(workspace, "not-yet"),
            join(outside, "dangling"),
          );
          expect(() => resolveWith(option, join(outside, "dangling", leaf)))
            .toThrow("whose target does not exist");
        });

        it("throws for a link outside the mounts to a file in the workspace", async () => {
          await Deno.writeTextFile(join(workspace, "target"), "");
          const link = join(outside, "link");
          await Deno.symlink(join(workspace, "target"), link);
          expect(() => resolveWith(option, link)).toThrow(
            "lies inside the writable mount",
          );
        });

        it("throws for a path through a loop of links", async () => {
          await Deno.symlink(join(outside, "loop-b"), join(outside, "loop-a"));
          await Deno.symlink(join(outside, "loop-a"), join(outside, "loop-b"));
          expect(() => resolveWith(option, join(outside, "loop-a", leaf)))
            .toThrow("symbolic links");
        });

        it("throws for a path through a file", () => {
          // Asking after an entry under a file fails, and not as "no such
          // entry": where the path leads could not be looked at.
          expect(() =>
            resolveWith(option, join(outside, "policy.json", "under", leaf))
          ).toThrow("could not be examined");
        });

        it({
          name:
            "throws for a path through a directory this process may not search",
          ignore: searchesDespiteMode(),
          fn: async () => {
            const locked = join(outside, "locked");
            await Deno.mkdir(join(locked, "in"), { recursive: true });
            await Deno.chmod(locked, 0o000);
            try {
              expect(() => resolveWith(option, join(locked, "in", leaf)))
                .toThrow("could not be examined");
            } finally {
              await Deno.chmod(locked, 0o700);
            }
          },
        });

        it("returns the real path of a path through a link outside the mounts", async () => {
          await Deno.symlink(outside, join(root, "alias"));
          const config = resolveWith(option, join(root, "alias", leaf));
          expect(config[option]).toBe(join(outside, leaf));
        });

        it("returns a path that does not exist yet under the real path of what does", async () => {
          await Deno.symlink(outside, join(root, "alias"));
          const config = resolveWith(
            option,
            join(root, "alias", "later", leaf),
          );
          expect(config[option]).toBe(join(outside, "later", leaf));
        });

        it("throws for a path in a workspace whose own path has `..` after a link, wherever that is read to lead", async () => {
          // The mount is `<root>/deep/ws2` to the kernel, which follows the
          // link first, and `<root>/ws2` to whatever folds the `..` out of
          // the spelling first.
          await Deno.mkdir(join(root, "deep", "dir"), { recursive: true });
          await Deno.symlink(join(root, "deep", "dir"), join(root, "alias"));
          for (const mount of [join(root, "deep", "ws2"), join(root, "ws2")]) {
            await Deno.mkdir(mount);
            expect(() =>
              resolveRunscSandboxConfig({
                ...base,
                workspaceHostPath: `${root}/alias/../ws2`,
                [option]: join(mount, leaf),
              })
            ).toThrow("lies inside the writable mount");
          }
        });

        it("compares without regard to case on macOS alone", () => {
          const mount = join(root, "Work", "Sub");
          const other = join(root, "Work", "SUB", leaf);
          expect(() =>
            resolveRunscSandboxConfig({
              ...base,
              workspaceHostPath: mount,
              platform: "darwin",
              [option]: other,
            })
          ).toThrow("lies inside the writable mount");
          const config = resolveRunscSandboxConfig({
            ...base,
            workspaceHostPath: mount,
            platform: "linux",
            [option]: other,
          });
          expect(config[option]).toBe(other);
        });
      });
    }
  });

  describe("resolveRunscSandboxConfig() given a path that is kept as given", () => {
    for (const option of ["cfcPolicyPath", "rootfs"] as const) {
      for (const given of ["policy.json", "./rootfs", "~/policy.json"]) {
        it(`throws for \`${given}\` as the \`${option}\`, which is not absolute`, () => {
          Deno.chdir(outside);
          expect(() => resolveWith(option, given)).toThrow(
            "must be an absolute host path",
          );
        });
      }
    }

    it("throws for a scratch directory in a workspace whose own path has `..` after a link, wherever that is read to lead", async () => {
      await Deno.mkdir(join(root, "deep", "dir"), { recursive: true });
      await Deno.symlink(join(root, "deep", "dir"), join(root, "alias"));
      for (const mount of [join(root, "deep", "ws2"), join(root, "ws2")]) {
        await Deno.mkdir(mount);
        expect(() =>
          resolveRunscSandboxConfig({
            ...base,
            workspaceHostPath: `${root}/alias/../ws2`,
            scratchDir: join(mount, "scratch"),
          })
        ).toThrow("lies inside the mount");
      }
    });

    it("throws for a scratch directory whose own path leads into the workspace, wherever it is read to lead", async () => {
      // `<workspace>/scratch` to the kernel and `<root>/scratch` to a
      // resolver that folds first, and then the other way about.
      await Deno.mkdir(join(workspace, "a", "b"), { recursive: true });
      await Deno.symlink(
        join(workspace, "a", "b"),
        join(workspace, "tools"),
      );
      await Deno.mkdir(join(root, "deep", "dir"), { recursive: true });
      await Deno.symlink(join(root, "deep", "dir"), join(root, "alias"));
      for (
        const scratchDir of [
          `${workspace}/tools/../../scratch`,
          `${root}/alias/../ws/scratch`,
        ]
      ) {
        expect(() => resolveRunscSandboxConfig({ ...base, scratchDir }))
          .toThrow("lies inside the mount");
      }
    });
  });

  describe("RunscSandboxRuntime", () => {
    /** A configuration made while `<workspace>/tools` is a plain directory. */
    const configuredThroughTheWorkspace = async () => {
      await Deno.mkdir(join(workspace, "tools"));
      return resolveRunscSandboxConfig({
        ...base,
        runscBinary: throughTheWorkspace("runsc"),
        cfcPolicyPath: throughTheWorkspace("policy.json"),
        rootfs: throughTheWorkspace("rootfs"),
      });
    };

    /** The value following each `flag` in `args`. */
    const valuesOf = (args: readonly string[], flag: string): string[] =>
      args.flatMap((arg, i) => arg === flag ? [args[i + 1]!] : []);

    it("hands every runsc command the paths the configuration was checked as", async () => {
      const config = await configuredThroughTheWorkspace();
      await modelPlantsLinkAndFiles();
      const runner = new RecordingRunner();
      const runtime = new RunscSandboxRuntime(config, runner);
      try {
        await runtime.run({ argv: ["true"] });
        await runtime.run({ argv: ["true"], session: "s" });
      } finally {
        await runtime.close();
      }

      const binary = join(outside, "runsc");
      const wrapped = runner.runs.filter((r) => r.command === "/bin/sh");
      const control = runner.runs.filter((r) => r.command !== "/bin/sh");
      // A fresh call and a session call, each under the shell wrapper.
      expect(wrapped.map((r) => r.args[5])).toEqual([binary, binary]);
      expect(runner.spawns.map((s) => s.command)).toEqual([binary]);
      expect(control.length).toBeGreaterThan(0);
      expect(control.map((r) => r.command)).toEqual(control.map(() => binary));

      const everyCommandLine = [
        ...runner.runs.map((r) => r.args),
        ...runner.spawns.map((s) => s.args),
      ];
      expect(everyCommandLine.map((args) => valuesOf(args, "--cfc-policy")))
        .toEqual(everyCommandLine.map(() => [join(outside, "policy.json")]));

      // One bundle for the fresh call and one for the session's container.
      expect(runner.specs.map((spec) => spec.root.path)).toEqual([
        join(outside, "rootfs"),
        join(outside, "rootfs"),
      ]);
      expect(runtime.describe().cfc?.image).toBe(join(outside, "rootfs"));
    });

    it("executes the operator's binary after the workspace turns the spelling into a link", async () => {
      const config = await configuredThroughTheWorkspace();
      await modelPlantsLinkAndFiles();
      const runtime = new RunscSandboxRuntime(config);
      try {
        await runtime.run({ argv: ["true"] });
      } finally {
        await runtime.close();
      }

      const ran = (await Deno.readTextFile(join(root, "operator.log")))
        .trim().split("\n");
      expect(ran.length).toBeGreaterThan(0);
      expect(ran).toEqual(ran.map(() => join(outside, "runsc")));
      await expect(Deno.lstat(join(root, "planted.log"))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    });
  });
});
