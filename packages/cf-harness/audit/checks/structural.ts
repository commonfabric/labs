/**
 * The Group A checks: what one run's own artifacts say about the CFC clauses
 * the harness answers to.
 *
 * Each check is an expression of the clauses it cites and of nothing else. It
 * reads only the artifact tree — no live runtime, no space database, no
 * network — so what it can establish is bounded by what the run wrote down,
 * and it says so: an artifact the check needs and did not find makes the
 * check `inconclusive`, never `pass`.
 *
 * Every check declares what falsifies it. A check nothing could falsify is a
 * sentence about the specification rather than a test of an implementation,
 * and `test/seeded-violations.test.ts` holds each one to its declaration by
 * seeding exactly that shape and requiring the verdict to turn.
 */

import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { handleTokensIn } from "../../console/steps.ts";
import type {
  HarnessCellLabelRecord,
  HarnessCellLabels,
} from "../../src/contracts/cell-labels.ts";
import type { HarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type { HarnessCfcModelContext } from "../../src/contracts/cfc-model-context.ts";
import type { HarnessHandleTable } from "../../src/contracts/handle-table.ts";
import type { HarnessPolicyEvent } from "../../src/contracts/policy.ts";
import {
  countHarnessPolicyDecisions,
  type HarnessPolicyDecisionCounts,
  type HarnessPolicyDecisionReasonCode,
  type HarnessPolicyDecisionRecord,
} from "../../src/contracts/policy-trace.ts";
import type { HarnessToolActivity } from "../../src/contracts/run-report.ts";
import type {
  HarnessToolTranscriptMessage,
  HarnessTranscriptMessage,
} from "../../src/contracts/transcript.ts";
import { inspectHarnessTranscriptPairing } from "../../src/contracts/transcript.ts";
import {
  HARNESS_TRANSCRIPT_OMISSION_RULES,
  type HarnessTranscriptOmissionRule,
  resultProvenanceOf,
} from "../../src/contracts/transcript-omissions.ts";
import { assertValidHarnessHandleTable } from "../../src/handle-table.ts";
import type { HarnessRunState } from "../../src/run-state.ts";
import { type CheckCitation, extendsClause, requiredBy } from "../citations.ts";
import {
  type ArtifactState,
  familyRuns,
  type RunEvidence,
  type RunFamily,
} from "../evidence.ts";
import type {
  CheckEvidence,
  CheckResult,
  CheckVerdict,
  KnownDefectRegistration,
} from "../report.ts";

/** What a check found, before it is stamped with the run it looked at. */
export interface CheckOutcome {
  verdict: CheckVerdict;
  message: string;
  evidence?: readonly CheckEvidence[];

  /** What a ledger entry for this finding would need. See its own type. */
  knownDefect?: KnownDefectRegistration;
}

/** One registered check. */
export interface AuditCheck {
  /** Stable id, cited in findings and in the seeded-violation suite. */
  id: string;

  /** What the check is about, in two or three words. */
  title: string;

  citations: readonly CheckCitation[];

  /**
   * What in an artifact tree turns this check away from `pass`.
   *
   * A registration is where a reader learns whether the check can report
   * anything at all, so this names the evidence rather than restating the
   * rule: "a decision record whose mode differs from the run's", not "the mode
   * is consistent". Most checks name what makes them `fail`; a check whose
   * finding is a `warn` — a posture that weakens its own assurance rather than
   * contradicting a clause — names that instead.
   */
  falsifiedBy: string;

  inspect(run: RunEvidence, family: RunFamily): CheckOutcome;
}

//
// Reading the evidence
//

/** An artifact this host did not find, or found and could not read. */
type UnreadableArtifact = Exclude<
  ArtifactState<unknown>,
  { status: "present" }
>;

/** The outcome for a check whose subject artifact was not readable. */
export const notReadable = (
  artifact: string,
  state: UnreadableArtifact,
): CheckOutcome => ({
  verdict: "inconclusive",
  message: state.status === "absent"
    ? `\`${artifact}\` is absent, so nothing about this clause was established`
    : `\`${artifact}\` ${state.detail}, so nothing about this clause was established`,
  evidence: [{ artifact, detail: state.status }],
});

export const runStateOf = (run: RunEvidence): HarnessRunState | undefined =>
  run.runState.status === "present" ? run.runState.value : undefined;

/**
 * The run's policy decisions, and which artifact they were read from.
 *
 * The trace is the artifact whose subject they are; the report and the run
 * state carry the same list, so a tree missing the trace can still be read.
 */
export const decisionsOf = (
  run: RunEvidence,
):
  | { source: string; decisions: readonly HarnessPolicyDecisionRecord[] }
  | undefined => {
  if (run.policyTrace.status === "present") {
    return {
      source: "policy-trace.json",
      decisions: run.policyTrace.value.decisions ?? [],
    };
  }
  if (run.runReport.status === "present") {
    return {
      source: "run-report.json",
      decisions: run.runReport.value.policyDecisions ?? [],
    };
  }
  const state = runStateOf(run);
  return state === undefined
    ? undefined
    : { source: "run-state.json", decisions: state.policyDecisions ?? [] };
};

export const activitiesOf = (
  run: RunEvidence,
): readonly HarnessToolActivity[] =>
  run.runReport.status === "present"
    ? run.runReport.value.toolActivity ?? []
    : [];

const policyEventsOf = (run: RunEvidence): readonly HarnessPolicyEvent[] =>
  run.runReport.status === "present"
    ? run.runReport.value.policyEvents ?? []
    : runStateOf(run)?.policyEvents ?? [];

/**
 * The invocation contexts each artifact that carries them holds, separately.
 *
 * Two artifacts record the same list, and reading one of them is what makes a
 * deletion from the other invisible. Keeping them apart is what lets AUD-9
 * ask whether they still agree.
 */
const invocationContextArtifacts = (
  run: RunEvidence,
): readonly {
  artifact: string;
  contexts: readonly HarnessCfcInvocationContext[];
}[] => {
  const found: {
    artifact: string;
    contexts: readonly HarnessCfcInvocationContext[];
  }[] = [];
  if (run.policyTrace.status === "present") {
    const contexts = run.policyTrace.value.cfcInvocationContexts;
    if (contexts !== undefined) {
      found.push({ artifact: "policy-trace.json", contexts });
    }
  }
  const state = runStateOf(run);
  if (state?.cfcInvocationContexts !== undefined) {
    found.push({
      artifact: "run-state.json",
      contexts: state.cfcInvocationContexts,
    });
  }
  return found;
};

/**
 * Every invocation context this run retained anywhere, by sequence.
 *
 * The union rather than the first artifact that answered. A context is a
 * record of a call reaching the CFC substrate, and one still held in either
 * artifact was minted whatever became of the other copy — reading the union
 * is the fail-closed direction, because it can only add calls the run must
 * account for. Whether the two artifacts still agree is a retention question,
 * and AUD-9 asks it there rather than here.
 */
const invocationContextsOf = (
  run: RunEvidence,
): readonly HarnessCfcInvocationContext[] => {
  const bySequence = new Map<number, HarnessCfcInvocationContext>();
  for (const { contexts } of invocationContextArtifacts(run)) {
    for (const context of contexts) {
      if (!bySequence.has(context.sequence)) {
        bySequence.set(context.sequence, context);
      }
    }
  }
  return [...bySequence.keys()].sort((left, right) => left - right)
    .map((sequence) => bySequence.get(sequence)!);
};

const transcriptOf = (
  run: RunEvidence,
): readonly HarnessTranscriptMessage[] | undefined =>
  run.transcript.status === "present" ? run.transcript.value : undefined;

const modelContextOf = (
  run: RunEvidence,
): HarnessCfcModelContext | undefined => runStateOf(run)?.cfcModelContext;

const handleTableOf = (run: RunEvidence): HarnessHandleTable | undefined =>
  runStateOf(run)?.handleTable;

export const isEnforcing = (mode: CfcEnforcementMode): boolean =>
  mode === "enforce-explicit" || mode === "enforce-strict";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

/** A tool message's parsed contents, or `undefined` when it is not JSON. */
const parsedToolContent = (message: HarnessToolTranscriptMessage): unknown => {
  try {
    return JSON.parse(message.content);
  } catch {
    return undefined;
  }
};

/** The number, and the singular or plural word for it. */
export const count = (
  total: number,
  singular: string,
  plural: string,
): string => `${total} ${total === 1 ? singular : plural}`;

//
// AUD-1 posture consistency
//

/** One place in the tree that states which mode the run was under. */
interface ModeClaim {
  artifact: string;
  where: string;
  mode: CfcEnforcementMode;
}

/**
 * Every place in the tree that states which mode the run was under.
 *
 * A run state carries the mode in more places than its own header: the policy
 * trace it embeds, the decisions inside that, and every invocation context it
 * recorded all name one. A reader that compared only the headers would call a
 * run consistent while a decision inside it said otherwise, so each is
 * collected and named by where it sits.
 */
const modeClaims = (run: RunEvidence): readonly ModeClaim[] => {
  const claims: ModeClaim[] = [];
  const collect = (
    artifact: string,
    prefix: string,
    source: {
      cfcEnforcementMode?: CfcEnforcementMode;
      decisions?: readonly HarnessPolicyDecisionRecord[];
      policyDecisions?: readonly HarnessPolicyDecisionRecord[];
      policyTrace?: { cfcEnforcementMode?: CfcEnforcementMode };
      cfcInvocationContexts?: readonly HarnessCfcInvocationContext[];
    },
  ): void => {
    if (source.cfcEnforcementMode !== undefined) {
      claims.push({
        artifact,
        where: `${prefix}cfcEnforcementMode`,
        mode: source.cfcEnforcementMode,
      });
    }
    if (source.policyTrace?.cfcEnforcementMode !== undefined) {
      claims.push({
        artifact,
        where: `${prefix}policyTrace.cfcEnforcementMode`,
        mode: source.policyTrace.cfcEnforcementMode,
      });
    }
    for (
      const [field, decisions] of [
        ["decisions", source.decisions],
        ["policyDecisions", source.policyDecisions],
        [
          "policyTrace.decisions",
          source.policyTrace === undefined
            ? undefined
            : (source.policyTrace as {
              decisions?: readonly HarnessPolicyDecisionRecord[];
            })
              .decisions,
        ],
      ] as const
    ) {
      for (const decision of decisions ?? []) {
        if (decision.cfcEnforcementMode !== undefined) {
          claims.push({
            artifact,
            where: `${prefix}${field}[${decision.sequence}].cfcEnforcementMode`,
            mode: decision.cfcEnforcementMode,
          });
        }
      }
    }
    for (const context of source.cfcInvocationContexts ?? []) {
      if (context.cfcEnforcementMode !== undefined) {
        claims.push({
          artifact,
          where:
            `${prefix}cfcInvocationContexts[${context.sequence}].cfcEnforcementMode`,
          mode: context.cfcEnforcementMode,
        });
      }
    }
  };

  const state = runStateOf(run);
  if (state !== undefined) {
    collect("run-state.json", "", state);
  }
  if (run.policyTrace.status === "present") {
    const trace = run.policyTrace.value;
    collect("policy-trace.json", "", {
      ...(trace.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: trace.cfcEnforcementMode }
        : {}),
      decisions: trace.decisions,
      ...(trace.cfcInvocationContexts !== undefined
        ? { cfcInvocationContexts: trace.cfcInvocationContexts }
        : {}),
    });
  }
  if (run.runReport.status === "present") {
    collect("run-report.json", "", run.runReport.value);
  }
  return claims;
};

