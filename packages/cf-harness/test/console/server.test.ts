import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  consoleDataDirectories,
  consoleHealthRows,
  consoleHelpText,
  consoleSandboxBanner,
  ConsoleServer,
  consoleStartupBanner,
  consoleVmHealthProbes,
  createConsoleHealth,
  createConsoleInteractiveServiceOptions,
  parseConsoleArgs,
} from "../../console/server.ts";
import {
  resolveConsoleConfig,
  startConsoleServer,
} from "../support/on-linux.ts";
import { ConsoleHealth, type ConsoleHealthRow } from "../../console/health.ts";
import {
  harnessSessionChatPolicy,
  harnessSessionEngineOptions,
} from "../../src/session-assembly.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import { createHarnessRunState } from "../../src/run-state.ts";
import {
  bashToolDescriptor,
  bashToolDescriptorForRuntime,
} from "../../src/tools/bash.ts";
import type { ProcessRunner } from "../../src/sandbox/process-runner.ts";
import {
  darwinCfcVmRootfs,
  defaultDarwinCfcVmStore,
} from "../../src/sandbox/runsc.ts";
import type { ConsoleSessionListing } from "../../console/sessions.ts";
import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../../src/pattern-index/client.ts";
import {
  createHarnessHandleTable,
  mintReferentHandle,
} from "../../src/handle-table.ts";
import { MAX_HARNESS_PATTERN_REFS } from "../../src/pattern-refs.ts";
import {
  type HarnessInteractiveChatEventListener,
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../../src/interactive-chat-service.ts";
import { openSqliteHarnessChatSessionStore } from "../../src/sqlite-session-store.ts";
import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../../src/prompt-loop.ts";
import type {
  BrowserHostResult,
  HarnessBrowserHost,
} from "../../src/contracts/browser-host.ts";
import {
  createHarnessChatErrorResponse,
  createHarnessChatEventEnvelope,
  createHarnessChatOkResponse,
  type HarnessChatResponse,
  type HarnessChatStartTurnParams,
  type HarnessChatTurnStatus,
} from "../../src/contracts/interactive-chat.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import {
  HARNESS_SUPPORTED_CLIENT_FEATURES,
  harnessClientProtocolEcho,
} from "../../src/contracts/client-command.ts";

/**
 * A loop that answers the task it was given and nothing else. The console
 * server's routes are what these tests are about, so the turn behind them only
 * has to reach a terminal state.
 */
