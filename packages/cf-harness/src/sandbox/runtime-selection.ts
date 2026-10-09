/**
 * Sandbox runtime selection, shared by every cf-harness entrypoint: the batch
 * CLI, the interactive stdio host, the Loom local host, and the console and
 * its launcher all derive the runtime here, so runs started from one
 * environment execute in the same sandbox.
 *
 * There is one sandbox runtime, `runsc`, the direct driver, and a flag or
 * `CF_HARNESS_SANDBOX_RUNTIME` may name it. Where neither does, the platform
 * decides. On macOS and Linux that is the native `runsc` runtime, taken from
 * the platform's store and refused where the store cannot provide it: on
 * macOS the cfc-vm store, whose VM runs on Apple silicon alone, and on Linux
 * the store gVisor's Linux installer writes, whose `runsc` runs as it is for
 * root and with `--rootless` for any other user, where the host allows that
 * user a user namespace. Every other platform has no default, and refuses a
 * run that names no runtime. So does an entrypoint whose caller must name the
 * runtime. `docker`, the name of a Docker driver this cf-harness does not
 * have, is refused wherever it is named or recorded.
 */

import { isAbsolute, join, resolve } from "@std/path";

import {
  HarnessControlError,
  harnessResumeRefusal,
} from "../control-errors.ts";
import {
  canonicalHostPath,
  DARWIN_CFC_VM_IMAGE_KEY,
  darwinCfcVmRootfs,
  darwinCfcVmStore,
  executableOnPath,
  LINUX_RUNSC_IMAGE_KEY,
  linuxRunscRootfs,
  linuxRunscStore,
  type RunscNetworkMode,
} from "./runsc.ts";
import type {
  NativeRuntimePlatform,
  SandboxArch,
  SandboxPlatform,
  SandboxRuntimeChoice,
  SandboxRuntimeKind,
} from "./types.ts";

export type {
  SandboxArch,
  SandboxPlatform,
  SandboxRuntimeChoice,
  SandboxRuntimeKind,
};

/** Engine options naming which runtime executes a run, and how. */
export interface SandboxRuntimeSelection {
  sandboxRuntimeKind: SandboxRuntimeKind;

  sandboxRootfs?: string;
  sandboxCfcPolicy?: string;
  sandboxRunscBinary?: string;
  sandboxRunscNetworkMode?: RunscNetworkMode;

  /**
   * Whether runsc runs with `--rootless`: the Linux default for a process
   * that is not root. Absent otherwise.
   */
  sandboxRunscRootless?: true;

  /**
   * The `pasta` that gives a container of the Linux default its `sandbox`
   * network. Absent otherwise.
   */
  sandboxRunscNetworkHelper?: string;

  /**
   * The `unshare` that gives root's pasta a mount namespace of its own, beside
   * `sandboxRunscNetworkHelper` for a Linux default run by root.
   */
  sandboxRunscUnshare?: string;

  /**
   * The `setpriv` that ties what pasta runs to pasta, beside
   * `sandboxRunscNetworkHelper`.
   */
  sandboxRunscSetpriv?: string;

  /** How the runtime was selected, which the run records beside it. */
  sandboxRuntimeChoice: SandboxRuntimeChoice;
}

/**
 * Values a caller received explicitly (a flag), which win over the
 * environment. A present value takes part even when it is empty: an empty
 * runtime is refused, an empty policy means "none", every default included,
 * and an empty rootfs names none, which the macOS and Linux defaults refuse,
 * since their runtime runs only from one. A named `runsc` given an empty rootfs is left
 * to its driver's own default. An empty variable names nothing, and the
 * default applies as though it were unset.
 */
export interface ExplicitSandboxRuntimeSelection {
  sandboxRuntime?: string;
  sandboxRootfs?: string;
  sandboxCfcPolicy?: string;
}

// Each variable below is declared in this file, as a literal on a line of
// this shape. Loom reads its vendored copy of the file for exactly such lines
// and compares the names with the ones it hands the harness, so a name
// declared in another module and exported from here is one it does not find.

/** Names the sandbox runtime, `runsc`, for every entrypoint. */
export const SANDBOX_RUNTIME_ENV = "CF_HARNESS_SANDBOX_RUNTIME";
export const SANDBOX_ROOTFS_ENV = "CF_HARNESS_SANDBOX_ROOTFS";
export const RUNSC_CFC_POLICY_ENV = "CF_HARNESS_RUNSC_CFC_POLICY";
export const RUNSC_BINARY_ENV = "CF_HARNESS_RUNSC_BINARY";
/**
 * Names the network mode in Docker's words, `none`, `bridge` or `host`, which
 * the selection maps onto runsc's.
 */
export const SANDBOX_NETWORK_MODE_ENV = "CF_HARNESS_DOCKER_NETWORK_MODE";

/** Names the macOS cfc-vm store, for the macOS `runsc` and for this module. */
export const CFC_VM_HOME_ENV = "CFC_VM_HOME";

/** The batch CLI's flag naming the runtime. */
export const SANDBOX_RUNTIME_FLAG = "--sandbox-runtime";

/** The batch CLI's flag naming the runsc runtime's rootfs. */
export const SANDBOX_ROOTFS_FLAG = "--sandbox-rootfs";

/** The batch CLI's flag naming the runsc runtime's CFC policy. */
export const SANDBOX_CFC_POLICY_FLAG = "--sandbox-cfc-policy";

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
];

/** Returns the process's own values of the variables the selection reads. */
export const processSandboxSelectionEnv = (): Record<
  string,
  string | undefined