/** How the run came by its mode, for a finding to name beside the mode. */
const modeSourceOf = (run: RunEvidence): string => {
  const fabric = runStateOf(run)?.fabricSessionCfc;
  return fabric === undefined
    ? "run configuration"
    : `fabric session (${fabric.enforcementModeSource})`;
};

const postureConsistency: AuditCheck = {
  id: "AUD-1",
  title: "posture consistency",
  citations: requiredBy("AH-CFC-14"),
  falsifiedBy:
    "two claims of one run naming different enforcement modes — a run state, policy-trace header, run report, or any decision record or invocation context disagreeing with the rest — or a run state or run report that states no mode at all",
  inspect(run) {
    // The clause puts the mode in two named places, so a tree missing either
    // one establishes nothing about it rather than passing on the other.
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    if (run.runReport.status !== "present") {
      return notReadable("run-report.json", run.runReport);
    }
    const claims = modeClaims(run);
    const silent = ([
      ["run-state.json", run.runState.value.cfcEnforcementMode],
      ["run-report.json", run.runReport.value.cfcEnforcementMode],
    ] as const).filter(([, mode]) => mode === undefined);
    if (silent.length > 0) {
      return {
        verdict: "fail",
        message: `${
          silent.map(([artifact]) => `\`${artifact}\``).join(" and ")
        } states no enforcement mode, which the clause requires of both`,
        evidence: silent.map(([artifact]) => ({
          artifact,
          pointer: "cfcEnforcementMode",
          detail: "absent",
        })),
      };
    }
    const modes = new Set(claims.map((claim) => claim.mode));
    if (modes.size > 1) {
      return {
        verdict: "fail",
        message: `this run's artifacts name ${
          count(modes.size, "enforcement mode", "different enforcement modes")
        } (${[...modes].sort().join(", ")})`,
        evidence: claims.map((claim) => ({
          artifact: claim.artifact,
          pointer: claim.where,
          detail: claim.mode,
        })),
      };
    }
    const [mode] = [...modes];
    return {
      verdict: "pass",
      message: `every artifact of this run names \`${mode}\`, selected by ${
        modeSourceOf(run)
      }`,
      evidence: [{
        artifact: "run-state.json",
        pointer: "cfcEnforcementMode",
        detail: `${mode}, agreed by ${
          count(claims.length, "recorded claim", "recorded claims")
        }`,
      }],
    };
  },
};

//
// AUD-2 mode-behavior attestation
//

/**
 * The mode a reason code belongs to, or `undefined` for one that says nothing
 * about the mode.
 *
 * `HarnessPolicyDecisionReasonCode` is a closed union whose CFC members carry
 * their mode in the name, which is what makes this exact rather than
 * heuristic. A code with no mode in it — `tool_not_allowed`,
 * `subagent_profile_allowed` — is mode-neutral and asserts nothing here.
 */
const modeOfReasonCode = (
  code: HarnessPolicyDecisionReasonCode | string,
): CfcEnforcementMode | undefined => {
  const body = code.startsWith("write_file_")
    ? code.slice("write_file_".length)
    : code.startsWith("cfc_")
    ? code.slice("cfc_".length)
    : undefined;
  if (body === undefined) return undefined;
  if (body === "disabled") return "disabled";
  if (body.startsWith("observe")) return "observe";
  if (body.startsWith("enforce_explicit")) return "enforce-explicit";
  if (body.startsWith("enforce_strict")) return "enforce-strict";
  return undefined;
};

/** The side effects this run actually executed, which need transport evidence. */
export const executedSideEffects = (
  run: RunEvidence,
): readonly HarnessToolActivity[] =>
  activitiesOf(run).filter((activity) =>
    activity.effectClass === "side-effect" &&
    activity.executionStatus === "completed"
  );

/**
 * The executed side effects of a run that could carry a CFC invocation
 * context.
 *
 * Which tools reach the substrate that mints a context is not something an
 * artifact tree states, so it is read off the run itself: a tool the run
 * recorded a context for is a tool whose invocations carry CFC evidence, and
 * a later call to it that carries none is evidence gone missing rather than a
 * tool that never had any. A host-side tool — `delegate_task`, `assign_slug`
 * — appears in no context and so is none of these.
 *
 * A run that recorded no context at all is the limit of this reading: it
 * classifies nothing, because a tree holding no context looks the same
 * whether its effects were host-side or its evidence was lost. AUD-2 and
 * AUD-9 both turn on this question, and answering it in one place is what
 * keeps a report from calling the same effects unattested under one check and
 * beyond the substrate under the other.
 */
const substrateReachingSideEffects = (
  run: RunEvidence,
): readonly HarnessToolActivity[] => {
  const transporting = new Set(
    invocationContextsOf(run).map((context) => context.toolId),
  );
  return executedSideEffects(run).filter((activity) =>
    transporting.has(activity.toolId)
  );
};

/**
 * The substrate-reaching side effects of a run that no retained invocation
 * context explains.
 *
 * The contexts are keyed by the tool as well as the output: an output id is
 * unique within a run, so a context another tool recorded would otherwise
 * read as covering this activity.
 */
const substrateEffectsMissingContext = (
  run: RunEvidence,
): readonly HarnessToolActivity[] => {
  const covered = new Set(
    invocationContextsOf(run)
      .filter((context) => context.toolOutputId !== undefined)
      .map((context) => `${context.toolId}:${String(context.toolOutputId)}`),
  );
  return substrateReachingSideEffects(run).filter((activity) =>
    activity.resultRef !== undefined &&
    !covered.has(`${activity.toolId}:${String(activity.resultRef.outputId)}`)
  );
};

