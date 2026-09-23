/**
 * Collects the helpers the tiles and the dashboard core share: the wrappers
 * that call the GitHub REST API and spend its rate-limit budget, the service
 * name a SigNoz query is scoped to, the small formatting routines that turn a
 * number or a span into the text a tile shows, and the sparkline and strip
 * drawing the tiles chart their history with.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";
import type { Run, Status } from "./types.ts";
import { PROD_SERVICE, REPO } from "./config.ts";
import {
  type GitHubPrimaryRateLimit,
  performanceGitHubRateLimit,
} from "./github-rate-limit.ts";
import {
  compactSpan,
  daysLabel,
  DURATION_LABEL_HEIGHT,
  durationTag,
  escapeHtml,
  groupDigits,
  humanDuration,
  humanSpan,
  SPARKLINE_HEIGHT,
  STATUS_DOT,
  STATUS_RANK,
  worstStatus,
} from "./tile-render-values.ts";

export {
  compactSpan,
  daysLabel,
  DURATION_LABEL_HEIGHT,
  durationTag,
  escapeHtml,
  groupDigits,
  humanDuration,
  humanSpan,
  SPARKLINE_HEIGHT,
  STATUS_DOT,
  STATUS_RANK,
  worstStatus,
};

// The service.name to scope a SigNoz query to. The name lands inside a query
// expression, so anything outside the shape a service name has falls back to the
// configured default rather than being interpolated.
export const serviceName = (env: (k: string) => string | undefined): string => {
  const s = env("PROD_SERVICE");
  return s && /^[A-Za-z0-9._-]+$/.test(s) ? s : PROD_SERVICE;
};

// Call the GitHub REST API and return parsed JSON. Pass an explicit `token` (e.g.
// a higher-privilege org-billing token); otherwise it reads GH_TOKEN or
// GITHUB_TOKEN from the environment. One of those must be set.
function githubToken(path: string, token?: string): string {
  const t = token ?? Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN");
  if (!t) throw new Error(`GitHub API ${path}: set GH_TOKEN or GITHUB_TOKEN`);
  return t;
}

type GitHubOperationStage =
  | "waiting for performance-request capacity"
  | "requesting GitHub"
  | "recording performance-request use"
  | "reading GitHub response";

interface ActiveGitHubOperation {
  id: number;
  path: string;
  startedAt: number;
  stage: GitHubOperationStage;
}

export interface GitHubOperationInProgress {
  id: number;
  path: string;
  elapsedMs: number;
  stage: GitHubOperationStage;
}

const activeGitHubOperations = new Map<number, ActiveGitHubOperation>();
let nextGitHubOperationId = 1;
const SLOW_GITHUB_OPERATION_MS = 10_000;
const GITHUB_ERROR_BODY_BYTES = 4_096;
const GITHUB_LOG_DETAIL_CHARS = 300;

export interface GitHubRequestOptions {
  // These expected HTTP responses stay quiet while transport failures still log.
  ignoreStatuses?: readonly number[];
}

export interface GitHubDownload {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Uint8Array<ArrayBuffer>;
}

export function githubOperationsInProgress(
  now = Date.now(),
): GitHubOperationInProgress[] {
  return [...activeGitHubOperations.values()].map((operation) => ({
    id: operation.id,
    path: operation.path,
    elapsedMs: Math.max(0, now - operation.startedAt),
    stage: operation.stage,
  }));
}

function boundedLogDetail(detail: string): string | undefined {
  const prefix = detail.slice(0, GITHUB_LOG_DETAIL_CHARS * 4);
  const withoutControls = [...prefix].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  }).join("");
  const compact = withoutControls.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, GITHUB_LOG_DETAIL_CHARS) : undefined;
}

function errorMessage(error: unknown): string {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return boundedLogDetail(detail) ?? "unknown error";
}

function githubResponseContext(response: Response): string {
  const parts = [`HTTP ${response.status}`];
  const header = (name: string): string | undefined => {
    const value = response.headers.get(name);
    return value === null ? undefined : boundedLogDetail(value);
  };
  const requestId = header("x-github-request-id");
  if (requestId) parts.push(`request ${requestId}`);
  const remaining = header("x-ratelimit-remaining");
  const limit = header("x-ratelimit-limit");
  if (remaining || limit) {
    parts.push(`rate limit ${remaining ?? "?"} remaining of ${limit ?? "?"}`);
  }
  const reset = header("x-ratelimit-reset");
  if (reset) parts.push(`rate limit resets at ${reset}`);
  const retryAfter = header("retry-after");
  if (retryAfter) parts.push(`retry after ${retryAfter}`);
  return parts.join(", ");
}

function githubErrorBody(body: string): string | undefined {
  let detail = body;
  try {
    const value: unknown = JSON.parse(body);
    if (
      isObjectOrArray(value) && "message" in value &&
      typeof value.message === "string"
    ) {
      detail = value.message;
    }
  } catch {
    // A plain-text GitHub error body is already the useful detail.
  }
  return boundedLogDetail(detail);
}

function finishGitHubOperation(
  operation: ActiveGitHubOperation,
  response: Response | undefined,
  failed: boolean,
): void {
  const elapsedMs = Math.max(0, Date.now() - operation.startedAt);
  activeGitHubOperations.delete(operation.id);
  if (!failed && response?.ok && elapsedMs >= SLOW_GITHUB_OPERATION_MS) {
    console.warn(
      `GitHub API operation ${operation.id} for ${operation.path} completed slowly after ` +
        `${elapsedMs} ms: ${githubResponseContext(response)}`,
    );
  }
}

function logGitHubOperationFailure(
  operation: ActiveGitHubOperation,
  error: unknown,
): void {
  console.error(
    `GitHub API operation ${operation.id} for ${operation.path} failed after ` +
      `${Math.max(0, Date.now() - operation.startedAt)} ms ` +
      `while ${operation.stage}: ${errorMessage(error)}`,
  );
}

function logGitHubErrorResponseFailure(
  response: Response,
  operation: ActiveGitHubOperation,
  action: string,
  error: unknown,
): void {
  console.error(
    "GitHub API operation " + operation.id + " for " + operation.path +
      " could not " + action + " the error response from " +
      githubResponseContext(response) + ": " + errorMessage(error),
  );
}

function discardGitHubErrorResponseBody(
  response: Response,
  operation: ActiveGitHubOperation,
): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch((error) => {
      logGitHubErrorResponseFailure(response, operation, "discard", error);
    });
  } catch (error) {
    logGitHubErrorResponseFailure(response, operation, "discard", error);
  }
}

async function githubErrorResponseBody(
  response: Response,
  operation: ActiveGitHubOperation,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const detail = (): string => {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  };
  if (!response.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    logGitHubErrorResponseFailure(response, operation, "read", error);
    return "";
  }
  const cancel = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch (error) {
      logGitHubErrorResponseFailure(response, operation, "stop reading", error);
    }
  };
  try {
    while (length < GITHUB_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) return detail();
      const remaining = GITHUB_ERROR_BODY_BYTES - length;
      const kept = value.slice(0, remaining);
      chunks.push(kept);
      length += kept.length;
    }
    await cancel();
    return detail();
  } catch (error) {
    logGitHubErrorResponseFailure(response, operation, "read", error);
    return detail();
  } finally {
    reader.releaseLock();
  }
}

interface GitHubResponseResult {
  response: Response;
  operation: ActiveGitHubOperation;
}

function githubRequest(path: string, token: string, withTimeout: boolean): Promise<Response> {
  const init: RequestInit = {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  };
  if (withTimeout) init.signal = AbortSignal.timeout(15_000);
  return fetch(
    `https://api.github.com/${path.replace(/^\//, "")}`,
    init,
  );
}

async function githubPrimaryRateLimit(
  token: string,
  operation: ActiveGitHubOperation,
): Promise<GitHubPrimaryRateLimit> {
  const response = await githubRequest("rate_limit", token, false);
  if (!response.ok) {
    discardGitHubErrorResponseBody(response, operation);
    throw new Error(
      `GitHub API rate_limit failed: ${githubResponseContext(response)}`,
    );
  }
  const value = await response.json() as {
    resources?: { core?: GitHubPrimaryRateLimit };
  };
  if (!value.resources?.core) {
    throw new Error("GitHub API rate_limit did not report the core budget");
  }
  return value.resources.core;
}

async function githubResponse(
  path: string,
  token: string,
  performance: boolean,
  withTimeout: boolean,
): Promise<GitHubResponseResult> {
  const normalizedPath = path.replace(/^\//, "");
  const operation: ActiveGitHubOperation = {
    id: nextGitHubOperationId++,
    path: normalizedPath,
    startedAt: Date.now(),
    stage: performance
      ? "waiting for performance-request capacity"
      : "requesting GitHub",
  };
  activeGitHubOperations.set(operation.id, operation);
  let reservation: Awaited<ReturnType<typeof performanceGitHubRateLimit.reserve>> | null = null;
  let response: Response | undefined;
  let failed = false;
  let operationError: unknown;
  try {
    if (performance) {
      reservation = await performanceGitHubRateLimit.reserve(
        token,
        () => githubPrimaryRateLimit(token, operation),
      );
      operation.stage = "requesting GitHub";
    }
    response = await githubRequest(path, token, withTimeout);
  } catch (error) {
    failed = true;
    operationError = error;
    logGitHubOperationFailure(operation, error);
  }
  try {
    if (reservation) {
      operation.stage = "recording performance-request use";
      await reservation.complete(response);
    }
  } catch (error) {
    failed = true;
    operationError = error;
    logGitHubOperationFailure(operation, error);
  }
  if (failed) {
    finishGitHubOperation(operation, response, true);
    throw operationError;
  }
  operation.stage = "reading GitHub response";
  return { response: response!, operation };
}

async function githubJson<T>(
  path: string,
  token: string,
  performance: boolean,
  options: GitHubRequestOptions,
): Promise<T> {
  const { response: res, operation } = await githubResponse(
    path,
    token,
    performance,
    true,
  );
  if (!res.ok) {
    const reportHttpError = !options.ignoreStatuses?.includes(res.status);
    const body = await githubErrorResponseBody(
      res,
      operation,
    );
    let rateLimited = false;
    if (res.status === 403) {
      rateLimited = res.headers.get("x-ratelimit-remaining") === "0" ||
        res.headers.has("retry-after") || /rate.?limit/i.test(body);
    }
    const detail = rateLimited ? " (rate-limited)" : "";
    const responseDetail = githubErrorBody(body);
    if (reportHttpError) {
      console.error(
        `GitHub API operation ${operation.id} for ${operation.path} returned ` +
          `${githubResponseContext(res)} after ` +
          `${Math.max(0, Date.now() - operation.startedAt)} ms` +
          `${responseDetail ? `: ${responseDetail}` : ""}`,
      );
    }
    finishGitHubOperation(operation, res, true);
    throw new Error(
      `GitHub API ${path} failed: HTTP ${res.status}${detail}`,
    );
  }
  try {
    const value = await res.json() as T;
    finishGitHubOperation(operation, res, false);
    return value;
  } catch (error) {
    console.error(
      `GitHub API operation ${operation.id} for ${operation.path} could not read valid JSON ` +
        `from ${githubResponseContext(res)} after ` +
        `${Math.max(0, Date.now() - operation.startedAt)} ms: ${errorMessage(error)}`,
    );
    finishGitHubOperation(operation, res, true);
    throw error;
  }
}

export async function github<T = unknown>(
  path: string,
  token?: string,
  options: GitHubRequestOptions = {},
): Promise<T> {
  const t = githubToken(path, token);
  return await githubJson<T>(path, t, false, options);
}

export async function githubDownload(
  path: string,
  token?: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubDownload> {
  const t = githubToken(path, token);
  return await githubDownloadResponse(
    path,
    t,
    false,
    options,
  );
}

export async function performanceGithub<T = unknown>(
  path: string,
  token?: string,
  options: GitHubRequestOptions = {},
): Promise<T> {
  const t = githubToken(path, token);
  return await githubJson<T>(path, t, true, options);
}

export async function performanceGithubDownload(
  path: string,
  token?: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubDownload> {
  const t = githubToken(path, token);
  return await githubDownloadResponse(
    path,
    t,
    true,
    options,
  );
}

async function githubDownloadResponse(
  path: string,
  token: string,
  performance: boolean,
  options: GitHubRequestOptions,
): Promise<GitHubDownload> {
  const { response, operation } = await githubResponse(
    path,
    token,
    performance,
    false,
  );
  if (!response.ok) {
    const reportHttpError = !options.ignoreStatuses?.includes(response.status);
    discardGitHubErrorResponseBody(response, operation);
    if (reportHttpError) {
      console.error(
        `GitHub API operation ${operation.id} for download ${operation.path} returned ` +
          `${githubResponseContext(response)} after ` +
          `${Math.max(0, Date.now() - operation.startedAt)} ms`,
      );
    }
    finishGitHubOperation(operation, response, true);
    return { ok: false, status: response.status, body: new Uint8Array() };
  }
  if (!response.body) {
    finishGitHubOperation(operation, response, false);
    return { ok: true, status: response.status, body: new Uint8Array() };
  }
  try {
    const body = new Uint8Array(await response.arrayBuffer());
    finishGitHubOperation(operation, response, false);
    return { ok: true, status: response.status, body };
  } catch (error) {
    logGitHubOperationFailure(operation, error);
    finishGitHubOperation(operation, response, true);
    throw error;
  }
}

/** The GitHub JSON call a collection makes, so a test can supply its own. */
export interface GitHubJson {
  json<T>(path: string, token: string): Promise<T>;
}

