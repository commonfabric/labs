/**
 * The environment a suite needs before it can run, named rather than
 * implied.
 *
 * A lane works out the union of what its batches need, opens each one
 * once, and runs the batches inside it. Naming them is what lets several
 * ways of providing the same thing coexist: `toolshed` runs a server from
 * source, which is cheap enough for a pull request and serves the API a
 * suite reaches over HTTP, while `toolshed-baked` and
 * `toolshed-baked-opposite` restore or build a binary, because the browser
 * shell is a bundle compiled into one. A suite says which it needs and
 * neither the workflow nor the other suites know the difference.
 *
 * Every capability is idempotent: opening one that is already open is the
 * same as not opening it. The lane runner relies on that when a batch it
 * did not plan for turns out to need something already standing.
 */

import * as path from "@std/path";
import { describeFailure } from "@commonfabric/js-values/describe-failure";

import {
  darwinLibfusePaths,
  LINUX_LIBFUSE_PATHS,
} from "@commonfabric/fuse/library-paths";

import {
  awaitReadyMarker,
  BACKGROUND_LOG_ENV,
} from "../runtime/toolshed/background.ts";
import { type BinaryName, BUILD_HOST_VARIABLES } from "./build-binaries.ts";
import {
  SERVER_EXECUTION_POSTURE_VARIABLES,
  serverExecutionCiLane,
  type ServerExecutionCiRole,
  verifyServerExecutionPosture,
} from "./server-execution-ci.ts";

/** Every piece of setup a suite may ask for. */
export type CapabilityId =
  | "deno"
  | "fuse"
  | "jq"
  | "browser"
  | "git-history"
  | "github-api"
  | "toolshed"
  | "toolshed-baked"
  | "toolshed-baked-opposite"
  | "cf"
  | "local-dev-servers"
  | "compile-cache";

/**
 * Running a command, as a capability does it: the output on success, and
 * a throw carrying that output on failure. Setup that half-worked is
 * worse than setup that did not, because the batch after it fails
 * somewhere unrelated.
 */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<string>;

/** Where an `Exec` runs its command, and with what environment. */
export interface ExecOptions {
  /** The directory the command runs in. */
  cwd?: string;

  /** Variables added to the environment the command inherits. */
  env?: Record<string, string>;

  /** Whether the command inherits no environment, leaving it only `env`. */
  clearEnv?: boolean;

  /**
   * Whether the command writes to the lane's own output rather than having
   * it captured. Its output is then in the job's log as it is written, so a
   * command that stalls is seen stalling, and nothing it leaves running can
   * hold the call open by holding a pipe. The call returns an empty string,
   * and an error from it does not quote the output, which is in the log.
   */
  inheritOutput?: boolean;
}

/**
 * Starting a command that keeps running, as a capability does it: its
 * standard output is piped back, and its standard input and error are
 * connected to the null device.
 */
export type Spawn = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => SpawnedProcess;

/** A process a capability started. */
export interface SpawnedProcess {
  /** What the process writes to its standard output. */
  readonly stdout: ReadableStream<Uint8Array>;

  /** Settles once the process has exited. */
  readonly status: Promise<Deno.CommandStatus>;

  /** Sends the process a signal. Throws once the process has exited. */
  kill(signal: Deno.Signal): void;
}

/** What a capability was given to work with. */
export interface CapabilityContext {
  /** The repository root, absolute. */
  root: string;

  /**
   * Report what would happen and change nothing. A dry-run capability
   * still returns the environment it would export, so a plan printed
   * without a machine to run it on says what the batches would see.
   */
  dryRun: boolean;

  /**
   * Where a capability may write files it owns, such as a restored
   * compile cache or a server log.
   */
  workDir: string;

  /**
   * The tree a binary the lane keeps is built in and kept under, absolute,
   * in place of the root. A binary found under `BINARY_CACHE_DIR` there is
   * used as it is, and a build rewrites files of the tree it runs in while
   * it runs, so a run that cannot vouch for what the root's cache holds, or
   * whose root somebody is working in, names a copy of the tree here.
   */
  buildFrom?: string;

  /**
   * How a capability runs a command. A caller that supplies one is
   * saying what the machine would have answered, which is the only way
   * setup that installs packages and starts servers can be exercised
   * without a machine that has neither.
   */
  exec?: Exec;

  /**
   * How a capability starts a process it keeps running, the way `exec`
   * runs one to completion. A test supplies one to stand in for the real
   * process.
   */
  spawn?: Spawn;

  /**
   * The GitHub token the lane took out of its own environment, for the
   * suites that declared they need one. Absent where the lane was handed
   * none.
   */
  githubToken?: string;

  /**
   * How a capability asks a server it started what it is serving. A
   * caller that supplies one is saying what the server would have
   * answered, the way `exec` says what the machine would have answered.
   */
  fetch?: typeof fetch;

  /**
   * Where opening says what it is doing, a line at a time: each
   * capability as it begins to open and once it has opened, and each
   * command a capability runs, before it runs. Setup captures the output of
   * most of its commands, so a step that never finishes is named in the log
   * only by the line said before it. Absent, opening says nothing.
   */
  report?: (line: string) => void;
}

