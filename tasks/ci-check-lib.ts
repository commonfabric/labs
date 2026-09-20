/**
 * Shared library for the CI coverage-debt gate.
 *
 * Used by:
 *   - coverage-check.ts        (per-PR coverage-debt gate)
 *   - post-coverage-comment.ts (posts the gate's coverage comment)
 */

//
// Config (from environment)
//

import { isObjectOrArray } from "@commonfabric/utils/types";

export const REPO = Deno.env.get("GITHUB_REPOSITORY") ?? "commonfabric/labs";

/** Where the repository is hosted; a workflow run names it. */
export const SERVER_URL = Deno.env.get("GITHUB_SERVER_URL") ??
  "https://github.com";

export const TOKEN = Deno.env.get("GITHUB_TOKEN");
export const WORKFLOW_FILE = "deno.yml";

/**
 * The per-run artifact and file the coverage check writes: this run's
 * coverage-debt metrics and its per-family compile cache states, so a later PR
 * run can read a recent main run's coverage as the ratchet baseline and know
 * whether that run was cold. The name `perf-metrics` is historical — the
 * artifact once also carried CI timing metrics for the removed performance gate
 * — and is kept so the ratchet baseline needs no migration. A run from before
 * the gate was removed recorded the same coverage metrics and cache states here
 * in the identical JSON shape, so it reads as a valid baseline unchanged.
 */
export const PERF_METRICS_ARTIFACT_NAME = "perf-metrics";

/** The file inside that artifact. */
export const PERF_METRICS_FILE = "perf-metrics.json";

/**
 * Prefix of the per-shard artifacts the pattern jobs upload to record whether
 * their compile byte cache restored (e.g. `cache-state-pattern-unit-3`). Each
 * contains one JSON file matching {@link CacheStateRecord}.
 */
export const CACHE_STATE_ARTIFACT_PREFIX = "cache-state-";

export const COVERAGE_METRIC_PREFIX = "coverage-debt:";
export const COVERAGE_BASELINE_RESET_MARKER = "NEW_COVERAGE_BASELINE";

/**
 * Hidden marker placed at the top of the coverage-debt suggestion comment so
 * the gate posts it at most once per PR.
 */
export const COVERAGE_SUGGESTION_MARKER = "<!-- coverage-debt-suggestion -->";

/**
 * Artifact and file the coverage gate writes a pending PR comment to. The gate
 * runs on `pull_request`, where fork PRs only get a read-only token, so it
 * cannot comment directly. A separate `workflow_run` workflow picks this file
 * up and posts it with a write token from the base-repo context.
 */
export const COVERAGE_COMMENT_ARTIFACT_NAME = "coverage-comment";

/** The file inside that artifact. */
export const COVERAGE_COMMENT_FILE = "coverage-comment.json";

/**
 * Pending coverage-debt comment handed from the gate to the posting workflow.
 *
 * - `state: "regressed"` carries the full comment `body`. The poster posts it as
 *   a new comment, or updates an existing coverage comment in place.
 * - `state: "ungated"` carries the full comment `body` too, and is posted the
 *   same way. It says the run held one or more changed source groups against no
 *   baseline, so that a run which checked nothing does not read as one that
 *   found nothing.
 * - `state: "resolved"` carries `improvedLines`, the net reduction in uncovered
 *   lines versus baseline across the changed, gated coverage groups, and
 *   `groups`, the per-group baseline-versus-this-PR breakdown. When the gate
 *   passed only because the debt was accepted, `overridden` is set and `files`
 *   names what the acceptance is standing in for. The poster rebuilds an
 *   existing comment into a collapsed summary of where the PR left coverage; it
 *   does nothing when there is no existing comment to update.
 */
export interface CoverageCommentPayload {
  prNumber: number;
  state: "regressed" | "ungated" | "resolved";

  /** Present when `state` is "regressed" or "ungated". */
  body?: string;

  /** Present when `state` is "resolved". */
  improvedLines?: number;

  /** Present when `state` is "resolved": the changed source groups and where
   * this PR left each one's uncovered-line count. */
  groups?: CoverageResolvedGroup[];

  /** Present when `state` is "resolved": true when the gate passed because a
   * changed group's debt was accepted with a per-group acceptance or the reset
   * marker, not because the new code is covered. */
  overridden?: boolean;

  /** Present when `overridden` is set: the files holding the uncovered lines
   * the acceptance covers for. */
  files?: CoverageSuggestionFileLines[];
}

/**
 * Command an author (or an LLM) runs locally to reproduce the coverage gate.
 * Collects coverage from the unit-test suites and prints the per-group
 * uncovered-line counts as JSON. The integration suites are omitted, so the
 * local counts are conservative: meeting the target locally also clears CI.
 */
export const COVERAGE_LOCAL_CHECK_COMMAND = [
  "rm -rf coverage/raw/local",
  'DENO_COVERAGE_DIR="$(pwd)/coverage/raw/local" deno task test',
  "deno run --allow-read --allow-write --allow-run --allow-env \\",
  "  tasks/coverage-metrics.ts \\",
  '  --profile-dir="$(pwd)/coverage/raw/local" --root="$(pwd)"',
].join("\n");

//
// Types
//

export interface WorkflowRun {
  id: number;
  html_url: string;
  head_sha: string;

  /** The branch the run's head commit is on. */
  head_branch?: string;

  created_at: string;

  /**
   * When the latest attempt started. A re-run moves this and leaves
   * `created_at` where it was, so the two straddle a UTC midnight for a
   * run re-run the next day.
   */
  run_started_at?: string;

  conclusion: string;
  event: string;
}

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

interface ArtifactsResponse {
  total_count?: number;
  artifacts: Artifact[];
}

/** What one `main` run measured for one coverage-debt metric. */
export interface BaselineSample {
  runId: number;
  sha: string;
  createdAt: string;
  uncoveredLines: number;
}

/**
 * One metric as the baseline artifact stores it. The `durationSeconds` and
 * `runUrl` keys are the ones that file has always carried: `durationSeconds`
 * holds the uncovered-line count, and `runUrl` is the run's GitHub page. Both
 * are kept so a file written before the performance gate was removed still
 * parses, and a file written now still parses in a checkout that predates this
 * shape.
 */
export interface MetricRecord {
  name: string;
  runId: number;
  runUrl: string;
  sha: string;
  createdAt: string;
  durationSeconds: number;
}

/**
 * Job families that restore a pattern compile byte cache (`actions/cache`
 * keyed on the compiler fingerprint). A fingerprint-changing PR runs these
 * jobs with a cold cache, which inflates their timing metrics and shifts
 * their coverage profiles.
 */
export const COMPILE_CACHE_FAMILIES = [
  "generated-patterns",
  "pattern-integration",
  "pattern-unit",
] as const;

export type CompileCacheFamily = (typeof COMPILE_CACHE_FAMILIES)[number];

/**
 * Compile cache state for one job family in one run. Cold means the cache
 * missed entirely (full recompile); warm covers both exact and restore-key
 * hits, since any hit implies the compiler fingerprint is unchanged.
 */
export type CompileCacheState = "cold" | "warm";

/**
 * Per-family compile cache states for a run. An absent family is unknown (a
 * run whose cache-state artifact never recorded or could not be read) and is
 * treated as not-cold: it is not excluded from the coverage ratchet baseline.
 */
export type CompileCacheStates = Partial<
  Record<CompileCacheFamily, CompileCacheState>
>;

/**
 * One shard's compile-cache restore result, as recorded by the workflow's
 * cache-state artifact. `family` is a string (not `CompileCacheFamily`) so
 * records from unknown families survive parsing; aggregation ignores them.
 */
export interface CacheStateRecord {
  family: string;
  shard: string;

  /** The cache key `actions/cache` restored from; empty on a full miss. */
  matchedKey: string;

  /** True only when the primary key matched exactly. */
  exactHit: boolean;
}

export interface CoverageBaselineFile {
  version: 1;
  generatedAt: string;
  metrics: MetricRecord[];

  /**
   * Per-family compile cache states for the run this file describes. Absent
   * when no cache-state artifact recorded for the run.
   */
  compileCacheStates?: CompileCacheStates;
}

export interface PRInfo {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  merged_at: string | null;
}

export interface PRFile {
  filename: string;

  /** Old path for renamed files; the fingerprint classifier needs both. */
  previous_filename?: string;

  /** Unified diff for this file. Absent for binary or oversized changes. */
  patch?: string;
}

export interface IssueComment {
  id: number;
  body: string;

  /**
   * The login the comment was written under. A token that may comment may
   * also edit any comment on the pull request, and every review app on it
   * writes as a bot, so anything that edits its own comment in place has
   * to know which login is its own.
   */
  author?: string;
}

export interface CurrentPRBody {
  body: string;
  source: "live" | "event-fallback" | "empty-fallback";
  errorMessage?: string;
}

export interface BaselineOverrides {
  /**
   * Coverage-debt metric name -> how many uncovered lines above its ratchet
   * baseline the pull request accepts. When these come from a merged pull
   * request's body, only which metrics are present carries meaning; the ratchet
   * reads the number off the current pull request alone.
   */
  metrics: Map<string, number>;

