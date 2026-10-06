/**
 * Read-only host checks for console health. Responses establish only the fact
 * each row names; an unreadable response leaves that fact unknown.
 */

import {
  type HarnessPatternIndexClientFactory,
  PatternIndexError,
} from "../src/pattern-index/client.ts";
import { debugStr } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { basename, dirname, join } from "@std/path";
import { DEFAULT_DOCKER_BINARY } from "../src/sandbox/docker-runsc.ts";
import { readDockerRuntimes } from "../src/sandbox/docker-runtimes.ts";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import {
  assertRunscCfcPolicyForMode,
  darwinCfcVmStore,
  type RunscSandboxConfig,
} from "../src/sandbox/runsc.ts";
import type { SandboxPlatform } from "../src/sandbox/types.ts";
import {
  type ConsoleHealthFact,
  type ConsoleHealthProbe,
  type ConsoleHealthRow,
  consoleHealthUrl,
} from "./health.ts";

/**
 * Checks the running daemon's registration without starting a sandbox.
 * `selected` describes how the console came to run on Docker, named or the
 * platform's default, and is carried in the runtime row's detail.
 */
export const consoleSandboxHealthProbe = (
  readRuntimes = () => readDockerRuntimes(DEFAULT_DOCKER_BINARY),
  selected?: string,
): ConsoleHealthProbe => {
  const source = "docker info";
  const detail = "docker info --format '{{json .Runtimes}}'";
  const initial: ConsoleHealthFact[] = [{
    id: "sandbox.docker",
    group: "sandbox",
    label: "Docker Daemon",
    value: "not checked",
    source,
    detail,
  }, {
    id: "sandbox.runtime",
    group: "sandbox",
    label: "Sandbox Runtime",
    value: "not checked",
    source,
    detail: withSelected(detail, selected),
  }];
  const unavailable = (checkedAt: string): ConsoleHealthRow[] =>
    initial.map((row) => ({
      ...row,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: "The Docker runtime table could not be read.",
      remedy: "Start Docker and check its runsc-cfc runtime registration.",
    }));
  return {
    id: "sandbox",
    initial,
    unavailable,
    read: async () => {
      const result = await readRuntimes();
      const checkedAt = new Date().toISOString();
      if (!isObjectNotArray(result.runtimes)) {
        return unavailable(checkedAt).map((row) => ({
          ...row,
          reason: result.unreadable ??
            "Docker returned an invalid runtime table.",
        }));
      }
      const registered = Object.hasOwn(result.runtimes, "runsc-cfc");
      return [{
        ...initial[0],
        state: "ok",
        checkedAt,
        value: "responding",
      }, {
        ...initial[1],
        state: registered ? "ok" : "failed",
        checkedAt,
        value: registered ? "runsc-cfc registered" : "runsc-cfc not registered",
        ...(registered ? {} : {
          reason: "The running daemon has no runsc-cfc entry.",
          remedy:
            "Install the runsc-cfc runtime and reload Docker's runtime registration.",
        }),
      }];
    },
  };
};

/**
 * Helper for the sandbox probes, which returns the runtime row's `detail`
 * with how the runtime was `selected` after it, where that is known.
 */
const withSelected = (detail: string, selected: string | undefined): string =>
  selected === undefined ? detail : `${detail}; selected: ${selected}`;

/** What a look at one host path found. */
export type ConsolePathReading =
  | { found: "file"; executable: boolean }
  | { found: "directory" }
  | { found: "other" }
  | { found: "absent" }
  | { found: "unreadable"; reason: string };

/**
 * Looks at one host path. Only a path that is not there reads as absent; any
 * other failure to look is unreadable, which leaves the fact it would have
 * established unknown. `stat` replaces `Deno.statSync`.
 */
export const readConsolePath = (
  path: string,
  stat: (path: string) => Deno.FileInfo = Deno.statSync,
): ConsolePathReading => {
  let info: Deno.FileInfo;
  try {
    info = stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { found: "absent" };
    return { found: "unreadable", reason: String(error) };
  }
  return info.isFile
    ? { found: "file", executable: ((info.mode ?? 0) & 0o111) !== 0 }
    : info.isDirectory
    ? { found: "directory" }
    : { found: "other" };
};

/**
 * What reading a CFC policy file found: a JSON object, a file the console
 * was refused permission to read, one that is not a JSON object, or a read
 * that failed some other way, which leaves the policy unknown.
 */
export type ConsolePolicyReading =
  | { found: "policy" }
  | { found: "denied"; reason: string }
  | { found: "malformed"; reason: string }
  | { found: "unreadable"; reason: string };

/**
 * Reads a CFC policy file and parses it. A policy that parses can still be
 * refused by runsc, which alone knows its schema; one that does not parse
 * as a JSON object is refused by every launch. `readText` replaces
 * `Deno.readTextFileSync`.
 */
