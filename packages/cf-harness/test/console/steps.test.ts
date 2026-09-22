import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  consoleRunHandles,
  consoleRunSteps,
  type ConsoleStep,
  consoleStepArguments,
} from "../../console/steps.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import type { HarnessHandleTable } from "../../src/contracts/handle-table.ts";
import type { HarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type { HarnessPolicyDecisionRecord } from "../../src/contracts/policy-trace.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import {
  HARNESS_CELL_LABELS_TYPE,
  type HarnessCellLabelRecord,
  type HarnessCellLabels,
} from "../../src/contracts/cell-labels.ts";
import { consoleCellLabelIndex } from "../../console/cell-labels.ts";

const call = (
  id: string,
  name: string,
  args: unknown,
): HarnessTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    },
  ],
});

const result = (
  toolCallId: string,
  toolName: string,
  content: unknown,
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId,
  toolName,
  content: typeof content === "string" ? content : JSON.stringify(content),
});

/** A snapshot the space was read for, holding these cells and no others. */
const labelSnapshot = (
  cells: readonly HarnessCellLabelRecord[],
): HarnessCellLabels => ({
  type: HARNESS_CELL_LABELS_TYPE,
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  status: "read",
  cells,
});

/** One cell the space labels `Secret` at its root. */
const secretCell = (
  entityId: string,
  ref: string,
): HarnessCellLabelRecord => ({
  entityId,
  ref,
  entries: [
    {
      path: [],
      confidentiality: [
        { type: "https://common.tools/cfc/Secret", name: "Secret" },
      ],
      integrity: [],
      origin: "declared",
    },
  ],
});

