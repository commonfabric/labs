/**
 * What each check is for: the shape it is supposed to catch, seeded into a
 * clean run and required to turn that check's verdict and no other's.
 *
 * The two halves matter equally. A check whose verdict never turns cannot
 * fail, and a check that reports a finding on every neighboring mutation says
 * nothing about the clause it cites. Each case here therefore asserts the
 * whole verdict map, so a check that widens to catch its neighbor's violation
 * fails here rather than in a reviewer's reading.
 *
 * The mutations are in memory. Nothing writes into the fixture tree, which is
 * the same discipline the checker itself holds to.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { inheritedCfcPostureReport } from "@commonfabric/runner/cfc";

import {
  HARNESS_CELL_LABELS_TYPE,
  type HarnessCellLabelRecord,
  type HarnessCellLabels,
} from "../../src/contracts/cell-labels.ts";
import type { HarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type { HarnessHandleEntry } from "../../src/contracts/handle-table.ts";
import type {
  HarnessPolicyDecisionReasonCode,
  HarnessPolicyDecisionRecord,
  HarnessPolicyTrace,
} from "../../src/contracts/policy-trace.ts";
import type { PromptSlotBinding } from "../../src/contracts/prompt-slot.ts";
import type { HarnessRunReport } from "../../src/contracts/run-report.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import type {
  HarnessFabricSessionCfcPosture,
  HarnessRunState,
} from "../../src/run-state.ts";
import { BUILTIN_TOOL_REGISTRY } from "../../src/tools/registry.ts";
import { RUN_CHECKS } from "../checks/registry.ts";
import {
  auditRunFamily,
  HOST_AUTHORED_OUTPUT_WRITERS,
} from "../checks/structural.ts";
import { harnessFabricSessionPosture } from "../../src/cfc-posture.ts";
import {
  loadRunFamily,
  type RunEvidence,
  type RunFamily,
  type ToolOutputArtifact,
} from "../evidence.ts";
import type { CheckVerdict } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));

/** Every check's verdict, keyed by check and run. */
const verdicts = (audited: RunFamily): Record<string, CheckVerdict> =>
  Object.fromEntries(
    auditRunFamily(audited, RUN_CHECKS).map((
      result,
    ) => [`${result.checkId}@${result.runId}`, result.verdict]),
  );

const CLEAN = verdicts(family);

/** The parent run's key for a check, which is where every mutation lands. */
const at = (checkId: string): string => `${checkId}@${FIXTURE_RUN_ID}`;

/** The family with `mutate` applied to a deep copy of its root run. */
const seeded = (mutate: (root: RunEvidence) => void): RunFamily => {
  const root = structuredClone(family.root);
  mutate(root);
  return { root, children: structuredClone(family.children) };
};

/**
 * Asserts that seeding `mutate` turns exactly `checkId`'s verdict, to
 * `expected`, and leaves every other verdict of the family where it was.
 */
const turnsOnly = (
  checkId: string,
  expected: CheckVerdict,
  mutate: (root: RunEvidence) => void,
): void => {
  expect(verdicts(seeded(mutate))).toEqual({
    ...CLEAN,
    [at(checkId)]: expected,
  });
};

/**
 * Asserts that seeding `mutate` turns exactly the verdicts `expected` names,
 * and leaves every other verdict of the family where it was.
 *
 * The plural of {@link turnsOnly}, for a mutation two checks are each
 * separately right to report on.
 */
const turnsInto = (
  expected: Record<string, CheckVerdict>,
  mutate: (root: RunEvidence) => void,
): void => {
  expect(verdicts(seeded(mutate))).toEqual({
    ...CLEAN,
    ...Object.fromEntries(
      Object.entries(expected).map(([checkId, verdict]) => [
        at(checkId),
        verdict,
      ]),
    ),
  });
};

/**
 * A persisted artifact as a seeding step may edit it.
 *
 * The contracts declare their lists `readonly`, which is right for the code
 * that produces them and wrong here: what a violation is, is an artifact
 * tree that says something the contract's producer would not have written.
 */
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer E)[]
    ? (E extends object ? Mutable<E> : E)[]
    : T[K];
};

const stateOf = (run: RunEvidence): Mutable<HarnessRunState> => {
  if (run.runState.status !== "present") {
    throw new Error("the fixture's run state did not load");
  }
  return run.runState.value as Mutable<HarnessRunState>;
};

const traceOf = (run: RunEvidence): Mutable<HarnessPolicyTrace> => {
  if (run.policyTrace.status !== "present") {
    throw new Error("the fixture's policy trace did not load");
  }
  return run.policyTrace.value as Mutable<HarnessPolicyTrace>;
};

const reportOf = (run: RunEvidence): Mutable<HarnessRunReport> => {
  if (run.runReport.status !== "present") {
    throw new Error("the fixture's run report did not load");
  }
  return run.runReport.value as Mutable<HarnessRunReport>;
};

const transcriptOf = (
  run: RunEvidence,
): Mutable<HarnessTranscriptMessage>[] => {
  if (run.transcript.status !== "present") {
    throw new Error("the fixture's transcript did not load");
  }
  return run.transcript.value as Mutable<HarnessTranscriptMessage>[];
};

/** The tool output the fixture's second invocation context explains. */
const SECOND_BASH_OUTPUT_ID = `${FIXTURE_RUN_ID}:bash:2`;

/**
 * Removes the invocation contexts `drop` selects, from both artifacts that
 * carry them, so the seeded run reads as one that never recorded them rather
 * than as one whose artifacts disagree.
 */
const dropInvocationContexts = (
  run: RunEvidence,
  drop: (context: HarnessCfcInvocationContext) => boolean,
): void => {
  const state = stateOf(run);
  state.cfcInvocationContexts = (state.cfcInvocationContexts ?? []).filter(
    (context) => !drop(context),
  );
  const trace = traceOf(run);
  trace.cfcInvocationContexts = (trace.cfcInvocationContexts ?? []).filter(
    (context) => !drop(context),
  );
};

/**
 * Adds an invocation context to both artifacts that carry them, built from the
 * fixture's own so it is the shape the mint site produces rather than one
 * written to suit a check.
 */