> =>
  Object.fromEntries(
    SANDBOX_SELECTION_ENV.map((name) => [name, Deno.env.get(name)]),
  );

/**
 * The name of the Docker driver, which this cf-harness does not have. An
 * environment written for a cf-harness that had it can name it, and a run
 * state or a session status such a cf-harness wrote can record it; each is
 * refused by name rather than as a runtime this build does not know.
 */
export const DOCKER_RUNTIME_NAME = "docker";

/**
 * The kind a capability snapshot records for a run on the Docker driver,
 * which this cf-harness does not have.
 */
export const DOCKER_RUNTIME_KIND = "docker-runsc-cfc";

/**
 * Returns `name` as a sandbox runtime where it is the one there is, `runsc`,
 * and `undefined` where it is anything else, `docker` included. It is the one
 * check of a runtime's name: the selection reads a named runtime through it,
 * and so do `recordedSandboxRuntime()`, for the runtime a run's state
 * records, and the interactive chat service, for the runtime a session's
 * status records.
 */
export const sandboxRuntimeNamed = (
  name: string,
): SandboxRuntimeKind | undefined => name === "runsc" ? "runsc" : undefined;

/** Each platform whose default is the native runtime, by its name in prose. */
export const NATIVE_RUNTIME_PLATFORM_NAMES: Readonly<
  Record<NativeRuntimePlatform, string>
> = { darwin: "macOS", linux: "Linux" };

/**
 * Returns `platform` where its default is the native runtime, and `undefined`
 * where it is another.
 */
export const nativeRuntimePlatformOf = (
  platform: SandboxPlatform,
): NativeRuntimePlatform | undefined =>
  platform === "darwin" || platform === "linux" ? platform : undefined;

const nonEmpty = (input: string | undefined): string | undefined => {
  const trimmed = input?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * Returns whether a regular file this process can read is at `path`. A path
 * that is not there reads as absent, and so does one that runs through a
 * file, where nothing can be.
 *
 * @throws The error of any other failure to look, which says nothing of
 * whether a file is there, and of a failure to open a file that is.
 */
const regularFileExists = async (path: string): Promise<boolean> => {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) {
      return false;
    }
    throw error;
  }
  if (!info.isFile) return false;
  // Opened, so that a file this process cannot read is refused here, by
  // name, rather than handed to `runsc` to fail inside the sandbox.
  (await Deno.open(path, { read: true })).close();
  return true;
};

/** What an entrypoint does where nothing names a runtime. */
export type UnnamedSandboxRuntime =
  /**
   * It takes the default of the `platform` it runs on. Required, so that an
   * entrypoint states its platform instead of inheriting one by omission.
   */
  | { platform: SandboxPlatform; namedBy?: never }
  /**
   * It refuses, on every platform: `namedBy` is the caller that must name the
   * runtime of every run, as the refusal names it. A value that carries a
   * platform as well, which this type forbids and a wider one can hand over,
   * still refuses: a caller that must name the runtime takes no default.
   */
  | { namedBy: string; platform?: never };

/**
 * What a platform's default needs to know of the process it would run for,
 * beside the platform. An entrypoint that takes a platform for its tests
 * takes these beside it, and hands them on; each is the process's own where
 * absent.
 */
export interface SandboxProcess {
  /**
   * The architecture the process runs on, `Deno.build.arch` when absent. A
   * macOS default needs Apple silicon.
   */
  arch?: SandboxArch;

  /**
   * Reads the user id the process runs as; `Deno.uid` when absent. A Linux
   * default runs the store's `runsc` as it is for root and with `--rootless`
   * for any other user. It throws where the id cannot be read, which the
   * default refuses on.
   */
  uid?: () => number | null;

  /**
   * Reads the Linux kernel parameter `name`, as `sysctl` names it, trimmed;
   * `undefined` where the kernel has no such parameter. It throws where the
   * parameter could not be read. `/proc/sys` is read when absent. A Linux
   * default for a process that is not root reads whether the host allows it
   * a user namespace.
   */
  readSysctl?: (name: string) => Promise<string | undefined>;

  /**
   * Returns the executable a bare `name` leads to on `PATH`, or `undefined`
   * where none does; this process's `PATH` is searched when absent. A Linux
   * default looks for `pasta` with it.
   */
  which?: (name: string) => string | undefined;

  /**
   * The home the default CFC policy and the default stores are looked up
   * under. An entrypoint that clears `HOME` from the environment it hands on
   * (the Loom local host does) names the real one here; otherwise `env.HOME`
   * is used.
   */
  homeDir?: string;
}

/** Returns the fields of `process` that are given, and no others. */
export const sandboxProcessOf = (process: SandboxProcess): SandboxProcess => ({
  ...(process.arch !== undefined ? { arch: process.arch } : {}),
  ...(process.uid !== undefined ? { uid: process.uid } : {}),
  ...(process.readSysctl !== undefined
    ? { readSysctl: process.readSysctl }
    : {}),
  ...(process.which !== undefined ? { which: process.which } : {}),
  ...(process.homeDir !== undefined ? { homeDir: process.homeDir } : {}),
});