const modeBehaviorAttestation: AuditCheck = {
  id: "AUD-2",
  title: "mode-behavior attestation",
  citations: [...requiredBy("AH-CFC-15"), ...extendsClause("AH-CFC-14")],
  falsifiedBy:
    "a decision reason code from another mode's family than the run claims — a `cfc_observe_*` or `cfc_disabled` code under an enforcing claim — or a call to a tool this run elsewhere recorded an invocation context for, made with none",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    // `decisionsOf` reads the first of policy trace, run report, and run state
    // that loaded, and the guard above established one of them, so it answers
    // here rather than returning nothing.
    const found = decisionsOf(run)!;
    const mode = runStateOf(run)!.cfcEnforcementMode;
    const evidence: CheckEvidence[] = [];
    for (const decision of found.decisions) {
      for (const code of decision.reasonCodes ?? []) {
        const codeMode = modeOfReasonCode(code);
        if (codeMode !== undefined && codeMode !== mode) {
          evidence.push({
            artifact: found.source,
            pointer: `decisions[${decision.sequence}].reasonCodes`,
            detail:
              `\`${code}\` belongs to \`${codeMode}\`, and this run claims \`${mode}\``,
          });
        }
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(
            evidence.length,
            "decision reason code names",
            "decision reason codes name",
          )
        } a mode other than the \`${mode}\` this run claims`,
        evidence,
      };
    }
    if (!isEnforcing(mode)) {
      return {
        verdict: "pass",
        message: `every decision reason code belongs to \`${mode}\``,
      };
    }
    // An enforcing claim is attested by what the run's side effects carried,
    // and the run report is where the side effects are. Without it the tool
    // activity reads as empty, which would attest the claim by knowing
    // nothing about it.
    if (run.runReport.status !== "present") {
      return notReadable("run-report.json", run.runReport);
    }
    const contexts = invocationContextsOf(run);
    const effects = executedSideEffects(run);
    const uncovered = substrateEffectsMissingContext(run);
    if (uncovered.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(uncovered.length, "side effect", "side effects")
        } used a tool this run transports CFC evidence for, and recorded none`,
        evidence: uncovered.map((activity) => ({
          artifact: "run-report.json",
          pointer: `toolActivity[${activity.sequence}]`,
          detail: `\`${activity.toolId}\` completed with no invocation context`,
        })),
      };
    }
    if (contexts.length === 0 && effects.length > 0) {
      return {
        verdict: "warn",
        message:
          `reduced assurance: this run claims \`${mode}\` and never exercised it — none of its ${
            count(effects.length, "side effect", "side effects")
          } reached the substrate that carries CFC evidence, so nothing here tested the claim`,
        evidence: effects.map((activity) => ({
          artifact: "run-report.json",
          pointer: `toolActivity[${activity.sequence}]`,
          detail: `\`${activity.toolId}\` completed with no invocation context`,
        })),
      };
    }
    return {
      verdict: "pass",
      message: `every decision reason code belongs to \`${mode}\`, and ${
        contexts.length === 0
          ? "it made no substrate invocation"
          : `its substrate invocations carry ${
            count(contexts.length, "invocation context", "invocation contexts")
          }`
      }`,
    };
  },
};

//
// AUD-3 decision coverage
//

/**
 * The writers other than a tool the model called that persist a file into a
 * run's `tool-outputs/` directory, named as each names itself to
 * `persistToolOutput`.
 *
 * A delegation writes the child's final text there as the trusted side's own
 * validation evidence, and a `run_pattern` call writes the source text it
 * carried beside that call's own output, under the same output id. Neither is
 * a tool effect: each joins to no tool activity, no policy decision is
 * expected for it, and its absence from the report's `toolOutputs` is not an
 * unrecorded effect.
 *
 * These are writing paths rather than contents. `persistToolOutput` names its
 * file `<outputId>-<writer>.json`, and neither half is a string a tool
 * invocation supplies: the output id is a host counter, and a writer name here
 * is not a `BuiltinToolId`, so no tool the model calls is persisted under one.
 * An exemption keyed on a field inside the file would be keyed on the artifact
 * being judged — a model-authored output carries a `type` of its choosing as
 * easily as a host-written one does, and the check would then be asking the
 * subject whether to look at it.
 *
 * What this does NOT establish, and a reader should not take from it: that the
 * name is beyond a model's reach altogether. The artifact root defaults inside
 * the workspace, and `bash` does not consult the reserved-artifact guard that
 * `write_file`, `edit_file`, `read_file` and `view_image` share, so a run that
 * can execute a shell can create a file under any name it likes — including
 * one of these. The type-keyed exemption this replaced was evadable by exactly
 * the same capability, so nothing here is weaker; what closes it is the other
 * discriminator, a host-side record of which outputs the harness authored,
 * which is a change to what a run writes rather than to what the audit reads.
 */
export const HOST_AUTHORED_OUTPUT_WRITERS: ReadonlySet<string> = new Set([
  "subagent-return",
  "run-pattern-source",
]);

/**
 * Whether `fileName` is one a host writer produced, read off the name
 * `persistToolOutput` composed rather than off anything inside the file.
 */
const isHostAuthoredOutputFile = (fileName: string): boolean => {
  for (const writer of HOST_AUTHORED_OUTPUT_WRITERS) {
    if (fileName.endsWith(`-${writer}.json`)) {
      return true;
    }
  }
  return false;
};

/** The three readings of a `withheld` count that differ. */
type WithheldCount =
  | { kind: "absent" }
  | { kind: "number"; value: number }
  | { kind: "malformed" };

/**
 * What a counts object says about `withheld`.
 *
 * A trace written before the outcome existed declares nothing, a trace written
 * after declares a number, and a field that is present and is not a number is
 * neither — which is why the three are told apart rather than collapsed into
 * an optional number.
 *
 * Read through an index rather than a field because the count is written by a
 * harness that may be newer than the contract this audit compiles against — an
 * audit that could only read the fields it was built with would go quiet on
 * exactly the runs worth reading.
 */
const withheldIn = (
  counts: HarnessPolicyDecisionCounts | Record<string, unknown> | undefined,
): WithheldCount => {
  if (counts === undefined) return { kind: "absent" };
  const value = (counts as Record<string, unknown>).withheld;
  if (value === undefined) return { kind: "absent" };
  return typeof value === "number"
    ? { kind: "number", value }
    : { kind: "malformed" };
};

const countsAgree = (
  declared: HarnessPolicyDecisionCounts | undefined,
  computed: HarnessPolicyDecisionCounts,
): boolean =>
  declared !== undefined &&
  declared.total === computed.total &&
  declared.allowed === computed.allowed &&
  declared.warned === computed.warned &&
  declared.denied === computed.denied &&
  // A run recorded before the `invalid` outcome existed declares no count for
  // it, and its decisions hold none: absent and zero are the same reading, so
  // reading absent as zero keeps such a run conclusive rather than failing it
  // for a field it could not have written. Absent means absent, though — a
  // count that is present and not the number beside it is a disagreement,
  // whatever it holds.
  (declared.invalid === undefined
    ? computed.invalid === 0
    : declared.invalid === computed.invalid) &&
  // `withheld` is the outcome of a release entry whose values were held back.
  // Unlike `invalid`, the counter this audit computes with may not know the
  // outcome at all: a trace can be written by a harness newer than the build
  // reading it. So the reconciliation is conditional on THIS build being able
  // to count the outcome — where it cannot, there is nothing to reconcile and
  // saying so is honest, where inventing a zero would manufacture a
  // disagreement out of a version gap. Once the counter emits `withheld`, a
  // declared count that is not the number beside it is a disagreement like any
  // other, and an absent declaration still reads as zero.
  ((): boolean => {
    const theirs = withheldIn(declared);
    // A field that is present and is not a number equals no count, so it
    // disagrees whether or not this build can compute one. Deciding that
    // first is what keeps a malformed declaration from hiding behind a
    // version gap.
    if (theirs.kind === "malformed") return false;
    // `computed` is this build's own count, so it is a number or nothing; only
    // the declared side can be malformed, which is decided above.
    const mine = withheldIn(computed);
    // Anything but a number on this side means this build did not count the
    // outcome, so there is nothing to reconcile; inventing a zero here would
    // manufacture a disagreement out of a trace written by a newer harness.
    if (mine.kind !== "number") return true;
    return (theirs.kind === "absent" ? 0 : theirs.value) === mine.value;
  })();

const describeCounts = (counts: HarnessPolicyDecisionCounts): string =>
  `total ${counts.total}, allowed ${counts.allowed}, warned ${counts.warned}, denied ${counts.denied}, invalid ${
    counts.invalid ?? 0
  }, withheld ${
    ((held) =>
      held.kind === "number"
        ? held.value
        : held.kind === "absent"
        ? 0
        : "malformed")(withheldIn(counts))
  }`;

