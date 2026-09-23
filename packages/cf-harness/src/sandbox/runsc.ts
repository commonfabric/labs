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
  SANDBOX_SESSION_NAME_PATTERN,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxRuntime,
  type SandboxRuntimeDescription,
  type SandboxRuntimeMountDescription,
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
 *   first use as an attached `runsc run` child of this process (so it dies
 *   with the harness, whatever else happens) and driven with `runsc exec`
 *   per call at about ten milliseconds. Sessions never share a sandbox: the
 *   container id carries the run id, and two names are two containers.
 *
 * What a session cannot do yet: carry a per-call CFC invocation context or
 * report a per-call result, because `runsc exec` has no fd flags for them.
 * Until it does, a session call in an enforcing mode is refused rather than
 * run unmediated.
 */

export const DEFAULT_RUNSC_BINARY = "runsc";
export const DEFAULT_RUNSC_WORKSPACE_MOUNT_PATH = "/workspace";
export const DEFAULT_RUNSC_SHELL = "/bin/sh";
export const DEFAULT_RUNSC_FABRIC_MOUNT_PATH = "/fabric";
export const RUNSC_ROOTFS_ENV = "CF_HARNESS_SANDBOX_ROOTFS";
export const RUNSC_CFC_POLICY_ENV = "CF_HARNESS_RUNSC_CFC_POLICY";
export const RUNSC_BINARY_ENV = "CF_HARNESS_RUNSC_BINARY";

/** Where the macOS runsc keeps the block image a bundle can name as rootfs. */
export const defaultDarwinRootfs = (
  home: string,
  imageKey = "kitchensink",
): string =>
  joinHostPath(
    home,
    "Library",
    "Application Support",
    "cfc-vm",
    "images",
    imageKey,
  );

export type RunscNetworkMode = "none" | "sandbox" | "host";

export interface RunscSandboxConfig {
  runscBinary: string;
  /**
   * The rootfs the bundle names. On Linux a directory; on macOS the
   * `<store>/images/<key>` marker the darwin runsc maps to a block image.
   */
  rootfs: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
  shellPath: string;
  networkMode: RunscNetworkMode;
  additionalMounts: readonly DockerRunscAdditionalMount[];
  /** Global runsc flags placed before the subcommand, verbatim. */
  extraRunscArgs: readonly string[];
  /** CFC policy file; `--cfc` is passed exactly when this is set. */
  cfcPolicyPath?: string;
  /** Host directory for bundles, contexts and results; private to the run. */
  scratchDir: string;
  /** Distinguishes this run's sessions from every other run's. */
  runId: string;
  containerUser?: string;
  /** How long a session's container may take to report running. */
  sessionStartTimeoutMs: number;
}

export interface ResolveRunscSandboxConfigOptions {
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
  platform?: "darwin" | "linux" | string;
  sessionStartTimeoutMs?: number;
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
  return normalizeSandboxRoot(path);
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
        readOnly: mount.readOnly ?? true,
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
  for (const a of roots) {
    for (const b of roots) {
      if (a !== b && isWithinRoot(a, b)) {
        throw new Error(`sandbox roots overlap: ${a} contains ${b}`);
      }
    }
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
  const scratchDir = requireAbsoluteHostPath(
    "scratch directory",
    options.scratchDir ?? joinHostPath(
      (Deno.env.get("TMPDIR") ?? "/tmp").replace(/\/+$/, "") || "/",
      "cf-harness-runsc",
      sanitizeIdPart(runId),
    ),
  );
  for (
    const root of [
      workspaceHostPath,
      ...additionalMounts.map((m) => m.hostPath),
    ]
  ) {
    const normalized = root.replace(/\/+$/, "");
    if (scratchDir === normalized || scratchDir.startsWith(normalized + "/")) {
      throw new Error(
        `sandbox scratch directory ${scratchDir} lies inside the mount ${root}: the CFC result and context files there would be writable from the sandbox`,
      );
    }
  }
  // Frozen, mounts included: the engine checks containment against this
  // set and the runtime rereads it at every launch, and a caller holding
  // `ownedRunscSandboxConfig` must not be able to make those two differ.
  return Object.freeze({
    runscBinary: options.runscBinary ?? DEFAULT_RUNSC_BINARY,
    rootfs: requireAbsoluteHostPath("sandbox rootfs", rootfs),
    workspaceHostPath,
    workspaceMountPath,
    shellPath: options.shellPath ?? DEFAULT_RUNSC_SHELL,
    networkMode: options.networkMode ?? "none",
    additionalMounts: Object.freeze(
      additionalMounts.map((mount) => Object.freeze(mount)),
    ),
    extraRunscArgs: Object.freeze([...(options.extraRunscArgs ?? [])]),
    ...(options.cfcPolicyPath !== undefined
      ? {
        cfcPolicyPath: requireAbsoluteHostPath(
          "CFC policy",
          options.cfcPolicyPath,
        ),
      }
      : {}),
    scratchDir,
    runId,
    ...(options.containerUser !== undefined
      ? { containerUser: options.containerUser }
      : {}),
    sessionStartTimeoutMs: options.sessionStartTimeoutMs ?? 30_000,
  });
};

/**
 * Refuse a session call in an enforcing mode: `runsc exec` cannot yet take a
 * per-call invocation context or hand back a per-call result, so the call
 * would run with no mediation at all, which enforcement forbids.
 */
export const assertRunscSessionAllowedForMode = (
  mode: CfcEnforcementMode,
  session: string | undefined,
): void => {
  if (session === undefined) return;
  if (cfcEnforcementStrictness(mode) < CFC_ENFORCING_STRICTNESS) return;
  throw new SandboxSessionUnavailableError(
    `sandbox session "${session}" cannot run in CFC mode ${mode}: runsc exec carries no per-call CFC transport yet; omit the session or run in observe mode`,
  );
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
  containerId: string;
  bundleDir: string;
  handle?: ProcessHandle;
  ready: Promise<void>;
}

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

const sanitizeIdPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40);