describe("console/steps", () => {
  describe("consoleRunSteps()", () => {
    it("folds a tool call and its result into one step", () => {
      const steps = consoleRunSteps([
        { role: "user", content: "do it" },
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok" }),
        { role: "assistant", content: "done" },
      ]);
      expect(steps.map((step) => step.kind)).toEqual([
        "user",
        "tool",
        "assistant",
      ]);
      expect(steps[1].input).toEqual({ sourceText: "x" });
      expect(steps[1].output).toEqual({ status: "ok" });
    });

    it("marks a run-pattern source replaced by a later attempt", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {
          sourceText:
            "[cf-harness: superseded run_pattern source collapsed for model context; attempt 1, 999 characters. The newest run_pattern call carries the source to edit; this attempt's source is preserved in tool output run:run_pattern:1.]",
        }),
        result("c1", "run_pattern", { status: "compile-error" }),
      ]);

      expect(steps[0].sourceReplacedByLaterAttempt).toBe(true);
    });

    it("keeps an assistant message that carries text alongside its calls", () => {
      const steps = consoleRunSteps([
        { role: "assistant", content: "thinking out loud", toolCalls: [] },
      ]);
      expect(steps).toHaveLength(1);
      expect(steps[0].text).toBe("thinking out loud");
    });

    it("reports arguments and results it cannot parse as text", () => {
      const steps = consoleRunSteps([
        call("c1", "bash", "{not json"),
        result("c1", "bash", "plain output"),
      ]);
      expect(steps[0].input).toBeUndefined();
      expect(steps[0].inputText).toBe("{not json");
      expect(steps[0].output).toBeUndefined();
      expect(steps[0].outputText).toBe("plain output");
    });

    it("joins recorded omissions to full tool-output positions", () => {
      const outputId = createToolOutputId("run", "run_pattern", 1);
      const artifactPath = "/moved/run/tool-outputs/result.json";
      const transcript: HarnessTranscriptMessage[] = [
        call("c1", "run_pattern", { sourceText: "x" }),
        {
          role: "tool",
          toolCallId: "c1",
          toolName: "run_pattern",
          content: JSON.stringify({ status: "compile-error" }),
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId,
            toolId: "run_pattern",
            runId: "run",
            artifactPath: "/original/run/tool-outputs/result.json",
          },
        },
      ];
      const rawDiagnostic =
        "Failure in fid1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const steps = consoleRunSteps(
        transcript,
        [],
        [],
        [],
        {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 1,
            toolCallId: "c1",
            toolId: "run_pattern",
            outputId,
            rules: [{
              rule: "artifact-only",
              locations: [{
                artifactPath: "/original/run/tool-outputs/result.json",
                jsonPointer: "/rawValue",
              }],
            }, {
              rule: "bare-fabric-identifier-scrub",
              locations: [{
                artifactPath: "/original/run/tool-outputs/result.json",
                jsonPointer: "/message",
              }],
            }, {
              rule: "superseded-run-pattern-diagnostic-collapse",
              locations: [{
                artifactPath: "/original/run/tool-outputs/result.json",
                jsonPointer: "/diagnostic",
              }],
            }, {
              rule: "bare-fabric-identifier-scrub",
              locations: [{
                artifactPath: "/original/run/tool-outputs/result.json",
                jsonPointer: "/schema/properties",
              }],
            }],
          }],
        },
        [{
          artifactPath,
          value: {
            status: "compile-error",
            rawValue: { retained: true },
            message: rawDiagnostic,
            diagnostic: rawDiagnostic,
            schema: {
              properties: {
                "did:key:z6MkSecret": { type: "string" },
              },
            },
          },
        }],
      );

      expect(steps[0].withheld.status).toBe("recorded");
      expect(steps[0].withheld.locations[0].value).toEqual({ retained: true });
      expect(steps[0].withheld.locations[1].redaction).toBe(
        "Failure in [fabric-id]",
      );
      expect(steps[0].withheld.locations[2].value).toBe(rawDiagnostic);
      expect(steps[0].withheld.locations[3].value).toEqual({
        "[fabric-id]": { type: "string" },
      });
    });

    it("reports a legacy tool result as unrecorded", () => {
      const steps = consoleRunSteps([
        call("c1", "bash", { command: "pwd" }),
        result("c1", "bash", { status: "ok" }),
      ]);
      expect(steps[0].withheld).toEqual({
        status: "unrecorded",
        locations: [],
      });
    });

    it("distinguishes unreadable and incomplete omission records", () => {
      const transcript = [
        call("c1", "bash", { command: "pwd" }),
        result("c1", "bash", { status: "ok" }),
      ];
      const unreadable = consoleRunSteps(
        transcript,
        [],
        [],
        [],
        { status: "unreadable" },
      );
      const incomplete = consoleRunSteps(
        transcript,
        [],
        [],
        [],
        {
          status: "present",
          value: {
            type: "cf-harness.transcript-omissions",
            version: 1,
            results: [],
          },
        },
      );

      expect(unreadable[0].withheld.status).toBe("record-unreadable");
      expect(incomplete[0].withheld.status).toBe("record-entry-missing");
    });

    it("reports root, array, and unavailable artifact positions honestly", () => {
      const outputId = createToolOutputId("run", "bash", 1);
      const artifactPath = "/run/tool-outputs/bash.json";
      const transcript: HarnessTranscriptMessage[] = [
        call("c1", "bash", { command: "echo" }),
        {
          role: "tool",
          toolCallId: "c1",
          toolName: "bash",
          content: "model-facing",
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId,
            toolId: "bash",
            runId: "run",
            artifactPath,
          },
        },
      ];
      const locations = ["", "/items/0", "/items/no", "not-a-pointer"];
      const steps = consoleRunSteps(
        transcript,
        [],
        [],
        [],
        {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 1,
            toolCallId: "c1",
            toolId: "bash",
            outputId,
            rules: [{
              rule: "artifact-only",
              locations: locations.map((jsonPointer) => ({
                artifactPath,
                jsonPointer,
              })),
            }, {
              rule: "observation-denied",
              locations: [{
                artifactPath: "/run/tool-outputs/missing.json",
                jsonPointer: "/stderr",
              }],
            }, {
              rule: "bare-fabric-identifier-scrub",
              locations: [{
                artifactPath: "/run/tool-outputs/missing.json",
                jsonPointer: "/message",
              }],
            }],
          }],
        },
        [{ artifactPath, value: { items: ["first"] } }],
      );

      expect(steps[0].withheld.locations.map((location) => ({
        available: location.available,
        value: location.value,
        redaction: location.redaction,
      }))).toEqual([
        { available: true, value: { items: ["first"] }, redaction: undefined },
        { available: true, value: "first", redaction: undefined },
        { available: false, value: undefined, redaction: undefined },
        { available: false, value: undefined, redaction: undefined },
        {
          available: false,
          value: undefined,
          redaction: "[redacted by CFC]",
        },
        { available: false, value: undefined, redaction: "[fabric-id]" },
      ]);
    });

    it("redacts an available denied value for every overlapping rule", () => {
      const outputId = createToolOutputId("run", "bash", 1);
      const artifactPath = "/run/tool-outputs/bash.json";
      const transcript: HarnessTranscriptMessage[] = [
        call("c1", "bash", { command: "echo" }),
        {
          role: "tool",
          toolCallId: "c1",
          toolName: "bash",
          content: "model-facing",
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId,
            toolId: "bash",
            runId: "run",
            artifactPath,
          },
        },
      ];
      const locations = [{ artifactPath, jsonPointer: "/stdout" }];
      const steps = consoleRunSteps(
        transcript,
        [],
        [],
        [],
        {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 1,
            toolCallId: "c1",
            toolId: "bash",
            outputId,
            rules: [{ rule: "artifact-only", locations }, {
              rule: "observation-denied",
              locations,
            }],
          }],
        },
        [{ artifactPath, value: { stdout: "PLANTED-SECRET" } }],
      );

      expect(steps[0].withheld.locations).toHaveLength(2);
      expect(
        steps[0].withheld.locations.every((location) =>
          location.redaction === "[redacted by CFC]" &&
          location.value === undefined
        ),
      ).toBe(true);
      expect(JSON.stringify(steps[0].withheld)).not.toContain("PLANTED-SECRET");
    });

    it("does not join an omission record whose transcript identity differs", () => {
      const outputId = createToolOutputId("run", "bash", 1);
      const artifactPath = "/run/tool-outputs/bash.json";
      const transcript: HarnessTranscriptMessage[] = [
        call("c1", "bash", { command: "echo" }),
        {
          role: "tool",
          toolCallId: "c1",
          toolName: "bash",
          content: "model-facing",
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId,
            toolId: "bash",
            runId: "run",
            artifactPath,
          },
        },
      ];
      const steps = consoleRunSteps(
        transcript,
        [],
        [],
        [],
        {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 0,
            toolCallId: "another-call",
            toolId: "bash",
            outputId,
            rules: [{
              rule: "artifact-only",
              locations: [{ artifactPath, jsonPointer: "/stdout" }],
            }],
          }],
        },
        [{ artifactPath, value: { stdout: "PLANTED-SECRET" } }],
      );

      expect(steps[0].withheld).toEqual({
        status: "record-entry-missing",
        locations: [],
      });
      expect(JSON.stringify(steps[0].withheld)).not.toContain("PLANTED-SECRET");
    });

    it("names the child a delegate_task step started", () => {
      const steps = consoleRunSteps([
        call("c1", "delegate_task", { goal: "author it" }),
        result("c1", "delegate_task", {
          subagent: { childRunId: "run.subagent.1", status: "completed" },
        }),
      ]);
      expect(steps[0].childRunId).toBe("run.subagent.1");
    });

    it("reads a skill resource the tool says it read as an ok step", () => {
      const steps = consoleRunSteps([
        call("c1", "read_skill_resource", { path: "SKILL.md" }),
        result("c1", "read_skill_resource", { status: "read", content: "#" }),
        call("c2", "read_skill_resource", { path: "logo.png" }),
        result("c2", "read_skill_resource", { status: "binary", bytes: 12 }),
        call("c3", "read_skill_resource", { path: "absent.md" }),
        result("c3", "read_skill_resource", { status: "error" }),
      ]);
      expect(steps.map((step) => step.status)).toEqual([
        "ok",
        "ok",
        "error",
      ]);
    });

    it("reads a skill script the tool says it executed as an ok step", () => {
      const steps = consoleRunSteps([
        call("c1", "run_skill_script", { script: "build.sh" }),
        result("c1", "run_skill_script", { status: "executed", exitCode: 0 }),
      ]);
      expect(steps[0].status).toBe("ok");
    });

    it("reads a status no tool succeeds under as an error step", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { status: "compile-error" }),
        call("c2", "bash", { command: "ls" }),
        // `read` is a success only for the tool that reports it.
        result("c2", "bash", { status: "read" }),
      ]);
      expect(steps.map((step) => step.status)).toEqual(["error", "error"]);
    });

    it("brings a handle into scope at the step its token first appears", () => {
      const steps = consoleRunSteps([
        { role: "user", content: "do it" },
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { resultRef: "cfh:a:aaaaa" }),
        call("c2", "describe_handle", { handle: "cfh:a:aaaaa" }),
        result("c2", "describe_handle", { shape: "object" }),
        call("c3", "run_pattern", { inputs: { a: "cfh:a:aaaaa" } }),
        result("c3", "run_pattern", { resultRef: "cfh:a:bbbbb" }),
      ]);
      expect(steps[0].handlesInScope).toEqual([]);
      expect(steps[1].handlesIntroduced).toEqual(["cfh:a:aaaaa"]);
      // The second step only reads the handle, so it introduces nothing.
      expect(steps[2].handlesIntroduced).toEqual([]);
      expect(steps[2].handlesInScope).toEqual(["cfh:a:aaaaa"]);
      expect(steps[3].handlesIntroduced).toEqual(["cfh:a:bbbbb"]);
      expect(steps[3].handlesInScope).toEqual(["cfh:a:aaaaa", "cfh:a:bbbbb"]);
    });
  });

  describe("consoleRunHandles()", () => {
    const table: HarnessHandleTable = {
      type: "cf-harness.handle-table",
      version: 1,
      salt: "run",
      entries: [
        {
          token: "cfh:a:aaaaa",
          kind: "address",
          ref: "/of:fid1:aaa",
          addressKey: '[null,"of:fid1:aaa","space",[]]',
        },
      ],
    };

    it("resolves a token against the run's own table", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { resultRef: "cfh:a:aaaaa" }),
      ]);
      expect(consoleRunHandles(steps, table)).toEqual([
        {
          token: "cfh:a:aaaaa",
          ref: "/of:fid1:aaa",
          addressKey: '[null,"of:fid1:aaa","space",[]]',
          introducedAtStep: 0,
          producedByStep: 0,
          uses: [],
          confidentiality: [],
        },
      ]);
    });

    it("still reports a token the table no longer holds", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { resultRef: "cfh:a:zzzzz" }),
      ]);
      const handles = consoleRunHandles(steps, table);
      expect(handles).toHaveLength(1);
      expect(handles[0].token).toBe("cfh:a:zzzzz");
      expect(handles[0].ref).toBeUndefined();
    });

    it("carries the labels the space holds for the cell a handle names", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { resultRef: "cfh:a:aaaaa" }),
      ]);
      const handles = consoleRunHandles(
        steps,
        table,
        consoleCellLabelIndex(
          labelSnapshot([secretCell("of:fid1:aaa", "/of:fid1:aaa")]),
        ),
      );
      expect(handles[0].labels?.confidentiality).toEqual(["Secret"]);
      // What a call put on the argument is a different fact, and stays its
      // own field: this run made no call carrying an atom.
      expect(handles[0].confidentiality).toEqual([]);
    });

    it("tells a cell the snapshot holds no label for from one it never read", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { resultRef: "cfh:a:aaaaa" }),
      ]);
      const read = consoleRunHandles(
        steps,
        table,
        consoleCellLabelIndex(
          labelSnapshot([
            { entityId: "of:fid1:aaa", ref: "/of:fid1:aaa", entries: [] },
          ]),
        ),
      );
      // The space was asked and holds nothing for this cell.
      expect(read[0].labels?.entries).toEqual([]);
      const unread = consoleRunHandles(
        steps,
        table,
        consoleCellLabelIndex(undefined),
      );
      // Nobody asked, which is not the same reading.
      expect(unread[0].labels).toBeUndefined();
    });
  });
});

