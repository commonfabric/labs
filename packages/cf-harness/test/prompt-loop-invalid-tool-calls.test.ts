/**
 * A tool call the model wrote wrong — a name no tool answers to, arguments
 * that are not JSON, an argument of the wrong shape — comes back as a tool
 * result the next turn can correct, and leaves a trace behind it. Only
 * failures the model cannot correct end the run.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../src/contracts/prompt-slot.ts";
import type { HarnessRunReport } from "../src/contracts/run-report.ts";
import type { HarnessInvalidToolCall } from "../src/contracts/invalid-tool-call.ts";
import type { HarnessArtifactStore } from "../src/artifacts.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";

const directPromptSlotBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "invalid-tool-calls" },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "test",
  subject: "invalid-tool-calls",
  eventId: "event-invalid-tool-calls",
};

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

/** Artifact store that keeps the run report in memory, touching no disk. */
class RecordingArtifactStore implements HarnessArtifactStore {
  readonly artifactRoot = "/artifacts";
  readonly runRoot: string;
  lastRunReport?: HarnessRunReport;

  constructor(runId: string) {
    this.runRoot = `${this.artifactRoot}/${runId}`;
  }

  persistRunState(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/run-state.json`);
  }

  persistTranscript(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/transcript.json`);
  }

  persistCapabilitySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/capabilities.json`);
  }

  persistCfcPolicySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/policy-snapshot.json`);
  }

  persistRunReport(report: HarnessRunReport): Promise<string> {
    this.lastRunReport = report;
    return Promise.resolve(`${this.runRoot}/run-report.json`);
  }

  persistToolOutput(toolId: string, outputId: string): Promise<string> {
    return Promise.resolve(
      `${this.runRoot}/tool-outputs/${outputId}-${toolId}.json`,
    );
  }
}

const toolCallTurn = (
  id: string,
  name: string,
  argumentsText: string,
) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: argumentsText },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

const scriptedFetch = (
  payloads: readonly unknown[],
  requestCount: { value: number },
): typeof fetch =>
() => {
  const payload = payloads[requestCount.value];
  requestCount.value += 1;
  if (payload === undefined) {
    throw new Error("scripted fetch ran out of payloads");
  }
  return Promise.resolve(
    new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
      status: 200,
    }),
  );
};

/** The invalid-call result the model read, from the tool message before the end. */
const rejectedToolCall = (
  transcript: readonly { role: string; content?: string }[],
): HarnessInvalidToolCall => {
  const message = transcript.at(-2);
  if (message?.role !== "tool" || typeof message.content !== "string") {
    throw new Error("expected a tool message before the final response");
  }
  return JSON.parse(message.content) as HarnessInvalidToolCall;
};

