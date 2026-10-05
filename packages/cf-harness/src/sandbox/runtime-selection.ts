/**
 * Sandbox runtime selection, shared by every cf-harness entrypoint.
 *
 * Why this is a module of its own: the batch CLI derived the runsc runtime
 * from `CF_HARNESS_SANDBOX_RUNTIME` and its companions inline, and the
 * interactive chat host — a second entrypoint over the same engine — read
 * none of them. Loom's chat lane launched the host with the native
 * environment set and got a docker engine anyway, the same "second
 * entrypoint, no provisioning" defect `host-mounts.ts` exists to remove.
 * There is one derivation here, and both entrypoints call it.
 *
 * The docker runtime reads its own environment (image, docker runtime,
 * network mode) where it builds its sandbox; only the runsc runtime needs
 * the selection carried in as engine options, because nothing else runs
 * runsc directly.
 */

import { isAbsolute, join, resolve } from "@std/path";
import type { RunscNetworkMode } from "./runsc.ts";

export type SandboxRuntimeKind = "docker" | "runsc";

/** Engine options naming which runtime executes a run, and how. */
export interface SandboxRuntimeSelection {
  sandboxRuntimeKind?: SandboxRuntimeKind;
  sandboxRootfs?: string;
  sandboxCfcPolicy?: string;
  sandboxRunscBinary?: string;
  sandboxRunscNetworkMode?: RunscNetworkMode;
}

/**
 * Values a caller received explicitly (a flag), which win over the
 * environment. A present value takes part even when it is empty: an empty
 * runtime is refused, and an empty rootfs or policy means "none" (for the
 * policy that includes the default under HOME).
 */
export interface ExplicitSandboxRuntimeSelection {
  sandboxRuntime?: string;
  sandboxRootfs?: string;
  sandboxCfcPolicy?: string;
}

export const SANDBOX_RUNTIME_ENV = "CF_HARNESS_SANDBOX_RUNTIME";
export const SANDBOX_ROOTFS_ENV = "CF_HARNESS_SANDBOX_ROOTFS";
export const RUNSC_CFC_POLICY_ENV = "CF_HARNESS_RUNSC_CFC_POLICY";
export const RUNSC_BINARY_ENV = "CF_HARNESS_RUNSC_BINARY";
/** Shared with the docker runtime; the vocabulary is docker's. */
export const SANDBOX_NETWORK_MODE_ENV = "CF_HARNESS_DOCKER_NETWORK_MODE";

const nonEmpty = (input: string | undefined): string | undefined => {
  const trimmed = input?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const regularFileExists = (path: string): Promise<boolean> =>
  Deno.stat(path).then((info) => info.isFile).catch(() => false);

export interface SandboxRuntimeSelectionOptions {
  /**
   * The home the default CFC policy is looked up under. An entrypoint that
   * clears `HOME` from the environment it hands on (the Loom local host does)
   * names the real one here; otherwise `env.HOME` is used.
   */
  homeDir?: string;
  /** Relative rootfs and policy paths resolve against this, as other path flags do. */
  cwd?: string;
  /** Whether a regular file exists at `path`; `Deno.stat` when absent. */
  pathExists?: (path: string) => Promise<boolean>;
}

/**
 * Derives the runtime selection from explicit values and the environment.
 *
 * Nothing is returned beyond the runtime kind unless the runtime is runsc:
 * the companions describe that runtime alone, and a docker run (or one that
 * names no runtime) must hand on exactly what it handed on before this
 * module existed.
 *
 * The default CFC policy is the one the docker path's installer puts under
 * HOME, so both runtimes label the same files the same way. It is looked up
 * only for the runsc runtime, only when nothing named one (an explicit empty
 * value means "none" and is not overridden by the default), and only taken
 * when it is there.
 */
export const resolveSandboxRuntimeSelection = async (
  env: Record<string, string | undefined>,
  explicit: ExplicitSandboxRuntimeSelection = {},
  options: SandboxRuntimeSelectionOptions = {},
): Promise<SandboxRuntimeSelection> => {
  const pathExists = options.pathExists ?? regularFileExists;
  const atCwd = (path: string | undefined): string | undefined =>
    path === undefined || options.cwd === undefined || isAbsolute(path)
      ? path
      : resolve(options.cwd, path);
  const rawRuntime = explicit.sandboxRuntime !== undefined
    ? explicit.sandboxRuntime.trim()
    : nonEmpty(env[SANDBOX_RUNTIME_ENV]);
  if (
    rawRuntime !== undefined && rawRuntime !== "docker" &&
    rawRuntime !== "runsc"
  ) {
    throw new Error("sandbox runtime must be one of docker, runsc");
  }
  const sandboxRuntimeKind = rawRuntime as SandboxRuntimeKind | undefined;
  if (sandboxRuntimeKind !== "runsc") {
    return sandboxRuntimeKind !== undefined ? { sandboxRuntimeKind } : {};
  }
  const sandboxRootfs = atCwd(
    explicit.sandboxRootfs !== undefined
      ? nonEmpty(explicit.sandboxRootfs)
      : nonEmpty(env[SANDBOX_ROOTFS_ENV]),
  );
  const policyNamed = explicit.sandboxCfcPolicy !== undefined;
  const namedPolicy = atCwd(
    policyNamed
      ? nonEmpty(explicit.sandboxCfcPolicy)
      : nonEmpty(env[RUNSC_CFC_POLICY_ENV]),
  );
  const home = nonEmpty(options.homeDir) ?? nonEmpty(env.HOME);
  const defaultPolicy = home !== undefined
    ? join(home, ".local", "share", "runsc-cfc", "cfc-policy.json")
    : undefined;
  const sandboxCfcPolicy = namedPolicy ??
    (!policyNamed && defaultPolicy !== undefined &&
        await pathExists(defaultPolicy)
      ? defaultPolicy
      : undefined);
  const sandboxRunscBinary = nonEmpty(env[RUNSC_BINARY_ENV]);
  const rawNetwork = nonEmpty(env[SANDBOX_NETWORK_MODE_ENV]);
  if (
    rawNetwork !== undefined &&
    rawNetwork !== "none" && rawNetwork !== "bridge" && rawNetwork !== "host"
  ) {
    // The docker path refuses this value when it builds its sandbox; the
    // runsc path must not read it as "no network" instead.
    throw new Error(
      `${SANDBOX_NETWORK_MODE_ENV} must be one of none, bridge, or host`,
    );
  }
  // The docker network vocabulary maps onto runsc's: none stays none, bridge
  // is runsc's own netstack, host is the host's stack.
  const sandboxRunscNetworkMode: RunscNetworkMode | undefined =
    rawNetwork === "none"
      ? "none"
      : rawNetwork === "host"
      ? "host"
      : rawNetwork === "bridge"
      ? "sandbox"
      : undefined;
  return {
    sandboxRuntimeKind,
    ...(sandboxRootfs !== undefined ? { sandboxRootfs } : {}),
    ...(sandboxCfcPolicy !== undefined ? { sandboxCfcPolicy } : {}),
    ...(sandboxRunscBinary !== undefined ? { sandboxRunscBinary } : {}),
    ...(sandboxRunscNetworkMode !== undefined
      ? { sandboxRunscNetworkMode }
      : {}),
  };
};
