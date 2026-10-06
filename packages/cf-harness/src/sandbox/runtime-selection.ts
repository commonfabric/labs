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
 * falls back from one runtime to the other. An entrypoint whose caller must
 * name the runtime takes no default at all, and refuses a run that names
 * none.
 *
 * The docker runtime reads its own environment (image, docker runtime,
 * network mode) where it builds its sandbox; only the runsc runtime needs
 * the selection carried in as engine options, because nothing else runs
 * runsc directly.
 */

import { isAbsolute, join, resolve } from "@std/path";

import {
  HarnessControlError,
  harnessResumeRefusal,
} from "../control-errors.ts";
import {
  CFC_INVOCATION_CONTEXT_DIR_ENV,
  CFC_RESULT_DIR_ENV,
} from "./docker-runsc.ts";
import {
  canonicalHostPath,
  DARWIN_CFC_VM_IMAGE_KEY,
  darwinCfcVmRootfs,
  darwinCfcVmStore,
  type RunscNetworkMode,
} from "./runsc.ts";
import type {
  SandboxPlatform,
  SandboxRuntimeChoice,
  SandboxRuntimeKind,
} from "./types.ts";

export type { SandboxPlatform, SandboxRuntimeChoice, SandboxRuntimeKind };

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
 * runtime is refused, an empty policy means "none", every default included,
 * and an empty rootfs names none, which the macOS default refuses, since its
 * runtime runs only from one. A named `runsc` given an empty rootfs is left
 * to its driver's own default. An empty variable names nothing, and the
 * default applies as though it were unset.
 */
export interface ExplicitSandboxRuntimeSelection {
  sandboxRuntime?: string;
  sandboxRootfs?: string;
  sandboxCfcPolicy?: string;

  /**
   * The Docker driver's flags the caller was given, by name and never by
   * value. A runtime the platform defaulted to the native one refuses them.
   */
  dockerDriverFlags?: readonly DockerDriverFlag[];
}

// Each variable below is declared in this file, as a literal on a line of
// this shape. Loom reads its vendored copy of the file for exactly such lines
// and compares the names with the ones it hands the harness, so a name
// declared in another module and exported from here is one it does not find.

/** Names the sandbox runtime, `docker` or `runsc`, for every entrypoint. */
export const SANDBOX_RUNTIME_ENV = "CF_HARNESS_SANDBOX_RUNTIME";
export const SANDBOX_ROOTFS_ENV = "CF_HARNESS_SANDBOX_ROOTFS";
export const RUNSC_CFC_POLICY_ENV = "CF_HARNESS_RUNSC_CFC_POLICY";
export const RUNSC_BINARY_ENV = "CF_HARNESS_RUNSC_BINARY";
/** Shared with the docker runtime; the vocabulary is docker's. */
export const SANDBOX_NETWORK_MODE_ENV = "CF_HARNESS_DOCKER_NETWORK_MODE";

/** Names the macOS cfc-vm store, for the macOS `runsc` and for this module. */
export const CFC_VM_HOME_ENV = "CFC_VM_HOME";

/** Names the Docker driver's image. */
export const SANDBOX_IMAGE_ENV = "CF_HARNESS_SANDBOX_IMAGE";

/** Names the Docker-registered runtime the Docker driver runs under. */
export const SANDBOX_DOCKER_RUNTIME_ENV = "CF_HARNESS_SANDBOX_DOCKER_RUNTIME";

/** The batch CLI's flag naming the runtime. */
export const SANDBOX_RUNTIME_FLAG = "--sandbox-runtime";

/** The batch CLI's flag naming the runsc runtime's CFC policy. */
export const SANDBOX_CFC_POLICY_FLAG = "--sandbox-cfc-policy";

/**
 * The Docker driver's own settings, each batch CLI flag beside the variable
 * that sets the same thing. The direct driver reads none of them.
 */
export const DOCKER_DRIVER_SETTINGS = [
  { flag: "--sandbox-image", variable: SANDBOX_IMAGE_ENV },
  { flag: "--sandbox-docker-runtime", variable: SANDBOX_DOCKER_RUNTIME_ENV },
  { flag: "--cfc-result-dir", variable: CFC_RESULT_DIR_ENV },
  {
    flag: "--cfc-invocation-context-dir",
    variable: CFC_INVOCATION_CONTEXT_DIR_ENV,
  },
] as const;

