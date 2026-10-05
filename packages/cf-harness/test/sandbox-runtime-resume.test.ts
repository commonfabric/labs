/**
 * Checks that a run, and an interactive session, goes on only on the sandbox
 * runtime it started on. The two runtimes need not keep the CFC labels of a
 * run's files where the other reads them, and on macOS they do not, so what
 * one labelled the other can read as unlabelled. Each case builds its runs
 * over a process runner that runs nothing, and a case that needs a native
 * store makes one.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";

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
  /** A directory of the case's own, with a workspace and a native store. */
  let root: string;
  let workspace: string;
  let store: string;

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

  describe("sandboxRuntimeOfKind()", () => {
    it("returns the runtime an entrypoint names for each kind a runtime describes itself as", () => {
      expect(sandboxRuntimeOfKind("docker-runsc-cfc")).toBe("docker");
      expect(sandboxRuntimeOfKind("runsc-cfc")).toBe("runsc");
    });
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

    it("returns an engine on either runtime for a run that recorded none", async () => {
      const { capabilitySnapshot: _, capabilitiesPath: __, ...runState } =
        await startedOn("docker");

      for (const runtime of ["docker", "runsc"] as const) {
        const engine = new CfHarnessEngine({ ...on(runtime), runState });

        expect(sandboxRuntimeOfKind(engine.sandbox.describe().kind)).toBe(
          runtime,
        );
      }
    });
  });

  describe("the batch CLI resuming a run", () => {
    /** Resumes a run started on `born` through the CLI, as `platform`. */
    const resume = async (
      born: SandboxRuntimeKind,
      platform: SandboxPlatform,
      extra: {
        args?: readonly string[];
        env?: Record<string, string>;
        sandboxSelectionFlags?: boolean;
      } = {},
    ) => {
      const runState = await startedOn(born);
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

    it("refuses a run started on `runsc` where Linux defaults the resume to Docker", async () => {
      const { exitCode, resumed, stderr } = await resume("runsc", "linux");

      expect([exitCode, resumed]).toEqual([1, false]);
      expect(stderr.join("")).toContain(
        "this resume selects `docker` (default on linux: the native runtime " +
          "is macOS only)",
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

    for (
      const [born, platform, args] of [
        ["docker", "darwin", ["--sandbox-runtime", "docker"]],
        ["docker", "linux", []],
        ["runsc", "darwin", []],
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

    it("starts a turn on either runtime for a stored session that recorded none", async () => {
      const first = await serviceOn(url, "docker");
      const { sandboxRuntime: _, ...unrecorded } = await startSession(
        first.service,
      );
      await first.sessionStore.saveSession({
        session: unrecorded,
        transcript: [],
      });
      first.sessionStore.close();

      const second = await serviceOn(url, "runsc");
      const response = await startTurn(second.service);
      await second.service.waitForIdle();
      second.sessionStore.close();

      expect(response.ok).toBe(true);
    });
  });
});