export const readConsolePolicy = (
  path: string,
  readText: (path: string) => string = Deno.readTextFileSync,
): ConsolePolicyReading => {
  let text: string;
  try {
    text = readText(path);
  } catch (error) {
    return error instanceof Deno.errors.PermissionDenied
      ? { found: "denied", reason: String(error) }
      : { found: "unreadable", reason: String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { found: "malformed", reason: String(error) };
  }
  return isObjectNotArray(parsed)
    ? { found: "policy" }
    : { found: "malformed", reason: "the policy is not a JSON object" };
};

/**
 * Checks the direct runsc driver without starting a sandbox and without
 * consulting Docker: that its configuration resolves the way a turn resolves
 * it, that the `runsc` binary it names is an executable file, that the rootfs
 * it names is a directory, and whether a CFC policy is configured, readable
 * and a JSON object. None of that proves a sandbox can execute a task: on
 * macOS the rootfs is a marker the darwin runsc maps to a block image, which
 * this does not look at, and runsc alone knows a policy's schema.
 *
 * `mode` is the CFC enforcement mode the console's turns run at. With no
 * policy configured, the engine refuses every turn in an enforcing mode before
 * any tool runs (`assertRunscCfcPolicyForMode`), which this reports as
 * failed; in a mode that only observes, commands run without `--cfc`, which
 * it reports as degraded.
 *
 * `resolve` throws where a turn would be refused. `examine` looks at one
 * path and `readPolicy` reads the policy; all three run synchronously, so an
 * observation holds no operation open. `selected` describes how the console
 * came to run on this driver, named or the platform's default, and is
 * carried in the runtime row's detail from before the first check, the row
 * of a refused configuration included.
 */
export const consoleRunscHealthProbe = (
  resolve: () => RunscSandboxConfig,
  mode: CfcEnforcementMode,
  examine: (path: string) => ConsolePathReading = readConsolePath,
  readPolicy: (path: string) => ConsolePolicyReading = readConsolePolicy,
  selected?: string,
): ConsoleHealthProbe => {
  const source = "runsc configuration";
  const initial: ConsoleHealthFact[] = [{
    id: "sandbox.runsc",
    group: "sandbox",
    label: "Runsc Binary",
    value: "not checked",
    source,
  }, {
    id: "sandbox.runtime",
    group: "sandbox",
    label: "Sandbox Runtime",
    value: "not checked",
    source,
    // How the runtime was selected is known before anything is checked, and
    // stays known where the configuration is refused, which is where an
    // operator most needs to read it.
    ...(selected !== undefined ? { detail: `selected: ${selected}` } : {}),
  }, {
    id: "sandbox.rootfs",
    group: "sandbox",
    label: "Sandbox Rootfs",
    value: "not checked",
    source,
  }];
  const unavailable = (checkedAt: string): ConsoleHealthRow[] =>
    initial.map((row) => ({
      ...row,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: "The runsc configuration could not be examined.",
    }));
  return {
    id: "sandbox",
    initial,
    unavailable,
    read: () => {
      const checkedAt = new Date().toISOString();
      let config: RunscSandboxConfig;
      try {
        config = resolve();
      } catch (error) {
        return Promise.resolve([{
          ...initial[0],
          state: "unknown",
          checkedAt,
          value: "not verified",
          reason:
            "The runsc configuration did not resolve, so no binary was examined.",
        }, {
          ...initial[1],
          state: "failed",
          checkedAt,
          value: "configuration refused",
          reason: error instanceof Error ? error.message : String(error),
          remedy:
            "Correct the runsc settings in the console's environment (CF_HARNESS_RUNSC_BINARY, CF_HARNESS_SANDBOX_ROOTFS, CF_HARNESS_RUNSC_CFC_POLICY) or its host mounts, then restart the console.",
        }, {
          ...initial[2],
          state: "unknown",
          checkedAt,
          value: "not verified",
          reason:
            "The runsc configuration did not resolve, so no rootfs was examined.",
        }]);
      }
      const policy = config.cfcPolicyPath;
      const detail = withSelected(
        `runsc ${config.runscBinary}; rootfs ${config.rootfs}; ` +
          `CFC policy ${policy ?? "none"}`,
        selected,
      );
      const binary = examine(config.runscBinary);
      const binaryRow: ConsoleHealthRow = binary.found === "unreadable"
        ? {
          ...initial[0],
          detail: config.runscBinary,
          state: "unknown",
          checkedAt,
          value: "not verified",
          reason: binary.reason,
        }
        : binary.found === "file" && binary.executable
        ? {
          ...initial[0],
          detail: config.runscBinary,
          state: "ok",
          checkedAt,
          value: "executable",
        }
        : {
          ...initial[0],
          detail: config.runscBinary,
          state: "failed",
          checkedAt,
          value: binary.found === "absent" ? "missing" : "not executable",
          reason: binary.found === "absent"
            ? "Nothing exists at the runsc binary path."
            : "The runsc binary path is not an executable file.",
          remedy:
            "Install runsc there, or set CF_HARNESS_RUNSC_BINARY to an executable runsc, then restart the console.",
        };
      const runtimeRow: ConsoleHealthRow = policy === undefined
        ? noPolicyRow(initial[1], detail, checkedAt, config, mode)
        : policyRow(
          initial[1],
          detail,
          checkedAt,
          examine(policy),
          () => readPolicy(policy),
        );
      const rootfs = examine(config.rootfs);
      const rootfsRow: ConsoleHealthRow = rootfs.found === "unreadable"
        ? {
          ...initial[2],
          detail: config.rootfs,
          state: "unknown",
          checkedAt,
          value: "not verified",
          reason: rootfs.reason,
        }
        : rootfs.found === "directory"
        ? {
          ...initial[2],
          detail: config.rootfs,
          state: "ok",
          checkedAt,
          value: "present",
        }
        : {
          ...initial[2],
          detail: config.rootfs,
          state: "failed",
          checkedAt,
          value: rootfs.found === "absent" ? "missing" : "not a directory",
          reason: rootfs.found === "absent"
            ? "Nothing exists at the sandbox rootfs path, so no sandbox can start."
            : "The sandbox rootfs path is not a directory, so no sandbox can start.",
          remedy:
            "Install the rootfs there, or set CF_HARNESS_SANDBOX_ROOTFS to one and restart the console.",
        };
      return Promise.resolve([binaryRow, runtimeRow, rootfsRow]);
    },
  };
};

/**
 * The runtime row for a direct runsc driver with a CFC policy configured:
 * ok only for a file the console can read that parses as a JSON object. A
 * policy runsc cannot use leaves every command's output without a CFC
 * result, which an enforcing turn refuses to show the model.
 */
const policyRow = (
  fact: ConsoleHealthFact,
  detail: string,
  checkedAt: string,
  found: ConsolePathReading,
  read: () => ConsolePolicyReading,
): ConsoleHealthRow => {
  if (found.found === "unreadable") {
    return {
      ...fact,
      detail,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: found.reason,
    };
  }
  if (found.found !== "file") {
    return {
      ...fact,
      detail,
      state: "failed",
      checkedAt,
      value: found.found === "absent"
        ? "CFC policy missing"
        : "CFC policy not a file",
      reason: found.found === "absent"
        ? "Nothing exists at the configured CFC policy path."
        : "The configured CFC policy path is not a file.",
      remedy:
        "Install the policy there, or set CF_HARNESS_RUNSC_CFC_POLICY to one and restart the console.",
    };
  }
  const policy = read();
  switch (policy.found) {
    case "policy":
      return {
        ...fact,
        detail,
        state: "ok",
        checkedAt,
        value: "direct runsc driver, CFC policy configured",
      };
    case "unreadable":
      return {
        ...fact,
        detail,
        state: "unknown",
        checkedAt,
        value: "not verified",
        reason: policy.reason,
      };
    case "denied":
      return {
        ...fact,
        detail,
        state: "failed",
        checkedAt,
        value: "CFC policy unreadable",
        reason:
          `The console was refused permission to read the configured CFC policy: ${policy.reason}`,
        remedy: "Make the policy readable by the user the console runs as.",
      };
    case "malformed":
      return {
        ...fact,
        detail,
        state: "failed",
        checkedAt,
        value: "CFC policy malformed",
        reason:
          `The configured CFC policy is not a JSON object, so runsc cannot use it: ${policy.reason}`,
        remedy: "Replace the policy with a valid one.",
      };
  }
};

/** The remedy for a direct runsc driver with no CFC policy. */
const NO_POLICY_REMEDY =
  "Install a CFC policy at $HOME/.local/share/runsc-cfc/cfc-policy.json, or set CF_HARNESS_RUNSC_CFC_POLICY to one, then restart the console.";

/**
 * The runtime row for a direct runsc driver with no CFC policy, decided by the
 * engine's own floor: failed where it refuses every turn, degraded where the
 * turns run untracked.
 */
const noPolicyRow = (
  fact: ConsoleHealthFact,
  detail: string,
  checkedAt: string,
  config: RunscSandboxConfig,
  mode: CfcEnforcementMode,
): ConsoleHealthRow => {
  try {
    assertRunscCfcPolicyForMode(mode, config);
  } catch {
    return {
      ...fact,
      detail,
      state: "failed",
      checkedAt,
      value: "no CFC policy, so every turn is refused",
      reason:
        `The console's turns enforce CFC at ${mode}, and the direct runsc driver refuses every turn in an enforcing mode that has no CFC policy, before any tool runs.`,
      remedy: NO_POLICY_REMEDY,
    };
  }
  return {
    ...fact,
    detail,
    state: "degraded",
    checkedAt,
    value: "direct runsc driver, no CFC policy",
    reason:
      `The console's turns run at ${mode}, so runsc runs without --cfc and commands run untracked: their output carries no CFC result.`,
    remedy: NO_POLICY_REMEDY,
  };
};

/**
 * A cfc-vm store as the VM row reads it: one whose `config.json` the console
 * read, or one holding a `config.json` it could not read.
 */
export type ConsoleVmStore =
  | ConsoleVmConfiguredStore
  | ConsoleVmUnreadableStore;

/**
 * A cfc-vm store whose `config.json` the console read: the directory holding
 * the daemon's socket, the image the configured rootfs names in it, and how
 * long the daemon waits without a client before it stops the VM.
 */
export interface ConsoleVmConfiguredStore {
  /** The store directory, which holds `daemon.sock` and `config.json`. */
  directory: string;

  /** What the configured rootfs names in the store. */
  image: ConsoleVmImage;

  /** Seconds the daemon waits without a client before it stops the VM. */
  idleTimeoutSec: number;
}

/**
 * A cfc-vm store holding a `config.json` the console could not read as a JSON
 * object. The VM's idle timeout is in that file, and the daemon does not start
 * from one it cannot read either.
 */
export interface ConsoleVmUnreadableStore {
  /** The store directory, which holds `daemon.sock` and `config.json`. */
  directory: string;

  /** Why `config.json` could not be read as a JSON object. */
  unreadable: string;
}

/**
 * What the configured rootfs names in a cfc-vm store: the image `key`, where
 * the rootfs is `<store>/images/<key>`; none of the store's images, where it
 * is anywhere else; or unresolved, where the store's own path could not be
 * resolved to compare the rootfs with.
 */
export type ConsoleVmImage =
  | { found: "image"; key: string }
  | { found: "none" }
  | { found: "unresolved"; reason: string };

/** The daemon's idle timeout where its `config.json` names none. */
const CFC_VM_DEFAULT_IDLE_TIMEOUT_SEC = 600;

/** How often the daemon checks whether it has gone idle, in seconds. */
const CFC_VM_IDLE_CHECK_SEC = 15;

/**
 * The cfc-vm store the macOS runsc runs a console's sandbox in, named the way
 * runsc names it: by `CFC_VM_HOME`, or else as `cfc-vm` under the user's
 * Application Support. `undefined` off macOS, and where the store holds no
 * `config.json`, without which runsc cannot start a VM; unreadable where it
 * holds one that cannot be read as a JSON object. `rootfs` names one of the
 * store's images when it is `<store>/images/<key>`, compared against the store
 * with its links resolved, as a resolved rootfs has them, and the image is
 * unresolved where the store's path could not be resolved for any reason but
 * its not being there. `platform` replaces `Deno.build.os`, and `realPath`
 * replaces `Deno.realPathSync`.
 */
export const consoleVmStore = (
  rootfs: string,
  env: Record<string, string | undefined>,
  options: {
    platform?: SandboxPlatform;
    realPath?: (path: string) => string;
  } = {},
): ConsoleVmStore | undefined => {
  if ((options.platform ?? Deno.build.os) !== "darwin") return undefined;
  const directory = darwinCfcVmStore(env.CFC_VM_HOME, env.HOME);
  if (directory === undefined) return undefined;
  const configPath = join(directory, "config.json");
  let text: string;
  try {
    text = Deno.readTextFileSync(configPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    return {
      directory,
      unreadable: `${configPath} could not be read: ${error}`,
    };
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return { directory, unreadable: `${configPath} is not JSON: ${error}` };
  }
  if (!isObjectNotArray(config)) {
    return {
      directory,
      unreadable: `${configPath} holds JSON that is not an object`,
    };
  }
  const configured = config.idleTimeoutSec;
  const idleTimeoutSec = typeof configured === "number" &&
      Number.isFinite(configured) && configured > 0
    ? configured
    : CFC_VM_DEFAULT_IDLE_TIMEOUT_SEC;
  const realPath = options.realPath ?? Deno.realPathSync;
  let resolved: string;
  try {
    resolved = realPath(directory);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        directory,
        image: { found: "unresolved", reason: String(error) },
        idleTimeoutSec,
      };
    }
    // A store that is not there has no links to resolve.
    resolved = directory;
  }
  const image: ConsoleVmImage = dirname(rootfs) === join(resolved, "images")
    ? { found: "image", key: basename(rootfs) }
    : { found: "none" };
  return { directory, image, idleTimeoutSec };
};

