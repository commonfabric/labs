/**
 * Host bind-mount provisioning, shared by every cf-harness entrypoint.
 *
 * This lives here rather than in `cli.ts` because it used to live there, and
 * that is exactly how the interactive chat entrypoint ended up with no way to
 * mount anything. The batch CLI parsed `--host-mount` and handed the result to
 * the engine; the interactive stdio host, a different entrypoint over the same
 * engine, had no equivalent — so an embedder could provision a batch run and
 * not a chat session, with nothing in the types to say why.
 *
 * There is one spec grammar and one parser. Adding an entrypoint means calling
 * `parseHostMountSpecs` and passing `hostMountsToAdditionalMounts` to the
 * engine; it must not mean inventing a second way in.
 */

import {
  type HarnessLoomAuthoringConfig,
  readLoomAuthoringConfig,
} from "./loom-authoring.ts";
import { dirname, isAbsolute, resolve } from "@std/path";
import {
  isAbsolute as isAbsoluteSandboxPath,
  normalize as normalizeSandboxPath,
} from "@std/path/posix";

import type { HarnessFabricSessionConfig } from "./config.ts";
import {
  resolveSandboxRuntimeSelection,
  type SandboxRuntimeSelection,
} from "./sandbox/runtime-selection.ts";
import type { DockerRunscAdditionalMountConfig } from "./sandbox/types.ts";

export type CfHarnessHostMountMode = "readonly" | "writable";

export interface CfHarnessHostMountConfig {
  name: string;
  hostPath: string;
  sandboxPath: string;
  mode: CfHarnessHostMountMode;
}

const HOST_MOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const normalizeSandboxMountPath = (path: string, label: string): string => {
  const normalized = normalizeSandboxPath(path);
  if (!isAbsoluteSandboxPath(normalized) || normalized === "/") {
    throw new Error(`${label} must be an absolute non-root sandbox path`);
  }
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const HOST_MOUNT_FIELDS = new Set(["name", "source", "target", "mode"]);

const parseHostMountSpecParts = (spec: string): Record<string, string> => {
  const parts: Record<string, string> = {};
  for (const segment of spec.split(",")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      throw new Error(
        "--host-mount entries must use key=value comma-separated fields",
      );
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new Error("--host-mount fields require non-empty keys and values");
    }
    if (parts[key] !== undefined) {
      throw new Error(`--host-mount field repeated: ${key}`);
    }
    // Reject unknown keys rather than ignoring them. A typo like `mdoe=writable`
    // would otherwise fall through to the readonly default and provision a
    // mount the caller believes is writable — a silent capability difference,
    // which is the failure mode this whole module exists to stop.
    if (!HOST_MOUNT_FIELDS.has(key)) {
      throw new Error(
        `--host-mount field unknown: ${key} (expected name, source, target, or mode)`,
      );
    }
    parts[key] = value;
  }
  return parts;
};

const realPathIfDirectory = async (
  path: string,
  label: string,
): Promise<string> => {
  let realPath: string;
  try {
    realPath = await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`${label} must exist: ${path}`);
    }
    throw error;
  }
  const stat = await Deno.stat(realPath);
  if (!stat.isDirectory) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
  if (realPath === dirname(realPath)) {
    throw new Error(`${label} must not be the filesystem root`);
  }
  return realPath;
};

const parseHostMountSpec = async (
  spec: string,
  cwd: string,
): Promise<CfHarnessHostMountConfig> => {
  if (spec.trim().length === 0) {
    throw new Error("--host-mount requires a non-empty spec");
  }
  const parts = parseHostMountSpecParts(spec);
  const name = parts.name;
  const source = parts.source;
  const target = parts.target;
  const mode = parts.mode ?? "readonly";
  if (name === undefined || source === undefined || target === undefined) {
    throw new Error("--host-mount requires name, source, and target fields");
  }
  if (!HOST_MOUNT_NAME_PATTERN.test(name)) {
    throw new Error(
      "--host-mount name must start with an alphanumeric character and contain only alphanumerics, dot, underscore, or dash",
    );
  }
  if (mode !== "readonly" && mode !== "writable") {
    throw new Error("--host-mount mode must be readonly or writable");
  }
  return {
    name,
    hostPath: await realPathIfDirectory(
      isAbsolute(source) ? resolve(source) : resolve(cwd, source),
      "--host-mount source",
    ),
    sandboxPath: normalizeSandboxMountPath(target, "--host-mount target"),
    mode,
  };
};

/** Parse repeated `--host-mount` specs. Names must be unique within a run. */
export const parseHostMountSpecs = async (
  input: string | readonly string[] | undefined,
  cwd: string,
): Promise<readonly CfHarnessHostMountConfig[]> => {
  const specs = input === undefined
    ? []
    : Array.isArray(input)
    ? input
    : [input as string];
  const mounts = await Promise.all(
    specs.map((spec) => parseHostMountSpec(spec, cwd)),
  );
  const names = new Set<string>();
  for (const mount of mounts) {
    if (names.has(mount.name)) {
      throw new Error(`--host-mount name repeated: ${mount.name}`);
    }
    names.add(mount.name);
  }
  return mounts;
};

/**
 * Resolves host mounts, Loom tools, the Fabric binding, and the sandbox
 * runtime the environment names into prompt-loop options. Throws when a
 * configured host resource cannot be resolved.
 *
 * `env` is the environment the entrypoint was launched with. The runtime
 * selection (`CF_HARNESS_SANDBOX_RUNTIME` and its companions) is derived the
 * way the batch CLI derives it, so a chat session and a batch run started
 * from one environment execute in the same sandbox; the parameter is
 * required so a new entrypoint cannot forget it the way this one did.
 */
export const resolveInteractiveProvisioning = async (
  parsed: {
    hostMountSpecs?: readonly string[];
    fabricSession?: HarnessFabricSessionConfig;
    loomAuthoringConfigPath?: string;
    maxModelTurns?: number;
  },
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<
  {
    additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
    fabricSession?: HarnessFabricSessionConfig;
    loomAuthoring?: HarnessLoomAuthoringConfig;
    maxModelTurns?: number;
  } & SandboxRuntimeSelection
> => {
  const loomAuthoring = await readLoomAuthoringConfig(
    parsed.loomAuthoringConfigPath,
  );
  const mounts = hostMountsToAdditionalMounts(
    await parseHostMountSpecs(parsed.hostMountSpecs, cwd),
  );
  const runtime = await resolveSandboxRuntimeSelection(env);
  return {
    ...runtime,
    ...(mounts.length > 0 ? { additionalMounts: mounts } : {}),
    ...(parsed.fabricSession !== undefined
      ? { fabricSession: parsed.fabricSession }
      : {}),
    ...(loomAuthoring !== undefined ? { loomAuthoring } : {}),
    ...(parsed.maxModelTurns !== undefined
      ? { maxModelTurns: parsed.maxModelTurns }
      : {}),
  };
};

/** Engine-shaped mounts. The only supported way to get bind mounts into a run. */
export const hostMountsToAdditionalMounts = (
  mounts: readonly CfHarnessHostMountConfig[],
): readonly DockerRunscAdditionalMountConfig[] =>
  mounts.map((mount) => ({
    kind: "host-bind" as const,
    name: mount.name,
    hostPath: mount.hostPath,
    sandboxPath: mount.sandboxPath,
    readOnly: mount.mode === "readonly",
  }));
