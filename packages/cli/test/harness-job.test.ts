import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
} from "@commonfabric/cf-harness/prompt-loop";
import type { HarnessTranscriptEvent } from "@commonfabric/cf-harness/contracts/transcript";
import { renderCellReference } from "@commonfabric/runner/shared";

import { type HarnessJobSpec, runHarnessJob } from "../lib/harness-job.ts";

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
    }) => Promise<HarnessPromptLoopResult>,
    options: {
      signal?: AbortSignal;
      onEvent?: (event: HarnessTranscriptEvent) => void;
      report?: (message: string) => void;
    } = {},
  ) => {
    const seen: Seen = {};
    const result = await runHarnessJob(spec, {
      runRoot,
      signal: options.signal ?? new AbortController().signal,
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
      ...(options.report !== undefined ? { report: options.report } : {}),
      harnessDeps: {
        env: {
          CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
          CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        },
        fabricSessionFactory: () =>
          Promise.reject(new Error("this job opens no fabric session")),
        createPromptLoop: (loopOptions) => {
          seen.loopOptions = loopOptions;
          return {
            runPrompt: (prompt) => {
              seen.prompt = prompt.prompt;
              seen.systemPrompt = prompt.systemPrompt;
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

    it("ends `failed` with its report when the model submitted no result", async () => {
      const reported: string[] = [];
      const { result } = await runScripted(
        plainSpec(),
        () => Promise.resolve(loopResult(runRoot)),
        { report: (message) => reported.push(message) },
      );

      expect(result.outcome).toBe("failed");
      if (result.outcome !== "failed") throw new Error("unreachable");
      expect(result.errorCode).toBe("PROVIDER_FAILURE");
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