  /** Reset all coverage-debt metrics at the commit carrying this marker. */
  coverageBaselineReset: boolean;
}

//
// GitHub API helpers
//

function apiHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

const GITHUB_GET_MAX_ATTEMPTS = 4;
const GITHUB_GET_RETRY_BASE_DELAY_MS = 250;
const GITHUB_GET_RETRY_MAX_DELAY_MS = 5_000;
const RETRYABLE_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ARTIFACT_DOWNLOAD_STATUSES = new Set([
  ...RETRYABLE_GITHUB_STATUSES,
  403,
  404,
]);

function retryAfterDelayMs(value: string | null): number | undefined {
  if (value == null) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

/**
 * How long to wait before the attempt after `attempt`. A `Retry-After` header
 * on the response that failed sets the delay when GitHub sends one; without a
 * response, or without that header, the delay doubles with each attempt. Both
 * are capped.
 */
function githubRetryDelayMs(attempt: number, resp?: Response): number {
  const retryAfter = resp
    ? retryAfterDelayMs(resp.headers.get("retry-after"))
    : undefined;
  return Math.min(
    retryAfter ?? GITHUB_GET_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    GITHUB_GET_RETRY_MAX_DELAY_MS,
  );
}

/** Resolves after `ms` milliseconds, or at once when `ms` is not positive. */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GitHub refusing because the token is over one of its request limits, as
 * against refusing for any other reason. A caller that has to tell the two
 * apart reads this type rather than the message, which names only the status
 * and the path.
 */
export class GitHubRateLimitError extends Error {}

/**
 * Whether `resp` is GitHub applying a request limit. It answers both its
 * primary and its secondary limits with 403 or 429, and the two statuses are
 * read differently because only one of them means anything else.
 *
 * 429 is too many requests and nothing besides, so the status settles it. The
 * rate-limit headers are documented as optional, and a response carrying none
 * of them is still a limit.
 *
 * 403 is also how GitHub refuses a request the token may not make, and an
 * artifact download reaches storage that answers 403 for a signed URL that has
 * expired. So there the evidence has to come from somewhere: no requests left
 * in the window, a wait to observe, or `body` saying outright that this is a
 * limit, which is how GitHub words a secondary limit that carries neither
 * header. A 403 offering none of the three is taken at its word as a refusal,
 * because reporting a permission failure as a limit would promise the author a
 * re-run that clears it.
 */
function isRateLimitResponse(resp: Response, body: string): boolean {
  if (resp.status === 429) return true;
  if (resp.status !== 403) return false;
  return isOverPrimaryRateLimit(resp) ||
    resp.headers.get("retry-after") !== null ||
    RATE_LIMIT_BODY.test(body);
}

/**
 * How GitHub words a limit in the body of a refusal that carries none of the
 * rate-limit headers. Consulted only for a 403, where the status settles
 * nothing on its own.
 */
const RATE_LIMIT_BODY = /\b(rate limit|abuse detection)\b/i;

/**
 * Whether `resp` spent the last request of its window. Such a limit resets
 * minutes to an hour out, so no retry within one job can clear it.
 */
function isOverPrimaryRateLimit(resp: Response): boolean {
  return resp.headers.get("x-ratelimit-remaining") === "0";
}

/**
 * Whether `resp` is a limit that asks for a wait rather than one that has
 * spent the window. Such a limit often clears inside the job, so it is worth
 * another attempt whichever status it arrives under — and an attempt that
 * succeeds is a pull request held to its baseline rather than passed ungated.
 */
function isSecondaryRateLimit(resp: Response, body: string): boolean {
  return isRateLimitResponse(resp, body) && !isOverPrimaryRateLimit(resp);
}

function githubApiError(
  resp: Response,
  path: string,
  method: "GET" | "POST" | "PATCH",
  body: string,
): Error {
  const statusText = resp.statusText ? ` ${resp.statusText}` : "";
  const message = `GitHub API ${method} ${resp.status}${statusText}: ${path}`;
  return isRateLimitResponse(resp, body)
    ? new GitHubRateLimitError(message)
    : new Error(message);
}

/**
 * Whether `error` is GitHub applying a request limit. The client above raises
 * a {@link GitHubRateLimitError} outright; the text match answers for a limit
 * reported by something else that reads the API.
 */
export function isGitHubRateLimitError(error: unknown): boolean {
  if (error instanceof GitHubRateLimitError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(rate limit|rate-limited|ratelimit)\b/i.test(message);
}

/**
 * Whether a thrown GitHub error is the interface saying the thing asked
 * for is not there, as against saying it could not answer. The two call
 * for different things, and only the first is an answer.
 */
export function isNotFound(error: unknown): boolean {
  return /^GitHub API (?:GET|POST|PATCH) 404\b/.test(
    error instanceof Error ? error.message : String(error),
  );
}

/** How much of a refusal's body is read to tell what kind of refusal it is. */
const MAX_REFUSAL_BODY_BYTES = 4096;

/**
 * How long that body has to arrive. Reaching the end of it costs the check
 * nothing: the classification falls back to what the status and the headers
 * say, which is the whole of the evidence anywhere else. So this bounds an
 * enrichment rather than an operation whose success anything waits on, and a
 * refusal that never arrives cannot leave the check hanging on a connection
 * the runner would otherwise hold open to the job's own limit.
 */
const REFUSAL_BODY_BUDGET_MS = 2_000;

/** Reads up to {@link MAX_REFUSAL_BODY_BYTES} of `reader`, decoded. */
async function drainRefusalBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let read = 0;
  while (read < MAX_REFUSAL_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    read += value.length;
  }

  const prefix = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(prefix);
}

/**
 * Takes a refusal's body, far enough to tell what kind of refusal it is. The
 * text is evidence for {@link isRateLimitResponse} and reaches no message: an
 * error names the status and the path, so a body holding an upstream request,
 * a data URI or a page of markup is never copied into a log.
 *
 * Answers with the empty string wherever the body cannot be had — absent,
 * unreadable, or slower than its budget — which leaves the status and the
 * headers to classify the refusal on their own.
 */
async function readRefusalBody(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";

  let expire: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<string>((resolve) => {
    expire = setTimeout(() => resolve(""), REFUSAL_BODY_BUDGET_MS);
  });

  try {
    return await Promise.race([drainRefusalBody(reader), budget]);
  } catch {
    return "";
  } finally {
    clearTimeout(expire);
    // Ask the connection to release, and settle a read still outstanding
    // against a body that never arrived. Do not wait for an underlying source
    // whose cancellation itself never settles: that would escape the budget
    // this cleanup follows.
    void reader.cancel().catch(() => {});
  }
}

export async function githubGet<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  for (let attempt = 1; attempt <= GITHUB_GET_MAX_ATTEMPTS; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { headers: apiHeaders() });
    } catch (error) {
      if (attempt === GITHUB_GET_MAX_ATTEMPTS) throw error;
      await sleep(githubRetryDelayMs(attempt));
      continue;
    }

    if (resp.ok) return resp.json();

    const refusal = await readRefusalBody(resp);
    // A secondary limit is worth another attempt whatever status carries it,
    // which is why it is named here beside the statuses that are retried by
    // their own nature. A spent window is not, and an ordinary refusal will
    // not answer differently for being asked again.
    const worthRetrying = RETRYABLE_GITHUB_STATUSES.has(resp.status) ||
      isSecondaryRateLimit(resp, refusal);
    if (
      !worthRetrying ||
      isOverPrimaryRateLimit(resp) ||
      attempt === GITHUB_GET_MAX_ATTEMPTS
    ) {
      throw githubApiError(resp, path, "GET", refusal);
    }

    await sleep(githubRetryDelayMs(attempt, resp));
  }

  throw new Error(`GitHub API GET retry loop exhausted unexpectedly: ${path}`);
}

export async function githubPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw githubApiError(resp, path, "POST", await readRefusalBody(resp));
  }
  return resp.json();
}

export async function githubPatch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`https://api.github.com${path}`, {
    method: "PATCH",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw githubApiError(resp, path, "PATCH", await readRefusalBody(resp));
  }
  return resp.json();
}

//
// Fetch artifacts
//

export async function fetchArtifactsForRun(
  runId: number,
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  const perPage = 100;

  for (let page = 1;; page++) {
    const data = await githubGet<ArtifactsResponse>(
      `/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=${perPage}&page=${page}`,
    );
    artifacts.push(...data.artifacts);

    if (data.artifacts.length === 0) break;
    if (
      typeof data.total_count === "number" &&
      artifacts.length >= data.total_count
    ) {
      break;
    }
    if (
      typeof data.total_count !== "number" && data.artifacts.length < perPage
    ) {
      break;
    }
  }

  return artifacts;
}

/**
 * Newest artifact per name. Re-running a single job uploads a same-named
 * artifact alongside the original attempt's, and the API lists newest first —
 * naive iteration lets the stale one win. Artifact ids are monotonic.
 */
export function newestArtifactsByName(artifacts: Artifact[]): Artifact[] {
  const byName = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    const existing = byName.get(artifact.name);
    if (!existing || artifact.id > existing.id) {
      byName.set(artifact.name, artifact);
    }
  }
  return [...byName.values()];
}

