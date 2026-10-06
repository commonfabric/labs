import {
  isAbsolute as isAbsoluteHostPath,
  join as joinHostPath,
  normalize as normalizeHostPath,
} from "@std/path";
import {
  isAbsolute as isAbsoluteSandboxPath,
  join as joinSandboxPath,
  normalize,
} from "@std/path/posix";

import type {
  CfcEnforcementMode,
  CfcSandboxResult,
} from "@commonfabric/runner/cfc";
import {
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
} from "@commonfabric/runner/cfc";

import { SandboxPathEscapeError } from "./errors.ts";
import {
  DenoProcessRunner,
  type ProcessHandle,
  type ProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "./process-runner.ts";
import {
  cfcResultFromRunscSidecar,
  deniedCfcResult,
  type RunscCfcResultSidecar,
} from "./runsc-cfc-result.ts";
import {
  type DockerRunscAdditionalMount,
  type DockerRunscAdditionalMountConfig,
  SANDBOX_RUNTIME_ENV,
  SANDBOX_SESSION_NAME_PATTERN,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxPlatform,
  type SandboxRuntime,
  type SandboxRuntimeChoice,
  type SandboxRuntimeDescription,
  type SandboxRuntimeMountDescription,
  sandboxSessionsAllowedUnder,
  SandboxSessionUnavailableError,
  type SandboxShellRequest,
} from "./types.ts";

/**
 * The direct runsc sandbox: cf-harness writes an OCI bundle and runs `runsc`
 * itself, with no Docker between them. The same driver runs on Linux against
 * the linux runsc and on macOS against the darwin runsc, which forwards the
 * identical command line into its VM.
 *
 * Two shapes of call:
 *
 * - No session: one container per call. `runsc run` with the command as the
 *   container's init process; the CFC invocation context goes in on an
 *   inherited descriptor and the trusted result comes out on another, so no
 *   directory is registered anywhere and nothing is keyed by container id.
 *   About a hundred milliseconds of sandbox boot per call.
 * - A session: one long-lived container per (run, session name), started on
 *   first use as an attached `runsc run` child of this process and driven
 *   with `runsc exec` per call at about ten milliseconds. Its init reads a
 *   stdin pipe this process holds open, so the container ends when the
 *   harness does, a SIGKILL included. Sessions never share a sandbox: each
 *   gets a container id minted here, fixed in width, so no id is a prefix
 *   of another (runsc resolves abbreviated ids).
 *
 * Sessions and CFC. A session call carries its own invocation context in on
 * fd 3 and gets a result out on fd 4, but that result is NOT a sound basis
 * for enforcement, and sessions are refused in enforcing modes:
 *
 * - the result is a snapshot taken when the exec'd process exits, while the
 *   call's output keeps draining and the session's background processes
 *   keep running, so labelled data can reach the output after a public
 *   result was computed (review, verified live);
 * - processes in one container share its PID namespace and tmpfs, and
 *   taint does not travel through metadata such as `/proc/<pid>/environ`
 *   or directory names, so one call can read what another call learned;
 * - once a tainted write reaches a sink in the container, every later
 *   result in that session carries the taint.
 *
 * In observe mode the result is reported for what it is, an observation.
 */

export const DEFAULT_RUNSC_BINARY = "runsc";
export const DEFAULT_RUNSC_WORKSPACE_MOUNT_PATH = "/workspace";
export const DEFAULT_RUNSC_SHELL = "/bin/sh";
/**
 * The docker runtime defaults to `--network bridge`; this is the runsc
 * spelling of the same posture (runsc's own netstack, which the darwin runsc
 * runs as the VM's network), so a run that names no network mode has the
 * same reach on either runtime. A lane that wants isolation says so, as the
 * docker lanes do, through `CF_HARNESS_DOCKER_NETWORK_MODE=none`.
 */
export const DEFAULT_RUNSC_NETWORK_MODE: RunscNetworkMode = "sandbox";
export const DEFAULT_RUNSC_FABRIC_MOUNT_PATH = "/fabric";
/**
 * Sessions live in memory: the rootfs overlay and `/tmp` of every session
 * come out of the one VM (or host) every run on the machine shares. Both
 * are bounded; a call past the session bound is refused recoverably.
 */
export const RUNSC_MAX_SESSIONS = 8;
export const RUNSC_TMPFS_SIZE = "512m";
/** How long a runsc control command (state, kill, delete) may take. */
export const RUNSC_CONTROL_TIMEOUT_MS = 15_000;
export const RUNSC_ROOTFS_ENV = "CF_HARNESS_SANDBOX_ROOTFS";
export const RUNSC_CFC_POLICY_ENV = "CF_HARNESS_RUNSC_CFC_POLICY";
export const RUNSC_BINARY_ENV = "CF_HARNESS_RUNSC_BINARY";

/**
 * The store the macOS runsc keeps its VM, images and daemon in when
 * `CFC_VM_HOME` does not name another.
 */
export const defaultDarwinCfcVmStore = (home: string): string =>
  joinHostPath(home, "Library", "Application Support", "cfc-vm");

/**
 * The store the macOS runsc uses, named the way it names one: `cfcVmHome`,
 * the value of `CFC_VM_HOME`, where that is set and not empty, and otherwise
 * the default store under `home`. `undefined` where neither names one.
 */
export const darwinCfcVmStore = (
  cfcVmHome: string | undefined,
  home: string | undefined,
): string | undefined =>
  cfcVmHome !== undefined && cfcVmHome !== ""
    ? cfcVmHome
    : home !== undefined && home !== ""
    ? defaultDarwinCfcVmStore(home)
    : undefined;

/** The image a macOS runsc store unpacks when it is installed, by its key. */
export const DARWIN_CFC_VM_IMAGE_KEY = "kitchensink";

/**
 * Where the macOS runsc `store` keeps the marker a bundle names as rootfs to
 * run from the block image `imageKey`.
 */
export const darwinCfcVmRootfs = (
  store: string,
  imageKey = DARWIN_CFC_VM_IMAGE_KEY,
): string => joinHostPath(store, "images", imageKey);

/** Like `darwinCfcVmRootfs()`, except in the store under `home`. */
export const defaultDarwinRootfs = (
  home: string,
  imageKey = DARWIN_CFC_VM_IMAGE_KEY,
): string => darwinCfcVmRootfs(defaultDarwinCfcVmStore(home), imageKey);

export type RunscNetworkMode = "none" | "sandbox" | "host";

export interface RunscSandboxConfig {
  /**
   * The runsc binary every command of the runtime executes, as the canonical
   * absolute path {@link canonicalHostPath} returns.
   */
  runscBinary: string;

  /**
   * The rootfs the bundle names, as a canonical absolute path. On Linux a
   * directory; on macOS the `<store>/images/<key>` marker the darwin runsc
   * maps to a block image.
   */
  rootfs: string;

  workspaceHostPath: string;
  workspaceMountPath: string;
  shellPath: string;
  networkMode: RunscNetworkMode;
  additionalMounts: readonly DockerRunscAdditionalMount[];
  /** Global runsc flags placed before the subcommand, verbatim. */
  extraRunscArgs: readonly string[];
  /**
   * CFC policy file, as a canonical absolute path; `--cfc` is passed exactly
   * when this is set.
   */
  cfcPolicyPath?: string;
  /** Host directory for bundles, contexts and results; private to the run. */
  scratchDir: string;
  /**
   * Set when `scratchDir` is the default: its parent, which the runtime
   * creates 0700 when absent and verifies is this user's and private before
   * first use.
   */
  scratchParentToVerify?: string;
  /** Distinguishes this run's sessions from every other run's. */
  runId: string;
  containerUser?: string;
  /** How long a session's container may take to report running. */
  sessionStartTimeoutMs: number;
}

export interface ResolveRunscSandboxConfigOptions {
  /**
   * The runsc binary: an absolute path, a path relative to the working
   * directory of this process, or a bare name to find on `PATH`. Default
   * {@link DEFAULT_RUNSC_BINARY}.
   */
  runscBinary?: string;

  rootfs?: string;
  workspaceHostPath: string;
  workspaceMountPath?: string;
  shellPath?: string;
  networkMode?: RunscNetworkMode;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  extraRunscArgs?: readonly string[];
  cfcPolicyPath?: string;
  scratchDir?: string;
  runId?: string;
  containerUser?: string;
  homeDir?: string;
  platform?: SandboxPlatform;
  sessionStartTimeoutMs?: number;

  /**
   * How the entrypoint selected this runtime, where it derived a selection.
   * A refusal of a runtime nobody named says so, and how Docker is selected.
   */
  selection?: SandboxRuntimeChoice;
}

const normalizeSandboxRoot = (path: string): string => {
  const normalized = normalize(path);
  return normalized !== "/" && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const isWithinRoot = (root: string, path: string): boolean => {
  const normalizedRoot = normalizeSandboxRoot(root);
  const normalizedPath = normalizeSandboxRoot(path);
  return normalizedRoot === "/" || normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
};

const requireAbsoluteHostPath = (label: string, path: string): string => {
  if (!isAbsoluteHostPath(path)) {
    throw new Error(`${label} must be an absolute host path: ${path}`);
  }
  return path;
};

const requireAbsoluteSandboxPath = (label: string, path: string): string => {
  if (!isAbsoluteSandboxPath(path)) {
    throw new Error(`${label} must be an absolute sandbox path: ${path}`);
  }
  const normalized = normalizeSandboxRoot(path);
  if (normalized === "/") {
    // A root at `/` contains every path, so every containment check the
    // tools make against the mounts would pass.
    throw new Error(`${label} must not be the sandbox root: ${path}`);
  }
  return normalized;
};

const resolveAdditionalMounts = (
  configs: readonly DockerRunscAdditionalMountConfig[],
): DockerRunscAdditionalMount[] =>
  configs.map((mount) => {
    if (mount.kind === "fabric-fuse") {
      return {
        kind: "fabric-fuse",
        hostPath: requireAbsoluteHostPath(
          "fabric mount host path",
          mount.hostPath,
        ),
        sandboxPath: requireAbsoluteSandboxPath(
          "fabric mount sandbox path",
          mount.sandboxPath ?? DEFAULT_RUNSC_FABRIC_MOUNT_PATH,
        ),
        // The docker runtime's default, so `/fabric` is writable or not on
        // both runtimes alike.
        readOnly: mount.readOnly ?? false,
      };
    }
    if (mount.name.trim() === "") {
      throw new Error("host bind mount name must be non-empty");
    }
    return {
      kind: "host-bind",
      name: mount.name,
      hostPath: requireAbsoluteHostPath(
        `host bind ${mount.name} host path`,
        mount.hostPath,
      ),
      sandboxPath: requireAbsoluteSandboxPath(
        `host bind ${mount.name} sandbox path`,
        mount.sandboxPath,
      ),
      readOnly: mount.readOnly ?? true,
    };
  });

/**
 * How many symbolic links one path may lead through. A path that leads
 * through more is taken to loop, as the kernel takes it.
 */
const MAX_SYMBOLIC_LINKS = 40;

/** One name of a path being walked. */
interface PathPart {
  name: string;

  /** Whether the name was read out of a symbolic link's target. */
  fromLink: boolean;
}

/** Helper for `canonicalHostPath()`, which splits `path` into its names. */
const pathParts = (path: string, fromLink: boolean): PathPart[] =>
  path.split("/").filter((name) => name !== "").map((name) => ({
    name,
    fromLink,
  }));

/** Returns what `error` says of itself, for a message that passes it on. */
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Returns the path the filesystem takes the absolute host path `path` to: a
 * path with no symbolic link, no `.` and no `..` in it. `label` names the
 * path in a refusal.
 *
 * The result is read off the filesystem one name at a time, in the order the
 * kernel resolves them: a symbolic link is followed where it stands, and a
 * `..` leaves the directory the names before it led to, which is not the
 * directory their spelling suggests once one of them is a link. A path that
 * does not exist yet is the real path of its nearest existing ancestor with
 * the remaining names appended.
 *
 * The result describes the filesystem at the time of the call. Whoever can
 * write a directory the result names can make the same path lead elsewhere
 * afterwards, so the result is worth exactly as much as those directories
 * are out of an adversary's reach.
 *
 * @throws When where the path leads cannot be told: a name on the way is a
 * symbolic link whose target does not exist, a name cannot be examined for
 * any reason but not existing, the path leads through more than
 * {@link MAX_SYMBOLIC_LINKS} links, or a `.` or `..` follows a name that does
 * not exist.
 */
export const canonicalHostPath = (label: string, path: string): string => {
  requireAbsoluteHostPath(label, path);
  const refuse = (why: string): never => {
    throw new Error(`${label} ${path} ${why}`);
  };
  // `reached` holds no link and no dot name, so handing it to Deno, which
  // folds `..` out of a spelling before the kernel sees it, changes nothing.
  let reached = "/";
  let reachedDirectory = true;
  let links = 0;
  let pending = pathParts(path, false);
  let rest: string[] = [];
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part.name === "." || part.name === "..") {
      if (!reachedDirectory) {
        refuse(`cannot be resolved: ${reached} is not a directory`);
      }
      if (part.name === "..") reached = dirnameHost(reached);
      continue;
    }
    const next = joinHostPath(reached, part.name);
    let info: Deno.FileInfo;
    try {
      info = Deno.lstatSync(next);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        refuse(
          `cannot be resolved: ${next} could not be examined (${
            errorText(error)
          })`,
        );
      }
      if (part.fromLink) {
        refuse(
          `leads through a symbolic link whose target does not exist (${next})`,
        );
      }
      rest = [part, ...pending].map((p) => p.name);
      if (rest.some((name) => name === "." || name === "..")) {
        refuse(
          `cannot be resolved: ${next} does not exist, and a \`.\` or \`..\` follows it`,
        );
      }
      break;
    }
    if (!info.isSymlink) {
      reached = next;
      reachedDirectory = info.isDirectory;
      continue;
    }
    links += 1;
    if (links > MAX_SYMBOLIC_LINKS) {
      refuse(
        `cannot be resolved: it leads through more than ${MAX_SYMBOLIC_LINKS} symbolic links`,
      );
    }
    let target: string;
    try {
      target = Deno.readLinkSync(next);
    } catch (error) {
      target = refuse(
        `cannot be resolved: the symbolic link ${next} could not be read (${
          errorText(error)
        })`,
      );
    }
    if (target === "") {
      refuse(
        `leads through a symbolic link whose target does not exist (${next})`,
      );
    }
    if (target.startsWith("/")) reached = "/";
    pending = [...pathParts(target, true), ...pending];
  }
  let real: string;
  try {
    // For what the walk cannot see: the case a case-insensitive volume
    // stores a name in.
    real = Deno.realPathSync(reached);
  } catch (error) {
    real = refuse(
      `cannot be resolved: ${reached} could not be examined (${
        errorText(error)
      })`,
    );
  }
  return rest.length === 0 ? real : joinHostPath(real, ...rest);
};