const decisionCoverage: AuditCheck = {
  id: "AUD-3",
  title: "decision coverage",
  citations: [
    ...requiredBy("AH-TOOL-3"),
    ...extendsClause("AH-CFC-9", "AH-CFC-11"),
  ],
  falsifiedBy:
    "a side-effect tool activity with no policy decision on its `toolCallId`, a declared decision count that does not match the decisions beside it, or a persisted tool output no activity accounts for and no host writer named",
  inspect(run) {
    if (run.runReport.status !== "present") {
      return notReadable("run-report.json", run.runReport);
    }
    const report = run.runReport.value;
    // `decisionsOf` reads the first of policy trace, run report, and run state
    // that loaded, and the guard above established one of them, so it answers
    // here rather than returning nothing.
    const found = decisionsOf(run)!;
    const evidence: CheckEvidence[] = [];
    const decided = new Set(
      found.decisions.map((decision) => decision.toolCallId),
    );
    for (const activity of report.toolActivity ?? []) {
      if (
        activity.effectClass === "side-effect" &&
        !decided.has(activity.toolCallId)
      ) {
        evidence.push({
          artifact: "run-report.json",
          pointer: `toolActivity[${activity.sequence}]`,
          detail:
            `side-effect call \`${activity.toolId}\` (${activity.toolCallId}) joins to no policy decision`,
        });
      }
    }
    const computed = countHarnessPolicyDecisions(found.decisions);
    if (run.policyTrace.status === "present") {
      const declared = run.policyTrace.value.decisionCounts;
      if (!countsAgree(declared, computed)) {
        evidence.push({
          artifact: "policy-trace.json",
          pointer: "decisionCounts",
          detail: `declares ${
            declared === undefined ? "no counts" : describeCounts(declared)
          }; its decisions are ${describeCounts(computed)}`,
        });
      }
    }
    const reportCounts = countHarnessPolicyDecisions(
      report.policyDecisions ?? [],
    );
    if (!countsAgree(report.policyDecisionCounts, reportCounts)) {
      evidence.push({
        artifact: "run-report.json",
        pointer: "policyDecisionCounts",
        detail: `declares ${
          report.policyDecisionCounts === undefined
            ? "no counts"
            : describeCounts(report.policyDecisionCounts)
        }; its decisions are ${describeCounts(reportCounts)}`,
      });
    }
    const activityOutputIds = new Set(
      (report.toolActivity ?? [])
        .map((activity) => activity.resultRef?.outputId)
        .filter((outputId) => outputId !== undefined)
        .map(String),
    );
    for (const output of report.toolOutputs ?? []) {
      if (!activityOutputIds.has(String(output.outputId))) {
        evidence.push({
          artifact: "run-report.json",
          pointer: `toolOutputs ${String(output.outputId)}`,
          detail:
            `a persisted output of \`${output.toolId}\` that no tool activity accounts for`,
        });
      }
    }
    if (run.toolOutputs.status === "present") {
      const listed = new Set(
        (report.toolOutputs ?? []).map((output) =>
          output.artifactPath?.split("/").at(-1) ?? ""
        ),
      );
      for (const entry of run.toolOutputs.entries) {
        if (listed.has(entry.fileName)) continue;
        if (isHostAuthoredOutputFile(entry.fileName)) continue;
        evidence.push({
          artifact: `tool-outputs/${entry.fileName}`,
          detail:
            "a tool output on disk that the run report's `toolOutputs` does not list",
        });
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(evidence.length, "tool effect is", "tool effects are")
        } not accounted for by a recorded policy decision`,
        evidence,
      };
    }
    return {
      verdict: "pass",
      message:
        `every side-effect activity joins to a decision, and the declared counts match the decisions recorded (${
          describeCounts(computed)
        })`,
    };
  },
};

//
// AUD-4 denial channel
//

/** A `toolCallId` this run denied, and where the denial was recorded. */
interface DenialRecord {
  toolCallId: string;
  artifact: string;
  pointer: string;
}

/**
 * Every denial the run recorded, wherever it recorded it.
 *
 * A decision record, a tool activity, and a policy event each carry one, and
 * they are not the same set: a call the policy allowed can still have its
 * observation denied afterwards for want of mediation metadata, and that
 * denial reaches only the activity and the event. Reading all three is what
 * keeps such a call inside this check.
 */
const denialsOf = (run: RunEvidence): readonly DenialRecord[] => {
  const denials = new Map<string, DenialRecord>();
  const remember = (record: DenialRecord): void => {
    if (!denials.has(record.toolCallId)) {
      denials.set(record.toolCallId, record);
    }
  };
  const found = decisionsOf(run);
  for (const decision of found?.decisions ?? []) {
    // A release refusal denied the VALUES of a result, not the call: the call
    // completed and answered with a reference to the result it withheld, so
    // there is no denied call for the typed deny channel to carry and no
    // withheld observation for a message to leak. AUD-16 is where those are
    // counted. A decision carrying no `release` denied the call itself.
    if (decision.decision === "denied" && decision.release === undefined) {
      remember({
        toolCallId: decision.toolCallId,
        artifact: found!.source,
        pointer: `decisions[${decision.sequence}]`,
      });
    }
  }
  for (const activity of activitiesOf(run)) {
    if (activity.policyDecision === "denied") {
      remember({
        toolCallId: activity.toolCallId,
        artifact: "run-report.json",
        pointer: `toolActivity[${activity.sequence}]`,
      });
    }
  }
  for (const [index, event] of policyEventsOf(run).entries()) {
    if (event.severity === "denied" && event.toolCallId !== undefined) {
      remember({
        toolCallId: event.toolCallId,
        artifact: "run-report.json",
        pointer: `policyEvents[${index}]`,
      });
    }
  }
  return [...denials.values()];
};

/** The typed shape a withheld observation reaches the model as. */
const OBSERVATION_DENIED_TYPE = "cf-harness.observation-denied";

/**
 * The prefix of every contract type the harness publishes.
 *
 * A tool that refuses in its own typed way — `read_file` returning a
 * `cf-harness.structured-file-tool-error` — is on the profile's channel as
 * much as an `observation-denied` is. A bare `{ status: "error" }` with no
 * contract behind it is not: nothing about it says which contract the model is
 * reading, which is the whole of what "the profile's typed deny/recovery
 * channel" asks for.
 */
const HARNESS_CONTRACT_TYPE_PREFIX = "cf-harness.";

/**
 * The fields that carry an observation's own bytes.
 *
 * A typed denial names a reason, a detail, and an opaque handle standing in
 * for what was withheld. Any of these beside it is the payload arriving
 * through the channel that was meant to withhold it.
 */
const PAYLOAD_FIELDS: readonly string[] = [
  "stdout",
  "stderr",
  "content",
  "diff",
  "text",
];

/** What is wrong with the message answering a denied call, if anything. */
const deniedMessageDefect = (
  message: HarnessToolTranscriptMessage,
): string | undefined => {
  const parsed = parsedToolContent(message);
  if (!isRecord(parsed)) {
    return "carries free text rather than a typed denial";
  }
  const errorType = isRecord(parsed.error) ? parsed.error.type : undefined;
  const typed = parsed.type === OBSERVATION_DENIED_TYPE ||
    (typeof errorType === "string" &&
      errorType.startsWith(HARNESS_CONTRACT_TYPE_PREFIX));
  if (!typed) {
    return `carries \`${
      typeof parsed.type === "string" ? parsed.type : "an untyped object"
    }\` rather than a typed denial`;
  }
  const carried = PAYLOAD_FIELDS.filter((field) => {
    const value = parsed[field];
    return typeof value === "string" && value.length > 0;
  });
  return carried.length === 0
    ? undefined
    : `carries payload content in \`${carried.join("`, `")}\``;
};

const denialChannel: AuditCheck = {
  id: "AUD-4",
  title: "denial channel",
  citations: requiredBy("AH-CFC-6", "AH-CFC-11"),
  falsifiedBy:
    "a denial the run recorded no policy event for, or a denied `toolCallId` whose tool message is untyped free text, carries the withheld observation's payload beside the denial, or is absent from the transcript altogether",
  inspect(run) {
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }
    const denials = denialsOf(run);
    if (denials.length === 0) {
      return { verdict: "not-applicable", message: "this run denied nothing" };
    }
    const answered = new Map<string, [number, HarnessToolTranscriptMessage]>();
    for (const [index, message] of run.transcript.value.entries()) {
      if (message.role === "tool") {
        answered.set(message.toolCallId, [index, message]);
      }
    }
    // The clause asks two things of a denial, and a run can hold one without
    // the other: that it was recorded as a policy event, and that it reached
    // the model only through the typed channel. Both are read here.
    const evented = new Set(
      policyEventsOf(run)
        .filter((event) => event.severity === "denied")
        .map((event) => event.toolCallId),
    );
    const evidence: CheckEvidence[] = [];
    // One denial can fail this check twice — no policy event AND an untyped
    // answer — so the denials that failed are counted rather than the evidence
    // rows, which is what makes the numerator a subset of the denominator.
    const failed = new Set<string>();
    for (const denial of denials) {
      if (!evented.has(denial.toolCallId)) {
        failed.add(denial.toolCallId);
        evidence.push({
          artifact: denial.artifact,
          pointer: denial.pointer,
          detail:
            `denied \`${denial.toolCallId}\`, which this run recorded no policy event for`,
        });
      }
      const paired = answered.get(denial.toolCallId);
      if (paired === undefined) {
        failed.add(denial.toolCallId);
        evidence.push({
          artifact: denial.artifact,
          pointer: denial.pointer,
          detail:
            `denied \`${denial.toolCallId}\`, which no tool message in the transcript pairs with`,
        });
        continue;
      }
      const [index, message] = paired;
      const defect = deniedMessageDefect(message);
      if (defect !== undefined) {
        failed.add(denial.toolCallId);
        evidence.push({
          artifact: "transcript.json",
          pointer: `[${index}]`,
          detail:
            `the message answering denied \`${denial.toolCallId}\` ${defect}`,
        });
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${failed.size} of ${
          count(denials.length, "denial", "denials")
        } did not reach the model through the typed deny channel`,
        evidence,
      };
    }
    return {
      verdict: "pass",
      message: `${
        count(denials.length, "denial", "denials")
      } reached the model as a typed denial carrying no payload`,
    };
  },
};

//
// AUD-5 handle discipline
//

/** Where a handle token appeared, and which side of the boundary wrote it. */
interface TokenAppearance {
  index: number;
  author: "harness" | "model";
  where: string;
}

/**
 * Every handle token appearance in a transcript, in order.
 *
 * The system prompt and a tool result are the harness writing to the model; an
 * assistant message and the arguments of the calls it carries are the model
 * writing back. That split is what makes a pre-mint token legible: a token the
 * model wrote before the harness ever showed it one is a token it did not get
 * from a mint.
 */
const tokenAppearances = (
  transcript: readonly HarnessTranscriptMessage[],
): Map<string, TokenAppearance[]> => {
  const appearances = new Map<string, TokenAppearance[]>();
  const record = (token: string, appearance: TokenAppearance): void => {
    const held = appearances.get(token);
    if (held === undefined) {
      appearances.set(token, [appearance]);
    } else {
      held.push(appearance);
    }
  };
  for (const [index, message] of transcript.entries()) {
    switch (message.role) {
      case "system":
      case "user":
        for (const token of handleTokensIn(message.content)) {
          record(token, { index, author: "harness", where: message.role });
        }
        break;
      case "tool":
        for (const token of handleTokensIn(message.content)) {
          record(token, { index, author: "harness", where: "tool result" });
        }
        break;
      case "assistant":
        for (const token of handleTokensIn(message.content)) {
          record(token, { index, author: "model", where: "assistant text" });
        }
        for (const call of message.toolCalls ?? []) {
          for (const token of handleTokensIn(call.function.arguments)) {
            record(token, {
              index,
              author: "model",
              where: `\`${call.function.name}\` arguments`,
            });
          }
        }
        break;
    }
  }
  return appearances;
};

