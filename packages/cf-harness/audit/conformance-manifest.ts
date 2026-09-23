/**
 * Where `@commonfabric/cf-harness` stands against `CfcAgentHarnessProfile`, as
 * data the audit reads and prints rather than as prose in a document nobody
 * re-reads.
 *
 * This file is the source of that position. `docs/IMPLEMENTATION_PROFILE.md`
 * points at it and does not restate a status, because two encodings of one
 * truth is the disease this audit exists to document: a consistency check
 * across two copies cannot detect a consistent wrong answer, and the copy
 * nobody runs is the one that goes stale.
 *
 * The manifest is itself audited. Where an obligation names covering checks,
 * {@link reconcileConformanceManifest} holds its status to their verdicts, and
 * a disagreement is a failure of the audit run. Without that, a manifest is
 * prose in a new file format: it could assert `mechanized` about an obligation
 * whose check has been failing for a month, and nothing would say so. The
 * direction that matters most is the one that catches good news — an
 * obligation still recorded as unmet whose every covering check now passes is
 * a gap that closed while the manifest stood still.
 *
 * An obligation with no covering check is NOT reconciled, and the report says
 * so rather than counting it as agreement. Four of the nine are in that state
 * and one of them (H3) is `mechanized` by the type system rather than by
 * anything an artifact tree can show; calling those "agreeing" would report
 * the absence of a check as a check that passed, which is the same error
 * `inconclusive` exists to prevent.
 */

import type { CheckResult, CheckVerdict } from "./report.ts";

/**
 * The document the obligations are quoted from.
 *
 * The CFC specification lives in another repository, so a quote from it cannot
 * carry the guarantee `citations.ts` gives an in-tree clause: nothing here can
 * re-read the document and break when the words change. The pin is one
 * constant rather than one per obligation, so moving it is a single visible
 * edit and the re-derivation it calls for is recorded in
 * `docs/specs/agent-harness/04-cfc-spec-correspondence.md`.
 *
 * The trade-off taken, stated so a reader is not misled about which authority
 * is guarded: a CFC clause can be reworded without anything in this repository
 * noticing.
 */
export const CFC_PROFILE_SOURCE = {
  repo: "commonfabric/specs",
  commit: "8b8613ea",
  section: "cfc/18-runtime-implementation-profiles.md §18.3.3",
  profile: "CfcAgentHarnessProfile",
} as const;

/**
 * How well an obligation is answered.
 *
 * `mechanized` is the only status that claims something breaks when the answer
 * stops being true, and it is deliberately the hardest to hold: an obligation
 * satisfied by inspection is `documented`, which is a claim a reader has to
 * take on trust.
 */
export type ObligationStatus =
  | "mechanized"
  | "documented"
  | "partial"
  | "absent";

/** Whether an obligation at this status is answered as the profile asks. */
export const statusSatisfies = (status: ObligationStatus): boolean =>
  status === "mechanized" || status === "documented";

/** One §18.3.3 obligation, and where this package stands on it. */
export interface ConformanceObligation {
  /** Stable id, as the gap analysis and the audit's findings name it. */
  id: string;

  /** The obligation, in the specification's own words. */
  obligation: string;

  status: ObligationStatus;

  /** What is and is not built, in one or two sentences. */
  account: string;

  /** Where in the tree the answer lives, so a reader can go and read it. */
  evidence: readonly string[];

  /**
   * The audit checks whose verdicts this status is held to.
   *
   * Empty means the audit establishes nothing about this obligation, and the
   * reconciliation reports it that way rather than as agreement.
   */
  coveredBy: readonly string[];

  /** Where the work is tracked. */
  issue: string;
}

/**
 * Every §18.3.3 obligation, in the order the checklist states them.
 *
 * `CT-2178` is the arc these were mapped under, and is the issue for the
 * obligations that have no narrower one yet. An obligation whose work is
 * scheduled on its own issue names that instead.
 */
