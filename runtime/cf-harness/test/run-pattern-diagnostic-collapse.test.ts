import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import { collapseSupersededRunPatternDiagnostics } from "../src/run-pattern-diagnostic-collapse.ts";

const codeFrame = (line: number) =>
  [
    "2 | import { computed, pattern } from 'commonfabric';",
    `${line} |   ({ n }) => ({ doubled: computed(() => missing(n)) }),`,
    "  |                                         ^",
  ].join("\n");

const DIAGNOSTIC = [
  `[ERROR] Cannot find name 'Celll'.\n${codeFrame(12)}`,
  `[ERROR] Cannot find name 'Celll'.\n${codeFrame(19)}`,
  `[ERROR] This expression is not callable.\n${codeFrame(24)}`,
].join("\n\n");

const runPatternFailure = (
  toolCallId: string,
  outputId: string,
  message = DIAGNOSTIC,
  status = "compile-error",
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId,
  toolName: "run_pattern",
  content: JSON.stringify({ outputId, status, message }),
});

const runPatternSuccess = (
  toolCallId: string,
  outputId: string,
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId,
  toolName: "run_pattern",
  content: JSON.stringify({ outputId, status: "ok", resultRef: "ref-1" }),
});

const contentOf = (message: HarnessTranscriptMessage): string =>
  (message as { content: string }).content;

const parseContent = (
  message: HarnessTranscriptMessage,
): Record<string, unknown> => JSON.parse(contentOf(message));

