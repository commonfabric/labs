/**
 * The one posture record: what a runtime is actually enforcing, in a shape
 * every surface that publishes it publishes identically.
 *
 * A deployment whose enforcement dials cannot be read off it is
 * indistinguishable from a default one, so an operator has no way to confirm
 * what a runtime enforces (CT-2075's posture-visibility finding, AH-CFC-14).
 * Three surfaces answered that question in three shapes — a toolshed route, a
 * console startup line, a run-state section — and three shapes are three
 * things to keep in agreement. This is the one shape, derived from the
 * constructed Runtime's RESOLVED fields: a second reading of configuration
 * could disagree with the first, and the disagreement would be invisible.
 *
 * Two things the record insists on that a bare dial dump does not. An
 * `observe` rung carries what it decides on, so `policyEvaluation: observe`
 * cannot be read as active enforcement — it is a diagnostic that decides on
 * the un-rewritten label. And every known sink appears, whether or not a
 * ceiling governs it: a list of the governed sinks reads as coverage, and a
 * sink missing from it is exactly the gap a reader needed to see.
 *
 * A third: the record says which of the two things it is. A surface that
 * publishes after its runtime exists reads the resolved fields; a surface that
 * publishes before — a console printing at startup, a harness recording a
 * session built lazily on first use — projects what those fields will be. The
 * two are not interchangeable. A projection is a claim about a path that has
 * not run, and an artifact asserting a posture the path did not honor is
 * exactly what an audit of these records exists to catch, so the record must
 * not be able to pass one off as the other. The three entry points below are
 * the only ways this code builds one, and each stamps its own provenance from
 * how it was called rather than from an argument. The third is a host that
 * runs on another host's runtime and republishes that host's record, which is
 * a third thing again: it neither read a runtime nor predicted one.
 *
 * What that buys and what it does not: no production path can mislabel a
 * record, and a reader of one built here can trust the stamp. It is NOT an
 * authenticated claim — the record is a plain serializable object, so a record
 * that arrived over a wire is only as trustworthy as the channel it came on.
 * `/api/meta` is read over the deployment's own transport and trusted on those
 * terms.
 */

import type { CfcConfClause } from "./clause.ts";
import {
  buildCfcPolicySnapshot,
  type CfcPolicyRecordInput,
  type PolicySnapshot,
} from "./policy.ts";
import {
  DEFAULT_SINK_MAX_CONFIDENTIALITY,
  KNOWN_SINKS,
  type KnownSinkName,
  SINK_UNGATED_RATIONALES,
  type SinkMaxConfidentiality,
} from "./sink-inventory.ts";
import type {
  CfcContentAddressedLabels,
  CfcDeclaredMonotonicityMode,
  CfcDecomposedEnvelopes,
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  CfcLabelMetadataProtectionMode,
  CfcPolicyEvaluationMode,
  CfcTriggerReadGating,
  CfcWriteFloorMode,
} from "./types.ts";

/**
 * Where a record's values came from.
 *
 * - `resolved` — read off a constructed Runtime's fields. An attestation:
 *   this is what that runtime is at.
 * - `projected` — computed from the options a runtime WILL be constructed
 *   with, before it exists. A prediction: this is what the surface expects,
 *   and nothing has yet honored it.
 * - `inherited` — the record of the host whose runtime this one is also
 *   running on. Neither an attestation nor a prediction of its own: the
 *   values are that host's, and what they establish is what its own record
 *   establishes, which a reader gets by reading that record's provenance.
 */
export type CfcPostureProvenance = "resolved" | "projected" | "inherited";

/**
 * One dial's resolved rung, with what that rung decides on.
 *
 * `diagnosticOnly` is the field an operator reads first. Every ladder here
 * has a rung whose name contains a verb — `observe` — that records findings
 * and changes no outcome, and a posture printed as a bare value invites
 * reading that rung as enforcement. Stating it as a flag beside the words
 * means a reader does not have to know which ladder rung means what.
 */
export interface CfcDialReport {
  /** The dial's resolved value. */
  readonly rung: string;

  /** Whether this rung records findings without changing any outcome. */
  readonly diagnosticOnly: boolean;

  /** What this rung decides on, in one phrase. */
  readonly decidesOn: string;
}

/** How the deployment governs one sink's confidentiality release. */
export type CfcSinkReport =
  | {
    readonly sink: string;
    /** The confidentiality clauses a request may carry; empty is public-only. */
    readonly ceiling: readonly CfcConfClause[];
  }
  | {
    readonly sink: string;
    /** Why this sink releases with no ceiling, and therefore no gate. */
    readonly ungated: string;
  };

