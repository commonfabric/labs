/**
 * The Group D checks: what a corpus of runs, and the deployment they ran
 * against, say together.
 *
 * Every check here is about more than one run, or about something outside the
 * artifact tree entirely, so none of them can be a per-run check the way
 * Group A and Group C are. They are evaluated once per audit invocation, and
 * only when the invocation asks a deployment question — `--corpus`,
 * `--expected-posture`, or `--toolshed-url`. That keeps the per-run audit's
 * exit code meaning what Phase 1 made it mean: an ordinary audit of an
 * artifact tree is not turned red by a question nobody asked.
 */

import type { CfcPostureReport } from "@commonfabric/runner/cfc";

import type { HarnessCfcPolicySnapshot } from "../../src/contracts/cfc-policy-snapshot.ts";
import {
  HARNESS_RELEASE_BOUNDARIES,
  HARNESS_RELEASE_DECISION_REASON_CODES,
  type HarnessReleaseDecisionReasonCode,
} from "../../src/contracts/policy-refusal.ts";
import type { HarnessPolicyDecisionRecord } from "../../src/contracts/policy-trace.ts";
import { type CheckCitation, extendsClause } from "../citations.ts";
import { familyRuns, type RunEvidence, type RunFamily } from "../evidence.ts";
import {
  type ExpectedPosture,
  postureMismatches,
} from "../expected-posture.ts";
import type { CheckEvidence, CheckResult, CheckVerdict } from "../report.ts";

/** The run id a corpus-level finding is stamped with. */
export const CORPUS_RUN_ID = "(corpus)";

/** What a Group D check was given to look at. */
export interface DeploymentAudit {
  /** Every run family the audit loaded, in the order it loaded them. */
  families: readonly RunFamily[];

  /** The paths named on the command line, for a finding to point back at. */
  paths: readonly string[];

  /** The spec `--expected-posture` named, when one was named. */
  expected?: ExpectedPosture;

  /** The `/api/meta` payload `--toolshed-url` fetched, when one was named. */
  toolshedMeta?: ToolshedMeta;

  /** Whether the corpus was declared adversarial (`--expect-refusals`). */
  expectRefusals: boolean;
}

/** What a `/api/meta` fetch established. */
export type ToolshedMeta =
  | { status: "read"; url: string; cfc: CfcPostureReport | null }
  | { status: "unreachable"; url: string; detail: string };

const everyRun = (audit: DeploymentAudit): readonly RunEvidence[] =>
  audit.families.flatMap((family) => [...familyRuns(family)]);

/**
 * The run's policy decisions, from the first artifact that carries a list of
 * them.
 *
 * An artifact that parsed but holds no `decisions` array is not a run that
 * decided nothing: it is an artifact this reader cannot answer from, and
 * falling through to the next one is what keeps a refusal held in the report
 * or the run state from disappearing behind a truncated trace. `undefined`
 * where no artifact carries one.
 */
const decisionsOf = (
  run: RunEvidence,
): readonly HarnessPolicyDecisionRecord[] | undefined => {
  if (
    run.policyTrace.status === "present" &&
    Array.isArray(run.policyTrace.value.decisions)
  ) {
    return run.policyTrace.value.decisions;
  }
  if (
    run.runReport.status === "present" &&
    Array.isArray(run.runReport.value.policyDecisions)
  ) {
    return run.runReport.value.policyDecisions;
  }
  return run.runState.status === "present" &&
      Array.isArray(run.runState.value.policyDecisions)
    ? run.runState.value.policyDecisions
    : undefined;
};

const snapshotOf = (
  run: RunEvidence,
): HarnessCfcPolicySnapshot | undefined =>
  run.policySnapshot.status === "present"
    ? run.policySnapshot.value
    : run.runState.status === "present"
    ? run.runState.value.cfcPolicySnapshot
    : undefined;

const recordOf = (run: RunEvidence): CfcPostureReport | undefined =>
  run.runState.status === "present"
    ? run.runState.value.fabricSessionCfc?.record
    : undefined;

