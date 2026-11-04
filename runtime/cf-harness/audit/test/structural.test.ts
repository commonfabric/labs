/**
 * What each check reads, one reading per case.
 *
 * `seeded-violations.test.ts` proves each check can fail and that it fails
 * alone; this file pins the rest of what a check says — which artifact it
 * falls back to when the one it prefers is gone, which shapes it calls
 * `not-applicable` rather than `pass`, and what its findings name. The runs
 * here are built rather than recorded, so each carries exactly the one shape
 * its case is about.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";

import type { HarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type { HarnessHandleTable } from "../../src/contracts/handle-table.ts";
import type { HarnessPolicyEvent } from "../../src/contracts/policy.ts";
import type {
  HarnessPolicyDecisionRecord,
  HarnessPolicyTrace,
} from "../../src/contracts/policy-trace.ts";
import type {
  HarnessRunReport,
  HarnessToolActivity,
} from "../../src/contracts/run-report.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import {
  annotateHarnessUserResultOmissions,
  createHarnessTranscriptOmissions,
  type HarnessTranscriptOmissions,
} from "../../src/contracts/transcript-omissions.ts";
import type { HarnessRunState } from "../../src/run-state.ts";
import {
  type AuditCheck,
  auditRunFamily,
  type CheckOutcome,
  STRUCTURAL_CHECKS,
} from "../checks/structural.ts";
import type { ArtifactState, RunEvidence, RunFamily } from "../evidence.ts";

const RUN_ID = "built-run";

const present = <T>(value: T): ArtifactState<T> => ({
  status: "present",
  path: "built",
  value,
});

const absent = <T>(): ArtifactState<T> => ({
  status: "absent",
  path: "built",
});

/**
 * A run's recorded state. Its enforcement mode is the one every artifact
 * builder below records too, and AUD-1 reads that agreement across the family.
 * A case whose subject is a rung overrides the mode on the artifacts it names.
 */
const runState = (
  overrides: Partial<HarnessRunState> = {},
): HarnessRunState => ({
  runId: RUN_ID,
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  cfcEnforcementMode: "enforce-explicit",
  currentDir: "/workspace",
  policyEvents: [],
  toolOutputs: [],
  ...overrides,
});

const activity = (
  overrides: Partial<HarnessToolActivity> & { toolCallId: string },
): HarnessToolActivity => ({
  type: "cf-harness.tool-activity",
  runId: RUN_ID,
  sequence: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  toolId: "bash",
  effectClass: "side-effect",
  cfcEnforcementMode: "enforce-explicit",
  policyDecision: "allowed",
  executionStatus: "completed",
  ...overrides,
});

/**
 * One recorded policy decision. Its reason code names the same mode the record
 * claims, and AUD-2 reads that pairing.
 */
const decision = (
  overrides: Partial<HarnessPolicyDecisionRecord> & { toolCallId: string },
): HarnessPolicyDecisionRecord => ({
  type: "cf-harness.policy-decision",
  sequence: 1,
  runId: RUN_ID,
  at: "2026-01-01T00:00:00.000Z",
  toolActivitySequence: 1,
  toolId: "bash",
  effectClass: "side-effect",
  cfcEnforcementMode: "enforce-explicit",
  decision: "allowed",
  reasonCodes: ["cfc_enforce_explicit_direct_command"],
  ...overrides,
});

const counted = (
  decisions: readonly HarnessPolicyDecisionRecord[],
) => ({
  total: decisions.length,
  allowed: decisions.filter((one) => one.decision === "allowed").length,
  warned: decisions.filter((one) => one.decision === "warned").length,
  denied: decisions.filter((one) => one.decision === "denied").length,
});

const policyTrace = (
  decisions: readonly HarnessPolicyDecisionRecord[],
  overrides: Partial<HarnessPolicyTrace> = {},
): HarnessPolicyTrace => ({
  type: "cf-harness.policy-trace",
  version: 1,
  generatedAt: "2026-01-01T00:00:01.000Z",
  runId: RUN_ID,
  cfcEnforcementMode: "enforce-explicit",
  decisionCounts: counted(decisions),
  decisions: [...decisions],
  ...overrides,
});

