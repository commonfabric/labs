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
  defaultDarwinCfcVmStore,
  type RunscSandboxConfig,
} from "../src/sandbox/runsc.ts";
import {
  type ConsoleHealthFact,
  type ConsoleHealthProbe,
  type ConsoleHealthRow,
  consoleHealthUrl,
} from "./health.ts";

/** Checks the running daemon's registration without starting a sandbox. */
export const consoleSandboxHealthProbe = (
  readRuntimes = () => readDockerRuntimes(DEFAULT_DOCKER_BINARY),
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
    detail,
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
 * observation holds no operation open.
 */
export const consoleRunscHealthProbe = (
  resolve: () => RunscSandboxConfig,
  mode: CfcEnforcementMode,
  examine: (path: string) => ConsolePathReading = readConsolePath,
  readPolicy: (path: string) => ConsolePolicyReading = readConsolePolicy,
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
      const detail = `runsc ${config.runscBinary}; rootfs ${config.rootfs}; ` +
        `CFC policy ${policy ?? "none"}`;
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
 * A cfc-vm store as the VM row reads it: the directory holding the daemon's
 * socket, the image the configured rootfs names in it, and how long the
 * daemon waits without a client before it stops the VM.
 */
export interface ConsoleVmStore {
  /** The store directory, which holds `daemon.sock`. */
  directory: string;

  /** The key of the image the rootfs names, where it is `<store>/images/<key>`. */
  imageKey?: string;

  /** Seconds the daemon waits without a client before it stops the VM. */
  idleTimeoutSec: number;
}

/** The daemon's idle timeout where its `config.json` names none. */
const CFC_VM_DEFAULT_IDLE_TIMEOUT_SEC = 600;

/** How often the daemon checks whether it has gone idle, in seconds. */
const CFC_VM_IDLE_CHECK_SEC = 15;

/**
 * The cfc-vm store the macOS runsc runs a console's sandbox in, named the way
 * runsc names it: by `CFC_VM_HOME`, or else as `cfc-vm` under the user's
 * Application Support. `undefined` off macOS, and where the store holds no
 * `config.json`, without which runsc cannot start a VM. `rootfs` names one of
 * the store's images when it is `<store>/images/<key>`, compared against the
 * store with its links resolved, as a resolved rootfs has them. `platform`
 * replaces `Deno.build.os`.
 */
export const consoleVmStore = (
  rootfs: string,
  env: Record<string, string | undefined>,
  options: { platform?: string } = {},
): ConsoleVmStore | undefined => {
  if ((options.platform ?? Deno.build.os) !== "darwin") return undefined;
  const directory = env.CFC_VM_HOME !== undefined && env.CFC_VM_HOME !== ""
    ? env.CFC_VM_HOME
    : env.HOME !== undefined && env.HOME !== ""
    ? defaultDarwinCfcVmStore(env.HOME)
    : undefined;
  if (directory === undefined) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(Deno.readTextFileSync(join(directory, "config.json")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    // A store whose configuration cannot be read is still a store; its VM is
    // what the row goes on to ask about.
  }
  const configured = isObjectNotArray(config)
    ? (config as Record<string, unknown>).idleTimeoutSec
    : undefined;
  const idleTimeoutSec = typeof configured === "number" &&
      Number.isFinite(configured) && configured > 0
    ? configured
    : CFC_VM_DEFAULT_IDLE_TIMEOUT_SEC;
  let resolved = directory;
  try {
    resolved = Deno.realPathSync(directory);
  } catch {
    // Compared as named; a rootfs under a store that cannot be resolved names
    // no image of it.
  }
  const imageKey = dirname(rootfs) === join(resolved, "images")
    ? basename(rootfs)
    : undefined;
  return {
    directory,
    ...(imageKey !== undefined ? { imageKey } : {}),
    idleTimeoutSec,
  };
};

/** What asking a cfc-vm daemon for its status found. */
export type ConsoleVmReading =
  /** Nothing listens at the socket, or there is no socket: no daemon runs. */
  | { found: "no-daemon" }
  /** The daemon answered with a JSON object. */
  | { found: "status"; status: Readonly<Record<string, unknown>> }
  /** A daemon took the connection and gave no status within the bound. */
  | { found: "no-answer"; reason: string };

/**
 * How long a status request may go unanswered before the daemon counts as not
 * answering. A daemon that answers does so in milliseconds, having asked its
 * guest. The bound is what keeps one that accepts a connection and never
 * answers from holding the observation open, and with it every later refresh
 * of the row, which waits on an observation already in flight.
 */
export const CFC_VM_STATUS_BOUND_MS = 2_000;

/**
 * Asks the cfc-vm daemon listening at `socket` for its status, with the one
 * line `#cfcvm status`. The daemon counts the request as client activity,
 * which restarts its idle timer. A socket with nothing listening on it, or no
 * socket, is no daemon; any other failure, and an answer that is not one JSON
 * object within `boundMs`, is no answer.
 */
export const askCfcVmStatus = async (
  socket: string,
  boundMs = CFC_VM_STATUS_BOUND_MS,
): Promise<ConsoleVmReading> => {
  let connection: Deno.UnixConn;
  try {
    connection = await Deno.connect({ transport: "unix", path: socket });
  } catch (error) {
    return error instanceof Deno.errors.ConnectionRefused ||
        error instanceof Deno.errors.NotFound
      ? { found: "no-daemon" }
      : { found: "no-answer", reason: `The connection failed: ${error}` };
  }
  const exchange = (async () => {
    await connection.write(new TextEncoder().encode("#cfcvm status\n"));
    return await new Response(connection.readable).text();
  })().then(
    (text) => ({ text }),
    (error: unknown) => ({ error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    exchange,
    new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), boundMs);
    }),
  ]);
  clearTimeout(timer);
  try {
    connection.close();
  } catch {
    // Reading the answer to its end has closed it already.
  }
  // Closing ends a read the bound cut short; waiting for it leaves nothing of
  // this request running.
  await exchange;
  if (outcome === "late") {
    return {
      found: "no-answer",
      reason: `The daemon gave no answer within ${boundMs} ms.`,
    };
  }
  if ("error" in outcome) {
    return {
      found: "no-answer",
      reason: `The exchange with the daemon failed: ${outcome.error}`,
    };
  }
  let status: unknown;
  try {
    status = JSON.parse(outcome.text);
  } catch {
    // Not JSON: reported below with what came back.
  }
  return isObjectNotArray(status)
    ? { found: "status", status: status as Record<string, unknown> }
    : {
      found: "no-answer",
      reason:
        debugStr`The daemon answered with something other than its status: $quote${outcome.text.trim()}`,
    };
};

