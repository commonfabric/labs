import type {
  HarnessTranscriptEvent,
  HarnessTranscriptMessage,
} from "@commonfabric/cf-harness/contracts/transcript";

export const browserChild = {
  parentToolCallId: "delegate-1",
  childRunId: "job-browse.subagent.1",
  profile: "browser" as const,
  goal: "Read the opening hours",
};

/** A parent's delegation, the hosted browse, and the child's return. */
export const delegatedBrowse = (): HarnessTranscriptEvent[] => {
  const parent: HarnessTranscriptMessage[] = [];
  const child: HarnessTranscriptMessage[] = [];
  const events: HarnessTranscriptEvent[] = [];
  const call = (id: string, name: string, args: unknown, fromChild = false) => {
    const message: HarnessTranscriptMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    };
    const transcript = fromChild ? child : parent;
    transcript.push(message);
    events.push({
      message,
      transcript: [...transcript],
      ...(fromChild ? { subagent: browserChild } : {}),
    });
    if (fromChild) {
      const result: HarnessTranscriptMessage = {
        role: "tool",
        toolName: name,
        toolCallId: id,
        content: "{}",
      };
      transcript.push(result);
      events.push({
        message: result,
        transcript: [...transcript],
        subagent: browserChild,
      });
    }
  };
  call("delegate-1", "delegate_task", {
    profile: "browser",
    goal: browserChild.goal,
  });
  call("open", "browser", { action: "open", url: "https://example.com" }, true);
  call("snapshot", "browser", { action: "snapshot", interactive: true }, true);
  call("click", "browser", { action: "click", ref: "hours" }, true);
  call("click-again", "browser", { action: "click", ref: "more" }, true);
  call("return", "submit_result", { answer: "Nine to five" }, true);
  const message: HarnessTranscriptMessage = {
    role: "tool",
    toolCallId: "delegate-1",
    toolName: "delegate_task",
    content: "{}",
  };
  parent.push(message);
  events.push({ message, transcript: [...parent] });
  call("done", "submit_result", { answer: "Nine to five" });
  return events;
};
