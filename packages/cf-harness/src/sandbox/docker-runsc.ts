import {
  isAbsolute as isAbsoluteHostPath,
  join as joinHostPath,
} from "@std/path";
import {
  isAbsolute as isAbsoluteSandboxPath,
  join as joinSandboxPath,
  normalize,
} from "@std/path/posix";

import type {
  CfcEnforcementMode,
  CfcSandboxJsonValue,
  CfcSandboxResult,
  CfcStreamChannel,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import {
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { HarnessCfcInvocationContext } from "../contracts/cfc-invocation-context.ts";
import { readDockerRuntimes } from "./docker-runtimes.ts";
import { SandboxPathEscapeError } from "./errors.ts";
import { DenoProcessRunner, type ProcessRunner } from "./process-runner.ts";
import type {
  CfcSidecarTransportKind,
  CfcSidecarTransportReading,
  CfcTransportReadiness,
  DockerNetworkMode,
  DockerRunscAdditionalMount,
  DockerRunscAdditionalMountConfig,
  DockerRunscSandboxConfig,
  ResolveDockerRunscSandboxConfigOptions,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxRuntimeMountDescription,
  SandboxShellRequest,
} from "./types.ts";

export const DEFAULT_DOCKER_RUNSC_IMAGE =
  "us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest";
export const DEFAULT_DOCKER_RUNTIME_NAME = "runsc-cfc";
export const DEFAULT_DOCKER_BINARY = "docker";
export const DEFAULT_WORKSPACE_MOUNT_PATH = "/workspace";
export const DEFAULT_SANDBOX_SHELL = "/bin/sh";
export const DEFAULT_DOCKER_NETWORK_MODE = "bridge" as const;
export const DEFAULT_FABRIC_MOUNT_PATH = "/fabric";
export const DOCKER_NETWORK_MODE_ENV = "CF_HARNESS_DOCKER_NETWORK_MODE";
export const CFC_RESULT_DIR_ENV = "CF_HARNESS_RUNSC_CFC_RESULT_DIR";
export const CFC_INVOCATION_CONTEXT_DIR_ENV =
  "CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR";

interface RunscCfcLabelSidecar {
  string?: unknown;
  xattrJSON?: unknown;
}

interface RunscCfcResultSidecar {
  version?: unknown;
  containerId?: unknown;
  sandboxId?: unknown;
  waitStatus?: unknown;
  cfcTaint?: unknown;
}

const textEncoder = new TextEncoder();

const readEnvVar = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const optionalNonEmptyString = (
  value: string | undefined,
): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

const parseDockerNetworkMode = (
  value: string | undefined,
): DockerNetworkMode | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "none" || value === "bridge" || value === "host") {
    return value;
  }
  throw new Error(
    `${DOCKER_NETWORK_MODE_ENV} must be one of none, bridge, or host`,
  );
};

const validateAbsoluteHostDir = (path: string, label: string): string => {
  if (path.trim() === "") {
    throw new Error(`${label} must not be empty`);
  }
  if (!isAbsoluteHostPath(path)) {
    throw new Error(`${label} must be an absolute host path`);
  }
  return path;
};

