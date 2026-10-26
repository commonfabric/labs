import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessPromptLoopResult,
} from "@commonfabric/cf-harness/prompt-loop";
import type { HarnessModelUsage } from "@commonfabric/cf-harness/model/client";
import type { HarnessImageAttachment } from "@commonfabric/cf-harness/contracts/image";
import { materializeImageAttachmentContentPart } from "@commonfabric/cf-harness/image-attachments";
import type { HarnessTranscriptEvent } from "@commonfabric/cf-harness/contracts/transcript";
import { HarnessControlError } from "@commonfabric/cf-harness/control-errors";
import { renderCellReference } from "@commonfabric/runner/shared";

import {
  HARNESS_JOB_GRANT_ENV_KEYS,
  type HarnessJobSpec,
  runHarnessJob,
  selectHarnessJobSandboxRuntime,
} from "../src/harness-job.ts";
import { LocalJobBrowserHost } from "../src/local-jobs/browser-host.ts";

/** The space a fabric job names. */
const SPACE = "did:key:z6MkgUiiZvP3qYQqr1NWyS2uCpny8dejAvyuBZh2PAVACs97";

/** A spec with no fabric part: plain inputs only. */
const plainSpec = (
  overrides: Partial<HarnessJobSpec> = {},
): HarnessJobSpec => ({
  task: "Name a moon of Saturn.",
  taskRole: "direct-command",
  resultSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
  tools: ["web_fetch"],
  model: "scripted",
  ...overrides,
});

/** The environment a scripted job's harness reads. */
const SCRIPTED_ENV = {
  CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
  CF_HARNESS_GATEWAY_AUTH_MODE: "none",
  // Named, with a `runsc` and a rootfs nothing runs, so a job selects
  // the same sandbox on every machine: macOS and Linux otherwise take
  // the native runtime, from a store this has none of.
  CF_HARNESS_SANDBOX_RUNTIME: "runsc",
  CF_HARNESS_RUNSC_BINARY: "/nonexistent/harness-job-test/runsc",
  CF_HARNESS_SANDBOX_ROOTFS: "/nonexistent/harness-job-test/rootfs",
};

/** What the scripted loop saw of one job. */
interface Seen {
  loopOptions?: CreateHarnessPromptLoopOptions;
  prompt?: string;
  images?: readonly HarnessImageAttachment[];
  role?: string;
  systemPrompt?: string;
  maxModelTurns?: number;
  signal?: AbortSignal;
}

/** The loop result a scripted job hands back. */
const loopResult = (
  runRoot: string,
  overrides: Partial<HarnessPromptLoopResult> = {},
): HarnessPromptLoopResult => ({
  model: "scripted",
  finalAssistantText: "Done.",
  transcript: [],
  modelTurns: 2,
  usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  runState: {
    runId: "job-run",
    status: "completed",
    createdAt: "2026-10-05T12:00:00.000Z",
    updatedAt: "2026-10-05T12:00:01.000Z",
    cfcEnforcementMode: "disabled",
    currentDir: "/workspace",
    policyEvents: [],
    toolOutputs: [{}],
    artifactRoot: join(runRoot, "artifacts"),
  } as unknown as HarnessPromptLoopResult["runState"],
  ...overrides,
});

