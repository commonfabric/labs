import type { HarnessChatSessionStore } from "../../src/session-store.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../../src/prompt-loop.ts";
import type { HarnessInteractivePromptLoopFactory } from "../../src/interactive-chat-service.ts";
import { createHarnessRunState } from "../../src/run-state.ts";

export const TOOL_CALL_IDS = ["call-a", "call-b"] as const;

export const toolCall = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "read_file", arguments: "{}" },
});

/**
 * Every point at which a turn can die once it has declared two tool calls:
 * before either result, between them, and after both.
 */
export const FAULT_POINTS = [0, 1, 2] as const;

export type ChatFault = "error" | "cancel" | "interrupt";

export const FAULT_KINDS: readonly ChatFault[] = ["error", "cancel"];

/**
 * A prompt loop that reports an assistant message declaring both tool calls,
 * then `resultsBeforeFault` of their results, then dies the named way.
 *
 * `cancel` waits to be released so the test can cancel the turn while the loop
 * is mid-tool; `interrupt` never settles, standing in for a process that was
 * killed with a turn in flight.
 */
export interface FaultingToolLoopOptions {
  /** Held by a test that wants to act while the loop sits mid-tool. */
  release?: Promise<void>;

  /**
   * Called once the loop has reported everything it ever will. A test that
   * inspects the store while an interrupted turn is still in flight waits on
   * this, so it reads a settled store rather than racing the writes.
   */
  onFault?: () => void;
}

export const faultingToolLoop = (
  resultsBeforeFault: number,
  fault: ChatFault,
  options: FaultingToolLoopOptions = {},
): HarnessInteractivePromptLoopFactory =>
(loopOptions) => ({
  runTranscript: async (runOptions: RunHarnessTranscriptOptions) => {
    const assistant = {
      role: "assistant" as const,
      content: "Reading both files.",
      toolCalls: TOOL_CALL_IDS.map(toolCall),
    };
    const transcript: HarnessTranscriptMessage[] = [
      ...runOptions.transcript,
      assistant,
    ];
    await runOptions.onTranscriptEvent?.({ message: assistant, transcript });
    for (const id of TOOL_CALL_IDS.slice(0, resultsBeforeFault)) {
      const message = {
        role: "tool" as const,
        toolCallId: id,
        toolName: "read_file",
        content: `contents for ${id}`,
      };
      transcript.push(message);
      await runOptions.onTranscriptEvent?.({ message, transcript });
    }
    if (resultsBeforeFault === TOOL_CALL_IDS.length) {
      await runOptions.onCheckpoint?.({
        transcript,
        runState: createHarnessRunState({
          runId: loopOptions.runId,
          currentDir: loopOptions.cwd ?? "/workspace",
          cfcEnforcementMode: "enforce-explicit",
          researchGoal: loopOptions.researchGoal,
          researchRuns: loopOptions.inheritedResearchRuns === undefined
            ? undefined
            : [...loopOptions.inheritedResearchRuns],
          cfcModelContext: loopOptions.inheritedCfcModelContext,
        }),
      });
    }
    options.onFault?.();
    if (fault === "interrupt") {
      return await new Promise<HarnessPromptLoopResult>(() => {});
    }
    await options.release;
    throw fault === "cancel"
      ? new DOMException("cf-harness chat turn canceled", "AbortError")
      : new Error("read_file exhausted its budget");
  },
});

/**
 * A store that keeps every transcript it was asked to persist, so a test can
 * assert an invariant over the whole history of durable writes rather than over
 * the final one alone.
 */
export const recordingStore = (): {
  store: HarnessChatSessionStore;
  snapshots: readonly HarnessTranscriptMessage[][];
} => {
  const snapshots: HarnessTranscriptMessage[][] = [];
  const keep = (transcript: readonly HarnessTranscriptMessage[]) => {
    snapshots.push([...transcript]);
  };
  return {
    snapshots,
    store: {
      saveSession: (snapshot) => keep(snapshot.transcript),
      getSession: () => undefined,
      listSessions: () => [],
      saveSessionAndAppendEvent: (snapshot) => keep(snapshot.transcript),
      saveSessionTurnAndAppendEvent: (mutation) => {
        keep(mutation.session.transcript);
        return true;
      },
      saveTurn: () => {},
      getTurn: () => undefined,
      listTurns: () => [],
      appendEvent: () => {},
      listEvents: () => [],
      latestSequence: () => 0,
    },
  };
};