/**
 * Helper for `resolveRunscBinary()`, which finds the file a bare `name` leads
 * to on `searchPath` and returns its canonical path, or `undefined` when no
 * entry holds one. The file is the one in the first entry, in order, holding
 * an executable file of that name. An empty or relative entry is a directory
 * under `cwd()`. An entry that cannot be looked into is passed over, as it is
 * when the system runs a bare name.
 */
const findOnSearchPath = (
  name: string,
  searchPath: string,
  cwd: () => string,
): string | undefined => {
  for (const entry of searchPath.split(":")) {
    const directory = entry === ""
      ? cwd()
      : isAbsoluteHostPath(entry)
      ? entry
      : `${cwd()}/${entry}`;
    try {
      const candidate = canonicalHostPath(name, `${directory}/${name}`);
      const info = Deno.statSync(candidate);
      if (info.isFile && (info.mode === null || (info.mode & 0o111) !== 0)) {
        return candidate;
      }
    } catch {
      // Not in this entry.
    }
  }
  return undefined;
};

/**
 * Returns the canonical path of the runsc binary `given` names, resolved the
 * way running it would resolve it: a bare name through `PATH`, a relative
 * path against the working directory of this process.
 *
 * @throws When `given` opens with `~`, which nothing between here and the
 * kernel expands; when no `PATH` entry holds an executable of a bare name;
 * and when {@link canonicalHostPath} does.
 */
