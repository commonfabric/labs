/**
 * What a confidentiality boundary refused, and what the boundary decided.
 *
 * Two shapes live here. {@link HarnessPolicyRefusal} is the runner's
 * `CfcRefusalDetail` folded into the terms a caller can act on: the gate, the
 * sinks, the offending atoms, and the keys of the caller's own inputs that
 * carried them in. {@link HarnessReleaseDecision} is what a boundary decided
 * about one tool result, refusal or not, which is what a policy-trace decision
 * carries when a label rather than an authority decided the outcome.
 *
 * They sit in `contracts/` rather than in the tool that mints them because
 * they are one representation with two readers: the tool that measured the
 * boundary writes them onto its output, and the prompt loop appends them to
 * `policy-trace.json` as decisions. A release site the runner comes to own
 * — the model-context sink resolver — writes the same two shapes.
 */

import type { JSONSchema } from "@commonfabric/api";
import type {
  CfcRefusalAttribution,
  CfcRefusalGate,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * What a boundary refused, in terms the caller can act on: the boundary that
 * refused, the label atoms outside it, and the keys of the call's own
 * `inputs` that carried those atoms in. When `attribution` is `complete`, a
 * run without those keys meets the boundary.
 *
 * Everything here reaches the model as it stands wherever a tool returns it —
 * a model-facing rendering scrubs free text and passes a structured field
 * through untouched. So nothing here is a document id, a space, or a path
 * into a document: an offending read that no input key accounts for is
 * counted rather than named.
 */
export interface HarnessPolicyRefusal {
  /**
   * The rules that refused, deduplicated. `sink-ceiling` is an egress whose
   * confidentiality ceiling the flow exceeded; `writer-fit` is a write whose
   * target does not admit what the write carries.
   */
  gates: readonly CfcRefusalGate[];

  /**
   * The sinks whose ceilings refused, deduplicated. Empty when what refused
   * was a write rather than an egress.
   */
  sinks: readonly string[];

  /**
   * The label atoms outside what the boundary admits, rendered as the
   * boundary renders them.
   */
  offendingAtoms: readonly string[];

  /**
   * Offending atoms left out of `offendingAtoms`. A structured atom can
   * carry the principal that introduced it, and there is no seam that
   * redacts a rendered atom, so it is counted rather than named.
   */
  withheldAtomCount?: number;

  /**
   * The keys of the call's own `inputs` whose values carried the offending
   * atoms in — the inputs to drop and retry without.
   */
  inputKeys: readonly string[];

  /**
   * Offending reads that no key of the call's `inputs` accounts for, counted
   * by document.
   */
  unattributedInputCount?: number;

  /**
   * Whether `inputKeys` is the whole remedy. `complete` — every offending
   * atom came in through them, so a run without them proceeds. `partial` —
   * dropping them narrows the flow without necessarily clearing it. `none` —
   * nothing was attributed to an input of this call.
   */
  attribution: CfcRefusalAttribution;
}

/** {@link HarnessPolicyRefusal}, as a tool's output schema states it. */
export const HARNESS_POLICY_REFUSAL_SCHEMA = {
  type: "object",
  properties: {
    gates: {
      type: "array",
      items: { type: "string", enum: ["sink-ceiling", "writer-fit"] },
    },
    sinks: { type: "array", items: { type: "string" } },
    offendingAtoms: { type: "array", items: { type: "string" } },
    withheldAtomCount: { type: "integer", minimum: 0 },
    inputKeys: { type: "array", items: { type: "string" } },
    unattributedInputCount: { type: "integer", minimum: 0 },
    attribution: {
      type: "string",
      enum: ["complete", "partial", "none"],
    },
  },
  required: [
    "gates",
    "sinks",
    "offendingAtoms",
    "inputKeys",
    "attribution",
  ],
  additionalProperties: false,
} satisfies JSONSchema;

/**
 * Which boundary decided, which decides what became of the result: a refused
 * commit landed no result, while a refused release has one, in the space
 * under its own labels, whose reference the caller holds with the values
 * withheld.
 */
export type HarnessReleaseBoundary = "commit" | "release";

/** The boundaries, as values, so a record read back off disk can be checked. */
export const HARNESS_RELEASE_BOUNDARIES: readonly HarnessReleaseBoundary[] = [
  "commit",
  "release",
];

/**
 * What a boundary decided about one tool result.
 *
 * The four members are the whole of what a release boundary can decide, and
 * each names its own decision — see {@link harnessReleaseDecisionOutcome}.
 * `released` and `observed` are the two non-rejecting ones: the values went
 * out either way, and `observed` says a measurement found something the
 * enforcement ladder was not turned up far enough to act on, which is what
 * lets an observe-stage rollout size what raising it would withhold.
 */
export type HarnessReleaseDecisionReasonCode =
  | "cfc_release_allowed"
  | "cfc_release_observed"
  | "cfc_release_withheld"
  | "cfc_commit_refused";

/**
 * The reason codes, as values, so a record read back off disk can be checked
 * against the union rather than asserted into it.
 */
export const HARNESS_RELEASE_DECISION_REASON_CODES:
  readonly HarnessReleaseDecisionReasonCode[] = [
    "cfc_release_allowed",
    "cfc_release_observed",
    "cfc_release_withheld",
    "cfc_commit_refused",
  ];

/**
 * What a boundary decided about one tool result, refusal or not.
 *
 * The tool that measured the boundary writes this onto its output, where the
 * model-facing rendering strips it; the prompt loop reads it back off the
 * persisted output and appends it to the run's policy trace as a decision,
 * beside the tool-result reference that names the artifact it belongs to.
 */
export interface HarnessReleaseDecision {
  reasonCode: HarnessReleaseDecisionReasonCode;
  boundary: HarnessReleaseBoundary;

  /**
   * The sink whose ceiling the flow was fitted against, where the harness
   * performed the fit itself. Absent for a commit refusal, which the runner
   * raised at the pattern's own sink requests — `refusal.sinks` names those.
   */
  sink?: string;

  /**
   * What that sink admits, rendered as an atom is rendered wherever it is
   * displayed. Empty is "public only" and is not the same as absent, which
   * is a fit this record does not state a ceiling for.
   */
  ceiling?: readonly string[];

  /** What the fit refused. Absent on `cfc_release_allowed`, which refused nothing. */
  refusal?: HarnessPolicyRefusal;
}

/**
 * The decision a reason code states, which is the whole of the mapping.
 *
 * A withheld release has its own outcome because the call it belongs to ran
 * and answered: the result exists in the space under its own labels and the
 * caller holds its reference, with only the values held back. `denied` is
 * what a call that did not run gets, which is what a refused commit is — the
 * runner refused the write, so no result landed.
 */
export const harnessReleaseDecisionOutcome = (
  reasonCode: HarnessReleaseDecisionReasonCode,
): "allowed" | "warned" | "withheld" | "denied" =>
  reasonCode === "cfc_release_allowed"
    ? "allowed"
    : reasonCode === "cfc_release_observed"
    ? "warned"
    : reasonCode === "cfc_release_withheld"
    ? "withheld"
    : "denied";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

/**
 * The boundary decision a tool output states, if it states one.
 *
 * Read structurally rather than by tool id: the tool that measures a release
 * boundary is the one that knows it did, and a release site added later says
 * so the same way.
 */
export const harnessReleaseDecisionOf = (
  output: unknown,
): HarnessReleaseDecision | undefined => {
  if (!isRecord(output)) return undefined;
  const decision = output.releaseDecision;
  if (!isRecord(decision)) return undefined;
  // Both discriminants are checked against their closed sets rather than
  // asserted: a tool output is read back through JSON, and a value outside
  // either union would otherwise reach `policy-trace.json` as a reason code
  // no reader of the trace can branch on. An unrecognized decision answers
  // `undefined`, so the loop records nothing rather than something it cannot
  // describe.
  const { reasonCode, boundary } = decision;
  return HARNESS_RELEASE_DECISION_REASON_CODES.includes(
      reasonCode as HarnessReleaseDecisionReasonCode,
    ) &&
      HARNESS_RELEASE_BOUNDARIES.includes(boundary as HarnessReleaseBoundary)
    ? decision as unknown as HarnessReleaseDecision
    : undefined;
};