/** A finding about the corpus rather than about one run. */
const corpusResult = (
  audit: DeploymentAudit,
  checkId: string,
  title: string,
  citations: readonly CheckCitation[],
  verdict: CheckVerdict,
  message: string,
  evidence: readonly CheckEvidence[] = [],
): CheckResult => ({
  checkId,
  title,
  runId: CORPUS_RUN_ID,
  runDir: audit.paths.join(", "),
  verdict,
  message,
  citations,
  evidence,
});

const count = (total: number, singular: string, plural: string): string =>
  `${total} ${total === 1 ? singular : plural}`;

//
// AUD-16 refusal liveness
//

/**
 * A release refusal, as a run writes one down.
 *
 * The boundary that refused records a `release` decision in `policy-trace.json`
 * — the same record every tool-policy decision is written as, carrying the
 * gate that refused (`sink-ceiling` is an egress whose confidentiality ceiling
 * the flow exceeded, `writer-fit` a write whose target does not admit what it
 * carries), the sink and ceiling it was fitted against, the offending atoms,
 * and the input keys that carried them in. That is the channel where a label
 * deciding an outcome is legible.
 *
 * The policy-decision REASON CODES alone are NOT that channel, and reading
 * them for this is the mistake to avoid. Every `cfc_observe_*`,
 * `cfc_enforce_*` and `cfc_disabled` code comes from one switch in
 * `prompt-loop.ts` that turns on the tool descriptor's static `effectClass`
 * and on whether the invocation carries direct-command evidence — authority,
 * not a label — and the loop records its allow-side decision before the tool
 * runs. What tells a release decision apart is the `release` record on it,
 * which only a boundary that consulted a label writes.
 */
interface ReleaseRefusal {
  runId: string;
  source: string;
  sequence: number;
  gates: readonly string[];
  sinks: readonly string[];
}

/**
 * The reason a release entry records, or `undefined` where a decision carries
 * no release at all.
 *
 * A release entry is written whenever the boundary measured a result, and its
 * `reasonCode` is the fact: `cfc_release_withheld` where values were held back,
 * `cfc_release_allowed` or `cfc_release_observed` where they were not. The
 * decision's own outcome word is a presentation of that fact and has changed
 * before, so a counter that keys on the word counts nothing the day it moves.
 * The reason code is what these checks read.
 */
const releaseReasonOf = (
  decision: HarnessPolicyDecisionRecord,
): HarnessReleaseDecisionReasonCode | undefined => {
  const release = decision.release as
    | { reasonCode?: unknown; boundary?: unknown }
    | null
    | undefined;
  // `null` as well as absent: a decision persisted with an empty release is a
  // record this cannot read, and dereferencing it would throw before the check
  // could reach a verdict about the run.
  if (release === null || release === undefined) return undefined;
  // Both discriminants are checked against the sets the contract exports for
  // the purpose, rather than against literals repeated here: a closed union
  // that gains a member should widen what this reads, not silently stop
  // matching a record the contract calls valid.
  const boundary = HARNESS_RELEASE_BOUNDARIES.find((known) =>
    known === release.boundary
  );
  if (boundary === undefined) return undefined;
  return HARNESS_RELEASE_DECISION_REASON_CODES.find((known) =>
    known === release.reasonCode
  );
};

/**
 * Every release refusal one run's decisions record.
 *
 * A decision that measured the boundary and released, and one an observe-stage
 * posture measured without acting on, are decisions too — they are what says
 * the boundary ran — but neither is a refusal, so neither is counted here.
 */
const releaseRefusalsOf = (
  run: RunEvidence,
): readonly ReleaseRefusal[] =>
  (decisionsOf(run) ?? [])
    .filter((decision) => releaseReasonOf(decision) === "cfc_release_withheld")
    .map((decision) => ({
      runId: run.runId,
      source: sourceOf(run),
      sequence: decision.sequence,
      gates: decision.release?.refusal?.gates ?? [],
      sinks: sinksOf(decision.release!),
    }));

/**
 * The sinks a decision refused at: the ones the refusal names, and otherwise
 * the one the harness fitted against. A commit refusal names its own; a
 * release refusal the harness measured carries the sink on the decision.
 */
const sinksOf = (
  release: NonNullable<HarnessPolicyDecisionRecord["release"]>,
): readonly string[] => {
  const named = release.refusal?.sinks ?? [];
  return named.length > 0
    ? named
    : release.sink === undefined
    ? []
    : [release.sink];
};