/**
 * The id of the newest unexpired artifact of `runId` named `name`, or
 * `undefined` where the run has none.
 *
 * The listing filters on the name, so the answer holds the artifacts of that
 * name alone rather than the hundred and more a run of the test workflow
 * uploads in total. Artifact ids are monotonic, so the newest of them is the
 * highest: re-running one job uploads a second artifact under the name that
 * job uploads, beside the original attempt's.
 */
export async function runArtifactId(options: {
  github: GitHubJson;
  runId: number;
  name: string;
  token: string;
}): Promise<number | undefined> {
  const { github, runId, name, token } = options;
  const params = new URLSearchParams({ name, per_page: "100" });
  const listed = await github.json<{
    artifacts?: { id: number; name: string; expired: boolean }[];
  }>(`repos/${REPO}/actions/runs/${runId}/artifacts?${params}`, token);
  const ids = (listed.artifacts ?? [])
    .filter((artifact) => artifact.name === name && !artifact.expired)
    .map((artifact) => artifact.id);
  return ids.length === 0 ? undefined : Math.max(...ids);
}

// Cache an async result for ttlMs; a rejection is not cached (so it retries).
export function memo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0;
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached || Date.now() - at > ttlMs) {
      at = Date.now();
      cached = fn().catch((e) => {
        cached = null;
        throw e;
      });
    }
    return cached;
  };
}