/** How an entrypoint derives its selection. */
export type SandboxRuntimeSelectionOptions =
  & UnnamedSandboxRuntime
  & SandboxProcess
  & {
    /**
     * Whether the entrypoint takes the batch CLI's selection flags. A refusal
     * names each flag beside its variable where it does, and the variable
     * alone where it does not.
     */
    flags: boolean;

    /** Relative rootfs and policy paths resolve against this, as other path flags do. */
    cwd?: string;

    /**
     * Whether a regular file this process can read is at `path`, looked at
     * with `Deno.stat` and opened when absent. It throws where it could not
     * look or could not open, which the selection refuses on.
     */
    pathExists?: (path: string) => Promise<boolean>;

    /**
     * Looks at one piece of the macOS store without following a link;
     * `Deno.lstat` when absent.
     */
    lstat?: (path: string) => Promise<Deno.FileInfo>;

    /**
     * Whether this process can execute the file at `path`, as `access(2)` with
     * `X_OK` answers; `/bin/test -x` when absent. It throws where it could not
     * be asked.
     */
    canExecute?: (path: string) => Promise<boolean>;
  };

/**
 * Helper for `resolveSandboxRuntimeSelection()`, which asks `/bin/test -x`
 * whether this process can execute `path`. The answer is the system's own
 * access check, which no file mode read here could stand in for: which of a
 * file's execute bits apply depends on who this process is.
 */