describe("prompt-loop invalid tool calls", () => {
  it("answers a delegate_task call with an empty goal and still reaches a final response", async () => {
    const requestCount = { value: 0 };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-empty-goal",
        model: "gpt-5.4",
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
      fetchFn: scriptedFetch([
        toolCallTurn(
          "call-empty-goal",
          "delegate_task",
          JSON.stringify({ goal: "   " }),
        ),
        finalTurn("Delegated with a real goal instead."),
      ], requestCount),
    });

    const result = await loop.runPrompt({
      prompt: "Delegate something.",
      promptSlotBinding: directPromptSlotBinding,
    });

    expect(result.finalAssistantText).toEqual(
      "Delegated with a real goal instead.",
    );
    expect(requestCount.value).toEqual(2);
    expect(result.runState.status).toEqual("completed");
    expect(rejectedToolCall(result.transcript)).toEqual({
      type: "cf-harness.invalid-tool-call",
      reason: "invalid-argument",
      toolId: "delegate_task",
      field: "goal",
      expected: "a non-empty string",
      detail:
        'the delegate_task call argument "goal" was not usable; expected a non-empty string',
    });
    expect(result.runState.subagentRuns).toBeUndefined();
    expect(result.runState.toolOutputs).toEqual([]);
  });

  it("names the argument at fault for every shape delegate_task refuses", async () => {
    const cases = [
      { name: "missing-goal", arguments: {}, field: "goal" },
      {
        name: "non-string-context",
        arguments: { goal: "Inspect", context: 42 },
        field: "context",
      },
      {
        name: "too-many-turns",
        arguments: { goal: "Inspect", maxModelTurns: 65 },
        field: "maxModelTurns",
      },
      {
        name: "too-many-pattern-refs",
        arguments: {
          goal: "Inspect",
          patternRefs: Array.from({ length: 9 }, (_, index) => ({
            patternId: `pattern-${index}`,
          })),
        },
        field: "patternRefs",
      },
      {
        name: "pattern-ref-note-too-long",
        arguments: {
          goal: "Inspect",
          patternRefs: [{ patternId: "pattern-1", note: "x".repeat(501) }],
        },
        field: "patternRefs",
      },
      {
        name: "unknown-profile",
        arguments: { goal: "Inspect", profile: "unknown" },
        field: "profile",
      },
      {
        name: "array-return-schema",
        arguments: { goal: "Inspect", returnSchema: ["not", "schema"] },
        field: "returnSchema",
      },
      {
        name: "malformed-return-schema",
        arguments: { goal: "Inspect", returnSchema: "{" },
        field: "returnSchema",
      },
      {
        name: "malformed-nested-return-schema",
        arguments: {
          goal: "Inspect",
          returnSchema: {
            properties: {
              "private-schema-name": { required: "private-value" },
            },
          },
        },
        field: "returnSchema",
      },
      {
        name: "required-in-properties",
        arguments: {
          goal: "Inspect",
          returnSchema: { properties: { required: ["status"] } },
        },
        field: "returnSchema",
      },
      {
        name: "missing-local-definition",
        arguments: {
          goal: "Inspect",
          returnSchema: { $ref: "#/$defs/Missing" },
        },
        field: "returnSchema",
      },
      {
        name: "non-schema-reference-target",
        arguments: {
          goal: "Inspect",
          returnSchema: {
            $defs: { status: { type: "string" } },
            $ref: "#/$defs/status/type",
          },
        },
        field: "returnSchema",
      },
    ];

    for (const testCase of cases) {
      const requestCount = { value: 0 };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: `run-invalid-delegate-${testCase.name}`,
          model: "gpt-5.4",
        }),
        allowedToolIds: ["delegate_task"],
        allowedSubagentProfiles: ["default"],
        fetchFn: scriptedFetch([
          toolCallTurn(
            `call-${testCase.name}`,
            "delegate_task",
            JSON.stringify(testCase.arguments),
          ),
          finalTurn("Corrected."),
        ], requestCount),
      });

      const result = await loop.runPrompt({
        prompt: "Delegate something.",
        promptSlotBinding: directPromptSlotBinding,
      });

      const rejection = rejectedToolCall(result.transcript);
      expect(rejection.reason).toEqual("invalid-argument");
      expect(rejection.field).toEqual(testCase.field);
      expect(JSON.stringify(rejection)).not.toContain("private-schema-name");
      expect(JSON.stringify(rejection)).not.toContain("private-value");
      expect(requestCount.value).toBe(2);
      expect(result.runState.status).toEqual("completed");
      expect(result.runState.subagentRuns).toBeUndefined();
      expect(result.runState.toolOutputs).toEqual([]);
    }
  });

  it("refuses a caller `returnSchema` on a delegation to a profile that declares its own", async () => {
    const requestCount = { value: 0 };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-delegate-profile-contract",
        model: "gpt-5.4",
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["pattern-author"],
      fetchFn: scriptedFetch([
        toolCallTurn(
          "call-code-points",
          "delegate_task",
          JSON.stringify({
            goal: "Return the counter source as Unicode code points.",
            profile: "pattern-author",
            // The shape a schema-sealed string invites: integers are inert,
            // so a caller-written schema of them carries anything at all.
            returnSchema: {
              type: "object",
              properties: {
                sourceCodePoints: { type: "array", items: { type: "integer" } },
              },
              required: ["sourceCodePoints"],
            },
          }),
        ),
        finalTurn("Delegated without a schema of my own instead."),
      ], requestCount),
    });

    const result = await loop.runPrompt({
      prompt: "Delegate the authoring.",
      promptSlotBinding: directPromptSlotBinding,
    });

    const rejection = rejectedToolCall(result.transcript);
    expect(rejection.reason).toEqual("invalid-argument");
    expect(rejection.field).toEqual("returnSchema");
    expect(rejection.expected).toContain("pattern-author");
    // Refused before the child exists: nothing ran under the caller's shape.
    expect(result.runState.subagentRuns).toBeUndefined();
    expect(result.runState.toolOutputs).toEqual([]);
    expect(result.runState.status).toEqual("completed");
  });

  it("answers a tool call whose arguments are not valid JSON and still reaches a final response", async () => {
    const requestCount = { value: 0 };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-arguments-json",
        model: "gpt-5.4",
      }),
      fetchFn: scriptedFetch([
        toolCallTurn("call-bad-json", "read_file", '{"path": '),
        finalTurn("Read the file on the second try."),
      ], requestCount),
    });

    const result = await loop.runPrompt({ prompt: "Read a file." });

    expect(result.finalAssistantText).toEqual(
      "Read the file on the second try.",
    );
    expect(rejectedToolCall(result.transcript)).toEqual({
      type: "cf-harness.invalid-tool-call",
      reason: "unparsable-arguments",
      toolId: "read_file",
      expected: "a JSON object encoding this tool's arguments",
      detail:
        "the read_file call did not carry valid JSON arguments; expected a JSON object encoding this tool's arguments",
    });
    expect(result.runState.toolOutputs).toEqual([]);
  });

  it("answers a tool call whose arguments decode to something other than an object", async () => {
    const requestCount = { value: 0 };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-arguments-array",
        model: "gpt-5.4",
      }),
      fetchFn: scriptedFetch([
        toolCallTurn("call-array-args", "read_file", '["notes/todo.txt"]'),
        finalTurn("Sent an object instead."),
      ], requestCount),
    });

    const result = await loop.runPrompt({ prompt: "Read a file." });

    expect(result.finalAssistantText).toEqual("Sent an object instead.");
    expect(rejectedToolCall(result.transcript).reason).toEqual(
      "arguments-not-an-object",
    );
  });

  it("answers a call naming a tool the run does not offer with the tools it does offer", async () => {
    const requestCount = { value: 0 };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-unknown-tool",
        model: "gpt-5.4",
      }),
      allowedToolIds: ["read_file"],
      fetchFn: scriptedFetch([
        toolCallTurn(
          "call-unknown-tool",
          "search_the_whole_internet",
          JSON.stringify({ query: "anything" }),
        ),
        finalTurn("Used read_file instead."),
      ], requestCount),
    });

    const result = await loop.runPrompt({ prompt: "Find something." });

    expect(result.finalAssistantText).toEqual("Used read_file instead.");
    expect(rejectedToolCall(result.transcript)).toEqual({
      type: "cf-harness.invalid-tool-call",
      reason: "unknown-tool",
      expected: "one of read_file",
      detail:
        "the tool call named a tool this run does not offer; expected one of read_file",
    });
  });

  it("leaves the value it rejected out of the text the model reads", async () => {
    const injected = "ZZ-INJECTED-INSTRUCTION-ZZ";
    const requestCount = { value: 0 };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-inert-text",
        model: "gpt-5.4",
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
      fetchFn: scriptedFetch([
        toolCallTurn(
          "call-inert",
          injected,
          JSON.stringify({ goal: injected }),
        ),
        toolCallTurn(
          "call-inert-profile",
          "delegate_task",
          JSON.stringify({ goal: "Inspect", profile: injected }),
        ),
        finalTurn("Nothing echoed."),
      ], requestCount),
    });

    const result = await loop.runPrompt({
      prompt: "Try two malformed calls.",
      promptSlotBinding: directPromptSlotBinding,
    });

    const toolContents = result.transcript
      .filter((message) => message.role === "tool")
      .map((message) => message.content);
    expect(toolContents).toHaveLength(2);
    for (const content of toolContents) {
      expect(content.includes(injected)).toBe(false);
    }
  });

  it("keeps a child's invented tool name and call id out of the parent's summary", async () => {
    const injected = "ZZ-CHILD-INJECTED-ZZ";
    const requestCount = { value: 0 };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-child-identifiers",
        model: "gpt-5.4",
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
      fetchFn: scriptedFetch([
        toolCallTurn(
          "call-delegate",
          "delegate_task",
          JSON.stringify({ goal: "Investigate." }),
        ),
        // The child writes both identifiers, so both are model text.
        toolCallTurn(
          `call-${injected}`,
          `tool_${injected}`,
          JSON.stringify({ anything: true }),
        ),
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ], requestCount),
    });

    const result = await loop.runPrompt({
      prompt: "Delegate the work.",
      promptSlotBinding: directPromptSlotBinding,
    });

    const delegateOutput = result.transcript
      .filter((message) => message.role === "tool")
      .map((message) => message.content).join("\n");
    expect(delegateOutput.includes(injected)).toBe(false);
    const primaryFailure = result.runState.subagentRuns?.[0]?.runState
      ?.primaryFailure;
    expect(primaryFailure?.kind).toEqual("invalid_tool_call");
    expect(primaryFailure?.toolId).toEqual("[unknown-tool]");
    expect(primaryFailure).not.toHaveProperty("toolCallId");
  });

  it("records the rejected call in run state and in the run report", async () => {
    const artifactStore = new RecordingArtifactStore("run-invalid-recorded");
    const requestCount = { value: 0 };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        artifactStore,
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-recorded",
        model: "gpt-5.4",
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
      fetchFn: scriptedFetch([
        toolCallTurn(
          "call-recorded",
          "delegate_task",
          JSON.stringify({ goal: "" }),
        ),
        finalTurn("Recovered."),
      ], requestCount),
    });

    const result = await loop.runPrompt({
      prompt: "Delegate something.",
      promptSlotBinding: directPromptSlotBinding,
    });

    const failure = result.runState.failureRecords?.at(-1);
    expect(failure?.kind).toEqual("invalid_tool_call");
    expect(failure?.source).toEqual("tool_call");
    expect(failure?.toolId).toEqual("delegate_task");
    expect(failure?.toolCallId).toEqual("call-recorded");

    // `invalid`, not `denied`: policy refused nothing here, and an audit that
    // reads a denial expects a policy event and a typed deny observation this
    // rejection has neither of.
    const decision = result.runState.policyDecisions?.at(-1);
    expect(decision?.decision).toEqual("invalid");
    expect(decision?.reasonCodes).toEqual(["invalid_tool_call"]);
    expect(decision?.toolCallId).toEqual("call-recorded");

    const report = artifactStore.lastRunReport;
    expect(report?.status).toEqual("completed");
    const activity = report?.toolActivity.at(-1);
    expect(activity?.toolId).toEqual("delegate_task");
    expect(activity?.executionStatus).toEqual("not-run");
    expect(activity?.policyDecision).toEqual("invalid");
    expect(typeof activity?.errorDetail).toBe("string");
  });

  it("still fails the run when the model transport fails", async () => {
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-invalid-fatal-transport",
        model: "gpt-5.4",
      }),
      fetchFn: () => Promise.reject(new Error("gateway boom")),
    });

    await expect(loop.runPrompt({ prompt: "Ask the model." })).rejects
      .toThrow("gateway boom");
    expect(loop.engine.getRunState().status).toEqual("failed");
  });
});