export const CFC_HARNESS_OBLIGATIONS: readonly ConformanceObligation[] = [
  {
    id: "H1",
    obligation:
      "which prompt/input surfaces can mint `PromptSlotBound` evidence and which roles each surface may mint",
    status: "documented",
    account:
      "Two surfaces mint, both through `createCliPromptSlotBinding`, and the role set is a closed union validated on the way in. Nothing restricts which role which surface may mint, which is the per-surface restriction the obligation's wording anticipates.",
    evidence: [
      "src/contracts/prompt-slot.ts",
      "src/cli.ts",
      "console/server.ts",
    ],
    coveredBy: [],
    issue: "CT-2178",
  },
  {
    id: "H2",
    obligation:
      "how UI, CLI, and API input-capture records bind subject, surface, value digest, role, and kernel name",
    status: "partial",
    account:
      "`kernelName`, `surface` and `role` are bound. No mint site populates a `valueDigest`, and the CLI binds a resume-run id or a workspace path into the field reserved for an authenticated subject. The contract already types the missing fields; the work is at the two mint sites.",
    evidence: [
      "src/contracts/prompt-slot.ts",
      "src/cli.ts",
      "console/server.ts",
    ],
    coveredBy: ["AUD-22"],
    issue: "CT-2216",
  },
  {
    id: "H3",
    obligation:
      "how direct-command evidence is kept unforgeable by application code, model output, sandboxed tools, and free-form documents",
    status: "mechanized",
    account:
      "Four mechanisms, each of which breaks something if removed: the binding is never a field of a tool input schema, a skill's prompt role is pinned to `context` at the type level, what the invocation context records is a `PromptSlotInfluence` integrity atom rather than a `PromptSlotBound` one, and the runner strips a pattern-authored `PromptSlotBound` from a declared label. All four are held by the type system and by package tests, so no audit check reads them.",
    evidence: [
      "src/contracts/skill.ts",
      "src/contracts/cfc-invocation-context.ts",
      "../runner/src/cfc/prepare.ts",
    ],
    coveredBy: [],
    issue: "CT-2178",
  },
  {
    id: "H4",
    obligation:
      "how tool descriptor and measured-contract registry snapshots are issued, accepted, expired, revoked, and bound to invocations",
    status: "absent",
    account:
      "There are no snapshots. The tool registry is a compile-time map and a descriptor carries no digest, so no invocation pins one. `acquire_skill` is the one dynamic acquisition path and does record issuance-grade provenance, which is binding without acceptance, expiry or revocation, and does not extend to tools.",
    evidence: [
      "src/tools/registry.ts",
      "src/contracts/tool-descriptor.ts",
      "src/contracts/skill.ts",
    ],
    coveredBy: [],
    issue: "CT-2178",
  },
  {
    id: "H5",
    obligation:
      "which descriptor fields are low-observable by default and which are protected by policy state or tool-availability labels",
    status: "absent",
    account:
      "Descriptor fields carry no observation labels and there is no low-safe descriptor view. Tool availability is narrowed — a tool the run cannot back is absent rather than present-and-failing — so a model cannot probe for hidden availability, but that is an ergonomic property rather than a labeling decision.",
    evidence: ["src/contracts/tool-descriptor.ts"],
    coveredBy: [],
    issue: "CT-2178",
  },
  {
    id: "H6",
    obligation:
      "how free-form tool documentation is kept separate from structured capability metadata",
    status: "partial",
    account:
      "Separated for skills, mechanically: a skill's text is a labeled document read under the `context` prompt role with a registry digest, an observed digest and a match flag recorded beside it. Not separated for tools: a descriptor's `description` is a plain string inside the same record as its effect class and schema, with no `docRef` and no opaque-handle path.",
    evidence: ["src/contracts/skill.ts", "src/contracts/tool-descriptor.ts"],
    coveredBy: [],
    issue: "CT-2178",
  },
  {
    id: "H7",
    obligation:
      "how opaque handles are passed to tools and subagents without revealing hidden payload bytes to the parent agent",
    status: "partial",
    account:
      "The address form is built and disciplined, and covered by AUD-5. The opaque handle over bytes is half-built: six sites mint a handle for a blocked observation and no code reads a `handleId`, so the token identifies a denial rather than conferring a capability and the recovery flow cannot be run end to end. Whether a given run needed to resolve one is not something artifacts can say, which is why no check covers this half — see `whyNotChecked` in the audit's README.",
    evidence: [
      "src/handle-table.ts",
      "src/prompt-loop.ts",
      "src/contracts/handle-table.ts",
    ],
    coveredBy: [],
    issue: "CT-2178",
  },
  {
    id: "H8",
    obligation:
      "how subagent ceilings and observation policies are applied before inherited handles are resolved",
    status: "mechanized",
    account:
      "A child shares its parent's fabric session and resolved observation ceiling. The delegation manifest records inheritance without revealing label atoms. Cell and transaction reads withhold a referenced payload outside that ceiling before it reaches the child; AUD-23 compares the parent and child runtime records. An absent ceiling inherits the owner's view.",
    evidence: [
      "src/contracts/subagent.ts",
      "src/prompt-loop.ts",
      "../runner/src/cfc/read-ceiling.ts",
      "test/prompt-loop-subagent-handles.test.ts",
    ],
    coveredBy: ["AUD-23"],
    issue: "CT-2217",
  },
  {
    id: "H9",
    obligation:
      "how side-effecting tool calls bottom out in the same sink-specific intent and commit-point checks used outside the agent harness",
    status: "partial",
    account:
      "`run_pattern` bottoms out where the clause asks: it measures its release against a named sink and an explicit ceiling and returns the commit boundary's refusal as structured evidence. No other side-effecting tool does. The gate the rest pass through turns on the descriptor's static effect class crossed with whether the run carries a direct-command binding, records its decision before the tool runs, and consults no sink, no ceiling and no label — a gate on who asked, where the clause asks for a gate on what is flowing.",
    evidence: [
      "src/tools/run-pattern.ts",
      "src/prompt-loop.ts",
      "../runner/src/cfc/sink-inventory.ts",
    ],
    coveredBy: ["AUD-21", "AUD-14"],
    issue: "CT-2175",
  },
];