/** What asking a cfc-vm daemon for its status found. */
export type ConsoleVmReading =
  /** Nothing listens at the socket, or there is no socket: no daemon runs. */
  | { found: "no-daemon" }
  /** The daemon answered with a JSON object. */
  | { found: "status"; status: Readonly<Record<string, unknown>> }
  /** The daemon answered with something other than one JSON object. */
  | { found: "other"; answer: string }
  /** A daemon took the connection and gave no answer within the bound. */
  | { found: "no-answer"; reason: string }
  /**
   * The socket could not be connected to, for want of permission or for some
   * reason other than nothing listening, so whether a daemon answers there
   * is not known.
   */
  | { found: "unreadable"; reason: string };

/**
 * How long a status request may go unanswered before the daemon counts as not
 * answering. The daemon answers after asking its guest, which it gives up on
 * after ten seconds, answering then without the guest's figures; five more
 * seconds cover taking the locks it reads the rest under. A daemon that has
 * not answered by then is stuck, and the bound is what keeps it from holding
 * the observation open, and with it every later refresh of the row, since the
 * console shares an observation in flight with each refresh that asks for it.
 */
export const CFC_VM_STATUS_BOUND_MS = 15_000;

/**
 * Asks the cfc-vm daemon listening at `socket` for its status, with the one
 * line `#cfcvm status`. The daemon counts the request as client activity,
 * which restarts its idle timer. A socket with nothing listening on it, or no
 * socket, is no daemon, and one that cannot be connected to otherwise is
 * unreadable. An answer is a status where it is one JSON object, and other
 * where it is anything else but nothing; once connected, any other failure, a
 * hang-up with nothing said among them, and no answer within `boundMs`, is no
 * answer. `boundMs` replaces {@link CFC_VM_STATUS_BOUND_MS}, and `connect`
 * replaces connecting to the socket with `Deno.connect`.
 */