/** The tokens each delegation named, keyed by the child run it started. */
const delegatedTokens = (
  parent: RunEvidence,
): Map<string, ReadonlySet<string>> => {
  const argumentsByCall = new Map<string, string>();
  for (const message of transcriptOf(parent) ?? []) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      argumentsByCall.set(call.id, call.function.arguments);
    }
  }
  const byChild = new Map<string, ReadonlySet<string>>();
  for (const subagentRun of runStateOf(parent)?.subagentRuns ?? []) {
    const args = argumentsByCall.get(subagentRun.parentToolCallId);
    byChild.set(
      subagentRun.childRunId,
      new Set(args === undefined ? [] : handleTokensIn(args)),
    );
  }
  return byChild;
};

const handleDiscipline: AuditCheck = {
  id: "AUD-5",
  title: "handle discipline",
  citations: requiredBy("AH-CFC-18", "AH-CFC-19", "AH-CFC-12", "AH-CFC-13"),
  falsifiedBy:
    "a handle table `assertValidHarnessHandleTable` refuses, a token the model wrote before the harness disclosed it, or a parent token in a child transcript that no delegation named and the child's own table does not hold",
  inspect(run, family) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }
    const table = handleTableOf(run);
    const appearances = tokenAppearances(run.transcript.value);
    if (table === undefined && appearances.size === 0) {
      return {
        verdict: "not-applicable",
        message: "this run minted no handle and its transcript carries none",
      };
    }
    const evidence: CheckEvidence[] = [];
    if (table !== undefined) {
      try {
        assertValidHarnessHandleTable(table);
      } catch (error) {
        evidence.push({
          artifact: "run-state.json",
          pointer: "handleTable",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const held = new Set((table?.entries ?? []).map((entry) => entry.token));
    // An input cell's token is minted before the run's first turn and reaches
    // the model through the seeded prompt, which is not part of the recorded
    // transcript. It has no disclosure to be earlier than.
    const seeded = new Set(
      (runStateOf(run)?.inputCells ?? []).map((cell) => cell.token),
    );
    for (const [token, where] of appearances) {
      if (!held.has(token) || seeded.has(token)) continue;
      const disclosed = where.find((one) => one.author === "harness");
      const written = where.find((one) => one.author === "model");
      if (
        written !== undefined &&
        (disclosed === undefined || written.index < disclosed.index)
      ) {
        evidence.push({
          artifact: "transcript.json",
          pointer: `[${written.index}]`,
          detail:
            `\`${token}\` reaches the model's ${written.where} before the harness disclosed it`,
        });
      }
    }
    if (run.runDir === family.root.runDir) {
      const delegations = delegatedTokens(run);
      for (const child of family.children) {
        const childTranscript = transcriptOf(child);
        if (childTranscript === undefined) continue;
        const childHeld = new Set(
          (handleTableOf(child)?.entries ?? []).map((entry) => entry.token),
        );
        const named = delegations.get(child.runId) ?? new Set<string>();
        for (const token of tokenAppearances(childTranscript).keys()) {
          if (held.has(token) && !childHeld.has(token) && !named.has(token)) {
            evidence.push({
              artifact: `${child.runId}/transcript.json`,
              detail:
                `\`${token}\` is a parent handle the child carries with no recorded transfer`,
            });
          }
        }
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(evidence.length, "handle defect", "handle defects")
        } in this run's table, disclosure order, or delegation boundary`,
        evidence,
      };
    }
    return {
      verdict: "pass",
      message: `the handle table is well formed, and its ${
        count(held.size, "token", "tokens")
      } reached the model only after the harness disclosed them`,
    };
  },
};

//
// AUD-6 transcript pairing
//

const transcriptPairing: AuditCheck = {
  id: "AUD-6",
  title: "transcript pairing",
  citations: [...requiredBy("AH-LIFE-6"), ...extendsClause("AH-CFC-16")],
  falsifiedBy:
    "a transcript `inspectHarnessTranscriptPairing` reports a defect in — an orphan or duplicate tool result, a duplicate tool call, or a call left unanswered",
  inspect(run) {
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }
    const pairing = inspectHarnessTranscriptPairing(run.transcript.value);
    if (pairing.valid) {
      return {
        verdict: "pass",
        message:
          "every tool call in the transcript has exactly one matching tool result",
      };
    }
    return {
      verdict: "fail",
      message: `the transcript carries ${
        count(pairing.defects.length, "pairing defect", "pairing defects")
      }; its longest resumable prefix ends at message ${pairing.safeBoundary}`,
      evidence: pairing.defects.map((defect) => ({
        artifact: "transcript.json",
        pointer: `[${defect.messageIndex}]`,
        detail: defect.kind === "unresolved_tool_calls"
          ? `${defect.kind}: ${defect.toolCallIds.join(", ")}`
          : `${defect.kind}: ${defect.toolCallId}`,
      })),
    };
  },
};

//
// AUD-7 observe disclosure
//

const observeDisclosure: AuditCheck = {
  id: "AUD-7",
  title: "observe disclosure",
  citations: [
    ...requiredBy("AH-CFC-modes-observe"),
    ...extendsClause("AH-CFC-15"),
  ],
  falsifiedBy:
    "a dial this run recorded at `observe`, which turns the verdict to `warn` and keeps it off `pass`. A run whose artifacts disagree about the mode is AUD-1's finding, not this one's: two checks failing on one shape would say the same thing twice and leave neither able to fail alone",
  inspect(run) {
    const claims = modeClaims(run);
    if (claims.length === 0) {
      return {
        verdict: "inconclusive",
        message:
          "no artifact of this run states an enforcement mode, so whether it was diagnostic is unknown",
      };
    }
    const observing = claims.filter((claim) => claim.mode === "observe");
    if (observing.length > 0) {
      return {
        verdict: "warn",
        message:
          "reduced assurance: this run was under `observe`, which is diagnostic, so its evidence attests no enforcement",
        evidence: observing.map((claim) => ({
          artifact: claim.artifact,
          pointer: claim.where,
          detail: claim.mode,
        })),
      };
    }
    if (runStateOf(run)?.fabricSessionCfc?.flowLabels === "observe") {
      return {
        verdict: "warn",
        message:
          "reduced assurance: this run's fabric session held flow labels at `observe`, so label propagation was diagnostic even where tool policy was enforcing",
        evidence: [{
          artifact: "run-state.json",
          pointer: "fabricSessionCfc.flowLabels",
          detail: "observe",
        }],
      };
    }
    return {
      verdict: "pass",
      message: "no dial this run recorded stands at `observe`",
    };
  },
};

//
// AUD-8 influence accumulation
//

/** One channel of one tool result, as the model-facing output summarized it. */
interface ChannelSummary {
  channel: string;
  policy: string;
  labeled: boolean;
}

/**
 * The per-channel CFC dispositions a mediated tool result carries.
 *
 * The model-facing output states each channel's policy and label beside the
 * text it let through, so the transcript alone says which observations the
 * model read under a confidentiality label — which is what makes the
 * accumulation rule checkable from artifacts.
 */
const channelSummaries = (parsed: unknown): readonly ChannelSummary[] => {
  if (!isRecord(parsed) || !isRecord(parsed.cfc)) return [];
  const summaries: ChannelSummary[] = [];
  for (const [key, value] of Object.entries(parsed.cfc)) {
    if (!isRecord(value) || typeof value.policy !== "string") continue;
    const label = isRecord(value.label) ? value.label : undefined;
    summaries.push({
      channel: typeof value.channel === "string" ? value.channel : key,
      policy: value.policy,
      labeled: Array.isArray(label?.confidentiality) &&
        label.confidentiality.length > 0,
    });
  }
  return summaries;
};