const resolveRunscBinary = (given: string): string => {
  const label = "runsc binary";
  if (given === "") {
    throw new Error(`${label} must not be empty: give an absolute path`);
  }
  if (given.startsWith("~")) {
    throw new Error(
      `${label} ${given} opens with \`~\`, which is not expanded here: give an absolute path`,
    );
  }
  if (isAbsoluteHostPath(given)) return canonicalHostPath(label, given);
  const cwd = (): string => {
    try {
      return Deno.cwd();
    } catch (error) {
      throw new Error(
        `${label} ${given} cannot be resolved: the working directory could not be read (${
          errorText(error)
        }); give an absolute path`,
      );
    }
  };
  if (given.includes("/")) {
    return canonicalHostPath(label, `${cwd()}/${given}`);
  }
  const searchPath = Deno.env.get("PATH");
  const found = searchPath === undefined
    ? undefined
    : findOnSearchPath(given, searchPath, cwd);
  if (found === undefined) {
    throw new Error(
      `${label} ${given} was not found: no directory on \`PATH\` (${
        searchPath ?? "which is not set"
      }) holds an executable file of that name; give an absolute path, or set ${RUNSC_BINARY_ENV} to one`,
    );
  }
  return found;
};

/**
 * Resolves the settings of a direct runsc sandbox, refusing those that would
 * put what the sandbox is trusted on within the sandbox's reach.
 *
 * The runsc binary, the CFC policy and the rootfs are each resolved once,
 * here, to a canonical path. That path is what is compared with the mounts,
 * what the returned configuration holds, and so what every later use names.
 * One of them that does not exist is accepted, as the path it will have under
 * its nearest existing ancestor: no writable mount holds that ancestor, so
 * what later appears there was not put there from a sandbox.
 *
 * @throws When a setting is malformed, when two sandbox roots overlap, when
 * the scratch directory lies inside a mount, when the binary, the policy or
 * the rootfs lies inside a writable mount, and when {@link canonicalHostPath}
 * cannot tell where one of those paths, or a mount, leads.
 */
