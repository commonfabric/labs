/**
 * The deployment mode matrix as data: which points of the CFC dial cube are
 * conforming, and which advances of one dial ahead of another the spec's
 * partial order forbids or weakens.
 *
 * `docs/specs/cfc-enforcement-matrix.md` states these as prose and a table.
 * A check that restated them in its own words would be independent state, so
 * each rule here carries the citation whose words it turns on, and the
 * citation-drift test reads them back out of the document. A rule reworded
 * past its quote breaks there, which is the notice that the rule needs
 * rewriting too.
 *
 * The rules are one-sided on purpose. Each says what a tuple must NOT be, and
 * a tuple violating none of them is conforming — the same shape the spec's own
 * "everything else is free" paragraph has, and the shape that keeps a new
 * dial from silently widening what counts as conforming.
 */

import type {
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  CfcPolicyEvaluationMode,
  CfcWriteFloorMode,
} from "@commonfabric/runner/cfc";

import { type SpecCitationKey } from "./citations.ts";

/** A point of the dial cube, as a deployment sits at it. */
export interface MatrixDialTuple {
  enforcementMode: CfcEnforcementMode;
  flowLabels: CfcFlowLabelsMode;
  writeFloor: CfcWriteFloorMode;
  triggerReadGating: boolean;
  policyEvaluation: CfcPolicyEvaluationMode;
}

/**
 * One conforming state the matrix's table names, as a deployment is expected
 * to pass through it.
 *
 * `policyEvaluation` is absent from the table's columns — it advances on its
 * own schedule alongside whichever state a deployment is in — so a point
 * names the four dials the table names and no more.
 */
export interface ConformingPoint {
  name: string;
  enforcementMode: CfcEnforcementMode;
  flowLabels: CfcFlowLabelsMode;
  writeFloor: CfcWriteFloorMode;
  triggerReadGating: boolean;
}

/** The states the matrix's table names, in the order it names them. */
export const CONFORMING_POINTS: readonly ConformingPoint[] = [
  {
    name: "Operator (explicitly disabled)",
    enforcementMode: "disabled",
    flowLabels: "off",
    writeFloor: "off",
    triggerReadGating: false,
  },
  {
    name: "Server hosts today",
    enforcementMode: "enforce-explicit",
    flowLabels: "off",
    writeFloor: "off",
    triggerReadGating: false,
  },
  {
    name: "Shell today",
    enforcementMode: "enforce-explicit",
    flowLabels: "persist",
    writeFloor: "off",
    triggerReadGating: false,
  },
  {
    name: "Shell + floor observe",
    enforcementMode: "enforce-explicit",
    flowLabels: "persist",
    writeFloor: "observe",
    triggerReadGating: false,
  },
  {
    name: "Shell + floor enforce",
    enforcementMode: "enforce-explicit",
    flowLabels: "persist",
    writeFloor: "enforce",
    triggerReadGating: false,
  },
  {
    name: "Strict",
    enforcementMode: "enforce-strict",
    flowLabels: "persist",
    writeFloor: "enforce",
    triggerReadGating: true,
  },
];

/**
 * One rule of the partial order.
 *
 * `verdict` is the rule's own weight, which is the spec's: a consuming
 * enforcement running ahead of the dial it consumes is unsound and fails,
 * while a dial that is sound anywhere but incomplete until flow persists —
 * and a dial that is permitted but pointless — warns.
 */
export interface MatrixRule {
  /** Stable id, cited in a finding beside the check's own. */
  id: string;

  citation: SpecCitationKey;

  verdict: "fail" | "warn";

  /** What is wrong with a tuple that violates this rule. */
  statement: string;

  /** Whether `tuple` violates the rule. */
  violatedBy(tuple: MatrixDialTuple): boolean;
}

/** Every rule of the partial order, in the order the spec states them. */
export const MATRIX_RULES: readonly MatrixRule[] = [
  {
    id: "MX-strict-persist",
    citation: "MATRIX-strict-persist",
    verdict: "fail",
    statement:
      "`enforce-strict` consumes derived labels, so it is unsound without `cfcFlowLabels: persist` producing them",
    violatedBy: (tuple) =>
      tuple.enforcementMode === "enforce-strict" &&
      tuple.flowLabels !== "persist",
  },
  {
    id: "MX-floor-credits-nothing",
    citation: "MATRIX-floor-credits-nothing",
    verdict: "warn",
    statement:
      "`cfcWriteFloor: enforce` is sound at any flow setting but credits nothing until flow persists, so it over-rejects a legitimately flow-endorsed write",
    violatedBy: (tuple) =>
      tuple.writeFloor === "enforce" && tuple.flowLabels !== "persist",
  },
  {
    id: "MX-trigger-one-hop",
    citation: "MATRIX-trigger-one-hop",
    verdict: "warn",
    statement:
      "`cfcTriggerReadGating` closes only the direct trigger channel until flow persists; a handler evades it through an unlabeled intermediary",
    violatedBy: (tuple) =>
      tuple.triggerReadGating && tuple.flowLabels !== "persist",
  },
  {
    id: "MX-policy-observe",
    // The matrix calls `observe` the honest dial-up step and sound at any
    // state, so it is NOT the clause that makes this a finding. What makes it
    // one is the enforcement-mode section's rule about diagnostic rungs: the
    // dial is loaded and decides nothing, and a posture reported without that
    // said reads as enforcement. The warn is about how the rung is read, not
    // about the deployment being wrong to sit at it.
    citation: "AH-CFC-modes-observe",
    verdict: "warn",
    statement:
      "`cfcPolicyEvaluation: observe` diagnoses the rewrite and decides on the un-rewritten label, so this rung must not be read as enforcement",
    violatedBy: (tuple) => tuple.policyEvaluation === "observe",
  },
  {
    id: "MX-persist-pointless",
    citation: "MATRIX-persist-pointless",
    verdict: "warn",
    statement:
      "`cfcFlowLabels: persist` under `cfcEnforcementMode: disabled` writes labels nothing ever consults",
    violatedBy: (tuple) =>
      tuple.flowLabels === "persist" && tuple.enforcementMode === "disabled",
  },
];

/** Every rule `tuple` violates, in rule order. */
export const matrixViolations = (
  tuple: MatrixDialTuple,
): readonly MatrixRule[] =>
  MATRIX_RULES.filter((rule) => rule.violatedBy(tuple));

/** The named conforming point `tuple` sits at, where it sits at one. */
export const conformingPointOf = (
  tuple: MatrixDialTuple,
): ConformingPoint | undefined =>
  CONFORMING_POINTS.find((point) =>
    point.enforcementMode === tuple.enforcementMode &&
    point.flowLabels === tuple.flowLabels &&
    point.writeFloor === tuple.writeFloor &&
    point.triggerReadGating === tuple.triggerReadGating
  );