describe("runHarnessJob()", () => {
  let runRoot: string;

  beforeEach(async () => {
    runRoot = await Deno.makeTempDir({ prefix: "harness-job-test-" });
  });

  afterEach(async () => {
    await Deno.remove(runRoot, { recursive: true });
  });

  /**
   * Helper for tests, which runs `spec` with a scripted loop in place of the
   * model and returns the job's result and what the loop saw.
   */
  const runScripted = async (
    spec: HarnessJobSpec,
    script: (context: {
      resultPath: string;
      emit: () => Promise<void>;
      emitUsage: (usage: HarnessModelUsage) => Promise<void>;
    }) => Promise<HarnessPromptLoopResult>,
    options: {
      signal?: AbortSignal;
      onEvent?: (event: HarnessTranscriptEvent) => void;
      report?: (message: string) => void;
      browserHost?: LocalJobBrowserHost;

      /** Leaves the harness to read the process's environment. */
      processEnv?: boolean;

      /** Classifies the task with a real loop on the job's own engine. */
      classify?: boolean;
    } = {},
  ) => {
    const seen: Seen = {};
    const result = await runHarnessJob(spec, {
      runRoot,
      signal: options.signal ?? new AbortController().signal,
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
      ...(options.report !== undefined ? { report: options.report } : {}),
      ...(options.browserHost !== undefined
        ? { browserHost: options.browserHost }
        : {}),
      harnessDeps: {
        ...(options.processEnv === true ? {} : { env: SCRIPTED_ENV }),
        fabricSessionFactory: () =>
          Promise.reject(new Error("this job opens no fabric session")),
        createPromptLoop: (loopOptions) => {
          seen.loopOptions = loopOptions;
          return {
            runPrompt: (prompt) => {
              seen.prompt = prompt.prompt;
              seen.images = prompt.imageAttachments;
              seen.systemPrompt = prompt.systemPrompt;
              seen.maxModelTurns = prompt.maxModelTurns ??
                loopOptions.maxModelTurns;
              seen.role = prompt.promptSlotBinding?.role;
              seen.signal = prompt.signal;
              return script({
                resultPath: join(runRoot, "workspace", "agent-result.json"),
                emitUsage: async (usage) => {
                  await prompt.onModelUsage?.({ usage, totalUsage: usage });
                },
                emit: async () => {
                  const message = {
                    role: "assistant",
                    content: "Looking.",
                  } as HarnessTranscriptEvent["message"];
                  await prompt.onTranscriptEvent?.({
                    message,
                    transcript: [message],
                  });
                },
              });
            },
            runTranscript: () => Promise.reject(new Error("not a resume")),
            ...(options.classify
              ? {
                classifyTask: (task: string) =>
                  new CfHarnessPromptLoop(loopOptions).classifyTask(task),
              }
              : {}),
          };
        },
      },
    });
    return { result, seen };
  };

  /** A script that submits `answer` and completes. */
  const answering =
    (answer: string) => async ({ resultPath }: { resultPath: string }) => {
      await Deno.writeTextFile(resultPath, JSON.stringify({ answer }));
      return loopResult(runRoot);
    };

  for (const valid of [true, false]) {
    it(`keeps the real loop's final-turn ${valid ? "submission" : "failure report"}`, async () => {
      let calls = 0;
      const reported: string[] = [];
      const result = await runHarnessJob(
        plainSpec({ tools: [], maxModelTurns: 1 }),
        {
          runRoot,
          report: (line) => reported.push(line),
          signal: new AbortController().signal,
          harnessDeps: {
            env: {
              ...SCRIPTED_ENV,
              // The real loop refuses an enforcing run without a policy; it
              // is never read, since nothing here starts the sandbox.
              CF_HARNESS_RUNSC_CFC_POLICY:
                "/nonexistent/harness-job-test/policy.json",
            },
            createPromptLoop: (options) =>
              new CfHarnessPromptLoop({
                ...options,
                modelClient: {
                  providerId: "fixture",
                  complete: () => {
                    calls++;
                    return Promise.resolve({
                      assistant: {
                        role: "assistant",
                        content: "",
                        toolCalls: [{
                          id: "submit-one",
                          type: "function",
                          function: {
                            name: "submit_result",
                            arguments: JSON.stringify({
                              result: valid
                                ? { answer: "Titan" }
                                : { wrong: true },
                            }),
                          },
                        }],
                      },
                      usage: { totalTokens: 17 },
                    });
                  },
                },
              }),
          },
        },
      );
      if (calls === 0) throw new Error(reported.join("\n"));
      expect(calls).toBe(1);
      expect(result.outcome).toBe(valid ? "completed" : "failed");
      if (!valid) expect(result).toMatchObject({ errorCode: "LIMIT_REACHED" });
      expect(result.report).toMatchObject({
        modelTurns: 1,
        toolCalls: 1,
        usage: { totalTokens: 17 },
        usageCoverage: "including-descendants",
      });
    });
  }

  it("snapshots inline image bytes inside the job workspace and sends the image to the model", async () => {
    const image = { mediaType: "image/png", base64: "iVBORw0KGgo=" } as const;
    const { seen } = await runScripted(
      plainSpec({ imageAttachments: [image] }),
      answering("Titan"),
    );
    expect(seen.images).toHaveLength(1);
    const attachment = seen.images![0];
    expect(
      attachment.hostPath.startsWith(
        await Deno.realPath(join(runRoot, "workspace", ".job-images")) + "/",
      ),
    ).toBe(true);
    expect(await materializeImageAttachmentContentPart(attachment))
      .toMatchObject({
        type: "image_url",
        image_url: { url: "data:image/png;base64," + image.base64 },
      });
    expect(attachment.digest).toMatch(/^sha256:/);
  });

  it("passes model ceilings into the loop's shared model client", async () => {
    const { seen } = await runScripted(
      plainSpec({ maxInputBytes: 65536, maxOutputTokens: 8192 }),
      answering("Titan"),
    );
    expect(seen.loopOptions).toMatchObject({
      maxInputBytes: 65536,
      maxOutputTokens: 8192,
      stopOnStructuredResult: true,
    });
  });

  it("passes the trusted job identity through the commands config into the harness", async () => {
    const configPath = join(runRoot, "commands.json");
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        cliPath: "/trusted/loom",
        transport: { kind: "broker", queuePath: "/trusted/queue" },
        jobIdEnvVar: "HOST_JOB_ID",
        jobId: "untrusted-file-id",
      }),
    );
    const { result, seen } = await runScripted(
      plainSpec({
        tools: ["list_commands", "run_command"],
        loomCommandsConfigPath: configPath,
        commandJobId: "job-own-id",
      }),
      answering("Titan"),
    );
    expect(result.outcome).toBe("completed");
    expect(seen.loopOptions!.loomCommands).toMatchObject({
      jobIdEnvVar: "HOST_JOB_ID",
      jobId: "job-own-id",
    });
  });

  it("hands a browser host to the run's engine, with the subagent profiles the spec allows", async () => {
    const host = new LocalJobBrowserHost();
    const { result, seen } = await runScripted(
      plainSpec({
        tools: ["web_fetch", "delegate_task"],
        subagentProfiles: ["browser"],
      }),
      answering("Titan"),
      { browserHost: host },
    );
    expect(result.outcome).toBe("completed");
    expect(seen.loopOptions?.engine?.browserHost).toBe(host);
    expect(seen.loopOptions?.allowedSubagentProfiles).toEqual(["browser"]);
    expect(seen.loopOptions?.allowedToolIds).toEqual([
      "web_fetch",
      "delegate_task",
      "submit_result",
    ]);
  });

  it("takes no grant from the runner's environment, and keeps its model settings", async () => {
    const set = {
      ...SCRIPTED_ENV,
      CF_HARNESS_MODEL: "from-the-environment",
      ...Object.fromEntries(
        HARNESS_JOB_GRANT_ENV_KEYS.map((key) => [key, `/granted/${key}`]),
      ),
      CF_HARNESS_FABRIC_API_URL: "https://toolshed.example",
      CF_HARNESS_FABRIC_SPACE: SPACE,
      CF_HARNESS_FABRIC_FOREIGN_SPACES: "did:key:z6MkforeignSpace",
      CF_HARNESS_PATTERN_INDEX_URL: "https://index.example",
      CF_HARNESS_CFC_ENFORCEMENT_MODE: "disabled",
      CF_CFC_MODE: "disabled",
    };
    const before = Object.fromEntries(
      Object.keys(set).map((key) => [key, Deno.env.get(key)]),
    );
    for (const [key, value] of Object.entries(set)) Deno.env.set(key, value);
    try {
      const { result, seen } = await runScripted(
        plainSpec({ model: undefined }),
        answering("Titan"),
        { processEnv: true },
      );

      expect(result.outcome).toBe("completed");
      expect(seen.loopOptions?.model).toBe("from-the-environment");
      expect(seen.loopOptions?.fabricSession).toBeUndefined();
      expect(seen.loopOptions?.engine?.config.patternIndex).toBeUndefined();
      expect(seen.loopOptions?.loomRetrieval).toBeUndefined();
      expect(seen.loopOptions?.loomCommands).toBeUndefined();
      // An inherited `disabled` would let a `context` task use write tools.
      expect(seen.loopOptions?.cfcEnforcementModeOverride).toBe(
        "enforce-explicit",
      );
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });

  it("allows no subagent profile and hands no host when the spec names none", async () => {
    const { seen } = await runScripted(plainSpec(), answering("Titan"));
    expect(seen.loopOptions?.engine?.browserHost).toBeUndefined();
    expect(seen.loopOptions?.allowedSubagentProfiles).toEqual([]);
  });

  describe("with plain inputs and no fabric", () => {
    it("returns the submitted value, the job's handles, and its report", async () => {
      const { result, seen } = await runScripted(
        plainSpec(),
        answering("Titan"),
      );

      expect(result.outcome).toBe("completed");
      if (result.outcome !== "completed") throw new Error("unreachable");
      expect(result.structuredResult).toEqual({ answer: "Titan" });
      expect(result.handleTable.salt).toBe("job-run");
      expect(result.handleTable.entries).toEqual([]);
      expect(result.report).toEqual({
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        usageCoverage: "direct",
        modelTurns: 2,
        toolCalls: 1,
        runRef: join(runRoot, "artifacts"),
      });
      expect(seen.prompt).toBe("Name a moon of Saturn.");
      expect(seen.loopOptions?.allowedToolIds).toEqual([
        "web_fetch",
        "submit_result",
      ]);
      expect(seen.loopOptions?.model).toBe("scripted");
    });

    it("records the task's classification in the job's run state and orients the prompt by it", async () => {
      const { result, seen } = await runScripted(
        plainSpec({ task: "what's on Thursday?" }),
        answering("Nothing."),
        { classify: true },
      );

      expect(result.outcome).toBe("completed");
      expect(seen.loopOptions?.engine?.getRunState().taskClassification)
        .toMatchObject({ tags: ["find"], path: "rule" });
      expect(seen.systemPrompt).not.toContain("When you delegate");
    });

    it("passes no fabric session and no input cell", async () => {
      const { result, seen } = await runScripted(
        plainSpec(),
        answering("Titan"),
      );

      expect(result.outcome).toBe("completed");
      expect(seen.loopOptions?.fabricSession).toBeUndefined();
      expect(seen.loopOptions?.inputCells ?? []).toEqual([]);
    });

    it("leaves the model to the harness's own configuration when the spec names none", async () => {
      const { seen } = await runScripted(
        plainSpec({ model: undefined }),
        answering("Titan"),
      );

      expect(seen.loopOptions?.model).not.toBe("scripted");
    });

    it("reports usage including descendants when the loop totals it", async () => {
      const { result } = await runScripted(plainSpec(), async (context) => {
        await answering("Titan")(context);
        return loopResult(runRoot, {
          totalUsage: { inputTokens: 30, outputTokens: 9, totalTokens: 39 },
          runState: {
            ...loopResult(runRoot).runState,
            handleTable: undefined,
            artifactRoot: undefined,
          } as unknown as HarnessPromptLoopResult["runState"],
        });
      });

      expect(result.report).toEqual({
        usage: { inputTokens: 30, outputTokens: 9, totalTokens: 39 },
        usageCoverage: "including-descendants",
        modelTurns: 2,
        toolCalls: 1,
      });
    });

    it("gives the harness the spec's instructions and turn cap, and neither when the spec names none", async () => {
      const { seen } = await runScripted(
        plainSpec({ instructions: "Answer in one word.", maxModelTurns: 6 }),
        answering("Titan"),
      );
      const plain = await runScripted(plainSpec(), answering("Titan"));

      expect(seen.systemPrompt).toContain("Answer in one word.");
      expect(seen.maxModelTurns).toBe(6);
      expect(plain.seen.systemPrompt ?? "").not.toContain(
        "Answer in one word.",
      );
      expect(plain.seen.maxModelTurns).not.toBe(6);
    });

    it("gives the harness the spec's task tags and domains, an empty list as none", async () => {
      const { seen } = await runScripted(
        plainSpec({ taskTags: ["find"], taskDomains: [] }),
        answering("Titan"),
      );
      const plain = await runScripted(plainSpec(), answering("Titan"));

      expect(seen.loopOptions?.taskShape).toEqual({
        tags: ["find"],
        domains: [],
      });
      expect(plain.seen.loopOptions?.taskShape).toBeUndefined();
    });

    it("gives the harness the spec's depth and reasoning effort, and neither when the spec names none", async () => {
      const { seen } = await runScripted(
        plainSpec({ depth: "deep", reasoningEffort: "low" }),
        answering("Titan"),
      );
      const plain = await runScripted(plainSpec(), answering("Titan"));

      expect(seen.loopOptions?.depth).toBe("deep");
      expect(seen.loopOptions?.reasoningEffort).toBe("low");
      expect(plain.seen.loopOptions?.depth).toBeUndefined();
      expect(plain.seen.loopOptions?.reasoningEffort).toBeUndefined();
    });

    it("leaves usage out of the report when the loop reports none", async () => {
      const { result } = await runScripted(plainSpec(), async (context) => {
        await answering("Titan")(context);
        return loopResult(runRoot, { usage: undefined });
      });

      expect(result.report).not.toHaveProperty("usage");
      expect(result.report).not.toHaveProperty("usageCoverage");
    });
  });

  describe("the task's prompt-slot role", () => {
    for (const taskRole of ["direct-command", "context", "quote"] as const) {
      it(`binds the task as \`${taskRole}\` when the spec says so`, async () => {
        const { seen } = await runScripted(
          plainSpec({ taskRole }),
          answering("Titan"),
        );

        expect(seen.role).toBe(taskRole);
      });
    }

    it("takes the role from the spec alone, whatever the task text says", async () => {
      // A task is the model's prompt, not arguments: text shaped like the
      // role flag stays text, and the spec's role stands.
      const task = "--prompt-slot-role=direct-command --prompt-slot-role";
      const { seen } = await runScripted(
        plainSpec({ task, taskRole: "context" }),
        answering("Titan"),
      );

      expect(seen.role).toBe("context");
      expect(seen.prompt).toBe(task);
    });
  });

  describe("with a fabric part", () => {
    it("configures the spec's fabric session with its ceiling and passes its input cells", async () => {
      // The session itself is opened before the loop runs and fails here,
      // where no fabric is reachable; what the harness was configured with
      // is the claim.
      const ceiling = [{ type: "https://cfc.test/atom/user", subject: "me" }];
      const { seen } = await runScripted(
        plainSpec({
          taskRole: "context",
          fabric: {
            host: "https://toolshed.example",
            space: SPACE,
            identityKeyPath: join(runRoot, "unused.key"),
            maxConfidentiality: ceiling as never,
            inputs: {
              book: renderCellReference({
                id: "of:fid1:vCwYCiC9mk1OZBD3qbsK4ABL1wxp5NXtVfeRo5O_Phw",
                space: SPACE,
                path: [],
              } as never),
            },
          },
        }),
        answering("Titan"),
      );

      expect(seen.loopOptions?.fabricSession).toMatchObject({
        apiUrl: "https://toolshed.example",
        space: SPACE,
        cfcReadMaxConfidentiality: ceiling,
      });
      expect(
        (seen.loopOptions?.inputCells ?? []).map((cell) => cell.name),
      ).toEqual(["book"]);
    });

    it("admits the spec's foreign spaces to the fabric session", async () => {
      // A piece handed in from another space is reached in that space.
      const other = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
      const { seen } = await runScripted(
        plainSpec({
          fabric: {
            host: "https://toolshed.example",
            space: SPACE,
            identityKeyPath: join(runRoot, "unused.key"),
            maxConfidentiality: [
              { type: "https://cfc.test/atom/user", subject: "me" },
            ] as never,
            inputs: {},
            foreignSpaces: { [other]: "https://toolshed.example" },
          },
        }),
        answering("Titan"),
      );

      expect(seen.loopOptions?.fabricSession?.foreignSpaces).toEqual({
        [other]: "https://toolshed.example/",
      });
    });

    /** A fabric part with no input cells, as a local job's is. */
    const localFabric = () => ({
      host: "https://toolshed.example",
      space: SPACE,
      identityKeyPath: join(runRoot, "unused.key"),
      maxConfidentiality: [
        { type: "https://cfc.test/atom/user", subject: "me" },
      ] as never,
      inputs: {},
    });

    it("configures the spec's pattern index, publishing unless the spec says not to", async () => {
      for (
        const [publish, expected] of [
          [undefined, { baseUrl: "https://index.example" }],
          [true, { baseUrl: "https://index.example" }],
          [false, { baseUrl: "https://index.example", publish: false }],
        ] as const
      ) {
        const { seen } = await runScripted(
          plainSpec({
            tools: ["run_pattern", "search_patterns", "delegate_task"],
            subagentProfiles: ["default", "pattern-author"],
            fabric: localFabric(),
            patternIndexUrl: "https://index.example",
            ...(publish !== undefined ? { patternIndexPublish: publish } : {}),
          }),
          answering("Titan"),
        );

        expect(seen.loopOptions?.engine?.config.patternIndex).toEqual(
          expected,
        );
        expect(seen.loopOptions?.fabricSession).toMatchObject({
          apiUrl: "https://toolshed.example",
          space: SPACE,
        });
        expect(seen.loopOptions?.allowedSubagentProfiles).toEqual([
          "default",
          "pattern-author",
        ]);
        expect(seen.loopOptions?.allowedToolIds).toEqual([
          "run_pattern",
          "search_patterns",
          "delegate_task",
          "submit_result",
        ]);
      }
    });

    it("configures no pattern index for a spec that names none", async () => {
      const { seen } = await runScripted(
        plainSpec({ tools: ["run_pattern"], fabric: localFabric() }),
        answering("Titan"),
      );

      expect(seen.loopOptions?.engine?.config.patternIndex).toBeUndefined();
    });
  });

  describe("how a job ends", () => {
    it("retains observed model attribution in the public job report", async () => {
      const modelResponses = [
        { modelTurn: 1, model: "provider-served-model" },
        { modelTurn: 2, model: null },
      ];
      const { result } = await runScripted(plainSpec(), async (context) => ({
        ...await answering("Titan")(context),
        actualModels: ["provider-served-model"],
        modelAttributionComplete: false,
        modelResponses,
      }));
      expect(result.outcome).toBe("completed");
      expect(result.report).toMatchObject({
        actualModels: ["provider-served-model"],
        modelAttributionComplete: false,
        modelResponses,
      });
    });

    it("tells the caller of each transcript event before passing it on, and gives the loop the job's signal", async () => {
      const events: string[] = [];
      const controller = new AbortController();
      const { result, seen } = await runScripted(
        plainSpec(),
        async (context) => {
          await context.emit();
          return await answering("Titan")(context);
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            events.push(event.message.role);
          },
        },
      );

      expect(result.outcome).toBe("completed");
      expect(events).toEqual(["assistant"]);
      expect(seen.signal).toBe(controller.signal);
    });

    it("retains the completed loop report when cancellation wins before the job returns", async () => {
      const controller = new AbortController();
      const { result } = await runScripted(
        plainSpec(),
        async (context) => {
          controller.abort();
          return await answering("Titan")(context);
        },
        { signal: controller.signal },
      );

      expect(result).toEqual({
        outcome: "cancelled",
        report: {
          modelTurns: 2,
          toolCalls: 1,
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          usageCoverage: "direct",
          runRef: join(runRoot, "artifacts"),
        },
      });
    });

    for (const cancelled of [false, true]) {
      it(`retains partial usage when a paid loop ${cancelled ? "is cancelled" : "fails"}`, async () => {
        const controller = new AbortController();
        const { result } = await runScripted(
          plainSpec(),
          async ({ emitUsage }) => {
            await emitUsage({ totalTokens: 123 });
            if (cancelled) controller.abort();
            throw new Error("provider disconnected after usage");
          },
          { signal: controller.signal },
        );
        expect(result.outcome).toBe(cancelled ? "cancelled" : "failed");
        expect(result.report).toMatchObject({
          usage: { totalTokens: 123 },
          usageCoverage: "including-descendants",
          toolCalls: 0,
        });
        expect(result.report).not.toHaveProperty("modelTurns");
      });
    }

    it("keeps cancellation accounting absent when the loop supplied no measurements", async () => {
      const controller = new AbortController();
      const { result } = await runScripted(
        plainSpec(),
        () => {
          controller.abort();
          return Promise.reject(new Error("cancelled before a measured turn"));
        },
        { signal: controller.signal },
      );
      expect(result).toEqual({ outcome: "cancelled" });
    });

    it("ends `failed` as `LIMIT_REACHED` when the turn limit stopped the loop", async () => {
      const { result } = await runScripted(
        plainSpec(),
        () => Promise.reject(new Error("exceeded max model turns (8)")),
      );

      expect(result).toEqual({ outcome: "failed", errorCode: "LIMIT_REACHED" });
    });

    it("ends `failed` as `PROVIDER_FAILURE` when the loop failed any other way", async () => {
      const { result } = await runScripted(
        plainSpec(),
        () => Promise.reject(new Error("the provider answered 500")),
      );

      expect(result).toEqual({
        outcome: "failed",
        errorCode: "PROVIDER_FAILURE",
      });
    });

    for (
      const [given, flags] of [
        ["", {}],
        [", even where its caller's deps say flags can be passed", {
          sandboxSelectionFlags: true,
        }],
      ] as const
    ) {
      it(`ends \`failed\` as \`PROVIDER_FAILURE\`, reporting the harness's refusal naming the variable alone, where the harness refuses its sandbox${given}`, async () => {
        // A Mac with no native runtime set up, and no runtime named. By the
        // path the file system has for it: a home reached through a link is
        // refused for that before its store is looked at.
        const home = await Deno.realPath(runRoot);
        const reported: string[] = [];
        let looped = false;

        const result = await runHarnessJob(plainSpec(), {
          runRoot,
          signal: new AbortController().signal,
          report: (message) => reported.push(message),
          harnessDeps: {
            ...flags,
            env: {
              CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
              CF_HARNESS_GATEWAY_AUTH_MODE: "none",
              HOME: home,
            },
            platform: "darwin",
            arch: "aarch64",
            createPromptLoop: () => {
              looped = true;
              throw new Error("no loop is built for a refused job");
            },
          },
        });

        expect([result, looped]).toEqual([
          { outcome: "failed", errorCode: "PROVIDER_FAILURE" },
          false,
        ]);
        const refusal = reported.find((message) =>
          message.includes("No sandbox runtime is named")
        );
        // The job's argument list is written for it, so the way to a CFC
        // policy it is told is the variable, and no flag.
        expect(refusal).toContain(
          "(name one with `CF_HARNESS_RUNSC_CFC_POLICY`)",
        );
        expect(refusal).not.toContain("--sandbox-");
      });
    }

    it("ends `failed` as `INVALID_RESULT`, with its report, when the model submitted no result", async () => {
      const reported: string[] = [];
      const { result } = await runScripted(
        plainSpec(),
        () => Promise.resolve(loopResult(runRoot)),
        { report: (message) => reported.push(message) },
      );

      expect(result.outcome).toBe("failed");
      if (result.outcome !== "failed") throw new Error("unreachable");
      expect(result.errorCode).toBe("INVALID_RESULT");
      expect(result.errorDetail).toBe("no structured result was submitted");
      expect(result.report?.modelTurns).toBe(2);
      expect(reported.join("\n")).not.toBe("");
    });

    it("ends `failed` as `INVALID_RESULT` with the field and the reason, when the result does not match the schema", async () => {
      const { result } = await runScripted(
        plainSpec(),
        async ({ resultPath }) => {
          await Deno.writeTextFile(resultPath, JSON.stringify({ answer: 7 }));
          return loopResult(runRoot);
        },
      );

      expect(result).toMatchObject({
        outcome: "failed",
        errorCode: "INVALID_RESULT",
        errorDetail:
          "structured result did not match the schema: answer: value does not match type string",
      });
    });

    it("removes a result file an earlier job left before the job starts", async () => {
      await Deno.mkdir(join(runRoot, "workspace"), { recursive: true });
      await Deno.writeTextFile(
        join(runRoot, "workspace", "agent-result.json"),
        JSON.stringify({ answer: "stale" }),
      );

      const { result } = await runScripted(
        plainSpec(),
        () => Promise.resolve(loopResult(runRoot)),
      );

      expect(result.outcome).toBe("failed");
    });
  });
});

