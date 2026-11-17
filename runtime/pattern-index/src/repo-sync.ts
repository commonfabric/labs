/**
 * Keeping the patterns a repository holds current in the pattern index: each
 * entry file on the default branch is one lineage of the brand that owns the
 * repository, and a sync publishes a new version of a lineage when, and only
 * when, that entry's source changed.
 *
 * A sync runs in two phases, in two separate jobs, because compiling a
 * pattern evaluates the repository's code and publishing needs a credential.
 * The plan phase (`repo-plan.ts`) finds the entries and compiles each one,
 * in a job that holds no credential. The publish phase ({@link publishPlan})
 * reads the plan as untrusted data, asks the index what it already holds,
 * and publishes what changed, in a job that evaluates no pattern code. A
 * pattern that escaped evaluation in the first job finds nothing to take, and
 * the second job holds the credential without running anything the
 * repository wrote.
 *
 * "Changed" is decided by a hash of the program an entry resolves to (its own
 * file and every file it imports) together with the compiler flags that bear
 * on a pattern's identity, not by a git diff. The index keeps that hash on
 * each lineage's newest version and returns it from `listRepoHeads`. A path
 * the index holds a lineage for that the repository no longer selects
 * (deleted, moved, or excluded) is withdrawn. A sync that failed partway
 * leaves the index behind, and the next one catches it up; nothing about past
 * runs is kept anywhere but the index.
 *
 * The privacy gardener is report-only for a brand: the index lists a
 * brand's version when it is published and records the gardener's verdict
 * when it lands. A sync shows the verdicts the heads carry when it starts,
 * which includes those that arrived since the last sync.
 */

import { encodeHex } from "@std/encoding/hex";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import type { RuntimeProgram } from "@commonfabric/runner";
import type {
  PatternIndexClient,
  PatternIndexFinding,
  PatternIndexPublishRequest,
  PatternIndexRepoHead,
} from "./client.ts";

/** One entry as the plan phase found it. */
export type PlannedEntry =
  | {
    path: string;
    status: "compiled";
    sourceHash: string;

    /** The publish request, without its repository source. */
    request: PatternIndexPublishRequest;
  }
  | { path: string; status: "undescribed" }
  | { path: string; status: "failed"; reason: string };

/** What the plan phase hands the publish phase. */
export interface RepoSyncPlan {
  entries: readonly PlannedEntry[];

  /**
   * Every path the sync's globs select, entry or not. A lineage whose path
   * is not among them is withdrawn; one whose file is still here but is no
   * longer an entry is left alone and reported.
   */
  selected: readonly string[];
}

/** What happened to one entry. */
export type EntryOutcome =
  | { path: string; status: "published"; patternId: string }
  | { path: string; status: "unchanged"; patternId: string }
  | { path: string; status: "undescribed" }
  | { path: string; status: "failed"; reason: string };

/** A gate verdict with findings, as the newest version of a path carries it. */
export interface GardenerReport {
  path: string;
  gardener: string;
  status: string;
  findings: readonly PatternIndexFinding[];
}

/** What a sync did, in the order of the entries it found. */
export interface RepoSyncReport {
  repository: string;
  commit: string;
  entries: readonly EntryOutcome[];

  /** Paths whose lineages were withdrawn, since the repository lost them. */
  withdrawn: readonly string[];

  /** Paths the index holds a lineage for that are here but not entries. */
  dormant: readonly string[];

  gardeners: readonly GardenerReport[];
}

/** Orders keyed pairs by key, so a hash does not depend on insertion order. */
const byKey = <T>(pairs: [string, T][]): [string, T][] =>
  pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

/**
 * A hash of everything a compile of `program` reads: the entry, the export it
 * runs, each file's name and contents, and the `experimental` flags. File
 * and flag order do not count.
 */
