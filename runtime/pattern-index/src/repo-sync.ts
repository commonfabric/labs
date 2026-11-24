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
import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexFinding,
  type PatternIndexPublishRequest,
  type PatternIndexRepoHead,
} from "./client.ts";

/** One entry as the plan phase found it. */
export type PlannedEntry =
  | {
    path: string;
    status: "compiled";
    sourceHash: string;

    /** The publish request, without its repository source. */
    request: PatternIndexPublishRequest;

    /**
     * The paths this entry's file had before it moved within the repository,
     * nearest first. A path with no lineage of its own continues the
     * lineage of the first of these the index holds and the repository no
     * longer selects.
     */
    formerPaths?: readonly string[];
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
  | { path: string; status: "public-elsewhere"; patternId: string }
  | { path: string; status: "unchanged"; patternId: string }
  | { path: string; status: "undescribed" }
  /** The index refused the program as larger than `limit` bytes of source. */
  | { path: string; status: "oversize"; limit: string }
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

  /**
   * Why the index refused to withdraw the lineages of paths the repository
   * lost, when it did. The entries above were synced either way.
   */
  withdrawFailure?: string;

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

/**
 * The byte limit a publish's HTTP 400 program-size refusal names, or
 * `undefined` for any other failure. The entire detail has to match the
 * server's fixed wording with one to twelve decimal digits.
 */
export const programSizeLimit = (error: unknown): string | undefined => {
  if (
    !(error instanceof PatternIndexError) || error.fn !== "publishPattern" ||
    error.status !== 400
  ) {
    return undefined;
  }
  const refusal = /^program exceeds ([0-9]{1,12}) bytes of source$/.exec(
    error.detail ?? "",
  );
  return refusal !== null && refusal[0] === error.detail
    ? refusal[1]
    : undefined;
};

/**
 * Returns a failure's message for a report. A `PatternIndexError`'s message
 * leaves out the index's detail, so index details stay withheld.
 */
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
    if (
      entry.formerPaths !== undefined &&
      !(Array.isArray(entry.formerPaths) &&
        entry.formerPaths.every((path) => typeof path === "string"))
    ) {
      return `${where} has former paths that are not a list of paths`;
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

/**
 * Publishes one compiled entry whose head is `head`, or that has none. An
 * entry with no head that moved from `movedFrom` names that path, so the
 * index moves its lineage here rather than starting one. A move the index
 * refuses throws, and the entry is reported failed: published anyway, it
 * would start a new lineage no later sync could move.
 */
const publishEntry = async (
  entry: Extract<PlannedEntry, { status: "compiled" }>,
  head: PatternIndexRepoHead | undefined,
  movedFrom: PatternIndexRepoHead | undefined,
  options: PublishPlanOptions,
  client: PublishClient,
): Promise<EntryOutcome> => {
  // The source is what usually moves, but a newer Labs can compile the same
  // source to a different pattern, so the id has to match as well.
  if (
    head?.sourceHash === entry.sourceHash &&
    head.patternId === entry.request.patternId
  ) {
    return { path: entry.path, status: "unchanged", patternId: head.patternId };
  }
  const response = await client.publishPattern({
    ...entry.request,
    source: {
      repository: options.repository,
      path: entry.path,
      commit: options.commit,
      sourceHash: entry.sourceHash,
      ...(head === undefined && movedFrom !== undefined
        ? { movedFrom: movedFrom.path }
        : {}),
    },
  });
  // An index that predates repository sync drops `source` and publishes an
  // unlinked version; that is a failure, not a success.
  if (response.ignored?.includes("source")) {
    throw new Error("the index ignored the repository source");
  }
  // A move the index confirms names the old path back. Without that, a new
  // lineage was started here, which no later sync can move.
  if (
    head === undefined && movedFrom !== undefined &&
    response.movedFrom === undefined
  ) {
    throw new Error(
      `the index did not say it moved the lineage of ${movedFrom.path} here`,
    );
  }
  const status = response.unchanged === true
    ? "unchanged"
    // The same source is already public under another publisher, so the
    // brand's version stays private rather than appearing twice.
    : response.visibility === "private"
    ? "public-elsewhere"
    : "published";
  return { path: entry.path, status, patternId: response.patternId };
};

/** The gate verdicts with findings that `heads` carry. */
const gardenerReports = (
  heads: readonly PatternIndexRepoHead[],
): GardenerReport[] =>
  heads.flatMap((head) =>
    Object.entries(head.gates ?? {}).flatMap(([gardener, verdict]) =>
      verdict.findings === undefined || verdict.findings.length === 0 ? [] : [{
        path: head.path,
        gardener,
        status: verdict.status,
        findings: verdict.findings,
      }]
    )
  );

/**
 * The publish phase: publishes a new version of every compiled entry whose
 * source hash or pattern id differs from its lineage's newest, and withdraws
 * the lineages of paths the repository no longer selects.
 *
 * A refused publish is recorded and the others still run, and a refused
 * withdrawal is recorded beside them; the caller fails the job when
 * {@link syncFailed} says so. A publish refused only for its program's size
 * is recorded as oversize, which, like an entry with no description, is
 * reported and does not fail the job: the fix is in the pattern. The next
 * sync tries the entry again, since nothing of it was published.
 *
 * @throws PatternIndexError when the index refuses `listRepoHeads`, before
 *   anything is published.
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
  const selected = new Set(plan.selected);
  // A former path's lineage moves to one entry at most: the first that
  // claims it.
  const claimed = new Set<string>();
  const movedFrom = (
    entry: Extract<PlannedEntry, { status: "compiled" }>,
  ): PatternIndexRepoHead | undefined => {
    if (headOf.has(entry.path)) return undefined;
    const former = (entry.formerPaths ?? []).find((path) =>
      headOf.has(path) && !selected.has(path) && !claimed.has(path)
    );
    if (former === undefined) return undefined;
    claimed.add(former);
    return headOf.get(former);
  };
  const outcomes: EntryOutcome[] = [];
  for (const entry of plan.entries) {
    if (entry.status !== "compiled") {
      outcomes.push(entry);
      continue;
    }
    try {
      outcomes.push(
        await publishEntry(
          entry,
          headOf.get(entry.path),
          movedFrom(entry),
          options,
          client,
        ),
      );
    } catch (error) {
      const limit = programSizeLimit(error);
      outcomes.push(
        limit === undefined
          ? { path: entry.path, status: "failed", reason: reasonOf(error) }
          : { path: entry.path, status: "oversize", limit },
      );
    }
  }
  const entryPaths = new Set(plan.entries.map((entry) => entry.path));
  // A path whose lineage moved this run is not withdrawn: the lineage is at
  // its new path now.
  const gone = heads.map((head) => head.path).filter((path) =>
    !selected.has(path) && !claimed.has(path)
  ).sort();
  let withdrawn: string[] = [];
  let withdrawFailure: string | undefined;
  if (gone.length > 0) {
    try {
      const answer = await client.withdrawRepoPaths({
        repository: options.repository,
        paths: gone,
      });
      withdrawn = answer.withdrawn.filter((removal) => removal.withdrawn)
        .map((removal) => removal.path);
    } catch (error) {
      withdrawFailure = reasonOf(error);
    }
  }
  return {
    repository: options.repository,
    commit: options.commit,
    entries: outcomes,
    withdrawn,
    ...(withdrawFailure === undefined ? {} : { withdrawFailure }),
    dormant: heads.map((head) => head.path).filter((path) =>
      selected.has(path) && !entryPaths.has(path)
    ).sort(),
    gardeners: gardenerReports(heads),
  };
};

/**
 * Whether the job should fail: some entry could not be synced, or the
 * lineages of lost paths could not be withdrawn. An undescribed or oversize
 * entry is reported but is not a failure.
 */
export const syncFailed = (report: RepoSyncReport): boolean =>
  report.withdrawFailure !== undefined ||
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
  const withStatus = <S extends EntryOutcome["status"]>(status: S) =>
    report.entries.filter((entry): entry is Extract<
      EntryOutcome,
      { status: S }
    > => entry.status === status);
  const published = withStatus("published");
  const failed = withStatus("failed");
  const undescribed = withStatus("undescribed");
  const oversize = withStatus("oversize");
  const lines = [
    `## Pattern index sync: ${report.repository}`,
    "",
    `At \`${report.commit.slice(0, 12)}\`: ${report.entries.length} entries, ` +
    `${published.length} published, ` +
    `${withStatus("unchanged").length} unchanged, ` +
    `${undescribed.length} without a description, ` +
    `${oversize.length} too large for the index, ${failed.length} failed.`,
  ];
  const list = (title: string, note: string, paths: readonly string[]) => {
    if (paths.length === 0) return;
    lines.push("", `### ${title}`, "", note, "");
    for (const path of paths) lines.push(`- \`${path}\``);
  };
  if (failed.length > 0) {
    lines.push("", "### Failed", "", "| Entry | Reason |", "| --- | --- |");
    for (const entry of failed) {
      lines.push(`| \`${entry.path}\` | ${cell(entry.reason)} |`);
    }
  }
  if (report.withdrawFailure !== undefined) {
    lines.push(
      "",
      "### Withdrawal failed",
      "",
      `The index refused to withdraw the lineages of paths no longer here: ${
        cell(report.withdrawFailure)
      }`,
    );
  }
  if (published.length > 0) {
    lines.push("", "### Published", "", "| Entry | Pattern |", "| --- | --- |");
    for (const entry of published) {
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
    "Already public under another publisher",
    "The same source is public under someone else, so the brand's version stays private.",
    withStatus("public-elsewhere").map((entry) => entry.path),
  );
  list(
    "Not published: no description",
    "Open each with a `/** ... */` doc comment whose first paragraph says what the pattern does.",
    undescribed.map((entry) => entry.path),
  );
  list(
    "Not published: too large for the index",
    `The index refuses a program (the entry and everything it imports) over ${
      [...new Set(oversize.map((entry) => entry.limit))].join(" or ")
    } bytes of source.`,
    oversize.map((entry) => entry.path),
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