/**
 * A published departure from the posture the deployment otherwise holds:
 * what is not enforced, who carries it, and what would retire it (AH-CFC-15,
 * which asks that a deviation be published rather than silently taken).
 */
export interface CfcPostureDeviation {
  readonly what: string;
  readonly owner: string;
  readonly retirement: string;
}

/** What a runtime is enforcing, as one record. */
export interface CfcPostureReport {
  /**
   * Whether this record attests a constructed runtime, predicts one, or
   * carries the record of the host whose runtime this one runs on.
   */
  readonly provenance: CfcPostureProvenance;

  readonly enforcementMode: CfcDialReport;
  readonly flowLabels: CfcDialReport;
  readonly writeFloor: CfcDialReport;
  readonly triggerReadGating: boolean;
  readonly decomposedEnvelopes: boolean;
  readonly contentAddressedLabels: boolean;
  readonly policyEvaluation: CfcDialReport;
  readonly labelMetadataProtection: CfcDialReport;
  readonly declaredMonotonicity: CfcDialReport;

  /** Digest of the deployment's policy snapshot; `null` when none is configured. */
  readonly policyDigest: string | null;

  /** Every known sink, in registry order, each governed or explicitly not. */
  readonly sinks: readonly CfcSinkReport[];

  /** Every published deviation from what this posture otherwise enforces. */
  readonly deviations: readonly CfcPostureDeviation[];
}

/**
 * The resolved CFC fields a posture record is read from. A `Runtime`
 * satisfies it; so does any other holder of the same resolved values, which
 * is what lets a host project the posture a runtime it has not built yet
 * will run at.
 */
export interface CfcPostureSource {
  readonly cfcEnforcementMode: CfcEnforcementMode;
  readonly cfcFlowLabels: CfcFlowLabelsMode;
  readonly cfcWriteFloor: CfcWriteFloorMode;
  readonly cfcTriggerReadGating: CfcTriggerReadGating;
  readonly cfcDecomposedEnvelopes: CfcDecomposedEnvelopes;
  readonly cfcContentAddressedLabels: CfcContentAddressedLabels;
  readonly cfcPolicyEvaluation: CfcPolicyEvaluationMode;
  readonly cfcLabelMetadataProtection: CfcLabelMetadataProtectionMode;
  readonly cfcDeclaredMonotonicity: CfcDeclaredMonotonicityMode;
  readonly cfcPolicySnapshot: PolicySnapshot | undefined;
  readonly cfcSinkMaxConfidentiality: SinkMaxConfidentiality;
}

const ENFORCEMENT_MODE_DECIDES: Record<CfcEnforcementMode, string> = {
  disabled: "nothing; the boundary pass runs no gate and no reason rejects",
  observe: "nothing; a recorded reason is a diagnostic and the commit proceeds",
  "enforce-explicit": "a recorded reason, which rejects the commit",
  "enforce-strict":
    "a recorded reason, which rejects the commit, plus the strict-only fail-closed rejects",
};

const FLOW_LABELS_DECIDES: Record<CfcFlowLabelsMode, string> = {
  off: "nothing; no derived label component comes into existence",
  observe:
    "nothing; the per-tx flow join is derived and diagnosed but not written",
  persist:
    "the written derived label components, which the enforcing checks consume",
};

const WRITE_FLOOR_DECIDES: Record<CfcWriteFloorMode, string> = {
  off: "nothing; the write-side integrity floor is not checked",
  observe: "nothing; a floor miss is a diagnostic and the write proceeds",
  enforce: "the written value's integrity against the required floor",
};

const POLICY_EVALUATION_DECIDES: Record<CfcPolicyEvaluationMode, string> = {
  off: "nothing; gated labels reach the gates un-rewritten",
  observe:
    "the un-rewritten label; the rewrite is diagnosed, never applied to a decision",
  enforce:
    "the rewritten label, failing closed on fuel exhaustion or policy-lookup failure",
};

const LABEL_METADATA_DECIDES: Record<CfcLabelMetadataProtectionMode, string> = {
  off: "nothing; label metadata writes are not gated",
  observe: "nothing; an unauthorized label-metadata write is a diagnostic",
  enforce: "authority over the label metadata a write changes",
};

const DECLARED_MONOTONICITY_DECIDES: Record<
  CfcDeclaredMonotonicityMode,
  string
> = {
  off: "nothing; a declared-monotonicity violation is not checked",
  observe: "nothing; a monotonicity violation is a diagnostic",
  enforce: "the declared monotonicity of the written value",
};

