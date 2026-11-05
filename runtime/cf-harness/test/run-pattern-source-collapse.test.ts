import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";
import { collapseSupersededRunPatternSources } from "../src/run-pattern-source-collapse.ts";

const SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "export default pattern<{ n: number }, { doubled: number }>(",
  `  ({ n }) => ({ doubled: computed(() => n * 2) }), // ${"pad ".repeat(60)}`,
  ");",
].join("\n");

const runPatternCall = (
  toolCallId: string,
  args: Record<string, unknown>,
): HarnessTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{
    id: toolCallId,
    type: "function",
    function: { name: "run_pattern", arguments: JSON.stringify(args) },
  }],
});

const runPatternResult = (
  toolCallId: string,
  outputId: string,
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId,
  toolName: "run_pattern",
  content: JSON.stringify({
    outputId,
    status: "compile-error",
    message: "[ERROR] Cannot find name 'Celll'.",
  }),
});

const attempt = (
  toolCallId: string,
  outputId: string,
  args: Record<string, unknown> = { sourceText: SOURCE },
): HarnessTranscriptMessage[] => [
  runPatternCall(toolCallId, args),
  runPatternResult(toolCallId, outputId),
];

/** Stands for a run whose artifact store held every source it was given. */
const preservedIn = (
  transcript: readonly HarnessTranscriptMessage[],
): Set<string> => {
  const preserved = new Set<string>();
  for (const message of transcript) {
    if (message.role !== "tool" || message.toolName !== "run_pattern") continue;
    try {
      const output = JSON.parse(message.content) as { outputId?: unknown };
      if (typeof output.outputId === "string") preserved.add(output.outputId);
    } catch {
      // A result that is not JSON names no artifact.
    }
  }
  return preserved;
};

const argumentsOf = (
  message: HarnessTranscriptMessage,
  index = 0,
): Record<string, unknown> =>
  JSON.parse(
    (message as HarnessAssistantTranscriptMessage).toolCalls![index].function
      .arguments,
  );

