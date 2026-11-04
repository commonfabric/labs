/** Shared follow-up history, state retention, and chat replay boundaries. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { HarnessResearchRunSummary } from "../src/contracts/research.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import {
  HARNESS_CHAT_INTERRUPTED_TURN_NOTICE,
  HarnessInteractiveChatService,
} from "../src/interactive-chat-service.ts";

import {
  NEXT_RUN_STATE_FIELDS,
  prepareHarnessContinuation,
} from "../src/run-continuation.ts";
import {
  createHarnessRunState,
  type HarnessRunState,
  type HarnessRunStatus,
} from "../src/run-state.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { INERT_RUNSC } from "./support/inert-runsc.ts";

const history: HarnessTranscriptMessage[] = [
  { role: "user", content: "First task" },
  { role: "assistant", content: "First answer" },
];

const priorState = () =>
  createHarnessRunState({
    runId: "prior",
    status: "completed",
    currentDir: "/workspace",
    cfcEnforcementMode: "disabled",
    systemPromptInputs: {},
  });

const answer = (index: number): HarnessResearchRunSummary => ({
  type: "cf-harness.research-run",
  researchRunId: `research-${index}`,
  outputId: `output-${index}`,
  completedAt: "2026-10-28T00:00:00.000Z",
  confirmedPatterns: [],
  describedHandles: [],
  kit: {
    purpose: "answer",
    status: "complete",
    task: "Find the reader",
    summary: `Answer ${index}`,
    inputs: [],
    patterns: [],
    rules: [],
    sources: [],
    missing: [],
  },
});

describe("next-run-builder", () => {
  for (
    const [status, count] of Object.entries(
      {
        pending: 1,
        running: 1,
        canceled: 1,
        failed: 1,
        completed: 0,
      } satisfies Record<HarnessRunStatus, number>,
    )
  ) {
    it(`includes ${count} interrupted notices for paired ${status} history`, async () => {
      const state = priorState();
      state.status = status as HarnessRunStatus;
      const next = await prepareHarnessContinuation({
        runState: state,
        transcript: history,
        prompt: "Continue",
        workspace: "/workspace",
        artifactRoot: "/workspace/runs",
        schemaExplicit: false,
      });
      expect(
        next.transcript.filter((message) =>
          message.content.startsWith("Host turn notice:")
        ),
      ).toHaveLength(count);
    });
  }

  for (const outcome of ["failed", "completed"] as const) {
    it(`retains paired ${outcome} chat history with ${outcome === "failed" ? "one" : "no"} interrupted notice`, async () => {
      const seeds: (readonly HarnessTranscriptMessage[])[] = [];
      const partial: HarnessTranscriptMessage[] = [{
        role: "assistant",
        content: "Reading the first file",
        toolCalls: [{
          id: "read",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"first.txt"}' },
        }],
      }, {
        role: "tool",
        toolCallId: "read",
        toolName: "read_file",
        content: "Partial evidence",
      }];
      const service = new HarnessInteractiveChatService({
        basePromptLoopOptions: { finalizeOnTurnLimit: true },
        createPromptLoop: () => ({
          runTranscript: async (options) => {
            seeds.push([...options.transcript]);
            const transcript = [...options.transcript];
            if (seeds.length === 1) {
              for (const message of partial) transcript.push(message);
              await options.onCheckpoint?.({
                transcript,
                runState: { ...priorState(), status: "running" },
              });
              if (outcome === "failed") {
                throw new Error("Provider disconnected");
              }
            }
            transcript.push({ role: "assistant", content: "Finished" });
            return {
              model: "test",
              modelTurns: 1,
              finalAssistantText: "Finished",
              runState: priorState(),
              transcript,
            };
          },
        }),
      });
      await service.startSession("start", {
        sessionId: "session",
        workspace: { hostPath: "/workspace" },
      });
      await service.startTurn("first", {
        sessionId: "session",
        turnId: "first",
        input: { text: "Read both files" },
      });
      await service.waitForTurn("session", "first");
      expect(service.listTurns({ sessionId: "session" }).turns[0].turn.status)
        .toBe(outcome);
      await service.startTurn("second", {
        sessionId: "session",
        turnId: "second",
        input: { text: "Continue" },
      });
      await service.waitForTurn("session", "second");
      expect(seeds).toHaveLength(2);
      expect(
        seeds[1].filter((message) =>
          message.role !== "user" || !message.turnLocal
        ).slice(0, 3),
      ).toEqual([
        { role: "user", content: "Read both files" },
        ...partial,
      ]);
      expect(
        seeds[1].filter((message) =>
          message.content === HARNESS_CHAT_INTERRUPTED_TURN_NOTICE
        ),
      ).toHaveLength(outcome === "failed" ? 1 : 0);
      expect(seeds[1].at(-1)).toEqual({ role: "user", content: "Continue" });
    });
  }

  it("classifies every run-state field with a retention reason", () => {
    const fields: Record<
      keyof HarnessRunState,
      { kind: string; reason: string }
    > = NEXT_RUN_STATE_FIELDS;
    expect(Object.keys(fields).length).toBeGreaterThan(0);
    for (const field of Object.values(fields)) {
      expect(["carried", "re-derived", "excluded"]).toContain(field.kind);
      expect(field.reason.length).toBeGreaterThan(0);
    }
    expect(fields.systemPromptInputs.kind).toBe("carried");
  });

  it("marks every replay at the loop source and excludes persisted local notices from checkpoints", async () => {
    const root = await Deno.makeTempDir();
    try {
      const seeds: HarnessTranscriptMessage[] = [];
      const checkpoints: (readonly HarnessTranscriptMessage[])[] = [];
      const loop = new CfHarnessPromptLoop({
        ...INERT_RUNSC,
        workspaceHostPath: root,
        artifactRoot: root,
        cfcEnforcementModeOverride: "disabled",
        requirePieceOutput: true,
        maxModelTurns: 1,
        model: "test",
        modelClient: {
          providerId: "openai-compatible-gateway",
          complete: () =>
            Promise.resolve({
              assistant: {
                role: "assistant",
                content: "Fresh answer",
                toolCalls: [{
                  id: "finish",
                  type: "function",
                  function: {
                    name: "finish_task",
                    arguments: JSON.stringify({
                      outcome: "completed",
                      message: "Fresh answer",
                    }),
                  },
                }],
              },
            }),
        },
      });
      const result = await loop.runTranscript({
        transcript: [...history, {
          role: "user",
          content: "Persisted notice",
          turnLocal: true,
        }, { role: "user", content: "New input" }],
        onTranscriptEvent: (event) => {
          if (event.seed) seeds.push(event.message);
        },
        onCheckpoint: (checkpoint) => {
          checkpoints.push(checkpoint.transcript);
        },
      });
      expect(seeds.map((message) => message.content)).toContain(
        "Persisted notice",
      );
      expect(seeds.length).toBeGreaterThan(4);
      expect(seeds.map((message) => message.content)).not.toContain(
        "Fresh answer",
      );
      expect(checkpoints.length).toBeGreaterThan(0);
      for (const transcript of [...checkpoints, result.transcript]) {
        expect(
          transcript.some((message) =>
            message.role === "user" && message.turnLocal
          ),
        ).toBe(false);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("excludes a flagged notice saved in a chat checkpoint while retaining the same unflagged words", async () => {
    const seeds: (readonly HarnessTranscriptMessage[])[] = [];
    const service = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) => {
          seeds.push([...options.transcript]);
          return Promise.resolve({
            model: "test",
            modelTurns: 1,
            finalAssistantText: "Answer",
            runState: priorState(),
            transcript: [
              ...options.transcript,
              {
                role: "user" as const,
                content: "Persisted chat notice",
                turnLocal: true as const,
              },
              { role: "user" as const, content: "Persisted chat notice" },
              { role: "assistant" as const, content: "Answer" },
            ],
          });
        },
      }),
    });
    await service.startSession("start", {
      sessionId: "session",
      workspace: { hostPath: "/workspace" },
    });
    for (const turnId of ["one", "two"]) {
      await service.startTurn(turnId, {
        sessionId: "session",
        turnId,
        input: { text: turnId },
      });
      await service.waitForTurn("session", turnId);
    }
    expect(
      seeds[1].filter((message) => message.content === "Persisted chat notice"),
    ).toEqual([{ role: "user", content: "Persisted chat notice" }]);
  });

  it("bounds retained research across a chain of continuations", async () => {
    let state = priorState();
    for (let index = 0; index < 6; index++) {
      state.researchRuns = [...state.researchRuns ?? [], answer(index)];
      const next = await prepareHarnessContinuation({
        runState: state,
        transcript: history,
        prompt: "Continue",
        workspace: "/workspace",
        artifactRoot: "/workspace/runs",
        schemaExplicit: false,
      });
      expect(next.runState.researchRuns?.length).toBeLessThanOrEqual(2);
      expect(next.runState.researchRuns?.at(-1)?.researchRunId).toBe(
        `research-${index}`,
      );
      expect(next.runState.researchRuns?.every((run) => run.historical)).toBe(
        true,
      );
      state = next.runState;
    }
  });

  it("re-establishes context as turn-local messages after the retained history", async () => {
    const next = await prepareHarnessContinuation({
      runState: priorState(),
      transcript: [...history, {
        role: "user",
        content: "Old grants",
        turnLocal: true,
      }],
      prompt: "Continue",
      workspace: "/workspace",
      artifactRoot: "/workspace/runs",
      schemaExplicit: false,
      establishContext: () =>
        Promise.resolve({ messages: ["Current grants", "Current skills"] }),
    });
    expect(next.transcript).toEqual([
      ...history,
      { role: "user", content: "Current grants", turnLocal: true },
      { role: "user", content: "Current skills", turnLocal: true },
      { role: "user", content: "Continue" },
    ]);
  });

  it("forwards no seed replay when the loop splices guidance into the seed", async () => {
    const root = await Deno.makeTempDir();
    const service = new HarnessInteractiveChatService({
      basePromptLoopOptions: {
        ...INERT_RUNSC,
        artifactRoot: root,
        cfcEnforcementModeOverride: "disabled",
      },
      createPromptLoop: () => ({
        runTranscript: async (options) => {
          const replay: HarnessTranscriptMessage = {
            role: "assistant",
            content: "Old answer",
          };
          const transcript: HarnessTranscriptMessage[] = [
            replay,
            ...options.transcript,
          ];
          transcript.splice(transcript.length - 1, 0, {
            role: "user",
            content: "Guidance",
            turnLocal: true,
          });
          for (const message of transcript) {
            await options.onTranscriptEvent?.({
              message,
              transcript,
              seed: true,
            });
          }
          const message = { role: "assistant" as const, content: "New answer" };
          transcript.push(message);
          await options.onTranscriptEvent?.({ message, transcript });
          return {
            model: "test",
            modelTurns: 1,
            finalAssistantText: message.content,
            transcript,
            runState: priorState(),
          };
        },
      }),
    });
    try {
      await service.startSession("start", {
        sessionId: "session",
        workspace: { hostPath: root },
        model: "test",
      });
      await service.startTurn("turn", {
        sessionId: "session",
        turnId: "turn",
        input: { text: "Seed input" },
      });
      await service.waitForTurn("session", "turn");
      const events = service.events("session").map(({ event }) => event);
      expect(events.filter((event) => event.kind === "assistant_completed"))
        .toHaveLength(1);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
