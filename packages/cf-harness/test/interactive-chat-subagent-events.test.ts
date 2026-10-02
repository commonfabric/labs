import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type {
  HarnessTranscriptMessage,
  HarnessTranscriptSubagentContext,
} from "../src/contracts/transcript.ts";
import type {
  HarnessChatEventEnvelope,
  HarnessChatStructuredEvent,
} from "../src/contracts/interactive-chat.ts";

const nextIsoNow = () => {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-05-22T00:00:${String(counter).padStart(2, "0")}.000Z`;
  };
};

const DELEGATE_TOOL_CALL_ID = "tool-delegate-1";

const subagentContext: HarnessTranscriptSubagentContext = {
  parentToolCallId: DELEGATE_TOOL_CALL_ID,
  childRunId: "run-1.subagent.1",
  profile: "default",
  goal: "Summarize the notes",
};

const delegateCall: HarnessTranscriptMessage = {
  role: "assistant",
  content: "",
  toolCalls: [{
    id: DELEGATE_TOOL_CALL_ID,
    type: "function",
    function: {
      name: "delegate_task",
      arguments: JSON.stringify({
        profile: "default",
        goal: subagentContext.goal,
      }),
    },
  }],
};

const childReadCall: HarnessTranscriptMessage = {
  role: "assistant",
  content: "",
  reasoning: "The notes are in the workspace, so read them first.",
  toolCalls: [{
    id: "child-tool-1",
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "/workspace/notes.md" }),
    },
  }],
};

const childReadResult: HarnessTranscriptMessage = {
  role: "tool",
  toolCallId: "child-tool-1",
  toolName: "read_file",
  content: JSON.stringify({
    outputId: "run-1.subagent.1:read_file:1",
    path: "/workspace/notes.md",
    content: "two notes",
  }),
};

const childAnswer: HarnessTranscriptMessage = {
  role: "assistant",
  content: "Two notes.",
};

const delegateResult: HarnessTranscriptMessage = {
  role: "tool",
  toolCallId: DELEGATE_TOOL_CALL_ID,
  toolName: "delegate_task",
  content: JSON.stringify({
    type: "cf-harness.delegate-task-output",
    outputId: "run-1:delegate_task:1",
    subagent: { status: "completed", summary: "Two notes." },
  }),
};

const parentAnswer: HarnessTranscriptMessage = {
  role: "assistant",
  content: "The subagent found two notes.",
};

/**
 * A loop that delegates one task, forwards the child's transcript events the
 * way `delegate_task` does, and then answers. The child's transcript stays
 * short while the parent's grows, which is what a nested loop's events look
 * like to the handler the parent was given.
 */
const delegatingLoop: HarnessInteractivePromptLoopFactory = () => ({
  runTranscript: async (
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> => {
    const parent = [...options.transcript];
    const emitParent = async (message: HarnessTranscriptMessage) => {
      parent.push(message);
      await options.onTranscriptEvent?.({ message, transcript: [...parent] });
    };
    const child: HarnessTranscriptMessage[] = [
      { role: "system", content: "You are a subagent." },
      { role: "user", content: subagentContext.goal },
    ];
    const emitChild = async (message: HarnessTranscriptMessage) => {
      child.push(message);
      await options.onTranscriptEvent?.({
        message,
        transcript: [...child],
        subagent: subagentContext,
      });
    };

    await emitParent(delegateCall);
    for (const seeded of [...child]) {
      await options.onTranscriptEvent?.({
        message: seeded,
        transcript: [...child],
        subagent: subagentContext,
      });
    }
    await emitChild(childReadCall);
    await emitChild(childReadResult);
    await emitChild(childAnswer);
    await emitParent(delegateResult);
    await emitParent(parentAnswer);

    return {
      model: "gpt-test",
      finalAssistantText: parentAnswer.content,
      transcript: parent,
      modelTurns: 2,
      runState: {} as HarnessPromptLoopResult["runState"],
    };
  },
});

const runDelegatingTurn = async (): Promise<HarnessInteractiveChatService> => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop: delegatingLoop,
    now: nextIsoNow(),
  });
  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Delegate the summary" },
  });
  await service.waitForTurn("session-1", "turn-1");
  return service;
};

const kindsOf = (events: readonly HarnessChatEventEnvelope[]) =>
  events.map((envelope) => envelope.event.kind);

const subagentTagOf = (
  event: HarnessChatStructuredEvent,
): unknown =>
  "subagent" in event ? (event as { subagent?: unknown }).subagent : undefined;

describe("interactive-chat subagent events", () => {
  it("brackets the child's derived events between start and completion", async () => {
    const service = await runDelegatingTurn();

    expect(kindsOf(service.events("session-1"))).toEqual([
      "session_started",
      "turn_started",
      "tool_started",
      "subagent_started",
      "assistant_reasoning",
      "tool_started",
      "tool_completed",
      "assistant_delta",
      "assistant_completed",
      "subagent_completed",
      "tool_completed",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ]);
  });

  it("reports a child's reasoning before the call it led to, tagged with the child", async () => {
    const service = await runDelegatingTurn();

    const reasoning = service.events("session-1").find((envelope) =>
      envelope.event.kind === "assistant_reasoning"
    )?.event;

    expect(reasoning).toEqual({
      kind: "assistant_reasoning",
      text: "The notes are in the workspace, so read them first.",
      subagent: subagentContext,
    });
  });

  it("reports the child's profile and goal on subagent_started", async () => {
    const service = await runDelegatingTurn();

    const started = service.events("session-1").find((envelope) =>
      envelope.event.kind === "subagent_started"
    );
    expect(started?.event).toEqual({
      kind: "subagent_started",
      subagent: {
        parentToolCallId: DELEGATE_TOOL_CALL_ID,
        childRunId: "run-1.subagent.1",
        profile: "default",
        goal: "Summarize the notes",
      },
    });
  });

  it("tags a child tool_completed with the subagent it came from", async () => {
    const service = await runDelegatingTurn();

    const completions = service.events("session-1").filter((envelope) =>
      envelope.event.kind === "tool_completed"
    );
    expect(completions).toHaveLength(2);
    const [childCompletion, parentCompletion] = completions;
    expect(childCompletion.event).toEqual({
      kind: "tool_completed",
      status: "completed",
      tool: { toolCallId: "child-tool-1", toolId: "read_file" },
      resultSummary: childReadResult.content,
      subagent: {
        parentToolCallId: DELEGATE_TOOL_CALL_ID,
        childRunId: "run-1.subagent.1",
        profile: "default",
        goal: "Summarize the notes",
      },
    });
    expect(subagentTagOf(parentCompletion.event)).toBeUndefined();
  });

  it("summarizes a child tool result from the model-facing content alone", async () => {
    const service = await runDelegatingTurn();

    const summaries = service.events("session-1")
      .map((envelope) => envelope.event)
      .filter((event) => event.kind === "tool_completed")
      .map((event) => event.resultSummary);
    expect(summaries).toEqual([
      childReadResult.content,
      delegateResult.content,
    ]);
  });

  it("keeps sequences monotonic across parent and child events", async () => {
    const service = await runDelegatingTurn();

    const sequences = service.events("session-1").map((envelope) =>
      envelope.sequence
    );
    expect(sequences).toEqual(
      sequences.map((_value, index) => sequences[0] + index),
    );
  });

  it("replays the child's events through list_events", async () => {
    const service = await runDelegatingTurn();

    const all = service.listEvents({ sessionId: "session-1" });
    expect(kindsOf(all.events)).toEqual(kindsOf(service.events("session-1")));
    expect(all.latestSequence).toBe(
      all.events[all.events.length - 1].sequence,
    );

    const startedAt = all.events.findIndex((envelope) =>
      envelope.event.kind === "subagent_started"
    );
    const resumed = service.listEvents({
      sessionId: "session-1",
      afterSequence: all.events[startedAt].sequence,
    });
    expect(kindsOf(resumed.events)).toEqual(
      kindsOf(all.events.slice(startedAt + 1)),
    );
  });
});