/** A rung whose findings change no outcome. */
const DIAGNOSTIC_RUNGS: readonly string[] = ["off", "observe", "disabled"];

const dial = (
  rung: string,
  decidesOn: string,
): CfcDialReport => ({
  rung,
  diagnosticOnly: DIAGNOSTIC_RUNGS.includes(rung),
  decidesOn,
});

/**
 * Every known sink and how this runtime governs it.
 *
 * A sink with no ceiling gets no gate, so its entry says so in words rather
 * than by being absent. Where the sink is one the inventory records a
 * rationale for, those are the words; where it is not, the deployment simply
 * has not configured one, and the entry says that instead of inventing a
 * justification for it.
 */
const sinkReports = (
  ceilings: SinkMaxConfidentiality,
): readonly CfcSinkReport[] =>
  KNOWN_SINKS.map((sink: KnownSinkName): CfcSinkReport => {
    const ceiling = ceilings[sink];
    if (ceiling !== undefined) {
      return { sink, ceiling: [...ceiling] };
    }
    const rationale = SINK_UNGATED_RATIONALES[sink];
    return {
      sink,
      ungated: rationale?.reason ??
        "no confidentiality ceiling is configured for this sink",
    };
  });

/**
 * The deviations this runtime is running under: a sink the inventory records
 * a deliberate rationale for, which this runtime does indeed leave ungated.
 * A sink left ungated with no recorded rationale is not a deviation — it is a
 * deployment that has not configured a ceiling, which the audit weighs
 * against whatever posture the surface claims rather than against this list.
 */
const postureDeviations = (
  ceilings: SinkMaxConfidentiality,
): readonly CfcPostureDeviation[] =>
  KNOWN_SINKS.flatMap((sink: KnownSinkName): CfcPostureDeviation[] => {
    const rationale = SINK_UNGATED_RATIONALES[sink];
    if (rationale === undefined || ceilings[sink] !== undefined) {
      return [];
    }
    return [{
      what:
        `sink \`${sink}\` releases with no confidentiality ceiling, so no policy evaluation runs for it: ${rationale.reason}`,
      owner: rationale.owner,
      retirement: rationale.retirement,
    }];
  });

/** The CFC dial options a runtime construction may carry, all optional. */
export type CfcDialOptions = {
  readonly [K in keyof ResolvedCfcDials]?: ResolvedCfcDials[K];
};

/** Every CFC dial, resolved. */
export interface ResolvedCfcDials {
  readonly cfcEnforcementMode: CfcEnforcementMode;
  readonly cfcFlowLabels: CfcFlowLabelsMode;
  readonly cfcWriteFloor: CfcWriteFloorMode;
  readonly cfcTriggerReadGating: CfcTriggerReadGating;
  readonly cfcDecomposedEnvelopes: CfcDecomposedEnvelopes;
  readonly cfcContentAddressedLabels: CfcContentAddressedLabels;
  readonly cfcPolicyEvaluation: CfcPolicyEvaluationMode;
  readonly cfcLabelMetadataProtection: CfcLabelMetadataProtectionMode;
  readonly cfcDeclaredMonotonicity: CfcDeclaredMonotonicityMode;
}

/**
 * What each dial resolves to when a construction leaves it unset.
 *
 * The Runtime's defaults, in one place, rather than nine `??` arms inside a
 * constructor no other host can reach. `DEFAULT_CFC_*` in `types.ts` are not
 * these: those are the per-transaction floors an unconfigured transaction
 * carries, which is a different question with a different answer.
 */
export const RUNTIME_CFC_DIAL_DEFAULTS: ResolvedCfcDials = Object.freeze({
  cfcEnforcementMode: "enforce-strict",
  cfcFlowLabels: "persist",
  cfcWriteFloor: "enforce",
  cfcTriggerReadGating: true,
  cfcDecomposedEnvelopes: false,
  cfcContentAddressedLabels: false,
  cfcPolicyEvaluation: "enforce",
  cfcLabelMetadataProtection: "enforce",
  cfcDeclaredMonotonicity: "observe",
});

/** A dial whose values are the named rungs of a ladder. */
type LadderDial = {
  [K in keyof ResolvedCfcDials]: ResolvedCfcDials[K] extends string ? K : never;
}[keyof ResolvedCfcDials];

/** A dial that is on or off. */
type ToggleDial = {
  [K in keyof ResolvedCfcDials]: ResolvedCfcDials[K] extends boolean ? K
    : never;
}[keyof ResolvedCfcDials];

