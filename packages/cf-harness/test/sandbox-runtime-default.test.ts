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
import {
  type CfHarnessCliIO,
  formatCfHarnessCliResult,
  parseCfHarnessCliArgs,
  runCfHarnessCli,
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
import {
  describeSandboxRuntimeChoice,
  resolveSandboxRuntimeSelection,
  type SandboxRuntimeChoice,
  type SandboxRuntimeSelection,
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

/** The CFC policy the Docker path's installer puts under `home`. */
const homePolicy = (home: string): string =>
  join(home, ".local", "share", "runsc-cfc", "cfc-policy.json");

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

/** What `promise` rejects with, or `undefined` where it resolves. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(() => undefined, (error: unknown) => error);

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

/** The record of a runtime Linux defaulted to. */
const DEFAULTED_DOCKER = {
  runtime: "docker",
  source: "default",
  platform: "linux",
} as const;

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

      for (const platform of ["darwin", "linux"]) {
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

      it("returns the policy under the home, and not the store's own, for a named `runsc` on macOS", async () => {
        await installStore(defaultStore(home));
        const select = () =>
          resolveSandboxRuntimeSelection(
            {
              HOME: home,
              CF_HARNESS_SANDBOX_RUNTIME: "runsc",
            },
            {},
            { platform: "darwin", flags: false },
          );

        // The store's `policy.json` is there, and a named `runsc` takes none.
        expect((await select()).sandboxCfcPolicy).toBeUndefined();
        await Deno.mkdir(join(homePolicy(home), ".."), { recursive: true });
        await Deno.writeTextFile(homePolicy(home), "{}\n");
        expect((await select()).sandboxCfcPolicy).toBe(homePolicy(home));
      });
    });

    describe("with no runtime named, off macOS", () => {
      for (const platform of ["linux", "windows", "freebsd"]) {
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
          platform: "linux",
          flags: true,
          pathExists: counted(true),
          stat: counted(await Deno.stat(home)),
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
              platform: "linux",
              flags: true,
            },
          ),
        ).toEqual({ sandboxRuntimeChoice: DEFAULTED_DOCKER });
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
        expect((refusal as Error).message).not.toContain("--sandbox");
      });

      it("throws for a store that cannot be located, with neither `CFC_VM_HOME` nor a home", async () => {
        for (const env of [{}, { HOME: "", CFC_VM_HOME: "" }]) {
          const refusal = await rejection(
            resolveSandboxRuntimeSelection(env, {}, {
              platform: "darwin",
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
            { platform: "darwin", flags: true },
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
            { platform: "darwin", flags: true },
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
            flags: true,
            homeDir: home,
          }),
        ).toEqual(fromStore(store, homePolicy(home)));
      });

      it("throws for a piece of the store that cannot be examined, with the reason", async () => {
        const store = defaultStore(home);
        await installStore(store);

        const refusal = await rejection(
          resolveSandboxRuntimeSelection({ HOME: home }, {}, {
            platform: "darwin",
            flags: true,
            stat: (path) =>
              path === join(store, CONFIG)
                ? Promise.reject(new Deno.errors.PermissionDenied("locked"))
                : Deno.stat(path),
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

    it("returns a defaulted Docker with the platform that defaulted to it", () => {
      expect(describeSandboxRuntimeChoice(DEFAULTED_DOCKER)).toBe(
        "docker (default on linux: the native runtime is macOS only)",
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
    ...(options?.sandboxRuntimeChoice !== undefined
      ? { sandboxRuntimeChoice: options.sandboxRuntimeChoice }
      : {}),
  });

  describe("the batch CLI", () => {
    /** Runs a prompt through the CLI, and keeps what its loop was built with. */
    const run = async (
      platform: string,
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

    it("runs on Docker with no runtime named on Linux, whatever store is there", async () => {
      await installStore(defaultStore(home));

      const { exitCode, built, stdout } = await run("linux", { HOME: home });

      expect(exitCode).toBe(0);
      expect(built.map(sandboxOf)).toEqual([
        { sandboxRuntimeChoice: DEFAULTED_DOCKER },
      ]);
      expect(stdout.join("")).toContain(
        "\nsandbox: docker (default on linux: the native runtime is macOS only)\n",
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

    it("leaves the sandbox line out of a summary given no selection", () => {
      expect(formatCfHarnessCliResult(completed())).not.toContain("sandbox:");
      expect(
        formatCfHarnessCliResult(completed(), "batch", DEFAULTED_DOCKER),
      ).toBe("Done.\n");
    });
  });

  describe("the interactive stdio entrypoint", () => {
    /** Starts the entrypoint, and keeps what it would run its host with. */
    const start = async (platform: string, env: Record<string, string>) => {
      const started: RunHarnessInteractiveChatStdioOptions[] = [];
      await runHarnessInteractiveChatStdioCli([], root, (options) => {
        started.push(options);
        return Promise.resolve();
      }, { env, platform });
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
      const { message } = refusal as Error;
      expect(message).toContain(
        `it is not set up at \`${defaultStore(home)}\`: `,
      );
      expect(message).toContain("`config.json`, the VM's configuration,");
      expect(message.endsWith(`or ${DOCKER_BY_VARIABLE}`)).toBe(true);
      expect(message).not.toContain("--sandbox");
    });

    it("hands its host Docker with no runtime named on Linux, whatever store is there", async () => {
      await installStore(defaultStore(home));

      expect(await start("linux", { HOME: home })).toEqual([
        { sandboxRuntimeChoice: DEFAULTED_DOCKER },
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
    /**
     * A host over `env`, whose batch lane builds a loop that runs nothing and
     * whose interactive lane starts a host that serves nothing.
     */
    const host = async (platform: string, env: Record<string, string>) => {
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
          platform,
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
    const batch = async (): Promise<string[]> => {
      const workspace = join(root, "workspace");
      await Deno.mkdir(workspace, { recursive: true });
      return ["--workspace", workspace, "--prompt", "hello"];
    };

    it("runs a batch on the native runtime, from the store under the home it keeps aside, on macOS", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const { loomHost, built, stderr } = await host("darwin", { HOME: home });

      expect([await loomHost.runBatch(await batch()), stderr]).toEqual([0, []]);
      expect(built.map(sandboxOf)).toEqual([
        fromStore(store, join(store, POLICY)),
      ]);
    });

    it("refuses a batch with the whole message on stderr, with no runtime named on macOS and no store", async () => {
      const { loomHost, built, stderr } = await host("darwin", { HOME: home });

      expect([await loomHost.runBatch(await batch()), built]).toEqual([1, []]);
      expect(stderr).toHaveLength(1);
      const failure = JSON.parse(stderr[0]) as {
        error: { code: string; message: string };
      };
      expect(failure.error.code).toBe("invalid-request");
      expect(failure.error.message).toContain(
        `it is not set up at \`${defaultStore(home)}\`: `,
      );
      expect(failure.error.message).toContain(
        "`bin/cfc-vm`, the VM daemon the shim starts, is missing",
      );
      // The batch lane hands its arguments to the batch CLI, which takes the
      // flag.
      expect(
        failure.error.message.endsWith(`or ${DOCKER_BY_FLAG_OR_VARIABLE}`),
      ).toBe(true);
    });

    it("runs a batch on Docker with no runtime named on Linux, whatever store is there", async () => {
      await installStore(defaultStore(home));
      const { loomHost, built } = await host("linux", { HOME: home });

      expect(await loomHost.runBatch(await batch())).toBe(0);
      expect(built.map(sandboxOf)).toEqual([
        { sandboxRuntimeChoice: DEFAULTED_DOCKER },
      ]);
    });

    it("starts its interactive lane on the native runtime, from the store, on macOS", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const { loomHost, started } = await host("darwin", { HOME: home });

      await loomHost.runInteractive([]);

      expect(
        started.map((options) => sandboxOf(options.basePromptLoopOptions)),
      ).toEqual([fromStore(store, join(store, POLICY))]);
    });

    it("refuses to start its interactive lane, naming the variable alone, on macOS with no store", async () => {
      const { loomHost, started } = await host("darwin", { HOME: home });

      const refusal = await rejection(loomHost.runInteractive([]));

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(started).toEqual([]);
      const { message } = refusal as Error;
      expect(message).toContain(
        `it is not set up at \`${defaultStore(home)}\`: `,
      );
      expect(message.endsWith(`or ${DOCKER_BY_VARIABLE}`)).toBe(true);
      expect(message).not.toContain("--sandbox");
    });

    it("starts its interactive lane on Docker with no runtime named on Linux", async () => {
      await installStore(defaultStore(home));
      const { loomHost, started } = await host("linux", { HOME: home });

      await loomHost.runInteractive([]);

      expect(
        started.map((options) => sandboxOf(options.basePromptLoopOptions)),
      ).toEqual([{ sandboxRuntimeChoice: DEFAULTED_DOCKER }]);
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

    it("serves on Docker with no runtime named on Linux, whatever store is there", async () => {
      await installStore(defaultStore(home));

      const config = await resolveConsoleConfig(ARGS, { HOME: home }, root, {
        platform: "linux",
      });

      expect(sandboxOf(config)).toEqual({
        sandboxRuntimeChoice: DEFAULTED_DOCKER,
      });
      expect(sandboxRow(config)).toEqual([{
        value: "docker",
        detail: "console default on linux: the native runtime is macOS only",
      }]);
      expect(consoleSandboxBanner(config)[0]).toBe(
        "  sandbox:    docker; default on linux: the native runtime is macOS only",
      );
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
          { platform: "darwin" },
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
        { platform: "linux" },
      );

      expect(consoleSandboxBanner(config)[0]).toBe("  sandbox:    docker");
    });

    it("says in its runtime row that the native runtime was the default, and reads its VM's store", async () => {
      const store = defaultStore(home);
      await installStore(store);
      const env = { HOME: home };
      const health = createConsoleHealth(
        await resolveConsoleConfig(ARGS, env, root, { platform: "darwin" }),
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
          platform: "linux",
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
          "docker (default on linux: the native runtime is macOS only)",
      });
    });

    describe("startConsoleServer()", () => {
      it("refuses to serve, naming the variable alone, with no runtime named on macOS and no store", async () => {
        const refusal = await rejection(
          startConsoleServer(ARGS, { HOME: home }, root, undefined, {
            platform: "darwin",
          }),
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        const { message } = refusal as Error;
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
          ["linux", "on Linux with no store", false],
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
              { platform },
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
        { platform: "darwin" },
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
        { platform: "darwin" },
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

    it("reports Docker as the default, and reads its runtime table, on Linux", async () => {
      await installStore(defaultStore(home));
      const launchIo = io();

      const { plan } = await prepareConsoleLaunch(
        ARGS,
        { HOME: home },
        launchIo,
        { platform: "linux" },
      );

      expect(sandboxRows(plan)).toEqual([{
        name: "sandbox",
        value: "docker",
        source: "harness default on linux: the native runtime is macOS only",
      }]);
      expect(launchIo.dockerReads).toBe(1);
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/sidecars/results",
      );
    });

    it("throws for a sidecar flag on a defaulted native runtime, saying how Docker is selected", async () => {
      await installStore(defaultStore(home));

      await expect(
        prepareConsoleLaunch(
          [...ARGS, "--cfc-result-dir", "/elsewhere"],
          { HOME: home },
          io(),
          { platform: "darwin" },
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
      /** Restores whatever the process held for the keys a launch decides. */
      const withEnvironmentRestored = async (
        body: () => Promise<void>,
      ): Promise<void> => {
        const before = LAUNCHER_OWNED_VARIABLES.map((name) =>
          [name, Deno.env.get(name)] as const
        );
        try {
          await body();
        } finally {
          for (const [name, value] of before) {
            if (value === undefined) Deno.env.delete(name);
            else Deno.env.set(name, value);
          }
        }
      };

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
          { platform: "darwin" },
        ));

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(served).toBe(false);
        const { message } = refusal as Error;
        expect(message).toContain(
          `it is not set up at \`${defaultStore(home)}\`: `,
        );
        expect(message.endsWith(`or ${DOCKER_BY_VARIABLE}`)).toBe(true);
      });

      for (
        const [platform, where, reads] of [
          ["darwin", "on macOS with a store set up", 0],
          ["linux", "on Linux", 1],
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
              { platform },
            )
          );

          expect(served).toEqual([[]]);
          expect(launchIo.dockerReads).toBe(reads);
        });
      }
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
