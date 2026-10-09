/**
 * Checks the sandbox runtime a run gets where nothing names one: through the
 * selection every entrypoint shares, and then through each entrypoint. Every
 * call here is told its platform rather than taking the machine's, and every
 * native store is a directory a case makes, so the macOS half runs on Linux
 * and no case reads the store of the machine it runs on.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  type ConsoleLaunchIo,
  launchConsole,
  LAUNCHER_OWNED_VARIABLES,
  prepareConsoleLaunch,
} from "../console/launch.ts";
import {
  consoleHealthRows,
  consoleSandboxBanner,
  createConsoleHealth,
  resolveConsoleConfig,
  startConsoleServer,
} from "../console/server.ts";
import { InMemoryHarnessCredentialStore } from "../src/auth/credential-store.ts";
import { resolveInteractiveProvisioning } from "../src/host-mounts.ts";
import {
  type CfHarnessCliIO,
  formatCfHarnessCliResult,
  parseCfHarnessCliArgs,
  runCfHarnessCli,
  selectCfHarnessCliSandboxRuntime,
} from "../src/cli.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  runHarnessInteractiveChatStdioCli,
  type RunHarnessInteractiveChatStdioOptions,
} from "../src/interactive-chat-stdio.ts";
import { createLoomLocalCfHarnessHost } from "../src/loom-local-host.ts";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessPromptLoopResult,
} from "../src/prompt-loop.ts";
import type { ProcessRunner } from "../src/sandbox/process-runner.ts";
import { resolveRunscSandboxConfig } from "../src/sandbox/runsc.ts";
import {
  describeSandboxRuntimeChoice,
  processSandboxSelectionEnv,
  procSysctlReader,
  resolveSandboxRuntimeSelection,
  SANDBOX_RUNTIME_ENV,
  type SandboxPlatform,
  type SandboxRuntimeChoice,
  type SandboxRuntimeSelection,
  unnamedRuntimeMountNote,
} from "../src/sandbox/runtime-selection.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";

/** The pieces an installed native store holds, as paths relative to it. */
const SHIM = join("bin", "runsc");
const DAEMON = join("bin", "cfc-vm");
const CONFIG = "config.json";
const ROOTFS = join("images", "kitchensink");
const IMAGE = join("ext4", "kitchensink.ext4");
const POLICY = "policy.json";

/** Makes a native store at `store` holding every piece an install leaves. */
const installStore = async (store: string): Promise<void> => {
  await Deno.mkdir(join(store, "bin"), { recursive: true });
  for (const binary of [SHIM, DAEMON]) {
    await Deno.writeTextFile(join(store, binary), "#!/bin/sh\n");
    await Deno.chmod(join(store, binary), 0o755);
  }
  await Deno.writeTextFile(join(store, CONFIG), "{}\n");
  await Deno.mkdir(join(store, ROOTFS), { recursive: true });
  await Deno.mkdir(join(store, "ext4"));
  await Deno.writeTextFile(join(store, IMAGE), "");
  await Deno.writeTextFile(join(store, POLICY), "{}\n");
};

/** Where the macOS `runsc` keeps its store under `home` unless told otherwise. */
const defaultStore = (home: string): string =>
  join(home, "Library", "Application Support", "cfc-vm");

/** The CFC policy under `home`, where gVisor's Linux installer puts it. */
const homePolicy = (home: string): string =>
  join(home, ".local", "share", "runsc-cfc", "cfc-policy.json");

/** The pieces an installed Linux store holds, as paths relative to it. */
const LINUX_RUNSC = join("bin", "runsc");
const LINUX_ROOTFS = join("images", "kitchensink");
const LINUX_POLICY = "cfc-policy.json";

/** Where gVisor's Linux installer puts its store under `home`. */
const linuxStore = (home: string): string =>
  join(home, ".local", "share", "runsc-cfc");

/**
 * Makes a Linux store under `home` holding every piece an install leaves,
 * and returns where it is.
 */
const installLinuxStore = async (home: string): Promise<string> => {
  const store = linuxStore(home);
  await Deno.mkdir(join(store, "bin"), { recursive: true });
  await Deno.writeTextFile(join(store, LINUX_RUNSC), "#!/bin/sh\n");
  await Deno.chmod(join(store, LINUX_RUNSC), 0o755);
  await Deno.mkdir(join(store, LINUX_ROOTFS), { recursive: true });
  await Deno.writeTextFile(join(store, LINUX_POLICY), "{}\n");
  return store;
};

/** The `pasta` a case's Linux process finds on its `PATH`. */
const PASTA = "/usr/bin/pasta";

/** The `unshare` a case's Linux process finds on its `PATH`. */
const UNSHARE = "/usr/bin/unshare";

/** The `setpriv` a case's Linux process finds on its `PATH`. */
const SETPRIV = "/usr/bin/setpriv";

/**
 * Finds `pasta`, `unshare` and `setpriv`, and nothing else, as a Linux host
 * with passt and util-linux does.
 */
const withPasta = (name: string): string | undefined =>
  name === "pasta"
    ? PASTA
    : name === "unshare"
    ? UNSHARE
    : name === "setpriv"
    ? SETPRIV
    : undefined;

/**
 * The selection of a defaulted Linux runtime for root, taken whole from
 * `store`, with pasta giving it the default network under `unshare`.
 */
const fromLinuxStore = (store: string): SandboxRuntimeSelection => ({
  sandboxRuntimeKind: "runsc",
  sandboxRootfs: join(store, LINUX_ROOTFS),
  sandboxCfcPolicy: join(store, LINUX_POLICY),
  sandboxRunscBinary: join(store, LINUX_RUNSC),
  sandboxRunscNetworkHelper: PASTA,
  sandboxRunscUnshare: UNSHARE,
  sandboxRunscSetpriv: SETPRIV,
  sandboxRuntimeChoice: {
    runtime: "runsc",
    source: "default",
    platform: "linux",
    nativeStore: store,
  },
});

/** `selection` as a process that is not root gets it, with no `unshare`. */
const withoutUnshare = (
  selection: SandboxRuntimeSelection,
): SandboxRuntimeSelection => {
  const { sandboxRunscUnshare: _, ...rest } = selection;
  return rest;
};

/** The refusal of a Linux default whose store has `problem` in its way. */
const linuxNotSetUp = (
  store: string,
  problem: string,
  docker: string,
): string =>
  "No sandbox runtime is named, so the default applies, which on Linux is " +
  `the native \`runsc\` runtime, and it is not set up at \`${store}\`: ` +
  `${problem}. Set it up there, or ${docker}`;

/** One condition a native store can be in. */
interface StoreState {
  /** How a case names the condition. */
  name: string;

  /** Brings an installed store at `store` into the condition. */
  arrange: (store: string) => Promise<void>;

  /**
   * What the macOS default says is in its way, for an entrypoint that takes
   * the selection flags, or `undefined` where nothing is.
   */
  problem?: (store: string, home: string | undefined) => string;
}