/**
 * Each ladder dial against the table of what its rungs decide on.
 *
 * That table is keyed by the dial's own mode union, so it holds an entry for
 * every rung and for nothing else. It is therefore the ladder as well as the
 * words, and a check driven from it accepts a rung the moment the ladder
 * gains one.
 *
 * The key order is the ladder's own, weakest rung first, so a reader ordering
 * two rungs of one dial orders them by their position here. The tables are
 * frozen: runtime validation and the audit's floor comparison both read this
 * one, and an importer that reordered a ladder would move what they mean.
 */
export const CFC_DIAL_LADDERS = Object.freeze({
  cfcEnforcementMode: Object.freeze(ENFORCEMENT_MODE_DECIDES),
  cfcFlowLabels: Object.freeze(FLOW_LABELS_DECIDES),
  cfcWriteFloor: Object.freeze(WRITE_FLOOR_DECIDES),
  cfcPolicyEvaluation: Object.freeze(POLICY_EVALUATION_DECIDES),
  cfcLabelMetadataProtection: Object.freeze(LABEL_METADATA_DECIDES),
  cfcDeclaredMonotonicity: Object.freeze(DECLARED_MONOTONICITY_DECIDES),
}) satisfies { [K in LadderDial]: Record<ResolvedCfcDials[K], string> };

/**
 * One ladder dial's rung: what `stated` names, or the default when it names
 * nothing.
 *
 * The comparison is against the rung names as values rather than as property
 * keys, so a value that merely renders as a rung — a one-element array, a
 * boxed string — is not one.
 *
 * @throws If `stated` is not a rung of this dial's ladder.
 */
const resolveRung = <K extends LadderDial>(
  dialName: K,
  stated: ResolvedCfcDials[K] | undefined,
): ResolvedCfcDials[K] => {
  const rungs = Object.keys(CFC_DIAL_LADDERS[dialName]);
  const value = stated === undefined
    ? RUNTIME_CFC_DIAL_DEFAULTS[dialName]
    : stated;
  if (!rungs.includes(value)) {
    throw new Error(
      `Runtime \`${dialName}\` is ${JSON.stringify(value)}, not one of ` +
        rungs.join(", "),
    );
  }
  return value;
};

/**
 * One toggle dial's setting: what `stated` says, or the default when it says
 * nothing.
 *
 * @throws If `stated` is neither `true` nor `false`.
 */
const resolveToggle = <K extends ToggleDial>(
  dialName: K,
  stated: ResolvedCfcDials[K] | undefined,
): ResolvedCfcDials[K] => {
  const value = stated === undefined
    ? RUNTIME_CFC_DIAL_DEFAULTS[dialName]
    : stated;
  if (typeof value !== "boolean") {
    throw new Error(
      `Runtime \`${dialName}\` is ${
        JSON.stringify(value)
      }, not one of true, false`,
    );
  }
  return value;
};

/**
 * The dial values a runtime constructed with `options` runs at.
 *
 * The `Runtime` constructor resolves its own fields through this, so a host
 * that has not built its runtime yet — a console printing its posture at
 * startup, a harness recording the posture a lazily-built session will run
 * at — projects the same values rather than restating the default table in
 * its own words. One table: a default moved here moves everywhere at once,
 * and a host cannot fall behind it silently.
 *
 * Every returned value is a rung of its own dial. A value that reached the
 * options as plain data — a worker's initialization message crosses
 * `postMessage` untyped, a command line and a JSON manifest arrive the same
 * way — is checked here, once, for every host that resolves its dials
 * through this. The type says the same thing, and says it only to callers
 * the type checker saw.
 *
 * @throws Error when a stated dial value is not one that dial accepts,
 * naming the dial and the values it takes.
 */
export const resolveCfcDials = (
  options: CfcDialOptions,
): ResolvedCfcDials => ({
  cfcEnforcementMode: resolveRung(
    "cfcEnforcementMode",
    options.cfcEnforcementMode,
  ),
  cfcFlowLabels: resolveRung("cfcFlowLabels", options.cfcFlowLabels),
  cfcWriteFloor: resolveRung("cfcWriteFloor", options.cfcWriteFloor),
  cfcTriggerReadGating: resolveToggle(
    "cfcTriggerReadGating",
    options.cfcTriggerReadGating,
  ),
  cfcDecomposedEnvelopes: resolveToggle(
    "cfcDecomposedEnvelopes",
    options.cfcDecomposedEnvelopes,
  ),
  cfcContentAddressedLabels: resolveToggle(
    "cfcContentAddressedLabels",
    options.cfcContentAddressedLabels,
  ),
  cfcPolicyEvaluation: resolveRung(
    "cfcPolicyEvaluation",
    options.cfcPolicyEvaluation,
  ),
  cfcLabelMetadataProtection: resolveRung(
    "cfcLabelMetadataProtection",
    options.cfcLabelMetadataProtection,
  ),
  cfcDeclaredMonotonicity: resolveRung(
    "cfcDeclaredMonotonicity",
    options.cfcDeclaredMonotonicity,
  ),
});