/**
 * The API path listing the runs a coverage baseline could come from:
 * successful pushes to the default branch, newest first.
 *
 * One path rather than one per reader, because the workflow the runs
 * belong to has to be the same for everything that compares against a
 * baseline, and a second copy is a second place to update when the run
 * moves to another workflow.
 *
 * GitHub serves a listing that carries a filter from a search index, and that
 * index can return a window of runs that ended weeks ago with no error to say
 * so. A reader that cannot tolerate that reads {@link workflowRunsPagePath}
 * and applies {@link isBaselineCandidateRun} itself.
 */
export function workflowRunsPathForBaseline(perPage: number): string {
  const params = new URLSearchParams({
    branch: "main",
    status: "success",
    event: "push",
    per_page: String(perPage),
  });
  return `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?${params}`;
}

/** Runs on one page of {@link workflowRunsPagePath}: GitHub's maximum. */
export const WORKFLOW_RUNS_PAGE_SIZE = 100;

/**
 * The API path of one page of every run of the workflow, newest first, with
 * `1` as the first page.
 *
 * It carries no filter, which is what keeps GitHub from serving it out of the
 * search index {@link workflowRunsPathForBaseline} describes. The pull request
 * details are left out because nothing here reads them and they are most of
 * the response.
 */
export function workflowRunsPagePath(page: number): string {
  const params = new URLSearchParams({
    per_page: String(WORKFLOW_RUNS_PAGE_SIZE),
    page: String(page),
    exclude_pull_requests: "true",
  });
  return `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?${params}`;
}

/**
 * Returns whether a run could serve as a coverage baseline: a push to the
 * default branch that concluded successfully. The same runs
 * {@link workflowRunsPathForBaseline} asks GitHub to select.
 */
export function isBaselineCandidateRun(
  run: Pick<WorkflowRun, "event" | "head_branch" | "conclusion">,
): boolean {
  return run.event === "push" && run.head_branch === "main" &&
    run.conclusion === "success";
}

/** The GitHub page of a workflow run: the URL the baseline file records. */
export function workflowRunUrl(runId: number): string {
  return `${SERVER_URL}/${REPO}/actions/runs/${runId}`;
}

export function serializeCoverageBaseline(
  metrics: Map<string, BaselineSample>,
  compileCacheStates?: CompileCacheStates,
): CoverageBaselineFile {
  const file: CoverageBaselineFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    metrics: metricsToRecords(metrics),
  };
  if (compileCacheStates && Object.keys(compileCacheStates).length > 0) {
    file.compileCacheStates = compileCacheStates;
  }
  return file;
}

function metricsToRecords(
  metrics: Map<string, BaselineSample>,
): MetricRecord[] {
  return [...metrics.entries()]
    .map(([name, sample]) => ({
      name,
      runId: sample.runId,
      runUrl: workflowRunUrl(sample.runId),
      sha: sample.sha,
      createdAt: sample.createdAt,
      durationSeconds: sample.uncoveredLines,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Parsed coverage baseline plus the run's compile cache states, when tagged. */
export interface CoverageBaselineDetailed {
  metrics: Map<string, BaselineSample>;

  /** Null when the file recorded no compile cache states. */
  compileCacheStates: CompileCacheStates | null;
}

const COMPILE_CACHE_FAMILY_SET: ReadonlySet<string> = new Set(
  COMPILE_CACHE_FAMILIES,
);

/**
 * Parse a baseline artifact file into its metrics and its optional compile
 * cache states. A metric record missing a field the ratchet reads fails the
 * whole file, because a baseline that silently lost a metric would read as a
 * group with no debt to beat. Unknown cache families and invalid state values
 * are dropped instead, so a malformed tag degrades to "unknown" rather than
 * losing the run's metrics.
 */
export function parseCoverageBaselineDetailed(
  content: string,
): CoverageBaselineDetailed {
  const parsed = JSON.parse(content) as Partial<CoverageBaselineFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.metrics)) {
    throw new Error("Unsupported coverage baseline file format.");
  }

  const metrics = new Map<string, BaselineSample>();
  for (const metric of parsed.metrics) {
    if (
      typeof metric.name !== "string" ||
      typeof metric.runId !== "number" ||
      typeof metric.sha !== "string" ||
      typeof metric.createdAt !== "string" ||
      typeof metric.durationSeconds !== "number"
    ) {
      throw new Error("Invalid coverage baseline metric record.");
    }

    metrics.set(metric.name, {
      runId: metric.runId,
      sha: metric.sha,
      createdAt: metric.createdAt,
      uncoveredLines: metric.durationSeconds,
    });
  }

  const rawStates = parsed.compileCacheStates;
  if (rawStates === undefined || rawStates === null) {
    return { metrics, compileCacheStates: null };
  }

  const compileCacheStates: CompileCacheStates = {};
  if (typeof rawStates === "object") {
    for (const [family, state] of Object.entries(rawStates)) {
      if (!COMPILE_CACHE_FAMILY_SET.has(family)) continue;
      if (state !== "cold" && state !== "warm") continue;
      compileCacheStates[family as CompileCacheFamily] = state;
    }
  }
  return { metrics, compileCacheStates };
}

export async function writeCoverageBaselineFile(
  path: string,
  metrics: Map<string, BaselineSample>,
  compileCacheStates?: CompileCacheStates,
): Promise<void> {
  await Deno.writeTextFile(
    path,
    `${
      JSON.stringify(
        serializeCoverageBaseline(metrics, compileCacheStates),
        null,
        2,
      )
    }\n`,
  );
}

/** What extracting one downloaded artifact zip produced. */
type ArtifactExtraction =
  | { extracted: true; tmpDir: string }
  | { extracted: false; error: string };

/**
 * Write the artifact zip carried by `resp` into a fresh temporary directory and
 * unzip it there, returning the directory. When either step fails the directory
 * is removed again and the failure is described for the caller's attempt log.
 */
async function extractArtifactZip(
  resp: Response,
  tmpPrefix: string,
): Promise<ArtifactExtraction> {
  const tmpDir = await Deno.makeTempDir({ prefix: tmpPrefix });
  const zipPath = `${tmpDir}/artifact.zip`;

  let error: string;
  try {
    const data = new Uint8Array(await resp.arrayBuffer());
    await Deno.writeFile(zipPath, data);

    const unzip = new Deno.Command("unzip", {
      args: ["-o", zipPath, "-d", tmpDir],
      stdout: "null",
      stderr: "piped",
    });
    const result = await unzip.output();
    if (result.success) {
      return { extracted: true, tmpDir };
    }

    const stderr = new TextDecoder().decode(result.stderr).trim();
    error = `unzip failed with exit code ${result.code}${
      stderr ? `: ${stderr}` : ""
    }`;
  } catch (caught) {
    error = `${caught}`;
  }

  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch { /* ignore cleanup errors */ }

  return { extracted: false, error };
}

export async function downloadAndExtractArtifact(
  artifactId: number,
  tmpPrefix: string,
): Promise<string | null> {
  const artifactPath = `/repos/${REPO}/actions/artifacts/${artifactId}/zip`;
  const url = `https://api.github.com${artifactPath}`;
  let lastError = "unknown error";
  const attemptErrors: string[] = [];
  const recordFailure = (attempt: number, message: string) => {
    lastError = message;
    attemptErrors.push(`attempt ${attempt}: ${message}`);
  };

  for (let attempt = 1; attempt <= GITHUB_GET_MAX_ATTEMPTS; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { headers: apiHeaders() });
    } catch (error) {
      recordFailure(attempt, `fetch failed: ${error}`);
      if (attempt === GITHUB_GET_MAX_ATTEMPTS) break;
      await sleep(githubRetryDelayMs(attempt));
      continue;
    }

    if (!resp.ok) {
      const statusText = resp.statusText ? ` ${resp.statusText}` : "";
      const failure =
        `GitHub artifact download ${resp.status}${statusText}: ${artifactPath}`;
      recordFailure(attempt, failure);
      const rateLimited = isRateLimitResponse(
        resp,
        await readRefusalBody(resp),
      );
      const overPrimaryLimit = isOverPrimaryRateLimit(resp);
      // A limit is the one refusal this must not report as a missing artifact:
      // a caller told the artifact is absent holds its metric against no
      // baseline, which is a verdict about coverage rather than about GitHub.
      if (
        rateLimited &&
        (overPrimaryLimit || attempt === GITHUB_GET_MAX_ATTEMPTS)
      ) {
        throw new GitHubRateLimitError(failure);
      }
      if (
        attempt === GITHUB_GET_MAX_ATTEMPTS ||
        !RETRYABLE_ARTIFACT_DOWNLOAD_STATUSES.has(resp.status)
      ) {
        break;
      }
      await sleep(githubRetryDelayMs(attempt, resp));
      continue;
    }

    const extraction = await extractArtifactZip(resp, tmpPrefix);
    if (extraction.extracted) return extraction.tmpDir;
    recordFailure(attempt, extraction.error);

    if (attempt < GITHUB_GET_MAX_ATTEMPTS) {
      await sleep(githubRetryDelayMs(attempt));
    }
  }

  console.warn(
    `  Warning: could not download/extract artifact ${artifactId} (${artifactPath}) after ${GITHUB_GET_MAX_ATTEMPTS} attempt(s): ${lastError}`,
  );
  console.warn(
    `  Artifact download attempts: ${attemptErrors.join(" | ")}`,
  );
  return null;
}

