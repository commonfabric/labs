/**
 * Sandbox runtime selection, shared by every cf-harness entrypoint: the batch
 * CLI, the interactive stdio host, the Loom local host, and the console and
 * its launcher all derive the runtime here, so runs started from one
 * environment execute in the same sandbox.
 *
 * A flag or `CF_HARNESS_SANDBOX_RUNTIME` names the runtime. Where neither
 * does, the platform decides. On macOS that is the native `runsc` runtime,
 * taken from the cfc-vm store and refused where the store cannot provide it.
 * On every other platform it is Docker, because the native runtime is the
 * macOS `runsc`, which runs in a VM only that platform has. Nothing here
 * falls back from one runtime to the other.
 *
 * The docker runtime reads its own environment (image, docker runtime,
 * network mode) where it builds its sandbox; only the runsc runtime needs
 * the selection carried in as engine options, because nothing else runs
 * runsc directly.
 */

import { isAbsolute, join, resolve } from "@std/path";

import { HarnessControlError } from "../control-errors.ts";
import {
  DARWIN_CFC_VM_IMAGE_KEY,
  darwinCfcVmRootfs,
  darwinCfcVmStore,
  type RunscNetworkMode,
} from "./runsc.ts";
import type { SandboxRuntimeChoice, SandboxRuntimeKind } from "./types.ts";

export type { SandboxRuntimeChoice, SandboxRuntimeKind };

/** Engine options naming which runtime executes a run, and how. */
export interface SandboxRuntimeSelection {
  /** Absent where Docker is the default and nothing named a runtime. */
  sandboxRuntimeKind?: SandboxRuntimeKind;

  sandboxRootfs?: string;
  sandboxCfcPolicy?: string;
  sandboxRunscBinary?: string;
  sandboxRunscNetworkMode?: RunscNetworkMode;

  /** How the runtime was selected, which the run records beside it. */
  sandboxRuntimeChoice: SandboxRuntimeChoice;
}

/**
 * Values a caller received explicitly (a flag), which win over the
 * environment. A present value takes part even when it is empty: an empty
 * runtime is refused, and an empty rootfs or policy means "none" (for the
 * policy that includes every default).
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

/** Names the macOS cfc-vm store, for the macOS `runsc` and for this module. */
export const CFC_VM_HOME_ENV = "CFC_VM_HOME";

/** The batch CLI's flag naming the runtime. */
export const SANDBOX_RUNTIME_FLAG = "--sandbox-runtime";

/** The batch CLI's flag naming the runsc runtime's CFC policy. */
export const SANDBOX_CFC_POLICY_FLAG = "--sandbox-cfc-policy";

/** The platform, as `Deno.build.os` writes it, whose default is native. */
export const NATIVE_RUNTIME_PLATFORM = "darwin";