export const askCfcVmStatus = async (
  socket: string,
  options: {
    boundMs?: number;
    connect?: (socket: string) => Promise<Deno.UnixConn>;
  } = {},
): Promise<ConsoleVmReading> => {
  const boundMs = options.boundMs ?? CFC_VM_STATUS_BOUND_MS;
  const connect = options.connect ??
    ((path: string) => Deno.connect({ transport: "unix", path }));
  let connection: Deno.UnixConn;
  try {
    connection = await connect(socket);
  } catch (error) {
    return noDaemon(error) ? { found: "no-daemon" } : {
      found: "unreadable",
      reason: `The daemon socket could not be connected to: ${error}`,
    };
  }
  // Closing the connection is what ends a read the bound cuts short, so the
  // one wait below is the whole of the request.
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    closeQuietly(connection);
  }, boundMs);
  let text: string;
  try {
    await connection.write(new TextEncoder().encode("#cfcvm status\n"));
    text = await new Response(connection.readable).text();
  } catch (error) {
    return {
      found: "no-answer",
      reason: late
        ? `The daemon gave no answer within ${boundMs} ms.`
        : `The exchange with the daemon failed: ${error}`,
    };
  } finally {
    clearTimeout(timer);
    closeQuietly(connection);
  }
  if (text.trim() === "") {
    return {
      found: "no-answer",
      reason: "The daemon hung up without an answer.",
    };
  }
  let status: unknown;
  try {
    status = JSON.parse(text);
  } catch {
    // Not JSON: an answer all the same, handed back as it came.
  }
  return isObjectNotArray(status)
    ? { found: "status", status }
    : { found: "other", answer: text.trim() };
};

