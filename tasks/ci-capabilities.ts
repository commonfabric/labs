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

import { type BinaryName, BUILD_HOST_VARIABLES } from "./build-binaries.ts";
import {
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
  | "bg-piece-service-binary"
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
   * How a capability runs a command. A caller that supplies one is
   * saying what the machine would have answered, which is the only way
   * setup that installs packages and starts servers can be exercised
   * without a machine that has neither.
   */
  exec?: Exec;

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

  /** Shuts it down. Called once, in the reverse of the opening order. */
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

  open(context: CapabilityContext): Promise<OpenCapability>;
}

/**
 * What a lane keeps between runs, relative to the repository root. The
 * lane's workflow carries one fixed cache step covering this directory,
 * so everything a lane wants restored has to sit inside it, and it has
 * to outlive the lane: a directory the lane made for itself would be
 * empty on every run, and everything in it would be built again.
 */
export const CACHE_DIR = ".ci-cache";

/** Where a built binary is kept, inside that directory. */
export const BINARY_CACHE_DIR = `${CACHE_DIR}/binaries`;

/** Where the pattern compile byte cache is kept, inside that directory. */
export const COMPILE_CACHE_FILE = `${CACHE_DIR}/compile/lane.json`;

/**
 * The server-execution define a Toolshed at `role` is built and run with: the
 * value the role names, or nothing where it names none. `defaultEnabled`
 * stands in for the first-party default where given.
 */
function serverExecutionDefine(
  role: ServerExecutionCiRole,
  defaultEnabled?: boolean,
): Record<string, string> {
  const value = serverExecutionCiLane(role, defaultEnabled).experimentalValue;
  return value === undefined ? {} : { EXPERIMENTAL_SERVER_EXECUTION: value };
}