export function humanDur(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function clampInt(v: string | null, def: number, lo: number, hi: number): number {
  if (v === null || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// Turn a raw collector error into a short, calm tile message. The full error is
// still logged; the dashboard shows a human phrase, not a stack trace or API
// path.
export function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (/connect|sending request|network|dns|refused|unreachable|timed ?out|timeout|econn/.test(m)) {
    return "source unreachable";
  }
  if (/rate.?limit|\b429\b/.test(m)) return "rate limit hit";
  if (/\b404\b|not found/.test(m)) return "not found";
  if (/\b401\b|\b403\b|unauthor|forbidden|bad credentials/.test(m)) return "auth failed";
  if (/gh_token|github_token/.test(m)) return "set GH_TOKEN";
  return "temporarily unavailable";
}

// Spend against a budget, matching the cloud-spend thresholds: at or under budget
// is good, up to 25% over is a warning, beyond that is bad. An unset or invalid
// budget (NaN) never alarms.
export function budgetStatus(cost: number, budget: number): Status {
  if (!Number.isFinite(budget)) return "good";
  return cost <= budget ? "good" : cost <= budget * 1.25 ? "warn" : "bad";
}

// Parse an optional numeric budget/quota from an env string; blank or unset -> NaN.
export function readBudget(raw: string | undefined): number {
  return raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
}

// A USD amount as a short string: whole dollars, or cents when it is under a
// dollar (so 0.45 -> "45¢"), and "$0" when it rounds away entirely.
export function usd(n: number): string {
  const cents = Math.round(n * 100);
  if (cents === 0) return "$0";
  if (Math.abs(cents) < 100) return `${cents}¢`;
  return `$${Math.round(n)}`;
}

/**
 * How long a completed run ran, in milliseconds, or nothing at all when it is
 * still running or its two timestamps do not describe a span.
 */
export function runDurationMs(run: Run): number | undefined {
  if (run.status !== "completed") return undefined;
  const start = Date.parse(run.run_started_at);
  const end = Date.parse(run.updated_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return undefined;
  }
  return end - start;
}

// A completed run's dot color: only genuine failures are red.
export function concDot(conclusion: string | null, attempt: number): string {
  if (conclusion === "success") return attempt > 1 ? "gray" : "green";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") return "red";
  return "gray";
}

// A lighter tint of a "#rrggbb" color, blended toward white. Sparklines mark the
// slice feeding the headline by redrawing it in a lighter version of the line's
// own color, so a multi-color chart can highlight without losing which line is
// which. Anything that is not a hex color is returned unchanged.
export function lighten(hex: string, amount = 0.6): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)];
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function scaleValues(
  vals: number[],
  scale: { trim?: number; minValues?: number } | undefined,
): number[] {
  const count = Math.max(0, Math.floor(scale?.trim ?? 0));
  const minimum = Math.max(count * 2 + 2, scale?.minValues ?? 0);
  if (count === 0 || vals.length < minimum) return vals;
  return [...vals].sort((a, b) => a - b).slice(count, -count);
}

