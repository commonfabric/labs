/**
 * Checks that a run, and an interactive session, goes on only on the sandbox
 * runtime it started on. The two runtimes need not keep the CFC labels of a
 * run's files where the other reads them, and on macOS they do not, so what
 * one labelled the other can read as unlabelled. A run records its runtime
 * as its engine is built and a session as it starts; a record written before
 * either did is read by what it does hold, and bound from its next use. Each
 * case builds its runs over a process runner that runs nothing, and a case
 * that needs a native store makes one.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";

import { readHarnessRunState } from "../src/artifacts.ts";
import { type CfHarnessCliIO, runCfHarnessCli } from "../src/cli.ts";
import type { HarnessChatSessionStatus } from "../src/contracts/interactive-chat.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import type { ProcessRunner } from "../src/sandbox/process-runner.ts";
import {
  recordedSandboxRuntime,
  sandboxRuntimeNamed,
  sandboxRuntimeOfKind,
  sandboxRuntimeOfOptions,
} from "../src/sandbox/runtime-selection.ts";
import type {
  SandboxPlatform,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxRuntimeKind,
} from "../src/sandbox/types.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";

/** A process runner that runs nothing and succeeds at it. */
const inertRunner: ProcessRunner = {
  run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
};

/** A runtime handed to an engine, which describes itself as `kind`. */
const handedIn = (kind: SandboxRuntimeDescription["kind"]): SandboxRuntime => ({
  describe: () => ({ kind, defaultWorkingDirectory: "/workspace" }),
  defaultWorkingDirectory: () => "/workspace",
  isPathWithinWorkspace: () => true,
  isPathWithinAllowedRoots: () => true,
  resolvePath: (path) => path,
  run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
});

/** What a resume says of a record that names the runtime `recorded`, unknown here. */
const unknownRuntime = (recorded: string): string =>
  "resume sandbox runtime unknown: the run records that it started on the " +
  `sandbox runtime \`${recorded}\`, which this cf-harness does not know, so ` +
  "it cannot tell whether this resume is on the same one. Resume it with " +
  "the cf-harness that wrote the record.";

/** What a resume says of a run started on `recorded` and resumed on `selected`. */
const mismatch = (
  recorded: SandboxRuntimeKind,
  selected: string,
  naming: string,
): string =>
  `resume sandbox runtime mismatch: the run started on \`${recorded}\`, and ` +
  `this resume selects ${selected}. The two need not keep the CFC labels of ` +
  "a run's files where the other reads them, and on macOS they do not, so a " +
  `run resumes only on the runtime it started on: name it with ${naming}.`;