const canExecuteFile = async (path: string): Promise<boolean> =>
  (await new Deno.Command("/bin/test", {
    args: ["-x", path],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output()).success;

/** The default CFC policy under `home`, where gVisor's Linux installer puts it. */
const homeCfcPolicy = (home: string): string =>
  join(linuxRunscStore(home), "cfc-policy.json");

/**
 * The CFC policy the installer of `platform`'s native store puts in `store`.
 * On Linux it is the policy under the home, since the store is under it.
 */
export const nativeStoreCfcPolicy = (
  platform: NativeRuntimePlatform,
  store: string,
): string =>
  join(store, platform === "darwin" ? "policy.json" : "cfc-policy.json");

/**
 * The `runsc` the installer of a native store puts in `store`: the shim on
 * macOS, and gVisor's own `runsc` on Linux.
 */
export const nativeStoreRunscBinary = (store: string): string =>
  join(store, "bin", "runsc");

/**
 * The rootfs a container of a defaulted native runtime names, in `store`: the
 * marker of the macOS store's image, and the directory of the Linux store's.
 */
const nativeStoreRootfs = (
  platform: NativeRuntimePlatform,
  store: string,
): string =>
  platform === "darwin" ? darwinCfcVmRootfs(store) : linuxRunscRootfs(store);

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
 * The pieces a defaulted native runtime of `platform` takes from its store,
 * less those the caller named in their place. `binaryNamed` drops `runsc`,
 * and on macOS the daemon the shim starts from beside itself; `rootfsNamed`
 * drops the rootfs, and on macOS the image it runs from. The CFC policy is
 * not among them: the selection looks for it on its own, under the home
 * first.
 */
const nativeStorePieces = (
  platform: NativeRuntimePlatform,
  binaryNamed: boolean,
  rootfsNamed: boolean,
): NativeStorePiece[] =>
  platform === "darwin"
    ? [
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
    ]
    : [
      ...(binaryNamed ? [] : [
        {
          path: join("bin", "runsc"),
          what: "gVisor's `runsc`",
          kind: "executable file" as const,
        },
      ]),
      ...(rootfsNamed ? [] : [
        {
          path: join("images", LINUX_RUNSC_IMAGE_KEY),
          what: "the rootfs a container runs from",
          kind: "directory" as const,
        },
      ]),
    ];

/** What one piece of a native store is, as its check found it. */
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
 * is returned.
 *
 * With `linksRefused`, which the macOS store is read with, a piece that is a
 * symbolic link, or is reached through a directory of the store that is one,
 * is not there either, whatever it leads to: the driver hands the macOS
 * `runsc` the rootfs and the binary by the paths the file system resolves
 * them to, while that `runsc` knows the store's pieces by their paths in the
 * store, and none of gVisor's installer scripts makes one a link. Without it
 * a piece is what its links lead to, since Linux's `runsc` is handed the
 * resolved paths and reads nothing by its path in the store.
 */
const readNativeStorePiece = async (
  store: string,
  piece: NativeStorePiece,
  linksRefused: boolean,
  lstat: (path: string) => Promise<Deno.FileInfo>,
  canExecute: (path: string) => Promise<boolean>,
): Promise<NativeStorePieceReading> => {
  const named = `\`${piece.path}\`, ${piece.what},`;
  /**
   * Looks at `path`, without following it where links are refused, and reads
   * it where it is a link.
   */
  const look = async (path: string) => {
    if (!linksRefused) {
      return { info: await Deno.stat(path), target: undefined };
    }
    const info = await lstat(path);
    return {
      info,
      target: info.isSymlink ? await Deno.readLink(path) : undefined,
    };
  };
  /**
   * The reading of a name on the way that could not be looked at. Where
   * links are followed nothing walks the way, so a file on it, where a
   * directory would have to be, says the piece is missing as well.
   */
  const unexamined = (error: unknown): NativeStorePieceReading => ({
    there: false,
    problem: error instanceof Deno.errors.NotFound ||
        (!linksRefused && error instanceof Deno.errors.NotADirectory)
      ? `${named} is missing`
      : `${named} could not be examined (${error})`,
  });
  // Each directory on the way from the store to the piece: a link at any of
  // them puts the piece somewhere other than its path in the store, as
  // surely as a link at the piece itself.
  const names = linksRefused ? piece.path.split("/") : [];
  for (let depth = 1; depth < names.length; depth += 1) {
    const reached = names.slice(0, depth).join("/");
    let target: string | undefined;
    try {
      ({ target } = await look(join(store, reached)));
    } catch (error) {
      return unexamined(error);
    }
    if (target !== undefined) {
      return {
        there: false,
        problem: `${named} is reached through \`${reached}\`, a symbolic ` +
          `link to \`${target}\``,
        linked: true,
      };
    }
  }
  let info: Deno.FileInfo;
  let target: string | undefined;
  try {
    ({ info, target } = await look(join(store, piece.path)));
  } catch (error) {
    return unexamined(error);
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
  if (!there) {
    return {
      there: false,
      problem: `${named} is not ${
        piece.kind === "executable file" ? "an" : "a"
      } ${piece.kind}`,
    };
  }
  // Of the right kind, and then of use to this process: a file it reads, a
  // binary it executes. Either failing here is refused by name, rather than
  // failing later inside the shim or the VM.
  const path = join(store, piece.path);
  if (piece.kind === "file") {
    try {
      (await Deno.open(path, { read: true })).close();
    } catch (error) {
      return { there: false, problem: `${named} could not be read (${error})` };
    }
  } else if (piece.kind === "executable file") {
    let executable: boolean;
    try {
      executable = await canExecute(path);
    } catch (error) {
      return unexamined(error);
    }
    if (!executable) {
      return {
        there: false,
        problem: `${named} is not executable by this process`,
      };
    }
  }
  return { there: true };
};

/**
 * Returns a reader of Linux kernel parameters under `root`, `/proc/sys` by
 * default, which reads the parameter `name` as `sysctl` names it, trimmed,
 * or `undefined` where the kernel has no such parameter. The reader throws
 * the error of any other failure to read one.
 */
export const procSysctlReader =
  (root = "/proc/sys") => async (name: string): Promise<string | undefined> => {
    try {
      return (await Deno.readTextFile(`${root}/${name.replaceAll(".", "/")}`))
        .trim();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  };

/**
 * The kernel parameters that keep a process that is not root from making a
 * user namespace, each with the value that does so, what that value means,
 * and the value that lifts it.
 */
const USER_NAMESPACE_BLOCKS: readonly {
  name: string;
  blocking: string;
  means: string;
  lift: string;
}[] = [{
  name: "user.max_user_namespaces",
  blocking: "0",
  means: "allows no user namespace at all",
  lift: "15000",
}, {
  name: "kernel.unprivileged_userns_clone",
  blocking: "0",
  means: "allows none to a process that is not root",
  lift: "1",
}, {
  name: "kernel.apparmor_restrict_unprivileged_userns",
  blocking: "1",
  means: "has AppArmor refuse one to a process that is not root",
  lift: "0",
}];

/**
 * Helper for `resolveSandboxRuntimeSelection()`, which returns what keeps
 * this host from giving a process that is not root a user namespace, with
 * the remedy, or `undefined` where nothing does. A parameter the kernel does
 * not have keeps nothing from it; one that could not be read is not known
 * to allow it, and is returned as what is in the way.
 */
const userNamespacesBlocked = async (
  readSysctl: (name: string) => Promise<string | undefined>,
): Promise<{ problem: string; remedy: string } | undefined> => {
  for (const block of USER_NAMESPACE_BLOCKS) {
    let value: string | undefined;
    try {
      value = await readSysctl(block.name);
    } catch (error) {
      return {
        problem: "whether this host allows that could not be told: " +
          `\`${block.name}\` could not be read (${error})`,
        remedy: `Make \`/proc/sys/${block.name.replaceAll(".", "/")}\` ` +
          "readable",
      };
    }
    if (value === block.blocking) {
      return {
        problem: `\`${block.name}\` is ${value}, which ${block.means}`,
        remedy: "Allow one with " +
          `\`sudo sysctl -w ${block.name}=${block.lift}\` (and a file in ` +
          "`/etc/sysctl.d` to keep it across boots)",
      };
    }
  }
  return undefined;
};

/**
 * Helper for `resolveSandboxRuntimeSelection()`, which builds the refusal of
 * a default that cannot be provided on `platform`. It says that the native
 * runtime is the default, what keeps it from being used, and what to do about
 * it where `remedy` says.
 */
const nativeDefaultRefusal = (
  platform: NativeRuntimePlatform,
  problem: string,
  remedy: string | undefined,
): HarnessControlError =>
  new HarnessControlError(
    "invalid-request",
    "No sandbox runtime is named, so the default applies, which on " +
      `${NATIVE_RUNTIME_PLATFORM_NAMES[platform]} is the native \`runsc\` ` +
      `runtime, and ${problem}.${remedy === undefined ? "" : ` ${remedy}.`}`,
  );

/**
 * Helper for `resolveSandboxRuntimeSelection()`, which builds the refusal of
 * `docker` named as the runtime: the driver it names is gone. It says which
 * of a flag or the environment named it, in the vocabulary of an entrypoint
 * that does or does not take `flags`, and how a run is started instead: by
 * leaving the runtime unnamed only where `hasDefault` says an unnamed one
 * would be taken, and otherwise by naming `runsc`.
 */
const dockerNamedRefusal = (
  namedBy: "flag" | "environment",
  flags: boolean,
  hasDefault: boolean,
): HarnessControlError =>
  new HarnessControlError(
    "invalid-request",
    `${
      namedBy === "flag"
        ? `\`${SANDBOX_RUNTIME_FLAG} docker\``
        : `\`${SANDBOX_RUNTIME_ENV}=docker\``
    } names the Docker driver, which this cf-harness no longer has: its one ` +
      `sandbox runtime is \`runsc\`. ${
        hasDefault
          ? "Leave the runtime unnamed to take the platform's default, or " +
            "name `runsc`"
          : "Name `runsc`"
      } with ${
        flags ? `\`${SANDBOX_RUNTIME_FLAG} runsc\` or ` : ""
      }\`${SANDBOX_RUNTIME_ENV}=runsc\`.`,
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
 * Helper for `resolveSandboxRuntimeSelection()`, which locates the macOS
 * store: the one `CFC_VM_HOME` names, or else the default one under `home`,
 * by the path the file system has for it, which has to be the path it was
 * given by.
 *
 * @throws HarnessControlError where the store cannot be located that way.
 */
const locateDarwinStore = (
  env: Record<string, string | undefined>,
  home: string | undefined,
): string => {
  const refusal = (problem: string, remedy: string) =>
    nativeDefaultRefusal("darwin", problem, remedy);
  const given = darwinCfcVmStore(env[CFC_VM_HOME_ENV], home);
  if (given === undefined) {
    throw refusal(
      `its store cannot be located: neither \`${CFC_VM_HOME_ENV}\` nor ` +
        "`HOME` is set",
      `Set \`${CFC_VM_HOME_ENV}\` to the store`,
    );
  }
  if (!isAbsolute(given)) {
    // The macOS `runsc` resolves the same name against its own working
    // directory, which need not be this selection's.
    throw refusal(
      `its store cannot be located: \`${given}\` is not an absolute path`,
      `Set \`${CFC_VM_HOME_ENV}\` to the store's absolute path`,
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
    throw refusal(
      `its store cannot be located: ${
        error instanceof Error ? error.message : String(error)
      }`,
      `Set \`${CFC_VM_HOME_ENV}\` to the path the store is at`,
    );
  }
  if (canonical !== written) {
    throw refusal(
      `its store \`${written}\` resolves to \`${canonical}\`, which the ` +
        "macOS `runsc` reads as another path: it compares paths as they " +
        "are written",
      `Set \`${CFC_VM_HOME_ENV}\` to \`${canonical}\``,
    );
  }
  return written;
};

/**
 * Helper for `resolveSandboxRuntimeSelection()`, which locates the Linux
 * store: the one under `home`, where gVisor's Linux installer writes it.
 * Linux's `runsc` reads nothing by its path in the store, so the store is
 * taken by the path it is given by, links and all.
 *
 * @throws HarnessControlError where there is no home, or it is not an
 * absolute path.
 */
const locateLinuxStore = (home: string | undefined): string => {
  if (home === undefined) {
    throw nativeDefaultRefusal(
      "linux",
      "its store cannot be located: `HOME` is not set",
      "Set `HOME`, under which the store is",
    );
  }
  if (!isAbsolute(home)) {
    throw nativeDefaultRefusal(
      "linux",
      `its store cannot be located: the home \`${home}\` is not an absolute ` +
        "path",
      "Set `HOME` to an absolute path",
    );
  }
  return linuxRunscStore(home);
};

/**
 * Derives the runtime selection from explicit values and the environment.
 *
 * Where nothing names a runtime on macOS or Linux, the selection is the
 * native `runsc` runtime, from the platform's store. On macOS that is the
 * store `CFC_VM_HOME` names or else the default one under the home, returned
 * by the path the file system has for it, which has to be the path it was
 * given by; the `runsc` binary is the store's shim, the rootfs is the store's
 * image, and the CFC policy is the default one under the home or else the
 * store's own. It runs on Apple silicon alone. On Linux it is the store under
 * the home; the `runsc` binary is the store's, the rootfs is the store's
 * unpacked image, and the CFC policy is the store's, which is the default one
 * under the home. Unless a `runsc` binary is named, the store's runs as it is
 * for root, and for any other user with `--rootless`, in a user namespace of
 * its own, which needs the host to allow unprivileged user namespaces
 * (`user.max_user_namespaces` above 0, and neither
 * `kernel.unprivileged_userns_clone` at 0 nor
 * `kernel.apparmor_restrict_unprivileged_userns` at 1). Its unnamed network is
 * `pasta`'s, which root's runs inside `unshare`, each found on `PATH`; a
 * network named `none` or `host` needs neither. A companion that is named
 * replaces the store's, as it does for a named `runsc`.
 *
 * For a named `runsc` the default CFC policy is the one under the home. It is
 * looked up only when nothing named one (an explicit empty value means "none"
 * and is not overridden by a default), and only taken when it is there.
 *
 * @throws HarnessControlError where `docker` is named, since this cf-harness
 * has no Docker driver; where nothing names a runtime and the entrypoint takes
 * no default, or runs on a platform with none, which is every platform but
 * macOS and Linux; and where nothing names one on macOS or Linux and the
 * native runtime cannot be provided: on macOS a process that is not running
 * on Apple silicon; on Linux, unless a `runsc` binary is named, a process
 * whose user cannot be read, or that is not root and whose host refuses it a
 * user namespace or whose kernel parameters cannot be read; on Linux, for the
 * unnamed network, no `pasta` or `setpriv` on `PATH`, or for a process whose
 * user is root, no `unshare`, and for one whose user cannot be read, that
 * user; the store cannot be located or on macOS is reached
 * through a link; a piece the selection would take from it is not there; or
 * no CFC policy is found and none was named. Each message says what is in the
 * way. Also, for the runtime, where a default CFC policy could not be
 * examined for any reason but its not being there.
 * @throws Error when the runtime is not `runsc` or `docker`, or the network
 * mode is not one of its values.
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
  const namedBy = explicit.sandboxRuntime !== undefined
    ? "flag"
    : "environment";
  if (rawRuntime === DOCKER_RUNTIME_NAME) {
    throw dockerNamedRefusal(
      namedBy,
      options.flags,
      options.namedBy === undefined &&
        nativeRuntimePlatformOf(options.platform) !== undefined,
    );
  }
  const named = rawRuntime === undefined
    ? undefined
    : sandboxRuntimeNamed(rawRuntime);
  if (rawRuntime !== undefined && named === undefined) {
    throw new Error("sandbox runtime must be runsc");
  }
  if (named === undefined && options.namedBy !== undefined) {
    throw new HarnessControlError(
      "invalid-request",
      "No sandbox runtime is named, and this entrypoint takes no default: " +
        `${options.namedBy} must name \`runsc\`, with ${
          options.flags ? `\`${SANDBOX_RUNTIME_FLAG}\` or ` : ""
        }\`${SANDBOX_RUNTIME_ENV}\`.`,
    );
  }
  // The platform is the whole of the reason: the native runtime is the macOS
  // `runsc` and its VM, or Linux's own `runsc`, and no other platform has
  // either.
  const platform = options.namedBy === undefined ? options.platform : undefined;
  if (
    named === undefined && platform !== undefined &&
    platform !== "darwin" && platform !== "linux"
  ) {
    throw new HarnessControlError(
      "invalid-request",
      `No sandbox runtime is named, and \`${platform}\` has no default: ` +
        "cf-harness's sandbox runtime, `runsc`, runs on macOS (Apple " +
        "silicon) and Linux alone.",
    );
  }
  const nativePlatform = named === undefined && platform !== undefined
    ? nativeRuntimePlatformOf(platform)
    : undefined;

  const home = nonEmpty(options.homeDir) ?? nonEmpty(env.HOME);
  const namedBinary = nonEmpty(env[RUNSC_BINARY_ENV]);
  let nativeStore: string | undefined;
  let rootless = false;
  // The user this process runs as, read once, where something turns on it.
  let uidRead: number | undefined;
  const processUid = (
    platform: NativeRuntimePlatform,
    turnsOn: string,
  ): number => {
    if (uidRead === undefined) {
      // Not known to be root, nor known not to be, so nothing that turns on
      // it is chosen.
      let uid: number | null;
      try {
        uid = (options.uid ?? Deno.uid)();
      } catch (error) {
        throw nativeDefaultRefusal(
          platform,
          `which user this process runs as could not be read (${error}), ` +
            `so ${turnsOn} is not known`,
          "Grant it `--allow-sys=uid`",
        );
      }
      if (uid === null) {
        throw nativeDefaultRefusal(
          platform,
          "which user this process runs as is not known (the platform " +
            `reports none), so ${turnsOn} is not known`,
          undefined,
        );
      }
      uidRead = uid;
    }
    return uidRead;
  };
  if (nativePlatform !== undefined) {
    const arch = options.arch ?? Deno.build.arch;
    if (nativePlatform === "darwin" && arch !== "aarch64") {
      // Before anything else: no setting and no store makes it run.
      throw nativeDefaultRefusal(
        nativePlatform,
        "that runtime runs only on Apple silicon, where this process runs " +
          `on \`${arch}\`, and cf-harness has no other sandbox runtime`,
        undefined,
      );
    }
    if (nativePlatform === "linux" && namedBinary === undefined) {
      // Before the store is looked for: the store is the one under the home
      // of whoever runs, and how its `runsc` runs depends on who that is.
      const uid = processUid(
        nativePlatform,
        "whether the store's `runsc` runs as root or rootless",
      );
      if (uid !== 0) {
        // Not root, so rootless: runsc maps this user to root in a user
        // namespace of its own, which the host has to allow.
        rootless = true;
        const blocked = await userNamespacesBlocked(
          options.readSysctl ?? procSysctlReader(),
        );
        if (blocked !== undefined) {
          throw nativeDefaultRefusal(
            nativePlatform,
            `this process is not root (uid ${uid}), so the store's \`runsc\` ` +
              "runs rootless, in a user namespace " +
              `of its own, and ${blocked.problem}`,
            `${blocked.remedy}, or run as root`,
          );
        }
      }
    }
    nativeStore = nativePlatform === "darwin"
      ? locateDarwinStore(env, home)
      : locateLinuxStore(home);
  }

  const namedRootfs = atCwd(
    explicit.sandboxRootfs !== undefined
      ? nonEmpty(explicit.sandboxRootfs)
      : nonEmpty(env[SANDBOX_ROOTFS_ENV]),
  );
  if (
    nativePlatform !== undefined && explicit.sandboxRootfs !== undefined &&
    namedRootfs === undefined
  ) {
    // Named, and named as nothing: the store's image does not stand in for
    // a rootfs someone said there is none of.
    throw options.flags
      ? nativeDefaultRefusal(
        nativePlatform,
        `\`${SANDBOX_ROOTFS_FLAG}\` is given empty, which names no rootfs, ` +
          "where that runtime runs only from one",
        "Name a rootfs, or leave the flag out to run from the store's own " +
          "image",
      )
      : nativeDefaultRefusal(
        nativePlatform,
        "a rootfs is given empty, which names none, where that runtime runs " +
          "only from one",
        `Name a rootfs with \`${SANDBOX_ROOTFS_ENV}\`, or leave it unnamed to ` +
          "run from the store's own image",
      );
  }
  const policyNamed = explicit.sandboxCfcPolicy !== undefined;
  const namedPolicy = atCwd(
    policyNamed
      ? nonEmpty(explicit.sandboxCfcPolicy)
      : nonEmpty(env[RUNSC_CFC_POLICY_ENV]),
  );
  // In the order they are taken, once each: the Linux store's own policy is
  // the one under the home. The store's own policy is a default of the native
  // runtime alone: a named `runsc` is given exactly what it names.
  const defaultPolicies = [
    ...new Set([
      ...(home !== undefined ? [homeCfcPolicy(home)] : []),
      ...(nativePlatform !== undefined && nativeStore !== undefined
        ? [nativeStoreCfcPolicy(nativePlatform, nativeStore)]
        : []),
    ]),
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
          `read (${error}), so whether it is a policy a run could use is not ` +
          "known";
        const remedy = `Make it readable or name a policy with ${
          policyNaming(options.flags)
        }`;
        throw nativePlatform !== undefined
          ? nativeDefaultRefusal(nativePlatform, `the ${unexamined}`, remedy)
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

  if (nativePlatform !== undefined && nativeStore !== undefined) {
    const linksRefused = nativePlatform === "darwin";
    const lstat = options.lstat ?? Deno.lstat;
    const canExecute = options.canExecute ?? canExecuteFile;
    const pieces = nativeStorePieces(
      nativePlatform,
      namedBinary !== undefined,
      namedRootfs !== undefined,
    );
    const problems: string[] = [];
    let linked = false;
    for (const piece of pieces) {
      const reading = await readNativeStorePiece(
        nativeStore,
        piece,
        linksRefused,
        lstat,
        canExecute,
      );
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
        nativePlatform,
        `it is not set up at \`${nativeStore}\`: ${problems.join("; ")}`,
        "Set it up there",
      );
    }
  }

  const sandboxRootfs = namedRootfs ??
    (nativePlatform !== undefined && nativeStore !== undefined
      ? nativeStoreRootfs(nativePlatform, nativeStore)
      : undefined);
  const sandboxRunscBinary = namedBinary ??
    (nativeStore !== undefined
      ? nativeStoreRunscBinary(nativeStore)
      : undefined);
  const rawNetwork = nonEmpty(env[SANDBOX_NETWORK_MODE_ENV]);
  if (
    rawNetwork !== undefined &&
    rawNetwork !== "none" && rawNetwork !== "bridge" && rawNetwork !== "host"
  ) {
    // Not read as "no network" instead.
    throw new Error(
      `${SANDBOX_NETWORK_MODE_ENV} must be one of none, bridge, or host`,
    );
  }
  // The network vocabulary is Docker's, and maps onto runsc's: none stays
  // none, host is the host's stack, and bridge is runsc's own `sandbox`
  // network, which on macOS is the VM's, and on Linux, where the default hands
  // the driver a `pasta` below, is pasta's namespace taken as runsc's host
  // network; with no helper Linux's is loopback alone.
  const sandboxRunscNetworkMode: RunscNetworkMode | undefined =
    rawNetwork === "none"
      ? "none"
      : rawNetwork === "host"
      ? "host"
      : rawNetwork === "bridge"
      ? "sandbox"
      : undefined;
  // Linux's runsc gives a container of its own `sandbox` network loopback
  // alone; pasta is what gives it egress and the host, as Docker's bridge did.
  let networkHelper: string | undefined;
  let unshare: string | undefined;
  let setpriv: string | undefined;
  if (
    nativePlatform === "linux" &&
    (sandboxRunscNetworkMode === undefined ||
      sandboxRunscNetworkMode === "sandbox")
  ) {
    const which = options.which ?? ((name: string) => executableOnPath(name));
    networkHelper = which("pasta");
    if (networkHelper === undefined) {
      throw nativeDefaultRefusal(
        nativePlatform,
        "its network, which gives a container egress and the host at " +
          "`host.docker.internal`, is `pasta`'s, from passt, and no `pasta` " +
          "is on `PATH`",
        "Install passt (`sudo apt install passt`), or name a network with " +
          `\`${SANDBOX_NETWORK_MODE_ENV}=none\` or \`${SANDBOX_NETWORK_MODE_ENV}=host\``,
      );
    }
    setpriv = which("setpriv");
    if (setpriv === undefined) {
      throw nativeDefaultRefusal(
        nativePlatform,
        "its network is `pasta`'s, and a container under pasta outlives a " +
          "`pasta` that is stopped unless `setpriv` (util-linux) ties it to " +
          "pasta, and no `setpriv` is on `PATH`",
        "Install util-linux, or name a network with " +
          `\`${SANDBOX_NETWORK_MODE_ENV}=none\` or \`${SANDBOX_NETWORK_MODE_ENV}=host\``,
      );
    }
    // Root's pasta runs in a mount namespace of its own; whoever else runs
    // has pasta make a user namespace, whether its `runsc` is rootless or a
    // named one that runs as it is, which the host has to allow. A rootless
    // `runsc` was checked for that already.
    const uid = processUid(
      nativePlatform,
      "whether `pasta` runs as root, in a mount namespace of its own, or in a " +
        "user namespace of its own",
    );
    if (uid !== 0 && !rootless) {
      const blocked = await userNamespacesBlocked(
        options.readSysctl ?? procSysctlReader(),
      );
      if (blocked !== undefined) {
        throw nativeDefaultRefusal(
          nativePlatform,
          `its network is \`pasta\`'s, and this process is not root (uid ${uid}), ` +
            "so pasta runs in a user namespace of its own, and " +
            blocked.problem,
          `${blocked.remedy}, run as root, or name a network with ` +
            `\`${SANDBOX_NETWORK_MODE_ENV}=none\` or ` +
            `\`${SANDBOX_NETWORK_MODE_ENV}=host\``,
        );
      }
    }
    if (uid === 0) {
      unshare = which("unshare");
      if (unshare === undefined) {
        throw nativeDefaultRefusal(
          nativePlatform,
          "its network is `pasta`'s, which for root runs in a mount " +
            "namespace of its own that `unshare` (util-linux) makes, and no " +
            "`unshare` is on `PATH`",
          "Install util-linux, run as a user that is not root, or name a " +
            `network with \`${SANDBOX_NETWORK_MODE_ENV}=none\` or ` +
            `\`${SANDBOX_NETWORK_MODE_ENV}=host\``,
        );
      }
    }
  }
  return {
    sandboxRuntimeKind: "runsc",
    ...(sandboxRootfs !== undefined ? { sandboxRootfs } : {}),
    ...(sandboxCfcPolicy !== undefined ? { sandboxCfcPolicy } : {}),
    ...(sandboxRunscBinary !== undefined ? { sandboxRunscBinary } : {}),
    ...(sandboxRunscNetworkMode !== undefined
      ? { sandboxRunscNetworkMode }
      : {}),
    ...(rootless ? { sandboxRunscRootless: true as const } : {}),
    ...(networkHelper !== undefined
      ? { sandboxRunscNetworkHelper: networkHelper }
      : {}),
    ...(unshare !== undefined ? { sandboxRunscUnshare: unshare } : {}),
    ...(setpriv !== undefined ? { sandboxRunscSetpriv: setpriv } : {}),
    sandboxRuntimeChoice: nativePlatform !== undefined &&
        nativeStore !== undefined
      ? {
        runtime: "runsc",
        source: "default",
        platform: nativePlatform,
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
): string =>
  choice.source !== "default"
    ? `named by ${
      choice.source === "flag" ? SANDBOX_RUNTIME_FLAG : SANDBOX_RUNTIME_ENV
    }`
    : `default on ${
      NATIVE_RUNTIME_PLATFORM_NAMES[choice.platform]
    }: the native store at ${choice.nativeStore}`;

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
 * native runtime was the default, and where its store is. `undefined` for a
 * runtime that was named, and for no record of the choice.
 */
export const unnamedRuntimeMountNote = (
  choice: SandboxRuntimeChoice | undefined,
): string | undefined =>
  choice?.source === "default"
    ? "No sandbox runtime is named, so this is the native `runsc` runtime " +
      `that ${
        NATIVE_RUNTIME_PLATFORM_NAMES[choice.platform]
      } defaults to, from the store at \`${choice.nativeStore}\`: ` +
      "run with a workspace and mounts that hold none of it."
    : undefined;

/**
 * Returns the runtime, as an entrypoint names it, that describes itself as
 * `kind`, or `undefined` for a kind this build does not run, the Docker
 * driver's included. A run records the kind, and an operator names the
 * runtime.
 */
export const sandboxRuntimeOfKind = (
  kind: string,
): SandboxRuntimeKind | undefined => kind === "runsc-cfc" ? "runsc" : undefined;

/**
 * Returns the runtime an engine built with `options` executes on: the one it
 * is handed where it is handed one, and otherwise the one it builds, `runsc`.
 *
 * @throws Error where the runtime handed in describes itself as a kind this
 * build does not run.
 */
export const sandboxRuntimeOfOptions = (
  options: { sandboxRuntime?: { describe(): { kind: string } } },
): SandboxRuntimeKind => {
  if (options.sandboxRuntime === undefined) return "runsc";
  const { kind } = options.sandboxRuntime.describe();
  const runtime = sandboxRuntimeOfKind(kind);
  if (runtime === undefined) {
    throw new Error(
      `the sandbox runtime handed in describes itself as \`${kind}\`, ` +
        "which is no kind of runtime this cf-harness runs",
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
 * names is checked rather than trusted to be the one there is.
 *
 * @throws HarnessControlError, a resume refusal, where the state records the
 * Docker driver, which this cf-harness does not have: a run resumes only on
 * the runtime it started on, since another need not read the CFC labels of
 * its files where that one kept them. Also where the state names a runtime,
 * or describes a kind of one, that this build does not know: a resume cannot
 * be held to a runtime it cannot tell from its own.
 */
export const recordedSandboxRuntime = (
  runState: {
    sandboxRuntime?: string;
    capabilitySnapshot?: { cfc?: { sandbox?: { kind: string } } };
  },
): SandboxRuntimeKind | undefined => {
  const refused = (recorded: string): HarnessControlError =>
    recorded === DOCKER_RUNTIME_NAME || recorded === DOCKER_RUNTIME_KIND
      ? harnessResumeRefusal(
        "resume sandbox runtime removed: the run records that it started on " +
          `the Docker driver (\`${recorded}\`), which this cf-harness no ` +
          "longer has. A run resumes only on the runtime it started on, " +
          "since another need not read the CFC labels of the run's files " +
          "where that one kept them. Start a new run.",
      )
      : harnessResumeRefusal(
        "resume sandbox runtime unknown: the run records that it started on " +
          `the sandbox runtime \`${recorded}\`, which this cf-harness does ` +
          "not know, so it cannot tell whether this resume is on the same " +
          "one. Resume it with the cf-harness that wrote the record.",
      );
  const named = runState.sandboxRuntime;
  if (named !== undefined) {
    const runtime = sandboxRuntimeNamed(named);
    if (runtime === undefined) throw refused(named);
    return runtime;
  }
  const kind = runState.capabilitySnapshot?.cfc?.sandbox?.kind;
  if (kind === undefined) return undefined;
  const runtime = sandboxRuntimeOfKind(kind);
  if (runtime === undefined) throw refused(kind);
  return runtime;
};