/** How many obligations sit at each status. */
export const countObligationStatuses = (
  obligations: readonly ConformanceObligation[] = CFC_HARNESS_OBLIGATIONS,
): Record<ObligationStatus, number> => {
  const counts: Record<ObligationStatus, number> = {
    mechanized: 0,
    documented: 0,
    partial: 0,
    absent: 0,
  };
  for (const obligation of obligations) {
    counts[obligation.status] += 1;
  }
  return counts;
};

/** What holding one obligation's status to its checks' verdicts established. */
export interface ObligationReconciliation {
  obligation: ConformanceObligation;

  /**
   * `unreconciled` where no covering check reported a verdict this run — the
   * obligation names none, or every one of them was `inconclusive` or
   * `not-applicable`. It is not agreement, and is never counted as one.
   */
  outcome: "agrees" | "disagrees" | "unreconciled";

  /** What the covering checks reported, worst verdict per check. */
  verdicts: Readonly<Record<string, CheckVerdict>>;

  /** Why the outcome is what it is, in one sentence. */
  detail: string;
}

/** What holding the whole manifest to the run's verdicts established. */
export interface ManifestReconciliation {
  obligations: readonly ObligationReconciliation[];
  counts: Record<ObligationStatus, number>;
  disagreements: readonly ObligationReconciliation[];
}

/** Whether a verdict is one the covering check reported anything with. */
const reported = (verdict: CheckVerdict): boolean =>
  verdict === "pass" || verdict === "fail" || verdict === "warn";

/** The worst verdict each covering check reached over `results`. */
const worstVerdicts = (
  obligation: ConformanceObligation,
  results: readonly CheckResult[],
): Record<string, CheckVerdict> => {
  const severity: Record<CheckVerdict, number> = {
    fail: 4,
    warn: 3,
    inconclusive: 2,
    "not-applicable": 1,
    pass: 0,
  };
  const worst: Record<string, CheckVerdict> = {};
  for (const result of results) {
    if (!obligation.coveredBy.includes(result.checkId)) continue;
    const held = worst[result.checkId];
    if (held === undefined || severity[result.verdict] > severity[held]) {
      worst[result.checkId] = result.verdict;
    }
  }
  return worst;
};