/**
 * Download the per-run perf-metrics artifact and parse the coverage baseline it
 * records — its coverage-debt metrics along with the run's compile cache states
 * (null when the file recorded no cache states).
 */
export async function downloadAndParseCoverageBaseline(
  artifactId: number,
): Promise<CoverageBaselineDetailed | null> {
  const tmpDir = await downloadAndExtractArtifact(artifactId, "perf-metrics-");
  if (!tmpDir) return null;
  try {
    const content = await Deno.readTextFile(`${tmpDir}/${PERF_METRICS_FILE}`);
    return parseCoverageBaselineDetailed(content);
  } catch {
    return null;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

//
// Compile cache state
//

/**
 * Parse the JSON contents of cache-state artifact files into records.
 * Returns null if any entry is malformed or invalid (each warned): a shard
 * whose record cannot be read could be the cold one, so a partial parse
 * could mislabel its family warm — the whole collection must degrade to
 * "unknown" instead, matching the artifact-download failure policy.
 */
export function parseCacheStateFiles(
  contents: string[],
): CacheStateRecord[] | null {
  const records: CacheStateRecord[] = [];
  let invalid = false;
  for (const content of contents) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      console.warn(
        `  Warning: malformed cache-state file: ${error}`,
      );
      invalid = true;
      continue;
    }

    const record = parsed as Partial<CacheStateRecord> | null;
    if (
      !isObjectOrArray(record) ||
      typeof record.family !== "string" ||
      typeof record.shard !== "string" ||
      typeof record.matchedKey !== "string" ||
      typeof record.exactHit !== "boolean"
    ) {
      console.warn(
        `  Warning: invalid cache-state record: ${content.trim()}`,
      );
      invalid = true;
      continue;
    }

    records.push({
      family: record.family,
      shard: record.shard,
      matchedKey: record.matchedKey,
      exactHit: record.exactHit,
    });
  }
  return invalid ? null : records;
}

/**
 * Aggregate per-shard cache-state records into one state per family: any
 * full-miss shard (`matchedKey === ""`) makes the family cold, otherwise at
 * least one record makes it warm (restore-key hits included — any hit implies
 * the compiler fingerprint is unchanged). Families with no records stay
 * absent (unknown); records from unknown families are ignored.
 */
export function aggregateCacheStates(
  records: CacheStateRecord[],
): CompileCacheStates {
  const states: CompileCacheStates = {};
  for (const record of records) {
    if (!COMPILE_CACHE_FAMILY_SET.has(record.family)) continue;
    const family = record.family as CompileCacheFamily;
    states[family] = record.matchedKey === "" ? "cold" : (
      states[family] ?? "warm"
    );
  }
  return states;
}

//
// Formatting
//

export function isCoverageDebtMetric(name: string): boolean {
  return name.startsWith(COVERAGE_METRIC_PREFIX);
}

export function coverageMetricGroupName(metric: string): string | null {
  if (!isCoverageDebtMetric(metric)) return null;

  const prefix = `${COVERAGE_METRIC_PREFIX} `;
  const suffix = " uncovered lines";
  if (!metric.startsWith(prefix) || !metric.endsWith(suffix)) return null;

  const name = metric.slice(prefix.length, -suffix.length);
  // A measured set's figure carries a member's name and is not a source
  // group. Whatever iterates the coverage metrics of a run sees both, and
  // reading one as the other would ratchet the wrong number.
  return name.startsWith(MEASURED_SET_MARKER) ? null : name;
}

/** What separates a measured set's metric from a source group's. */
const MEASURED_SET_MARKER = "measured set ";

/**
 * The metric one measured set's uncovered lines are counted in, named by
 * the suite and the member the set pairs.
 *
 * A different quantity from the source group over the same member: that
 * one is the member's source measured by every test in the run, and this
 * one is the same source measured by one suite's tests alone. The two
 * come apart under test selection, because a run that samples the corpus
 * measures a sample of the first and the whole of the second. That is
 * what makes this the figure the coverage gate can compare and the other
 * one a trend.
 */
export function measuredSetCoverageMetric(set: string): string {
  return `${COVERAGE_METRIC_PREFIX} ${MEASURED_SET_MARKER}${set} ` +
    `uncovered lines`;
}

/** The measured set one metric names, or null for anything else. */
export function coverageMetricMeasuredSet(metric: string): string | null {
  const prefix = `${COVERAGE_METRIC_PREFIX} ${MEASURED_SET_MARKER}`;
  const suffix = " uncovered lines";
  if (!metric.startsWith(prefix) || !metric.endsWith(suffix)) return null;
  const set = metric.slice(prefix.length, -suffix.length);
  return set.length === 0 ? null : set;
}

/** The metric a source group's uncovered lines are counted in. */
export function coverageMetricForGroup(group: string): string {
  return `${COVERAGE_METRIC_PREFIX} ${group} uncovered lines`;
}

export function coverageGroupForChangedFile(filename: string): string | null {
  const normalized = filename.replaceAll("\\", "/");
  if (!/\.[jt]sx?$/.test(normalized)) return null;

  const parts = normalized.split("/");
  if (parts[0] === "packages" && parts[1]) {
    return `packages/${parts[1]}`;
  }
  if (parts[0] === "tasks") {
    return parts[0];
  }
  return null;
}

export function coverageGroupsForChangedFiles(
  filenames: Iterable<string>,
): Set<string> {
  const groups = new Set<string>();
  for (const filename of filenames) {
    const group = coverageGroupForChangedFile(filename);
    if (group) groups.add(group);
  }
  return groups;
}

export function shouldGateCoverageDebtMetric(
  metric: string,
  changedCoverageGroups: Set<string> | undefined,
): boolean {
  if (!isCoverageDebtMetric(metric)) return true;
  if (!changedCoverageGroups) return true;

  const group = coverageMetricGroupName(metric);
  if (!group || group === "workspace") return false;
  return changedCoverageGroups.has(group);
}

/**
 * Parse a unified diff (the per-file `patch` from the GitHub PR files API) and
 * return the lines this PR adds, keyed by their line number in the new file
 * and mapped to the added source text (without the leading `+`).
 */
export function parseAddedLinesFromPatch(patch: string): Map<number, string> {
  const added = new Map<number, string>();
  let newLineNumber = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        newLineNumber = parseInt(match[1], 10);
        inHunk = true;
      }
      continue;
    }

    // Skip the file-header section (e.g. `--- a/...`, `+++ b/...`) that precedes
    // the first hunk. Inside a hunk every line is content, so a `+`/`-` is the
    // diff marker and the rest — even another `+` or `-` — is source text.
    if (!inHunk) continue;

    if (line.startsWith("+")) {
      added.set(newLineNumber, line.slice(1));
      newLineNumber++;
      continue;
    }

    if (line.startsWith("-")) {
      // Deletion: present only in the old file, so the new-file cursor holds.
      continue;
    }

    // "\ No newline at end of file" markers and the trailing empty element
    // from splitting do not advance the new-file cursor.
    if (line.startsWith("\\") || line === "") continue;

    // Context line: present in both files.
    newLineNumber++;
  }

  return added;
}

/** A changed source group whose uncovered-line count regressed. */
export interface CoverageSuggestionGroup {
  group: string;

  /** Uncovered-line count from latest `main`; the PR must not exceed it. */
  target: number;

  /** Uncovered-line count this PR produced. */
  current: number;
}

/**
 * Count of newly uncovered lines attributed to one file. Usually these are
 * lines the PR added; an accepted unattributed regression can instead name
 * lines in an unchanged file that the baseline run covered.
 */
export interface CoverageSuggestionFileLines {
  relativePath: string;
  group: string;
  uncoveredCount: number;
}

/** A changed source group and where this PR left its uncovered-line count. */
export interface CoverageResolvedGroup {
  group: string;

  /** Uncovered-line count from latest `main`. */
  baseline: number;

  /** Uncovered-line count this PR produced. */
  current: number;
}

export interface CoverageDebtSuggestionInput {
  groups: CoverageSuggestionGroup[];
  files: CoverageSuggestionFileLines[];
}

const MAX_SUGGESTION_FILES = 50;

/**
 * Cap the file listing so a large PR does not produce an enormous comment.
 * Returns the files trimmed to the budget and how many were dropped.
 */
function limitSuggestionFiles(
  files: CoverageSuggestionFileLines[],
): { files: CoverageSuggestionFileLines[]; omitted: number } {
  if (files.length <= MAX_SUGGESTION_FILES) {
    return { files, omitted: 0 };
  }
  return {
    files: files.slice(0, MAX_SUGGESTION_FILES),
    omitted: files.length - MAX_SUGGESTION_FILES,
  };
}