export const programSourceHash = async (
  program: RuntimeProgram,
  experimental: object,
): Promise<string> => {
  const canonical = JSON.stringify({
    experimental: byKey(
      Object.entries(experimental).filter(([, value]) => value !== undefined),
    ),
    main: program.main,
    mainExport: program.mainExport ?? null,
    files: byKey(program.files.map((file) => [file.name, file.contents])),
    sourceRoots: [...(program.sourceRoots ?? [])].sort(),
    dataFiles: [...(program.dataFiles ?? [])].sort(),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return encodeHex(new Uint8Array(digest));
};

/** A failure's message, for a report. */
export const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What keeps `plan` from being a {@link RepoSyncPlan}, or `undefined` when
 * nothing does. The publish phase reads a plan the plan phase wrote while
 * evaluating the repository's code, so it checks the shape before trusting
 * any of it. A publish request's own fields are the index's to judge.
 */
export const planProblem = (plan: unknown): string | undefined => {
  if (!isObjectNotArray(plan) || !Array.isArray(plan.entries)) {
    return "the plan has no list of entries";
  }
  if (
    !Array.isArray(plan.selected) ||
    !plan.selected.every((path) => typeof path === "string")
  ) {
    return "the plan has no list of selected paths";
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
    if (typeof entry.sourceHash !== "string") {
      return `${where} has no source hash`;
    }
    if (
      !isObjectNotArray(entry.request) ||
      typeof entry.request.patternId !== "string"
    ) {
      return `${where} has no publish request`;
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

/** What the publish phase reaches the index through. */
export type PublishClient = Pick<
  PatternIndexClient,
  "listRepoHeads" | "publishPattern" | "withdrawRepoPaths"
>;

/** Publishes one compiled entry whose head is `head`, or that has none. */
const publishEntry = async (
  entry: Extract<PlannedEntry, { status: "compiled" }>,
  head: PatternIndexRepoHead | undefined,
  options: PublishPlanOptions,
  client: PublishClient,
): Promise<EntryOutcome> => {
  if (head?.sourceHash === entry.sourceHash) {
    return { path: entry.path, status: "unchanged", patternId: head.patternId };
  }
  const response = await client.publishPattern({
    ...entry.request,
    source: {
      repository: options.repository,
      path: entry.path,
      commit: options.commit,
      sourceHash: entry.sourceHash,
    },
  });
  // An index that predates repository sync drops `source` and publishes an
  // unlinked version; that is a failure, not a success.
  if (response.ignored?.includes("source")) {
    throw new Error("the index ignored the repository source");
  }
  return response.unchanged === true
    ? { path: entry.path, status: "unchanged", patternId: response.patternId }
    : { path: entry.path, status: "published", patternId: response.patternId };
};

/** The gate verdicts with findings that `heads` carry. */
const gardenerReports = (
  heads: readonly PatternIndexRepoHead[],
): GardenerReport[] =>
  heads.flatMap((head) =>
    Object.entries(head.gates ?? {})
      .filter(([, verdict]) => (verdict.findings?.length ?? 0) > 0)
      .map(([gardener, verdict]) => ({
        path: head.path,
        gardener,
        status: verdict.status,
        findings: verdict.findings ?? [],
      }))
  );

/**
 * The publish phase: publishes a new version of every compiled entry whose
 * hash differs from its lineage's newest, and withdraws the lineages of paths
 * the repository no longer selects.
 *
 * A refused publish is recorded and the others still run; the caller fails
 * the job when any entry failed, here or in the plan.
 *
 * @throws PatternIndexError when the index refuses `listRepoHeads` (before
 *   anything is published) or `withdrawRepoPaths` (after).
 */
export const publishPlan = async (
  plan: RepoSyncPlan,
  options: PublishPlanOptions,
  client: PublishClient,
): Promise<RepoSyncReport> => {
  const { heads } = await client.listRepoHeads({
    repository: options.repository,
  });
  const headOf = new Map(heads.map((head) => [head.path, head]));
  const outcomes: EntryOutcome[] = [];
  for (const entry of plan.entries) {
    if (entry.status !== "compiled") {
      outcomes.push(entry);
      continue;
    }
    try {
      outcomes.push(
        await publishEntry(entry, headOf.get(entry.path), options, client),
      );
    } catch (error) {
      outcomes.push({
        path: entry.path,
        status: "failed",
        reason: reasonOf(error),
      });
    }
  }
  const selected = new Set(plan.selected);
  const entryPaths = new Set(plan.entries.map((entry) => entry.path));
  const gone = heads.map((head) => head.path).filter((path) =>
    !selected.has(path)
  ).sort();
  const withdrawn = gone.length === 0 ? [] : (await client.withdrawRepoPaths({
    repository: options.repository,
    paths: gone,
  })).withdrawn.filter((removal) => removal.withdrawn).map((removal) =>
    removal.path
  );
  return {
    repository: options.repository,
    commit: options.commit,
    entries: outcomes,
    withdrawn,
    dormant: heads.map((head) => head.path).filter((path) =>
      selected.has(path) && !entryPaths.has(path)
    ).sort(),
    gardeners: gardenerReports(heads),
  };
};

/** Whether the job should fail: some entry could not be synced. */
export const syncFailed = (report: RepoSyncReport): boolean =>
  report.entries.some((entry) => entry.status === "failed");

/** Text safe inside a Markdown table cell. */
const cell = (text: string): string =>
  text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/**
 * The report as Markdown, for a GitHub job summary. Findings are reported by
 * category, file and line, as the index records them, with the gardener's
 * `why`. The summary is visible to whoever can read the repository's runs,
 * which is whoever can read the source the findings are about.
 */
export const reportMarkdown = (report: RepoSyncReport): string => {
  const withStatus = (status: EntryOutcome["status"]) =>
    report.entries.filter((entry) => entry.status === status);
  const published = withStatus("published");
  const failed = withStatus("failed");
  const undescribed = withStatus("undescribed");
  const lines = [
    `## Pattern index sync: ${report.repository}`,
    "",
    `At \`${report.commit.slice(0, 12)}\`: ${report.entries.length} entries, ` +
    `${published.length} published, ` +
    `${withStatus("unchanged").length} unchanged, ` +
    `${undescribed.length} without a description, ${failed.length} failed.`,
  ];
  const list = (title: string, note: string, paths: readonly string[]) => {
    if (paths.length === 0) return;
    lines.push("", `### ${title}`, "", note, "");
    for (const path of paths) lines.push(`- \`${path}\``);
  };
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
  if (report.gardeners.length > 0) {
    lines.push(
      "",
      "### Gardener findings",
      "",
      "Reported, not enforced. Each is on the newest version the index held when this sync started.",
      "",
      "| Entry | Gardener | Status | Category | Where | Why |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const gardenerReport of report.gardeners) {
      for (const finding of gardenerReport.findings) {
        const where = finding.file === undefined
          ? ""
          : `\`${finding.file}${
            finding.line === undefined ? "" : `:${finding.line}`
          }\``;
        lines.push(
          `| \`${gardenerReport.path}\` | ${gardenerReport.gardener} | ` +
            `${gardenerReport.status} | ${cell(finding.category)} | ` +
            `${where} | ${cell(finding.why)} |`,
        );
      }
    }
  }
  list(
    "Not published: no description",
    "Open each with a `/** ... */` doc comment whose first paragraph says what the pattern does.",
    undescribed.map((entry) => entry.path),
  );
  list(
    "Withdrawn",
    "No longer here: unlisted in the index, and still readable by id.",
    report.withdrawn,
  );
  list(
    "No longer entries",
    "Still here but no longer pattern entries (no default export); the index keeps them listed.",
    report.dormant,
  );
  return lines.join("\n") + "\n";
};
