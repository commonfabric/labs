#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run --allow-write

/**
 * PR Coverage Check
 *
 * Runs as a PR CI job after all test jobs complete. Joins the coverage
 * profiles every test job uploaded and gates the PR on coverage debt: for each
 * source group the PR changed, the count of uncovered lines must not rise above
 * the count from the `main` run for the base-branch commit this run merged,
 * unless the PR description accepts the increase. Fails (exit 1) when a changed
 * group regresses, and when the workflow's run listing, which is where that
 * `main` run is found, turns out not to be current. A changed group with no
 * baseline to be held against passes, and the run says so wherever it reports;
 * so does a run GitHub's API rate limit stopped from reading a baseline at all.
 *
 * Environment:
 *   GITHUB_TOKEN        - Required.
 *   GITHUB_REPOSITORY   - Optional, defaults to "commonfabric/labs".
 *   GITHUB_SERVER_URL   - Optional, defaults to "https://github.com".
 *   GITHUB_RUN_ID       - Required. Current workflow run ID.
 *   PR_NUMBER           - Required. Pull request number.
 *   COVERAGE_ARTIFACTS_DIR - Optional. Directory containing downloaded
 *                            coverage artifacts, one subdirectory per name.
 */

import { walk } from "@std/fs/walk";
import * as path from "@std/path";
import type { Environment } from "@commonfabric/test-support/records";

import {
  acceptsCoverageDebt,
  aggregateCacheStates,
  type Artifact,
  type BaselineOverrides,
  type BaselineSample,
  buildCoverageDebtSuggestionComment,
  buildCoverageDebtUnattributedComment,
  buildCoverageNotGatedComment,
  CACHE_STATE_ARTIFACT_PREFIX,
  COMPILE_CACHE_FAMILIES,
  type CompileCacheStates,
  COVERAGE_BASELINE_RESET_MARKER,
  COVERAGE_COMMENT_FILE,
  COVERAGE_NOT_GATED_HEADLINE,
  type CoverageBaselineDetailed,
  type CoverageCommentPayload,
  coverageGroupForChangedFile,
  coverageGroupsForChangedFiles,
  coverageListingNotCurrent,
  type CoverageMeasurement,
  coverageMetricGroupName,
  type CoverageNotGatedGroup,
  type CoverageNotGatedInput,
  coverageNotGatedNotice,
  type CoverageNotGatedReason,
  type CoverageResolvedGroup,
  type CoverageRunIdentity,
  type CoverageSuggestionFileLines,
  type CoverageSuggestionGroup,
  type CoverageUnattributedFile,
  downloadAndExtractArtifact,
  downloadAndParseCoverageBaseline,
  fetchArtifactsForRun,
  fetchCurrentPRBody,
  fetchPRFiles,
  formatOverrideSuggestion,
  githubGet,
  isBaselineCandidateRun,
  isGitHubRateLimitError,
  newestArtifactsByName,
  parseAddedLinesFromPatch,
  parseBaselineOverrides,
  parseCacheStateFiles,
  PERF_METRICS_ARTIFACT_NAME,
  PERF_METRICS_FILE,
  type PRFile,
  type PRInfo,
  readAndParseEvent,
  REPO,
  shouldGateCoverageDebtMetric,
  sleep,
  unknownAcceptedMetrics,
  WORKFLOW_RUNS_PAGE_SIZE,
  type WorkflowRun,
  workflowRunsPagePath,
  workflowRunUrl,
  writeCoverageBaselineFile,
} from "./ci-check-lib.ts";
import {
  fillMissingFamiliesFromFingerprint,
  inferCurrentRunFallbackState,
} from "./compile-cache-state.ts";
import { recordCoverage } from "./coverage-records.ts";
import {
  collectCoverageDebtMetricsFromLcov,
  collectRegressedLines,
  collectUncoveredLinesForFiles,
  COVERAGE_PROFILE_ARTIFACT_PREFIX,
  lcovFromCoverageProfile,
  unscoredMetricGroups,
} from "./coverage-metrics.ts";
import {
  parseUnlaunchedMembers,
  UNLAUNCHED_MEMBERS_FILE,
} from "./unlaunched-members.ts";

/**
 * How many `main` runs the walk reads, nearest the base-branch commit first,
 * before it leaves the metrics still without a baseline as they are.
 */
const BASELINE_RUNS = 20;

/** How many pages of the workflow's run listing one check reads at most. */
const RUN_LISTING_MAX_PAGES = 10;

/** How many times the listing is read before it is judged not current. */
const RUN_LISTING_ATTEMPTS = 3;

/** The wait before the listing's second reading; each later wait doubles. */
const RUN_LISTING_RETRY_DELAY_MS = 2_000;

export function currentWorkflowRunFromEvent(
  event: object | undefined,
  runId: number,
): WorkflowRun {
  const payload = event as {
    after?: unknown;
    pull_request?: {
      head?: { sha?: unknown };
    };
  } | undefined;

  const headSha = typeof payload?.pull_request?.head?.sha === "string"
    ? payload.pull_request.head.sha
    : typeof payload?.after === "string"
    ? payload.after
    : Deno.env.get("GITHUB_SHA") ?? "";

  return {
    id: runId,
    html_url: workflowRunUrl(runId),
    head_sha: headSha,
    created_at: new Date().toISOString(),
    conclusion: "",
    event: Deno.env.get("GITHUB_EVENT_NAME") ?? "",
  };
}

/**
 * The perf-metrics artifact this run publishes: its coverage metrics, and the
 * compile cache states that stamp them. A later run reads the stamp to decide
 * whether this run was cold, so every path that writes the artifact writes
 * both halves.
 */
export interface PerfMetricsArtifact {
  metrics: Map<string, BaselineSample>;
  compileCacheStates?: CompileCacheStates;
}

/** Writes the artifact to {@link PERF_METRICS_FILE}, and says so. */
async function writePerfMetricsArtifact(
  artifact: PerfMetricsArtifact,
): Promise<void> {
  await writeCoverageBaselineFile(
    PERF_METRICS_FILE,
    artifact.metrics,
    artifact.compileCacheStates,
  );
  console.log(
    `Wrote ${PERF_METRICS_FILE} with ${artifact.metrics.size} metrics.`,
  );
}

/**
 * Raised where a GitHub API rate limit stops the check reading the data a
 * baseline comparison needs. {@link runCoverageRatchet} catches it, so that the
 * skip is decided and reported in the one place that knows what the run was
 * going to be gated on.
 */
export class CoverageRateLimitedError extends Error {}

/**
 * Runs one read of the GitHub API, turning a rate limit into a
 * {@link CoverageRateLimitedError} that ends the check. Any other failure is
 * the caller's to handle and is rethrown.
 *
 * The perf-metrics artifact is written before giving up, so that a run cut
 * short still publishes what it measured, stamped with its compile cache
 * states, for a later run to read as a baseline.
 */
export async function guardRateLimit<T>(
  description: string,
  operation: () => Promise<T>,
  artifact: PerfMetricsArtifact,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isGitHubRateLimitError(error)) throw error;

    console.warn(
      `  Warning: GitHub API rate limit while ${description}: ${error}`,
    );
    await writePerfMetricsArtifact(artifact);
    throw new CoverageRateLimitedError(
      `GitHub API rate limits prevented ${description}.`,
    );
  }
}

export function parseMergedBaselineOverrides(
  pr: Pick<PRInfo, "number" | "body">,
  warn: (message: string) => void = console.warn,
): BaselineOverrides | null {
  try {
    // A merged PR's description was written under the rules in force when it
    // landed and cannot be rewritten now, so a marker the parser cannot read is
    // passed over and the rest of the body still yields its acceptances, which
    // truncate the baseline timeline (see parseBaselineOverrides).
    return parseBaselineOverrides(pr.body ?? "", true);
  } catch (error) {
    warn(
      `  Warning: ignoring invalid baseline override in merged PR #${pr.number}: ${error}`,
    );
    return null;
  }
}

/** Reads one page of the workflow's runs, newest first; `1` is the first. */
export async function fetchWorkflowRunsPage(
  page: number,
): Promise<WorkflowRun[]> {
  const data = await githubGet<{ workflow_runs: WorkflowRun[] }>(
    workflowRunsPagePath(page),
  );
  return data.workflow_runs;
}

/**
 * The head SHA of the latest prior baseline run — the run whose compile cache
 * the current main push would have restored. Used to fingerprint-classify a
 * main push that carries no recorded cache state. Reads the run listing a page
 * at a time until one holds a baseline run, since a stretch of failing `main`
 * runs can fill the newest page. Undefined when no page within the budget holds
 * one (e.g. an empty run history).
 */
export async function fetchLatestBaselineRunSha(
  fetchPage: (page: number) => Promise<WorkflowRun[]> = fetchWorkflowRunsPage,
): Promise<string | undefined> {
  for (let page = 1; page <= RUN_LISTING_MAX_PAGES; page++) {
    const runs = await fetchPage(page);
    const latest = runs.find(isBaselineCandidateRun);
    if (latest !== undefined) return latest.head_sha;
    if (runs.length < WORKFLOW_RUNS_PAGE_SIZE) break;
  }
  return undefined;
}

/** What reading the workflow's run listing found. */
export interface BaselineRunListing {
  /**
   * Whether the listing names the workflow's newest runs. It does not when it
   * leaves out the run asking for it: that run was created before the listing
   * was read, so a listing without it is an older one, and every `main` run it
   * fails to name is a baseline the ratchet would wrongly report as missing.
   */
  current: boolean;

  /**
   * Whether the pages read got as far back as the run asking. False for a run
   * created longer ago than the listing is read, where the `main` runs for the
   * commit it merges are older still and so out of reach as well.
   */
  reachedCurrentRun: boolean;

  /** Successful `main` push runs on the pages read so far, newest first. */
  candidates: WorkflowRun[];

  /** The newest run the listing returned, whatever triggered it. */
  newest: WorkflowRun | undefined;

  /** How many pages it took to find the run asking, or to give up. */
  pagesRead: number;

  /**
   * Reads the next older page and returns the baseline candidates on it.
   * Returns null once the listing has ended or the page budget is spent.
   */
  older: () => Promise<WorkflowRun[] | null>;

  /**
   * Returns whether the pages read so far have shown a `main` push run for the
   * commit `sha`, whatever its conclusion. A run still going or one that failed
   * is a run the ratchet cannot use, and having seen it says there is none
   * further back to look for. Until one is shown, the commit's run may be on a
   * page not yet read, and nothing else says otherwise: the date a commit
   * carries is its author's word, so it puts no bound on where the run sits.
   */
  accountsFor: (sha: string) => boolean;
}

/** What {@link readBaselineRunListing} reads, and how far it goes. */
export interface ReadBaselineRunListingOptions {
  /** The run asking, which a current listing shows. */
  currentRunId: number;

  /** Reads one page of the listing; `fetchWorkflowRunsPage()` by default. */
  fetchPage?: (page: number) => Promise<WorkflowRun[]>;

  /** Waits between two readings of the listing. */
  wait?: (ms: number) => Promise<void>;

  /** The most pages one reading takes, older pages included. */
  maxPages?: number;