export const resolveRunscSandboxConfig = (
  options: ResolveRunscSandboxConfigOptions,
): RunscSandboxConfig => {
  const platform = options.platform ?? Deno.build.os;
  const rootfs = options.rootfs ??
    (platform === "darwin" && options.homeDir !== undefined
      ? defaultDarwinRootfs(options.homeDir)
      : undefined);
  if (rootfs === undefined) {
    throw new Error(
      `runsc sandbox needs a rootfs: pass --sandbox-rootfs or set ${RUNSC_ROOTFS_ENV} (on macOS the default is the cfc-vm kitchensink image)`,
    );
  }
  const workspaceMountPath = requireAbsoluteSandboxPath(
    "workspace mount path",
    options.workspaceMountPath ?? DEFAULT_RUNSC_WORKSPACE_MOUNT_PATH,
  );
  const additionalMounts = resolveAdditionalMounts(
    options.additionalMounts ?? [],
  );
  const roots = [
    workspaceMountPath,
    ...additionalMounts.map((m) => m.sandboxPath),
  ];
  // By index, so two mounts at the very same path are an overlap too: the
  // later bind would shadow the earlier one while the description still
  // reported both.
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const a = roots[i]!;
      const b = roots[j]!;
      if (isWithinRoot(a, b) || isWithinRoot(b, a)) {
        throw new Error(`sandbox roots overlap: ${a} and ${b}`);
      }
    }
  }
  if (
    options.containerUser !== undefined &&
    !/^\d+(:\d+)?$/.test(options.containerUser)
  ) {
    // A name would reach the spec as NaN and run the container as root.
    throw new Error(
      `container user must be numeric uid or uid:gid: ${options.containerUser}`,
    );
  }
  const runId = options.runId ?? crypto.randomUUID();
  const workspaceHostPath = requireAbsoluteHostPath(
    "workspace host path",
    options.workspaceHostPath,
  );
  // Scratch holds the bundle, the invocation context and the CFC result
  // for every call. It is host-private, OUTSIDE every sandbox mount: a
  // sandbox that could reach the result file could rewrite it before the
  // harness reads it and forge a public taint over its own output (review,
  // verified live). The default is the user's temp dir; an explicit scratch
  // is refused when it lies inside a mount.
  // The directory name carries a readable slice of the run id and a nonce:
  // the sanitizer truncates, and sibling subagent ids (`<uuid>.subagent.N`)
  // agree on their first 40 characters.
  // The default's parent is a fixed name under the temp dir. Where that is
  // shared (`/tmp` when TMPDIR is unset) another user could own the parent
  // and swap a bundle under us, so the runtime verifies it before first use:
  // see `verifyPrivateScratchParent`.
  const defaultScratchParent = joinHostPath(
    (Deno.env.get("TMPDIR") ?? "/tmp").replace(/\/+$/, "") || "/",
    "cf-harness-runsc",
  );
  const scratchDir = requireAbsoluteHostPath(
    "scratch directory",
    options.scratchDir ?? joinHostPath(
      defaultScratchParent,
      `${sanitizeIdPart(runId).slice(0, 24)}-${
        crypto.randomUUID().slice(0, 8)
      }`,
    ),
  );
  // Compared by canonical path, not spelling: a symlink under a mount that
  // points at scratch (or the reverse) would put the files inside the
  // sandbox's reach while the strings say otherwise.
  // macOS volumes are case-insensitive by default: a path that differs only
  // in case from a mount is inside it once created.
  const comparable = (canonical: string): string => {
    const trimmed = canonical.replace(/\/+$/, "");
    return platform === "darwin" ? trimmed.toLowerCase() : trimmed;
  };
  const inside = (
    canonical: string,
    canonicalRoots: readonly string[],
  ): boolean => {
    const p = comparable(canonical);
    return canonicalRoots.some((root) => {
      const r = comparable(root);
      return p === r || p.startsWith(r + "/");
    });
  };
  // A mount and the scratch directory are kept as they were given, and what
  // uses them does not agree on where a `..` after a link leads: the kernel
  // follows the link first, and Deno folds the `..` out of the spelling
  // first. Such a path is compared as both.
  const everyReading = (label: string, path: string): string[] => [
    ...new Set([
      canonicalHostPath(label, path),
      canonicalHostPath(label, normalizeHostPath(path)),
    ]),
  ];
  const hostMounts = [
    {
      label: "workspace host path",
      hostPath: workspaceHostPath,
      readOnly: false,
    },
    ...additionalMounts.map((m) => ({
      label: m.kind === "fabric-fuse"
        ? "fabric mount host path"
        : `host bind ${m.name} host path`,
      hostPath: m.hostPath,
      readOnly: m.readOnly,
    })),
  ].map((mount) => ({
    ...mount,
    canonical: everyReading(mount.label, mount.hostPath),
  }));
  for (const scratch of everyReading("sandbox scratch directory", scratchDir)) {
    for (const mount of hostMounts) {
      if (inside(scratch, mount.canonical)) {
        throw new Error(
          `sandbox scratch directory ${scratchDir} lies inside the mount ${mount.hostPath}: the CFC result and context files there would be writable from the sandbox`,
        );
      }
    }
  }
  // What decides how the sandbox is built and labelled must be out of the
  // sandbox's reach as well: a policy inside a writable mount was rewritten
  // from inside one container and the next read a labelled file as public
  // (review, verified live). The rootfs and the runsc binary likewise.
  // Whoever ran into this on the native runtime macOS defaulted to named no
  // runtime and may know of no store, so that refusal says where the file
  // came from and how the other driver is selected. It names the variable,
  // which every entrypoint reads.
  const selection = options.selection;
  const unnamed = selection?.source === "default" &&
      selection.runtime === "runsc"
    ? ". No sandbox runtime is named, so this is the native `runsc` runtime " +
      `that macOS defaults to, from the store at \`${selection.nativeStore}\`: ` +
      "run with a workspace and mounts that hold none of it, or select " +
      `Docker with \`${SANDBOX_RUNTIME_ENV}=docker\`.`
    : "";
  const trusted = (
    label: string,
    given: string,
    canonical: string,
  ): string => {
    for (const mount of hostMounts) {
      if (!mount.readOnly && inside(canonical, mount.canonical)) {
        throw new Error(
          `${label} ${given}${
            canonical === given ? "" : ` (which is ${canonical})`
          } lies inside the writable mount ${mount.hostPath}: the sandbox could rewrite it${unnamed}`,
        );
      }
    }
    return canonical;
  };
  const givenBinary = options.runscBinary ?? DEFAULT_RUNSC_BINARY;
  const runscBinary = trusted(
    "runsc binary",
    givenBinary,
    resolveRunscBinary(givenBinary),
  );
  const canonicalRootfs = trusted(
    "sandbox rootfs",
    rootfs,
    canonicalHostPath("sandbox rootfs", rootfs),
  );
  const cfcPolicyPath = options.cfcPolicyPath === undefined
    ? undefined
    : trusted(
      "CFC policy",
      options.cfcPolicyPath,
      canonicalHostPath("CFC policy", options.cfcPolicyPath),
    );
  // Frozen, mounts included: the engine checks containment against this
  // set and the runtime rereads it at every launch, and a caller holding
  // `ownedRunscSandboxConfig` must not be able to make those two differ.
  return Object.freeze({
    runscBinary,
    rootfs: canonicalRootfs,
    workspaceHostPath,
    workspaceMountPath,
    shellPath: options.shellPath ?? DEFAULT_RUNSC_SHELL,
    networkMode: options.networkMode ?? DEFAULT_RUNSC_NETWORK_MODE,
    additionalMounts: Object.freeze(
      additionalMounts.map((mount) => Object.freeze(mount)),
    ),
    extraRunscArgs: Object.freeze([...(options.extraRunscArgs ?? [])]),
    ...(cfcPolicyPath !== undefined ? { cfcPolicyPath } : {}),
    scratchDir,
    ...(options.scratchDir === undefined
      ? { scratchParentToVerify: defaultScratchParent }
      : {}),
    runId,
    ...(options.containerUser !== undefined
      ? { containerUser: options.containerUser }
      : {}),
    sessionStartTimeoutMs: options.sessionStartTimeoutMs ?? 30_000,
  });
};

/**
 * The enforcing floor for this runtime, the counterpart of the docker
 * runtime's sidecar-transport check: without a policy runsc runs with no
 * `--cfc` at all, so every result would arrive unmediated and an enforcing
 * mode would deny each one after the command had already run. Refuse the
 * run before anything executes instead.
 */
export const assertRunscCfcPolicyForMode = (
  mode: CfcEnforcementMode,
  config: Pick<RunscSandboxConfig, "cfcPolicyPath">,
): void => {
  if (cfcEnforcementStrictness(mode) < CFC_ENFORCING_STRICTNESS) return;
  if (config.cfcPolicyPath !== undefined) return;
  throw new Error(
    `cfc enforcement mode '${mode}' requires the runsc sandbox to run with a CFC policy (set --sandbox-cfc-policy or CF_HARNESS_RUNSC_CFC_POLICY); refusing to start a run that would silently degrade enforcement`,
  );
};