describe("collapseSupersededRunPatternSources()", () => {
  it("leaves a lone attempt's source verbatim", () => {
    const transcript = [...attempt("call-1", "out-1")];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    expect(argumentsOf(transcript[0]).sourceText).toBe(SOURCE);
  });

  it("keeps the newest source verbatim and marks the earlier ones", () => {
    const transcript = [
      ...attempt("call-1", "out-1", {
        sourceText: SOURCE,
        description: "Doubles a number",
      }),
      ...attempt("call-2", "out-2"),
      ...attempt("call-3", "out-3"),
    ];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    expect(argumentsOf(transcript[0]).sourceText).toBe(
      "[cf-harness: superseded run_pattern source collapsed for model " +
        `context; attempt 1, ${SOURCE.length} characters. The newest ` +
        "run_pattern call carries the source to edit; this attempt's source " +
        "is preserved in tool output out-1.]",
    );
    // Every other argument of the call is left as the model wrote it.
    expect(argumentsOf(transcript[0]).description).toBe("Doubles a number");
    expect(argumentsOf(transcript[2]).sourceText).toContain("attempt 2,");
    expect(argumentsOf(transcript[2]).sourceText).toContain(
      "tool output out-2.",
    );
    expect(argumentsOf(transcript[4]).sourceText).toBe(SOURCE);
  });

  it("marks each superseded call of an assistant message that made several", () => {
    const transcript: HarnessTranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "run_pattern",
              arguments: JSON.stringify({ sourceText: SOURCE }),
            },
          },
          {
            id: "call-2",
            type: "function",
            function: {
              name: "run_pattern",
              arguments: JSON.stringify({ sourceText: SOURCE }),
            },
          },
        ],
      },
      runPatternResult("call-1", "out-1"),
      runPatternResult("call-2", "out-2"),
      ...attempt("call-3", "out-3"),
    ];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    expect(argumentsOf(transcript[0], 0).sourceText).toContain("attempt 1,");
    expect(argumentsOf(transcript[0], 1).sourceText).toContain("attempt 2,");
    expect(argumentsOf(transcript[3]).sourceText).toBe(SOURCE);
  });

  it("marks the calls of a batch whose results have arrived so far", () => {
    // The state partway through a batch: the first call's result is in, the
    // second call's is not. The second is the newest source either way.
    const transcript: HarnessTranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "run_pattern",
              arguments: JSON.stringify({ sourceText: SOURCE }),
            },
          },
          {
            id: "call-2",
            type: "function",
            function: {
              name: "run_pattern",
              arguments: JSON.stringify({ sourceText: SOURCE }),
            },
          },
        ],
      },
      runPatternResult("call-1", "out-1"),
    ];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    expect(argumentsOf(transcript[0], 0).sourceText).toContain("attempt 1,");
    expect(argumentsOf(transcript[0], 0).sourceText).toContain(
      "tool output out-1.",
    );
    expect(argumentsOf(transcript[0], 1).sourceText).toBe(SOURCE);
  });

  it("leaves a call that named a `patternId` alone", () => {
    const transcript = [
      ...attempt("call-1", "out-1", { patternId: "pattern-abc" }),
      ...attempt("call-2", "out-2"),
      ...attempt("call-3", "out-3"),
    ];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    expect(argumentsOf(transcript[0])).toEqual({ patternId: "pattern-abc" });
    // A `patternId` run is an attempt, so the source that follows it is the
    // second — the number its own diagnostic carries.
    expect(argumentsOf(transcript[2]).sourceText).toContain("attempt 2,");
  });

  it("leaves a call whose result reported no `outputId` alone", () => {
    const transcript: HarnessTranscriptMessage[] = [
      runPatternCall("call-1", { sourceText: SOURCE }),
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "run_pattern",
        content: "the call was refused before it ran",
      },
      ...attempt("call-2", "out-2"),
    ];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    expect(argumentsOf(transcript[0]).sourceText).toBe(SOURCE);
  });

  it("leaves a source whose artifact was not written verbatim", () => {
    const transcript = [
      ...attempt("call-1", "out-1"),
      ...attempt("call-2", "out-2"),
    ];

    collapseSupersededRunPatternSources(transcript, new Set());

    expect(argumentsOf(transcript[0]).sourceText).toBe(SOURCE);
  });

  it("collapses only the sources whose artifacts were written", () => {
    const transcript = [
      ...attempt("call-1", "out-1"),
      ...attempt("call-2", "out-2"),
      ...attempt("call-3", "out-3"),
    ];

    collapseSupersededRunPatternSources(transcript, new Set(["out-2"]));

    expect(argumentsOf(transcript[0]).sourceText).toBe(SOURCE);
    expect(argumentsOf(transcript[2]).sourceText).toContain("attempt 2,");
  });

  it("leaves a source shorter than its own marker verbatim", () => {
    const transcript = [
      ...attempt("call-1", "out-1", { sourceText: "export default 1;" }),
      ...attempt("call-2", "out-2"),
    ];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    expect(argumentsOf(transcript[0]).sourceText).toBe("export default 1;");
  });

  it("leaves an already marked call as it stands", () => {
    const transcript = [
      ...attempt("call-1", "out-1"),
      ...attempt("call-2", "out-2"),
    ];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));
    const once = argumentsOf(transcript[0]).sourceText;
    for (const message of attempt("call-3", "out-3")) transcript.push(message);
    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    expect(argumentsOf(transcript[0]).sourceText).toBe(once);
    expect(argumentsOf(transcript[2]).sourceText).toContain("attempt 2,");
  });

  it("leaves another tool's call and unparsable arguments alone", () => {
    const transcript: HarnessTranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: {
            name: "search_patterns",
            arguments: JSON.stringify({ query: "counter" }),
          },
        }],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-2",
          type: "function",
          function: { name: "run_pattern", arguments: "not json" },
        }],
      },
      runPatternResult("call-2", "out-2"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-2b",
          type: "function",
          function: { name: "run_pattern", arguments: "[]" },
        }],
      },
      runPatternResult("call-2b", "out-2b"),
      ...attempt("call-3", "out-3"),
      ...attempt("call-4", "out-4"),
    ];

    collapseSupersededRunPatternSources(transcript, preservedIn(transcript));

    const argumentsAt = (index: number): string =>
      (transcript[index] as HarnessAssistantTranscriptMessage).toolCalls![0]
        .function.arguments;
    expect(argumentsOf(transcript[0])).toEqual({ query: "counter" });
    expect(argumentsAt(1)).toBe("not json");
    expect(argumentsAt(3)).toBe("[]");
    // Both unreadable calls are attempts; the source that follows is third.
    expect(argumentsOf(transcript[5]).sourceText).toContain("attempt 3,");
    expect(argumentsOf(transcript[7]).sourceText).toBe(SOURCE);
  });
});