  /** How many times the listing is read before it is judged not current. */
  attempts?: number;

  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** How a log line names a run: its id, when it was created, and its commit. */
function describeRun(run: WorkflowRun | undefined): string {
  return run === undefined
    ? "nothing"
    : `run ${run.id} (${run.created_at}) for ${run.head_sha.slice(0, 8)}`;
}

/**
 * Reads the workflow's run listing, newest first, as far back as the run
 * asking, and says whether the listing is current.
 *
 * The listing is the only place a `main` run is found by the commit it
 * measured, and GitHub can return an old one without saying so. What tells the
 * two apart is the run asking: it exists, so a current listing shows it, ahead
 * of every run created before it. Run ids grow with creation and the listing is
 * newest first, so a run with a smaller id is an older one. A page of older
 * runs followed by a page that still lacks this run, or a listing that ends
 * without it, is therefore not current. One page of grace covers two runs
 * created together whose order puts a page boundary between them.
 *
 * A listing that is not current is read again, up to `attempts` times in all,
 * because a later request can be served a current one. The last reading
 * stands.
 */
export async function readBaselineRunListing(
  options: ReadBaselineRunListingOptions,
): Promise<BaselineRunListing> {
  const fetchPage = options.fetchPage ?? fetchWorkflowRunsPage;
  const wait = options.wait ?? sleep;
  const maxPages = options.maxPages ?? RUN_LISTING_MAX_PAGES;
  const attempts = options.attempts ?? RUN_LISTING_ATTEMPTS;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;

  for (let attempt = 1;; attempt++) {
    const seen = new Set<number>();
    const pushShown = new Set<string>();
    const candidates: WorkflowRun[] = [];
    let newest: WorkflowRun | undefined;
    let ended = false;
    let pagesRead = 0;

    // Reads the next page, and returns every run on it alongside the baseline
    // candidates no earlier page already held. A run slides onto the next page
    // when a new one is created between two reads.
    const readPage = async () => {
      const runs = await fetchPage(++pagesRead);
      ended = runs.length < WORKFLOW_RUNS_PAGE_SIZE;
      const fresh = runs.filter((run) => !seen.has(run.id));
      for (const run of fresh) {
        seen.add(run.id);
        if (run.event === "push" && run.head_branch === "main") {
          pushShown.add(run.head_sha);
        }
      }
      return { runs, fresh: fresh.filter(isBaselineCandidateRun) };
    };

    let shown = false;
    let olderRunSeen = false;
    while (!shown && !ended && pagesRead < maxPages) {
      const graceSpent = olderRunSeen;
      const { runs, fresh } = await readPage();
      newest ??= runs[0];
      candidates.push(...fresh);
      shown = runs.some((run) => run.id === options.currentRunId);
      if (graceSpent) break;
      olderRunSeen = runs.some((run) => run.id < options.currentRunId);
    }

    const current = shown || (!olderRunSeen && !ended);
    if (!current && attempt < attempts) {
      warn(
        `  Warning: the workflow's run listing left out this run, ` +
          `${options.currentRunId}; the newest it named is ` +
          `${describeRun(newest)}. Reading it again (attempt ${attempt + 1} ` +
          `of ${attempts}).`,
      );
      await wait(RUN_LISTING_RETRY_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }

    return {
      current,
      reachedCurrentRun: shown,
      candidates,
      newest,
      pagesRead,
      older: async () => {
        if (ended || pagesRead >= maxPages) return null;
        log(`Reading page ${pagesRead + 1} of the workflow's run listing.`);
        return (await readPage()).fresh;
      },
      accountsFor: (sha) => pushShown.has(sha),
    };
  }
}

/** Says what the run listing held, and how far a baseline can be sought. */
export function reportBaselineRunListing(
  listing: BaselineRunListing,
  currentRunId: number,
  log: (message: string) => void = console.log,
  warn: (message: string) => void = console.warn,
): void {
  const pages = pluralize(listing.pagesRead, "page");
  if (!listing.current) {
    warn(
      `  Warning: the workflow's run listing is not current: ${pages} of it ` +
        `never showed this run, ${currentRunId}, and the newest run it named ` +
        `is ${describeRun(listing.newest)}.`,
    );
    return;
  }

  log(
    `Read ${pages} of the workflow's run listing: the newest run is ` +
      `${describeRun(listing.newest)}, and ${
        pluralize(listing.candidates.length, "successful `main` push run")
      } so far could be a baseline.`,
  );
  if (!listing.reachedCurrentRun) {
    warn(
      `  Warning: this run, ${currentRunId}, was created longer ago than ` +
        `${pages} of the run listing reach, so the \`main\` runs for the ` +
        "commit it merges are out of reach too.",
    );
  }
}

function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export async function readHeadCommitObject(
  cwd?: string,
): Promise<string | null> {
  try {
    const result = await new Deno.Command("git", {
      args: ["cat-file", "commit", "HEAD"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      console.warn(
        `  Warning: could not read the \`HEAD\` commit object: ${
          new TextDecoder().decode(result.stderr).trim()
        }`,
      );
      return null;
    }
    return new TextDecoder().decode(result.stdout);
  } catch (error) {
    console.warn(
      `  Warning: could not run \`git\` to read the \`HEAD\` commit object: ${
        formatErrorForLog(error)
      }`,
    );
    return null;
  }
}

/**
 * Reads the base-branch commit the checked-out tree merges this pull request
 * into.
 *
 * A `pull_request` run checks out `refs/pull/<number>/merge`, a merge commit
 * whose first parent is the base-branch commit and whose second parent is the
 * pull request head. GitHub rebuilds that merge ref whenever the base branch
 * moves and does not rewrite the base recorded in the triggering event, so the
 * event can name an older commit than the one the checkout merged. The commit
 * object names the commit whose code the test jobs ran.
 *
 * The parents come from the raw commit object, because `actions/checkout`
 * clones to depth one and git treats a shallow boundary commit as having no
 * parents. `git cat-file` prints the stored object, which still lists them.
 *
 * Returns null when `HEAD` has fewer than two parents, and when `git` cannot
 * be run.
 */
export async function readBaseBranchSha(
  readCommitObject: () => Promise<string | null> = readHeadCommitObject,
): Promise<string | null> {
  const commit = await readCommitObject();
  if (commit === null) return null;

  const parents: string[] = [];
  for (const line of commit.split("\n")) {
    // The header ends at the first blank line; the commit message that follows
    // it can contain a line that reads like a parent.
    if (line === "") break;
    const match = /^parent ([0-9a-f]{40,64})$/.exec(line);
    if (match) parents.push(match[1]);
  }

  return parents.length >= 2 ? parents[0] : null;
}

/** How far back from the base-branch commit a baseline may sit. */
const BASELINE_ANCESTRY_DEPTH = 100;

/** The compare endpoint returns at most this many files. */
const COMPARE_FILE_LIMIT = 300;

/**
 * Reads how far back each recent commit sits from the base-branch commit this
 * run merged, newest first, so that `0` is that commit itself.
 *
 * Listing commits from the base-branch commit walks its ancestry, so a commit
 * absent from the result is not an ancestor. That is what keeps a `main` run
 * that landed after this run started from becoming the baseline: it measured
 * base-branch code this run does not contain.
 */
export async function fetchAncestorRanks(
  baseSha: string,
  depth = BASELINE_ANCESTRY_DEPTH,
): Promise<Map<string, number>> {
  const commits = await githubGet<{ sha: string }[]>(
    `/repos/${REPO}/commits?sha=${
      encodeURIComponent(baseSha)
    }&per_page=${depth}`,
  );
  return new Map(commits.map((commit, index) => [commit.sha, index]));
}

/** One baseline run, as much of it as choosing a baseline needs. */
export interface BaselineRunReading {
  /** The run's uncovered-line count per metric, from its baseline artifact. */
  samples: Map<string, BaselineSample>;

  /** What the run's merged pull request accepted, when it has one. */
  overrides: BaselineOverrides | null;

  /** True when the run compiled patterns from scratch. */
  cold: boolean;
}

export interface WalkBaselineRunsOptions {
  /**
   * The metrics to find a baseline for. An array rather than any iterable,
   * because a one-shot iterator would leave a second pass over it empty.
   */
  metrics: readonly string[];

  /** Recent `main` runs, newest first. */
  runs: WorkflowRun[];

  /**
   * Reads the next older page of `main` runs, or returns null when there is
   * none. Asked while a metric still has no baseline, in two cases: the runs in
   * hand have all been read, or the next one is for an ancestor with a nearer
   * commit not yet accounted for, whose run an older page may hold.
   */
  olderRuns?: () => Promise<WorkflowRun[] | null>;

  /**
   * Whether the run listing read so far has shown a `main` push run for a
   * commit; see `BaselineRunListing.accountsFor()`. Every commit counts as
   * accounted for when this is left out.
   */
  accountedFor?: (sha: string) => boolean;

  /** The most runs the walk reads; `BASELINE_RUNS` when left out. */
  maxRunsRead?: number;

  /** Reads one run. Called only for the runs the walk reaches. */
  readRun: (run: WorkflowRun) => Promise<BaselineRunReading>;

  /**
   * How far back from the base-branch commit this run merged each recent commit
   * sits, or null when there is no base-branch commit to measure against.
   */
  ancestorRank: Map<string, number> | null;
}

/**
 * Chooses every metric's ratchet baseline: the `main` run for the nearest
 * ancestor of the base-branch commit this run merged.
 *
 * The base-branch commit's own run is the ideal baseline, because it measured
 * exactly the base-branch code this run merged, leaving the pull request as the
 * only difference between the two numbers. It is often available, but a run
 * still going or one that failed leaves the nearest ancestor with a usable run
 * standing in for it. Whatever the base branch changed in between is then in
 * this run and not in the baseline, so `isComparableBaseline()` withholds
 * gating from the groups it touched. A run for a commit that is not an ancestor
 * is never a baseline: it landed after this run started, so it measured code
 * this run does not contain.
 *
 * A non-cold run wins: a cold run covers cold-compile-only branches, and its
 * lower debt would hold a warm pull request to an unreachable bar. When every
 * ancestor is cold the nearest one stands, so a metric never loses its baseline
 * to coldness alone.
 *
 * A merged pull request that accepted a metric's debt, with a per-group
 * acceptance or the whole-coverage reset marker, sets the floor: its own run is
 * the oldest baseline the ratchet may reach for that metric, so the accepted
 * level is what later runs are held to and nothing older undoes it. Only a run
 * that both carries the acceptance and measured the metric stops the walk —
 * an acceptance whose run uploaded no baseline artifact leaves the search to
 * continue past it. An acceptance that merged onto a commit this run does not
 * contain sets no floor here, for the same reason such a run is no baseline.
 *
 * Runs are read one at a time in the order `baselineWalkOrder()` gives, and the
 * walk stops as soon as every metric has its baseline, so a run that measured
 * every metric is the only one read. When the runs in hand are spent first, the
 * walk asks `olderRuns()` for the next page and carries on with those too. It
 * gives up after `maxRunsRead` runs, so a metric no `main` run has measured
 * costs a bounded number of reads.
 *
 * The order holds across pages, not only within one. A page further back holds
 * runs created earlier, which are usually the ones for commits further from the
 * base-branch commit, but two pushes landing together can have their runs
 * created in the other order, and a page boundary can fall between them. So
 * before the walk reads the run for an ancestor, every commit nearer the
 * base-branch commit has to be accounted for: its run already read, or
 * `accountedFor()` saying the listing has shown a run for it. Until then the
 * walk asks for older pages, and it takes what it has once there are none. A
 * commit with no run at all therefore costs the rest of the page budget, on the
 * runs that have to look past it.
 */
export async function walkBaselineRuns(
  options: WalkBaselineRunsOptions,
): Promise<Map<string, BaselineSample>> {
  const pending = new Set(options.metrics);
  const chosen = new Map<string, BaselineSample>();
  const coldFallback = new Map<string, BaselineSample>();
  const maxRunsRead = options.maxRunsRead ?? BASELINE_RUNS;
  const accountedFor = options.accountedFor ?? (() => true);
  const ancestorRank = options.ancestorRank;

  const unread = [...options.runs];
  const readShas = new Set<string>();
  let olderRuns = options.olderRuns;
  let runsRead = 0;

  // Whether every commit nearer the base-branch commit than `run`'s is
  // accounted for, so that no run for one of them is still to come.
  const nearerCommitsSettled = (run: WorkflowRun): boolean => {
    const rank = ancestorRank?.get(run.head_sha);
    if (ancestorRank == null || rank === undefined) return true;
    for (const [sha, nearer] of ancestorRank) {
      if (nearer < rank && !readShas.has(sha) && !accountedFor(sha)) {
        return false;
      }
    }
    return true;
  };

  while (pending.size > 0 && runsRead < maxRunsRead) {
    const next = baselineWalkOrder(unread, ancestorRank).at(0);
    if (olderRuns !== undefined && !(next && nearerCommitsSettled(next))) {
      const older = await olderRuns();
      if (older === null) olderRuns = undefined;
      else unread.push(...older);
      continue;
    }
    if (next === undefined) break;

    unread.splice(unread.indexOf(next), 1);
    const reading = await options.readRun(next);
    readShas.add(next.head_sha);
    runsRead++;

    for (const metric of [...pending]) {
      const sample = reading.samples.get(metric);
      if (sample === undefined) continue;

      if (!reading.cold) {
        chosen.set(metric, sample);
        pending.delete(metric);
        continue;
      }
      if (!coldFallback.has(metric)) coldFallback.set(metric, sample);

      if (reading.overrides && acceptsCoverageDebt(reading.overrides, metric)) {
        pending.delete(metric);
      }
    }
  }

  for (const [metric, sample] of coldFallback) {
    if (!chosen.has(metric)) chosen.set(metric, sample);
  }
  return chosen;
}

/**
 * The order the walk reads runs in: the run for the base-branch commit itself
 * first, then its ancestors from nearest to furthest, and runs whose commit is
 * not an ancestor left out entirely. Two runs for one commit read oldest first,
 * matching how a ranked search settles that tie.
 *
 * Ranking rather than trusting the order the runs arrive in matters because the
 * walk takes the first answer it finds and stops. Run creation follows the push
 * order that ancestry describes, but not through a history rewrite, and not
 * across two pushes that land in the same second.
 *
 * Without an ancestry to rank against — a `main` push run, a checkout that is
 * not a merge, or a commit listing that could not be fetched — the runs stand
 * as given, newest first, and the newest usable one wins.
 */
function baselineWalkOrder(
  runs: WorkflowRun[],
  ancestorRank: Map<string, number> | null,
): WorkflowRun[] {
  if (ancestorRank === null) return runs;

  return runs
    .filter((run) => ancestorRank.has(run.head_sha))
    .sort((a, b) =>
      ancestorRank.get(a.head_sha)! - ancestorRank.get(b.head_sha)! ||
      a.created_at.localeCompare(b.created_at) ||
      a.id - b.id
    );
}

/**
 * Reads the coverage source groups the base branch changed between the baseline
 * run's commit and the base-branch commit this run merged.
 *
 * A group's uncovered-line count is a total over its files, so a group the base
 * branch touched in between has a baseline counting different code from this
 * run. Those groups are the ones the ratchet cannot speak to. Every other
 * group's total stays comparable, which is what lets a pull request still be
 * gated when the base-branch commit has no run of its own.
 */
export async function fetchGroupsChangedOnBase(
  baselineSha: string,
  baseSha: string,
  warn: (message: string) => void = console.warn,
): Promise<Set<string>> {
  if (baselineSha === baseSha) return new Set();

  const comparison = await githubGet<{ files?: { filename: string }[] }>(
    `/repos/${REPO}/compare/${encodeURIComponent(baselineSha)}...${
      encodeURIComponent(baseSha)
    }`,
  );
  const files = comparison.files ?? [];
  if (files.length >= COMPARE_FILE_LIMIT) {
    warn(
      `  Warning: comparing ${baselineSha.slice(0, 8)} against ${
        baseSha.slice(0, 8)
      } hit the ${COMPARE_FILE_LIMIT}-file response cap, so a group the base ` +
        "branch changed may still be gated.",
    );
  }
  return coverageGroupsForChangedFiles(files.map((file) => file.filename));
}

/**
 * Returns whether a metric's baseline can be held against this run.
 *
 * The two numbers must count the same base-branch code, or the difference
 * between them is not the pull request's. Three things break that, and each
 * leaves the metric reported and not gated:
 *
 * - No base-branch commit. Without one there is no ancestry to select against,
 *   so the baseline is whatever ran most recently and counts unrelated code.
 * - No baseline at all for the metric.
 * - A group the base branch changed between this metric's own baseline commit
 *   and the base-branch commit. The lookup is keyed by that commit, so a metric
 *   whose baseline is the base-branch commit itself stays gated even when
 *   another metric fell back to an older one.
 *
 * A `main` push run has no base-branch commit and is informational, so it
 * reports against whatever baseline it has.
 */
export function isComparableBaseline(
  options: {
    sample: BaselineSample | undefined;
    metric: string;
    baseSha: string | null;
    groupsChangedByBaseline: Map<string, Set<string>>;
    isPullRequest: boolean;
  },
): boolean {
  if (!options.isPullRequest) return true;
  if (options.baseSha === null || options.sample === undefined) return false;

  const group = coverageMetricGroupName(options.metric);
  if (group === null) return true;

  const moved = options.groupsChangedByBaseline.get(options.sample.sha);
  return !moved?.has(group);
}

export interface MetricBaseline {
  sample?: BaselineSample;

  /** Whether the ratchet may fail this metric against that sample. */
  comparable: boolean;

  /**
   * The base-branch commit the comparison was judged against: the commit this
   * run merges the pull request into. Absent on a `main` push run, and when
   * the commit could not be read.
   */
  baseSha?: string;
}

export interface SelectBaselinesOptions {
  /** The metrics to gate; an array, as in {@link WalkBaselineRunsOptions}. */
  metrics: readonly string[];

  /** Recent `main` runs, newest first. */
  runs: WorkflowRun[];

  /** Reads the next older page of `main` runs; see the walk's option. */
  olderRuns?: () => Promise<WorkflowRun[] | null>;

  /**
   * Whether the run listing read so far has shown a `main` push run for a
   * commit; `BaselineRunListing.accountsFor()`.
   */
  accountedFor?: (sha: string) => boolean;

  /** Reads one baseline run; called only for the runs the walk reaches. */
  readRun: (run: WorkflowRun) => Promise<BaselineRunReading>;

  isPullRequest: boolean;
  readBaseSha?: () => Promise<string | null>;
  fetchRanks?: (baseSha: string) => Promise<Map<string, number>>;
  fetchChangedGroups?: (
    baselineSha: string,
    baseSha: string,
  ) => Promise<Set<string>>;

  /** Wraps the GitHub calls made here so a rate limit ends the check as one. */
  guard?: <T>(description: string, operation: () => Promise<T>) => Promise<T>;

  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Chooses every metric's ratchet baseline against the base-branch commit this
 * run merged, and reports what it chose.
 *
 * Reads the base-branch commit, ranks its ancestry, walks the recent `main`
 * runs for each metric's baseline, and asks which coverage groups the base
 * branch moved since each baseline the walk picked.
 */
export async function selectBaselines(
  options: SelectBaselinesOptions,
): Promise<Map<string, MetricBaseline>> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const readBaseSha = options.readBaseSha ?? readBaseBranchSha;
  const fetchRanks = options.fetchRanks ?? fetchAncestorRanks;
  const fetchChangedGroups = options.fetchChangedGroups ??
    fetchGroupsChangedOnBase;
  const guard = options.guard ?? ((_description, operation) => operation());

  const baseSha = options.isPullRequest ? await readBaseSha() : null;
  if (options.isPullRequest && baseSha === null) {
    warn(
      "  Warning: could not read the base-branch commit this run merges " +
        "into; coverage debt metrics will be reported but not gated.",
    );
  } else if (baseSha !== null) {
    log(
      `This run merges the pull request into base-branch commit ${
        baseSha.slice(0, 8)
      }.`,
    );
  }

  const ancestorRank = baseSha === null ? null : await guard(
    "listing the base-branch commit's ancestry",
    () => fetchRanks(baseSha),
  );

  const olderRuns = options.olderRuns;
  const baselines = await walkBaselineRuns({
    metrics: options.metrics,
    runs: options.runs,
    olderRuns: olderRuns &&
      (() => guard("reading an older page of the run listing", olderRuns)),
    accountedFor: options.accountedFor,
    readRun: options.readRun,
    ancestorRank,
  });

  const groupsChangedByBaseline = new Map<string, Set<string>>();
  if (baseSha !== null) {
    const baselineShas = new Set(
      [...baselines.values()].map((sample) => sample.sha),
    );
    for (const sha of baselineShas) {
      groupsChangedByBaseline.set(
        sha,
        await guard(
          "comparing the baseline commit against the base-branch commit",
          () => fetchChangedGroups(sha, baseSha),
        ),
      );
    }
    reportBaselineDistance(baselineShas, baseSha, ancestorRank, log);
  }

  const resolved = new Map<string, MetricBaseline>();
  for (const metric of options.metrics) {
    const sample = baselines.get(metric);
    resolved.set(metric, {
      sample,
      baseSha: baseSha ?? undefined,
      comparable: isComparableBaseline({
        sample,
        metric,
        baseSha,
        groupsChangedByBaseline,
        isPullRequest: options.isPullRequest,
      }),
    });
  }
  return resolved;
}

/** Names the groups no baseline could speak to, and why they are not gated. */
export function reportUngatedGroups(
  groups: Set<string>,
  log: (message: string) => void = console.log,
): void {
  if (groups.size === 0) return;

  log(
    "\nNot gated, because no baseline counts the same base-branch code as " +
      `this run does: ${[...groups].sort().join(", ")}. A later run of this ` +
      "pull request gates them, once a `main` run has measured the commit it " +
      "merges.",
  );
}

/**
 * Reports which commit each baseline was measured at, and how far back from the
 * base-branch commit that sits.
 */
export function reportBaselineDistance(
  baselineShas: Set<string>,
  baseSha: string,
  ancestorRank: Map<string, number> | null,
  log: (message: string) => void = console.log,
): void {
  if (baselineShas.size === 0) {
    log(
      `No \`main\` run has measured base-branch commit ${
        baseSha.slice(0, 8)
      } or any of its ancestors.`,
    );
    return;
  }

  for (const sha of [...baselineShas].sort()) {
    const rank = ancestorRank?.get(sha);
    const distance = rank === undefined
      ? "at an unknown distance from"
      : rank === 0
      ? "at"
      : `${pluralize(rank, "commit")} before`;
    log(
      `Ratchet baseline measured ${distance} the base-branch commit: ${
        sha.slice(0, 8)
      }.`,
    );
  }
}

export function selectMergedPRForCommit(prs: PRInfo[]): PRInfo | null {
  return prs.find((pr) => pr.merged_at !== null) ?? prs[0] ?? null;
}

export interface PRLookupResult {
  pr: PRInfo | null;
  error: unknown | null;
}

export interface BaselineRunContext {
  run: WorkflowRun;
  artifacts: Artifact[];
  pr: PRInfo | null;
  prLookupError: unknown | null;
}

/**
 * Reads the merged pull request for `sha`, keeping a failure as a value rather
 * than throwing: a lookup that fails costs the run that pull request's accepted
 * debt, which is reported, not the whole check.
 *
 * A rate limit is the exception, and is rethrown. Kept as a value it would go
 * on to read as a commit whose pull request accepted nothing, which is a claim
 * about the baseline rather than about GitHub.
 */
export async function fetchPRForCommitWithError(
  sha: string,
): Promise<PRLookupResult> {
  try {
    const prs = await githubGet<PRInfo[]>(
      `/repos/${REPO}/commits/${sha}/pulls`,
    );
    return { pr: selectMergedPRForCommit(prs), error: null };
  } catch (error) {
    if (isGitHubRateLimitError(error)) throw error;
    return { pr: null, error };
  }
}

export function newestArtifactNamed(
  artifacts: Artifact[],
  name: string,
): Artifact | null {
  return newestArtifactsByName(
    artifacts.filter((artifact) => artifact.name === name && !artifact.expired),
  )[0] ?? null;
}

export function formatErrorForLog(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

/**
 * Lists one run's artifacts, reporting a failure as an empty list: a run whose
 * artifacts cannot be listed contributes no baseline, and the walk moves on to
 * the next one.
 *
 * A rate limit is the exception, and is rethrown. An empty list says the run
 * measured nothing, which would hold a changed group against no baseline and
 * report it as a run nobody has measured yet.
 */
export async function fetchArtifactsForRunBestEffort(
  run: WorkflowRun,
  fetchArtifacts: (runId: number) => Promise<Artifact[]> = fetchArtifactsForRun,
  warn: (message: string) => void = console.warn,
): Promise<Artifact[]> {
  try {
    return await fetchArtifacts(run.id);
  } catch (error) {
    if (isGitHubRateLimitError(error)) throw error;
    warn(`  Warning: could not fetch artifacts for run ${run.id}: ${error}`);
    return [];
  }
}

/**
 * Lists the artifacts of the run this check belongs to. When GitHub's rate
 * limit refuses the listing and the coverage profiles were downloaded ahead of
 * the check into `coverageArtifactsDir`, the downloaded directories stand in
 * for it. The profiles the check measures are read from those directories
 * either way, and the listing only names them, so the run still measures its
 * coverage; the baseline comparison reads the API again afterward, and reports
 * a limit it reaches there as a run left ungated.
 *
 * What stands in holds only what was downloaded, which leaves out the compile
 * cache states, so the run has none recorded. Any other failure, and a limit
 * with no downloaded directory to fall back on, is rethrown.
 */
export async function fetchCurrentRunArtifacts(
  runId: number,
  coverageArtifactsDir: string | undefined,
): Promise<Artifact[]> {
  try {
    return await fetchArtifactsForRun(runId);
  } catch (error) {
    if (!coverageArtifactsDir || !isGitHubRateLimitError(error)) throw error;
    console.warn(
      `  Warning: GitHub API rate limit while listing this run's artifacts; ` +
        `reading the ones downloaded to \`${coverageArtifactsDir}\` instead: ` +
        `${error}`,
    );
    return await downloadedArtifacts(coverageArtifactsDir);
  }
}

/**
 * Helper for {@link fetchCurrentRunArtifacts}, which names each artifact
 * downloaded into `dir` by the directory holding it. The id and the size are
 * the listing's to report, so each is zero here; what reads a downloaded
 * artifact, and what copies its files, tells it apart by name.
 */
async function downloadedArtifacts(dir: string): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isDirectory) continue;
    artifacts.push({
      id: 0,
      name: entry.name,
      size_in_bytes: 0,
      expired: false,
    });
  }
  return artifacts;
}

export interface BuildBaselineRunContextOptions {
  run: WorkflowRun;
  fetchArtifactsForRun?: (run: WorkflowRun) => Promise<Artifact[]>;
  fetchPRForCommit?: (sha: string) => Promise<PRLookupResult>;
}

/** Reads everything one baseline run contributes: its artifacts and its PR. */
export async function buildBaselineRunContext(
  options: BuildBaselineRunContextOptions,
): Promise<BaselineRunContext> {
  const fetchArtifacts = options.fetchArtifactsForRun ??
    fetchArtifactsForRunBestEffort;
  const fetchPR = options.fetchPRForCommit ?? fetchPRForCommitWithError;

  const [artifacts, prLookup] = await Promise.all([
    fetchArtifacts(options.run),
    fetchPR(options.run.head_sha),
  ]);
  return {
    run: options.run,
    artifacts,
    pr: prLookup.pr,
    prLookupError: prLookup.error,
  };
}

/**
 * Logs one line per baseline run: when it ran, the commit it measured, the
 * pull request that merged that commit, and whether it carries a perf-metrics
 * artifact. Names each run whose pull-request lookup failed a second time
 * after the group, with the error.
 */
export function reportBaselineContextResults(
  contexts: BaselineRunContext[],
): void {
  console.log("\n::group::Baseline source runs:\n");
  for (const { run, artifacts, pr, prLookupError } of contexts) {
    const baselineArtifact = newestArtifactNamed(
      artifacts,
      PERF_METRICS_ARTIFACT_NAME,
    );
    const prLabel = pr
      ? `PR #${pr.number}`
      : prLookupError
      ? "PR lookup failed"
      : "no PR found";
    const artifactLabel = baselineArtifact
      ? `perf-metrics artifact ${baselineArtifact.id}`
      : "no perf-metrics artifact";
    console.log(
      `  ${run.created_at} run ${run.id} ${run.head_sha.slice(0, 8)} ` +
        `${prLabel}; ${artifactLabel}`,
    );
  }
  console.log("\n::endgroup::\n");

  // The gate reads accepted coverage debt out of the merged pull request body,
  // so a run whose lookup failed contributes no overrides.
  for (const { run, prLookupError } of contexts) {
    if (!prLookupError) continue;
    console.warn(
      `  Warning: run ${run.id} (${
        run.head_sha.slice(0, 8)
      }) PR lookup failed: ${formatErrorForLog(prLookupError)}`,
    );
  }
}

export async function parseCoverageBaselineFromArtifacts(
  artifacts: Artifact[],
  parseMetrics: (
    artifactId: number,
  ) => Promise<CoverageBaselineDetailed | null> =
    downloadAndParseCoverageBaseline,
): Promise<CoverageBaselineDetailed | null> {
  const artifact = newestArtifactNamed(
    artifacts,
    PERF_METRICS_ARTIFACT_NAME,
  );
  if (!artifact) return null;

  return await parseMetrics(artifact.id);
}

/**
 * Download the JSON file(s) inside one cache-state artifact. Returns null
 * when the download or extraction fails.
 */
async function downloadCacheStateFiles(
  artifactId: number,
): Promise<string[] | null> {
  const tmpDir = await downloadAndExtractArtifact(artifactId, "cache-state-");
  if (!tmpDir) return null;
  try {
    const contents: string[] = [];
    for await (
      const entry of walk(tmpDir, { includeDirs: false, exts: [".json"] })
    ) {
      contents.push(await Deno.readTextFile(entry.path));
    }
    return contents;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/** `family=state` pairs for every cache family, absent shown as unknown. */
export function formatCompileCacheStates(states: CompileCacheStates): string {
  return COMPILE_CACHE_FAMILIES
    .map((family) => `${family}=${states[family] ?? "unknown"}`)
    .join(", ");
}

/**
 * Aggregate the current run's per-shard cache-state artifacts into per-family
 * compile cache states. Re-run duplicates are deduped newest-first — a re-run
 * restores the cache the first (cold) attempt saved, so it is genuinely warm.
 * Best-effort: any failure degrades to `{}` (all unknown) with a warning, so
 * a broken tag behaves like a pre-rollout run instead of failing the gate.
 */
export async function collectCurrentCacheStates(
  artifacts: Artifact[],
  download: (artifactId: number) => Promise<string[] | null> =
    downloadCacheStateFiles,
): Promise<CompileCacheStates> {
  try {
    const cacheStateArtifacts = newestArtifactsByName(artifacts.filter(
      (artifact) =>
        artifact.name.startsWith(CACHE_STATE_ARTIFACT_PREFIX) &&
        !artifact.expired,
    ));

    const contents: string[] = [];
    for (const artifact of cacheStateArtifacts) {
      const files = await download(artifact.id);
      if (!files) {
        throw new Error(
          `could not download cache-state artifact ${artifact.name} (${artifact.id})`,
        );
      }
      contents.push(...files);
    }
    const records = parseCacheStateFiles(contents);
    if (!records) {
      throw new Error(
        "one or more cache-state records failed to parse; a missing shard " +
          "could mislabel its family warm",
      );
    }
    return aggregateCacheStates(records);
  } catch (error) {
    console.warn(
      `  Warning: could not collect compile cache states; treating them as unknown: ${error}`,
    );
    return {};
  }
}

export const EXPECTED_COVERAGE_ARTIFACT_NAMES = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) =>
    `coverage-profile-workspace-${shard}`
  ),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) =>
    `coverage-profile-runner-${shard}`
  ),
  ...[1, 2].map((shard) => `coverage-profile-generated-patterns-${shard}`),
  "coverage-profile-package-runner",
  "coverage-profile-package-runtime-client",
  "coverage-profile-package-shell",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((shard) =>
    `coverage-profile-pattern-integration-${shard}`
  ),
  "coverage-profile-pattern-reload",
  ...[1, 2, 3, 4].map((chunk) => `coverage-profile-pattern-unit-${chunk}`),
];

