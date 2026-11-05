import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  formatCfHarnessCliResult,
  formatCfHarnessTranscriptEvent,
} from "../src/cli.ts";
import { createHarnessRunState } from "../src/run-state.ts";

describe("research-cli-output", () => {
  it("prints the task of an explicit research call", () => {
    expect(formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "research-call",
          type: "function",
          function: {
            name: "research",
            arguments: JSON.stringify({ task: "Compose a checklist" }),
          },
        }],
      },
      transcript: [],
    })).toBe('assistant -> tools: research(task="Compose a checklist")\n');
  });

  it("prints the question of a persisted `query_docs` call", () => {
    expect(formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "query-docs-call",
          type: "function",
          function: {
            name: "query_docs",
            arguments: JSON.stringify({
              question: "Which cell API preserves defaults?",
            }),
          },
        }],
      },
      transcript: [],
    })).toBe(
      'assistant -> tools: query_docs(question="Which cell API preserves defaults?")\n',
    );
  });

  it("prints the number of research calls that returned no kit", () => {
    const output = formatCfHarnessCliResult({
      model: "test-model",
      modelTurns: 1,
      finalAssistantText: "Research remains incomplete.",
      transcript: [],
      runState: createHarnessRunState({
        runId: "research-cli-output",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        researchFailures: 2,
      }),
    });
    expect(output).toContain(
      "researchFailures: 2 — research calls in this run or its children that returned no kit",
    );
  });
});
