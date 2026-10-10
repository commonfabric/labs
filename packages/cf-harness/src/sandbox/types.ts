import {
  CFC_ENFORCING_STRICTNESS,
  type CfcEnforcementMode,
  cfcEnforcementStrictness,
  type CfcSandboxResult,
} from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "../contracts/cfc-invocation-context.ts";

/**
 * How a direct runsc sandbox is networked: `none`, loopback alone; `sandbox`,
 * runsc's own network stack in the container's network namespace; `host`,
 * the host's network.
 */
export type RunscNetworkMode = "none" | "sandbox" | "host";

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

export interface SandboxFabricAdditionalMountConfig {
  kind: "fabric-fuse";
  hostPath: string;
  sandboxPath?: string;
  readOnly?: boolean;
}

export interface SandboxHostBindAdditionalMountConfig {
  kind: "host-bind";
  name: string;
  hostPath: string;
  sandboxPath: string;
  readOnly?: boolean;
}

export type SandboxAdditionalMountConfig =
  | SandboxFabricAdditionalMountConfig
  | SandboxHostBindAdditionalMountConfig;

export interface SandboxFabricAdditionalMount {
  kind: "fabric-fuse";
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}

export interface SandboxHostBindAdditionalMount {
  kind: "host-bind";
  name: string;
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}

export type SandboxAdditionalMount =
  | SandboxFabricAdditionalMount
  | SandboxHostBindAdditionalMount;

/**
 * A sandbox session name. A call that names one runs inside a sandbox the
 * runtime keeps alive for the rest of the run, so state a command leaves
 * behind (files outside the mounts, background processes, installed
 * packages) is there for the next call that names the same session. A call
 * that names none gets a fresh sandbox of its own. A session belongs to the
 * runtime that started it: two runtimes naming the same session never share a
 * sandbox, and runs that execute on one runtime share its sessions.
 */
export type SandboxSessionName = string;

export const SANDBOX_SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

/**
 * Whether a run in `mode` can use a sandbox session. No enforcing mode can: a
 * session's CFC result cannot vouch for everything that reaches a call's
 * output. One rule for the runtime that refuses a session and the tool that
 * offers the model one, so a run is never offered a session it will be
 * refused.
 */
export const sandboxSessionsAllowedUnder = (
  mode: CfcEnforcementMode,
): boolean => cfcEnforcementStrictness(mode) < CFC_ENFORCING_STRICTNESS;

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

/**
 * Why a runtime refused a sandbox session, as a closed set. What a model
 * should do next differs by reason, so a caller that tells a model about the
 * refusal selects its text by this and never by reading the message.
 *
 * - `invalid-name`: the name is not a session name.
 * - `enforcing-mode`: the run's CFC enforcement mode allows no session.
 * - `session-lost`: the session ended before the call and what it held is
 *   gone. The call's command was not executed. Naming the session again
 *   starts an empty one.
 * - `session-ended-during-call`: the session ended while the call's command
 *   was handed to it, and what it held is gone. Whether the command ran, in
 *   whole or in part, is not known, and its output was not kept. Naming the
 *   session again starts an empty one.
 * - `session-limit`: the run holds as many sessions as it may.
 * - `start-failed`: the session's sandbox did not start.
 */
export type SandboxSessionUnavailableReason =
  | "invalid-name"
  | "enforcing-mode"
  | "session-lost"
  | "session-ended-during-call"
  | "session-limit"
  | "start-failed";

/**
 * A tool call named a sandbox session the runtime cannot honor right now.
 * Recoverable: the bash tool turns it into a result the model can act on,
 * rather than a run-fatal error.
 *
 * `message` is written for an operator. It can carry host paths, container
 * ids and the text of an underlying runtime error, so it is not shown to a
 * model; `reason` is what a model-facing caller goes by.
 */
export class SandboxSessionUnavailableError extends Error {
  readonly reason: SandboxSessionUnavailableReason;

  constructor(message: string, reason: SandboxSessionUnavailableReason) {
    super(message);
    this.name = "SandboxSessionUnavailableError";
    this.reason = reason;
  }
}

/**
 * The sandbox runtime an entrypoint selects: `runsc`, the direct driver, the
 * one there is. A run state or a session status written by a cf-harness that
 * had a Docker driver may record `docker`, which this build reads in order to
 * refuse it.
 */
export type SandboxRuntimeKind = "runsc";

/**
 * A platform whose default sandbox runtime can apply, as `Deno.build.os`
 * writes it. A name outside this set is a type error rather than a platform
 * that reads as "not macOS".
 */
export type SandboxPlatform = typeof Deno.build.os;

/**
 * A processor architecture, as `Deno.build.arch` writes it. On macOS it
 * decides whether the native runtime can run at all: its VM runs on Apple
 * silicon alone.
 */
export type SandboxArch = typeof Deno.build.arch;

/** The platforms whose default sandbox runtime is the native one. */
export type NativeRuntimePlatform = "darwin" | "linux";

/**
 * How a selection came to its runtime, kept so that a run and the console can
 * tell a runtime someone named from one the platform defaulted to. Only macOS
 * and Linux have a default, so a defaulted runtime anywhere else is not a
 * choice there can be.
 */
export type SandboxRuntimeChoice =
  /** A flag or the environment named the runtime. */
  | { runtime: SandboxRuntimeKind; source: "flag" | "environment" }
  /**
   * Nothing named one, on a platform whose default is the native runtime,
   * which runs from the store at `nativeStore`: the cfc-vm store on macOS,
   * and on Linux the store gVisor's Linux installer writes.
   */
  | {
    runtime: "runsc";
    source: "default";
    platform: NativeRuntimePlatform;
    nativeStore: string;
  };

export interface SandboxRuntimeDescription {
  /**
   * `runsc-cfc`, the direct runsc driver, the one this build runs. A
   * capability snapshot a cf-harness with a Docker driver wrote can record
   * `docker-runsc-cfc`, which this build reads in order to refuse a resume of
   * that run, and refuses as the description of a runtime handed to it.
   */
  kind: "runsc-cfc" | "docker-runsc-cfc";
  defaultWorkingDirectory: string;
  /** Whether `session` on a request is honoured rather than ignored. */
  sessions?: boolean;

  /**
   * How an entrypoint selected this runtime. A runtime does not describe this
   * of itself: the engine adds it where it was built with a selection, and
   * it is absent for an engine a caller built without one.
   */
  selection?: SandboxRuntimeChoice;

  cfc?: {
    runtimeRequested: boolean;
    image?: string;
    workspaceMountPath?: string;
    mounts?: readonly SandboxRuntimeMountDescription[];
    /**
     * The runtime's network mode; `bridge` only in a capability snapshot a
     * cf-harness with a Docker driver wrote, which this build reads in order
     * to refuse a resume of that run.
     */
    networkMode?: RunscNetworkMode | "bridge";
    invocationContextTransport?: string;
    invocationContextTransportReadiness?: string;
  };
}

export interface SandboxRuntime {
  describe(): SandboxRuntimeDescription;

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
