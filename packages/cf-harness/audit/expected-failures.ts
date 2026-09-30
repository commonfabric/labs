/**
 * Holding a nightly audit to a list of the findings it is known to produce.
 *
 * A job that is red on day one trains everyone to ignore it, and a job whose
 * threshold was lowered to make it green stops being a signal at all. The
 * third option is this one: name each known finding, and fail on anything
 * else.
 *
 * Two directions, both of which matter. A finding no entry covers is a new
 * failure and fails the run. An entry that matched nothing is a gap that has
 * been closed, and it fails the run too, so the fix has to take the entry with
 * it. That second direction is what keeps the list from becoming a permanent
 * excuse, and what makes the list shrinking the thing to watch.
 *
 * This is not a threshold. `--fail-on` decides which verdicts count as
 * findings; this decides which of those findings were already known, on which
 * run shape.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import type { CheckResult, FailOnThreshold } from "./report.ts";
import { verdictFailsThreshold } from "./report.ts";

/** One finding the suite is known to produce, and what it is tracked under. */
export interface ExpectedFailure {
  checkId: string;

  /** The kind of run this arises on, in prose, for a reader of the list. */
  runShape: string;

  /**
   * An anchored regular expression over the run id, which decides which runs
   * this entry speaks for.
   *
   * `runShape` is prose and matches nothing. Without a machine-readable
   * selector beside it, an entry written for one shape suppresses the same
   * message on every other, and a finding on a run nobody had considered
   * borrows the entry rather than failing the job.
   */
  runs: string;

  /**
   * A substring of the finding's message, which is what matches it.
   *
   * A check fails for more than one reason, and an entry that matched the
   * check alone would excuse reasons nobody decided about. Empty is refused
   * for the same reason: it would match every message the check can write.
   */
  detail: string;

  /** Why it is open rather than fixed. */
  why: string;

  /** The issue tracking it. An entry without one is not an entry. */
  issue: string;
}

/**
 * Refuses an entry that cannot do its job.
 *
 * A malformed entry is worse than a missing one: it suppresses findings while
 * looking like a decision somebody made. Each of these would silently widen
 * what the list excuses, so each is a hard failure at load rather than a
 * quiet broadening at match time.
 */
export const assertUsableExpectedFailure = (
  entry: ExpectedFailure,
  index: number,
): void => {
  const at = `expected[${index}]`;
  for (
    const [field, value] of [
      ["checkId", entry.checkId],
      ["runs", entry.runs],
      ["detail", entry.detail],
      ["issue", entry.issue],
    ] as const
  ) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `${at} needs a non-empty \`${field}\`; an entry without one matches more than whoever wrote it decided`,
      );
    }
  }
  try {
    new RegExp(entry.runs);
  } catch (error) {
    throw new Error(
      `${at} has a \`runs\` that is not a regular expression: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

export interface ExpectedFailuresFile {
  expected: readonly ExpectedFailure[];
}

/**
 * The entries of a parsed expected-failures file, or a throw saying why not.
 *
 * A file whose `expected` is missing or is not an array must not read as an
 * empty list: an empty list excuses nothing, so a malformed file would look
 * like a strict one and the mistake would never surface.
 */
export const readExpectedFailures = (
  value: unknown,
): readonly ExpectedFailure[] => {
  if (!isObjectNotArray(value)) {
    throw new Error("the file's top level is not an object");
  }
  const expected = (value as { expected?: unknown }).expected;
  if (!Array.isArray(expected)) {
    throw new Error("the file has no `expected` array");
  }
  return expected as readonly ExpectedFailure[];
};

/** What holding the findings to the list established. */
export interface ExpectedFailureReconciliation {
  /** Findings no entry covers. Each is a new failure. */
  unexpected: readonly CheckResult[];

  /** Entries that matched nothing, each a gap that has since been closed. */
  stale: readonly ExpectedFailure[];

  /** Findings an entry covers, which do not fail the run. */
  matched: readonly CheckResult[];
}

const matches = (
  entry: ExpectedFailure,
  finding: CheckResult,
): boolean =>
  entry.checkId === finding.checkId &&
  finding.message.includes(entry.detail) &&
  new RegExp(`^(?:${entry.runs})$`).test(finding.runId);

/**
 * Reconciles the results against the list.
 *
 * The threshold decides which unmatched results are failures; it does not
 * decide which entries are live. An entry is used when anything it names is
 * still happening, at any verdict, so raising the threshold cannot make a
 * standing gap look like a closed one.
 *
 * Reads only the results it is given; it neither knows nor cares which paths
 * produced them.
 */
export const reconcileExpectedFailures = (
  results: readonly CheckResult[],
  expected: readonly ExpectedFailure[],
  threshold: FailOnThreshold,
): ExpectedFailureReconciliation => {
  expected.forEach(assertUsableExpectedFailure);
  const matched: CheckResult[] = [];
  const unexpected: CheckResult[] = [];
  const used = new Set<ExpectedFailure>();
  for (const result of results) {
    const entry = expected.find((candidate) => matches(candidate, result));
    if (entry !== undefined) {
      // Marked used whatever the threshold: an entry for a `warn` under
      // `--fail-on fail` still describes something that is happening, and
      // calling it stale would report a live gap as a closed one and fail the
      // run for the opposite of the reason it looks like.
      used.add(entry);
      if (verdictFailsThreshold(result.verdict, threshold)) {
        matched.push(result);
      }
      continue;
    }
    if (verdictFailsThreshold(result.verdict, threshold)) {
      unexpected.push(result);
    }
  }
  return {
    unexpected,
    stale: expected.filter((entry) => !used.has(entry)),
    matched,
  };
};

/** Whether the reconciliation should fail the run. */
export const reconciliationFails = (
  reconciliation: ExpectedFailureReconciliation,
): boolean =>
  reconciliation.unexpected.length > 0 || reconciliation.stale.length > 0;

/** What a reader is told about the reconciliation, worst first. */
export const renderReconciliation = (
  reconciliation: ExpectedFailureReconciliation,
): string => {
  const lines: string[] = [];
  if (reconciliation.unexpected.length > 0) {
    lines.push(
      `${reconciliation.unexpected.length} finding(s) no entry covers:`,
    );
    for (const finding of reconciliation.unexpected) {
      lines.push(
        `  ${finding.checkId} ${finding.verdict} — ${finding.runId}: ${finding.message}`,
      );
    }
  }
  if (reconciliation.stale.length > 0) {
    lines.push(
      `${reconciliation.stale.length} expected failure(s) that no longer occur — remove the entry with the fix:`,
    );
    for (const entry of reconciliation.stale) {
      lines.push(`  ${entry.checkId} (${entry.issue}) — ${entry.detail}`);
    }
  }
  if (reconciliation.matched.length > 0) {
    lines.push(
      `${reconciliation.matched.length} known finding(s), each tracked under an issue.`,
    );
  }
  return lines.join("\n");
};