const nonEmpty = (input: string | undefined): string | undefined => {
  const trimmed = input?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const regularFileExists = (path: string): Promise<boolean> =>
  Deno.stat(path).then((info) => info.isFile).catch(() => false);

export interface SandboxRuntimeSelectionOptions {
  /**
   * Platform whose default applies where nothing names a runtime, as
   * `Deno.build.os` writes it. Required, so that an entrypoint states which
   * platform it runs on instead of inheriting one by omission.
   */
  platform: string;

  /**
   * Whether the entrypoint takes the batch CLI's selection flags. A refusal
   * names each flag beside its variable where it does, and the variable
   * alone where it does not.
   */
  flags: boolean;

  /**
   * The home the default CFC policy and the default macOS store are looked up
   * under. An entrypoint that clears `HOME` from the environment it hands on
   * (the Loom local host does) names the real one here; otherwise `env.HOME`
   * is used.
   */
  homeDir?: string;

  /** Relative rootfs and policy paths resolve against this, as other path flags do. */
  cwd?: string;

  /** Whether a regular file exists at `path`; `Deno.stat` when absent. */
  pathExists?: (path: string) => Promise<boolean>;

  /** Looks at one piece of the macOS store; `Deno.stat` when absent. */
  stat?: (path: string) => Promise<Deno.FileInfo>;
}

/** The default CFC policy, which the docker path's installer puts under `home`. */
const homeCfcPolicy = (home: string): string =>
  join(home, ".local", "share", "runsc-cfc", "cfc-policy.json");

/** The CFC policy the macOS store's installer puts in `store`. */
export const nativeStoreCfcPolicy = (store: string): string =>
  join(store, "policy.json");

/** The `runsc` shim the macOS store's installer puts in `store`. */
export const nativeStoreRunscBinary = (store: string): string =>
  join(store, "bin", "runsc");

/** One file or directory the native runtime needs its store to hold. */
interface NativeStorePiece {
  /** Path of the piece, relative to the store. */
  path: string;

  /** What the piece is, as a refusal names it. */
  what: string;

  /** What has to be at the path for the piece to be there. */
  kind: "executable file" | "file" | "directory";
}

/**
 * The pieces a defaulted native runtime takes from its store, less those the
 * caller named in their place. `binaryNamed` drops the shim and the daemon
 * the shim starts from beside itself, and `rootfsNamed` drops the image.
 */
const nativeStorePieces = (
  binaryNamed: boolean,
  rootfsNamed: boolean,
): NativeStorePiece[] => [
  ...(binaryNamed ? [] : [
    {
      path: join("bin", "runsc"),
      what: "the `runsc` shim",
      kind: "executable file" as const,
    },
    {
      path: join("bin", "cfc-vm"),
      what: "the VM daemon the shim starts",
      kind: "executable file" as const,
    },
  ]),
  {
    path: "config.json",
    what: "the VM's configuration",
    kind: "file",
  },
  ...(rootfsNamed ? [] : [
    {
      path: join("images", DARWIN_CFC_VM_IMAGE_KEY),
      what: "the rootfs a container names",
      kind: "directory" as const,
    },
    {
      path: join("ext4", `${DARWIN_CFC_VM_IMAGE_KEY}.ext4`),
      what: "the image that rootfs runs from",
      kind: "file" as const,
    },
  ]),
];

/**
 * Helper for `resolveSandboxRuntimeSelection()`, which returns what keeps
 * `piece` of `store` from being there, or `undefined` where it is there. A
 * piece that cannot be looked at is not there, and the reason is returned.
 */
const nativeStorePieceProblem = async (
  store: string,
  piece: NativeStorePiece,
  stat: (path: string) => Promise<Deno.FileInfo>,
): Promise<string | undefined> => {
  const named = `\`${piece.path}\`, ${piece.what},`;
  let info: Deno.FileInfo;
  try {
    info = await stat(join(store, piece.path));
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? `${named} is missing`
      : `${named} could not be examined (${error})`;
  }
  const there = piece.kind === "directory" ? info.isDirectory : info.isFile &&
    (piece.kind === "file" || ((info.mode ?? 0) & 0o111) !== 0);
  return there
    ? undefined
    : `${named} is not ${
      piece.kind === "executable file" ? "an" : "a"
    } ${piece.kind}`;
};

/**
 * Helper for `resolveSandboxRuntimeSelection()`, which builds the refusal of
 * a default that cannot be provided. It says that the native runtime is the
 * default, what keeps it from being used, and how Docker is selected, in the
 * vocabulary of an entrypoint that does or does not take `flags`.
 */
const nativeDefaultRefusal = (
  problem: string,
  remedy: string,
  flags: boolean,
): HarnessControlError =>
  new HarnessControlError(
    "invalid-request",
    "No sandbox runtime is named, so the default applies, which on macOS is " +
      `the native \`runsc\` runtime, and ${problem}. ${remedy}, or select ` +
      `Docker with ${
        flags ? `\`${SANDBOX_RUNTIME_FLAG} docker\` or ` : ""
      }\`${SANDBOX_RUNTIME_ENV}=docker\`.`,
  );