interface OciMount {
  destination: string;
  type: string;
  source: string;
  options: string[];
}

interface SessionState {
  name: string;
  containerId: string;
  bundleDir: string;
  handle?: ProcessHandle;
  ready: Promise<void>;
  /** Set once the container's `runsc run` child has exited. */
  ended: boolean;
}

/** Returns the owner of the entry at `path`, read without following a link. */
const ownerOfEntry = async (path: string): Promise<number | null> =>
  (await Deno.lstat(path)).uid;

/**
 * Verifies that the scratch parent is this user's alone, creating it with
 * mode 0700 when it is absent: whoever owns the parent, or may write to it,
 * can swap a bundle or a result under the run.
 *
 * This user is whoever owns what this process makes. The function makes an
 * empty entry in the parent, compares its owner with the parent's, and
 * removes it again, so the user compared is the one the run's own files will
 * belong to, whichever user started the process. The entry is made only in
 * a parent that is a directory with no access for group or others, and is
 * removed whether the parent is then accepted or not.
 *
 * `ownerOf` reads the owner of an entry, for the tests.
 *
 * @throws When the parent is a symbolic link, is not a directory, has any
 * access for group or others, belongs to another user than what this process
 * makes in it, or admits no entry made by this process.
 */
export const verifyPrivateScratchParent = async (
  parent: string,
  ownerOf: (path: string) => Promise<number | null> = ownerOfEntry,
): Promise<void> => {
  await Deno.mkdir(dirnameHost(parent), { recursive: true }).catch(() =>
    undefined
  );
  try {
    await Deno.mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = await Deno.lstat(parent);
  const mode = info.mode === null ? "unknown" : (info.mode & 0o777).toString(8);
  const refusal = (found: string): Error =>
    new Error(
      `sandbox scratch parent ${parent} is not a private directory of this user (${found}); remove it or set TMPDIR to a private directory`,
    );
  if (
    !info.isDirectory || info.isSymlink ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    const kind = info.isSymlink
      ? "a symbolic link, "
      : info.isDirectory
      ? ""
      : "not a directory, ";
    throw refusal(`${kind}owner ${info.uid}, mode ${mode}`);
  }
  // A directory, which `mkdir` makes or fails to make and never follows a
  // link to, under a name nothing else in the parent has.
  const probe = joinHostPath(parent, `.owner-probe-${crypto.randomUUID()}`);
  try {
    await Deno.mkdir(probe, { mode: 0o700 });
  } catch (error) {
    throw refusal(
      `owner ${info.uid}, mode ${mode}; this process could not make an entry in it: ${
        errorText(error)
      }`,
    );
  }
  let parentOwner: number | null;
  let madeOwner: number | null;
  try {
    parentOwner = await ownerOf(parent);
    madeOwner = await ownerOf(probe);
  } finally {
    await Deno.remove(probe);
  }
  if (madeOwner !== parentOwner) {
    throw refusal(
      `owner ${parentOwner}, mode ${mode}; what this process makes there is owned by ${madeOwner}`,
    );
  }
};

/** Resolve when `promise` does or after `ms`, without leaving a timer behind. */
const waitUpTo = (promise: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => undefined), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

const dirnameHost = (p: string): string => {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return "/";
  return trimmed.slice(0, i);
};

const sanitizeIdPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40);

export class RunscSandboxRuntime implements SandboxRuntime {
  readonly config: RunscSandboxConfig;
  readonly #runner: ProcessRunner;
  readonly #sessions = new Map<string, SessionState>();
  /**
   * Sessions that ended underneath the run (their init died, a call in
   * them timed out) and have not been named since. The next call that names
   * one is told its state is lost, once; the call after that starts an empty
   * session. A session that failed to start is not kept here: it held
   * nothing, and the next call that names it starts it again.
   */
  readonly #lostSessions = new Map<string, string>();
  /** Fresh-call containers in flight, so `close()` can take them down. */
  readonly #liveCalls = new Set<string>();
  #sessionsStarted = 0;
  #scratchVerified: Promise<void> | undefined;
  /**
   * What names this runtime's containers: a readable slice of the run id
   * plus a nonce minted here, so two runs whose ids share a prefix — or
   * two runtimes for one run — never resolve a session name to the same
   * container (review, verified live with a shared 12-character prefix).
   */
  readonly #runTag: string;
  #closed = false;