export const resolveDefaultContainerUser = (
  hostOs: typeof Deno.build.os = Deno.build.os,
): string | undefined => {
  // Docker Desktop bind mounts are mediated by a Linux VM; the macOS uid/gid
  // does not imply write access inside the container.
  if (hostOs === "windows" || hostOs === "darwin") {
    return undefined;
  }
  const uidFromEnv = readEnvVar("UID");
  const gidFromEnv = readEnvVar("GID");
  if (uidFromEnv !== undefined && gidFromEnv !== undefined) {
    return `${uidFromEnv}:${gidFromEnv}`;
  }
  try {
    const uid = Deno.uid();
    const gid = Deno.gid();
    return `${uid}:${gid}`;
  } catch {
    try {
      const uidResult = new Deno.Command("id", {
        args: ["-u"],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      const gidResult = new Deno.Command("id", {
        args: ["-g"],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      if (uidResult.success && gidResult.success) {
        const uid = new TextDecoder().decode(uidResult.stdout).trim();
        const gid = new TextDecoder().decode(gidResult.stdout).trim();
        if (uid.length > 0 && gid.length > 0) {
          return `${uid}:${gid}`;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
};

const normalizeWorkspacePath = (path: string): string => {
  const normalized = normalize(path);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const validateSandboxRoot = (path: string, label: string): string => {
  const normalized = normalizeWorkspacePath(path);
  if (!isAbsoluteSandboxPath(normalized) || normalized === "/") {
    throw new Error(`${label} must be an absolute non-root sandbox path`);
  }
  return normalized;
};

const isWithinRoot = (root: string, path: string): boolean => {
  const normalizedRoot = normalizeWorkspacePath(root);
  const normalizedPath = normalizeWorkspacePath(path);
  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
};

const rootsOverlap = (left: string, right: string): boolean =>
  isWithinRoot(left, right) || isWithinRoot(right, left);

const normalizeAdditionalMount = (
  mount: DockerRunscAdditionalMountConfig,
): DockerRunscAdditionalMount => {
  if (mount.hostPath.trim() === "") {
    throw new Error(`${mount.kind} hostPath must not be empty`);
  }
  if (mount.kind === "host-bind" && mount.name.trim() === "") {
    throw new Error("host-bind name must not be empty");
  }
  if (mount.kind === "host-bind") {
    return {
      kind: "host-bind",
      name: mount.name,
      hostPath: mount.hostPath,
      sandboxPath: validateSandboxRoot(
        mount.sandboxPath,
        "host-bind sandboxPath",
      ),
      readOnly: mount.readOnly ?? true,
    };
  }
  return {
    kind: "fabric-fuse",
    hostPath: mount.hostPath,
    sandboxPath: validateSandboxRoot(
      mount.sandboxPath ?? DEFAULT_FABRIC_MOUNT_PATH,
      "fabric-fuse sandboxPath",
    ),
    readOnly: mount.readOnly ?? false,
  };
};

const validateNonOverlappingMounts = (
  mounts: readonly { kind: string; sandboxPath: string }[],
): void => {
  for (let i = 0; i < mounts.length; i += 1) {
    for (let j = i + 1; j < mounts.length; j += 1) {
      const left = mounts[i]!;
      const right = mounts[j]!;
      if (rootsOverlap(left.sandboxPath, right.sandboxPath)) {
        throw new Error(
          `sandbox mount paths overlap: ${left.sandboxPath} (${left.kind}) and ${right.sandboxPath} (${right.kind})`,
        );
      }
    }
  }
};

const dockerMountArg = (mount: {
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}): string =>
  `type=bind,src=${mount.hostPath},dst=${mount.sandboxPath}${
    mount.readOnly ? ",readonly" : ""
  }`;

const resolveCfcInvocationContextDir = (
  options: ResolveDockerRunscSandboxConfigOptions,
): string | undefined => {
  const dir = optionalNonEmptyString(
    options.cfcInvocationContextDir ??
      readEnvVar(CFC_INVOCATION_CONTEXT_DIR_ENV),
  );
  return dir === undefined
    ? undefined
    : validateAbsoluteHostDir(dir, "cfcInvocationContextDir");
};

export const resolveDockerRunscSandboxConfig = (
  options: ResolveDockerRunscSandboxConfigOptions,
): DockerRunscSandboxConfig => {
  const containerUser = options.containerUser ?? resolveDefaultContainerUser();
  const workspaceMountPath = validateSandboxRoot(
    options.workspaceMountPath ?? DEFAULT_WORKSPACE_MOUNT_PATH,
    "workspaceMountPath",
  );
  const additionalMounts = (options.additionalMounts ?? []).map(
    normalizeAdditionalMount,
  );
  validateNonOverlappingMounts([
    { kind: "workspace", sandboxPath: workspaceMountPath },
    ...additionalMounts,
  ]);
  const cfcResultDir = optionalNonEmptyString(
    options.cfcResultDir ?? readEnvVar(CFC_RESULT_DIR_ENV),
  );
  const cfcInvocationContextDir = resolveCfcInvocationContextDir(options);
  return {
    dockerBinary: options.dockerBinary ?? DEFAULT_DOCKER_BINARY,
    runtimeName: options.runtimeName ?? DEFAULT_DOCKER_RUNTIME_NAME,
    image: options.image ?? DEFAULT_DOCKER_RUNSC_IMAGE,
    ...(containerUser !== undefined ? { containerUser } : {}),
    workspaceHostPath: options.workspaceHostPath,
    workspaceMountPath,
    shellPath: options.shellPath ?? DEFAULT_SANDBOX_SHELL,
    dockerNetworkMode: options.dockerNetworkMode ??
      parseDockerNetworkMode(readEnvVar(DOCKER_NETWORK_MODE_ENV)) ??
      DEFAULT_DOCKER_NETWORK_MODE,
    additionalMounts,
    extraDockerArgs: options.extraDockerArgs ?? [],
    ...(cfcResultDir !== undefined ? { cfcResultDir } : {}),
    ...(cfcInvocationContextDir !== undefined
      ? { cfcInvocationContextDir }
      : {}),
  };
};

/**
 * In `enforce-*` modes the runtime depends on two trusted sidecar transports:
 *
 *  - `cfcInvocationContextDir` — the harness writes the initial-taint
 *    invocation context the sandbox reads in. Without it the sandbox starts
 *    untainted, so input labels (explicit trusted labels, prior observed
 *    labels) are silently dropped.
 *  - `cfcResultDir` — runsc writes the final-taint result the harness reads
 *    back to mediate output. Without it every command's CFC result is absent
 *    and enforce-mode mediation fail-closes every observation.
 *
 * Both come from `CF_HARNESS_RUNSC_CFC_*` env vars or explicit config and are
 * easy to omit. A run can then claim to enforce while the dangerous half
 * (missing input taint) degrades with no operator-visible signal. The engine
 * calls this at run start (before the first tool executes) so a mis-wired
 * enforce run aborts loudly rather than emitting silent denials mid-run.
 * `disabled`/`observe` impose no such floor.
 *
 * Naming the directories is the half of the floor that can be checked without
 * a Docker daemon. Whether the runtime is registered to read them is the other
 * half, and `cfcTransportReadinessFromDockerRuntimes` below decides it.
 */
export const assertDockerRunscCfcTransportForMode = (
  mode: CfcEnforcementMode,
  config: Pick<
    DockerRunscSandboxConfig,
    "cfcResultDir" | "cfcInvocationContextDir"
  >,
): void => {
  // `disabled` and `observe` do not mediate or deny tool output, so a missing
  // transport cannot silently weaken them; only the enforcing floor requires it.
  if (cfcEnforcementStrictness(mode) < CFC_ENFORCING_STRICTNESS) {
    return;
  }
  const missing: string[] = [];
  if (config.cfcInvocationContextDir === undefined) {
    missing.push(
      `CFC invocation-context transport (set --cfc-invocation-context-dir or ${CFC_INVOCATION_CONTEXT_DIR_ENV})`,
    );
  }
  if (config.cfcResultDir === undefined) {
    missing.push(
      `CFC result transport (set --cfc-result-dir or ${CFC_RESULT_DIR_ENV})`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `cfc enforcement mode '${mode}' requires the runsc sandbox to wire ${
        missing.join(" and ")
      }; refusing to start a run that would silently degrade enforcement`,
    );
  }
};

export const CFC_INVOCATION_CONTEXT_DIR_RUNTIME_FLAG =
  "cfc-invocation-context-dir";
export const CFC_RESULT_DIR_RUNTIME_FLAG = "cfc-result-dir";

/**
 * runsc parses its arguments with Go's `flag` package, which accepts one or
 * two leading dashes and both the `=` and the separate-token spelling.
 */
const runtimeFlagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  // `entries()` rather than an index loop: it yields the element as `string`,
  // so there is no absent-element case to guard that the caller cannot reach —
  // `readRuntimeArgs` has already rejected a table with a non-string in it.
  // Docker does not require a runtime's arguments to be unique, and Go's
  // `flag` parser calls `Value.Set` for every occurrence, so for a string flag
  // the LAST one is what runsc runs with. Returning the first would read a
  // directory the runtime is not using.
  let value: string | undefined;
  for (const [index, arg] of args.entries()) {
    for (const dashes of ["--", "-"]) {
      if (arg.startsWith(`${dashes}${flag}=`)) {
        value = arg.slice(`${dashes}${flag}=`.length);
      } else if (arg === `${dashes}${flag}`) {
        value = args[index + 1];
      }
    }
  }
  return value;
};

const readRuntimeArgs = (
  entry: Record<string, unknown>,
): readonly string[] | "unreadable" => {
  const args = entry.runtimeArgs;
  // Docker omits `runtimeArgs` entirely when a runtime is registered without
  // any, so an absent key is a reading of "no arguments" rather than a failure
  // to read.
  if (args === undefined) {
    return [];
  }
  if (
    !Array.isArray(args) || args.some((arg) => typeof arg !== "string")
  ) {
    return "unreadable";
  }
  return args as readonly string[];
};

const SAFE_RUNTIME_ARGUMENT_CHARACTER = /^[A-Za-z0-9._/=:,-]$/;

/**
 * Returns the first runtime argument containing characters outside the
 * conservative shell-stable allowlist, and each distinct unsafe character.
 */
const unsafeRuntimeArgument = (
  args: readonly string[],
): { argumentIndex: number; unsafeCharacters: string[] } | undefined => {
  for (const [argumentIndex, argument] of args.entries()) {
    const unsafeCharacters = [
      ...new Set(
        [...argument].filter((character) =>
          !SAFE_RUNTIME_ARGUMENT_CHARACTER.test(character)
        ),
      ),
    ];
    if (unsafeCharacters.length > 0) {
      return { argumentIndex, unsafeCharacters };
    }
  }
  return undefined;
};

/**
 * One reading, applied to every configured transport. An unreadable runtime
 * table is a fact about the reading, not about either directory, so it must
 * not be expressed as an absent flag — that would be positive evidence the
 * check never gathered.
 */
export const cfcTransportReadinessIndeterminate = (options: {
  cfcInvocationContextDir?: string;
  cfcResultDir?: string;
  reason: string;
}): CfcTransportReadiness => {
  const readings: Record<string, CfcSidecarTransportReading> = {};
  if (options.cfcInvocationContextDir !== undefined) {
    readings["invocation-context"] = {
      status: "indeterminate",
      reason: options.reason,
    };
  }
  if (options.cfcResultDir !== undefined) {
    readings.result = { status: "indeterminate", reason: options.reason };
  }
  return readings as CfcTransportReadiness;
};

/**
 * Read, from the runtime table `docker info` reports, whether each configured
 * sidecar transport has a valid absolute directory registered for it.
 *
 * This asks whether anything is registered, never whether what is registered
 * is the harness's directory. The second question cannot be answered from two
 * path spellings — see `CfcSidecarTransportReading` — and every way of
 * attacking this check has been an attack on a comparison it no longer makes.
 */
export const cfcTransportReadinessFromDockerRuntimes = (options: {
  runtimeName: string;
  runtimes: unknown;
  cfcInvocationContextDir?: string;
  cfcResultDir?: string;
}): CfcTransportReadiness => {
  const configured: Array<[CfcSidecarTransportKind, string]> = [];
  if (options.cfcInvocationContextDir !== undefined) {
    configured.push([
      "invocation-context",
      CFC_INVOCATION_CONTEXT_DIR_RUNTIME_FLAG,
    ]);
  }
  if (options.cfcResultDir !== undefined) {
    configured.push(["result", CFC_RESULT_DIR_RUNTIME_FLAG]);
  }
  const allIndeterminate = (reason: string): CfcTransportReadiness =>
    cfcTransportReadinessIndeterminate({
      ...(options.cfcInvocationContextDir !== undefined
        ? { cfcInvocationContextDir: options.cfcInvocationContextDir }
        : {}),
      ...(options.cfcResultDir !== undefined
        ? { cfcResultDir: options.cfcResultDir }
        : {}),
      reason,
    });

  if (!isObjectNotArray(options.runtimes)) {
    return allIndeterminate("docker info did not report a runtime table");
  }
  const entry = options.runtimes[options.runtimeName];
  if (entry === undefined) {
    return allIndeterminate(
      `docker runtime '${options.runtimeName}' is not registered on this host`,
    );
  }
  if (!isObjectNotArray(entry)) {
    return allIndeterminate(
      `docker info reported a non-object entry for runtime '${options.runtimeName}'`,
    );
  }
  const args = readRuntimeArgs(entry);
  if (args === "unreadable") {
    return allIndeterminate(
      `docker info reported non-string runtime arguments for '${options.runtimeName}'`,
    );
  }

  const unsafeArgument = unsafeRuntimeArgument(args);
  if (unsafeArgument !== undefined) {
    const readings: Record<string, CfcSidecarTransportReading> = {};
    for (const [kind] of configured) {
      readings[kind] = {
        status: "unsafe-runtime-arguments",
        ...unsafeArgument,
      };
    }
    return readings as CfcTransportReadiness;
  }

  const readings: Record<string, CfcSidecarTransportReading> = {};
  for (const [kind, flag] of configured) {
    const registered = runtimeFlagValue(args, flag);
    // The only question asked, and the only one a reading of the registration
    // can answer: is a valid absolute directory registered for this flag at
    // all. Absent, empty and relative all mean nothing reads anywhere — runsc
    // refuses a non-absolute `--cfc-*-dir` — and that holds whatever
    // filesystem either side resolves paths on. Which directory it names
    // travels with the status rather than being compared with the harness's,
    // because no comparison of two spellings can establish that they are, or
    // are not, one directory.
    readings[kind] = registered !== undefined && registered.startsWith("/")
      ? { status: "registered", registeredPath: registered }
      : { status: "unregistered" };
  }
  return readings as CfcTransportReadiness;
};

/**
 * The prefix Docker Desktop's Linux VM writes in front of a host path in the
 * runtime table it reports, for a path the host itself addresses without one.
 */
const DOCKER_DESKTOP_HOST_PREFIX = "/host_mnt";

/**
 * The host paths a registered runtime's own arguments name for the two CFC
 * sidecar transports, or nothing for a transport the registration leaves out.
 * `runtimes` is what `docker info --format '{{json .Runtimes}}'` reported.
 *
 * This is the question a caller asks when it is about to configure the harness
 * to write those directories, rather than the one
 * `cfcTransportReadinessFromDockerRuntimes` answers about a configuration it
 * already has. So it translates Docker Desktop's `/host_mnt` spelling to the
 * path the host writes at — a translation of one address into another, which
 * is not the comparison of two spellings that readiness declines to make.
 */
export const registeredCfcSidecarHostDirs = (options: {
  runtimeName: string;
  runtimes: unknown;
}): { resultDir?: string; invocationContextDir?: string } => {
  if (!isObjectNotArray(options.runtimes)) {
    return {};
  }
  const entry = options.runtimes[options.runtimeName];
  if (!isObjectNotArray(entry)) {
    return {};
  }
  const args = readRuntimeArgs(entry);
  if (args === "unreadable") {
    return {};
  }
  const hostDir = (flag: string): string | undefined => {
    const registered = runtimeFlagValue(args, flag);
    if (registered === undefined || !registered.startsWith("/")) {
      return undefined;
    }
    return registered.startsWith(`${DOCKER_DESKTOP_HOST_PREFIX}/`)
      ? registered.slice(DOCKER_DESKTOP_HOST_PREFIX.length)
      : registered;
  };
  const resultDir = hostDir(CFC_RESULT_DIR_RUNTIME_FLAG);
  const invocationContextDir = hostDir(
    CFC_INVOCATION_CONTEXT_DIR_RUNTIME_FLAG,
  );
  return {
    ...(resultDir !== undefined ? { resultDir } : {}),
    ...(invocationContextDir !== undefined ? { invocationContextDir } : {}),
  };
};

const byteLength = (text: string): number => textEncoder.encode(text).length;

const appendStderr = (stderr: string, message: string): string =>
  stderr.length > 0
    ? `${stderr}${stderr.endsWith("\n") ? "" : "\n"}${message}`
    : message;

const parseDockerContainerID = (stdout: string): string | undefined => {
  const firstLine = stdout.trim().split(/\s+/)[0];
  return firstLine !== undefined && firstLine.length > 0
    ? firstLine
    : undefined;
};

const cfcSidecarPath = (dir: string, containerID: string): string => {
  if (
    containerID === "" ||
    containerID === "." ||
    containerID === ".." ||
    /[/\\]/.test(containerID)
  ) {
    throw new Error(
      `invalid Docker container ID for CFC sidecar: ${containerID}`,
    );
  }
  return joinHostPath(dir, `${containerID}.json`);
};

const parseDockerWaitExitCode = (stdout: string): number | undefined => {
  const firstLine = stdout.trim().split(/\s+/)[0];
  if (firstLine === undefined || !/^-?\d+$/.test(firstLine)) {
    return undefined;
  }
  const parsed = Number(firstLine);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const observedStream = (
  channel: CfcStreamChannel,
  text: string,
  label: IFCLabel,
) => ({
  channel,
  policy: "observed" as const,
  label,
  segments: text.length === 0
    ? []
    : [{ text, label, offset: 0, byteLength: byteLength(text) }],
});

const opaqueStream = (
  channel: CfcStreamChannel,
  text: string,
  label: IFCLabel,
) => ({
  channel,
  policy: "opaque" as const,
  label,
  byteLength: byteLength(text),
});

const deniedCfcResult = (
  code: string,
  message: string,
  details: Record<string, CfcSandboxJsonValue> = {},
): CfcSandboxResult => ({
  version: 1,
  stdout: {
    channel: "stdout",
    policy: "denied",
    label: {},
    reason: message,
  },
  stderr: {
    channel: "stderr",
    policy: "denied",
    label: {},
    reason: message,
  },
  exitCode: {
    policy: "denied",
    label: {},
    reason: message,
  },
  diagnostics: [{
    level: "error",
    code,
    message,
    details,
  }],
});

const hasNonEmptyXattrValue = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isObjectNotArray(value)) {
    return Object.values(value).some(hasNonEmptyXattrValue);
  }
  return value !== undefined && value !== null;
};

const runscTaintLabel = (taint: RunscCfcLabelSidecar): IFCLabel => {
  const xattr = isObjectNotArray(taint.xattrJSON) ? taint.xattrJSON : {};
  return {
    ...(Array.isArray(xattr.confidentiality)
      ? { confidentiality: xattr.confidentiality }
      : {}),
    ...(Array.isArray(xattr.integrity) ? { integrity: xattr.integrity } : {}),
  };
};

const isPublicRunscTaint = (taint: RunscCfcLabelSidecar): boolean => {
  if (isObjectNotArray(taint.xattrJSON)) {
    return !Object.values(taint.xattrJSON).some(hasNonEmptyXattrValue);
  }
  const stringValue = typeof taint.string === "string"
    ? taint.string.trim()
    : "";
  return stringValue.length === 0 || stringValue === "{}";
};

const cfcResultFromRunscSidecar = (
  parsed: RunscCfcResultSidecar,
  expectedContainerID: string,
  commandResult: SandboxCommandResult,
): CfcSandboxResult => {
  if (parsed.version !== 1) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_version",
      "runsc CFC result sidecar has an unsupported version",
      { containerId: expectedContainerID },
    );
  }
  if (parsed.containerId !== expectedContainerID) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_container_mismatch",
      "runsc CFC result sidecar did not match the Docker container ID",
      {
        expectedContainerId: expectedContainerID,
        actualContainerId: typeof parsed.containerId === "string"
          ? parsed.containerId
          : "",
      },
    );
  }
  if (!isObjectNotArray(parsed.cfcTaint)) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_missing_taint",
      "runsc CFC result sidecar did not include final CFC taint",
      { containerId: expectedContainerID },
    );
  }

  const cfcTaint = parsed.cfcTaint;
  const label = runscTaintLabel(cfcTaint);
  const details: Record<string, CfcSandboxJsonValue> = {
    containerId: expectedContainerID,
  };
  if (typeof parsed.sandboxId === "string") {
    details.sandboxId = parsed.sandboxId;
  }
  if (typeof parsed.waitStatus === "number") {
    details.waitStatus = parsed.waitStatus;
  }
  if (typeof cfcTaint.string === "string") {
    details.runscTaint = cfcTaint.string;
  }
  if (cfcTaint.xattrJSON !== undefined) {
    details.runscTaintXattrJSON = cfcTaint.xattrJSON as CfcSandboxJsonValue;
  }

  if (isPublicRunscTaint(cfcTaint)) {
    return {
      version: 1,
      stdout: observedStream("stdout", commandResult.stdout, label),
      stderr: observedStream("stderr", commandResult.stderr, label),
      exitCode: {
        policy: "observed",
        label,
        value: commandResult.exitCode,
      },
      diagnostics: [{
        level: "info",
        code: "runsc_cfc_result",
        message: "runsc reported final CFC taint for sandbox output",
        label,
        details,
      }],
    };
  }

  return {
    version: 1,
    stdout: opaqueStream("stdout", commandResult.stdout, label),
    stderr: opaqueStream("stderr", commandResult.stderr, label),
    exitCode: {
      policy: "opaque",
      label,
    },
    diagnostics: [{
      level: "info",
      code: "runsc_cfc_result",
      message:
        "runsc reported tainted sandbox output; raw streams are withheld from model context",
      label,
      details,
    }],
  };
};

export class DockerRunscSandboxRuntime implements SandboxRuntime {
  #cfcTransportReadiness?: CfcTransportReadiness;

  /**
   * Copy of `config.cfcInvocationContextDir`, taken once here and read from
   * here afterwards. `config` is public, its `readonly` binds the reference
   * rather than the fields, and `readonly` is a compile-time annotation that
   * is erased before runtime — so it cannot stop a JavaScript caller, a cast,
   * or `any`. The probe memoizes a verdict about this directory and
   * `#cfcResultDir`, and a verdict must not outlive the evidence that
   * produced it; copying the values is what makes the directories unable to
   * move out from under it, rather than asking a type to be respected.
   */
  readonly #cfcInvocationContextDir?: string;

  /** Copy of `config.cfcResultDir`, for the same reason. */
  readonly #cfcResultDir?: string;

  /**
   * The effective Docker runtime name: a `--runtime` in `extraDockerArgs`
   * when present, otherwise `config.runtimeName`. The registration reading is
   * about a named runtime reached through a named binary, so those identify
   * the verdict as much as the directories do. Held for the same reason as
   * `#cfcInvocationContextDir` and used on every path that either probes or
   * launches, so the runtime a verdict describes is the runtime that runs.
   */
  readonly #runtimeName: string;

  /** Copy of `config.dockerBinary`, for the same reason as `#runtimeName`. */
  readonly #dockerBinary: string;

  readonly #extraDockerArgs: readonly string[];
  readonly #runner: ProcessRunner;

  constructor(
    readonly config: DockerRunscSandboxConfig,
    runner: ProcessRunner = new DenoProcessRunner(),
  ) {
    this.#cfcInvocationContextDir = config.cfcInvocationContextDir;
    this.#cfcResultDir = config.cfcResultDir;
    this.#dockerBinary = config.dockerBinary;
    this.#extraDockerArgs = [...config.extraDockerArgs];
    this.#runner = runner;
    // `extraDockerArgs` is appended after `--runtime` on the create command
    // line, and Docker takes the last occurrence of a non-repeatable flag, so
    // a `--runtime` in there is what the container actually runs under. The
    // effective name is resolved once and used for both the registration
    // reading and the launch, so the runtime a verdict describes cannot differ
    // from the runtime that runs.
    this.#runtimeName = runtimeFlagValue(this.#extraDockerArgs, "runtime") ??
      config.runtimeName;
  }

  /**
   * The invocation transport's own reading, never the pair's summary. The two
   * transports are registered independently and can disagree, so a consumer
   * asking about input taint must not be answered with a verdict the result
   * transport contributed to.
   */
  #invocationContextReading(): CfcSidecarTransportReading | undefined {
    return this.#cfcTransportReadiness?.["invocation-context"];
  }

  /**
   * Read the registered arguments of the Docker runtime this sandbox launches
   * and report whether they name the sidecar directories the harness is
   * configured with.
   *
   * Taken afresh on every call rather than memoized. Docker reloads its
   * `runtimes` configuration on SIGHUP, so a registration can be replaced
   * mid-run — and a cached reading does not merely weaken the affirmative
   * half, it suppresses the negative one: an invocation held against a stale
   * `registered` never meets the `unregistered` a current read would have
   * returned, which is the refusal this whole check exists to make. One `docker info`
   * against a call that is about to create, start, wait on and remove a
   * container is not a cost worth a stale refusal.
   *
   * The last reading is retained so `describe()` can report what the run
   * started with.
   */
  async probeCfcTransportReadiness(): Promise<CfcTransportReadiness> {
    const readiness = await this.#readCfcTransportReadiness();
    this.#cfcTransportReadiness = readiness;
    return readiness;
  }

  async #readCfcTransportReadiness(): Promise<CfcTransportReadiness> {
    const unreadable = (reason: string): CfcTransportReadiness =>
      cfcTransportReadinessIndeterminate({
        ...this.#configuredTransportDirs(),
        reason,
      });
    const result = await readDockerRuntimes(this.#dockerBinary, this.#runner);
    if (result.unreadable !== undefined) return unreadable(result.unreadable);
    return cfcTransportReadinessFromDockerRuntimes({
      runtimeName: this.#runtimeName,
      runtimes: result.runtimes,
      ...this.#configuredTransportDirs(),
    });
  }

  #configuredTransportDirs(): {
    cfcInvocationContextDir?: string;
    cfcResultDir?: string;
  } {
    return {
      ...(this.#cfcInvocationContextDir !== undefined
        ? { cfcInvocationContextDir: this.#cfcInvocationContextDir }
        : {}),
      ...(this.#cfcResultDir !== undefined
        ? { cfcResultDir: this.#cfcResultDir }
        : {}),
    };
  }

  defaultWorkingDirectory(): string {
    return normalizeWorkspacePath(this.config.workspaceMountPath);
  }

  #mounts(): Array<{
    kind: SandboxRuntimeMountDescription["kind"];
    name?: string;
    hostPath: string;
    sandboxPath: string;
    readOnly: boolean;
  }> {
    return [
      {
        kind: "workspace",
        hostPath: this.config.workspaceHostPath,
        sandboxPath: this.config.workspaceMountPath,
        readOnly: false,
      },
      ...this.config.additionalMounts,
    ];
  }

  #mountDescriptions(): SandboxRuntimeMountDescription[] {
    return this.#mounts().map((mount) => ({
      kind: mount.kind,
      ...(mount.kind === "host-bind" ? { name: mount.name } : {}),
      hostPath: mount.hostPath,
      sandboxPath: mount.sandboxPath,
      readOnly: mount.readOnly,
      ...(mount.kind === "host-bind"
        ? { mode: mount.readOnly ? "readonly" as const : "writable" as const }
        : {}),
    }));
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: {
        runtimeRequested: true,
        runtimeName: this.#runtimeName,
        image: this.config.image,
        workspaceMountPath: this.config.workspaceMountPath,
        mounts: this.#mountDescriptions(),
        networkMode: this.config.dockerNetworkMode,
        extraDockerArgsCount: this.#extraDockerArgs.length,
        ...(this.#cfcInvocationContextDir !== undefined
          ? {
            invocationContextTransport: "sidecar",
            // Naming the directory says where the harness writes, not that
            // anything reads there. Until a probe has read the runtime's
            // registration this snapshot must say so rather than let the
            // transport tag stand in for a working one.
            invocationContextTransportReadiness:
              this.#invocationContextReading()?.status ?? "unverified",
            invocationContextConfiguredPath: this.#cfcInvocationContextDir,
            ...(this.#invocationContextReading()?.status === "registered"
              ? {
                invocationContextRegisteredPath:
                  (this.#invocationContextReading() as {
                    registeredPath: string;
                  }).registeredPath,
              }
              : {}),
          }
          : {}),
      },
    };
  }

  isPathWithinWorkspace(path: string): boolean {
    return isWithinRoot(this.config.workspaceMountPath, path);
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.#mounts().some((mount) =>
      isWithinRoot(mount.sandboxPath, path)
    );
  }

  resolvePath(path: string, cwd?: string): string {
    const normalized = isAbsoluteSandboxPath(path)
      ? normalize(path)
      : normalize(joinSandboxPath(cwd ?? this.defaultWorkingDirectory(), path));
    if (!this.isPathWithinAllowedRoots(normalized)) {
      const rootLabel = this.config.additionalMounts.length === 0
        ? "workspace root"
        : "allowed sandbox roots";
      throw new SandboxPathEscapeError(
        path,
        `path escapes ${rootLabel}: ${path}`,
      );
    }
    return normalized;
  }

  async run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    const createArgs = [
      "create",
      ...(request.stdinText !== undefined ? ["-i"] : []),
      "--runtime",
      this.#runtimeName,
      "--network",
      this.config.dockerNetworkMode,
      ...(this.config.containerUser !== undefined
        ? ["--user", this.config.containerUser]
        : []),
      ...this.#mounts().flatMap((mount) => ["--mount", dockerMountArg(mount)]),
      "-w",
      request.cwd
        ? this.resolvePath(request.cwd)
        : this.defaultWorkingDirectory(),
      ...Object.entries(request.env ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      ...this.#extraDockerArgs,
      this.config.image,
      ...request.argv,
    ];
    const createResult = await this.#runner.run({
      command: this.#dockerBinary,
      args: createArgs,
    });
    if (createResult.exitCode !== 0) {
      return createResult;
    }
    const containerID = parseDockerContainerID(createResult.stdout);
    if (containerID === undefined) {
      return {
        stdout: createResult.stdout,
        stderr: appendStderr(
          createResult.stderr,
          "docker create did not return a container ID",
        ),
        exitCode: 125,
      };
    }

    try {
      const sidecarFailure = await this.#writeCfcInvocationContextSidecar(
        containerID,
        request,
        createResult,
      );
      if (sidecarFailure !== undefined) {
        return sidecarFailure;
      }
      const startResult = await this.#runner.run({
        command: this.#dockerBinary,
        args: [
          "start",
          "--attach",
          ...(request.stdinText !== undefined ? ["--interactive"] : []),
          containerID,
        ],
        stdinText: request.stdinText,
        timeoutMs: request.timeoutMs,
      });
      const waitResult = await this.#runner.run({
        command: this.#dockerBinary,
        args: ["wait", containerID],
      });
      const exitCode = parseDockerWaitExitCode(waitResult.stdout) ??
        startResult.exitCode;
      const commandResult: SandboxCommandResult = {
        stdout: startResult.stdout,
        stderr: waitResult.exitCode === 0
          ? startResult.stderr
          : appendStderr(startResult.stderr, waitResult.stderr),
        exitCode,
      };
      const cfcResult = await this.#readCfcResultSidecar(
        containerID,
        commandResult,
      );
      return cfcResult === undefined
        ? commandResult
        : { ...commandResult, cfcResult };
    } finally {
      await this.#runner.run({
        command: this.#dockerBinary,
        args: ["rm", "-f", containerID],
      });
    }
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return this.run({
      argv: [
        this.config.shellPath,
        "-lc",
        request.command,
        this.config.shellPath,
        ...(request.args ?? []),
      ],
      cwd: request.cwd,
      env: request.env,
      stdinText: request.stdinText,
      timeoutMs: request.timeoutMs,
      cfcInvocationContext: request.cfcInvocationContext,
    });
  }

  async #readCfcResultSidecar(
    containerID: string,
    commandResult: SandboxCommandResult,
  ): Promise<CfcSandboxResult | undefined> {
    if (this.#cfcResultDir === undefined) {
      return undefined;
    }
    let sidecarPath: string;
    try {
      sidecarPath = cfcSidecarPath(this.#cfcResultDir, containerID);
    } catch (error) {
      return deniedCfcResult(
        "runsc_cfc_sidecar_container_id",
        "runsc CFC sidecar path could not be derived from the Docker container ID",
        {
          containerId: containerID,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    let text: string;
    try {
      text = await Deno.readTextFile(sidecarPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return undefined;
      }
      return deniedCfcResult(
        "runsc_cfc_sidecar_read_error",
        "failed to read runsc CFC result sidecar",
        {
          containerId: containerID,
          sidecarPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    try {
      const parsed = JSON.parse(text) as RunscCfcResultSidecar;
      return cfcResultFromRunscSidecar(parsed, containerID, commandResult);
    } catch (error) {
      return deniedCfcResult(
        "runsc_cfc_sidecar_parse_error",
        "failed to parse runsc CFC result sidecar",
        {
          containerId: containerID,
          sidecarPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Refuse an enforcing invocation whose input labels would be written into a
   * directory the runtime is not registered to read.
   *
   * This half of the CFC sidecar pair fails open: nothing downstream notices
   * that the sandbox started untainted, so the run goes on reporting the
   * enforcement posture it printed at startup while dropping every input
   * label it was handed. Refusing here states the condition once, at the call
   * it actually affects, instead of leaving it to be inferred from an output
   * mediation denial that has a different cause.
   *
   * An absent registration and a shell-unsafe argument list refuse for
   * distinct reasons. A host whose registration could not be read is
   * `indeterminate` and runs, so that an unreadable `docker info` cannot
   * masquerade as evidence of a misconfiguration.
   */
  async #refuseUnreadCfcInvocationContext(
    context: HarnessCfcInvocationContext,
    createResult: SandboxCommandResult,
    dir: string | undefined,
  ): Promise<SandboxCommandResult | undefined> {
    const refuse = (detail: string): SandboxCommandResult => ({
      stdout: createResult.stdout,
      stderr: appendStderr(
        createResult.stderr,
        `refusing to start a container under cfc enforcement mode '${context.cfcEnforcementMode}': ${detail}`,
      ),
      exitCode: 125,
    });
    if (
      cfcEnforcementStrictness(context.cfcEnforcementMode) <
        CFC_ENFORCING_STRICTNESS
    ) {
      return undefined;
    }
    // `assertDockerRunscCfcTransportForMode` already refuses an unconfigured
    // transport at run start, but it guards the engine's entry rather than
    // this one, and a runtime constructed directly reaches here with the same
    // labels and no guard behind it.
    if (dir === undefined) {
      return refuse(
        `no CFC invocation-context directory is configured, so this invocation's ` +
          `CFC input labels have nowhere to be read from`,
      );
    }
    await this.probeCfcTransportReadiness();
    const reading = this.#invocationContextReading();
    // Moby places `runtimeArgs` in a generated shell wrapper, so the shell
    // parses these strings before runsc parses its flags and their meaning can
    // diverge between this check and runsc. The check deliberately trusts only
    // a conservative allowlist (CT-2137). A legitimate directory containing a
    // space or another excluded character is therefore refused; renaming that
    // directory to use allowlisted characters is the remedy.
    if (reading?.status === "unsafe-runtime-arguments") {
      return refuse(
        `the '${this.#runtimeName}' docker runtime argument at index ` +
          `${reading.argumentIndex} contains unsafe characters: ` +
          `${
            JSON.stringify(reading.unsafeCharacters)
          }; refusing to trust its ` +
          `shell-parsed CFC transport registration`,
      );
    }
    if (reading?.status !== "unregistered") {
      return undefined;
    }
    return refuse(
      `the '${this.#runtimeName}' docker runtime is not registered with ` +
        `--${CFC_INVOCATION_CONTEXT_DIR_RUNTIME_FLAG}=${dir}, so this invocation's ` +
        `CFC input labels would be written and never read`,
    );
  }

  async #writeCfcInvocationContextSidecar(
    containerID: string,
    request: SandboxCommandRequest,
    createResult: SandboxCommandResult,
  ): Promise<SandboxCommandResult | undefined> {
    const context = request.cfcInvocationContext;
    if (context === undefined) {
      return undefined;
    }
    const dir = this.#cfcInvocationContextDir;
    const refusal = await this.#refuseUnreadCfcInvocationContext(
      context,
      createResult,
      dir,
    );
    if (refusal !== undefined) {
      return refusal;
    }
    if (dir === undefined) {
      return undefined;
    }
    try {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        cfcSidecarPath(dir, containerID),
        `${JSON.stringify(request.cfcInvocationContext, null, 2)}\n`,
      );
      return undefined;
    } catch (error) {
      return {
        stdout: createResult.stdout,
        stderr: appendStderr(
          createResult.stderr,
          `failed to write CFC invocation context sidecar: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
        exitCode: 125,
      };
    }
  }
}
