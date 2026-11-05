import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type {
  HarnessAssistantTranscriptMessage,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

/** A workspace whose commands complete without starting a sandbox process. */
class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({
      stdout: request.command.includes(CAPABILITY_PROBE_SENTINEL)
        ? "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release"
        : "workspace output",
      stderr: "",
      exitCode: 0,
    });
  }
}

const finalTurn = (content: string): HarnessAssistantTranscriptMessage => ({
  role: "assistant",
  content,
});

const toolTurn = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): HarnessAssistantTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  }],
});

const inspectTurn = () => toolTurn("inspect", "bash", { command: "pwd" });
const submitTurn = (id: string, answer: string) =>
  toolTurn(id, "submit_result", { result: { answer } });
const promptSlotBinding = directPromptSlotBindingFor("prompt-loop-steer");

/** Captures each model request before the loop can append another message. */
const scriptedLoop = (
  turns: readonly (HarnessAssistantTranscriptMessage | Error)[],
  options: { engine?: CfHarnessEngine; stopOnStructuredResult?: boolean } = {},
) => {
  const requests: HarnessModelTurnRequest[] = [];
  const engine = options.engine ?? new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    model: "test-model",
  });
  const loop = new CfHarnessPromptLoop({
    engine,
    stopOnStructuredResult: options.stopOnStructuredResult,
    modelClient: {
      providerId: "test-provider",
      complete(request) {
        const response = turns[requests.length];
        requests.push({
          ...request,
          transcript: structuredClone(request.transcript),
        });
        if (response instanceof Error) throw response;
        if (response === undefined) throw new Error("No scripted turn remains");
        return Promise.resolve({ assistant: response });
      },
    },
  });
  return { loop, requests };
};