/** What the default says of a store with no CFC policy in or beside it. */
const noPolicyProblem = (
  store: string,
  home: string | undefined,
  flags = true,
): string =>
  `no CFC policy is at ${
    [...(home === undefined ? [] : [homePolicy(home)]), join(store, POLICY)]
      .map((path) => `\`${path}\``).join(" or ")
  } (name one with ${
    flags ? "`--sandbox-cfc-policy` or " : ""
  }\`CF_HARNESS_RUNSC_CFC_POLICY\`)`;

/** Replaces the file at `path` with a directory, or the directory with a file. */
const swapKind = async (path: string): Promise<void> => {
  const wasDirectory = (await Deno.stat(path)).isDirectory;
  await Deno.remove(path);
  if (wasDirectory) await Deno.writeTextFile(path, "");
  else await Deno.mkdir(path);
};

/** Every condition of a store the selection tells apart. */
const STORE_STATES: readonly StoreState[] = [{
  name: "set up",
  arrange: () => Promise.resolve(),
}, {
  name: "absent",
  arrange: (store) => Deno.remove(store, { recursive: true }),
  problem: (store, home) =>
    [
      "`bin/runsc`, the `runsc` shim, is missing",
      "`bin/cfc-vm`, the VM daemon the shim starts, is missing",
      "`config.json`, the VM's configuration, is missing",
      "`images/kitchensink`, the rootfs a container names, is missing",
      "`ext4/kitchensink.ext4`, the image that rootfs runs from, is missing",
      noPolicyProblem(store, home),
    ].join("; "),
}, {
  name: "without its `runsc` shim",
  arrange: (store) => Deno.remove(join(store, SHIM)),
  problem: () => "`bin/runsc`, the `runsc` shim, is missing",
}, {
  name: "with a `runsc` shim that is not executable",
  arrange: (store) => Deno.chmod(join(store, SHIM), 0o644),
  problem: () => "`bin/runsc`, the `runsc` shim, is not an executable file",
}, {
  name: "with a directory where its `runsc` shim goes",
  arrange: (store) => swapKind(join(store, SHIM)),
  problem: () => "`bin/runsc`, the `runsc` shim, is not an executable file",
}, {
  name: "without its VM daemon",
  arrange: (store) => Deno.remove(join(store, DAEMON)),
  problem: () => "`bin/cfc-vm`, the VM daemon the shim starts, is missing",
}, {
  name: "with a VM daemon that is not executable",
  arrange: (store) => Deno.chmod(join(store, DAEMON), 0o644),
  problem: () =>
    "`bin/cfc-vm`, the VM daemon the shim starts, is not an executable file",
}, {
  name: "without its `config.json`",
  arrange: (store) => Deno.remove(join(store, CONFIG)),
  problem: () => "`config.json`, the VM's configuration, is missing",
}, {
  name: "with a directory where its `config.json` goes",
  arrange: (store) => swapKind(join(store, CONFIG)),
  problem: () => "`config.json`, the VM's configuration, is not a file",
}, {
  name: "without its rootfs marker",
  arrange: (store) => Deno.remove(join(store, ROOTFS)),
  problem: () =>
    "`images/kitchensink`, the rootfs a container names, is missing",
}, {
  name: "with a file where its rootfs marker goes",
  arrange: (store) => swapKind(join(store, ROOTFS)),
  problem: () =>
    "`images/kitchensink`, the rootfs a container names, is not a directory",
}, {
  name: "without its image",
  arrange: (store) => Deno.remove(join(store, IMAGE)),
  problem: () =>
    "`ext4/kitchensink.ext4`, the image that rootfs runs from, is missing",
}, {
  name: "with a directory where its image goes",
  arrange: (store) => swapKind(join(store, IMAGE)),
  problem: () =>
    "`ext4/kitchensink.ext4`, the image that rootfs runs from, is not a file",
}, {
  name: "without a CFC policy",
  arrange: (store) => Deno.remove(join(store, POLICY)),
  problem: noPolicyProblem,
}];

/** How an entrypoint that takes the selection flags is told to use Docker. */
const DOCKER_BY_FLAG_OR_VARIABLE =
  "select Docker with `--sandbox-runtime docker` or " +
  "`CF_HARNESS_SANDBOX_RUNTIME=docker`.";

/** How an entrypoint that reads the environment alone is told to. */
const DOCKER_BY_VARIABLE =
  "select Docker with `CF_HARNESS_SANDBOX_RUNTIME=docker`.";

/** The refusal of a default whose store at `store` has `problem` in its way. */
const notSetUp = (store: string, problem: string, docker: string): string =>
  "No sandbox runtime is named, so the default applies, which on macOS is " +
  `the native \`runsc\` runtime, and it is not set up at \`${store}\`: ` +
  `${problem}. Set it up there, or ${docker}`;

/**
 * Whether this process reads a file whose mode forbids it, as root does,
 * found by trying. A case that needs a file it cannot read is skipped where
 * it can.
 */
const readsDespiteMode = (): boolean => {
  const dir = Deno.makeTempDirSync({ prefix: "sandbox-runtime-mode-" });
  try {
    const file = join(dir, "locked");
    Deno.writeTextFileSync(file, "");
    Deno.chmodSync(file, 0o000);
    try {
      Deno.readTextFileSync(file);
      return true;
    } catch {
      return false;
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
};

/** What `promise` rejects with, or `undefined` where it resolves. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(() => undefined, (error: unknown) => error);

/** The message of the error `thrown` is, or the empty one where it is none. */
const messageOf = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : "";

/** The message of what `run` throws, or `undefined` where it returns. */
const thrownMessage = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return messageOf(error);
  }
  return undefined;
};

/** The selection of a defaulted native runtime, taken whole from `store`. */
const fromStore = (store: string, policy: string): SandboxRuntimeSelection => ({
  sandboxRuntimeKind: "runsc",
  sandboxRootfs: join(store, ROOTFS),
  sandboxCfcPolicy: policy,
  sandboxRunscBinary: join(store, SHIM),
  sandboxRuntimeChoice: {
    runtime: "runsc",
    source: "default",
    platform: "darwin",
    nativeStore: store,
  },
});

/**
 * The record of a runtime FreeBSD defaulted to: Docker, as every platform
 * with no native runtime does.
 */
const DEFAULTED_DOCKER = {
  runtime: "docker",
  source: "default",
  platform: "freebsd",
} as const;

/**
 * The record of a defaulted Docker's reason, on the platform `platform`,
 * which has no native runtime.
 */
const dockerDefaultReason = (platform: string): string =>
  `default on ${platform}: the native runtime is macOS and Linux only`;

describe("sandbox-runtime-default", () => {
  /** A directory of the case's own, with a home directory in it. */
  let root: string;
  let home: string;

  beforeEach(async () => {
    // Resolved, so a path an engine canonicalizes compares equal to it.
    root = await Deno.realPath(await Deno.makeTempDir());
    home = join(root, "home");
    await Deno.mkdir(home);
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  /** Where a case's store is, and the environment that leads there. */
  interface Location {
    name: string;
    place: () => {
      store: string;
      home: string | undefined;
      env: Record<string, string>;
    };
  }

  const LOCATIONS: readonly Location[] = [{
    name: "under `HOME`",
    place: () => ({ store: defaultStore(home), home, env: { HOME: home } }),
  }, {
    name: "named by `CFC_VM_HOME`",
    place: () => ({
      store: join(root, "vm"),
      home,
      env: { HOME: home, CFC_VM_HOME: join(root, "vm") },
    }),
  }, {
    name: "named by `CFC_VM_HOME` with `HOME` unset",
    place: () => ({
      store: join(root, "vm"),
      home: undefined,
      env: { CFC_VM_HOME: join(root, "vm") },
    }),
  }];

  /**
   * Makes a store at `location` in `state`, in place of whatever the case
   * made before it, and returns where it is and the environment naming it.
   */
  const arrange = async (location: Location, state: StoreState) => {
    await Deno.remove(root, { recursive: true });
    await Deno.mkdir(home, { recursive: true });
    const placed = location.place();
    await installStore(placed.store);
    await state.arrange(placed.store);
    return placed;
  };

  describe("resolveSandboxRuntimeSelection()", () => {
    describe("with a runtime named", () => {
      // A named runtime is taken as named, whatever the platform and whatever
      // the store holds: `docker` is Docker, and `runsc` is given the
      // companions that were named and nothing out of the store.

      for (const platform of ["darwin", "linux"] as const) {
        for (const runtime of ["docker", "runsc"] as const) {
          for (const location of LOCATIONS) {
            it(`returns \`${runtime}\` as the flag named it, on ${platform}, for a store ${location.name} in any state`, async () => {
              for (const state of STORE_STATES) {
                const { env } = await arrange(location, state);

                expect(
                  await resolveSandboxRuntimeSelection(env, {
                    sandboxRuntime: runtime,
                  }, { platform, flags: true }),
                ).toEqual({
                  sandboxRuntimeKind: runtime,
                  sandboxRuntimeChoice: { runtime, source: "flag" },
                });
              }
            });

            it(`returns \`${runtime}\` as the environment named it, on ${platform}, for a store ${location.name} in any state`, async () => {
              for (const state of STORE_STATES) {
                const { env } = await arrange(location, state);

                expect(
                  await resolveSandboxRuntimeSelection(
                    {
                      ...env,
                      CF_HARNESS_SANDBOX_RUNTIME: runtime,
                    },
                    {},
                    { platform, flags: false },
                  ),
                ).toEqual({
                  sandboxRuntimeKind: runtime,
                  sandboxRuntimeChoice: { runtime, source: "environment" },
                });
              }
            });
          }
        }

        it(`returns the runtime the flag names over the one the environment names, on ${platform}`, async () => {
          await installStore(defaultStore(home));
          const select = (flag: string, variable: string) =>
            resolveSandboxRuntimeSelection(
              {
                HOME: home,
                CF_HARNESS_SANDBOX_RUNTIME: variable,
              },
              { sandboxRuntime: flag },
              { platform, flags: true },
            );

          expect((await select("docker", "runsc")).sandboxRuntimeChoice)
            .toEqual({ runtime: "docker", source: "flag" });
          expect((await select("runsc", "docker")).sandboxRuntimeChoice)
            .toEqual({ runtime: "runsc", source: "flag" });
        });
      }

      it("returns the runtime a name written with white space around it names", async () => {
        for (const runtime of ["docker", "runsc"] as const) {
          expect(
            (await resolveSandboxRuntimeSelection(
              { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: ` ${runtime}\t` },
              {},
              { platform: "darwin", arch: "aarch64", flags: false },
            )).sandboxRuntimeChoice,
          ).toEqual({ runtime, source: "environment" });
          expect(
            (await resolveSandboxRuntimeSelection(
              { HOME: home },
              { sandboxRuntime: `\n${runtime} ` },
              { platform: "darwin", arch: "aarch64", flags: true },
            )).sandboxRuntimeChoice,
          ).toEqual({ runtime, source: "flag" });
        }
      });

      it("returns the policy under the home, and not the store's own, for a named `runsc` on macOS", async () => {
        await installStore(defaultStore(home));
        const select = () =>
          resolveSandboxRuntimeSelection(
            {
              HOME: home,
              CF_HARNESS_SANDBOX_RUNTIME: "runsc",
            },
            {},
            { platform: "darwin", arch: "aarch64", flags: false },
          );

        // The store's `policy.json` is there, and a named `runsc` takes none.
        expect((await select()).sandboxCfcPolicy).toBeUndefined();
        await Deno.mkdir(join(homePolicy(home), ".."), { recursive: true });
        await Deno.writeTextFile(homePolicy(home), "{}\n");
        expect((await select()).sandboxCfcPolicy).toBe(homePolicy(home));
      });
    });

    describe("for an entrypoint whose caller must name the runtime", () => {
      /** The refusal of an unnamed runtime where `flags` are or are not taken. */
      const mustName = (flags: boolean): string =>
        "No sandbox runtime is named, and this entrypoint takes no default: " +
        "Loom must name `docker` or `runsc`, with " +
        (flags ? "`--sandbox-runtime` or " : "") +
        "`CF_HARNESS_SANDBOX_RUNTIME`.";

      for (const flags of [true, false]) {
        it(`throws for an unnamed runtime, whatever store is there, naming ${flags ? "the flag and the variable" : "the variable alone"}`, async () => {
          for (const state of STORE_STATES.slice(0, 2)) {
            const { env } = await arrange(LOCATIONS[0], state);

            const refusal = await rejection(
              resolveSandboxRuntimeSelection(env, {}, {
                namedBy: "Loom",
                flags,
              }),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(refusal).toMatchObject({
              code: "invalid-request",
              message: mustName(flags),
            });
          }
        });
      }

      describe("given a platform too, which its type does not show", () => {
        // A caller typed as one that must name the runtime, whose value also
        // carries a platform: its type admits the value, which is what the
        // selection is handed at run time. It takes no default all the same.
        const both = { namedBy: "Loom", platform: "darwin" as const };
        const caller: { namedBy: string } = both;

        it("throws for an unnamed runtime, as for one given no platform", async () => {
          await installStore(defaultStore(home));

          const refusal = await rejection(
            resolveSandboxRuntimeSelection({ HOME: home }, {}, {
              ...caller,
              flags: true,
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({ message: mustName(true) });
        });

        it("refuses the interactive provisioning of an unnamed runtime, as for one given no platform", async () => {
          await installStore(defaultStore(home));

          const refusal = await rejection(
            resolveInteractiveProvisioning({}, root, { HOME: home }, {
              ...caller,
              homeDir: home,
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({ message: mustName(false) });
        });
      });

      it("throws for a runtime named by white space alone", async () => {
        expect(
          await rejection(
            resolveSandboxRuntimeSelection(
              { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: "  " },
              {},
              { namedBy: "Loom", flags: false },
            ),
          ),
        ).toMatchObject({ message: mustName(false) });
      });

      for (const runtime of ["docker", "runsc"] as const) {
        it(`returns \`${runtime}\` as named, by the flag or the environment, with a store set up`, async () => {
          await installStore(defaultStore(home));

          expect(
            await resolveSandboxRuntimeSelection(
              { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: runtime },
              {},
              { namedBy: "Loom", flags: false },
            ),
          ).toEqual({
            sandboxRuntimeKind: runtime,
            sandboxRuntimeChoice: { runtime, source: "environment" },
          });
          expect(
            await resolveSandboxRuntimeSelection(
              { HOME: home },
              { sandboxRuntime: runtime },
              { namedBy: "Loom", flags: true },
            ),
          ).toEqual({
            sandboxRuntimeKind: runtime,
            sandboxRuntimeChoice: { runtime, source: "flag" },
          });
        });
      }
    });

    describe("with no runtime named, off macOS and Linux", () => {
      for (const platform of ["windows", "freebsd"] as const) {
        for (const location of LOCATIONS) {
          it(`returns Docker by default on ${platform}, and nothing of a store ${location.name} in any state`, async () => {
            for (const state of STORE_STATES) {
              const { env } = await arrange(location, state);

              expect(
                await resolveSandboxRuntimeSelection(env, {}, {
                  platform,
                  flags: true,
                }),
              ).toEqual({
                sandboxRuntimeChoice: {
                  runtime: "docker",
                  source: "default",
                  platform,
                },
              });
            }
          });
        }
      }

      it("returns Docker by default without looking at any file", async () => {
        await installStore(defaultStore(home));
        let looks = 0;
        const counted = <T>(result: T) => () => {
          looks += 1;
          return Promise.resolve(result);
        };

        await resolveSandboxRuntimeSelection({ HOME: home }, {}, {
          platform: "freebsd",
          flags: true,
          pathExists: counted(true),
          lstat: counted(await Deno.lstat(home)),
        });

        expect(looks).toBe(0);
      });

      it("returns Docker by default for companions that describe `runsc`", async () => {
        expect(
          await resolveSandboxRuntimeSelection(
            {
              HOME: home,
              CF_HARNESS_SANDBOX_ROOTFS: "/named/rootfs",
              CF_HARNESS_RUNSC_BINARY: "/named/runsc",
              CF_HARNESS_RUNSC_CFC_POLICY: "/named/policy.json",
            },
            { sandboxRootfs: "/flag/rootfs", sandboxCfcPolicy: "/flag/p" },
            {
              platform: "freebsd",
              flags: true,
            },
          ),
        ).toEqual({ sandboxRuntimeChoice: DEFAULTED_DOCKER });
      });
    });

    describe("with no runtime named, on Linux", () => {
      /** Selects with nothing named on Linux, as root unless `uid` says. */
      const select = (
        env: Record<string, string | undefined>,
        explicit: Parameters<typeof resolveSandboxRuntimeSelection>[1] = {},
        options: {
          flags?: boolean;
          uid?: () => number | null;
          readSysctl?: (name: string) => Promise<string | undefined>;
          which?: (name: string) => string | undefined;
          homeDir?: string;
        } = {},
      ) =>
        resolveSandboxRuntimeSelection(env, explicit, {
          platform: "linux",
          flags: options.flags ?? true,
          uid: options.uid ?? (() => 0),
          which: options.which ?? withPasta,
          readSysctl: options.readSysctl ??
            (() => Promise.reject(new Error("no parameter is read for root"))),
          ...(options.homeDir !== undefined
            ? { homeDir: options.homeDir }
            : {}),
        });

      /** Every condition of a Linux store the selection tells apart. */
      const LINUX_STORE_STATES: readonly {
        name: string;
        arrange: (store: string) => Promise<void>;
        problem?: (store: string) => string;
      }[] = [{
        name: "set up",
        arrange: () => Promise.resolve(),
      }, {
        name: "absent",
        arrange: (store) => Deno.remove(store, { recursive: true }),
        problem: (store) =>
          [
            "`bin/runsc`, gVisor's `runsc`, is missing",
            "`images/kitchensink`, the rootfs a container runs from, is " +
            "missing",
            `no CFC policy is at \`${join(store, LINUX_POLICY)}\` (name ` +
            "one with `--sandbox-cfc-policy` or " +
            "`CF_HARNESS_RUNSC_CFC_POLICY`)",
          ].join("; "),
      }, {
        name: "without its `runsc`",
        arrange: (store) => Deno.remove(join(store, LINUX_RUNSC)),
        problem: () => "`bin/runsc`, gVisor's `runsc`, is missing",
      }, {
        name: "with a `runsc` that is not executable",
        arrange: (store) => Deno.chmod(join(store, LINUX_RUNSC), 0o644),
        problem: () =>
          "`bin/runsc`, gVisor's `runsc`, is not an executable file",
      }, {
        name: "with a directory where its `runsc` goes",
        arrange: (store) => swapKind(join(store, LINUX_RUNSC)),
        problem: () =>
          "`bin/runsc`, gVisor's `runsc`, is not an executable file",
      }, {
        name: "with a file where its `bin` directory goes",
        arrange: async (store) => {
          await Deno.remove(join(store, "bin"), { recursive: true });
          await Deno.writeTextFile(join(store, "bin"), "");
        },
        problem: () => "`bin/runsc`, gVisor's `runsc`, is missing",
      }, {
        name: "without its rootfs",
        arrange: (store) => Deno.remove(join(store, LINUX_ROOTFS)),
        problem: () =>
          "`images/kitchensink`, the rootfs a container runs from, is missing",
      }, {
        name: "with a file where its rootfs goes",
        arrange: (store) => swapKind(join(store, LINUX_ROOTFS)),
        problem: () =>
          "`images/kitchensink`, the rootfs a container runs from, is not " +
          "a directory",
      }, {
        name: "without a CFC policy",
        arrange: (store) => Deno.remove(join(store, LINUX_POLICY)),
        problem: (store) =>
          `no CFC policy is at \`${join(store, LINUX_POLICY)}\` (name one ` +
          "with `--sandbox-cfc-policy` or `CF_HARNESS_RUNSC_CFC_POLICY`)",
      }];

      for (const state of LINUX_STORE_STATES) {
        const problem = state.problem;
        if (problem === undefined) {
          it(`returns the native runtime from a store under \`HOME\` that is ${state.name}`, async () => {
            const store = await installLinuxStore(home);
            await state.arrange(store);

            expect(await select({ HOME: home })).toEqual(
              fromLinuxStore(store),
            );
          });
          continue;
        }

        it(`throws, naming what is in the way, for a store under \`HOME\` that is ${state.name}`, async () => {
          const store = await installLinuxStore(home);
          await state.arrange(store);

          const refusal = await rejection(select({ HOME: home }));

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "invalid-request",
            message: linuxNotSetUp(
              store,
              problem(store),
              DOCKER_BY_FLAG_OR_VARIABLE,
            ),
          });
        });
      }

      it("throws naming the variable alone for an entrypoint that takes no selection flag", async () => {
        const store = linuxStore(home);

        const refusal = await rejection(
          select({ HOME: home }, {}, { flags: false }),
        );

        expect(refusal).toMatchObject({
          message: linuxNotSetUp(
            store,
            [
              "`bin/runsc`, gVisor's `runsc`, is missing",
              "`images/kitchensink`, the rootfs a container runs from, is " +
              "missing",
              `no CFC policy is at \`${join(store, LINUX_POLICY)}\` (name ` +
              "one with `CF_HARNESS_RUNSC_CFC_POLICY`)",
            ].join("; "),
            DOCKER_BY_VARIABLE,
          ),
        });
        expect(messageOf(refusal)).not.toContain("--sandbox");
      });

      it("returns the native runtime from a store reached through symbolic links, which Linux's `runsc` reads by the paths they lead to", async () => {
        // The whole store is a link to one elsewhere, and its rootfs a link
        // to a directory elsewhere again.
        const elsewhere = join(root, "elsewhere");
        const store = await installLinuxStore(elsewhere);
        const rootfs = join(root, "rootfs");
        await Deno.mkdir(rootfs);
        await Deno.remove(join(store, LINUX_ROOTFS));
        await Deno.symlink(rootfs, join(store, LINUX_ROOTFS));
        await Deno.mkdir(join(linuxStore(home), ".."), { recursive: true });
        await Deno.symlink(store, linuxStore(home));

        expect(await select({ HOME: home })).toEqual(
          fromLinuxStore(linuxStore(home)),
        );
      });

      it("returns the native runtime rootless for a process that is not root, where the host allows it a user namespace", async () => {
        const store = await installLinuxStore(home);
        const read: string[] = [];

        expect(
          await select({ HOME: home }, {}, {
            uid: () => 1000,
            readSysctl: (name) => {
              read.push(name);
              // A kernel with none of the parameters keeps nothing from it,
              // and so does one with a parameter at a value that allows it.
              return Promise.resolve(
                name === "kernel.apparmor_restrict_unprivileged_userns"
                  ? "0"
                  : undefined,
              );
            },
          }),
        ).toEqual({
          ...withoutUnshare(fromLinuxStore(store)),
          sandboxRunscRootless: true,
        });
        expect(read).toEqual([
          "user.max_user_namespaces",
          "kernel.unprivileged_userns_clone",
          "kernel.apparmor_restrict_unprivileged_userns",
        ]);
      });

      it("returns the native runtime as root, reading nothing of user namespaces, for root", async () => {
        const store = await installLinuxStore(home);

        // The reader `select` gives root refuses to be asked anything.
        expect(await select({ HOME: home })).toEqual(fromLinuxStore(store));
      });

      for (
        const [name, value, means, lift] of [
          [
            "user.max_user_namespaces",
            "0",
            "allows no user namespace at all",
            "15000",
          ],
          [
            "kernel.unprivileged_userns_clone",
            "0",
            "allows none to a process that is not root",
            "1",
          ],
          [
            "kernel.apparmor_restrict_unprivileged_userns",
            "1",
            "has AppArmor refuse one to a process that is not root",
            "0",
          ],
        ] as const
      ) {
        it(`throws for a process that is not root where \`${name}\` is ${value}, before it looks at the store`, async () => {
          const refusal = await rejection(
            select({ HOME: home }, {}, {
              uid: () => 1000,
              readSysctl: (asked) =>
                Promise.resolve(asked === name ? value : undefined),
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "invalid-request",
            message: "No sandbox runtime is named, so the default applies, " +
              "which on Linux is the native `runsc` runtime, and this " +
              "process is not root (uid 1000), so the store's `runsc` runs " +
              "rootless, in a user namespace of its own, and " +
              `\`${name}\` is ${value}, which ${means}. Allow one with ` +
              `\`sudo sysctl -w ${name}=${lift}\` (and a file in ` +
              "`/etc/sysctl.d` to keep it across boots), or run as root, or " +
              DOCKER_BY_FLAG_OR_VARIABLE,
          });
        });
      }

      it("throws where a kernel parameter could not be read, rather than take user namespaces for allowed", async () => {
        await installLinuxStore(home);

        const refusal = await rejection(
          select({ HOME: home }, {}, {
            uid: () => 1000,
            readSysctl: () => Promise.reject(new Error("permission denied")),
          }),
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(messageOf(refusal)).toContain(
          "whether this host allows that could not be told: " +
            "`user.max_user_namespaces` could not be read (Error: permission " +
            "denied). Make `/proc/sys/user/max_user_namespaces` readable, or " +
            "run as root",
        );
      });

      it("throws where which user the process runs as cannot be read, rather than take it for root or not", async () => {
        await installLinuxStore(home);

        const refusal = await rejection(
          select({ HOME: home }, {}, {
            uid: () => {
              throw new Error("no sys access to uid");
            },
          }),
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(messageOf(refusal)).toContain(
          "which user this process runs as could not be read (Error: no sys " +
            "access to uid), so whether the store's `runsc` runs as root or " +
            "rootless is not known. Grant it `--allow-sys=uid`, or select",
        );
      });

      it("throws where the platform reports no user for the process, rather than take it for one that is not root", async () => {
        await installLinuxStore(home);

        const refusal = await rejection(
          select({ HOME: home }, {}, { uid: () => null }),
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(messageOf(refusal)).toContain(
          "which user this process runs as is not known (the platform " +
            "reports none), so whether the store's `runsc` runs as root or " +
            "rootless is not known. Select",
        );
      });

      it("returns the native runtime for a process that is not root where a `runsc` is named, which takes none from the store", async () => {
        const store = await installLinuxStore(home);
        await Deno.remove(join(store, LINUX_RUNSC));

        expect(
          await select(
            { HOME: home, CF_HARNESS_RUNSC_BINARY: "/usr/local/bin/runsc" },
            {},
            { uid: () => 1000, readSysctl: () => Promise.resolve(undefined) },
          ),
        ).toEqual({
          // The named `runsc` runs as it is, and pasta as this user does: no
          // `unshare`, which is root's alone.
          ...withoutUnshare(fromLinuxStore(store)),
          sandboxRunscBinary: "/usr/local/bin/runsc",
        });
      });

      it("returns the rootfs and the policy named in place of the store's, and looks for neither there", async () => {
        const store = await installLinuxStore(home);
        await Deno.remove(join(store, LINUX_ROOTFS));
        await Deno.remove(join(store, LINUX_POLICY));

        expect(
          await select(
            { HOME: home },
            { sandboxRootfs: "/named/rootfs", sandboxCfcPolicy: "/named/p" },
          ),
        ).toEqual({
          ...fromLinuxStore(store),
          sandboxRootfs: "/named/rootfs",
          sandboxCfcPolicy: "/named/p",
        });
      });

      it("throws for a rootfs given empty, which names none", async () => {
        const store = await installLinuxStore(home);

        expect(
          await rejection(select({ HOME: home }, { sandboxRootfs: "" })),
        ).toMatchObject({
          message: "No sandbox runtime is named, so the default applies, " +
            "which on Linux is the native `runsc` runtime, and " +
            "`--sandbox-rootfs` is given empty, which names no rootfs, where " +
            "that runtime runs only from one. Name a rootfs, or leave the " +
            "flag out to run from the store's own image, or " +
            DOCKER_BY_FLAG_OR_VARIABLE,
        });
        expect(await select({ HOME: home })).toEqual(fromLinuxStore(store));
      });

      it("throws for a setting of the Docker driver, whatever the store holds", async () => {
        await installLinuxStore(home);

        expect(
          await rejection(
            select(
              { HOME: home, CF_HARNESS_SANDBOX_IMAGE: "image" },
              { dockerDriverFlags: ["--cfc-result-dir"] },
            ),
          ),
        ).toMatchObject({
          message: "No sandbox runtime is named, so the default applies, " +
            "which on Linux is the native `runsc` runtime, and " +
            "`--cfc-result-dir` and `CF_HARNESS_SANDBOX_IMAGE` are settings " +
            "of the Docker driver, which the native runtime does not read. " +
            `Remove them, or ${DOCKER_BY_FLAG_OR_VARIABLE}`,
        });
      });

      it("throws for a store that cannot be located, with no home or a home that is not absolute", async () => {
        for (
          const [env, problem, remedy] of [
            [
              {},
              "its store cannot be located: `HOME` is not set",
              "Set `HOME`, under which the store is",
            ],
            [
              { HOME: "home" },
              "its store cannot be located: the home `home` is not an " +
              "absolute path",
              "Set `HOME` to an absolute path",
            ],
          ] as const
        ) {
          const refusal = await rejection(select(env));

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            message: "No sandbox runtime is named, so the default applies, " +
              `which on Linux is the native \`runsc\` runtime, and ${problem}. ` +
              `${remedy}, or ${DOCKER_BY_FLAG_OR_VARIABLE}`,
          });
        }
      });

      it("returns the store under the home an entrypoint kept aside from its environment", async () => {
        const store = await installLinuxStore(home);

        expect(await select({ HOME: undefined }, {}, { homeDir: home }))
          .toEqual(fromLinuxStore(store));
      });

      it("throws where no `pasta` gives the default network, naming passt and the networks that need none", async () => {
        await installLinuxStore(home);

        for (const named of [undefined, "bridge"]) {
          const refusal = await rejection(
            select(
              {
                HOME: home,
                ...(named !== undefined
                  ? { CF_HARNESS_DOCKER_NETWORK_MODE: named }
                  : {}),
              },
              {},
              { which: () => undefined },
            ),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            message: "No sandbox runtime is named, so the default applies, " +
              "which on Linux is the native `runsc` runtime, and its " +
              "network, which gives a container egress and the host at " +
              "`host.docker.internal`, is `pasta`'s, from passt, and no " +
              "`pasta` is on `PATH`. Install passt (`sudo apt install " +
              "passt`), or name a network with " +
              "`CF_HARNESS_DOCKER_NETWORK_MODE=none` or " +
              "`CF_HARNESS_DOCKER_NETWORK_MODE=host`, or " +
              DOCKER_BY_FLAG_OR_VARIABLE,
          });
        }
      });

      it("throws for root where no `unshare` gives pasta a mount namespace of its own", async () => {
        await installLinuxStore(home);

        const refusal = await rejection(
          select({ HOME: home }, {}, {
            which: (name) => name === "unshare" ? undefined : withPasta(name),
          }),
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(messageOf(refusal)).toContain(
          "its network is `pasta`'s, which for root runs in a mount namespace " +
            "of its own that `unshare` (util-linux) makes, and no `unshare` " +
            "is on `PATH`. Install util-linux, run as a user that is not " +
            "root, or name a network with",
        );
      });

      it("throws where no `setpriv` ties what pasta runs to pasta, for root and for a user that is not root", async () => {
        await installLinuxStore(home);

        for (const uid of [0, 1000]) {
          const refusal = await rejection(
            select({ HOME: home }, {}, {
              uid: () => uid,
              readSysctl: () => Promise.resolve(undefined),
              which: (name) => name === "setpriv" ? undefined : withPasta(name),
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(messageOf(refusal)).toContain(
            "its network is `pasta`'s, and a container under pasta outlives " +
              "a `pasta` that is stopped unless `setpriv` (util-linux) ties " +
              "it to pasta, and no `setpriv` is on `PATH`. Install " +
              "util-linux, or name a network with",
          );
        }
      });

      it("throws for a `runsc` named by a process that is not root on a host that allows it no user namespace, which pasta's network needs", async () => {
        await installLinuxStore(home);

        const refusal = await rejection(
          select(
            { HOME: home, CF_HARNESS_RUNSC_BINARY: "/usr/local/bin/runsc" },
            {},
            {
              uid: () => 1000,
              readSysctl: (name) =>
                Promise.resolve(
                  name === "kernel.unprivileged_userns_clone" ? "0" : undefined,
                ),
            },
          ),
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(messageOf(refusal)).toContain(
          "its network is `pasta`'s, and this process is not root (uid 1000), " +
            "so pasta runs in a user namespace of its own, and " +
            "`kernel.unprivileged_userns_clone` is 0, which allows none to a " +
            "process that is not root. Allow one with `sudo sysctl -w " +
            "kernel.unprivileged_userns_clone=1` (and a file in " +
            "`/etc/sysctl.d` to keep it across boots), run as root, or name " +
            "a network with `CF_HARNESS_DOCKER_NETWORK_MODE=none` or " +
            "`CF_HARNESS_DOCKER_NETWORK_MODE=host`",
        );
        // A network that needs no pasta needs no user namespace of it.
        expect(
          await select(
            {
              HOME: home,
              CF_HARNESS_RUNSC_BINARY: "/usr/local/bin/runsc",
              CF_HARNESS_DOCKER_NETWORK_MODE: "none",
            },
            {},
            {
              uid: () => 1000,
              readSysctl: () => Promise.reject(new Error("not read")),
            },
          ),
        ).toMatchObject({ sandboxRunscNetworkMode: "none" });
      });

      it("throws for a `runsc` named by a process whose user cannot be read, rather than guess how pasta runs", async () => {
        await installLinuxStore(home);
        const binary = join(home, "own-runsc");
        await Deno.writeTextFile(binary, "#!/bin/sh\n", { mode: 0o755 });

        const refusal = await rejection(
          select({ HOME: home, CF_HARNESS_RUNSC_BINARY: binary }, {}, {
            uid: () => {
              throw new Error("not capable");
            },
          }),
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(messageOf(refusal)).toContain(
          "which user this process runs as could not be read (Error: not " +
            "capable), so whether `pasta` runs as root, in a mount namespace " +
            "of its own, or in a user namespace of its own is not known. " +
            "Grant it `--allow-sys=uid`",
        );
      });

      it("returns the native runtime with no `pasta` where a network that needs none is named", async () => {
        const store = await installLinuxStore(home);
        const {
          sandboxRunscNetworkHelper: _,
          sandboxRunscUnshare: __,
          sandboxRunscSetpriv: ___,
          ...withoutPasta
        } = fromLinuxStore(store);

        for (const named of ["none", "host"] as const) {
          expect(
            await select(
              { HOME: home, CF_HARNESS_DOCKER_NETWORK_MODE: named },
              {},
              { which: () => undefined },
            ),
          ).toEqual({ ...withoutPasta, sandboxRunscNetworkMode: named });
        }
      });

      it("maps the network named in Docker's words onto runsc's", async () => {
        const store = await installLinuxStore(home);

        for (
          const [named, mode] of [
            ["none", "none"],
            ["bridge", "sandbox"],
            ["host", "host"],
          ] as const
        ) {
          const {
            sandboxRunscNetworkHelper: _,
            sandboxRunscUnshare: __,
            sandboxRunscSetpriv: ___,
            ...withoutPasta
          } = fromLinuxStore(store);
          expect(
            await select({
              HOME: home,
              CF_HARNESS_DOCKER_NETWORK_MODE: named,
            }),
          ).toEqual({
            // Pasta gives runsc's own network alone.
            ...(mode === "sandbox" ? fromLinuxStore(store) : withoutPasta),
            sandboxRunscNetworkMode: mode,
          });
        }
      });
    });

    describe("with no runtime named, on a Mac that is not Apple silicon", () => {
      it("throws, whatever the store holds, saying the native runtime needs Apple silicon", async () => {
        for (const state of STORE_STATES.slice(0, 2)) {
          const { env } = await arrange(LOCATIONS[0], state);

          for (const flags of [true, false]) {
            const refusal = await rejection(
              resolveSandboxRuntimeSelection(env, {}, {
                platform: "darwin",
                arch: "x86_64",
                flags,
              }),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(refusal).toMatchObject({
              code: "invalid-request",
              message: "No sandbox runtime is named, so the default applies, " +
                "which on macOS is the native `runsc` runtime, and that " +
                "runtime runs only on Apple silicon, where this process runs " +
                "on `x86_64`. S" +
                (flags ? DOCKER_BY_FLAG_OR_VARIABLE : DOCKER_BY_VARIABLE)
                  .slice(1),
            });
          }
        }
      });

      it("returns the runtime that is named, as on any Mac", async () => {
        for (const runtime of ["docker", "runsc"] as const) {
          expect(
            (await resolveSandboxRuntimeSelection(
              { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: runtime },
              {},
              { platform: "darwin", arch: "x86_64", flags: false },
            )).sandboxRuntimeChoice,
          ).toEqual({ runtime, source: "environment" });
        }
      });
    });

    describe("with no runtime named, on macOS", () => {
      for (const location of LOCATIONS) {
        for (const state of STORE_STATES) {
          if (state.problem === undefined) {
            it(`returns the native runtime from a store ${location.name} that is ${state.name}`, async () => {
              const { store, env } = await arrange(location, state);

              expect(
                await resolveSandboxRuntimeSelection(env, {}, {
                  platform: "darwin",
                  arch: "aarch64",
                  flags: true,
                }),
              ).toEqual(fromStore(store, join(store, POLICY)));
            });
            continue;
          }
          const problem = state.problem;

          it(`throws, naming what is in the way, for a store ${location.name} that is ${state.name}`, async () => {
            const { store, home, env } = await arrange(location, state);

            const refusal = await rejection(
              resolveSandboxRuntimeSelection(env, {}, {
                platform: "darwin",
                arch: "aarch64",
                flags: true,
              }),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(refusal).toMatchObject({
              code: "invalid-request",
              message: notSetUp(
                store,
                problem(store, home),
                DOCKER_BY_FLAG_OR_VARIABLE,
              ),
            });
          });
        }
      }

      it("throws naming the variable alone for an entrypoint that takes no selection flag", async () => {
        const refusal = await rejection(
          resolveSandboxRuntimeSelection({ HOME: home }, {}, {
            platform: "darwin",
            arch: "aarch64",
            flags: false,
          }),
        );

        // No store was made, so every piece and the policy are in the way;
        // neither the remedy for the policy nor the way to Docker names a
        // flag this entrypoint would refuse.
        const store = defaultStore(home);
        expect(refusal).toMatchObject({
          message: notSetUp(
            store,
            [
              "`bin/runsc`, the `runsc` shim, is missing",
              "`bin/cfc-vm`, the VM daemon the shim starts, is missing",
              "`config.json`, the VM's configuration, is missing",
              "`images/kitchensink`, the rootfs a container names, is missing",
              "`ext4/kitchensink.ext4`, the image that rootfs runs from, is missing",
              noPolicyProblem(store, home, false),
            ].join("; "),
            DOCKER_BY_VARIABLE,
          ),
        });
        expect(messageOf(refusal)).not.toContain("--sandbox");
      });

      it("throws for a store that cannot be located, with neither `CFC_VM_HOME` nor a home", async () => {
        for (const env of [{}, { HOME: "", CFC_VM_HOME: "" }]) {
          const refusal = await rejection(
            resolveSandboxRuntimeSelection(env, {}, {
              platform: "darwin",
              arch: "aarch64",
              flags: true,
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            message:
              "No sandbox runtime is named, so the default applies, which on " +
              "macOS is the native `runsc` runtime, and its store cannot be " +
              "located: neither `CFC_VM_HOME` nor `HOME` is set. Set " +
              "`CFC_VM_HOME` to the store, or " + DOCKER_BY_FLAG_OR_VARIABLE,
          });
        }
      });

      it("throws for a store whose path is not absolute, from `CFC_VM_HOME` or from the home", async () => {
        await installStore(defaultStore(home));

        for (
          const [env, store] of [
            [{ HOME: home, CFC_VM_HOME: "stores/vm" }, "stores/vm"],
            [{ HOME: "home" }, defaultStore("home")],
          ] as const
        ) {
          const refusal = await rejection(
            resolveSandboxRuntimeSelection(env, {}, {
              platform: "darwin",
              arch: "aarch64",
              flags: false,
              cwd: root,
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            message:
              "No sandbox runtime is named, so the default applies, which on " +
              "macOS is the native `runsc` runtime, and its store cannot be " +
              `located: \`${store}\` is not an absolute path. Set ` +
              "`CFC_VM_HOME` to the store's absolute path, or " +
              DOCKER_BY_VARIABLE,
          });
        }
      });

      it("returns the store under the home for a `CFC_VM_HOME` that is empty", async () => {
        const store = defaultStore(home);
        await installStore(store);

        expect(
          await resolveSandboxRuntimeSelection(
            { HOME: home, CFC_VM_HOME: "" },
            {},
            { platform: "darwin", arch: "aarch64", flags: true },
          ),
        ).toEqual(fromStore(store, join(store, POLICY)));
      });

      it("returns the store `CFC_VM_HOME` names over a set-up one under the home", async () => {
        await installStore(defaultStore(home));
        const named = join(root, "vm");
        const select = () =>
          resolveSandboxRuntimeSelection(
            { HOME: home, CFC_VM_HOME: named },
            {},
            { platform: "darwin", arch: "aarch64", flags: true },
          );

        // The store the variable names is the one the macOS `runsc` will use,
        // so a set-up store elsewhere does not stand in for it.
        expect(await rejection(select())).toMatchObject({
          message: expect.stringContaining(`not set up at \`${named}\``),
        });
        await installStore(named);
        expect(await select()).toEqual(fromStore(named, join(named, POLICY)));
      });

      it("returns the store under the home an entrypoint kept aside from its environment", async () => {
        const store = defaultStore(home);
        await installStore(store);
        await Deno.mkdir(join(homePolicy(home), ".."), { recursive: true });
        await Deno.writeTextFile(homePolicy(home), "{}\n");

        expect(
          await resolveSandboxRuntimeSelection({ HOME: undefined }, {}, {
            platform: "darwin",
            arch: "aarch64",
            flags: true,
            homeDir: home,
          }),
        ).toEqual(fromStore(store, homePolicy(home)));
      });

      describe("a rootfs named empty", () => {
        it("throws for `--sandbox-rootfs` given empty, which names no rootfs, with a store set up", async () => {
          await installStore(defaultStore(home));

          const refusal = await rejection(
            resolveSandboxRuntimeSelection(
              { HOME: home },
              { sandboxRootfs: "" },
              { platform: "darwin", arch: "aarch64", flags: true },
            ),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "invalid-request",
            message: "No sandbox runtime is named, so the default applies, " +
              "which on macOS is the native `runsc` runtime, and " +
              "`--sandbox-rootfs` is given empty, which names no rootfs, " +
              "where that runtime runs only from one. Name a rootfs, or " +
              "leave the flag out to run from the store's own image, or " +
              DOCKER_BY_FLAG_OR_VARIABLE,
          });
        });

        it("throws naming the variable alone for a rootfs given empty to an entrypoint that takes no selection flags", async () => {
          await installStore(defaultStore(home));

          const refusal = await rejection(
            resolveSandboxRuntimeSelection(
              { HOME: home },
              { sandboxRootfs: "" },
              { platform: "darwin", arch: "aarch64", flags: false },
            ),
          );

          expect(refusal).toMatchObject({
            code: "invalid-request",
            message: "No sandbox runtime is named, so the default applies, " +
              "which on macOS is the native `runsc` runtime, and a rootfs " +
              "is given empty, which names none, where that runtime runs " +
              "only from one. Name a rootfs with " +
              "`CF_HARNESS_SANDBOX_ROOTFS`, or leave it unnamed to run from " +
              "the store's own image, or " + DOCKER_BY_VARIABLE,
          });
        });

        it("returns a named `runsc` with no rootfs for `--sandbox-rootfs` given empty, leaving it to the driver's default", async () => {
          await installStore(defaultStore(home));

          expect(
            await resolveSandboxRuntimeSelection(
              { HOME: home },
              { sandboxRuntime: "runsc", sandboxRootfs: "" },
              { platform: "darwin", arch: "aarch64", flags: true },
            ),
          ).toEqual({
            sandboxRuntimeKind: "runsc",
            sandboxRuntimeChoice: { runtime: "runsc", source: "flag" },
          });
        });

        it("returns the store's own image for `CF_HARNESS_SANDBOX_ROOTFS` set empty, which names nothing", async () => {
          const store = defaultStore(home);
          await installStore(store);

          expect(
            await resolveSandboxRuntimeSelection(
              { HOME: home, CF_HARNESS_SANDBOX_ROOTFS: "" },
              {},
              { platform: "darwin", arch: "aarch64", flags: true },
            ),
          ).toEqual(fromStore(store, join(store, POLICY)));
        });

        it("refuses a batch run given `--sandbox-rootfs` empty with no runtime named on macOS", async () => {
          await installStore(defaultStore(home));
          const stderr: string[] = [];

          const exitCode = await runCfHarnessCli(
            [
              "--model-provider",
              "openai-compatible-gateway",
              "--gateway-auth-mode",
              "none",
              "--sandbox-rootfs",
              "",
              "--prompt",
              "hello",
            ],
            {
              io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
              env: { HOME: home },
              platform: "darwin",
              arch: "aarch64",
              cwd: root,
              registerSignalHandler: () => () => {},
              createPromptLoop: () => {
                throw new Error("no loop is built for a refused run");
              },
            },
          );

          expect(exitCode).toBe(1);
          expect(stderr.join("")).toContain(
            "`--sandbox-rootfs` is given empty, which names no rootfs",
          );
        });
      });

      describe("a piece of the store that is a link", () => {
        /** Each piece of an installed store, and what a link to it holds. */
        const PIECES = [
          { piece: SHIM, what: "the `runsc` shim", directory: false },
          {
            piece: DAEMON,
            what: "the VM daemon the shim starts",
            directory: false,
          },
          { piece: CONFIG, what: "the VM's configuration", directory: false },
          {
            piece: ROOTFS,
            what: "the rootfs a container names",
            directory: true,
          },
          {
            piece: IMAGE,
            what: "the image that rootfs runs from",
            directory: false,
          },
        ];

        /** What the refusal says each linked piece has to be instead. */
        const MUST_BE_ITSELF = "each of `bin/runsc`, `bin/cfc-vm`, " +
          "`config.json`, `images/kitchensink` and `ext4/kitchensink.ext4` " +
          "has to be the file or directory itself, as gVisor's installer " +
          "writes it, and not a link to one";

        for (const { piece, what, directory } of PIECES) {
          it(`throws for \`${piece}\` that is a link to a ${directory ? "directory" : "file"} of the right kind, naming the piece and its target`, async () => {
            const store = defaultStore(home);
            await installStore(store);
            // The real thing, moved out of the store and linked back in.
            const target = join(root, "elsewhere");
            await Deno.rename(join(store, piece), target);
            await Deno.symlink(target, join(store, piece));

            const refusal = await rejection(
              resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                platform: "darwin",
                arch: "aarch64",
                flags: true,
              }),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(refusal).toMatchObject({
              message: notSetUp(
                store,
                `\`${piece}\`, ${what}, is a symbolic link to ` +
                  `\`${target}\`; ${MUST_BE_ITSELF}`,
                DOCKER_BY_FLAG_OR_VARIABLE,
              ),
            });
          });
        }

        it("names every piece that is a link, and says once what they have to be", async () => {
          const store = defaultStore(home);
          await installStore(store);
          for (const piece of [CONFIG, ROOTFS]) {
            const target = join(
              root,
              `elsewhere-${piece.replaceAll("/", "-")}`,
            );
            await Deno.rename(join(store, piece), target);
            await Deno.symlink(target, join(store, piece));
          }

          expect(
            messageOf(
              await rejection(
                resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                  platform: "darwin",
                  arch: "aarch64",
                  flags: true,
                }),
              ),
            ),
          ).toBe(
            notSetUp(
              store,
              "`config.json`, the VM's configuration, is a symbolic link to " +
                `\`${join(root, "elsewhere-config.json")}\`; ` +
                "`images/kitchensink`, the rootfs a container names, is a " +
                "symbolic link to " +
                `\`${join(root, "elsewhere-images-kitchensink")}\`; ` +
                MUST_BE_ITSELF,
              DOCKER_BY_FLAG_OR_VARIABLE,
            ),
          );
        });

        it("says what has to be itself of the pieces it takes from the store alone, where a named binary replaces the shim and the daemon", async () => {
          const store = defaultStore(home);
          await installStore(store);
          const target = join(root, "elsewhere");
          await Deno.rename(join(store, CONFIG), target);
          await Deno.symlink(target, join(store, CONFIG));

          expect(
            messageOf(
              await rejection(
                resolveSandboxRuntimeSelection(
                  { HOME: home, CF_HARNESS_RUNSC_BINARY: "/named/runsc" },
                  {},
                  { platform: "darwin", arch: "aarch64", flags: true },
                ),
              ),
            ),
          ).toBe(
            notSetUp(
              store,
              "`config.json`, the VM's configuration, is a symbolic link to " +
                `\`${target}\`; each of \`config.json\`, ` +
                "`images/kitchensink` and `ext4/kitchensink.ext4` has to be " +
                "the file or directory itself, as gVisor's installer writes " +
                "it, and not a link to one",
              DOCKER_BY_FLAG_OR_VARIABLE,
            ),
          );
        });

        for (
          const [directory, pieces] of [
            ["bin", [
              [SHIM, "the `runsc` shim"],
              [DAEMON, "the VM daemon the shim starts"],
            ]],
            ["images", [[ROOTFS, "the rootfs a container names"]]],
            ["ext4", [[IMAGE, "the image that rootfs runs from"]]],
          ] as const
        ) {
          it(`throws for \`${directory}\` that is a link to a directory outside the store, naming it as what each piece in it is reached through`, async () => {
            const store = defaultStore(home);
            await installStore(store);
            // The real directory, moved out of the store and linked back in:
            // every piece in it is then a file or directory of the right
            // kind, at its own name, behind the link.
            const target = join(root, `outside-${directory}`);
            await Deno.rename(join(store, directory), target);
            await Deno.symlink(target, join(store, directory));

            const refusal = await rejection(
              resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                platform: "darwin",
                arch: "aarch64",
                flags: true,
              }),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(messageOf(refusal)).toBe(
              notSetUp(
                store,
                [
                  ...pieces.map(([piece, what]) =>
                    `\`${piece}\`, ${what}, is reached through ` +
                    `\`${directory}\`, a symbolic link to \`${target}\``
                  ),
                  MUST_BE_ITSELF,
                ].join("; "),
                DOCKER_BY_FLAG_OR_VARIABLE,
              ),
            );
          });
        }

        it("says a piece behind a directory that cannot be examined could not be examined, not that it is missing", async () => {
          const store = defaultStore(home);
          await installStore(store);

          const refusal = await rejection(
            resolveSandboxRuntimeSelection({ HOME: home }, {}, {
              platform: "darwin",
              arch: "aarch64",
              flags: true,
              lstat: (path) =>
                path === join(store, "images")
                  ? Promise.reject(new Deno.errors.PermissionDenied("locked"))
                  : Deno.lstat(path),
            }),
          );

          expect(messageOf(refusal)).toBe(
            notSetUp(
              store,
              "`images/kitchensink`, the rootfs a container names, could " +
                "not be examined (PermissionDenied: locked)",
              DOCKER_BY_FLAG_OR_VARIABLE,
            ),
          );
        });

        it("returns the native runtime where a link is in a piece a named setting replaces", async () => {
          const store = defaultStore(home);
          await installStore(store);
          const target = join(root, "elsewhere");
          await Deno.rename(join(store, ROOTFS), target);
          await Deno.symlink(target, join(store, ROOTFS));

          const selected = await resolveSandboxRuntimeSelection(
            { HOME: home, CF_HARNESS_SANDBOX_ROOTFS: "/named/rootfs" },
            {},
            { platform: "darwin", arch: "aarch64", flags: true },
          );

          expect(selected.sandboxRootfs).toBe("/named/rootfs");
        });
      });

      describe("a piece this process cannot use", () => {
        it({
          name: "throws for a `config.json` it cannot read, saying so",
          // Root reads a file whatever its mode, so the case is skipped where
          // the file can be read anyway.
          ignore: readsDespiteMode(),
          fn: async () => {
            const store = defaultStore(home);
            await installStore(store);
            await Deno.chmod(join(store, CONFIG), 0o000);

            const message = messageOf(
              await rejection(
                resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                  platform: "darwin",
                  arch: "aarch64",
                  flags: true,
                }),
              ),
            );

            expect(message).toContain(
              "`config.json`, the VM's configuration, could not be read " +
                "(PermissionDenied",
            );
            expect(message).not.toContain("is missing");
          },
        });

        it({
          name: "throws for an image it cannot read, saying so",
          ignore: readsDespiteMode(),
          fn: async () => {
            const store = defaultStore(home);
            await installStore(store);
            await Deno.chmod(join(store, IMAGE), 0o000);

            expect(
              messageOf(
                await rejection(
                  resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                    platform: "darwin",
                    arch: "aarch64",
                    flags: true,
                  }),
                ),
              ),
            ).toContain(
              "`ext4/kitchensink.ext4`, the image that rootfs runs from, " +
                "could not be read (PermissionDenied",
            );
          },
        });

        it({
          name:
            "throws for a shim whose execute bits are another class's than this process's, saying it is not executable",
          // Executable by group and others, and not by its owner, which this
          // process is: some execute bit is set, and none this process can
          // use. Root executes it anyway, so the case is skipped where root
          // reads what it should not.
          ignore: readsDespiteMode(),
          fn: async () => {
            const store = defaultStore(home);
            await installStore(store);
            await Deno.chmod(join(store, SHIM), 0o011);

            expect(
              messageOf(
                await rejection(
                  resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                    platform: "darwin",
                    arch: "aarch64",
                    flags: true,
                  }),
                ),
              ),
            ).toBe(
              notSetUp(
                store,
                "`bin/runsc`, the `runsc` shim, is not executable by this " +
                  "process",
                DOCKER_BY_FLAG_OR_VARIABLE,
              ),
            );
          },
        });

        it("throws for a daemon the access check says this process cannot execute", async () => {
          const store = defaultStore(home);
          await installStore(store);

          expect(
            messageOf(
              await rejection(
                resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                  platform: "darwin",
                  arch: "aarch64",
                  flags: true,
                  canExecute: (path) =>
                    Promise.resolve(path !== join(store, DAEMON)),
                }),
              ),
            ),
          ).toBe(
            notSetUp(
              store,
              "`bin/cfc-vm`, the VM daemon the shim starts, is not " +
                "executable by this process",
              DOCKER_BY_FLAG_OR_VARIABLE,
            ),
          );
        });

        it("throws for a binary the access check could not be run on, with the reason", async () => {
          const store = defaultStore(home);
          await installStore(store);

          expect(
            messageOf(
              await rejection(
                resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                  platform: "darwin",
                  arch: "aarch64",
                  flags: true,
                  canExecute: (path) =>
                    path === join(store, SHIM)
                      ? Promise.reject(new Error("no access check here"))
                      : Promise.resolve(true),
                }),
              ),
            ),
          ).toBe(
            notSetUp(
              store,
              "`bin/runsc`, the `runsc` shim, could not be examined " +
                "(Error: no access check here)",
              DOCKER_BY_FLAG_OR_VARIABLE,
            ),
          );
        });

        it("returns the native runtime from a store whose pieces it can read and execute, as the access check finds", async () => {
          const store = defaultStore(home);
          await installStore(store);

          expect(
            await resolveSandboxRuntimeSelection({ HOME: home }, {}, {
              platform: "darwin",
              arch: "aarch64",
              flags: true,
            }),
          ).toEqual(fromStore(store, join(store, POLICY)));
        });
      });

      it("throws for a piece of the store that cannot be examined, with the reason", async () => {
        const store = defaultStore(home);
        await installStore(store);

        const refusal = await rejection(
          resolveSandboxRuntimeSelection({ HOME: home }, {}, {
            platform: "darwin",
            arch: "aarch64",
            flags: true,
            lstat: (path) =>
              path === join(store, CONFIG)
                ? Promise.reject(new Deno.errors.PermissionDenied("locked"))
                : Deno.lstat(path),
          }),
        );

        expect(refusal).toMatchObject({
          message: notSetUp(
            store,
            "`config.json`, the VM's configuration, could not be examined " +
              "(PermissionDenied: locked)",
            DOCKER_BY_FLAG_OR_VARIABLE,
          ),
        });
      });

      it("takes the store and the policy under the home an entrypoint names, over `HOME`", async () => {
        const kept = join(root, "kept-home");
        await installStore(defaultStore(kept));
        await Deno.mkdir(join(homePolicy(kept), ".."), { recursive: true });
        await Deno.writeTextFile(homePolicy(kept), "{}\n");
        const select = () =>
          resolveSandboxRuntimeSelection({ HOME: home }, {}, {
            platform: "darwin",
            arch: "aarch64",
            flags: true,
            homeDir: kept,
          });

        // `HOME` holds no store, and the selection does not look there.
        expect(await select()).toEqual(
          fromStore(defaultStore(kept), homePolicy(kept)),
        );
        // And a store under `HOME` does not stand in for the named home's.
        await Deno.remove(kept, { recursive: true });
        await installStore(defaultStore(home));
        expect(await rejection(select())).toMatchObject({
          message: expect.stringContaining(
            `not set up at \`${defaultStore(kept)}\``,
          ),
        });
      });

      describe("a setting of the Docker driver", () => {
        const FLAGS = [
          "--sandbox-image",
          "--sandbox-docker-runtime",
          "--cfc-result-dir",
          "--cfc-invocation-context-dir",
        ] as const;
        const VARIABLES = [
          "CF_HARNESS_SANDBOX_IMAGE",
          "CF_HARNESS_SANDBOX_DOCKER_RUNTIME",
          "CF_HARNESS_RUNSC_CFC_RESULT_DIR",
          "CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR",
        ] as const;

        /** The refusal of `settings`, already written as code spans. */
        const dockerOnly = (settings: string, docker: string): string =>
          "No sandbox runtime is named, so the default applies, which on " +
          `macOS is the native \`runsc\` runtime, and ${settings} of the ` +
          "Docker driver, which the native runtime does not read. Remove " +
          `${settings.includes(" and ") ? "them" : "it"}, or ${docker}`;

        beforeEach(async () => {
          await installStore(defaultStore(home));
        });

        for (const flag of FLAGS) {
          it(`throws for \`${flag}\` given with no runtime named`, async () => {
            const refusal = await rejection(
              resolveSandboxRuntimeSelection({ HOME: home }, {
                dockerDriverFlags: [flag],
              }, { platform: "darwin", arch: "aarch64", flags: true }),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(refusal).toMatchObject({
              code: "invalid-request",
              message: dockerOnly(
                `\`${flag}\` is a setting`,
                DOCKER_BY_FLAG_OR_VARIABLE,
              ),
            });
          });
        }

        for (const variable of VARIABLES) {
          it(`throws for \`${variable}\` set with no runtime named, and keeps its value out of the message`, async () => {
            const refusal = await rejection(
              resolveSandboxRuntimeSelection(
                { HOME: home, [variable]: "/a/value/nobody/should/see" },
                {},
                { platform: "darwin", arch: "aarch64", flags: false },
              ),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(refusal).toMatchObject({
              message: dockerOnly(
                `\`${variable}\` is a setting`,
                DOCKER_BY_VARIABLE,
              ),
            });
          });
        }

        it("throws naming every one given, flags before variables", async () => {
          const refusal = await rejection(
            resolveSandboxRuntimeSelection(
              {
                HOME: home,
                CF_HARNESS_SANDBOX_IMAGE: "registry.example/secret:tag",
                CF_HARNESS_RUNSC_CFC_RESULT_DIR: "/secret/results",
              },
              { dockerDriverFlags: ["--sandbox-docker-runtime"] },
              {
                platform: "darwin",
                arch: "aarch64",
                flags: true,
              },
            ),
          );

          expect(refusal).toMatchObject({
            message: dockerOnly(
              "`--sandbox-docker-runtime`, `CF_HARNESS_SANDBOX_IMAGE` and " +
                "`CF_HARNESS_RUNSC_CFC_RESULT_DIR` are settings",
              DOCKER_BY_FLAG_OR_VARIABLE,
            ),
          });
          expect(messageOf(refusal)).not.toContain("secret");
        });

        it("throws for one before it looks for a store", async () => {
          await Deno.remove(defaultStore(home), { recursive: true });

          expect(
            await rejection(
              resolveSandboxRuntimeSelection(
                { HOME: home, CF_HARNESS_SANDBOX_IMAGE: "image:1" },
                {},
                { platform: "darwin", arch: "aarch64", flags: false },
              ),
            ),
          ).toMatchObject({
            message: dockerOnly(
              "`CF_HARNESS_SANDBOX_IMAGE` is a setting",
              DOCKER_BY_VARIABLE,
            ),
          });
        });

        it("returns the native runtime for a variable set to nothing", async () => {
          const store = defaultStore(home);

          expect(
            await resolveSandboxRuntimeSelection(
              {
                HOME: home,
                CF_HARNESS_SANDBOX_IMAGE: "",
                CF_HARNESS_RUNSC_CFC_RESULT_DIR: "  ",
              },
              { dockerDriverFlags: [] },
              { platform: "darwin", arch: "aarch64", flags: true },
            ),
          ).toEqual(fromStore(store, join(store, POLICY)));
        });

        it("returns a named runtime with every one of them given, on macOS", async () => {
          const env = {
            HOME: home,
            ...Object.fromEntries(VARIABLES.map((name) => [name, "/set"])),
          };

          for (const runtime of ["docker", "runsc"] as const) {
            expect(
              await resolveSandboxRuntimeSelection(
                { ...env, CF_HARNESS_SANDBOX_RUNTIME: runtime },
                { dockerDriverFlags: FLAGS },
                { platform: "darwin", arch: "aarch64", flags: true },
              ),
            ).toEqual({
              sandboxRuntimeKind: runtime,
              sandboxRuntimeChoice: { runtime, source: "environment" },
            });
          }
        });

        it("returns Docker by default off macOS and Linux with every one of them given", async () => {
          expect(
            await resolveSandboxRuntimeSelection(
              {
                HOME: home,
                ...Object.fromEntries(VARIABLES.map((name) => [name, "/set"])),
              },
              { dockerDriverFlags: FLAGS },
              {
                platform: "freebsd",
                flags: true,
              },
            ),
          ).toEqual({ sandboxRuntimeChoice: DEFAULTED_DOCKER });
        });
      });

      describe("a policy path that runs through a file", () => {
        // Nothing can be at a path whose parent is not a directory, so such
        // a policy is known to be absent, as one that is simply not there is.
        let store: string;

        /** Puts a file where the directory of the home's policy goes. */
        const fileForPolicyDirectory = async () => {
          await Deno.mkdir(join(homePolicy(home), "..", ".."), {
            recursive: true,
          });
          await Deno.writeTextFile(join(homePolicy(home), ".."), "");
        };

        beforeEach(async () => {
          store = defaultStore(home);
          await installStore(store);
        });

        it("returns a named `runsc` with no policy where a file is where the policy's directory goes", async () => {
          await fileForPolicyDirectory();

          expect(
            await resolveSandboxRuntimeSelection(
              { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: "runsc" },
              {},
              { platform: "darwin", arch: "aarch64", flags: true },
            ),
          ).toEqual({
            sandboxRuntimeKind: "runsc",
            sandboxRuntimeChoice: { runtime: "runsc", source: "environment" },
          });
        });

        it("returns a named `runsc` with no policy where the home is a file", async () => {
          const file = join(root, "a-file");
          await Deno.writeTextFile(file, "");

          expect(
            await resolveSandboxRuntimeSelection(
              { HOME: file, CF_HARNESS_SANDBOX_RUNTIME: "runsc" },
              {},
              { platform: "linux", flags: true },
            ),
          ).toEqual({
            sandboxRuntimeKind: "runsc",
            sandboxRuntimeChoice: { runtime: "runsc", source: "environment" },
          });
        });

        it("returns the default with the store's own policy where a file is where the home policy's directory goes", async () => {
          await fileForPolicyDirectory();

          expect(
            await resolveSandboxRuntimeSelection({ HOME: home }, {}, {
              platform: "darwin",
              arch: "aarch64",
              flags: true,
            }),
          ).toEqual(fromStore(store, join(store, POLICY)));
        });
      });

      describe("a policy that cannot be examined", () => {
        let store: string;

        beforeEach(async () => {
          store = defaultStore(home);
          await installStore(store);
        });

        /** A look for a policy that fails at `unreadable` and works elsewhere. */
        const failingAt = (unreadable: string) => async (path: string) => {
          if (path === unreadable) {
            throw new Deno.errors.PermissionDenied("locked");
          }
          return (await Deno.stat(path).catch(() => undefined))?.isFile ??
            false;
        };

        it("throws for the one under the home, and does not take the store's in its place", async () => {
          const refusal = await rejection(
            resolveSandboxRuntimeSelection({ HOME: home }, {}, {
              platform: "darwin",
              arch: "aarch64",
              flags: true,
              pathExists: failingAt(homePolicy(home)),
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "invalid-request",
            message:
              "No sandbox runtime is named, so the default applies, which on " +
              "macOS is the native `runsc` runtime, and the CFC policy at " +
              `\`${homePolicy(home)}\` could not be read ` +
              "(PermissionDenied: locked), so whether it is a policy a run " +
              "could use is not known. Make it readable or name a policy with " +
              "`--sandbox-cfc-policy` or `CF_HARNESS_RUNSC_CFC_POLICY`, or " +
              DOCKER_BY_FLAG_OR_VARIABLE,
          });
        });

        it("throws for the store's own, where none is under the home", async () => {
          const refusal = await rejection(
            resolveSandboxRuntimeSelection({ HOME: home }, {}, {
              platform: "darwin",
              arch: "aarch64",
              flags: false,
              pathExists: failingAt(join(store, POLICY)),
            }),
          );

          expect(refusal).toMatchObject({
            message:
              "No sandbox runtime is named, so the default applies, which on " +
              "macOS is the native `runsc` runtime, and the CFC policy at " +
              `\`${join(store, POLICY)}\` could not be read ` +
              "(PermissionDenied: locked), so whether it is a policy a run " +
              "could use is not known. Make it readable or name a policy with " +
              "`CF_HARNESS_RUNSC_CFC_POLICY`, or " + DOCKER_BY_VARIABLE,
          });
        });

        it("throws for a named `runsc` too, which has no way to Docker to be told", async () => {
          const refusal = await rejection(
            resolveSandboxRuntimeSelection(
              { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: "runsc" },
              {},
              {
                platform: "linux",
                flags: true,
                pathExists: failingAt(homePolicy(home)),
              },
            ),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "invalid-request",
            message: `The CFC policy at \`${homePolicy(home)}\` could not be ` +
              "read (PermissionDenied: locked), so whether it is a policy a " +
              "run could use is not known. Make it readable or name a policy with " +
              "`--sandbox-cfc-policy` or `CF_HARNESS_RUNSC_CFC_POLICY`.",
          });
        });

        it("is not looked for where a policy is named, the empty one included", async () => {
          const never = () => Promise.reject(new Error("not asked"));

          for (
            const [env, explicit] of [
              [{ CF_HARNESS_RUNSC_CFC_POLICY: "/named.json" }, {}],
              [{}, { sandboxCfcPolicy: "" }],
            ] as const
          ) {
            const selected = await resolveSandboxRuntimeSelection(
              { HOME: home, ...env },
              explicit,
              {
                platform: "darwin",
                arch: "aarch64",
                flags: true,
                pathExists: never,
              },
            );

            expect(selected.sandboxRuntimeKind).toBe("runsc");
          }
        });

        it({
          name:
            "throws, read off the file system, for a policy under the home that is there and cannot be read",
          // Root reads a file whatever its mode, so the case can only be made
          // as another user, and is skipped where the file can be read anyway.
          ignore: readsDespiteMode(),
          fn: async () => {
            await Deno.mkdir(join(homePolicy(home), ".."), { recursive: true });
            await Deno.writeTextFile(homePolicy(home), "{}\n");
            await Deno.chmod(homePolicy(home), 0o000);

            const refusal = await rejection(
              resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                platform: "darwin",
                arch: "aarch64",
                flags: true,
              }),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(messageOf(refusal)).toContain(
              `the CFC policy at \`${homePolicy(home)}\` could not be read ` +
                "(PermissionDenied",
            );
          },
        });

        it({
          name:
            "throws, read off the file system, for the store's own policy where it is there and cannot be read",
          // As above: skipped where the file can be read anyway, as by root.
          ignore: readsDespiteMode(),
          fn: async () => {
            await Deno.chmod(join(store, POLICY), 0o000);

            const refusal = await rejection(
              resolveSandboxRuntimeSelection({ HOME: home }, {}, {
                platform: "darwin",
                arch: "aarch64",
                flags: true,
              }),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            expect(messageOf(refusal)).toContain(
              `the CFC policy at \`${join(store, POLICY)}\` could not be ` +
                "read (PermissionDenied",
            );
          },
        });

        it("throws, read off the file system, for a policy path that leads nowhere it can follow", async () => {
          // A link to itself: examining it fails, and not for its absence.
          await Deno.mkdir(join(homePolicy(home), ".."), { recursive: true });
          await Deno.symlink("cfc-policy.json", homePolicy(home));

          const refusal = await rejection(
            resolveSandboxRuntimeSelection({ HOME: home }, {}, {
              platform: "darwin",
              arch: "aarch64",
              flags: true,
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(messageOf(refusal)).toContain(
            `the CFC policy at \`${homePolicy(home)}\` could not be read (`,
          );
        });
      });

      describe("a store behind a link", () => {
        /** The refusal of a store written `given` that is at `canonical`. */
        const linked = (given: string, canonical: string): string =>
          "No sandbox runtime is named, so the default applies, which on " +
          "macOS is the native `runsc` runtime, and its store " +
          `\`${given}\` resolves to \`${canonical}\`, which the macOS ` +
          "`runsc` reads as another path: it compares paths as they are " +
          "written. Set `CFC_VM_HOME` to " +
          `\`${canonical}\`, or ${DOCKER_BY_VARIABLE}`;

        it("throws, naming where the store is, for a `CFC_VM_HOME` that is a link to it", async () => {
          const store = join(root, "vm");
          await installStore(store);
          const link = join(root, "vm-link");
          await Deno.symlink(store, link);

          const refusal = await rejection(
            resolveSandboxRuntimeSelection(
              { HOME: home, CFC_VM_HOME: link },
              {},
              { platform: "darwin", arch: "aarch64", flags: false },
            ),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "invalid-request",
            message: linked(link, store),
          });
        });

        it("throws for the store under a home that is reached through a link", async () => {
          await installStore(defaultStore(home));
          const linkedHome = join(root, "home-link");
          await Deno.symlink(home, linkedHome);

          expect(
            await rejection(
              resolveSandboxRuntimeSelection({ HOME: linkedHome }, {}, {
                platform: "darwin",
                arch: "aarch64",
                flags: false,
              }),
            ),
          ).toMatchObject({
            message: linked(defaultStore(linkedHome), defaultStore(home)),
          });
        });

        it("names the path past a link in the middle of the way to the home, as root's `/var/root` is", async () => {
          // `/var` on macOS is a link to `private/var`, and root's home is
          // under it, so root's default store is behind a link.
          const home = join(root, "private", "var", "root");
          await installStore(defaultStore(home));
          await Deno.symlink(join("private", "var"), join(root, "var"));
          const written = join(root, "var", "root");

          expect(
            await rejection(
              resolveSandboxRuntimeSelection({ HOME: written }, {}, {
                platform: "darwin",
                arch: "aarch64",
                flags: false,
              }),
            ),
          ).toMatchObject({
            message: linked(defaultStore(written), defaultStore(home)),
          });
        });

        it("throws for a link on the way to a store that is not there yet", async () => {
          const linkedHome = join(root, "home-link");
          await Deno.symlink(home, linkedHome);

          expect(
            await rejection(
              resolveSandboxRuntimeSelection({ HOME: linkedHome }, {}, {
                platform: "darwin",
                arch: "aarch64",
                flags: false,
              }),
            ),
          ).toMatchObject({
            message: linked(defaultStore(linkedHome), defaultStore(home)),
          });
        });

        it("returns the store by the path it is at, for one written with a trailing slash or a `.`", async () => {
          const store = join(root, "vm");
          await installStore(store);

          for (const written of [`${store}/`, `${root}/./vm`, `${store}//`]) {
            expect(
              await resolveSandboxRuntimeSelection(
                { HOME: home, CFC_VM_HOME: written },
                {},
                { platform: "darwin", arch: "aarch64", flags: true },
              ),
            ).toEqual(fromStore(store, join(store, POLICY)));
          }
        });

        it("throws for a store whose path cannot be followed, saying why", async () => {
          const loop = join(root, "loop");
          await Deno.symlink(loop, loop);
          const dangling = join(root, "dangling");
          await Deno.symlink(join(root, "nowhere"), dangling);

          for (
            const [given, why] of [
              [loop, "it leads through more than 40 symbolic links"],
              [dangling, "a symbolic link whose target does not exist"],
            ]
          ) {
            const refusal = await rejection(
              resolveSandboxRuntimeSelection(
                { HOME: home, CFC_VM_HOME: given },
                {},
                { platform: "darwin", arch: "aarch64", flags: true },
              ),
            );

            expect(refusal).toBeInstanceOf(HarnessControlError);
            const message = messageOf(refusal);
            expect(message).toContain("its store cannot be located: ");
            expect(message).toContain(why);
            expect(message.endsWith(`or ${DOCKER_BY_FLAG_OR_VARIABLE}`)).toBe(
              true,
            );
          }
        });
      });

      describe("the CFC policy", () => {
        let store: string;

        beforeEach(async () => {
          store = defaultStore(home);
          await installStore(store);
          await Deno.mkdir(join(homePolicy(home), ".."), { recursive: true });
          await Deno.writeTextFile(homePolicy(home), "{}\n");
        });

        const select = (
          env: Record<string, string>,
          explicit: { sandboxCfcPolicy?: string } = {},
        ) =>
          resolveSandboxRuntimeSelection({ HOME: home, ...env }, explicit, {
            platform: "darwin",
            arch: "aarch64",
            flags: true,
            cwd: root,
          });

        it("is the one under the home where both that and the store's own are there", async () => {
          expect((await select({})).sandboxCfcPolicy).toBe(homePolicy(home));
        });

        it("is the store's own where none is under the home", async () => {
          await Deno.remove(homePolicy(home));

          expect((await select({})).sandboxCfcPolicy).toBe(join(store, POLICY));
        });

        it("is the one the environment names, over both defaults", async () => {
          expect(
            (await select({ CF_HARNESS_RUNSC_CFC_POLICY: "named/policy.json" }))
              .sandboxCfcPolicy,
          ).toBe(join(root, "named", "policy.json"));
        });

        it("is the one the flag names, over the environment's", async () => {
          expect(
            (await select(
              { CF_HARNESS_RUNSC_CFC_POLICY: "/env/policy.json" },
              { sandboxCfcPolicy: "/flag/policy.json" },
            )).sandboxCfcPolicy,
          ).toBe("/flag/policy.json");
        });

        it("is none for a flag given empty, whatever the environment names and whichever default is there", async () => {
          const selected = await select(
            { CF_HARNESS_RUNSC_CFC_POLICY: "/env/policy.json" },
            { sandboxCfcPolicy: "" },
          );

          expect(selected.sandboxRuntimeKind).toBe("runsc");
          expect("sandboxCfcPolicy" in selected).toBe(false);
        });

        it("is none for a flag given empty with no policy anywhere, which is not refused for want of one", async () => {
          await Deno.remove(homePolicy(home));
          await Deno.remove(join(store, POLICY));

          const selected = await select({}, { sandboxCfcPolicy: "" });

          expect(selected.sandboxRuntimeKind).toBe("runsc");
          expect("sandboxCfcPolicy" in selected).toBe(false);
        });

        it("is a default for a variable set empty, which names nothing", async () => {
          expect(
            (await select({ CF_HARNESS_RUNSC_CFC_POLICY: " " }))
              .sandboxCfcPolicy,
          ).toBe(homePolicy(home));
        });
      });

      describe("a companion that is named", () => {
        let store: string;

        beforeEach(async () => {
          store = defaultStore(home);
          await installStore(store);
        });

        const select = (
          env: Record<string, string>,
          explicit: { sandboxRootfs?: string } = {},
        ) =>
          resolveSandboxRuntimeSelection({ HOME: home, ...env }, explicit, {
            platform: "darwin",
            arch: "aarch64",
            flags: true,
          });

        it("replaces the store's image as the rootfs, and the store need hold no image", async () => {
          await Deno.remove(join(store, ROOTFS));
          await Deno.remove(join(store, IMAGE));

          for (
            const [env, explicit, rootfs] of [
              [{ CF_HARNESS_SANDBOX_ROOTFS: "/env/rootfs" }, {}, "/env/rootfs"],
              [
                { CF_HARNESS_SANDBOX_ROOTFS: "/env/rootfs" },
                { sandboxRootfs: "/flag/rootfs" },
                "/flag/rootfs",
              ],
            ] as const
          ) {
            expect(await select(env, explicit)).toEqual({
              ...fromStore(store, join(store, POLICY)),
              sandboxRootfs: rootfs,
            });
          }
        });

        it("replaces the store's shim as the binary, and the store need hold neither shim nor daemon", async () => {
          await Deno.remove(join(store, SHIM));
          await Deno.remove(join(store, DAEMON));

          expect(await select({ CF_HARNESS_RUNSC_BINARY: "/opt/runsc" }))
            .toEqual({
              ...fromStore(store, join(store, POLICY)),
              sandboxRunscBinary: "/opt/runsc",
            });
        });

        it("leaves the store's `config.json` required, which every macOS `runsc` reads", async () => {
          await Deno.remove(join(store, CONFIG));

          expect(
            await rejection(select({
              CF_HARNESS_SANDBOX_ROOTFS: "/env/rootfs",
              CF_HARNESS_RUNSC_BINARY: "/opt/runsc",
            })),
          ).toMatchObject({
            message: notSetUp(
              store,
              "`config.json`, the VM's configuration, is missing",
              DOCKER_BY_FLAG_OR_VARIABLE,
            ),
          });
        });

        it("maps the network mode as it does for a named `runsc`", async () => {
          expect(
            (await select({ CF_HARNESS_DOCKER_NETWORK_MODE: "bridge" }))
              .sandboxRunscNetworkMode,
          ).toBe("sandbox");
          await expect(
            select({ CF_HARNESS_DOCKER_NETWORK_MODE: "bridgeish" }),
          ).rejects.toThrow(
            "CF_HARNESS_DOCKER_NETWORK_MODE must be one of none, bridge, or host",
          );
        });
      });
    });
  });

  describe("procSysctlReader()", () => {
    it("reads a parameter trimmed, reads one the kernel does not have as absent, and throws for one it cannot read", async () => {
      const sys = join(root, "sys");
      await Deno.mkdir(join(sys, "kernel", "unreadable"), { recursive: true });
      await Deno.writeTextFile(
        join(sys, "kernel", "apparmor_restrict_unprivileged_userns"),
        "1\n",
      );
      const read = procSysctlReader(sys);

      expect(await read("kernel.apparmor_restrict_unprivileged_userns")).toBe(
        "1",
      );
      expect(await read("user.max_user_namespaces")).toBeUndefined();
      // A directory where the parameter's file goes is no parameter that
      // could be read.
      expect(await rejection(read("kernel.unreadable"))).toBeInstanceOf(
        Error,
      );
    });
  });

  describe("describeSandboxRuntimeChoice()", () => {
    it("returns the runtime with the flag or variable that named it", () => {
      expect(
        describeSandboxRuntimeChoice({ runtime: "docker", source: "flag" }),
      ).toBe("docker (named by --sandbox-runtime)");
      expect(
        describeSandboxRuntimeChoice({
          runtime: "runsc",
          source: "environment",
        }),
      ).toBe("runsc (named by CF_HARNESS_SANDBOX_RUNTIME)");
    });

    it("returns a defaulted native runtime with the store it runs from", () => {
      expect(
        describeSandboxRuntimeChoice({
          runtime: "runsc",
          source: "default",
          platform: "darwin",
          nativeStore: "/Users/u/Library/Application Support/cfc-vm",
        }),
      ).toBe(
        "runsc (default on macOS: the native store at " +
          "/Users/u/Library/Application Support/cfc-vm)",
      );
    });

    it("returns a defaulted Linux runtime with the store it runs from", () => {
      expect(
        describeSandboxRuntimeChoice({
          runtime: "runsc",
          source: "default",
          platform: "linux",
          nativeStore: "/root/.local/share/runsc-cfc",
        }),
      ).toBe(
        "runsc (default on Linux: the native store at " +
          "/root/.local/share/runsc-cfc)",
      );
    });

    it("says of a store a writable mount holds which platform defaulted to it", () => {
      expect(
        unnamedRuntimeMountNote({
          runtime: "runsc",
          source: "default",
          platform: "linux",
          nativeStore: "/root/.local/share/runsc-cfc",
        }),
      ).toBe(
        "No sandbox runtime is named, so this is the native `runsc` runtime " +
          "that Linux defaults to, from the store at " +
          "`/root/.local/share/runsc-cfc`: run with a workspace and mounts " +
          "that hold none of it, or select Docker with " +
          "`CF_HARNESS_SANDBOX_RUNTIME=docker`.",
      );
    });

    it("returns a defaulted Docker with the platform that defaulted to it", () => {
      expect(describeSandboxRuntimeChoice(DEFAULTED_DOCKER)).toBe(
        `docker (${dockerDefaultReason("freebsd")})`,
      );
    });
  });

  /** A CLI's output, kept. */
  const ioBuffers = (): {
    io: CfHarnessCliIO;
    stdout: string[];
    stderr: string[];
  } => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      stdout,
      stderr,
    };
  };

  /** The result of a run that did nothing, for a loop that runs nothing. */
  const completed = (): HarnessPromptLoopResult => ({
    model: "gpt-5.4",
    finalAssistantText: "Done.",
    transcript: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Done." },
    ],
    modelTurns: 1,
    runState: {
      runId: "run-default",
      status: "completed",
      createdAt: "2026-10-05T12:00:00.000Z",
      updatedAt: "2026-10-05T12:00:01.000Z",
      cfcEnforcementMode: "enforce-strict",
      currentDir: "/workspace",
      policyEvents: [],
      toolOutputs: [],
    },
  });

  /** The sandbox settings of `options`, which is what a selection decides. */
  const sandboxOf = (
    options: CreateHarnessPromptLoopOptions | undefined,
  ): Partial<SandboxRuntimeSelection> => ({
    ...(options?.sandboxRuntimeKind !== undefined
      ? { sandboxRuntimeKind: options.sandboxRuntimeKind }
      : {}),
    ...(options?.sandboxRootfs !== undefined
      ? { sandboxRootfs: options.sandboxRootfs }
      : {}),
    ...(options?.sandboxCfcPolicy !== undefined
      ? { sandboxCfcPolicy: options.sandboxCfcPolicy }
      : {}),
    ...(options?.sandboxRunscBinary !== undefined
      ? { sandboxRunscBinary: options.sandboxRunscBinary }
      : {}),
    ...(options?.sandboxRunscNetworkHelper !== undefined
      ? { sandboxRunscNetworkHelper: options.sandboxRunscNetworkHelper }
      : {}),
    ...(options?.sandboxRunscUnshare !== undefined
      ? { sandboxRunscUnshare: options.sandboxRunscUnshare }
      : {}),
    ...(options?.sandboxRunscSetpriv !== undefined
      ? { sandboxRunscSetpriv: options.sandboxRunscSetpriv }
      : {}),
    ...(options?.sandboxRunscRootless === true
      ? { sandboxRunscRootless: true as const }
      : {}),
    ...(options?.sandboxRuntimeChoice !== undefined
      ? { sandboxRuntimeChoice: options.sandboxRuntimeChoice }
      : {}),
  });

  describe("the names of the variables the selection reads", () => {
    it("are declared in `src/sandbox/runtime-selection.ts`, each as a literal of its own", async () => {
      // Loom checks its vendored copy of that one file for lines of exactly
      // this shape, and takes a name it does not find there for one the
      // harness does not read. A name declared in another module, and
      // exported from this one, is a name that check does not find.
      const source = await Deno.readTextFile(
        new URL("../src/sandbox/runtime-selection.ts", import.meta.url),
      );
      const declared = Object.fromEntries(
        [...source.matchAll(
          /^export\s+const\s+(\w+_ENV)\s*=\s*["']([A-Z0-9_]+)["']/gm,
        )].map(([, name, value]) => [name, value]),
      );

      expect(declared).toMatchObject({
        SANDBOX_RUNTIME_ENV: "CF_HARNESS_SANDBOX_RUNTIME",
        SANDBOX_ROOTFS_ENV: "CF_HARNESS_SANDBOX_ROOTFS",
        RUNSC_CFC_POLICY_ENV: "CF_HARNESS_RUNSC_CFC_POLICY",
        RUNSC_BINARY_ENV: "CF_HARNESS_RUNSC_BINARY",
        SANDBOX_NETWORK_MODE_ENV: "CF_HARNESS_DOCKER_NETWORK_MODE",
      });
      expect(SANDBOX_RUNTIME_ENV).toBe("CF_HARNESS_SANDBOX_RUNTIME");
    });
  });

  describe("processSandboxSelectionEnv()", () => {
    it("returns the home and every setting of either sandbox driver as the process's environment has them", () => {
      // Each variable the batch CLI takes for its sandbox from the process
      // it runs in. A name missing here is a setting the CLI stops reading.
      const names = [
        "HOME",
        "CFC_VM_HOME",
        "CF_HARNESS_SANDBOX_RUNTIME",
        "CF_HARNESS_SANDBOX_ROOTFS",
        "CF_HARNESS_RUNSC_CFC_POLICY",
        "CF_HARNESS_RUNSC_BINARY",
        "CF_HARNESS_DOCKER_NETWORK_MODE",
        "CF_HARNESS_SANDBOX_IMAGE",
        "CF_HARNESS_SANDBOX_DOCKER_RUNTIME",
        "CF_HARNESS_RUNSC_CFC_RESULT_DIR",
        "CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR",
      ];
      const before = names.map((name) => [name, Deno.env.get(name)] as const);
      const put = (name: string, value: string | undefined) =>
        value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
      let read: Record<string, string | undefined>;
      // Nothing is awaited between the two loops, so nothing else in the
      // process sees these values.
      for (const name of names) put(name, `the process's ${name}`);
      try {
        read = processSandboxSelectionEnv();
      } finally {
        for (const [name, value] of before) put(name, value);
      }

      expect(read).toEqual(
        Object.fromEntries(
          names.map((name) => [name, `the process's ${name}`]),
        ),
      );
    });
  });

  describe("the batch CLI", () => {
    /** Runs a prompt through the CLI, and keeps what its loop was built with. */
    const run = async (
      platform: SandboxPlatform,
      env: Record<string, string>,
      extraArgs: readonly string[] = [],
      embedded: { sandboxSelectionFlags?: boolean } = {},
    ) => {
      const { io, stdout, stderr } = ioBuffers();
      const built: CreateHarnessPromptLoopOptions[] = [];
      // Beside the home rather than around it: the direct driver refuses a
      // store its own writable mount would hold.
      const workspace = join(root, "workspace");
      await Deno.mkdir(workspace);
      const exitCode = await runCfHarnessCli(
        [
          "--model-provider",
          "openai-compatible-gateway",
          "--gateway-auth-mode",
          "none",
          "--workspace",
          workspace,
          "--prompt",
          "hello",
          ...extraArgs,
        ],
        {
          io,
          env,
          platform,
          arch: "aarch64",
          uid: () => 0,
          which: withPasta,
          ...embedded,
          cwd: root,
          registerSignalHandler: () => () => {},
          createPromptLoop: (options) => {
            built.push(options);
            return {
              runPrompt: () => Promise.resolve(completed()),
              runTranscript: () => Promise.reject(new Error("no resume")),
            };
          },
        },
      );
      return { exitCode, built, stdout, stderr };
    };

    it("runs on the native runtime, from the store, with no runtime named on macOS", async () => {
      const store = defaultStore(home);
      await installStore(store);

      const { exitCode, built, stdout, stderr } = await run("darwin", {
        HOME: home,
      });

      expect([exitCode, stderr]).toEqual([0, []]);
      expect(built.map(sandboxOf)).toEqual([
        fromStore(store, join(store, POLICY)),
      ]);
      expect(stdout.join("")).toContain(
        `\nsandbox: runsc (default on macOS: the native store at ${store})\n`,
      );
    });

    it("refuses to run, and builds no loop, with no runtime named on macOS and no store", async () => {
      const { exitCode, built, stdout, stderr } = await run("darwin", {
        HOME: home,
      });

      expect([exitCode, built, stdout]).toEqual([1, [], []]);
      expect(stderr).toHaveLength(1);
      const [said] = stderr;
      expect(said).toContain(
        "the default applies, which on macOS is the native `runsc` runtime, " +
          `and it is not set up at \`${defaultStore(home)}\`: `,
      );
      expect(said).toContain("`bin/runsc`, the `runsc` shim, is missing");
      expect(said.endsWith(`or ${DOCKER_BY_FLAG_OR_VARIABLE}\n`)).toBe(true);
    });

    it("refuses naming the variable alone for an embedder whose operator can pass no flag", async () => {
      const { exitCode, built, stderr } = await run(
        "darwin",
        { HOME: home },
        [],
        { sandboxSelectionFlags: false },
      );

      expect([exitCode, built]).toEqual([1, []]);
      const [said] = stderr;
      expect(said).toContain(noPolicyProblem(defaultStore(home), home, false));
      expect(said.endsWith(`or ${DOCKER_BY_VARIABLE}\n`)).toBe(true);
      expect(said).not.toContain("--sandbox");
    });

    for (
      const [flag, value] of [
        ["--sandbox-image", "registry.example/private:tag"],
        ["--sandbox-docker-runtime", "runc"],
        ["--cfc-result-dir", "private/results"],
        ["--cfc-invocation-context-dir", "private/contexts"],
      ]
    ) {
      it(`refuses \`${flag}\` with no runtime named on macOS, and runs with it where \`docker\` is named`, async () => {
        await installStore(defaultStore(home));

        const refused = await run("darwin", { HOME: home }, [flag, value]);

        expect([refused.exitCode, refused.built]).toEqual([1, []]);
        expect(refused.stderr).toEqual([
          "No sandbox runtime is named, so the default applies, which on " +
          `macOS is the native \`runsc\` runtime, and \`${flag}\` is a ` +
          "setting of the Docker driver, which the native runtime does not " +
          `read. Remove it, or ${DOCKER_BY_FLAG_OR_VARIABLE}\n`,
        ]);
        // On a second workspace: `run` makes one for each call.
        await Deno.remove(join(root, "workspace"));
        const named = await run("darwin", { HOME: home }, [
          flag,
          value,
          "--sandbox-runtime",
          "docker",
        ]);
        expect(named.exitCode).toBe(0);
      });
    }

    it("refuses every flag of the Docker driver given with no runtime named on macOS, naming each", async () => {
      await installStore(defaultStore(home));

      const { exitCode, built, stderr } = await run("darwin", { HOME: home }, [
        "--cfc-invocation-context-dir",
        "private/contexts",
        "--sandbox-image=registry.example/private:tag",
        "--cfc-result-dir",
        "private/results",
        "--sandbox-docker-runtime",
        "runc",
      ]);

      expect([exitCode, built]).toEqual([1, []]);
      expect(stderr).toEqual([
        "No sandbox runtime is named, so the default applies, which on " +
        "macOS is the native `runsc` runtime, and `--sandbox-image`, " +
        "`--sandbox-docker-runtime`, `--cfc-result-dir` and " +
        "`--cfc-invocation-context-dir` are settings of the Docker driver, " +
        "which the native runtime does not read. Remove them, or " +
        `${DOCKER_BY_FLAG_OR_VARIABLE}\n`,
      ]);
    });

    it("refuses the variable of a Docker setting with no runtime named on macOS", async () => {
      await installStore(defaultStore(home));

      const { exitCode, built, stderr } = await run("darwin", {
        HOME: home,
        CF_HARNESS_SANDBOX_DOCKER_RUNTIME: "runc",
      });

      expect([exitCode, built]).toEqual([1, []]);
      expect(stderr.join("")).toContain(
        "`CF_HARNESS_SANDBOX_DOCKER_RUNTIME` is a setting of the Docker driver",
      );
    });

    it("runs on a named `runsc` with the Docker driver's settings given, as a caller that passes both does", async () => {
      const store = defaultStore(home);
      await installStore(store);

      const { exitCode, built, stderr } = await run("darwin", {
        HOME: home,
        CF_HARNESS_SANDBOX_RUNTIME: "runsc",
        CF_HARNESS_SANDBOX_ROOTFS: join(store, ROOTFS),
        CF_HARNESS_RUNSC_BINARY: join(store, SHIM),
        CF_HARNESS_RUNSC_CFC_POLICY: join(store, POLICY),
        CF_HARNESS_SANDBOX_DOCKER_RUNTIME: "runc",
        CF_HARNESS_RUNSC_CFC_RESULT_DIR: "/sidecars/results",
        CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR: "/sidecars/contexts",
      }, ["--sandbox-image", "registry.example/kitchensink:1"]);

      expect([exitCode, stderr]).toEqual([0, []]);
      expect(built.map((options) => options.sandboxRuntimeChoice)).toEqual([
        { runtime: "runsc", source: "environment" },
      ]);
    });

    it("runs on Docker with no runtime named on FreeBSD, whatever store is there", async () => {
      await installStore(defaultStore(home));
      await installLinuxStore(home);

      const { exitCode, built, stdout } = await run("freebsd", { HOME: home });

      expect(exitCode).toBe(0);
      expect(built.map(sandboxOf)).toEqual([
        { sandboxRuntimeChoice: DEFAULTED_DOCKER },
      ]);
      expect(stdout.join("")).toContain(
        `\nsandbox: docker (${dockerDefaultReason("freebsd")})\n`,
      );
    });

    it("runs on the native runtime, from the Linux store, with no runtime named on Linux", async () => {
      const store = await installLinuxStore(home);

      const { exitCode, built, stdout } = await run("linux", { HOME: home });

      expect(exitCode).toBe(0);
      expect(built.map(sandboxOf)).toEqual([fromLinuxStore(store)]);
      expect(stdout.join("")).toContain(
        `\nsandbox: runsc (default on Linux: the native store at ${store})\n`,
      );
    });

    it("runs on Docker where the flag names it, on macOS with a store set up", async () => {
      await installStore(defaultStore(home));

      const { exitCode, built, stdout } = await run("darwin", { HOME: home }, [
        "--sandbox-runtime",
        "docker",
      ]);

      expect(exitCode).toBe(0);
      expect(built.map(sandboxOf)).toEqual([{
        sandboxRuntimeKind: "docker",
        sandboxRuntimeChoice: { runtime: "docker", source: "flag" },
      }]);
      expect(stdout.join("")).toContain(
        "\nsandbox: docker (named by --sandbox-runtime)\n",
      );
    });

    it("runs on Docker where the environment names it, on macOS with a store set up", async () => {
      await installStore(defaultStore(home));

      const { built } = await run("darwin", {
        HOME: home,
        CF_HARNESS_SANDBOX_RUNTIME: "docker",
      });

      expect(built.map(sandboxOf)).toEqual([{
        sandboxRuntimeKind: "docker",
        sandboxRuntimeChoice: { runtime: "docker", source: "environment" },
      }]);
    });

    it("reads `CFC_VM_HOME` from the process's environment where it is given none", async () => {
      const store = join(root, "vm");
      await installStore(store);
      // The process's environment as this case needs it: the store named,
      // and nothing naming a runtime or a setting of one.
      const wanted: Record<string, string | undefined> = {
        CFC_VM_HOME: store,
        CF_HARNESS_SANDBOX_RUNTIME: undefined,
        CF_HARNESS_SANDBOX_ROOTFS: undefined,
        CF_HARNESS_RUNSC_BINARY: undefined,
      };
      const before = Object.keys(wanted).map((name) =>
        [name, Deno.env.get(name)] as const
      );
      const put = (name: string, value: string | undefined) =>
        value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
      for (const [name, value] of Object.entries(wanted)) put(name, value);
      try {
        const parsed = await parseCfHarnessCliArgs(["hello"], {
          platform: "darwin",
          arch: "aarch64",
          cwd: root,
        });

        expect(sandboxOf("help" in parsed ? undefined : parsed))
          .toMatchObject({
            sandboxRootfs: join(store, ROOTFS),
            sandboxRunscBinary: join(store, SHIM),
            sandboxRuntimeChoice: { nativeStore: store },
          });
      } finally {
        for (const [name, value] of before) put(name, value);
      }
    });

    it("refuses before a run, with no runtime named on Linux for a process that is not root, on the kernel parameters its caller reads", async () => {
      await installLinuxStore(home);

      const refusal = await rejection(
        selectCfHarnessCliSandboxRuntime({
          cwd: root,
          env: { HOME: home },
          platform: "linux",
          uid: () => 1000,
          readSysctl: (name) =>
            Promise.resolve(
              name === "user.max_user_namespaces" ? "0" : undefined,
            ),
          which: withPasta,
        }),
      );

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(messageOf(refusal)).toContain(
        "`user.max_user_namespaces` is 0, which allows no user namespace at all",
      );
    });

    it("parses, with no runtime named on Linux, to the `pasta` and `unshare` the lookup its caller hands it finds", async () => {
      await installLinuxStore(home);

      // Paths no host has, so that only the lookup handed over finds them.
      const parsed = await parseCfHarnessCliArgs(["hello"], {
        cwd: root,
        env: { HOME: home },
        platform: "linux",
        uid: () => 0,
        which: (name) => `/handed/${name}`,
      });

      expect(parsed).toMatchObject({
        sandboxRunscNetworkHelper: "/handed/pasta",
        sandboxRunscUnshare: "/handed/unshare",
        sandboxRunscSetpriv: "/handed/setpriv",
      });
    });

    it("leaves the sandbox line out of a summary given no selection", () => {
      expect(formatCfHarnessCliResult(completed())).not.toContain("sandbox:");
      expect(
        formatCfHarnessCliResult(completed(), "batch", DEFAULTED_DOCKER),
      ).toBe("Done.\n");
    });
  });

  describe("the interactive stdio entrypoint", () => {
    /** Starts the entrypoint, and keeps what it would run its host with. */
    const start = async (
      platform: SandboxPlatform,
      env: Record<string, string>,
    ) => {
      const started: RunHarnessInteractiveChatStdioOptions[] = [];
      await runHarnessInteractiveChatStdioCli([], root, (options) => {
        started.push(options);
        return Promise.resolve();
      }, { env, platform, arch: "aarch64", uid: () => 0, which: withPasta });
      return started.map((options) => sandboxOf(options.basePromptLoopOptions));
    };

    it("hands its host the native runtime, from the store, with no runtime named on macOS", async () => {
      const store = defaultStore(home);
      await installStore(store);

      expect(await start("darwin", { HOME: home })).toEqual([
        fromStore(store, join(store, POLICY)),
      ]);
    });

    it("refuses to start, naming the variable alone, with no runtime named on macOS and no store", async () => {
      const refusal = await rejection(start("darwin", { HOME: home }));

      expect(refusal).toBeInstanceOf(HarnessControlError);
      const message = messageOf(refusal);
      expect(message).toContain(
        `it is not set up at \`${defaultStore(home)}\`: `,
      );
      expect(message).toContain("`config.json`, the VM's configuration,");
      expect(message.endsWith(`or ${DOCKER_BY_VARIABLE}`)).toBe(true);
      expect(message).not.toContain("--sandbox");
    });

    it("refuses the variable of a Docker setting with no runtime named on macOS, naming no flag", async () => {
      await installStore(defaultStore(home));

      const refusal = await rejection(
        start("darwin", {
          HOME: home,
          CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR: "/sidecars/contexts",
        }),
      );

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(refusal).toMatchObject({
        message:
          "No sandbox runtime is named, so the default applies, which on " +
          "macOS is the native `runsc` runtime, and " +
          "`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` is a setting of the " +
          "Docker driver, which the native runtime does not read. Remove " +
          `it, or ${DOCKER_BY_VARIABLE}`,
      });
    });

    it("hands its host Docker with no runtime named on FreeBSD, whatever store is there", async () => {
      await installStore(defaultStore(home));
      await installLinuxStore(home);

      expect(await start("freebsd", { HOME: home })).toEqual([
        { sandboxRuntimeChoice: DEFAULTED_DOCKER },
      ]);
    });

    it("hands its host the native runtime, from the Linux store, with no runtime named on Linux", async () => {
      const store = await installLinuxStore(home);

      expect(await start("linux", { HOME: home })).toEqual([
        fromLinuxStore(store),
      ]);
    });

    it("hands its host Docker where the environment names it, on macOS with a store set up", async () => {
      await installStore(defaultStore(home));

      expect(
        await start("darwin", {
          HOME: home,
          CF_HARNESS_SANDBOX_RUNTIME: "docker",
        }),
      ).toEqual([{
        sandboxRuntimeKind: "docker",
        sandboxRuntimeChoice: { runtime: "docker", source: "environment" },
      }]);
    });
  });

  describe("the Loom local host", () => {
    // The host takes no platform default: Loom names the runtime of every run
    // it starts, so a run that names none is one Loom forgot to select for,
    // and is refused on every platform.

    /**
     * A host over `env`, whose batch lane builds a loop that runs nothing and
     * whose interactive lane starts a host that serves nothing.
     */
    const host = async (env: Record<string, string>) => {
      const harnessHome = join(root, "harness-home");
      await Deno.mkdir(harnessHome, { recursive: true });
      const { io, stdout, stderr } = ioBuffers();
      const built: CreateHarnessPromptLoopOptions[] = [];
      const started: RunHarnessInteractiveChatStdioOptions[] = [];
      const loomHost = await createLoomLocalCfHarnessHost({
        harnessHome,
        env: {
          CF_HARNESS_GATEWAY_BASE_URL: "https://gateway.example/",
          CF_HARNESS_GATEWAY_AUTH_MODE: "none",
          ...env,
        },
        credentialStore: new InMemoryHarnessCredentialStore(),
        providerSettingsStore: {
          inspect: () =>
            Promise.resolve({
              state: "configured",
              settings: {
                version: 1,
                modelProvider: "openai-compatible-gateway",
              },
            }),
        },
        fetchFn: () => Promise.reject(new Error("must not request")),
        interactiveStdioRunner: (options) => {
          started.push(options);
          return Promise.resolve();
        },
        cliDependencies: {
          cwd: root,
          io,
          registerSignalHandler: () => () => {},
          createPromptLoop: (options) => {
            built.push(options);
            return {
              runPrompt: () =>
                Promise.resolve({
                  ...completed(),
                  runState: options.engine!.getRunState(),
                }),
              runTranscript: () => Promise.reject(new Error("no resume")),
            };
          },
        },
      });
      return { loomHost, built, started, stdout, stderr };
    };

    /**
     * A batch whose workspace is beside the home rather than around it: the
     * direct driver refuses a store its own writable mount would hold.
     */
    const batch = async (...more: string[]): Promise<string[]> => {
      const workspace = join(root, "workspace");
      await Deno.mkdir(workspace, { recursive: true });
      return ["--workspace", workspace, "--prompt", "hello", ...more];
    };

    /** What the host says of a run whose caller named no runtime. */
    const loomMustName = (flags: boolean): string =>
      "No sandbox runtime is named, and this entrypoint takes no default: " +
      "Loom must name `docker` or `runsc`, with " +
      (flags ? "`--sandbox-runtime` or " : "") +
      "`CF_HARNESS_SANDBOX_RUNTIME`.";

    /** The environment naming `runsc` with every setting from `store`. */
    const namesRunsc = (store: string): Record<string, string> => ({
      CF_HARNESS_SANDBOX_RUNTIME: "runsc",
      CF_HARNESS_SANDBOX_ROOTFS: join(store, ROOTFS),
      CF_HARNESS_RUNSC_BINARY: join(store, SHIM),
      CF_HARNESS_RUNSC_CFC_POLICY: join(store, POLICY),
    });

    /** The selection `namesRunsc(store)` asks for. */
    const namedRunsc = (store: string): SandboxRuntimeSelection => ({
      sandboxRuntimeKind: "runsc",
      sandboxRootfs: join(store, ROOTFS),
      sandboxCfcPolicy: join(store, POLICY),
      sandboxRunscBinary: join(store, SHIM),
      sandboxRuntimeChoice: { runtime: "runsc", source: "environment" },
    });

    for (const store of [true, false]) {
      const where = store ? "with a store set up" : "with no store";

      it(`refuses a batch whose caller named no runtime, ${where}`, async () => {
        if (store) await installStore(defaultStore(home));
        const { loomHost, built, stderr } = await host({ HOME: home });

        expect([await loomHost.runBatch(await batch()), built]).toEqual([
          1,
          [],
        ]);
        expect(stderr.map((line) => JSON.parse(line))).toEqual([{
          type: "cf-harness.host-failure",
          version: 1,
          ok: false,
          // The batch lane hands its arguments to the batch CLI, which takes
          // the flag.
          error: { code: "invalid-request", message: loomMustName(true) },
        }]);
      });

      it(`refuses to start its interactive lane where its caller named no runtime, ${where}`, async () => {
        if (store) await installStore(defaultStore(home));
        const { loomHost, started } = await host({ HOME: home });

        const refusal = await rejection(loomHost.runInteractive([]));

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(refusal).toMatchObject({
          code: "invalid-request",
          message: loomMustName(false),
        });
        expect(started).toEqual([]);
      });
    }

    it("runs a batch on Docker where its environment names it, with a store set up", async () => {
      await installStore(defaultStore(home));
      const { loomHost, built, stderr } = await host({
        HOME: home,
        CF_HARNESS_SANDBOX_RUNTIME: "docker",
      });

      expect([await loomHost.runBatch(await batch()), stderr]).toEqual([0, []]);
      expect(built.map(sandboxOf)).toEqual([{
        sandboxRuntimeKind: "docker",
        sandboxRuntimeChoice: { runtime: "docker", source: "environment" },
      }]);
      expect(built[0].engine!.sandbox.describe().kind).toBe(
        "docker-runsc-cfc",
      );
    });

    it("runs a batch on Docker where the flag names it, over an environment that names `runsc`", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const { loomHost, built } = await host({
        HOME: home,
        ...namesRunsc(store),
      });

      expect(
        await loomHost.runBatch(await batch("--sandbox-runtime", "docker")),
      ).toBe(0);
      expect(built.map(sandboxOf)).toEqual([{
        sandboxRuntimeKind: "docker",
        sandboxRuntimeChoice: { runtime: "docker", source: "flag" },
      }]);
    });

    it("starts its interactive lane on Docker where its environment names it, with a store set up", async () => {
      await installStore(defaultStore(home));
      const { loomHost, started } = await host({
        HOME: home,
        CF_HARNESS_SANDBOX_RUNTIME: "docker",
      });

      await loomHost.runInteractive([]);

      expect(
        started.map((options) => sandboxOf(options.basePromptLoopOptions)),
      ).toEqual([{
        sandboxRuntimeKind: "docker",
        sandboxRuntimeChoice: { runtime: "docker", source: "environment" },
      }]);
    });

    it("runs a batch on `runsc` where its environment names it, with the settings named beside it", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const { loomHost, built, stderr } = await host({
        HOME: home,
        ...namesRunsc(store),
      });

      expect([await loomHost.runBatch(await batch()), stderr]).toEqual([0, []]);
      expect(built.map(sandboxOf)).toEqual([namedRunsc(store)]);
      expect(built[0].engine!.sandbox.describe().kind).toBe("runsc-cfc");
    });

    it("starts its interactive lane on `runsc` where its environment names it", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const { loomHost, started } = await host({
        HOME: home,
        ...namesRunsc(store),
      });

      await loomHost.runInteractive([]);

      expect(
        started.map((options) => sandboxOf(options.basePromptLoopOptions)),
      ).toEqual([namedRunsc(store)]);
    });

    it("takes the default policy of a named `runsc` from under the home it keeps aside", async () => {
      const store = defaultStore(home);
      await installStore(store);
      await Deno.mkdir(join(homePolicy(home), ".."), { recursive: true });
      await Deno.writeTextFile(homePolicy(home), "{}\n");
      const { CF_HARNESS_RUNSC_CFC_POLICY: _, ...env } = namesRunsc(store);
      const { loomHost, built, started } = await host({ HOME: home, ...env });

      expect(await loomHost.runBatch(await batch())).toBe(0);
      await loomHost.runInteractive([]);

      expect([
        built[0].sandboxCfcPolicy,
        started[0].basePromptLoopOptions?.sandboxCfcPolicy,
      ]).toEqual([homePolicy(home), homePolicy(home)]);
    });
  });

  describe("the console", () => {
    const ARGS = [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
    ];

    /** The configuration row that names the sandbox runtime. */
    const sandboxRow = (
      config: Awaited<ReturnType<typeof resolveConsoleConfig>>,
    ) =>
      consoleHealthRows(config).filter((row) => row.id === "config.sandbox")
        .map(({ value, detail }) => ({ value, detail }));

    it("serves on the native runtime, from the store, with no runtime named on macOS", async () => {
      const store = defaultStore(home);
      await installStore(store);

      const config = await resolveConsoleConfig(ARGS, { HOME: home }, root, {
        platform: "darwin",
        arch: "aarch64",
      });

      expect(sandboxOf(config)).toEqual(fromStore(store, join(store, POLICY)));
      // The direct driver reads no sidecar directory, so none is sited.
      expect([config.cfcResultDir, config.cfcInvocationContextDir]).toEqual([
        undefined,
        undefined,
      ]);
      expect(sandboxRow(config)).toEqual([{
        value: "runsc",
        detail: `console default on macOS: the native store at ${store}`,
      }]);
      expect(consoleSandboxBanner(config)).toEqual([
        "  sandbox:    runsc, the direct driver (no Docker); default on " +
        `macOS: the native store at ${store}`,
        `  runsc:      ${join(store, SHIM)}`,
        `  rootfs:     ${join(store, ROOTFS)}`,
        `  policy:     ${join(store, POLICY)}`,
      ]);
    });

    it("serves on Docker with no runtime named on FreeBSD, whatever store is there", async () => {
      await installStore(defaultStore(home));
      await installLinuxStore(home);

      const config = await resolveConsoleConfig(ARGS, { HOME: home }, root, {
        platform: "freebsd",
      });

      expect(sandboxOf(config)).toEqual({
        sandboxRuntimeChoice: DEFAULTED_DOCKER,
      });
      expect(sandboxRow(config)).toEqual([{
        value: "docker",
        detail: `console ${dockerDefaultReason("freebsd")}`,
      }]);
      expect(consoleSandboxBanner(config)[0]).toBe(
        `  sandbox:    docker; ${dockerDefaultReason("freebsd")}`,
      );
    });

    it("serves on the native runtime, from the Linux store, with no runtime named on Linux", async () => {
      const store = await installLinuxStore(home);

      const config = await resolveConsoleConfig(ARGS, { HOME: home }, root, {
        platform: "linux",
        uid: () => 0,
        which: withPasta,
      });

      expect(sandboxOf(config)).toEqual(fromLinuxStore(store));
      expect(sandboxRow(config)).toEqual([{
        value: "runsc",
        detail: `console default on Linux: the native store at ${store}`,
      }]);
      expect(consoleSandboxBanner(config)).toEqual([
        "  sandbox:    runsc, the direct driver (no Docker); default on " +
        `Linux: the native store at ${store}`,
        `  runsc:      ${join(store, LINUX_RUNSC)}`,
        `  rootfs:     ${join(store, LINUX_ROOTFS)}`,
        `  policy:     ${join(store, LINUX_POLICY)}`,
      ]);
    });

    it("refuses the variable of a Docker sidecar directory with no runtime named on macOS, and serves on Docker with it where Docker is named", async () => {
      await installStore(defaultStore(home));
      const env = {
        HOME: home,
        CF_HARNESS_RUNSC_CFC_RESULT_DIR: "/sidecars/results",
      };

      const refusal = await rejection(
        resolveConsoleConfig(ARGS, env, root, {
          platform: "darwin",
          arch: "aarch64",
        }),
      );

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(refusal).toMatchObject({
        message:
          "No sandbox runtime is named, so the default applies, which on " +
          "macOS is the native `runsc` runtime, and " +
          "`CF_HARNESS_RUNSC_CFC_RESULT_DIR` is a setting of the Docker " +
          "driver, which the native runtime does not read. Remove it, or " +
          DOCKER_BY_VARIABLE,
      });
      const named = await resolveConsoleConfig(
        ARGS,
        { ...env, CF_HARNESS_SANDBOX_RUNTIME: "docker" },
        root,
        { platform: "darwin", arch: "aarch64" },
      );
      expect(named.cfcResultDir).toBe("/sidecars/results");
    });

    it("names the variable as the source of a runtime the environment named", async () => {
      await installStore(defaultStore(home));

      for (const runtime of ["docker", "runsc"]) {
        const config = await resolveConsoleConfig(
          ARGS,
          {
            HOME: home,
            CF_HARNESS_SANDBOX_RUNTIME: runtime,
          },
          root,
          { platform: "darwin", arch: "aarch64" },
        );

        expect(sandboxRow(config)).toEqual([{
          value: runtime,
          detail: "CF_HARNESS_SANDBOX_RUNTIME",
        }]);
        expect(consoleSandboxBanner(config)[0]).toContain(
          "; named by CF_HARNESS_SANDBOX_RUNTIME",
        );
      }
    });

    it("names the driver alone in the banner of a configuration that carries no selection", async () => {
      const { sandboxRuntimeChoice: _, ...config } = await resolveConsoleConfig(
        ARGS,
        {},
        root,
        { platform: "freebsd" },
      );

      expect(consoleSandboxBanner(config)[0]).toBe("  sandbox:    docker");
    });

    it("says in its runtime row that the native runtime was the default, and reads its VM's store", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const env = { HOME: home };
      const health = createConsoleHealth(
        await resolveConsoleConfig(ARGS, env, root, {
          platform: "darwin",
          arch: "aarch64",
        }),
        undefined,
        undefined,
        env,
        undefined,
        () => Promise.reject(new Error("Docker is not asked")),
        { platform: "darwin" },
      );

      await health.refresh();
      const rows = health.snapshot().rows.filter((row) =>
        row.id.startsWith("sandbox.")
      );

      expect(rows.map(({ id, state, value }) => ({ id, state, value })))
        .toEqual([
          { id: "sandbox.runsc", state: "ok", value: "executable" },
          {
            id: "sandbox.runtime",
            state: "ok",
            value: "direct runsc driver, CFC policy configured",
          },
          { id: "sandbox.rootfs", state: "ok", value: "present" },
          // No daemon runs for a store a case made, and reading the row
          // starts none.
          { id: "sandbox.vm", state: "ok", value: "idle; starts on first use" },
        ]);
      expect(rows[1].detail).toBe(
        `runsc ${join(store, SHIM)}; rootfs ${join(store, ROOTFS)}; ` +
          `CFC policy ${join(store, POLICY)}; selected: runsc (default on ` +
          `macOS: the native store at ${store})`,
      );
    });

    it("reads no VM for a named `runsc` off macOS, whatever store its environment names", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const env = {
        HOME: home,
        CF_HARNESS_SANDBOX_RUNTIME: "runsc",
        CF_HARNESS_SANDBOX_ROOTFS: join(store, ROOTFS),
        CF_HARNESS_RUNSC_BINARY: join(store, SHIM),
        CF_HARNESS_RUNSC_CFC_POLICY: join(store, POLICY),
      };
      const health = createConsoleHealth(
        await resolveConsoleConfig(ARGS, env, root, { platform: "linux" }),
        undefined,
        undefined,
        env,
        undefined,
        () => Promise.reject(new Error("Docker is not asked")),
        { platform: "linux" },
      );

      await health.refresh();

      expect(
        health.snapshot().rows.filter((row) => row.id.startsWith("sandbox."))
          .map(({ id }) => id),
      ).toEqual(["sandbox.runsc", "sandbox.runtime", "sandbox.rootfs"]);
    });

    it("says in its runtime row that Docker was the default", async () => {
      const health = createConsoleHealth(
        await resolveConsoleConfig(ARGS, { HOME: home }, root, {
          platform: "freebsd",
        }),
        undefined,
        undefined,
        {},
        undefined,
        () => Promise.resolve({ runtimes: { "runsc-cfc": {} } }),
      );

      await health.refresh();
      const runtime = health.snapshot().rows.find((row) =>
        row.id === "sandbox.runtime"
      );

      expect(runtime).toMatchObject({
        state: "ok",
        value: "runsc-cfc registered",
        detail: "docker info --format '{{json .Runtimes}}'; selected: " +
          `docker (${dockerDefaultReason("freebsd")})`,
      });
    });

    describe("told that its launcher's caller names the runtime", () => {
      const LOOM_MUST_NAME =
        "No sandbox runtime is named, and this entrypoint takes no default: " +
        "Loom must name `docker` or `runsc`, with " +
        "`CF_HARNESS_SANDBOX_RUNTIME`.";

      for (
        const [platform, where] of [
          ["darwin", "on macOS with a store set up"],
          ["linux", "on Linux"],
        ] as const
      ) {
        it(`refuses a configuration with no runtime named, ${where}`, async () => {
          await installStore(defaultStore(home));

          const refusal = await rejection(
            resolveConsoleConfig(ARGS, { HOME: home }, root, {
              platform,
              sandboxRuntimeNamedBy: "Loom",
            }),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "invalid-request",
            message: LOOM_MUST_NAME,
          });
        });

        it(`refuses to serve with no runtime named, ${where}, before it makes anything`, async () => {
          await installStore(defaultStore(home));

          const refusal = await rejection(
            startConsoleServer(ARGS, { HOME: home }, root, undefined, {
              platform,
              sandboxRuntimeNamedBy: "Loom",
            }),
          );

          expect(messageOf(refusal)).toBe(LOOM_MUST_NAME);
          expect([...Deno.readDirSync(root)].map((entry) => entry.name))
            .toEqual(["home"]);
        });
      }

      it("resolves the runtime the environment names, as a console told nothing does", async () => {
        await installStore(defaultStore(home));

        for (const runtime of ["docker", "runsc"] as const) {
          const env = { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: runtime };

          expect(
            sandboxOf(
              await resolveConsoleConfig(ARGS, env, root, {
                platform: "darwin",
                arch: "aarch64",
                sandboxRuntimeNamedBy: "Loom",
              }),
            ),
          ).toEqual(
            sandboxOf(
              await resolveConsoleConfig(ARGS, env, root, {
                platform: "darwin",
                arch: "aarch64",
              }),
            ),
          );
        }
      });
    });

    describe("startConsoleServer()", () => {
      it("refuses to serve, naming the variable alone, with no runtime named on macOS and no store", async () => {
        const refusal = await rejection(
          startConsoleServer(ARGS, { HOME: home }, root, undefined, {
            platform: "darwin",
            arch: "aarch64",
          }),
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        const message = messageOf(refusal);
        expect(message).toContain(
          `it is not set up at \`${defaultStore(home)}\`: `,
        );
        expect(message).toContain("`bin/runsc`, the `runsc` shim, is missing");
        expect(message.endsWith(`or ${DOCKER_BY_VARIABLE}`)).toBe(true);
        // Refused before anything of the console's was made.
        expect([...Deno.readDirSync(root)].map((entry) => entry.name))
          .toEqual(["home"]);
      });

      for (
        const [platform, where, store] of [
          ["darwin", "on macOS with a store set up", true],
          ["freebsd", "on FreeBSD with no store", false],
        ] as const
      ) {
        it(`gets past the selection to what it needs next, with no runtime named ${where}`, async () => {
          if (store) await installStore(defaultStore(home));

          // No fabric session is named, which is the first thing a console
          // asks for once its sandbox is selected.
          await expect(
            startConsoleServer(
              ["--session-db", "none"],
              { HOME: home },
              root,
              undefined,
              { platform, arch: "aarch64" },
            ),
          ).rejects.toThrow("a fabric session is required");
        });
      }
    });
  });

  describe("the console launcher", () => {
    const ARGS = [
      "--fabric-identity",
      "/keys/dev.key",
      "--fabric-space",
      "cf-harness-dev",
      "--fabric-api-url",
      "http://localhost:8000",
      "--store",
      "/checkout/cache/memory",
    ];

    /** Launch IO that reads no instance, and counts readings of Docker. */
    const io = (): ConsoleLaunchIo & { dockerReads: number } => {
      const counted = {
        dockerReads: 0,
        readTextFile: () => Promise.resolve(undefined),
        readToolshedStoreDir: () => Promise.resolve(""),
        readDockerRuntimes: () => {
          counted.dockerReads += 1;
          return Promise.resolve({
            runtimes: {
              "runsc-cfc": {
                path: "/opt/runsc",
                runtimeArgs: [
                  "--cfc-result-dir=/sidecars/results",
                  "--cfc-invocation-context-dir=/sidecars/ctx",
                ],
              },
            },
          });
        },
      };
      return counted;
    };

    /**
     * Runs `body`, which launches, and restores whatever the process held
     * for the keys a launch decides. Returns what `body` resolves to.
     */
    const withEnvironmentRestored = async <T>(
      body: () => Promise<T>,
    ): Promise<T> => {
      const before = LAUNCHER_OWNED_VARIABLES.map((name) =>
        [name, Deno.env.get(name)] as const
      );
      try {
        return await body();
      } finally {
        for (const [name, value] of before) {
          if (value === undefined) Deno.env.delete(name);
          else Deno.env.set(name, value);
        }
      }
    };

    /** The rows of a launch's report that describe its sandbox. */
    const sandboxRows = (
      plan: Awaited<ReturnType<typeof prepareConsoleLaunch>>["plan"],
    ) =>
      plan.resolved.filter(({ name }) =>
        ["sandbox", "runsc", "rootfs", "cfc policy"].includes(name)
      );

    it("reports the native runtime as the default, each setting beside the store it came from, on macOS", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const launchIo = io();

      const { plan } = await prepareConsoleLaunch(
        ARGS,
        { HOME: home },
        launchIo,
        { platform: "darwin", arch: "aarch64" },
      );

      const fromStoreSource = `the native store at \`${store}\``;
      expect(sandboxRows(plan)).toEqual([{
        name: "sandbox",
        value: "runsc",
        source: `harness default on macOS: the native store at ${store}`,
      }, {
        name: "runsc",
        value: join(store, SHIM),
        source: fromStoreSource,
      }, {
        name: "rootfs",
        value: join(store, ROOTFS),
        source: fromStoreSource,
      }, {
        name: "cfc policy",
        value: join(store, POLICY),
        source: fromStoreSource,
      }]);
      // Docker is not involved, so its runtime table is not read and no
      // sidecar directory is exported.
      expect(launchIo.dockerReads).toBe(0);
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBeUndefined();
    });

    it("reports the native runtime as the default, each setting beside the store it came from, on Linux", async () => {
      const store = await installLinuxStore(home);
      const launchIo = io();

      const { plan } = await prepareConsoleLaunch(
        ARGS,
        { HOME: home },
        launchIo,
        { platform: "linux", uid: () => 0, which: withPasta },
      );

      const fromStoreSource = `the native store at \`${store}\``;
      expect(sandboxRows(plan)).toEqual([{
        name: "sandbox",
        value: "runsc",
        source: `harness default on Linux: the native store at ${store}`,
      }, {
        name: "runsc",
        value: join(store, LINUX_RUNSC),
        source: fromStoreSource,
      }, {
        name: "rootfs",
        value: join(store, LINUX_ROOTFS),
        source: fromStoreSource,
      }, {
        name: "cfc policy",
        value: join(store, LINUX_POLICY),
        source: fromStoreSource,
      }]);
      expect(launchIo.dockerReads).toBe(0);
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBeUndefined();
    });

    it("refuses to launch, reading nothing of Docker's, with no runtime named on Linux for a process that is not root on a host that allows it no user namespace", async () => {
      await installLinuxStore(home);
      const launchIo = io();

      const refusal = await rejection(
        prepareConsoleLaunch(ARGS, { HOME: home }, launchIo, {
          platform: "linux",
          uid: () => 1000,
          readSysctl: (name) =>
            Promise.resolve(
              name === "kernel.apparmor_restrict_unprivileged_userns"
                ? "1"
                : undefined,
            ),
        }),
      );

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(messageOf(refusal)).toContain(
        "`kernel.apparmor_restrict_unprivileged_userns` is 1, which has " +
          "AppArmor refuse one to a process that is not root",
      );
      expect(launchIo.dockerReads).toBe(0);
    });

    describe("for a Loom instance", () => {
      // Loom chooses a runtime for each instance. A console launched for one
      // that names none is one Loom did not choose for, so it is refused on
      // every platform rather than put on whichever default applies.
      const INSTANCE_ARGS = [
        "--instance",
        "loom",
        "--fabric-api-url",
        "http://localhost:8000",
      ];

      /** What a launch for an instance says of a runtime nobody named. */
      const LOOM_MUST_NAME =
        "No sandbox runtime is named, and this entrypoint takes no default: " +
        "Loom must name `docker` or `runsc`, with " +
        "`CF_HARNESS_SANDBOX_RUNTIME`.";

      /** Launch IO whose instance `loom` records an identity and a space. */
      const instanceIo = (): ConsoleLaunchIo & { dockerReads: number } => {
        const base = io();
        return Object.assign(base, {
          readTextFile: (path: string) =>
            Promise.resolve(
              path.endsWith("pieces.json")
                ? JSON.stringify({
                  defaults: {
                    identity: "/keys/instance.key",
                    local_space: "loom-dev",
                  },
                })
                : undefined,
            ),
          readToolshedStoreDir: () => Promise.resolve("file:///store/memory/"),
        });
      };

      for (
        const [platform, where] of [
          ["darwin", "on macOS with a store set up"],
          ["linux", "on Linux"],
        ] as const
      ) {
        it(`refuses to launch with no runtime named, ${where}, saying Loom must name one`, async () => {
          await installStore(defaultStore(home));
          const launchIo = instanceIo();

          const refusal = await rejection(
            prepareConsoleLaunch(
              INSTANCE_ARGS,
              { HOME: home },
              launchIo,
              { platform },
            ),
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "invalid-request",
            message: LOOM_MUST_NAME,
          });
          expect(launchIo.dockerReads).toBe(0);
        });

        it(`serves nothing with no runtime named, ${where}`, async () => {
          await installStore(defaultStore(home));
          let served = false;

          const refusal = await withEnvironmentRestored(() =>
            rejection(launchConsole(
              INSTANCE_ARGS,
              { HOME: home },
              () => {
                served = true;
                return Promise.resolve();
              },
              instanceIo(),
              { platform },
            ))
          );

          expect(messageOf(refusal)).toBe(LOOM_MUST_NAME);
          expect(served).toBe(false);
        });
      }

      it("launches on Docker where the environment names it, on macOS with a store set up", async () => {
        await installStore(defaultStore(home));
        const launchIo = instanceIo();

        const { plan } = await prepareConsoleLaunch(
          INSTANCE_ARGS,
          { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: "docker" },
          launchIo,
          { platform: "darwin", arch: "aarch64" },
        );

        expect(sandboxRows(plan)).toEqual([{
          name: "sandbox",
          value: "docker",
          source: "`CF_HARNESS_SANDBOX_RUNTIME`, inherited",
        }]);
        expect(launchIo.dockerReads).toBe(1);
      });

      it("launches on `runsc` where the environment names it, with the settings named beside it", async () => {
        const store = defaultStore(home);
        await installStore(store);
        const launchIo = instanceIo();

        const { plan } = await prepareConsoleLaunch(
          INSTANCE_ARGS,
          {
            HOME: home,
            CF_HARNESS_SANDBOX_RUNTIME: "runsc",
            CF_HARNESS_SANDBOX_ROOTFS: join(store, ROOTFS),
            CF_HARNESS_RUNSC_BINARY: join(store, SHIM),
            CF_HARNESS_RUNSC_CFC_POLICY: join(store, POLICY),
          },
          launchIo,
          { platform: "linux" },
        );

        expect(sandboxRows(plan).map(({ name, value }) => [name, value]))
          .toEqual([
            ["sandbox", "runsc"],
            ["runsc", join(store, SHIM)],
            ["rootfs", join(store, ROOTFS)],
            ["cfc policy", join(store, POLICY)],
          ]);
        expect(launchIo.dockerReads).toBe(0);
      });

      it("tells the console it serves that Loom names its runtime, and a console launched for no instance nothing of the kind", async () => {
        await installStore(defaultStore(home));
        const hosts: unknown[] = [];
        const serve = (_args: string[], _health: unknown, host: unknown) => {
          hosts.push(host);
          return Promise.resolve();
        };

        await withEnvironmentRestored(async () => {
          await launchConsole(
            INSTANCE_ARGS,
            { HOME: home, CF_HARNESS_SANDBOX_RUNTIME: "docker" },
            serve,
            instanceIo(),
            { platform: "darwin", arch: "aarch64" },
          );
          await launchConsole(ARGS, { HOME: home }, serve, io(), {
            platform: "darwin",
            arch: "aarch64",
          });
        });

        expect(hosts).toEqual([
          {
            platform: "darwin",
            arch: "aarch64",
            sandboxRuntimeNamedBy: "Loom",
          },
          { platform: "darwin", arch: "aarch64" },
        ]);
      });
    });

    it("attributes a setting the environment named, and the policy under the home, to their own sources", async () => {
      const store = defaultStore(home);
      await installStore(store);
      await Deno.mkdir(join(homePolicy(home), ".."), { recursive: true });
      await Deno.writeTextFile(homePolicy(home), "{}\n");

      const { plan } = await prepareConsoleLaunch(
        ARGS,
        {
          HOME: home,
          CF_HARNESS_SANDBOX_ROOTFS: "/named/rootfs",
          CF_HARNESS_RUNSC_BINARY: "/named/runsc",
        },
        io(),
        { platform: "darwin", arch: "aarch64" },
      );

      expect(sandboxRows(plan).slice(1)).toEqual([{
        name: "runsc",
        value: "/named/runsc",
        source: "`CF_HARNESS_RUNSC_BINARY`, inherited",
      }, {
        name: "rootfs",
        value: "/named/rootfs",
        source: "`CF_HARNESS_SANDBOX_ROOTFS`, inherited",
      }, {
        name: "cfc policy",
        value: homePolicy(home),
        source: "harness default",
      }]);
    });

    it("reports Docker as the default, and reads its runtime table, on FreeBSD", async () => {
      await installStore(defaultStore(home));
      const launchIo = io();

      const { plan } = await prepareConsoleLaunch(
        ARGS,
        { HOME: home },
        launchIo,
        { platform: "freebsd" },
      );

      expect(sandboxRows(plan)).toEqual([{
        name: "sandbox",
        value: "docker",
        source: `harness ${dockerDefaultReason("freebsd")}`,
      }]);
      expect(launchIo.dockerReads).toBe(1);
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/sidecars/results",
      );
    });

    it("refuses the variable of a Docker sidecar directory before it reads anything of Docker's, with no runtime named on macOS", async () => {
      await installStore(defaultStore(home));
      const launchIo = io();

      const refusal = await rejection(
        prepareConsoleLaunch(
          ARGS,
          {
            HOME: home,
            CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR: "/sidecars/ctx",
          },
          launchIo,
          { platform: "darwin", arch: "aarch64" },
        ),
      );

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(messageOf(refusal)).toContain(
        "`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` is a setting of the " +
          "Docker driver, which the native runtime does not read. Remove " +
          `it, or ${DOCKER_BY_VARIABLE}`,
      );
      expect(launchIo.dockerReads).toBe(0);
    });

    it("throws for a sidecar flag on a defaulted native runtime, saying how Docker is selected", async () => {
      await installStore(defaultStore(home));

      await expect(
        prepareConsoleLaunch(
          [...ARGS, "--cfc-result-dir", "/elsewhere"],
          { HOME: home },
          io(),
          { platform: "darwin", arch: "aarch64" },
        ),
      ).rejects.toThrow(
        "`--cfc-result-dir` names a sidecar directory of the Docker driver, " +
          "and this console is on the direct runsc driver, the default on " +
          "macOS, which reads none; drop the flag, or set " +
          "`CF_HARNESS_SANDBOX_RUNTIME=docker` to run on Docker",
      );
    });

    it("throws for a sidecar flag on a named `runsc`, saying the variable to set rather than to unset", async () => {
      await expect(
        prepareConsoleLaunch(
          [...ARGS, "--cfc-invocation-context-dir", "/elsewhere"],
          {
            CF_HARNESS_SANDBOX_RUNTIME: "runsc",
            CF_HARNESS_SANDBOX_ROOTFS: "/store/images/kitchensink",
          },
          io(),
          { platform: "linux" },
        ),
      ).rejects.toThrow(
        "`--cfc-invocation-context-dir` names a sidecar directory of the " +
          "Docker driver, and `CF_HARNESS_SANDBOX_RUNTIME` puts this console " +
          "on the direct runsc driver, which reads none; drop the flag, or " +
          "set `CF_HARNESS_SANDBOX_RUNTIME=docker` to run on Docker",
      );
    });

    describe("launchConsole()", () => {
      it("refuses to launch, and serves nothing, with no runtime named on macOS and no store", async () => {
        let served = false;

        const refusal = await rejection(launchConsole(
          ARGS,
          { HOME: home },
          () => {
            served = true;
            return Promise.resolve();
          },
          io(),
          { platform: "darwin", arch: "aarch64" },
        ));

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(served).toBe(false);
        const message = messageOf(refusal);
        expect(message).toContain(
          `it is not set up at \`${defaultStore(home)}\`: `,
        );
        expect(message.endsWith(`or ${DOCKER_BY_VARIABLE}`)).toBe(true);
      });

      for (
        const [platform, where, reads] of [
          ["darwin", "on macOS with a store set up", 0],
          ["freebsd", "on FreeBSD", 1],
        ] as const
      ) {
        it(`serves, with no runtime named ${where}`, async () => {
          await installStore(defaultStore(home));
          const launchIo = io();
          const served: string[][] = [];

          await withEnvironmentRestored(() =>
            launchConsole(
              ARGS,
              { HOME: home },
              (consoleArgs) => {
                served.push(consoleArgs);
                return Promise.resolve();
              },
              launchIo,
              { platform, arch: "aarch64" },
            )
          );

          expect(served).toEqual([[]]);
          expect(launchIo.dockerReads).toBe(reads);
        });
      }
    });
  });

  describe("a named `runsc` with no rootfs named, on Linux", () => {
    it("is the rootfs of the Linux store under the home, for the direct driver's configuration", async () => {
      const store = await installLinuxStore(home);
      const workspace = join(root, "workspace");
      await Deno.mkdir(workspace);

      const config = resolveRunscSandboxConfig({
        workspaceHostPath: workspace,
        runscBinary: join(store, LINUX_RUNSC),
        platform: "linux",
        homeDir: home,
      });

      expect(config.rootfs).toBe(join(store, LINUX_ROOTFS));
    });

    it("is refused, saying where it is looked for, where there is no home", () => {
      expect(thrownMessage(() =>
        resolveRunscSandboxConfig({
          workspaceHostPath: root,
          runscBinary: "/bin/sh",
          platform: "linux",
        })
      )).toBe(
        "runsc sandbox needs a rootfs: pass --sandbox-rootfs or set " +
          "CF_HARNESS_SANDBOX_ROOTFS (the default is the kitchensink image " +
          "of the store under the home: the cfc-vm store on macOS, " +
          "~/.local/share/runsc-cfc on Linux)",
      );
    });
  });

  describe("a named `runsc` with no rootfs named, on macOS", () => {
    // Its rootfs is the kitchen-sink image of the store the macOS `runsc`
    // runs from: the one `CFC_VM_HOME` names, else the one under the home.
    // The store `CFC_VM_HOME` names is A, and the home holds another, B.
    let storeA: string;
    let storeB: string;
    let workspace: string;

    beforeEach(async () => {
      storeA = join(root, "vm");
      storeB = defaultStore(home);
      await installStore(storeA);
      await installStore(storeB);
      workspace = join(root, "workspace");
      await Deno.mkdir(workspace);
    });

    /** Runs `body` with the process's environment holding `values`. */
    const withProcessEnv = <T>(
      values: Record<string, string | undefined>,
      body: () => T,
    ): T => {
      const before = Object.keys(values).map((name) =>
        [name, Deno.env.get(name)] as const
      );
      const put = (name: string, value: string | undefined) =>
        value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
      // `body` runs to its end before the values are restored, with nothing
      // awaited, so nothing else in the process sees them.
      for (const [name, value] of Object.entries(values)) put(name, value);
      try {
        return body();
      } finally {
        for (const [name, value] of before) put(name, value);
      }
    };

    it("is the image of the store `CFC_VM_HOME` names, for the direct driver's configuration", () => {
      const config = resolveRunscSandboxConfig({
        workspaceHostPath: workspace,
        runscBinary: join(storeA, SHIM),
        platform: "darwin",
        homeDir: home,
        cfcVmHome: storeA,
      });

      expect(config.rootfs).toBe(join(storeA, ROOTFS));
    });

    it("is the image of the store under the home where `CFC_VM_HOME` is unset or empty", () => {
      for (const cfcVmHome of [undefined, ""]) {
        const config = resolveRunscSandboxConfig({
          workspaceHostPath: workspace,
          runscBinary: join(storeB, SHIM),
          platform: "darwin",
          homeDir: home,
          ...(cfcVmHome !== undefined ? { cfcVmHome } : {}),
        });

        expect(config.rootfs).toBe(join(storeB, ROOTFS));
      }
    });

    it("is the image of the store `CFC_VM_HOME` names, for an engine built in that environment", () => {
      const engine = withProcessEnv(
        { HOME: home, CFC_VM_HOME: storeA },
        () =>
          new CfHarnessEngine({
            model: "gpt-5.4",
            workspaceHostPath: workspace,
            sandboxRuntimeKind: "runsc",
            sandboxRunscBinary: join(storeA, SHIM),
            sandboxPlatform: "darwin",
            cfcEnforcementMode: "observe",
            processRunner: {
              run: () =>
                Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
            },
          }),
      );

      expect(engine.sandbox.describe().cfc?.image).toBe(join(storeA, ROOTFS));
    });

    it("is the image of the store `CFC_VM_HOME` names, in the console's runtime row", async () => {
      const env = {
        HOME: home,
        CFC_VM_HOME: storeA,
        CF_HARNESS_SANDBOX_RUNTIME: "runsc",
        CF_HARNESS_RUNSC_BINARY: join(storeA, SHIM),
        CF_HARNESS_RUNSC_CFC_POLICY: join(storeA, POLICY),
      };
      const health = createConsoleHealth(
        await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--workspace",
            workspace,
          ],
          env,
          root,
          { platform: "darwin", arch: "aarch64" },
        ),
        undefined,
        undefined,
        env,
        undefined,
        () => Promise.reject(new Error("Docker is not asked")),
        { platform: "darwin" },
      );

      await health.refresh();
      const rows = health.snapshot().rows;

      expect(rows.find((row) => row.id === "sandbox.runtime")?.detail)
        .toContain(`rootfs ${join(storeA, ROOTFS)};`);
      // The VM row is A's too, and finds the rootfs to be one of its images.
      // No daemon runs for a store a case made, and reading the row starts
      // none.
      expect(rows.find((row) => row.id === "sandbox.vm")).toMatchObject({
        state: "ok",
        value: "idle; starts on first use",
        detail: join(storeA, "daemon.sock"),
      });
    });
  });

  describe("a native store that a writable mount of the run holds", () => {
    /** The record of a native runtime macOS defaulted to, from `store`. */
    const defaulted = (store: string): SandboxRuntimeChoice => ({
      runtime: "runsc",
      source: "default",
      platform: "darwin",
      nativeStore: store,
    });

    /** What the direct driver says of one of its files a mount holds. */
    const within = (file: string, mount: string): string =>
      `${file} lies inside the writable mount ${mount}: the sandbox could ` +
      "rewrite it";

    /** What it adds for a runtime nobody named. */
    const unnamed = (store: string): string =>
      ". No sandbox runtime is named, so this is the native `runsc` runtime " +
      `that macOS defaults to, from the store at \`${store}\`: run with a ` +
      "workspace and mounts that hold none of it, or select Docker with " +
      "`CF_HARNESS_SANDBOX_RUNTIME=docker`.";

    /**
     * Each file the driver keeps out of a writable mount: how it names the
     * file, and a directory of the store that holds that file and neither of
     * the other two.
     */
    const FILES = [
      { label: "runsc binary", file: SHIM, holder: "bin" },
      { label: "sandbox rootfs", file: ROOTFS, holder: "images" },
      { label: "CFC policy", file: join("policy", POLICY), holder: "policy" },
    ];

    /**
     * Resolves the direct driver's configuration from the store at `store`
     * for a run whose workspace is `workspace`, as an engine does. The
     * policy is in a directory of its own, so a workspace can hold it alone.
     */
    const resolved = (
      store: string,
      workspace: string,
      selection?: SandboxRuntimeChoice,
    ) =>
      resolveRunscSandboxConfig({
        workspaceHostPath: workspace,
        runscBinary: join(store, SHIM),
        rootfs: join(store, ROOTFS),
        cfcPolicyPath: join(store, "policy", POLICY),
        platform: "linux",
        unnamedRuntimeNote: unnamedRuntimeMountNote(selection),
      });

    /** Makes a store under the case's root with its policy where `resolved` names it. */
    const installed = async (): Promise<string> => {
      const store = join(root, "vm");
      await installStore(store);
      await Deno.mkdir(join(store, "policy"));
      await Deno.writeTextFile(join(store, "policy", POLICY), "{}\n");
      return store;
    };

    for (const { label, file, holder } of FILES) {
      it(`says of a ${label} in the workspace that the runtime was the default, and how Docker is selected`, async () => {
        const store = await installed();
        const workspace = join(store, holder);

        expect(
          thrownMessage(() => resolved(store, workspace, defaulted(store))),
        )
          .toBe(
            within(`${label} ${join(store, file)}`, workspace) +
              unnamed(store),
          );
      });

      it(`says of a ${label} in the workspace no more than where it lies, for a runtime that was named`, async () => {
        const store = await installed();
        const workspace = join(store, holder);

        for (
          const selection of [
            undefined,
            { runtime: "runsc", source: "flag" } as const,
            { runtime: "runsc", source: "environment" } as const,
          ]
        ) {
          expect(thrownMessage(() => resolved(store, workspace, selection)))
            .toBe(within(`${label} ${join(store, file)}`, workspace));
        }
      });
    }

    it("resolves for the default where no mount holds the store", async () => {
      const store = await installed();
      const workspace = join(root, "workspace");
      await Deno.mkdir(workspace);

      expect(resolved(store, workspace, defaulted(store))).toMatchObject({
        runscBinary: join(store, SHIM),
        rootfs: join(store, ROOTFS),
        cfcPolicyPath: join(store, "policy", POLICY),
      });
    });

    it("refuses a batch run on macOS whose workspace is the home, saying the runtime was the default", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const { io, stdout, stderr } = ioBuffers();

      const exitCode = await runCfHarnessCli(
        [
          "--model-provider",
          "openai-compatible-gateway",
          "--gateway-auth-mode",
          "none",
          "--workspace",
          home,
          "--prompt",
          "hello",
        ],
        {
          io,
          env: { HOME: home },
          platform: "darwin",
          arch: "aarch64",
          cwd: root,
          registerSignalHandler: () => () => {},
          createPromptLoop: () => {
            throw new Error("no loop is built for a refused run");
          },
        },
      );

      expect([exitCode, stdout]).toEqual([1, []]);
      expect(stderr.join("")).toContain(
        within(`runsc binary ${join(store, SHIM)}`, home) + unnamed(store),
      );
    });

    it("fails the runtime row of a console on macOS whose workspace is the home, saying the runtime was the default", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const env = { HOME: home };
      const health = createConsoleHealth(
        await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--workspace",
            home,
          ],
          env,
          root,
          { platform: "darwin", arch: "aarch64" },
        ),
        undefined,
        undefined,
        env,
        undefined,
        () => Promise.reject(new Error("Docker is not asked")),
        { platform: "darwin" },
      );

      const selected =
        `selected: runsc (default on macOS: the native store at ${store})`;
      const runtimeRow = () =>
        health.snapshot().rows.find((row) => row.id === "sandbox.runtime");
      // Before anything is checked, the row already says how the runtime
      // was selected.
      expect(runtimeRow()).toMatchObject({
        value: "not checked",
        detail: selected,
      });

      await health.refresh();

      expect(runtimeRow()).toMatchObject({
        state: "failed",
        value: "configuration refused",
        reason: within(`runsc binary ${join(store, SHIM)}`, home) +
          unnamed(store),
        detail: selected,
      });
    });
  });

  describe("an entrypoint given no platform", () => {
    // Every other case in this file names its platform. These name none, so
    // each entrypoint takes the platform the suite runs on, and what a case
    // expects is read off that same platform: a run on macOS or Linux checks
    // that the entrypoint's own default is the native runtime, and a run
    // anywhere else that it is Docker. An entrypoint whose platform were fixed
    // would fail one of the two.

    const CONSOLE_ARGS = [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
    ];
    const LAUNCH_ARGS = [
      "--fabric-identity",
      "/keys/dev.key",
      "--fabric-space",
      "cf-harness-dev",
      "--fabric-api-url",
      "http://localhost:8000",
      "--store",
      "/checkout/cache/memory",
    ];

    /** Launch IO that reads no instance and a Docker with its sidecars. */
    const launchIo: ConsoleLaunchIo = {
      readTextFile: () => Promise.resolve(undefined),
      readToolshedStoreDir: () => Promise.resolve(""),
      readDockerRuntimes: () =>
        Promise.resolve({
          runtimes: {
            "runsc-cfc": {
              runtimeArgs: [
                "--cfc-result-dir=/sidecars/results",
                "--cfc-invocation-context-dir=/sidecars/ctx",
              ],
            },
          },
        }),
    };

    /** The record of the Docker default of the platform the suite runs on. */
    const defaultedDockerHere = {
      sandboxRuntimeChoice: {
        runtime: "docker",
        source: "default",
        platform: Deno.build.os,
      },
    };

    /**
     * On macOS and Linux, checks that `selecting` was refused by the native
     * default, which the home holds no store for. On Linux the process the
     * suite runs as decides what is in the way first (whether it is root, or
     * can tell), so the refusal is checked for whose default it is. Returns
     * whether the suite runs on either, where that is the whole of what a
     * case expects.
     */
    const refusedHere = async (
      selecting: Promise<unknown>,
    ): Promise<boolean> => {
      const name = Deno.build.os === "darwin"
        ? "macOS"
        : Deno.build.os === "linux"
        ? "Linux"
        : undefined;
      if (name === undefined) return false;
      const refusal = await rejection(selecting);
      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(messageOf(refusal)).toContain(
        "No sandbox runtime is named, so the default applies, which on " +
          `${name} is the native \`runsc\` runtime, and `,
      );
      if (name === "macOS") {
        expect(messageOf(refusal)).toContain(
          `it is not set up at \`${defaultStore(home)}\`: `,
        );
      }
      return true;
    };

    it("is the batch CLI, which takes the default of the platform it runs on", async () => {
      const parsing = parseCfHarnessCliArgs(["hello"], {
        cwd: root,
        env: { HOME: home },
      });

      if (await refusedHere(parsing)) return;
      const parsed = await parsing;
      expect(sandboxOf("help" in parsed ? undefined : parsed)).toEqual(
        defaultedDockerHere,
      );
    });

    it("is the batch CLI's check before a run, which takes the same default", async () => {
      const selecting = selectCfHarnessCliSandboxRuntime({
        cwd: root,
        env: { HOME: home },
      });

      if (await refusedHere(selecting)) return;
      expect(await selecting).toEqual(defaultedDockerHere);
    });

    it("is the interactive stdio entrypoint, which takes the default of the platform it runs on", async () => {
      const started: RunHarnessInteractiveChatStdioOptions[] = [];
      const starting = runHarnessInteractiveChatStdioCli(
        [],
        root,
        (options) => {
          started.push(options);
          return Promise.resolve();
        },
        { env: { HOME: home } },
      );

      if (await refusedHere(starting)) return;
      await starting;
      expect(
        started.map((options) => sandboxOf(options.basePromptLoopOptions)),
      ).toEqual([defaultedDockerHere]);
    });

    it("is the console, which takes the default of the platform it runs on", async () => {
      const resolving = resolveConsoleConfig(
        CONSOLE_ARGS,
        { HOME: home },
        root,
      );

      if (await refusedHere(resolving)) return;
      expect(sandboxOf(await resolving)).toEqual(defaultedDockerHere);
    });

    it("is the console launcher, which takes the default of the platform it runs on", async () => {
      const preparing = prepareConsoleLaunch(
        LAUNCH_ARGS,
        { HOME: home },
        launchIo,
      );

      if (await refusedHere(preparing)) return;
      expect(
        (await preparing).plan.resolved.filter(({ name }) =>
          name === "sandbox"
        ),
      ).toEqual([{
        name: "sandbox",
        value: "docker",
        source: `harness ${dockerDefaultReason(Deno.build.os)}`,
      }]);
    });
  });

  describe("a run's record of its runtime", () => {
    /** A process runner that runs nothing and succeeds at it. */
    const inertRunner: ProcessRunner = {
      run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    };

    /** One model turn that calls `name`, in the chat fixture's shape. */
    const toolCallTurn = (
      id: string,
      name: string,
      args: Record<string, unknown>,
    ) => ({
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
    });

    /** One model turn that ends a run. */
    const finalTurn = (content: string) => ({
      choices: [{ index: 0, message: { role: "assistant", content } }],
    });

    /** Serves `payloads` in order, one for each request. */
    const scriptedFetch = (payloads: readonly unknown[]): typeof fetch => {
      let served = 0;
      return () => {
        const payload = payloads[served];
        served += 1;
        if (payload === undefined) {
          throw new Error("scripted fetch ran out of payloads");
        }
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
    };

    /** Reads one JSON artifact of the run `runId` under the artifact root. */
    const artifact = async (runId: string, name: string) =>
      JSON.parse(
        await Deno.readTextFile(join(root, "artifacts", runId, name)),
      );

    /**
     * Runs a parent that delegates once, on the direct driver, built the way
     * an entrypoint builds it from a selection that carries `choice`.
     */
    const runWithChild = async (choice: SandboxRuntimeChoice | undefined) => {
      const store = defaultStore(home);
      await installStore(store);
      const workspace = join(root, "workspace");
      await Deno.mkdir(workspace);
      const engine = new CfHarnessEngine({
        runId: "run-recorded",
        model: "gpt-5.4",
        workspaceHostPath: workspace,
        artifactRoot: join(root, "artifacts"),
        sandboxRuntimeKind: "runsc",
        sandboxRunscBinary: join(store, SHIM),
        sandboxRootfs: join(store, ROOTFS),
        cfcEnforcementMode: "observe",
        processRunner: inertRunner,
        ...(choice !== undefined ? { sandboxRuntimeChoice: choice } : {}),
      });
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        maxModelTurns: 4,
        fetchFn: scriptedFetch([
          toolCallTurn("call-delegate", "delegate_task", {
            goal: "Report.",
            maxModelTurns: 2,
          }),
          finalTurn("Child done."),
          finalTurn("Parent done."),
        ]),
      });
      const result = await loop.runPrompt({
        prompt: "Delegate.",
        promptSlotBinding: directPromptSlotBindingFor("recorded-runtime"),
      });
      expect(result.runState.status).toBe("completed");
      return result;
    };

    it("is carried in the runtime description of the run, of its policy snapshot, and of its child", async () => {
      const choice: SandboxRuntimeChoice = {
        runtime: "runsc",
        source: "default",
        platform: "darwin",
        nativeStore: defaultStore(home),
      };

      const result = await runWithChild(choice);

      expect(result.runState.capabilitySnapshot?.cfc.sandbox).toMatchObject({
        kind: "runsc-cfc",
        selection: choice,
      });
      expect(
        (await artifact("run-recorded", "capabilities.json")).cfc.sandbox
          .selection,
      ).toEqual(choice);
      expect(
        (await artifact("run-recorded", "policy-snapshot.json")).substrate
          .sandbox.selection,
      ).toEqual(choice);
      expect(
        (await artifact("run-recorded.subagent.1", "capabilities.json")).cfc
          .sandbox.selection,
      ).toEqual(choice);
    });

    it("is absent from the description of a run built without a selection", async () => {
      const result = await runWithChild(undefined);

      const described = result.runState.capabilitySnapshot?.cfc.sandbox;
      expect(described?.kind).toBe("runsc-cfc");
      expect(described !== undefined && "selection" in described).toBe(false);
      expect(
        "selection" in
          (await artifact("run-recorded.subagent.1", "capabilities.json")).cfc
            .sandbox,
      ).toBe(false);
    });
  });
});