export class RunscSandboxRuntime implements SandboxRuntime {
  readonly config: RunscSandboxConfig;
  readonly #runner: ProcessRunner;
  readonly #sessions = new Map<string, SessionState>();
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
        options: ["nosuid", "nodev", "mode=1777"],
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
        cwd: request.cwd ?? this.defaultWorkingDirectory(),
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

  async #writeBundle(id: string, specText: string): Promise<string> {
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
    const bundleDir = await this.#writeBundle(callId, this.#spec(request));
    const contextPath = joinHostPath(bundleDir, "cfc-invocation-context.json");
    const resultPath = joinHostPath(bundleDir, "cfc-result.json");
    const withContext = request.cfcInvocationContext !== undefined;
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
        await this.#runner.run({
          command: this.config.runscBinary,
          args: [...this.#globalArgs(), "delete", "--force", callId],
        }).catch(() => undefined);
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

  #sessionContainerId(session: string): string {
    if (!SANDBOX_SESSION_NAME_PATTERN.test(session)) {
      throw new Error(
        `invalid sandbox session name: ${JSON.stringify(session)}`,
      );
    }
    return `s-${this.#runTag}-${session}`;
  }

  /**
   * Start a session's container on first use: an attached `runsc run` whose
   * init just waits, kept as a child of this process. Ready once `runsc
   * state` says running.
   */
  #ensureSession(session: string): SessionState {
    const existing = this.#sessions.get(session);
    if (existing !== undefined) return existing;
    if (this.#closed) {
      throw new Error("sandbox runtime is closed");
    }
    const containerId = this.#sessionContainerId(session);
    const state: SessionState = {
      containerId,
      bundleDir: "",
      ready: Promise.resolve(),
    };
    state.ready = (async () => {
      const spec = this.#spec({
        argv: [this.config.shellPath, "-c", "while :; do sleep 3600; done"],
        cwd: this.defaultWorkingDirectory(),
      });
      state.bundleDir = await this.#writeBundle(containerId, spec);
      const spawn = this.#runner.spawn;
      if (spawn === undefined) {
        throw new Error(
          "process runner cannot keep a session alive (no spawn)",
        );
      }
      state.handle = spawn.call(this.#runner, {
        command: this.config.runscBinary,
        args: [
          ...this.#globalArgs(),
          "run",
          "--bundle",
          state.bundleDir,
          containerId,
        ],
      });
      const deadline = Date.now() + this.config.sessionStartTimeoutMs;
      while (Date.now() < deadline) {
        const st = await this.#runner.run({
          command: this.config.runscBinary,
          args: [...this.#globalArgs(), "state", containerId],
        });
        if (st.exitCode === 0 && /"status":\s*"running"/.test(st.stdout)) {
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      state.handle.kill("SIGKILL");
      throw new Error(
        `sandbox session "${session}" did not start within ${this.config.sessionStartTimeoutMs}ms`,
      );
    })();
    this.#sessions.set(session, state);
    return state;
  }

  async #runInSession(
    request: SandboxCommandRequest,
    session: string,
  ): Promise<SandboxCommandResult> {
    const state = this.#ensureSession(session);
    await state.ready;
    const result = await this.#runner.run({
      command: this.config.runscBinary,
      args: [
        ...this.#globalArgs(),
        "exec",
        "--cwd",
        request.cwd ?? this.defaultWorkingDirectory(),
        ...Object.entries(request.env ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .flatMap(([k, v]) => ["--env", `${k}=${v}`]),
        ...(this.config.containerUser !== undefined
          ? ["--user", this.config.containerUser]
          : []),
        state.containerId,
        ...request.argv,
      ],
      stdinText: request.stdinText,
      timeoutMs: request.timeoutMs,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    if (this.#closed) {
      return Promise.reject(new Error("sandbox runtime is closed"));
    }
    if (request.session !== undefined) {
      try {
        assertRunscSessionAllowedForMode(
          request.cfcInvocationContext?.cfcEnforcementMode ?? "disabled",
          request.session,
        );
      } catch (error) {
        return Promise.reject(error);
      }
      return this.#runInSession(request, request.session);
    }
    return this.#runOnce(request);
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

  /** Stop every session: kill, delete, remove the bundle. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const state of sessions) {
      await state.ready.catch(() => undefined);
      await this.#runner.run({
        command: this.config.runscBinary,
        args: [...this.#globalArgs(), "kill", state.containerId, "KILL"],
      }).catch(() => undefined);
      state.handle?.kill("SIGTERM");
      await waitUpTo(state.handle?.exited ?? Promise.resolve(), 5_000);
      await this.#runner.run({
        command: this.config.runscBinary,
        args: [...this.#globalArgs(), "delete", "--force", state.containerId],
      }).catch(() => undefined);
      if (state.bundleDir !== "") {
        await Deno.remove(state.bundleDir, { recursive: true }).catch(() =>
          undefined
        );
      }
    }
    // The scratch tree is this run's; take it down when nothing is left in
    // it (non-recursive on purpose: anything still there is evidence).
    for (const sub of ["bundles", "state"]) {
      await Deno.remove(joinHostPath(this.config.scratchDir, sub)).catch(() =>
        undefined
      );
    }
    await Deno.remove(this.config.scratchDir).catch(() => undefined);
  }
}
