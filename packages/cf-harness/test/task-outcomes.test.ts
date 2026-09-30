import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { ConsoleServer, resolveConsoleConfig } from "../console/server.ts";
import { readConsoleTurnResult } from "../console/turn-result.ts";
import { readHarnessTaskOutcome } from "../src/contracts/task-outcome.ts";
import type { HarnessToolCall } from "../src/contracts/transcript.ts";
import {
  type HarnessInteractiveChatEventListener,
  HarnessInteractiveChatService,
} from "../src/interactive-chat-service.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

/** A host-only task uses this sandbox solely for its capability inventory. */
const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "docker-runsc-cfc",
    defaultWorkingDirectory: "/workspace",
    cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
  }),
  defaultWorkingDirectory: () => "/workspace",
  resolvePath: (path) => path,
  isPathWithinWorkspace: () => true,
  isPathWithinAllowedRoots: () => true,
  run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
};

/** A terminal call authored by the scripted model. */
const finishCall = (input: unknown, id = "finish"): HarnessToolCall => ({
  id,
  type: "function",
  function: { name: "finish_task", arguments: JSON.stringify(input) },
});

/** A same-origin request through the console's public HTTP handler. */
const taskRequest = (input: unknown): Request =>
  new Request("http://127.0.0.1:8100/api/task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

describe("task-outcomes", () => {
  for (
    const [outcome, withAddress] of [
      ["question", false],
      ["gave-up", false],
      ["question", true],
      ["gave-up", true],
    ] as const
  ) {
    it(`persists an admitted ${outcome}${withAddress ? " with an authored address" : ""} and stops after one model turn`, async () => {
      const artifactRoot = await Deno.makeTempDir();
      const address = `/of:fid1:${"R".repeat(43)}`;
      const sentence = outcome === "question"
        ? "Please attach the mailbox you want me to use."
        : "I cannot inspect this source under the current permissions.";
      const message = sentence + (withAddress ? ` Use ${address}.` : "");
      const taskOutcome = outcome === "question"
        ? { outcome, question: { text: message } }
        : { outcome, reason: message };
      const requests: HarnessModelTurnRequest[] = [];
      try {
        const loop = new CfHarnessPromptLoop({
          sandboxRuntime: sandbox,
          artifactRoot,
          runId: "terminal",
          model: "gpt-test",
          allowedToolIds: ["finish_task"],
          modelClient: {
            providerId: "test-provider",
            complete: (request) => {
              requests.push({
                ...request,
                transcript: [...request.transcript],
              });
              return Promise.resolve({
                assistant: {
                  role: "assistant",
                  content: "",
                  toolCalls: [finishCall({ outcome, message })],
                },
              });
            },
          },
        });
        const result = await loop.runPrompt({
          prompt: "Read the mailbox.",
          maxModelTurns: 1,
          promptSlotBinding: directPromptSlotBindingFor("terminal"),
        });
        expect(requests).toHaveLength(1);
        expect(result.finalAssistantText).toBe(message);
        expect(result.taskOutcome).toEqual(taskOutcome);
        expect(result.runState.status).toBe("completed");
        expect(result.transcript.map((entry) => entry.role)).toEqual([
          "user",
          "assistant",
          "tool",
        ]);
        if (withAddress) {
          const modelOutput = JSON.parse(result.transcript[2].content);
          const modelSentence = outcome === "question"
            ? modelOutput.taskOutcome.question.text
            : modelOutput.taskOutcome.reason;
          expect(modelSentence).toContain(" Use cfh:a:");
          expect(modelSentence).not.toContain(address);
        }
        const report = JSON.parse(
          await Deno.readTextFile(
            join(artifactRoot, "terminal", "run-report.json"),
          ),
        );
        expect(report.taskOutcome).toEqual(taskOutcome);
        expect(report.toolActivity).toMatchObject([{
          toolId: "finish_task",
          executionStatus: "completed",
          policyDecision: "allowed",
        }]);
        expect(report.toolActivity).toHaveLength(1);
        expect(report.toolOutputs).toHaveLength(1);
        expect(
          await readConsoleTurnResult({
            artifactRoot,
            turnId: "terminal",
            sessionId: "conversation",
            continuable: true,
            spaceName: "empty-space",
          }),
        ).toEqual({
          ...taskOutcome,
          sessionId: "conversation",
          continuable: true,
          looms: [],
          pieces: [],
          spaceName: "empty-space",
          finalText: message,
        });
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });
  }

  for (
    const invalid of [
      "empty",
      "bad-outcome",
      "batch",
      "child",
      "withheld",
    ] as const
  ) {
    it(`rejects a terminal call when the case is ${invalid}`, async () => {
      const requests: HarnessModelTurnRequest[] = [];
      const call = finishCall({
        outcome: invalid === "bad-outcome" ? "success" : "question",
        message: invalid === "empty" ? " " : "Which mailbox?",
      });
      const loop = new CfHarnessPromptLoop({
        sandboxRuntime: sandbox,
        model: "gpt-test",
        allowedToolIds: invalid === "withheld" ? [] : ["finish_task"],
        ...(invalid === "child"
          ? {
            lineage: {
              role: "subagent" as const,
              rootRunId: "root",
              parentRunId: "root",
              parentToolCallId: "delegate",
              depth: 1,
            },
          }
          : {}),
        modelClient: {
          providerId: "test-provider",
          complete: (request) => {
            requests.push({ ...request, transcript: [...request.transcript] });
            return Promise.resolve({
              assistant: requests.length === 1
                ? {
                  role: "assistant",
                  content: "",
                  toolCalls: invalid === "batch"
                    ? [call, { ...call, id: "finish-2" }]
                    : [call],
                }
                : {
                  role: "assistant",
                  content: "Reported the blocker to the caller.",
                },
            });
          },
        },
      });
      const result = await loop.runPrompt({
        prompt: "Read mail",
        maxModelTurns: 2,
        promptSlotBinding: directPromptSlotBindingFor("terminal"),
      });
      expect(requests).toHaveLength(2);
      expect(result.taskOutcome).toEqual({ outcome: "completed" });
      expect(result.finalAssistantText).toBe(
        "Reported the blocker to the caller.",
      );
      const output = JSON.parse(
        result.transcript.find((entry) => entry.role === "tool")!.content,
      );
      if (invalid === "child" || invalid === "withheld") {
        expect(output).toMatchObject({
          type: "cf-harness.observation-denied",
          reason: "not-authorized",
        });
        expect(requests[0].tools.map((tool) => tool.toolId)).not.toContain(
          "finish_task",
        );
      }
      if (invalid === "empty" || invalid === "bad-outcome") {
        expect(output).toMatchObject({
          status: "error",
          message:
            "finish_task requires outcome question or gave-up and a nonempty message.",
        });
      }
      if (invalid === "batch") {
        expect(output.expected).toContain("only tool call");
      }
    });
  }

  for (const restored of [false, true]) {
    it(`keeps SSE and polling aligned and continues a ${restored ? "restored" : "live"} session`, async () => {
      const artifactRoot = await Deno.makeTempDir();
      const requests: HarnessModelTurnRequest[] = [];
      const store = restored
        ? await openSqliteHarnessChatSessionStore({
          url: toFileUrl(join(artifactRoot, "sessions.sqlite")),
        })
        : undefined;
      try {
        const config = await resolveConsoleConfig(
          [
            "--fabric-identity",
            "unused.key",
            "--fabric-space",
            "empty-space",
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
            basePromptLoopOptions: { artifactRoot, sandboxRuntime: sandbox },
            createPromptLoop: (options) =>
              new CfHarnessPromptLoop({
                ...options,
                allowedToolIds: ["finish_task"],
                modelClient: {
                  providerId: "test-provider",
                  complete: (request) => {
                    requests.push({
                      ...request,
                      transcript: [...request.transcript],
                    });
                    return Promise.resolve({
                      assistant: requests.length === 1
                        ? {
                          role: "assistant",
                          content: "",
                          toolCalls: [
                            finishCall({
                              outcome: "question",
                              message: "Which mailbox should I use?",
                            }),
                          ],
                        }
                        : {
                          role: "assistant",
                          content: "I will use the mailbox you attach.",
                        },
                    });
                  },
                },
              }),
            onEvent,
            runIdForTurn: (_sessionId, turnId) => turnId,
            sessionStore: store,
          });
        let server = new ConsoleServer(config, createService);
        const startedResponse = await server.handle(
          taskRequest({ text: "Read my missing mailbox" }),
        );
        const started = await startedResponse.json();
        await server.service.waitForTurn(started.sessionId, started.turnId);
        expect(startedResponse.status).toBe(200);
        if (restored) {
          server = new ConsoleServer(config, createService);
          await server.service.initializeFromStore();
        }
        const polledResponse = await server.handle(
          new Request(
            `http://127.0.0.1:8100/api/turns/${started.turnId}/result`,
          ),
        );
        expect(polledResponse.status).toBe(200);
        const polled = await polledResponse.json();
        expect(polled).toMatchObject({
          outcome: "question",
          question: { text: "Which mailbox should I use?" },
          finalText: "Which mailbox should I use?",
          sessionId: started.sessionId,
          continuable: true,
        });
        const stream = await server.handle(
          new Request(
            `http://127.0.0.1:8100/api/events?sessionId=${started.sessionId}&afterSequence=0`,
          ),
        );
        const reader = stream.body!.pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        let terminal;
        try {
          while (terminal === undefined) {
            const chunk = await reader.read();
            if (chunk.done) {
              throw new Error("stream ended without its terminal");
            }
            buffer += chunk.value;
            for (let split; (split = buffer.indexOf("\n\n")) >= 0;) {
              const block = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              const data = block.split("\n").find((line) =>
                line.startsWith("data: ")
              );
              if (data === undefined) continue;
              const envelope = JSON.parse(data.slice(6));
              if (envelope.event?.kind === "turn_completed") {
                terminal = envelope;
              }
            }
          }
        } finally {
          await reader.cancel();
        }
        expect(terminal.turnId).toBe(started.turnId);
        expect(terminal.event.outcome).toBe("question");
        expect(terminal.event.result).toEqual(polled);
        const continuedResponse = await server.handle(
          taskRequest({
            sessionId: started.sessionId,
            text: "Use the shared mailbox I will attach.",
          }),
        );
        const continued = await continuedResponse.json();
        await server.service.waitForTurn(continued.sessionId, continued.turnId);
        expect(continuedResponse.status).toBe(200);
        expect(continued.sessionId).toBe(started.sessionId);
        expect(requests).toHaveLength(2);
        expect(
          requests[1].transcript.some((entry) =>
            entry.role === "tool" && entry.toolName === "finish_task"
          ),
        ).toBe(true);
        expect(requests[1].transcript.at(-1)?.content).toBe(
          "Use the shared mailbox I will attach.",
        );
        await server.service.closeSession("close", started.sessionId, "done");
        const closed = await server.handle(
          new Request(
            `http://127.0.0.1:8100/api/turns/${started.turnId}/result`,
          ),
        );
        expect((await closed.json()).continuable).toBe(false);
      } finally {
        store?.close();
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });
  }

  it("refuses required outcome fields inherited from a prototype", () => {
    const text = "Which mailbox?";
    for (
      const value of [
        Object.create({ outcome: "question", question: { text } }),
        Object.assign(Object.create({ question: { text } }), {
          outcome: "question",
        }),
        { outcome: "question", question: Object.create({ text }) },
        Object.assign(Object.create({ reason: "Not available" }), {
          outcome: "gave-up",
        }),
      ]
    ) {
      expect(readHarnessTaskOutcome(value)).toBeUndefined();
    }
  });

  it("defaults absent legacy outcomes and refuses contradictory or incomplete records", () => {
    expect(readHarnessTaskOutcome(undefined)).toEqual({ outcome: "completed" });
    for (
      const value of [
        null,
        [],
        {},
        { outcome: 42 },
        { outcome: " " },
        { outcome: "question" },
        { outcome: "gave-up", reason: " " },
        { outcome: "question", question: { text: "Why?" }, reason: "stopped" },
        { outcome: "completed", question: { text: "Why?" } },
      ]
    ) {
      expect(readHarnessTaskOutcome(value)).toBeUndefined();
    }
  });
});