function uncoveredLineCount(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

/**
 * The Markdown bullet list naming each file and how many of the lines it adds
 * no test executes. Both coverage comments render it, in the same words, so a
 * reader who has seen one recognizes the other.
 */
function uncoveredFileList(
  files: CoverageSuggestionFileLines[],
  omitted: number,
): string[] {
  const lines = files.map((file) =>
    `- \`${file.relativePath}\` — ${uncoveredLineCount(file.uncoveredCount)}`
  );
  if (omitted > 0) lines.push(`- _…and ${omitted} more file(s)._`);
  return lines;
}

/**
 * Render the disclosure `<summary>`, leading with the detective emoji. The
 * regression comment wraps the line in an `<h3>` so it stands out while the
 * details are open; the resolved comment uses `<strong>`, a quieter weight that
 * suits a collapsed, already-handled note.
 */
function coverageSummary(
  text: string,
  emphasis: "h3" | "strong" = "h3",
): string {
  return `<summary><${emphasis}>🕵🏻‍♀️ ${text}</${emphasis}></summary>`;
}

function formatTargetList(groups: CoverageSuggestionGroup[]): string[] {
  return groups.map((group) =>
    `  ${COVERAGE_METRIC_PREFIX} ${group.group} uncovered lines  <=  ${group.target}   (this PR: ${group.current})`
  );
}

/**
 * Build the plain-text prompt an author can paste into an AI coding agent. It
 * is self-contained: the files holding the new uncovered code, the command to
 * reproduce the gate, and the target thresholds it must reach.
 */
function buildCoverageSuggestionPrompt(
  input: CoverageDebtSuggestionInput,
  limitedFiles: CoverageSuggestionFileLines[],
  omitted: number,
): string[] {
  const lines: string[] = [
    "Test coverage for this branch regressed: it adds source lines that no",
    "test executes, and the CI coverage gate is failing. Add or extend tests so",
    "the new code in the files below is executed. Write real tests that exercise",
    "the code paths; do not delete assertions, mark lines ignored, or weaken the",
    "gate.",
    "",
  ];

  if (limitedFiles.length > 0) {
    lines.push("Files with new uncovered lines (count in parentheses):");
    lines.push("");
    for (const file of limitedFiles) {
      lines.push(`  ${file.relativePath} (${file.uncoveredCount})`);
    }
    if (omitted > 0) {
      lines.push(`  ...and ${omitted} more file(s).`);
    }
    lines.push("");
  } else {
    lines.push(
      "The uncovered lines could not be tied to specific files from the diff.",
      "Run the command below to measure each group.",
      "",
    );
  }

  lines.push("After adding tests, verify from the repository root:");
  lines.push("");
  for (const command of COVERAGE_LOCAL_CHECK_COMMAND.split("\n")) {
    lines.push(`  ${command}`);
  }
  lines.push("");
  lines.push(
    "That prints one JSON object of coverage-debt metrics. The gate passes when",
    "each of these metrics is at or below its target:",
    "",
  );
  lines.push(...formatTargetList(input.groups));
  lines.push("");
  lines.push(
    "Use the metrics only after the test run finishes and passes. If a test",
    "fails while collecting coverage, make it pass or temporarily skip it for",
    "the coverage run, then rerun the command above from the start. Do not",
    "include temporary test skips in the PR. The workspace runner stops",
    "launching packages after the first failure, so code in packages it never",
    "runs is counted as fully uncovered.",
    "",
    "The local run omits the integration suites, so its counts are conservative:",
    "if every metric meets its target locally, CI will pass too.",
  );

  return lines;
}

/**
 * Build the Markdown body of the once-per-PR coverage-regression comment. Leads
 * with the hidden marker so a later run can detect that it was already posted.
 */
export function buildCoverageDebtSuggestionComment(
  input: CoverageDebtSuggestionInput,
): string {
  const { files, omitted } = limitSuggestionFiles(input.files);
  const overBy = input.groups.reduce(
    (sum, group) => sum + (group.current - group.target),
    0,
  );
  const out: string[] = [COVERAGE_SUGGESTION_MARKER];

  out.push("<details open>");
  out.push(
    coverageSummary(`Test coverage regressed by ${uncoveredLineCount(overBy)}`),
  );
  out.push("");
  out.push(
    "This PR adds source lines that no test exercises, so the coverage gate in " +
      "the **Coverage Check** job is failing. The gate ratchets each changed " +
      "source group against its uncovered-line count on `main`: the group must " +
      "not end up with more uncovered lines than that baseline.",
  );
  out.push("");

  out.push("| Source group | Baseline (target) | This PR | Over by |");
  out.push("| --- | ---: | ---: | ---: |");
  for (const group of input.groups) {
    out.push(
      `| \`${group.group}\` | ${group.target} | ${group.current} | +${
        group.current - group.target
      } |`,
    );
  }
  out.push("");

  out.push("### Files with new uncovered lines");
  out.push("");
  if (files.length > 0) {
    out.push(...uncoveredFileList(files, omitted));
  } else {
    out.push(
      "Could not tie the regression to specific files from the diff (the " +
        "uncovered code may be in modified rather than newly-added lines). " +
        "Use the command below to measure each group.",
    );
  }
  out.push("");

  out.push("### Prompt for an AI coding agent");
  out.push("");
  out.push(
    "Copy the block below into an AI coding agent to add the missing tests:",
  );
  out.push("");
  out.push("````text");
  out.push(...buildCoverageSuggestionPrompt(input, files, omitted));
  out.push("````");
  out.push("");
  out.push("</details>");

  return out.join("\n");
}

/** One file's lines that this PR leaves uncovered and the baseline covered. */
export interface CoverageUnattributedFile {
  relativePath: string;
  lines: number[];
}

/**
 * Which run produced a coverage measurement, and which base-branch commit that
 * run measured. A `pull_request` run measures the pull request merged into the
 * base branch, so the commit worth naming is the base-branch commit: the one
 * whose history says whether a line has been given a test since.
 *
 * Each half is optional: a run of the checker outside GitHub Actions has no
 * run page to point at, and a run that could not read the commit it merged has
 * no commit to report.
 */
export interface CoverageMeasurement {
  /** The run's page on GitHub. */
  runUrl?: string;

  /** The base-branch commit the run merged the pull request into. */
  baseSha?: string;
}

/** A run that measured a baseline, and the commit it measured. */
export interface CoverageRunIdentity {
  /** The run's page on GitHub. */
  runUrl?: string;

  /** The commit that run measured. */
  sha?: string;
}

/** A regressed group, and the baseline run its count was held against. */
export interface CoverageUnattributedGroup extends CoverageSuggestionGroup {
  baseline?: CoverageRunIdentity;
}

export interface CoverageDebtUnattributedInput {
  groups: CoverageUnattributedGroup[];
  files: CoverageUnattributedFile[];

  /** The run whose coverage report the affected lines were read from. */
  measurement?: CoverageMeasurement;
}

/** How many affected files the comment names before it starts counting. */
const MAX_UNATTRIBUTED_FILES = 20;

/** How many line numbers one file contributes before the rest are counted. */
const MAX_UNATTRIBUTED_LINES_PER_FILE = 20;

/** `a.ts:3, 4, 5` — one file's affected lines, capped and counted. */
function formatUnattributedFile(file: CoverageUnattributedFile): string {
  const shown = file.lines.slice(0, MAX_UNATTRIBUTED_LINES_PER_FILE);
  const rest = file.lines.length - shown.length;
  const lines = shown.join(", ") + (rest > 0 ? `, …and ${rest} more` : "");
  return `\`${file.relativePath}\`: ${lines}`;
}

/**
 * The `ACCEPT_COVERAGE_DEBT:` line that takes one group off the ratchet. It
 * names the rise this run measured rather than the total it reached, so a
 * rebase onto a different baseline leaves the line saying the same thing.
 */
export function coverageOverrideLine(group: CoverageSuggestionGroup): string {
  return `ACCEPT_COVERAGE_DEBT: ${group.group} +${
    uncoveredLineCount(group.current - group.target)
  }`;
}

/** `run <url>, commit <sha>`, dropping either half the run context lacks. */
function formatRunIdentity(identity: CoverageRunIdentity): string | null {
  const parts: string[] = [];
  if (identity.runUrl) parts.push(`run ${identity.runUrl}`);
  if (identity.sha) parts.push(`commit ${identity.sha}`);
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * Name the runs the affected lines were read from, and tell the reader to
 * check that the measurement still describes the code before working on it.
 *
 * A run is named only as far as the run context named it, so a checker run
 * outside GitHub Actions prints no run page and no commit, and the closing
 * paragraph drops its reference to the measured commit.
 */
function buildMeasurementSection(
  input: CoverageDebtUnattributedInput,
): string[] {
  const measurement = input.measurement ?? {};
  const provenance: string[] = [];
  if (measurement.runUrl) {
    provenance.push(`  Measuring run: ${measurement.runUrl}`);
  }
  if (measurement.baseSha) {
    provenance.push(`  Base commit measured: ${measurement.baseSha}`);
  }
  for (const group of input.groups) {
    const baseline = group.baseline && formatRunIdentity(group.baseline);
    if (!baseline) continue;
    provenance.push(`  Baseline for ${group.group}: ${baseline}`);
  }

  const lines: string[] = [];
  if (provenance.length > 0) {
    lines.push("", "Where this measurement came from:", "", ...provenance);
  }
  lines.push("");
  lines.push(
    ...(measurement.baseSha
      ? [
        "The run above measured the pull request merged into that base commit,",
        "and held the result against a measurement each baseline run took of",
        "its own commit. Code moves and tests land, so check what has reached",
        "`main` since. On an up-to-date checkout:",
        "",
        `  git log ${measurement.baseSha}.. -- <one of the files above>`,
        "",
        "If a line has changed, or been given a test, the measurement has been",
        "overtaken: say so rather than writing a second test for a line that",
        "already has one.",
      ]
      : [
        "The lines above are one measurement, and it may no longer describe the",
        "code. Code moves and tests land. Before working on a line, read",
        "`git log` for its file and check whether the line has changed, or been",
        "given a test, since the measurement was taken. If it has, the",
        "measurement has been overtaken: say so rather than writing a second",
        "test for a line that already has one.",
      ]),
  );
  return lines;
}

/**
 * Build the prompt for an agent asked to make the affected lines cover the same
 * way on every run. The work is on the lines themselves, not on this pull
 * request, so the prompt is written to be pasted into a fresh session.
 */
function buildUnattributedPrompt(
  input: CoverageDebtUnattributedInput,
  files: CoverageUnattributedFile[],
  omitted: number,
): string[] {
  const lines: string[] = [
    "The lines below are covered on some runs of the CI test suite and not on",
    "others, with no change to their source. That makes the coverage-debt gate",
    "fail on pull requests that did not touch them, because the gate compares",
    "one measurement of a source group against another.",
    "",
    "Find out what each line's coverage depends on, and add or extend a test so",
    "the line is executed on every run and under every configuration. Common",
    "causes: a branch taken only when an operation happens twice in one process,",
    "a guard on elapsed wall-clock time, a path reached only when work lands in",
    "a particular order, and a file that only some shards load. Write real",
    "tests: do not delete assertions, mark lines ignored, or weaken the gate.",
    "",
    "Affected lines:",
    "",
  ];

  for (const file of files) {
    const shown = file.lines.slice(0, MAX_UNATTRIBUTED_LINES_PER_FILE);
    const rest = file.lines.length - shown.length;
    lines.push(
      `  ${file.relativePath}: ${shown.join(", ")}${
        rest > 0 ? `, and ${rest} more` : ""
      }`,
    );
  }
  if (omitted > 0) lines.push(`  ...and ${omitted} more file(s).`);

  lines.push(...buildMeasurementSection(input));

  lines.push(
    "",
    'docs/development/COVERAGE.md, under "Coverage must not depend on the',
    'execution environment", states the policy and works through examples of',
    "each cause. Read it first.",
    "",
    "Do not try to establish that a line is fixed by running the suite several",
    "times and finding it covered each time. A line covered on most runs looks",
    "settled in any number of runs you have the patience for, and a run that",
    "covers it by luck reads exactly like one that covers it by design. What",
    "makes a line deterministic is a test that drives the condition the line",
    "needs, so that reaching the line is what the test is for.",
    "",
    "Confirm that by measuring the test you added on its own. Run it the way",
    "its package runs tests — the package's deno.jsonc gives the flags — with a",
    "clean profile directory:",
    "",
    "  rm -rf coverage/raw/line-check",
    '  DENO_COVERAGE_DIR="$(pwd)/coverage/raw/line-check" \\',
    "    deno test <flags> <the test file you added>",
    "  deno coverage --lcov coverage/raw/line-check > line-check.lcov",
    "",
    "Find the file's SF: record in line-check.lcov and read the DA:<line>,<hits>",
    "entry for each affected line. Every one of them must show a nonzero hit",
    "count from that test alone. A line still covered only when the rest of the",
    "suite runs is a line still covered by accident.",
  );

  return lines;
}

/**
 * Build the Markdown body for a regression none of the pull request's own added
 * lines account for: every affected line is in a file the pull request left
 * alone, and the baseline run covered it. Carries the same hidden marker as the
 * other coverage comments, so the poster keeps updating the one comment.
 */
export function buildCoverageDebtUnattributedComment(
  input: CoverageDebtUnattributedInput,
): string {
  const files = input.files.slice(0, MAX_UNATTRIBUTED_FILES);
  const omitted = input.files.length - files.length;
  const overBy = input.groups.reduce(
    (sum, group) => sum + (group.current - group.target),
    0,
  );

  const out: string[] = [COVERAGE_SUGGESTION_MARKER];
  out.push("<details open>");
  out.push(
    coverageSummary(`Test coverage regressed by ${uncoveredLineCount(overBy)}`),
  );
  out.push("");
  out.push(
    "For some reason there are lines marked as uncovered in this PR that are " +
      "not introduced by this PR and that were previously covered on `main`. " +
      "This is likely because there are lines that are inconsistently covered " +
      "on `main`.",
  );
  out.push("");
  out.push("The following lines are affected:");
  out.push("");
  for (const file of files) {
    out.push(`- ${formatUnattributedFile(file)}`);
  }
  if (omitted > 0) {
    out.push(`- _…and ${omitted} more file(s)._`);
  }
  out.push("");
  out.push(
    "To skip coverage checking for this PR, add the following to the PR's " +
      "description:",
  );
  out.push("");
  out.push("```text");
  for (const group of input.groups) {
    out.push(coverageOverrideLine(group));
  }
  out.push("```");
  out.push("");
  out.push("### Prompt for an AI coding agent");
  out.push("");
  out.push(
    "Copy the block below into a new AI coding agent session to improve our " +
      "coverage and reduce this kind of flakiness in the future:",
  );
  out.push("");
  out.push("````text");
  out.push(...buildUnattributedPrompt(input, files, omitted));
  out.push("````");
  out.push("");
  out.push("</details>");

  return out.join("\n");
}

/** Why the gate held a changed source group against no baseline. */
export type CoverageNotGatedReason =
  /** GitHub's listing of the workflow's runs left out the run asking for it. */
  | "listing-not-current"
  /** The checkout did not name the base-branch commit the run merged. */
  | "no-base-commit"
  /** No `main` run within reach measured that commit or an ancestor of it. */
  | "no-baseline"
  /** The base branch changed the group since the nearest measured ancestor. */
  | "base-branch-moved"
  /** GitHub's API rate limit stopped the run reading any baseline data. */
  | "rate-limited";

/** A source group the pull request changed and the gate did not hold. */
export interface CoverageNotGatedGroup {
  /** The source group, named as an `ACCEPT_COVERAGE_DEBT` line names it. */
  group: string;

  reason: CoverageNotGatedReason;

  /** The commit the nearest baseline measured, when there is one. */
  baselineSha?: string;
}

/**
 * What a report of an ungated run says: which groups, and why. It says nothing
 * of how the job ended, because a group with no baseline decides that only when
 * the reason is the run listing: a regression in another group fails the same
 * job.
 */
export interface CoverageNotGatedInput {
  /** The groups the gate applied to and compared against nothing. */
  groups: CoverageNotGatedGroup[];

  /** The run that went ungated, and the base-branch commit it merged. */
  measurement?: CoverageMeasurement;
}

/**
 * Returns whether `groups` went ungated because the run listing was not
 * current. That reason is the one that fails the job by itself, and the one
 * whose remedy is reading the listing again.
 */
export function coverageListingNotCurrent(
  groups: CoverageNotGatedGroup[],
): boolean {
  return groups.some((group) => group.reason === "listing-not-current");
}

/**
 * Returns whether `groups` went ungated because a GitHub API rate limit stopped
 * the run reading the data a comparison needs. That reason is the one whose
 * remedy waits on GitHub rather than on this repository.
 */
function coverageRateLimited(groups: CoverageNotGatedGroup[]): boolean {
  return groups.some((group) => group.reason === "rate-limited");
}

/** The headline every surface reporting an ungated run opens with. */
export const COVERAGE_NOT_GATED_HEADLINE =
  "Test coverage was NOT gated on this run";

/** How a sentence names the base-branch commit, read or not. */
function baseCommitPhrase(baseSha: string | undefined): string {
  return baseSha
    ? `base-branch commit \`${baseSha.slice(0, 8)}\``
    : "the base-branch commit";
}

/** One sentence saying why `group` was not gated. */
function coverageNotGatedReasonText(
  group: CoverageNotGatedGroup,
  baseSha: string | undefined,
): string {
  switch (group.reason) {
    case "listing-not-current":
      return "GitHub's listing of this workflow's runs left out this run, so " +
        "no `main` run it named could be trusted as a baseline.";
    case "no-base-commit":
      return "The base-branch commit this run merges into could not be read " +
        "from the checkout.";
    case "no-baseline":
      return "No successful `main` run within reach measured " +
        `${baseCommitPhrase(baseSha)} or an ancestor of it.`;
    case "base-branch-moved": {
      const ancestor = group.baselineSha
        ? ` (\`${group.baselineSha.slice(0, 8)}\`)`
        : "";
      return "`main` changed this group between the nearest measured " +
        `ancestor${ancestor} and ${baseCommitPhrase(baseSha)}.`;
    }
    case "rate-limited":
      return "GitHub's API rate limit stopped this run reading the baseline " +
        "data, so nothing was compared.";
  }
}

/** What the reader is asked to do about a run that gated nothing. */
function coverageNotGatedRemedy(groups: CoverageNotGatedGroup[]): string {
  if (coverageListingNotCurrent(groups)) {
    return "Re-run the **Coverage Check** job to ask GitHub for the listing " +
      "again.";
  }
  if (coverageRateLimited(groups)) {
    return "Re-run the **Coverage Check** job once GitHub's API rate limit " +
      "has reset. The limit is a property of the moment rather than of this " +
      "pull request, so a re-run started straight away meets it again.";
  }
  return "A later run of this pull request gates these groups, once a `main` " +
    "run has measured the commit it merges. Re-running the **Coverage " +
    "Check** job is enough when that `main` run has finished since; " +
    "updating the branch gives the next run a newer commit to merge.";
}

/**
 * The Markdown saying which changed source groups went ungated, why, and what
 * gates them. The pull request comment and the job summary both render it, so
 * the two say the same thing.
 */
export function coverageNotGatedNotice(input: CoverageNotGatedInput): string[] {
  const baseSha = input.measurement?.baseSha;
  const groups = input.groups.map((group) => `\`${group.group}\``).join(", ");
  const listingNotCurrent = coverageListingNotCurrent(input.groups);
  const out: string[] = [];

  out.push(
    listingNotCurrent
      ? "The **Coverage Check** job failed because it could not find a " +
        `baseline to hold ${groups} against. Nothing here says this pull ` +
        "request regressed coverage, and nothing says it did not."
      : `The **Coverage Check** job did not hold ${groups} against a ` +
        "baseline, so it would not have caught a coverage regression there.",
  );
  out.push("");
  out.push("| Source group | Why it was not gated |");
  out.push("| --- | --- |");
  for (const group of input.groups) {
    out.push(
      `| \`${group.group}\` | ${coverageNotGatedReasonText(group, baseSha)} |`,
    );
  }
  out.push("");
  out.push(coverageNotGatedRemedy(input.groups));
  if (input.measurement?.runUrl) {
    out.push("");
    out.push(`Measured by ${input.measurement.runUrl}.`);
  }
  return out;
}

/**
 * Build the Markdown body of the coverage comment for a run that held one or
 * more changed source groups against no baseline. Carries the same hidden
 * marker as the other coverage comments, so the poster keeps updating the one
 * comment, and stays open so the state is read without a click.
 */
export function buildCoverageNotGatedComment(
  input: CoverageNotGatedInput,
): string {
  return [
    COVERAGE_SUGGESTION_MARKER,
    "<details open>",
    coverageSummary(COVERAGE_NOT_GATED_HEADLINE),
    "",
    ...coverageNotGatedNotice(input),
    "",
    "</details>",
  ].join("\n");
}

/**
 * Describe how a group's uncovered-line count moved between its `main` baseline
 * and this PR, for the "Change" column of the resolved comment's table.
 */
function coverageChangeText(baseline: number, current: number): string {
  const delta = baseline - current;
  if (delta === 0) return "no change";
  const magnitude = uncoveredLineCount(Math.abs(delta));
  return delta > 0 ? `${magnitude} fewer` : `${magnitude} more`;
}

/**
 * Build the Markdown body of the coverage comment once the gate passes, in
 * place of what an earlier run left there: a regression, or a notice that the
 * run went ungated. Leads with the same hidden marker so the poster keeps
 * finding the one comment, keeps the disclosure collapsed (no `open`), and
 * replaces the earlier body with a short summary of where the PR left coverage.
 *
 * `improvedLines` is the net reduction in the overall (workspace) uncovered-line
 * count versus its `main` baseline: when positive the summary reports the
 * reduction, otherwise it just notes the debt is within the ratchet. `groups` lists
 * the changed source groups the gate ratchets, each with its `main` baseline and
 * the count this PR produced, rendered as a before-and-after table. When
 * `overridden` is set the gate passed only because the debt was accepted with an
 * override or the reset marker, so the summary says the metric was overridden
 * rather than implying the new code is covered. An overridden run with no
 * `groups` compared nothing, which is a reset whose run listing was not
 * current, and the comment says that in place of the table.
 *
 * `files` names where those uncovered lines are, and is rendered only under an
 * override. This comment replaces an earlier regression body in place, and that
 * body is the only place the attribution was ever written down: without it here,
 * accepting the debt erases the answer to "which file" from the pull request.
 * The other two resolutions have no such answer to keep — the debt was covered
 * rather than accepted.
 */
export function buildCoverageResolvedComment(
  improvedLines: number,
  groups: CoverageResolvedGroup[],
  overridden = false,
  files: CoverageSuggestionFileLines[] = [],
): string {
  const summary = overridden
    ? "Code coverage debt accepted with an override."
    : improvedLines > 0
    ? `Code coverage debt reduced by ${uncoveredLineCount(improvedLines)}!`
    : "Code coverage debt is within the ratchet.";

  const out: string[] = [COVERAGE_SUGGESTION_MARKER];
  out.push("<details>");
  out.push(coverageSummary(summary, "strong"));
  out.push("");
  out.push(
    overridden
      ? "The coverage gate in the **Coverage Check** job passes because this " +
        "PR's coverage debt was accepted with an override rather than covered " +
        "by new tests. Here is where it left each changed source group:"
      : improvedLines > 0
      ? "The coverage gate in the **Coverage Check** job passes. This PR " +
        `now covers ${
          uncoveredLineCount(improvedLines)
        } that no test reached ` +
        "on `main`. Here is where it left each changed source group:"
      : "The coverage gate in the **Coverage Check** job passes. Here is " +
        "where this PR left each changed source group:",
  );
  out.push("");

  if (groups.length > 0) {
    out.push("| Source group | Baseline (`main`) | This PR | Change |");
    out.push("| --- | ---: | ---: | ---: |");
    for (const group of groups) {
      out.push(
        `| \`${group.group}\` | ${group.baseline} | ${group.current} | ${
          coverageChangeText(group.baseline, group.current)
        } |`,
      );
    }
  } else {
    out.push(
      overridden
        ? "This run compared no source group against a baseline, so there " +
          "are no counts to show."
        : "Every changed source group is at or below its `main` baseline " +
          "for uncovered lines.",
    );
  }

  const limited = limitSuggestionFiles(files);
  if (overridden && limited.files.length > 0) {
    out.push("");
    out.push("### Files with new uncovered lines");
    out.push("");
    out.push(...uncoveredFileList(limited.files, limited.omitted));
  }

  out.push("");
  out.push("</details>");

  return out.join("\n");
}

//
// Event helpers
//

/**
 * Reads and parses the GHA event. Returns `undefined` if it can't be done.
 */
export async function readAndParseEvent(
  eventPath?: string,
): Promise<object | undefined> {
  eventPath ??= Deno.env.get("GITHUB_EVENT_PATH");

  if (!eventPath) {
    return undefined;
  }

  try {
    const result = JSON.parse(await Deno.readTextFile(eventPath));
    return (typeof result === "object") ? result : undefined;
  } catch {
    return undefined;
  }
}

//
// PR helpers
//

/** Fetch the full body of a PR by number. */
export async function fetchPRBody(prNumber: number): Promise<string> {
  const pr = await githubGet<{ body: string | null }>(
    `/repos/${REPO}/pulls/${prNumber}`,
  );
  return pr.body ?? "";
}

export async function fetchPRFiles(prNumber: number): Promise<PRFile[]> {
  const files: PRFile[] = [];
  const perPage = 100;

  for (let page = 1;; page++) {
    const data = await githubGet<PRFile[]>(
      `/repos/${REPO}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`,
    );
    files.push(...data);
    if (data.length < perPage) break;
  }

  return files;
}

/** Fetch every issue comment on a PR (PR conversation comments). */
export async function fetchIssueComments(
  issueNumber: number,
): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  const perPage = 100;

  for (let page = 1;; page++) {
    const data = await githubGet<
      { id: number; body: string | null; user?: { login?: string } }[]
    >(
      `/repos/${REPO}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
    );
    for (const comment of data) {
      comments.push({
        id: comment.id,
        body: comment.body ?? "",
        ...(comment.user?.login === undefined
          ? {}
          : { author: comment.user.login }),
      });
    }
    if (data.length < perPage) break;
  }

  return comments;
}

export function pullRequestBodyFromEvent(
  event: object | undefined,
): string | undefined {
  const pullRequest =
    (event as { pull_request?: { body?: unknown } } | undefined)
      ?.pull_request;
  if (!pullRequest || !("body" in pullRequest)) return undefined;
  return typeof pullRequest.body === "string" ? pullRequest.body : "";
}

export async function fetchCurrentPRBody(
  prNumber: number,
  event: object | undefined,
): Promise<CurrentPRBody> {
  try {
    return { body: await fetchPRBody(prNumber), source: "live" };
  } catch (error) {
    const eventBody = pullRequestBodyFromEvent(event);
    return {
      body: eventBody ?? "",
      source: eventBody === undefined ? "empty-fallback" : "event-fallback",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

//
// Coverage override parsing
//

/**
 * Each `ACCEPT_COVERAGE_DEBT:` marker that starts a line, and the rest of that
 * line. An acceptance is written flush against the left margin, which is what
 * lets a description also talk about the mechanism: the marker named in a
 * sentence is prose, and an indented example of one is an example. Neither is
 * read as an acceptance, and neither is reported as a malformed one.
 */
const COVERAGE_ACCEPTANCE_MARKER = /^ACCEPT_COVERAGE_DEBT:[^\n]*/gm;

/** The same marker, indented, which is what makes it an example. */
const COVERAGE_ACCEPTANCE_INDENTED = /^[ \t]+ACCEPT_COVERAGE_DEBT:[^\n]*/gm;

/** The source group and the rise a well-formed acceptance names. */
const COVERAGE_ACCEPTANCE_TERMS =
  /^ACCEPT_COVERAGE_DEBT:[ \t]*(\S+)[ \t]*\+[ \t]*(\d+)[ \t]*lines?\b/;

/**
 * A coverage source group. Metric collection rolls a file up to its top-level
 * directory, `packages` excepted, where the package directory below it carries
 * the group. So `workspace` and `tasks` are groups and `packages/runner` is
 * one, while `tasks/foo` and `packages/connectors/github` are not — nothing
 * measures a group at that depth.
 */
const COVERAGE_GROUP_NAME = /^(?:[A-Za-z0-9._-]+|packages\/[A-Za-z0-9._-]+)$/;

/** Whether an accepted name is one the repository-wide ratchet measures. */
export function namesCoverageSourceGroup(name: string): boolean {
  return COVERAGE_GROUP_NAME.test(name);
}

/**
 * What an acceptance may name: a coverage source group, or a workspace member
 * nested deeper than one. The coverage gate scores a measured set over a
 * member, which sits at whatever depth the workspace puts it, so an acceptance
 * has to be able to name `packages/connectors/github`.
 */
const COVERAGE_ACCEPTANCE_NAME =
  /^(?:[A-Za-z0-9._-]+|packages(?:\/[A-Za-z0-9._-]+)+)$/;

/**
 * Each `ACCEPT_COVERAGE_DEBT:` acceptance in a description, as the name it
 * gives against the lines it allows.
 *
 * The name is read as written. Two gates take it differently — the
 * repository-wide ratchet reads it as a coverage source group, and the
 * coverage gate reads it as a workspace member — and one parse serving both
 * is what keeps an author writing one marker rather than two.
 *
 * `mergedPullRequestBody` says a merged pull request's description is what is
 * being read, in which case a marker this cannot read is passed over rather
 * than rejected: a body that has already merged cannot be rewritten to suit a
 * later parser.
 */
export function acceptedCoverageDebt(
  body: string,
  mergedPullRequestBody = false,
): Map<string, number> {
  const accepted = new Map<string, number>();
  for (const marker of body.match(COVERAGE_ACCEPTANCE_MARKER) ?? []) {
    const terms = COVERAGE_ACCEPTANCE_TERMS.exec(marker);
    if (terms === null) {
      if (mergedPullRequestBody) continue;
      throw new Error(
        `Invalid ACCEPT_COVERAGE_DEBT acceptance "${marker.trim()}": write it ` +
          "as `ACCEPT_COVERAGE_DEBT: <source group or workspace member> +N " +
          "lines`, where N is how many lines above the baseline to allow the " +
          "rise.",
      );
    }
    const name = terms[1];
    if (!COVERAGE_ACCEPTANCE_NAME.test(name)) {
      throw new Error(
        `Invalid ACCEPT_COVERAGE_DEBT acceptance for "${name}": name a ` +
          "coverage source group or a workspace member, such as " +
          "`packages/runner`, `packages/connectors/github`, `tasks`, or " +
          "`workspace`.",
      );
    }
    const lines = parseInt(terms[2], 10);
    const already = accepted.get(name);
    if (already !== undefined) {
      // Two acceptances of one name is an author who meant one number
      // and would be given the other. A body that has already merged
      // cannot be rewritten, so there the larger stands.
      if (!mergedPullRequestBody) {
        throw new Error(
          `Two ACCEPT_COVERAGE_DEBT acceptances name "${name}", for ` +
            `${already} and ${lines} lines. Write one, for the whole rise ` +
            `you are accepting.`,
        );
      }
      accepted.set(name, Math.max(already, lines));
      continue;
    }
    accepted.set(name, lines);
  }
  return accepted;
}

