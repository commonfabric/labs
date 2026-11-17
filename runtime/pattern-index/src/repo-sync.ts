/**
 * Keeping the patterns a repository holds current in the pattern index: each
 * entry file on the default branch is one lineage of the brand that owns the
 * repository, and a sync makes a new version of a lineage when, and only
 * when, that entry's source changed. The index decides that: a pattern whose
 * id the lineage's newest version already has makes no new version.
 *
 * A sync runs in two phases, in two separate jobs, because compiling a
 * pattern evaluates the repository's code and publishing needs a credential.
 * The plan phase (`repo-plan.ts`) finds the entries and compiles each one,
 * in a job that holds no credential. The publish phase ({@link publishPlan})
 * reads the plan as untrusted data and sends it to the index, in a job that
 * evaluates no pattern code. A pattern that escaped evaluation in the first
 * job finds nothing to take, and the second job holds the credential without
 * running anything the repository wrote.
 *
 * Nothing about past runs is kept anywhere but the index: every sync sends
 * every entry, so one after a failure catches up.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  BrandSyncError,
  type BrandSyncPattern,
  type BrandSyncRequest,
  type BrandSyncResponse,
  MAX_BRAND_SYNC_PATTERNS,
} from "./brand-sync-client.ts";

/** One entry as the plan phase found it. */
export type PlannedEntry =
  | { path: string; status: "compiled"; pattern: BrandSyncPattern }
  | { path: string; status: "undescribed" }
  | { path: string; status: "failed"; reason: string };

/** What the plan phase hands the publish phase. */
export interface RepoSyncPlan {
  entries: readonly PlannedEntry[];

  /** Entry paths this push deleted, whose lineages the index withdraws. */
  removed: readonly string[];
}

/** What happened to one entry. */
export type EntryOutcome =
  | { path: string; status: "published"; patternId: string }
  | { path: string; status: "unchanged"; patternId: string }
  | { path: string; status: "undescribed" }
  | { path: string; status: "failed"; reason: string };

/** What a sync did, in the order of the entries it found. */
export interface RepoSyncReport {
  repository: string;
  commit: string;

  /** The brand the index published under, once a call succeeded. */
  brand?: string;

  entries: readonly EntryOutcome[];

  /** The removed paths whose lineages the index withdrew. */
  withdrawn: readonly string[];
}

/** A failure's message, for a report. */
export const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What keeps `plan` from being a {@link RepoSyncPlan}, or `undefined` when
 * nothing does. The publish phase reads a plan the plan phase wrote while
 * evaluating the repository's code, so it checks the shape before trusting
 * any of it. A pattern's own fields are the index's to judge.
 */
export const planProblem = (plan: unknown): string | undefined => {
  if (!isObjectNotArray(plan) || !Array.isArray(plan.entries)) {
    return "the plan has no list of entries";
  }
  if (
    !Array.isArray(plan.removed) ||
    !plan.removed.every((path) => typeof path === "string")
  ) {
    return "the plan has no list of removed paths";
  }
  for (const [index, entry] of plan.entries.entries()) {
    const where = `entries[${index}]`;
    if (!isObjectNotArray(entry) || typeof entry.path !== "string") {
      return `${where} has no path`;
    }
    if (entry.status === "undescribed") continue;
    if (entry.status === "failed") {
      if (typeof entry.reason !== "string") return `${where} has no reason`;
      continue;
    }
    if (entry.status !== "compiled") return `${where} has an unknown status`;
    if (
      !isObjectNotArray(entry.pattern) || entry.pattern.path !== entry.path ||
      typeof entry.pattern.patternId !== "string"
    ) {
      return `${where} has no pattern for its path`;
    }
  }
  return undefined;
};

/** Where the publish phase publishes. */
export interface PublishPlanOptions {
  /** `owner/name`, from the job's own environment, never from the plan. */
  repository: string;

  /** The commit the job runs at, from its own environment. */
  commit: string;
}

/** The index call, with the credential already bound. */
export type BrandSync = (
  request: BrandSyncRequest,
) => Promise<BrandSyncResponse>;

/** Splits `items` into runs of at most `size`. */
const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    runs.push(items.slice(start, start + size));
  }
  return runs;
};

/** The outcome the index's result for one pattern means. */
const outcomeOf = (
  result: BrandSyncResponse["results"][number],
): EntryOutcome =>
  result.created
    ? { path: result.path, status: "published", patternId: result.patternId }
    : { path: result.path, status: "unchanged", patternId: result.patternId };

/** Whether `error` is the index refusing what a call carried (400). */
const refusedContent = (error: unknown): error is BrandSyncError =>
  error instanceof BrandSyncError && error.status === 400;

/**
 * The publish phase: sends every compiled entry to the index, in calls of at
 * most {@link MAX_BRAND_SYNC_PATTERNS}, and the removed paths with the first.
 *
 * The index refuses a whole call (400) when one pattern in it is malformed,
 * so a refused call's patterns are sent again one to a call, to learn which
 * one it was, and the rest are published. A refusal of who is calling (401,
 * 403) would be the same for every call, so it ends the sync.
 *
 * @throws BrandSyncError when the index refuses the caller, and whatever the
 *   transport throws.
 */