/**
 * Connects to the cfc-vm daemon listening at `socket` and hangs up without
 * sending a byte. The daemon closes such a connection and counts it as no
 * activity, so this finds out whether a daemon listens without restarting its
 * idle timer. A socket with nothing listening on it, or no socket, is no
 * daemon, and any other failure to connect is returned as it came.
 */
export const touchCfcVmDaemon = async (
  socket: string,
): Promise<"listening" | "no-daemon" | { failed: string }> => {
  try {
    closeQuietly(await Deno.connect({ transport: "unix", path: socket }));
    return "listening";
  } catch (error) {
    return noDaemon(error) ? "no-daemon" : { failed: String(error) };
  }
};

/** Helper for the VM probe, which returns whether `error` means no daemon. */
const noDaemon = (error: unknown): boolean =>
  error instanceof Deno.errors.ConnectionRefused ||
  error instanceof Deno.errors.NotFound;

/** Helper for the VM probe, which closes `connection` if it is still open. */
const closeQuietly = (connection: Deno.Conn): void => {
  try {
    connection.close();
  } catch {
    // Reading the answer to its end has closed it already.
  }
};

/**
 * Checks, on macOS, the VM the direct runsc driver runs every sandbox in: is
 * it up, and does it hold the image the rootfs names. The rootfs row cannot
 * tell. On macOS the rootfs is a marker directory, empty by design, and it
 * reads present whether or not a VM is running.
 *
 * The VM starts on a sandbox command's first use and stops itself after
 * `idleTimeoutSec` without a client, and the daemon counts a status request
 * as one. So every read looks for the daemon's socket, where no socket is
 * no daemon, and a daemon is asked for its status at most once per idle
 * timeout and two of its idle checks, whatever its answer said, status or
 * not, and at once where the socket is not the one it last answered on, or
 * the last question got no answer. Between two questions a read connects and
 * hangs up without asking, which the daemon does not count as activity, and
 * reports the last answer as of when it was given, against the block images
 * the store holds now. So a daemon that stops, however it stops, reads idle
 * at the next read. A socket that cannot be looked at, or connected to other
 * than for nothing listening on it, leaves the row unknown: that says nothing
 * of whether a daemon answers there.
 *
 * Polling the row never starts a VM, and does not on its own keep one up: a
 * VM that nothing else uses stops before the next question, which then finds
 * no daemon. What it can do is keep a VM up for one idle timeout past its
 * last use. Another client asking in between, a second console's row among
 * them, counts as use. A store whose `config.json` could not be read has no
 * idle timeout to pace the questions by, so its row is unknown at every read
 * and the daemon is not looked for.
 *
 * `lstat` looks at the socket, `touch` and `ask` reach the daemon, `examine`
 * looks for an image's block file, and `now` is the monotonic clock, in
 * milliseconds, the interval runs on.
 */