const influenceAccumulation: AuditCheck = {
  id: "AUD-8",
  title: "influence accumulation",
  citations: requiredBy("AH-CFC-7", "AH-CFC-8"),
  falsifiedBy:
    "a confidentiality-labeled channel the model read that the run's model context holds no influence entry for, or an influence entry sourced from a channel the same result records as opaque or denied",
  inspect(run) {
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    const influencing = new Set<string>();
    for (const observation of modelContextOf(run)?.observations ?? []) {
      for (const channel of observation.channels) {
        influencing.add(`${observation.toolCallId}:${channel}`);
      }
    }
    const evidence: CheckEvidence[] = [];
    let exposed = 0;
    for (const [index, message] of run.transcript.value.entries()) {
      if (message.role !== "tool") continue;
      for (const summary of channelSummaries(parsedToolContent(message))) {
        const key = `${message.toolCallId}:${summary.channel}`;
        if (summary.policy === "observed" && summary.labeled) {
          exposed += 1;
          if (!influencing.has(key)) {
            evidence.push({
              artifact: "transcript.json",
              pointer: `[${index}].cfc.${summary.channel}`,
              detail:
                `a labeled \`${summary.channel}\` the model read that the run's model context accumulates no influence for`,
            });
          }
          continue;
        }
        if (summary.policy !== "observed" && influencing.has(key)) {
          evidence.push({
            artifact: "run-state.json",
            pointer: "cfcModelContext.observations",
            detail:
              `influence accumulated from the \`${summary.channel}\` of ${message.toolCallId}, which the result records as \`${summary.policy}\``,
          });
        }
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(
            evidence.length,
            "influence entry disagrees",
            "influence entries disagree",
          )
        } with what the transcript says the model was allowed to read`,
        evidence,
      };
    }
    if (exposed === 0 && influencing.size === 0) {
      return {
        verdict: "not-applicable",
        message:
          "this run exposed no labeled observation to the model and accumulated no influence",
      };
    }
    return {
      verdict: "pass",
      message: `the ${
        count(exposed, "labeled channel", "labeled channels")
      } the model read ${
        exposed === 1 ? "is" : "are"
      } accumulated as influence, and no denied or opaque channel is`,
    };
  },
};

//
// AUD-9 evidence retention
//

/** One artifact the claimed mode requires, and whether the run retained it. */
interface RetentionRequirement {
  name: string;
  held: boolean;
  detail: string;
}

/**
 * What became of a run's cell-labels read: the artifact's own state, and, for
 * a run without one, whether the harness tried and failed — which it records
 * on the run — or never asked.
 *
 * The two cases are different facts and {@link cellLabelsSnapshot} reports
 * them differently, so this says which it was rather than only that the
 * artifact is absent.
 */
const cellLabelsRetentionDetail = (run: RunEvidence): string => {
  if (run.cellLabels.status === "present") {
    return "present";
  }
  const failed = runStateOf(run)?.failureRecords?.find((record) =>
    record.source === "cell_labels"
  );
  if (failed !== undefined) {
    return `${run.cellLabels.status}; the read was attempted and failed: ${failed.detail}`;
  }
  return `${run.cellLabels.status}; no read was attempted`;
};

/**
 * The invocation contexts a run minted and no artifact still holds.
 *
 * The mint site numbers a context `contexts.length + 1`, so a run's retained
 * contexts are `1..N` with nothing missing. A hole in that run is a context
 * that was minted and is gone — and it is the only artifact-side witness to a
 * tool losing EVERY context it recorded. Without it, the set of tools that
 * transport CFC evidence is read off the contexts that survived, so a tool
 * whose contexts all vanished leaves that set and reads as host-side: the run
 * looks like one that never went near the substrate rather than one whose
 * evidence went missing. A surviving context for another tool is what hides
 * it, because the run then holds contexts and the warning for a run holding
 * none does not fire either.
 *
 * The numbering is not the model's to influence: it is a host counter, and
 * `invocationContextsOf` reads it across both artifacts that carry the list,
 * so deleting a copy from one of them recovers rather than hides.
 *
 * What this cannot see, and what nothing read from artifacts alone can: a
 * deletion taking the highest-numbered contexts from every artifact at once
 * leaves `1..N` complete for a smaller N, and is indistinguishable from a run
 * that stopped there. A run that retained no context at all is that case at
 * its limit, and AUD-9 warns on it for the same reason.
 */
/**
 * Whether the two artifacts carrying the context list have diverged, as
 * opposed to one of them lagging the other.
 *
 * The union {@link invocationContextsOf} reads is fail-closed for coverage —
 * a context held anywhere is one the run must account for — and it has one
 * blind spot on its own: two artifacts that each lost a DIFFERENT context
 * union back to a complete sequence, so a loss either artifact alone would
 * expose is masked. A trace holding `[1]` beside a run state holding `[2]` is
 * that shape.
 *
 * The test is containment rather than equality, and that is the whole
 * distinction. The trace is written from the run state at each report, so an
 * interrupted run leaves the trace a subset of the live record — a write that
 * did not finish, not evidence that went missing, and failing on it would fire
 * on every killed run. Neither list containing the other is divergence, which
 * no ordinary write order produces.
 */
const invocationContextsDiverge = (run: RunEvidence): boolean => {
  const artifacts = invocationContextArtifacts(run);
  if (artifacts.length < 2) {
    return false;
  }
  const sequencesOf = (index: number): ReadonlySet<number> =>
    new Set(artifacts[index]!.contexts.map((context) => context.sequence));
  const left = sequencesOf(0);
  const right = sequencesOf(1);
  const contains = (
    bigger: ReadonlySet<number>,
    smaller: ReadonlySet<number>,
  ): boolean => [...smaller].every((sequence) => bigger.has(sequence));
  return !contains(left, right) && !contains(right, left);
};

const missingInvocationContexts = (run: RunEvidence): readonly number[] => {
  const retained = invocationContextsOf(run);
  const held = new Set(retained.map((context) => context.sequence));
  const highest = retained.length === 0
    ? 0
    : Math.max(...retained.map((context) => context.sequence));
  const gaps: number[] = [];
  for (let sequence = 1; sequence <= highest; sequence += 1) {
    if (!held.has(sequence)) {
      gaps.push(sequence);
    }
  }
  return gaps;
};

/**
 * AUD-9, which asks whether a run kept the artifacts AH-CFC-16 enumerates.
 *
 * The clause names six: prompt-slot evidence, invocation-context references,
 * mediation dispositions, policy events, model-context influence state, and
 * side-effect decisions. This check is an expression of those and of nothing
 * else, which is why it can cite the clause as `required-by`. A run's
 * cell-labels snapshot is not among them, and asking for it here would have
 * been one check answering to two authorities — the shape AUD-15 and AUD-15a
 * are split along. {@link cellLabelsSnapshot} carries it as `extends`.
 *
 * What AH-CFC-16 obliges a run to retain is bounded by what its execution
 * produced. An invocation context is minted where a call reaches the CFC
 * substrate, so a side effect that never goes near it mints none, and the
 * clause is answered by the artifacts the run does hold. Which side effects
 * could have carried one is read by the classifier AUD-2 uses, so a run that
 * transports evidence for a tool and then calls it carrying none fails both
 * checks: the call is unattested, and what would explain its result is gone.
 *
 * A run that recorded no context at all is the case the artifacts cannot
 * decide. A tool activity states its identity and its effect class and not
 * where it ran, so a run whose side effects were all host-side and a run that
 * lost every context it minted are the same tree, and passing it would report
 * an absence as a clean shape. That run warns, naming the ambiguity as the
 * finding. It is AH-CFC-16's own — retention that cannot be confirmed —
 * beside rather than inside AUD-2's warn on AH-CFC-15, which is about an
 * enforcing claim that went untested.
 */
const evidenceRetention: AuditCheck = {
  id: "AUD-9",
  title: "evidence retention",
  citations: requiredBy("AH-CFC-16"),
  falsifiedBy:
    "an enforcing run missing one of the artifacts AH-CFC-16 enumerates: its policy trace, its policy snapshot or that snapshot's digest, an invocation context for a side effect that reached the CFC substrate, or a hole in the numbering of the contexts it retained; and, as a warning, a run whose side effects recorded no invocation context at all, which its artifacts cannot tell from evidence that was lost",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    const mode = runStateOf(run)!.cfcEnforcementMode;
    const digest = run.policyTrace.status === "present"
      ? run.policyTrace.value.cfcPolicySnapshotDigest
      : runStateOf(run)?.policyTrace?.cfcPolicySnapshotDigest;
    const contexts = invocationContextsOf(run);
    const effects = executedSideEffects(run);
    const unexplained = substrateEffectsMissingContext(run);
    const lostContexts = missingInvocationContexts(run);
    const diverged = invocationContextsDiverge(run);
    const requirements: readonly RetentionRequirement[] = [
      {
        name: "policy-trace.json",
        held: run.policyTrace.status === "present",
        detail: run.policyTrace.status,
      },
      {
        name: "policy-snapshot.json",
        held: run.policySnapshot.status === "present",
        detail: run.policySnapshot.status,
      },
      {
        name: "the policy snapshot's digest",
        held: typeof digest === "string" && digest.length > 0,
        detail: digest === undefined ? "absent" : "present",
      },
      {
        name: "a CFC invocation context",
        held: unexplained.length === 0,
        detail: `${contexts.length} recorded beside ${
          count(effects.length, "executed side effect", "executed side effects")
        }, ${unexplained.length} of which reached the substrate carrying none`,
      },
      {
        name: "the invocation contexts it minted",
        held: lostContexts.length === 0 && !diverged,
        detail: diverged
          ? "the two artifacts carrying the context list have diverged: neither holds everything the other does, so each has lost something the other kept"
          : lostContexts.length === 0
          ? `${contexts.length} retained, numbered without a gap`
          : `${
            count(lostContexts.length, "context", "contexts")
          } the run minted are held by no artifact: ${lostContexts.join(", ")}`,
      },
    ];
    const missing = requirements.filter((requirement) => !requirement.held);
    if (missing.length === 0 && contexts.length === 0 && effects.length > 0) {
      return {
        verdict: "warn",
        message: `retention unconfirmed: none of this run's ${
          count(effects.length, "side effect", "side effects")
        } recorded an invocation context, and its artifacts do not say whether they ran host-side or lost the evidence they minted`,
        evidence: effects.map((activity) => ({
          artifact: "run-report.json",
          pointer: `toolActivity[${activity.sequence}]`,
          detail: `\`${activity.toolId}\` completed with no invocation context`,
        })),
      };
    }
    if (missing.length === 0) {
      return {
        verdict: "pass",
        message:
          "every artifact AH-CFC-16 enumerates is present; what each holds is not read here",
      };
    }
    return {
      verdict: isEnforcing(mode) ? "fail" : "warn",
      message: `this run claims \`${mode}\` and retained none of: ${
        missing.map((requirement) => requirement.name).join("; ")
      }`,
      evidence: missing.map((requirement) => ({
        artifact: requirement.name,
        detail: requirement.detail,
      })),
    };
  },
};

