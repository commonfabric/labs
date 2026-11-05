/**
 * What one audit check says about one run, and how a set of those verdicts
 * decides whether the audit passed.
 *
 * The verdict vocabulary is what keeps the audit honest. `inconclusive` is
 * the verdict for a check whose evidence was absent — it is never `pass`,
 * because a check that could not look at anything has not found anything.
 * `not-applicable` is narrower and stronger: the evidence was there and said
 * the check's subject does not arise in this run.
 */

import type { CheckCitation } from "./citations.ts";

/**
 * How a check turned out.
 *
 * - `pass` — the check looked at the evidence its clause names and found it
 *   consistent with the clause.
 * - `fail` — the evidence contradicts the clause.
 * - `warn` — the evidence is consistent with the clause but the run's own
 *   posture makes the assurance weaker than an enforcing run's.
 * - `inconclusive` — an artifact the check needs is absent or unparseable,
 *   so nothing was established either way.
 * - `not-applicable` — the evidence is present and says the check's subject
 *   does not arise in this run.
 */
export type CheckVerdict =
  | "pass"
  | "fail"
  | "warn"
  | "inconclusive"
  | "not-applicable";

/** One thing the check read, and where a reader can go and read it too. */
export interface CheckEvidence {
  /**
   * Where the fact sits, as an artifact-relative path and a position inside
   * it: `policy-trace.json decisions[3]`, `transcript.json messages[7]`. A
   * fact that is about the run family rather than about one file omits it.
   */
  pointer?: string;

  /** The artifact the pointer is into, relative to the run directory. */
  artifact?: string;

  /** What that position says, in the check's own words. */
  detail: string;
}

/**
 * What a known-defect finding says about itself so that recording it in a
 * nightly's expected-failures ledger is data entry rather than rediscovery.
 *
 * A Group E check fails by design until its defect is fixed, so a nightly that
 * runs the audit has to be told which of its findings were already known. That
 * ledger's entries carry a check id, the run shape, a substring of the
 * finding's message to match on, the reason it is open, and the issue. Every
 * one of those except the run selector is something the check knows and the
 * person writing the entry would otherwise have to reconstruct by reading the
 * check's source and guessing which part of a message is stable.
 *
 * {@link CheckResult.runId} is the sixth field: an entry's selector is an
 * anchored expression over the run id, and this is the id to write one from.
 */
export interface KnownDefectRegistration {
  /**
   * A substring of the finding's `message` that does not vary between runs.
   *
   * A message carries counts, and an entry matching on a count would stop
   * matching the moment a run made one more call. This is the part that does
   * not move, and `test/known-defects.test.ts` holds every finding to it being
   * genuinely a substring of the message beside it — an entry copied from a
   * finding whose detail was not in the message would match nothing and be
   * reported stale forever.
   */
  detail: string;

  /** The kind of run this arises on, in prose, for a reader of the ledger. */
  runShape: string;

  /** Why it is open rather than fixed. */
  why: string;

  /** Where the work that closes it is planned. */
  issue: string;
}

/** One check's verdict on one run. */
export interface CheckResult {
  checkId: string;
  title: string;
  runId: string;

  /** The run directory audited, as the caller named it. */
  runDir: string;

  verdict: CheckVerdict;

  /** One sentence stating what the check found. */
  message: string;

  citations: readonly CheckCitation[];
  evidence: readonly CheckEvidence[];

  /**
   * Set on a finding from a defect we already know about, carrying what a
   * ledger entry for it would need. Absent on a `pass`, and absent on every
   * check that is about a regression rather than about a known gap.
   */
  knownDefect?: KnownDefectRegistration;
}

/** The verdict at or above which the audit exits non-zero. */
export type FailOnThreshold = "fail" | "warn" | "inconclusive";

const THRESHOLD_VERDICTS: Record<
  FailOnThreshold,
  readonly CheckVerdict[]
> = {
  fail: ["fail"],
  warn: ["fail", "warn"],
  inconclusive: ["fail", "warn", "inconclusive"],
};

/**
 * The threshold an audit uses when the caller names none.
 *
 * `inconclusive` rather than `fail`: an audit run in CI over a tree missing
 * the artifacts the checks read has established nothing, and a green exit
 * code there would report the absence of evidence as evidence of compliance.
 */
export const DEFAULT_FAIL_ON: FailOnThreshold = "inconclusive";

/** Whether `verdict` is at or above `threshold`. */
export const verdictFailsThreshold = (
  verdict: CheckVerdict,
  threshold: FailOnThreshold,
): boolean => THRESHOLD_VERDICTS[threshold].includes(verdict);

/** The order findings are reported in, worst first. */
export const VERDICT_ORDER: readonly CheckVerdict[] = [
  "fail",
  "warn",
  "inconclusive",
  "not-applicable",
  "pass",
];

/** How many results carried each verdict. */
export const countVerdicts = (
  results: readonly CheckResult[],
): Record<CheckVerdict, number> => {
  const counts: Record<CheckVerdict, number> = {
    fail: 0,
    warn: 0,
    inconclusive: 0,
    "not-applicable": 0,
    pass: 0,
  };
  for (const result of results) {
    counts[result.verdict] += 1;
  }
  return counts;
};
