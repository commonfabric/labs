/**
 * The Group C checks: what the posture a run recorded says about itself.
 *
 * Group A reads what a run did. These read what it declared it was doing —
 * the fabric-session dial tuple, the posture record those dials resolve to,
 * and where each value came from. A posture is a claim, and a claim is worth
 * checking against two things: the matrix, which says which claims are
 * coherent, and the record's own contents, which say whether the claim covers
 * what it appears to cover.
 *
 * These checks WARN and FAIL on a recording; they do not stop a run. The
 * runtime does not yet refuse a non-conforming tuple at construction time
 * (CT-2179), so what an audit can say about one is that it was recorded.
 *
 * What a recorded posture IS, is the other thing to hold on to. The harness
 * writes its record before the session's runtime exists, so the record is a
 * projection — what the run expected to be at — and it says so
 * (`provenance`); a delegated child, which runs on the session its parent
 * built, carries that parent's record and says that instead. A finding here
 * therefore reports on a declaration, and every message says which it read: a
 * projected record establishes nothing about what a runtime honored, and an
 * audit that let one read as an attestation would be the very confusion it
 * exists to catch.
 */

import type {
  CfcPostureProvenance,
  CfcPostureReport,
} from "@commonfabric/runner/cfc";
import type { MAX_ENFORCEMENT_CFC_OPTIONS } from "@commonfabric/runner";

import type { HarnessCfcPolicySnapshot } from "../../src/contracts/cfc-policy-snapshot.ts";
import type { HarnessFabricSessionCfcPosture } from "../../src/run-state.ts";
import { cfcEnforcementStrictness } from "@commonfabric/runner/cfc";

import { extendsClause, requiredBy } from "../citations.ts";
import type { RunEvidence } from "../evidence.ts";
import {
  conformingPointOf,
  type MatrixDialTuple,
  matrixViolations,
} from "../matrix.ts";
import type { CheckEvidence } from "../report.ts";
import type { AuditCheck, CheckOutcome } from "./structural.ts";

/** The fabric-session posture a run recorded, where it recorded one. */
const fabricPostureOf = (
  run: RunEvidence,
): HarnessFabricSessionCfcPosture | undefined =>
  run.runState.status === "present"
    ? run.runState.value.fabricSessionCfc
    : undefined;

const policySnapshotOf = (
  run: RunEvidence,
): HarnessCfcPolicySnapshot | undefined =>
  run.policySnapshot.status === "present"
    ? run.policySnapshot.value
    : run.runState.status === "present"
    ? run.runState.value.cfcPolicySnapshot
    : undefined;

/**
 * The outcome for a check whose subject is a fabric session, on a run that
 * had none.
 *
 * `not-applicable` rather than `inconclusive`: the run state loaded and said
 * this run ran no fabric session, so there is no posture to be uncertain
 * about. A run whose state did not load is the other case, and says so.
 */
const noFabricSession = (run: RunEvidence): CheckOutcome =>
  run.runState.status === "present"
    ? {
      verdict: "not-applicable",
      message:
        "this run recorded no fabric session, so it declared no session posture",
      evidence: [{
        artifact: "run-state.json",
        pointer: "fabricSessionCfc",
        detail: "absent",
      }],
    }
    : {
      verdict: "inconclusive",
      message:
        "`run-state.json` did not load, so nothing about the session posture was established",
      evidence: [{
        artifact: "run-state.json",
        detail: run.runState.status,
      }],
    };

/**
 * The dial tuple a recorded posture resolves to.
 *
 * Every value comes from the posture record, which is where the session's
 * dials, the named bundle it opted into, and the runtime's own defaults have
 * all been resolved into one answer. The two itemized fields beside it say
 * which dials an operator set and where each came from, which is a different
 * question — and one AUD-15 asks.
 */
const tupleOf = (
  posture: HarnessFabricSessionCfcPosture,
): MatrixDialTuple | undefined => {
  const record = posture.record;
  if (record === undefined) return undefined;
  return {
    enforcementMode: record.enforcementMode
      .rung as MatrixDialTuple["enforcementMode"],
    flowLabels: record.flowLabels.rung as MatrixDialTuple["flowLabels"],
    writeFloor: record.writeFloor.rung as MatrixDialTuple["writeFloor"],
    triggerReadGating: record.triggerReadGating,
    policyEvaluation: record.policyEvaluation
      .rung as MatrixDialTuple["policyEvaluation"],
  };
};