// A trend line from a numeric series (oldest -> newest). With `highlight`, the
// trailing `count` points are overdrawn in a second color (e.g. to pick out the
// most recent runs against a longer trend). The vertical scale is normalized to
// those recent points' range plus 25% headroom, so older outliers clip off the
// edges instead of flattening the recent detail into a useless line. `fade`
// makes the base line a horizontal gradient from transparent on the far left up
// to `color` by the tile's midpoint. `xs` gives each point's horizontal
// position as a fraction 0..1 of the width (for placing several sparklines on
// one shared axis — e.g. a real time axis); a series that doesn't reach the
// ends occupies only part of the width. Without it, points are spaced evenly.
// The line has no label of its own. A tile's `duration` slot draws the span in
// the corner. `scale.trim`
// excludes that many values from each end of the sorted scale inputs without
// removing the points themselves. A series below `scale.minValues`, or too short
// to leave two scale values, keeps its full range.
export function sparkline(
  vals: number[],
  color: string,
  highlight?: { count: number; color: string; scaleAll?: boolean },
  fade = false,
  xs?: number[],
  scale?: { trim?: number; minValues?: number },
): string {
  if (vals.length < 2) return "";
  const w = 220, h = 26;
  // Scale to the highlighted tail (recent) by default; scaleAll keeps the full
  // series in view while still brightening the tail (for series whose recent
  // window can sit far from the historical range, e.g. a near-zero error rate).
  const recent = highlight && !highlight.scaleAll ? vals.slice(-highlight.count) : vals;
  const scaled = scaleValues(recent, scale);
  const lo = Math.min(...scaled), hi = Math.max(...scaled);
  const pad = (hi - lo) * 0.125 || 0.5; // 12.5% each side ≈ +25% range; a floor for a flat series
  const min = lo - pad, rng = (hi + pad) - min;
  // Place each point at its `xs` fraction of the width (shared axis), else evenly.
  const xAt = (i: number) => (xs ? xs[i] : i / (vals.length - 1)) * w;
  const pts = vals.map((v, i) =>
    `${xAt(i).toFixed(1)},${(h - 3 - ((v - min) / rng) * (h - 6)).toFixed(1)}`
  );
  // The base line fades from transparent on the far left to `color`, then holds
  // `color` (SVG extends the last stop). userSpaceOnUse keeps the transition at
  // the same screen x when `xs` places the line on only part of the chart.
  let defs = "", baseStroke = color;
  if (fade) {
    // Reach `color` by the tile's midpoint — or sooner, if the highlight starts
    // before halfway (so the base is fully `color` before the handoff).
    const edge = highlight && highlight.count >= 2 && highlight.count < vals.length
      ? Math.max(
        0,
        Math.min(
          1,
          xs?.length === vals.length
            ? xs[vals.length - highlight.count]
            : (vals.length - highlight.count) / (vals.length - 1),
        ),
      )
      : 1;
    const tf = Math.min(0.5, edge);
    if (tf > 0) {
      const id = `spk-${
        color.replace(/[^0-9a-fA-F]/g, "")
      }-${Math.round(tf * 100)}`;
      defs = `<defs><linearGradient id="${id}" ` +
        `gradientUnits="userSpaceOnUse" x1="0" y1="0" ` +
        `x2="${w}" y2="0">` +
        `<stop offset="0" stop-color="${color}" stop-opacity="0"/>` +
        `<stop offset="${tf.toFixed(3)}" stop-color="${color}" ` +
        `stop-opacity="1"/>` +
        `</linearGradient></defs>`;
      baseStroke = `url(#${id})`;
    }
  }
  const lines = [`<polyline points="${pts.join(" ")}" fill="none" stroke="${baseStroke}" stroke-width="2"/>`];
  // A tail covering the whole series marks nothing off, and would repaint the
  // line in the highlight color, so the base is left to stand on its own.
  if (highlight && highlight.count >= 2 && highlight.count < vals.length) {
    const tail = pts.slice(vals.length - highlight.count);
    lines.push(`<polyline points="${tail.join(" ")}" fill="none" stroke="${highlight.color}" stroke-width="2"/>`);
  }
  // The svg is a block, so the chart's box is the height it draws: an inline svg
  // sits on a text baseline, and the line box around it reserves descender space
  // underneath.
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${SPARKLINE_HEIGHT}" preserveAspectRatio="none" style="display:block;margin-top:9px">${defs}${lines.join("")}</svg>`;
}