function sampleForRun(
  run: WorkflowRun,
  uncoveredLines: number,
): BaselineSample {
  return {
    runId: run.id,
    sha: run.head_sha,
    createdAt: run.created_at,
    uncoveredLines,
  };
}

/**
 * Copies one coverage-profile artifact's contents into the directories the
 * combined report is built from, and reports what it found: how many raw
 * profile files and how many LCOV reports, plus the members the job that
 * uploaded it never launched, read from the record it carries.
 *
 * Each copy is named after the artifact it came from. Shards carry files of the
 * same name, so the name has to tell the artifacts apart, which is what the
 * artifact's own name does within one run; an artifact's id need not, since the
 * run's artifacts read from their downloaded directories carry none.
 */
export async function copyCoverageArtifactFiles(
  artifact: Artifact,
  profileDir: string,
  lcovDir: string,
  coverageArtifactsDir?: string,
): Promise<
  { profileFiles: number; lcovFiles: number; unlaunchedMembers: string[] }
> {
  let sourceDir: string;
  let removeSourceDir = false;
  if (coverageArtifactsDir) {
    sourceDir = path.join(coverageArtifactsDir, artifact.name);
    let sourceStat: Deno.FileInfo;
    try {
      sourceStat = await Deno.stat(sourceDir);
    } catch (error) {
      const problem = error instanceof Deno.errors.NotFound
        ? "was not found"
        : "could not be read";
      throw new Error(
        `Pre-downloaded coverage profile artifact ${artifact.name} (${artifact.id}) ${problem} at ${sourceDir}.`,
        { cause: error },
      );
    }
    if (!sourceStat.isDirectory) {
      throw new Error(
        `Pre-downloaded coverage profile artifact ${artifact.name} (${artifact.id}) is not a directory: ${sourceDir}.`,
      );
    }
  } else {
    const extractedDir = await downloadAndExtractArtifact(
      artifact.id,
      "coverage-profile-",
    );
    if (!extractedDir) {
      throw new Error(
        `Failed to download or extract coverage profile artifact ${artifact.name} (${artifact.id}).`,
      );
    }
    sourceDir = extractedDir;
    removeSourceDir = true;
  }

  let profileFiles = 0;
  let lcovFiles = 0;
  const unlaunchedMembers: string[] = [];
  try {
    for await (
      const entry of walk(sourceDir, { includeDirs: false })
    ) {
      if (path.basename(entry.path) === UNLAUNCHED_MEMBERS_FILE) {
        unlaunchedMembers.push(
          ...parseUnlaunchedMembers(await Deno.readTextFile(entry.path)),
        );
        continue;
      }
      const isLcov = entry.path.endsWith(".lcov");
      // Everything else the artifact carries stays where it is. Copying a file
      // `deno coverage` cannot parse in among the profiles would fail the
      // whole conversion.
      if (!isLcov && !entry.path.endsWith(".json")) continue;
      const count = isLcov ? lcovFiles : profileFiles;
      const destDir = isLcov ? lcovDir : profileDir;
      const dest = path.join(
        destDir,
        `${artifact.name}-${count}-${path.basename(entry.path)}`,
      );
      await Deno.copyFile(entry.path, dest);
      if (isLcov) lcovFiles++;
      else profileFiles++;
    }

    if (profileFiles === 0 && lcovFiles === 0) {
      throw new Error(
        `Coverage profile artifact ${artifact.name} (${artifact.id}) contained no profile or LCOV files.`,
      );
    }
  } finally {
    if (removeSourceDir) {
      try {
        await Deno.remove(sourceDir, { recursive: true });
      } catch { /* ignore cleanup errors */ }
    }
  }

  return { profileFiles, lcovFiles, unlaunchedMembers };
}