/**
 * How the finding names what it read.
 *
 * A projected record is the run's claim about a runtime that had not been
 * constructed when the claim was written; a resolved one is a reading of a
 * runtime that had; an inherited one is the record of the run whose session
 * this one shares, and establishes what that run's record establishes. The
 * words go in every message rather than in a footnote, because a reader
 * acting on the finding is deciding what the run establishes.
 */
const READ_AS: Record<CfcPostureProvenance, string> = {
  projected:
    "recorded posture (projected before the session runtime was constructed)",
  inherited:
    "inherited posture (the record of the run whose fabric session this run shares)",
  resolved: "resolved posture",
};

/** How a finding names the record it read. */
const readAs = (record: CfcPostureReport): string => READ_AS[record.provenance];

const renderTuple = (tuple: MatrixDialTuple): string =>
  `${tuple.enforcementMode} / flow ${tuple.flowLabels} / floor ${tuple.writeFloor} / trigger ${tuple.triggerReadGating} / policy ${tuple.policyEvaluation}`;

//
// AUD-13 conforming point
//

const conformingPoint: AuditCheck = {
  id: "AUD-13",
  title: "conforming matrix point",
  // The matrix states which dial combinations are conforming and which a
  // deploy-check should reject, so these clauses state what AUD-13 enforces.
  citations: requiredBy(
    "MATRIX-conforming",
    "MATRIX-strict-persist",
    "MATRIX-persist-pointless",
    "MATRIX-floor-credits-nothing",
    "MATRIX-trigger-one-hop",
    "AH-CFC-modes-observe",
  ),
  falsifiedBy:
    "a recorded fabric-session dial tuple that advances a consuming enforcement ahead of the dial it consumes — `enforce-strict` without persisted flow labels fails; a write floor, trigger gating, or policy evaluation whose rung is sound but credits nothing at this flow setting warns, as does persisting labels under a disabled mode",
  inspect(run) {
    const posture = fabricPostureOf(run);
    if (posture === undefined) {
      return noFabricSession(run);
    }
    const tuple = tupleOf(posture);
    if (tuple === undefined) {
      return {
        verdict: "inconclusive",
        message:
          "this run's fabric-session posture predates the full posture record, so three of the five dials it turns on are not recorded",
        evidence: [{
          artifact: "run-state.json",
          pointer: "fabricSessionCfc.record",
          detail: "absent",
        }],
      };
    }
    const violations = matrixViolations(tuple);
    const evidence: readonly CheckEvidence[] = violations.map((rule) => ({
      artifact: "run-state.json",
      pointer: "fabricSessionCfc",
      detail: `${rule.id}: ${rule.statement}`,
    }));
    if (violations.length === 0) {
      const point = conformingPointOf(tuple);
      return {
        verdict: "pass",
        message: `this run's dials (${
          renderTuple(tuple)
        }) violate no ordering rule${
          point === undefined ? "" : `, at the matrix's \`${point.name}\` state`
        }`,
      };
    }
    return {
      verdict: violations.some((rule) => rule.verdict === "fail")
        ? "fail"
        : "warn",
      message: `this run's ${readAs(posture.record!)} (${
        renderTuple(tuple)
      }) violates ${violations.map((rule) => `\`${rule.id}\``).join(", ")}`,
      evidence,
    };
  },
};

//
// AUD-14 llm-sink gap
//

/** Every sink of a record that carries no ceiling, with the recorded reason. */
const ungatedSinks = (
  posture: HarnessFabricSessionCfcPosture,
): readonly { sink: string; reason: string }[] =>
  (posture.record?.sinks ?? [])
    .flatMap((sink) =>
      "ungated" in sink ? [{ sink: sink.sink, reason: sink.ungated }] : []
    );

const llmSinkGap: AuditCheck = {
  id: "AUD-14",
  title: "ungated sink coverage",
  // OURS, not the specification's: no clause requires that a sink releasing
  // without a ceiling be published as a deviation. These are the clauses whose
  // purpose it serves — a posture that is readable, and an enforcing claim that
  // does not quietly fall short of itself.
  citations: extendsClause("AH-CFC-15", "AH-CFC-14"),
  falsifiedBy:
    "a posture record that publishes no deviation while listing a sink that releases with no confidentiality ceiling — a claim of coverage the record's own sink list contradicts",
  inspect(run) {
    const posture = fabricPostureOf(run);
    if (posture === undefined) {
      return noFabricSession(run);
    }
    if (posture.posture !== "max-enforcement") {
      return {
        verdict: "not-applicable",
        message:
          "this run claims no named enforcement posture, so it claims no sink coverage to fall short of",
        evidence: [{
          artifact: "run-state.json",
          pointer: "fabricSessionCfc.posture",
          detail: posture.posture ?? "absent",
        }],
      };
    }
    const record = posture.record;
    if (record === undefined) {
      return {
        verdict: "inconclusive",
        message:
          "this run claims the max-enforcement posture but recorded no posture record, so which sinks it governs is not established",
        evidence: [{
          artifact: "run-state.json",
          pointer: "fabricSessionCfc.record",
          detail: "absent",
        }],
      };
    }
    const ungated = ungatedSinks(posture);
    if (ungated.length === 0) {
      // The retirement condition, reached: every known sink carries a ceiling,
      // so there is no gap left for this check to name.
      return {
        verdict: "not-applicable",
        message:
          "every known sink carries a confidentiality ceiling under this run's posture",
      };
    }
    const evidence: readonly CheckEvidence[] = ungated.map((entry) => ({
      artifact: "run-state.json",
      pointer: `fabricSessionCfc.record.sinks[${entry.sink}]`,
      detail: entry.reason,
    }));
    if (record.deviations.length === 0) {
      return {
        verdict: "fail",
        message: `this run's ${readAs(record)} publishes no deviation while ${
          ungated.map((entry) => `\`${entry.sink}\``).join(", ")
        } release with no ceiling, so the record claims a coverage its own sink list contradicts`,
        evidence,
      };
    }
    return {
      verdict: "warn",
      message: `under the max-enforcement posture this run's ${
        readAs(record)
      } leaves ${
        ungated.map((entry) => `\`${entry.sink}\``).join(", ")
      } releasing with no confidentiality ceiling and therefore no gate`,
      evidence,
    };
  },
};

//
// AUD-15 default-sourced enforcement mode, AUD-15a default-sourced dial drift
//
// Two checks rather than one, because they are two properties with two
// authorities. A run whose enforcement MODE resolved from a default to
// something weaker than it claims has silently fallen back from an enforcing
// mode, which AH-CFC-15 states in those words. A run whose flow-label dial did
// the same has done something no clause names — worth catching, and ours. One
// check reporting both would lend the clause's authority to the half it does
// not cover.
//

const defaultModeDrift: AuditCheck = {
  id: "AUD-15",
  title: "default-sourced enforcement mode",
  citations: requiredBy("AH-CFC-15"),
  falsifiedBy:
    "a policy snapshot whose enforcement mode came from a default and is weaker than the mode the run's session claims",
  inspect(run) {
    const posture = fabricPostureOf(run);
    if (posture === undefined) {
      return noFabricSession(run);
    }
    const snapshot = policySnapshotOf(run);
    if (snapshot === undefined) {
      return {
        verdict: "inconclusive",
        message:
          "`policy-snapshot.json` is absent, so where this run's enforcement mode came from is not established",
        evidence: [{ artifact: "policy-snapshot.json", detail: "absent" }],
      };
    }
    if (snapshot.cfc.enforcementModeSource !== "default") {
      return {
        verdict: "not-applicable",
        message:
          `this run's enforcement mode came from \`${snapshot.cfc.enforcementModeSource}\`, not from a default`,
        evidence: [{
          artifact: "policy-snapshot.json",
          pointer: "cfc.enforcementModeSource",
          detail: snapshot.cfc.enforcementModeSource ?? "absent",
        }],
      };
    }
    const claimed = cfcEnforcementStrictness(posture.enforcementMode);
    const resolved = cfcEnforcementStrictness(snapshot.cfc.enforcementMode);
    if (resolved >= claimed) {
      return {
        verdict: "pass",
        message:
          `this run's enforcement mode came from a default and landed at \`${snapshot.cfc.enforcementMode}\`, no weaker than the \`${posture.enforcementMode}\` its session claims`,
      };
    }
    return {
      verdict: "fail",
      message:
        `this run's enforcement mode came from a default and landed at \`${snapshot.cfc.enforcementMode}\`, weaker than the \`${posture.enforcementMode}\` its session claims`,
      evidence: [{
        artifact: "policy-snapshot.json",
        pointer: "cfc.enforcementModeSource",
        detail:
          `default-sourced \`${snapshot.cfc.enforcementMode}\` under a \`${posture.enforcementMode}\` claim`,
      }],
    };
  },
};