/**
 * Parse a PR body for coverage-debt overrides.
 *
 * Format (visible markdown, each flush against the left margin):
 *   ACCEPT_COVERAGE_DEBT: packages/runner +12 lines
 *   NEW_COVERAGE_BASELINE
 *
 * `ACCEPT_COVERAGE_DEBT` accepts one source group rising a stated number of
 * lines above whatever baseline the ratchet compares it against. It names the
 * group — `workspace`, a top-level directory such as `tasks`, or a package as
 * `packages/runner` — rather than the metric that group's lines are counted in.
 * The rise is a whole number of lines. Stating a rise rather than a total is
 * what lets a pull request be rebased: the baseline moves with the rebase and
 * the accepted rise above it does not, so the same line keeps accepting the
 * same amount of new debt.
 *
 * A group name of the right shape still names no group the run measured, so
 * the caller checks each accepted metric against the metrics it collected;
 * `unknownAcceptedMetrics()` is that check.
 * `NEW_COVERAGE_BASELINE` is a whole-coverage ratchet reset marker; it has no
 * value and lets the PR's/main run's coverage metrics become the next baseline.
 *
 * A merged PR's acceptance truncates the baseline timeline, so that a
 * previously accepted increase does not re-gate once its group's recent `main`
 * runs go cold and the ratchet reaches back past the acceptance to a lower
 * pre-acceptance sample. Only which metrics such a body names is read for that;
 * the numbers it carries mean nothing to the ratchet. `mergedPullRequestBody`
 * says a merged PR's description is what is being read, and changes two things.
 * The marker's former name, `NEW_PERF_BASELINE: <coverage-debt metric> = N
 * lines`, counts as an acceptance, since the bodies that carry it were written
 * before the rename; the timing forms it also carried gate nothing now, so a
 * non-coverage-debt legacy line is ignored rather than rejected. And a marker
 * this parser cannot read is passed over rather than rejected, because a body
 * that has already merged cannot be rewritten to suit a later parser.
 */