/** One of the Docker driver's flags on the batch CLI. */
export type DockerDriverFlag = (typeof DOCKER_DRIVER_SETTINGS)[number]["flag"];

/**
 * Every variable the selection reads. An entrypoint that hands the selection
 * a narrowed environment hands it all of these.
 */
export const SANDBOX_SELECTION_ENV: readonly string[] = [
  "HOME",
  SANDBOX_RUNTIME_ENV,
  SANDBOX_ROOTFS_ENV,
  RUNSC_CFC_POLICY_ENV,
  RUNSC_BINARY_ENV,
  SANDBOX_NETWORK_MODE_ENV,
  CFC_VM_HOME_ENV,
  ...DOCKER_DRIVER_SETTINGS.map((setting) => setting.variable),
];

/** Returns the process's own values of the variables the selection reads. */
export const processSandboxSelectionEnv = (): Record<
  string,
  string | undefined
> =>
  Object.fromEntries(
    SANDBOX_SELECTION_ENV.map((name) => [name, Deno.env.get(name)]),
  );

/** The platform whose default is the native runtime. */
export const NATIVE_RUNTIME_PLATFORM: SandboxPlatform = "darwin";

const nonEmpty = (input: string | undefined): string | undefined => {
  const trimmed = input?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * Returns whether a regular file is at `path`. A path that is not there reads
 * as absent, and so does one that runs through a file, where nothing can be.
 *
 * @throws The error of any other failure to look, which says nothing of
 * whether a file is there.
 */
const regularFileExists = async (path: string): Promise<boolean> => {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) {
      return false;
    }
    throw error;
  }
};

/** What an entrypoint does where nothing names a runtime. */
export type UnnamedSandboxRuntime =
  /**
   * It takes the default of the `platform` it runs on. Required, so that an
   * entrypoint states its platform instead of inheriting one by omission.
   */
  | { platform: SandboxPlatform }
  /**
   * It refuses, on every platform: `namedBy` is the caller that must name the
   * runtime of every run, as the refusal names it.
   */
  | { namedBy: string };

/** How an entrypoint derives its selection. */
export type SandboxRuntimeSelectionOptions = UnnamedSandboxRuntime & {
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

  /**
   * Whether a regular file exists at `path`; `Deno.stat` when absent. It
   * throws where it could not look, which the selection refuses on.
   */
  pathExists?: (path: string) => Promise<boolean>;

  /**
   * Looks at one piece of the macOS store without following a link;
   * `Deno.lstat` when absent.
   */
  lstat?: (path: string) => Promise<Deno.FileInfo>;
};

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

/** What one piece of the macOS store is, as its check found it. */
type NativeStorePieceReading =
  /** It is there, and is what it has to be. */
  | { there: true }
  /** It is not, and `problem` says why. */
  | { there: false; problem: string }
  /** It is a link rather than the thing itself; `problem` names its target. */
  | { there: false; problem: string; linked: true };

/**
 * Helper for `resolveSandboxRuntimeSelection()`, which reads what `piece` of
 * `store` is. A piece that cannot be looked at is not there, and the reason
 * is returned. A piece that is a symbolic link is not there either, whatever
 * it leads to: the driver hands the macOS `runsc` the rootfs and the binary by
 * the paths the file system resolves them to, while that `runsc` knows the
 * store's pieces by their paths in the store, and none of gVisor's installer
 * scripts makes one a link.
 */
const readNativeStorePiece = async (
  store: string,
  piece: NativeStorePiece,
  lstat: (path: string) => Promise<Deno.FileInfo>,
): Promise<NativeStorePieceReading> => {
  const named = `\`${piece.path}\`, ${piece.what},`;
  const path = join(store, piece.path);
  let info: Deno.FileInfo;
  let target: string | undefined;
  try {
    info = await lstat(path);
    if (info.isSymlink) target = await Deno.readLink(path);
  } catch (error) {
    return {
      there: false,
      problem: error instanceof Deno.errors.NotFound
        ? `${named} is missing`
        : `${named} could not be examined (${error})`,
    };
  }
  if (target !== undefined) {
    return {
      there: false,
      problem: `${named} is a symbolic link to \`${target}\``,
      linked: true,
    };
  }
  const there = piece.kind === "directory" ? info.isDirectory : info.isFile &&
    (piece.kind === "file" || ((info.mode ?? 0) & 0o111) !== 0);
  return there ? { there: true } : {
    there: false,
    problem: `${named} is not ${
      piece.kind === "executable file" ? "an" : "a"
    } ${piece.kind}`,
  };
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

/** Helper for the refusals, which names how a CFC policy is named. */
const policyNaming = (flags: boolean): string =>
  `${
    flags ? `\`${SANDBOX_CFC_POLICY_FLAG}\` or ` : ""
  }\`${RUNSC_CFC_POLICY_ENV}\``;