// Overlaid trend lines (each oldest -> newest) sharing one vertical scale, each
// in its own color. With a per-series `label`, that series' value is placed in a
// right-hand gutter at the line's end height, in the line color. With
// `opts.fade`, each line fades from transparent on the far left up to its own
// color, reaching full opacity by the midpoint (or by the start of the
// highlight, if that comes sooner) — like the ci-duration sparkline. The `xs`
// field positions points on a shared horizontal axis. The `highlightCount`
// field redraws trailing points, including explicit markers, in a lighter tint.
// `opts.highlight` supplies the count for series that do not set one. `maxXGap`
// breaks a path when adjacent horizontal positions are farther apart than that
// fraction of the chart. `showSinglePoint` draws explicit markers for a
// one-sample series and for points isolated by those breaks. All overlays are
// HTML or gradients, so preserveAspectRatio="none" cannot distort them. The
// span it covers is drawn separately by a tile's `duration` slot. `opts.scale`
// has the same trimming behavior as `sparkline`.
export function multiSparkline(
  series: {
    vals: number[];
    color: string;
    highlightColor?: string;
    label?: string;
    xs?: number[];
    highlightCount?: number;
    maxXGap?: number;
    showSinglePoint?: boolean;
  }[],
  opts: {
    fade?: boolean;
    highlight?: { count: number };
    scale?: { trim?: number; minValues?: number };
  } = {},
): string {
  const drawable = series.filter((line) =>
    line.vals.length >= 2 ||
    (line.showSinglePoint === true && line.vals.length === 1)
  );
  const all = drawable.flatMap((line) => line.vals);
  if (!all.length) return "";
  const scaled = scaleValues(all, opts.scale);
  const lo = Math.min(...scaled), hi = Math.max(...scaled);
  // Match sparkline's centered flat range when trimming leaves two equal values.
  const pad = scaled === all || lo !== hi ? 0 : 0.5;
  const w = 220, h = 34, min = lo - pad, max = hi + pad, rng = (max - min) || 1;
  const yv = (v: number) => h - 3 - ((v - min) / rng) * (h - 6);

  // Each line fades from transparent on the left up to its own color, reaching
  // full opacity at the handoff `tf`: the midpoint, or the start of the
  // highlight when that comes sooner (so the base is solid before the handoff).
  // userSpaceOnUse keeps the transition at the same screen x for every line and
  // avoids the zero-bbox quirk when a line is flat.
  const defs: string[] = [];
  const highlightCount = (
    line: (typeof series)[number],
  ): number => line.highlightCount ?? opts.highlight?.count ?? 0;
  const highlightEdge = (line: (typeof series)[number]): number => {
    const count = highlightCount(line);
    if (count < 2) return 1;
    if (count >= line.vals.length) return 1;
    const index = line.vals.length - count;
    return line.xs?.length === line.vals.length
      ? line.xs[index]
      : index / (line.vals.length - 1);
  };
  const strokeFor = (line: (typeof series)[number]): string => {
    const color = line.color;
    if (!opts.fade) return color;
    const tf = Math.min(0.5, Math.max(0, highlightEdge(line)));
    const off = String(+tf.toFixed(3));
    const id = `mspk-${
      color.replace(/[^0-9a-fA-F]/g, "")
    }-${Math.round(tf * 100)}`;
    if (!defs.some((d) => d.includes(`"${id}"`))) {
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">` +
          `<stop offset="0" stop-color="${color}" stop-opacity="0"/>` +
          `<stop offset="${off}" stop-color="${color}" stop-opacity="1"/>` +
          `</linearGradient>`,
      );
    }
    return `url(#${id})`;
  };
  const highlightStartIndex = (
    line: (typeof series)[number],
    pointCount: number,
  ): number | undefined => {
    const count = Math.min(highlightCount(line), pointCount);
    return count >= 2 && count < pointCount ? pointCount - count : undefined;
  };
  type SparkPoint = { index: number; x: number; px: number; py: number };
  const splitPoints = (
    points: SparkPoint[],
    maxXGap: number | undefined,
  ): SparkPoint[][] => {
    const segments: SparkPoint[][] = [];
    for (const point of points) {
      const current = segments[segments.length - 1];
      const previous = current?.[current.length - 1];
      const tolerance = maxXGap === undefined || previous === undefined
        ? 0
        : Number.EPSILON * 4 *
          Math.max(
            1,
            Math.abs(point.x),
            Math.abs(previous.x),
            Math.abs(maxXGap),
          );
      if (
        previous === undefined ||
        (maxXGap !== undefined &&
          Math.abs(point.x - previous.x) > maxXGap + tolerance)
      ) {
        segments.push([point]);
      } else {
        current.push(point);
      }
    }
    return segments;
  };
  const svgPoint = (point: SparkPoint) =>
    `${point.px.toFixed(1)},${point.py.toFixed(1)}`;
  const poly = (pts: string[], stroke: string) =>
    `<polyline points="${pts.join(" ")}" fill="none" stroke="${stroke}" stroke-width="2"/>`;
  const marker = (point: SparkPoint, color: string) =>
    `<circle cx="${point.px.toFixed(1)}" cy="${
      point.py.toFixed(1)
    }" r="1.0" fill="${escapeHtml(color)}"/>`;
  const drawn = drawable.filter((s) => s.vals.length >= 2).map((s) => {
    const points = s.vals.map((v, i) => {
      const x = s.xs?.length === s.vals.length
        ? s.xs[i]
        : i / (s.vals.length - 1);
      return { index: i, x, px: x * w, py: yv(v) };
    });
    return {
      s,
      points,
      segments: splitPoints(points, s.maxXGap),
    };
  });
  // Every base first, then every tint, so a line drawn later cannot paint over an
  // earlier line's tint where the two cross inside the highlighted slice.
  const bases = drawn.map(({ s, segments }) => {
    const paths = segments.filter((segment) => segment.length >= 2);
    if (!paths.length) return "";
    const stroke = strokeFor(s);
    return paths.map((path) => poly(path.map(svgPoint), stroke)).join("");
  }).join("");
  // The trailing slice, redrawn in a lighter tint of each line's own color. A
  // slice covering the whole line marks nothing off, so it is left alone.
  const tints = drawn.map(({ s, points }) => {
    const start = highlightStartIndex(s, points.length);
    if (start === undefined) return "";
    return splitPoints(points.slice(start), s.maxXGap)
      .filter((segment) => segment.length >= 2)
      .map((segment) =>
        poly(segment.map(svgPoint), s.highlightColor ?? lighten(s.color))
      )
      .join("");
  }).join("");
  const isolatedMarkers = drawn.map(({ s, points, segments }) => {
    if (!s.showSinglePoint) return "";
    const highlightStart = highlightStartIndex(s, points.length);
    return segments
      .filter((segment) => segment.length === 1)
      .map((segment) => {
        const point = segment[0];
        const color = highlightStart !== undefined &&
            point.index >= highlightStart
          ? s.highlightColor ?? lighten(s.color)
          : s.color;
        return marker(point, color);
      })
      .join("");
  }).join("");
  const singleSeriesMarkers = drawable
    .filter((s) => s.vals.length === 1)
    .map((s) => {
      const x = s.xs?.length === 1 ? s.xs[0] : 0.5;
      return marker({ index: 0, x, px: x * w, py: yv(s.vals[0]) }, s.color);
    })
    .join("");
  const lines = bases + tints + isolatedMarkers + singleSeriesMarkers;
  const defsBlock = defs.length ? `<defs>${defs.join("")}</defs>` : "";

  const labeled = drawable.filter((s) => s.label !== undefined);
  if (labeled.length === 0) {
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${SPARKLINE_HEIGHT}" preserveAspectRatio="none" style="display:block;margin-top:9px">${defsBlock}${lines}</svg>`;
  }
  const RH = SPARKLINE_HEIGHT;
  const LABEL_INSET = 6;
  const LABEL_GAP = 12;
  const labelEdge = RH - LABEL_INSET;
  // Each label sits at its line's end height; when a chart is drawn its value
  // appears only here. Sort the labels by height and spread close labels apart.
  // A crowded chart divides the available band evenly between every label.
  const placed = labeled
    .map((s) => ({ s, py: Math.max(LABEL_INSET, Math.min(labelEdge, (yv(s.vals[s.vals.length - 1]) / h) * RH)) }))
    .sort((a, b) => a.py - b.py);
  const gap = placed.length > 1
    ? Math.min(LABEL_GAP, (labelEdge - LABEL_INSET) / (placed.length - 1))
    : 0;
  for (let i = 1; i < placed.length; i++) {
    placed[i].py = Math.max(placed[i].py, placed[i - 1].py + gap);
  }
  if (placed[placed.length - 1].py > labelEdge) {
    placed[placed.length - 1].py = labelEdge;
    for (let i = placed.length - 2; i >= 0; i--) {
      placed[i].py = Math.min(placed[i].py, placed[i + 1].py - gap);
    }
  }
  const tags = placed.map(({ s, py }) =>
    `<span style="position:absolute;right:0;top:${py.toFixed(1)}px;transform:translateY(-50%);font-size:11px;line-height:1;color:${s.color};font-variant-numeric:tabular-nums;pointer-events:none">${escapeHtml(s.label!)}</span>`
  ).join("");
  const svgWidth = labeled.length ? "calc(100% - 24px)" : "100%";
  const svg = `<svg viewBox="0 0 ${w} ${h}" width="${svgWidth}" height="${RH}" preserveAspectRatio="none" style="display:block">${defsBlock}${lines}</svg>`;
  return `<div style="position:relative;margin-top:9px;height:${RH}px">${svg}${tags}</div>`;
}