/**
 * Derives the runtime selection from explicit values and the environment.
 *
 * A named `docker`, and the Docker default of every platform but macOS, return
 * no companion: the companions describe the runsc runtime alone, and a docker
 * run must hand the engine exactly what it would with no selection at all.
 *
 * Where nothing names a runtime on macOS, the selection is the native `runsc`
 * runtime, from the store `CFC_VM_HOME` names or else the default one under
 * the home. The `runsc` binary is the store's shim, the rootfs is the store's
 * image, and the CFC policy is the default one under the home or else the
 * store's own. A companion that is named replaces the store's, as it does for
 * a named `runsc`.
 *
 * For a named `runsc` the default CFC policy is the one the docker path's
 * installer puts under the home, so both runtimes label the same files the
 * same way. It is looked up only when nothing named one (an explicit empty
 * value means "none" and is not overridden by a default), and only taken when
 * it is there.
 *
 * @throws HarnessControlError where nothing names a runtime on macOS and the
 * native runtime cannot be provided: the store cannot be located, a piece the
 * selection would take from it is not there, or no CFC policy is found and
 * none was named. The message names the store, each thing in the way, and
 * how Docker is selected.
 * @throws Error when the runtime or the network mode is not one of its values.
 */
export const resolveSandboxRuntimeSelection = async (
  env: Record<string, string | undefined>,
  explicit: ExplicitSandboxRuntimeSelection,
  options: SandboxRuntimeSelectionOptions,
): Promise<SandboxRuntimeSelection> => {
  const pathExists = options.pathExists ?? regularFileExists;
  const atCwd = (path: string | undefined): string | undefined =>
    path === undefined || options.cwd === undefined || isAbsolute(path)
      ? path
      : resolve(options.cwd, path);
  const rawRuntime = explicit.sandboxRuntime !== undefined
    ? explicit.sandboxRuntime.trim()
    : nonEmpty(env[SANDBOX_RUNTIME_ENV]);
  const named: SandboxRuntimeKind | undefined =
    rawRuntime === "docker" || rawRuntime === "runsc" ? rawRuntime : undefined;
  if (rawRuntime !== undefined && named === undefined) {
    throw new Error("sandbox runtime must be one of docker, runsc");
  }
  const namedBy = explicit.sandboxRuntime !== undefined
    ? "flag"
    : "environment";
  if (named === "docker") {
    return {
      sandboxRuntimeKind: named,
      sandboxRuntimeChoice: { runtime: named, source: namedBy },
    };
  }
  // The platform is the whole of the reason: the native runtime is the macOS
  // `runsc`, and no other platform has the VM it runs in.
  const nativeDefault = named === undefined &&
    options.platform === NATIVE_RUNTIME_PLATFORM;
  if (named === undefined && !nativeDefault) {
    return {
      sandboxRuntimeChoice: {
        runtime: "docker",
        source: "default",
        platform: options.platform,
      },
    };
  }

  const home = nonEmpty(options.homeDir) ?? nonEmpty(env.HOME);
  let nativeStore: string | undefined;
  if (nativeDefault) {
    nativeStore = darwinCfcVmStore(env[CFC_VM_HOME_ENV], home);
    if (nativeStore === undefined) {
      throw nativeDefaultRefusal(
        `its store cannot be located: neither \`${CFC_VM_HOME_ENV}\` nor ` +
          "`HOME` is set",
        `Set \`${CFC_VM_HOME_ENV}\` to the store`,
        options.flags,
      );
    }
    if (!isAbsolute(nativeStore)) {
      // The macOS `runsc` resolves the same name against its own working
      // directory, which need not be this selection's.
      throw nativeDefaultRefusal(
        `its store cannot be located: \`${nativeStore}\` is not an ` +
          "absolute path",
        `Set \`${CFC_VM_HOME_ENV}\` to the store's absolute path`,
        options.flags,
      );
    }
  }

  const namedRootfs = atCwd(
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
  const namedBinary = nonEmpty(env[RUNSC_BINARY_ENV]);
  // In the order they are taken. The store's own policy is a default of the
  // native runtime alone: a named `runsc` is given exactly what it names.
  const defaultPolicies = [
    ...(home !== undefined ? [homeCfcPolicy(home)] : []),
    ...(nativeStore !== undefined ? [nativeStoreCfcPolicy(nativeStore)] : []),
  ];
  let sandboxCfcPolicy = namedPolicy;
  if (sandboxCfcPolicy === undefined && !policyNamed) {
    for (const candidate of defaultPolicies) {
      if (await pathExists(candidate)) {
        sandboxCfcPolicy = candidate;
        break;
      }
    }
  }

  if (nativeStore !== undefined) {
    const stat = options.stat ?? Deno.stat;
    const problems: string[] = [];
    for (
      const piece of nativeStorePieces(
        namedBinary !== undefined,
        namedRootfs !== undefined,
      )
    ) {
      const problem = await nativeStorePieceProblem(nativeStore, piece, stat);
      if (problem !== undefined) problems.push(problem);
    }
    if (sandboxCfcPolicy === undefined && !policyNamed) {
      // The default has to be one a run can start on, and an enforcing run
      // with no CFC policy is refused as it starts.
      problems.push(
        `no CFC policy is at ${
          defaultPolicies.map((path) => `\`${path}\``).join(" or ")
        } (name one with ${
          options.flags ? `\`${SANDBOX_CFC_POLICY_FLAG}\` or ` : ""
        }\`${RUNSC_CFC_POLICY_ENV}\`)`,
      );
    }
    if (problems.length > 0) {
      throw nativeDefaultRefusal(
        `it is not set up at \`${nativeStore}\`: ${problems.join("; ")}`,
        "Set it up there",
        options.flags,
      );
    }
  }

  const sandboxRootfs = namedRootfs ??
    (nativeStore !== undefined ? darwinCfcVmRootfs(nativeStore) : undefined);
  const sandboxRunscBinary = namedBinary ??
    (nativeStore !== undefined
      ? nativeStoreRunscBinary(nativeStore)
      : undefined);
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
    sandboxRuntimeKind: "runsc",
    ...(sandboxRootfs !== undefined ? { sandboxRootfs } : {}),
    ...(sandboxCfcPolicy !== undefined ? { sandboxCfcPolicy } : {}),
    ...(sandboxRunscBinary !== undefined ? { sandboxRunscBinary } : {}),
    ...(sandboxRunscNetworkMode !== undefined
      ? { sandboxRunscNetworkMode }
      : {}),
    sandboxRuntimeChoice: nativeStore !== undefined
      ? {
        runtime: "runsc",
        source: "default",
        platform: options.platform,
        nativeStore,
      }
      : { runtime: "runsc", source: namedBy },
  };
};

/**
 * Returns how `choice` came to its runtime, for an operator: the flag or
 * variable that named it, or the platform default that selected it, with the
 * store a defaulted native runtime runs from.
 */
export const sandboxRuntimeChoiceReason = (
  choice: SandboxRuntimeChoice,
): string => {
  if (choice.source !== "default") {
    return `named by ${
      choice.source === "flag" ? SANDBOX_RUNTIME_FLAG : SANDBOX_RUNTIME_ENV
    }`;
  }
  return choice.runtime === "runsc"
    ? `default on macOS: the native store at ${choice.nativeStore}`
    : `default on ${choice.platform}: the native runtime is macOS only`;
};

/**
 * Describes `choice` for an operator: the runtime, and in parentheses how it
 * came to be selected, as `sandboxRuntimeChoiceReason()` returns it.
 */
export const describeSandboxRuntimeChoice = (
  choice: SandboxRuntimeChoice,
): string => `${choice.runtime} (${sandboxRuntimeChoiceReason(choice)})`;