/** Helper for the refusals, which joins `names` as prose: `a`, `b` and `c`. */
const listed = (names: readonly string[]): string =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

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
 * a named `runsc`. The store is returned by the path the file system has for
 * it, which has to be the path it was given by.
 *
 * For a named `runsc` the default CFC policy is the one the docker path's
 * installer puts under the home, so both runtimes label the same files the
 * same way. It is looked up only when nothing named one (an explicit empty
 * value means "none" and is not overridden by a default), and only taken when
 * it is there.
 *
 * @throws HarnessControlError where nothing names a runtime and the entrypoint
 * takes no default; and where nothing names one on macOS and the native
 * runtime cannot be provided: a setting of the Docker driver is given, the
 * store cannot be located or is reached through a link, a piece the selection
 * would take from it is not there, or no CFC policy is found and none was
 * named. Each message says what is in the way and how a runtime is named.
 * Also, for a runtime that is or defaults to `runsc`, where a default CFC
 * policy could not be examined for any reason but its not being there.
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
  if (named === undefined && !("platform" in options)) {
    throw new HarnessControlError(
      "invalid-request",
      "No sandbox runtime is named, and this entrypoint takes no default: " +
        `${options.namedBy} must name \`docker\` or \`runsc\`, with ${
          options.flags ? `\`${SANDBOX_RUNTIME_FLAG}\` or ` : ""
        }\`${SANDBOX_RUNTIME_ENV}\`.`,
    );
  }
  // The platform is the whole of the reason: the native runtime is the macOS
  // `runsc`, and no other platform has the VM it runs in.
  const platform = "platform" in options ? options.platform : undefined;
  const nativeDefault = named === undefined &&
    platform === NATIVE_RUNTIME_PLATFORM;
  if (named === undefined && platform !== undefined && !nativeDefault) {
    return {
      sandboxRuntimeChoice: { runtime: "docker", source: "default", platform },
    };
  }

  const home = nonEmpty(options.homeDir) ?? nonEmpty(env.HOME);
  let nativeStore: string | undefined;
  if (nativeDefault) {
    // Before the store is looked for: whoever gave one of these means Docker,
    // and is told so whatever the store holds.
    const dockerSettings = [
      ...(explicit.dockerDriverFlags ?? []),
      ...DOCKER_DRIVER_SETTINGS.map((setting) => setting.variable).filter((
        variable,
      ) => nonEmpty(env[variable]) !== undefined),
    ].map((name) => `\`${name}\``);
    if (dockerSettings.length > 0) {
      const several = dockerSettings.length > 1;
      throw nativeDefaultRefusal(
        `${listed(dockerSettings)} ${
          several ? "are settings" : "is a setting"
        } of the Docker driver, which the native runtime does not read`,
        `Remove ${several ? "them" : "it"}`,
        options.flags,
      );
    }
    const given = darwinCfcVmStore(env[CFC_VM_HOME_ENV], home);
    if (given === undefined) {
      throw nativeDefaultRefusal(
        `its store cannot be located: neither \`${CFC_VM_HOME_ENV}\` nor ` +
          "`HOME` is set",
        `Set \`${CFC_VM_HOME_ENV}\` to the store`,
        options.flags,
      );
    }
    if (!isAbsolute(given)) {
      // The macOS `runsc` resolves the same name against its own working
      // directory, which need not be this selection's.
      throw nativeDefaultRefusal(
        `its store cannot be located: \`${given}\` is not an ` +
          "absolute path",
        `Set \`${CFC_VM_HOME_ENV}\` to the store's absolute path`,
        options.flags,
      );
    }
    // The driver hands the macOS `runsc` the rootfs by the path the file
    // system has for it, and that `runsc` tells one of its store's images by
    // comparing the path, as written, with the store's own as it was given.
    // So a store given by any other path than the one it is at runs nothing.
    const written = resolve(given);
    let canonical: string;
    try {
      canonical = canonicalHostPath("the native store", written);
    } catch (error) {
      throw nativeDefaultRefusal(
        `its store cannot be located: ${
          error instanceof Error ? error.message : String(error)
        }`,
        `Set \`${CFC_VM_HOME_ENV}\` to the path the store is at`,
        options.flags,
      );
    }
    if (canonical !== written) {
      throw nativeDefaultRefusal(
        `its store \`${written}\` resolves to \`${canonical}\`, which the ` +
          "macOS `runsc` reads as another path: it compares paths as they " +
          "are written",
        `Set \`${CFC_VM_HOME_ENV}\` to \`${canonical}\``,
        options.flags,
      );
    }
    nativeStore = written;
  }

  const namedRootfs = atCwd(
    explicit.sandboxRootfs !== undefined
      ? nonEmpty(explicit.sandboxRootfs)
      : nonEmpty(env[SANDBOX_ROOTFS_ENV]),
  );
  if (
    nativeStore !== undefined && explicit.sandboxRootfs !== undefined &&
    namedRootfs === undefined
  ) {
    // Named, and named as nothing: the store's image does not stand in for
    // a rootfs someone said there is none of.
    throw nativeDefaultRefusal(
      "`--sandbox-rootfs` is given empty, which names no rootfs, where that " +
        "runtime runs only from one",
      "Name a rootfs, or leave the flag out to run from the store's own image",
      options.flags,
    );
  }
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
      let found: boolean;
      try {
        found = await pathExists(candidate);
      } catch (error) {
        // Not known to be absent, so the next default does not stand in for
        // it, and the selection does not go on as though there were none.
        const unexamined = `CFC policy at \`${candidate}\` could not be ` +
          `examined (${error}), so whether it is there is not known`;
        const remedy = `Make it readable or name a policy with ${
          policyNaming(options.flags)
        }`;
        throw nativeStore !== undefined
          ? nativeDefaultRefusal(`the ${unexamined}`, remedy, options.flags)
          : new HarnessControlError(
            "invalid-request",
            `The ${unexamined}. ${remedy}.`,
          );
      }
      if (found) {
        sandboxCfcPolicy = candidate;
        break;
      }
    }
  }

  if (nativeStore !== undefined) {
    const lstat = options.lstat ?? Deno.lstat;
    const pieces = nativeStorePieces(
      namedBinary !== undefined,
      namedRootfs !== undefined,
    );
    const problems: string[] = [];
    let linked = false;
    for (const piece of pieces) {
      const reading = await readNativeStorePiece(nativeStore, piece, lstat);
      if (reading.there) continue;
      problems.push(reading.problem);
      if ("linked" in reading) linked = true;
    }
    if (linked) {
      problems.push(
        `each of ${
          listed(pieces.map((piece) => `\`${piece.path}\``))
        } has to be the file or directory itself, as gVisor's installer ` +
          "writes it, and not a link to one",
      );
    }
    if (sandboxCfcPolicy === undefined && !policyNamed) {
      // The default has to be one a run can start on, and an enforcing run
      // with no CFC policy is refused as it starts.
      problems.push(
        `no CFC policy is at ${
          defaultPolicies.map((path) => `\`${path}\``).join(" or ")
        } (name one with ${policyNaming(options.flags)})`,
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
        platform: NATIVE_RUNTIME_PLATFORM,
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

/**
 * Returns what the direct driver adds to its refusal of a file that a
 * writable mount holds, for a runtime `choice` says nobody named: that the
 * native runtime was the default, where its store is, and how Docker is
 * selected. `undefined` for a runtime that was named, and for no record of
 * the choice. It names the variable alone, which every entrypoint reads,
 * since the driver's refusal reaches the operators of all of them.
 */
export const unnamedRuntimeMountNote = (
  choice: SandboxRuntimeChoice | undefined,
): string | undefined =>
  choice?.source === "default" && choice.runtime === "runsc"
    ? "No sandbox runtime is named, so this is the native `runsc` runtime " +
      `that macOS defaults to, from the store at \`${choice.nativeStore}\`: ` +
      "run with a workspace and mounts that hold none of it, or select " +
      `Docker with \`${SANDBOX_RUNTIME_ENV}=docker\`.`
    : undefined;

