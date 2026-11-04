import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type HarnessToolCall,
  type HarnessTranscriptDefect,
  type HarnessTranscriptMessage,
  inspectHarnessTranscriptPairing,
  isResumableHarnessTranscript,
} from "../../src/contracts/transcript.ts";
import { toResponsesInput } from "../../src/model/responses-protocol.ts";

const call = (id: string): HarnessToolCall => ({
  id,
  type: "function",
  function: { name: "read_file", arguments: "{}" },
});

const assistant = (
  content: string,
  ...toolCalls: HarnessToolCall[]
): HarnessTranscriptMessage => ({
  role: "assistant",
  content,
  ...(toolCalls.length > 0 ? { toolCalls } : {}),
});

const result = (id: string): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId: id,
  toolName: "read_file",
  content: `contents for ${id}`,
});

const user = (content: string): HarnessTranscriptMessage => ({
  role: "user",
  content,
});

/**
 * Each case names the transcript, the defects it should report, and where its
 * resumable prefix ends. `safeBoundary` is stated for every case on purpose: a
 * boundary that runs past a defect is the failure mode that hides here, and it
 * is invisible to a test that only checks the defect list.
 */
const CASES: readonly {
  name: string;
  transcript: readonly HarnessTranscriptMessage[];
  defects: readonly HarnessTranscriptDefect[];
  safeBoundary: number;
}[] = [
  { name: "an empty transcript", transcript: [], defects: [], safeBoundary: 0 },
  {
    name: "a fully paired transcript",
    transcript: [
      user("read both"),
      assistant("reading", call("a"), call("b")),
      result("a"),
      result("b"),
      assistant("done"),
    ],
    defects: [],
    safeBoundary: 5,
  },
  {
    name: "an assistant message whose two calls are both unanswered",
    transcript: [user("read both"), assistant("reading", call("a"), call("b"))],
    defects: [{
      kind: "unresolved_tool_calls",
      messageIndex: 1,
      toolCallIds: ["a", "b"],
    }],
    safeBoundary: 1,
  },
  {
    name: "one of two results having landed",
    transcript: [
      user("read both"),
      assistant("reading", call("a"), call("b")),
      result("a"),
    ],
    defects: [{
      kind: "unresolved_tool_calls",
      messageIndex: 1,
      toolCallIds: ["b"],
    }],
    safeBoundary: 1,
  },
  {
    name: "a result no call preceded",
    transcript: [user("hi"), result("ghost")],
    defects: [{
      kind: "orphan_tool_result",
      messageIndex: 1,
      toolCallId: "ghost",
    }],
    safeBoundary: 1,
  },
  {
    name: "a second result for an answered call",
    transcript: [assistant("reading", call("a")), result("a"), result("a")],
    defects: [{
      kind: "duplicate_tool_result",
      messageIndex: 2,
      toolCallId: "a",
    }],
    safeBoundary: 2,
  },
  {
    name: "a call id declared twice",
    transcript: [
      assistant("reading", call("a")),
      result("a"),
      assistant("again", call("a")),
    ],
    defects: [{
      kind: "duplicate_tool_call",
      messageIndex: 2,
      toolCallId: "a",
    }],
    safeBoundary: 2,
  },
  {
    name: "a user message interleaved while calls are pending",
    transcript: [
      user("read both"),
      assistant("reading", call("a"), call("b")),
      user("actually, never mind"),
    ],
    defects: [{
      kind: "unresolved_tool_calls",
      messageIndex: 1,
      toolCallIds: ["a", "b"],
    }],
    safeBoundary: 1,
  },
  {
    name: "a result that lands after an intervening user message",
    // Pairing is by id, not adjacency. The harness cannot build this shape —
    // the prompt loop collects follow-up user messages during the tool loop and
    // appends them only once every result has landed (`prompt-loop.ts`) — and
    // nothing here establishes that a provider rejects it. Pinned so the
    // accepted reading is deliberate rather than incidental.
    transcript: [
      assistant("reading", call("a")),
      user("actually, also check the other one"),
      result("a"),
    ],
    defects: [],
    safeBoundary: 3,
  },
  {
    name: "an assistant message carrying only native model tool results",
    // Provider-side results already embedded in the assistant message. The
    // Responses projection never turns them into a call needing a partner.
    transcript: [user("search"), {
      role: "assistant",
      content: "here is what I found",
      nativeModelToolResults: [{
        type: "cf-harness.native-model-tool-result",
        toolId: "google_search",
      }],
    }],
    defects: [],
    safeBoundary: 2,
  },
];

describe("harness transcript pairing", () => {
  for (const testCase of CASES) {
    it(`reports ${testCase.name}`, () => {
      const pairing = inspectHarnessTranscriptPairing(testCase.transcript);
      expect(pairing.defects).toEqual(testCase.defects);
      expect(pairing.valid).toBe(testCase.defects.length === 0);
      expect(pairing.safeBoundary).toBe(testCase.safeBoundary);
    });
  }

  it("truncates every case to a prefix that is itself resumable", () => {
    // The property the recovery path depends on, asserted over the same table
    // rather than restated per case.
    for (const { name, transcript, safeBoundary } of CASES) {
      const prefix = transcript.slice(0, safeBoundary);
      expect(isResumableHarnessTranscript(prefix), name).toBe(true);
    }
  });

  it("projects a truncated transcript into paired provider input", async () => {
    // The boundary has to fall after a complete call/result pair, or the
    // projection below proves nothing about pairing.
    const transcript = [
      { role: "system", content: "Be careful." } as HarnessTranscriptMessage,
      user("read the first"),
      assistant("reading", call("a")),
      result("a"),
      assistant("reading both", call("b"), call("c")),
      result("b"),
    ];
    const { safeBoundary } = inspectHarnessTranscriptPairing(transcript);
    expect(safeBoundary).toBe(4);

    const { input } = await toResponsesInput(
      transcript.slice(0, safeBoundary),
      "gpt-5",
      "openai",
      "gateway Responses",
    );
    const calls = input.filter((item) => item.type === "function_call").map((
      item,
    ) => item.call_id);
    const outputs = input.filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id);
    expect(calls).toEqual(["a"]);
    // Every call has exactly one output and every output has its call: a bare
    // subset check passes on a transcript carrying neither.
    expect(outputs).toEqual(calls);
  });
});