/** The values of a record, whichever way its provenance was arrived at. */
const buildReport = (
  provenance: CfcPostureProvenance,
  source: CfcPostureSource,
): CfcPostureReport => ({
  provenance,
  enforcementMode: dial(
    source.cfcEnforcementMode,
    ENFORCEMENT_MODE_DECIDES[source.cfcEnforcementMode],
  ),
  flowLabels: dial(
    source.cfcFlowLabels,
    FLOW_LABELS_DECIDES[source.cfcFlowLabels],
  ),
  writeFloor: dial(
    source.cfcWriteFloor,
    WRITE_FLOOR_DECIDES[source.cfcWriteFloor],
  ),
  triggerReadGating: source.cfcTriggerReadGating === true,
  decomposedEnvelopes: source.cfcDecomposedEnvelopes === true,
  contentAddressedLabels: source.cfcContentAddressedLabels === true,
  policyEvaluation: dial(
    source.cfcPolicyEvaluation,
    POLICY_EVALUATION_DECIDES[source.cfcPolicyEvaluation],
  ),
  labelMetadataProtection: dial(
    source.cfcLabelMetadataProtection,
    LABEL_METADATA_DECIDES[source.cfcLabelMetadataProtection],
  ),
  declaredMonotonicity: dial(
    source.cfcDeclaredMonotonicity,
    DECLARED_MONOTONICITY_DECIDES[source.cfcDeclaredMonotonicity],
  ),
  policyDigest: source.cfcPolicySnapshot?.digest ?? null,
  sinks: sinkReports(source.cfcSinkMaxConfidentiality),
  deviations: postureDeviations(source.cfcSinkMaxConfidentiality),
});

/**
 * The posture record a constructed runtime is at, from its resolved fields.
 * An attestation: `provenance: "resolved"`.
 */
export const cfcPostureReport = (
  source: CfcPostureSource,
): CfcPostureReport => buildReport("resolved", source);

/**
 * The CFC options a runtime will be constructed with — the subset of
 * `RuntimeOptions` a posture is read from, every field optional because a
 * construction that states none still resolves a posture.
 */
export interface CfcPostureOptions extends CfcDialOptions {
  readonly cfcPolicyRecords?: readonly CfcPolicyRecordInput[];
  readonly cfcSinkMaxConfidentiality?: SinkMaxConfidentiality;
}

/**
 * The posture record a runtime constructed with `options` WILL be at, for a
 * surface that has to publish before that runtime exists. A prediction:
 * `provenance: "projected"`.
 *
 * Every value goes through the same resolution the constructor uses — the
 * shared dial table, the same policy-snapshot digest, the same sink registry —
 * so the projection is that resolution rather than a second statement of it.
 * What it cannot promise is that the runtime the surface eventually builds is
 * the one these options describe, which is why the record says it is a
 * projection rather than leaving a reader to assume otherwise.
 */
export const projectedCfcPostureReport = (
  options: CfcPostureOptions,
): CfcPostureReport =>
  buildReport("projected", {
    ...resolveCfcDials(options),
    cfcPolicySnapshot: buildCfcPolicySnapshot(options.cfcPolicyRecords),
    cfcSinkMaxConfidentiality: options.cfcSinkMaxConfidentiality ??
      DEFAULT_SINK_MAX_CONFIDENTIALITY,
  });

/**
 * The record for a host executing on another host's runtime: `parent`'s
 * record, restamped `inherited`.
 *
 * A host that neither constructed a runtime nor holds the options one will be
 * constructed from has a third relationship to the posture — it is running on
 * someone else's runtime, and that runtime's posture is its own. Recomputing
 * the values from the parent's configuration would be a second reading that
 * can disagree with the first; publishing nothing would leave a run whose
 * posture is known reading as one whose posture is not.
 *
 * The values are carried across whatever `parent`'s own provenance is, so a
 * parent record that becomes an attestation makes the inherited record carry
 * an attested runtime's values without this code changing. What the stamp
 * says is where the values came from, never how strong they are: an inherited
 * record establishes exactly what the parent's record establishes, and a
 * reader who needs to know which reads that record.
 */
export const inheritedCfcPostureReport = (
  parent: CfcPostureReport,
): CfcPostureReport => ({ ...parent, provenance: "inherited" });