/**
 * Returns the runtime, as an entrypoint names it, that describes itself as
 * `kind`, or `undefined` for a kind this build does not know. A run records
 * the kind, and an operator names the runtime.
 */
export const sandboxRuntimeOfKind = (
  kind: string,
): SandboxRuntimeKind | undefined =>
  kind === "runsc-cfc"
    ? "runsc"
    : kind === "docker-runsc-cfc"
    ? "docker"
    : undefined;

/**
 * Returns the runtime an engine built with `options` executes on: the one it
 * is handed where it is handed one, and otherwise the one it builds, which is
 * Docker unless `runsc` is named.
 *
 * @throws Error where the runtime handed in describes itself as a kind this
 * build does not know.
 */
export const sandboxRuntimeOfOptions = (
  options: {
    sandboxRuntime?: { describe(): { kind: string } };
    sandboxRuntimeKind?: SandboxRuntimeKind;
  },
): SandboxRuntimeKind => {
  if (options.sandboxRuntime === undefined) {
    return options.sandboxRuntimeKind ?? "docker";
  }
  const { kind } = options.sandboxRuntime.describe();
  const runtime = sandboxRuntimeOfKind(kind);
  if (runtime === undefined) {
    throw new Error(
      `the sandbox runtime handed in describes itself as \`${kind}\`, ` +
        "which is no kind of runtime this cf-harness knows",
    );
  }
  return runtime;
};