const seedInvocationContext = (
  run: RunEvidence,
  overrides: Partial<HarnessCfcInvocationContext>,
): void => {
  const state = stateOf(run);
  const template = (state.cfcInvocationContexts ?? [])[0];
  if (template === undefined) {
    throw new Error("the fixture recorded no invocation context to build on");
  }
  const context = { ...structuredClone(template), ...overrides };
  state.cfcInvocationContexts = [
    ...(state.cfcInvocationContexts ?? []),
    context,
  ];
  const trace = traceOf(run);
  trace.cfcInvocationContexts = [
    ...(trace.cfcInvocationContexts ?? []),
    context,
  ];
};

/** Adds a file to the run's `tool-outputs/`, as a reader would have found it. */
const seedToolOutput = (
  run: RunEvidence,
  fileName: string,
  value: unknown,
): void => {
  if (run.toolOutputs.status !== "present") {
    throw new Error("the fixture's tool outputs did not load");
  }
  (run.toolOutputs.entries as ToolOutputArtifact[]).push({
    fileName,
    path: join(run.toolOutputs.path, fileName),
    value,
  });
};

/**
 * The fabric-session posture a run recorded when it ran a session at all.
 *
 * The fixture tree records none — the runs it was captured from had no
 * fabric session — so the Group C cases install one first. It is built the
 * way the harness builds it, from a session config, rather than written out
 * by hand: a hand-written record would pass these checks by agreeing with
 * the checks rather than by being what a session resolves.
 */
const CONFORMING_SESSION_POSTURE: HarnessFabricSessionCfcPosture = {
  enforcementMode: "enforce-explicit",
  enforcementModeSource: "preset-pin",
  flowLabels: "persist",
  flowLabelsSource: "posture",
  posture: "max-enforcement",
  record: harnessFabricSessionPosture({
    apiUrl: "https://fabric.test/",
    identityKeyPath: "/dev/null",
    space: "did:key:seeded",
    cfcPosture: "max-enforcement",
  }),
};

/**
 * A recorded posture as a seeding step may edit it.
 *
 * The posture record's fields are `readonly` all the way down, which is right
 * for the code that produces it and wrong here: what a violation is, is a
 * record saying something its producer would not have written.
 */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> };

/** The family with a conforming session posture installed on its root run. */
const withSessionPosture = (
  mutate: (posture: DeepMutable<HarnessFabricSessionCfcPosture>) => void,
): RunFamily =>
  seeded((root) => {
    const posture = structuredClone(
      CONFORMING_SESSION_POSTURE,
    ) as DeepMutable<HarnessFabricSessionCfcPosture>;
    mutate(posture);
    stateOf(root).fabricSessionCfc = posture;
  });

/** Every verdict of the family once a conforming session posture is installed. */
const SESSION_CLEAN = verdicts(withSessionPosture(() => {}));

/**
 * The family with the conforming posture on its root and the same posture,
 * stamped `inherited`, on every child — a delegation as the harness records
 * one, where the child runs on the session its parent built.
 */
const withInheritedChildPosture = (): RunFamily => {
  const audited = withSessionPosture(() => {});
  const parentRecord = CONFORMING_SESSION_POSTURE.record!;
  for (const child of audited.children) {
    stateOf(child).fabricSessionCfc = {
      ...structuredClone(CONFORMING_SESSION_POSTURE),
      record: inheritedCfcPostureReport(parentRecord),
    };
  }
  return audited;
};

/** The key a check's verdict on `run` is held under. */
const on = (checkId: string, runId: string): string => `${checkId}@${runId}`;

/**
 * Asserts that seeding `mutate` into the session posture turns exactly
 * `checkId`'s verdict, against the baseline where that posture is conforming.
 */
const sessionTurnsOnly = (
  checkId: string,
  expected: CheckVerdict,
  mutate: (posture: DeepMutable<HarnessFabricSessionCfcPosture>) => void,
): void => {
  expect(verdicts(withSessionPosture(mutate))).toEqual({
    ...SESSION_CLEAN,
    [at(checkId)]: expected,
  });
};