describe("sandbox-runtime-resume", () => {
  /**
   * A directory of the case's own, with a workspace and a native store of
   * each platform's: macOS's, and the Linux one beside it under the same home.
   */
  let root: string;
  let workspace: string;
  let store: string;
  let linuxStore: string;

  beforeEach(async () => {
    root = await Deno.realPath(await Deno.makeTempDir());
    workspace = join(root, "workspace");
    await Deno.mkdir(workspace);
    store = join(root, "home", "Library", "Application Support", "cfc-vm");
    await Deno.mkdir(join(store, "bin"), { recursive: true });
    for (const binary of ["runsc", "cfc-vm"]) {
      await Deno.writeTextFile(join(store, "bin", binary), "#!/bin/sh\n");
      await Deno.chmod(join(store, "bin", binary), 0o755);
    }
    await Deno.writeTextFile(join(store, "config.json"), "{}\n");
    await Deno.mkdir(join(store, "images", "kitchensink"), { recursive: true });
    await Deno.mkdir(join(store, "ext4"));
    await Deno.writeTextFile(join(store, "ext4", "kitchensink.ext4"), "");
    await Deno.writeTextFile(join(store, "policy.json"), "{}\n");
    linuxStore = join(root, "home", ".local", "share", "runsc-cfc");
    await Deno.mkdir(join(linuxStore, "bin"), { recursive: true });
    await Deno.writeTextFile(join(linuxStore, "bin", "runsc"), "#!/bin/sh\n");
    await Deno.chmod(join(linuxStore, "bin", "runsc"), 0o755);
    await Deno.mkdir(join(linuxStore, "images", "kitchensink"), {
      recursive: true,
    });
    await Deno.writeTextFile(join(linuxStore, "cfc-policy.json"), "{}\n");
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  /** The engine options that put a run on `runtime`, built by the engine. */
  const on = (runtime: SandboxRuntimeKind) => ({
    model: "gpt-5.4",
    workspaceHostPath: workspace,
    cfcEnforcementMode: "observe" as const,
    processRunner: inertRunner,
    ...(runtime === "runsc"
      ? {
        sandboxRuntimeKind: "runsc" as const,
        sandboxRunscBinary: join(store, "bin", "runsc"),
        sandboxRootfs: join(store, "images", "kitchensink"),
      }
      : {}),
  });

  /**
   * The state of a run that started on `runtime` and described it. The Docker
   * one is handed its runtime: a real one needs a Docker to probe.
   */
  const startedOn = async (
    runtime: SandboxRuntimeKind,
  ): Promise<HarnessRunState> => {
    const engine = new CfHarnessEngine({
      ...on(runtime),
      ...(runtime === "docker"
        ? { sandboxRuntime: handedIn("docker-runsc-cfc") }
        : {}),
      runId: "run-born",
    });
    const state = await engine.ensureDiagnosticsInitialized();
    expect(state.capabilitySnapshot?.cfc.sandbox.kind).toBe(
      runtime === "runsc" ? "runsc-cfc" : "docker-runsc-cfc",
    );
    return state;
  };

  /**
   * The state of a run built on `runtime` that never described it, as one
   * whose first probe of its sandbox failed is left.
   */
  const neverDescribed = (runtime: SandboxRuntimeKind): HarnessRunState =>
    new CfHarnessEngine({
      ...on(runtime),
      ...(runtime === "docker"
        ? { sandboxRuntime: handedIn("docker-runsc-cfc") }
        : {}),
      runId: "run-born",
    }).getRunState();

  /** `state` as a harness that did not yet record a run's runtime wrote it. */
  const beforeRecording = (
    { sandboxRuntime: _, ...older }: HarnessRunState,
  ): HarnessRunState => older;

  /**
   * `state` with `changes` in it, read back from a `run-state.json`, as a
   * record another build wrote arrives.
   */
  const asWritten = async (
    state: HarnessRunState,
    changes: Record<string, unknown>,
  ): Promise<HarnessRunState> => {
    const path = join(root, "run-state.json");
    await Deno.writeTextFile(path, JSON.stringify({ ...state, ...changes }));
    return await readHarnessRunState(path);
  };

  /** What building `build` throws, or `undefined` where it builds. */
  const refusalOf = (build: () => unknown): unknown => {
    try {
      build();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  describe("sandboxRuntimeNamed()", () => {
    it("returns each runtime for its own name, and nothing for any other", () => {
      expect(
        ["docker", "runsc", "Docker", "RUNSC", " docker", "", "podman"].map(
          sandboxRuntimeNamed,
        ),
      ).toEqual([
        "docker",
        "runsc",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    });
  });

  describe("sandboxRuntimeOfKind()", () => {
    it("returns the runtime an entrypoint names for each kind a runtime describes itself as", () => {
      expect(sandboxRuntimeOfKind("docker-runsc-cfc")).toBe("docker");
      expect(sandboxRuntimeOfKind("runsc-cfc")).toBe("runsc");
    });

    it("returns nothing for a kind it does not know, the runtimes' own names among them", () => {
      for (const kind of ["docker", "runsc", "", "podman-cfc", "RUNSC-CFC"]) {
        expect(sandboxRuntimeOfKind(kind)).toBeUndefined();
      }
    });
  });

  describe("recordedSandboxRuntime()", () => {
    it("returns the runtime a record names, over the kind in its description", () => {
      expect(recordedSandboxRuntime({ sandboxRuntime: "runsc" })).toBe("runsc");
      expect(
        recordedSandboxRuntime({
          sandboxRuntime: "docker",
          capabilitySnapshot: { cfc: { sandbox: { kind: "runsc-cfc" } } },
        }),
      ).toBe("docker");
    });

    it("returns the runtime of the kind a record describes, where it names none", () => {
      expect(
        recordedSandboxRuntime({
          capabilitySnapshot: { cfc: { sandbox: { kind: "runsc-cfc" } } },
        }),
      ).toBe("runsc");
      expect(
        recordedSandboxRuntime({
          capabilitySnapshot: {
            cfc: { sandbox: { kind: "docker-runsc-cfc" } },
          },
        }),
      ).toBe("docker");
    });

    it("returns nothing for a record that neither names a runtime nor describes one", () => {
      expect(recordedSandboxRuntime({})).toBeUndefined();
      expect(recordedSandboxRuntime({ capabilitySnapshot: {} }))
        .toBeUndefined();
      expect(recordedSandboxRuntime({ capabilitySnapshot: { cfc: {} } }))
        .toBeUndefined();
    });

    for (
      const [what, record, named] of [
        ["names a runtime", { sandboxRuntime: "podman" }, "podman"],
        ["names an empty runtime", { sandboxRuntime: "" }, ""],
        [
          "names a runtime it does not know, whatever it describes",
          {
            sandboxRuntime: "podman",
            capabilitySnapshot: { cfc: { sandbox: { kind: "runsc-cfc" } } },
          },
          "podman",
        ],
        [
          "describes a kind",
          { capabilitySnapshot: { cfc: { sandbox: { kind: "podman-cfc" } } } },
          "podman-cfc",
        ],
      ] as const
    ) {
      it(`throws a resume refusal for a record that ${what} it does not know`, () => {
        const refusal = refusalOf(() => recordedSandboxRuntime(record));

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(refusal).toMatchObject({
          code: "provider-mismatch",
          message: unknownRuntime(named),
        });
      });
    }
  });

  describe("sandboxRuntimeOfOptions()", () => {
    it("returns the runtime handed in over the one named, and Docker where neither is", () => {
      expect(sandboxRuntimeOfOptions({})).toBe("docker");
      expect(sandboxRuntimeOfOptions({ sandboxRuntimeKind: "runsc" })).toBe(
        "runsc",
      );
      expect(
        sandboxRuntimeOfOptions({
          sandboxRuntimeKind: "runsc",
          sandboxRuntime: handedIn("docker-runsc-cfc"),
        }),
      ).toBe("docker");
      expect(
        sandboxRuntimeOfOptions({ sandboxRuntime: handedIn("runsc-cfc") }),
      ).toBe("runsc");
    });

    it("throws for a runtime handed in that describes itself as a kind it does not know", () => {
      expect(() =>
        sandboxRuntimeOfOptions({
          sandboxRuntimeKind: "runsc",
          sandboxRuntime: { describe: () => ({ kind: "podman-cfc" }) },
        })
      ).toThrow(
        new Error(
          "the sandbox runtime handed in describes itself as `podman-cfc`, " +
            "which is no kind of runtime this cf-harness knows",
        ),
      );
    });
  });

  describe("an engine as it is built", () => {
    it("records the runtime it runs on in its run state, before it has probed anything", () => {
      expect(
        (["docker", "runsc"] as const).map((runtime) =>
          new CfHarnessEngine(on(runtime)).getRunState().sandboxRuntime
        ),
      ).toEqual(["docker", "runsc"]);
    });

    it("records the runtime it was handed, rather than the one its options name", () => {
      expect(
        new CfHarnessEngine({
          ...on("docker"),
          sandboxRuntime: handedIn("runsc-cfc"),
        }).getRunState().sandboxRuntime,
      ).toBe("runsc");
    });

    it("keeps the record through a first probe of the sandbox that fails", async () => {
      const failing: SandboxRuntime = {
        ...handedIn("runsc-cfc"),
        run: () => Promise.reject(new Error("the sandbox did not start")),
        runShell: () => Promise.reject(new Error("the sandbox did not start")),
      };
      const engine = new CfHarnessEngine({
        ...on("docker"),
        sandboxRuntime: failing,
      });

      const state = await engine.ensureDiagnosticsInitialized();

      expect([state.capabilitySnapshot, state.sandboxRuntime]).toEqual([
        undefined,
        "runsc",
      ]);
    });

    it("records how its runtime was chosen beside it, for a run refused before its sandbox is described", async () => {
      // The native runtime macOS defaulted to, with no CFC policy: an
      // enforcing run on it is refused before its sandbox is probed, so its
      // capability snapshot, which also holds the choice, is never taken.
      const choice = {
        runtime: "runsc",
        source: "default",
        platform: "darwin",
        nativeStore: store,
      } as const;
      const engine = new CfHarnessEngine({
        ...on("runsc"),
        cfcEnforcementMode: "enforce-strict",
        artifactRoot: join(root, "artifacts"),
        runId: "run-refused",
        sandboxRuntimeChoice: choice,
      });

      const refusal = await engine.ensureDiagnosticsInitialized().then(
        () => undefined,
        (error: unknown) => error,
      );
      await engine.persistRunState();
      const recorded = await readHarnessRunState(
        join(root, "artifacts", "run-refused", "run-state.json"),
      );

      expect(refusal).toBeInstanceOf(Error);
      expect([
        recorded.capabilitySnapshot,
        recorded.sandboxRuntime,
        recorded.sandboxRuntimeChoice,
      ]).toEqual([undefined, "runsc", choice]);
    });

    it("keeps how the runtime was chosen when the run started, through a resume that chose it another way", () => {
      const started = new CfHarnessEngine({
        ...on("runsc"),
        sandboxRuntimeChoice: { runtime: "runsc", source: "environment" },
      }).getRunState();

      const resumed = new CfHarnessEngine({
        ...on("runsc"),
        runState: started,
        sandboxRuntimeChoice: { runtime: "runsc", source: "flag" },
      }).getRunState();

      expect(resumed.sandboxRuntimeChoice).toEqual({
        runtime: "runsc",
        source: "environment",
      });
    });

    it("records how a resume chose its runtime in a record that holds none", () => {
      const { sandboxRuntimeChoice: _, ...older } = new CfHarnessEngine(
        on("docker"),
      ).getRunState();

      expect(
        new CfHarnessEngine({
          ...on("docker"),
          runState: older,
          sandboxRuntimeChoice: { runtime: "docker", source: "flag" },
        }).getRunState().sandboxRuntimeChoice,
      ).toEqual({ runtime: "docker", source: "flag" });
    });

    it("records no choice for an engine its caller built with none", () => {
      expect(new CfHarnessEngine(on("docker")).getRunState()).not
        .toHaveProperty(
          "sandboxRuntimeChoice",
        );
    });
  });

  describe("an engine built to resume a run", () => {
    for (
      const [born, resumed] of [
        ["docker", "runsc"],
        ["runsc", "docker"],
      ] as const
    ) {
      it(`throws for a run started on \`${born}\` and resumed on \`${resumed}\`, naming \`${born}\` and its variable`, async () => {
        const runState = await startedOn(born);

        let refusal: unknown;
        try {
          new CfHarnessEngine({ ...on(resumed), runState });
        } catch (error) {
          refusal = error;
        }

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(refusal).toMatchObject({
          code: "provider-mismatch",
          message: mismatch(
            born,
            `\`${resumed}\``,
            `\`CF_HARNESS_SANDBOX_RUNTIME=${born}\``,
          ),
        });
      });

      it(`throws for a run started on \`${born}\` and resumed on a \`${resumed}\` runtime handed in`, async () => {
        const runState = await startedOn(born);

        expect(() =>
          new CfHarnessEngine({
            ...on(born),
            runState,
            sandboxRuntime: handedIn(
              resumed === "runsc" ? "runsc-cfc" : "docker-runsc-cfc",
            ),
          })
        ).toThrow(`the run started on \`${born}\``);
      });

      it(`returns an engine for a run started and resumed on \`${born}\``, async () => {
        const runState = await startedOn(born);

        const engine = new CfHarnessEngine({ ...on(born), runState });

        expect(sandboxRuntimeOfKind(engine.sandbox.describe().kind)).toBe(born);
      });
    }

    it("says how the resume selected its runtime, where the engine was told", async () => {
      const runState = await startedOn("docker");

      expect(() =>
        new CfHarnessEngine({
          ...on("runsc"),
          runState,
          sandboxRuntimeChoice: {
            runtime: "runsc",
            source: "default",
            platform: "darwin",
            nativeStore: store,
          },
        })
      ).toThrow(
        mismatch(
          "docker",
          `\`runsc\` (default on macOS: the native store at ${store})`,
          "`CF_HARNESS_SANDBOX_RUNTIME=docker`",
        ),
      );
    });

    for (
      const [born, resumed] of [
        ["docker", "runsc"],
        ["runsc", "docker"],
      ] as const
    ) {
      it(`throws for a run built on \`${born}\` that never described it, resumed on \`${resumed}\``, () => {
        const runState = neverDescribed(born);
        expect(runState.capabilitySnapshot).toBeUndefined();

        const refusal = refusalOf(() =>
          new CfHarnessEngine({ ...on(resumed), runState })
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(refusal).toMatchObject({
          code: "provider-mismatch",
          message: mismatch(
            born,
            `\`${resumed}\``,
            `\`CF_HARNESS_SANDBOX_RUNTIME=${born}\``,
          ),
        });
      });

      it(`returns an engine for a run built on \`${born}\` that never described it, resumed on \`${born}\``, () => {
        const engine = new CfHarnessEngine({
          ...on(born),
          runState: neverDescribed(born),
        });

        expect(engine.getRunState().sandboxRuntime).toBe(born);
      });

      it(`throws for a record written before runs recorded their runtime, by the \`${born}\` it describes, resumed on \`${resumed}\``, async () => {
        const runState = beforeRecording(await startedOn(born));

        const refusal = refusalOf(() =>
          new CfHarnessEngine({ ...on(resumed), runState })
        );

        expect(refusal).toMatchObject({
          code: "provider-mismatch",
          message: mismatch(
            born,
            `\`${resumed}\``,
            `\`CF_HARNESS_SANDBOX_RUNTIME=${born}\``,
          ),
        });
      });

      it(`writes \`${born}\` into a record written before runs recorded their runtime, as it resumes it there`, async () => {
        const runState = beforeRecording(await startedOn(born));

        const engine = new CfHarnessEngine({ ...on(born), runState });

        expect(engine.getRunState().sandboxRuntime).toBe(born);
      });
    }

    it("holds a resume to the runtime a record names, over the kind in its description", async () => {
      const runState = {
        ...await startedOn("docker"),
        sandboxRuntime: "runsc" as const,
      };

      expect(
        new CfHarnessEngine({ ...on("runsc"), runState }).getRunState()
          .sandboxRuntime,
      ).toBe("runsc");
      expect(
        refusalOf(() => new CfHarnessEngine({ ...on("docker"), runState })),
      ).toMatchObject({
        message: mismatch(
          "runsc",
          "`docker`",
          "`CF_HARNESS_SANDBOX_RUNTIME=runsc`",
        ),
      });
    });

    it("returns an engine on either runtime for a record that neither names a runtime nor describes one, and binds it to that runtime", async () => {
      const { capabilitySnapshot: _, capabilitiesPath: __, ...described } =
        await startedOn("docker");
      const runState = beforeRecording(described);

      for (
        const [runtime, other] of [["docker", "runsc"], [
          "runsc",
          "docker",
        ]] as const
      ) {
        const engine = new CfHarnessEngine({ ...on(runtime), runState });

        expect(sandboxRuntimeOfKind(engine.sandbox.describe().kind)).toBe(
          runtime,
        );
        // From here on the record names the runtime, and holds a resume to it.
        const bound = engine.getRunState();
        expect(bound.sandboxRuntime).toBe(runtime);
        expect(
          refusalOf(() =>
            new CfHarnessEngine({ ...on(other), runState: bound })
          ),
        ).toBeInstanceOf(HarnessControlError);
      }
    });

    for (
      const [what, changes, named] of [
        ["names a runtime", { sandboxRuntime: "podman" }, "podman"],
        [
          "describes a kind of runtime",
          {
            sandboxRuntime: undefined,
            capabilitySnapshot: {
              cfc: { sandbox: { kind: "podman-cfc" } },
            },
          },
          "podman-cfc",
        ],
      ] as const
    ) {
      it(`throws for a record that ${what} it does not know, on either runtime`, async () => {
        const runState = await asWritten(await startedOn("docker"), changes);

        for (const runtime of ["docker", "runsc"] as const) {
          const refusal = refusalOf(() =>
            new CfHarnessEngine({ ...on(runtime), runState })
          );

          expect(refusal).toBeInstanceOf(HarnessControlError);
          expect(refusal).toMatchObject({
            code: "provider-mismatch",
            message: unknownRuntime(named),
          });
        }
      });
    }
  });

  describe("the batch CLI resuming a run", () => {
    /**
     * Resumes a run through the CLI, as `platform`: one started on `born`
     * that described its runtime, or the one whose state is given.
     */
    const resume = async (
      born: SandboxRuntimeKind | HarnessRunState,
      platform: SandboxPlatform,
      extra: {
        args?: readonly string[];
        env?: Record<string, string>;
        sandboxSelectionFlags?: boolean;
      } = {},
    ) => {
      const runState = typeof born === "string" ? await startedOn(born) : born;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io: CfHarnessCliIO = {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      };
      let resumed = false;
      const exitCode = await runCfHarnessCli(
        [
          "--resume-run",
          join(root, "runs", "run-born"),
          "--workspace",
          workspace,
          "--gateway-auth-mode",
          "none",
          ...(extra.args ?? []),
        ],
        {
          io,
          platform,
          // Where the native default can run: Apple silicon, as root.
          arch: "aarch64",
          uid: () => 0,
          which: (name: string) =>
            name === "pasta" || name === "unshare"
              ? `/usr/bin/${name}`
              : undefined,
          cwd: root,
          env: { HOME: join(root, "home"), ...extra.env },
          ...(extra.sandboxSelectionFlags !== undefined
            ? { sandboxSelectionFlags: extra.sandboxSelectionFlags }
            : {}),
          registerSignalHandler: () => () => {},
          readRunArtifacts: () =>
            Promise.resolve({
              runRoot: join(root, "runs", "run-born"),
              runStatePath: join(root, "runs", "run-born", "run-state.json"),
              transcriptPath: join(root, "runs", "run-born", "transcript.json"),
              runState,
              transcript: [{ role: "user", content: "Continue." }],
            }),
          createPromptLoop: (options) => ({
            runPrompt: () => Promise.reject(new Error("not a new run")),
            runTranscript: () => {
              resumed = true;
              return Promise.resolve({
                model: "gpt-5.4",
                finalAssistantText: "Resumed.",
                transcript: [],
                modelTurns: 1,
                runState: options.engine!.getRunState(),
              });
            },
          }),
        },
      );
      return { exitCode, resumed, stdout, stderr };
    };

    it("refuses a run started on Docker where macOS defaults the resume to the native runtime", async () => {
      const { exitCode, resumed, stderr } = await resume("docker", "darwin");

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr).toEqual([
        `${
          mismatch(
            "docker",
            `\`runsc\` (default on macOS: the native store at ${store})`,
            "`--sandbox-runtime docker` or `CF_HARNESS_SANDBOX_RUNTIME=docker`",
          )
        }\n`,
      ]);
    });

    it("refuses a run started on `runsc` where the resume names Docker, naming `runsc`", async () => {
      const { exitCode, resumed, stderr } = await resume("runsc", "darwin", {
        args: ["--sandbox-runtime", "docker"],
      });

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr).toEqual([
        `${
          mismatch(
            "runsc",
            "`docker` (named by --sandbox-runtime)",
            "`--sandbox-runtime runsc` or `CF_HARNESS_SANDBOX_RUNTIME=runsc`",
          )
        }\n`,
      ]);
    });

    it("refuses a run started on Docker where Linux defaults the resume to the native runtime", async () => {
      const { exitCode, resumed, stderr } = await resume("docker", "linux");

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr).toEqual([
        `${
          mismatch(
            "docker",
            `\`runsc\` (default on Linux: the native store at ${linuxStore})`,
            "`--sandbox-runtime docker` or `CF_HARNESS_SANDBOX_RUNTIME=docker`",
          )
        }\n`,
      ]);
    });

    it("refuses a run started on `runsc` where FreeBSD defaults the resume to Docker", async () => {
      const { exitCode, resumed, stderr } = await resume("runsc", "freebsd");

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr.join("")).toContain(
        "this resume selects `docker` (default on freebsd: the native " +
          "runtime is macOS and Linux only)",
      );
    });

    it("refuses naming the variable alone for an embedder whose operator can pass no flag", async () => {
      const { stderr } = await resume("docker", "darwin", {
        sandboxSelectionFlags: false,
      });

      expect(stderr.join("")).toContain(
        "name it with `CF_HARNESS_SANDBOX_RUNTIME=docker`.",
      );
      expect(stderr.join("")).not.toContain("--sandbox-runtime");
    });

    it("refuses a run built on Docker that never described it, where macOS defaults the resume to the native runtime", async () => {
      const { exitCode, resumed, stderr } = await resume(
        neverDescribed("docker"),
        "darwin",
      );

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr).toEqual([
        `${
          mismatch(
            "docker",
            `\`runsc\` (default on macOS: the native store at ${store})`,
            "`--sandbox-runtime docker` or `CF_HARNESS_SANDBOX_RUNTIME=docker`",
          )
        }\n`,
      ]);
    });

    it("refuses a record written before runs recorded their runtime, by the runtime it describes", async () => {
      const { exitCode, resumed, stderr } = await resume(
        beforeRecording(await startedOn("runsc")),
        "freebsd",
      );

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr.join("")).toContain("the run started on `runsc`");
    });

    it("refuses a record that names a runtime it does not know, whatever the resume selects", async () => {
      const runState = await asWritten(await startedOn("docker"), {
        sandboxRuntime: "podman",
      });

      for (
        const args of [[], ["--sandbox-runtime", "docker"], [
          "--sandbox-runtime",
          "runsc",
        ]]
      ) {
        const { exitCode, resumed, stderr } = await resume(
          runState,
          "freebsd",
          { args },
        );

        expect([exitCode, resumed]).toEqual([1, false]);
        expect(stderr).toEqual([`${unknownRuntime("podman")}\n`]);
      }
    });

    for (
      const [born, platform, args] of [
        ["docker", "darwin", ["--sandbox-runtime", "docker"]],
        ["docker", "freebsd", []],
        ["runsc", "darwin", []],
        ["runsc", "linux", []],
      ] as const
    ) {
      it(`resumes a run started on \`${born}\` on ${platform} with ${args.length > 0 ? "the runtime named" : "no runtime named"}`, async () => {
        const { exitCode, resumed, stderr } = await resume(born, platform, {
          args,
        });

        expect([exitCode, resumed, stderr]).toEqual([0, true, []]);
      });
    }
  });

  describe("an interactive session", () => {
    /** A loop that answers a turn without running anything. */
    const answering: HarnessInteractivePromptLoopFactory = () => ({
      runPrompt: () => Promise.reject(new Error("a session runs transcripts")),
      runTranscript: (options) =>
        Promise.resolve({
          model: "gpt-5.4",
          finalAssistantText: "Done.",
          transcript: [
            ...options.transcript,
            { role: "assistant", content: "Done." },
          ],
          modelTurns: 1,
          runState: {
            runId: "turn-run",
            status: "completed",
            createdAt: "2026-10-05T12:00:00.000Z",
            updatedAt: "2026-10-05T12:00:01.000Z",
            cfcEnforcementMode: "observe",
            currentDir: "/workspace",
            policyEvents: [],
            toolOutputs: [],
          },
        }),
    });

    /** A service over the store at `url`, whose turns run on `runtime`. */
    const serviceOn = async (
      url: URL,
      runtime: SandboxRuntimeKind | SandboxRuntime,
    ) => {
      const sessionStore = await openSqliteHarnessChatSessionStore({ url });
      const service = new HarnessInteractiveChatService({
        sessionStore,
        basePromptLoopOptions: typeof runtime === "string"
          ? (runtime === "runsc" ? { sandboxRuntimeKind: "runsc" } : {})
          : { sandboxRuntime: runtime },
        createPromptLoop: answering,
      });
      await service.initializeFromStore();
      return { service, sessionStore };
    };

    /** Starts the session `chat` on `service`, and returns its status. */
    const startSession = async (
      service: HarnessInteractiveChatService,
    ): Promise<HarnessChatSessionStatus> => {
      const response = await service.startSession("start", {
        sessionId: "chat",
        workspace: { hostPath: workspace },
        model: "gpt-5.4",
      });
      if (!response.ok) throw new Error(response.error.message);
      return response.result;
    };

    /** Starts a turn of `chat` on `service`, and returns the response. */
    const startTurn = (service: HarnessInteractiveChatService) =>
      service.startTurn("turn", {
        sessionId: "chat",
        input: { text: "Continue." },
      });

    let url: URL;

    beforeEach(() => {
      url = toFileUrl(join(root, "chat.sqlite"));
    });

    for (
      const [born, restarted] of [
        ["docker", "runsc"],
        ["runsc", "docker"],
      ] as const
    ) {
      it(`records \`${born}\` as the runtime it started on, and refuses a turn once its host restarts on \`${restarted}\``, async () => {
        const first = await serviceOn(url, born);
        expect((await startSession(first.service)).sandboxRuntime).toBe(born);
        first.sessionStore.close();

        const second = await serviceOn(url, restarted);
        const response = await startTurn(second.service);
        second.sessionStore.close();

        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "provider-mismatch",
            message: `chat session \`chat\` started on the \`${born}\` ` +
              `sandbox runtime, and this host runs \`${restarted}\`. The ` +
              "two need not keep the CFC labels of a session's files where " +
              "the other reads them, and on macOS they do not, so a session " +
              "goes on only on the runtime it started on: restart the host " +
              "with " +
              `\`CF_HARNESS_SANDBOX_RUNTIME=${born}\`, or start a new ` +
              "session.",
          },
        });
      });

      it(`starts a turn of a session started on \`${born}\` once its host restarts on \`${born}\``, async () => {
        const first = await serviceOn(url, born);
        await startSession(first.service);
        first.sessionStore.close();

        const second = await serviceOn(url, born);
        const response = await startTurn(second.service);
        await second.service.waitForIdle();
        second.sessionStore.close();

        expect(response.ok).toBe(true);
      });
    }

    it("records the runtime a host was handed, rather than the one its options name", async () => {
      const { service, sessionStore } = await serviceOn(
        url,
        handedIn("runsc-cfc"),
      );

      const status = await startSession(service);
      sessionStore.close();

      expect(status.sandboxRuntime).toBe("runsc");
    });

    /**
     * Stores the session `chat` as a host that did not yet record a
     * session's runtime left it, with `changes` in its status.
     */
    const storedBeforeRecording = async (
      changes: Record<string, unknown> = {},
    ): Promise<void> => {
      const first = await serviceOn(url, "docker");
      const { sandboxRuntime: _, ...unrecorded } = await startSession(
        first.service,
      );
      // Through JSON, as the store reads a status another build wrote.
      const session: HarnessChatSessionStatus = JSON.parse(
        JSON.stringify({ ...unrecorded, ...changes }),
      );
      await first.sessionStore.saveSession({ session, transcript: [] });
      first.sessionStore.close();
    };

    for (
      const [first, other] of [
        ["docker", "runsc"],
        ["runsc", "docker"],
      ] as const
    ) {
      it(`binds a session stored before sessions recorded a runtime to \`${first}\`, where its next turn runs`, async () => {
        await storedBeforeRecording();

        const next = await serviceOn(url, first);
        const turn = await startTurn(next.service);
        await next.service.waitForIdle();
        const stored = await next.sessionStore.getSession("chat");
        next.sessionStore.close();
        const later = await serviceOn(url, other);
        const refused = await later.service.startTurn("turn-2", {
          sessionId: "chat",
          input: { text: "Continue." },
        });
        later.sessionStore.close();

        expect(turn.ok).toBe(true);
        expect(stored?.session.sandboxRuntime).toBe(first);
        expect(refused).toMatchObject({
          ok: false,
          error: {
            code: "provider-mismatch",
            message: expect.stringContaining(
              `chat session \`chat\` started on the \`${first}\` sandbox ` +
                `runtime, and this host runs \`${other}\`.`,
            ),
          },
        });
      });
    }

    it("leaves a session unbound whose turn it refuses", async () => {
      await storedBeforeRecording();
      const host = await serviceOn(url, "runsc");
      await host.service.closeSession("close", "chat");

      const refused = await startTurn(host.service);
      const held = host.service.status("chat").sessions.map((session) =>
        session.sandboxRuntime
      );
      const stored = await host.sessionStore.getSession("chat");
      host.sessionStore.close();

      expect(refused.ok).toBe(false);
      expect([held, stored?.session.sandboxRuntime]).toEqual([
        [undefined],
        undefined,
      ]);
    });

    it("refuses a turn of a session that records a runtime it does not know, on either runtime", async () => {
      await storedBeforeRecording({ sandboxRuntime: "podman" });

      for (const runtime of ["docker", "runsc"] as const) {
        const host = await serviceOn(url, runtime);
        const response = await startTurn(host.service);
        host.sessionStore.close();

        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "provider-mismatch",
            message:
              "chat session `chat` records that it started on the sandbox " +
              "runtime `podman`, which this cf-harness does not know, so it " +
              "cannot tell whether this host runs the same one. Start a new " +
              "session, or go on with this one on the cf-harness that " +
              "started it.",
          },
        });
      }
    });
  });
});