/**
 * Returns the runtime a run's state records the run started on, or
 * `undefined` where it records none. That is the runtime the state names,
 * which every engine writes as it is built. A state written before engines
 * did so names none, and its runtime is the kind its capability snapshot
 * describes, where a first probe of the sandbox left one.
 *
 * The state is read from a file another build may have written, so what it
 * names is checked rather than trusted to be one of the two.
 *
 * @throws HarnessControlError, a resume refusal, where the state names a
 * runtime, or describes a kind of one, that this build does not know: a
 * resume cannot be held to a runtime it cannot tell from its own.
 */
export const recordedSandboxRuntime = (
  runState: {
    sandboxRuntime?: string;
    capabilitySnapshot?: { cfc?: { sandbox?: { kind: string } } };
  },
): SandboxRuntimeKind | undefined => {
  const unknown = (recorded: string): HarnessControlError =>
    harnessResumeRefusal(
      "resume sandbox runtime unknown: the run records that it started on " +
        `the sandbox runtime \`${recorded}\`, which this cf-harness does not ` +
        "know, so it cannot tell whether this resume is on the same one. " +
        "Resume it with the cf-harness that wrote the record.",
    );
  const named = runState.sandboxRuntime;
  if (named !== undefined) {
    if (named === "docker" || named === "runsc") return named;
    throw unknown(named);
  }
  const kind = runState.capabilitySnapshot?.cfc?.sandbox?.kind;
  if (kind === undefined) return undefined;
  const runtime = sandboxRuntimeOfKind(kind);
  if (runtime === undefined) throw unknown(kind);
  return runtime;
};

/**
 * Builds the refusal of a resume on another runtime than its run started on.
 *
 * Each runtime's `runsc` decides where the CFC labels of a run's files are
 * kept, and the two need not agree. Under Docker Desktop on macOS they are in
 * a directory the Docker runtime's registration names, since Docker's file
 * share takes no extended attribute, and the native runtime keeps them as
 * extended attributes of the host's files. A file one of them labelled then
 * reads as unlabelled under the other, and a run carried across would read
 * what it withheld as public. The harness does not know which hosts agree,
 * so it refuses every such resume.
 *
 * `recorded` is the runtime the run started on. `selected` is the runtime the
 * resume would run on, with how it was selected where that is known. The
 * message names the recorded runtime and how to name it: by the flag and the
 * variable where `flags` are taken, and by the variable alone where not.
 */
export const sandboxRuntimeResumeRefusal = (
  recorded: SandboxRuntimeKind,
  selected: SandboxRuntimeKind | SandboxRuntimeChoice,
  flags: boolean,
): HarnessControlError =>
  harnessResumeRefusal(
    `resume sandbox runtime mismatch: the run started on \`${recorded}\`, ` +
      `and this resume selects ${
        typeof selected === "string"
          ? `\`${selected}\``
          : `\`${selected.runtime}\` (${sandboxRuntimeChoiceReason(selected)})`
      }. The two need not keep the CFC labels of a run's files where the ` +
      "other reads them, and on macOS they do not, so a run resumes only on " +
      `the runtime it started on: name it with ${
        flags ? `\`${SANDBOX_RUNTIME_FLAG} ${recorded}\` or ` : ""
      }\`${SANDBOX_RUNTIME_ENV}=${recorded}\`.`,
  );