export const publishPlan = async (
  plan: RepoSyncPlan,
  options: PublishPlanOptions,
  sync: BrandSync,
): Promise<RepoSyncReport> => {
  const outcomes = new Map<string, EntryOutcome>();
  for (const entry of plan.entries) {
    if (entry.status !== "compiled") outcomes.set(entry.path, entry);
  }
  let brand: string | undefined;
  const withdrawn: string[] = [];
  const send = async (
    patterns: readonly BrandSyncPattern[],
    removed: readonly string[] = [],
  ) => {
    const response = await sync({
      repository: options.repository,
      commit: options.commit,
      patterns,
      ...(removed.length === 0 ? {} : { removed }),
    });
    brand = response.brand.displayName;
    for (const result of response.results) {
      outcomes.set(result.path, outcomeOf(result));
    }
    for (const removal of response.removed) {
      if (removal.withdrawn) withdrawn.push(removal.path);
    }
  };
  const fail = (pattern: BrandSyncPattern, error: BrandSyncError) =>
    outcomes.set(pattern.path, {
      path: pattern.path,
      status: "failed",
      reason: error.message,
    });

  const patterns = plan.entries.flatMap((entry) =>
    entry.status === "compiled" ? [entry.pattern] : []
  );
  const batches = chunks(patterns, MAX_BRAND_SYNC_PATTERNS);
  // With no pattern to send, one call still carries the removals.
  if (batches.length === 0 && plan.removed.length > 0) batches.push([]);
  for (const [index, batch] of batches.entries()) {
    const removed = index === 0 ? plan.removed : [];
    try {
      await send(batch, removed);
      continue;
    } catch (error) {
      if (!refusedContent(error)) throw error;
      if (batch.length === 1 && removed.length === 0) {
        fail(batch[0], error);
        continue;
      }
    }
    // Removals go alone, so a malformed pattern cannot hold them back.
    if (removed.length > 0) await send([], removed);
    for (const pattern of batch) {
      try {
        await send([pattern]);
      } catch (error) {
        if (!refusedContent(error)) throw error;
        fail(pattern, error);
      }
    }
  }
  return {
    repository: options.repository,
    commit: options.commit,
    ...(brand === undefined ? {} : { brand }),
    // An index that answered for fewer patterns than it was sent leaves the
    // rest unpublished, which is a failure like any other.
    entries: plan.entries.map((entry) =>
      outcomes.get(entry.path) ?? {
        path: entry.path,
        status: "failed",
        reason: "the index returned no result for it",
      }
    ),
    withdrawn,
  };
};

/** Whether the job should fail: some entry could not be synced. */
export const syncFailed = (report: RepoSyncReport): boolean =>
  report.entries.some((entry) => entry.status === "failed");

/** Text safe inside a Markdown table cell. */
const cell = (text: string): string =>
  text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** The report as Markdown, for a GitHub job summary. */
export const reportMarkdown = (report: RepoSyncReport): string => {
  const withStatus = (status: EntryOutcome["status"]) =>
    report.entries.filter((entry) => entry.status === status);
  const published = withStatus("published");
  const failed = withStatus("failed");
  const undescribed = withStatus("undescribed");
  const lines = [
    `## Pattern index sync: ${report.repository}`,
    "",
    `At \`${report.commit.slice(0, 12)}\`` +
    (report.brand === undefined ? "" : `, as ${report.brand}`) +
    `: ${report.entries.length} entries, ${published.length} published, ` +
    `${withStatus("unchanged").length} unchanged, ` +
    `${undescribed.length} without a description, ${failed.length} failed.`,
  ];
  if (failed.length > 0) {
    lines.push("", "### Failed", "", "| Entry | Reason |", "| --- | --- |");
    for (const entry of failed) {
      if (entry.status !== "failed") continue;
      lines.push(`| \`${entry.path}\` | ${cell(entry.reason)} |`);
    }
  }
  if (published.length > 0) {
    lines.push("", "### Published", "", "| Entry | Pattern |", "| --- | --- |");
    for (const entry of published) {
      if (entry.status !== "published") continue;
      lines.push(`| \`${entry.path}\` | \`${entry.patternId}\` |`);
    }
  }
  if (undescribed.length > 0) {
    lines.push(
      "",
      "### Not published: no description",
      "",
      "Open each with a `/** ... */` doc comment whose first paragraph says what the pattern does.",
      "",
    );
    for (const entry of undescribed) lines.push(`- \`${entry.path}\``);
  }
  if (report.withdrawn.length > 0) {
    lines.push(
      "",
      "### Withdrawn",
      "",
      "Deleted here: unlisted in the index, and still readable by id.",
      "",
    );
    for (const path of report.withdrawn) lines.push(`- \`${path}\``);
  }
  return lines.join("\n") + "\n";
};
