import type { CfcSandboxResult } from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "../contracts/cfc-invocation-context.ts";

export type DockerNetworkMode = "none" | "bridge" | "host";

export type SandboxRuntimeMountKind =
  | "workspace"
  | "fabric-fuse"
  | "host-bind";

export type SandboxHostMountMode = "readonly" | "writable";

export interface SandboxRuntimeMountDescription {
  kind: SandboxRuntimeMountKind;
  name?: string;
  hostPath?: string;
  sandboxPath: string;
  readOnly: boolean;
  mode?: SandboxHostMountMode;
}

export interface DockerRunscFabricAdditionalMountConfig {
  kind: "fabric-fuse";
  hostPath: string;
  sandboxPath?: string;
  readOnly?: boolean;
}

export interface DockerRunscHostBindAdditionalMountConfig {
  kind: "host-bind";
  name: string;
  hostPath: string;
  sandboxPath: string;
  readOnly?: boolean;
}

export type DockerRunscAdditionalMountConfig =
  | DockerRunscFabricAdditionalMountConfig
  | DockerRunscHostBindAdditionalMountConfig;

export interface DockerRunscFabricAdditionalMount {
  kind: "fabric-fuse";
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}

export interface DockerRunscHostBindAdditionalMount {
  kind: "host-bind";
  name: string;
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}

export type DockerRunscAdditionalMount =
  | DockerRunscFabricAdditionalMount
  | DockerRunscHostBindAdditionalMount;

export interface DockerRunscSandboxConfig {
  dockerBinary: string;
  runtimeName: string;
  image: string;
  containerUser?: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
  shellPath: string;
  dockerNetworkMode: DockerNetworkMode;
  additionalMounts: readonly DockerRunscAdditionalMount[];
  extraDockerArgs: readonly string[];
  // Read once per sandbox and then memoized, so a verdict outlives the read
  // that produced it. `readonly` keeps the directory it was read against from
  // moving underneath it.
  readonly cfcResultDir?: string;
  readonly cfcInvocationContextDir?: string;
}

export interface ResolveDockerRunscSandboxConfigOptions {
  dockerBinary?: string;
  runtimeName?: string;
  image?: string;
  containerUser?: string;
  workspaceHostPath: string;
  workspaceMountPath?: string;
  shellPath?: string;
  dockerNetworkMode?: DockerNetworkMode;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  extraDockerArgs?: readonly string[];
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
}

/**
 * Which of the two host sidecar directories a readiness reading is about.
 * `cf-harness` writes into the invocation-context directory and reads out of
 * the result directory; the installed Docker runtime is the counterparty for
 * both, and it can be wired for either one independently of the other.
 */
export type CfcSidecarTransportKind = "invocation-context" | "result";

/**
 * One transport's reading.
 *
 * `unregistered` says no valid absolute value occurs for the flag — absent,
 * empty, or relative, and runsc refuses a non-absolute one — so nothing reads
 * the harness's directory. It refuses under enforcement.
 *
 * `unsafe-runtime-arguments` says the runtime argument list contains a
 * character outside the conservative allowlist the readiness check trusts.
 * Moby shell-parses that list before runsc sees it, so its raw meaning cannot
 * be affirmed. It carries the first offending argument and its unsafe
 * characters, and refuses under enforcement without collapsing into
 * `unregistered`.
 *
 * `registered` says a valid absolute directory is registered, and carries
 * which one. It is deliberately not a claim that the directory is the one the
 * harness writes to, and not a claim that the transport works. Comparing the
 * two spellings cannot establish either: Docker resolves bind paths on the
 * daemon's host, symlinks and case-insensitive projections make two spellings
 * one directory, and `runtimes` is SIGHUP-reloadable. The registered path
 * travels with the status instead, so an operator can see that it differs
 * without this check pretending that seeing it differ is knowing it differs.
 * Affirming the transport needs an end-to-end proof — a sentinel written by
 * the harness and read back from inside the sandbox — which this reading is
 * not.
 *
 * `indeterminate` is the absence of any reading. Folding it into `unregistered`
 * refuses a host whose registration could not be read; folding it into
 * `registered` excuses a broken one.
 *
 * The word each status carries is what survives: these travel on the wire into
 * `policy-snapshot.json`, where no doc comment follows them, and a reader who
 * meets one there has only the word.
 */
export type CfcSidecarTransportReading =
  | { status: "registered"; registeredPath: string }
  | { status: "unregistered" }
  | {
    status: "unsafe-runtime-arguments";
    argumentIndex: number;
    unsafeCharacters: readonly string[];
  }
  | { status: "indeterminate"; reason: string };

export type CfcTransportReadiness = {
  readonly [K in CfcSidecarTransportKind]?: CfcSidecarTransportReading;
};

/**
 * A sandbox session name. A call that names one runs inside a sandbox the
 * runtime keeps alive for the rest of the run, so state a command leaves
 * behind (files outside the mounts, background processes, installed
 * packages) is there for the next call that names the same session. A call
 * that names none gets a fresh sandbox of its own. Sessions are scoped to
 * the run: two runs naming the same session never share a sandbox.
 */
export type SandboxSessionName = string;

export const SANDBOX_SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

export interface SandboxCommandRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinText?: string;
  timeoutMs?: number;
  cfcInvocationContext?: HarnessCfcInvocationContext;
  session?: SandboxSessionName;
}

export interface SandboxShellRequest {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinText?: string;
  timeoutMs?: number;
  cfcInvocationContext?: HarnessCfcInvocationContext;
  session?: SandboxSessionName;
}

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cfcResult?: CfcSandboxResult;
}

export interface SandboxRuntimeDescription {
  kind: "docker-runsc-cfc" | "runsc-cfc";
  defaultWorkingDirectory: string;
  /** Whether `session` on a request is honoured rather than ignored. */
  sessions?: boolean;
  cfc?: {
    runtimeRequested: boolean;
    runtimeName?: string;
    image?: string;
    workspaceMountPath?: string;
    mounts?: readonly SandboxRuntimeMountDescription[];
    networkMode?: DockerNetworkMode;
    extraDockerArgsCount?: number;
    invocationContextTransport?: string;
    invocationContextTransportReadiness?: string;
    // Reported as a pair so the difference between them is legible without
    // this check comparing them. The two are expected to differ on Docker
    // Desktop, where the documented configuration registers the `/host_mnt`
    // projection of the very directory the harness writes to.
    invocationContextRegisteredPath?: string;
    invocationContextConfiguredPath?: string;
  };
}

export interface SandboxRuntime {
  describe(): SandboxRuntimeDescription;

  /**
   * Read whether the host runtime has a valid absolute directory registered
   * for each CFC sidecar flag, so that `describe()` reports a reading rather
   * than `unverified`. It does not check that what is registered is this
   * sandbox's directory — see `CfcSidecarTransportReading` for why that
   * cannot be read from a registration. Optional because it is meaningful
   * only for a runtime that has a registration to read; a caller that wants
   * the description to carry a reading awaits this first.
   */
  probeCfcTransportReadiness?(): Promise<CfcTransportReadiness>;

  resolvePath(path: string, cwd?: string): string;
  isPathWithinWorkspace(path: string): boolean;
  isPathWithinAllowedRoots(path: string): boolean;
  defaultWorkingDirectory(): string;
  run(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult>;

  /**
   * Release whatever the runtime keeps alive between calls (sessions). The
   * engine calls it when the run ends; a runtime with nothing to release
   * need not implement it.
   */
  close?(): Promise<void>;
}