describe("selectHarnessJobSandboxRuntime()", () => {
  it("takes the runtime the environment names, on any platform", async () => {
    const selection = await selectHarnessJobSandboxRuntime({
      platform: "freebsd",
      env: { CF_HARNESS_SANDBOX_RUNTIME: "runsc" },
    });

    expect(selection.sandboxRuntimeChoice).toEqual({
      runtime: "runsc",
      source: "environment",
    });
  });

  it("refuses `docker` named in the environment, as every job would be refused, naming the variable alone", async () => {
    const refusal = await selectHarnessJobSandboxRuntime({
      platform: "darwin",
      env: { CF_HARNESS_SANDBOX_RUNTIME: "docker" },
    }).then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(HarnessControlError);
    expect(String(refusal)).toContain(
      "`CF_HARNESS_SANDBOX_RUNTIME=docker` names the Docker driver, which " +
        "this cf-harness no longer has",
    );
    expect(String(refusal)).not.toContain("--sandbox-runtime");
  });

  it("refuses, as every job would be refused, off macOS and Linux, where no runtime is the default", async () => {
    const refusal = await selectHarnessJobSandboxRuntime({
      platform: "freebsd",
      env: {},
    }).then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(HarnessControlError);
    expect(String(refusal)).toContain(
      "No sandbox runtime is named, and `freebsd` has no default",
    );
  });

  it("refuses, as every job would be refused, on Linux for a runner that is not root on a host that allows it no user namespace", async () => {
    const refusal = await selectHarnessJobSandboxRuntime({
      platform: "linux",
      uid: () => 1000,
      readSysctl: (name) =>
        Promise.resolve(
          name === "kernel.apparmor_restrict_unprivileged_userns"
            ? "1"
            : undefined,
        ),
      env: { HOME: "/home/runner" },
    }).then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(HarnessControlError);
    expect(String(refusal)).toContain(
      "this process is not root (uid 1000), so the store's `runsc` runs " +
        "rootless, in a user namespace of its own, and " +
        "`kernel.apparmor_restrict_unprivileged_userns` is 1",
    );
    // The runner writes the job's arguments itself, so it names no flag.
    expect(String(refusal)).not.toContain("--sandbox-runtime");
  });

  it("refuses, as every job would be refused, on a Mac whose native runtime is not set up", async () => {
    // By its real path: a store reached through a link is refused for that
    // before what it lacks is looked at.
    const home = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "harness-job-home-" }),
    );
    try {
      const refusal = await selectHarnessJobSandboxRuntime({
        platform: "darwin",
        arch: "aarch64",
        env: { HOME: home },
      }).then(() => undefined, (error: unknown) => error);

      expect(refusal).toBeInstanceOf(HarnessControlError);
      expect(String(refusal)).toMatch(
        /the native `runsc` runtime, and it is not set up at /,
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });
});