/**
 * The flow-label rung a run claiming the max-enforcement bundle is held to.
 *
 * A record carries the rung the run resolved and the name of the bundle it
 * claimed, never the rung that bundle asserted, so the audit carries the
 * second one. This rung moves when this line is edited and at no other time,
 * which is what keeps a verdict on an already-recorded artifact from turning
 * over as the runner's bundle moves.
 *
 * The pin is what makes moving it a decision. It reads no value out of the
 * runner: `satisfies` fails `deno check` when the bundle sets a different
 * rung or stops setting one, so the move surfaces where it is made rather
 * than as an audit that quietly grades the corpus by a new rule.
 *
 * `persist` is the strongest rung of `CfcFlowLabelsMode`, which is what makes
 * the inequality below read as `falsifiedBy` states it — weaker than the
 * bundle asserts, rather than merely different from it.
 */
const EXPECTED_MAX_ENFORCEMENT_FLOW_LABELS =
  "persist" satisfies typeof MAX_ENFORCEMENT_CFC_OPTIONS["cfcFlowLabels"];

const defaultDialDrift: AuditCheck = {
  id: "AUD-15a",
  title: "default-sourced dial drift",
  // OURS: no clause names the flow-label dial or what a named posture bundle
  // asserts about it. These are the clauses whose purpose it serves.
  citations: extendsClause("AH-CFC-14", "AH-CFC-15"),
  falsifiedBy:
    "a flow-label dial the run resolved from a default, landing weaker than the named posture bundle the run claims asserts",
  inspect(run) {
    const posture = fabricPostureOf(run);
    if (posture === undefined) {
      return noFabricSession(run);
    }
    if (posture.posture !== "max-enforcement") {
      return {
        verdict: "not-applicable",
        message:
          "this run claims no named posture bundle, so no dial of it can have defaulted away from one",
        evidence: [{
          artifact: "run-state.json",
          pointer: "fabricSessionCfc.posture",
          detail: posture.posture ?? "absent",
        }],
      };
    }
    if (
      posture.flowLabelsSource === "default" &&
      posture.flowLabels !== EXPECTED_MAX_ENFORCEMENT_FLOW_LABELS
    ) {
      return {
        verdict: "fail",
        message:
          `this run's flow-label dial came from a default and landed at \`${posture.flowLabels}\`, while the max-enforcement bundle it claims asserts \`${EXPECTED_MAX_ENFORCEMENT_FLOW_LABELS}\``,
        evidence: [{
          artifact: "run-state.json",
          pointer: "fabricSessionCfc.flowLabelsSource",
          detail: `default-sourced \`${posture.flowLabels}\``,
        }],
      };
    }
    return {
      verdict: "pass",
      message:
        `this run's flow-label dial came from \`${posture.flowLabelsSource}\` and lands at \`${posture.flowLabels}\`, which the bundle it claims asserts`,
    };
  },
};

/** Every Group C check, in id order. */
export const POSTURE_CHECKS: readonly AuditCheck[] = [
  conformingPoint,
  llmSinkGap,
  defaultModeDrift,
  defaultDialDrift,
];
