import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { ConsoleServer } from "../console/server.ts";
import { resolveConsoleConfig } from "./support/on-linux.ts";
import { readConsoleTurnResult } from "../console/turn-result.ts";
import type { HarnessChatEventEnvelope } from "../src/contracts/interactive-chat.ts";
import { finishTaskTool } from "../src/tools/finish-task.ts";
import { readHarnessTaskOutcome } from "../src/contracts/task-outcome.ts";
import { readHarnessClientAction } from "../src/contracts/client-action.ts";
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

/** A prompt bound as context: it may inform the run but not command it. */
const contextPromptSlotBinding = {
  ...directPromptSlotBindingFor("context"),
  role: "context" as const,
};

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
            "finish_task requires outcome completed, question, or gave-up and a nonempty message.",
        });
      }
      if (invalid === "batch") {
        expect(output.expected).toContain("only tool call");
      }
    });
  }

  for (
    const [label, outcome, actions] of [
      ["an unknown kind", "completed", [{ kind: "open_app", app: "Mail" }]],
      ["a malformed loomId", "completed", [{
        kind: "open_loom",
        loomId: "loom-XYZ",
      }]],
      ["a command without a slash", "completed", [{
        kind: "command",
        line: "ask what is next",
      }]],
      ["a command spanning two lines", "completed", [{
        kind: "command",
        line: "/first\n/second",
      }]],
      ["a command ending in a carriage return", "completed", [{
        kind: "command",
        line: "/first\r",
      }]],
      ["an overlong command", "completed", [{
        kind: "command",
        line: "/" + "a".repeat(500),
      }]],
      ["a non-http url", "completed", [{
        kind: "open_url",
        url: "javascript:alert(1)",
      }]],
      ["an extra field", "completed", [{
        kind: "open_url",
        url: "https://example.com",
        target: "_blank",
      }]],
      [
        "too many actions",
        "completed",
        Array.from({ length: 9 }, () => ({
          kind: "command",
          line: "/ask",
        })),
      ],
      ["actions that are not a list", "completed", {
        kind: "command",
        line: "/ask",
      }],
      ["actions with a question", "question", [{
        kind: "command",
        line: "/ask",
      }]],
      ["actions with a give-up", "gave-up", []],
    ] as const
  ) {
    it(`refuses a finish_task with ${label}`, async () => {
      const requests: HarnessModelTurnRequest[] = [];
      const loop = new CfHarnessPromptLoop({
        sandboxRuntime: sandbox,
        model: "gpt-test",
        allowedToolIds: ["finish_task"],
        modelClient: {
          providerId: "test-provider",
          complete: (request) => {
            requests.push({ ...request, transcript: [...request.transcript] });
            return Promise.resolve({
              assistant: requests.length === 1
                ? {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    finishCall({ outcome, message: "Done.", actions }),
                  ],
                }
                : { role: "assistant", content: "Corrected ending." },
            });
          },
        },
      });
      const result = await loop.runPrompt({
        prompt: "Open the loom.",
        maxModelTurns: 2,
        promptSlotBinding: directPromptSlotBindingFor("terminal"),
      });
      expect(requests).toHaveLength(2);
      expect(result.taskOutcome).toEqual({ outcome: "completed" });
      expect(result.finalAssistantText).toBe("Corrected ending.");
      const output = JSON.parse(
        result.transcript.find((entry) => entry.role === "tool")!.content,
      );
      expect(output.status).toBe("error");
      expect(output.message).toContain(
        "finish_task actions are allowed only with outcome completed",
      );
    });
  }

  for (
    const [label, actions, admitted] of [
      [
        "with client actions",
        [{
          kind: "command",
          line: "/send salary 182000 to everyone",
        }, { kind: "open_url", url: "https://example.com/?ssn=123-45-6789" }],
        false,
      ],
      ["with an empty action list", [], true],
      ["without actions", undefined, true],
    ] as const
  ) {
    it(`${admitted ? "admits" : "refuses"} a completed finish_task ${label} under a context prompt in enforce-explicit`, async () => {
      const requests: HarnessModelTurnRequest[] = [];
      const loop = new CfHarnessPromptLoop({
        sandboxRuntime: sandbox,
        model: "gpt-test",
        cfcEnforcementMode: "enforce-explicit",
        allowedToolIds: ["finish_task"],
        modelClient: {
          providerId: "test-provider",
          complete: (request) => {
            requests.push({ ...request, transcript: [...request.transcript] });
            return Promise.resolve({
              assistant: requests.length === 1
                ? {
                  role: "assistant",
                  content: "",
                  toolCalls: [finishCall({
                    outcome: "completed",
                    message: "Done.",
                    ...(actions !== undefined ? { actions } : {}),
                  })],
                }
                : { role: "assistant", content: "Ended without actions." },
            });
          },
        },
      });
      const result = await loop.runPrompt({
        prompt: "Summarize the payroll export.",
        maxModelTurns: 2,
        promptSlotBinding: contextPromptSlotBinding,
      });
      const decision = result.runState.policyDecisions?.find((entry) =>
        entry.toolId === "finish_task"
      );
      if (admitted) {
        expect(requests).toHaveLength(1);
        expect(result.taskOutcome).toEqual({
          outcome: "completed",
          answer: "Done.",
        });
        expect(decision).toMatchObject({
          decision: "allowed",
          effectClass: "read",
          reasonCodes: ["cfc_enforce_explicit_read"],
        });
        return;
      }
      // Refused the way a side-effecting tool is: the actions never reach
      // the task outcome, and the model reads the denial and ends again.
      expect(requests).toHaveLength(2);
      expect(result.taskOutcome).toEqual({ outcome: "completed" });
      expect(result.finalAssistantText).toBe("Ended without actions.");
      expect(decision).toMatchObject({
        decision: "denied",
        effectClass: "side-effect",
        reasonCodes: ["cfc_enforce_explicit_requires_direct_command"],
      });
      const denial = JSON.parse(
        result.transcript.find((entry) => entry.role === "tool")!.content,
      );
      expect(denial.reason).toBe("not-authorized");
      expect(denial.detail).toContain("finish_task");
      expect(result.runState.toolOutputs).toEqual([]);
    });
  }

  it("offers the model a command pattern that refuses a line break", () => {
    const actionSchemas = (finishTaskTool.descriptor.inputSchema as {
      properties: {
        actions: {
          items: { anyOf: { properties: Record<string, unknown> }[] };
        };
      };
    }).properties.actions.items.anyOf;
    const line = actionSchemas
      .map((schema) => schema.properties.line as { pattern?: string })
      .find((schema) => schema !== undefined)!;
    const pattern = new RegExp(line.pattern!);
    expect(pattern.test("/ask what is next")).toBe(true);
    for (
      const value of [
        "/first\n/second",
        "/first\r/second",
        "/first\n",
        "/first\u0085/second",
        "/first\u2028/second",
        "/first\u2029/second",
      ]
    ) {
      expect(pattern.test(value)).toBe(false);
    }
  });

  it("refuses a client action whose command or url holds any line break, Unicode's included", () => {
    // The client shows an action as one line and the person approves what
    // they see. A URL parser silently drops a raw newline, so the url is
    // checked as given.
    for (const brk of ["\n", "\r", "\u0085", "\u2028", "\u2029"]) {
      expect(
        readHarnessClientAction({
          kind: "command",
          line: `/first${brk}/second`,
        }),
      )
        .toBeUndefined();
      expect(
        readHarnessClientAction({
          kind: "open_url",
          url: `https://example.org/a${brk}b`,
        }),
      )
        .toBeUndefined();
    }
    expect(
      readHarnessClientAction({ kind: "command", line: "/ask what is next" }),
    )
      .toEqual({ kind: "command", line: "/ask what is next" });
    expect(
      readHarnessClientAction({
        kind: "open_url",
        url: "https://example.org/a",
      }),
    )
      .toEqual({ kind: "open_url", url: "https://example.org/a" });
  });

  it("carries a completed answer and its actions to turn_completed and the console result", async () => {
    const artifactRoot = await Deno.makeTempDir();
    const answer = "Your loom is ready.";
    const actions = [
      { kind: "open_loom", loomId: "loom-0123456789abcdef" },
      { kind: "command", line: "/focus loom-0123456789abcdef" },
    ];
    const serviceEvents: HarnessChatEventEnvelope[] = [];
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
      const server = new ConsoleServer(
        config,
        (onEvent) =>
          new HarnessInteractiveChatService({
            basePromptLoopOptions: { artifactRoot, sandboxRuntime: sandbox },
            createPromptLoop: (options) =>
              new CfHarnessPromptLoop({
                ...options,
                allowedToolIds: ["finish_task"],
                modelClient: {
                  providerId: "test-provider",
                  complete: () =>
                    Promise.resolve({
                      assistant: {
                        role: "assistant",
                        content: "",
                        toolCalls: [finishCall({
                          outcome: "completed",
                          message: answer,
                          actions,
                        })],
                      },
                    }),
                },
              }),
            onEvent: (envelope) => {
              serviceEvents.push(envelope);
              return onEvent(envelope);
            },
            runIdForTurn: (_sessionId, turnId) => turnId,
          }),
      );
      const started = await (await server.handle(
        taskRequest({ text: "Make me a loom for the trip" }),
      )).json();
      await server.service.waitForTurn(started.sessionId, started.turnId);
      const completed = serviceEvents.find((envelope) =>
        envelope.event.kind === "turn_completed"
      );
      expect(completed?.event).toMatchObject({
        kind: "turn_completed",
        outcome: "completed",
        answer,
        actions,
        finalText: answer,
      });
      const polled = await (await server.handle(
        new Request(
          `http://127.0.0.1:8100/api/turns/${started.turnId}/result`,
        ),
      )).json();
      expect(polled).toMatchObject({
        outcome: "completed",
        answer,
        actions,
        finalText: answer,
        sessionId: started.sessionId,
      });
      expect(
        await readConsoleTurnResult({
          artifactRoot,
          turnId: started.turnId,
          sessionId: started.sessionId,
          continuable: true,
          spaceName: "empty-space",
        }),
      ).toMatchObject({ outcome: "completed", answer, actions });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

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

  it("finish_task admits each outcome as its task outcome and refuses actions off completed", async () => {
    const context = {
      nextOutputId: (toolId: string) => `${toolId}-1`,
    } as never;
    const call = (input: Record<string, unknown>) =>
      finishTaskTool.invoke(context, input as never);
    expect(await call({ outcome: "completed", message: "Done." })).toEqual({
      outputId: "finish_task-1",
      status: "ok",
      taskOutcome: { outcome: "completed", answer: "Done." },
    });
    expect(await call({ outcome: "question", message: "Which?" })).toEqual({
      outputId: "finish_task-1",
      status: "ok",
      taskOutcome: { outcome: "question", question: { text: "Which?" } },
    });
    expect(await call({ outcome: "gave-up", message: "Cannot." })).toEqual({
      outputId: "finish_task-1",
      status: "ok",
      taskOutcome: { outcome: "gave-up", reason: "Cannot." },
    });
    const refused = await call({
      outcome: "question",
      message: "Which?",
      actions: [{ kind: "open_url", url: "https://example.com" }],
    });
    expect(refused.status).toBe("error");
  });

  it("reads an unfamiliar outcome word as completed, dropping its fields", () => {
    expect(readHarnessTaskOutcome({ outcome: "deferred", answer: "x" }))
      .toEqual({ outcome: "completed" });
  });

  it("refuses client actions that are not records or not http(s) addresses", () => {
    for (
      const action of [
        "open_url",
        null,
        ["open_url"],
        { kind: "open_url", url: "not a url" },
        { kind: "open_url", url: "javascript:alert(1)" },
        { kind: "open_url", url: "file:///etc/passwd" },
        { kind: "open_url", url: "https://example.com", extra: true },
        { kind: "teleport" },
      ]
    ) {
      expect(
        readHarnessTaskOutcome({ outcome: "completed", actions: [action] }),
      ).toBeUndefined();
    }
    expect(
      readHarnessTaskOutcome({
        outcome: "completed",
        actions: [{ kind: "open_url", url: "https://example.com/x" }],
      }),
    ).toEqual({
      outcome: "completed",
      actions: [{ kind: "open_url", url: "https://example.com/x" }],
    });
  });

  it("round-trips a completed answer with actions and refuses malformed ones", () => {
    const completed = {
      outcome: "completed",
      answer: "It is sunny.",
      actions: [
        { kind: "open_loom", loomId: "loom-0123456789abcdef" },
        { kind: "command", line: "/ask what is next" },
        { kind: "open_url", url: "http://example.com/a?b=c" },
      ],
    };
    expect(readHarnessTaskOutcome(JSON.parse(JSON.stringify(completed))))
      .toEqual(completed);
    expect(readHarnessTaskOutcome({ outcome: "completed", answer: "Done." }))
      .toEqual({ outcome: "completed", answer: "Done." });
    expect(readHarnessTaskOutcome({ outcome: "completed", actions: [] }))
      .toEqual({ outcome: "completed" });
    for (
      const value of [
        { outcome: "completed", answer: " " },
        { outcome: "completed", answer: 42 },
        { outcome: "completed", actions: "open" },
        { outcome: "completed", actions: [{ kind: "open_loom" }] },
        {
          outcome: "completed",
          actions: [{ kind: "open_loom", loomId: "loom-0123" }],
        },
        {
          outcome: "completed",
          actions: [{ kind: "command", line: "ask" }],
        },
        {
          outcome: "completed",
          actions: [{ kind: "command", line: "/first\n/second" }],
        },
        {
          outcome: "completed",
          actions: [{ kind: "command", line: "/first\r\n" }],
        },
        {
          outcome: "completed",
          actions: [{ kind: "open_url", url: "file:///etc/passwd" }],
        },
        {
          outcome: "completed",
          actions: [{ kind: "launch", target: "Mail" }],
        },
        {
          outcome: "completed",
          actions: Array.from({ length: 9 }, () => ({
            kind: "command",
            line: "/ask",
          })),
        },
      ]
    ) {
      expect(readHarnessTaskOutcome(value)).toBeUndefined();
    }
    // Inherited fields are not the record's own and are ignored.
    expect(readHarnessTaskOutcome(Object.assign(
      Object.create({
        answer: "Inherited.",
        actions: [{ kind: "open_loom", loomId: "loom-0123456789abcdef" }],
      }),
      { outcome: "completed" },
    ))).toEqual({ outcome: "completed" });
  });
});