/** A capability that has been opened. */
export interface OpenCapability {
  /** Environment the suites that asked for it run with. */
  env: Record<string, string>;

  /**
   * Files it writes that say what it did, for a lane that failed to
   * report. A capability outside the test process is the half of a
   * failure the test process cannot describe, and outside a job its work
   * directory goes when the lane ends, so there a log nobody names here
   * is gone.
   */
  logs?: readonly string[];

  /**
   * Shuts it down. Called once, in the reverse of the opening order.
   * Settles once what it opened has stopped, and rejects where it failed
   * to stop.
   */
  close(): Promise<void>;
}

/** One named piece of setup. */
export interface Capability {
  id: CapabilityId;

  /** What it provides, in words the job summary prints. */
  description: string;

  /**
   * Capabilities this one is built on. They are opened first, and their
   * environment is visible to this one.
   */
  needs?: readonly CapabilityId[];

  /**
   * Whether opening it prepares a continuous-integration runner, installing
   * packages, relaxing a kernel setting, or deepening a shallow checkout,
   * rather than starting or naming something the suites reach. A run on a
   * workstation opens none of these, and its tests find the machine and the
   * checkout as their owner set them up.
   */
  preparesRunner?: true;

  /**
   * For one that prepares a runner, what a machine running `os` lacks that
   * opening it would have provided, or nothing where the machine has it. It
   * asks and changes nothing, so a run on a workstation can leave out the
   * suites needing what is not there rather than fail them.
   */
  missing?(
    context: Pick<CapabilityContext, "root" | "exec" | "report">,
    os?: typeof Deno.build.os,
  ): Promise<string | undefined>;

  /** The binary it builds where `BINARY_CACHE_DIR` holds none. */
  builds?: CachedBinaryName;

  /**
   * Whether what it opens shares the checkout with its owner's own work, as
   * the local development stack does: its servers keep their logs and their
   * store in the checkout, where the owner's own servers keep theirs. A run
   * on a workstation runs no suite needing one.
   */
  sharesCheckout?: true;

  open(context: CapabilityContext): Promise<OpenCapability>;
}

/**
 * What a lane keeps between runs, relative to the repository root. The
 * lane's workflow restores and saves each part of it with a cache step of
 * its own, so everything a lane wants restored has to sit at a path one
 * of those steps names, and it has to outlive the lane: a directory the
 * lane made for itself would be empty on every run, and everything in it
 * would be built again.
 */
export const CACHE_DIR = ".ci-cache";

/**
 * Where a built binary is kept, inside that directory. The workflow
 * caches each binary in it with a step of its own, under an exact key
 * naming what that binary is built from and no restore prefix, because a
 * lane uses a binary it finds without asking what it was built from.
 */
export const BINARY_CACHE_DIR = `${CACHE_DIR}/binaries`;

/**
 * Where the pattern compile byte cache is kept, inside that directory.
 * The workflow caches the file's directory with one step, under a key
 * naming the compiler fingerprint, the lane and the pattern sources, and
 * restores from the prefix naming the fingerprint alone, because a
 * compiled pattern is reused only where its source is unchanged.
 */
export const COMPILE_CACHE_FILE = `${CACHE_DIR}/compile/lane.json`;

/**
 * The server-execution variables a Toolshed at `role` is built and run with
 * (`ServerExecutionCiLane.environment`): the value the role names, or nothing
 * where it names none, and on the ON arm the flags it runs with besides.
 * `defaultEnabled` stands in for the first-party default where given.
 */
function serverExecutionEnvironment(
  role: ServerExecutionCiRole,
  defaultEnabled?: boolean,
): Record<string, string> {
  return { ...serverExecutionCiLane(role, defaultEnabled).environment };
}

/** The name of a binary a lane keeps in `BINARY_CACHE_DIR`. */
export type CachedBinaryName = `toolshed-baked-${ServerExecutionCiRole}`;

/** How a lane builds one binary it keeps in `BINARY_CACHE_DIR`. */
export interface CachedBinary {
  /** The binary `deno task build-binaries` is asked for. */
  build: BinaryName;

  /**
   * The environment variables the build is given besides the host ones.
   * Every other variable is unset, whatever the lane's own environment
   * holds.
   */
  bakes: Record<string, string>;
}

/**
 * Every binary a lane keeps in `BINARY_CACHE_DIR`, and how each is built. A
 * binary is made from the variables its build sets as much as from its
 * sources, so the cache key covers this table as well. The Toolshed builds
 * follow whether server execution is on by default, which is the first-party
 * default unless `defaultEnabled` says otherwise.
 *
 * None of them sets `COMMIT_SHA`. A cached binary serves every commit whose
 * sources match those of the commit that built it, so a commit baked into it
 * would be wrong at all the others, and a key covering the commit would never
 * be reused.
 */