describe("seeded violations", () => {
  describe("the clean fixture", () => {
    it("reports nothing but the defects the register names", () => {
      // The fixture is a captured run of a system that has the gaps the Group
      // E checks are about, so a clean tree is no longer a silent one. What
      // has to stay true is that the noise is exactly the known set: a Group
      // A or Group C finding here is a regression, and this is where it
      // surfaces.
      expect(
        Object.fromEntries(
          Object.entries(CLEAN).filter(([, verdict]) =>
            verdict !== "pass" && verdict !== "not-applicable"
          ),
        ),
      ).toEqual({
        [at("AUD-21")]: "fail",
        [at("AUD-22")]: "fail",
        [on("AUD-22", `${FIXTURE_RUN_ID}.subagent.1`)]: "fail",
      });
    });

    it("exercises every check on the run that carries the delegation", () => {
      expect(
        RUN_CHECKS.filter((check) => CLEAN[at(check.id)] === undefined)
          .map((check) => check.id),
      ).toEqual([]);
    });
  });

  describe("check registration", () => {
    it("names what falsifies every check", () => {
      expect(
        RUN_CHECKS.filter((check) => check.falsifiedBy.trim() === "")
          .map((check) => check.id),
      ).toEqual([]);
    });

    it("gives every check a distinct id", () => {
      expect(new Set(RUN_CHECKS.map((check) => check.id)).size).toBe(
        RUN_CHECKS.length,
      );
    });
  });

  describe("AUD-1 posture consistency", () => {
    it("fails a decision record whose mode differs from the run's", () => {
      turnsOnly("AUD-1", "fail", (root) => {
        traceOf(root).decisions[0]!.cfcEnforcementMode = "enforce-strict";
      });
    });
  });

  describe("AUD-2 mode-behavior attestation", () => {
    it("fails an observe-family reason code under an enforcing claim", () => {
      turnsOnly("AUD-2", "fail", (root) => {
        traceOf(root).decisions[0]!.reasonCodes.push("cfc_observe_read");
      });
    });

    it("fails a substrate-reaching side effect whose context was dropped", () => {
      // AUD-9 turns with it: the call is unattested, and what would explain
      // its result is the artifact that went missing.

      expect(verdicts(seeded((root) => {
        dropInvocationContexts(
          root,
          (context) => context.toolOutputId === SECOND_BASH_OUTPUT_ID,
        );
      }))).toEqual({
        ...CLEAN,
        [at("AUD-2")]: "fail",
        [at("AUD-9")]: "fail",
      });
    });
  });

  describe("AUD-3 decision coverage", () => {
    it("fails a side-effect activity whose decision was deleted", () => {
      turnsOnly("AUD-3", "fail", (root) => {
        const trace = traceOf(root);
        const report = reportOf(root);
        const dropped = report.toolActivity.find((activity) =>
          activity.effectClass === "side-effect" &&
          activity.policyDecision !== "denied"
        )!;
        const surviving = trace.decisions.filter((decision) =>
          decision.toolCallId !== dropped.toolCallId
        );
        trace.decisions = surviving;
        trace.decisionCounts = {
          total: surviving.length,
          allowed: surviving.filter((one) => one.decision === "allowed").length,
          warned: surviving.filter((one) => one.decision === "warned").length,
          denied: surviving.filter((one) => one.decision === "denied").length,
        };
      });
    });

    it("fails a persisted tool output the run report does not list", () => {
      turnsOnly("AUD-3", "fail", (root) => {
        seedToolOutput(root, `${FIXTURE_RUN_ID}_bash_4-bash.json`, {
          outputId: `${FIXTURE_RUN_ID}:bash:4`,
          stdout: "unrecorded\n",
          stderr: "",
          exitCode: 0,
        });
      });
    });

    it("passes a run-pattern-source sidecar the run report does not list", () => {
      expect(verdicts(seeded((root) => {
        seedToolOutput(
          root,
          `${FIXTURE_RUN_ID}_run_pattern_4-run-pattern-source.json`,
          {
            type: "cf-harness.run-pattern-source",
            outputId: `${FIXTURE_RUN_ID}:run_pattern:4`,
            sourceText: "export default recipe(Input, () => ({}));",
          },
        );
      }))).toEqual(CLEAN);
    });

    it("fails an unlisted tool output claiming a host writer's `type`", () => {
      // The exemption is the writing path, which `persistToolOutput` composed
      // and a model never reaches. This file took a `bash` call's path and
      // says it took the sidecar's, which is the evasion an exemption keyed on
      // a field inside the artifact would have admitted.

      turnsOnly("AUD-3", "fail", (root) => {
        seedToolOutput(root, `${FIXTURE_RUN_ID}_bash_4-bash.json`, {
          type: "cf-harness.run-pattern-source",
          outputId: `${FIXTURE_RUN_ID}:bash:4`,
          stdout: "unrecorded\n",
        });
      });
    });

    it("names no builtin tool among the writers it exempts", () => {
      // A writer name that were also a tool id would exempt every output of
      // that tool, because the two share the one filename suffix.
      expect(
        [...BUILTIN_TOOL_REGISTRY.keys()].filter((toolId) =>
          HOST_AUTHORED_OUTPUT_WRITERS.has(toolId)
        ),
      ).toEqual([]);
    });
  });

  describe("AUD-4 denial channel", () => {
    it("fails a denied tool message carrying the withheld payload", () => {
      turnsOnly("AUD-4", "fail", (root) => {
        const denied = reportOf(root).toolActivity.find((activity) =>
          activity.policyDecision === "denied"
        )!;
        for (const message of transcriptOf(root)) {
          if (
            message.role === "tool" && message.toolCallId === denied.toolCallId
          ) {
            message.content = JSON.stringify({
              ...JSON.parse(message.content),
              stdout: "the withheld bytes",
            });
          }
        }
      });
    });

    it("counts denials rather than defects when one denial fails twice", () => {
      const mutate = (root: RunEvidence): void => {
        const denied = reportOf(root).toolActivity.find((activity) =>
          activity.policyDecision === "denied"
        )!;
        // One denial, two defects: no policy event accounts for it, and the
        // message answering it is untyped free text.
        const state = stateOf(root);
        state.policyEvents = state.policyEvents.filter((event) =>
          event.toolCallId !== denied.toolCallId
        );
        const report = reportOf(root);
        report.policyEvents = (report.policyEvents ?? []).filter((event) =>
          event.toolCallId !== denied.toolCallId
        );
        for (const message of transcriptOf(root)) {
          if (
            message.role === "tool" && message.toolCallId === denied.toolCallId
          ) {
            message.content = "refused";
          }
        }
      };
      // The whole map, as every case in this file asserts it: a mutation that
      // also turned a neighbor's verdict would say nothing about AUD-4.
      turnsOnly("AUD-4", "fail", mutate);

      // Then the message itself, which is what this case is really about: the
      // numerator counts denials, so it cannot exceed the denominator even
      // though this one denial failed the check twice over.
      const outcome = auditRunFamily(seeded(mutate), RUN_CHECKS).find((
        result,
      ) => result.checkId === "AUD-4" && result.runId === FIXTURE_RUN_ID)!;
      expect(outcome.message).toContain("1 of 1 denial");
      expect(outcome.evidence?.length).toBe(2);
    });

    it("reconciles a trace declaring a `withheld` count this build cannot spell", () => {
      // CT-2232 adds `withheld` beside `allowed`, `warned`, `denied` and
      // `invalid`. An audit that could only read the outcomes it was built
      // with would fail every run written by a newer harness — so the count is
      // read when present, and absent still reads as zero for a trace written
      // before it existed. Neither direction is a disagreement here.
      turnsOnly("AUD-3", "pass", (root) => {
        const trace = traceOf(root) as unknown as {
          decisionCounts: Record<string, number>;
        };
        trace.decisionCounts.withheld = 0;
      });
    });

    it("does not count an invalid-argument rejection as a denial", () => {
      const invalidated = (root: RunEvidence): void => {
        const trace = traceOf(root);
        const decision = trace.decisions.at(-1)!;
        decision.decision = "invalid";
        decision.reasonCodes = ["invalid_tool_call"];
        trace.decisionCounts.allowed -= 1;
        trace.decisionCounts.invalid = (trace.decisionCounts.invalid ?? 0) + 1;
        const report = reportOf(root);
        const reported = (report.policyDecisions ?? []).find((candidate) =>
          candidate.toolCallId === decision.toolCallId
        );
        if (reported !== undefined) {
          reported.decision = "invalid";
          reported.reasonCodes = ["invalid_tool_call"];
        }
        if (report.policyDecisionCounts !== undefined) {
          report.policyDecisionCounts.allowed -= 1;
          report.policyDecisionCounts.invalid =
            (report.policyDecisionCounts.invalid ?? 0) + 1;
        }
        const state = stateOf(root);
        const held = (state.policyDecisions ?? []).find((candidate) =>
          candidate.toolCallId === decision.toolCallId
        );
        if (held !== undefined) {
          held.decision = "invalid";
          held.reasonCodes = ["invalid_tool_call"];
        }
        for (const activity of report.toolActivity) {
          if (activity.toolCallId === decision.toolCallId) {
            activity.policyDecision = "invalid";
          }
        }
      };

      // A rejection the loop made over arguments it could not read reached no
      // policy question, so it owes the typed deny channel nothing.
      expect(verdicts(seeded(invalidated))).toEqual(CLEAN);
    });
  });

  describe("AUD-5 handle discipline", () => {
    it("fails a handle token the model wrote before any mint disclosed it", () => {
      turnsOnly("AUD-5", "fail", (root) => {
        const token = "cfh:a:zzzzz";
        const entry: HarnessHandleEntry = {
          token,
          kind: "address",
          ref: `/of:fid1:${"B".repeat(43)}`,
          addressKey: "seeded-pre-mint-address",
        };
        stateOf(root).handleTable!.entries.push(entry);
        const assistant = transcriptOf(root).find((message) =>
          message.role === "assistant"
        )!;
        assistant.content = `${assistant.content} ${token}`;
      });
    });
  });

  describe("AUD-6 transcript pairing", () => {
    it("fails a tool result no call is left outstanding for", () => {
      turnsOnly("AUD-6", "fail", (root) => {
        const transcript = transcriptOf(root);
        const last = transcript.findLast((message) => message.role === "tool")!;
        const orphan = structuredClone(last);
        if (orphan.role === "tool") {
          delete orphan.resultRef;
        }
        transcript.push(orphan);
      });
    });
  });

  describe("AUD-7 observe disclosure", () => {
    it("warns rather than passes a run whose every dial stands at observe", () => {
      // Every claim the run owns moves together, reason codes included, so
      // nothing else has a disagreement to report — that shape is AUD-1's
      // finding. What is left is the reading AUD-7 owns: a diagnostic run
      // whose evidence must not be taken for enforcement.
      //
      // AUD-21 leaves the register with it, and correctly: a diagnostic run
      // admits its side effects without claiming to have decided about them,
      // so there is no admission for the known defect to be about.

      turnsInto({ "AUD-7": "warn", "AUD-21": "not-applicable" }, (root) => {
        // Every enforcing reason code has an observe-family counterpart of
        // the same name, so the substitution lands inside the closed union.
        const observing = (
          code: HarnessPolicyDecisionReasonCode,
        ): HarnessPolicyDecisionReasonCode =>
          code.replace(
            /enforce_(explicit|strict)/,
            "observe",
          ) as HarnessPolicyDecisionReasonCode;
        const moveDecisions = (
          decisions: readonly HarnessPolicyDecisionRecord[] | undefined,
        ): void => {
          for (
            const decision of (decisions ??
              []) as Mutable<HarnessPolicyDecisionRecord>[]
          ) {
            decision.cfcEnforcementMode = "observe";
            decision.reasonCodes = decision.reasonCodes.map(observing);
          }
        };
        const state = stateOf(root);
        const report = reportOf(root);
        state.cfcEnforcementMode = "observe";
        report.cfcEnforcementMode = "observe";
        moveDecisions(state.policyDecisions);
        moveDecisions(report.policyDecisions);
        for (const context of state.cfcInvocationContexts ?? []) {
          context.cfcEnforcementMode = "observe";
        }
        for (
          const trace of [traceOf(root), state.policyTrace, report.policyTrace]
        ) {
          if (trace === undefined) continue;
          trace.cfcEnforcementMode = "observe";
          moveDecisions(trace.decisions);
          for (const context of trace.cfcInvocationContexts ?? []) {
            context.cfcEnforcementMode = "observe";
          }
        }
      });
    });
  });

  describe("AUD-8 influence accumulation", () => {
    it("fails a labeled observation stripped from the model context", () => {
      turnsOnly("AUD-8", "fail", (root) => {
        stateOf(root).cfcModelContext!.observations = [];
      });
    });
  });

  describe("the conforming session posture", () => {
    it("passes the matrix and the drift check, and names the llm gap", () => {
      // The baseline the Group C cases move away from. AUD-14 is a WARN here
      // by design: the max-enforcement posture leaves the llm sinks ungated,
      // and the always-emitted finding is what publishes that rather than
      // leaving it to be inferred from a sink's absence.
      expect(SESSION_CLEAN[at("AUD-13")]).toBe("pass");
      expect(SESSION_CLEAN[at("AUD-14")]).toBe("warn");
      expect(SESSION_CLEAN[at("AUD-15")]).toBe("not-applicable");
      expect(SESSION_CLEAN[at("AUD-15a")]).toBe("pass");
    });
  });

  describe("a delegated child's inherited posture", () => {
    it("evaluates the two record-reading checks on the child rather than leaving them inconclusive", () => {
      // The child is where `run_pattern` runs, so a child recording no
      // posture record leaves the run that exercises the sinks as the one
      // whose sink registry the audit cannot establish. Inheriting the
      // parent's record is what gives these two checks something to read.
      const inherited = verdicts(withInheritedChildPosture());
      const childIds = family.children.map((child) => child.runId);
      expect(childIds.length).toBeGreaterThan(0);
      expect(inherited).toEqual({
        ...SESSION_CLEAN,
        ...Object.fromEntries(childIds.flatMap((runId) => [
          [on("AUD-13", runId), "pass"],
          [on("AUD-14", runId), "warn"],
          [on("AUD-15", runId), "not-applicable"],
          [on("AUD-15a", runId), "pass"],
        ])),
      });
    });

    it("leaves both inconclusive on a child that recorded the dials without the record", () => {
      const withoutRecord = withInheritedChildPosture();
      for (const child of withoutRecord.children) {
        delete stateOf(child).fabricSessionCfc!.record;
      }
      const verdictMap = verdicts(withoutRecord);
      for (const child of withoutRecord.children) {
        expect(verdictMap[on("AUD-13", child.runId)]).toBe("inconclusive");
        expect(verdictMap[on("AUD-14", child.runId)]).toBe("inconclusive");
      }
    });
  });

  describe("AUD-21 label-consulting admission", () => {
    it("fails today, on a run whose side effects were admitted on authority", () => {
      // The defect direction, and it needs no seeding: nothing but
      // `run_pattern` reaches a boundary that consults a label, so a captured
      // run of sandbox tools carries no `release` record at all.
      expect(CLEAN[at("AUD-21")]).toBe("fail");
    });

    it("passes once each admitting decision carries a release record", () => {
      // The direction that makes this a check rather than a constant: the
      // shape a fix produces, where each side effect's own decision states
      // what a boundary measured its flow against.
      turnsOnly("AUD-21", "pass", (root) => {
        const admitted = new Set(
          reportOf(root).toolActivity
            .filter((activity) =>
              activity.effectClass === "side-effect" &&
              activity.executionStatus === "completed"
            )
            .map((activity) => activity.toolCallId),
        );
        for (const decision of traceOf(root).decisions) {
          if (!admitted.has(decision.toolCallId)) continue;
          decision.release = {
            reasonCode: "cfc_release_allowed",
            boundary: "release",
            sink: "sandbox.command",
            ceiling: [],
          };
        }
      });
    });

    it("reports unreadable tool outputs rather than assuming every call produced a result", () => {
      // The absence-as-evidence case, in the check written to catch it. An
      // audit that cannot read which calls produced a result cannot say any
      // of them reached a boundary, and saying so is the honest verdict where
      // a fail would be a finding manufactured out of a missing artifact.
      turnsOnly("AUD-21", "inconclusive", (root) => {
        root.toolOutputs = {
          status: "absent",
          path: root.toolOutputs.path,
        };
      });
    });

    it("reports an unreadable output file rather than narrowing what it read", () => {
      // A file the loader could not parse says nothing about the call it
      // belongs to, so a directory listing one cannot answer which calls
      // produced a result. Reading the rest and calling that the answer is the
      // same silent narrowing an absent directory would be.
      turnsOnly("AUD-21", "inconclusive", (root) => {
        const outputs = root.toolOutputs;
        if (outputs.status !== "present") throw new Error("no outputs");
        delete (outputs.entries[0] as { value?: unknown }).value;
      });
    });

    it("skips an output entry that names no call", () => {
      // A file under `tool-outputs/` that parsed but carries no `outputId`
      // belongs to no call, so it says nothing about whether one produced a
      // result: AUD-21 drops it rather than reading it as a failed call, and
      // its verdict is unchanged. AUD-3 flags the same file, and correctly —
      // an output no activity accounts for is exactly what that check is for,
      // so the honest expectation names both rather than seeding around one.
      turnsInto({ "AUD-3": "fail", "AUD-21": "fail" }, (root) => {
        const outputs = root.toolOutputs;
        if (outputs.status !== "present") throw new Error("no outputs");
        (outputs.entries as unknown[]).push({
          fileName: "orphan.json",
          path: `${outputs.path}/orphan.json`,
          value: { status: "compile-error" },
        });
      });
    });

    it("still measures a failed call whose output records a boundary decision", () => {
      // `errorOutput` attaches the release decision when the boundary already
      // decided, so an exit below the fit still states what it decided. Such a
      // call reached the boundary and belongs in the measured set; dropping it
      // for having failed would hide a decision that was actually made.
      turnsOnly("AUD-21", "fail", (root) => {
        const outputs = root.toolOutputs;
        if (outputs.status !== "present") throw new Error("no outputs");
        for (const entry of outputs.entries) {
          const value = entry.value as
            | { outputId?: string; status?: string; releaseDecision?: unknown }
            | undefined;
          if (value?.outputId === undefined) continue;
          value.status = "error";
          value.releaseDecision = {
            reasonCode: "cfc_release_allowed",
            boundary: "release",
          };
        }
      });
    });

    it("reports a trace whose `withheld` count is present and not a number", () => {
      // Absent is legacy and reads as zero; present-and-malformed is neither,
      // and letting it read as absence would let a trace declare anything at
      // all and reconcile.
      turnsOnly("AUD-3", "fail", (root) => {
        const trace = traceOf(root) as unknown as {
          decisionCounts: Record<string, unknown>;
        };
        trace.decisionCounts.withheld = "two";
      });
    });

    it("does not count a call that produced no result as an ungated path", () => {
      // A call that failed before producing a value crossed no release
      // boundary, so its allow-side decision is the only one it can have.
      // Reading that absence as a missing gate reports a compile error as a
      // CFC defect — which is what this check did until it read the output.
      turnsOnly("AUD-21", "not-applicable", (root) => {
        const outputs = root.toolOutputs;
        if (outputs.status !== "present") {
          throw new Error("fixture records no tool outputs");
        }
        const failed = new Set<string>();
        for (const activity of reportOf(root).toolActivity) {
          if (
            activity.effectClass !== "side-effect" ||
            activity.executionStatus !== "completed"
          ) continue;
          const outputId = activity.resultRef?.outputId;
          if (outputId !== undefined) failed.add(outputId);
        }
        for (const entry of outputs.entries) {
          const value = entry.value as
            | { outputId?: string; status?: string }
            | undefined;
          if (value?.outputId !== undefined && failed.has(value.outputId)) {
            (value as { status?: string }).status = "compile-error";
          }
        }
      });
    });
  });

  describe("AUD-22 prompt-slot binding", () => {
    it("fails today, on a binding whose subject is not a principal", () => {
      // The CLI binds a workspace path or a resume-run id into the field
      // AH-CFC-3 reserves for an authenticated subject, and no mint site
      // populates a value digest.
      expect(CLEAN[at("AUD-22")]).toBe("fail");
    });

    it("passes a binding carrying a subject DID and a value digest", () => {
      turnsOnly("AUD-22", "pass", (root) => {
        const bind = (binding: Mutable<PromptSlotBinding> | undefined) => {
          if (binding === undefined) return;
          binding.subject = "did:key:z6MkseededPromptSubject";
          binding.valueDigest = "sha256:" + "a".repeat(64);
        };
        bind(stateOf(root).promptSlotBinding);
        for (const activity of reportOf(root).toolActivity) {
          bind(activity.promptSlot);
        }
        for (const decision of traceOf(root).decisions) {
          bind(decision.promptSlot);
        }
      });
    });

    it("has nothing to say about a run that minted no direct-command authority", () => {
      // AH-CFC-3 binds what direct-command authority must rest on, so a run
      // that minted none is outside the clause rather than failing it. The
      // distinction matters because `not-applicable` and `pass` are different
      // answers here: this run did not satisfy the obligation, it never
      // reached it.

      turnsOnly("AUD-22", "not-applicable", (root) => {
        const demote = (binding: Mutable<PromptSlotBinding> | undefined) => {
          if (binding === undefined) return;
          binding.role = "context";
        };
        demote(stateOf(root).promptSlotBinding);
        for (const activity of reportOf(root).toolActivity) {
          demote(activity.promptSlot);
        }
        for (const decision of traceOf(root).decisions) {
          demote(decision.promptSlot);
        }
        for (const context of stateOf(root).cfcInvocationContexts ?? []) {
          demote(context.promptSlot);
        }
        for (const context of traceOf(root).cfcInvocationContexts ?? []) {
          demote(context.promptSlot);
        }
      });
    });

    it("fails a binding carrying a digest but still no principal", () => {
      // The two halves are separately required, so a fix landing one of them
      // must not read as the obligation closing.
      turnsOnly("AUD-22", "fail", (root) => {
        const digest = (binding: Mutable<PromptSlotBinding> | undefined) => {
          if (binding === undefined) return;
          binding.valueDigest = "sha256:" + "b".repeat(64);
        };
        digest(stateOf(root).promptSlotBinding);
        for (const activity of reportOf(root).toolActivity) {
          digest(activity.promptSlot);
        }
        for (const decision of traceOf(root).decisions) {
          digest(decision.promptSlot);
        }
      });
    });
  });

  describe("AUD-23 delegation ceiling", () => {
    it("passes a delegation carrying the inherited owner view", () => {
      expect(CLEAN[at("AUD-23")]).toBe("pass");
    });

    it("still sees the delegation when the run state loses it", () => {
      // The union's point. `subagentRuns` is carried by both artifacts, and
      // reading only the run state would report a run that delegated as one
      // that did not — turning a known gap into `not-applicable`, which is a
      // silence that reads like a clean bill.

      expect(verdicts(seeded((root) => {
        delete stateOf(root).subagentRuns;
      }))).toEqual(CLEAN);
    });

    it("weakens a clean answer when the two artifacts disagree about children", () => {
      // Containment, not equality: an interrupted write leaves one artifact a
      // subset of the other and passes. Each holding a child the other lost is
      // divergence, and then "every delegation bound a ceiling" is not a claim
      // these artifacts support — so a ceiling on every child they still hold
      // warns rather than passes.

      turnsOnly("AUD-23", "warn", (root) => {
        const state = stateOf(root);
        const report = reportOf(root);
        for (const delegation of state.subagentRuns ?? []) {
          (delegation.manifest as unknown as Record<string, unknown>)
            .confidentialityCeiling = { source: "parent", mode: "owner-view" };
        }
        const orphan = structuredClone(report.subagentRuns![0]!);
        orphan.childRunId = `${FIXTURE_RUN_ID}.subagent.2`;
        (orphan.manifest as unknown as Record<string, unknown>)
          .confidentialityCeiling = { source: "parent", mode: "owner-view" };
        report.subagentRuns = [orphan];
      });
    });

    it("warns when a delegation loses its inherited ceiling", () => {
      turnsOnly("AUD-23", "warn", (root) => {
        for (const delegation of stateOf(root).subagentRuns ?? []) {
          delete (delegation.manifest as unknown as Record<string, unknown>)
            .confidentialityCeiling;
        }
        for (const delegation of reportOf(root).subagentRuns ?? []) {
          delete (delegation.manifest as unknown as Record<string, unknown>)
            .confidentialityCeiling;
        }
      });
    });
  });

  describe("AUD-24 cell-labels snapshot", () => {
    it("warns a run that recorded no cell-labels read and attempted none", () => {
      // And AUD-9 does not move, which is the point of the split. The
      // cell-labels snapshot is not among the six categories of evidence AH-CFC-16
      // enumerates, so a run missing it has not failed that clause.
      turnsOnly("AUD-24", "warn", (root) => {
        root.cellLabels = {
          status: "absent",
          path: root.cellLabels.path,
        };
        delete stateOf(root).cellLabels;
      });
    });

    it("fails an enforcing run whose attempted cell-labels read failed", () => {
      // A different fact from the one above, and the artifacts distinguish
      // them: this run held a ref, asked, and the answer is gone.
      turnsOnly("AUD-24", "fail", (root) => {
        root.cellLabels = {
          status: "absent",
          path: root.cellLabels.path,
        };
        const state = stateOf(root);
        delete state.cellLabels;
        state.failureRecords = [
          ...(state.failureRecords ?? []),
          {
            type: "cf-harness.failure-record",
            at: "2026-09-03T00:00:00.000Z",
            source: "cell_labels",
            kind: "unknown",
            detail: "the space refused the read",
          },
        ];
      });
    });

    it("passes a run holding the snapshot", () => {
      // The other direction: the fixture keeps one, and the check reaches it.
      expect(CLEAN[at("AUD-24")]).toBe("pass");
    });

    it("carries the issue on the finding it cannot decide", () => {
      // The open question is which of the two absences AH-CFC-16 should want.
      // Until that is settled the check reports the fact and names where the
      // question is being decided.
      const audited = auditRunFamily(
        seeded((root) => {
          root.cellLabels = { status: "absent", path: root.cellLabels.path };
          delete stateOf(root).cellLabels;
        }),
        RUN_CHECKS,
      );
      const finding = audited.find((result) =>
        result.checkId === "AUD-24" && result.runId === FIXTURE_RUN_ID
      );
      expect(finding?.knownDefect?.issue).toBe("CT-2210");
      expect(finding?.message).toContain(finding?.knownDefect?.detail);
    });
  });

  describe("AUD-25 labels across a followed link", () => {
    /** The family with a fabric session, and `cells` as its cell-labels read. */
    const withCellLabels = (
      cells: HarnessCellLabelRecord[],
      held: "both" | "state-only" = "both",
    ): RunFamily =>
      seeded((root) => {
        stateOf(root).fabricSessionCfc = structuredClone(
          CONFORMING_SESSION_POSTURE,
        ) as DeepMutable<HarnessFabricSessionCfcPosture>;
        const labels: HarnessCellLabels = {
          type: HARNESS_CELL_LABELS_TYPE,
          version: 1,
          generatedAt: "2026-09-07T00:00:00.000Z",
          status: "read",
          space: { configured: "seeded", dbPath: "/dev/null" },
          cells,
        };
        root.cellLabels = held === "both"
          ? { status: "present", path: root.cellLabels.path, value: labels }
          : { status: "absent", path: root.cellLabels.path };
        (stateOf(root) as Mutable<HarnessRunState>).cellLabels = labels;
      });

    /** A cell record carrying one labeled row behind the link at `result/0`. */
    const labeledRowEntry = () => ({
      path: ["result", "0", "subject"],
      origin: "declared",
      source: "of:fid1:seededRow",
      confidentiality: [{
        type: "https://commonfabric.org/cfc/atom/Resource",
        name: "Resource",
        fields: { class: "email" },
      }],
      integrity: [],
    });

    /** The link a result cell holds at `result/0`, as the reader reports one. */
    const linkEntry = () => ({
      path: ["result", "0"],
      origin: "link",
      confidentiality: [],
      integrity: [{
        type: "https://commonfabric.org/cfc/atom/LinkReference",
        name: "LinkReference",
      }],
    });

    it("is not applicable to a run that configured no fabric session", () => {
      // The fixture is that run: no session, so no pattern ran and no value
      // was derived from anything. Reported as a subject that does not arise
      // rather than as evidence nobody looked for.
      expect(CLEAN[at("AUD-25")]).toBe("not-applicable");
    });

    it("declines a snapshot that was never read, leaving it to AUD-24", () => {
      // A session ran, so the subject arises; the snapshot says the space was
      // not opened. What became of that read is AUD-24's finding, so this
      // check declines rather than putting a second finding on one fact —
      // and declines rather than reporting the cells as unlabeled, which is
      // the collapse the cell-labels contract forbids.
      expect(SESSION_CLEAN[at("AUD-25")]).toBe("not-applicable");
    });

    it("warns when every link a run's cells hold leads to no label", () => {
      // The shape a broken derivation leaves: the result cell still splits
      // each row into its own doc and links to it, and nothing came back on
      // the far side — with nothing in the snapshot saying the far side went
      // unread.
      expect(
        verdicts(withCellLabels([{
          entityId: "of:fid1:seededResult",
          entries: [linkEntry()],
        }])),
      ).toEqual({ ...SESSION_CLEAN, [at("AUD-25")]: "warn" });
    });

    it("passes when a label sits on a cell reached through a link", () => {
      // The derivation working, as the live Gmail probe records it: the
      // column's own label, on the row's own entity doc, reported under the
      // path that reached it and naming the doc it was read from.
      expect(
        verdicts(withCellLabels([{
          entityId: "of:fid1:seededResult",
          entries: [
            linkEntry(),
            {
              path: ["result", "0", "subject"],
              origin: "declared",
              source: "of:fid1:seededRow",
              confidentiality: [{
                type: "https://commonfabric.org/cfc/atom/Resource",
                name: "Resource",
                fields: { class: "email" },
              }],
              integrity: [{
                type:
                  "https://loom.commonfabric.org/cfc/atom/ConnectorObserved",
                name: "ConnectorObserved",
              }],
            },
          ],
        }])),
      ).toEqual({ ...SESSION_CLEAN, [at("AUD-25")]: "pass" });
    });

    it("does not count a label sitting outside the links it counted", () => {
      // The entry names a cell it was read from, so it crossed SOME link —
      // but not one of the links this record holds, so it is no evidence
      // about them. Counting it would let a label reached by an unrelated
      // path vouch for a result that carries none.
      expect(
        verdicts(withCellLabels([{
          entityId: "of:fid1:seededResult",
          entries: [
            linkEntry(),
            { ...labeledRowEntry(), path: ["elsewhere", "subject"] },
          ],
        }])),
      ).toEqual({ ...SESSION_CLEAN, [at("AUD-25")]: "warn" });
    });

    it("is not applicable to a snapshot that read cells holding no link", () => {
      // The snapshot reached this run's cells and none of them references
      // another, so no value here was derived across one. A positive reading
      // of the artifact, not an absence of evidence.
      expect(
        verdicts(withCellLabels([{
          entityId: "of:fid1:seededPlain",
          entries: [{
            path: ["total"],
            origin: "declared",
            confidentiality: [],
            integrity: [],
          }],
        }])),
      ).toEqual({ ...SESSION_CLEAN, [at("AUD-25")]: "not-applicable" });
    });

    it("reads the snapshot off the run state when the artifact is gone", () => {
      // A run records the snapshot in both places, so a tree that lost the
      // file still answers. AUD-24 moves too and is right to: what became of
      // the artifact is its subject, and this check's is what the snapshot
      // says.
      expect(
        verdicts(
          withCellLabels([{
            entityId: "of:fid1:seededResult",
            entries: [linkEntry(), labeledRowEntry()],
          }], "state-only"),
        ),
      ).toEqual({ ...SESSION_CLEAN, [at("AUD-25")]: "pass" });
    });

    it("cannot conclude anything when neither place holds a snapshot", () => {
      // Both the artifact and the run state's copy are gone, so there is no
      // snapshot to read at all — a different fact from one that was read and
      // holds nothing, and reported as the absence it is.
      expect(
        verdicts(seeded((root) => {
          stateOf(root).fabricSessionCfc = structuredClone(
            CONFORMING_SESSION_POSTURE,
          ) as DeepMutable<HarnessFabricSessionCfcPosture>;
          root.cellLabels = { status: "absent", path: root.cellLabels.path };
          delete stateOf(root).cellLabels;
        })),
      ).toEqual({
        ...SESSION_CLEAN,
        [at("AUD-24")]: "warn",
        [at("AUD-25")]: "inconclusive",
      });
    });

    it("cannot conclude anything when the reader ran out of nodes", () => {
      // The other half of "the reader stopped": a truncation names no path,
      // so the links it left behind are accounted for by the whole-record
      // reason rather than by an entry for each.
      expect(
        verdicts(withCellLabels([{
          entityId: "of:fid1:seededResult",
          entries: [linkEntry()],
          truncationReason: "node-budget-exhausted",
        }])),
      ).toEqual({ ...SESSION_CLEAN, [at("AUD-25")]: "inconclusive" });
    });

    it("names no detail for an unavailable snapshot that carries none", () => {
      // `unavailableDetail` and `unavailableReason` are both optional. A
      // snapshot carrying neither still names which status it was, in the
      // message and in the evidence, rather than a dangling separator and an
      // empty detail.
      const audited = auditRunFamily(
        seeded((root) => {
          stateOf(root).fabricSessionCfc = structuredClone(
            CONFORMING_SESSION_POSTURE,
          ) as DeepMutable<HarnessFabricSessionCfcPosture>;
          const bare = {
            ...(stateOf(root).cellLabels as HarnessCellLabels),
          } as Mutable<HarnessCellLabels>;
          delete bare.unavailableDetail;
          delete bare.unavailableReason;
          root.cellLabels = {
            status: "present",
            path: root.cellLabels.path,
            value: bare as HarnessCellLabels,
          };
          (stateOf(root) as Mutable<HarnessRunState>).cellLabels =
            bare as HarnessCellLabels;
        }),
        RUN_CHECKS,
      );
      const finding = audited.find((result) =>
        result.checkId === "AUD-25" && result.runId === FIXTURE_RUN_ID
      );
      expect(finding?.verdict).toBe("not-applicable");
      expect(finding?.message).toContain("`unavailable`");
      expect(finding?.message).not.toContain("(");
      expect(finding?.evidence[0]?.detail).toBe("unavailable");
    });

    it("cannot conclude anything when the reader stopped at every link", () => {
      // The same bare far side, with the snapshot saying why: the walk ran
      // out of hops. Nothing was established, which is not the same finding
      // as a link that led somewhere and found nothing.
      expect(
        verdicts(withCellLabels([{
          entityId: "of:fid1:seededResult",
          entries: [linkEntry()],
          unreadPaths: [{ path: ["result", "0"], reason: "beyond-link-hops" }],
        }])),
      ).toEqual({ ...SESSION_CLEAN, [at("AUD-25")]: "inconclusive" });
    });
  });

  describe("AUD-13 conforming matrix point", () => {
    it("fails a strict run whose flow labels are not persisted", () => {
      sessionTurnsOnly("AUD-13", "fail", (posture) => {
        posture.record!.enforcementMode.rung = "enforce-strict";
        posture.record!.flowLabels.rung = "off";
      });
    });

    it("warns a run whose policy evaluation only observes", () => {
      sessionTurnsOnly("AUD-13", "warn", (posture) => {
        posture.record!.policyEvaluation.rung = "observe";
      });
    });
  });

  describe("AUD-14 ungated sink coverage", () => {
    it("fails a record that publishes no deviation while a sink is ungated", () => {
      sessionTurnsOnly("AUD-14", "fail", (posture) => {
        posture.record!.deviations = [];
      });
    });

    it("retires once every known sink carries a ceiling", () => {
      sessionTurnsOnly("AUD-14", "not-applicable", (posture) => {
        posture.record!.sinks = posture.record!.sinks.map((sink) => ({
          sink: sink.sink,
          ceiling: [],
        }));
      });
    });
  });

  describe("AUD-15a default-sourced dial drift", () => {
    it("fails a default-sourced flow dial under a max-enforcement claim", () => {
      sessionTurnsOnly("AUD-15a", "fail", (posture) => {
        posture.flowLabels = "off";
        posture.flowLabelsSource = "default";
      });
    });
  });

  describe("AUD-9 evidence retention", () => {
    it("fails an enforcing run whose policy trace is gone", () => {
      turnsOnly("AUD-9", "fail", (root) => {
        root.policyTrace = { status: "absent", path: root.policyTrace.path };
      });
    });

    it("warns a run whose side effects recorded no invocation context", () => {
      // The two warns are one run read against two clauses: AUD-2 says the
      // enforcing claim went untested, and this says retention cannot be
      // confirmed, because a tree holding no context reads the same whether
      // the effects ran host-side or the evidence was lost.

      expect(verdicts(seeded((root) => {
        dropInvocationContexts(root, () => true);
      }))).toEqual({
        ...CLEAN,
        [at("AUD-2")]: "warn",
        [at("AUD-9")]: "warn",
      });
    });

    it("fails a run where one tool lost every context it recorded", () => {
      // The blind spot this witness exists for. Which tools transport CFC
      // evidence is read off the contexts that survived, so a tool whose
      // contexts ALL vanished leaves that set and its calls read as
      // host-side — a run that never went near the substrate rather than one
      // whose evidence went missing. A surviving context for another tool is
      // what hides it: the run holds contexts, so the warning for a run that
      // holds none does not fire either.
      //
      // The numbering is what still says so. `bash` was numbered 1 and 2, and
      // a run retaining only 3 is missing two contexts it minted.

      expect(verdicts(seeded((root) => {
        seedInvocationContext(root, {
          sequence: 3,
          toolId: "web_fetch",
          toolOutputId: createToolOutputId(FIXTURE_RUN_ID, "web_fetch", 3),
        });
        dropInvocationContexts(root, (context) => context.toolId === "bash");
      }))).toEqual({
        ...CLEAN,
        [at("AUD-9")]: "fail",
      });
    });

    it("fails two artifacts that each lost a context the other kept", () => {
      // The union's own blind spot. Read together, `[1]` and `[2]` union back
      // to a complete sequence and nothing looks lost; read either alone, a
      // context is missing. Containment is what tells this from an
      // interrupted write, where the trace is a subset of the live record.

      turnsOnly("AUD-9", "fail", (root) => {
        const trace = traceOf(root);
        trace.cfcInvocationContexts = (trace.cfcInvocationContexts ?? [])
          .filter((context) => context.sequence !== 2);
        const state = stateOf(root);
        state.cfcInvocationContexts = (state.cfcInvocationContexts ?? [])
          .filter((context) => context.sequence !== 1);
      });
    });

    it("recovers a context dropped from one artifact and left in the other", () => {
      // Two artifacts carry the list, and the reader takes their union, so
      // deleting a copy from one of them recovers rather than hides. Reading
      // the first artifact that answered would have made this a run that
      // minted one context, and the call the deleted one explained would have
      // read as evidence gone missing.

      expect(verdicts(seeded((root) => {
        const trace = traceOf(root);
        trace.cfcInvocationContexts = (trace.cfcInvocationContexts ?? [])
          .filter((context) => context.sequence !== 1);
      }))).toEqual(CLEAN);
    });

    it("passes a run holding every context it minted, in both artifacts", () => {
      // The other direction: the same shape with nothing removed is the
      // fixed shape, and the check has to be able to reach it.
      expect(CLEAN[at("AUD-9")]).toBe("pass");
    });
  });

  describe("AUD-20 omission accounting", () => {
    it("is inconclusive when the run predates omission records", () => {
      turnsOnly("AUD-20", "inconclusive", (root) => {
        root.transcriptOmissions = {
          status: "absent",
          path: root.transcriptOmissions.path,
        };
      });
    });
  });
});