//
// AUD-20 omission accounting
//

/**
 * AUD-20, which accounts for every model-boundary omission without copying
 * the withheld value into the accounting artifact.
 */
const omissionAccounting: AuditCheck = {
  id: "AUD-20",
  title: "omission accounting",
  // OURS: AH-CFC-16 requires enough evidence to explain exposure and denial,
  // but it does not require a per-rule omission accounting artifact.
  citations: extendsClause("AH-CFC-16"),
  falsifiedBy:
    "a duplicated or transcript-mismatched result, a result recording one omission rule more than once, or a rule carrying no withheld location; an absent or unreadable omission artifact is inconclusive",
  inspect(run) {
    if (run.transcriptOmissions.status !== "present") {
      if (run.transcriptOmissions.status === "absent") {
        return {
          verdict: "inconclusive",
          message:
            "this run predates `transcript-omissions.json`, so no per-rule omission count is available",
          evidence: [{
            artifact: "transcript-omissions.json",
            detail: "legacy run",
          }],
        };
      }
      return notReadable(
        "transcript-omissions.json",
        run.transcriptOmissions,
      );
    }
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }

    const errors: CheckEvidence[] = [];
    const counts = Object.fromEntries(
      HARNESS_TRANSCRIPT_OMISSION_RULES.map((rule) => [rule, 0]),
    ) as Record<HarnessTranscriptOmissionRule, number>;
    const outputIds = new Set<string>();
    const recordsByTranscriptResult = new Map<string, number>();

    for (
      const [resultIndex, result] of run.transcriptOmissions.value.results
        .entries()
    ) {
      const pointer = `results[${resultIndex}]`;
      const transcriptResultKey =
        `${result.transcriptIndex}\u0000${result.outputId}`;
      recordsByTranscriptResult.set(
        transcriptResultKey,
        (recordsByTranscriptResult.get(transcriptResultKey) ?? 0) + 1,
      );
      if (outputIds.has(result.outputId)) {
        errors.push({
          artifact: "transcript-omissions.json",
          pointer: `${pointer}.outputId`,
          detail: `output id \`${result.outputId}\` is recorded more than once`,
        });
      }
      outputIds.add(result.outputId);
      const message = run.transcript.value[result.transcriptIndex];
      const provenance = message === undefined
        ? undefined
        : resultProvenanceOf(message);
      if (
        provenance === undefined ||
        provenance.toolCallId !== result.toolCallId ||
        provenance.toolId !== result.toolId ||
        provenance.outputId !== result.outputId
      ) {
        errors.push({
          artifact: "transcript-omissions.json",
          pointer,
          detail: "result identity does not match its transcript message",
        });
      }
      const rules = new Set<HarnessTranscriptOmissionRule>();
      for (const [ruleIndex, rule] of result.rules.entries()) {
        counts[rule.rule] += 1;
        if (rules.has(rule.rule)) {
          errors.push({
            artifact: "transcript-omissions.json",
            pointer: `${pointer}.rules[${ruleIndex}]`,
            detail: `rule \`${rule.rule}\` is recorded more than once`,
          });
        }
        rules.add(rule.rule);
        if (rule.locations.length === 0) {
          errors.push({
            artifact: "transcript-omissions.json",
            pointer: `${pointer}.rules[${ruleIndex}].locations`,
            detail: `rule \`${rule.rule}\` names no withheld location`,
          });
        }
        for (const [locationIndex, location] of rule.locations.entries()) {
          if (location.artifactPath.length === 0) {
            errors.push({
              artifact: "transcript-omissions.json",
              pointer:
                `${pointer}.rules[${ruleIndex}].locations[${locationIndex}].artifactPath`,
              detail: `rule \`${rule.rule}\` names an empty artifact path`,
            });
          }
        }
      }
    }
    for (const [transcriptIndex, message] of run.transcript.value.entries()) {
      const provenance = resultProvenanceOf(message);
      if (provenance === undefined) continue;
      const { outputId } = provenance;
      const matches = recordsByTranscriptResult.get(
        `${transcriptIndex}\u0000${outputId}`,
      ) ?? 0;
      if (matches !== 1) {
        errors.push({
          artifact: "transcript.json",
          pointer: `[${transcriptIndex}].${
            message.role === "user" ? "toolResultProvenance" : "resultRef"
          }`,
          detail: `tool result \`${outputId}\` maps to ${
            count(matches, "omission entry", "omission entries")
          }; exactly one is required`,
        });
      }
    }
    if (errors.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(
            errors.length,
            "omission-accounting error",
            "omission-accounting errors",
          )
        } found`,
        evidence: errors,
      };
    }
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return {
      verdict: "pass",
      message: `${count(total, "omission", "omissions")} recorded: ${
        HARNESS_TRANSCRIPT_OMISSION_RULES.map((rule) =>
          `\`${rule}\` ${counts[rule]}`
        ).join("; ")
      }`,
      evidence: HARNESS_TRANSCRIPT_OMISSION_RULES.map((rule) => ({
        artifact: "transcript-omissions.json",
        detail: `${rule}: ${counts[rule]}`,
      })),
    };
  },
};

//
// AUD-24 cell-labels snapshot
//

/**
 * What a ledger entry for this finding would need. See {@link
 * KnownDefectRegistration}.
 *
 * CT-2210 is the record. Its substance was that AH-CFC-16's enumeration does
 * not include a cell-labels read, so AUD-9 demanding one under a `required-by`
 * citation was the check overclaiming rather than the harness underdelivering
 * — which is closed by this split rather than by any change to what a run
 * records. What the split leaves is this check, and the question of whether
 * its remaining half is worth reporting at all.
 */
const CELL_LABELS_REGISTRATION: KnownDefectRegistration = {
  detail: "recorded no read of its space's cell labels",
  runShape:
    "a run that minted no handle, so the engine never read a cell label for it",
  why:
    "CT-2210's substance — AH-CFC-16 enumerates six categories of evidence and a cell-labels read is not among them, so AUD-9 was overclaiming — is closed by the split that produced this check, not by a change to what a run records. What is left open is narrower and is this check's own: the engine reads a space's cell labels only for the refs its handle table holds, so a run that minted no handle has nothing to record, and whether an audit should report that at all is undecided. Until it is, the check states the fact as `extends` and names where the question sits.",
  issue: "CT-2210",
};

/**
 * AUD-24, which asks whether a run kept a snapshot of the labels its space
 * carried.
 *
 * Cited as `extends`, and the distinction is the whole reason this is its own
 * check. AH-CFC-16's enumeration — prompt-slot evidence, invocation-context
 * references, mediation dispositions, policy events, model-context influence
 * state, side-effect decisions — does not include cell labels. The snapshot is
 * worth having for the same reason those are: without it, a later reading
 * cannot say what the enforcement was enforcing against. That is our judgment
 * about what explains a run, not the clause speaking, and a finding here says
 * so.
 *
 * Two absences, reported differently, because the artifacts distinguish them.
 * A read the run attempted and failed is evidence that was reachable and is
 * gone. A read nobody attempted is a run that never held a ref to ask about —
 * the engine reads labels only for the refs in the handle table — and calling
 * that a lost artifact would report a run's shape as its failure. Which of
 * the two the obligation should want is the open question CT-2210 carries,
 * and until it is settled the check reports the fact and names the issue
 * rather than deciding it.
 */
const cellLabelsSnapshot: AuditCheck = {
  id: "AUD-24",
  title: "cell-labels snapshot",
  citations: extendsClause("AH-CFC-16"),
  falsifiedBy:
    "a run with no cell-labels snapshot: a failure where the run recorded an attempted read whose evidence is now gone, and a warning where it recorded no attempt, which is a run that held no ref to ask about rather than an artifact that was lost",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    const state = runStateOf(run)!;
    if (run.cellLabels.status === "present" || state.cellLabels !== undefined) {
      return {
        verdict: "pass",
        message:
          "this run kept a snapshot of the labels its space carried; what it holds is not read here",
      };
    }
    const attempted = state.failureRecords?.find((record) =>
      record.source === "cell_labels"
    );
    const evidence: readonly CheckEvidence[] = [{
      artifact: "cell-labels.json",
      detail: cellLabelsRetentionDetail(run),
    }];
    if (attempted !== undefined) {
      return {
        verdict: isEnforcing(state.cfcEnforcementMode) ? "fail" : "warn",
        message:
          `this run attempted a cell-labels read and it failed, so what its space carried is not recoverable from these artifacts: ${attempted.detail}`,
        evidence,
      };
    }
    return {
      verdict: "warn",
      message:
        "this run recorded no read of its space's cell labels, and attempted none — the engine reads labels only for the refs a handle table holds, so a run that minted no handle has nothing to record",
      evidence,
      knownDefect: CELL_LABELS_REGISTRATION,
    };
  },
};

//
// AUD-25 labels across a followed link
//

/**
 * The snapshot a run holds, from whichever of the two places carries it.
 *
 * A run writes the snapshot beside itself and records it on its state, so a
 * tree missing one of the two can still be read. {@link cellLabelsSnapshot}
 * accepts either as evidence that a snapshot was kept; this reads what the
 * snapshot SAYS, so it needs the value rather than the artifact's presence.
 */
const cellLabelsOf = (run: RunEvidence): HarnessCellLabels | undefined =>
  run.cellLabels.status === "present"
    ? run.cellLabels.value
    : runStateOf(run)?.cellLabels;

/** One place a snapshot held a link, and the cell record it sat in. */
interface FollowedLink {
  cell: HarnessCellLabelRecord;
  path: readonly string[];
}

/**
 * Every path of a snapshot where the reader had a link to follow out of the
 * cell the run addressed.
 *
 * `origin: "link"` is the label a reference itself carries, so a path holding
 * one is a place the walk had a link to follow. It is the denominator of this
 * check: a run with none reached no second document, so nothing about
 * derivation across a link arises for it.
 */
const followedLinks = (
  labels: HarnessCellLabels,
): readonly FollowedLink[] =>
  labels.cells.flatMap((cell) =>
    cell.entries
      .filter((entry) => entry.origin === "link")
      .map((entry) => ({ cell, path: entry.path }))
  );

/** Whether `path` is `prefix` itself or sits beneath it. */
const under = (
  path: readonly string[],
  prefix: readonly string[],
): boolean =>
  path.length >= prefix.length &&
  prefix.every((segment, index) => segment === path[index]);

/**
 * Whether the snapshot says why the target of `link` went unread.
 *
 * An unread path is tested as a PREFIX of the link rather than as its equal: a
 * reader that stopped at a path read nothing beneath it either, so a shallower
 * entry accounts for every link under it as much as an exact one does.
 */
const linkAccountedFor = (link: FollowedLink): boolean =>
  link.cell.truncationReason !== undefined ||
  (link.cell.unreadPaths ?? []).some((unread) => under(link.path, unread.path));

/**
 * The confidentiality and integrity atoms sitting on cells the run reached
 * THROUGH a link, named.
 *
 * `source` is set on exactly those entries: the label was read off another
 * document and reported under the path that reached it. A sqlite query's
 * result is that shape — each row splits into its own entity doc and the
 * column's label lands there — so these atoms are the ones that crossed from
 * a labeled source into a value the run derived from it.
 */
const derivedAtomNames = (
  links: readonly FollowedLink[],
): readonly string[] => {
  const names = new Set<string>();
  for (const link of links) {
    for (const entry of link.cell.entries) {
      if (entry.source === undefined) continue;
      if (!under(entry.path, link.path)) continue;
      for (const atom of [...entry.confidentiality, ...entry.integrity]) {
        names.add(atom.name);
      }
    }
  }
  return [...names].sort();
};

/**
 * Whether a label a run's source carried reached the value the run derived
 * from it.
 *
 * A labeled column's label is re-established on the far side of the opaque
 * SQLite boundary by the result write, and the row it lands on is its own
 * entity doc — so from the artifact tree the evidence is an entry naming the
 * cell it was read from. AUD-24 establishes that a snapshot was kept and says
 * outright that what it holds is not read there; this reads it, which is what
 * turns "the run recorded its space's labels" into "a label crossed into what
 * the run produced".
 *
 * What it can and cannot tell apart is the reason it warns rather than fails.
 * A snapshot whose followed links all lead to cells holding no label is
 * consistent with two different runs: one that queried nothing labeled, and
 * one where a label failed to derive. The snapshot does not carry the source
 * contract — a database's per-column `ifc` is part of the handle's VALUE, not
 * a label on it — so nothing here can decide between them, and a finding says
 * so rather than picking.
 *
 * A run whose state records no fabric session is `not-applicable` rather than
 * `inconclusive`, and the message says the state rather than the run: the
 * field is also absent where a host injected its own session factory, whose
 * runtime the harness never saw, so the artifacts cannot tell that run from
 * one that ran no session at all.
 *
 * A snapshot that was never READ is `not-applicable` for a different reason,
 * and the reason is which check owns the fact. AUD-24 already reports what
 * became of a run's cell-labels read, failing an enforcing run whose attempt
 * is gone; a second check restating it would put two findings on one fact and
 * would sit at `inconclusive` — below the default threshold — for every run
 * whose space is not a file on this host, which every ephemeral-fabric episode
 * is. So this one declines and names the check that speaks. Declining is not
 * the collapse the cell-labels contract warns about: nothing is asserted about
 * any label here, where reporting the cells as unlabeled would assert one.
 */
const derivedCellLabels: AuditCheck = {
  id: "AUD-25",
  title: "labels across a followed link",
  citations: extendsClause("SQLITE-CFC-read-labels"),
  falsifiedBy:
    "a run whose cell-labels snapshot followed a link and found no label on the far side of any of them, with nothing in the snapshot saying those targets went unread",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    const state = runStateOf(run)!;
    if (state.fabricSessionCfc === undefined) {
      return {
        verdict: "not-applicable",
        message:
          "this run's state records no fabric session, so nothing in its artifacts describes a runtime a value could have been derived in",
        evidence: [{
          artifact: "run-state.json",
          detail: "no `fabricSessionCfc`",
        }],
      };
    }
    if (run.cellLabels.status !== "present" && state.cellLabels === undefined) {
      return notReadable("cell-labels.json", run.cellLabels);
    }
    const labels = cellLabelsOf(run)!;
    if (labels.status !== "read") {
      return {
        verdict: "not-applicable",
        message:
          `the cell-labels snapshot is \`${labels.status}\`, so this run holds no read cell to speak about; whether that snapshot should have been readable is AUD-24's${
            labels.unavailableDetail === undefined
              ? ""
              : ` (${labels.unavailableDetail})`
          }`,
        evidence: [{
          artifact: "cell-labels.json",
          detail: labels.unavailableReason ?? labels.status,
        }],
      };
    }
    const links = followedLinks(labels);
    if (links.length === 0) {
      return {
        verdict: "not-applicable",
        message:
          "the snapshot read this run's cells and none of them holds a link, so no value here was derived across one",
      };
    }
    const atoms = derivedAtomNames(links);
    if (atoms.length > 0) {
      return {
        verdict: "pass",
        message: `${
          count(links.length, "link", "links")
        } this run's cells hold lead to labeled cells, carrying ${
          atoms.join(", ")
        }`,
        evidence: [{
          artifact: "cell-labels.json",
          detail: `atoms on cells reached through a link: ${atoms.join(", ")}`,
        }],
      };
    }
    if (links.every(linkAccountedFor)) {
      return {
        verdict: "inconclusive",
        message: `the snapshot stopped short of every one of the ${
          count(links.length, "link", "links")
        } this run's cells hold, so what they lead to was never read`,
        evidence: [{
          artifact: "cell-labels.json",
          detail: "every followed link is recorded unread or truncated",
        }],
      };
    }
    return {
      verdict: "warn",
      message: `no label crossed any of the ${
        count(links.length, "link", "links")
      } this run's cells hold: either nothing behind them was labeled, or a label did not reach the value derived from it`,
      evidence: [{
        artifact: "cell-labels.json",
        detail:
          `${links.length} followed link(s), 0 entries naming a cell they were read from`,
      }],
    };
  },
};

