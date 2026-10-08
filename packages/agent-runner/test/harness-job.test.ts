import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
} from "@commonfabric/cf-harness/prompt-loop";
import type {
  HarnessTranscriptEvent,
  HarnessTranscriptMessage,
} from "@commonfabric/cf-harness/contracts/transcript";
import { HarnessControlError } from "@commonfabric/cf-harness/control-errors";
import { renderCellReference } from "@commonfabric/runner/shared";

import {
  type HarnessJobSpec,
  readHarnessJobTranscript,
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
  role?: string;
  systemPrompt?: string;
  contextMessages?: readonly string[];
  maxModelTurns?: number;
  signal?: AbortSignal;

  /** The transcript the loop was started from, when it was given one. */
  transcript?: readonly HarnessTranscriptMessage[];

  openingResearchTask?: string;
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
              seen.systemPrompt = prompt.systemPrompt;
              seen.contextMessages = prompt.contextMessages;
              seen.maxModelTurns = prompt.maxModelTurns ??
                loopOptions.maxModelTurns;
              seen.role = prompt.promptSlotBinding?.role;
              seen.signal = prompt.signal;
              return script({
                resultPath: join(runRoot, "workspace", "agent-result.json"),
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
            runTranscript: (run) => {
              seen.transcript = run.transcript;
              seen.openingResearchTask = run.openingResearchTask;
              seen.maxModelTurns = run.maxModelTurns ??
                loopOptions.maxModelTurns;
              seen.role = run.promptSlotBinding?.role;
              seen.signal = run.signal;
              return script({
                resultPath: join(runRoot, "workspace", "agent-result.json"),
                // As the loop does: the transcript it starts from, replayed,
                // then a message of its own.
                emit: async () => {
                  const message = {
                    role: "assistant",
                    content: "Looking.",
                  } as HarnessTranscriptEvent["message"];
                  const transcript = [...run.transcript, message];
                  for (const replayed of run.transcript) {
                    await run.onTranscriptEvent?.({
                      message: replayed,
                      transcript: run.transcript,
                    });
                  }
                  await run.onTranscriptEvent?.({ message, transcript });
                },
              });
            },
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

    it("ends `cancelled` when its signal aborted", async () => {
      const controller = new AbortController();
      const { result } = await runScripted(
        plainSpec(),
        async (context) => {
          controller.abort();
          return await answering("Titan")(context);
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

  describe("continuing earlier history", () => {
    /** An earlier job's history. */
    const PRIOR: HarnessTranscriptMessage[] = [
      { role: "user", content: "Name a moon of Saturn." },
      { role: "assistant", content: "Titan." },
    ];

    it("starts the loop from a fresh job's system prompt, the history, then a fresh job's context and task, under the task's role and turn cap", async () => {
      const controller = new AbortController();
      const spec = plainSpec({
        task: "And another?",
        instructions: "Answer briefly.",
        maxModelTurns: 6,
      });
      const fresh = (await runScripted(spec, answering("Titan"))).seen;
      const { result, seen } = await runScripted(
        { ...spec, priorTranscript: PRIOR },
        answering("Rhea"),
        { signal: controller.signal },
      );

      expect(result).toMatchObject({
        outcome: "completed",
        structuredResult: { answer: "Rhea" },
      });
      expect(seen.prompt).toBeUndefined();
      const [system, ...rest] = seen.transcript!;
      expect(system).toEqual({ role: "system", content: fresh.systemPrompt });
      expect(fresh.systemPrompt).toContain("Answer briefly.");
      expect(rest).toEqual([
        ...PRIOR,
        ...fresh.contextMessages!.map((content) => ({ role: "user", content })),
        { role: "user", content: "And another?" },
      ]);
      // The history's own messages, so whatever the host recorded on them
      // travels with them.
      expect(rest[0]).toBe(PRIOR[0]);
      expect(seen.openingResearchTask).toBe("And another?");
      expect(seen.role).toBe("direct-command");
      expect(seen.maxModelTurns).toBe(6);
      expect(seen.signal).toBe(controller.signal);
    });

    it("tells the caller of the job's own transcript events and none of the history's", async () => {
      const told: HarnessTranscriptMessage[] = [];
      const { result } = await runScripted(
        plainSpec({ priorTranscript: PRIOR }),
        async (context) => {
          await context.emit();
          return await answering("Rhea")(context);
        },
        { onEvent: (event) => void told.push(event.message) },
      );

      expect(result.outcome).toBe("completed");
      expect(told).not.toContain(PRIOR[0]);
      expect(told).not.toContain(PRIOR[1]);
      expect(told.map((message) => message.role)).toContain("system");
      expect(told.slice(-2).map((message) => message.content)).toEqual([
        plainSpec().task,
        "Looking.",
      ]);
    });

    it("starts a job with no history from its prompt, as before", async () => {
      const { seen } = await runScripted(plainSpec(), answering("Titan"));

      expect(seen.prompt).toBe(plainSpec().task);
      expect(seen.transcript).toBeUndefined();
    });
  });
});

describe("readHarnessJobTranscript()", () => {
  let runRoot: string;

  beforeEach(async () => {
    runRoot = await Deno.makeTempDir({ prefix: "harness-job-transcript-" });
  });

  afterEach(async () => {
    await Deno.remove(runRoot, { recursive: true });
  });

  /** A run's transcript. */
  const TRANSCRIPT: HarnessTranscriptMessage[] = [
    { role: "system", content: "Answer briefly." },
    { role: "user", content: "Name a moon of Saturn." },
  ];

  /** Helper for tests, which writes `files` under the job's artifacts. */
  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      const full = join(runRoot, "artifacts", path);
      await Deno.mkdir(join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, text);
    }
  };

  it("reads the job's own run's transcript, not a delegated child's", async () => {
    await write({
      "run-1/transcript.json": JSON.stringify(TRANSCRIPT),
      "run-1.subagent.1/transcript.json": "[]",
      ".acquired-skills/run-1/skill.json": "{}",
    });

    expect(await readHarnessJobTranscript(runRoot)).toEqual(TRANSCRIPT);
  });

  it("returns `undefined` for a job whose run left no artifacts, no run, or no transcript", async () => {
    expect(await readHarnessJobTranscript(runRoot)).toBeUndefined();
    await Deno.mkdir(join(runRoot, "artifacts"));
    expect(await readHarnessJobTranscript(runRoot)).toBeUndefined();
    await write({ "run-1/run-state.json": "{}" });
    expect(await readHarnessJobTranscript(runRoot)).toBeUndefined();
  });

  it("throws for an artifacts directory it cannot list", async () => {
    await Deno.writeTextFile(join(runRoot, "artifacts"), "");

    await expect(readHarnessJobTranscript(runRoot)).rejects.toThrow();
  });

  it("throws for a transcript, or omission records, it cannot read, and for more than one run", async () => {
    await write({ "run-1/transcript.json": "{}" });
    await expect(readHarnessJobTranscript(runRoot)).rejects.toThrow(
      "holds no transcript",
    );
    await write({
      "run-1/transcript.json": JSON.stringify(TRANSCRIPT),
      "run-1/transcript-omissions.json": '{"type":"other"}',
    });
    await expect(readHarnessJobTranscript(runRoot)).rejects.toThrow(
      "transcript-omissions.json is not readable",
    );
    await write({ "run-1/transcript-omissions.json": "{ not json" });
    await expect(readHarnessJobTranscript(runRoot)).rejects.toThrow(
      SyntaxError,
    );
    await write({ "run-2/transcript.json": "[]" });
    await expect(readHarnessJobTranscript(runRoot)).rejects.toThrow(
      "holds 2 runs",
    );
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