  constructor(config: RunscSandboxConfig, runner?: ProcessRunner) {
    this.config = config;
    this.#runner = runner ?? new DenoProcessRunner();
    this.#runTag = `${sanitizeIdPart(config.runId).slice(0, 12)}-${
      crypto.randomUUID().slice(0, 8)
    }`;
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      sessions: true,
      cfc: {
        runtimeRequested: this.config.cfcPolicyPath !== undefined,
        image: this.config.rootfs,
        workspaceMountPath: this.config.workspaceMountPath,
        mounts: this.#mountDescriptions(),
        networkMode: this.config.networkMode,
        invocationContextTransport: "fd",
        invocationContextTransportReadiness: "intrinsic",
      },
    };
  }

  defaultWorkingDirectory(): string {
    return this.config.workspaceMountPath;
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
      throw new SandboxPathEscapeError(
        path,
        `path escapes allowed sandbox roots: ${path}`,
      );
    }
    return normalized;
  }

  #mounts(): Array<
    {
      kind: "workspace" | "fabric-fuse" | "host-bind";
      name?: string;
      hostPath: string;
      sandboxPath: string;
      readOnly: boolean;
    }
  > {
    return [
      {
        kind: "workspace",
        hostPath: this.config.workspaceHostPath,
        sandboxPath: this.config.workspaceMountPath,
        readOnly: false,
      },
      ...this.config.additionalMounts.map((m) => ({
        kind: m.kind,
        ...(m.kind === "host-bind" ? { name: m.name } : {}),
        hostPath: m.hostPath,
        sandboxPath: m.sandboxPath,
        readOnly: m.readOnly,
      })),
    ];
  }

  #mountDescriptions(): SandboxRuntimeMountDescription[] {
    return this.#mounts().map((m) => ({
      kind: m.kind,
      ...(m.name !== undefined ? { name: m.name } : {}),
      hostPath: m.hostPath,
      sandboxPath: m.sandboxPath,
      readOnly: m.readOnly,
      ...(m.kind === "host-bind"
        ? { mode: m.readOnly ? "readonly" as const : "writable" as const }
        : {}),
    }));
  }

  /** Global runsc flags: what every subcommand of this runtime is run with. */
  #globalArgs(): string[] {
    return [
      "--root",
      joinHostPath(this.config.scratchDir, "state"),
      "--ignore-cgroups",
      `--network=${this.config.networkMode}`,
      "--overlay2=root:memory",
      ...(this.config.cfcPolicyPath !== undefined
        ? ["--cfc", "--cfc-policy", this.config.cfcPolicyPath]
        : []),
      ...this.config.extraRunscArgs,
    ];
  }

  /** A call's working directory: inside the mounts, as the docker runtime requires. */
  #cwd(cwd: string | undefined): string {
    return cwd === undefined
      ? this.defaultWorkingDirectory()
      : this.resolvePath(cwd);
  }

  /**
   * The docker runtime refuses, per call, an enforcing invocation context it
   * has no transport for. The counterpart here: without a policy runsc runs
   * with no `--cfc`, the context would be dropped and no result produced.
   * The engine refuses such a run at its start, but a runtime constructed
   * or injected directly has no engine in front of it.
   */
  #refusedForEnforcement(
    request: SandboxCommandRequest,
  ): SandboxCommandResult | undefined {
    const mode = request.cfcInvocationContext?.cfcEnforcementMode;
    if (
      mode === undefined ||
      cfcEnforcementStrictness(mode) < CFC_ENFORCING_STRICTNESS ||
      this.config.cfcPolicyPath !== undefined
    ) {
      return undefined;
    }
    return {
      stdout: "",
      stderr:
        `refusing to start a container under cfc enforcement mode '${mode}': the runsc sandbox has no CFC policy, so this invocation's CFC input labels would be dropped and no result produced\n`,
      exitCode: 125,
    };
  }

  /** The OCI spec for a container running argv, as `config.json` text. */
  #spec(
    request: { argv: string[]; cwd?: string; env?: Record<string, string> },
  ): string {
    const mounts: OciMount[] = [
      { destination: "/proc", type: "proc", source: "proc", options: [] },
      {
        destination: "/dev",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
      },
      {
        destination: "/dev/pts",
        type: "devpts",
        source: "devpts",
        options: [
          "nosuid",
          "noexec",
          "newinstance",
          "ptmxmode=0666",
          "mode=0620",
        ],
      },
      {
        destination: "/dev/shm",
        type: "tmpfs",
        source: "shm",
        options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"],
      },
      {
        destination: "/sys",
        type: "sysfs",
        source: "sysfs",
        options: ["nosuid", "noexec", "nodev", "ro"],
      },
      {
        destination: "/tmp",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "nodev", "mode=1777", `size=${RUNSC_TMPFS_SIZE}`],
      },
      ...this.#mounts().map((m) => ({
        destination: m.sandboxPath,
        type: "bind",
        source: m.hostPath,
        options: ["rbind", m.readOnly ? "ro" : "rw"],
      })),
    ];
    const env = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      TERM: "xterm",
      ...request.env,
    };
    const [uid, gid] = this.config.containerUser?.split(":").map(Number) ??
      [0, 0];
    const spec = {
      ociVersion: "1.1.0",
      process: {
        terminal: false,
        user: { uid: uid ?? 0, gid: gid ?? 0 },
        args: request.argv,
        env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map((
          [k, v],
        ) => `${k}=${v}`),
        cwd: this.#cwd(request.cwd),
      },
      root: { path: this.config.rootfs, readonly: false },
      hostname: "cf-harness",
      mounts,
      linux: {
        namespaces: [
          { type: "pid" },
          { type: "network" },
          { type: "ipc" },
          { type: "uts" },
          { type: "mount" },
        ],
      },
    };
    return `${JSON.stringify(spec, null, 2)}\n`;
  }

  /** Before anything is written under scratch: see verifyPrivateScratchParent. */
  #verifyScratch(): Promise<void> {
    this.#scratchVerified ??= this.config.scratchParentToVerify === undefined
      ? Promise.resolve()
      : verifyPrivateScratchParent(this.config.scratchParentToVerify);
    return this.#scratchVerified;
  }

  /**
   * A runsc control command: bounded, and never throwing. None is run while
   * the scratch parent has not passed, because a control command reads the
   * state of its container from under the scratch directory.
   */
  async #control(args: string[]): Promise<ProcessRunResult | undefined> {
    const request: ProcessRunRequest = {
      command: this.config.runscBinary,
      args: [...this.#globalArgs(), ...args],
      timeoutMs: RUNSC_CONTROL_TIMEOUT_MS,
    };
    try {
      await this.#verifyScratch();
      return await this.#runner.run(request);
    } catch {
      return undefined;
    }
  }

  /**
   * Take a container down and make sure it is gone: `delete --force`, and
   * when runsc still knows the container afterwards, kill and delete once
   * more. An ignored failure here is a sandbox left running.
   */
  async #destroyContainer(id: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.#control(["delete", "--force", id]);
      const state = await this.#control(["state", id]);
      if (state === undefined || state.exitCode !== 0) return;
      await this.#control(["kill", "--all", id, "KILL"]);
    }
  }

  async #writeBundle(id: string, specText: string): Promise<string> {
    await this.#verifyScratch();
    const dir = joinHostPath(this.config.scratchDir, "bundles", id);
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(joinHostPath(dir, "config.json"), specText);
    return dir;
  }

  /**
   * One container per call. Deno cannot hand a child arbitrary descriptors,
   * so a shell opens the context and result files as fds 3 and 4 and execs
   * runsc; on the Mac the darwin runsc carries those fds into the VM, on
   * Linux runsc reads and writes them directly. Both files are private to
   * this call under the run's scratch directory.
   */
  async #runOnce(
    request: SandboxCommandRequest,
  ): Promise<SandboxCommandResult> {
    const callId = `c-${this.#runTag}-${crypto.randomUUID().slice(0, 8)}`;
    // Validated before anything is written or registered.
    const specText = this.#spec(request);
    this.#liveCalls.add(callId);
    const bundleDir = await this.#writeBundle(callId, specText).catch(
      (error) => {
        this.#liveCalls.delete(callId);
        throw error;
      },
    );
    const contextPath = joinHostPath(bundleDir, "cfc-invocation-context.json");
    const resultPath = joinHostPath(bundleDir, "cfc-result.json");
    // Both descriptors go with `--cfc` or not at all: a runsc that is not
    // tracking refuses them rather than take a context it would drop.
    const withContext = request.cfcInvocationContext !== undefined &&
      this.config.cfcPolicyPath !== undefined;
    if (withContext) {
      await Deno.writeTextFile(
        contextPath,
        `${JSON.stringify(request.cfcInvocationContext, null, 2)}\n`,
      );
    }
    const withResult = this.config.cfcPolicyPath !== undefined;
    const runscArgs = [
      ...this.#globalArgs(),
      "run",
      ...(withContext ? ["--cfc-invocation-context-fd", "3"] : []),
      ...(withResult ? ["--cfc-result-fd", "4"] : []),
      "--bundle",
      bundleDir,
      callId,
    ];
    // `exec 3<ctx 4>result` then exec runsc: the descriptors are inherited
    // at the numbers runsc was told, and nothing else about the environment
    // changes.
    const shellArgs = [
      "-c",
      'exec 3<"$1" 4>"$2"; shift 2; exec "$@"',
      "sh",
      withContext ? contextPath : "/dev/null",
      withResult ? resultPath : "/dev/null",
      this.config.runscBinary,
      ...runscArgs,
    ];
    // The bundle (and the context and result files in it) goes whatever
    // happens below: a run that throws — a timeout, a runsc that will not
    // start — must not leave one behind per call, since the bash tool turns
    // timeouts into recoverable results and the model may repeat them.
    try {
      let result: ProcessRunResult;
      try {
        result = await this.#runner.run({
          command: "/bin/sh",
          args: shellArgs,
          stdinText: request.stdinText,
          timeoutMs: request.timeoutMs,
        });
      } finally {
        // A timed-out or killed run leaves the container registered; make
        // sure the sandbox is gone before the bundle it was started from.
        await this.#destroyContainer(callId);
        this.#liveCalls.delete(callId);
      }
      const commandResult: SandboxCommandResult = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
      if (!withResult) {
        return commandResult;
      }
      let cfcResult: CfcSandboxResult;
      try {
        const text = await Deno.readTextFile(resultPath);
        const parsed = JSON.parse(text) as RunscCfcResultSidecar;
        cfcResult = cfcResultFromRunscSidecar(parsed, callId, commandResult);
      } catch (error) {
        cfcResult = deniedCfcResult(
          "runsc_cfc_result_fd_unreadable",
          "runsc did not deliver a CFC result on the result descriptor",
          {
            containerId: callId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return { ...commandResult, cfcResult };
    } finally {
      await Deno.remove(bundleDir, { recursive: true }).catch(() => undefined);
    }
  }

  /**
   * A container id for a new session. Minted, not derived from the name:
   * runsc resolves abbreviated ids, so with the name in the id a session
   * `build` ran inside the container of `build2`, and `a` became ambiguous
   * once `ab` existed (review, verified live). A fixed-width counter under
   * this runtime's tag makes no id a prefix of another, differs for names
   * that differ only in case, and is never reused, so a session started
   * again after it ended does not meet what the old one left behind.
   */
  #mintSessionContainerId(): string {
    this.#sessionsStarted += 1;
    return `s-${this.#runTag}-${
      String(this.#sessionsStarted).padStart(4, "0")
    }`;
  }

  /** Whether the session's container is there and running, asked of runsc. */
  async #containerRunning(state: SessionState): Promise<boolean> {
    if (state.ended) return false;
    const st = await this.#control(["state", state.containerId]);
    return st !== undefined && st.exitCode === 0 &&
      /"status":\s*"running"/.test(st.stdout);
  }

  /** Forget a session and take down everything it held. */
  async #dropSession(state: SessionState, lostBecause?: string): Promise<void> {
    if (this.#sessions.get(state.name) === state) {
      this.#sessions.delete(state.name);
      if (lostBecause !== undefined) {
        this.#lostSessions.set(state.name, lostBecause);
      }
    }
    state.handle?.kill("SIGKILL");
    await this.#destroyContainer(state.containerId);
    await waitUpTo(state.handle?.exited ?? Promise.resolve(), 5_000);
    if (state.bundleDir !== "") {
      await Deno.remove(state.bundleDir, { recursive: true }).catch(() =>
        undefined
      );
    }
  }

  /**
   * Start a session's container on first use: an attached `runsc run` kept
   * as a child of this process, whose init reads the stdin pipe this
   * process holds. Ready once `runsc state` says running.
   */
  #ensureSession(session: string): SessionState {
    if (!SANDBOX_SESSION_NAME_PATTERN.test(session)) {
      throw new SandboxSessionUnavailableError(
        `invalid sandbox session name ${
          JSON.stringify(session)
        }: use 1 to 32 letters, digits, '_', '.' or '-', starting with a letter or digit`,
        "invalid-name",
      );
    }
    const lost = this.#lostSessions.get(session);
    if (lost !== undefined) {
      // Told once. The model must not carry on as if the files and
      // processes it left in the session were still there.
      this.#lostSessions.delete(session);
      throw new SandboxSessionUnavailableError(
        `sandbox session "${session}" ended (${lost}) and its state is lost; name it again to start an empty session`,
        "session-lost",
      );
    }
    const existing = this.#sessions.get(session);
    if (existing !== undefined) return existing;
    if (this.#closed) {
      throw new Error("sandbox runtime is closed");
    }
    if (this.#sessions.size >= RUNSC_MAX_SESSIONS) {
      throw new SandboxSessionUnavailableError(
        `this run already holds ${RUNSC_MAX_SESSIONS} sandbox sessions (${
          [...this.#sessions.keys()].join(", ")
        }); reuse one of them, or run without a session`,
        "session-limit",
      );
    }
    const state: SessionState = {
      name: session,
      containerId: this.#mintSessionContainerId(),
      bundleDir: "",
      ready: Promise.resolve(),
      ended: false,
    };
    const start = async (): Promise<void> => {
      const spec = this.#spec({
        // Waits on stdin, which this process holds open: EOF is the harness
        // going away, and the container goes with it.
        argv: [this.config.shellPath, "-c", "while read -r _; do :; done"],
        cwd: this.defaultWorkingDirectory(),
      });
      state.bundleDir = await this.#writeBundle(state.containerId, spec);
      const spawn = this.#runner.spawn;
      if (spawn === undefined) {
        throw new Error(
          "process runner cannot keep a session alive (no spawn)",
        );
      }
      const handle = spawn.call(this.#runner, {
        command: this.config.runscBinary,
        args: [
          ...this.#globalArgs(),
          "run",
          "--bundle",
          state.bundleDir,
          state.containerId,
        ],
        stdin: "held",
      });
      state.handle = handle;
      let exitCode: number | undefined;
      handle.exited.then((status) => {
        exitCode = status.exitCode;
        state.ended = true;
      }).catch(() => {
        state.ended = true;
      });
      const deadline = Date.now() + this.config.sessionStartTimeoutMs;
      while (Date.now() < deadline) {
        if (state.ended) {
          throw new Error(
            `its container exited with code ${
              exitCode ?? "unknown"
            } before it was running`,
          );
        }
        const st = await this.#control(["state", state.containerId]);
        if (
          st !== undefined && st.exitCode === 0 &&
          /"status":\s*"running"/.test(st.stdout)
        ) {
          return;
        }
        await waitUpTo(handle.exited, 25);
      }
      throw new Error(
        `it did not start within ${this.config.sessionStartTimeoutMs}ms`,
      );
    };
    state.ready = start().catch(async (error) => {
      // A start that failed is not cached: the entry goes, so does whatever
      // the attempt created, and the refusal is one the model can act on.
      await this.#dropSession(state);
      throw new SandboxSessionUnavailableError(
        `sandbox session "${session}" could not start: ${
          error instanceof Error ? error.message : String(error)
        }; run without a session, or try again`,
        "start-failed",
      );
    });
    // Awaited by every caller; marked handled so a session nobody awaits
    // (a close racing the start) is not an unhandled rejection.
    state.ready.catch(() => undefined);
    this.#sessions.set(session, state);
    return state;
  }

  async #runInSession(
    request: SandboxCommandRequest,
    session: string,
  ): Promise<SandboxCommandResult> {
    const mode = request.cfcInvocationContext?.cfcEnforcementMode;
    if (mode !== undefined && !sandboxSessionsAllowedUnder(mode)) {
      // See the header: a session's result cannot vouch for what reaches
      // the call's output, so an enforcing run gets no session at all.
      throw new SandboxSessionUnavailableError(
        `sandbox sessions are not available under cfc enforcement mode '${mode}': a session's CFC result cannot vouch for everything that reaches its output; run this command without a session`,
        "enforcing-mode",
      );
    }
    const cwd = this.#cwd(request.cwd);
    const state = this.#ensureSession(session);
    await state.ready;
    if (this.#closed) {
      throw new Error("sandbox runtime is closed");
    }
    if (state.ended) {
      await this.#dropSession(state);
      throw new SandboxSessionUnavailableError(
        `sandbox session "${session}" ended (its container exited) and its state is lost; name it again to start an empty session`,
        "session-lost",
      );
    }
    // Per call, the same transport a fresh container gets: the context on
    // fd 3, the result on fd 4, both private files under scratch that go
    // when the call does.
    const callId = `x-${this.#runTag}-${crypto.randomUUID().slice(0, 8)}`;
    const callDir = joinHostPath(this.config.scratchDir, "calls", callId);
    await Deno.mkdir(callDir, { recursive: true, mode: 0o700 });
    const contextPath = joinHostPath(callDir, "cfc-invocation-context.json");
    const resultPath = joinHostPath(callDir, "cfc-result.json");
    // Both descriptors go with `--cfc` or not at all: a runsc that is not
    // tracking refuses them rather than take a context it would drop.
    const withContext = request.cfcInvocationContext !== undefined &&
      this.config.cfcPolicyPath !== undefined;
    const withResult = this.config.cfcPolicyPath !== undefined;
    try {
      if (withContext) {
        await Deno.writeTextFile(
          contextPath,
          `${JSON.stringify(request.cfcInvocationContext, null, 2)}\n`,
        );
      }
      const runscArgs = [
        ...this.#globalArgs(),
        "exec",
        ...(withContext ? ["--cfc-invocation-context-fd", "3"] : []),
        ...(withResult ? ["--cfc-result-fd", "4"] : []),
        "--cwd",
        cwd,
        ...Object.entries(request.env ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .flatMap(([k, v]) => ["--env", `${k}=${v}`]),
        ...(this.config.containerUser !== undefined
          ? ["--user", this.config.containerUser]
          : []),
        state.containerId,
        ...request.argv,
      ];
      let result: ProcessRunResult;
      try {
        result = await this.#runner.run({
          command: "/bin/sh",
          args: [
            "-c",
            'exec 3<"$1" 4>"$2"; shift 2; exec "$@"',
            "sh",
            withContext ? contextPath : "/dev/null",
            withResult ? resultPath : "/dev/null",
            this.config.runscBinary,
            ...runscArgs,
          ],
          stdinText: request.stdinText,
          timeoutMs: request.timeoutMs,
        });
      } catch (error) {
        // A timeout stops the host side of the exec only: the command would
        // keep running in the session, with the workspace and the network,
        // and a retry would stack another on top (review, verified live).
        // There is no handle on the one process, so the session goes.
        await this.#dropSession(
          state,
          error instanceof Error && error.name === "ProcessTimeoutError"
            ? "a command in it timed out and was stopped with the session"
            : "a command in it could not be run",
        );
        throw error;
      }
      if (result.exitCode !== 0 && !(await this.#containerRunning(state))) {
        // runsc returns 128 with nothing on stdout when it could not reach
        // the container at all, and a command that ran can exit the same
        // way, so whether the command ran is not known. Anything else is a
        // command that took the container down with it, whose own result
        // stands.
        const unknownIfRan = result.exitCode === 128 && result.stdout === "";
        await this.#dropSession(
          state,
          unknownIfRan ? undefined : "its container exited",
        );
        if (unknownIfRan) {
          throw new SandboxSessionUnavailableError(
            `sandbox session "${session}" ended (its container exited) and its state is lost; name it again to start an empty session`,
            "session-ended-during-call",
          );
        }
      }
      const commandResult: SandboxCommandResult = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
      if (!withResult) {
        return commandResult;
      }
      let cfcResult: CfcSandboxResult;
      try {
        const text = await Deno.readTextFile(resultPath);
        const parsed = JSON.parse(text) as RunscCfcResultSidecar;
        cfcResult = cfcResultFromRunscSidecar(
          parsed,
          state.containerId,
          commandResult,
        );
      } catch (error) {
        cfcResult = deniedCfcResult(
          "runsc_cfc_result_fd_unreadable",
          "runsc exec did not deliver a CFC result on the result descriptor",
          {
            containerId: state.containerId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return { ...commandResult, cfcResult };
    } finally {
      await Deno.remove(callDir, { recursive: true }).catch(() => undefined);
    }
  }

  async run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    if (this.#closed) {
      throw new Error("sandbox runtime is closed");
    }
    const refusal = this.#refusedForEnforcement(request);
    if (refusal !== undefined) return refusal;
    if (request.session !== undefined) {
      return await this.#runInSession(request, request.session);
    }
    return await this.#runOnce(request);
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
      session: request.session,
    });
  }

  /** Session container ids currently alive, for tests and diagnostics. */
  sessionContainerIds(): string[] {
    return [...this.#sessions.values()].map((s) => s.containerId);
  }

  /**
   * Stop everything this runtime started: every session, and every fresh
   * call still in flight (a call racing the close, or one whose run was
   * interrupted). Idempotent.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#lostSessions.clear();
    for (const state of sessions) {
      await state.ready.catch(() => undefined);
      await this.#dropSession(state);
    }
    for (const callId of [...this.#liveCalls]) {
      await this.#destroyContainer(callId);
      await Deno.remove(
        joinHostPath(this.config.scratchDir, "bundles", callId),
        { recursive: true },
      ).catch(() => undefined);
    }
    // The scratch tree is this run's; take it down when nothing is left in
    // it (non-recursive on purpose: anything still there is evidence).
    for (const sub of ["calls", "bundles", "state"]) {
      await Deno.remove(joinHostPath(this.config.scratchDir, sub)).catch(() =>
        undefined
      );
    }
    await Deno.remove(this.config.scratchDir).catch(() => undefined);
  }
}