//
// The registry
//

/** Every Group A check, in id order. */
export const STRUCTURAL_CHECKS: readonly AuditCheck[] = [
  postureConsistency,
  modeBehaviorAttestation,
  decisionCoverage,
  denialChannel,
  handleDiscipline,
  transcriptPairing,
  observeDisclosure,
  influenceAccumulation,
  evidenceRetention,
  omissionAccounting,
  cellLabelsSnapshot,
  derivedCellLabels,
];

/**
 * Runs every check over every run of `family`.
 *
 * A check that throws is a defect in the checker rather than a finding about
 * the run, so it reports `inconclusive` naming the failure: one unhandled
 * shape in one historic tree must not cost the verdicts on every tree after
 * it.
 */
export const auditRunFamily = (
  family: RunFamily,
  checks: readonly AuditCheck[] = STRUCTURAL_CHECKS,
): readonly CheckResult[] => {
  const results: CheckResult[] = [];
  for (const run of familyRuns(family)) {
    for (const check of checks) {
      let outcome: CheckOutcome;
      try {
        outcome = check.inspect(run, family);
      } catch (error) {
        outcome = {
          verdict: "inconclusive",
          message: `the check itself failed on this run: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      results.push({
        checkId: check.id,
        title: check.title,
        runId: run.runId,
        runDir: run.runDir,
        verdict: outcome.verdict,
        message: outcome.message,
        citations: check.citations,
        evidence: outcome.evidence ?? [],
        ...(outcome.knownDefect !== undefined
          ? { knownDefect: outcome.knownDefect }
          : {}),
      });
    }
  }
  return results;
};