// The middle of a series. An even count has no single middle sample, so it is
// the mean of the two: taking the upper one alone reports a value no sample
// had, and always the higher of the pair. The input is copied before sorting,
// so a caller's array keeps its own order.
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Inflate raw-deflate bytes (the compression zip uses) to their decompressed form.
async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const collected = new Response(ds.readable).arrayBuffer(); // read as we write
  const writer = ds.writable.getWriter();
  await writer.write(data);
  await writer.close();
  return new Uint8Array(await collected);
}

// Extract the first *.json file from a zip via its central directory (which holds
// the true sizes even when a streamed zip leaves them out of the local headers).
// A GitHub artifact download is one of these.
export async function jsonFromZip(
  buf: Uint8Array<ArrayBuffer>,
): Promise<string | null> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let p = u32(eocd + 16); // central directory offset
  const count = u16(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (u32(p) !== 0x02014b50) break; // central-directory file header signature
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const nameLen = u16(p + 28),
      extraLen = u16(p + 30),
      commentLen = u16(p + 32);
    const lho = u32(p + 42); // local header offset
    const name = new TextDecoder().decode(
      buf.subarray(p + 46, p + 46 + nameLen),
    );
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith(".json")) continue;
    if (u32(lho) !== 0x04034b50) return null; // local file header signature
    const dataStart = lho + 30 + u16(lho + 26) + u16(lho + 28);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const bytes = method === 0
      ? comp
      : method === 8
      ? await inflateRaw(comp)
      : null;
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
  return null;
}

