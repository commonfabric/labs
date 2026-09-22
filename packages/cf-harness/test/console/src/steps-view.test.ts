import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { nothing } from "lit";
import {
  clampSelection,
  ConsoleSteps,
  stepPolicyView,
  withheldSummary,
  withheldView,
} from "../../../console/src/steps-view.ts";
import {
  type ConsoleHandle,
  consoleRunSteps,
  type ConsoleStep,
} from "../../../console/steps.ts";
import type { HarnessTranscriptMessage } from "../../../src/contracts/transcript.ts";
import { createToolOutputId } from "../../../src/contracts/tool-result.ts";
import { templateText } from "./template-text.ts";

describe("console/src/steps-view", () => {
  describe("clampSelection", () => {
    it("keeps a selection the run is long enough to hold", () => {
      expect(clampSelection(3, 9)).toBe(3);
    });

    it("moves a selection past a shorter run's end to its last step", () => {
      expect(clampSelection(8, 3)).toBe(2);
    });

    it("answers zero for a run that recorded no steps", () => {
      expect(clampSelection(8, 0)).toBe(0);
    });

    it("answers zero for a step before the first", () => {
      expect(clampSelection(-1, 9)).toBe(0);
    });
  });

  describe("stepPolicyView", () => {
    const step = (policy?: ConsoleStep["policy"]): ConsoleStep => ({
      index: 1,
      kind: "tool",
      toolName: "read_file",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld: { status: "recorded", locations: [] },
      ...(policy === undefined ? {} : { policy }),
    });

    it("renders nothing for a step whose run recorded no CFC decision", () => {
      // A step with no decision, no event and no labels has no CFC pane to
      // draw, and an empty one would read as a decision that was not made.
      expect(stepPolicyView(step())).toBe(nothing);
    });

    it("renders the decision and its reasons for a step that carries one", () => {
      const text = templateText(stepPolicyView(step({
        decision: "allowed",
        effectClass: "side-effect",
        reasonCodes: ["cfc_enforce_explicit_direct_command"],
      })));

      expect(text).toContain("allowed");
      expect(text).toContain("side-effect");
      expect(text).toContain("cfc_enforce_explicit_direct_command");
    });

    it("lists the prompt slot's influence as integrity on the path it names", () => {
      const text = templateText(stepPolicyView({
        ...step(),
        invocation: {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "r",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "bash",
          operation: "shell",
          cfcEnforcementMode: "enforce-strict",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
          promptSlotInfluenceLabels: {
            version: 1,
            entries: [{
              path: ["command"],
              label: {
                integrity: [{
                  type: "https://commonfabric.org/cfc/atom/PromptSlotInfluence",
                  version: 1,
                }],
              },
            }],
          },
        },
      }));

      expect(text).toContain("command");
      expect(text).toContain("PromptSlotInfluence");
      // An integrity-only row carries no taint and says nothing about its
      // absence.
      expect(text).not.toContain("no confidentiality atom");
    });
  });

  describe("withheldSummary", () => {
    const step = (withheld: ConsoleStep["withheld"]): ConsoleStep => ({
      index: 1,
      kind: "tool",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld,
    });

    it("labels a legacy result as having no omission record", () => {
      expect(withheldSummary(step({ status: "unrecorded", locations: [] })))
        .toBe("withheld from the model · no record");
    });

    it("labels a recorded result with its withheld position count", () => {
      expect(withheldSummary(step({
        status: "recorded",
        locations: [{
          rule: "artifact-only",
          artifactPath: "/run/tool-outputs/result.json",
          jsonPointer: "/rawValue",
          value: "retained",
          available: true,
        }],
      }))).toBe("withheld from the model · 1");
    });

    it("distinguishes an unreadable record from a missing result entry", () => {
      expect(withheldSummary(step({
        status: "record-unreadable",
        locations: [],
      }))).toContain("record unreadable");
      expect(withheldSummary(step({
        status: "record-entry-missing",
        locations: [],
      }))).toContain("entry missing");
    });
  });

  describe("withheldView", () => {
    const step = (withheld: ConsoleStep["withheld"]): ConsoleStep => ({
      index: 1,
      kind: "tool",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld,
    });

    it("explains why a legacy result cannot be reconstructed", () => {
      const text = templateText(withheldView(step({
        status: "unrecorded",
        locations: [],
      })));
      expect(text).toContain("withheld from the model · no record");
      expect(text).toContain("Legacy runs cannot be");
      expect(text).toContain("reconstructed honestly");
    });

    it("states when a recorded result has no omissions", () => {
      const text = templateText(withheldView(step({
        status: "recorded",
        locations: [],
      })));
      expect(text).toContain("No omission rule applied to this result");
    });

    it("does not describe a bad or incomplete current record as legacy", () => {
      const unreadable = templateText(withheldView(step({
        status: "record-unreadable",
        locations: [],
      })));
      const incomplete = templateText(withheldView(step({
        status: "record-entry-missing",
        locations: [],
      })));

      expect(unreadable).toContain("exists but is unreadable");
      expect(incomplete).toContain("exists but has no entry");
      expect(unreadable).not.toContain("Legacy");
      expect(incomplete).not.toContain("Legacy");
    });

    it("renders values, redaction markers, and unavailable positions", () => {
      const text = templateText(withheldView(step({
        status: "recorded",
        locations: [{
          rule: "artifact-only",
          artifactPath: "/run/output.json",
          jsonPointer: "/rawValue",
          value: { retained: true },
          available: true,
        }, {
          rule: "observation-denied",
          artifactPath: "/run/output.json",
          jsonPointer: "/stderr",
          redaction: "[redacted by CFC]",
          available: true,
        }, {
          rule: "model-context-truncation",
          artifactPath: "/run/missing.json",
          jsonPointer: "/stdout",
          available: false,
        }],
      })));
      expect(text).toContain("artifact-only");
      expect(text).toContain('{\n  "retained": true\n}');
      expect(text).toContain("[redacted by CFC]");
      expect(text).toContain("recorded artifact position is unavailable");
    });

    it("never renders an available denied value through an overlapping rule", () => {
      const outputId = createToolOutputId("run", "bash", 1);
      const artifactPath = "/run/tool-outputs/bash.json";
      const transcript: HarnessTranscriptMessage[] = [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: { name: "bash", arguments: '{"command":"echo"}' },
        }],
      }, {
        role: "tool",
        toolCallId: "call-1",
        toolName: "bash",
        content: "model-facing",
        resultRef: {
          type: "cf-harness.tool-result-ref",
          outputId,
          toolId: "bash",
          runId: "run",
          artifactPath,
        },
      }];
      const locations = [{ artifactPath, jsonPointer: "/stdout" }];
      const joined = consoleRunSteps(
        transcript,
        [],
        [],
        [],
        {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 1,
            toolCallId: "call-1",
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
      const text = templateText(withheldView(joined[0]));

      expect(text.match(/\[redacted by CFC\]/g)).toHaveLength(2);
      expect(text).not.toContain("PLANTED-SECRET");
    });
  });

  describe("ConsoleSteps", () => {
    class TestConsoleSteps extends ConsoleSteps {
      view() {
        return this.render();
      }
    }

    it("renders the model-facing result beside its retrospective context", () => {
      const outputId = createToolOutputId("run", "run_pattern", 1);
      const token = "cfh:a:abcde";
      const handle: ConsoleHandle = {
        token,
        ref: "/of:fid1:cell",
        introducedAtStep: 0,
        producedByStep: 0,
        uses: [],
        confidentiality: [],
      };
      const step: ConsoleStep = {
        index: 0,
        kind: "tool",
        toolName: "run_pattern",
        toolCallId: "call-1",
        input: { sourceText: "marker", input: token, count: 2 },
        sourceReplacedByLaterAttempt: true,
        output: { status: "ok", value: 4 },
        resultRef: {
          type: "cf-harness.tool-result-ref",
          outputId,
          toolId: "run_pattern",
          runId: "run",
        },
        childRunId: "run.subagent.1",
        handlesIntroduced: [token],
        handlesInScope: [token],
        status: "ok",
        policy: {
          decision: "allowed",
          effectClass: "side-effect",
          reasonCodes: ["direct-command"],
        },
        policyEvents: [{
          type: "cf-harness.policy-event",
          severity: "warning",
          mode: "observe",
          toolId: "run_pattern",
          toolCallId: "call-1",
          detail: "observed",
          at: "2026-01-01T00:00:00.000Z",
        }],
        disclosure: {
          valueBytes: 1_024,
          sealedPositions: 1,
          longestNumericRun: 32,
        },
        withheld: {
          status: "recorded",
          locations: [{
            rule: "artifact-only",
            artifactPath: "/run/output.json",
            jsonPointer: "/rawValue",
            value: "retained",
            available: true,
          }],
        },
        invocation: {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "run",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "run_pattern",
          toolOutputId: outputId,
          operation: "command",
          cfcEnforcementMode: "observe",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
          cfcInputLabels: {
            version: 1,
            entries: [{
              path: ["count"],
              label: {
                confidentiality: [{ type: "Secret" }],
                integrity: [{ type: "Trusted" }],
              },
            }],
          },
        },
      };
      const view = new TestConsoleSteps();
      view.steps = [step];
      view.handles = [handle];

      const text = templateText(view.view());
      expect(text).toContain("Source replaced by a later attempt");
      expect(text).toContain("run-pattern-source sidecar");
      expect(text).toContain("retained");
      expect(text).toContain("longest numeric run 32");
      expect(text).toContain("Open subagent run");
    });

    it("marks a legacy trace's withheld release, whose persisted word is `denied`", () => {
      // The whole path, from the record on disk to the badge: a run recorded
      // before the outcome existed persisted `denied` beside a release that
      // held values back, and the view must still show the boundary rather
      // than a denial of a call that ran.
      const steps = consoleRunSteps(
        [
          {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "c1",
              type: "function",
              function: { name: "run_pattern", arguments: "{}" },
            }],
          },
          {
            role: "tool",
            toolCallId: "c1",
            toolName: "run_pattern",
            content: JSON.stringify({ status: "ok" }),
          },
        ],
        [{
          type: "cf-harness.policy-decision",
          sequence: 1,
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
        }],
      );
      const view = new TestConsoleSteps();
      view.steps = steps;

      const text = templateText(view.view());
      expect(steps[0].status).toBe("ok");
      expect(text).toContain("withheld");
      expect(text).not.toContain("denied");
    });

    it("marks a withheld release beside the CFC line of a step that succeeded", () => {
      const step: ConsoleStep = {
        index: 0,
        kind: "tool",
        toolName: "run_pattern",
        toolCallId: "call-1",
        output: { status: "ok" },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policy: {
          decision: "withheld",
          effectClass: "side-effect",
          reasonCodes: ["cfc_release_withheld"],
        },
        policyEvents: [],
        withheld: {
          status: "recorded",
          locations: [{
            rule: "artifact-only",
            artifactPath: "/run/output.json",
            jsonPointer: "/value",
            value: "retained",
            available: true,
          }],
        },
      };
      const view = new TestConsoleSteps();
      view.steps = [step];

      const text = templateText(view.view());
      // The badge names the boundary's own outcome and the marker beside it
      // counts what the retrospective holds back, so the step reads as the
      // success it was rather than as a denied call.
      expect(text).toContain("withheld");
      expect(text).toContain("withheld from the model \u00b7 1");
      expect(text).not.toContain("denied");
    });
  });
});
