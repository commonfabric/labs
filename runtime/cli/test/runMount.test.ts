import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";

import {
  childStatusPathForStatePath,
  type FuseMountChild,
  type FuseMountDeps,
  runMount,
} from "../commands/fuse.ts";
import { prepareMountStatePath, readAllMountStates } from "../lib/fuse.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const CHILD_PID = 4711;

/** The value following `flag` in `args`, or undefined when `flag` is absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** A readiness channel whose writers all exit once `lines` are through. */
function readiness(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function report(state: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ state, pid: CHILD_PID, ...extra })}\n`;
}

/**
 * A spawned process the test settles by hand. `statusRead` resolves when the
 * mount command first waits on the process's exit.
 */
function standInChild(stdout: ReadableStream<Uint8Array> = readiness([])) {
  const exit = Promise.withResolvers<Deno.CommandStatus>();
  const statusRead = Promise.withResolvers<void>();
  let unrefs = 0;
  const child: FuseMountChild = {
    pid: CHILD_PID,
    get status() {
      statusRead.resolve();
      return exit.promise;
    },
    stdout,
    unref: () => {
      unrefs++;
    },
  };
  return {
    child,
    statusRead: statusRead.promise,
    exit: (code: number) =>
      exit.resolve({ code, success: code === 0, signal: null }),
    unrefs: () => unrefs,
  };
}

describe("runMount()", () => {
  let tmp: string;
  let stateDir: string;
  let mountpoint: string;
  let importMetaUrl: string;
  let spawned: Array<{ command: string; options: Deno.CommandOptions }>;
  let killed: Array<[number, Deno.Signal]>;
  let exits: number[];
  let logs: string[];
  let errors: string[];

  beforeEach(async () => {
    tmp = await Deno.makeTempDir({ prefix: "run-mount-" });
    stateDir = join(tmp, "state");
    mountpoint = join(tmp, "mnt-run-mount");
    importMetaUrl = toFileUrl(
      join(tmp, "repo", "runtime", "cli", "commands", "fuse.ts"),
    ).href;
    spawned = [];
    killed = [];
    exits = [];
    logs = [];
    errors = [];
  });

  afterEach(async () => {
    await Deno.remove(tmp, { recursive: true });
  });

  function deps(
    child: FuseMountChild,
    overrides: FuseMountDeps = {},
  ): FuseMountDeps {
    return {
      spawn: (command, options) => {
        spawned.push({ command, options });
        return child;
      },
      kill: (pid, signal) => {
        killed.push([pid, signal]);
      },
      isAlive: () => true,
      exit: (code) => {
        exits.push(code);
      },
      output: {
        log: (message: string) => logs.push(message),
        error: (message: string) => errors.push(message),
      },
      stateDir,
      execPath: "/usr/local/bin/deno",
      importMetaUrl,
      ...overrides,
    };
  }

  it("runs the FUSE module in the foreground and records its mount state while it runs", async () => {
    const identity = join(tmp, "identity.pem");
    await Deno.writeTextFile(identity, "key");
    const fake = standInChild();
    const mounted = runMount(
      {
        apiUrl: "http://localhost:9999",
        identity,
        space: ["home", "work"],
        debug: true,
      },
      mountpoint,
      deps(fake.child),
    );
    await fake.statusRead;

    const logFile = "/tmp/cf-fuse-mnt-run-mount.log";
    expect(spawned).toHaveLength(1);
    const [{ command, options }] = spawned;
    expect(command).toBe("deno");
    const args = options.args ?? [];
    expect(args.slice(0, 2)).toEqual(["run", "--unstable-ffi"]);
    expect(args).toContain(join(tmp, "repo", "runtime", "fuse", "mod.ts"));
    expect(args).toContain(mountpoint);
    expect(flagValue(args, "--api-url")).toBe("http://localhost:9999");
    expect(flagValue(args, "--identity")).toBe(identity);
    expect(flagValue(args, "--exec-cli")).toBe(
      join(tmp, "repo", ".cf", "fuse", "cf-exec"),
    );
    expect(args.filter((arg) => arg === "--space")).toHaveLength(2);
    expect(args).toContain("--debug");
    expect(args.slice(-2)).toEqual(["--log-file", logFile]);
    expect(options.stdin).toBe("inherit");
    expect(options.stdout).toBe("inherit");
    expect(errors).toEqual([`FUSE log: ${logFile}`]);
    expect((await Deno.stat(mountpoint)).isDirectory).toBe(true);

    const states = await readAllMountStates(stateDir);
    expect(states.map(({ entry }) => entry)).toEqual([
      expect.objectContaining({
        pid: CHILD_PID,
        mountpoint,
        apiUrl: "http://localhost:9999",
        identity,
        logFile,
      }),
    ]);
    expect(exits).toEqual([]);

    fake.exit(3);
    await mounted;
    expect(exits).toEqual([3]);
    expect(await readAllMountStates(stateDir)).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("runs the compiled binary's daemon subcommand in the foreground", async () => {
    await Deno.mkdir(mountpoint);
    const fake = standInChild();
    const mounted = runMount(
      {},
      mountpoint,
      deps(fake.child, { execPath: "/opt/bin/cf" }),
    );
    await fake.statusRead;
    fake.exit(0);
    await mounted;

    const [{ command, options }] = spawned;
    expect(command).toBe("/opt/bin/cf");
    const args = options.args ?? [];
    expect(args.slice(0, 2)).toEqual(["fuse-daemon", mountpoint]);
    expect(args).not.toContain("--api-url");
    const shim = flagValue(args, "--exec-cli") ?? "";
    expect(shim.startsWith(`${stateDir}/cf-exec-`)).toBe(true);
    expect(shim.slice(`${stateDir}/cf-exec-`.length)).toMatch(
      /^[0-9a-f]{16}$/,
    );
    expect(exits).toEqual([0]);
  });

  for (const killThrows of [false, true]) {
    it(
      `stops the foreground child when its mount state cannot be written${
        killThrows ? ", even if it has already exited" : ""
      }`,
      async () => {
        // A directory where the state file belongs makes the write fail.
        await Deno.mkdir(await prepareMountStatePath(stateDir, mountpoint));
        const fake = standInChild();
        await expect(
          runMount(
            {},
            mountpoint,
            deps(fake.child, {
              kill: (pid, signal) => {
                killed.push([pid, signal]);
                if (killThrows) throw new Error("already exited");
              },
            }),
          ),
        ).rejects.toThrow(Deno.errors.IsADirectory);
        expect(killed).toEqual([[CHILD_PID, "SIGTERM"]]);
        expect(exits).toEqual([]);
      },
    );
  }

  it("rejects an identity path that does not exist or is not a file, before spawning", async () => {
    const fake = standInChild();
    const missing = join(tmp, "missing.pem");
    await expect(
      runMount({ identity: missing }, mountpoint, deps(fake.child)),
    ).rejects.toThrow(`Identity file not found: ${missing}`);
    await expect(
      runMount({ identity: tmp }, mountpoint, deps(fake.child)),
    ).rejects.toThrow(`Identity file not found: ${tmp}`);
    expect(spawned).toEqual([]);
    await expect(Deno.stat(mountpoint)).rejects.toThrow(Deno.errors.NotFound);
  });

  it("starts a background supervisor and returns once the mount reports it is up", async () => {
    const statePath = await prepareMountStatePath(stateDir, mountpoint);
    const childStatusPath = childStatusPathForStatePath(statePath);
    await Deno.writeTextFile(childStatusPath, "stale");
    let staleStatusAtSpawn = true;
    const fake = standInChild(readiness([report("mounted")]));

    await runMount(
      { background: true, noattrcache: true },
      mountpoint,
      deps(fake.child, {
        spawn: (command, options) => {
          spawned.push({ command, options });
          try {
            Deno.statSync(childStatusPath);
          } catch {
            staleStatusAtSpawn = false;
          }
          return fake.child;
        },
      }),
    );

    expect(staleStatusAtSpawn).toBe(false);
    const [{ command, options }] = spawned;
    expect(command).toBe("/usr/local/bin/deno");
    const args = options.args ?? [];
    expect(args.slice(0, 5)).toEqual([
      "run",
      "--allow-run",
      `--allow-write=${statePath}`,
      join(tmp, "repo", "runtime", "cli", "lib", "fuse-supervisor.ts"),
      mountpoint,
    ]);
    expect(flagValue(args, "--state-path")).toBe(statePath);
    expect(flagValue(args, "--supervisor-status")).toBe(childStatusPath);
    expect(flagValue(args, "--log-file")).toBe(
      "/tmp/cf-fuse-mnt-run-mount.log",
    );
    expect(args).toContain("--noattrcache");
    expect(options.stdout).toBe("piped");
    expect(options.stdin).toBe("null");
    expect(fake.unrefs()).toBe(1);
    expect(killed).toEqual([]);
    expect(logs).toEqual([
      `FUSE mounted in background (PID ${CHILD_PID})`,
      `  mountpoint: ${mountpoint}`,
      "  log:        /tmp/cf-fuse-mnt-run-mount.log",
      `Use 'cf fuse status' to check, 'cf fuse unmount ${mountpoint}' to stop.`,
    ]);
  });

  it("starts the compiled binary's supervisor subcommand in the background", async () => {
    const fake = standInChild(readiness([report("mounted")]));
    await runMount(
      { background: true },
      mountpoint,
      deps(fake.child, { execPath: "/opt/bin/cf" }),
    );
    const [{ command, options }] = spawned;
    expect(command).toBe("/opt/bin/cf");
    expect((options.args ?? []).slice(0, 2)).toEqual([
      "fuse-supervisor",
      mountpoint,
    ]);
  });

  for (const killThrows of [false, true]) {
    it(
      `stops the background supervisor when the mount fails to start${
        killThrows ? ", even if it has already exited" : ""
      }`,
      async () => {
        const fake = standInChild(
          readiness([report("failed", { error: "no FUSE-T" })]),
        );
        await expect(
          runMount(
            { background: true },
            mountpoint,
            deps(fake.child, {
              kill: (pid, signal) => {
                killed.push([pid, signal]);
                if (killThrows) throw new Error("already exited");
              },
            }),
          ),
        ).rejects.toThrow(
          "Background FUSE mount failed during startup: no FUSE-T",
        );
        expect(killed).toEqual([[CHILD_PID, "SIGTERM"]]);
        expect(fake.unrefs()).toBe(0);
        expect(logs).toEqual([]);
      },
    );
  }

  it("refuses to start in the background when the old child status cannot be removed", async () => {
    const statePath = await prepareMountStatePath(stateDir, mountpoint);
    const childStatusPath = childStatusPathForStatePath(statePath);
    await Deno.mkdir(childStatusPath);
    await Deno.writeTextFile(join(childStatusPath, "entry"), "");
    const fake = standInChild();
    await expect(
      runMount({ background: true }, mountpoint, deps(fake.child)),
    ).rejects.toThrow("Directory not empty");
    expect((await Deno.stat(childStatusPath)).isDirectory).toBe(true);
    expect(spawned).toEqual([]);
  });
});