export function parseBaselineOverrides(
  body: string,
  mergedPullRequestBody = false,
  warn: (message: string) => void = console.warn,
): BaselineOverrides {
  const result: BaselineOverrides = {
    metrics: new Map(),
    coverageBaselineReset: new RegExp(
      `^\\s*${COVERAGE_BASELINE_RESET_MARKER}(?::\\s*.*)?\\s*$`,
      "m",
    ).test(body),
  };

  // An indented marker is read as an example, which is silent by design. Say
  // which lines that reached, so an author who meant one as an acceptance and
  // indented it can see why the gate carried on without it.
  if (!mergedPullRequestBody) {
    for (const example of body.match(COVERAGE_ACCEPTANCE_INDENTED) ?? []) {
      warn(
        `  Warning: "${example.trim()}" is indented, so it is read as an ` +
          "example. An acceptance starts at the left margin.",
      );
    }
  }

  for (
    const [name, lines] of acceptedCoverageDebt(body, mergedPullRequestBody)
  ) {
    // An acceptance naming a workspace member deeper than a source group
    // is one the coverage gate reads and this ratchet measures nothing
    // for. Taking it as a group would fail the run for an acceptance
    // that names no group.
    if (!namesCoverageSourceGroup(name)) continue;
    result.metrics.set(coverageMetricForGroup(name), lines);
  }

  if (mergedPullRequestBody) {
    const legacyRe =
      /NEW_PERF_BASELINE:\s*(.+?)\s*=\s*(\d+(?:\.\d+)?)\s*lines?\b/g;
    let legacyMatch;
    while ((legacyMatch = legacyRe.exec(body)) !== null) {
      const metric = legacyMatch[1].trim();
      if (!isCoverageDebtMetric(metric)) continue;
      if (!result.metrics.has(metric)) {
        result.metrics.set(metric, parseFloat(legacyMatch[2]));
      }
    }
  }

  return result;
}