/** Every release refusal the corpus recorded. */
const labelDrivenRefusals = (
  audit: DeploymentAudit,
): readonly ReleaseRefusal[] => everyRun(audit).flatMap(releaseRefusalsOf);

/** Release measurements that refused nothing, which say the boundary ran. */
const releasesMeasured = (audit: DeploymentAudit): number =>
  everyRun(audit).reduce(
    (total, run) =>
      total +
      (decisionsOf(run) ?? []).filter((decision) => {
        const reason = releaseReasonOf(decision);
        // Only the two non-rejecting codes. `cfc_commit_refused` names a
        // boundary that refused at the pattern's own sink requests, so
        // counting it beside the allowed ones would report a refusal as a
        // measurement that let the values out.
        return reason === "cfc_release_allowed" ||
          reason === "cfc_release_observed";
      }).length,
    0,
  );

/** Every denial of the corpus an authority rather than a label decided. */
const allDenials = (audit: DeploymentAudit): number =>
  everyRun(audit).reduce(
    (total, run) =>
      total +
      (decisionsOf(run) ?? []).filter((decision) =>
        decision.decision === "denied" && decision.release === undefined
      ).length,
    0,
  );

/** Which artifact a run's decisions were read from, for a finding to cite. */
const sourceOf = (run: RunEvidence): string =>
  run.policyTrace.status === "present" &&
    Array.isArray(run.policyTrace.value.decisions)
    ? "policy-trace.json"
    : run.runReport.status === "present" &&
        Array.isArray(run.runReport.value.policyDecisions)
    ? "run-report.json"
    : "run-state.json";

/**
 * Runs whose decisions this host could not read from any artifact.
 *
 * A run that answers `undefined` to {@link decisionsOf} said nothing about
 * its decisions anywhere — every artifact that would carry them is missing,
 * unparseable, or parsed without the list. None of those is an empty channel,
 * and reporting them as one would answer "no refusal here" to a question this
 * host cannot see the evidence for.
 */
const unreadableDecisions = (
  audit: DeploymentAudit,
): readonly RunEvidence[] =>
  everyRun(audit).filter((run) => decisionsOf(run) === undefined);