describe("collapseSupersededRunPatternDiagnostics()", () => {
  it("leaves a lone failure verbatim", () => {
    const transcript = [runPatternFailure("call-1", "out-1")];

    collapseSupersededRunPatternDiagnostics(transcript);

    expect(parseContent(transcript[0]).message).toBe(DIAGNOSTIC);
  });

  it("keeps the newest failure verbatim and summarizes the earlier ones", () => {
    const transcript = [
      runPatternFailure("call-1", "out-1"),
      runPatternFailure("call-2", "out-2"),
      runPatternFailure("call-3", "out-3"),
    ];

    collapseSupersededRunPatternDiagnostics(transcript);

    expect(parseContent(transcript[0]).message).toBe(
      "[cf-harness: superseded run_pattern diagnostic collapsed for model " +
        "context; attempt 1, compile-error, 3 errors: " +
        '"Cannot find name \'Celll\'." x2; "This expression is not callable.". ' +
        "Full diagnostic is preserved in tool output out-1.]",
    );
    expect(parseContent(transcript[1]).message).toContain("attempt 2,");
    expect(parseContent(transcript[1]).message).toContain("tool output out-2.");
    expect(parseContent(transcript[2]).message).toBe(DIAGNOSTIC);
  });

  it("records the collapse and the length of the diagnostic it replaced", () => {
    const transcript = [
      runPatternFailure("call-1", "out-1"),
      runPatternFailure("call-2", "out-2"),
    ];

    collapseSupersededRunPatternDiagnostics(transcript);

    expect(parseContent(transcript[0]).messageCollapsed).toBe(true);
    expect(parseContent(transcript[0]).messageOriginalLength).toBe(
      DIAGNOSTIC.length,
    );
    expect(parseContent(transcript[1]).messageCollapsed).toBe(undefined);
  });

  it("numbers an attempt by its position among all `run_pattern` results", () => {
    const transcript = [
      runPatternFailure("call-1", "out-1"),
      runPatternSuccess("call-2", "out-2"),
      runPatternFailure("call-3", "out-3"),
      runPatternFailure("call-4", "out-4"),
    ];

    collapseSupersededRunPatternDiagnostics(transcript);

    expect(parseContent(transcript[0]).message).toContain("attempt 1,");
    expect(parseContent(transcript[2]).message).toContain("attempt 3,");
  });

  it("keeps the fields beside the diagnostic, a policy refusal among them", () => {
    const policyRefusal = { gates: ["sink-ceiling"], sinks: ["mail"] };
    const runtimeFailure = `the commit boundary refused this run. ${
      "It named no offending input. ".repeat(8)
    }`;
    const transcript: HarnessTranscriptMessage[] = [
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "run_pattern",
        content: JSON.stringify({
          outputId: "out-1",
          status: "error",
          message: runtimeFailure,
          policyRefusal,
        }),
      },
      runPatternFailure("call-2", "out-2"),
    ];

    collapseSupersededRunPatternDiagnostics(transcript);

    const collapsed = parseContent(transcript[0]);
    expect(collapsed.outputId).toBe("out-1");
    expect(collapsed.status).toBe("error");
    expect(collapsed.policyRefusal).toEqual(policyRefusal);
    expect(collapsed.message).toBe(
      "[cf-harness: superseded run_pattern diagnostic collapsed for model " +
        'context; attempt 1, error, first line: "' +
        `${runtimeFailure.trim().slice(0, 100)}...". ` +
        "Full diagnostic is preserved in tool output out-1.]",
    );
  });

  it("counts two errors sharing a long prefix as two classes", () => {
    const prefix = `Type '{ ${"donut: string; ".repeat(12)}}' is not `;
    const transcript = [
      runPatternFailure(
        "call-1",
        "out-1",
        [
          `[ERROR] ${prefix}assignable to parameter of type 'Glaze'.`,
          `[ERROR] ${prefix}assignable to parameter of type 'Fryer'.`,
        ].join("\n"),
      ),
      runPatternFailure("call-2", "out-2"),
    ];

    collapseSupersededRunPatternDiagnostics(transcript);

    const message = parseContent(transcript[0]).message as string;
    expect(message).toContain("2 errors:");
    expect(message).not.toContain("x2");
    expect(message.split(`"${prefix.slice(0, 100)}..."`).length - 1).toBe(2);
  });

  it("leaves a diagnostic shorter than its own summary verbatim", () => {
    const transcript = [
      runPatternFailure("call-1", "out-1", "[ERROR] Cannot find name 'x'."),
      runPatternFailure("call-2", "out-2"),
    ];

    collapseSupersededRunPatternDiagnostics(transcript);

    expect(parseContent(transcript[0]).message).toBe(
      "[ERROR] Cannot find name 'x'.",
    );
    expect(parseContent(transcript[0]).messageCollapsed).toBe(undefined);
  });

  it("leaves an already collapsed summary as it stands", () => {
    const transcript = [
      runPatternFailure("call-1", "out-1"),
      runPatternFailure("call-2", "out-2"),
    ];

    collapseSupersededRunPatternDiagnostics(transcript);
    const once = contentOf(transcript[0]);
    transcript.push(runPatternFailure("call-3", "out-3"));
    collapseSupersededRunPatternDiagnostics(transcript);

    expect(contentOf(transcript[0])).toBe(once);
    expect(parseContent(transcript[1]).messageCollapsed).toBe(true);
  });

  it("leaves a successful result, another tool's result, and unparsable content alone", () => {
    const transcript: HarnessTranscriptMessage[] = [
      runPatternSuccess("call-1", "out-1"),
      {
        role: "tool",
        toolCallId: "call-2",
        toolName: "bash",
        content: JSON.stringify({
          outputId: "out-2",
          status: "error",
          message: DIAGNOSTIC,
        }),
      },
      {
        role: "tool",
        toolCallId: "call-3",
        toolName: "run_pattern",
        content: "not json",
      },
      runPatternFailure("call-4", "out-4"),
      runPatternFailure("call-5", "out-5"),
    ];
    const untouched = transcript.slice(0, 3).map(contentOf);

    collapseSupersededRunPatternDiagnostics(transcript);

    expect(transcript.slice(0, 3).map(contentOf)).toEqual(untouched);
    expect(parseContent(transcript[3]).messageCollapsed).toBe(true);
    expect(parseContent(transcript[4]).message).toBe(DIAGNOSTIC);
  });
});