export function cachedBinaries(
  defaultEnabled?: boolean,
): Record<CachedBinaryName, CachedBinary> {
  const toolshed = (role: ServerExecutionCiRole): CachedBinary => ({
    build: "toolshed",
    bakes: {
      ...serverExecutionEnvironment(role, defaultEnabled),
      // A lane's binary is a test fixture, not a release: it takes the
      // compiler-input fingerprint as its compile-cache version rather than
      // the corpus compile a shipped build pays for.
      CF_COMPILE_CACHE_VERSION: "inputs",
    },
  });
  return {
    "toolshed-baked-default": toolshed("default"),
    "toolshed-baked-opposite": toolshed("opposite"),
  };
}

/** Nothing to undo. */
const NOTHING = () => Promise.resolve();

/** A capability that exports environment and owns no process. */
function exported(env: Record<string, string>): OpenCapability {
  return { env, close: NOTHING };
}

/**
 * Runs a command, and throws with its output when it fails. Setup that
 * half-worked is worse than setup that did not, because the batch after
 * it fails somewhere unrelated.
 */
export const run: Exec = async (command, args, options = {}) => {
  if (options.inheritOutput) {
    const { success, code } = await new Deno.Command(command, {
      ...commandOptions(args, options),
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    if (success) return "";
    throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  }
  const result = await new Deno.Command(command, {
    ...commandOptions(args, options),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.success) return stdout;
  const stderr = new TextDecoder().decode(result.stderr);
  throw new Error(
    `${command} ${args.join(" ")} exited ${result.code}\n${stdout}${stderr}`,
  );
};

const spawn: Spawn = (command, args, options = {}) =>
  new Deno.Command(command, {
    ...commandOptions(args, options),
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();

/** The arguments and `ExecOptions` of a command, as `Deno.Command` takes them. */
function commandOptions(
  args: readonly string[],
  options: ExecOptions,
): Deno.CommandOptions {
  return {
    args: [...args],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.clearEnv === undefined ? {} : { clearEnv: options.clearEnv }),
  };
}

/** How this context runs commands. */
function execOf(context: Pick<CapabilityContext, "exec" | "report">): Exec {
  const exec = context.exec ?? run;
  return (command, args, options) => {
    context.report?.(`ci-lane: running ${[command, ...args].join(" ")}`);
    return exec(command, args, options);
  };
}

/** How this context starts commands it keeps running. */
function spawnOf(context: CapabilityContext): Spawn {
  const start = context.spawn ?? spawn;
  return (command, args, options) => {
    context.report?.(`ci-lane: starting ${[command, ...args].join(" ")}`);
    return start(command, args, options);
  };
}

/** A probe answering whether `command` is on the path. */
function onPath(command: string): readonly string[] {
  return ["sh", "-c", `command -v ${command}`];
}

/** Whether a command runs and reports success. */
async function succeeds(
  exec: Exec,
  command: readonly string[],
): Promise<boolean> {
  const [name, ...args] = command;
  try {
    await exec(name!, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * The most seconds one `apt-get` command may take. It waits on mirrors nothing
 * here controls, and one that stalls would otherwise hold the lane until its
 * step's bound without a test having run. A command takes seconds when the
 * mirrors answer, so this stops only one that is not going to finish.
 */
const APT_BOUND_SECONDS = 300;

/** How long a stopped `apt-get` command gets before it is killed outright. */
const APT_KILL_AFTER_SECONDS = 30;

/**
 * Installs Debian packages, and does nothing where the probes say they
 * are already there.
 *
 * A probe is a command whose success means what one of the packages
 * provides is there. A package that puts a command on the path is
 * probed with `onPath`; a package whose point is a file is probed with
 * whatever answers about that file.
 *
 * Each command is bounded by a `timeout` running inside `sudo`, because the
 * lane has no permission to signal what `sudo` started. Its output goes to the
 * job's log, so a stall names the mirror it stalled on.
 *
 * @throws where a command fails or reaches `APT_BOUND_SECONDS`.
 */
async function apt(
  exec: Exec,
  packages: readonly string[],
  probes: readonly (readonly string[])[],
): Promise<void> {
  let missing = false;
  for (const probe of probes) {
    if (!await succeeds(exec, probe)) missing = true;
  }
  if (!missing) return;
  const aptGet = async (args: readonly string[]): Promise<void> => {
    try {
      await exec(
        "sudo",
        [
          "timeout",
          `--kill-after=${APT_KILL_AFTER_SECONDS}`,
          `${APT_BOUND_SECONDS}`,
          "apt-get",
          ...args,
        ],
        { inheritOutput: true },
      );
    } catch (error) {
      throw new Error(
        `could not install ${packages.join(", ")}: \`apt-get ${args[0]}\` ` +
          `failed or took more than ${APT_BOUND_SECONDS}s, and what it said ` +
          `is in the log above: ${describeFailure(error)}`,
        { cause: error },
      );
    }
  };
  await aptGet(["update"]);
  await aptGet(["install", "-y", "--no-install-recommends", ...packages]);
}

/**
 * The Deno toolchain and the workspace's dependencies. The lane's own job
 * has already done this through the setup actions, which is why opening
 * it is a check rather than an install: a lane that reached this code is
 * running under Deno, and a dependency install this could redo is one the
 * workflow already paid for.
 */
const deno: Capability = {
  id: "deno",
  description: "the Deno toolchain and the workspace's dependencies",
  open: () => Promise.resolve(exported({})),
};

const fuse: Capability = {
  id: "fuse",
  description: "the FUSE headers and tools the CLI's mount suite needs",
  preparesRunner: true,
  async missing(context, os = Deno.build.os) {
    const exec = execOf(context);
    // The paths are the shell's arguments, so none is read as shell syntax.
    const anyOf = (paths: readonly string[]) =>
      succeeds(exec, [
        "sh",
        "-c",
        'for at; do test -e "$at" && exit 0; done; exit 1',
        "sh",
        ...paths,
      ]);
    if (os === "darwin") {
      return await anyOf(darwinLibfusePaths())
        ? undefined
        : "neither FUSE-T nor macFUSE is installed";
    }
    if (!await anyOf(LINUX_LIBFUSE_PATHS)) {
      return "libfuse3 is not where the FUSE bindings look for it";
    }
    if (!await succeeds(exec, onPath("fusermount3"))) {
      return "fusermount3 is not on the path";
    }
    return await succeeds(exec, [
        "sh",
        "-c",
        "test -r /dev/fuse -a -w /dev/fuse",
      ])
      ? undefined
      : "/dev/fuse is not open to this user";
  },
  async open(context) {
    if (!context.dryRun) {
      const exec = execOf(context);
      // The mount opens `libfuse3.so` through the foreign-function
      // interface, and that unversioned name comes from the development
      // package. `pkg-config --exists fuse3` is the question that names
      // it: it fails where the development package is absent, and it
      // fails where `pkg-config` itself is, which is the other thing this
      // installs. `fusermount3` is what the unmount runs, and it is the
      // remaining package.
      await apt(
        exec,
        ["pkg-config", "gcc", "libfuse3-dev", "fuse3"],
        [
          onPath("gcc"),
          onPath("fusermount3"),
          ["pkg-config", "--exists", "fuse3"],
        ],
      );
      // The mount itself needs the device, and the runner image leaves it
      // owned by root.
      await exec("sudo", ["chmod", "666", "/dev/fuse"]);
    }
    return exported({});
  },
};

const jq: Capability = {
  id: "jq",
  description: "jq, which the shell integration suites filter JSON with",
  preparesRunner: true,
  async missing(context) {
    return await succeeds(execOf(context), onPath("jq"))
      ? undefined
      : "jq is not on the path";
  },
  async open(context) {
    if (!context.dryRun) {
      await apt(execOf(context), ["jq"], [onPath("jq")]);
    }
    return exported({});
  },
};

/** The kernel setting with which AppArmor restricts user namespaces. */
const USERNS_SYSCTL = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/**
 * Astral drives Chrome through a user namespace, which Ubuntu's AppArmor
 * profile denies to unprivileged processes. Relaxing it is the whole of
 * what a browser test needs from the machine.
 */
const browser: Capability = {
  id: "browser",
  description: "the AppArmor relaxation a sandboxed browser needs",
  preparesRunner: true,
  async missing(context) {
    return await succeeds(execOf(context), [
        "sh",
        "-c",
        `test ! -e ${USERNS_SYSCTL} || test "$(cat ${USERNS_SYSCTL})" = 0`,
      ])
      ? undefined
      : "AppArmor restricts the user namespace a sandboxed browser needs";
  },
  async open(context) {
    const sysctl = USERNS_SYSCTL;
    if (!context.dryRun) {
      const exec = execOf(context);
      // Asked of the machine rather than of the filesystem directly, so
      // that an image with the knob and an image without it are the same
      // question with two answers rather than two code paths only one
      // machine can reach.
      try {
        await exec("sh", ["-c", `test -e ${sysctl}`]);
      } catch {
        // Nothing restricts the namespace here, so nothing needs
        // relaxing.
        return exported({});
      }
      await exec("sh", [
        "-c",
        `printf '0\\n' | sudo tee ${sysctl} >/dev/null`,
      ]);
    }
    return exported({});
  },
};

/**
 * A checkout deep enough to diff against a merge base and to replay a
 * recorded vintage. The lane's own checkout is already full depth, so
 * this is a repair for a shallow one rather than the usual path.
 */
const gitHistory: Capability = {
  id: "git-history",
  description: "an unshallowed checkout",
  preparesRunner: true,
  async missing(context) {
    const shallow = (await execOf(context)("git", [
      "rev-parse",
      "--is-shallow-repository",
    ], { cwd: context.root })).trim();
    return shallow === "true" ? "the checkout is shallow" : undefined;
  },
  async open(context) {
    if (!context.dryRun) {
      const exec = execOf(context);
      const shallow = (await exec("git", [
        "rev-parse",
        "--is-shallow-repository",
      ], { cwd: context.root })).trim();
      if (shallow === "true") {
        await exec("git", ["fetch", "--unshallow"], { cwd: context.root });
      }
    }
    return exported({});
  },
};

/**
 * The names a GitHub token reaches a lane under, and the names a suite
 * that declared one is given it under. The `gh` command line reads
 * `GH_TOKEN`, and `check-action-pins` reads `GITHUB_TOKEN` and falls
 * back to `GH_TOKEN`, so both names are taken out of the lane and both
 * are exported to a suite that asked.
 */
const GITHUB_TOKEN_VARIABLES = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

/**
 * Takes the GitHub token out of this process and answers with it.
 *
 * A child process inherits what its parent holds, so a token left in the
 * lane's own environment reaches every test in the lane whether or not
 * its suite asked for one. Taking it out is what makes the declaration
 * mean something.
 *
 * It leaves this process rather than being filtered out of each child's
 * environment, because everything the lane spawns reads the environment
 * from here: the batches through `runInvocation`, the capability setup
 * commands, and the `git` calls that read the diff. One take covers
 * them, and covers whatever spawns next.
 *
 * Where the lane was handed a token under more than one name, the first
 * of the names above wins. Answers with nothing where it was handed
 * none, which is the state on a workstation and in a job whose workflow
 * passes none.
 */
export function takeGithubToken(): string | undefined {
  let token: string | undefined;
  for (const name of GITHUB_TOKEN_VARIABLES) {
    const value = Deno.env.get(name);
    Deno.env.delete(name);
    if (token === undefined && value !== undefined && value.length > 0) {
      token = value;
    }
  }
  return token;
}

/**
 * A token for the GitHub API, handed to the suites that ask the service a
 * question and to no others.
 *
 * A lane runs the repository's own gates beside pattern and integration
 * tests, and one gate asks GitHub what each action pin resolves to.
 * Sixty requests an hour is what the service allows a caller with no
 * token, shared across everything else reaching it from that address, so
 * the gate needs one.
 *
 * What it exports is the token the lane took out of its own environment
 * before it opened anything, handed back here.
 */
const githubApi: Capability = {
  id: "github-api",
  description: "a token for the GitHub API",
  open(context) {
    const token = context.githubToken;
    return Promise.resolve(exported(
      token === undefined ? {} : Object.fromEntries(
        GITHUB_TOKEN_VARIABLES.map((name) => [name, token]),
      ),
    ));
  },
};

/**
 * The environment a Toolshed at `role` runs under: the ambient environment
 * without the variables the posture check reads, carrying the server-execution
 * define the role names, and carrying none where the role names none.
 *
 * An unset define is a third state rather than a synonym for `false`. It
 * follows the first-party default, which is what the default role's posture
 * check asks for, so that role removes the name rather than setting it.
 */
function serverExecutionEnv(
  role: ServerExecutionCiRole,
): Record<string, string> {
  const env = Deno.env.toObject();
  for (const name of SERVER_EXECUTION_POSTURE_VARIABLES) delete env[name];
  return { ...env, ...serverExecutionEnvironment(role) };
}

/** How a Toolshed server is started, whichever binary provides it. */
interface ToolshedOptions {
  /** The command that starts it, and where it runs. */
  command: readonly string[];
  cwd: string;

  /**
   * The server-execution arm this server is meant to be serving. A suite
   * reaching a server on the other arm passes and reports that the arm
   * it named works.
   */
  role: ServerExecutionCiRole;

  /**
   * Whether the suites are told the server's own store, rather than one of
   * their own beside it. A suite that reads a server's store through the
   * command line needs the server's. One that starts servers of its own in
   * its test processes needs its own, or two servers would open one store.
   */
  sharesStore: boolean;
}

/**
 * How much of a capability's log a report carries. A server's log is mostly
 * one line per request, so a whole one would bury the report it sits in; the
 * end of it is where a run that went wrong says so.
 */
export const CAPABILITY_LOG_TAIL_LINES = 200;

/**
 * The end of the log at `at`, under a line saying how much was left out, or
 * one line saying why it could not be read.
 *
 * Never throws. Every caller is reporting something that has already gone
 * wrong, and a report that threw would replace the failure it was written for.
 */
export async function logTail(
  at: string,
  read: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<string> {
  let contents: string;
  try {
    contents = await read(at);
  } catch (error) {
    return `  (unreadable: ${error})`;
  }
  const lines = contents.split("\n");
  // A trailing newline ends the last line rather than starting another.
  if (lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-CAPABILITY_LOG_TAIL_LINES);
  const dropped = lines.length - tail.length;
  return [
    `  last ${tail.length} of ${lines.length} line(s)${
      dropped > 0 ? `; ${dropped} earlier dropped` : ""
    }`,
    ...tail,
  ].join("\n");
}

/** How a process ended, in words. */
function exitOf(status: Deno.CommandStatus): string {
  return status.signal === null
    ? `exited with code ${status.code}`
    : `was killed by ${status.signal}`;
}

/**
 * The interval, in milliseconds, between a lane server's metric exports:
 * a week, which no lane outlives.
 */
export const METRIC_EXPORT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Starts a Toolshed server and exports the addresses the suites reach it
 * at.
 *
 * The server is this process's own child, started as the server half of a
 * `--background` launch: it writes its logs to the file the environment
 * names, and writes one line to its standard output once it has bound its
 * port, so there is nothing here to poll and nothing to wait a fixed time
 * for. Being its parent is what lets the close wait for it: closing sends
 * the server SIGTERM and settles once it has exited, so the lane that
 * opened it leaves nothing listening on the port and nothing writing into
 * the work directory.
 */
async function startToolshed(
  context: CapabilityContext,
  options: ToolshedOptions,
): Promise<OpenCapability> {
  // Port zero would leave the suites with no address to reach, so the
  // port is chosen here and the server is told which one to bind.
  const port = context.dryRun ? 8000 : freePort();
  const url = `http://localhost:${port}`;
  // Every name carries the origin with no trailing slash. The shell
  // suites compose a path onto it as `${API_URL}/api/health/stats`, and
  // a slash on both sides is a path the server does not serve.
  const env = {
    API_URL: url,
    MEMORY_URL: url,
    TOOLSHED_URL: url,
    TOOLSHED_PORT: `${port}`,
  };
  // The server keeps its spaces in a store of its own in the lane's work
  // directory, and so do the suites, so none of them opens another's, a
  // developer's own included. A server, and a command that reads a store
  // directly, finds it by these names before any default.
  const store = path.join(context.workDir, `toolshed-${port}`);
  const storeAt = (directory: string) => ({
    MEMORY_DIR: path.toFileUrl(path.join(store, directory) + "/").href,
    DB_PATH: "",
  });
  const storeEnv = storeAt("memory");
  const told = {
    ...env,
    ...(options.sharesStore ? storeEnv : storeAt("suites-memory")),
  };
  if (context.dryRun) return exported(told);
  const [command, ...args] = options.command;
  const logFile = path.join(context.workDir, `toolshed-${port}.log`);
  const server = spawnOf(context)(command!, [...args, `--port=${port}`], {
    cwd: options.cwd,
    // The environment below is the whole of it, so that a name
    // `serverExecutionEnv()` removed is unset rather than inherited.
    clearEnv: true,
    env: {
      ...serverExecutionEnv(options.role),
      CACHE_DIR: path.join(store, "cache"),
      // The server reaches for a gateway and a model key at startup. A
      // test server has neither.
      CFTS_AI_GATEWAY_URL: "",
      CFTS_AI_LLM_ANTHROPIC_API_KEY: "fake",
      // Leak tests read the server's memory after a full collection.
      EXPOSE_GC: "true",
      // A compiled server runs Deno's own OpenTelemetry with metrics on,
      // since `build-binaries` compiles it under `OTEL_DENO`. Each metric
      // export waits for the main thread to observe the isolate's gauges,
      // and `Deno.exit()` waits on its main thread for the exporter to shut
      // down, so an export that falls due while the server's main thread is
      // busy with its own shutdown leaves the process never exiting and the
      // close below waiting on it. An interval longer than any lane means no
      // export falls due.
      OTEL_METRIC_EXPORT_INTERVAL: `${METRIC_EXPORT_INTERVAL_MS}`,
      ...storeEnv,
      ...env,
      [BACKGROUND_LOG_ENV]: logFile,
    },
  });
  // Sends the server SIGTERM unless it has already exited, and returns its
  // exit status once it has.
  const stop = async (): Promise<Deno.CommandStatus> => {
    try {
      server.kill("SIGTERM");
    } catch {
      // It has exited, and its status says how.
    }
    return await server.status;
  };
  try {
    if (!await awaitReadyMarker(server.stdout)) {
      throw new Error(
        `the toolshed server ${exitOf(await stop())} before it bound its port`,
      );
    }
    await verifyServerExecutionPosture(
      options.role,
      url,
      context.fetch ?? fetch,
    );
  } catch (error) {
    await stop();
    // The server's own log is the account of why it failed. Nothing is
    // holding the path at this point -- the capability never opened -- so
    // the log is carried in the throw or it goes with the work directory
    // unread.
    throw new Error(
      `${describeFailure(error)}\ntoolshed log:\n${await logTail(logFile)}`,
      { cause: error },
    );
  }
  return {
    env: told,
    logs: [logFile],
    close: async () => {
      const status = await stop();
      if (!status.success) {
        throw new Error(
          `the toolshed server ${exitOf(status)}; its log is \`${logFile}\``,
        );
      }
    },
  };
}

/**
 * A free TCP port, taken by listening on port zero and closing again. Two
 * servers in one lane must not collide, and a fixed port would collide
 * with whatever the runner image already has listening as well.
 */
function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/**
 * A Toolshed server run from source. A pull request that downloaded a
 * compiled binary would pay a build job on its critical path and a
 * download in every consumer; the dependency graph is already in the Deno
 * cache the workflow restored, so starting from source costs seconds.
 */
const toolshed: Capability = {
  id: "toolshed",
  description: "a Toolshed server, run from source on an allocated port",
  needs: ["deno"],
  open: (context) =>
    startToolshed(context, {
      command: [Deno.execPath(), "run", "--unstable-otel", "-A", "index.ts"],
      cwd: path.join(context.root, "runtime", "toolshed"),
      role: "default",
      // The shell suites read the server's spaces through `cf inspect`.
      sharesStore: true,
    }),
};

/** The host variables this process's environment holds. */
function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BUILD_HOST_VARIABLES) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The path of the cached binary `name`, which is built in place when the
 * workflow restored none.
 *
 * The build inherits nothing from this process's environment but the host
 * variables, and is handed the variables `cachedBinaries()` names for it,
 * so a variable the lane's environment happens to hold cannot reach a
 * binary that the cache key does not describe.
 */
async function cachedBinary(
  context: CapabilityContext,
  name: CachedBinaryName,
): Promise<string> {
  const tree = context.buildFrom ?? context.root;
  const binary = path.join(tree, BINARY_CACHE_DIR, name);
  if (context.dryRun) return binary;
  let present = true;
  try {
    await Deno.stat(binary);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    present = false;
  }
  if (!present) {
    const { build, bakes } = cachedBinaries()[name];
    await execOf(context)(Deno.execPath(), ["task", "build-binaries", build], {
      cwd: tree,
      clearEnv: true,
      env: { ...hostEnv(), ...bakes },
    });
    await Deno.mkdir(path.dirname(binary), { recursive: true });
    await Deno.copyFile(path.join(tree, "dist", build), binary);
  }
  await Deno.chmod(binary, 0o755);
  return binary;
}

/**
 * A Toolshed server from a compiled binary, at a stated server-execution
 * role.
 *
 * The browser shell is a bundle baked into the binary, so this is what a
 * suite that drives a browser needs; a server run from source answers the
 * API and serves no shell. The opposite role needs a binary for a second
 * reason — its posture is a compile-time define baked into that same
 * shell.
 *
 * The lane's workflow restores these from the Actions cache before the
 * runner starts; building one here is what happens when that cache
 * missed. That is the slow path — about forty seconds against seventeen
 * for a restore — and it is what the first run after a change to the
 * sources pays.
 */
function bakedToolshed(role: ServerExecutionCiRole): Capability {
  return {
    id: role === "default" ? "toolshed-baked" : "toolshed-baked-opposite",
    description:
      `a Toolshed server with the ${role} posture in its baked shell`,
    needs: ["deno"],
    builds: `toolshed-baked-${role}`,
    async open(context) {
      return await startToolshed(context, {
        command: [await cachedBinary(context, `toolshed-baked-${role}`)],
        cwd: context.root,
        role,
        // Its integration tests start servers of their own in their test
        // processes, which read where to keep their spaces from these names.
        sharesStore: false,
      });
    },
  };
}

const toolshedBaked = bakedToolshed("default");
const toolshedBakedOpposite = bakedToolshed("opposite");

/**
 * The `cf` command line by name. `bin/cf` runs from source and works out
 * which checkout it belongs to, so putting the directory on the path is
 * the whole of it — no binary to build and nothing to download.
 */
const cf: Capability = {
  id: "cf",
  description: "the cf command line on the path, run from source",
  needs: ["deno"],
  open(context) {
    const bin = path.join(context.root, "bin");
    return Promise.resolve(exported({
      PATH: `${bin}${path.DELIMITER}${Deno.env.get("PATH") ?? ""}`,
      CF_LABS_ROOT: context.root,
    }));
  },
};

/**
 * The whole local development stack, brought up the way somebody working
 * on the repository brings it up. The reload suite needs this rather than
 * `toolshed`: its own task starts the stack, so a lane that had opened a
 * Toolshed server would have paid for the wrong thing and still failed.
 */
const localDevServers: Capability = {
  id: "local-dev-servers",
  description: "the local development stack on an allocated port offset",
  needs: ["deno"],
  sharesCheckout: true,
  // `deno task integration patterns-reload` brings the stack up and takes
  // it down around its own run. Declaring the capability is what keeps
  // that suite from being packed beside one that opened a Toolshed
  // server, which is a different server on a different port.
  open: () => Promise.resolve(exported({})),
};

/**
 * The byte cache that lets an unchanged pattern reuse the last run's
 * emitted bytes. The workflow's cache action puts the file in place; this
 * points the compiler at it and gives it somewhere to write when the
 * action found nothing.
 */
const compileCache: Capability = {
  id: "compile-cache",
  description: "the pattern compile byte cache",
  async open(context) {
    const file = path.join(context.root, COMPILE_CACHE_FILE);
    if (!context.dryRun) {
      await Deno.mkdir(path.dirname(file), { recursive: true });
    }
    return exported({ CF_COMPILE_CACHE_FILE: file });
  },
};

/** Every capability, by name. */
export const CAPABILITIES: ReadonlyMap<CapabilityId, Capability> = new Map(
  ([
    deno,
    fuse,
    jq,
    browser,
    gitHistory,
    githubApi,
    toolshed,
    toolshedBaked,
    toolshedBakedOpposite,
    cf,
    localDevServers,
    compileCache,
  ] as const).map((capability) => [capability.id, capability]),
);

/**
 * The capabilities a set of requests comes to, in the order they open.
 * A capability built on another appears after it, and each appears once
 * however many suites asked for it.
 */
export function resolveCapabilities(
  requested: Iterable<CapabilityId>,
  registry: ReadonlyMap<CapabilityId, Capability> = CAPABILITIES,
): CapabilityId[] {
  const order: CapabilityId[] = [];
  const placed = new Set<CapabilityId>();
  const visiting = new Set<CapabilityId>();
  const visit = (id: CapabilityId): void => {
    if (placed.has(id)) return;
    const capability = registry.get(id);
    if (capability === undefined) {
      throw new Error(`no such capability: ${id}`);
    }
    if (visiting.has(id)) {
      throw new Error(`capability ${id} is built on itself`);
    }
    visiting.add(id);
    for (const need of capability.needs ?? []) visit(need);
    visiting.delete(id);
    placed.add(id);
    order.push(id);
  };
  // Sorted first, so the same set opens in the same order whatever order
  // the batches were planned in.
  for (const id of [...requested].sort()) visit(id);
  return order;
}

/** What opening a set of capabilities produced. */
export interface OpenedCapabilities {
  /**
   * The environment the capabilities a suite asked for export, merged in
   * the order they opened.
   *
   * Two capabilities may export the same name and mean different things
   * by it. The two Toolshed servers are the case: each exports the
   * address its own server is listening on, and the default and opposite
   * server-execution arms can share a lane. A batch reaching the other
   * arm's server passes and reports that the arm it named works.
   */
  envFor(requested: Iterable<CapabilityId>): Record<string, string>;

  /** Seconds each capability's setup took, in the order they opened. */
  timings: Array<{ capability: CapabilityId; seconds: number }>;

  /** Every log the opened capabilities named, in the order they opened. */
  logs: Array<{ capability: CapabilityId; path: string }>;

  /**
   * Why each of the capabilities `requested` or built under them did not open,
   * which is never anything without `partial`.
   */
  refusalsFor(
    requested: Iterable<CapabilityId>,
  ): Array<{ capability: CapabilityId; why: string }>;

  /**
   * Closes them all, in the reverse of the order they opened. Settles once
   * every one has closed, and rejects naming each that failed to.
   */
  close(): Promise<void>;
}

/**
 * Opens every capability the requests come to, once each, and measures
 * what each took. The measurements are what the publisher fits
 * `setupCost` from, so they are the point of this returning anything
 * beyond the environment.
 *
 * One that fails to open closes those already open and throws, unless
 * `partial` is set. Then it is recorded with why, as is any built on it, and
 * the rest still open, so that a caller can go on with whatever needs none of
 * them.
 */
export async function openCapabilities(
  requested: Iterable<CapabilityId>,
  context: CapabilityContext,
  registry: ReadonlyMap<CapabilityId, Capability> = CAPABILITIES,
  { partial = false }: { partial?: boolean } = {},
): Promise<OpenedCapabilities> {
  const exported = new Map<CapabilityId, Record<string, string>>();
  const timings: Array<{ capability: CapabilityId; seconds: number }> = [];
  const logs: Array<{ capability: CapabilityId; path: string }> = [];
  const opened: Array<{ id: CapabilityId; open: OpenCapability }> = [];
  const refused = new Map<CapabilityId, string>();
  const refuse = (id: CapabilityId, why: string): void => {
    refused.set(id, why);
    context.report?.(`ci-lane: could not open ${id}: ${why}`);
  };
  // One that fails to close does not keep the rest open.
  const close = async (): Promise<void> => {
    const failures: string[] = [];
    for (const { id, open } of opened.reverse()) {
      try {
        await open.close();
      } catch (error) {
        failures.push(`${id} failed to close: ${describeFailure(error)}`);
      }
    }
    opened.length = 0;
    if (failures.length > 0) {
      throw new Error(failures.join("\n"));
    }
  };
  try {
    for (const id of resolveCapabilities(requested, registry)) {
      const capability = registry.get(id)!;
      const under = capability.needs?.find((need) => refused.has(need));
      if (under !== undefined) {
        refuse(id, `it is built on ${under}, which did not open`);
        continue;
      }
      context.report?.(`ci-lane: opening ${id}: ${capability.description}`);
      const startedAt = performance.now();
      let open: OpenCapability;
      try {
        open = await capability.open(context);
      } catch (error) {
        if (!partial) throw error;
        refuse(id, describeFailure(error));
        continue;
      }
      opened.push({ id, open });
      exported.set(id, open.env);
      const seconds = (performance.now() - startedAt) / 1000;
      timings.push({ capability: id, seconds });
      context.report?.(`ci-lane: opened ${id} in ${seconds.toFixed(1)}s`);
      for (const log of open.logs ?? []) {
        logs.push({ capability: id, path: log });
      }
    }
  } catch (error) {
    try {
      await close();
    } catch (closing) {
      throw new Error(
        `${describeFailure(error)}\n${describeFailure(closing)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    envFor: (requested) => {
      const env: Record<string, string> = {};
      // Resolved rather than taken as given, so that a suite naming a
      // capability gets what the capabilities under it export too.
      for (const id of resolveCapabilities(requested, registry)) {
        Object.assign(env, exported.get(id) ?? {});
      }
      return env;
    },
    timings,
    logs,
    refusalsFor: (requested) =>
      resolveCapabilities(requested, registry).flatMap((capability) => {
        const why = refused.get(capability);
        return why === undefined ? [] : [{ capability, why }];
      }),
    close,
  };
}