// Evenly thin an array to at most `max` items, keeping the first and last.
export function thin<T>(arr: T[], max: number): T[] {
  if (max < 2 || arr.length <= max) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

// A grid of small run-outcome cells (one per run, oldest first) laid out in
// responsive columns. Each cell links to that run's CI results.
export function strip(
  cells: { outcome: string; href: string }[],
  labelSpace = false,
): string {
  if (!cells.length) return "";
  const col = (d: string) =>
    d === "green"
      ? "var(--status-good)"
      : d === "red"
      ? "var(--status-bad)"
      : d === "run"
      ? "var(--running)"
      : "var(--status-unknown)";
  const html = cells.map((c) =>
    `<a class="cell" href="${escapeHtml(c.href)}" target="_blank" rel="noopener" style="background:${col(c.outcome)}"></a>`
  ).join("");
  const className = labelSpace ? "cells labeled" : "cells";
  return `<div class="${className}">${html}</div>`;
}

// The PR that landed a commit: squash titles end "(#123)", merge commits start
// "Merge pull request #123". Parses the full message first line; falls back to
// the commit page so a mid-message "#456" never mislinks.
export function landingHref(message: string, sha: string, repo: string): string {
  const first = message.split("\n", 1)[0];
  const pr = first.match(/\(#(\d+)\)\s*$/)?.[1] ?? first.match(/^Merge pull request #(\d+)/)?.[1];
  return pr ? `https://github.com/${repo}/pull/${pr}` : `https://github.com/${repo}/commit/${sha}`;
}