const answeringLoop: HarnessInteractivePromptLoopFactory = () => ({
  runTranscript: async (
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> => {
    const answer = { role: "assistant" as const, content: "built it" };
    const transcript = [...options.transcript, answer];
    await options.onTranscriptEvent?.({ message: answer, transcript });
    return {
      model: "gpt-test",
      finalAssistantText: answer.content,
      transcript,
      modelTurns: 1,
      runState: {} as HarnessPromptLoopResult["runState"],
    };
  },
});

/**
 * A loop that records the supplied completion in the run artifact directory.
 * This is the production ordering the console depends on: the prompt loop
 * persists its transcript before the service emits `turn_completed`.
 */
const artifactLoop = (
  messages: readonly HarnessTranscriptMessage[],
  onCompleted?: () => void,
): HarnessInteractivePromptLoopFactory =>
(loopOptions) => ({
  runTranscript: async (
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> => {
    if (
      loopOptions.artifactRoot === undefined || loopOptions.runId === undefined
    ) {
      throw new Error("artifact loop requires an artifact root and run id");
    }
    const transcript = [...options.transcript, ...messages];
    await writeTurnTranscript(
      loopOptions.artifactRoot,
      loopOptions.runId,
      transcript,
      options.transcript.length,
    );
    const finalAssistantText =
      transcript.findLast((message) => message.role === "assistant")?.content ??
        "";
    onCompleted?.();
    return {
      model: "gpt-test",
      finalAssistantText,
      transcript,
      modelTurns: 1,
      runState: {} as HarnessPromptLoopResult["runState"],
    };
  },
});

/**
 * A clock that advances a second per reading. Two turns started in the same
 * millisecond are ordered by turn id, which a real session's random ids make
 * arbitrary, so the tests that turn on which turn came first give the service
 * a clock that distinguishes them.
 */
const advancingClock = () => {
  let seconds = 0;
  return () => {
    seconds += 1;
    return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
  };
};

/** The identity the proxied index client signs with in these tests. */
const signer = await Identity.fromPassphrase("cf-harness console index proxy");

/** What the index answers for the pattern a task attaches by id. */
const INDEXED_PATTERN = {
  patternId: "pat-expenses",
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  description: "Totals an expense list",
  hashtags: ["expenses"],
  dependencies: [],
};

/** An entity id of the shape an input-cell reference has to carry. */
const CELL_ID = `of:fid1:${"A".repeat(43)}`;

const config = () =>
  resolveConsoleConfig(
    [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
    ],
    {},
    "/console",
  );

/** The same configuration, allowing a task to declare a browser host. */
const configWithBrowserHost = () =>
  resolveConsoleConfig(
    [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
      "--allow-browser-host",
    ],
    {},
    "/console",
  );

/** The same configuration, with an index for the proxy route to reach. */
const configWithIndex = () =>
  resolveConsoleConfig(
    [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
      "--pattern-index-url",
      "https://index.test/api",
    ],
    {},
    "/console",
  );

const jsonRequest = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`http://127.0.0.1:8100${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const getRequest = (
  path: string,
  headers: Record<string, string> = {},
): Request => new Request(`http://127.0.0.1:8100${path}`, { headers });

const writeTurnTranscript = async (
  artifactRoot: string,
  turnId: string,
  transcript: readonly HarnessTranscriptMessage[],
  firstGeneratedIndex = 0,
): Promise<void> => {
  const runRoot = join(artifactRoot, turnId);
  await Deno.mkdir(runRoot, { recursive: true });
  await Deno.writeTextFile(
    join(runRoot, "transcript.json"),
    JSON.stringify(transcript),
  );
  await Deno.writeTextFile(
    join(runRoot, "run-report.json"),
    JSON.stringify({
      finalAssistantText: transcript.slice(firstGeneratedIndex).findLast(
        (message) => message.role === "assistant",
      )?.content ?? "",
      timeline: transcript.map((message, transcriptIndex) => ({
        kind: "transcript_message",
        transcriptIndex,
        role: message.role,
        ...(transcriptIndex >= firstGeneratedIndex ? { modelTurn: 1 } : {}),
      })),
    }),
  );
};

describe("console/server", () => {
  let server: ConsoleServer;

  beforeEach(async () => {
    server = new ConsoleServer(
      await config(),
      (onEvent) =>
        new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: advancingClock(),
          onEvent,
        }),
    );
  });

  /** Starts a task and waits for the turn it started to finish. */
  const startTask = async (
    body: unknown,
  ): Promise<{ sessionId: string; turnId: string }> => {
    const response = await server.handle(
      jsonRequest("/api/task", body),
    );
    expect(response.status).toBe(200);
    const started = await response.json();
    await server.service.waitForTurn(started.sessionId, started.turnId);
    return started;
  };

  const listSessions = async (): Promise<ConsoleSessionListing> => {
    const response = await server.handle(
      getRequest("/api/sessions"),
    );
    expect(response.status).toBe(200);
    return await response.json();
  };

  /** A started turn that keeps running until `finish()` is called. */
  interface HeldTurn {
    server: ConsoleServer;
    sessionId: string;
    turnId: string;

    /** Lets the turn's model loop return, and waits for the turn to end. */
    finish(): Promise<void>;
  }

  /**
   * Starts a task on a server of its own whose model loop does not return
   * until the test says so, so the turn is still running when the test acts
   * on it.
   */
  const startHeldTurn = async (): Promise<HeldTurn> => {
    const gate = Promise.withResolvers<void>();
    const held = new ConsoleServer(
      await config(),
      (onEvent) =>
        new HarnessInteractiveChatService({
          createPromptLoop: () => ({
            runTranscript: async (options) => {
              await gate.promise;
              return await answeringLoop({} as never).runTranscript(options);
            },
          }),
          now: advancingClock(),
          onEvent,
        }),
    );
    const response = await held.handle(
      jsonRequest("/api/task", { text: "keep working" }),
    );
    expect(response.status).toBe(200);
    const { sessionId, turnId } = await response.json();
    return {
      server: held,
      sessionId,
      turnId,
      finish: async () => {
        gate.resolve();
        await held.service.waitForTurn(sessionId, turnId);
      },
    };
  };

  /** What the index client was asked for, as it composed the request. */
  interface IndexRequest {
    url: string;
    body: string;
  }

  /**
   * A second server, configured with an index, whose client answers from
   * `responses` rather than from a deployment. The client is handed in because
   * the real one reads a keyfile off disk to sign with; what the routes are
   * about is which requests reach it and which are refused before they do.
   */
  const indexServer = async (
    responses: readonly Response[],
    artifactRoot?: string,
  ): Promise<
    { server: ConsoleServer; requests: IndexRequest[] }
  > => {
    const requests: IndexRequest[] = [];
    let answered = 0;
    const fetchFn: HarnessFetch = (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      const response = responses[answered] ?? Response.json({});
      answered += 1;
      return Promise.resolve(response);
    };
    const indexed = new ConsoleServer(
      {
        ...await configWithIndex(),
        ...(artifactRoot !== undefined ? { artifactRoot } : {}),
      },
      (onEvent) =>
        new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: advancingClock(),
          onEvent,
        }),
      () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test/api",
            fetchFn,
            signer,
          }),
        ),
    );
    return { server: indexed, requests };
  };

  /** Reads one live completed event backed by its durable run transcript. */
  const liveTurnResult = async (
    messages: readonly HarnessTranscriptMessage[],
  ): Promise<unknown> => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-event-",
    });
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const resultConfig = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--artifact-root",
          artifactRoot,
        ],
        {},
        "/console",
      );
      const resultServer = new ConsoleServer(
        resultConfig,
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: { artifactRoot },
            createPromptLoop: artifactLoop(messages, () => clock += 1750),
            now: () => new Date(clock).toISOString(),
            onEvent,
            runIdForTurn: (_sessionId, turnId) => turnId,
          }),
      );
      const page = await resultServer.handle(getRequest("/"));
      await page.body?.cancel();
      const response = await resultServer.handle(getRequest(
        "/api/events?afterSequence=0",
        {},
      ));
      const startedResponse = await resultServer.handle(
        jsonRequest("/api/task", { text: "track my books" }, {}),
      );
      expect(startedResponse.status).toBe(200);
      return (await envelopesUntil(response, "turn_completed")).at(-1)!.event
        .result;
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  };

  describe("console prompt configuration", () => {
    it("threads configured skills.sh discovery into the run and policy", async () => {
      const resolved = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--skills-registry-url",
          "https://registry.example",
        ],
        {},
        "/console",
      );
      const serviceOptions = createConsoleInteractiveServiceOptions(
        resolved,
        {
          modelProvider: "openai-compatible-gateway",
          modelAuthSource: "none",
          gatewayAuthMode: "none",
        },
        () => {},
      );

      expect(resolved.skillsSh).toEqual({
        baseUrl: "https://registry.example",
      });
      expect(serviceOptions.basePromptLoopOptions?.skillsSh).toEqual({
        baseUrl: "https://registry.example",
      });
      expect(serviceOptions.runIdForTurn?.("session-1", "turn-1")).toBe(
        "turn-1",
      );
      // A registry and a fabric session back both skill tools, so a session
      // configured for one offers acquisition as well as discovery.
      const policy = harnessSessionChatPolicy(resolved);
      expect(policy.allowedToolIds).toContain("search_skills");
      expect(policy.allowedToolIds).toContain("acquire_skill");
    });

    it("runs skill scripts when the console was launched with the switch", async () => {
      const named = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--allow-skill-scripts",
        ],
        {},
        "/console",
      );
      expect(named.allowSkillScripts).toBe(true);

      const inherited = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_ALLOW_SKILL_SCRIPTS: "1" },
        "/console",
      );
      expect(inherited.allowSkillScripts).toBe(true);
    });

    it("runs no skill script when the console was launched without it", async () => {
      expect((await config()).allowSkillScripts).toBe(false);
    });

    it("offers `run_skill_script` when a registry backs it and the switch is on", async () => {
      // Backing alone never offers this tool — it appears only in the withheld
      // set — so without this the switch would reach an acquired child through
      // its own surface and never reach the run holding the registry, and the
      // registry half of one decision would be undeliverable.
      const withSwitch = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--skills-root",
          "/workspace/skills",
          "--allow-skill-scripts",
        ],
        {},
        "/console",
      );
      const withNeither = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--skills-root",
          "/workspace/skills",
        ],
        {},
        "/console",
      );

      expect(harnessSessionChatPolicy(withSwitch).allowedToolIds).toContain(
        "run_skill_script",
      );
      expect(harnessSessionChatPolicy(withNeither).allowedToolIds).not
        .toContain("run_skill_script");
    });

    it("withholds the skill tools from a session with no registry", async () => {
      const policy = harnessSessionChatPolicy(await config());
      expect(policy.allowedToolIds).not.toContain("search_skills");
      expect(policy.allowedToolIds).not.toContain("acquire_skill");
    });

    it("reads the skills.sh discovery registry from the environment", async () => {
      const resolved = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_SKILLS_REGISTRY_URL: "https://registry.example" },
        "/console",
      );

      expect(resolved.skillsSh).toEqual({
        baseUrl: "https://registry.example",
      });
    });

    it("rejects a skills.sh discovery registry that is not a URL", async () => {
      await expect(
        resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--skills-registry-url",
            "not a url",
          ],
          {},
          "/console",
        ),
      ).rejects.toThrow("--skills-registry-url must be a valid URL");
    });

    it("reads the named prompt and disables child composition guidance", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "cf-harness-console-prompt-",
      });
      try {
        await Deno.writeTextFile(
          join(directory, "system.txt"),
          "COMPOSE FIRST\n",
        );
        const resolved = await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--system-prompt-file",
            "system.txt",
            "--no-child-composition-guidance",
          ],
          {},
          directory,
        );

        expect(resolved.systemPrompt).toBe("COMPOSE FIRST\n");
        expect(resolved.subagentCompositionGuidance).toBe(false);
        const serviceOptions = createConsoleInteractiveServiceOptions(
          resolved,
          {
            modelProvider: "openai-compatible-gateway",
            modelAuthSource: "none",
            gatewayAuthMode: "none",
          },
          () => {},
        );
        expect(serviceOptions.systemPrompt).toBe("COMPOSE FIRST\n");
        expect(
          serviceOptions.basePromptLoopOptions?.subagentCompositionGuidance,
        ).toBe(false);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("rejects a prompt file that cannot be read", async () => {
      await expect(
        resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--system-prompt-file",
            "missing.txt",
          ],
          {},
          "/console-prompt-test",
        ),
      ).rejects.toThrow(
        "--system-prompt-file could not be read: /console-prompt-test/missing.txt",
      );
    });

    it("rejects a prompt file containing only whitespace", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "cf-harness-console-prompt-",
      });
      try {
        const promptPath = join(directory, "empty.txt");
        await Deno.writeTextFile(promptPath, " \n\t");

        await expect(
          resolveConsoleConfig(
            [
              "--fabric-identity",
              "key.pkcs8",
              "--fabric-space",
              "console-test",
              "--session-db",
              "none",
              "--system-prompt-file",
              promptPath,
            ],
            {},
            directory,
          ),
        ).rejects.toThrow(`--system-prompt-file is empty: ${promptPath}`);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  });

  describe("the sandbox runtime", () => {
    /** The selection Loom hands a console on the native runtime. */
    const RUNSC_ENV = {
      CF_HARNESS_SANDBOX_RUNTIME: "runsc",
      CF_HARNESS_SANDBOX_ROOTFS: "/store/images/kitchensink",
      CF_HARNESS_RUNSC_BINARY: "/store/bin/runsc",
      CF_HARNESS_RUNSC_CFC_POLICY: "/store/policy.json",
    };

    const ARGS = [
      "--fabric-identity",
      "key.pkcs8",
      "--fabric-space",
      "console-test",
      "--session-db",
      "none",
    ];

    /** A runner that runs nothing: these tests read what a turn would build. */
    const inertRunner: ProcessRunner = {
      run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    };

    /**
     * The sandbox a turn of this console runs in, built by the engine from
     * the options the console hands every turn.
     */
    const turnSandbox = async (env: Record<string, string>) => {
      const resolved = await resolveConsoleConfig(ARGS, env, "/console");
      const { basePromptLoopOptions } = createConsoleInteractiveServiceOptions(
        resolved,
        {
          modelProvider: "openai-compatible-gateway",
          modelAuthSource: "none",
          gatewayAuthMode: "none",
        },
        () => {},
      );
      const engine = new CfHarnessEngine({
        ...basePromptLoopOptions,
        runId: "console-turn",
        processRunner: inertRunner,
      });
      return {
        description: engine.sandbox.describe(),
        run: {
          cfcEnforcementMode: engine.getRunState().cfcEnforcementMode,
        },
      };
    };

    it("builds the direct runsc driver from the runtime the environment selects", async () => {
      const { description, run } = await turnSandbox(RUNSC_ENV);

      expect(description.kind).toBe("runsc-cfc");
      expect(description.sessions).toBe(true);
      expect(description.cfc?.image).toBe("/store/images/kitchensink");
      expect(description.cfc?.runtimeName).toBeUndefined();
      expect(description.cfc?.invocationContextTransport).toBe("fd");
      // A console turn enforces, and no enforcing run can use a session, so
      // the model is offered bash without one, as it is on Docker.
      expect(run.cfcEnforcementMode).toBe("enforce-strict");
      expect(bashToolDescriptorForRuntime(description, run)).toEqual(
        bashToolDescriptor,
      );
    });

    for (
      const [name, env] of [
        ["names no runtime", {}],
        ["names `docker`", { CF_HARNESS_SANDBOX_RUNTIME: "docker" }],
      ] as const
    ) {
      it(`builds the Docker driver, with its sidecar transports, when the environment ${name}`, async () => {
        const { description, run } = await turnSandbox(env);

        expect(description).toEqual({
          kind: "docker-runsc-cfc",
          defaultWorkingDirectory: "/workspace",
          cfc: {
            runtimeRequested: true,
            runtimeName: "runsc-cfc",
            image:
              "us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest",
            workspaceMountPath: "/workspace",
            mounts: [{
              kind: "workspace",
              hostPath: "/console/.cf-harness-console/workspace",
              sandboxPath: "/workspace",
              readOnly: false,
            }],
            networkMode: "bridge",
            extraDockerArgsCount: 0,
            invocationContextTransport: "sidecar",
            invocationContextTransportReadiness: "unverified",
            invocationContextConfiguredPath:
              "/console/.cf-harness-console/cfc/invocation-context",
          },
        });
        expect(bashToolDescriptorForRuntime(description, run)).toEqual(
          bashToolDescriptor,
        );
      });
    }

    it("sites the Docker driver's sidecar directories only for a console on Docker", async () => {
      const docker = await resolveConsoleConfig(ARGS, {}, "/console");
      const runsc = await resolveConsoleConfig(ARGS, RUNSC_ENV, "/console");

      expect([docker.cfcResultDir, docker.cfcInvocationContextDir]).toEqual([
        "/console/.cf-harness-console/cfc/results",
        "/console/.cf-harness-console/cfc/invocation-context",
      ]);
      expect([runsc.cfcResultDir, runsc.cfcInvocationContextDir]).toEqual([
        undefined,
        undefined,
      ]);
    });

    it("throws the shared derivation's refusal for a runtime it does not know", async () => {
      await expect(
        resolveConsoleConfig(
          ARGS,
          { CF_HARNESS_SANDBOX_RUNTIME: "podman" },
          "/console",
        ),
      ).rejects.toThrow("sandbox runtime must be one of docker, runsc");
    });

    for (
      const [flag, variable] of [
        ["--sandbox-runtime", "CF_HARNESS_SANDBOX_RUNTIME"],
        ["--sandbox-rootfs", "CF_HARNESS_SANDBOX_ROOTFS"],
        ["--sandbox-cfc-policy", "CF_HARNESS_RUNSC_CFC_POLICY"],
      ] as const
    ) {
      it(`throws naming \`${variable}\` for the batch CLI's \`${flag}\` in every spelling`, async () => {
        for (
          const spelling of [
            [flag, "runsc"],
            [`${flag}=runsc`],
            [`${flag}=`],
            [flag],
            [flag, "runsc", flag, "docker"],
          ]
        ) {
          await expect(
            resolveConsoleConfig([...ARGS, ...spelling], {}, "/console"),
          ).rejects.toThrow(variable);
        }
      });
    }

    it("resolves relative sandbox paths against the console's working directory", async () => {
      const config = await resolveConsoleConfig(ARGS, {
        CF_HARNESS_SANDBOX_RUNTIME: "runsc",
        CF_HARNESS_SANDBOX_ROOTFS: "images/kitchensink",
        CF_HARNESS_RUNSC_CFC_POLICY: "policy/cfc.json",
      }, "/console");

      expect([config.sandboxRootfs, config.sandboxCfcPolicy]).toEqual([
        "/console/images/kitchensink",
        "/console/policy/cfc.json",
      ]);
    });

    it("observes the driver's own default rootfs for a runsc console that names none", async () => {
      // On macOS the driver finds the rootfs in the store under the `HOME` of
      // the environment the console runs in, where no `CFC_VM_HOME` names
      // another; on any other platform a rootfs must be named, and the turn
      // is refused. `/Users/console` has no link on the way, as macOS's
      // `/home` does, so its spelling is the path the driver resolves.
      const [, runtime, rootfs] = await (async () => {
        const health = createConsoleHealth(
          await resolveConsoleConfig(ARGS, {
            CF_HARNESS_SANDBOX_RUNTIME: "runsc",
            CF_HARNESS_RUNSC_BINARY: "/store/bin/runsc",
            CF_HARNESS_RUNSC_CFC_POLICY: "/store/policy.json",
          }, "/console"),
          undefined,
          undefined,
          { HOME: "/Users/console" },
          undefined,
          () => Promise.reject(new Error("Docker is not asked")),
        );
        await health.refresh();
        return health.snapshot().rows.filter((row) =>
          row.id.startsWith("sandbox.")
        );
      })();

      if (Deno.build.os === "darwin") {
        const expected = darwinCfcVmRootfs(
          defaultDarwinCfcVmStore("/Users/console"),
        );
        expect(rootfs.detail).toBe(expected);
        expect(runtime.detail).toContain(`rootfs ${expected}`);
      } else {
        expect(runtime).toMatchObject({
          state: "failed",
          value: "configuration refused",
        });
        expect(runtime.reason).toContain("needs a rootfs");
      }
    });

    it("observes the runsc configuration refused for a CFC policy inside a writable host mount", async () => {
      const dir = await Deno.makeTempDir({ prefix: "console-mount-" });
      try {
        const health = createConsoleHealth(
          await resolveConsoleConfig([
            ...ARGS,
            "--host-mount",
            `name=shared,source=${dir},target=/mnt/shared,mode=writable`,
          ], {
            CF_HARNESS_SANDBOX_RUNTIME: "runsc",
            CF_HARNESS_SANDBOX_ROOTFS: "/store/images/kitchensink",
            CF_HARNESS_RUNSC_BINARY: "/store/bin/runsc",
            CF_HARNESS_RUNSC_CFC_POLICY: join(dir, "policy.json"),
          }, "/console"),
          undefined,
          undefined,
          {},
          undefined,
          () => Promise.reject(new Error("Docker is not asked")),
        );
        await health.refresh();
        const runtime = health.snapshot().rows.find((row) =>
          row.id === "sandbox.runtime"
        );

        expect(runtime).toMatchObject({
          state: "failed",
          value: "configuration refused",
        });
        expect(runtime?.reason).toContain("writable mount");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("observes the runsc configuration, and asks Docker nothing, for a console on the runsc runtime", async () => {
      let dockerReads = 0;
      const health = createConsoleHealth(
        await resolveConsoleConfig(ARGS, RUNSC_ENV, "/console"),
        undefined,
        undefined,
        {},
        undefined,
        () => {
          dockerReads += 1;
          return Promise.resolve({ runtimes: { "runsc-cfc": {} } });
        },
      );

      await health.refresh();

      expect(dockerReads).toBe(0);
      expect(
        health.snapshot().rows.filter((row) => row.group === "sandbox").map((
          { id, state, value },
        ) => ({ id, state, value })),
      ).toEqual([
        { id: "config.sandbox", state: "ok", value: "runsc" },
        { id: "sandbox.runsc", state: "failed", value: "missing" },
        { id: "sandbox.runtime", state: "failed", value: "CFC policy missing" },
        { id: "sandbox.rootfs", state: "failed", value: "missing" },
      ]);
    });

    it("adds the VM row for a console on the runsc runtime exactly where the store is a macOS one", async () => {
      const store = await Deno.makeTempDir({ prefix: "cf-vm-store-" });
      try {
        await Deno.writeTextFile(join(store, "config.json"), "{}");
        const health = createConsoleHealth(
          await resolveConsoleConfig(ARGS, {
            ...RUNSC_ENV,
            CF_HARNESS_SANDBOX_ROOTFS: join(store, "images", "kitchensink"),
          }, "/console"),
          undefined,
          undefined,
          { CFC_VM_HOME: store },
          undefined,
          () => Promise.reject(new Error("Docker is not asked")),
        );

        await health.refresh();

        const vm = health.snapshot().rows.find((row) =>
          row.id === "sandbox.vm"
        );
        if (Deno.build.os === "darwin") {
          expect(vm).toMatchObject({
            group: "sandbox",
            state: "ok",
            value: "idle; starts on first use",
          });
        } else {
          expect(vm).toBeUndefined();
        }
      } finally {
        await Deno.remove(store, { recursive: true });
      }
    });

    it("adds no VM row for a console on Docker, whatever store the environment names", async () => {
      // Settings a runsc console would resolve, so that only the runtime kind
      // stands between this console and a VM row.
      const store = await Deno.makeTempDir({ prefix: "cf-vm-store-" });
      try {
        await Deno.writeTextFile(join(store, "config.json"), "{}");
        const runsc = await resolveConsoleConfig(ARGS, {
          ...RUNSC_ENV,
          CF_HARNESS_SANDBOX_ROOTFS: join(store, "images", "kitchensink"),
        }, "/console");
        const health = createConsoleHealth(
          { ...runsc, sandboxRuntimeKind: "docker" },
          undefined,
          undefined,
          { CFC_VM_HOME: store },
          undefined,
          () => Promise.resolve({ runtimes: { "runsc-cfc": {} } }),
        );

        await health.refresh();

        expect(health.snapshot().rows.map((row) => row.id)).not.toContain(
          "sandbox.vm",
        );
      } finally {
        await Deno.remove(store, { recursive: true });
      }
    });

    /**
     * Runs `body` with the process's `CFC_VM_HOME` naming `store`, which is
     * where a console built without an environment finds its VM, and restores
     * the variable after.
     */
    const withProcessVmHome = async <T>(
      store: string,
      body: () => Promise<T>,
    ): Promise<T> => {
      const previous = Deno.env.get("CFC_VM_HOME");
      Deno.env.set("CFC_VM_HOME", store);
      try {
        return await body();
      } finally {
        if (previous === undefined) Deno.env.delete("CFC_VM_HOME");
        else Deno.env.set("CFC_VM_HOME", previous);
      }
    };

    it("adds the VM row from the process's environment for a console built without one", async () => {
      // runsc runs with the console process's environment, so that is where
      // a console handed no environment looks for the store runsc uses.
      const store = await Deno.makeTempDir({ prefix: "cf-vm-store-" });
      try {
        await Deno.writeTextFile(join(store, "config.json"), "{}");
        const configured = await resolveConsoleConfig(ARGS, {
          ...RUNSC_ENV,
          CF_HARNESS_SANDBOX_ROOTFS: join(store, "images", "kitchensink"),
        }, "/console");

        const vm = await withProcessVmHome(store, async () => {
          const response = await new ConsoleServer(
            configured,
            () => server.service,
          ).handle(getRequest("/api/health/detail"));
          const { rows } = await response.json() as {
            rows: readonly ConsoleHealthRow[];
          };
          return rows.find((row) => row.id === "sandbox.vm");
        });

        if (Deno.build.os === "darwin") {
          expect(vm).toMatchObject({
            label: "Sandbox VM",
            value: "not checked",
            detail: join(store, "daemon.sock"),
          });
        } else {
          expect(vm).toBeUndefined();
        }
      } finally {
        await Deno.remove(store, { recursive: true });
      }
    });

    describe("consoleVmHealthProbes()", () => {
      /** A macOS store holding `config.json`, removed after `body`. */
      const withStore = async (body: (store: string) => Promise<void>) => {
        const store = await Deno.makeTempDir({ prefix: "cf-vm-store-" });
        try {
          await Deno.writeTextFile(join(store, "config.json"), "{}");
          await body(store);
        } finally {
          await Deno.remove(store, { recursive: true });
        }
      };

      /** A runsc console whose rootfs names an image of `store`. */
      const runscConsole = (store: string) =>
        resolveConsoleConfig(ARGS, {
          ...RUNSC_ENV,
          CF_HARNESS_SANDBOX_ROOTFS: join(store, "images", "kitchensink"),
        }, "/console");

      it("returns the VM probe for a runsc console on macOS whose store holds a `config.json`", async () => {
        await withStore(async (store) => {
          const probes = consoleVmHealthProbes(
            await runscConsole(store),
            { CFC_VM_HOME: store },
            { platform: "darwin" },
          );

          expect(probes.map((probe) => probe.id)).toEqual(["sandbox.vm"]);
        });
      });

      it("returns no VM probe for a console on Docker, on macOS or not", async () => {
        await withStore(async (store) => {
          const onDocker = {
            ...await runscConsole(store),
            sandboxRuntimeKind: "docker" as const,
          };

          expect(
            consoleVmHealthProbes(onDocker, { CFC_VM_HOME: store }, {
              platform: "darwin",
            }),
          ).toEqual([]);
        });
      });

      it("returns no VM probe off macOS", async () => {
        await withStore(async (store) => {
          expect(
            consoleVmHealthProbes(
              await runscConsole(store),
              { CFC_VM_HOME: store },
              { platform: "linux" },
            ),
          ).toEqual([]);
        });
      });
    });

    /** The runsc selection with no CFC policy named, and none under `HOME`. */
    const RUNSC_NO_POLICY_ENV = {
      CF_HARNESS_SANDBOX_RUNTIME: "runsc",
      CF_HARNESS_SANDBOX_ROOTFS: "/store/images/kitchensink",
      CF_HARNESS_RUNSC_BINARY: "/store/bin/runsc",
    };

    /** The sandbox runtime row a console's health settles on. */
    const runtimeRow = async (
      config: Awaited<ReturnType<typeof resolveConsoleConfig>>,
    ) => {
      const health = createConsoleHealth(
        config,
        undefined,
        undefined,
        {},
        undefined,
        () => Promise.reject(new Error("Docker is not asked")),
      );
      await health.refresh();
      return health.snapshot().rows.find((row) => row.id === "sandbox.runtime");
    };

    it("reports a runsc console with no CFC policy as failed, since its enforcing turns are refused", async () => {
      const config = await resolveConsoleConfig(
        ARGS,
        RUNSC_NO_POLICY_ENV,
        "/console",
      );

      const row = await runtimeRow(config);

      expect(config.sandboxCfcPolicy).toBeUndefined();
      expect(row).toMatchObject({
        state: "failed",
        value: "no CFC policy, so every turn is refused",
      });
      expect(row?.reason).toContain("enforce-strict");
      expect(row?.remedy).toContain("CF_HARNESS_RUNSC_CFC_POLICY");
    });

    it("reports a runsc console with no CFC policy as degraded when its turns only observe", async () => {
      const config = await resolveConsoleConfig(
        ARGS,
        RUNSC_NO_POLICY_ENV,
        "/console",
      );

      const row = await runtimeRow({
        ...config,
        cfcEnforcementModeOverride: "observe",
      });

      expect(row).toMatchObject({
        state: "degraded",
        value: "direct runsc driver, no CFC policy",
      });
      expect(row?.reason).toContain("untracked");
    });

    it("observes the Docker runtime table for a console on Docker", async () => {
      let dockerReads = 0;
      const health = createConsoleHealth(
        await resolveConsoleConfig(ARGS, {}, "/console"),
        undefined,
        undefined,
        {},
        undefined,
        () => {
          dockerReads += 1;
          return Promise.resolve({ runtimes: { "runsc-cfc": {} } });
        },
      );

      await health.refresh();

      expect(dockerReads).toBe(1);
      expect(
        health.snapshot().rows.filter((row) => row.group === "sandbox").map((
          { id, state, value },
        ) => ({ id, state, value })),
      ).toEqual([
        { id: "config.sandbox", state: "ok", value: "docker" },
        { id: "sandbox.docker", state: "ok", value: "responding" },
        {
          id: "sandbox.runtime",
          state: "ok",
          value: "runsc-cfc registered",
        },
      ]);
    });

    it("returns the driver and its sidecar directories as its banner for a console on Docker", async () => {
      expect(
        consoleSandboxBanner(await resolveConsoleConfig(ARGS, {}, "/console")),
      ).toEqual([
        "  sandbox:    docker; default on linux: the native runtime is macOS only",
        "  results:    /console/.cf-harness-console/cfc/results",
        "  contexts:   /console/.cf-harness-console/cfc/invocation-context",
      ]);
    });

    it("returns a banner saying every turn is refused for a runsc console with no CFC policy", async () => {
      const config = await resolveConsoleConfig(
        ARGS,
        RUNSC_NO_POLICY_ENV,
        "/console",
      );

      expect(consoleSandboxBanner(config).at(-1)).toBe(
        "  policy:     (none: every turn is refused at enforce-strict)",
      );
      // Read off the mode, so a console whose turns only observe says so.
      expect(
        consoleSandboxBanner({
          ...config,
          cfcEnforcementModeOverride: "observe",
        }).at(-1),
      ).toBe("  policy:     (none: runsc runs without --cfc)");
    });

    it("returns the runsc binary, rootfs and policy as its banner for a console on the runsc runtime", async () => {
      expect(
        consoleSandboxBanner(
          await resolveConsoleConfig(ARGS, RUNSC_ENV, "/console"),
        ),
      ).toEqual([
        "  sandbox:    runsc, the direct driver (no Docker); named by CF_HARNESS_SANDBOX_RUNTIME",
        "  runsc:      /store/bin/runsc",
        "  rootfs:     /store/images/kitchensink",
        "  policy:     /store/policy.json",
      ]);
    });

    it("returns the sidecar directories among those created only for a console on Docker", async () => {
      // Strict: `toEqual` would pass a list carrying an `undefined` entry.
      expect(
        consoleDataDirectories(
          await resolveConsoleConfig(ARGS, {}, "/console"),
        ),
      ).toStrictEqual([
        "/console/.cf-harness-console/workspace",
        "/console/.cf-harness-console/runs",
        "/console/.cf-harness-console/cfc/results",
        "/console/.cf-harness-console/cfc/invocation-context",
      ]);
      expect(
        consoleDataDirectories(
          await resolveConsoleConfig(ARGS, RUNSC_ENV, "/console"),
        ),
      ).toStrictEqual([
        "/console/.cf-harness-console/workspace",
        "/console/.cf-harness-console/runs",
      ]);
    });

    it("returns a startup banner naming the sidecar directories for a console on Docker", async () => {
      const banner = consoleStartupBanner(
        await resolveConsoleConfig(
          [
            ...ARGS,
            "--pattern-index-url",
            "https://index.test/api",
            "--skills-registry-url",
            "https://skills.test",
          ],
          {},
          "/console",
        ),
      );

      expect(banner.slice(0, 5)).toEqual([
        "\n  cf-harness console: http://127.0.0.1:8100",
        "  space:      console-test",
        "  fabric:     http://localhost:8000",
        "  index:      https://index.test/api",
        "  skills:     https://skills.test",
      ]);
      expect(banner.slice(-5)).toEqual([
        "  results:    /console/.cf-harness-console/cfc/results",
        "  contexts:   /console/.cf-harness-console/cfc/invocation-context",
        "  workspace:  /console/.cf-harness-console/workspace",
        "  artifacts:  /console/.cf-harness-console/runs",
        "  agent runs: /console/.cf-harness/agent-runs\n",
      ]);
    });

    it("returns a startup banner naming the runsc driver, and no sidecar directory, for a console on the runsc runtime", async () => {
      const banner = consoleStartupBanner(
        await resolveConsoleConfig(ARGS, RUNSC_ENV, "/console"),
      );

      expect(banner.slice(3, 5)).toEqual([
        "  index:      (not configured)",
        "  skills:     (not configured)",
      ]);
      expect(banner.slice(-7)).toEqual([
        "  sandbox:    runsc, the direct driver (no Docker); named by CF_HARNESS_SANDBOX_RUNTIME",
        "  runsc:      /store/bin/runsc",
        "  rootfs:     /store/images/kitchensink",
        "  policy:     /store/policy.json",
        "  workspace:  /console/.cf-harness-console/workspace",
        "  artifacts:  /console/.cf-harness-console/runs",
        "  agent runs: /console/.cf-harness/agent-runs\n",
      ]);
      expect(banner.some((line) => line.startsWith("  results:"))).toBe(false);
    });

    it("reads the agent runner's runs from CF_HARNESS_HOME unless told another root, or none", async () => {
      const agentRunsRoot = async (
        args: readonly string[],
        env: Record<string, string>,
      ) =>
        (await resolveConsoleConfig([...ARGS, ...args], env, "/console"))
          .agentRunsRoot;
      expect(await agentRunsRoot([], { HOME: "/home/a" })).toBe(
        "/home/a/.cf-harness/agent-runs",
      );
      expect(await agentRunsRoot([], { CF_HARNESS_HOME: "/harness" })).toBe(
        "/harness/agent-runs",
      );
      expect(
        await agentRunsRoot([], {
          CF_HARNESS_CONSOLE_AGENT_RUNS_ROOT: "runs-elsewhere",
        }),
      ).toBe("/console/runs-elsewhere");
      expect(
        await agentRunsRoot(["--agent-runs-root", "/flag"], {
          CF_HARNESS_CONSOLE_AGENT_RUNS_ROOT: "/env",
        }),
      ).toBe("/flag");
      expect(await agentRunsRoot(["--agent-runs-root", "none"], {}))
        .toBeUndefined();
    });

    it("reports the runsc runtime's rows, and no Docker row, for a console on the runsc runtime", async () => {
      // The process's environment names a store without a `config.json`, so
      // that this host's own VM adds no row.
      const store = await Deno.makeTempDir({ prefix: "cf-vm-store-" });
      const rows = await withProcessVmHome(store, async () => {
        const runscServer = new ConsoleServer(
          await resolveConsoleConfig(ARGS, RUNSC_ENV, "/console"),
          () => server.service,
        );

        const response = await runscServer.handle(
          getRequest("/api/health/detail"),
        );
        return (await response.json() as {
          rows: readonly ConsoleHealthRow[];
        }).rows;
      }).finally(() => Deno.remove(store, { recursive: true }));

      expect(
        rows.filter((row) => row.group === "sandbox").map((
          { id, label, value },
        ) => ({ id, label, value })),
      ).toEqual([
        { id: "config.sandbox", label: "Sandbox", value: "runsc" },
        { id: "sandbox.runsc", label: "Runsc Binary", value: "not checked" },
        {
          id: "sandbox.runtime",
          label: "Sandbox Runtime",
          value: "not checked",
        },
        {
          id: "sandbox.rootfs",
          label: "Sandbox Rootfs",
          value: "not checked",
        },
      ]);
    });
  });

  describe("the module", () => {
    // `deno run` can credit unexecuted top-level code from V8's code cache.
    // The program cases disable it so their coverage measures the entry
    // block they execute.

    it("prints help and exits successfully when run as a program", async () => {
      const repoRoot = resolve(import.meta.dirname!, "..", "..", "..", "..");
      const output = await runDenoCommandWithTemporaryLock({
        root: repoRoot,
        args: (lock) => [
          "run",
          "--no-code-cache",
          `--lock=${lock}`,
          "--allow-env",
          "packages/cf-harness/console/server.ts",
          "--help",
        ],
      });

      expect(output.code).toBe(0);
      expect(new TextDecoder().decode(output.stdout)).toBe(
        consoleHelpText(["--help"]) + "\n",
      );
      expect(output.stderr.length).toBe(0);
    });

    it("prints the startup error without a stack and exits 1 when a flag has no value", async () => {
      const repoRoot = resolve(import.meta.dirname!, "..", "..", "..", "..");
      const output = await runDenoCommandWithTemporaryLock({
        root: repoRoot,
        args: (lock) => [
          "run",
          "--no-code-cache",
          `--lock=${lock}`,
          "--allow-env",
          "packages/cf-harness/console/server.ts",
          "--port",
        ],
      });

      expect(output.code).toBe(1);
      expect(new TextDecoder().decode(output.stderr)).toBe(
        "`--port` was given no value\n",
      );
      expect(output.stdout.length).toBe(0);
    });

    it("loads on a host with no FFI permission", async () => {
      // The console promises a machine without the SQLite native library can
      // serve its page: a run reads its space through that library only as
      // it ends, and only when it holds a cell to ask about. So evaluating
      // this module must not open that library.
      const repoRoot = resolve(import.meta.dirname!, "..", "..", "..", "..");
      const wrapperDir = await Deno.makeTempDir({
        prefix: "cf-harness-console-import-",
      });
      try {
        const wrapper = join(wrapperDir, "import-console-server.ts");
        await Deno.writeTextFile(
          wrapper,
          `import ${
            JSON.stringify(
              toFileUrl(join(repoRoot, "packages/cf-harness/console/server.ts"))
                .href,
            )
          };\n`,
        );
        const output = await runDenoCommandWithTemporaryLock({
          root: repoRoot,
          args: (lock) => [
            "run",
            `--lock=${lock}`,
            // The entry sits outside the workspace, so it names the config
            // rather than finding one beside itself.
            `--config=${join(repoRoot, "deno.jsonc")}`,
            "--allow-env",
            wrapper,
          ],
        });
        if (!output.success) {
          console.error(new TextDecoder().decode(output.stderr));
        }
        expect(output.code).toBe(0);
      } finally {
        await Deno.remove(wrapperDir, { recursive: true });
      }
    });
  });

  describe("GET /api/sessions", () => {
    it("answers with no sessions before a task is started", async () => {
      expect(await listSessions()).toEqual({ sessions: [] });
    });

    it("describes a started session by the task it was given", async () => {
      const started = await startTask({ text: "track my books" });

      const listing = await listSessions();
      expect(listing.sessions).toHaveLength(1);
      expect(listing.sessions[0]).toMatchObject({
        sessionId: started.sessionId,
        status: "idle",
        reusable: true,
        turnCount: 1,
        firstTaskText: "track my books",
      });
    });

    it("orders the most recently touched session first", async () => {
      const first = await startTask({ text: "first task" });
      const second = await startTask({ text: "second task" });

      const listing = await listSessions();
      expect(listing.sessions.map((entry) => entry.sessionId)).toEqual([
        second.sessionId,
        first.sessionId,
      ]);
    });
  });

  describe("GET /api/status", () => {
    it("answers with the configured artifact root before a task is started", async () => {
      const response = await server.handle(
        getRequest("/api/status"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        artifactRoot: (await config()).artifactRoot,
        protocol: harnessClientProtocolEcho(HARNESS_SUPPORTED_CLIENT_FEATURES),
        sessions: [],
      });
    });
  });

  describe("GET /api/policy", () => {
    it("returns what a session started here would run under, before any session exists", async () => {
      const response = await server.handle(
        getRequest("/api/policy"),
      );

      expect(response.status).toBe(200);
      const resolved = await config();
      const policy = harnessSessionChatPolicy(resolved);
      expect(await response.json()).toEqual({
        systemPromptSha256: null,
        allowedToolIds: [...policy.allowedToolIds],
        allowedSubagentProfiles: [...policy.allowedSubagentProfiles],
        fabricSpace: resolved.fabricSession.space,
        artifactRoot: resolved.artifactRoot,
        sessionDbPath: null,
      });
    });
  });

  describe("GET /api/health", () => {
    it("reports the configured Fabric API and unverified session liveness without a token", async () => {
      const response = await server.handle(getRequest("/api/health"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        fabricApiUrl: (await config()).fabricSession.apiUrl,
        fabricSession: "unverified",
      });
    });

    it("answers 403 when the request names another host", async () => {
      const response = await server.handle(
        getRequest("/api/health", { host: "evil.test:8100" }),
      );

      expect(response.status).toBe(403);
    });

    it("answers 403 to a browser's navigation and to another site's page, and 200 to the console's own page and to a client that is no browser", async () => {
      const requests: Record<string, string>[] = [
        { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
        { "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" },
        { "sec-fetch-mode": "no-cors", "sec-fetch-site": "same-site" },
        { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" },
        {},
      ];
      const statuses = [];
      for (const headers of requests) {
        statuses.push(
          (await server.handle(getRequest("/api/health", headers))).status,
        );
      }

      expect(statuses).toEqual([403, 403, 403, 200, 200]);
    });
  });

  describe("GET /api/health/detail", () => {
    it("returns the cached snapshot while a host probe remains pending and applies the existing host restriction", async () => {
      const pending = Promise.withResolvers<readonly ConsoleHealthRow[]>();
      const fact = {
        id: "index.reachable",
        group: "index",
        label: "Index",
        value: "not checked",
        source: "host probe",
      };
      const health = new ConsoleHealth([], [{
        id: fact.id,
        initial: [fact],
        read: () => pending.promise,
        unavailable: () => [],
      }]);
      const healthServer = new ConsoleServer(
        await config(),
        () => server.service,
        undefined,
        health,
      );
      try {
        const response = await healthServer.handle(
          getRequest("/api/health/detail"),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          version: 1,
          rows: [{ ...fact, state: "unknown", checkedAt: null }],
        });
        expect(
          (await healthServer.handle(
            getRequest("/api/health/detail", { host: "evil.test:8100" }),
          )).status,
        ).toBe(403);
        expect(server.service.turns()).toHaveLength(0);
      } finally {
        pending.resolve([]);
        await health.refresh();
      }
    });
  });

  describe("consoleHealthRows()", () => {
    it("keeps shared classes on distinct named stores from the launch environment", async () => {
      const connectorGrants = ["drive", "readwise"].map((connection) => ({
        name: connection,
        cfcClass: "document",
        ref: `/${CELL_ID}`,
        source: { connection, piece: "resources" },
      }));
      const configured = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_CONNECTOR_GRANTS: JSON.stringify(connectorGrants) },
        "/console",
      );
      expect(configured.connectorGrants).toEqual(connectorGrants);
      expect(
        consoleHealthRows(configured).filter((row) =>
          row.id.startsWith("connector.granted.")
        ).map(({ id, value }) => ({ id, value })),
      )
        .toEqual([
          { id: "connector.granted.drive", value: "granted: drive (document)" },
          {
            id: "connector.granted.readwise",
            value: "granted: readwise (document)",
          },
        ]);
    });

    it("keeps index URL credentials out of the configured value and retained launch evidence", async () => {
      const indexUrl =
        "https://user-secret:password-secret@index.test/api/?token=query-secret#fragment-secret";
      const configured = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_PATTERN_INDEX_URL: indexUrl },
        "/console",
      );
      const rows = consoleHealthRows(configured, {
        checkedAt: "2026-09-17T00:00:00.000Z",
        connectors: [],
        resolved: [{ name: "index", value: indexUrl, source: "launch flag" }],
      });
      expect(rows.find((row) => row.id === "config.index")).toMatchObject({
        value: "https://index.test/api/",
        source: "console launch record",
        detail: "launch flag",
      });
      expect(JSON.stringify(rows)).not.toContain("-secret");
      expect(configured.patternIndex?.baseUrl).toBe(indexUrl);
    });

    it("retains the launch record only for inherited active values, including an equal explicit override", async () => {
      const configured = await resolveConsoleConfig([
        "--fabric-identity",
        "key.pkcs8",
        "--fabric-space",
        "console-test",
        "--port",
        "8123",
        "--session-db",
        "none",
      ], {
        MEMORY_DIR: "/data/selected",
        CF_HARNESS_MODEL: "test-model",
        CF_HARNESS_ALLOW_SKILL_SCRIPTS: "1",
      }, "/console");
      const checkedAt = "2026-09-17T00:00:00.000Z";
      const connector = {
        id: "connector.refused.0",
        group: "connectors",
        label: "gmail",
        value: "not granted",
        source: "loom connector receipt + pieces.json (gmail)",
        detail: "/loom/handles.json; /loom/pieces.json",
        state: "degraded" as const,
        reason: "Class already claimed.",
        remedy: "Select a connection.",
      };
      const rows = consoleHealthRows(configured, {
        checkedAt,
        connectors: [connector],
        resolved: [
          { name: "port", value: "8123", source: "launch record" },
          {
            name: "store",
            value: "/data/selected",
            source: "loom toolshed-store-dir",
          },
          { name: "model", value: "other-model", source: "launch record" },
        ],
      });
      expect(rows.find((row) => row.id === "config.port")).toMatchObject({
        label: "Port",
        value: "8123",
        source: "console launch flag",
        detail: "--port",
      });
      expect(rows.find((row) => row.id === "config.store")).toMatchObject({
        value: "/data/selected",
        source: "console launch record",
        detail: "loom toolshed-store-dir",
        checkedAt,
      });
      expect(rows.find((row) => row.id === "config.model")).toMatchObject({
        value: "test-model",
        source: "console configuration",
        detail: "CF_HARNESS_MODEL",
      });
      expect(rows.find((row) => row.id === "config.skill-scripts"))
        .toMatchObject({
          label: "Skill Scripts",
          value: "run in the sandbox",
          source: "console configuration",
          detail: "CF_HARNESS_ALLOW_SKILL_SCRIPTS",
        });
      expect(rows.find((row) => row.id === connector.id)).toEqual({
        ...connector,
        checkedAt,
      });
      expect(
        rows.filter((row) => row.state !== "unknown").every((row) =>
          Number.isFinite(Date.parse(row.checkedAt!))
        ),
      ).toBe(true);
    });

    it("defaults new tasks and the health display to `gpt-6.1-sol`", async () => {
      const configured = await config();
      expect(harnessSessionEngineOptions(configured).model).toBe("gpt-6.1-sol");
      expect(
        consoleHealthRows(configured).find((row) => row.id === "config.model"),
      )
        .toMatchObject({ value: "gpt-6.1-sol" });
    });

    it("sends every turn the reasoning effort the environment names, and reports where it came from", async () => {
      const configured = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        { CF_HARNESS_REASONING_EFFORT: "low" },
        "/console",
      );
      expect(harnessSessionEngineOptions(configured).reasoningEffort).toBe(
        "low",
      );
      expect(
        consoleHealthRows(configured).find((row) =>
          row.id === "config.reasoning-effort"
        ),
      ).toMatchObject({
        label: "Reasoning Effort",
        value: "low",
        detail: "CF_HARNESS_REASONING_EFFORT",
      });
    });

    it("leaves the reasoning effort to the provider when nothing names one", async () => {
      const configured = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
        ],
        {},
        "/console",
      );
      expect(harnessSessionEngineOptions(configured)).not.toHaveProperty(
        "reasoningEffort",
      );
      expect(
        consoleHealthRows(configured).find((row) =>
          row.id === "config.reasoning-effort"
        ),
      ).toMatchObject({
        value: "provider default",
        detail: "provider default",
      });
    });

    it("takes the reasoning effort the flag names over the environment's", async () => {
      const configured = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "key.pkcs8",
          "--fabric-space",
          "console-test",
          "--session-db",
          "none",
          "--reasoning-effort",
          "high",
        ],
        { CF_HARNESS_REASONING_EFFORT: "low" },
        "/console",
      );
      expect(harnessSessionEngineOptions(configured).reasoningEffort).toBe(
        "high",
      );
      expect(
        consoleHealthRows(configured).find((row) =>
          row.id === "config.reasoning-effort"
        ),
      ).toMatchObject({ value: "high", detail: "--reasoning-effort" });
    });

    it("keeps missing inventory, automatic store discovery and unobserved credentials unknown", async () => {
      const rows = consoleHealthRows(await config());
      expect(rows.find((row) => row.id === "connectors.inventory"))
        .toMatchObject({
          state: "unknown",
          value: "0 explicit grants configured",
        });
      expect(rows.find((row) => row.id === "config.store")).toMatchObject({
        state: "unknown",
        value: "automatic discovery",
      });
      expect(rows.find((row) => row.id === "model.auth")).toMatchObject({
        state: "unknown",
        checkedAt: null,
      });
      expect(rows.find((row) => row.id === "config.index")).toMatchObject({
        state: "degraded",
        value: "not configured",
      });
      expect(
        rows.filter((row) => row.id.startsWith("index.")).map((row) =>
          row.state
        ),
      ).toEqual(["unknown", "unknown"]);
    });

    for (const mode of ["missing", "key", "none", "codex"] as const) {
      it(`reports ${mode} credential provenance without publishing a credential`, async () => {
        const options: CreateHarnessPromptLoopOptions = mode === "codex"
          ? {
            modelProvider: "openai-codex",
            modelAuthSource: "cf-harness-local-store",
          }
          : {
            modelProvider: "openai-compatible-gateway",
            gatewayAuthMode: mode === "none" ? "none" : "bearer",
            ...(mode === "key" ? { apiKey: "secret-test-value" } : {}),
          };
        const rows = consoleHealthRows(await config(), undefined, options, {
          CF_HARNESS_API_KEY: mode === "key" ? "secret-test-value" : undefined,
        });
        expect(rows.find((row) => row.id === "model.auth")).toMatchObject({
          label: "Model Authentication",
          state: mode === "missing" ? "failed" : "ok",
          source: mode === "codex"
            ? "harness credential store"
            : "console environment",
          detail: mode === "codex"
            ? "/console/.cf-harness/auth.json"
            : mode === "none"
            ? "CF_HARNESS_GATEWAY_AUTH_MODE"
            : mode === "key"
            ? "CF_HARNESS_API_KEY"
            : "CF_HARNESS_API_KEY / OPENAI_API_KEY",
        });
        expect(JSON.stringify(rows)).not.toContain("secret-test-value");
      });
    }
  });

  describe("task Loom context", () => {
    it("rejects malformed Loom targets before starting a turn", async () => {
      for (const loomId of ["../private", {}, "loom-not-valid"]) {
        const response = await server.handle(
          jsonRequest("/api/task", { text: "Make a Loom", loomId }),
        );
        expect(response.status).toBe(400);
      }
      expect(server.service.turns()).toHaveLength(0);
    });

    it("persists the submitted origin even when the next turn names another Loom", async () => {
      const first = await startTask({
        text: "First",
        loomId: "loom-1111111111111111",
      });
      await startTask({
        text: "Second",
        sessionId: first.sessionId,
        loomId: "loom-2222222222222222",
      });
      expect(
        server.service.turns(first.sessionId).map((entry) =>
          entry.input.loomId
        ),
      ).toEqual(["loom-1111111111111111", "loom-2222222222222222"]);
    });
  });

  describe("GET /api/turns/<turnId>/result", () => {
    it("returns named errors for malformed and unknown turn paths", async () => {
      const malformedRoute = await server.handle(getRequest(
        "/api/turns/not-a-result",
        {},
      ));
      expect(malformedRoute.status).toBe(404);

      const malformedEncoding = await server.handle(getRequest(
        "/api/turns/%/result",
        {},
      ));
      expect(malformedEncoding.status).toBe(404);

      const unknownTurn = await server.handle(getRequest(
        "/api/turns/turn-nobody-started/result",
        {},
      ));
      expect(unknownTurn.status).toBe(404);
      expect(await unknownTurn.json()).toEqual({
        code: "turn_not_found",
        error: "turn turn-nobody-started was not found",
      });
    });

    it("returns a named error when completed-turn artifacts are unavailable", async () => {
      const started = await startTask({ text: "track my books" });

      const response = await server.handle(getRequest(
        `/api/turns/${started.turnId}/result`,
        {},
      ));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: "turn_result_unavailable",
        error: `result for turn ${started.turnId} is unavailable`,
      });
    });

    it("returns the durable result of a completed turn", async () => {
      const artifactRoot = await Deno.makeTempDir({
        prefix: "cf-harness-console-result-route-",
      });
      let clock = Date.parse("2026-01-01T00:00:00.000Z");
      try {
        const resultConfig = await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--artifact-root",
            artifactRoot,
          ],
          {},
          "/console",
        );
        const resultServer = new ConsoleServer(
          resultConfig,
          (onEvent) =>
            new HarnessInteractiveChatService({
              createPromptLoop: (options) => ({
                runTranscript: async (runOptions) => {
                  const result = await answeringLoop(options).runTranscript(
                    runOptions,
                  );
                  clock += 1750;
                  return result;
                },
              }),
              now: () => new Date(clock).toISOString(),
              onEvent,
            }),
        );
        const page = await resultServer.handle(getRequest("/"));
        await page.body?.cancel();
        const startedResponse = await resultServer.handle(
          jsonRequest("/api/task", {
            text: "track my books",
            loomId: "loom-1111111111111111",
          }, {}),
        );
        const started = await startedResponse.json();
        await resultServer.service.waitForTurn(
          started.sessionId,
          started.turnId,
        );
        await writeTurnTranscript(artifactRoot, started.turnId, [
          {
            role: "tool",
            toolCallId: "call-1",
            toolName: "assign_slug",
            content: JSON.stringify({
              outputId: "run:assign_slug:1",
              status: "ok",
              slug: "reading-list",
              url: "http://localhost:8000/console-test/reading-list",
            }),
          },
          { role: "assistant", content: "built it" },
        ]);

        const response = await resultServer.handle(getRequest(
          `/api/turns/${started.turnId}/result`,
          {},
        ));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          originLoomId: "loom-1111111111111111",
          looms: [],
          pieces: [{
            slug: "reading-list",
            url: "http://localhost:8000/console-test/reading-list",
          }],
          spaceName: "console-test",
          outcome: "completed",
          sessionId: started.sessionId,
          continuable: true,
          finalText: "built it",
          elapsedMs: 1750,
        });
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("returns a completed turn after its session is restored", async () => {
      const artifactRoot = await Deno.makeTempDir({
        prefix: "cf-harness-console-result-restored-",
      });
      let clock = Date.parse("2026-01-01T00:00:00.000Z");
      const store = await openSqliteHarnessChatSessionStore({
        url: toFileUrl(join(artifactRoot, "sessions.sqlite")),
      });
      try {
        const resultConfig = await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--artifact-root",
            artifactRoot,
          ],
          {},
          "/console",
        );
        const createService = (onEvent: HarnessInteractiveChatEventListener) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: { artifactRoot },
            createPromptLoop: artifactLoop([
              { role: "assistant", content: "restored result" },
            ], () => clock += 2750),
            now: () => new Date(clock).toISOString(),
            onEvent,
            runIdForTurn: (_sessionId, turnId) => turnId,
            sessionStore: store,
          });
        const firstServer = new ConsoleServer(
          resultConfig,
          createService,
        );
        const firstPage = await firstServer.handle(getRequest("/"));
        await firstPage.body?.cancel();
        const startedResponse = await firstServer.handle(
          jsonRequest("/api/task", { text: "persist this turn" }, {}),
        );
        const started = await startedResponse.json();
        await firstServer.service.waitForTurn(
          started.sessionId,
          started.turnId,
        );

        const restoredServer = new ConsoleServer(
          resultConfig,
          createService,
        );
        clock += 10_000;
        await restoredServer.service.initializeFromStore();
        const restoredPage = await restoredServer.handle(getRequest("/"));
        await restoredPage.body?.cancel();

        const response = await restoredServer.handle(getRequest(
          `/api/turns/${started.turnId}/result`,
          {},
        ));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          looms: [],
          pieces: [],
          spaceName: "console-test",
          outcome: "completed",
          sessionId: started.sessionId,
          continuable: true,
          finalText: "restored result",
          elapsedMs: 2750,
        });
      } finally {
        store.close();
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("returns a named error for a turn that has not completed", async () => {
      let finish: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const waitingServer = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: () => ({
              runTranscript: async (options) => {
                await gate;
                return await answeringLoop({} as never).runTranscript(options);
              },
            }),
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await waitingServer.handle(getRequest("/"));
      await page.body?.cancel();
      const startedResponse = await waitingServer.handle(
        jsonRequest("/api/task", { text: "keep working" }, {}),
      );
      const started = await startedResponse.json();
      try {
        const response = await waitingServer.handle(getRequest(
          `/api/turns/${started.turnId}/result`,
          {},
        ));

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          code: "turn_not_completed",
          error: `turn ${started.turnId} has not completed`,
        });
      } finally {
        finish!();
        await waitingServer.service.waitForTurn(
          started.sessionId,
          started.turnId,
        );
      }
    });

    it("answers 410 `turn_failed` with the turn's error for a turn that failed", async () => {
      // A failed turn will never have a result, so a poller is told to stop
      // rather than to ask again.
      const failingServer = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: () => ({
              runTranscript: () =>
                Promise.reject(new Error("model stream returned an error")),
            }),
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await failingServer.handle(getRequest("/"));
      await page.body?.cancel();
      const startedResponse = await failingServer.handle(
        jsonRequest("/api/task", { text: "build it" }, {}),
      );
      const started = await startedResponse.json();
      await failingServer.service.waitForTurn(
        started.sessionId,
        started.turnId,
      );

      const response = await failingServer.handle(getRequest(
        `/api/turns/${started.turnId}/result`,
        {},
      ));

      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        code: "turn_failed",
        error: `turn ${started.turnId} failed`,
        detail: {
          code: "internal_error",
          message: "model stream returned an error",
        },
      });
    });

    it("answers 410 `turn_canceled` for a turn that was canceled", async () => {
      const held = await startHeldTurn();
      const canceled = await held.server.handle(
        jsonRequest("/api/cancel", {
          sessionId: held.sessionId,
          reason: "stopped by the test",
        }),
      );
      expect(canceled.status).toBe(200);
      await held.finish();

      const response = await held.server.handle(getRequest(
        `/api/turns/${held.turnId}/result`,
      ));

      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        code: "turn_canceled",
        error: `turn ${held.turnId} was canceled`,
        detail: "stopped by the test",
      });
    });
  });

  describe("POST /api/cancel", () => {
    /** What the turn's result route gives as the reason it was canceled. */
    const cancelReason = async (held: HeldTurn): Promise<unknown> => {
      await held.finish();
      const response = await held.server.handle(getRequest(
        `/api/turns/${held.turnId}/result`,
      ));
      expect(response.status).toBe(410);
      return (await response.json()).detail;
    };

    it("records the reason the caller gives for the cancel", async () => {
      const held = await startHeldTurn();

      const canceled = await held.server.handle(
        jsonRequest("/api/cancel", {
          sessionId: held.sessionId,
          turnId: held.turnId,
          reason: "stopped from the Weaver pill",
        }),
      );

      expect(canceled.status).toBe(200);
      expect(await cancelReason(held)).toBe("stopped from the Weaver pill");
    });

    it("records only the route for a cancel that gives no reason", async () => {
      const held = await startHeldTurn();

      const canceled = await held.server.handle(
        jsonRequest("/api/cancel", { sessionId: held.sessionId }),
      );

      expect(canceled.status).toBe(200);
      expect(await cancelReason(held)).toBe(
        "canceled by a request to the console",
      );
    });

    it("refuses a turn id that is not a string, and leaves the turn running", async () => {
      const held = await startHeldTurn();

      for (const turnId of [7, null]) {
        const refused = await held.server.handle(
          jsonRequest("/api/cancel", { sessionId: held.sessionId, turnId }),
        );
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({
          error: "turnId, when given, must be a string",
        });
      }
      const canceled = await held.server.handle(
        jsonRequest("/api/cancel", {
          sessionId: held.sessionId,
          turnId: held.turnId,
          reason: "stopped by the test",
        }),
      );

      expect(canceled.status).toBe(200);
      expect(await cancelReason(held)).toBe("stopped by the test");
    });

    it("refuses a reason that is not a non-empty string, and leaves the turn running", async () => {
      const held = await startHeldTurn();

      for (const reason of [42, "", "  ", null]) {
        const refused = await held.server.handle(
          jsonRequest("/api/cancel", { sessionId: held.sessionId, reason }),
        );
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({
          error: "reason, when given, must be a non-empty string",
        });
      }
      const canceled = await held.server.handle(
        jsonRequest("/api/cancel", {
          sessionId: held.sessionId,
          reason: "stopped by the test",
        }),
      );

      expect(canceled.status).toBe(200);
      expect(await cancelReason(held)).toBe("stopped by the test");
    });
  });

  describe("POST /api/client-actions", () => {
    it("returns 400 for malformed JSON before starting or settling a turn", async () => {
      const response = await server.handle(
        new Request("http://127.0.0.1:8100/api/client-actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "request body is not JSON",
      });
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    const loomId = "loom-0123456789abcdef";

    /**
     * A server whose model loop asks the client to open a loom through the
     * door the service hands it, then waits for that answer.
     */
    const askingServer = async (
      actions: readonly unknown[] = [{ kind: "open_loom", loomId }],
    ) => {
      const asked = Promise.withResolvers<{
        outcomes: Promise<readonly Record<string, unknown>[]>;
      }>();
      const options: Record<string, unknown>[] = [];
      let ids = 0;
      const server = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            randomUUID: () => `id-${++ids}`,
            createPromptLoop: (loopOptions) => {
              options.push(loopOptions as unknown as Record<string, unknown>);
              return {
                runTranscript: async (run) => {
                  const request = (loopOptions as {
                    requestClientActions?: (
                      actions: readonly unknown[],
                      signal?: AbortSignal,
                    ) => Promise<readonly Record<string, unknown>[]>;
                  }).requestClientActions;
                  if (request !== undefined) {
                    const outcomes = request(actions, run.signal);
                    asked.resolve({ outcomes });
                    await outcomes;
                  }
                  return await answeringLoop({} as never).runTranscript(run);
                },
              };
            },
            now: advancingClock(),
            onEvent,
          }),
      );
      /** The id the service minted for the one action this loop asked for. */
      const actionId = (sessionId: string): string =>
        server.service.events(sessionId).map((e) => e.event).find((e) =>
          e.kind === "client_action_requested"
        )!.actionId;
      return { server, asked, options, actionId };
    };

    it("settles a pending action through the service and answers 200", async () => {
      const { server, asked, actionId } = await askingServer();
      const started = await (await server.handle(
        jsonRequest("/api/task", { text: "open it", clientActions: true }),
      )).json();
      const { outcomes } = await asked.promise;

      const response = await server.handle(jsonRequest("/api/client-actions", {
        sessionId: started.sessionId,
        actionId: actionId(started.sessionId),
        outcome: "done",
        result: "opened",
      }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(await outcomes).toEqual([
        {
          action: { kind: "open_loom", loomId },
          outcome: "done",
          result: "opened",
        },
      ]);
      const events = server.service.events(started.sessionId).map((e) =>
        e.event
      );
      expect(events.filter((e) => e.kind === "client_action_requested"))
        .toHaveLength(1);
      expect(events.filter((e) => e.kind === "client_action_resolved"))
        .toHaveLength(1);
      await server.service.waitForTurn(started.sessionId, started.turnId);
    });

    it("answers 404 for an unknown action, 409 for a settled one, and 400 for a bad body", async () => {
      const { server, asked, actionId } = await askingServer();
      const started = await (await server.handle(
        jsonRequest("/api/task", { text: "open it", clientActions: true }),
      )).json();
      await asked.promise;
      const answer = (body: unknown) =>
        server.handle(jsonRequest("/api/client-actions", body));

      const unknown = await answer({
        sessionId: started.sessionId,
        actionId: "missing",
        outcome: "done",
      });
      expect(unknown.status).toBe(404);
      expect((await unknown.json()).error.code).toBe("unknown_action");

      expect(
        (await answer({
          sessionId: started.sessionId,
          actionId: actionId(started.sessionId),
          outcome: "declined",
        })).status,
      ).toBe(200);
      const again = await answer({
        sessionId: started.sessionId,
        actionId: actionId(started.sessionId),
        outcome: "done",
      });
      expect(again.status).toBe(409);
      expect((await again.json()).error.code).toBe("action_resolved");

      for (
        const body of [
          {},
          { sessionId: started.sessionId },
          {
            sessionId: started.sessionId,
            actionId: actionId(started.sessionId),
            outcome: "maybe",
          },
          {
            sessionId: started.sessionId,
            actionId: actionId(started.sessionId),
            outcome: "done",
            result: "x".repeat(501),
          },
        ]
      ) {
        expect((await answer(body)).status).toBe(400);
      }
      await server.service.waitForTurn(started.sessionId, started.turnId);
    });

    /** A typed-command wire fixture, as the Weaver's Swift tests read it. */
    const wire = (name: string): Record<string, unknown> =>
      JSON.parse(
        Deno.readTextFileSync(
          fromFileUrl(
            new URL(
              `../fixtures/client-command-wire/${name}.json`,
              import.meta.url,
            ),
          ),
        ),
      );
    const wireAction = (name: string) =>
      (wire(name).event as { action: unknown }).action;

    it("settles a typed command with its settlement body, and takes a resend without a second event", async () => {
      const { server, asked, actionId } = await askingServer([
        wireAction("request-invoke-query"),
      ]);
      const started = await (await server.handle(
        jsonRequest("/api/task", { text: "what is here", clientActions: true }),
      )).json();
      const { outcomes } = await asked.promise;
      const body = {
        ...wire("resolve-executed-success"),
        sessionId: started.sessionId,
        actionId: actionId(started.sessionId),
      };

      const response = await server.handle(
        jsonRequest("/api/client-actions", body),
      );
      expect(response.status).toBe(200);
      const resend = await server.handle(
        jsonRequest("/api/client-actions", body),
      );
      expect(resend.status).toBe(200);
      const [outcome] = await outcomes;
      expect(outcome.settlement).toMatchObject({
        status: "executed",
        outcome: { ok: true, transportStatus: 200, id: "loom.inspect" },
      });
      const resolved = server.service.events(started.sessionId)
        .map((e) => e.event)
        .filter((e) => e.kind === "client_action_resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        outcome: "done",
        settlement: { status: "executed", outcome: { bodyBytes: 378 } },
      });
      await server.service.waitForTurn(started.sessionId, started.turnId);
    });

    it("settles a catalog request, and answers 400 for a settlement of the wrong form", async () => {
      const { server, asked, actionId } = await askingServer([
        wireAction("request-list-commands"),
      ]);
      const started = await (await server.handle(
        jsonRequest("/api/task", {
          text: "what can you do",
          clientActions: true,
        }),
      )).json();
      const { outcomes } = await asked.promise;
      const address = {
        sessionId: started.sessionId,
        actionId: actionId(started.sessionId),
      };

      const wrong = await server.handle(jsonRequest("/api/client-actions", {
        ...wire("resolve-declined"),
        ...address,
      }));
      expect(wrong.status).toBe(400);
      expect((await wrong.json()).error.code).toBe("invalid_request");
      const response = await server.handle(jsonRequest("/api/client-actions", {
        ...wire("resolve-executed-catalog"),
        ...address,
      }));
      expect(response.status).toBe(200);
      const [outcome] = await outcomes;
      expect(
        (outcome.settlement as { catalog: { entries: unknown[] } }).catalog
          .entries,
      ).toHaveLength(3);
      await server.service.waitForTurn(started.sessionId, started.turnId);
    });

    it("offers the tool only to a task that sets clientActions", async () => {
      const { server, options } = await askingServer();
      const started = await (await server.handle(
        jsonRequest("/api/task", { text: "no actions please" }),
      )).json();
      await server.service.waitForTurn(started.sessionId, started.turnId);
      expect(options[0].requestClientActions).toBeUndefined();
      expect(options[0].allowedToolIds as string[]).not.toContain(
        "weaver_action",
      );

      const refused = await server.handle(
        jsonRequest("/api/task", { text: "x", clientActions: "yes" }),
      );
      expect(refused.status).toBe(400);
    });
  });

  describe("POST /api/task", () => {
    it("returns 400 for malformed JSON before starting or settling a turn", async () => {
      const response = await server.handle(
        new Request("http://127.0.0.1:8100/api/task", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "request body is not JSON",
      });
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("refuses a host whose protocol requires an unserved feature, before any session starts", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "what is on this loom?",
        protocol: {
          protocolVersion: 1,
          requires: ["typed_commands", "browser_host"],
        },
      }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "this console does not serve browser_host",
        code: "protocol_mismatch",
        protocol: harnessClientProtocolEcho(HARNESS_SUPPORTED_CLIENT_FEATURES),
        requestedVersion: 1,
        missing: ["browser_host"],
      });
      expect((await listSessions()).sessions).toEqual([]);
    });

    it("answers 400 for a malformed protocol declaration", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "what is on this loom?",
        protocol: { protocolVersion: "1", requires: [] },
      }));

      expect(response.status).toBe(400);
      expect((await listSessions()).sessions).toEqual([]);
    });

    it("echoes its protocol on an accepted task", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "track my books",
        clientActions: true,
        protocol: {
          protocolVersion: 1,
          requires: ["client_actions", "typed_commands"],
        },
      }));

      expect(response.status).toBe(200);
      const started = await response.json();
      expect(started.protocol).toEqual(
        harnessClientProtocolEcho(HARNESS_SUPPORTED_CLIENT_FEATURES),
      );
      await server.service.waitForTurn(started.sessionId, started.turnId);
    });

    it("starts a follow-up turn in the session the request names", async () => {
      const started = await startTask({ text: "track my books" });

      const followUp = await startTask({
        text: "add a rating",
        sessionId: started.sessionId,
      });

      expect(followUp.sessionId).toBe(started.sessionId);
      expect(followUp.turnId).not.toBe(started.turnId);
      const listing = await listSessions();
      expect(listing.sessions).toHaveLength(1);
      expect(listing.sessions[0].turnCount).toBe(2);
      expect(listing.sessions[0].firstTaskText).toBe("track my books");
    });

    it("answers 404 for a session that does not exist", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "track my books",
        sessionId: "session-nobody-started",
      }));

      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe("session_not_found");
    });

    it("answers 400 for a sessionId that is not a string", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "track my books",
        sessionId: 7,
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("sessionId must be a string");
    });

    it("attaches the task's input cells to the run that answers it", async () => {
      // The weaver flow: a caller names cells it wants the task computed
      // over, by reference and under its own names. What reaches the run is
      // the specification; the run mints the tokens the model sees.
      const loopOptions: CreateHarnessPromptLoopOptions[] = [];
      const capturing = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: {
              engine: {
                config: {},
                fabricSessionAvailable: false,
                startRun: () => undefined,
                establishInputCells: () =>
                  Promise.resolve([{
                    name: "itinerary",
                    token: "cfh:a:itinerary",
                    ref: `/${CELL_ID}/days`,
                  }]),
                establishPatternRefs: () => Promise.resolve([]),
              } as unknown as CfHarnessEngine,
            },
            createPromptLoop: (options) => {
              loopOptions.push(options);
              return answeringLoop(options);
            },
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await capturing.handle(getRequest("/"));
      await page.body?.cancel();

      const response = await capturing.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [{ name: "itinerary", ref: `/${CELL_ID}/days` }],
      }));
      expect(response.status).toBe(200);
      const started = await response.json();
      await capturing.service.waitForTurn(started.sessionId, started.turnId);

      expect(loopOptions.at(-1)?.inputCells).toEqual([
        { name: "itinerary", ref: `/${CELL_ID}/days` },
      ]);
    });

    it("honors an explicit empty input list instead of configured defaults", async () => {
      const loopOptions: CreateHarnessPromptLoopOptions[] = [];
      const capturing = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: {
              inputCells: [{ name: "default", ref: `/${CELL_ID}/days` }],
            },
            createPromptLoop: (options) => {
              loopOptions.push(options);
              return answeringLoop(options);
            },
            now: advancingClock(),
            onEvent,
          }),
      );
      const response = await capturing.handle(jsonRequest("/api/task", {
        text: "Start without an attached piece",
        inputCells: [],
      }));
      expect(response.status).toBe(200);
      const started = await response.json();
      await capturing.service.waitForTurn(started.sessionId, started.turnId);
      expect(loopOptions.at(-1)?.inputCells).toEqual([]);
    });

    it("answers 400 for an input cell the flag's own grammar refuses", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [{ name: "not a name", ref: `/${CELL_ID}/days` }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("--input-cell name");
    });

    it("answers 400 for an input-cell ref that names no entity, before any turn starts", async () => {
      // The mint would refuse this ref; refusing it here costs no turn.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make a budget dashboard",
        inputCells: [{
          name: "transactions",
          ref: `/fid1:${"A".repeat(43)}/account`,
        }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "reference does not parse",
      );
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("answers 400 for a piece address naming a space that is not this console's", async () => {
      // The caller cannot see which space this console runs against, so the
      // mismatch is this side's to explain — and it costs no turn to say it.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make the headings readable",
        inputCells: [{
          name: "pattern_1",
          ref: "pattern:someone-elses-space/bill-inbox",
        }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "this session runs in `console-test`",
      );
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("answers 400 for a piece address whose slug is malformed", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make the headings readable",
        inputCells: [{ name: "pattern_1", ref: "pattern:console-test/Bills!" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "reference does not parse",
      );
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("answers 400 for a bare slug the runtime's slug rule refuses", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make the headings readable",
        inputCells: [{ name: "pattern_1", ref: "Bill Inbox" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "reference does not parse",
      );
    });

    it("answers 400 for a piece address naming a path under the piece", async () => {
      // A slug names a piece or it names nothing; the general cell case is
      // CT-2319's, and claiming it here would promise what nothing resolves.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "make the headings readable",
        inputCells: [{
          name: "pattern_1",
          ref: "pattern:console-test/bill-inbox/rows",
        }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        "more than one path segment",
      );
    });

    it("answers 400 for input cells that are not a list of name and ref", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [{ name: "itinerary" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each input cell needs a string name and ref",
      );
    });

    it("answers 400 for input cells that are not a list at all", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: { itinerary: `/${CELL_ID}/days` },
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("inputCells must be an array");
    });

    it("answers 400 for an input cell that is not an object", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [`itinerary=/${CELL_ID}/days`],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each input cell must be an object",
      );
    });

    it("answers 400 for a name the request uses twice", async () => {
      // Two references under one name is a request that has not said which
      // cell the model's `itinerary` is.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [
          { name: "itinerary", ref: `/${CELL_ID}/days` },
          { name: "itinerary", ref: `/${CELL_ID}/nights` },
        ],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "inputCells names `itinerary` twice",
      );
    });

    it("answers 400 for an input cell whose name is already a connector grant", async () => {
      // The caller cannot see the console's grants, so the refusal names the
      // connection the colliding grant came from rather than only the word.

      const granted = new ConsoleServer(
        await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
          ],
          {
            CF_HARNESS_CONNECTOR_GRANTS: JSON.stringify([{
              name: "email",
              ref: `/${CELL_ID}`,
              source: {
                connection: "gmail-work",
                piece: "cf-gmail-messages--gmail-work",
              },
            }]),
          },
          "/console",
        ),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: advancingClock(),
            onEvent,
          }),
      );
      const response = await granted.handle(jsonRequest("/api/task", {
        text: "summarize the trip",
        inputCells: [{ name: "email", ref: `/${CELL_ID}/days` }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "inputCells names `email`, which is already this console's grant for the `gmail-work` connector handle",
      );
    });

    it("starts a task that names no input cells at all", async () => {
      const started = await startTask({
        text: "track my books",
        inputCells: null,
      });

      expect(started.turnId).toBeDefined();
    });

    it("attaches the task's pattern references to the run that answers it", async () => {
      // The pill's `use <id>` flow: the caller names published patterns by
      // the index's own id. What reaches the run is the id; resolving it
      // against the index is the run's, before its first model turn.
      const loopOptions: CreateHarnessPromptLoopOptions[] = [];
      const artifactRoot = await Deno.makeTempDir({
        prefix: "cf-harness-console-pattern-refs-",
      });
      const capturing = new ConsoleServer(
        await resolveConsoleConfig(
          [
            "--fabric-identity",
            "key.pkcs8",
            "--fabric-space",
            "console-test",
            "--session-db",
            "none",
            "--pattern-index-url",
            "https://index.test/api",
            "--artifact-root",
            artifactRoot,
          ],
          {},
          "/console",
        ),
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: {
              patternIndexClientFactory: () =>
                Promise.resolve(
                  new PatternIndexClient({
                    baseUrl: "https://index.test/api",
                    fetchFn: () =>
                      Promise.resolve(Response.json(INDEXED_PATTERN)),
                    signer,
                  }),
                ),
            },
            createPromptLoop: (options) => {
              loopOptions.push(options);
              return answeringLoop(options);
            },
            now: advancingClock(),
            onEvent,
          }),
      );
      const page = await capturing.handle(getRequest("/"));
      await page.body?.cancel();

      try {
        const response = await capturing.handle(jsonRequest("/api/task", {
          text: "use pat-expenses for a dice roller app",
          patternRefs: [{ patternId: "pat-expenses" }],
        }));
        expect(response.status).toBe(200);
        const started = await response.json();
        await capturing.service.waitForTurn(started.sessionId, started.turnId);

        expect(
          capturing.service.events(started.sessionId).map((envelope) =>
            envelope.event.kind
          ),
        ).toContain("turn_completed");
        expect(loopOptions.at(-1)?.patternRefs).toEqual([
          { patternId: "pat-expenses" },
        ]);
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });

    it("answers 400 for a pattern reference that is not an index id, before any turn starts", async () => {
      // The prose the person typed after `use` is not an id, and an id is
      // the whole of the reference grammar.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "use it for a dice roller app",
        patternRefs: [{ patternId: "it for a dice roller app" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("patternId must match");
      expect((await listSessions()).sessions).toHaveLength(0);
    });

    it("answers 400 for pattern references that are not a list at all", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: { patternId: "pat-expenses" },
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "patternRefs must be an array",
      );
    });

    it("answers 400 for a pattern reference that is not an object at all", async () => {
      // A reference is a `{ patternId }`, so a bare id in the list is a
      // spelling the route refuses rather than one it reads through.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: ["pat-expenses"],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each pattern reference must be an object",
      );
    });

    it("answers 400 for a `null` sitting in the reference list", async () => {
      // Distinct from a `null` in place of the list itself, which is how a
      // body says it attaches no patterns and starts an ordinary task.
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: [null],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each pattern reference must be an object",
      );
    });

    it("answers 400 for a pattern reference that carries no string patternId", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: [{ id: "pat-expenses" }],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "each pattern reference needs a string patternId",
      );
    });

    it("answers 400 for an id the request names twice", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: [
          { patternId: "pat-expenses" },
          { patternId: "pat-expenses" },
        ],
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "patternRefs names `pat-expenses` twice",
      );
    });

    it("answers 400 for more pattern references than a task may attach", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "total my spending",
        patternRefs: Array.from(
          { length: MAX_HARNESS_PATTERN_REFS + 1 },
          (_unused, index) => ({ patternId: `pat-${index}` }),
        ),
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(
        `at most ${MAX_HARNESS_PATTERN_REFS}`,
      );
    });

    it("starts a task that names no pattern references at all", async () => {
      const started = await startTask({
        text: "track my books",
        patternRefs: null,
      });

      expect(started.turnId).toBeDefined();
    });
  });

  describe("GET /api/events", () => {
    it("replays a past session's whole history from sequence zero", async () => {
      const started = await startTask({ text: "track my books" });

      const response = await server.handle(getRequest(
        `/api/events?sessionId=${started.sessionId}&afterSequence=0`,
        {},
      ));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const kinds = await kindsUntil(response, "turn_completed");

      expect(kinds).toEqual([
        "session_started",
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ]);
    });

    it("adds the durable result to a completed turn", async () => {
      expect(
        await liveTurnResult([
          {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call-1",
              type: "function",
              function: { name: "assign_slug", arguments: "{}" },
            }],
          },
          {
            role: "tool",
            toolCallId: "call-1",
            toolName: "assign_slug",
            content: JSON.stringify({
              outputId: "run:assign_slug:1",
              status: "ok",
              slug: "reading-list",
              url: "http://localhost:8000/console-test/reading-list",
            }),
          },
          { role: "assistant", content: "built it" },
        ]),
      ).toEqual({
        looms: [],
        pieces: [{
          slug: "reading-list",
          url: "http://localhost:8000/console-test/reading-list",
        }],
        spaceName: "console-test",
        outcome: "completed",
        sessionId: expect.any(String),
        continuable: true,
        finalText: "built it",
        elapsedMs: 1750,
      });
    });

    it("adds `pieces: []` when a completed turn assigned no slug", async () => {
      expect(
        await liveTurnResult([
          { role: "assistant", content: "calculated it" },
        ]),
      ).toEqual({
        looms: [],
        pieces: [],
        spaceName: "console-test",
        outcome: "completed",
        sessionId: expect.any(String),
        continuable: true,
        finalText: "calculated it",
        elapsedMs: 1750,
      });
    });

    it("replays only the session the stream names", async () => {
      await startTask({ text: "first task" });
      const second = await startTask({ text: "second task" });

      const response = await server.handle(getRequest(
        `/api/events?sessionId=${second.sessionId}&afterSequence=0`,
        {},
      ));
      const sessionIds = new Set(
        (await envelopesUntil(response, "turn_completed")).map((envelope) =>
          envelope.sessionId
        ),
      );

      expect([...sessionIds]).toEqual([second.sessionId]);
    });

    it("answers 400 for an afterSequence that is not a sequence", async () => {
      const response = await server.handle(
        getRequest("/api/events?afterSequence=later"),
      );

      expect(response.status).toBe(400);
    });
  });

  describe("resolveConsoleConfig()", () => {
    it("defaults to Sol 6.1 and preserves explicit model choices", async () => {
      const flags = ["--fabric-identity", "k", "--fabric-space", "s"];
      expect((await resolveConsoleConfig(flags, {}, "/console")).model)
        .toBe("gpt-6.1-sol");
      expect(
        (await resolveConsoleConfig(flags, {
          CF_HARNESS_MODEL: "gpt-5.6-sol",
        }, "/console")).model,
      ).toBe("gpt-5.6-sol");
      expect(
        (await resolveConsoleConfig([...flags, "--model", "gpt-6-luna"], {
          CF_HARNESS_MODEL: "gpt-5.6-sol",
        }, "/console")).model,
      ).toBe("gpt-6-luna");
    });

    it("throws naming both ways to supply a fabric session when neither is given", async () => {
      await expect(resolveConsoleConfig([], {}, "/console")).rejects.toThrow(
        "a fabric session is required",
      );
    });

    it("throws naming the flag for a port that is not a positive integer", async () => {
      await expect(
        resolveConsoleConfig(
          ["--fabric-identity", "k", "--fabric-space", "s", "--port", "0"],
          {},
          "/console",
        ),
      ).rejects.toThrow("--port must be a positive integer");
    });

    it("throws naming the variable for a port the environment set wrongly", async () => {
      await expect(
        resolveConsoleConfig(
          ["--fabric-identity", "k", "--fabric-space", "s"],
          { CF_HARNESS_CONSOLE_PORT: "http" },
          "/console",
        ),
      ).rejects.toThrow("CF_HARNESS_CONSOLE_PORT must be a positive integer");
    });

    it("throws naming a misspelled restriction flag and the flag it meant", async () => {
      await expect(
        resolveConsoleConfig(
          [
            "--fabric-identity",
            "k",
            "--fabric-space",
            "s",
            "--no-pattern-index-publsh",
          ],
          {},
          "/console",
        ),
      ).rejects.toThrow(
        "`--no-pattern-index-publsh` is not a flag of the console. Did you " +
          "mean `--no-pattern-index-publish`?",
      );
    });

    it("throws naming a flag given no value, and not the word after it", async () => {
      const refusal = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "k",
          "--fabric-space",
          "s",
          "--workspace",
          "--Secret prompt text",
        ],
        {},
        "/console",
      ).then(() => undefined, (error: Error) => error.message);

      expect(refusal).toBe(
        "`--workspace` was given no value; a value starting with `-` needs " +
          "the `--workspace=<value>` spelling",
      );
    });

    it("throws for a port or a turn budget given no value, rather than using its default", async () => {
      for (
        const extra of [
          ["--port", "-1"],
          ["--max-model-turns", "-3"],
          ["--port="],
          ["--max-model-turns= "],
        ]
      ) {
        const flag = extra[0].split("=")[0];
        await expect(
          resolveConsoleConfig(
            ["--fabric-identity", "k", "--fabric-space", "s", ...extra],
            {},
            "/console",
          ),
        ).rejects.toThrow(`\`${flag}\` was given no value`);
      }
    });

    it("throws naming no negative number standing alone", async () => {
      await expect(
        resolveConsoleConfig(
          ["--fabric-identity", "k", "--fabric-space", "s", "-5x"],
          {},
          "/console",
        ),
      ).rejects.toThrow(
        "An argument starting with `-` is not a flag of the console.",
      );
    });

    it("throws saying a negated switch takes no value", async () => {
      await expect(
        resolveConsoleConfig(
          [
            "--fabric-identity",
            "k",
            "--fabric-space",
            "s",
            "--no-pattern-index-publish=true",
          ],
          {},
          "/console",
        ),
      ).rejects.toThrow("`--no-pattern-index-publish` takes no value.");
    });

    it("throws naming a flag written after `--`, which it does not read", async () => {
      await expect(
        resolveConsoleConfig(
          ["--fabric-identity", "k", "--fabric-space", "s", "--", "--bogus"],
          {},
          "/console",
        ),
      ).rejects.toThrow(
        "`--bogus` follows `--`, after which the console reads no flag; it " +
          "takes no positional arguments.",
      );
    });

    it("throws for a positional argument without repeating it", async () => {
      for (
        const extra of [["hunter2"], ["--", "--Secret words"], ["--", "-15"]]
      ) {
        const refusal = await resolveConsoleConfig(
          ["--fabric-identity", "k", "--fabric-space", "s", ...extra],
          {},
          "/console",
        ).then(() => undefined, (error: Error) => error.message);

        expect(refusal).toBe(
          "The console takes no positional arguments, and reads no flag " +
            "after `--`.",
        );
      }
    });

    it("throws naming an undeclared flag without the value given with it", async () => {
      const refusal = await resolveConsoleConfig(
        [
          "--fabric-identity",
          "k",
          "--fabric-space",
          "s",
          "--api-key=sk-secret",
        ],
        {},
        "/console",
      ).then(() => undefined, (error: Error) => error.message);

      expect(refusal).toBe("`--api-key` is not a flag of the console.");
    });
  });

  describe("consoleHelpText()", () => {
    it("returns usage naming every flag for `--help` or `-h`, whatever else is on the line", () => {
      for (
        const args of [["--help"], ["-h"], ["--port", "8100", "--bogus", "-h"]]
      ) {
        const text = consoleHelpText(args);

        expect(text).toContain("--fabric-identity");
        expect(text).toContain("--no-pattern-index-publish");
        expect(text).toContain("README.md");
      }
    });

    it("returns `undefined` for arguments that ask for no help", () => {
      expect(consoleHelpText(["--fabric-identity", "k"])).toBeUndefined();
    });

    it("leaves `--help` and `-h` among the flags the console takes", () => {
      expect(() => parseConsoleArgs(["--help", "-h"])).not.toThrow();
    });

    it("prints usage for `--help` rather than resolving a configuration", async () => {
      // Resolving one would throw: no fabric session is named here.
      await startConsoleServer(["--help"], {}, "/console");
    });

    it("refuses a flag whose value reads as help, rather than printing usage", async () => {
      for (const help of ["-h", "--help"]) {
        await expect(
          startConsoleServer(["--port", help], {}, "/console"),
        ).rejects.toThrow(
          "`--port` was given no value; a value starting with `-` needs " +
            "the `--port=<value>` spelling",
        );
      }
    });

    it("refuses a value holding an `h` as given no value, rather than printing usage", async () => {
      await expect(
        startConsoleServer(["--workspace", "-hidden"], {}, "/console"),
      ).rejects.toThrow(
        "`--workspace` was given no value; a value starting with `-` needs " +
          "the `--workspace=<value>` spelling",
      );
    });

    it("refuses a dotted flag without the value of the flag before the dot", async () => {
      const refusal = await startConsoleServer(
        ["--fabric-identity", "/secret/key.pem", "--fabric-identity.x", "y"],
        {},
        "/console",
      ).then(() => undefined, (error: Error) => error.message);

      expect(refusal).toBe(
        "`--fabric-identity.x` is not a flag of the console. Did you mean " +
          "`--fabric-identity`?",
      );
    });
  });

  describe("POST /api/index/call", () => {
    /** Posts one proxied read at a server that has an index. */
    const call = async (
      indexed: { server: ConsoleServer },
      body: unknown,
    ): Promise<Response> =>
      await indexed.server.handle(
        jsonRequest("/api/index/call", body),
      );

    it("passes a `listEvents` read through with the pattern and limit it named", async () => {
      const indexed = await indexServer([Response.json({ events: [] })]);

      const response = await call(indexed, {
        fn: "listEvents",
        body: { patternId: "ss-2w4nQ8", limit: 5 },
      });

      expect(response.status).toBe(200);
      expect(indexed.requests).toHaveLength(1);
      const sent = `${indexed.requests[0].url} ${indexed.requests[0].body}`;
      expect(sent).toContain("ss-2w4nQ8");
      expect(sent).toContain("5");
    });

    it("passes a `listEvents` read naming neither a pattern nor a limit", async () => {
      const indexed = await indexServer([Response.json({ events: [] })]);

      const response = await call(indexed, { fn: "listEvents" });

      expect(response.status).toBe(200);
      expect(indexed.requests).toHaveLength(1);
    });

    it("answers a host-side failure generically, never with its message", async () => {
      // A factory that cannot build its client throws host-side — an
      // unreadable keyfile names the path the operator configured, which the
      // page must not read.
      const server = new ConsoleServer(
        await config(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: advancingClock(),
            onEvent,
          }),
        () => Promise.reject(new Error("ENOENT: /Users/operator/.secret.key")),
      );
      const page = await server.handle(getRequest("/"));
      await page.body?.cancel();
      const response = await server.handle(
        jsonRequest("/api/index/call", { fn: "listPatterns" }),
      );
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).not.toContain(".secret.key");
      expect(body.error).toContain("see its log");
    });

    it("answers an allowlisted read with what the index returned", async () => {
      const listing = {
        patterns: [{
          patternId: "pat-1",
          description: "Totals an expense list",
          hashtags: ["expenses"],
          keywords: [],
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          events: { run_succeeded: 2 },
          score: 2,
        }],
        eventTypes: { run_succeeded: 1 },
      };
      const indexed = await indexServer([Response.json(listing)]);

      const response = await call(indexed, { fn: "listPatterns" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(listing);
      expect(indexed.requests[0].url).toBe(
        "https://index.test/api/listPatterns",
      );
      expect(JSON.parse(indexed.requests[0].body)).toEqual({});
    });

    it("sends only the search fields the page supplied", async () => {
      const indexed = await indexServer([Response.json({ results: [] })]);

      await call(indexed, {
        fn: "searchPatterns",
        body: { tags: ["expenses"], text: "totals", limit: 5, mystery: true },
      });

      expect(indexed.requests[0].url).toBe(
        "https://index.test/api/searchPatterns",
      );
      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        tags: ["expenses"],
        text: "totals",
        limit: 5,
      });
    });

    it("asks for a pattern without its source, whatever the page sent", async () => {
      const indexed = await indexServer([
        Response.json({
          patternId: "pat-1",
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          description: "Totals an expense list",
          hashtags: [],
          dependencies: [],
        }),
      ]);

      await call(indexed, {
        fn: "getPattern",
        body: { patternId: "pat-1", includeSource: true },
      });

      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        patternId: "pat-1",
      });
    });

    it("answers 400 for getPattern with no pattern named", async () => {
      const indexed = await indexServer([]);

      const response = await call(indexed, { fn: "getPattern", body: {} });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("patternId is required");
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a function outside the allowlist", async () => {
      const indexed = await indexServer([]);

      for (
        const fn of [
          "recordEvent",
          "publishPattern",
          "retractPattern",
          "deletePattern",
          7,
        ]
      ) {
        const response = await call(indexed, {
          fn,
          body: { patternId: "pat-1", eventType: "thumbs_up" },
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("fn must be one of");
      }
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a body that is not JSON", async () => {
      const indexed = await indexServer([]);

      const response = await indexed.server.handle(
        new Request("http://127.0.0.1:8100/api/index/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }),
      );

      expect(response.status).toBe(400);
      expect(indexed.requests).toEqual([]);
    });

    it("passes through the status the index gave a request it faulted", async () => {
      const indexed = await indexServer([
        Response.json({ error: "unknown pattern" }, { status: 404 }),
      ]);

      const response = await call(indexed, {
        fn: "getPattern",
        body: { patternId: "missing" },
      });

      expect(response.status).toBe(404);
      // The message names the function and the status; the index's own body
      // stays behind, as it does everywhere else a failure is rendered.
      expect((await response.json()).error).toBe(
        "pattern index getPattern failed (404)",
      );
    });

    it("answers 502 when the index itself failed", async () => {
      const indexed = await indexServer([
        Response.json({ error: "datastore unavailable" }, { status: 503 }),
      ]);

      const response = await call(indexed, { fn: "listPatterns" });

      expect(response.status).toBe(502);
      expect((await response.json()).error).toContain("listPatterns");
    });

    it("answers 404 when the server was started without an index", async () => {
      const response = await server.handle(
        jsonRequest("/api/index/call", { fn: "listPatterns" }),
      );

      expect(response.status).toBe(404);
      expect((await response.json()).error).toContain(
        "started without a pattern index",
      );
    });
  });

  describe("POST /api/index/feedback", () => {
    /** Posts one verdict at a server that has an index. */
    const vote = async (
      indexed: { server: ConsoleServer },
      body: unknown,
    ): Promise<Response> =>
      await indexed.server.handle(
        jsonRequest("/api/index/feedback", body),
      );

    it("records an up verdict as a thumbs_up under the server's own identity", async () => {
      const indexed = await indexServer([Response.json({ ok: true })]);

      const response = await vote(indexed, {
        patternId: "ss-2w4nQ8",
        verdict: "up",
        did: "did:key:zImpersonated",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        patternId: "ss-2w4nQ8",
        eventType: "thumbs_up",
        recordedBy: signer.did(),
      });
      expect(indexed.requests[0].url).toBe(
        "https://index.test/api/recordEvent",
      );
      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        patternId: "ss-2w4nQ8",
        eventType: "thumbs_up",
        did: signer.did(),
      });
    });

    it("records a down verdict as a thumbs_down", async () => {
      const indexed = await indexServer([Response.json({ ok: true })]);

      const response = await vote(indexed, {
        patternId: "ss-2w4nQ8",
        verdict: "down",
      });

      expect(response.status).toBe(200);
      expect((await response.json()).eventType).toBe("thumbs_down");
      expect(JSON.parse(indexed.requests[0].body)).toEqual({
        patternId: "ss-2w4nQ8",
        eventType: "thumbs_down",
        did: signer.did(),
      });
    });

    it("answers 400 for a verdict the index has no event for", async () => {
      const indexed = await indexServer([]);

      // `constructor` is the one that passes an unguarded lookup on the
      // verdict map, so it stands beside the ordinary misspellings.
      for (const verdict of ["sideways", "thumbs_up", "constructor", "", 1]) {
        const response = await vote(indexed, {
          patternId: "ss-2w4nQ8",
          verdict,
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(
          'verdict must be "up" or "down"',
        );
      }
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a body that names no pattern", async () => {
      const indexed = await indexServer([]);

      for (const patternId of [undefined, "", 7]) {
        const response = await vote(indexed, { patternId, verdict: "up" });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("patternId is required");
      }
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a body that is not JSON", async () => {
      const indexed = await indexServer([]);

      const response = await indexed.server.handle(
        new Request("http://127.0.0.1:8100/api/index/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("request body is not JSON");
      expect(indexed.requests).toEqual([]);
    });

    it("answers 400 for a JSON body that is not an object", async () => {
      const indexed = await indexServer([]);

      const response = await vote(indexed, "ss-2w4nQ8");

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("patternId is required");
      expect(indexed.requests).toEqual([]);
    });

    it("answers 503 when the server was started without an index", async () => {
      const response = await server.handle(
        jsonRequest("/api/index/feedback", {
          patternId: "ss-2w4nQ8",
          verdict: "up",
        }),
      );

      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain(
        "started without a pattern index",
      );
    });

    it("answers 502 when the index took the request and did not record it", async () => {
      const indexed = await indexServer([Response.json({ ok: false })]);

      const response = await vote(indexed, {
        patternId: "ss-2w4nQ8",
        verdict: "up",
      });

      expect(response.status).toBe(502);
      expect((await response.json()).error).toContain("thumbs_up");
    });

    it("passes through the status the index gave a request it faulted", async () => {
      const indexed = await indexServer([
        Response.json({ error: "unknown pattern" }, { status: 404 }),
      ]);

      const response = await vote(indexed, {
        patternId: "missing",
        verdict: "up",
      });

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe(
        "pattern index recordEvent failed (404)",
      );
    });
  });

  describe("GET /api/runs with the agent runner's work root", () => {
    it("lists an /ask job's run and serves its detail, flow, graph and files", async () => {
      const base = await Deno.makeTempDir();
      try {
        const agentRuns = join(base, "agent-runs");
        const runDir = join(agentRuns, "local", "job-1", "artifacts", "asked");
        await Deno.mkdir(runDir, { recursive: true });
        await Deno.writeTextFile(
          join(runDir, "run-state.json"),
          JSON.stringify(createHarnessRunState({
            runId: "asked",
            cfcEnforcementMode: "observe",
            currentDir: "/workspace",
            now: "2026-01-01T00:00:00.000Z",
          })),
        );
        await Deno.writeTextFile(join(runDir, "transcript.json"), "[]");
        const reading = new ConsoleServer(
          {
            ...await config(),
            artifactRoot: join(base, "console-runs"),
            agentRunsRoot: agentRuns,
          },
          (onEvent) =>
            new HarnessInteractiveChatService({
              createPromptLoop: answeringLoop,
              now: advancingClock(),
              onEvent,
            }),
        );
        const listed = await reading.handle(getRequest("/api/runs"));
        expect(
          (await listed.json()).runs.map((
            run: { runId: string; source: string },
          ) => [run.runId, run.source]),
        ).toEqual([["asked", "ask"]]);
        for (
          const path of [
            "/api/runs/asked",
            "/api/runs/asked/flow",
            "/api/runs/asked/graph",
            "/api/runs/asked/artifacts/run-state.json",
          ]
        ) {
          const response = await reading.handle(getRequest(path));
          expect([path, response.status]).toEqual([path, 200]);
          await response.body?.cancel();
        }
        const escaped = await reading.handle(
          getRequest(`/api/runs/${encodeURIComponent("../asked")}`),
        );
        expect(escaped.status).toBe(404);
        await escaped.body?.cancel();
      } finally {
        await Deno.remove(base, { recursive: true });
      }
    });
  });

  describe("GET /api/runs/<runId>", () => {
    /**
     * A run holding two strings a browsing child returned, one labeled for
     * `owner` and one for someone else, read by a server whose fabric session
     * signs with the key at `keyPath`.
     */
    const runDetailFrom = async (
      keyPath: string,
      root: string,
      owner: string,
    ) => {
      const referent = (value: string, subject: string) => ({
        kind: "return" as const,
        source: "delegate_task:child",
        value,
        label: { confidentiality: [cfcAtom.user(subject)] },
        labelSource: "child" as const,
      });
      const mine = await mintReferentHandle(
        createHarnessHandleTable("run-1"),
        referent("my note", owner),
      );
      const theirs = await mintReferentHandle(
        mine.table,
        referent("their note", "did:key:zOther"),
      );
      await Deno.mkdir(join(root, "run-1"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "run-1", "run-state.json"),
        JSON.stringify({
          ...createHarnessRunState({
            runId: "run-1",
            cfcEnforcementMode: "enforce-strict",
            currentDir: "/workspace",
            now: "2026-01-01T00:00:00.000Z",
          }),
          handleTable: theirs.table,
        }),
      );
      await Deno.writeTextFile(join(root, "run-1", "transcript.json"), "[]");
      const configured = await config();
      const owned = new ConsoleServer(
        {
          ...configured,
          artifactRoot: root,
          fabricSession: {
            ...configured.fabricSession,
            identityKeyPath: keyPath,
          },
        },
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: advancingClock(),
            onEvent,
          }),
      );
      const response = await owned.handle(getRequest("/api/runs/run-1"));
      return {
        detail: await response.json(),
        mine: mine.token,
        theirs: theirs.token,
      };
    };

    it("returns the strings that fit the display of the identity the console signs as", async () => {
      const root = await Deno.makeTempDir();
      try {
        const keyPath = join(root, "owner.pkcs8");
        const key = await Identity.generatePkcs8();
        await Deno.writeFile(keyPath, key);
        const owner = (await Identity.fromPkcs8(key)).did();

        const { detail, mine, theirs } = await runDetailFrom(
          keyPath,
          root,
          owner,
        );

        expect(detail.revealed).toEqual({ [mine]: "my note" });
        expect(detail.hidden).toEqual([theirs]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns no strings when the console cannot read its identity", async () => {
      const root = await Deno.makeTempDir();
      try {
        const { detail, mine, theirs } = await runDetailFrom(
          join(root, "missing.pkcs8"),
          root,
          signer.did(),
        );

        expect(detail.revealed).toEqual({});
        expect(detail.hidden).toEqual([mine, theirs]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("POST /api/index/retract", () => {
    const request = {
      patternId: "A".repeat(43),
      successorPatternId: "B".repeat(43),
      reason: "Superseded by the corrected reader",
    };

    for (const changed of [true, false]) {
      it(`returns the index receipt with changed=${changed} for the publication id read from an artifact`, async () => {
        const root = await Deno.makeTempDir();
        try {
          const outputRoot = join(root, "run-1.subagent.1", "tool-outputs");
          await Deno.mkdir(outputRoot, { recursive: true });
          await Deno.writeTextFile(
            join(outputRoot, "publication.json"),
            JSON.stringify({
              status: "ok",
              pieceId: CELL_ID,
              patternPublication: {
                status: "queued",
                reason: "recorded-automatically",
                patternId: request.patternId,
              },
            }),
          );
          const receipt = {
            patternId: request.patternId,
            status: "retracted",
            successorPatternId: request.successorPatternId,
            retractionReason: request.reason,
            retractedBy: signer.did(),
            retractedAt: "2026-09-21T00:00:00.000Z",
            discoverable: false,
            changed,
          };
          const indexed = await indexServer([Response.json(receipt)], root);
          const artifact = await indexed.server.handle(getRequest(
            "/api/runs/run-1.subagent.1/tool-outputs/publication.json",
          ));
          expect(artifact.status).toBe(200);
          const publication = (await artifact.json()).patternPublication;
          const response = await indexed.server.handle(
            jsonRequest("/api/index/retract", {
              ...request,
              patternId: publication.patternId,
              ownerDid: "did:key:zOther",
              retractedBy: "did:key:zOther",
              admin: true,
              includeSource: true,
            }),
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual(receipt);
          expect(indexed.requests).toEqual([{
            url: "https://index.test/api/retractPattern",
            body: JSON.stringify(request),
          }]);
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      });
    }

    for (const field of ["patternId", "successorPatternId", "reason"]) {
      it(`returns 400 without contacting the index for an invalid ${field}`, async () => {
        const indexed = await indexServer([]);
        for (const value of [undefined, null, 7, "", "   "]) {
          const response = await indexed.server.handle(
            jsonRequest("/api/index/retract", { ...request, [field]: value }),
          );
          expect(response.status).toBe(400);
          const { error } = await response.json();
          expect(error).toContain(`${field} is required`);
          if (field === "successorPatternId") {
            expect(error).toContain("same-owner direct successor");
            expect(error).toContain("standalone deletion is not supported");
          }
        }
        expect(indexed.requests).toEqual([]);
      });
    }

    it("returns 400 for malformed JSON or a non-object body without contacting the index", async () => {
      const indexed = await indexServer([]);
      for (const body of ["not JSON", "null", "[]", '"pattern"']) {
        const response = await indexed.server.handle(
          new Request("http://127.0.0.1:8100/api/index/retract", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        );
        expect(response.status).toBe(400);
      }
      expect(indexed.requests).toEqual([]);
    });

    it("returns 503 when the console has no index", async () => {
      const response = await server.handle(
        jsonRequest("/api/index/retract", request),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain(
        "without a pattern index",
      );
    });

    for (const status of [400, 403, 404, 409, 500]) {
      it(`preserves the index refusal at ${status} without exposing its body`, async () => {
        const indexed = await indexServer([
          Response.json({ error: "private index detail" }, { status }),
        ]);
        const response = await indexed.server.handle(
          jsonRequest("/api/index/retract", request),
        );
        expect(response.status).toBe(status === 500 ? 502 : status);
        expect(await response.json()).toEqual({
          error: `pattern index retractPattern failed (${status})`,
        });
        expect(indexed.requests).toHaveLength(1);
      });
    }

    it("returns a generic 502 for a host-side failure", async () => {
      const unavailable = new ConsoleServer(
        await configWithIndex(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: advancingClock(),
            onEvent,
          }),
        () => Promise.reject(new Error("private identity path")),
      );
      const response = await unavailable.handle(
        jsonRequest("/api/index/retract", request),
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "the index request failed on this server; see its log",
      });
    });

    it("refuses a foreign Host before contacting the index", async () => {
      const indexed = await indexServer([]);
      const response = await indexed.server.handle(
        jsonRequest("/api/index/retract", request, { host: "foreign.test" }),
      );
      expect(response.status).toBe(403);
      expect(indexed.requests).toEqual([]);
    });
  });

  describe("the served page", () => {
    it("confines the page to this origin with a content security policy", async () => {
      const response = await server.handle(getRequest("/"));
      await response.body?.cancel();

      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
      // The run tree indents a row with a `style` attribute, which a policy
      // without this would refuse; a script has no such exception.
      expect(policy).toContain("style-src 'self' 'unsafe-inline'");
      expect(policy).not.toContain("script-src");
      expect(policy).not.toContain("default-src 'self' 'unsafe-inline'");
    });

    it("carries that policy on every path served from the built page", async () => {
      const response = await server.handle(getRequest("/scripts/index.js"));
      await response.body?.cancel();

      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'self'",
      );
    });

    it("does not answer an API route with a page policy", async () => {
      const response = await server.handle(
        getRequest("/api/sessions"),
      );
      await response.json();

      expect(response.headers.get("content-security-policy")).toBeNull();
    });
  });

  describe("the live pane", () => {
    it("confines the live pane with the page's content security policy", async () => {
      const response = await server.handle(getRequest("/live/session-1"));
      await response.body?.cancel();

      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      // The pane is opened at the top level of its own view, never framed.
      expect(policy).toContain("frame-ancestors 'none'");
    });

    it("answers 403 for a live pane request naming another host", async () => {
      const response = await server.handle(
        getRequest("/live/session-1", { host: "evil.test:8100" }),
      );
      await response.body?.cancel();

      expect(response.status).toBe(403);
    });

    it("answers 404 without a token for a path below the session segment", async () => {
      const response = await server.handle(
        getRequest("/live/session-1/turn-1"),
      );
      await response.body?.cancel();

      expect(response.status).toBe(404);
    });

    it("sends the trailing-slash live address to its canonical form, relatively", async () => {
      // The pane's stylesheet and script are `../styles/...` and
      // `../scripts/...`; from `/live/session-1/` they would resolve one level
      // too deep. The Location is relative so it lands under whatever prefix
      // a host fronts the console at, with no rewriting on the host's side.
      const response = await server.handle(getRequest("/live/session-1/"));
      await response.body?.cancel();

      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("../session-1");
    });

    it("keeps the turn and pieces base a trailing-slash live address carries", async () => {
      // `?turn=` narrows the pane and `?piecesBase=` says where a piece
      // renders; a redirect that dropped them would open the pane on the
      // wrong thing.
      const response = await server.handle(getRequest(
        "/live/session-1/?turn=turn-1&piecesBase=http%3A%2F%2Fh%2Fpattern-pane",
      ));
      await response.body?.cancel();

      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(
        "../session-1?turn=turn-1&piecesBase=http%3A%2F%2Fh%2Fpattern-pane",
      );
    });

    it("still refuses the trailing-slash live address naming another host", async () => {
      const response = await server.handle(
        getRequest("/live/session-1/", { host: "evil.test:8100" }),
      );
      await response.body?.cancel();

      expect(response.status).toBe(403);
    });
  });

  describe("the host gate", () => {
    it("answers an API request carrying no cookie", async () => {
      const response = await server.handle(getRequest("/api/sessions"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [] });
    });

    it("answers an API request from any other origin", async () => {
      const response = await server.handle(
        getRequest("/api/sessions", { origin: "http://elsewhere.test" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [] });
    });

    it("starts a turn from a request carrying neither cookie nor origin", async () => {
      const response = await server.handle(
        jsonRequest("/api/task", { text: "track my books" }),
      );

      expect(response.status).toBe(200);
      const started = await response.json();
      await server.service.waitForTurn(started.sessionId, started.turnId);
      expect((await listSessions()).sessions).toHaveLength(1);
    });

    it("hands the page no cookie", async () => {
      const response = await server.handle(getRequest("/"));
      await response.body?.cancel();

      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("answers 403 for a page request naming another host", async () => {
      const response = await server.handle(
        getRequest("/", { host: "evil.test:8100" }),
      );
      await response.body?.cancel();

      expect(response.status).toBe(403);
    });

    it("answers 403 for an API request naming another host", async () => {
      const response = await server.handle(
        getRequest("/api/sessions", { host: "evil.test:8100" }),
      );

      expect(response.status).toBe(403);
    });

    it("answers 415 for a task posted as a form submission", async () => {
      const response = await server.handle(
        new Request("http://127.0.0.1:8100/api/task", {
          method: "POST",
          headers: { "content-type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({ text: "track my books" }),
        }),
      );

      expect(response.status).toBe(415);
    });
  });

  describe("the browser host routes", () => {
    const PAGE = { url: "https://shop.example/", title: "Shop" };

    /**
     * A server whose one turn asks its browser host for a snapshot and answers
     * with what the host returned, so a test can play the host's part over
     * the routes.
     */
    const hostedServer = async (): Promise<{
      server: ConsoleServer;
      loopOptions: CreateHarnessPromptLoopOptions[];
      results: (BrowserHostResult | undefined)[];
    }> => {
      const loopOptions: CreateHarnessPromptLoopOptions[] = [];
      const results: (BrowserHostResult | undefined)[] = [];
      const hosted = new ConsoleServer(
        await configWithBrowserHost(),
        (onEvent) =>
          new HarnessInteractiveChatService({
            createPromptLoop: (options) => {
              loopOptions.push(options);
              return {
                runTranscript: async (run) => {
                  const result = await options.browserHost?.perform({
                    action: "snapshot",
                    interactive: true,
                  });
                  results.push(result);
                  const answer = {
                    role: "assistant" as const,
                    content: result?.status === "ok"
                      ? result.text ?? ""
                      : `refused: ${result?.status}`,
                  };
                  const transcript = [...run.transcript, answer];
                  await run.onTranscriptEvent?.({
                    message: answer,
                    transcript,
                  });
                  return {
                    model: "gpt-test",
                    finalAssistantText: answer.content,
                    transcript,
                    modelTurns: 1,
                    runState: {} as HarnessPromptLoopResult["runState"],
                  };
                },
              };
            },
            now: advancingClock(),
            onEvent,
          }),
      );
      return { server: hosted, loopOptions, results };
    };

    /** Reads `stream` until what it has delivered contains `text`. */
    const readUntil = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      text: string,
    ): Promise<string> => {
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes(text)) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error(`stream ended before ${text}: ${received}`);
        }
        received += decoder.decode(value);
      }
      return received;
    };

    it("returns a host token only to a task that declares a host", async () => {
      const { server: hosted, loopOptions } = await hostedServer();

      const plain = await server.handle(
        jsonRequest("/api/task", { text: "no browser" }),
      );
      const plainBody = await plain.json();
      await server.service.waitForTurn(plainBody.sessionId, plainBody.turnId);
      const declared = await hosted.handle(jsonRequest("/api/task", {
        text: "use the web",
        browserHost: { aFieldThisConsoleDoesNotKnow: true },
      }));
      const declaredBody = await declared.json();

      expect(plainBody.browserHostToken).toBeUndefined();
      expect(typeof declaredBody.browserHostToken).toBe("string");
      expect(loopOptions[0]?.browserHost).toBeDefined();
      expect(loopOptions[0]?.allowedSubagentProfiles).toContain("browser");

      const stream = await hosted.handle(
        jsonRequest("/api/browser-host/stream", {
          turnId: declaredBody.turnId,
          token: declaredBody.browserHostToken,
        }),
      );
      const reader = stream.body!.getReader();
      await readUntil(reader, "event: request");
      await hosted.handle(jsonRequest("/api/browser-host/result", {
        turnId: declaredBody.turnId,
        token: declaredBody.browserHostToken,
        id: "1",
        result: { status: "ok", page: PAGE, text: "" },
      }));
      await readUntil(reader, "event: close");
      await reader.cancel();
      await hosted.service.waitForTurn(
        declaredBody.sessionId,
        declaredBody.turnId,
      );
    });

    it("writes each liveness tick to an attached host's stream", async () => {
      const { server: hosted } = await hostedServer();
      const started = await (await hosted.handle(jsonRequest("/api/task", {
        text: "use the web",
        browserHost: {},
      }))).json();
      const stream = await hosted.handle(
        jsonRequest("/api/browser-host/stream", {
          turnId: started.turnId,
          token: started.browserHostToken,
        }),
      );
      const reader = stream.body!.getReader();
      await readUntil(reader, "event: request");

      hosted.ping();
      const ticked = await readUntil(reader, ": 1\n\n");
      await hosted.handle(jsonRequest("/api/browser-host/result", {
        turnId: started.turnId,
        token: started.browserHostToken,
        id: "1",
        result: { status: "ok", page: PAGE, text: "" },
      }));
      await readUntil(reader, "event: close");
      await reader.cancel();
      await hosted.service.waitForTurn(started.sessionId, started.turnId);

      expect(ticked).toContain(": 1\n\n");
    });

    it("returns 400 for a host route body that is not JSON or names no turn", async () => {
      const empty = await server.handle(
        new Request("http://127.0.0.1:8100/api/browser-host/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
        }),
      );
      const notJson = await server.handle(
        new Request("http://127.0.0.1:8100/api/browser-host/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      );
      const noTurn = await server.handle(
        jsonRequest("/api/browser-host/result", { token: "t", id: "1" }),
      );

      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ error: "request body is not JSON" });
      expect(notJson.status).toBe(400);
      expect(await notJson.json()).toEqual({
        error: "request body is not JSON",
      });
      expect(noTurn.status).toBe(400);
      expect(await noTurn.json()).toEqual({ error: "turnId is required" });
    });

    it("serves browser_host only when it allows a browser host, and says so before a task", async () => {
      const { server: hosted } = await hostedServer();
      const features = async (console: ConsoleServer) =>
        (await (await console.handle(getRequest("/api/status"))).json())
          .protocol.features;
      const requiring = (console: ConsoleServer) =>
        console.handle(jsonRequest("/api/task", {
          text: "use the web",
          protocol: { protocolVersion: 1, requires: ["browser_host"] },
        }));

      expect(await features(server)).toEqual([
        "client_actions",
        "typed_commands",
        "starts_run",
      ]);
      expect(await features(hosted)).toEqual([
        "client_actions",
        "typed_commands",
        "browser_host",
        "starts_run",
      ]);

      const refused = await requiring(server);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        error: "this console does not serve browser_host",
        missing: ["browser_host"],
      });
      expect((await listSessions()).sessions).toEqual([]);

      const accepted = await requiring(hosted);
      expect(accepted.status).toBe(200);
      const started = await accepted.json();
      expect(started.protocol.features).toContain("browser_host");
      await hosted.service.waitForTurn(started.sessionId, started.turnId);
    });

    it("returns 403 for a host declaration a console that allows none is sent, and gives it no browser children", async () => {
      const response = await server.handle(jsonRequest("/api/task", {
        text: "use the web",
        browserHost: {},
      }));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error:
          "this console takes no browser host; an operator allows one with --allow-browser-host",
      });
      expect(
        (await (await server.handle(getRequest("/api/policy"))).json())
          .allowedSubagentProfiles,
      ).not.toContain("browser");
    });

    it("runs a console's ordinary task without browser children, and gives a host's turn them", async () => {
      const { server: hosted, loopOptions } = await hostedServer();

      const plain = await (await hosted.handle(
        jsonRequest("/api/task", { text: "no browser" }),
      )).json();
      await hosted.service.waitForTurn(plain.sessionId, plain.turnId);

      expect(plain.error).toBeUndefined();
      expect(loopOptions[0]?.browserHost).toBeUndefined();
      expect(loopOptions[0]?.allowedSubagentProfiles).not.toContain(
        "browser",
      );
      expect(
        (await (await hosted.handle(getRequest("/api/policy"))).json())
          .allowedSubagentProfiles,
      ).not.toContain("browser");
    });

    it("returns 400 for a host declaration that is not an object", async () => {
      const { server: hosted } = await hostedServer();
      const response = await hosted.handle(jsonRequest("/api/task", {
        text: "use the web",
        browserHost: ["profileFields"],
      }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "browserHost must be an object",
      });
    });

    it("returns 413 for a host route body larger than a result may be, without reading the rest", async () => {
      const response = await server.handle(
        new Request("http://127.0.0.1:8100/api/browser-host/result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(32 * 1024 * 1024 + 1),
        }),
      );

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "request body is larger than 33554432 bytes",
      });
    });

    it("carries an operation to the host and its result back to the run", async () => {
      const { server: hosted, results } = await hostedServer();
      const started = await (await hosted.handle(jsonRequest("/api/task", {
        text: "use the web",
        browserHost: {},
      }))).json();

      const refused = await hosted.handle(
        jsonRequest("/api/browser-host/stream", {
          turnId: started.turnId,
          token: "not-the-token",
        }),
      );
      const stream = await hosted.handle(
        jsonRequest("/api/browser-host/stream", {
          turnId: started.turnId,
          token: started.browserHostToken,
        }),
      );
      const second = await hosted.handle(
        jsonRequest("/api/browser-host/stream", {
          turnId: started.turnId,
          token: started.browserHostToken,
        }),
      );
      const reader = stream.body!.getReader();
      const delivered = await readUntil(reader, "\n\n");
      const posted = await hosted.handle(
        jsonRequest("/api/browser-host/result", {
          turnId: started.turnId,
          token: started.browserHostToken,
          id: "1",
          result: { status: "ok", page: PAGE, text: '- button "Buy"' },
        }),
      );
      const closing = await readUntil(reader, "event: close");
      await hosted.service.waitForTurn(started.sessionId, started.turnId);

      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({
        error: "no browser host for that turn",
      });
      expect(stream.headers.get("content-type")).toBe("text/event-stream");
      expect(second.status).toBe(409);
      await second.body?.cancel();
      expect(delivered).toBe(
        `event: request\ndata: ${
          JSON.stringify({
            id: "1",
            operation: { action: "snapshot", interactive: true },
          })
        }\n\n`,
      );
      expect(posted.status).toBe(200);
      expect(closing).toContain("event: close");
      expect(results).toEqual([
        { status: "ok", page: PAGE, text: '- button "Buy"' },
      ]);
    });

    it("answers 404 for a result under another token or for an id nobody waits on, and 400 for one that is not a result, which fails the operation", async () => {
      const { server: hosted, results } = await hostedServer();
      const started = await (await hosted.handle(jsonRequest("/api/task", {
        text: "use the web",
        browserHost: {},
      }))).json();
      const stream = await hosted.handle(
        jsonRequest("/api/browser-host/stream", {
          turnId: started.turnId,
          token: started.browserHostToken,
        }),
      );
      const reader = stream.body!.getReader();
      await readUntil(reader, "event: request");
      const post = (id: string, result: unknown, token: string) =>
        hosted.handle(jsonRequest("/api/browser-host/result", {
          turnId: started.turnId,
          token,
          id,
          result,
        }));

      const forged = await post(
        "1",
        { status: "ok", page: PAGE },
        "not-the-token",
      );
      const unknown = await post(
        "2",
        { status: "ok", page: PAGE },
        started.browserHostToken,
      );
      const malformed = await post(
        "1",
        { status: "ok" },
        started.browserHostToken,
      );
      await readUntil(reader, "event: close");
      await hosted.service.waitForTurn(started.sessionId, started.turnId);

      expect(forged.status).toBe(404);
      await forged.body?.cancel();
      expect(unknown.status).toBe(404);
      await unknown.body?.cancel();
      expect(malformed.status).toBe(400);
      await malformed.body?.cancel();
      expect(results).toEqual([{
        status: "failed",
        message:
          "the browser host answered with something that is not a result",
      }]);
    });

    it("ends a turn's channel when the turn ends before its start returns, and when it fails to start or throws", async () => {
      const attached: (HarnessBrowserHost | undefined)[] = [];
      /** A service whose turn ends inside its own start, or never starts. */
      class ShortTurnService extends HarnessInteractiveChatService {
        readonly #onEvent: HarnessInteractiveChatEventListener;
        readonly #start: "ends" | "refuses" | "throws";

        constructor(
          onEvent: HarnessInteractiveChatEventListener,
          start: "ends" | "refuses" | "throws",
        ) {
          super({
            createPromptLoop: () => {
              throw new Error("no turn runs here");
            },
            onEvent,
          });
          this.#onEvent = onEvent;
          this.#start = start;
        }

        override async startTurn(
          requestId: string,
          params: HarnessChatStartTurnParams,
          extra: { browserHost?: HarnessBrowserHost } = {},
        ): Promise<HarnessChatResponse<HarnessChatTurnStatus>> {
          attached.push(extra.browserHost);
          const turnId = params.turnId ?? "";
          if (this.#start === "throws") {
            throw new Error("this turn could not be started");
          }
          if (this.#start === "refuses") {
            return createHarnessChatErrorResponse(requestId, {
              code: "invalid_request",
              message: "this turn does not start",
            });
          }
          await this.#onEvent(createHarnessChatEventEnvelope({
            sessionId: params.sessionId,
            turnId,
            sequence: 1,
            event: { kind: "turn_canceled", turnId },
          }));
          const at = new Date().toISOString();
          return createHarnessChatOkResponse(requestId, {
            turnId,
            status: "canceled",
            startedAt: at,
            updatedAt: at,
          });
        }
      }
      const task = async (start: "ends" | "refuses" | "throws") => {
        const shortTurns = new ConsoleServer(
          await configWithBrowserHost(),
          (onEvent) => new ShortTurnService(onEvent, start),
        );
        const response = await shortTurns.handle(jsonRequest("/api/task", {
          text: "use the web",
          browserHost: {},
        }));
        return { server: shortTurns, response };
      };

      const ended = await task("ends");
      const started = await ended.response.json();
      const attach = await ended.server.handle(
        jsonRequest("/api/browser-host/stream", {
          turnId: started.turnId,
          token: started.browserHostToken,
        }),
      );
      const refused = await task("refuses");
      await refused.response.body?.cancel();
      await expect(task("throws")).rejects.toThrow(
        "this turn could not be started",
      );

      expect(attach.status).toBe(404);
      await attach.body?.cancel();
      expect(refused.response.ok).toBe(false);
      expect(attached).toHaveLength(3);
      for (const host of attached) {
        expect(await host?.perform({ action: "reload" })).toEqual({
          status: "session-ended",
          message: "the turn has ended",
        });
      }
    });

    it("ends the run's outstanding operation when the host's stream ends", async () => {
      const { server: hosted, results } = await hostedServer();
      const started = await (await hosted.handle(jsonRequest("/api/task", {
        text: "use the web",
        browserHost: {},
      }))).json();
      const stream = await hosted.handle(
        jsonRequest("/api/browser-host/stream", {
          turnId: started.turnId,
          token: started.browserHostToken,
        }),
      );
      const reader = stream.body!.getReader();
      await readUntil(reader, "event: request");

      await reader.cancel();
      await hosted.service.waitForTurn(started.sessionId, started.turnId);

      expect(results).toEqual([{
        status: "session-ended",
        message: "the browser host's connection ended",
      }]);
    });
  });
});

interface StreamedEnvelope {
  sessionId: string;
  sequence: number;
  event: { kind: string; result?: unknown };
}

/**
 * The envelopes a stream writes up to and including the one of `finalKind`.
 * The reader resolves on each chunk the server enqueues, so the read ends when
 * the replay reaches that event rather than after any span of time.
 */
const envelopesUntil = async (
  response: Response,
  finalKind: string,
): Promise<readonly StreamedEnvelope[]> => {
  const reader = response.body!.pipeThrough(new TextDecoderStream())
    .getReader();
  const envelopes: StreamedEnvelope[] = [];
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return envelopes;
      }
      buffered += chunk.value;
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) =>
          line.startsWith("data: ")
        );
        if (data === undefined || !frame.startsWith("event: chat")) {
          continue;
        }
        const envelope: StreamedEnvelope = JSON.parse(data.slice(6));
        envelopes.push(envelope);
        if (envelope.event.kind === finalKind) {
          return envelopes;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
};

const kindsUntil = async (
  response: Response,
  finalKind: string,
): Promise<readonly string[]> =>
  (await envelopesUntil(response, finalKind)).map((envelope) =>
    envelope.event.kind
  );
