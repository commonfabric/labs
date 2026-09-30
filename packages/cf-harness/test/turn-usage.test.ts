import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { ConsoleServer, resolveConsoleConfig } from "../console/server.ts";
import type { ConsoleChatEventEnvelope } from "../console/turn-result.ts";
import { harnessChatTurnElapsedMs } from "../src/contracts/interactive-chat.ts";
import type { HarnessToolCall } from "../src/contracts/transcript.ts";
import { HarnessInteractiveChatService } from "../src/interactive-chat-service.ts";
import type { HarnessModelUsage } from "../src/model/client.ts";
import { readHarnessModelUsage } from "../src/model/usage.ts";
import {
  CfHarnessPromptLoop,
  type HarnessModelUsageUpdate,
} from "../src/prompt-loop.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

/** The usage fixture reads a file without launching a sandbox process. */
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
  run: () => Promise.resolve({ stdout: "fixture", stderr: "", exitCode: 0 }),
  runShell: () =>
    Promise.resolve({ stdout: "fixture", stderr: "", exitCode: 0 }),
};

const call = (name: string, input: unknown, id = name): HarnessToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(input) },
});

const taskRequest = (text: string, sessionId?: string): Request =>
  new Request("http://127.0.0.1:8100/api/task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sessionId }),
  });

/** Reads actual SSE frames until the requested turn event arrives. */
const nextEvent = async (
  reader: ReadableStreamDefaultReader<string>,
  kind: string,
): Promise<ConsoleChatEventEnvelope> => {
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`stream ended before ${kind}`);
    buffer += chunk.value;
    for (let split; (split = buffer.indexOf("\n\n")) >= 0;) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (data === undefined) continue;
      const envelope: ConsoleChatEventEnvelope = JSON.parse(data.slice(6));
      if (envelope.event.kind === kind) return envelope;
      if (envelope.event.kind === "turn_completed") {
        throw new Error(`turn completed before ${kind}`);
      }
    }
  }
};

