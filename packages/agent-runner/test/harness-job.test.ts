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
        env: {
          CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
          CF_HARNESS_GATEWAY_AUTH_MODE: "none",
          // Named, so a job selects the same sandbox on every machine: a Mac
          // otherwise takes the native runtime, from a store this has none of.
          CF_HARNESS_SANDBOX_RUNTIME: "docker",
        },
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
              CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
              CF_HARNESS_GATEWAY_AUTH_MODE: "none",
              CF_HARNESS_SANDBOX_RUNTIME: "docker",
              CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR: join(
                runRoot,
                "contexts",
              ),
              CF_HARNESS_RUNSC_CFC_RESULT_DIR: join(runRoot, "results"),
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
        // The job's argument list is written for it, so the way to Docker it
        // is told is the variable, and no flag.
        expect(refusal).toContain(
          "select Docker with `CF_HARNESS_SANDBOX_RUNTIME=docker`.",
        );
        expect(refusal).not.toContain("--sandbox-runtime");
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
      expect(result.report?.modelTurns).toBe(2);
      expect(reported.join("\n")).not.toBe("");
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
      platform: "darwin",
      env: { CF_HARNESS_SANDBOX_RUNTIME: "docker" },
    });

    expect(selection.sandboxRuntimeChoice).toEqual({
      runtime: "docker",
      source: "environment",
    });
  });

  it("takes Docker by default off macOS", async () => {
    const selection = await selectHarnessJobSandboxRuntime({
      platform: "linux",
      env: {},
    });

    expect(selection.sandboxRuntimeChoice).toEqual({
      runtime: "docker",
      source: "default",
      platform: "linux",
    });
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