const refusalLiveness = (audit: DeploymentAudit): CheckResult => {
  const refusals = labelDrivenRefusals(audit);
  const runs = everyRun(audit);
  const unreadable = unreadableDecisions(audit);
  const notAttested = runs.filter((run) =>
    snapshotOf(run)?.cfc.substrateStatus === "not-attested"
  );
  const permissive = runs.filter((run) =>
    snapshotOf(run)?.cfc.absenceBehavior === "permissive-if-absent"
  );
  const gates = [...new Set(refusals.flatMap((refusal) => refusal.gates))]
    .sort();
  const sinks = [...new Set(refusals.flatMap((refusal) => refusal.sinks))]
    .sort();
  const evidence: CheckEvidence[] = [
    {
      artifact: "policy-trace.json",
      pointer: "decisions[].release",
      detail: `${
        count(refusals.length, "release refusal", "release refusals")
      } across ${count(runs.length, "run", "runs")}${
        gates.length === 0 ? "" : ` (gates: ${gates.join(", ")})`
      }${sinks.length === 0 ? "" : ` (sinks: ${sinks.join(", ")})`}`,
    },
    {
      artifact: "policy-trace.json",
      pointer: "decisions[].release",
      detail: `${
        count(
          releasesMeasured(audit),
          "release the same boundary measured and did not refuse",
          "releases the same boundary measured and did not refuse",
        )
      }`,
    },
    {
      detail: `${
        count(allDenials(audit), "tool-policy denial", "tool-policy denials")
      } beside them, which decide on authority rather than on a label`,
    },
    {
      artifact: "policy-snapshot.json",
      pointer: "cfc.substrateStatus",
      detail: `${
        count(notAttested.length, "run", "runs")
      } recorded \`not-attested\``,
    },
    {
      artifact: "policy-snapshot.json",
      pointer: "cfc.absenceBehavior",
      detail: `${
        count(permissive.length, "run", "runs")
      } recorded \`permissive-if-absent\``,
    },
  ];
  if (unreadable.length > 0) {
    // The channel exists and this host could not read it here, which is not
    // the same fact as an empty channel and must not report as one.
    return corpusResult(
      audit,
      "AUD-16",
      "refusal liveness",
      extendsClause("AH-CFC-11", "AH-CFC-15"),
      "inconclusive",
      `the policy decisions of ${
        count(unreadable.length, "run", "runs")
      } could not be read, so whether this corpus holds a release refusal is not established`,
      evidence,
    );
  }
  if (refusals.length === 0) {
    return corpusResult(
      audit,
      "AUD-16",
      "refusal liveness",
      extendsClause("AH-CFC-11", "AH-CFC-15"),
      audit.expectRefusals ? "fail" : "warn",
      audit.expectRefusals
        ? `this corpus was declared adversarial and its ${
          count(runs.length, "run", "runs")
        } recorded no release refusal at all, so nothing here shows a label deciding an outcome`
        : `no run of this corpus recorded a release refusal, so the corpus shows the machinery loaded and never shows it deciding; ${
          count(notAttested.length, "run", "runs")
        } recorded \`not-attested\` and ${
          count(permissive.length, "run", "runs")
        } \`permissive-if-absent\``,
      evidence,
    );
  }
  const weakened = notAttested.length > 0 || permissive.length > 0;
  return corpusResult(
    audit,
    "AUD-16",
    "refusal liveness",
    extendsClause("AH-CFC-11", "AH-CFC-15"),
    weakened ? "warn" : "pass",
    `${count(refusals.length, "release refusal", "release refusals")} across ${
      count(runs.length, "run", "runs")
    }${gates.length === 0 ? "" : `, refused by ${gates.join(", ")}`}${
      weakened
        ? `, weakened by ${
          count(notAttested.length, "run", "runs")
        } recording \`not-attested\` and ${
          count(permissive.length, "run", "runs")
        } \`permissive-if-absent\``
        : ""
    }`,
    evidence,
  );
};

//
// AUD-17 toolshed posture
//

const toolshedPosture = (audit: DeploymentAudit): CheckResult | undefined => {
  const meta = audit.toolshedMeta;
  if (meta === undefined) return undefined;
  const citations = extendsClause("AH-CFC-14", "AH-CFC-15");
  if (meta.status === "unreachable") {
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "inconclusive",
      `\`${meta.url}\` could not be read (${meta.detail}), so nothing about the deployment's posture was established`,
    );
  }
  if (meta.cfc === null) {
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "fail",
      `\`${meta.url}\` publishes no posture, so what this deployment enforces is indistinguishable from the default`,
      [{ artifact: "/api/meta", pointer: "cfc", detail: "null" }],
    );
  }
  if (meta.cfc.provenance !== "resolved") {
    // A deployment publishing anything but an attestation has published what
    // it expects to be at, or what some other host is at, rather than what it
    // is at, and a client adopting it would be adopting one of those.
    // `/api/meta` is served from a constructed Runtime, so this cannot be a
    // shape the route produces — it is a deployment answering the question
    // with the wrong kind of record.
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "fail",
      `\`${meta.url}\` publishes a \`${meta.cfc.provenance}\` posture, which is what a runtime is expected to resolve or what another host resolved, rather than what this one attested`,
      [{
        artifact: "/api/meta",
        pointer: "cfc.provenance",
        detail: meta.cfc.provenance,
      }],
    );
  }
  if (audit.expected === undefined) {
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "warn",
      `\`${meta.url}\` publishes a posture, but no expected-posture spec was named for it to be compared against`,
      [{
        artifact: "/api/meta",
        pointer: "cfc.enforcementMode.rung",
        detail: meta.cfc.enforcementMode.rung,
      }],
    );
  }
  const mismatches = postureMismatches(audit.expected, meta.cfc);
  if (mismatches.length === 0) {
    return corpusResult(
      audit,
      "AUD-17",
      "toolshed posture",
      citations,
      "pass",
      `\`${meta.url}\` publishes a posture satisfying every field the spec asserts`,
    );
  }
  return corpusResult(
    audit,
    "AUD-17",
    "toolshed posture",
    citations,
    "fail",
    `\`${meta.url}\` publishes a posture that misses ${
      count(
        mismatches.length,
        "field the spec asserts",
        "fields the spec asserts",
      )
    }`,
    mismatches.map((mismatch) => ({
      artifact: "/api/meta",
      pointer: `cfc.${mismatch.field}`,
      detail: `expected ${mismatch.expected}, found ${mismatch.found}`,
    })),
  );
};