/**
 * Holds every obligation's status to the verdicts of the checks covering it.
 *
 * The rule in both directions. An obligation the manifest records as answered
 * — `mechanized` or `documented` — must have every covering check passing, or
 * the manifest is claiming something the audit is contradicting. An obligation
 * it records as unmet — `partial` or `absent` — must have at least one covering
 * check still reporting a finding, or the gap closed and the manifest did not
 * move with it.
 *
 * The second half is the one that keeps this honest over time. A manifest that
 * only failed when it overclaimed would let every entry sit at `absent`
 * forever, describing a system that had since been fixed, and the register
 * would stop being a progress signal.
 */
export const reconcileConformanceManifest = (
  results: readonly CheckResult[],
  obligations: readonly ConformanceObligation[] = CFC_HARNESS_OBLIGATIONS,
): ManifestReconciliation => {
  const reconciled = obligations.map((obligation) => {
    const verdicts = worstVerdicts(obligation, results);
    const speaking = Object.entries(verdicts).filter(([, verdict]) =>
      reported(verdict)
    );
    if (speaking.length === 0) {
      return {
        obligation,
        outcome: "unreconciled" as const,
        verdicts,
        detail: obligation.coveredBy.length === 0
          ? "no audit check covers this obligation, so nothing here establishes its status"
          : `every covering check (${
            obligation.coveredBy.join(", ")
          }) was inconclusive or not-applicable over these runs`,
      };
    }
    const findings = speaking.filter(([, verdict]) => verdict !== "pass");
    if (statusSatisfies(obligation.status)) {
      return findings.length === 0
        ? {
          obligation,
          outcome: "agrees" as const,
          verdicts,
          detail:
            `recorded \`${obligation.status}\`, and every covering check passed`,
        }
        : {
          obligation,
          outcome: "disagrees" as const,
          verdicts,
          detail:
            `recorded \`${obligation.status}\`, and the audit is contradicting it: ${
              findings.map(([checkId, verdict]) => `${checkId} ${verdict}`)
                .join(", ")
            }`,
        };
    }
    return findings.length > 0
      ? {
        obligation,
        outcome: "agrees" as const,
        verdicts,
        detail: `recorded \`${obligation.status}\`, and ${
          findings.map(([checkId, verdict]) => `${checkId} ${verdict}`).join(
            ", ",
          )
        } is still reporting it`,
      }
      : {
        obligation,
        outcome: "disagrees" as const,
        verdicts,
        detail: `recorded \`${obligation.status}\`, and every covering check (${
          speaking.map(([checkId]) => checkId).join(", ")
        }) now passes — the gap closed and the manifest did not move with it`,
      };
  });
  return {
    obligations: reconciled,
    counts: countObligationStatuses(obligations),
    disagreements: reconciled.filter((one) => one.outcome === "disagrees"),
  };
};

/** The one-line position, which every audit run prints. */
export const renderConformancePosition = (
  reconciliation: ManifestReconciliation,
): string => {
  const { counts } = reconciliation;
  const answered = counts.mechanized + counts.documented;
  const total = reconciliation.obligations.length;
  const headline = answered === total
    ? `${CFC_PROFILE_SOURCE.profile}: every one of ${total} obligations is answered`
    : `${CFC_PROFILE_SOURCE.profile} is NOT satisfied by @commonfabric/cf-harness — ${answered} of ${total} obligations answered`;
  const lines = [
    headline,
    `  mechanized ${counts.mechanized}  documented ${counts.documented}  partial ${counts.partial}  absent ${counts.absent}`,
    `  ${CFC_PROFILE_SOURCE.section}, pinned at ${CFC_PROFILE_SOURCE.repo}@${CFC_PROFILE_SOURCE.commit} (external: not drift-guarded)`,
  ];
  for (const one of reconciliation.obligations) {
    const covering = one.obligation.coveredBy.length === 0
      ? "no covering check"
      : one.obligation.coveredBy.join(", ");
    lines.push(
      `  ${one.obligation.id} ${one.obligation.status} [${covering}] — ${one.outcome}: ${one.detail}`,
    );
  }
  if (reconciliation.disagreements.length > 0) {
    lines.push(
      `  ${reconciliation.disagreements.length} obligation(s) disagree with the checks covering them; the manifest is wrong or the checks are`,
    );
  }
  return lines.join("\n");
};

/** Whether the manifest's own audit failed. */
export const manifestReconciliationFails = (
  reconciliation: ManifestReconciliation,
): boolean => reconciliation.disagreements.length > 0;