describe("turn-usage", () => {
  for (const childFails of [false, true]) {
    it(`streams research and child calls before the child ${childFails ? "fails" : "finishes"} and counts each once in the result`, async () => {
      const root = await Deno.makeTempDir();
      const docsRoot = join(root, "docs");
      const artifactRoot = join(root, "artifacts");
      await Deno.mkdir(docsRoot);
      await Deno.writeTextFile(
        join(docsRoot, "guide.md"),
        "# Files\nRead files.",
      );
      const store = childFails
        ? undefined
        : await openSqliteHarnessChatSessionStore({
          url: toFileUrl(join(root, "sessions.sqlite")),
        });
      const childWaiting = Promise.withResolvers<void>();
      const releaseChild = Promise.withResolvers<void>();
      let clock = Date.parse("2026-09-21T00:00:00.000Z");
      let researchCalls = 0;
      let parentCalls = 0;
      let childCalls = 0;
      let service: HarnessInteractiveChatService | undefined;
      let started: { sessionId: string; turnId: string } | undefined;
      let reader: ReadableStreamDefaultReader<string> | undefined;
      try {
        const config = await resolveConsoleConfig(
          [
            "--fabric-identity",
            "unused.key",
            "--fabric-space",
            "usage-test",
            "--session-db",
            "none",
            "--artifact-root",
            artifactRoot,
          ],
          {},
          "/console",
        );
        const server = new ConsoleServer(config, (onEvent) => {
          service = new HarnessInteractiveChatService({
            basePromptLoopOptions: {
              artifactRoot,
              sandboxRuntime: sandbox,
              docsCorpus: {
                type: "cf-harness.docs-corpus-record",
                source: "configured",
                roots: [docsRoot],
              },
            },
            now: () => new Date(clock).toISOString(),
            onEvent,
            sessionStore: store,
            runIdForTurn: (_sessionId, turnId) => turnId,
            createPromptLoop: (options) =>
              new CfHarnessPromptLoop({
                ...options,
                allowedToolIds: [
                  "research",
                  "delegate_task",
                  "read_file",
                  "finish_task",
                ],
                modelClient: {
                  providerId: "test-provider",
                  complete: async (request) => {
                    let ordinal: number;
                    let content = "";
                    let toolCalls: HarnessToolCall[] = [];
                    if (request.runId.includes(":research:")) {
                      ordinal = ++researchCalls;
                      if (researchCalls === 1) {
                        toolCalls = [call("search_docs", { query: "files" })];
                      } else {
                        content = JSON.stringify({
                          status: "incomplete",
                          summary: "Read the requested file.",
                          inputs: [],
                          selectedPatternIds: [],
                          rules: [],
                          sourceIds: [],
                          leads: [],
                          questions: [],
                          missing: ["The requested file has not been read."],
                        });
                      }
                    } else if (request.runId.includes(".subagent.")) {
                      ordinal = 3 + ++childCalls;
                      if (childCalls === 1) {
                        toolCalls = [
                          call("read_file", { path: "/workspace/note.txt" }),
                        ];
                      } else {
                        childWaiting.resolve();
                        await releaseChild.promise;
                        if (childFails) {
                          throw new Error("scripted child provider failure");
                        }
                        content = "The note was read.";
                      }
                    } else {
                      ordinal = ++parentCalls === 1 ? 3 : 6;
                      toolCalls = parentCalls === 1
                        ? [call("delegate_task", { goal: "Read the note." })]
                        : [
                          call("finish_task", {
                            outcome: "question",
                            message: "Which note should I read next?",
                          }, `finish-${parentCalls}`),
                        ];
                    }
                    clock += 1000;
                    return {
                      assistant: { role: "assistant", content, toolCalls },
                      usage: {
                        inputTokens: ordinal * 10,
                        outputTokens: ordinal,
                        totalTokens: ordinal * 11,
                      },
                    };
                  },
                },
              }),
          });
          return service;
        });
        started =
          await (await server.handle(taskRequest("Read the note with help.")))
            .json();
        const { sessionId, turnId } = started!;
        const done = server.service.waitForTurn(sessionId, turnId);
        await Promise.race([
          childWaiting.promise,
          done.then(() => {
            throw new Error("turn ended before the child waited");
          }),
        ]);
        const progress = server.service.events(sessionId).filter((entry) =>
          entry.event.kind === "turn_usage"
        );
        expect(progress.map((entry) => entry.event)).toEqual(
          [11, 33, 66, 110].map((totalTokens, index) => ({
            kind: "turn_usage",
            turnId,
            usage: {
              inputTokens: totalTokens * 10 / 11,
              outputTokens: totalTokens / 11,
              totalTokens,
              estimateWithheldReason: "incomplete-estimates",
            },
            elapsedMs: (index + 1) * 1000,
          })),
        );
        expect(
          progress.every((entry) =>
            entry.turnId === turnId && entry.sessionId === sessionId
          ),
        ).toBe(true);
        expect(server.service.status(sessionId).sessions[0].status).toBe(
          "turn_running",
        );
        const stream = await server.handle(
          new Request(
            `http://127.0.0.1:8100/api/events?sessionId=${sessionId}&afterSequence=${
              progress.at(-1)!.sequence
            }`,
          ),
        );
        reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
        const nextUsage = nextEvent(reader, "turn_usage");
        const running = await server.handle(
          new Request(`http://127.0.0.1:8100/api/turns/${turnId}/result`),
        );
        expect(running.status).toBe(409);

        releaseChild.resolve();
        const live = await nextUsage;
        expect(live).toMatchObject({
          sessionId,
          turnId,
          event: {
            kind: "turn_usage",
            turnId,
            usage: { totalTokens: childFails ? 176 : 165 },
            elapsedMs: 5000,
          },
        });
        expect(live.sequence).toBeGreaterThan(progress.at(-1)!.sequence);
        await done;
        const terminal = await nextEvent(reader, "turn_completed");
        const polled = await (await server.handle(
          new Request(`http://127.0.0.1:8100/api/turns/${turnId}/result`),
        )).json();
        const total = childFails ? 176 : 231;
        expect(polled).toMatchObject({
          outcome: "question",
          sessionId,
          continuable: true,
          usage: {
            inputTokens: total * 10 / 11,
            outputTokens: total / 11,
            totalTokens: total,
          },
          elapsedMs: childFails ? 5000 : 6000,
        });
        if (terminal.event.kind !== "turn_completed") {
          throw new Error("missing terminal");
        }
        expect(terminal.event.result).toEqual(polled);
        expect(terminal.event.usage).toEqual(polled.usage);
        const calls = server.service.events(sessionId).filter((entry) =>
          entry.event.kind === "turn_usage"
        );
        expect(calls).toHaveLength(childFails ? 5 : 6);
        const report = JSON.parse(
          await Deno.readTextFile(
            join(artifactRoot, turnId, "run-report.json"),
          ),
        );
        expect(report.usage.totalTokens).toBe(99);
        expect(report.totalUsage).toEqual(polled.usage);
        const childReport = JSON.parse(
          await Deno.readTextFile(
            join(artifactRoot, `${turnId}.subagent.1`, "run-report.json"),
          ),
        );
        expect(childReport.totalUsage.totalTokens).toBe(childFails ? 44 : 99);

        const followup =
          await (await server.handle(taskRequest("Another note?", sessionId)))
            .json();
        await server.service.waitForTurn(sessionId, followup.turnId);
        const followupResult = await (await server.handle(
          new Request(
            `http://127.0.0.1:8100/api/turns/${followup.turnId}/result`,
          ),
        )).json();
        expect(followupResult.usage.totalTokens).toBe(66);
        expect(followupResult.elapsedMs).toBe(1000);
      } finally {
        releaseChild.resolve();
        if (service !== undefined && started !== undefined) {
          await service.waitForTurn(started.sessionId, started.turnId);
        }
        await reader?.cancel();
        store?.close();
        await Deno.remove(root, { recursive: true });
      }
    });
  }

  it("retains usage and completes when the usage listener rejects", async () => {
    const root = await Deno.makeTempDir();
    const deliveryError = new Error("usage subscriber disconnected");
    const deliveryFailures: unknown[] = [];
    const service = new HarnessInteractiveChatService({
      basePromptLoopOptions: {
        artifactRoot: root,
        sandboxRuntime: sandbox,
        model: "test",
      },
      runIdForTurn: (_sessionId, turnId) => turnId,
      onEvent: (envelope) => {
        if (envelope.event.kind === "turn_usage") {
          return Promise.reject(deliveryError);
        }
      },
      onEventDeliveryError: (envelope, error) => {
        deliveryFailures.push({ kind: envelope.event.kind, error });
      },
      createPromptLoop: (options) =>
        new CfHarnessPromptLoop({
          ...options,
          modelClient: {
            providerId: "test-provider",
            complete: () =>
              Promise.resolve({
                assistant: {
                  role: "assistant",
                  content: "The repository note is ready.",
                },
                usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
              }),
          },
        }),
    });
    try {
      await service.startSession("session", {
        sessionId: "conversation",
        workspace: { hostPath: "/workspace" },
      });
      await service.startTurn("start", {
        sessionId: "conversation",
        turnId: "usage-listener",
        input: { text: "Summarize the repository note." },
      });
      await service.waitForTurn("conversation", "usage-listener");
      const events = service.events("conversation");
      expect(deliveryFailures).toEqual([{
        kind: "turn_usage",
        error: deliveryError,
      }]);
      expect(events.filter((entry) => entry.event.kind === "turn_usage"))
        .toHaveLength(1);
      expect(events.at(-1)?.event.kind).toBe("turn_completed");
      expect(events.some((entry) => entry.event.kind === "turn_failed")).toBe(
        false,
      );
      const report = JSON.parse(
        await Deno.readTextFile(
          join(root, "usage-listener", "run-report.json"),
        ),
      );
      expect(report.status).toBe("completed");
      expect(report.totalUsage.totalTokens).toBe(12);
    } finally {
      await service.waitForTurn("conversation", "usage-listener");
      await Deno.remove(root, { recursive: true });
    }
  });

  it("stops stream updates on cancellation while retaining usage returned during unwind", async () => {
    const root = await Deno.makeTempDir();
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const service = new HarnessInteractiveChatService({
      basePromptLoopOptions: {
        artifactRoot: root,
        sandboxRuntime: sandbox,
        model: "test",
      },
      runIdForTurn: (_sessionId, turnId) => turnId,
      createPromptLoop: (options) =>
        new CfHarnessPromptLoop({
          ...options,
          allowedToolIds: ["read_file"],
          modelClient: {
            providerId: "test-provider",
            complete: async () => {
              calls += 1;
              if (calls === 2) {
                waiting.resolve();
                await release.promise;
              }
              return {
                assistant: {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    call("read_file", { path: "/workspace/note.txt" }),
                  ],
                },
                usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
              };
            },
          },
        }),
    });
    try {
      await service.startSession("session", {
        sessionId: "conversation",
        workspace: { hostPath: "/workspace" },
      });
      await service.startTurn("start", {
        sessionId: "conversation",
        turnId: "canceled",
        input: { text: "Read the note." },
      });
      const done = service.waitForTurn("conversation", "canceled");
      await Promise.race([
        waiting.promise,
        done.then(() => {
          throw new Error("turn ended before cancellation");
        }),
      ]);
      await service.cancelTurn(
        "cancel",
        "conversation",
        "canceled",
        "user requested",
      );
      release.resolve();
      await done;
      const updates = service.events("conversation").filter((entry) =>
        entry.event.kind === "turn_usage"
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].event).toMatchObject({
        turnId: "canceled",
        usage: { totalTokens: 12 },
      });
      const report = JSON.parse(
        await Deno.readTextFile(join(root, "canceled", "run-report.json")),
      );
      expect(report.status).toBe("canceled");
      expect(report.totalUsage.totalTokens).toBe(24);
    } finally {
      release.resolve();
      await service.waitForTurn("conversation", "canceled");
      await Deno.remove(root, { recursive: true });
    }
  });

  for (const reportsUsage of [false, true]) {
    it(`preserves ${reportsUsage ? "partially" : "entirely"} unreported usage without inventing a complete cost`, async () => {
      const updates: HarnessModelUsageUpdate[] = [];
      let calls = 0;
      const usage: HarnessModelUsage = {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        costUsd: 1,
        estimatedCostUsd: 0.5,
      };
      const loop = new CfHarnessPromptLoop({
        sandboxRuntime: sandbox,
        model: "test",
        runId: "partial-usage",
        allowedToolIds: ["read_file"],
        modelClient: {
          providerId: "test-provider",
          complete: () => {
            calls += 1;
            return Promise.resolve({
              assistant: {
                role: "assistant",
                content: calls === 3 ? "Read." : "",
                toolCalls: calls === 3 ? [] : [
                  call(
                    "read_file",
                    { path: "/workspace/note.txt" },
                    `read-${calls}`,
                  ),
                ],
              },
              ...(reportsUsage && calls !== 2 ? { usage } : {}),
            });
          },
        },
      });
      const result = await loop.runPrompt({
        prompt: "Read the repository notes.",
        promptSlotBinding: directPromptSlotBindingFor("partial-usage"),
        onModelUsage: async (update) => {
          await Promise.resolve();
          updates.push(update);
        },
      });
      expect(updates.map((entry) => entry.usage)).toEqual(
        reportsUsage
          ? [usage, undefined, usage]
          : [undefined, undefined, undefined],
      );
      expect(result.totalUsage).toEqual(
        reportsUsage
          ? {
            inputTokens: 20,
            outputTokens: 4,
            totalTokens: 24,
            estimateWithheldReason: "incomplete-estimates",
          }
          : undefined,
      );
      expect(updates.at(-1)?.totalUsage).toEqual(result.totalUsage);
    });
  }

  it("projects only recognized finite usage fields from stored reports", () => {
    expect(
      readHarnessModelUsage({
        inputTokens: 0,
        outputTokens: 12,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 3,
        totalTokens: 12,
        costUsd: 0.1,
        estimatedCostUsd: 0.2,
        secret: "not usage",
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 12,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
      totalTokens: 12,
      costUsd: 0.1,
      estimatedCostUsd: 0.2,
    });
    expect(
      readHarnessModelUsage({
        inputTokens: -1,
        outputTokens: "12",
        totalTokens: Infinity,
        costUsd: NaN,
        estimateWithheldReason: "unknown-model",
      }),
    ).toEqual({ estimateWithheldReason: "unknown-model" });
    expect(
      readHarnessModelUsage({
        estimateWithheldReason: "private provider cause",
        secret: "not usage",
      }),
    ).toBeUndefined();
    expect(readHarnessModelUsage(null)).toBeUndefined();
    expect(readHarnessModelUsage([])).toBeUndefined();
  });

  it("omits unavailable or reversed turn clocks while retaining a real zero", () => {
    const start = "2026-09-21T00:00:00.000Z";
    expect(harnessChatTurnElapsedMs(start, start)).toBe(0);
    expect(harnessChatTurnElapsedMs(undefined, start)).toBeUndefined();
    expect(harnessChatTurnElapsedMs(start, undefined)).toBeUndefined();
    expect(harnessChatTurnElapsedMs("bad", start)).toBeUndefined();
    expect(harnessChatTurnElapsedMs(start, "2026-09-20T00:00:00.000Z"))
      .toBeUndefined();
  });
});