async function readCombinedLcov(lcovDir: string): Promise<string> {
  const chunks: string[] = [];
  for await (
    const entry of walk(lcovDir, { includeDirs: false, exts: [".lcov"] })
  ) {
    chunks.push(await Deno.readTextFile(entry.path));
  }
  return chunks.join("\n");
}

type TableAlign = "left" | "right";
export type Status =
  | "OVER"
  | "OK"
  | "ovrd"
  | "excl"
  | "n/a";

function printTextTable(
  headers: string[],
  rows: string[][],
  align: TableAlign[] = [],
): void {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[column]?.length ?? 0),
    )
  );

  const formatCell = (cell: string, column: number) =>
    align[column] === "right"
      ? cell.padStart(widths[column])
      : cell.padEnd(widths[column]);
  const formatRow = (cells: string[]) =>
    cells.map((cell, column) => formatCell(cell, column)).join("  ");

  console.log(formatRow(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

export function formatMetricValueForTable(
  value: number | undefined,
): string {
  if (value === undefined) return "-";
  return `${Math.round(value)}`;
}

export function formatMetricDelta(row: Row): string {
  if (row.baseline === undefined || row.pctIncrease === undefined) return "-";

  const delta = row.current - row.baseline;
  const sign = delta >= 0 ? "+" : "-";
  const formattedAbsolute = `${Math.round(Math.abs(delta))}`;
  const pctSign = row.pctIncrease >= 0 ? "+" : "";
  const pctDigits = row.pctIncrease !== 0 && Math.abs(row.pctIncrease) < 1
    ? 1
    : 0;
  return `${sign}${formattedAbsolute} (${pctSign}${
    row.pctIncrease.toFixed(pctDigits)
  }%)`;
}

export interface Row {
  metric: string;
  status: Status;
  current: number;

  /** Uncovered lines the chosen `main` run measured for this metric. */
  baseline?: number;

  /** Head SHA of the run that baseline came from. */
  baselineSha?: string;

  /** Id of the run that baseline came from. */
  baselineRunId?: number;

  /** Id of the run that measured `current`. */
  measuredRunId?: number;

  /**
   * The base-branch commit that run merged this pull request into. A
   * `pull_request` run measures `refs/pull/<number>/merge`, so this is the
   * `main` commit whose code the measurement covers.
   */
  baseSha?: string;

  pctIncrease?: number;
}

export function metricTableRows(
  rows: Row[],
  includeStatus: boolean,
): string[][] {
  return rows.map((row) => {
    const cells = [
      formatMetricValueForTable(row.baseline),
      formatMetricValueForTable(row.current),
      formatMetricDelta(row),
      coverageMetricGroupName(row.metric) ?? row.metric,
    ];
    return includeStatus ? [row.status, ...cells] : cells;
  });
}

export interface BuildCoverageRowsOptions {
  currentMetrics: Map<string, BaselineSample>;
  baselineByMetric: Map<string, MetricBaseline>;
  overrides: BaselineOverrides;

  /** Undefined when the PR's changed files could not be read. */
  changedCoverageGroups: Set<string> | undefined;
}

export interface CoverageRows {
  rows: Row[];

  /** The subset of `rows` that fails the gate. */
  failures: Row[];

  /** Groups whose baseline could not be held against this run. */
  ungatedGroups: Set<string>;

  /**
   * The subset of those groups the gate applied to, each with why it went
   * ungated: the groups where a regression would have passed unseen. A group
   * the pull request left alone is not one, since it is never gated, and
   * neither is one whose debt the description accepted.
   */
  notGated: CoverageNotGatedGroup[];
}

/** Why a metric the gate applied to was held against no baseline. */
function notGatedReason(
  baseline: MetricBaseline | undefined,
): CoverageNotGatedReason {
  if (baseline?.baseSha === undefined) return "no-base-commit";
  return baseline.sample === undefined ? "no-baseline" : "base-branch-moved";
}

/**
 * Scores every metric against its baseline and says which ones fail.
 *
 * A metric is failed only when it is gated and its count rose above the
 * baseline. It is not gated when the pull request left its group alone, when
 * the description accepts a rise at least as large as the one measured, or when
 * no baseline counts the same base-branch code as this run.
 *
 * An acceptance is read against the baseline this run chose rather than as a
 * total, so rebasing the pull request onto a different baseline changes what the
 * same acceptance line permits, and the pull request is still held to the amount
 * of new debt its author accepted.
 */
export function buildCoverageRows(
  options: BuildCoverageRowsOptions,
): CoverageRows {
  const rows: Row[] = [];
  const failures: Row[] = [];
  const ungatedGroups = new Set<string>();
  const notGated: CoverageNotGatedGroup[] = [];

  for (const [metric, currentSample] of options.currentMetrics) {
    const current = currentSample.uncoveredLines;
    const resolvedBaseline = options.baselineByMetric.get(metric);
    // What every row for this metric carries, whatever the gate decides: the
    // count, the run that measured it, and the base-branch commit that run
    // merged. A comment built from these rows reads them back out to say
    // where its numbers came from.
    const measured = {
      metric,
      current,
      measuredRunId: currentSample.runId,
      baseSha: resolvedBaseline?.baseSha,
    };
    const baselineSample = resolvedBaseline?.sample;
    const latestBaseline = baselineSample?.uncoveredLines;
    const acceptedRise = options.overrides.metrics.get(metric);
    const coverageReset = options.overrides.coverageBaselineReset;
    const comparable = resolvedBaseline?.comparable ?? false;
    const group = coverageMetricGroupName(metric);
    if (!comparable && group !== null) ungatedGroups.add(group);
    const gateApplies = shouldGateCoverageDebtMetric(
      metric,
      options.changedCoverageGroups,
    );
    const shouldGateCoverage = comparable && gateApplies;
    // Called where a row is excluded: a gate that applied and compared nothing
    // is the state a reader has to be told about.
    const noteIfNotGated = () => {
      if (comparable || !gateApplies || group === null) return;
      notGated.push({
        group,
        reason: notGatedReason(resolvedBaseline),
        baselineSha: baselineSample?.sha,
      });
    };

    if (latestBaseline === undefined) {
      // With no baseline the ratchet holds the metric to zero, as the gating
      // branch below does, so the whole of an acceptance is available here.
      if (
        coverageReset || (acceptedRise !== undefined && current <= acceptedRise)
      ) {
        rows.push({ ...measured, status: "ovrd" });
      } else if (!shouldGateCoverage) {
        rows.push({ ...measured, status: "excl" });
        noteIfNotGated();
      } else if (current > 0) {
        const row: Row = {
          ...measured,
          status: "OVER",
          baseline: 0,
          pctIncrease: 100,
        };
        rows.push(row);
        failures.push(row);
      } else {
        rows.push({ ...measured, status: "n/a" });
      }
      continue;
    }

    const pctIncrease = latestBaseline === 0
      ? current > 0 ? 100 : 0
      : ((current - latestBaseline) / latestBaseline) * 100;
    const stats = {
      baseline: latestBaseline,
      baselineSha: baselineSample?.sha,
      baselineRunId: baselineSample?.runId,
      pctIncrease,
    };

    if (coverageReset) {
      rows.push({ ...measured, status: "ovrd", ...stats });
      continue;
    }

    if (
      acceptedRise !== undefined && current <= latestBaseline + acceptedRise
    ) {
      rows.push({ ...measured, status: "ovrd", ...stats });
      continue;
    }

    if (!shouldGateCoverage) {
      rows.push({ ...measured, status: "excl", ...stats });
      noteIfNotGated();
      continue;
    }

    if (current > latestBaseline) {
      const row: Row = { ...measured, status: "OVER", ...stats };
      rows.push(row);
      failures.push(row);
    } else {
      rows.push({ ...measured, status: "OK", ...stats });
    }
  }

  return { rows, failures, ungatedGroups, notGated };
}

export function printMetricTable(rows: Row[], includeStatus = false): void {
  const headers = includeStatus
    ? ["Status", "Baseline", "Current", "Change", "Group"]
    : ["Baseline", "Current", "Change", "Group"];
  const align = includeStatus
    ? ["left", "right", "right", "right", "left"] as TableAlign[]
    : ["right", "right", "right", "left"] as TableAlign[];
  printTextTable(headers, metricTableRows(rows, includeStatus), align);
}

/** The coverage-profile artifacts of one run, one per artifact name. */
function coverageProfileArtifacts(artifacts: Artifact[]): Artifact[] {
  return newestArtifactsByName(artifacts.filter(
    (artifact) =>
      artifact.name.startsWith(COVERAGE_PROFILE_ARTIFACT_PREFIX) &&
      !artifact.expired,
  ));
}

/**
 * Join one run's coverage-profile artifacts into a single LCOV report, and
 * name the workspace members the run never launched. A job uploads its own
 * LCOV; the profile-file branch reads the raw V8 profiles a run predating that
 * upload carries.
 *
 * Each artifact carries the record of what the job that wrote it selected and
 * never started, and one job selects each member, so the union across
 * artifacts is the set of members nothing in the run measured against their
 * own tests.
 */
export async function combinedLcovFromArtifacts(
  coverageArtifacts: Artifact[],
  coverageArtifactsDir?: string,
): Promise<
  { lcov: string; sourceDescription: string; unlaunchedMembers: Set<string> }
> {
  const profileDir = await Deno.makeTempDir({ prefix: "coverage-profiles-" });
  const lcovDir = await Deno.makeTempDir({ prefix: "coverage-lcov-" });
  try {
    let profileFileCount = 0;
    let lcovFileCount = 0;
    const unlaunchedMembers = new Set<string>();
    for (const artifact of coverageArtifacts) {
      const copied = await copyCoverageArtifactFiles(
        artifact,
        profileDir,
        lcovDir,
        coverageArtifactsDir,
      );
      profileFileCount += copied.profileFiles;
      lcovFileCount += copied.lcovFiles;
      for (const member of copied.unlaunchedMembers) {
        unlaunchedMembers.add(member);
      }
    }

    if (profileFileCount === 0 && lcovFileCount === 0) {
      throw new Error(
        "Coverage profile artifacts contained no profile or LCOV files.",
      );
    }

    return {
      lcov: lcovFileCount > 0
        ? await readCombinedLcov(lcovDir)
        : await lcovFromCoverageProfile(profileDir),
      sourceDescription: lcovFileCount > 0
        ? `${lcovFileCount} LCOV report files`
        : `${profileFileCount} coverage profile files`,
      unlaunchedMembers,
    };
  } finally {
    try {
      await Deno.remove(profileDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
    try {
      await Deno.remove(lcovDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * The line the log carries for a run that left members unlaunched: which
 * members, and which metric groups the run therefore does not score. Returns
 * `undefined` for a run that launched everything it selected.
 *
 * A group the metrics leave out gets no row, so without this line it reads the
 * same as a group with nothing to report.
 */
export function unscoredGroupsReport(
  unlaunchedMembers: Iterable<string>,
): string | undefined {
  const members = [...unlaunchedMembers].sort();
  if (members.length === 0) return undefined;
  const groups = [...unscoredMetricGroups(members)].sort();
  return `This run never launched ${members.join(", ")}, so it carries no ` +
    `measurement of ${groups.join(", ")} and does not score them.`;
}

async function extractCoverageDebtSamples(
  run: WorkflowRun,
  artifacts: Artifact[],
  coverageArtifactsDir?: string,
): Promise<{ samples: Map<string, BaselineSample>; lcov: string }> {
  const metrics = new Map<string, BaselineSample>();
  const coverageArtifacts = coverageProfileArtifacts(artifacts);
  const coverageArtifactNames = new Set(
    coverageArtifacts.map((artifact) => artifact.name),
  );
  const missingArtifacts = EXPECTED_COVERAGE_ARTIFACT_NAMES.filter((name) =>
    !coverageArtifactNames.has(name)
  );

  if (missingArtifacts.length > 0) {
    throw new Error(
      `Missing coverage profile artifact(s): ${missingArtifacts.join(", ")}`,
    );
  }

  const { lcov, sourceDescription, unlaunchedMembers } =
    await combinedLcovFromArtifacts(
      coverageArtifacts,
      coverageArtifactsDir,
    );

  // Every coverage stream feeds the gate: V8 runtime coverage, unit pattern
  // coverage (TN:pattern-runtime), and integration pattern coverage
  // (TN:pattern-runtime-integration) all join here, and a line covered by any
  // of them counts covered. So a pattern line an end-to-end flow exercises
  // that the unit suite does not lowers the gated debt.
  const coverageMetrics = await collectCoverageDebtMetricsFromLcov({
    rootDir: Deno.cwd(),
    lcov,
    unlaunchedMembers,
  });
  for (const metric of coverageMetrics) {
    metrics.set(metric.name, sampleForRun(run, metric.uncoveredLines));
  }

  console.log(
    `Extracted ${coverageMetrics.length} coverage debt metrics from ${sourceDescription}.`,
  );

  const unscored = unscoredGroupsReport(unlaunchedMembers);
  if (unscored !== undefined) console.warn(unscored);

  return { samples: metrics, lcov };
}

/**
 * Join the coverage-profile artifacts of a `main` run into one LCOV report.
 * Returns null when the run has none, or when the download fails: the comment
 * this feeds is best-effort, and a regression is reported either way.
 */
export async function baselineLcovForRun(
  runId: number,
  fetchArtifacts: (runId: number) => Promise<Artifact[]> = fetchArtifactsForRun,
): Promise<string | null> {
  try {
    const artifacts = coverageProfileArtifacts(await fetchArtifacts(runId));
    if (artifacts.length === 0) {
      console.warn(
        `  Warning: baseline run ${runId} has no coverage profile artifacts.`,
      );
      return null;
    }
    const { lcov } = await combinedLcovFromArtifacts(artifacts);
    return lcov;
  } catch (error) {
    console.warn(
      `  Warning: could not read coverage from baseline run ${runId}: ${error}`,
    );
    return null;
  }
}

/** File the coverage-comment payload is written to; tests override via env. */
function coverageCommentOutputPath(): string {
  return Deno.env.get("COVERAGE_COMMENT_FILE") ?? COVERAGE_COMMENT_FILE;
}

/**
 * Decide and write the coverage-debt comment payload for a PR. A coverage
 * regression writes a "regressed" body; a run that held a changed group against
 * no baseline writes an "ungated" one; any other run writes a "resolved"
 * payload so the poster can collapse any earlier comment. Done for every real PR
 * run, pass or fail, so a fixed regression is reflected even when the run still
 * fails for other reasons.
 *
 * A regression comes first because it is what the author has to act on, and the
 * run after the fix reports whatever is still ungated then.
 */
export async function writeCoverageComment(
  prNumber: number,
  coverageFailures: Row[],
  coverageRows: Row[],
  prFiles: PRFile[],
  lcov: string,
  notGated?: CoverageNotGatedInput,
): Promise<void> {
  if (coverageFailures.length > 0) {
    await writeCoverageDebtSuggestion(
      prNumber,
      coverageFailures,
      prFiles,
      lcov,
    );
  } else if (notGated !== undefined && notGated.groups.length > 0) {
    await writeCoverageNotGated(prNumber, notGated);
  } else {
    await writeCoverageResolved(prNumber, coverageRows, prFiles, lcov);
  }
}

/**
 * Writes the "ungated" coverage-comment payload, for the poster to post or to
 * rewrite the pull request's one coverage comment with. Never throws — this is
 * best-effort, like the regression path.
 */
export async function writeCoverageNotGated(
  prNumber: number,
  notGated: CoverageNotGatedInput,
): Promise<void> {
  try {
    const payload: CoverageCommentPayload = {
      prNumber,
      state: "ungated",
      body: buildCoverageNotGatedComment(notGated),
    };
    const outputFile = coverageCommentOutputPath();
    await Deno.writeTextFile(outputFile, JSON.stringify(payload, null, 2));
    console.log(
      `Wrote ${outputFile} (not gated) for PR #${prNumber}; the coverage-comment workflow will post or update it.`,
    );
  } catch (error) {
    console.warn(
      `  Warning: could not write the not-gated coverage comment for PR #${prNumber}: ${error}`,
    );
  }
}

/**
 * Where the counts in `rows` were measured. Every row comes from the same run
 * and the same base-branch commit, so the first row that names each speaks for
 * all of them, and a row that names neither leaves both out.
 */
function measurementFromRows(rows: Row[]): CoverageMeasurement {
  const runId = rows.find((row) => row.measuredRunId !== undefined)
    ?.measuredRunId;
  return {
    runUrl: runId === undefined ? undefined : workflowRunUrl(runId),
    baseSha: rows.find((row) => row.baseSha)?.baseSha,
  };
}

/**
 * Build the body naming the lines a regression the pull request did not cause
 * is charged for: lines this run leaves uncovered in files the pull request
 * never touched, which the baseline run covered.
 *
 * Returns null when there is nothing to say — no baseline run to compare
 * against, its coverage cannot be read, or every affected line is in a file the
 * pull request changed — and the caller falls back to the ordinary comment.
 */
export interface UnattributedRegressionOptions {
  /** Repository checkout whose source files the LCOV reports describe. */
  rootDir: string;

  groups: CoverageSuggestionGroup[];
  coverageFailures: Row[];
  prFiles: PRFile[];

  /** LCOV from this run. */
  lcov: string;

  readBaselineLcov: (runId: number) => Promise<string | null>;
}

interface UnattributedRegressionFile extends CoverageUnattributedFile {
  group: string;
}

interface UnattributedRegressionAttribution {
  files: UnattributedRegressionFile[];
  baselineByGroup: Map<string, CoverageRunIdentity>;
}

/**
 * Resolve an unattributed regression to unchanged files by comparing each
 * affected group's current LCOV with the particular baseline run that supplied
 * its ratchet. The result stays as data so both the failing and accepted-debt
 * comment paths can describe the same attribution.
 */
async function collectUnattributedRegressionAttribution(
  options: Omit<UnattributedRegressionOptions, "groups">,
): Promise<UnattributedRegressionAttribution> {
  // Each metric resolves its own ratchet baseline, so two regressed groups can
  // be held against two different `main` runs. A group is compared against the
  // run its own baseline came from and no other: another run measured a
  // different commit, where the same line may legitimately have been covered.
  const groupsByBaselineRun = new Map<number, Set<string>>();
  const baselineByGroup = new Map<string, CoverageRunIdentity>();
  for (const failure of options.coverageFailures) {
    const runId = failure.baselineRunId;
    if (runId === undefined) continue;
    const group = coverageMetricGroupName(failure.metric);
    if (group === null) continue;
    const groups = groupsByBaselineRun.get(runId) ?? new Set<string>();
    groups.add(group);
    groupsByBaselineRun.set(runId, groups);
    baselineByGroup.set(group, {
      runUrl: workflowRunUrl(runId),
      sha: failure.baselineSha,
    });
  }

  const changedFiles = new Set(
    options.prFiles.map((prFile) => prFile.filename.replaceAll("\\", "/")),
  );

  const files: UnattributedRegressionFile[] = [];
  for (const [runId, groups] of groupsByBaselineRun) {
    const baselineLcov = await options.readBaselineLcov(runId);
    if (baselineLcov === null) continue;
    const regressed = await collectRegressedLines({
      rootDir: options.rootDir,
      lcov: options.lcov,
      baselineLcov,
      groups,
      changedFiles,
    });
    for (const file of regressed) {
      files.push({
        relativePath: file.relativePath,
        group: file.metricGroup,
        lines: file.lines,
      });
    }
  }

  return { files, baselineByGroup };
}

export async function buildUnattributedRegressionBody(
  options: UnattributedRegressionOptions,
): Promise<string | null> {
  const { files, baselineByGroup } =
    await collectUnattributedRegressionAttribution(options);

  if (files.length === 0) return null;

  const total = files.reduce((sum, file) => sum + file.lines.length, 0);
  console.log(
    `Regression not attributable to this PR's added lines: ${total} line(s) ` +
      `across ${files.length} unchanged file(s) that the baseline run covered.`,
  );
  return buildCoverageDebtUnattributedComment({
    groups: options.groups.map((group) => ({
      ...group,
      baseline: baselineByGroup.get(group.group),
    })),
    files,
    measurement: measurementFromRows(options.coverageFailures),
  });
}

/**
 * Per changed file in one of `groups`, how many of the lines the pull request
 * added no test executes. Files that added no uncovered line are left out.
 *
 * This is the attribution both coverage comments carry: a regression names the
 * files to write tests for, and an accepted debt names the files the acceptance
 * stands in for. Uncovered line numbers are resolved only for changed files in
 * those groups, so per-line data is never materialized for the whole workspace.
 */
async function uncoveredAddedLinesByFile(
  prFiles: PRFile[],
  lcov: string,
  groups: Set<string>,
): Promise<CoverageSuggestionFileLines[]> {
  const changedInGroups = prFiles
    .map((prFile) => prFile.filename.replaceAll("\\", "/"))
    .filter((relativePath) => {
      const group = coverageGroupForChangedFile(relativePath);
      return group !== null && groups.has(group);
    });
  const uncoveredByPath = await collectUncoveredLinesForFiles({
    rootDir: Deno.cwd(),
    lcov,
    files: changedInGroups,
  });

  const files: CoverageSuggestionFileLines[] = [];
  for (const prFile of prFiles) {
    const relativePath = prFile.filename.replaceAll("\\", "/");
    const group = coverageGroupForChangedFile(relativePath);
    if (!group || !groups.has(group)) continue;

    const uncoveredLines = uncoveredByPath.get(relativePath);
    if (!uncoveredLines || !prFile.patch) continue;

    const addedLines = parseAddedLinesFromPatch(prFile.patch);
    const uncoveredCount = uncoveredLines.filter((line) =>
      addedLines.has(line)
    ).length;
    if (uncoveredCount > 0) files.push({ relativePath, group, uncoveredCount });
  }
  return files;
}

/**
 * Write the coverage-debt regression comment to a file for a later workflow to
 * post. The gate runs on `pull_request`, where fork PRs get a read-only token
 * and cannot comment, so the `post-coverage-comment` job of the Pull
 * Request Comments workflow posts this from the base-repo context instead. Never throws — this is best-effort so it cannot
 * mask the regression failure itself.
 */
export async function writeCoverageDebtSuggestion(
  prNumber: number,
  coverageFailures: Row[],
  prFiles: PRFile[],
  lcov: string,
  readBaselineLcov: (runId: number) => Promise<string | null> =
    baselineLcovForRun,
): Promise<void> {
  const groups = coverageFailures
    .map((failure) => ({
      group: coverageMetricGroupName(failure.metric),
      target: Math.round(failure.baseline ?? 0),
      current: Math.round(failure.current),
    }))
    .filter((group): group is CoverageSuggestionGroup => group.group !== null);

  if (groups.length === 0) return;

  const files = await uncoveredAddedLinesByFile(
    prFiles,
    lcov,
    new Set(groups.map((group) => group.group)),
  );

  try {
    // Nothing the pull request added accounts for the regression, so the lines
    // it is charged for are somewhere it did not touch. Say which ones by
    // comparing this run against the baseline run line by line.
    const unattributed = files.length === 0
      ? await buildUnattributedRegressionBody({
        rootDir: Deno.cwd(),
        groups,
        coverageFailures,
        prFiles,
        lcov,
        readBaselineLcov,
      })
      : null;
    const body = unattributed ??
      buildCoverageDebtSuggestionComment({ groups, files });
    const payload: CoverageCommentPayload = {
      prNumber,
      state: "regressed",
      body,
    };
    const outputFile = coverageCommentOutputPath();
    await Deno.writeTextFile(outputFile, JSON.stringify(payload, null, 2));
    console.log(
      `Wrote ${outputFile} for PR #${prNumber}; the coverage-comment workflow will post or update it.`,
    );
  } catch (error) {
    console.warn(
      `  Warning: could not write coverage suggestion comment for PR #${prNumber}: ${error}`,
    );
  }
}

/**
 * Write a "resolved" coverage-comment payload so the coverage-comment workflow
 * can collapse and rewrite an earlier regression comment on the PR. The payload
 * is always written when coverage is acceptable: a run cannot tell whether a
 * comment exists, nor what files earlier commits on the PR changed, so it defers
 * that to the poster, which no-ops when there is nothing to update.
 *
 * `improvedLines` is the reduction this PR makes to the coverage debt it is
 * gated on: summed across the per-package groups whose files it changed, how far
 * each now sits below its `main` ratchet baseline. A passing gated group has
 * status "OK"; the workspace aggregate and untouched groups are "excl" and
 * overridden groups are "ovrd", so leaving everything but "OK" out keeps the
 * number to the debt this PR removed in the code it actually touched — not the
 * whole-workspace drift the gate never attributes to the PR. `groups` is the
 * per-group baseline-versus-this-PR breakdown for the source groups this PR
 * changed, the same groups the gate ratchets, so the collapsed comment can show
 * where the PR left coverage. Never throws —
 * best-effort, like the regression path.
 *
 * An accepted debt also carries the files holding the uncovered lines, because
 * this payload rewrites the regression comment that named them and would
 * otherwise leave the pull request with no record of which file the acceptance
 * is for. When no added line explains the regression, the same baseline LCOV
 * comparison as the failing path recovers its attribution to unchanged files.
 * Files are read only for an accepted debt: every other resolution covered its
 * debt rather than accepting it, so there is nothing to name.
 */
export async function writeCoverageResolved(
  prNumber: number,
  coverageRows: Row[],
  prFiles: PRFile[],
  lcov: string,
  options: {
    rootDir?: string;
    readBaselineLcov?: (runId: number) => Promise<string | null>;

    /**
     * True when the description reset the baseline and no row is there to say
     * so, because the run compared nothing.
     */
    reset?: boolean;
  } = {},
): Promise<void> {
  const improvedLines = coverageRows.reduce((sum, row) => {
    if (row.status !== "OK" || row.baseline === undefined) return sum;
    return sum + Math.max(0, Math.round(row.baseline - row.current));
  }, 0);

  // Summarize the source groups this PR changed — the per-group ratchet the
  // gate evaluates. Workspace is the aggregate behind `improvedLines`, so it
  // stays out of the per-group breakdown.
  const changedGroups = coverageGroupsForChangedFiles(
    prFiles.map((prFile) => prFile.filename),
  );
  const groups: CoverageResolvedGroup[] = coverageRows
    .map((row) => ({
      group: coverageMetricGroupName(row.metric),
      baseline: Math.round(row.baseline ?? 0),
      current: Math.round(row.current),
    }))
    .filter((group): group is CoverageResolvedGroup =>
      group.group !== null &&
      group.group !== "workspace" &&
      changedGroups.has(group.group)
    );

  // The groups whose debt the gate accepted with a per-group acceptance or the
  // reset marker (status "ovrd"), rather than passing because the new code is
  // covered.
  const overriddenRows = coverageRows.filter((row) => {
    if (row.status !== "ovrd") return false;
    const group = coverageMetricGroupName(row.metric);
    return group !== null && group !== "workspace" && changedGroups.has(group);
  });
  const overriddenGroups = new Set(
    overriddenRows
      .map((row) => coverageMetricGroupName(row.metric))
      .filter((group): group is string => group !== null),
  );
  const overridden = overriddenGroups.size > 0 || options.reset === true;

  try {
    let files: CoverageSuggestionFileLines[] = [];
    if (overriddenGroups.size > 0) {
      files = await uncoveredAddedLinesByFile(
        prFiles,
        lcov,
        overriddenGroups,
      );

      // The failing comment takes this same fallback when no added line in the
      // diff accounts for the regression. Recompute it here after an override,
      // because this payload replaces that comment and must not erase its only
      // record of which unchanged file started flapping.
      if (files.length === 0) {
        const unattributed = await collectUnattributedRegressionAttribution({
          rootDir: options.rootDir ?? Deno.cwd(),
          coverageFailures: overriddenRows,
          prFiles,
          lcov,
          readBaselineLcov: options.readBaselineLcov ?? baselineLcovForRun,
        });
        files = unattributed.files.map((file) => ({
          relativePath: file.relativePath,
          group: file.group,
          uncoveredCount: file.lines.length,
        }));
      }
    }

    const payload: CoverageCommentPayload = {
      prNumber,
      state: "resolved",
      improvedLines,
      groups,
      overridden,
      files,
    };
    const outputFile = coverageCommentOutputPath();
    await Deno.writeTextFile(outputFile, JSON.stringify(payload, null, 2));
    console.log(
      `Wrote ${outputFile} (resolved, net ${improvedLines} line(s) covered) for PR #${prNumber}; the coverage-comment workflow will update any existing comment.`,
    );
  } catch (error) {
    console.warn(
      `  Warning: could not write resolved coverage comment for PR #${prNumber}: ${error}`,
    );
  }
}

//
// Reporting an outcome
//

/** Escapes the message of a workflow command the way the runner reads it. */
function escapeCommandMessage(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

/**
 * Formats a workflow command that GitHub Actions turns into an annotation on
 * the run's page and on the pull request's checks. Outside Actions it is an
 * ordinary log line.
 */
export function workflowAnnotation(
  level: "warning" | "error",
  title: string,
  message: string,
): string {
  const property = escapeCommandMessage(title).replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
  return `::${level} title=${property}::${escapeCommandMessage(message)}`;
}

/**
 * Appends Markdown to the job summary GitHub Actions shows on the run's page.
 * Does nothing outside Actions, where no summary file is named, and never
 * throws: the summary repeats what the log already says.
 */
export async function appendJobSummary(
  markdown: string,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  const file = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (!file) return;

  try {
    await Deno.writeTextFile(file, `${markdown}\n`, { append: true });
  } catch (error) {
    warn(`  Warning: could not write the job summary: ${error}`);
  }
}

/**
 * Says in the log, loudly, that the gate held one or more changed source groups
 * against no baseline, and annotates the run with it. Says nothing when every
 * group the gate applied to was compared.
 */
export function reportNotGated(
  notGated: CoverageNotGatedInput,
  log: (message: string) => void = console.log,
): void {
  if (notGated.groups.length === 0) return;

  const groups = notGated.groups.map((group) => group.group).sort();
  log(
    "\n!!!" +
      `\n!!! COVERAGE WAS NOT GATED for ${groups.length} changed source ` +
      `group(s): ${groups.join(", ")} !!!` +
      "\n!!!\n",
  );
  for (const line of coverageNotGatedNotice(notGated)) log(line);
  log(
    workflowAnnotation(
      coverageListingNotCurrent(notGated.groups) ? "error" : "warning",
      COVERAGE_NOT_GATED_HEADLINE,
      `No baseline was held against: ${groups.join(", ")}. ` +
        "See the Coverage Check job's summary for why.",
    ),
  );
}

/** The line a run that failed nothing ends its log on. */
export function coverageOutcomeLine(notGated: CoverageNotGatedGroup[]): string {
  if (notGated.length === 0) {
    return "Coverage debt within the ratchet for every changed group.";
  }
  return `Coverage debt was NOT gated for ${
    notGated.map((group) => group.group).sort().join(", ")
  }; every other changed group is within the ratchet.`;
}

/** What the job summary reports: the rows scored, and what went ungated. */
export interface CoverageJobSummaryInput {
  /** Every metric's row; the summary tables the ones that were compared. */
  rows: Row[];

  /** The subset of `rows` that fails the gate. */
  failures: Row[];

  /** The changed groups the gate compared against nothing. */
  notGated: CoverageNotGatedGroup[];

  /** The run that measured the rows, and the base-branch commit it merged. */
  measurement?: CoverageMeasurement;
}

/**
 * Builds the job summary: whether the gate compared anything, what regressed,
 * and where each source group it compared or accepted ended up.
 */
export function buildCoverageJobSummary(
  input: CoverageJobSummaryInput,
): string {
  const out: string[] = ["## Coverage Check", ""];

  if (input.notGated.length > 0) {
    out.push(`### ⚠️ ${COVERAGE_NOT_GATED_HEADLINE}`, "");
    out.push(
      ...coverageNotGatedNotice({
        groups: input.notGated,
        measurement: input.measurement,
      }),
      "",
    );
  }

  if (input.failures.length > 0) {
    out.push(
      `### Coverage debt regressed in ${input.failures.length} source group(s)`,
      "",
    );
  } else if (input.notGated.length === 0) {
    out.push(
      "Coverage debt is within the ratchet for every changed group.",
      "",
    );
  }

  const compared = input.rows.filter((row) =>
    row.status === "OVER" || row.status === "OK" || row.status === "ovrd"
  );
  if (compared.length > 0) {
    out.push("| Status | Baseline | This run | Change | Source group |");
    out.push("| --- | ---: | ---: | ---: | --- |");
    for (const cells of metricTableRows(compared, true)) {
      out.push(`| ${cells.join(" | ")} |`);
    }
    out.push("");
  }

  return out.join("\n");
}

/**
 * The changed source groups a check that ended before it compared anything was
 * going to be gated on, named as an `ACCEPT_COVERAGE_DEBT` line names them. A
 * description that resets the baseline accepts every group, so it leaves none.
 */
function groupsLeftUngated(
  input: CoverageRatchetInput,
  reason: CoverageNotGatedReason,
): CoverageNotGatedGroup[] {
  if (input.prOverrides.coverageBaselineReset) return [];
  return [...input.perfArtifact.metrics.keys()]
    .filter((metric) =>
      shouldGateCoverageDebtMetric(metric, input.changedCoverageGroups)
    )
    .map((metric) => coverageMetricGroupName(metric))
    .filter((group): group is string => group !== null)
    .sort()
    .map((group) => ({ group, reason }));
}

/**
 * Reports a check that compared nothing for a run the gate was never going to
 * hold: a `main` run, a pull request that changed no source group, and one
 * whose description resets the baseline. Such a pull request still gets a
 * resolved comment payload, so that a failure an earlier run reported does not
 * stay open on it.
 */
async function reportNothingToGate(
  input: CoverageRatchetInput,
): Promise<void> {
  console.warn(
    "  Warning: skipping the baseline comparison, which this run would " +
      "not have been gated on.",
  );
  if (input.prNumber === null) return;
  await writeCoverageResolved(
    input.prNumber,
    [],
    input.prFiles,
    input.coverageLcov,
    { reset: input.prOverrides.coverageBaselineReset },
  );
}

/**
 * Says on every surface that a check ended without gating the groups it
 * applied to: the log, an annotation on the run, the job summary, and the pull
 * request's coverage comment.
 */
async function reportUngatedRun(
  prNumber: number,
  groups: CoverageNotGatedGroup[],
  measurement: CoverageMeasurement,
  log: (message: string) => void,
): Promise<void> {
  const notGated: CoverageNotGatedInput = { groups, measurement };
  reportNotGated(notGated, log);
  await writeCoverageNotGated(prNumber, notGated);
  await appendJobSummary(
    buildCoverageJobSummary({
      rows: [],
      failures: [],
      notGated: groups,
      measurement,
    }),
  );
}

/**
 * Ends a check whose run listing is not current. No `main` run found through
 * such a listing can be trusted, so nothing is compared. A pull request the
 * gate applies to fails, because reading the listing again is the remedy and a
 * pass would say its coverage had been checked. A run the gate compares nothing
 * for passes with the warning.
 */
async function reportListingNotCurrent(
  input: CoverageRatchetInput,
  listing: BaselineRunListing,
): Promise<number> {
  const groups = groupsLeftUngated(input, "listing-not-current");

  if (input.prNumber === null || groups.length === 0) {
    await reportNothingToGate(input);
    return 0;
  }

  await reportUngatedRun(
    input.prNumber,
    groups,
    { runUrl: workflowRunUrl(input.currentRunId) },
    console.error,
  );
  console.error(
    "\nFailing because the workflow's run listing is not current, so no " +
      `baseline it named can be trusted (newest: ${
        describeRun(listing.newest)
      }). Re-run this job to read the listing again.`,
  );
  return 1;
}

/**
 * Ends a check a GitHub API rate limit stopped from reading baseline data.
 *
 * The run passes. The limit bounds what this repository may ask of GitHub in an
 * hour, so it is a property of the moment rather than of the pull request, and
 * a re-run started straight away meets it again; failing would hold the pull
 * request on a condition its author has no way to clear. What makes the pass
 * safe is that it is not a quiet one — every changed group the gate applied to
 * is reported as not gated, on every surface a run that found no baseline
 * reports to.
 */
async function reportRateLimited(
  input: CoverageRatchetInput,
  error: CoverageRateLimitedError,
): Promise<number> {
  const groups = groupsLeftUngated(input, "rate-limited");

  if (input.prNumber === null || groups.length === 0) {
    await reportNothingToGate(input);
    return 0;
  }

  await reportUngatedRun(
    input.prNumber,
    groups,
    { runUrl: workflowRunUrl(input.currentRunId) },
    console.log,
  );
  console.log(
    `\nPassing without a coverage gate: ${error.message} Re-run this job ` +
      "once the limit has reset to hold these groups against a baseline.",
  );
  return 0;
}

//
// Main
//

/**
 * Runs the check the way the job runs it. `env` is where the run's record
 * spool is looked up, and the default is an empty environment, so a caller
 * that does not hand one over records nothing.
 */
export async function main(env: Environment = () => undefined) {
  const runId = Deno.env.get("GITHUB_RUN_ID");
  const rawPrNumber = Deno.env.get("PR_NUMBER");
  const prNumber = (rawPrNumber === "") ? null : rawPrNumber;
  const informationalOnly = prNumber === null;

  if (!Deno.env.get("GITHUB_TOKEN")) {
    console.error("GITHUB_TOKEN is required.");
    Deno.exit(1);
  }
  if (!runId) {
    console.error("GITHUB_RUN_ID is required.");
    Deno.exit(1);
  }

  const event = await readAndParseEvent();
  console.log("::group::Triggered by event:\n%o\n::endgroup::", event);

  // 1. Check PR description for overrides, if there's a PR to check.
  let prOverrides;
  if (prNumber) {
    console.log(`Fetching live PR #${prNumber} description...`);
    const prBody = await fetchCurrentPRBody(parseInt(prNumber), event);
    if (prBody.source === "live") {
      console.log("Using live PR description from GitHub API.");
    } else if (prBody.source === "event-fallback") {
      console.warn(
        `  Warning: could not fetch live PR body; using pull_request event payload: ${prBody.errorMessage}`,
      );
    } else {
      console.warn(
        `  Warning: could not fetch live PR body and no pull_request event body was available: ${prBody.errorMessage}`,
      );
    }
    try {
      prOverrides = parseBaselineOverrides(prBody.body);
    } catch (error) {
      console.error(
        `Invalid performance baseline override in PR description: ${error}`,
      );
      Deno.exit(1);
    }
  } else {
    prOverrides = { metrics: new Map(), coverageBaselineReset: false };
  }

  if (prOverrides.metrics.size > 0) {
    console.log(
      `PR description contains ${prOverrides.metrics.size} ACCEPT_COVERAGE_DEBT override(s).`,
    );
  }
  if (prOverrides.coverageBaselineReset) {
    console.log(
      `PR description contains ${COVERAGE_BASELINE_RESET_MARKER}; coverage debt ratchet failures will be treated as an intentional baseline reset.`,
    );
  }

  // 2. Extract the current run's coverage.
  const runIdNum = parseInt(runId);
  const currentMetrics = new Map<string, BaselineSample>();

  // The event payload has the metadata needed for samples, so avoid spending
  // an API request on the current workflow run.
  const currentRunInfo = currentWorkflowRunFromEvent(event, runIdNum);
  let changedCoverageGroups: Set<string> | undefined;
  let prFiles: PRFile[] = [];

  if (prNumber) {
    try {
      prFiles = await fetchPRFiles(parseInt(prNumber));
      changedCoverageGroups = coverageGroupsForChangedFiles(
        prFiles.map((file) => file.filename),
      );
      const groups = [...changedCoverageGroups].sort();
      if (groups.length > 0) {
        console.log(
          `Coverage debt gating applies to changed source group(s): ${
            groups.join(", ")
          }.`,
        );
      } else {
        console.log(
          "PR changes no coverage source groups; coverage debt metrics will be reported but not blocking.",
        );
      }
    } catch (error) {
      console.warn(
        `  Warning: could not fetch PR changed files; coverage debt metrics will use strict gating: ${error}`,
      );
    }
  }

  const coverageArtifactsDir = Deno.env.get("COVERAGE_ARTIFACTS_DIR");
  let currentArtifacts: Artifact[] = [];
  let currentArtifactsError: unknown;

  try {
    currentArtifacts = await fetchCurrentRunArtifacts(
      runIdNum,
      coverageArtifactsDir,
    );
    console.log(
      `Fetched ${currentArtifacts.length} artifacts for current run.`,
    );
  } catch (e) {
    currentArtifactsError = e;
    console.warn(`  Warning: could not fetch artifacts for current run: ${e}`);
  }

  // Aggregate the current run's compile cache states so this run's
  // perf-metrics artifact is tagged (main-push runs included — a later
  // PR's coverage ratchet must know whether this run was cold).
  const currentCacheStates = await collectCurrentCacheStates(currentArtifacts);
  console.log(
    `Compile cache states: ${formatCompileCacheStates(currentCacheStates)}`,
  );

  // Fallback for families with no recorded state (artifact missing, upload or
  // download failed): infer the run-level state from the compile fingerprint —
  // the PR's changed files, or the compare against the previous main run — and
  // fill only the families with no recorded state. Recorded states are ground
  // truth and win (see inferCurrentRunFallbackState /
  // fillMissingFamiliesFromFingerprint).
  const inferredRunState = await inferCurrentRunFallbackState({
    isPullRequestRun: !!prNumber,
    prFiles,
    headSha: currentRunInfo.head_sha,
    fetchLatestBaselineSha: fetchLatestBaselineRunSha,
  });
  fillMissingFamiliesFromFingerprint(currentCacheStates, inferredRunState);

  // Both halves of the artifact travel together from here on: every GitHub
  // call is wrapped so a rate limit writes this same stamped payload before
  // skipping the check. `metrics` and `compileCacheStates` are the live
  // objects, so later additions to either are picked up.
  const perfArtifact: PerfMetricsArtifact = {
    metrics: currentMetrics,
    compileCacheStates: currentCacheStates,
  };

  // Extract coverage debt metrics from coverage profile artifacts.
  let coverageDataError: unknown;
  let coverageLcov = "";
  try {
    if (currentArtifactsError) {
      throw new Error(
        `Could not fetch current run artifacts: ${currentArtifactsError}`,
      );
    }
    const coverage = await extractCoverageDebtSamples(
      currentRunInfo,
      currentArtifacts,
      coverageArtifactsDir,
    );
    for (const [name, sample] of coverage.samples) {
      currentMetrics.set(name, sample);
    }
    coverageLcov = coverage.lcov;
  } catch (e) {
    coverageDataError = e;
    console.error(
      `  Error: could not extract coverage debt metrics for current run: ${e}`,
    );
  }

  await writePerfMetricsArtifact(perfArtifact);
  // The same figures go to the record store, where the dashboard's trend
  // reads them. Only a push to `main` ships them, which the workflow
  // decides.
  recordCoverage(
    [...currentMetrics].map(([name, sample]) => [name, sample.uncoveredLines]),
    Object.values(currentCacheStates).includes("cold"),
    env,
  );

  if (coverageDataError && !informationalOnly) {
    console.error(
      "Failing because coverage debt data is required for pull request checks.",
    );
    Deno.exit(1);
  }

  if (currentMetrics.size === 0) {
    console.log(
      "No coverage metrics extracted from current run. Nothing to check.",
    );
    Deno.exit(0);
  }

  console.log(
    `Extracted ${currentMetrics.size} coverage metrics from current run.`,
  );

  // An acceptance for a group this run measured nothing for is one nothing will
  // ever consult, so say which groups there are rather than letting the line
  // pass for an acceptance that had no effect.
  const unknown = unknownAcceptedMetrics(prOverrides, currentMetrics);
  if (unknown.length > 0) {
    for (const metric of unknown) {
      console.error(
        `ACCEPT_COVERAGE_DEBT names "${
          coverageMetricGroupName(metric) ?? metric
        }", which this run measured no coverage for.`,
      );
    }
    console.error(
      `The source groups this run measured are: ${
        [...currentMetrics.keys()]
          .map((metric) => coverageMetricGroupName(metric) ?? metric)
          .sort()
          .join(", ")
      }.`,
    );
    Deno.exit(1);
  }

  Deno.exit(
    await runCoverageRatchet({
      prNumber: prNumber ? parseInt(prNumber) : null,
      currentRunId: runIdNum,
      perfArtifact,
      prOverrides,
      changedCoverageGroups,
      prFiles,
      coverageLcov,
    }),
  );
}

/** What {@link runCoverageRatchet} holds against the baselines, and how. */
export interface CoverageRatchetInput {
  /** The pull request under check, or null for an informational `main` run. */
  prNumber: number | null;

  /** The run this check belongs to, which a current run listing shows. */
  currentRunId: number;

  /** What this run measured, and the compile cache states stamped on it. */
  perfArtifact: PerfMetricsArtifact;

  /** What the pull request description accepts. */
  prOverrides: BaselineOverrides;

  /** Undefined when the PR's changed files could not be read. */
  changedCoverageGroups: Set<string> | undefined;

  /** The files the pull request changed, for attributing a regression. */
  prFiles: PRFile[];

  /** This run's combined LCOV report, for attributing a regression. */
  coverageLcov: string;

  /** Reads the workflow's run listing; `readBaselineRunListing()` by default. */
  readListing?: (
    options: ReadBaselineRunListingOptions,
  ) => Promise<BaselineRunListing>;

  /** Reads one baseline run; from its artifacts and merged PR by default. */
  readBaselineRun?: (run: WorkflowRun) => Promise<BaselineRunReading>;

  /** How the base-branch commit, its ancestry and its changes are read. */
  baselineReads?: Pick<
    SelectBaselinesOptions,
    "readBaseSha" | "fetchRanks" | "fetchChangedGroups"
  >;
}

/**
 * Holds what this run measured against its ratchet baselines, reports the
 * result to the log, the job summary and the pull request comment, and returns
 * the exit code the job ends on.
 *
 * A changed source group regressing fails a pull request, and so does a run
 * listing that is not current, since no baseline found through one can be
 * trusted. A changed group with no comparable baseline passes, and says so on
 * every surface it reports to, as does a run a GitHub API rate limit stopped
 * from reading any baseline at all. A `main` run is informational and always
 * passes.
 */
export async function runCoverageRatchet(
  input: CoverageRatchetInput,
): Promise<number> {
  try {
    return await ratchetAgainstBaselines(input);
  } catch (error) {
    if (!(error instanceof CoverageRateLimitedError)) throw error;
    return await reportRateLimited(input, error);
  }
}

/**
 * The comparison itself: reads the baselines, scores every metric against the
 * one it was given, and reports the result. Gives up by raising a
 * {@link CoverageRateLimitedError} where GitHub's rate limit stops a read.
 */
async function ratchetAgainstBaselines(
  input: CoverageRatchetInput,
): Promise<number> {
  const { prNumber, perfArtifact, prOverrides, changedCoverageGroups } = input;
  const currentMetrics = perfArtifact.metrics;
  const currentCacheStates = perfArtifact.compileCacheStates ?? {};
  const informationalOnly = prNumber === null;
  const readListing = input.readListing ?? readBaselineRunListing;

  // 3. Read the workflow's run listing, which is where a `main` run is found by
  // the commit it measured.
  const listing = await guardRateLimit(
    "reading the workflow's run listing",
    () => readListing({ currentRunId: input.currentRunId }),
    perfArtifact,
  );
  reportBaselineRunListing(listing, input.currentRunId);

  if (!listing.current) {
    return await reportListingNotCurrent(input, listing);
  }

  // 4. Read `main` runs, nearest the base-branch commit first, until every
  // metric has a ratchet baseline. A run's artifacts, compile cache state and
  // merged-PR acceptances are fetched only when the walk reaches it, so a run
  // whose nearest baseline serves every metric reads one run rather than all of
  // them.
  const runsNewestFirst = [...listing.candidates].sort((a, b) =>
    b.created_at.localeCompare(a.created_at) || b.id - a.id
  );

  // Compile cache states per baseline run, from tagged perf-metrics
  // artifacts. A run whose artifact is missing or carries no stamp stays
  // absent, which the ratchet reads as not-cold.
  const cacheStatesByRunId = new Map<number, CompileCacheStates>();
  const isRunCold = (runId: number): boolean => {
    const states = cacheStatesByRunId.get(runId);
    return states !== undefined && Object.values(states).includes("cold");
  };

  // What the walk read, for the diagnostics below.
  const visitedContexts: BaselineRunContext[] = [];
  let acceptingRuns = 0;

  const readBaselineRun = input.readBaselineRun ??
    ((run: WorkflowRun): Promise<BaselineRunReading> =>
      guardRateLimit("reading a baseline run", async () => {
        const context = await buildBaselineRunContext({ run });
        visitedContexts.push(context);

        const baseline = await parseCoverageBaselineFromArtifacts(
          context.artifacts,
        );
        if (baseline?.compileCacheStates) {
          cacheStatesByRunId.set(run.id, baseline.compileCacheStates);
        }

        const overrides = context.pr
          ? parseMergedBaselineOverrides(context.pr)
          : null;
        if (
          overrides &&
          (overrides.metrics.size > 0 || overrides.coverageBaselineReset)
        ) {
          acceptingRuns++;
        }

        return {
          samples: baseline?.metrics ?? new Map(),
          overrides,
          cold: isRunCold(run.id),
        };
      }, perfArtifact));

  // 5. Compare the current run's coverage debt against the ratchet baseline.

  // Reported in `finally` so a baseline run that could not be read still says
  // which runs it got to before it gave up.
  const baselineByMetric = await selectBaselines({
    ...input.baselineReads,
    metrics: [...currentMetrics.keys()],
    runs: runsNewestFirst,
    olderRuns: listing.older,
    accountedFor: listing.accountsFor,
    readRun: readBaselineRun,
    isPullRequest: prNumber !== null,
    guard: (description, operation) =>
      guardRateLimit(description, operation, perfArtifact),
  }).finally(() => reportBaselineContextResults(visitedContexts));

  if (acceptingRuns > 0) {
    console.log(
      `Found ${acceptingRuns} coverage baseline override(s) from merged PRs.`,
    );
  }

  const coverageBaselineAvailable = [...baselineByMetric.values()].some(
    (baseline) => baseline.sample !== undefined,
  );

  const { rows, failures, ungatedGroups, notGated } = buildCoverageRows({
    currentMetrics,
    baselineByMetric,
    overrides: prOverrides,
    changedCoverageGroups,
  });
  const measurement = measurementFromRows(rows);

  reportUngatedGroups(ungatedGroups);
  reportNotGated({ groups: notGated, measurement });

  // 6. Report results

  // 6a. Prominent failure callout up top, so it's unmissable.
  if (failures.length > 0) {
    console.log(
      "\n!!!" +
        `\n!!! COVERAGE DEBT REGRESSION in ${failures.length} source group(s) !!!` +
        "\n!!!",
    );
  }

  // 6b. Cold compile cache note. A cold run covers cold-compile-only branches,
  // so it is recorded cold and a later PR's coverage ratchet skips it as a
  // baseline in favor of the nearest warm ancestor of its base-branch commit.
  const coldFamilies = COMPILE_CACHE_FAMILIES.filter(
    (family) => currentCacheStates[family] === "cold",
  );
  if (coldFamilies.length > 0) {
    console.log("\n## Cold compile cache");
    console.log(
      `The pattern compile byte cache missed for: ${coldFamilies.join(", ")}.`,
    );
    console.log(
      "This run is recorded cold. A cold run covers cold-compile-only branches,",
    );
    console.log(
      "so a later PR's coverage ratchet skips it for the nearest warm ancestor",
    );
    console.log(
      "instead — otherwise warm PRs would be held to a stricter, unreachable bar.",
    );
  }

  // 6c. Full coverage-debt table.
  console.log(
    "\n::group::All coverage debt metrics:\n" +
      "Ratchet: for a source group the PR changed, uncovered lines must not rise\n" +
      "above the count from the main run for the base-branch commit this run\n" +
      "merged, or the nearest ancestor of it that has one.\n" +
      "Status key: OVER = above baseline (fails); OK = at or below baseline;\n" +
      "  ovrd = accepted by a PR override/reset; excl = not gated for this PR;\n" +
      "  n/a = no baseline yet and no new uncovered lines.",
  );
  // Sort order: most at-risk of failing first. `ovrd` sits below `OK` because
  // an override-protected metric is at strictly lower risk than an unguarded OK
  // metric — the author has already authorized its current level.
  const STATUS_ORDER: Record<Status, number> = {
    OVER: 4,
    OK: 3,
    ovrd: 2,
    excl: 1,
    "n/a": 0,
  };

  const counts = {
    OVER: 0,
    OK: 0,
    ovrd: 0,
    excl: 0,
    "n/a": 0,
  } as Record<Status, number>;
  for (const r of rows) counts[r.status]++;

  console.log(
    `\n## Coverage debt metrics  (${rows.length} total — OVER: ${counts.OVER}, OK: ${counts.OK}, ovrd: ${counts.ovrd}, excl: ${counts.excl}, n/a: ${
      counts["n/a"]
    })`,
  );

  const sortedRows = [...rows].sort((a, b) => {
    const s = STATUS_ORDER[b.status] - STATUS_ORDER[a.status];
    if (s !== 0) return s;
    return (b.pctIncrease ?? -Infinity) - (a.pctIncrease ?? -Infinity);
  });
  printMetricTable(sortedRows, true);

  console.log("::endgroup::");

  // 6d. Failure detail.
  if (failures.length > 0) {
    failures.sort((a, b) => (b.pctIncrease ?? 0) - (a.pctIncrease ?? 0));

    console.log("\n## Coverage debt regression details:\n");
    printMetricTable(failures);
  }

  // 6e. Pass/fail outcome + acceptance copy-paste block pinned at the bottom.
  if (informationalOnly) {
    console.log("\nInformational Only:");
  }

  // Coverage-debt PR comment, written for the coverage-comment workflow to post
  // (fork PRs get a read-only token on pull_request and cannot comment here).
  // Done before the exit branches so it runs whether the run passes or fails for
  // other reasons.
  if (prNumber !== null) {
    await writeCoverageComment(
      prNumber,
      failures,
      rows,
      input.prFiles,
      input.coverageLcov,
      { groups: notGated, measurement },
    );
    await appendJobSummary(
      buildCoverageJobSummary({ rows, failures, notGated, measurement }),
    );
  }

  if (failures.length === 0) {
    console.log(`\n${coverageOutcomeLine(notGated)}`);
    return 0;
  } else if (informationalOnly) {
    console.log("\nOne or more changed groups regressed coverage debt.");
    console.log("This build would fail if it were a PR.");
    return 0;
  }

  const verb = coverageBaselineAvailable ? "reset" : "bootstrap";
  console.log(
    `\nTo ${verb} the coverage ratchet for one cycle, add ${COVERAGE_BASELINE_RESET_MARKER} to your PR description.`,
  );
  console.log(
    "\nTo accept these coverage regressions one group at a time, add the following to your PR description, each line flush against the left margin:\n",
  );
  console.log("---BEGIN COPY-PASTE---");
  for (const f of failures) {
    const suggested = formatOverrideSuggestion(f.current - (f.baseline ?? 0));
    const group = coverageMetricGroupName(f.metric) ?? f.metric;
    console.log(`ACCEPT_COVERAGE_DEBT: ${group} +${suggested}`);
  }
  console.log("---END COPY-PASTE---");

  return 1;
}

if (import.meta.main) {
  main(Deno.env.get);
}