const runReport = (
  overrides: Partial<HarnessRunReport> = {},
): HarnessRunReport => {
  const decisions = overrides.policyDecisions ?? [];
  return {
    type: "cf-harness.run-report",
    runId: RUN_ID,
    generatedAt: "2026-01-01T00:00:01.000Z",
    status: "completed",
    model: "built-model",
    modelTurns: 1,
    cfcEnforcementMode: "enforce-explicit",
    policyEventCounts: { total: 0, warnings: 0, denied: 0 },
    policyDecisionCounts: counted(decisions),
    policyEvents: [],
    policyDecisions: [...decisions],
    timeline: [],
    toolActivity: [],
    toolOutputs: [],
    ...overrides,
  };
};

/** The artifacts a built run carries; anything left out reads as absent. */
interface BuiltRun {
  runState?: HarnessRunState;
  transcript?: readonly HarnessTranscriptMessage[];
  transcriptOmissions?: HarnessTranscriptOmissions;
  runReport?: HarnessRunReport;
  policyTrace?: HarnessPolicyTrace;
  policySnapshot?: Record<string, unknown>;
  cellLabels?: Record<string, unknown>;
  toolOutputs?: RunEvidence["toolOutputs"];
  runId?: string;
}

const evidenceOf = (built: BuiltRun): RunEvidence => ({
  runDir: `/runs/${built.runId ?? RUN_ID}`,
  runId: built.runId ?? RUN_ID,
  runState: built.runState === undefined ? absent() : present(built.runState),
  transcript: built.transcript === undefined
    ? absent()
    : present(built.transcript),
  transcriptOmissions: built.transcriptOmissions === undefined
    ? absent()
    : present(built.transcriptOmissions),
  runReport: built.runReport === undefined
    ? absent()
    : present(built.runReport),
  policyTrace: built.policyTrace === undefined
    ? absent()
    : present(built.policyTrace),
  policySnapshot: built.policySnapshot === undefined
    ? absent()
    : present(built.policySnapshot as never),
  cellLabels: built.cellLabels === undefined
    ? absent()
    : present(built.cellLabels as never),
  toolOutputs: built.toolOutputs ?? { status: "absent", path: "built" },
});

const checkNamed = (id: string): AuditCheck => {
  const found = STRUCTURAL_CHECKS.find((check) => check.id === id);
  if (found === undefined) {
    throw new Error(`no check named ${id}`);
  }
  return found;
};

/** One check's outcome over a run built alone, with no delegation beside it. */
const inspect = (id: string, built: BuiltRun): CheckOutcome => {
  const root = evidenceOf(built);
  return checkNamed(id).inspect(root, { root, children: [] });
};

/** One check's outcome over a parent and the children built beside it. */
const inspectFamily = (
  id: string,
  parent: BuiltRun,
  children: readonly BuiltRun[],
): CheckOutcome => {
  const family: RunFamily = {
    root: evidenceOf(parent),
    children: children.map(evidenceOf),
  };
  return checkNamed(id).inspect(family.root, family);
};

/** The details of a check's evidence, joined for a substring assertion. */
const detailsOf = (outcome: CheckOutcome): string =>
  (outcome.evidence ?? []).map((one) => one.detail).join(" | ");

/** Where a check's evidence points, joined for a substring assertion. */
const pointersOf = (outcome: CheckOutcome): string =>
  (outcome.evidence ?? []).map((one) =>
    `${one.artifact ?? ""} ${one.pointer ?? ""}`
  ).join(" | ");

const handleTable = (
  ...tokens: readonly string[]
): HarnessHandleTable => ({
  type: "cf-harness.handle-table",
  version: 1,
  salt: RUN_ID,
  entries: tokens.map((token, index) => ({
    token,
    kind: "address",
    ref: `/of:fid1:${String.fromCharCode(65 + index).repeat(43)}`,
    addressKey: `address-${index}`,
  })),
});

const invocationContext = (
  mode: CfcEnforcementMode,
  toolId = "bash",
  outputId = `${RUN_ID}:bash:1`,
): HarnessCfcInvocationContext => ({
  type: "cf-harness.cfc-invocation-context",
  version: 1,
  sequence: 1,
  runId: RUN_ID,
  createdAt: "2026-01-01T00:00:00.000Z",
  toolId,
  toolOutputId: outputId as never,
  operation: "shell",
  cfcEnforcementMode: mode,
  cwd: "/workspace",
  runManifest: { present: false },
  inputs: {},
});

const deniedEvent = (toolCallId: string): HarnessPolicyEvent => ({
  type: "cf-harness.policy-event",
  severity: "denied",
  mode: "enforce-explicit",
  toolId: "bash",
  toolCallId,
  detail: "no trusted mediation metadata",
  at: "2026-01-01T00:00:01.000Z",
});