/**
 * Checks, on macOS, the VM the direct runsc driver runs every sandbox in: is
 * it up, and does it hold the image the rootfs names. The rootfs row cannot
 * tell. On macOS the rootfs is a marker directory, empty by design, and it
 * reads present whether or not a VM is running.
 *
 * The VM starts on a sandbox command's first use and stops itself after
 * `idleTimeoutSec` without a client, and the daemon counts a status request
 * as one. So the probe connects only where the daemon's socket is present,
 * reads a socket with nothing listening on it as no daemon, and asks a running
 * daemon at most once per idle timeout and two of the daemon's idle checks,
 * reporting the last answer, at the time it was given, in between. A socket
 * that has gone reads as idle at once. Polling the row never starts a VM, and
 * does not on its own keep one up: a VM that nothing else uses stops before
 * the next request, which then finds no socket. What it can do is keep a VM up
 * for one idle timeout past its last use. Another client asking in between,
 * a second console's row among them, counts as use.
 *
 * `lstat` looks at the socket, `ask` puts the question, `examine` looks for an
 * image's block file, and `now` is the clock the interval runs on.
 */
export const consoleVmHealthProbe = (
  store: ConsoleVmStore,
  options: {
    lstat?: (path: string) => Deno.FileInfo;
    ask?: (socket: string) => Promise<ConsoleVmReading>;
    examine?: (path: string) => ConsolePathReading;
    now?: () => number;
  } = {},
): ConsoleHealthProbe => {
  const lstat = options.lstat ?? Deno.lstatSync;
  const ask = options.ask ?? askCfcVmStatus;
  const examine = options.examine ?? readConsolePath;
  const now = options.now ?? Date.now;
  const socket = join(store.directory, "daemon.sock");
  const askIntervalMs = (store.idleTimeoutSec + 2 * CFC_VM_IDLE_CHECK_SEC) *
    1_000;
  const fact: ConsoleHealthFact = {
    id: "sandbox.vm",
    group: "sandbox",
    label: "Sandbox VM",
    value: "not checked",
    source: "cfc-vm daemon",
    detail: socket,
  };
  const idle = (checkedAt: string, reason: string): ConsoleHealthRow => ({
    ...fact,
    state: "ok",
    checkedAt,
    value: "idle; starts on first use",
    reason,
  });
  let last: { askedAt: number; row: ConsoleHealthRow } | undefined;
  return {
    id: "sandbox.vm",
    initial: [fact],
    unavailable: (checkedAt) => [{
      ...fact,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: "The VM daemon could not be looked for.",
    }],
    read: async () => {
      const lookedAt = now();
      const checkedAt = new Date(lookedAt).toISOString();
      try {
        lstat(socket);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          return [{
            ...fact,
            state: "unknown",
            checkedAt,
            value: "not verified",
            reason: `The daemon socket could not be looked at: ${error}`,
          }];
        }
        last = undefined;
        return [idle(
          checkedAt,
          "No VM daemon is running for this store; the next sandbox command starts one.",
        )];
      }
      if (last !== undefined && lookedAt - last.askedAt < askIntervalMs) {
        return [last.row];
      }
      const reading = await ask(socket);
      if (reading.found === "no-daemon") {
        last = undefined;
        return [idle(
          checkedAt,
          "Nothing listens on the daemon socket, which is what a daemon that stopped without removing it leaves; the next sandbox command starts one.",
        )];
      }
      const row = reading.found === "status"
        ? vmStatusRow(fact, store, reading.status, checkedAt, askIntervalMs, {
          examine,
          socket,
        })
        : vmNotAnsweringRow(
          fact,
          store,
          checkedAt,
          "the VM daemon does not answer",
          reading.reason,
        );
      last = { askedAt: lookedAt, row };
      return [row];
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
 * The VM row for a daemon that answered with a status: running, unless its
 * guest gave the daemon no figures, or the VM lacks the image the rootfs names
 * and the store holds no block image runsc could attach it from.
 */
const vmStatusRow = (
  fact: ConsoleHealthFact,
  store: ConsoleVmStore,
  status: Readonly<Record<string, unknown>>,
  checkedAt: string,
  askIntervalMs: number,
  looks: {
    examine: (path: string) => ConsolePathReading;
    socket: string;
  },
): ConsoleHealthRow => {
  const { guest, images, uptimeSec } = status;
  if (
    !isObjectNotArray(guest) || !Array.isArray(images) ||
    images.some((image) => typeof image !== "string")
  ) {
    return vmNotAnsweringRow(
      fact,
      store,
      checkedAt,
      "the VM daemon does not answer",
      "The daemon's answer carries no `guest` object or no `images` list, so it is not a status.",
    );
  }
  const { memAvailableKiB, memTotalKiB } = guest as Record<string, unknown>;
  if (typeof memAvailableKiB !== "number" || typeof memTotalKiB !== "number") {
    return vmNotAnsweringRow(
      fact,
      store,
      checkedAt,
      "the VM guest does not answer",
      "The daemon answered without its guest's figures, so the agent inside the VM did not answer the daemon.",
    );
  }
  const detail = [
    `#cfcvm status at ${looks.socket}`,
    ...(typeof uptimeSec === "number" ? [`up ${vmUptime(uptimeSec)}`] : []),
    `guest memory ${Math.round(memAvailableKiB / 1024)} MiB available of ${
      Math.round(memTotalKiB / 1024)
    } MiB`,
    `images ${images.length === 0 ? "none" : images.join(", ")}`,
  ].join("; ");
  const asked =
    "The daemon answered `#cfcvm status`. A status request counts as activity, which restarts the VM's idle timer, so this row asks at most once every " +
    `${askIntervalMs / 1_000} s and shows the last answer between.`;
  const key = store.imageKey;
  if (key === undefined || images.includes(key)) {
    return {
      ...fact,
      state: "ok",
      checkedAt,
      value: "running",
      detail,
      reason: asked,
    };
  }
  const blockImage = join(store.directory, "ext4", `${key}.ext4`);
  const found = looks.examine(blockImage);
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