//
// AUD-18 posture uniformity across the corpus
//
// Named for what it reads. A run artifact carries no surface identity, so
// this compares the DISTINCT posture records a corpus holds and cannot say
// which surface produced which. Comparing a deployment's published record
// against a harness run's is a different check, and needs a surface tag the
// artifacts do not yet carry.
//

/**
 * The distinct postures the corpus recorded, each with the runs that recorded
 * it, keyed by the posture's JSON.
 *
 * The key leaves out the provenance, which says how a run came by its record
 * rather than what the posture is. A delegated child runs on its parent's
 * session and republishes its parent's record as `inherited`, so keying on
 * the stamp would count one posture as two and report a divergence where one
 * runtime served both.
 */
const distinctPostures = (
  audit: DeploymentAudit,
): ReadonlyMap<string, { record: CfcPostureReport; runIds: string[] }> => {
  const byPosture = new Map<
    string,
    { record: CfcPostureReport; runIds: string[] }
  >();
  for (const run of everyRun(audit)) {
    const record = recordOf(run);
    if (record === undefined) continue;
    const { provenance: _provenance, ...posture } = record;
    const key = JSON.stringify(posture);
    const held = byPosture.get(key);
    if (held === undefined) {
      byPosture.set(key, { record, runIds: [run.runId] });
    } else {
      held.runIds.push(run.runId);
    }
  }
  return byPosture;
};

const postureUniformity = (audit: DeploymentAudit): CheckResult => {
  const citations = extendsClause("AH-CFC-14", "AH-CFC-15");
  const records = distinctPostures(audit);
  if (records.size === 0) {
    return corpusResult(
      audit,
      "AUD-18",
      "posture uniformity",
      citations,
      "inconclusive",
      "no run of this corpus recorded a posture record, so there was nothing to compare",
    );
  }
  const evidence: CheckEvidence[] = [...records.values()].map((
    { record, runIds },
  ) => ({
    detail: `${runIds.length} run(s) — ${
      runIds.join(", ")
    } — at ${record.enforcementMode.rung} / flow ${record.flowLabels.rung}`,
  }));
  const mismatched = audit.expected === undefined
    ? []
    : [...records.values()].flatMap(({ record, runIds }) =>
      postureMismatches(audit.expected!, record).map((mismatch) => ({
        runIds,
        mismatch,
      }))
    );
  if (mismatched.length > 0) {
    return corpusResult(
      audit,
      "AUD-18",
      "posture uniformity",
      citations,
      "fail",
      `${
        count(records.size, "posture record", "distinct posture records")
      } in this corpus, and ${
        count(mismatched.length, "field", "fields")
      } of the spec is not satisfied by all of them`,
      mismatched.map(({ runIds, mismatch }) => ({
        pointer: mismatch.field,
        detail: `${
          runIds.join(", ")
        }: expected ${mismatch.expected}, found ${mismatch.found}`,
      })),
    );
  }
  if (records.size > 1) {
    return corpusResult(
      audit,
      "AUD-18",
      "posture uniformity",
      citations,
      "warn",
      `this corpus holds ${
        count(records.size, "posture record", "distinct posture records")
      }; the harness's own surfaces diverge by default — the console opts every session into the max-enforcement bundle and the CLI leaves the fleet posture unless \`--fabric-cfc-posture\` says otherwise — so a corpus mixing them records two postures for one harness`,
      evidence,
    );
  }
  return corpusResult(
    audit,
    "AUD-18",
    "posture uniformity",
    citations,
    "pass",
    "every run of this corpus that recorded a posture recorded the same one",
    evidence,
  );
};

/** Every Group D finding, in id order. */
export const auditDeployment = (
  audit: DeploymentAudit,
): readonly CheckResult[] => {
  const results: CheckResult[] = [refusalLiveness(audit)];
  const toolshed = toolshedPosture(audit);
  if (toolshed !== undefined) {
    results.push(toolshed);
  }
  results.push(postureUniformity(audit));
  return results;
};