export const consoleVmHealthProbe = (
  store: ConsoleVmStore,
  options: {
    lstat?: (path: string) => Deno.FileInfo;
    touch?: (
      socket: string,
    ) => Promise<"listening" | "no-daemon" | { failed: string }>;
    ask?: (socket: string) => Promise<ConsoleVmReading>;
    examine?: (path: string) => ConsolePathReading;
    now?: () => number;
  } = {},
): ConsoleHealthProbe => {
  const lstat = options.lstat ?? Deno.lstatSync;
  const touch = options.touch ?? touchCfcVmDaemon;
  const ask = options.ask ?? askCfcVmStatus;
  const examine = options.examine ?? readConsolePath;
  const now = options.now ?? (() => performance.now());
  const socket = join(store.directory, "daemon.sock");
  const fact: ConsoleHealthFact = {
    id: "sandbox.vm",
    group: "sandbox",
    label: "Sandbox VM",
    value: "not checked",
    source: "cfc-vm daemon",
    detail: socket,
  };
  const unknown = (checkedAt: string, reason: string): ConsoleHealthRow => ({
    ...fact,
    state: "unknown",
    checkedAt,
    value: "not verified",
    reason,
  });
  const unavailable = (checkedAt: string): ConsoleHealthRow[] => [
    unknown(checkedAt, "The VM daemon could not be looked for."),
  ];
  if ("unreadable" in store) {
    return {
      id: "sandbox.vm",
      initial: [fact],
      unavailable,
      read: () =>
        Promise.resolve([{
          ...unknown(
            new Date().toISOString(),
            `${store.unreadable}. That file holds the VM's idle timeout, which paces this row's questions, so the row asks the daemon nothing.`,
          ),
          remedy: `Make ${
            join(store.directory, "config.json")
          } a readable JSON object, which the daemon needs to start a VM, then restart the console, which reads it once.`,
        }]),
    };
  }
  const askIntervalMs = (store.idleTimeoutSec + 2 * CFC_VM_IDLE_CHECK_SEC) *
    1_000;
  const idle = (checkedAt: string, reason: string): ConsoleHealthRow => ({
    ...fact,
    state: "ok",
    checkedAt,
    value: "idle; starts on first use",
    reason,
  });
  const notAnswering = (checkedAt: string, reason: string) =>
    vmNotAnsweringRow(
      fact,
      store,
      checkedAt,
      "the VM daemon does not answer",
      reason,
    );
  const noSocket =
    "No VM daemon is running for this store; the next sandbox command starts one.";
  const nothingListening =
    "Nothing listens on the daemon socket, which is what a daemon that stopped without removing it leaves; the next sandbox command starts one.";
  /**
   * The last status the daemon gave, the socket it came on, when it was asked
   * for on the interval's clock, and when it was given.
   */
  let last:
    | { askedAt: number; socket: string; answer: VmAnswer; answeredAt: string }
    | undefined;
  const answerRow = (answer: VmAnswer, checkedAt: string, answeredAt: string) =>
    "status" in answer
      ? vmStatusRow(fact, store, answer.status, {
        checkedAt,
        answeredAt,
        askIntervalMs,
        examine,
        socket,
      })
      : notAnswering(
        checkedAt,
        `The daemon answered at ${answeredAt} ${answer.notStatus}, so it is ` +
          "not a status. The answer is held as a status would be, since " +
          "asking again is activity that would keep the VM up.",
      );
  return {
    id: "sandbox.vm",
    initial: [fact],
    unavailable,
    read: async () => {
      const checkedAt = new Date().toISOString();
      let info: Deno.FileInfo;
      try {
        info = lstat(socket);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          return [
            unknown(
              checkedAt,
              `The daemon socket could not be looked at: ${error}`,
            ),
          ];
        }
        last = undefined;
        return [idle(checkedAt, noSocket)];
      }
      // A daemon binds its socket afresh, so one that has replaced the daemon
      // last asked is on a socket the last answer did not come on.
      const identity = `${info.dev}:${info.ino}:${info.mtime?.getTime()}`;
      if (
        last !== undefined && last.socket === identity &&
        now() - last.askedAt < askIntervalMs
      ) {
        const found = await touch(socket);
        if (found === "listening") {
          return [answerRow(last.answer, checkedAt, last.answeredAt)];
        }
        last = undefined;
        return [
          found === "no-daemon" ? idle(checkedAt, nothingListening) : unknown(
            checkedAt,
            `The daemon socket could not be connected to: ${found.failed}`,
          ),
        ];
      }
      const askedAt = now();
      const reading = await ask(socket);
      if (reading.found === "no-daemon") {
        return [idle(checkedAt, nothingListening)];
      }
      if (reading.found === "unreadable") {
        return [unknown(checkedAt, reading.reason)];
      }
      if (reading.found === "no-answer") {
        return [notAnswering(checkedAt, reading.reason)];
      }
      // Held whatever it says: the daemon answered, and asking it again is
      // activity that would keep the VM up for as long as the row is read.
      const answer = vmAnswer(reading);
      last = { askedAt, socket: identity, answer, answeredAt: checkedAt };
      return [answerRow(answer, checkedAt, checkedAt)];
    },
  };
};