/** The name of a binary a lane keeps in `BINARY_CACHE_DIR`. */
export type CachedBinaryName =
  | `toolshed-baked-${ServerExecutionCiRole}`
  | "bg-piece-service";

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
    bakes: serverExecutionDefine(role, defaultEnabled),
  });
  return {
    "toolshed-baked-default": toolshed("default"),
    "toolshed-baked-opposite": toolshed("opposite"),
    "bg-piece-service": { build: "bg-piece-service", bakes: {} },
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
const run: Exec = async (command, args, options = {}) => {
  const result = await new Deno.Command(command, {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.clearEnv === undefined ? {} : { clearEnv: options.clearEnv }),
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.success) return stdout;
  const stderr = new TextDecoder().decode(result.stderr);
  throw new Error(
    `${command} ${args.join(" ")} exited ${result.code}\n${stdout}${stderr}`,
  );
};

/** How this context runs commands. */
function execOf(context: CapabilityContext): Exec {
  return context.exec ?? run;
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
 * Installs Debian packages, and does nothing where the probes say they
 * are already there.
 *
 * A probe is a command whose success means what one of the packages
 * provides is there. A package that puts a command on the path is
 * probed with `onPath`; a package whose point is a file is probed with
 * whatever answers about that file.
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
  await exec("sudo", ["apt-get", "update"]);
  await exec("sudo", [
    "apt-get",
    "install",
    "-y",
    "--no-install-recommends",
    ...packages,
  ]);
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
  async open(context) {
    if (!context.dryRun) {
      await apt(execOf(context), ["jq"], [onPath("jq")]);
    }
    return exported({});
  },
};

/**
 * Astral drives Chrome through a user namespace, which Ubuntu's AppArmor
 * profile denies to unprivileged processes. Relaxing it is the whole of
 * what a browser test needs from the machine.
 */
const browser: Capability = {
  id: "browser",
  description: "the AppArmor relaxation a sandboxed browser needs",
  async open(context) {
    const sysctl = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
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
 * carrying the server-execution define the role names, and carrying none
 * where the role names none.
 *
 * An unset define is a third state rather than a synonym for `false`. It
 * follows the first-party default, which is what the default role's posture
 * check asks for, so that role removes the name rather than setting it.
 */
function serverExecutionEnv(
  role: ServerExecutionCiRole,
): Record<string, string> {
  const env = Deno.env.toObject();
  delete env.EXPERIMENTAL_SERVER_EXECUTION;
  return { ...env, ...serverExecutionDefine(role) };
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

/** The process identifier a background launch reports having detached. */
export function pidOfBackgroundLaunch(output: string): number | undefined {
  const match = /\(pid (\d+)\)/.exec(output);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Starts a Toolshed server and exports the addresses the suites reach it
 * at. `--background` is what makes this a single call: the launcher waits
 * for the server to report over a pipe that it has bound its port, then
 * detaches and prints the server's process identifier, so there is
 * nothing here to poll and nothing to wait a fixed time for. Killing that
 * process is the close, so a lane that opened a server leaves nothing
 * listening behind it.
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
  if (context.dryRun) return exported(env);
  const [command, ...args] = options.command;
  const logFile = path.join(context.workDir, `toolshed-${port}.log`);
  const output = await execOf(context)(command!, [
    ...args,
    `--port=${port}`,
    "--background",
    `--log-file=${logFile}`,
  ], {
    cwd: options.cwd,
    // The environment below is the whole of it, so that a name
    // `serverExecutionEnv()` removed is unset rather than inherited.
    clearEnv: true,
    env: {
      ...serverExecutionEnv(options.role),
      // The server reaches for a gateway and a model key at startup. A
      // test server has neither.
      CFTS_AI_GATEWAY_URL: "",
      CFTS_AI_LLM_ANTHROPIC_API_KEY: "fake",
      ...env,
    },
  });
  const pid = pidOfBackgroundLaunch(output);
  if (pid === undefined) {
    throw new Error(`the toolshed launch named no process:\n${output}`);
  }
  const stop = () => {
    try {
      Deno.kill(pid, "SIGTERM");
    } catch {
      // Already gone, which is the state this was after.
    }
  };
  try {
    await verifyServerExecutionPosture(
      options.role,
      url,
      context.fetch ?? fetch,
    );
  } catch (error) {
    stop();
    // The server started and then failed its posture check, so its own log
    // is the account of why. Nothing is holding the path at this point --
    // the capability never opened -- so the log is carried in the throw or
    // it goes with the work directory unread.
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `toolshed log:\n${await logTail(logFile)}`,
      { cause: error },
    );
  }
  return {
    env,
    logs: [logFile],
    close: () => {
      stop();
      return Promise.resolve();
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
      cwd: path.join(context.root, "packages", "toolshed"),
      role: "default",
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
  const binary = path.join(context.root, BINARY_CACHE_DIR, name);
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
      cwd: context.root,
      clearEnv: true,
      env: { ...hostEnv(), ...bakes },
    });
    await Deno.mkdir(path.dirname(binary), { recursive: true });
    await Deno.copyFile(path.join(context.root, "dist", build), binary);
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
    async open(context) {
      return await startToolshed(context, {
        command: [await cachedBinary(context, `toolshed-baked-${role}`)],
        cwd: context.root,
        role,
      });
    },
  };
}

const toolshedBaked = bakedToolshed("default");
const toolshedBakedOpposite = bakedToolshed("opposite");

/**
 * The compiled background-piece-service binary used by its deployed-topology
 * gate. That gate deliberately starts the shipped artifact rather than a
 * source process, so the binary is a capability like the baked Toolshed.
 */
const bgPieceServiceBinary: Capability = {
  id: "bg-piece-service-binary",
  description: "the compiled background-piece-service binary",
  needs: ["deno"],
  async open(context) {
    return exported({
      BG_PIECE_SERVICE_BIN: await cachedBinary(context, "bg-piece-service"),
    });
  },
};

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
    bgPieceServiceBinary,
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

  /** Closes them all, in the reverse of the order they opened. */
  close(): Promise<void>;
}

/**
 * Opens every capability the requests come to, once each, and measures
 * what each took. The measurements are what the publisher fits
 * `setupCost` from, so they are the point of this returning anything
 * beyond the environment.
 */
export async function openCapabilities(
  requested: Iterable<CapabilityId>,
  context: CapabilityContext,
  registry: ReadonlyMap<CapabilityId, Capability> = CAPABILITIES,
): Promise<OpenedCapabilities> {
  const exported = new Map<CapabilityId, Record<string, string>>();
  const timings: Array<{ capability: CapabilityId; seconds: number }> = [];
  const logs: Array<{ capability: CapabilityId; path: string }> = [];
  const opened: OpenCapability[] = [];
  const close = async (): Promise<void> => {
    for (const capability of opened.reverse()) {
      try {
        await capability.close();
      } catch (error) {
        console.warn(`ci-lane: closing a capability failed: ${error}`);
      }
    }
    opened.length = 0;
  };
  try {
    for (const id of resolveCapabilities(requested, registry)) {
      const capability = registry.get(id)!;
      const startedAt = performance.now();
      const open = await capability.open(context);
      opened.push(open);
      exported.set(id, open.env);
      timings.push({
        capability: id,
        seconds: (performance.now() - startedAt) / 1000,
      });
      for (const log of open.logs ?? []) {
        logs.push({ capability: id, path: log });
      }
    }
  } catch (error) {
    await close();
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
    close,
  };
}