describe("console/steps CFC and disclosure", () => {
  const call = (
    id: string,
    name: string,
    args: unknown,
  ): HarnessTranscriptMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });

  const result = (
    toolCallId: string,
    toolName: string,
    content: unknown,
  ): HarnessTranscriptMessage => ({
    role: "tool",
    toolCallId,
    toolName,
    content: JSON.stringify(content),
  });

  it("carries the CFC decision recorded for a call", () => {
    const steps = consoleRunSteps(
      [
        call("c1", "run_pattern", {}),
        result("c1", "run_pattern", { status: "ok" }),
      ],
      [
        {
          type: "cf-harness.policy-decision",
          sequence: 1,
          runId: "r",
          at: "2026-01-01T00:00:00.000Z",
          toolActivitySequence: 1,
          toolCallId: "c1",
          toolId: "run_pattern",
          effectClass: "side-effect",
          cfcEnforcementMode: "enforce-explicit",
          decision: "allowed",
          reasonCodes: ["cfc_enforce_explicit_direct_command"],
        },
      ],
    );
    expect(steps[0].policy?.decision).toBe("allowed");
    expect(steps[0].policy?.effectClass).toBe("side-effect");
    expect(steps[0].status).toBe("ok");
  });

  it("reads a step as denied when a policy event denied its observation", () => {
    const steps = consoleRunSteps(
      [
        call("c1", "bash", { command: "cat x" }),
        result("c1", "bash", { type: "cf-harness.observation-denied" }),
      ],
      [],
      [
        {
          type: "cf-harness.policy-event",
          severity: "denied",
          mode: "enforce-explicit",
          toolId: "bash",
          toolCallId: "c1",
          detail: "bash output did not include trusted CFC mediation metadata",
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
    expect(steps[0].status).toBe("denied");
    expect(steps[0].policyEvents).toHaveLength(1);
  });

  it("reads a step the loop rejected for its arguments as an error, not a denial", () => {
    const steps = consoleRunSteps(
      [
        call("c1", "delegate_task", { goal: "" }),
        result("c1", "delegate_task", {
          type: "cf-harness.invalid-tool-call",
          reason: "invalid_arguments",
          expected: "a non-empty goal",
          detail: "delegate_task goal must be a non-empty string",
        }),
      ],
      [{
        type: "cf-harness.policy-decision",
        sequence: 1,
        runId: "run-invalid",
        at: "2026-01-01T00:00:00.000Z",
        toolActivitySequence: 1,
        toolCallId: "c1",
        toolId: "delegate_task",
        cfcEnforcementMode: "enforce-explicit",
        decision: "invalid",
        reasonCodes: ["invalid_tool_call"],
      }],
    );

    // The answer carries no `status` of its own, so without reading the
    // decision the step would read as an ordinary success.
    expect(steps[0].status).toBe("error");
    expect(steps[0].policyEvents).toHaveLength(0);
  });

  it("reads a step whose release was withheld as the ok its own answer states", () => {
    const steps = consoleRunSteps(
      [
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", {
          status: "ok",
          resultRef: { outputId: "out-1" },
          valueError: "the values are withheld; resultRef still names them",
        }),
      ],
      [
        {
          type: "cf-harness.policy-decision",
          sequence: 1,
          runId: "run-withheld",
          at: "2026-01-01T00:00:00.000Z",
          toolActivitySequence: 1,
          toolCallId: "c1",
          toolId: "run_pattern",
          cfcEnforcementMode: "enforce-explicit",
          decision: "allowed",
          reasonCodes: ["cfc_enforce_explicit_direct_command"],
        },
        {
          type: "cf-harness.policy-decision",
          sequence: 2,
          runId: "run-withheld",
          at: "2026-01-01T00:00:00.000Z",
          toolActivitySequence: 1,
          toolCallId: "c1",
          toolId: "run_pattern",
          cfcEnforcementMode: "enforce-explicit",
          decision: "withheld",
          reasonCodes: ["cfc_release_withheld"],
          release: {
            reasonCode: "cfc_release_withheld",
            boundary: "release",
            sink: "run_pattern",
            ceiling: [],
          },
        },
      ],
    );

    // The call ran and answered with the reference to its result, so the step
    // is the success its answer states; the boundary shows as the decision the
    // CFC line carries, and not as a denial of the call.
    expect(steps[0].status).toBe("ok");
    expect(steps[0].policy?.decision).toBe("withheld");
    expect(steps[0].policy?.reasonCodes).toEqual(["cfc_release_withheld"]);
  });

  it("reads a legacy trace's withheld release off its reason code, not its outcome word", () => {
    // A run recorded before the `withheld` outcome existed persisted `denied`
    // beside a release that held values back. The reason code is the fact and
    // does not move, so the console reads the step off that — the same field
    // AUD-16 counts — and an old family reads alike whichever build opens it.
    const steps = consoleRunSteps(
      [
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", {
          status: "ok",
          resultRef: { outputId: "out-1" },
          valueError: "the values are withheld; resultRef still names them",
        }),
      ],
      [
        {
          type: "cf-harness.policy-decision",
          sequence: 1,
          runId: "run-legacy",
          at: "2026-01-01T00:00:00.000Z",
          toolActivitySequence: 1,
          toolCallId: "c1",
          toolId: "run_pattern",
          cfcEnforcementMode: "enforce-explicit",
          decision: "allowed",
          reasonCodes: ["cfc_enforce_explicit_direct_command"],
        },
        {
          type: "cf-harness.policy-decision",
          sequence: 2,
          runId: "run-legacy",
          at: "2026-01-01T00:00:00.000Z",
          toolActivitySequence: 1,
          toolCallId: "c1",
          toolId: "run_pattern",
          cfcEnforcementMode: "enforce-explicit",
          decision: "denied",
          reasonCodes: ["cfc_release_withheld"],
          release: {
            reasonCode: "cfc_release_withheld",
            boundary: "release",
            sink: "run_pattern",
            ceiling: [],
          },
        },
      ],
    );

    expect(steps[0].status).toBe("ok");
    expect(steps[0].policy?.decision).toBe("withheld");
  });

  it("keeps `denied` for a decision no boundary decided", () => {
    // The other half of the rule: a call authority refused carries no release
    // record, so nothing rewrites its word and the step stays denied.
    const steps = consoleRunSteps(
      [
        call("c1", "write_file", { path: "x" }),
        result("c1", "write_file", { status: "error" }),
      ],
      [{
        type: "cf-harness.policy-decision",
        sequence: 1,
        runId: "run-denied",
        at: "2026-01-01T00:00:00.000Z",
        toolActivitySequence: 1,
        toolCallId: "c1",
        toolId: "write_file",
        cfcEnforcementMode: "enforce-explicit",
        decision: "denied",
        reasonCodes: ["write_file_enforce_explicit_direct_command"],
      }],
    );

    expect(steps[0].status).toBe("denied");
    expect(steps[0].policy?.decision).toBe("denied");
  });

  it("keeps the persisted word when the release record answers neither closed set", () => {
    // A trace is read back through JSON. A release record whose boundary or
    // reason code is outside the contract's sets is a record the console
    // cannot read, and an unreadable record is not evidence to rewrite a
    // persisted outcome with — so the word the run recorded stands. `null` is
    // the same reading, and would throw if it were dereferenced instead.
    const legacy = {
      type: "cf-harness.policy-decision",
      sequence: 1,
      runId: "run-malformed",
      at: "2026-01-01T00:00:00.000Z",
      toolActivitySequence: 1,
      toolCallId: "c1",
      toolId: "run_pattern",
      cfcEnforcementMode: "enforce-explicit",
      decision: "denied",
      reasonCodes: ["cfc_release_withheld"],
    } as const;
    const transcript = [
      call("c1", "run_pattern", { sourceText: "x" }),
      result("c1", "run_pattern", { status: "ok" }),
    ];
    const malformed = [
      // A boundary outside the set, beside a reason code inside it.
      { reasonCode: "cfc_release_withheld", boundary: "egress" },
      // A reason code outside the set, beside a boundary inside it.
      { reasonCode: "cfc_release_maybe", boundary: "release" },
      // No discriminant at all, and an empty record.
      { sink: "run_pattern" },
      null,
    ];

    for (const release of malformed) {
      const steps = consoleRunSteps(transcript, [
        { ...legacy, release } as unknown as HarnessPolicyDecisionRecord,
      ]);
      expect(steps[0].status).toBe("denied");
      expect(steps[0].policy?.decision).toBe("denied");
    }
  });

  it("reads a refused commit as denied, since it landed no result", () => {
    // A release record does not by itself mean the call answered: the runner
    // refused this write, so `cfc_commit_refused` keeps the denial.
    const steps = consoleRunSteps(
      [
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", { status: "ok" }),
      ],
      [{
        type: "cf-harness.policy-decision",
        sequence: 1,
        runId: "run-commit",
        at: "2026-01-01T00:00:00.000Z",
        toolActivitySequence: 1,
        toolCallId: "c1",
        toolId: "run_pattern",
        cfcEnforcementMode: "enforce-strict",
        decision: "denied",
        reasonCodes: ["cfc_commit_refused"],
        release: { reasonCode: "cfc_commit_refused", boundary: "commit" },
      }],
    );

    expect(steps[0].status).toBe("denied");
    expect(steps[0].policy?.decision).toBe("denied");
  });

  it("measures the longest numeric run a result let across as value", () => {
    const bytes = Array.from({ length: 40 }, (_, index) => index);
    const steps = consoleRunSteps([
      call("c1", "run_pattern", {}),
      result("c1", "run_pattern", { status: "ok", value: { bytes } }),
    ]);
    expect(steps[0].disclosure?.longestNumericRun).toBe(40);
    expect(steps[0].disclosure?.sealedPositions).toBe(0);
  });

  it("counts a sealed position rather than reading it as a value", () => {
    const steps = consoleRunSteps([
      call("c1", "run_pattern", {}),
      result("c1", "run_pattern", {
        status: "ok",
        value: { note: "opaque:handle/note" },
      }),
    ]);
    expect(steps[0].disclosure?.sealedPositions).toBe(1);
    expect(steps[0].disclosure?.longestNumericRun).toBe(0);
  });

  it("attaches the CFC invocation context recorded for the call's output", () => {
    const steps = consoleRunSteps(
      [
        call("c1", "bash", { command: "ls" }),
        {
          role: "tool",
          toolCallId: "c1",
          toolName: "bash",
          content: JSON.stringify({ status: "ok" }),
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId: createToolOutputId("r", "bash", 2),
            toolId: "bash",
            runId: "r",
          },
        },
      ],
      [],
      [],
      [
        {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "r",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "bash",
          toolOutputId: createToolOutputId("r", "bash", 2),
          operation: "shell",
          cfcEnforcementMode: "enforce-explicit",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
          cfcInputLabels: {
            version: 1,
            entries: [
              {
                path: ["command"],
                label: {
                  confidentiality: [
                    {
                      type: "test.cfc/ObservedOutput",
                      subject: "did:key:observed",
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    );
    expect(steps[0].invocation?.operation).toBe("shell");
    expect(steps[0].invocation?.cfcInputLabels?.entries[0].path).toEqual([
      "command",
    ]);
  });

  it("hands a context that named no output to its own tool's steps in turn", () => {
    const context = (
      sequence: number,
      toolId: string,
      cwd: string,
    ): HarnessCfcInvocationContext => ({
      type: "cf-harness.cfc-invocation-context",
      version: 1,
      sequence,
      runId: "r",
      createdAt: "2026-01-01T00:00:00.000Z",
      toolId,
      operation: "shell",
      cfcEnforcementMode: "enforce-explicit",
      cwd,
      runManifest: { present: false },
      inputs: {},
    });
    const steps = consoleRunSteps(
      [
        call("c1", "read_file", { path: "a.txt" }),
        result("c1", "read_file", { path: "a.txt", content: "a" }),
        call("c2", "read_file", { path: "b.txt" }),
        result("c2", "read_file", { path: "b.txt", content: "b" }),
      ],
      [],
      [],
      [
        context(1, "read_file", "/workspace/a"),
        context(
          2,
          "read_file",
          "/workspace/b",
        ),
      ],
    );
    expect(steps[0].invocation?.cwd).toBe("/workspace/a");
    expect(steps[1].invocation?.cwd).toBe("/workspace/b");
  });

  it("leaves a step with no invocation context recorded for another tool", () => {
    const steps = consoleRunSteps(
      [
        call("c1", "read_file", { path: "a.txt" }),
        result("c1", "read_file", { path: "a.txt", content: "a" }),
      ],
      [],
      [],
      [
        {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "r",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "write_file",
          operation: "shell",
          cfcEnforcementMode: "enforce-explicit",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
        },
      ],
    );
    expect(steps[0].invocation).toBeUndefined();
  });

  it("measures a value in bytes rather than in code units", () => {
    const steps = consoleRunSteps([
      call("c1", "run_pattern", {}),
      result("c1", "run_pattern", { status: "ok", value: { note: "🙂" } }),
    ]);
    // `{"note":"🙂"}` is thirteen code units and fifteen bytes.
    expect(steps[0].disclosure?.valueBytes).toBe(15);
  });

  it("leaves a step with no invocation context when none names its output", () => {
    const steps = consoleRunSteps(
      [
        call("c1", "bash", { command: "ls" }),
        result("c1", "bash", { status: "ok" }),
      ],
      [],
      [],
      [],
    );
    expect(steps[0].invocation).toBeUndefined();
  });

  it("reports no disclosure for a result carrying no value at all", () => {
    const steps = consoleRunSteps([
      call("c1", "assign_slug", { slug: "x" }),
      result("c1", "assign_slug", { status: "ok", slug: "x" }),
    ]);
    expect(steps[0].disclosure).toBeUndefined();
  });
});

describe("console/steps provenance", () => {
  const call = (
    id: string,
    name: string,
    args: unknown,
  ): HarnessTranscriptMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });

  const result = (
    toolCallId: string,
    toolName: string,
    content: unknown,
  ): HarnessTranscriptMessage => ({
    role: "tool",
    toolCallId,
    toolName,
    content: JSON.stringify(content),
  });

  const table: HarnessHandleTable = {
    type: "cf-harness.handle-table",
    version: 1,
    salt: "run",
    entries: [
      {
        token: "cfh:a:aaaaa",
        kind: "address",
        ref: "/of:fid1:abc",
        addressKey: '[null,"of:fid1:abc","space",[]]',
        schema: { type: "object", properties: { numbers: { type: "array" } } },
      },
    ],
  };

  /** A run that makes a cell, names it, then wires a pattern to read it. */
  const composed = (wiredAs: string): readonly ConsoleStep[] =>
    consoleRunSteps([
      call("c1", "run_pattern", { sourceText: "x" }),
      result("c1", "run_pattern", { status: "ok", resultRef: "cfh:a:aaaaa" }),
      call("c2", "assign_slug", { token: "cfh:a:aaaaa", slug: "numbers" }),
      result("c2", "assign_slug", {
        status: "ok",
        slug: "numbers",
        url: "http://localhost:8000/space/numbers",
      }),
      call("c3", "run_pattern", {
        sourceText: "y",
        inputs: { source: wiredAs },
      }),
      result("c3", "run_pattern", { status: "ok", resultRef: "cfh:a:bbbbb" }),
    ]);

  it("names the step whose result minted a handle", () => {
    const handles = consoleRunHandles(composed("cfh:a:aaaaa"), table);
    const minted = handles.find((handle) => handle.token === "cfh:a:aaaaa");
    expect(minted?.producedByStep).toBe(0);
    expect(minted?.slug).toBe("numbers");
    expect(minted?.url).toBe("http://localhost:8000/space/numbers");
  });

  it("records every call a handle was passed into", () => {
    const handles = consoleRunHandles(composed("cfh:a:aaaaa"), table);
    const minted = handles.find((handle) => handle.token === "cfh:a:aaaaa");
    expect(minted?.uses).toEqual([
      { step: 1, toolName: "assign_slug", as: "token" },
      { step: 2, toolName: "run_pattern", as: "source" },
    ]);
  });

  describe("consoleStepArguments()", () => {
    it("reads an input written as a handle token as a reference", () => {
      const steps = composed("cfh:a:aaaaa");
      const handles = consoleRunHandles(steps, table);
      const args = consoleStepArguments(steps[2], handles);
      expect(args).toHaveLength(1);
      expect(args[0].key).toBe("source");
      expect(args[0].isReference).toBe(true);
      expect(args[0].token).toBe("cfh:a:aaaaa");
      expect(args[0].slug).toBe("numbers");
      expect(args[0].producedByStep).toBe(0);
    });

    it("reads an input written as a whole link as the same reference", () => {
      const steps = composed("/of:fid1:abc");
      const handles = consoleRunHandles(steps, table);
      const args = consoleStepArguments(steps[2], handles);
      expect(args[0].isReference).toBe(true);
      // The link and the token name one cell, so the link resolves to the
      // handle's slug and origin rather than reading as an unknown address.
      expect(args[0].token).toBe("cfh:a:aaaaa");
      expect(args[0].slug).toBe("numbers");
      expect(args[0].producedByStep).toBe(0);
    });

    it("reads a cross-space link as a reference", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {
          sourceText: "y",
          inputs: { source: "/@did:key:z6MkAbc/of:fid1:xyz" },
        }),
        result("c1", "run_pattern", { status: "ok" }),
      ]);
      const args = consoleStepArguments(steps[0], []);
      // No handle resolves it, but a link the run holds nothing for is still a
      // reference — reading it as a plain value would lose it entirely.
      expect(args[0].isReference).toBe(true);
      expect(args[0].ref).toBe("/@did:key:z6MkAbc/of:fid1:xyz");
    });

    it("matches complete references to legacy handles by decoded address", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {
          sourceText: "y",
          inputs: { source: "//did:key:z6MkAbc/of:fid1:abc@space/numbers" },
        }),
        result("c1", "run_pattern", { status: "ok" }),
      ]);
      const handles = consoleRunHandles(composed("cfh:a:aaaaa"), table).map(
        (handle) => ({ ...handle, ref: `/@did:key:z6MkAbc${handle.ref}` }),
      );
      const args = consoleStepArguments(steps[0], handles);
      expect(args[0].isReference).toBe(true);
      expect(args[0].token).toBe("cfh:a:aaaaa");
    });

    it("preserves path whitespace when reading a padded reference", () => {
      const steps = composed("  /of:fid1:abc/title ");
      const handles = consoleRunHandles(steps, table);
      const args = consoleStepArguments(steps[2], handles);
      expect(args[0].isReference).toBe(true);
      expect(consoleStepArguments(steps[2], [])[0].ref).toBe(
        "/of:fid1:abc/title ",
      );
      expect(args[0].token).toBe("cfh:a:aaaaa");
    });

    it("refuses non-entity URI schemes as cell references", () => {
      for (const value of ["/data:abc", "/fid1:abc"]) {
        const steps = composed(value);
        expect(consoleStepArguments(steps[2], [])[0].isReference).toBe(false);
      }
    });

    it("resolves a link naming a path inside a held cell to that cell", () => {
      const steps = composed("/of:fid1:abc/numbers");
      const handles = consoleRunHandles(steps, table);
      const args = consoleStepArguments(steps[2], handles);
      expect(args[0].isReference).toBe(true);
      expect(args[0].token).toBe("cfh:a:aaaaa");
      expect(args[0].producedByStep).toBe(0);
    });

    it("does not attach a handle to a link that merely shares its prefix", () => {
      const steps = composed("/of:fid1:abcdef");
      const handles = consoleRunHandles(steps, table);
      const args = consoleStepArguments(steps[2], handles);
      // The held cell is `/of:fid1:abc`; this names a different entity.
      expect(args[0].isReference).toBe(true);
      expect(args[0].token).toBeUndefined();
      expect(args[0].ref).toBe("/of:fid1:abcdef");
    });

    it("reads a prefix-shaped string that is not a link as a value", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", {
          sourceText: "y",
          inputs: { source: "/of:" },
        }),
        result("c1", "run_pattern", { status: "ok" }),
      ]);
      const args = consoleStepArguments(steps[0], []);
      expect(args[0].isReference).toBe(false);
    });

    it("puts a label only on the argument its path names", () => {
      // An invocation context is recorded for a sandbox operation, so its
      // label paths are rooted at that operation's own arguments.
      const labelled: HarnessCfcInvocationContext = {
        type: "cf-harness.cfc-invocation-context",
        version: 1,
        sequence: 1,
        runId: "r",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolId: "bash",
        toolOutputId: createToolOutputId("r", "bash", 1),
        operation: "shell",
        cfcEnforcementMode: "enforce-explicit",
        cwd: "/workspace",
        runManifest: { present: false },
        inputs: {},
        cfcInputLabels: {
          version: 1,
          entries: [
            {
              path: ["command"],
              label: {
                confidentiality: [
                  {
                    type: "test.cfc/ObservedOutput",
                    subject: "did:key:observed",
                  },
                ],
              },
            },
          ],
        },
      };
      const steps = consoleRunSteps(
        [
          call("c1", "bash", { command: "cat x", cwd: "/workspace" }),
          {
            role: "tool",
            toolCallId: "c1",
            toolName: "bash",
            content: JSON.stringify({ status: "ok" }),
            resultRef: {
              type: "cf-harness.tool-result-ref",
              outputId: createToolOutputId("r", "bash", 1),
              toolId: "bash",
              runId: "r",
            },
          },
        ],
        [],
        [],
        [labelled],
      );
      const args = consoleStepArguments(steps[0], []);
      const command = args.find((argument) => argument.key === "command");
      const cwd = args.find((argument) => argument.key === "cwd");
      expect(command?.confidentiality).toEqual(["ObservedOutput"]);
      // The other argument carried no label, and must not borrow this one.
      expect(cwd?.confidentiality).toEqual([]);
    });

    it("puts the prompt slot's influence on the argument its path names, as integrity", () => {
      const influenced: HarnessCfcInvocationContext = {
        type: "cf-harness.cfc-invocation-context",
        version: 1,
        sequence: 1,
        runId: "r",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolId: "bash",
        toolOutputId: createToolOutputId("r", "bash", 1),
        operation: "shell",
        cfcEnforcementMode: "enforce-strict",
        cwd: "/workspace",
        runManifest: { present: false },
        inputs: {},
        promptSlotInfluenceLabels: {
          version: 1,
          entries: [
            {
              path: ["command"],
              label: {
                integrity: [
                  {
                    type:
                      "https://commonfabric.org/cfc/atom/PromptSlotInfluence",
                    version: 1,
                  },
                ],
              },
            },
          ],
        },
      };
      const steps = consoleRunSteps(
        [
          call("c1", "bash", { command: "cat x", cwd: "/workspace" }),
          {
            role: "tool",
            toolCallId: "c1",
            toolName: "bash",
            content: JSON.stringify({ status: "ok" }),
            resultRef: {
              type: "cf-harness.tool-result-ref",
              outputId: createToolOutputId("r", "bash", 1),
              toolId: "bash",
              runId: "r",
            },
          },
        ],
        [],
        [],
        [influenced],
      );
      const args = consoleStepArguments(steps[0], []);
      const command = args.find((argument) => argument.key === "command");
      const cwd = args.find((argument) => argument.key === "cwd");
      expect(command?.integrity).toEqual(["PromptSlotInfluence"]);
      // Influence is not taint: the argument carries no confidentiality.
      expect(command?.confidentiality).toEqual([]);
      expect(cwd?.integrity).toEqual([]);
    });

    it("keeps a label whose root names no argument of the call", () => {
      // A tool taking `path` may be mediated as `args`, so the label root
      // names nothing the model wrote. Dropping the atom would lose an
      // observed fact; it governs the call instead.
      const labelled: HarnessCfcInvocationContext = {
        type: "cf-harness.cfc-invocation-context",
        version: 1,
        sequence: 1,
        runId: "r",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolId: "read_file",
        toolOutputId: createToolOutputId("r", "read_file", 1),
        operation: "command",
        cfcEnforcementMode: "enforce-explicit",
        cwd: "/workspace",
        runManifest: { present: false },
        inputs: {},
        cfcInputLabels: {
          version: 1,
          entries: [
            {
              path: ["args"],
              label: {
                confidentiality: [
                  {
                    type: "test.cfc/ObservedOutput",
                    subject: "did:key:observed",
                  },
                ],
              },
            },
          ],
        },
      };
      const steps = consoleRunSteps(
        [
          call("c1", "read_file", { path: "notes.md" }),
          {
            role: "tool",
            toolCallId: "c1",
            toolName: "read_file",
            content: JSON.stringify({ ok: true }),
            resultRef: {
              type: "cf-harness.tool-result-ref",
              outputId: createToolOutputId("r", "read_file", 1),
              toolId: "read_file",
              runId: "r",
            },
          },
        ],
        [],
        [],
        [labelled],
      );
      const args = consoleStepArguments(steps[0], []);
      expect(args[0].key).toBe("path");
      expect(args[0].confidentiality).toEqual(["ObservedOutput"]);
    });

    it("reads a literal input as a value rather than a reference", () => {
      const steps = consoleRunSteps([
        call("c1", "run_pattern", { sourceText: "x", inputs: { bill: 100 } }),
        result("c1", "run_pattern", { status: "ok" }),
      ]);
      const args = consoleStepArguments(steps[0], []);
      expect(args[0].isReference).toBe(false);
      expect(args[0].value).toBe(100);
    });

    it("reads a handle-taking tool's own argument as a reference", () => {
      const steps = composed("cfh:a:aaaaa");
      const handles = consoleRunHandles(steps, table);
      const args = consoleStepArguments(steps[1], handles);
      const token = args.find((argument) => argument.key === "token");
      expect(token?.isReference).toBe(true);
      expect(token?.producedByStep).toBe(0);
    });

    it("carries the shape the pattern that made the cell declared", () => {
      const steps = composed("cfh:a:aaaaa");
      const handles = consoleRunHandles(steps, table);
      const args = consoleStepArguments(steps[2], handles);
      expect(args[0].schema).toEqual(table.entries[0].schema);
    });

    it("takes an argument's labels from the handle it resolved to", () => {
      const steps = composed("cfh:a:aaaaa");
      const handles = consoleRunHandles(
        steps,
        table,
        consoleCellLabelIndex(
          labelSnapshot([secretCell("of:fid1:abc", "/of:fid1:abc")]),
        ),
      );
      const args = consoleStepArguments(steps[2], handles);
      expect(args[0].labels?.confidentiality).toEqual(["Secret"]);
    });

    it("labels an argument written as a whole link the run holds no handle for", () => {
      const steps = composed("/of:fid1:zzz");
      const args = consoleStepArguments(
        steps[2],
        [],
        consoleCellLabelIndex(
          labelSnapshot([secretCell("of:fid1:zzz", "/of:fid1:zzz")]),
        ),
      );
      expect(args[0].token).toBeUndefined();
      expect(args[0].labels?.confidentiality).toEqual(["Secret"]);
    });

    it("labels a link naming a path inside a document from the document", () => {
      const steps = composed("/of:fid1:zzz/numbers");
      const args = consoleStepArguments(
        steps[2],
        [],
        consoleCellLabelIndex(
          labelSnapshot([secretCell("of:fid1:zzz", "/of:fid1:zzz")]),
        ),
      );
      // The labels are stored for the document, and the path resolves to it.
      expect(args[0].ref).toBe("/of:fid1:zzz/numbers");
      expect(args[0].labels?.confidentiality).toEqual(["Secret"]);
    });
  });
});
