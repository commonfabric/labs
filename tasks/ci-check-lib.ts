/**
 * Shared helpers for the CI tasks that talk to GitHub, read coverage
 * figures, or read a pull request's coverage acceptances.
 *
 * Used by:
 *   - coverage-gate.ts          (reads `ACCEPT_COVERAGE_DEBT` acceptances)
 *   - post-coverage-comment.ts  (posts the coverage gate's comment)
 *   - post-main-report.ts       (reports a `main` run to its pull request)
 *   - coverage-report.ts and coverage-records.ts (name coverage metrics)
 *   - ci-lane.ts                (records the compile cache state)
 */

//
// Config (from environment)
//

export const REPO = Deno.env.get("GITHUB_REPOSITORY") ?? "commonfabric/labs";
export const TOKEN = Deno.env.get("GITHUB_TOKEN");
export const WORKFLOW_FILE = "deno.yml";

const COVERAGE_METRIC_PREFIX = "coverage-debt:";

/**
 * Hidden marker that opens the coverage gate's pull-request comment. It is
 * how the poster finds the one comment to update rather than posting
 * another.
 */
export const COVERAGE_SUGGESTION_MARKER = "<!-- coverage-debt-suggestion -->";

/**
 * The file the coverage gate writes its pending pull-request comment to.
 * The gate runs on `pull_request`, where a fork's pull request gets a
 * read-only token and cannot comment, so the file travels as the
 * `coverage-comment` artifact and the Pull Request Comments workflow posts
 * it from the base repository's context with a write token.
 */
export const COVERAGE_COMMENT_FILE = "coverage-comment.json";

/**
 * The pull-request comment the coverage gate hands to the poster. Either
 * body opens with {@link COVERAGE_SUGGESTION_MARKER}.
 */
export interface CoverageCommentPayload {
  /** The pull request the comment belongs to. */
  prNumber: number;

  /**
   * Whether the gate passed. A `regressed` body is posted, or replaces the
   * marked comment's body. A `resolved` body only ever replaces a marked
   * comment's body: a pull request the gate never failed is told nothing.
   */
  state: "regressed" | "resolved";

  /** The whole comment. */
  body: string;
}

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

/**
 * Whether a run's pattern compile byte cache was restored. Cold means the
 * cache missed entirely, which is a full recompile; warm covers both an
 * exact hit and a restore-key hit, since any hit implies the compiler
 * fingerprint is unchanged.
 */
export type CompileCacheState = "cold" | "warm";

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
function sleep(ms: number): Promise<void> {
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

/**
 * Helper for the GitHub client, which composes the error a refusal raises. A
 * limit says so in its message as well as in its type, because a caller that
 * treats every failure alike still logs the message, and a 403 read there
 * would otherwise pass for a permission failure.
 */
function githubApiError(
  resp: Response,
  path: string,
  method: "GET" | "POST" | "PATCH",
  body: string,
): Error {
  const statusText = resp.statusText ? ` ${resp.statusText}` : "";
  const rateLimited = isRateLimitResponse(resp, body);
  const message = `GitHub API ${method} ${resp.status}${statusText}${
    rateLimited ? " (rate limit)" : ""
  }: ${path}`;
  return rateLimited ? new GitHubRateLimitError(message) : new Error(message);
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
      // A limit is the one refusal this does not report as a missing
      // artifact: GitHub declining to answer says nothing about whether the
      // artifact is there.
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

//
// Coverage metric names
//

/** What separates a measured set's metric from a source group's. */
const MEASURED_SET_MARKER = "measured set ";

/** The source group one metric names, or null for anything else. */
export function coverageMetricGroupName(metric: string): string | null {
  const prefix = `${COVERAGE_METRIC_PREFIX} `;
  const suffix = " uncovered lines";
  if (!metric.startsWith(prefix) || !metric.endsWith(suffix)) return null;

  const name = metric.slice(prefix.length, -suffix.length);
  // A measured set's figure carries a member's name and is not a source
  // group. Whatever iterates the coverage metrics of a run sees both, and
  // reading one as the other would report the wrong number.
  return name.startsWith(MEASURED_SET_MARKER) ? null : name;
}

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

/**
 * Helper for {@link coverageGroupsForChangedFiles}, which names the source
 * group one changed file belongs to, or null for a file no group counts.
 */
function coverageGroupForChangedFile(filename: string): string | null {
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

//
// PR helpers
//

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

//
// Coverage acceptances
//

/**
 * Each `ACCEPT_COVERAGE_DEBT:` marker that starts a line, and the rest of that
 * line. An acceptance is written flush against the left margin, which is what
 * lets a description also talk about the mechanism: the marker named in a
 * sentence is prose, and an indented example of one is an example. Neither is
 * read as an acceptance, and neither is reported as a malformed one.
 */
const COVERAGE_ACCEPTANCE_MARKER = /^ACCEPT_COVERAGE_DEBT:[^\n]*/gm;

/** The name and the rise a well-formed acceptance gives. */
const COVERAGE_ACCEPTANCE_TERMS =
  /^ACCEPT_COVERAGE_DEBT:[ \t]*(\S+)[ \t]*\+[ \t]*(\d+)[ \t]*lines?\b/;

/**
 * What an acceptance may name: a path shaped like a workspace member. The
 * coverage gate scores a measured set over a member, which sits at whatever
 * depth the workspace puts it, so an acceptance has to be able to name
 * `packages/connectors/github/connector`.
 */
const COVERAGE_ACCEPTANCE_NAME =
  /^(?:[A-Za-z0-9._-]+|packages(?:\/[A-Za-z0-9._-]+)+)$/;

/**
 * Each `ACCEPT_COVERAGE_DEBT:` acceptance in a pull request's description, as
 * the name it gives against the lines it allows. The name is read as written;
 * which names mean anything is the reader's question.
 *
 * Throws on a marker it cannot read, and on two markers naming one thing,
 * since the author meant one number and would be given the other.
 */
export function acceptedCoverageDebt(body: string): Map<string, number> {
  const accepted = new Map<string, number>();
  for (const marker of body.match(COVERAGE_ACCEPTANCE_MARKER) ?? []) {
    const terms = COVERAGE_ACCEPTANCE_TERMS.exec(marker);
    if (terms === null) {
      throw new Error(
        `Invalid ACCEPT_COVERAGE_DEBT acceptance "${marker.trim()}": write it ` +
          "as `ACCEPT_COVERAGE_DEBT: <workspace member> +N " +
          "lines`, where N is how many lines above the baseline to allow the " +
          "rise.",
      );
    }
    const name = terms[1];
    if (!COVERAGE_ACCEPTANCE_NAME.test(name)) {
      throw new Error(
        `Invalid ACCEPT_COVERAGE_DEBT acceptance for "${name}": name a ` +
          "workspace member, such as `packages/runner` or " +
          "`packages/connectors/github/connector`.",
      );
    }
    const lines = parseInt(terms[2], 10);
    const already = accepted.get(name);
    if (already !== undefined) {
      throw new Error(
        `Two ACCEPT_COVERAGE_DEBT acceptances name "${name}", for ` +
          `${already} and ${lines} lines. Write one, for the whole rise ` +
          `you are accepting.`,
      );
    }
    accepted.set(name, lines);
  }
  return accepted;
}
