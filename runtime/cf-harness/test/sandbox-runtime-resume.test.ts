/**
 * Checks that a run, and an interactive session, goes on only on the sandbox
 * runtime it started on. There is one, `runsc`; a record of a run or a
 * session that started on the Docker driver, which this cf-harness no longer
 * has, or on a runtime it does not know, is refused, since another runtime
 * need not read the CFC labels of its files where that one kept them. A run
 * records its runtime as its engine is built and a session as it starts; a
 * record written before either did is read by what it does hold, and bound
 * from its next use. Each case builds its runs over a process runner that
 * runs nothing, and a case that needs a native store makes one.
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

/**
 * What a resume says of a record of a run started on the Docker driver, which
 * records it as `recorded`: by its name, or by the kind of its description.
 */
const removed = (recorded: "docker" | "docker-runsc-cfc"): string =>
  "resume sandbox runtime removed: the run records that it started on the " +
  `Docker driver (\`${recorded}\`), which this cf-harness no longer has. A ` +
  "run resumes only on the runtime it started on, since another need not " +
  "read the CFC labels of the run's files where that one kept them. Start a " +
  "new run.";

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

  /** The engine options that put a run on `runsc`, built by the engine. */
  const onRunsc = () => ({
    model: "gpt-5.4",
    workspaceHostPath: workspace,
    cfcEnforcementMode: "observe" as const,
    processRunner: inertRunner,
    sandboxRuntimeKind: "runsc" as const,
    sandboxRunscBinary: join(store, "bin", "runsc"),
    sandboxRootfs: join(store, "images", "kitchensink"),
  });

  /** The state of a run that started on `runsc` and described it. */
  const startedOn = async (): Promise<HarnessRunState> => {
    const engine = new CfHarnessEngine({ ...onRunsc(), runId: "run-born" });
    const state = await engine.ensureDiagnosticsInitialized();
    expect(state.capabilitySnapshot?.cfc.sandbox.kind).toBe("runsc-cfc");
    return state;
  };

  /**
   * The state of a run built on `runsc` that never described it, as one whose
   * first probe of its sandbox failed is left.
   */
  const neverDescribed = (): HarnessRunState =>
    new CfHarnessEngine({ ...onRunsc(), runId: "run-born" }).getRunState();

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

  /**
   * `state` as a cf-harness with a Docker driver wrote it for a run that
   * started there: naming `docker` where it names a runtime, and describing
   * the Docker driver's kind where it describes one.
   */
  const onDocker = (state: HarnessRunState): Promise<HarnessRunState> =>
    asWritten(state, {
      ...(state.sandboxRuntime !== undefined
        ? { sandboxRuntime: "docker" }
        : {}),
      ...(state.capabilitySnapshot !== undefined
        ? {
          capabilitySnapshot: {
            ...state.capabilitySnapshot,
            cfc: {
              ...state.capabilitySnapshot.cfc,
              sandbox: {
                ...state.capabilitySnapshot.cfc.sandbox,
                kind: "docker-runsc-cfc",
              },
            },
          },
        }
        : {}),
    });

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
    it("returns `runsc` for its own name, and nothing for any other, `docker` among them", () => {
      expect(
        ["runsc", "docker", "RUNSC", " runsc", "", "podman"].map(
          sandboxRuntimeNamed,
        ),
      ).toEqual([
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
    it("returns the runtime an entrypoint names for the kind it describes itself as, and nothing for the Docker driver's", () => {
      expect(sandboxRuntimeOfKind("runsc-cfc")).toBe("runsc");
      expect(sandboxRuntimeOfKind("docker-runsc-cfc")).toBeUndefined();
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
          sandboxRuntime: "runsc",
          capabilitySnapshot: {
            cfc: { sandbox: { kind: "docker-runsc-cfc" } },
          },
        }),
      ).toBe("runsc");
    });

    it("returns the runtime of the kind a record describes, where it names none", () => {
      expect(
        recordedSandboxRuntime({
          capabilitySnapshot: { cfc: { sandbox: { kind: "runsc-cfc" } } },
        }),
      ).toBe("runsc");
    });

    it("returns nothing for a record that neither names a runtime nor describes one", () => {
      expect(recordedSandboxRuntime({})).toBeUndefined();
      expect(recordedSandboxRuntime({ capabilitySnapshot: {} }))
        .toBeUndefined();
      expect(recordedSandboxRuntime({ capabilitySnapshot: { cfc: {} } }))
        .toBeUndefined();
    });

    for (
      const [what, record, recorded] of [
        ["names it", { sandboxRuntime: "docker" }, "docker"],
        [
          "names it, whatever it describes",
          {
            sandboxRuntime: "docker",
            capabilitySnapshot: { cfc: { sandbox: { kind: "runsc-cfc" } } },
          },
          "docker",
        ],
        [
          "describes its kind",
          {
            capabilitySnapshot: {
              cfc: { sandbox: { kind: "docker-runsc-cfc" } },
            },
          },
          "docker-runsc-cfc",
        ],
      ] as const
    ) {
      it(`throws a resume refusal for a record of a run on the Docker driver that ${what}`, () => {
        const refusal = refusalOf(() => recordedSandboxRuntime(record));

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(refusal).toMatchObject({
          code: "provider-mismatch",
          message: removed(recorded),
        });
      });
    }

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
    it("returns `runsc`, for a runtime handed in and for the one an engine builds", () => {
      expect(sandboxRuntimeOfOptions({})).toBe("runsc");
      expect(
        sandboxRuntimeOfOptions({ sandboxRuntime: handedIn("runsc-cfc") }),
      ).toBe("runsc");
    });

    for (const kind of ["docker-runsc-cfc", "podman-cfc"]) {
      it(`throws for a runtime handed in that describes itself as \`${kind}\`, a kind it does not run`, () => {
        expect(() =>
          sandboxRuntimeOfOptions({
            sandboxRuntime: { describe: () => ({ kind }) },
          })
        ).toThrow(
          new Error(
            `the sandbox runtime handed in describes itself as \`${kind}\`, ` +
              "which is no kind of runtime this cf-harness runs",
          ),
        );
      });
    }
  });

  describe("an engine as it is built", () => {
    it("records the runtime it runs on in its run state, before it has probed anything", () => {
      expect(new CfHarnessEngine(onRunsc()).getRunState().sandboxRuntime)
        .toBe("runsc");
    });

    it("records the runtime it was handed", () => {
      const { sandboxRuntimeKind: _, ...unnamed } = onRunsc();

      expect(
        new CfHarnessEngine({
          ...unnamed,
          sandboxRuntime: handedIn("runsc-cfc"),
        }).getRunState().sandboxRuntime,
      ).toBe("runsc");
    });

    it("refuses to be built on a runtime handed in that describes itself as the Docker driver's", () => {
      expect(() =>
        new CfHarnessEngine({
          ...onRunsc(),
          sandboxRuntime: handedIn("docker-runsc-cfc"),
        })
      ).toThrow("describes itself as `docker-runsc-cfc`");
    });

    it("keeps the record through a first probe of the sandbox that fails", async () => {
      const failing: SandboxRuntime = {
        ...handedIn("runsc-cfc"),
        run: () => Promise.reject(new Error("the sandbox did not start")),
        runShell: () => Promise.reject(new Error("the sandbox did not start")),
      };
      const engine = new CfHarnessEngine({
        ...onRunsc(),
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
        ...onRunsc(),
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
        ...onRunsc(),
        sandboxRuntimeChoice: { runtime: "runsc", source: "environment" },
      }).getRunState();

      const resumed = new CfHarnessEngine({
        ...onRunsc(),
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
        onRunsc(),
      ).getRunState();

      expect(
        new CfHarnessEngine({
          ...onRunsc(),
          runState: older,
          sandboxRuntimeChoice: { runtime: "runsc", source: "flag" },
        }).getRunState().sandboxRuntimeChoice,
      ).toEqual({ runtime: "runsc", source: "flag" });
    });

    it("records no choice for an engine its caller built with none", () => {
      expect(new CfHarnessEngine(onRunsc()).getRunState()).not
        .toHaveProperty(
          "sandboxRuntimeChoice",
        );
    });
  });

  describe("an engine built to resume a run", () => {
    it("returns an engine for a run started and resumed on `runsc`", async () => {
      const runState = await startedOn();

      const engine = new CfHarnessEngine({ ...onRunsc(), runState });

      expect(sandboxRuntimeOfKind(engine.sandbox.describe().kind)).toBe(
        "runsc",
      );
    });

    it("throws for a run started on the Docker driver, naming the driver it no longer has", async () => {
      const runState = await onDocker(await startedOn());

      const refusal = refusalOf(() =>
        new CfHarnessEngine({ ...onRunsc(), runState })
      );

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(refusal).toMatchObject({
        code: "provider-mismatch",
        message: removed("docker"),
      });
    });

    it("throws for a run started on the Docker driver and resumed on a `runsc` runtime handed in", async () => {
      const runState = await onDocker(await startedOn());

      expect(() =>
        new CfHarnessEngine({
          ...onRunsc(),
          runState,
          sandboxRuntime: handedIn("runsc-cfc"),
        })
      ).toThrow(removed("docker"));
    });

    it("throws for a run started on the Docker driver whatever the resume selected, saying nothing of how it was selected", async () => {
      const runState = await onDocker(await startedOn());

      expect(() =>
        new CfHarnessEngine({
          ...onRunsc(),
          runState,
          sandboxRuntimeChoice: {
            runtime: "runsc",
            source: "default",
            platform: "darwin",
            nativeStore: store,
          },
        })
      ).toThrow(removed("docker"));
    });

    it("throws for a run built on the Docker driver that never described it", async () => {
      const runState = await onDocker(neverDescribed());
      expect(runState.capabilitySnapshot).toBeUndefined();

      const refusal = refusalOf(() =>
        new CfHarnessEngine({ ...onRunsc(), runState })
      );

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(refusal).toMatchObject({
        code: "provider-mismatch",
        message: removed("docker"),
      });
    });

    it("returns an engine for a run built on `runsc` that never described it, resumed on `runsc`", () => {
      const engine = new CfHarnessEngine({
        ...onRunsc(),
        runState: neverDescribed(),
      });

      expect(engine.getRunState().sandboxRuntime).toBe("runsc");
    });

    it("throws for a record written before runs recorded their runtime, by the Docker driver's kind it describes", async () => {
      const runState = await onDocker(beforeRecording(await startedOn()));

      const refusal = refusalOf(() =>
        new CfHarnessEngine({ ...onRunsc(), runState })
      );

      expect(refusal).toMatchObject({
        code: "provider-mismatch",
        message: removed("docker-runsc-cfc"),
      });
    });

    it("writes `runsc` into a record written before runs recorded their runtime, as it resumes it there", async () => {
      const runState = beforeRecording(await startedOn());

      const engine = new CfHarnessEngine({ ...onRunsc(), runState });

      expect(engine.getRunState().sandboxRuntime).toBe("runsc");
    });

    it("holds a resume to the runtime a record names, over the kind in its description", async () => {
      const described = await onDocker(beforeRecording(await startedOn()));

      expect(
        new CfHarnessEngine({
          ...onRunsc(),
          runState: { ...described, sandboxRuntime: "runsc" },
        }).getRunState().sandboxRuntime,
      ).toBe("runsc");
      const named = { ...await startedOn(), sandboxRuntime: "docker" as const };
      expect(
        refusalOf(() => new CfHarnessEngine({ ...onRunsc(), runState: named })),
      ).toMatchObject({ message: removed("docker") });
    });

    it("returns an engine for a record that neither names a runtime nor describes one, and binds it to `runsc`", async () => {
      const { capabilitySnapshot: _, capabilitiesPath: __, ...described } =
        await startedOn();
      const runState = beforeRecording(described);

      const engine = new CfHarnessEngine({ ...onRunsc(), runState });

      expect(sandboxRuntimeOfKind(engine.sandbox.describe().kind)).toBe(
        "runsc",
      );
      expect(engine.getRunState().sandboxRuntime).toBe("runsc");
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
      it(`throws for a record that ${what} it does not know`, async () => {
        const runState = await asWritten(await startedOn(), changes);

        const refusal = refusalOf(() =>
          new CfHarnessEngine({ ...onRunsc(), runState })
        );

        expect(refusal).toBeInstanceOf(HarnessControlError);
        expect(refusal).toMatchObject({
          code: "provider-mismatch",
          message: unknownRuntime(named),
        });
      });
    }
  });

  describe("the batch CLI resuming a run", () => {
    /**
     * Resumes a run through the CLI, as `platform`: one started on `runsc`
     * that described it, or the one whose state is given.
     */
    const resume = async (
      born: "runsc" | HarnessRunState,
      platform: SandboxPlatform,
      extra: {
        args?: readonly string[];
        env?: Record<string, string>;
        sandboxSelectionFlags?: boolean;
      } = {},
    ) => {
      const runState = born === "runsc" ? await startedOn() : born;
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
            name === "pasta" || name === "unshare" || name === "setpriv"
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
      const { exitCode, resumed, stderr } = await resume(
        await onDocker(await startedOn()),
        "darwin",
      );

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr).toEqual([`${removed("docker")}\n`]);
    });

    it("refuses a resume that names Docker, as it refuses any run that names it", async () => {
      const { exitCode, resumed, stderr } = await resume("runsc", "darwin", {
        args: ["--sandbox-runtime", "docker"],
      });

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr.join("")).toContain(
        "`--sandbox-runtime docker` names the Docker driver, which this " +
          "cf-harness no longer has",
      );
    });

    it("refuses a run started on Docker where Linux defaults the resume to the native runtime", async () => {
      const { exitCode, resumed, stderr } = await resume(
        await onDocker(await startedOn()),
        "linux",
      );

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr).toEqual([`${removed("docker")}\n`]);
    });

    it("refuses a resume of a run started on `runsc` where FreeBSD has no default", async () => {
      const { exitCode, resumed, stderr } = await resume("runsc", "freebsd");

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr.join("")).toContain(
        "No sandbox runtime is named, and `freebsd` has no default",
      );
    });

    it("refuses `docker` in the environment, naming the variable alone, for an embedder whose operator can pass no flag", async () => {
      const { exitCode, resumed, stderr } = await resume("runsc", "darwin", {
        env: { CF_HARNESS_SANDBOX_RUNTIME: "docker" },
        sandboxSelectionFlags: false,
      });

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr.join("")).toContain(
        "`CF_HARNESS_SANDBOX_RUNTIME=docker` names the Docker driver",
      );
      expect(stderr.join("")).toContain(
        "name `runsc` with `CF_HARNESS_SANDBOX_RUNTIME=runsc`.",
      );
      expect(stderr.join("")).not.toContain("--sandbox-runtime");
    });

    it("refuses a run built on Docker that never described it, where macOS defaults the resume to the native runtime", async () => {
      const { exitCode, resumed, stderr } = await resume(
        await onDocker(neverDescribed()),
        "darwin",
      );

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr).toEqual([`${removed("docker")}\n`]);
    });

    it("refuses a record written before runs recorded their runtime, by the runtime it describes", async () => {
      const { exitCode, resumed, stderr } = await resume(
        await onDocker(beforeRecording(await startedOn())),
        "darwin",
      );

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr).toEqual([`${removed("docker-runsc-cfc")}\n`]);
    });

    it("refuses a record that names a runtime it does not know, whatever the resume selects", async () => {
      const runState = await asWritten(await startedOn(), {
        sandboxRuntime: "podman",
      });

      for (const args of [[], ["--sandbox-runtime", "runsc"]]) {
        const { exitCode, resumed, stderr } = await resume(
          runState,
          "darwin",
          { args },
        );

        expect([exitCode, resumed]).toEqual([1, false]);
        expect(stderr).toEqual([`${unknownRuntime("podman")}\n`]);
      }
    });

    for (const platform of ["darwin", "linux"] as const) {
      it(`resumes a run started on \`runsc\` on ${platform} with no runtime named`, async () => {
        const { exitCode, resumed, stderr } = await resume("runsc", platform);

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
      runtime: "runsc" | SandboxRuntime,
    ) => {
      const sessionStore = await openSqliteHarnessChatSessionStore({ url });
      const service = new HarnessInteractiveChatService({
        sessionStore,
        basePromptLoopOptions: runtime === "runsc"
          ? { sandboxRuntimeKind: "runsc" }
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

    /**
     * Stores the session `chat` as a host that did not yet record a
     * session's runtime left it, with `changes` in its status.
     */
    const storedBeforeRecording = async (
      changes: Record<string, unknown> = {},
    ): Promise<void> => {
      const first = await serviceOn(url, "runsc");
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

    it("records `runsc` as the runtime it started on", async () => {
      const { service, sessionStore } = await serviceOn(url, "runsc");

      const status = await startSession(service);
      sessionStore.close();

      expect(status.sandboxRuntime).toBe("runsc");
    });

    it("starts a turn of a session started on `runsc` once its host restarts on `runsc`", async () => {
      const first = await serviceOn(url, "runsc");
      await startSession(first.service);
      first.sessionStore.close();

      const second = await serviceOn(url, "runsc");
      const response = await startTurn(second.service);
      await second.service.waitForIdle();
      second.sessionStore.close();

      expect(response.ok).toBe(true);
    });

    it("refuses a turn of a session that records it started on the Docker driver, which it no longer has, and leaves the record as it is", async () => {
      await storedBeforeRecording({ sandboxRuntime: "docker" });

      const host = await serviceOn(url, "runsc");
      const response = await startTurn(host.service);
      const stored = await host.sessionStore.getSession("chat");
      host.sessionStore.close();

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "provider-mismatch",
          message: "chat session `chat` started on the Docker driver " +
            "(`docker`), which this cf-harness no longer has, and a session " +
            "goes on only on the runtime it started on, since another need " +
            "not read the CFC labels of its files where that one kept them. " +
            "Start a new session.",
        },
      });
      expect(stored?.session.sandboxRuntime).toBe("docker");
    });

    it("records the runtime a host was handed", async () => {
      const { service, sessionStore } = await serviceOn(
        url,
        handedIn("runsc-cfc"),
      );

      const status = await startSession(service);
      sessionStore.close();

      expect(status.sandboxRuntime).toBe("runsc");
    });

    it("binds a session stored before sessions recorded a runtime to `runsc`, where its next turn runs", async () => {
      await storedBeforeRecording();

      const next = await serviceOn(url, "runsc");
      const turn = await startTurn(next.service);
      await next.service.waitForIdle();
      const stored = await next.sessionStore.getSession("chat");
      next.sessionStore.close();

      expect(turn.ok).toBe(true);
      expect(stored?.session.sandboxRuntime).toBe("runsc");
    });

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

    it("refuses a turn of a session that records a runtime it does not know", async () => {
      await storedBeforeRecording({ sandboxRuntime: "podman" });

      const host = await serviceOn(url, "runsc");
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
    });
  });
});