/**
 * The VM row for a daemon or a guest that gave no status, with the way to a
 * fresh VM.
 */
const vmNotAnsweringRow = (
  fact: ConsoleHealthFact,
  store: ConsoleVmStore,
  checkedAt: string,
  value: string,
  reason: string,
): ConsoleHealthRow => ({
  ...fact,
  state: "failed",
  checkedAt,
  value,
  reason,
  remedy: `Read ${
    join(store.directory, "daemon.log")
  }; ending the cfc-vm process that serves this store lets the next sandbox command start a fresh VM.`,
});

/**
 * What the VM row holds of a daemon's answer: the status it read, or, for an
 * answer that is none, what the answer was, as a phrase.
 */
type VmAnswer = { status: VmStatus } | { notStatus: string };

/**
 * Helper for the VM probe, which returns what the row holds of `reading`, an
 * answer the daemon gave.
 */
const vmAnswer = (
  reading:
    | { found: "status"; status: Readonly<Record<string, unknown>> }
    | { found: "other"; answer: string },
): VmAnswer => {
  if (reading.found === "other") {
    return {
      notStatus:
        debugStr`with something other than JSON, $quote${reading.answer}`,
    };
  }
  const status = readVmStatus(reading.status);
  return status !== undefined ? { status } : {
    notStatus: "with JSON that carries no `guest` object or no `images` list",
  };
};

/** What the VM row reads of a daemon's status. */
interface VmStatus {
  /** The guest agent's own figures, empty where it did not answer. */
  guest: Readonly<Record<string, unknown>>;

  /** The images the VM attached when it started. */
  images: readonly string[];

  /** Seconds since the daemon started, where it said. */
  uptimeSec?: number;
}

/**
 * Helper for the VM probe, which returns the parts of `status` the row reads,
 * or `undefined` where it carries no `guest` object or no list of image names,
 * and so is not a status.
 */
const readVmStatus = (
  status: Readonly<Record<string, unknown>>,
): VmStatus | undefined => {
  const { guest, images, uptimeSec } = status;
  if (!isObjectNotArray(guest) || !Array.isArray(images)) return undefined;
  const names: string[] = [];
  for (const image of images) {
    if (typeof image !== "string") return undefined;
    names.push(image);
  }
  return {
    guest,
    images: names,
    ...(typeof uptimeSec === "number" ? { uptimeSec } : {}),
  };
};

/**
 * The VM row for a daemon that answered `status` at `answeredAt`: running,
 * unless its guest gave the daemon no figures, or the VM lacks the image the
 * rootfs names and the store holds no block image runsc could attach it from.
 * Where which image the rootfs names could not be told, or the block image
 * could not be looked at, whether the VM can run a sandbox is unknown. The
 * block image is looked for at every call, so installing it clears the row
 * without asking the daemon again.
 */