describe("prompt-loop", () => {
  describe("steering", () => {
    let dir: string;
    let resultPath: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "prompt-loop-steer-" });
      resultPath = join(dir, "result.json");
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    const resultEngine = () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        model: "test-model",
        structuredResult: {
          path: resultPath,
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      });

    it("appends pending messages verbatim after the first prompt", async () => {
      const { loop, requests } = scriptedLoop([finalTurn("Done")]);
      const calls: number[] = [];
      const messages = ["  Use April.\n", ""];
      const options = {
        prompt: "Summarize the figures.",
        maxModelTurns: 1,
        takeMessages: (turn: number) => {
          calls.push(turn);
          return messages;
        },
      };

      const result = await loop.runPrompt(options);

      expect(requests[0].transcript).toEqual([
        { role: "user", content: options.prompt },
        ...messages.map((content) => ({ role: "user", content })),
      ]);
      expect(calls).toEqual([1]);
      expect(result.finalAssistantText).toBe("Done");
    });

    for (
      const digest of ["valueDigest", "slotDigest", "snapshotDigest"] as const
    ) {
      for (const inherited of [false, true]) {
        it(`refuses steering with ${inherited ? "an inherited" : "an explicit"} ${digest} binding`, async () => {
          const binding = {
            ...promptSlotBinding,
            [digest]: "exact-prompt-digest",
          };
          const engine = new CfHarnessEngine({
            sandboxRuntime: new FakeSandboxRuntime(),
            model: "test-model",
          });
          if (inherited) engine.setPromptSlotBinding(binding);
          const { loop, requests } = scriptedLoop([finalTurn("Done")], {
            engine,
          });
          const calls: number[] = [];
          const options = {
            transcript: [
              { role: "user", content: "Inspect the workspace." } as const,
            ],
            ...(inherited ? {} : { promptSlotBinding: binding }),
            takeMessages: (turn: number) => {
              calls.push(turn);
              return ["Use April."];
            },
          };

          await expect(loop.runTranscript(options)).rejects.toThrow("digest");

          expect(requests).toHaveLength(0);
          expect(calls).toEqual([]);
        });
      }
    }

    it("appends a boundary message after the previous tool results", async () => {
      const { loop, requests } = scriptedLoop([
        inspectTurn(),
        finalTurn("Done"),
      ]);
      const calls: number[] = [];
      const options = {
        prompt: "Inspect the workspace.",
        promptSlotBinding,
        maxModelTurns: 2,
        takeMessages: (turn: number) => {
          calls.push(turn);
          return Promise.resolve(turn === 2 ? ["Inspect April too."] : []);
        },
      };

      const result = await loop.runPrompt(options);

      expect(requests[1].transcript.at(-2)?.role).toBe("tool");
      expect(requests[1].transcript.at(-1)).toEqual({
        role: "user",
        content: "Inspect April too.",
      });
      expect(calls).toEqual([1, 2]);
      expect(result.finalAssistantText).toBe("Done");
    });

    it("continues a provisional text answer with a pending steer", async () => {
      const { loop, requests } = scriptedLoop([
        finalTurn("March answer"),
        finalTurn("April answer"),
      ]);
      const calls: number[] = [];
      const pending: string[] = [];
      const order: string[] = [];
      const options = {
        prompt: "Summarize March.",
        maxModelTurns: 3,
        takeMessages: (turn: number) => {
          calls.push(turn);
          order.push(`take:${turn}`);
          return pending.splice(0);
        },
        onTranscriptEvent: (
          { message }: { message: HarnessTranscriptMessage },
        ) => {
          if (message.role !== "assistant") return;
          order.push(message.content);
          if (message.content === "March answer") pending.push("Use April.");
        },
      };

      const result = await loop.runPrompt(options);
      order.push("returned");

      expect(requests).toHaveLength(2);
      expect(requests[1].transcript.at(-1)).toEqual({
        role: "user",
        content: "Use April.",
      });
      expect(result.finalAssistantText).toBe("April answer");
      expect(result.modelTurns).toBe(2);
      expect(calls).toEqual([1, 2, 3]);
      expect(order.slice(-3)).toEqual(["April answer", "take:3", "returned"]);
    });

    it("replaces an accepted structured result after reading a steer", async () => {
      const { loop, requests } = scriptedLoop([
        submitTurn("march", "March"),
        submitTurn("april", "April"),
      ], { engine: resultEngine(), stopOnStructuredResult: true });
      const pending: string[] = [];
      const calls: number[] = [];
      const options = {
        prompt: "Submit March.",
        promptSlotBinding,
        maxModelTurns: 2,
        takeMessages: (turn: number) => {
          calls.push(turn);
          return pending.splice(0);
        },
        onTranscriptEvent: (
          { message }: { message: HarnessTranscriptMessage },
        ) => {
          if (message.role === "tool" && message.toolCallId === "march") {
            pending.push("Use April.");
          }
        },
      };

      const result = await loop.runPrompt(options);

      expect(requests).toHaveLength(2);
      expect(requests[1].transcript.at(-1)).toEqual({
        role: "user",
        content: "Use April.",
      });
      expect(JSON.parse(await Deno.readTextFile(resultPath))).toEqual({
        answer: "April",
      });
      expect(result.modelTurns).toBe(2);
      expect(calls).toEqual([1, 2]);
      const outputs = result.transcript.filter((message) =>
        message.role === "tool"
      );
      expect(outputs.map((message) => JSON.parse(message.content).replaced))
        .toEqual([false, true]);
    });

    for (const structured of [false, true]) {
      it(`defers messages arriving after a ${structured ? "structured-result" : "text"} ending take to the following boundary`, async () => {
        const { loop, requests } = scriptedLoop([
          structured ? submitTurn("march", "March") : finalTurn("March answer"),
          inspectTurn(),
          finalTurn("Final answer"),
        ], { engine: resultEngine(), stopOnStructuredResult: structured });
        const calls: number[] = [];
        const pending: string[] = [];
        const result = await loop.runPrompt({
          prompt: "Summarize March.",
          promptSlotBinding,
          maxModelTurns: 3,
          takeMessages: (turn) => {
            calls.push(turn);
            return pending.splice(0);
          },
          onTranscriptEvent: ({ message }) => {
            if (
              message.content === "March answer" ||
              (message.role === "tool" && message.toolCallId === "march")
            ) {
              pending.push("Use April.");
            }
            if (message.role === "user" && message.content === "Use April.") {
              pending.push("Inspect May too.");
            }
          },
        });

        expect(calls).toEqual([1, 2, 3]);
        expect(requests).toHaveLength(3);
        expect(requests[1].transcript).toContainEqual({
          role: "user",
          content: "Use April.",
        });
        expect(
          requests[1].transcript.some((message) =>
            message.content === "Inspect May too."
          ),
        ).toBe(false);
        expect(requests[2].transcript).toContainEqual({
          role: "user",
          content: "Inspect May too.",
        });
        expect(result.finalAssistantText).toBe("Final answer");
      });
    }

    it("checkpoints a steer taken at an accepted-result ending", async () => {
      const { loop, requests } = scriptedLoop([
        submitTurn("march", "March"),
        finalTurn("April answer"),
      ], { engine: resultEngine(), stopOnStructuredResult: true });
      const pending: string[] = [];
      const checkpoints: HarnessTranscriptMessage[][] = [];
      const steer = { role: "user", content: "Use April." } as const;
      const result = await loop.runTranscript({
        transcript: [{ role: "user", content: "Submit March." }],
        promptSlotBinding,
        maxModelTurns: 2,
        takeMessages: () => pending.splice(0),
        onTranscriptEvent: ({ message }) => {
          if (message.role === "tool") pending.push(steer.content);
        },
        onCheckpoint: ({ transcript }) => {
          checkpoints.push(structuredClone([...transcript]));
        },
      });

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toContainEqual(steer);
      expect(requests).toHaveLength(2);
      expect(result.finalAssistantText).toBe("April answer");
    });

    it("discards an admitted task outcome when a steer continues the run", async () => {
      const { loop, requests } = scriptedLoop([
        toolTurn("finish", "finish_task", {
          outcome: "question",
          message: "Which month?",
        }),
        finalTurn("April answer"),
      ]);
      const pending: string[] = [];
      const options = {
        prompt: "Summarize the figures.",
        promptSlotBinding,
        maxModelTurns: 2,
        takeMessages: (_turn: number) => pending.splice(0),
        onTranscriptEvent: (
          { message }: { message: HarnessTranscriptMessage },
        ) => {
          if (message.role === "tool") pending.push("Use April.");
        },
      };

      const result = await loop.runPrompt(options);

      expect(requests).toHaveLength(2);
      expect(requests[1].transcript.at(-1)).toEqual({
        role: "user",
        content: "Use April.",
      });
      expect(result.finalAssistantText).toBe("April answer");
      expect(result.taskOutcome).toEqual({ outcome: "completed" });
    });

    for (const structured of [false, true]) {
      it(`leaves a last-turn message pending after ${structured ? "submit_result" : "a text answer"}`, async () => {
        const { loop, requests } = scriptedLoop([
          inspectTurn(),
          structured ? submitTurn("last", "March") : finalTurn("March answer"),
        ], { engine: resultEngine(), stopOnStructuredResult: structured });
        const calls: number[] = [];
        const pending: string[] = [];
        const options = {
          prompt: "Summarize March.",
          promptSlotBinding,
          maxModelTurns: 2,
          takeMessages: (turn: number) => {
            calls.push(turn);
            return pending.splice(0);
          },
          onModelUsage: () => {
            if (requests.length === 2) pending.push("Use April.");
          },
        };

        const result = await loop.runPrompt(options);

        expect(calls).toEqual([1, 2]);
        expect(pending).toEqual(["Use April."]);
        expect(requests).toHaveLength(2);
        expect(result.modelTurns).toBe(2);
        if (structured) {
          expect(JSON.parse(await Deno.readTextFile(resultPath))).toEqual({
            answer: "March",
          });
        } else {
          expect(result.finalAssistantText).toBe("March answer");
        }
      });
    }

    it("takes messages only for root requests during a delegation", async () => {
      const { loop, requests } = scriptedLoop([
        toolTurn("delegate", "delegate_task", {
          goal: "Inspect the workspace.",
          maxModelTurns: 2,
        }),
        inspectTurn(),
        finalTurn("Child done"),
        finalTurn("Parent done"),
      ]);
      const calls: number[] = [];
      const options = {
        prompt: "Delegate the inspection.",
        promptSlotBinding,
        maxModelTurns: 2,
        takeMessages: (turn: number) => {
          calls.push(turn);
          return [`Root steer ${turn}`];
        },
      };

      const result = await loop.runPrompt(options);

      expect(requests).toHaveLength(4);
      expect(requests[1].runId).not.toBe(requests[0].runId);
      expect(requests[2].runId).toBe(requests[1].runId);
      for (const request of requests.slice(1, 3)) {
        expect(
          request.transcript.some((message) =>
            message.content.startsWith("Root steer")
          ),
        ).toBe(false);
      }
      expect(calls).toEqual([1, 2]);
      expect(result.finalAssistantText).toBe("Parent done");
    });

    it("completes an unsteered result when its final checkpoint aborts", async () => {
      const { loop, requests } = scriptedLoop([submitTurn("result", "March")], {
        engine: resultEngine(),
        stopOnStructuredResult: true,
      });
      const controller = new AbortController();

      const result = await loop.runTranscript({
        transcript: [{ role: "user", content: "Submit March." }],
        promptSlotBinding,
        maxModelTurns: 2,
        signal: controller.signal,
        onCheckpoint: () => {
          controller.abort(new Error("Stopped after the final checkpoint"));
        },
      });

      expect(requests).toHaveLength(1);
      expect(controller.signal.aborted).toBe(true);
      expect(result.runState.status).toBe("completed");
      expect(JSON.parse(await Deno.readTextFile(resultPath))).toEqual({
        answer: "March",
      });
    });

    it("leaves a message pending when the final checkpoint aborts a steered run", async () => {
      const { loop, requests } = scriptedLoop([submitTurn("result", "March")], {
        engine: resultEngine(),
        stopOnStructuredResult: true,
      });
      const controller = new AbortController();
      const pending: string[] = [];
      const order: string[] = [];

      const result = await loop.runTranscript({
        transcript: [{ role: "user", content: "Submit March." }],
        promptSlotBinding,
        maxModelTurns: 2,
        signal: controller.signal,
        takeMessages: (turn) => {
          order.push(`take:${turn}`);
          return pending.splice(0);
        },
        onCheckpoint: () => {
          order.push("checkpoint");
          pending.push("Use April.");
          controller.abort(new Error("Stopped after the final checkpoint"));
        },
      });
      order.push("returned");

      expect(requests).toHaveLength(1);
      expect(result.runState.status).toBe("completed");
      expect(pending).toEqual(["Use April."]);
      expect(order.slice(order.indexOf("checkpoint"))).toEqual([
        "checkpoint",
        "returned",
      ]);
      expect(JSON.parse(await Deno.readTextFile(resultPath))).toEqual({
        answer: "March",
      });
    });

    it("retains a steer in resumable history and tool-batch checkpoints", async () => {
      const { loop } = scriptedLoop([inspectTurn(), finalTurn("Done")]);
      const checkpoints: HarnessTranscriptMessage[][] = [];
      const events: HarnessTranscriptMessage[] = [];
      const steer = { role: "user", content: "Use April." } as const;
      const options = {
        transcript: [
          { role: "user", content: "Inspect the workspace." } as const,
        ],
        promptSlotBinding,
        maxModelTurns: 2,
        takeMessages: (turn: number) => turn === 1 ? [steer.content] : [],
        onCheckpoint: (
          { transcript }: { transcript: readonly HarnessTranscriptMessage[] },
        ) => {
          checkpoints.push(structuredClone([...transcript]));
        },
        onTranscriptEvent: (
          { message }: { message: HarnessTranscriptMessage },
        ) => {
          events.push(message);
        },
      };

      const result = await loop.runTranscript(options);

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toContainEqual(steer);
      expect(result.transcript).toContainEqual(steer);
      expect(events.filter((message) => message.content === steer.content))
        .toEqual([steer]);
    });

    for (const abort of [false, true]) {
      it(`takes no further messages on ${abort ? "abort" : "model failure"}`, async () => {
        const { loop, requests } = scriptedLoop([
          abort ? finalTurn("Interrupted") : new Error("Model failed"),
        ]);
        const controller = new AbortController();
        const calls: number[] = [];
        const options = {
          prompt: "Inspect the workspace.",
          signal: controller.signal,
          maxModelTurns: 2,
          takeMessages: (turn: number) => {
            calls.push(turn);
            return [];
          },
          onModelUsage: () => {
            if (abort) controller.abort(new Error("Stopped"));
          },
        };

        await expect(loop.runPrompt(options)).rejects.toThrow(
          abort ? "Stopped" : "Model failed",
        );

        expect(requests).toHaveLength(1);
        expect(calls).toEqual([1]);
      });
    }
  });
});