describe("structural", () => {
  describe("AUD-1 posture consistency", () => {
    it("returns `inconclusive` when the run report did not load", () => {
      // The clause names two places the mode must be in, so one of them
      // missing leaves the check with nothing to establish rather than with
      // the other one to pass on.

      const outcome = inspect("AUD-1", { runState: runState() });

      expect(outcome.verdict).toBe("inconclusive");
      expect(outcome.message).toContain("run-report.json");
    });

    it("fails a run report that states no mode", () => {
      const outcome = inspect("AUD-1", {
        runState: runState(),
        runReport: runReport({
          cfcEnforcementMode: undefined as never,
        }),
      });

      expect(outcome.verdict).toBe("fail");
      expect(outcome.message).toContain("states no enforcement mode");
    });

    it("fails an invocation context whose mode differs from the run's", () => {
      const outcome = inspect("AUD-1", {
        runState: runState({
          cfcInvocationContexts: [invocationContext("enforce-strict")],
        }),
        runReport: runReport(),
      });

      expect(outcome.verdict).toBe("fail");
      expect(pointersOf(outcome)).toContain("cfcInvocationContexts[1]");
    });

    it("names the fabric session as the mode's source when the run had one", () => {
      const outcome = inspect("AUD-1", {
        runState: runState({
          fabricSessionCfc: {
            enforcementMode: "enforce-explicit",
            enforcementModeSource: "preset-pin",
            flowLabels: "persist",
            flowLabelsSource: "posture",
          },
        }),
        runReport: runReport(),
      });

      expect(outcome.verdict).toBe("pass");
      expect(outcome.message).toContain("fabric session (preset-pin)");
    });
  });

  describe("AUD-2 mode-behavior attestation", () => {
    it("returns `pass` for a `disabled` run whose codes are the disabled family", () => {
      const decisions = [
        decision({
          toolCallId: "call-1",
          cfcEnforcementMode: "disabled",
          reasonCodes: ["cfc_disabled"],
        }),
      ];
      const outcome = inspect("AUD-2", {
        runState: runState({ cfcEnforcementMode: "disabled" }),
        policyTrace: policyTrace(decisions, {
          cfcEnforcementMode: "disabled",
        }),
      });

      expect(outcome.verdict).toBe("pass");
      expect(outcome.message).toContain("`disabled`");
    });

    it("returns `pass` for a mode-neutral reason code under any claim", () => {
      const decisions = [
        decision({ toolCallId: "call-1", reasonCodes: ["tool_not_allowed"] }),
      ];
      const outcome = inspect("AUD-2", {
        runState: runState(),
        policyTrace: policyTrace(decisions),
        runReport: runReport({ policyDecisions: decisions }),
      });

      expect(outcome.verdict).toBe("pass");
    });

    it("fails an enforce-strict code under an enforce-explicit claim", () => {
      const decisions = [
        decision({
          toolCallId: "call-1",
          reasonCodes: ["cfc_enforce_strict_direct_command"],
        }),
      ];
      const outcome = inspect("AUD-2", {
        runState: runState(),
        policyTrace: policyTrace(decisions),
        runReport: runReport({ policyDecisions: decisions }),
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("belongs to `enforce-strict`");
    });

    it("fails a call to a tool the same run transports evidence for, made with none", () => {
      const attested = activity({ toolCallId: "call-1", sequence: 1 });
      const unattested = activity({
        toolCallId: "call-2",
        sequence: 2,
        resultRef: {
          type: "cf-harness.tool-result-ref",
          outputId: `${RUN_ID}:bash:2` as never,
          toolId: "bash",
          runId: RUN_ID,
        },
      });
      const outcome = inspect("AUD-2", {
        runState: runState({
          cfcInvocationContexts: [invocationContext("enforce-explicit")],
        }),
        runReport: runReport({ toolActivity: [attested, unattested] }),
      });

      expect(outcome.verdict).toBe("fail");
      expect(outcome.message).toContain("transports CFC evidence for");
    });

    it("fails when only another tool's context carries the activity's output id", () => {
      // An output id is unique within a run, so a context some other tool
      // recorded must not read as covering this one's invocation.

      const covered = activity({
        toolCallId: "call-1",
        resultRef: {
          type: "cf-harness.tool-result-ref",
          outputId: `${RUN_ID}:bash:1` as never,
          toolId: "bash",
          runId: RUN_ID,
        },
      });
      const outcome = inspect("AUD-2", {
        runState: runState({
          cfcInvocationContexts: [
            invocationContext("enforce-explicit", "bash", `${RUN_ID}:bash:9`),
            invocationContext(
              "enforce-explicit",
              "some_other_tool",
              `${RUN_ID}:bash:1`,
            ),
          ],
        }),
        runReport: runReport({ toolActivity: [covered] }),
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("no invocation context");
    });

    it("returns `inconclusive` for an enforcing run whose report did not load", () => {
      const outcome = inspect("AUD-2", {
        runState: runState(),
        policyTrace: policyTrace([decision({ toolCallId: "call-1" })]),
      });

      expect(outcome.verdict).toBe("inconclusive");
      expect(outcome.message).toContain("run-report.json");
    });

    it("warns that an enforcing run with no transport evidence never exercised its claim", () => {
      const outcome = inspect("AUD-2", {
        runState: runState(),
        runReport: runReport({
          toolActivity: [
            activity({ toolCallId: "call-1", toolId: "assign_slug" }),
          ],
        }),
      });

      expect(outcome.verdict).toBe("warn");
      expect(outcome.message).toContain("never exercised it");
    });

    it("returns `pass` for an enforcing run that executed no side effect", () => {
      const outcome = inspect("AUD-2", {
        runState: runState(),
        runReport: runReport({
          toolActivity: [
            activity({ toolCallId: "call-1", effectClass: "read" }),
          ],
        }),
      });

      expect(outcome.verdict).toBe("pass");
      expect(outcome.message).toContain("made no substrate invocation");
    });

    describe("reason-code families", () => {
      // One case per mode-bearing family the closed reason-code union names,
      // so a code whose family the mapping misreads lands here rather than in
      // a silent `pass` under a mode it does not belong to.

      const families: readonly [string, CfcEnforcementMode][] = [
        ["write_file_disabled", "disabled"],
        ["write_file_observe_direct_command", "observe"],
        ["write_file_enforce_strict_direct_command", "enforce-strict"],
      ];

      for (const [code, mode] of families) {
        it(`reads \`${code}\` as belonging to \`${mode}\``, () => {
          const decisions = [
            decision({
              toolCallId: "call-1",
              reasonCodes: [code as never],
              cfcEnforcementMode: mode,
            }),
          ];
          const outcome = inspect("AUD-2", {
            runState: runState({ cfcEnforcementMode: mode }),
            policyTrace: policyTrace(decisions, { cfcEnforcementMode: mode }),
            runReport: runReport({
              cfcEnforcementMode: mode,
              policyDecisions: decisions,
            }),
          });

          expect(outcome.verdict).toBe("pass");
        });
      }
    });
  });

  describe("AUD-3 decision coverage", () => {
    it("reads the decisions off the run report when no policy trace loaded", () => {
      const decisions = [decision({ toolCallId: "call-1" })];
      const outcome = inspect("AUD-3", {
        runReport: runReport({
          policyDecisions: decisions,
          toolActivity: [activity({ toolCallId: "call-1" })],
        }),
      });

      expect(outcome.verdict).toBe("pass");
    });

    it("fails a policy trace whose declared counts do not match its decisions", () => {
      const decisions = [decision({ toolCallId: "call-1" })];
      const outcome = inspect("AUD-3", {
        policyTrace: policyTrace(decisions, {
          decisionCounts: { total: 7, allowed: 7, warned: 0, denied: 0 },
        }),
        runReport: runReport({
          policyDecisions: decisions,
          toolActivity: [activity({ toolCallId: "call-1" })],
        }),
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("declares total 7");
    });

    it("fails a run report whose declared counts do not match its decisions", () => {
      const decisions = [decision({ toolCallId: "call-1" })];
      const outcome = inspect("AUD-3", {
        policyTrace: policyTrace(decisions),
        runReport: runReport({
          policyDecisions: decisions,
          policyDecisionCounts: { total: 0, allowed: 0, warned: 0, denied: 0 },
          toolActivity: [activity({ toolCallId: "call-1" })],
        }),
      });

      expect(outcome.verdict).toBe("fail");
      expect(pointersOf(outcome)).toContain("policyDecisionCounts");
    });

    it("fails a persisted output that no tool activity accounts for", () => {
      const decisions = [decision({ toolCallId: "call-1" })];
      const outcome = inspect("AUD-3", {
        policyTrace: policyTrace(decisions),
        runReport: runReport({
          policyDecisions: decisions,
          toolActivity: [activity({ toolCallId: "call-1" })],
          toolOutputs: [{
            type: "cf-harness.tool-result-ref",
            outputId: `${RUN_ID}:bash:9` as never,
            toolId: "bash",
            runId: RUN_ID,
          }],
        }),
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("no tool activity accounts for");
    });

    it("fails a tool output on disk the run report does not list", () => {
      const decisions = [decision({ toolCallId: "call-1" })];
      const outcome = inspect("AUD-3", {
        policyTrace: policyTrace(decisions),
        runReport: runReport({
          policyDecisions: decisions,
          toolActivity: [activity({ toolCallId: "call-1" })],
        }),
        toolOutputs: {
          status: "present",
          path: "built/tool-outputs",
          entries: [{
            fileName: "stray-bash.json",
            path: "built/tool-outputs/stray-bash.json",
            value: { outputId: "stray" },
          }],
        },
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("does not list");
    });

    it("passes over a delegation's raw-return record, which is no tool's result", () => {
      const decisions = [decision({ toolCallId: "call-1" })];
      const outcome = inspect("AUD-3", {
        policyTrace: policyTrace(decisions),
        runReport: runReport({
          policyDecisions: decisions,
          toolActivity: [activity({ toolCallId: "call-1" })],
        }),
        toolOutputs: {
          status: "present",
          path: "built/tool-outputs",
          entries: [{
            fileName: "child_subagent_return_1-subagent-return.json",
            path:
              "built/tool-outputs/child_subagent_return_1-subagent-return.json",
            value: { type: "cf-harness.subagent-raw-return" },
          }],
        },
      });

      expect(outcome.verdict).toBe("pass");
    });
  });

  describe("AUD-4 denial channel", () => {
    it("reads a denial the run state recorded when no report or trace loaded", () => {
      const outcome = inspect("AUD-4", {
        runState: runState({
          policyEvents: [deniedEvent("call-1")],
          policyDecisions: [
            decision({ toolCallId: "call-1", decision: "denied" }),
          ],
        }),
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "bash",
          content: JSON.stringify({
            type: "cf-harness.observation-denied",
            reason: "not-observable",
          }),
        }],
      });

      expect(outcome.verdict).toBe("pass");
    });

    it("fails a denial the run recorded no policy event for", () => {
      const outcome = inspect("AUD-4", {
        runState: runState({
          policyDecisions: [
            decision({ toolCallId: "call-1", decision: "denied" }),
          ],
        }),
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "bash",
          content: JSON.stringify({
            type: "cf-harness.observation-denied",
            reason: "not-observable",
          }),
        }],
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("recorded no policy event for");
    });

    it("passes a denial a tool answered with its own typed error contract", () => {
      const outcome = inspect("AUD-4", {
        runState: runState({ policyEvents: [deniedEvent("call-1")] }),
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "read_file",
          content: JSON.stringify({
            outputId: `${RUN_ID}:read_file:1`,
            ok: false,
            error: {
              type: "cf-harness.structured-file-tool-error",
              code: "unknown",
            },
          }),
        }],
      });

      expect(outcome.verdict).toBe("pass");
    });

    it("fails a denial answered with an error object naming no contract", () => {
      const outcome = inspect("AUD-4", {
        runState: runState({ policyEvents: [deniedEvent("call-1")] }),
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "bash",
          content: JSON.stringify({ status: "error", error: {} }),
        }],
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("rather than a typed denial");
    });

    it("fails a denial the transcript answers with free text", () => {
      const outcome = inspect("AUD-4", {
        runState: runState({ policyEvents: [deniedEvent("call-1")] }),
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "bash",
          content: "permission denied",
        }],
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("free text");
    });

    it("fails a denial the transcript answers with some other typed result", () => {
      const outcome = inspect("AUD-4", {
        runState: runState({ policyEvents: [deniedEvent("call-1")] }),
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "bash",
          content: JSON.stringify({ type: "cf-harness.bash-output" }),
        }],
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("cf-harness.bash-output");
    });

    it("fails a denial the transcript answers with no message at all", () => {
      const outcome = inspect("AUD-4", {
        runState: runState({ policyEvents: [deniedEvent("call-1")] }),
        transcript: [],
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("no tool message in the transcript");
    });
  });

  describe("AUD-5 handle discipline", () => {
    it("returns `inconclusive` when the transcript did not load", () => {
      const outcome = inspect("AUD-5", { runState: runState() });

      expect(outcome.verdict).toBe("inconclusive");
      expect(outcome.message).toContain("transcript.json");
    });

    it("returns `not-applicable` for a run that minted no handle and carries none", () => {
      const outcome = inspect("AUD-5", {
        runState: runState(),
        transcript: [{ role: "user", content: "no tokens here" }],
      });

      expect(outcome.verdict).toBe("not-applicable");
    });

    it("fails a handle table `assertValidHarnessHandleTable` refuses", () => {
      const table = handleTable("cfh:a:aaaaa");
      table.entries.push({ ...table.entries[0]! });
      const outcome = inspect("AUD-5", {
        runState: runState({ handleTable: table }),
        transcript: [{ role: "user", content: "cfh:a:aaaaa" }],
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("duplicate token");
    });

    it("passes over a token the run's table does not hold", () => {
      const outcome = inspect("AUD-5", {
        runState: runState({ handleTable: handleTable("cfh:a:aaaaa") }),
        transcript: [
          {
            role: "tool",
            toolCallId: "c",
            toolName: "bash",
            content: "cfh:a:aaaaa",
          },
          { role: "assistant", content: "and cfh:a:bbbbb, which no mint made" },
        ],
      });

      expect(outcome.verdict).toBe("pass");
    });

    it("fails a parent token a child carries with no recorded transfer", () => {
      const outcome = inspectFamily(
        "AUD-5",
        {
          runState: runState({ handleTable: handleTable("cfh:a:aaaaa") }),
          transcript: [{
            role: "tool",
            toolCallId: "c",
            toolName: "bash",
            content: "cfh:a:aaaaa",
          }],
        },
        [{
          runId: `${RUN_ID}.subagent.1`,
          runState: runState({ runId: `${RUN_ID}.subagent.1` }),
          transcript: [{ role: "user", content: "cfh:a:aaaaa" }],
        }],
      );

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("no recorded transfer");
    });

    it("passes over a child whose transcript did not load", () => {
      const outcome = inspectFamily(
        "AUD-5",
        {
          runState: runState({ handleTable: handleTable("cfh:a:aaaaa") }),
          transcript: [{
            role: "tool",
            toolCallId: "c",
            toolName: "bash",
            content: "cfh:a:aaaaa",
          }],
        },
        [{
          runId: `${RUN_ID}.subagent.1`,
          runState: runState({ runId: `${RUN_ID}.subagent.1` }),
        }],
      );

      expect(outcome.verdict).toBe("pass");
    });
  });

  describe("AUD-7 observe disclosure", () => {
    it("warns rather than fails a run whose artifacts disagree about the mode", () => {
      // Disagreement is AUD-1's finding. What AUD-7 owes such a run is the
      // reading it owns: a dial at `observe` means the evidence attests no
      // enforcement, whatever else the tree also says.

      const built = {
        runState: runState({ cfcEnforcementMode: "observe" as const }),
        runReport: runReport({ cfcEnforcementMode: "enforce-explicit" }),
      };

      expect(inspect("AUD-7", built).verdict).toBe("warn");
      expect(inspect("AUD-1", built).verdict).toBe("fail");
    });

    it("warns a run whose fabric session held flow labels at `observe`", () => {
      const outcome = inspect("AUD-7", {
        runState: runState({
          fabricSessionCfc: {
            enforcementMode: "enforce-explicit",
            enforcementModeSource: "configured",
            flowLabels: "observe",
            flowLabelsSource: "configured",
          },
        }),
      });

      expect(outcome.verdict).toBe("warn");
      expect(outcome.message).toContain("label propagation was diagnostic");
    });
  });

  describe("AUD-8 influence accumulation", () => {
    it("returns `inconclusive` when the run state did not load", () => {
      const outcome = inspect("AUD-8", { transcript: [] });

      expect(outcome.verdict).toBe("inconclusive");
      expect(outcome.message).toContain("run-state.json");
    });

    it("fails influence accumulated from a channel the result records as denied", () => {
      const outcome = inspect("AUD-8", {
        runState: runState({
          cfcModelContext: {
            type: "cf-harness.cfc-model-context",
            version: 1,
            updatedAt: "2026-01-01T00:00:01.000Z",
            label: { confidentiality: ["secret"] },
            observations: [{
              type: "cf-harness.cfc-model-context-observation",
              sequence: 1,
              at: "2026-01-01T00:00:01.000Z",
              toolCallId: "call-1",
              toolId: "bash",
              outputId: `${RUN_ID}:bash:1` as never,
              channels: ["stdout"],
              policy: "observed",
              label: { confidentiality: ["secret"] },
            }],
          },
        }),
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "bash",
          content: JSON.stringify({
            cfc: {
              stdout: {
                channel: "stdout",
                policy: "denied",
                label: { confidentiality: ["secret"] },
              },
            },
          }),
        }],
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain(
        "which the result records as `denied`",
      );
    });
  });

  describe("AUD-20 omission accounting", () => {
    it("requires an exact omission entry for a host-carried research result", () => {
      const message = annotateHarnessUserResultOmissions({
        role: "user",
        content: "Opening research handoff.",
        toolResultProvenance: {
          type: "cf-harness.tool-result-provenance",
          toolCallId: "opening-research",
          toolId: "research",
          outputId: createToolOutputId(RUN_ID, "research", 1),
        },
      }, [{
        rule: "artifact-only",
        locations: [{
          artifactPath: "tool-outputs/research.json",
          jsonPointer: "/researchRecord",
        }],
      }]);
      const transcript = [message];
      const omissions = createHarnessTranscriptOmissions(transcript);
      const valid = inspect("AUD-20", {
        transcript,
        transcriptOmissions: omissions,
      });
      const missing = inspect("AUD-20", {
        transcript,
        transcriptOmissions: { ...omissions, results: [] },
      });
      const mismatched = inspect("AUD-20", {
        transcript,
        transcriptOmissions: {
          ...omissions,
          results: omissions.results.map((entry) => ({
            ...entry,
            toolCallId: "another-call",
          })),
        },
      });

      expect(valid.verdict).toBe("pass");
      expect(valid.message).toContain("`artifact-only` 1");
      expect(missing.verdict).toBe("fail");
      expect(detailsOf(missing)).toContain("maps to 0 omission entries");
      expect(mismatched.verdict).toBe("fail");
      expect(detailsOf(mismatched)).toContain(
        "result identity does not match its transcript message",
      );
    });

    it("counts each recorded omission rule", () => {
      const outcome = inspect("AUD-20", {
        transcript: [{ role: "user", content: "Run it." }, {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "run_pattern", arguments: "{}" },
          }],
        }, {
          role: "tool",
          toolCallId: "call-1",
          toolName: "run_pattern",
          content: "model-facing",
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId: `${RUN_ID}:run_pattern:1` as never,
            toolId: "run_pattern",
            runId: RUN_ID,
          },
        }],
        transcriptOmissions: {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 2,
            toolCallId: "call-1",
            toolId: "run_pattern",
            outputId: `${RUN_ID}:run_pattern:1`,
            rules: [
              {
                rule: "artifact-only",
                locations: [{
                  artifactPath: "tool-outputs/result.json",
                  jsonPointer: "/rawValue",
                }],
              },
              {
                rule: "bare-fabric-identifier-scrub",
                locations: [{
                  artifactPath: "tool-outputs/result.json",
                  jsonPointer: "/message",
                }],
              },
            ],
          }],
        },
      });

      expect(outcome.verdict).toBe("pass");
      expect(outcome.message).toContain("`artifact-only` 1");
      expect(outcome.message).toContain("`model-context-truncation` 0");
      expect(detailsOf(outcome)).toContain(
        "bare-fabric-identifier-scrub: 1",
      );
    });

    it("returns `inconclusive` when the run predates omission records", () => {
      const outcome = inspect("AUD-20", {});

      expect(outcome.verdict).toBe("inconclusive");
      expect(outcome.message).toContain("predates");
    });

    it("returns `inconclusive` when a current omission record has no transcript", () => {
      const outcome = inspect("AUD-20", {
        transcriptOmissions: {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [],
        },
      });

      expect(outcome.verdict).toBe("inconclusive");
      expect(outcome.message).toContain("`transcript.json` is absent");
    });

    it("returns `inconclusive` when a current omission record has an unreadable transcript", () => {
      const root = evidenceOf({
        transcriptOmissions: {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [],
        },
      });
      root.transcript = {
        status: "unparseable",
        path: "built",
        detail: "did not parse",
      };

      const outcome = checkNamed("AUD-20").inspect(root, {
        root,
        children: [],
      });

      expect(outcome.verdict).toBe("inconclusive");
      expect(outcome.message).toContain("did not parse");
    });

    it("fails duplicate rules and rules without a location", () => {
      const outcome = inspect("AUD-20", {
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "run_pattern",
          content: "model-facing",
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId: `${RUN_ID}:run_pattern:1` as never,
            toolId: "run_pattern",
            runId: RUN_ID,
          },
        }],
        transcriptOmissions: {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 0,
            toolCallId: "call-1",
            toolId: "run_pattern",
            outputId: `${RUN_ID}:run_pattern:1`,
            rules: [{
              rule: "artifact-only",
              locations: [{
                artifactPath: "tool-outputs/result.json",
                jsonPointer: "/rawValue",
              }],
            }, {
              rule: "artifact-only",
              locations: [],
            }],
          }],
        },
      });

      expect(outcome.verdict).toBe("fail");
      expect(outcome.message).toBe("2 omission-accounting errors found");
      expect(detailsOf(outcome)).toContain("recorded more than once");
      expect(detailsOf(outcome)).toContain("names no withheld location");
    });

    it("fails duplicate results and transcript identity mismatches", () => {
      const result = {
        transcriptIndex: 1,
        toolCallId: "call-1",
        toolId: "bash",
        outputId: `${RUN_ID}:bash:1`,
        rules: [{
          rule: "artifact-only" as const,
          locations: [{
            artifactPath: "tool-outputs/result.json",
            jsonPointer: "/stdout",
          }],
        }],
      };
      const outcome = inspect("AUD-20", {
        transcript: [{ role: "user", content: "Run it." }, {
          role: "tool",
          toolCallId: "another-call",
          toolName: "bash",
          content: "model-facing",
        }],
        transcriptOmissions: {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [result, result],
        },
      });

      expect(outcome.verdict).toBe("fail");
      expect(detailsOf(outcome)).toContain("recorded more than once");
      expect(detailsOf(outcome)).toContain("does not match");
    });

    it("fails when the omission record covers only part of the transcript", () => {
      const firstOutputId = `${RUN_ID}:bash:1` as never;
      const secondOutputId = `${RUN_ID}:bash:2` as never;
      const toolResult = (
        toolCallId: string,
        outputId: typeof firstOutputId,
      ) => ({
        role: "tool" as const,
        toolCallId,
        toolName: "bash",
        content: "model-facing",
        resultRef: {
          type: "cf-harness.tool-result-ref" as const,
          outputId,
          toolId: "bash",
          runId: RUN_ID,
        },
      });
      const outcome = inspect("AUD-20", {
        transcript: [
          toolResult("call-1", firstOutputId),
          toolResult("call-2", secondOutputId),
        ],
        transcriptOmissions: {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 0,
            toolCallId: "call-1",
            toolId: "bash",
            outputId: firstOutputId,
            rules: [],
          }],
        },
      });

      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence).toContainEqual({
        artifact: "transcript.json",
        pointer: "[1].resultRef",
        detail:
          `tool result \`${secondOutputId}\` maps to 0 omission entries; exactly one is required`,
      });
    });

    it("fails a withheld location with an empty artifact path", () => {
      const outputId = `${RUN_ID}:bash:1` as never;
      const outcome = inspect("AUD-20", {
        transcript: [{
          role: "tool",
          toolCallId: "call-1",
          toolName: "bash",
          content: "model-facing",
          resultRef: {
            type: "cf-harness.tool-result-ref",
            outputId,
            toolId: "bash",
            runId: RUN_ID,
          },
        }],
        transcriptOmissions: {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 0,
            toolCallId: "call-1",
            toolId: "bash",
            outputId,
            rules: [{
              rule: "model-context-truncation",
              locations: [{ artifactPath: "", jsonPointer: "/stdout" }],
            }],
          }],
        },
      });

      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence).toContainEqual({
        artifact: "transcript-omissions.json",
        pointer: "results[0].rules[0].locations[0].artifactPath",
        detail: "rule `model-context-truncation` names an empty artifact path",
      });
    });
  });

  describe("auditRunFamily()", () => {
    it("returns `inconclusive` naming the failure when a check throws", () => {
      const throwing: AuditCheck = {
        id: "AUD-X",
        title: "a check that throws",
        citations: [],
        falsifiedBy: "nothing; it exists to fail",
        inspect() {
          throw new Error("the shape was one this check has no name for");
        },
      };
      const root = evidenceOf({ runState: runState() });

      const results = auditRunFamily({ root, children: [] }, [throwing]);

      expect(results.map((one) => one.verdict)).toEqual(["inconclusive"]);
      expect(results[0]!.message).toContain("no name for");
    });
  });
});