/**
 * The accepted metrics this run measured nothing for, in the order they were
 * written.
 *
 * A group name can be well formed and still name no group: a package that does
 * not exist, a directory that holds no tracked source, a misspelling. Nothing
 * downstream consults an acceptance whose metric is absent, so left alone it
 * would read as a line that was written, accepted, and quietly did nothing.
 * The caller fails the run instead.
 */
export function unknownAcceptedMetrics(
  overrides: BaselineOverrides,
  measured: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): string[] {
  return [...overrides.metrics.keys()].filter((metric) =>
    !measured.has(metric)
  );
}

/**
 * Format an accepted rise in uncovered lines as the value half of an
 * `ACCEPT_COVERAGE_DEBT` line, rounded up to whole lines.
 */
export function formatOverrideSuggestion(value: number): string {
  const rounded = Math.ceil(value);
  return `${rounded} ${rounded === 1 ? "line" : "lines"}`;
}

/**
 * Whether a merged PR's overrides accept the debt one metric carries, either
 * with a per-group acceptance or with the whole-coverage reset marker.
 */
export function acceptsCoverageDebt(
  overrides: BaselineOverrides,
  metric: string,
): boolean {
  return overrides.metrics.has(metric) ||
    (overrides.coverageBaselineReset && isCoverageDebtMetric(metric));
}