const vmStatusRow = (
  fact: ConsoleHealthFact,
  store: ConsoleVmConfiguredStore,
  status: VmStatus,
  at: {
    checkedAt: string;
    answeredAt: string;
    askIntervalMs: number;
    examine: (path: string) => ConsolePathReading;
    socket: string;
  },
): ConsoleHealthRow => {
  const { guest, images, uptimeSec } = status;
  const { checkedAt } = at;
  const { memAvailableKiB, memTotalKiB } = guest;
  if (typeof memAvailableKiB !== "number" || typeof memTotalKiB !== "number") {
    return vmNotAnsweringRow(
      fact,
      store,
      checkedAt,
      "the VM guest does not answer",
      `The daemon answered at ${at.answeredAt} without its guest's figures, so the agent inside the VM did not answer the daemon.`,
    );
  }
  const detail = [
    `#cfcvm status at ${at.socket}`,
    ...(uptimeSec !== undefined ? [`up ${vmUptime(uptimeSec)}`] : []),
    `guest memory ${Math.round(memAvailableKiB / 1024)} MiB available of ${
      Math.round(memTotalKiB / 1024)
    } MiB`,
    `images ${images.length === 0 ? "none" : images.join(", ")}`,
  ].join("; ");
  const asked =
    `The daemon answered \`#cfcvm status\` at ${at.answeredAt}. A ` +
    "status request counts as activity, which restarts the VM's idle timer, " +
    `so this row asks at most once every ${
      at.askIntervalMs / 1_000
    } s and in ` +
    "between only connects, which does not count, to see that the daemon " +
    "still listens.";
  const { image } = store;
  if (image.found === "unresolved") {
    return {
      ...fact,
      state: "unknown",
      checkedAt,
      value: "not verified",
      detail,
      reason:
        `Which of the store's images the rootfs names could not be told, since ${store.directory} could not be resolved: ${image.reason}`,
    };
  }
  if (image.found === "none" || images.includes(image.key)) {
    return {
      ...fact,
      state: "ok",
      checkedAt,
      value: "running",
      detail,
      reason: asked,
    };
  }
  const { key } = image;
  const blockImage = join(store.directory, "ext4", `${key}.ext4`);
  const found = at.examine(blockImage);
  if (found.found === "file") {
    return {
      ...fact,
      state: "ok",
      checkedAt,
      value: "running",
      detail,
      reason:
        `${asked} The VM did not attach ${key} when it started; runsc attaches it from ${blockImage} on first use.`,
    };
  }
  if (found.found === "unreadable") {
    return {
      ...fact,
      state: "unknown",
      checkedAt,
      value: "not verified",
      detail,
      reason:
        `The VM did not attach ${key} when it started, and ${blockImage} could not be looked at: ${found.reason}`,
    };
  }
  return {
    ...fact,
    state: "failed",
    checkedAt,
    value: `the VM has no ${key} image`,
    detail,
    reason:
      `The configured rootfs names the ${key} image, which the running VM has not attached and the store holds no block image for, so no sandbox command can start.`,
    remedy:
      `Install the ${key} image into the store, as ${blockImage}; runsc attaches it on the next sandbox command.`,
  };
};

/** Helper for the VM row, which writes a count of seconds as `26m 32s`. */
const vmUptime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}h ${minutes}m`
    : minutes > 0
    ? `${minutes}m ${rest}s`
    : `${rest}s`;
};

/** Checks health and membership independently using the console's client. */
export const consolePatternIndexHealthProbes = (
  baseUrl: string,
  clientFactory: HarnessPatternIndexClientFactory,
): readonly ConsoleHealthProbe[] => {
  const displayUrl = consoleHealthUrl(baseUrl);
  const facts: ConsoleHealthFact[] = [{
    id: "index.reachable",
    group: "index",
    label: "Pattern Index Reachability",
    value: "not checked",
    source: "index /health",
    detail: `GET health at ${displayUrl}`,
  }, {
    id: "index.enrolled",
    group: "index",
    label: "Pattern Index Enrollment",
    value: "not checked",
    source: "index /enrollmentStatus",
    detail: `GET enrollmentStatus at ${displayUrl}, for the console identity`,
  }];
  return facts.map((fact, index) => {
    const unavailable = (
      checkedAt: string,
      error?: unknown,
    ): ConsoleHealthRow[] => [{
      ...fact,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: error instanceof PatternIndexError
        ? `The index answered HTTP ${error.status}; this does not establish ${
          index === 0 ? "health" : "membership"
        }.`
        : "The index observation could not be completed or its response was not valid.",
      remedy:
        "Check the configured index URL, network access, and console identity file.",
    }];
    return {
      id: fact.id,
      initial: [fact],
      unavailable,
      read: async () => {
        const client = await clientFactory();
        const result =
          await (index === 0 ? client.health() : client.enrollmentStatus());
        const checkedAt = new Date().toISOString();
        if (!isObjectNotArray(result)) return unavailable(checkedAt);
        const record = result as Record<string, unknown>;
        const field = index === 0 ? "ok" : "enrolled";
        if (
          !Object.hasOwn(record, field) || typeof record[field] !== "boolean" ||
          (index !== 0 &&
            (!Object.hasOwn(record, "did") || record.did !== client.did))
        ) return unavailable(checkedAt);
        const confirmed = record[field];
        return [{
          ...fact,
          state: confirmed ? "ok" : "failed",
          checkedAt,
          value: index === 0
            ? confirmed ? "responding" : "reports unhealthy"
            : confirmed
            ? "console identity enrolled"
            : "console identity not enrolled",
          ...(confirmed ? {} : {
            reason: index === 0
              ? "The index reports that its health check failed."
              : "The index reports no enrollment for the console identity.",
            remedy: index === 0
              ? "Check the pattern index deployment."
              : `Enroll the console's identity through ${
                displayUrl.replace(/\/+$/, "")
              }/enroll.`,
          }),
        }];
      },
    };
  });
};
