/**
 * Charts the historical wall-clock duration of every job in the labs and loom
 * CI workflows. The page samples successful main runs, persists each completed
 * attempt's jobs, and uses the same trailing-parenthesis grouping as
 * scripts/ci-gantt.ts.
 */

import {
  type CachedCiGanttJob,
  type CachedCiRun,
  type CachedCiRunReference,
  CI_JOB_HISTORY_SAMPLING_VERSION,
  CiJobHistoryStore,
  ganttRunSummary,
  isDrawableGanttJob,
} from "./ci-job-cache.ts";
import { CiGanttDetailStore, ganttDetailDirectory } from "./ci-gantt-detail.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "./config.ts";
import {
  clampInt,
  durationTag,
  escapeHtml,
  friendlyError,
  github,
  performanceGithub,
  sparkline,
  STALE_RUNS_ERROR,
} from "./lib.ts";
import { GitHubRateLimitBudgetError } from "./github-rate-limit.ts";
import {
  distinctTrendDays,
  trendPct,
  trendPctLabel,
  trendStatus,
} from "./trend.ts";
import {
  PERFORMANCE_CHECK_MS,
  PERFORMANCE_HISTORY_SCALE_MIN_VALUES,
  PERFORMANCE_HISTORY_SCALE_TRIM,
  PERFORMANCE_VIEW_STYLES,
  performanceViewNav,
} from "./performance-views.ts";
import {
  CHART_LINE,
  DASHBOARD_THEME_CLIENT,
  DASHBOARD_THEME_HEAD,
  dashboardThemeToggle,
} from "./theme.ts";

export const CI_HISTORY_DAYS = 45;
export const CI_HISTORY_MIN_DAYS = 1;
export const CI_HISTORY_POINT_TARGET = 200;

const DAY_MS = 86_400_000;
const JOBS_PER_PAGE = 100;
const JOB_FETCH_CONCURRENCY = 8;
const REFRESH_MS = 30 * 60_000;
const GITHUB_SEARCH_LIMIT = 1_000;
export const GANTT_MAX_RUNS = 150;
const SELECTED_WORKFLOW_RUN_CACHE_MAX = GANTT_MAX_RUNS;
export const PROGRESS_RECORD_MAX = 256;
// Built snapshots are kept per repository and window width, and the window
// width comes from the page's URL, so the set of keys is as wide as the range
// slider. A snapshot holds a point for every job in every sampled run, and it
// is rebuilt from the run index without touching GitHub, so only a handful are
// worth keeping.
export const SNAPSHOT_CACHE_MAX = 8;

type GitHubRequest = <T = unknown>(
  path: string,
  token?: string,
) => Promise<T>;

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch?: string | null;
  head_sha?: string;
  path?: string;
  run_attempt: number;
  run_started_at: string;
  html_url: string;
  name?: string;
}

interface ApiStep {
  name: string;
  number: number;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface ApiJob {
  name: string;
  status?: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: ApiStep[];
}

export interface CiGanttInputRun {
  run: {
    attempt: number;
    databaseId: number;
    status: string;
    conclusion: string;
    event: string;
    headBranch?: string;
    startedAt: string;
    workflowName?: string;
  };
  jobs: CachedCiGanttJob[];
}

export interface CiGanttInput {
  runs: CiGanttInputRun[];
}

export interface CiGanttOptions {
  limit: number;
  mainOnly: boolean;
  allConclusions?: boolean;
  selectedRuns?: CiGanttRunSelection[];
  headSha?: string;
}

export interface CiGanttRunSelection {
  runId: number;
  runAttempt: number;
}

export interface CiGanttRefresh {
  progress: CiJobFetchProgress;
  result: Promise<GanttSelection>;
}

export interface CiTimedJob {
  name: string;
  seconds: number;
}

export interface CiHistorySample {
  runId: number;
  runUrl: string;
  at: number;
  overallSeconds?: number;
  jobs: CiTimedJob[];
}

export interface CiJobPoint {
  at: number;
  seconds: number;
  runId: number;
  runUrl: string;
}

export interface CiJobSeries {
  kind: "job" | "group" | "overall";
  name: string;
  base: string;
  points: CiJobPoint[];
}

export interface CiShardGroup {
  base: string;
  maxConcurrent: number;
  aggregate: CiJobSeries;
  shards: CiJobSeries[];
}

export interface CiJobHistorySnapshot {
  runCount: number;
  successfulRunTimes: number[] | null;
  failedRunCount: number;
  failedRunTimes: number[];
  stale: boolean;
  axisStart: number;
  axisEnd: number;
  overall: CiJobSeries | null;
  groups: CiShardGroup[];
  jobs: CiJobSeries[];
}

export type CiJobFetchPhase =
  | "discovering"
  | "fetching"
  | "saving"
  | "complete"
  | "error";

export interface CiJobFetchProgress {
  id: string;
  source: CiHistorySourceKey;
  days: number;
  phase: CiJobFetchPhase;
  discoveryRequestsMade: number;
  discoveryResponsesReceived: number;
  discoveryOutstandingRequests: number;
  totalRuns: number;
  cachedRuns: number;
  requestsMade: number;
  responsesReceived: number;
  sharedRequests: number;
  sharedResponses: number;
  successfulResponses: number;
  failedResponses: number;
  completedRuns: number;
  queuedRuns: number;
  outstandingRequests: number;
  needsReload: boolean;
  updatedAt: number;
  error?: string;
  warning?: string;
}

export interface CiJobRefresh {
  progress: CiJobFetchProgress | null;
  result: Promise<CiJobHistorySnapshot>;
}

type CiJobProgressListener = (progress: CiJobFetchProgress) => void;

interface CiJobProgressRecord {
  state: CiJobFetchProgress;
  listeners: Set<CiJobProgressListener>;
  baselines: Set<string>;
}

interface CiWorkflowDiscovery<Result = WorkflowRun[]> {
  progresses: Set<CiJobProgressRecord>;
  requestsMade: number;
  responsesReceived: number;
  result: Promise<Result>;
}

interface SelectedWorkflowRuns {
  runs: WorkflowRun[];
  failure?: { error: unknown };
}

interface CiGanttRequest {
  progress: CiJobProgressRecord;
  result: Promise<GanttSelection>;
}

// The runs one chart is made of. Their step detail stays on disk until each run
// is handed to whatever is drawing or writing the chart.
export interface GanttSelection {
  entries: CachedCiRun[];
  exactSelection: boolean;
}

type CiJobFetchOutcome =
  | { run: WorkflowRun; entry: CachedCiRun }
  | { run: WorkflowRun; error: unknown; persistence: boolean };

interface CiJobLoad {
  kind: "cached" | "joined" | "requested";
  result: Promise<CachedCiRun>;
}

class CiJobCacheWriteError extends Error {
  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`Could not persist CI job history: ${message}`, { cause: error });
    this.name = "CiJobCacheWriteError";
  }
}

export type CiHistorySourceKey = "labs" | "loom";

export interface CiHistorySource {
  key: CiHistorySourceKey;
  label: string;
  repo: string;
  workflow: string;
}

export const CI_HISTORY_SOURCES: Record<CiHistorySourceKey, CiHistorySource> = {
  labs: { key: "labs", label: "labs", repo: REPO, workflow: CI_WORKFLOW },
  loom: {
    key: "loom",
    label: "loom",
    repo: LOOM_REPO,
    workflow: LOOM_CI_WORKFLOW,
  },
};

export function baseJobName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "");
}

function shardKey(name: string): string {
  const fraction = name.match(/\((\d+)\/(\d+)\)/);
  if (fraction) return String(Number(fraction[1])).padStart(4, "0");
  const suffix = name.match(/\(([^)]*)\)\s*$/);
  return suffix ? suffix[1] : "";
}

function runTime(run: WorkflowRun): number {
  return Date.parse(run.run_started_at);
}

// Runs `work` over every item with at most `limit` of them outstanding, taking
// the next item the moment any one finishes, so a slow response costs only its
// own slot. For a GitHub read, waiting is nearly all of the time spent.
//
// Results keep the order of `items`. `work` is expected to report its own
// failures in its result rather than rejecting; a rejection stops the run and
// is raised once the outstanding work has finished. `halt` is consulted before
// each item is taken, so a failure that makes the rest pointless — the cache
// refusing writes — stops the remaining items from being started at all.
async function inFlight<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
  halt?: (result: R) => boolean,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = next++;
      if (index >= items.length) return;
      const result = await work(items[index]);
      results[index] = result;
      if (halt?.(result)) stopped = true;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  // Slots that halted before taking an item leave holes rather than undefined
  // results the caller would have to guard.
  return results.slice(0, Math.min(next, items.length)).filter((result) =>
    result !== undefined
  );
}

// GitHub answers a workflow-run query with far more than a run: the repository,
// the head repository, the whole head commit, and both actors travel with every
// entry, which is around 18 KB where the fields below are 330 bytes. A
// discovery window is thousands of runs held for the length of the freshness
// window, so each one is narrowed to these fields as it arrives.
export function projectWorkflowRun(run: WorkflowRun): WorkflowRun {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    path: run.path,
    run_attempt: run.run_attempt,
    run_started_at: run.run_started_at,
    html_url: run.html_url,
    name: run.name,
  };
}

function validateSelectedWorkflowRun(
  run: WorkflowRun,
  selected: CiGanttRunSelection,
  source: CiHistorySource,
  headSha: string,
): WorkflowRun {
  const workflowPath = run.path?.split("@", 1)[0];
  const expectedWorkflowPath = `.github/workflows/${source.workflow}`;
  if (
    run.id !== selected.runId || run.run_attempt !== selected.runAttempt ||
    run.head_sha?.toLowerCase() !== headSha ||
    workflowPath !== expectedWorkflowPath
  ) {
    throw new Error(
      `Selected CI run ${selected.runId} attempt ${selected.runAttempt} does not match the requested commit and workflow.`,
    );
  }
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    path: run.path,
    run_attempt: run.run_attempt,
    run_started_at: run.run_started_at,
    html_url: run.html_url,
    name: run.name,
  };
}

export function ciHistoryDays(value: string | null): number {
  return clampInt(
    value,
    CI_HISTORY_DAYS,
    CI_HISTORY_MIN_DAYS,
    CI_HISTORY_DAYS,
  );
}

export function ciHistorySource(value: string | null): CiHistorySource {
  return value === "loom" ? CI_HISTORY_SOURCES.loom : CI_HISTORY_SOURCES.labs;
}

export function ciGanttOptions(
  parameters: URLSearchParams,
): CiGanttOptions {
  const selectedRuns = parameters.getAll("run").flatMap((value) => {
    const match = value.match(/^(\d+):(\d+)$/);
    if (!match) return [];
    const runId = Number(match[1]);
    const runAttempt = Number(match[2]);
    return Number.isSafeInteger(runId) && runId > 0 &&
        Number.isSafeInteger(runAttempt) && runAttempt > 0
      ? [{ runId, runAttempt }]
      : [];
  });
  const options: CiGanttOptions = {
    limit: clampInt(parameters.get("limit"), 60, 1, GANTT_MAX_RUNS),
    mainOnly: parameters.get("mainOnly") === "1",
    allConclusions: parameters.get("allConclusions") === "1",
  };
  if (selectedRuns.length) options.selectedRuns = selectedRuns;
  const headSha = parameters.get("sha") ?? "";
  if (selectedRuns.length && /^[0-9a-f]{40}$/i.test(headSha)) {
    options.headSha = headSha.toLowerCase();
  }
  return options;
}

function normalizedGanttOptions(
  options: CiGanttOptions,
): Required<CiGanttOptions> {
  const requestedLimit = Number.isFinite(options.limit)
    ? Math.floor(options.limit)
    : GANTT_MAX_RUNS;
  const selectedRuns = new Map<number, CiGanttRunSelection>();
  for (const selected of options.selectedRuns ?? []) {
    if (
      !Number.isSafeInteger(selected.runId) || selected.runId <= 0 ||
      !Number.isSafeInteger(selected.runAttempt) || selected.runAttempt <= 0
    ) continue;
    const current = selectedRuns.get(selected.runId);
    if (!current || current.runAttempt < selected.runAttempt) {
      selectedRuns.set(selected.runId, { ...selected });
    }
    if (selectedRuns.size >= GANTT_MAX_RUNS) break;
  }
  const headSha = options.headSha?.toLowerCase() ?? "";
  if (selectedRuns.size && !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("Selected CI runs require a commit SHA.");
  }
  return {
    limit: selectedRuns.size ||
      Math.max(1, Math.min(GANTT_MAX_RUNS, requestedLimit)),
    mainOnly: options.mainOnly,
    allConclusions: options.allConclusions === true,
    selectedRuns: [...selectedRuns.values()],
    headSha,
  };
}

export function ciHistoryBucketMs(days: number): number {
  return days * DAY_MS / CI_HISTORY_POINT_TARGET;
}

function sampleEvenlyAcrossRuns<T>(
  values: T[],
  at: (value: T) => number,
  cutoff: number,
): T[] {
  const eligible = values
    .filter((value) => {
      const time = at(value);
      return Number.isFinite(time) && time >= cutoff;
    })
    .sort((a, b) => at(a) - at(b));
  if (eligible.length <= CI_HISTORY_POINT_TARGET) {
    return eligible;
  }
  const last = eligible.length - 1;
  return Array.from(
    { length: CI_HISTORY_POINT_TARGET },
    (_, index) =>
      eligible[Math.round(index * last / (CI_HISTORY_POINT_TARGET - 1))],
  );
}

export function sampleWorkflowRuns(
  runs: WorkflowRun[],
  now = Date.now(),
  days = CI_HISTORY_DAYS,
): WorkflowRun[] {
  const eligible = successfulMainWorkflowRuns(runs, now, days);
  const cutoff = now - days * DAY_MS;
  return sampleEvenlyAcrossRuns(
    eligible,
    runTime,
    cutoff,
  );
}

function successfulMainWorkflowRuns(
  runs: WorkflowRun[],
  now: number,
  days: number,
): WorkflowRun[] {
  const cutoff = now - days * DAY_MS;
  const eligible = new Map<number, WorkflowRun>();
  for (const run of runs) {
    const at = runTime(run);
    if (
      !isSuccessfulPush(run) ||
      (run.head_branch !== undefined && run.head_branch !== null &&
        run.head_branch !== "main") ||
      !Number.isFinite(at) || at < cutoff || at > now
    ) continue;
    const current = eligible.get(run.id);
    if (!current || run.run_attempt > current.run_attempt) {
      eligible.set(run.id, run);
    }
  }
  return [...eligible.values()];
}

// Whether `run` is a push that succeeded.
function isSuccessfulPush(run: WorkflowRun): boolean {
  return run.status === "completed" && run.conclusion === "success" &&
    run.event === "push";
}

// One page of a workflow's runs, whatever they ran for, newest first. GitHub
// serves this listing current. A listing narrowed by branch, event, or status
// is served from an index that can be days behind it.
async function fetchUnfilteredWorkflowRuns(
  token: string,
  source: CiHistorySource,
  request: GitHubRequest,
  page = 1,
): Promise<WorkflowRun[]> {
  const response = await request<{ workflow_runs?: WorkflowRun[] }>(
    `repos/${source.repo}/actions/workflows/${source.workflow}/runs?per_page=100&page=${page}`,
    token,
  );
  return (response.workflow_runs ?? []).map(projectWorkflowRun);
}

async function fetchWorkflowRuns(
  token: string,
  now: number,
  source: CiHistorySource,
  request: GitHubRequest,
): Promise<WorkflowRun[]> {
  const cutoff = now - CI_HISTORY_DAYS * DAY_MS;
  // GitHub caps every filtered workflow-run search at 1,000 results. Query the
  // complete window first, then divide only a saturated range. The one-day
  // buffer covers runs that were created before the cutoff but started after it.
  const searchRange = async (
    start: number,
    end: number,
  ): Promise<WorkflowRun[]> => {
    const requestPage = (page: number) => {
      const created = `${new Date(start).toISOString()}..${
        new Date(end).toISOString()
      }`;
      const params = new URLSearchParams({
        branch: "main",
        event: "push",
        status: "success",
        created,
        per_page: "100",
        page: String(page),
      });
      return request<{
        total_count?: number;
        workflow_runs?: WorkflowRun[];
      }>(
        `repos/${source.repo}/actions/workflows/${source.workflow}/runs?${params}`,
        token,
      );
    };

    const first = await requestPage(1);
    const firstBatch = (first.workflow_runs ?? []).map(projectWorkflowRun);
    if ((first.total_count ?? firstBatch.length) >= GITHUB_SEARCH_LIMIT) {
      if (end - start <= 1_000) {
        throw new Error(
          "GitHub workflow-run search exceeded 1,000 results in one second",
        );
      }
      const midpoint = Math.floor((start + end) / 2);
      return [
        ...await searchRange(start, midpoint),
        ...await searchRange(midpoint, end),
      ];
    }

    const runs = [...firstBatch];
    for (let page = 2; firstBatch.length === 100; page++) {
      if (first.total_count !== undefined && runs.length >= first.total_count) {
        break;
      }
      const response = await requestPage(page);
      const batch = (response.workflow_runs ?? []).map(projectWorkflowRun);
      runs.push(...batch);
      if (batch.length < 100) break;
    }
    return runs;
  };

  const searched = await searchRange(cutoff - DAY_MS, now);
  const newest = await fetchUnfilteredWorkflowRuns(token, source, request);
  // The search has to reach the oldest successful first attempt of a main push
  // in the window on the newest page, read after it, so that no run falls
  // between the two. A search that does not was served from a moment before
  // that run. A later attempt is not held to this, since the search can know
  // the run by the attempt before it until its index catches up.
  const recent = newest.filter((run) =>
    isSuccessfulPush(run) && run.head_branch === "main" &&
    runTime(run) >= cutoff
  );
  const joint = recent.findLast((run) => run.run_attempt === 1);
  if (joint && !searched.some((run) => run.id === joint.id)) {
    throw new Error(STALE_RUNS_ERROR);
  }
  const unique = new Map<number, WorkflowRun>();
  for (const run of [...searched, ...recent]) {
    const current = unique.get(run.id);
    if (!current || run.run_attempt > current.run_attempt) {
      unique.set(run.id, run);
    }
  }
  return [...unique.values()];
}

// Up to GANTT_MAX_RUNS of a workflow's newest runs in the history window, or of
// its pushes to main. Main's pushes are picked out of the unfiltered listing
// here, since GitHub serves that listing current. A run that pages repeat as
// runs land is kept once, at its latest attempt.
async function fetchRecentWorkflowRuns(
  token: string,
  source: CiHistorySource,
  mainOnly: boolean,
  request: GitHubRequest,
  now: number,
): Promise<WorkflowRun[]> {
  const cutoff = now - CI_HISTORY_DAYS * DAY_MS;
  const runs = new Map<number, WorkflowRun>();
  for (let page = 1; runs.size < GANTT_MAX_RUNS; page++) {
    const batch = await fetchUnfilteredWorkflowRuns(token, source, request, page);
    for (const run of batch) {
      if (
        runTime(run) < cutoff ||
        (mainOnly && (run.event !== "push" || run.head_branch !== "main"))
      ) continue;
      const kept = runs.get(run.id);
      if (!kept || run.run_attempt > kept.run_attempt) runs.set(run.id, run);
    }
    const last = batch.at(-1);
    if (batch.length < 100 || !last || runTime(last) < cutoff) break;
  }
  return [...runs.values()].slice(0, GANTT_MAX_RUNS);
}

interface TimedApiJob {
  timing: CiTimedJob;
  start: number;
  end: number;
}

interface CiRunTiming {
  jobs: CiTimedJob[];
  overallSeconds: number;
  ganttJobs: CachedCiGanttJob[];
}

function timedJob(job: ApiJob): TimedApiJob | null {
  if (
    job.conclusion !== "success" || !job.started_at || !job.completed_at
  ) {
    return null;
  }
  const start = Date.parse(job.started_at);
  const end = Date.parse(job.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return {
    timing: { name: job.name, seconds: (end - start) / 1_000 },
    start,
    end,
  };
}

function ganttJob(job: ApiJob, attempt: number): CachedCiGanttJob {
  return {
    attempt,
    name: job.name,
    status: job.status ?? "completed",
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      number: step.number,
      conclusion: step.conclusion,
      started_at: step.started_at,
      completed_at: step.completed_at,
    })),
  };
}

async function fetchJobPage(
  path: string,
  token: string,
  source: CiHistorySource,
  request: GitHubRequest,
): Promise<ApiJob[]> {
  const jobs: ApiJob[] = [];
  for (let page = 1;; page++) {
    const response = await request<{ jobs?: ApiJob[] }>(
      `repos/${source.repo}/${path}${
        path.includes("?") ? "&" : "?"
      }per_page=${JOBS_PER_PAGE}&page=${page}`,
      token,
    );
    const batch = response.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < JOBS_PER_PAGE) break;
  }
  return jobs;
}

async function fetchRunJobs(
  run: WorkflowRun,
  token: string,
  source: CiHistorySource,
  request: GitHubRequest,
): Promise<CiRunTiming> {
  const complete = new Map<string, ApiJob>();
  const ganttExecutions = new Map<
    string,
    { attempt: number; job: ApiJob }
  >();
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const attempted = await fetchJobPage(
      `actions/runs/${run.id}/attempts/${attempt}/jobs`,
      token,
      source,
      request,
    );
    for (const job of attempted) {
      complete.set(job.name, job);
      // GitHub repeats an earlier successful job in later failed-job rerun
      // responses with a new job ID. Its name and timestamps stay the same. A
      // job that ran again has new timestamps and gets a separate Gantt bar.
      const execution = [
        job.name,
        job.started_at ?? "",
        job.completed_at ?? "",
      ].join("\u0000");
      if (!ganttExecutions.has(execution)) {
        ganttExecutions.set(execution, { attempt, job });
      }
    }
  }
  const jobs = [...complete.values()];
  const ganttJobs = [...ganttExecutions.values()];
  if (!ganttJobs.some(({ job }) => isDrawableGanttJob(job))) {
    throw new Error(
      `No completed CI job timings were returned for run ${run.id} attempt ${run.run_attempt}.`,
    );
  }
  const timed = jobs.flatMap((job) => {
    const value = timedJob(job);
    return value ? [value] : [];
  });
  const start = timed.length ? Math.min(...timed.map((job) => job.start)) : 0;
  const end = timed.length ? Math.max(...timed.map((job) => job.end)) : 0;
  return {
    jobs: timed.map((job) => job.timing),
    overallSeconds: start && end > start ? (end - start) / 1_000 : 0,
    ganttJobs: ganttJobs.map(({ attempt, job }) => ganttJob(job, attempt)),
  };
}

export function buildCiJobHistory(
  samples: CiHistorySample[],
  failedRunCount = 0,
  axis?: { start: number; end: number },
  failedRunTimes: number[] = [],
  successfulRunTimes: number[] | null = null,
): CiJobHistorySnapshot {
  const jobSeries = new Map<string, CiJobSeries>();
  const groupPoints = new Map<string, CiJobPoint[]>();
  const overallPoints: CiJobPoint[] = [];
  const shardedBases = new Set<string>();
  const maxConcurrent = new Map<string, number>();

  for (const sample of samples) {
    if (
      sample.overallSeconds !== undefined &&
      Number.isFinite(sample.overallSeconds) && sample.overallSeconds > 0
    ) {
      overallPoints.push({
        at: sample.at,
        seconds: sample.overallSeconds,
        runId: sample.runId,
        runUrl: sample.runUrl,
      });
    }
    // A re-run can return two records with the same job name. Keep the longer
    // successful record so one run contributes one point to each series.
    const jobsByName = new Map<string, CiTimedJob>();
    for (const job of sample.jobs) {
      const current = jobsByName.get(job.name);
      if (!current || job.seconds > current.seconds) {
        jobsByName.set(job.name, job);
      }
    }
    const jobsByBase = new Map<string, CiTimedJob[]>();
    for (const job of jobsByName.values()) {
      const base = baseJobName(job.name);
      let series = jobSeries.get(job.name);
      if (!series) {
        series = { kind: "job", name: job.name, base, points: [] };
        jobSeries.set(job.name, series);
      }
      const point = {
        at: sample.at,
        seconds: job.seconds,
        runId: sample.runId,
        runUrl: sample.runUrl,
      };
      series.points.push(point);
      const siblings = jobsByBase.get(base);
      if (siblings) siblings.push(job);
      else jobsByBase.set(base, [job]);
    }
    for (const [base, jobs] of jobsByBase) {
      if (jobs.length > 1) shardedBases.add(base);
      maxConcurrent.set(
        base,
        Math.max(maxConcurrent.get(base) ?? 0, jobs.length),
      );
      const slowest = jobs.reduce((a, b) => a.seconds >= b.seconds ? a : b);
      const points = groupPoints.get(base);
      const point = {
        at: sample.at,
        seconds: slowest.seconds,
        runId: sample.runId,
        runUrl: sample.runUrl,
      };
      if (points) points.push(point);
      else groupPoints.set(base, [point]);
    }
  }

  const groups = [...shardedBases].sort().map((base): CiShardGroup => {
    const shards = [...jobSeries.values()]
      .filter((series) => series.base === base)
      .sort((a, b) =>
        shardKey(a.name).localeCompare(shardKey(b.name)) ||
        a.name.localeCompare(b.name)
      );
    return {
      base,
      maxConcurrent: maxConcurrent.get(base) ?? shards.length,
      aggregate: {
        kind: "group",
        name: base,
        base,
        points: groupPoints.get(base)!,
      },
      shards,
    };
  });
  const jobs = [...jobSeries.values()]
    .filter((series) => !shardedBases.has(series.base))
    .sort((a, b) => a.name.localeCompare(b.name));
  const times = samples.map((sample) => sample.at).filter(Number.isFinite);
  return {
    runCount: samples.length,
    successfulRunTimes,
    failedRunCount,
    failedRunTimes,
    stale: samples.length === 0 && failedRunCount > 0,
    axisStart: axis?.start ?? (times.length ? Math.min(...times) : 0),
    axisEnd: axis?.end ?? (times.length ? Math.max(...times) : 0),
    overall: overallPoints.length
      ? {
        kind: "overall",
        name: "Overall CI",
        base: "Overall CI",
        points: overallPoints,
      }
      : null,
    groups,
    jobs,
  };
}

const snapshotKey = (source: CiHistorySource, days: number): string =>
  `${source.key}:${days}`;

function snapshotFingerprint(
  snapshot: CiJobHistorySnapshot | null,
): string {
  if (!snapshot) return "none";
  return JSON.stringify([
    snapshot.runCount,
    snapshot.successfulRunTimes,
    snapshot.failedRunCount,
    snapshot.failedRunTimes,
    snapshot.stale,
    snapshot.overall,
    snapshot.groups,
    snapshot.jobs,
  ]);
}

export function ciJobHistorySnapshotVersion(
  snapshot: CiJobHistorySnapshot | null,
): string {
  const value = snapshotFingerprint(snapshot);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function inRequestedWindow(
  snapshot: CiJobHistorySnapshot,
  now: number,
  days: number,
): CiJobHistorySnapshot {
  const axisStart = now - days * DAY_MS;
  const samples = new Map<number, CiHistorySample>();
  const sampleFor = (point: CiJobPoint): CiHistorySample | null => {
    if (point.at < axisStart || point.at > now) return null;
    let sample = samples.get(point.runId);
    if (!sample) {
      sample = {
        runId: point.runId,
        runUrl: point.runUrl,
        at: point.at,
        jobs: [],
      };
      samples.set(point.runId, sample);
    }
    return sample;
  };
  for (const point of snapshot.overall?.points ?? []) {
    const sample = sampleFor(point);
    if (sample) sample.overallSeconds = point.seconds;
  }
  const jobs = [
    ...snapshot.jobs,
    ...snapshot.groups.flatMap((group) => group.shards),
  ];
  for (const series of jobs) {
    for (const point of series.points) {
      const sample = sampleFor(point);
      if (sample) {
        sample.jobs.push({ name: series.name, seconds: point.seconds });
      }
    }
  }
  const failedRunTimes = snapshot.failedRunTimes.filter((at) =>
    at >= axisStart && at <= now
  );
  const successfulRunTimes =
    snapshot.successfulRunTimes?.filter((at) => at >= axisStart && at <= now) ??
      null;
  const untimedFailureCount = Math.max(
    0,
    snapshot.failedRunCount - snapshot.failedRunTimes.length,
  );
  const overlapsOriginalWindow = snapshot.axisEnd >= axisStart &&
    snapshot.axisStart <= now;
  const failedRunCount = failedRunTimes.length +
    (overlapsOriginalWindow ? untimedFailureCount : 0);
  const filtered = buildCiJobHistory(
    [...samples.values()].sort((a, b) => a.at - b.at),
    failedRunCount,
    { start: axisStart, end: now },
    failedRunTimes,
    successfulRunTimes,
  );
  return {
    ...filtered,
    stale: filtered.runCount > 0 ? snapshot.stale : filtered.stale,
  };
}

function sampleFromCache(run: CachedCiRun): CiHistorySample {
  return {
    runId: run.runId,
    runUrl: run.runUrl,
    at: run.at,
    overallSeconds: run.overallSeconds,
    jobs: run.jobs,
  };
}

function isSuccessfulMainCachedRun(run: CachedCiRun): boolean {
  return run.gantt.status === "completed" &&
    run.gantt.conclusion === "success" && run.gantt.event === "push" &&
    (run.gantt.headBranch === undefined || run.gantt.headBranch === "main");
}

function isMainCachedRun(run: CachedCiRun): boolean {
  return run.gantt.status === "completed" &&
    run.gantt.event === "push" &&
    (run.gantt.headBranch === undefined || run.gantt.headBranch === "main");
}

function hasDrawableGanttTiming(run: CachedCiRun): boolean {
  return run.gantt.drawable;
}

function hasAttemptMetadata(run: CachedCiRun): boolean {
  return run.runAttempt === 1 || run.gantt.attemptTagged;
}

function hasAttemptAwareGanttTiming(run: CachedCiRun): boolean {
  return hasDrawableGanttTiming(run) && hasAttemptMetadata(run);
}

function workflowRunFromCache(
  run: CachedCiRun,
  source: CiHistorySource,
): WorkflowRun {
  return {
    id: run.runId,
    status: run.gantt.status,
    conclusion: run.gantt.conclusion,
    event: run.gantt.event,
    head_branch: run.gantt.headBranch,
    head_sha: run.headSha,
    path: `.github/workflows/${source.workflow}`,
    run_attempt: run.runAttempt,
    run_started_at: run.gantt.startedAt,
    html_url: run.runUrl,
    name: run.gantt.workflowName,
  };
}

function ganttInputRun(
  run: CachedCiRun,
  jobs: CachedCiGanttJob[],
): CiGanttInputRun {
  return {
    run: {
      attempt: run.runAttempt,
      databaseId: run.runId,
      status: run.gantt.status,
      conclusion: run.gantt.conclusion ?? "",
      event: run.gantt.event,
      headBranch: run.gantt.headBranch,
      startedAt: run.gantt.startedAt,
      workflowName: run.gantt.workflowName,
    },
    jobs,
  };
}

export class CiJobHistoryCollector {
  #store: CiJobHistoryStore;
  #detail: CiGanttDetailStore;
  #github: GitHubRequest;
  #cacheSaves = new Map<number, Promise<void>>();
  #jobRequests = new Map<string, Promise<CachedCiRun>>();
  #latest = new Map<string, CiJobHistorySnapshot>();
  #sampledRuns = new Map<string, CachedCiRunReference[]>();
  #samplingVersions = new Map<string, number | null>();
  #snapshotRevisions = new Map<string, number>();
  #progressById = new Map<string, CiJobProgressRecord>();
  #progressByKey = new Map<string, CiJobProgressRecord>();
  #newestProgress: CiJobProgressRecord | null = null;
  #progressSequence = 0;
  #refreshedAt = new Map<string, { at: number; revision: number }>();
  #refreshFailureAt = new Map<CiHistorySourceKey, number>();
  #refreshFailureError = new Map<string, string>();
  #refreshRequests = new Map<string, Promise<CiJobHistorySnapshot>>();
  #recentWorkflowRuns = new Map<string, { at: number; runs: WorkflowRun[] }>();
  #selectedWorkflowRuns = new Map<
    string,
    { at: number; run: WorkflowRun }
  >();
  #recentWorkflowRequests = new Map<string, CiWorkflowDiscovery>();
  #selectedWorkflowRequests = new Map<
    string,
    CiWorkflowDiscovery<SelectedWorkflowRuns>
  >();
  #workflowRuns = new Map<
    CiHistorySourceKey,
    { at: number; runs: WorkflowRun[] }
  >();
  #workflowRequests = new Map<CiHistorySourceKey, CiWorkflowDiscovery>();
  #ganttRequests = new Map<string, CiGanttRequest>();

  constructor(
    store = new CiJobHistoryStore(),
    request: GitHubRequest = performanceGithub,
    detail = new CiGanttDetailStore(() => ganttDetailDirectory(store.file)),
  ) {
    this.#store = store;
    this.#github = request;
    this.#detail = detail;
  }

  #newProgress(
    source: CiHistorySource,
    days: number,
    baseline?: CiJobHistorySnapshot | null,
    key = snapshotKey(source, days),
  ): CiJobProgressRecord {
    const previous = this.#progressByKey.get(key);
    if (previous) {
      this.#progressByKey.delete(key);
      this.#progressById.delete(previous.state.id);
    }
    const now = Date.now();
    const state: CiJobFetchProgress = {
      id: `${source.key}-${days}-${now.toString(36)}-${++this
        .#progressSequence}`,
      source: source.key,
      days,
      phase: "discovering",
      discoveryRequestsMade: 0,
      discoveryResponsesReceived: 0,
      discoveryOutstandingRequests: 0,
      totalRuns: 0,
      cachedRuns: 0,
      requestsMade: 0,
      responsesReceived: 0,
      sharedRequests: 0,
      sharedResponses: 0,
      successfulResponses: 0,
      failedResponses: 0,
      completedRuns: 0,
      queuedRuns: 0,
      outstandingRequests: 0,
      needsReload: false,
      updatedAt: now,
    };
    const record = {
      state,
      listeners: new Set<CiJobProgressListener>(),
      baselines: new Set(
        baseline === undefined ? [] : [snapshotFingerprint(baseline)],
      ),
    };
    this.#progressByKey.set(key, record);
    this.#progressById.set(state.id, record);
    this.#newestProgress = record;
    this.#trimProgressRecords(record);
    return record;
  }

  #rememberSnapshot(key: string, value: CiJobHistorySnapshot): void {
    // Re-inserting moves the key to the end of the map's insertion order, so
    // the first key is always the one written longest ago.
    this.#latest.delete(key);
    this.#latest.set(key, value);
    for (const candidate of this.#latest.keys()) {
      if (this.#latest.size <= SNAPSHOT_CACHE_MAX) break;
      // Skipping a window that is still collecting is what makes eviction
      // safe, not merely tidy. Its refresh reads #sampledRuns and
      // #samplingVersions back at the end of collect() to record its manifest,
      // and markRefreshed accepts an empty sampled-run list, so evicting one
      // mid-collection would persist a manifest claiming no sampled runs and
      // leave that window's chart permanently empty.
      if (candidate === key || this.#refreshRequests.has(candidate)) continue;
      this.#latest.delete(candidate);
      this.#sampledRuns.delete(candidate);
      this.#samplingVersions.delete(candidate);
      this.#snapshotRevisions.delete(candidate);
      this.#refreshedAt.delete(candidate);
    }
  }

  #trimProgressRecords(preserve: CiJobProgressRecord): void {
    if (this.#progressByKey.size <= PROGRESS_RECORD_MAX) return;
    // The record created most recently is exempt. Its progress id may have
    // been handed to a caller that has not opened the progress stream yet,
    // and that stream answers `unknown progress id` for a record this loop
    // has taken.
    for (const [key, record] of this.#progressByKey) {
      if (this.#progressByKey.size <= PROGRESS_RECORD_MAX) break;
      const terminal = record.state.phase === "complete" ||
        record.state.phase === "error";
      if (record !== preserve && record !== this.#newestProgress && terminal) {
        this.#progressByKey.delete(key);
        this.#progressById.delete(record.state.id);
      }
    }
  }

  #updateProgress(
    record: CiJobProgressRecord,
    update: Partial<CiJobFetchProgress>,
  ): void {
    Object.assign(record.state, update);
    record.state.completedRuns = Math.min(
      record.state.totalRuns,
      record.state.cachedRuns + record.state.responsesReceived +
        record.state.sharedResponses,
    );
    record.state.queuedRuns = Math.max(
      0,
      record.state.totalRuns - record.state.cachedRuns -
        record.state.requestsMade - record.state.sharedRequests,
    );
    record.state.outstandingRequests = Math.max(
      0,
      record.state.requestsMade + record.state.sharedRequests -
        record.state.responsesReceived - record.state.sharedResponses,
    );
    record.state.updatedAt = Date.now();
    const value = { ...record.state };
    for (const listener of record.listeners) {
      try {
        listener(value);
      } catch {
        record.listeners.delete(listener);
      }
    }
    if (update.phase === "complete" || update.phase === "error") {
      this.#trimProgressRecords(record);
    }
  }

  #startJobLoadProgress(
    progress: CiJobProgressRecord,
    kind: CiJobLoad["kind"],
  ): void {
    if (kind === "requested") {
      this.#updateProgress(progress, {
        requestsMade: progress.state.requestsMade + 1,
      });
    } else if (kind === "joined") {
      this.#updateProgress(progress, {
        sharedRequests: progress.state.sharedRequests + 1,
      });
    }
  }

  #finishJobLoadProgress(
    progress: CiJobProgressRecord,
    kind: CiJobLoad["kind"],
    succeeded: boolean,
  ): void {
    if (kind === "cached") {
      this.#updateProgress(progress, {
        cachedRuns: progress.state.cachedRuns + 1,
      });
      return;
    }
    this.#updateProgress(progress, {
      responsesReceived: progress.state.responsesReceived +
        (kind === "requested" ? 1 : 0),
      sharedResponses: progress.state.sharedResponses +
        (kind === "joined" ? 1 : 0),
      successfulResponses: progress.state.successfulResponses +
        (succeeded ? 1 : 0),
      failedResponses: progress.state.failedResponses + (succeeded ? 0 : 1),
    });
  }

  progress(id: string): CiJobFetchProgress | null {
    const record = this.#progressById.get(id);
    return record ? { ...record.state } : null;
  }

  subscribeProgress(
    id: string,
    listener: CiJobProgressListener,
  ): (() => void) | null {
    const record = this.#progressById.get(id);
    if (!record) return null;
    record.listeners.add(listener);
    try {
      listener({ ...record.state });
    } catch {
      record.listeners.delete(listener);
      return null;
    }
    return () => record.listeners.delete(listener);
  }

  snapshot(
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
  ): CiJobHistorySnapshot | null {
    return this.#latest.get(snapshotKey(source, days)) ?? null;
  }

  async cached(
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
    now = Date.now(),
  ): Promise<CiJobHistorySnapshot | null> {
    await this.#store.load();
    const key = snapshotKey(source, days);
    if (
      this.#store.quarantineFutureRefresh(
        source.repo,
        source.workflow,
        days,
      )
    ) {
      this.#refreshedAt.delete(key);
      await this.#saveCache(now);
    }
    const refresh = this.#store.refresh(
      source.repo,
      source.workflow,
      days,
    );
    const current = this.snapshot(source, days);
    const sourceRevision = this.#store.revisionFor(
      source.repo,
      source.workflow,
    );
    if (current && this.#snapshotRevisions.get(key) === sourceRevision) {
      return inRequestedWindow(current, now, days);
    }
    const cutoff = now - days * DAY_MS;
    const successfulRunTimes =
      refresh?.successfulRunTimes.filter((at) => at >= cutoff && at <= now) ??
        null;
    const resolvedRefreshRuns = this.#store.refreshedRuns(
      source.repo,
      source.workflow,
      days,
    );
    const refreshedRuns =
      resolvedRefreshRuns?.filter((run) => run.at >= cutoff && run.at <= now) ??
        resolvedRefreshRuns;
    const runs = refreshedRuns ?? sampleEvenlyAcrossRuns(
      this.#store.list(source.repo, source.workflow, cutoff).filter(
        isSuccessfulMainCachedRun,
      ),
      (run) => run.at,
      cutoff,
    );
    if (!runs.length && !refresh) {
      return current ? inRequestedWindow(current, now, days) : null;
    }
    const failedRunTimes =
      refresh?.failedRunTimes.filter((at) => at >= cutoff && at <= now) ?? [];
    const untimedFailureCount = refresh
      ? Math.max(0, refresh.failedRunCount - refresh.failedRunTimes.length)
      : 0;
    const built = buildCiJobHistory(
      runs.map(sampleFromCache),
      failedRunTimes.length + untimedFailureCount,
      { start: cutoff, end: now },
      failedRunTimes,
      successfulRunTimes,
    );
    const value = refresh?.stale && built.runCount
      ? { ...built, stale: true }
      : built;
    this.#sampledRuns.set(
      key,
      runs.map((run) => ({
        runId: run.runId,
        runAttempt: run.runAttempt,
      })),
    );
    this.#samplingVersions.set(
      key,
      refresh ? refresh.samplingVersion ?? null : null,
    );
    this.#snapshotRevisions.set(
      key,
      this.#store.revisionFor(source.repo, source.workflow),
    );
    this.#rememberSnapshot(key, value);
    const freshRefresh = this.#store.freshRefresh(
      source.repo,
      source.workflow,
      days,
    );
    if (freshRefresh) {
      this.#refreshedAt.set(key, {
        at: freshRefresh.refreshedAt,
        revision: this.#store.revisionFor(source.repo, source.workflow),
      });
    }
    return value;
  }

  #jobsForRun(
    run: WorkflowRun,
    token: string,
    source: CiHistorySource,
    now: number,
    options: {
      exactAttempt?: boolean;
      expectedHeadSha?: string;
      // Set by the Gantt collectors, which need the attempt's step detail and
      // not only its index entry. An entry whose detail has been pruned is
      // fetched again.
      hasGanttDetail?: boolean;
    } = {},
  ): CiJobLoad {
    const exactAttempt = options.exactAttempt ?? false;
    const expectedHeadSha = options.expectedHeadSha ?? "";
    const ganttDetailAvailable = options.hasGanttDetail ?? true;
    const pending = this.#pendingJobsForRun(run, source, exactAttempt);
    if (pending) return { kind: "joined", result: pending };
    let cached = exactAttempt
      ? this.#store.get(
        source.repo,
        source.workflow,
        run.id,
        run.run_attempt,
      )
      : this.#store.latest(source.repo, source.workflow, run.id);
    if (exactAttempt && cached && run.head_sha) {
      cached = this.#store.setHeadSha(
        source.repo,
        source.workflow,
        run.id,
        run.run_attempt,
        run.head_sha,
      );
    }
    const repairCachedEntry = cached !== undefined &&
      (exactAttempt
        ? !hasAttemptAwareGanttTiming(cached)
        : !hasAttemptMetadata(cached));
    if (
      cached && ganttDetailAvailable &&
      (exactAttempt
        ? cached.runAttempt === run.run_attempt &&
          cached.headSha === expectedHeadSha &&
          hasAttemptAwareGanttTiming(cached)
        : cached.runAttempt >= run.run_attempt &&
          hasAttemptMetadata(cached))
    ) {
      return { kind: "cached", result: Promise.resolve(cached) };
    }

    const key =
      `${source.repo}:${source.workflow}:${run.id}:${run.run_attempt}:${
        exactAttempt ? "exact" : "aggregate"
      }`;
    let request = this.#jobRequests.get(key);
    if (!request) {
      request = fetchRunJobs(run, token, source, this.#github)
        .then(async (timing): Promise<CachedCiRun> => {
          const entry = {
            repo: source.repo,
            workflow: source.workflow,
            runId: run.id,
            runAttempt: run.run_attempt,
            headSha: run.head_sha?.toLowerCase(),
            runUrl: run.html_url,
            at: runTime(run),
            overallSeconds: timing.overallSeconds,
            jobs: timing.jobs,
            gantt: ganttRunSummary({
              status: run.status,
              conclusion: run.conclusion,
              event: run.event,
              headBranch: run.head_branch ?? undefined,
              startedAt: run.run_started_at,
              workflowName: run.name ?? source.workflow,
            }, timing.ganttJobs),
          };
          if (repairCachedEntry) this.#store.replace(entry);
          else this.#store.set(entry);
          // The index holds the durations on its own. An attempt whose step
          // detail could not be written is one a chart collects again, the same
          // as an attempt whose detail has been pruned, so the collection keeps
          // going. A filesystem that cannot take the detail also cannot take
          // the index, and that failure below does stop the collection.
          try {
            await this.#detail.write(
              source,
              run.id,
              run.run_attempt,
              timing.ganttJobs,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : `${error}`;
            console.error(
              `CI Gantt detail for run ${run.id} attempt ${run.run_attempt} was not stored: ${message}`,
            );
          }
          const cached = exactAttempt
            ? this.#store.get(
              source.repo,
              source.workflow,
              run.id,
              run.run_attempt,
            )!
            : this.#store.latest(source.repo, source.workflow, run.id)!;
          try {
            await this.#saveCache(now);
          } catch (error) {
            throw new CiJobCacheWriteError(error);
          }
          return cached;
        })
        .finally(() => this.#jobRequests.delete(key));
      this.#jobRequests.set(key, request);
    }
    return { kind: "requested", result: request };
  }

  #jobRequestPrefix(run: WorkflowRun, source: CiHistorySource): string {
    return `${source.repo}:${source.workflow}:${run.id}:`;
  }

  #pendingJobsForRun(
    run: WorkflowRun,
    source: CiHistorySource,
    exactAttempt = false,
  ): Promise<CachedCiRun> | null {
    const prefix = this.#jobRequestPrefix(run, source);
    let newestAttempt = -1;
    let pending: Promise<CachedCiRun> | null = null;
    for (const [key, request] of this.#jobRequests) {
      if (!key.startsWith(prefix)) continue;
      const [attemptValue, mode] = key.slice(prefix.length).split(":", 2);
      if (mode !== (exactAttempt ? "exact" : "aggregate")) continue;
      const attempt = Number(attemptValue);
      if (
        (exactAttempt
          ? attempt === run.run_attempt
          : attempt >= run.run_attempt) &&
        attempt > newestAttempt
      ) {
        newestAttempt = attempt;
        pending = request;
      }
    }
    return pending;
  }

  /**
   * Drops the Gantt detail of the attempts the run index no longer keeps. An
   * attempt keeps its detail for exactly as long as the run index keeps the
   * attempt. Compression makes an attempt's detail small enough that the whole
   * retention window fits, so nothing GitHub would have to serve again is
   * discarded early.
   *
   * Passing every attempt the index holds, with no cap of its own, is what
   * makes pruning safe to run against a chart being assembled: a chart draws
   * the runs the index names, so the set kept here always covers it. A cap here
   * would break that, and no amount of coordinating the two would repair it — a
   * chart would simply be reading files this had already decided to drop.
   */
  async #pruneGanttDetail(source: CiHistorySource): Promise<void> {
    await this.#detail.prune(
      source,
      this.#store.attempts(source.repo, source.workflow),
    );
  }

  async #saveCache(now: number): Promise<void> {
    if (!this.#store.dirty) return;
    const revision = this.#store.revision;
    let request = this.#cacheSaves.get(revision);
    if (!request) {
      const save = this.#store.save(now);
      const saveRevision = this.#store.revision;
      request = save.finally(() => {
        this.#cacheSaves.delete(revision);
        this.#cacheSaves.delete(saveRevision);
      });
      this.#cacheSaves.set(revision, request);
      this.#cacheSaves.set(saveRevision, request);
    }
    await request;
  }

  async collect(
    token: string,
    now = Date.now(),
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
    workflowRuns?: WorkflowRun[],
    progress?: CiJobProgressRecord,
  ): Promise<CiJobHistorySnapshot> {
    await this.#store.load();
    const previous = this.snapshot(source, days) ??
      await this.cached(source, days, now);
    const workflowRunHistory = workflowRuns ??
      await fetchWorkflowRuns(token, now, source, this.#github);
    const successfulRuns = successfulMainWorkflowRuns(
      workflowRunHistory,
      now,
      days,
    );
    const successfulRunTimes = successfulRuns.map(runTime).sort((a, b) =>
      a - b
    );
    const runs = sampleEvenlyAcrossRuns(
      successfulRuns,
      runTime,
      now - days * DAY_MS,
    );
    const priorRefresh = this.#store.refresh(
      source.repo,
      source.workflow,
      days,
    );
    const desiredRuns = runs.map((run) => ({
      runId: run.id,
      runAttempt: run.run_attempt,
    }));
    if (
      priorRefresh &&
      JSON.stringify(priorRefresh.sampledRuns) !== JSON.stringify(desiredRuns)
    ) {
      this.#store.invalidateRefresh(source.repo, source.workflow, days);
      this.#refreshedAt.delete(snapshotKey(source, days));
      await this.#saveCache(now);
    }
    const entries = new Map<number, CachedCiRun>();
    for (const run of runs) {
      const cached = this.#store.latest(source.repo, source.workflow, run.id);
      if (
        cached && cached.runAttempt >= run.run_attempt &&
        !this.#pendingJobsForRun(run, source)
      ) {
        entries.set(run.id, cached);
      }
    }
    const missing = runs.filter((run) => !entries.has(run.id));
    if (progress) {
      this.#updateProgress(progress, {
        phase: "fetching",
        totalRuns: runs.length,
        cachedRuns: entries.size,
        needsReload: missing.length > 0,
      });
    }
    const failed = new Map<number, unknown>();
    const outcomes = await inFlight(
      missing,
      JOB_FETCH_CONCURRENCY,
      async (run): Promise<CiJobFetchOutcome> => {
        const load = this.#jobsForRun(run, token, source, now);
        if (progress) this.#startJobLoadProgress(progress, load.kind);
        try {
          const entry = await load.result;
          if (progress) {
            this.#finishJobLoadProgress(progress, load.kind, true);
          }
          return { run, entry };
        } catch (error) {
          if (progress) {
            this.#finishJobLoadProgress(progress, load.kind, false);
          }
          return {
            run,
            error,
            persistence: error instanceof CiJobCacheWriteError,
          };
        }
      },
      (outcome) => "error" in outcome && outcome.persistence,
    );
    const persistenceFailure = outcomes.find((outcome) =>
      "error" in outcome && outcome.persistence
    );
    if (persistenceFailure && "error" in persistenceFailure) {
      throw persistenceFailure.error;
    }
    for (const outcome of outcomes) {
      if ("entry" in outcome) entries.set(outcome.run.id, outcome.entry);
      else failed.set(outcome.run.id, outcome.error);
    }
    if (progress) this.#updateProgress(progress, { phase: "saving" });
    await this.#saveCache(now);
    await this.#pruneGanttDetail(source);
    const samples = runs.flatMap((run) => {
      const entry = entries.get(run.id);
      return entry ? [sampleFromCache(entry)] : [];
    });
    const failures = runs.flatMap((run) => {
      return failed.has(run.id) ? [{ run, error: failed.get(run.id) }] : [];
    });
    if (failures.length) {
      const first = failures[0];
      const message = first.error instanceof Error
        ? first.error.message
        : String(first.error);
      console.error(
        `CI job history could not read ${failures.length} sampled run(s); ` +
          `first was ${first.run.id} attempt ${first.run.run_attempt}: ${message}`,
      );
    }
    const key = snapshotKey(source, days);
    const failedRunTimes = failures.map(({ run }) => runTime(run)).filter(
      Number.isFinite,
    );
    const previousInWindow = previous
      ? inRequestedWindow(previous, now, days)
      : null;
    const preservePrevious = !samples.length && failures.length &&
      Boolean(previousInWindow?.runCount);
    const value = preservePrevious
      ? {
        ...previousInWindow!,
        successfulRunTimes: [
          ...new Set([
            ...successfulRunTimes,
            ...(previousInWindow!.successfulRunTimes ?? []),
          ]),
        ].sort((a, b) => a - b),
        failedRunCount: failures.length,
        failedRunTimes,
        stale: true,
      }
      : buildCiJobHistory(
        samples,
        failures.length,
        {
          start: now - days * DAY_MS,
          end: now,
        },
        failedRunTimes,
        successfulRunTimes,
      );
    const sampledRuns = preservePrevious
      ? (this.#sampledRuns.get(key) ?? []).filter((reference) => {
        const run = this.#store.get(
          source.repo,
          source.workflow,
          reference.runId,
          reference.runAttempt,
        );
        return Boolean(
          run && run.at >= now - days * DAY_MS && run.at <= now,
        );
      })
      : runs.flatMap((run) => {
        const entry = entries.get(run.id);
        return entry
          ? [{ runId: entry.runId, runAttempt: entry.runAttempt }]
          : [];
      });
    if (preservePrevious && sampledRuns.length !== value.runCount) {
      throw new Error(
        "CI job history could not preserve the exact previous run set.",
      );
    }
    const previousSamplingVersion = this.#samplingVersions.has(key)
      ? this.#samplingVersions.get(key)!
      : priorRefresh?.samplingVersion ?? null;
    const samplingVersion = preservePrevious
      ? previousSamplingVersion
      : CI_JOB_HISTORY_SAMPLING_VERSION;
    this.#sampledRuns.set(key, sampledRuns);
    this.#samplingVersions.set(key, samplingVersion);
    this.#snapshotRevisions.set(
      key,
      this.#store.revisionFor(source.repo, source.workflow),
    );
    this.#rememberSnapshot(key, value);
    const rateLimitFailure = failures.find(({ error }) =>
      error instanceof GitHubRateLimitBudgetError
    );
    if (rateLimitFailure) throw rateLimitFailure.error;
    return value;
  }

  async #discoverWorkflowRuns<Key, Result>(
    requests: Map<Key, CiWorkflowDiscovery<Result>>,
    key: Key,
    load: (request: GitHubRequest) => Promise<Result>,
    progress?: CiJobProgressRecord,
  ): Promise<Result> {
    let discovery = requests.get(key);
    if (!discovery) {
      const activeDiscovery: CiWorkflowDiscovery<Result> = {
        progresses: new Set(progress ? [progress] : []),
        requestsMade: 0,
        responsesReceived: 0,
        result: Promise.resolve(undefined as Result),
      };
      const updateProgress = () => {
        for (const progress of activeDiscovery.progresses) {
          this.#updateProgress(progress, {
            discoveryRequestsMade: activeDiscovery.requestsMade,
            discoveryResponsesReceived: activeDiscovery.responsesReceived,
            discoveryOutstandingRequests: Math.max(
              0,
              activeDiscovery.requestsMade -
                activeDiscovery.responsesReceived,
            ),
          });
        }
      };
      const request: GitHubRequest = async <T>(
        path: string,
        token?: string,
      ) => {
        activeDiscovery.requestsMade++;
        updateProgress();
        try {
          return await this.#github<T>(path, token);
        } finally {
          activeDiscovery.responsesReceived++;
          updateProgress();
        }
      };
      activeDiscovery.result = Promise.resolve()
        .then(() => load(request))
        .finally(() => {
          if (requests.get(key) === activeDiscovery) {
            requests.delete(key);
          }
        });
      discovery = activeDiscovery;
      requests.set(key, activeDiscovery);
    } else if (progress) {
      discovery.progresses.add(progress);
      this.#updateProgress(progress, {
        discoveryRequestsMade: discovery.requestsMade,
        discoveryResponsesReceived: discovery.responsesReceived,
        discoveryOutstandingRequests: Math.max(
          0,
          discovery.requestsMade - discovery.responsesReceived,
        ),
      });
    }
    return await discovery.result;
  }

  async #runsForRefresh(
    token: string,
    source: CiHistorySource,
    now: number,
    progress?: CiJobProgressRecord,
  ): Promise<WorkflowRun[]> {
    const cached = this.#workflowRuns.get(source.key);
    if (cached && Date.now() - cached.at < REFRESH_MS) return cached.runs;
    return await this.#discoverWorkflowRuns(
      this.#workflowRequests,
      source.key,
      (request) =>
        fetchWorkflowRuns(token, now, source, request).then((runs) => {
          this.#workflowRuns.set(source.key, { at: Date.now(), runs });
          return runs;
        }),
      progress,
    );
  }

  #selectedWorkflowRunKey(
    source: CiHistorySource,
    headSha: string,
    selected: CiGanttRunSelection,
  ): string {
    return `${source.key}:selected:${headSha}:${selected.runId}:${selected.runAttempt}`;
  }

  #cacheSelectedWorkflowRun(key: string, run: WorkflowRun): void {
    this.#selectedWorkflowRuns.delete(key);
    this.#selectedWorkflowRuns.set(key, { at: Date.now(), run });
    if (
      this.#selectedWorkflowRuns.size > SELECTED_WORKFLOW_RUN_CACHE_MAX
    ) {
      const oldest = this.#selectedWorkflowRuns.keys().next();
      if (!oldest.done) this.#selectedWorkflowRuns.delete(oldest.value);
    }
  }

  async #selectedRunsForGantt(
    token: string,
    source: CiHistorySource,
    options: Required<CiGanttOptions>,
    progress?: CiJobProgressRecord,
  ): Promise<SelectedWorkflowRuns> {
    const resolved = new Map<number, WorkflowRun>();
    const missing: CiGanttRunSelection[] = [];
    for (const selected of options.selectedRuns) {
      const persisted = this.#store.get(
        source.repo,
        source.workflow,
        selected.runId,
        selected.runAttempt,
      );
      if (
        persisted?.headSha === options.headSha &&
        hasAttemptAwareGanttTiming(persisted)
      ) {
        resolved.set(selected.runId, workflowRunFromCache(persisted, source));
        continue;
      }
      const key = this.#selectedWorkflowRunKey(
        source,
        options.headSha,
        selected,
      );
      const cached = this.#selectedWorkflowRuns.get(key);
      if (cached && Date.now() - cached.at < REFRESH_MS) {
        resolved.set(selected.runId, cached.run);
      } else {
        missing.push(selected);
      }
    }

    let failure: SelectedWorkflowRuns["failure"];
    if (missing.length) {
      const key = `${source.key}:selected:${options.headSha}:${
        missing.map(({ runId, runAttempt }) => `${runId}:${runAttempt}`).join(
          ",",
        )
      }`;
      const discovered = await this.#discoverWorkflowRuns(
        this.#selectedWorkflowRequests,
        key,
        async (request): Promise<SelectedWorkflowRuns> => {
          // One selection that does not match its commit invalidates the whole
          // chart, so the first failure stops the rest from being started.
          const outcomes = await inFlight(
            missing,
            JOB_FETCH_CONCURRENCY,
            async (
              selected,
            ): Promise<
              { selected: CiGanttRunSelection; run: WorkflowRun } | {
                error: unknown;
              }
            > => {
              try {
                return {
                  selected,
                  run: validateSelectedWorkflowRun(
                    await request<WorkflowRun>(
                      `repos/${source.repo}/actions/runs/${selected.runId}/attempts/${selected.runAttempt}`,
                      token,
                    ),
                    selected,
                    source,
                    options.headSha,
                  ),
                };
              } catch (error) {
                return { error };
              }
            },
            (outcome) => "error" in outcome,
          );
          const runs: WorkflowRun[] = [];
          let failure: SelectedWorkflowRuns["failure"];
          for (const outcome of outcomes) {
            if ("error" in outcome) {
              failure ??= { error: outcome.error };
              continue;
            }
            runs.push(outcome.run);
            this.#cacheSelectedWorkflowRun(
              this.#selectedWorkflowRunKey(
                source,
                options.headSha,
                outcome.selected,
              ),
              outcome.run,
            );
          }
          return { runs, failure };
        },
        progress,
      );
      failure = discovered.failure;
      for (const run of discovered.runs) resolved.set(run.id, run);
    }

    return {
      runs: options.selectedRuns.flatMap((selected) => {
        const run = resolved.get(selected.runId);
        return run ? [run] : [];
      }),
      failure,
    };
  }

  async #runsForGantt(
    token: string,
    source: CiHistorySource,
    options: Required<CiGanttOptions>,
    now: number,
    progress?: CiJobProgressRecord,
  ): Promise<SelectedWorkflowRuns> {
    if (options.selectedRuns.length) {
      return await this.#selectedRunsForGantt(
        token,
        source,
        options,
        progress,
      );
    }
    if (options.mainOnly && !options.allConclusions) {
      return {
        runs: successfulMainWorkflowRuns(
          await this.#runsForRefresh(token, source, now, progress),
          now,
          CI_HISTORY_DAYS,
        ),
      };
    }
    const key = `${source.key}:${options.mainOnly ? "main" : "all"}`;
    const cached = this.#recentWorkflowRuns.get(key);
    if (cached && Date.now() - cached.at < REFRESH_MS) {
      return { runs: cached.runs };
    }
    return {
      runs: await this.#discoverWorkflowRuns(
        this.#recentWorkflowRequests,
        key,
        (request) =>
          fetchRecentWorkflowRuns(
            token,
            source,
            options.mainOnly,
            request,
            now,
          )
            .then(
              (runs) => {
                this.#recentWorkflowRuns.set(key, {
                  at: Date.now(),
                  runs,
                });
                return runs;
              },
            ),
        progress,
      ),
    };
  }

  /**
   * Hands each run a chart draws to `visit`, reading one attempt's step detail
   * at a time and letting go of it before reading the next, so the memory a
   * chart costs does not grow with its size. The 150 attempts the range slider
   * allows are around 17 MB of timings between them.
   *
   * A run the detail store cannot return is left out, except under an exact
   * selection, where the caller asked for particular runs and a chart missing
   * one of them would misrepresent the commit.
   */
  async #eachGanttRun(
    source: CiHistorySource,
    entries: CachedCiRun[],
    exactSelection: boolean,
    visit: (run: CiGanttInputRun) => void | Promise<void>,
  ): Promise<number> {
    let drawn = 0;
    for (const entry of entries) {
      const jobs = await this.#detail.read(
        source,
        entry.runId,
        entry.runAttempt,
      );
      if (!jobs) {
        if (exactSelection) {
          throw new Error("Not every selected CI run has cached job timings.");
        }
        continue;
      }
      await visit(ganttInputRun(entry, jobs));
      drawn++;
    }
    return drawn;
  }

  /**
   * Returns the subset of `entries` whose step detail reads back, without
   * keeping any of it. An attempt counts as drawable only when its detail
   * parses, so one that cannot be read — a format this version does not
   * recognize, a damaged file — is collected from GitHub again like one that
   * was never stored.
   */
  async #drawableGanttRuns(
    source: CiHistorySource,
    entries: CachedCiRun[],
  ): Promise<CachedCiRun[]> {
    const drawable: CachedCiRun[] = [];
    for (const entry of entries) {
      if (await this.#ganttDetailReadable(source, entry)) drawable.push(entry);
    }
    return drawable;
  }

  async #ganttDetailReadable(
    source: CiHistorySource,
    entry: CachedCiRun | undefined,
  ): Promise<boolean> {
    if (!entry) return false;
    return await this.#detail.read(
      source,
      entry.runId,
      entry.runAttempt,
    ) !== null;
  }

  /**
   * Returns the index entries a chart would draw from the cache alone, newest
   * first. Reading their detail is left to the caller, which often does not
   * need it.
   */
  #cachedGanttRuns(
    source: CiHistorySource,
    options: CiGanttOptions,
  ): CachedCiRun[] {
    const selectedRuns = options.selectedRuns ?? [];
    const candidates = selectedRuns.length
      ? selectedRuns.flatMap(({ runId, runAttempt }) => {
        const run = this.#store.get(
          source.repo,
          source.workflow,
          runId,
          runAttempt,
        );
        if (
          !run || run.headSha !== options.headSha ||
          !hasAttemptAwareGanttTiming(run)
        ) return [];
        return [run];
      })
      : this.#store.list(source.repo, source.workflow).filter(
        hasAttemptMetadata,
      );
    return candidates
      .filter((run) =>
        !options.mainOnly ||
        (options.allConclusions
          ? isMainCachedRun(run)
          : isSuccessfulMainCachedRun(run))
      )
      .sort((a, b) => b.at - a.at)
      .slice(0, options.limit);
  }

  /**
   * Collects a chart and returns every run of it at once. Convenient to assert
   * against, and bounded only by the range slider, so the dashboard itself
   * uses `writeGanttInput()` instead.
   */
  async gantt(
    token: string | undefined,
    source: CiHistorySource,
    options: CiGanttOptions,
    now = Date.now(),
    workflowRuns?: WorkflowRun[],
  ): Promise<CiGanttInput> {
    return await this.ganttRuns(
      source,
      await this.#collectGantt(
        token,
        source,
        normalizedGanttOptions(options),
        now,
        workflowRuns,
      ),
    );
  }

  /**
   * Returns every run of an already collected chart, held together. Bounded
   * only by the range slider, so the dashboard uses `writeGanttInput()`
   * instead.
   */
  async ganttRuns(
    source: CiHistorySource,
    selection: GanttSelection,
  ): Promise<CiGanttInput> {
    const runs: CiGanttInputRun[] = [];
    await this.#emitGantt(source, selection, (run) => {
      runs.push(run);
    });
    return { runs };
  }

  /**
   * Collects a chart and writes it straight to `destination` as the JSON the
   * Gantt renderer reads, one run at a time. Nothing holds the whole chart, so
   * the dashboard's memory does not grow with the size of the chart it serves.
   */
  async writeGanttInput(
    source: CiHistorySource,
    selection: GanttSelection,
    destination: string,
  ): Promise<number> {
    using file = await Deno.open(destination, {
      write: true,
      create: true,
      truncate: true,
    });
    const encoder = new TextEncoder();
    const write = async (text: string): Promise<void> => {
      const bytes = encoder.encode(text);
      for (let at = 0; at < bytes.length;) {
        at += await file.write(bytes.subarray(at));
      }
    };
    await write(`{"runs":[`);
    let written = 0;
    await this.#emitGantt(source, selection, async (run) => {
      await write(`${written++ ? "," : ""}${JSON.stringify(run)}`);
    });
    await write("]}");
    return written;
  }

  /** Hands over the runs of an already collected chart. */
  async #emitGantt(
    source: CiHistorySource,
    selection: GanttSelection,
    visit: (run: CiGanttInputRun) => void | Promise<void>,
  ): Promise<number> {
    return await this.#eachGanttRun(
      source,
      selection.entries,
      selection.exactSelection,
      visit,
    );
  }

  async #collectGantt(
    token: string | undefined,
    source: CiHistorySource,
    normalized: Required<CiGanttOptions>,
    now: number,
    workflowRuns?: WorkflowRun[],
    progress?: CiJobProgressRecord,
  ): Promise<GanttSelection> {
    try {
      return await this.#assembleGantt(
        token,
        source,
        normalized,
        now,
        workflowRuns,
        progress,
      );
    } finally {
      // Reported rather than raised: the chart is already decided, and a
      // filesystem that cannot take this also fails the run index save.
      await this.#pruneGanttDetail(source).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : `${error}`;
        console.error(`CI Gantt detail was not pruned: ${message}`);
      });
    }
  }

  async #assembleGantt(
    token: string | undefined,
    source: CiHistorySource,
    normalized: Required<CiGanttOptions>,
    now: number,
    workflowRuns?: WorkflowRun[],
    progress?: CiJobProgressRecord,
  ): Promise<GanttSelection> {
    await this.#store.load();
    await this.#saveCache(now);
    // Which runs the cache alone would draw. Their detail is read to find out
    // whether it is still there, and dropped again rather than carried.
    const cachedRuns = this.#cachedGanttRuns(source, normalized);
    let cachedDrawable: CachedCiRun[] | undefined;
    const drawableFromCache = async (): Promise<CachedCiRun[]> =>
      cachedDrawable ??= await this.#drawableGanttRuns(source, cachedRuns);
    const exactSelection = normalized.selectedRuns.length > 0;
    if (exactSelection) {
      const drawable = await drawableFromCache();
      const hasEverySelectedRun = normalized.selectedRuns.every((
        { runId, runAttempt },
      ) =>
        drawable.some((entry) =>
          entry.runId === runId && entry.runAttempt === runAttempt
        )
      );
      if (hasEverySelectedRun) return { entries: drawable, exactSelection };
    }
    if (!token) {
      if (!exactSelection && cachedRuns.length) {
        const drawable = await drawableFromCache();
        if (drawable.length) {
          if (progress) {
            this.#updateProgress(progress, {
              warning:
                "Showing cached runs; set GH_TOKEN to check for newer attempts.",
            });
          }
          return { entries: drawable, exactSelection };
        }
      }
      throw new Error("Set GH_TOKEN to collect CI Gantt data.");
    }

    let discovery: SelectedWorkflowRuns;
    try {
      discovery = workflowRuns
        ? { runs: workflowRuns }
        : await this.#runsForGantt(
          token,
          source,
          normalized,
          now,
          progress,
        );
    } catch (error) {
      const drawable = !exactSelection && cachedRuns.length
        ? await drawableFromCache()
        : [];
      if (drawable.length) {
        if (progress) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          this.#updateProgress(progress, {
            warning: `Showing cached runs because workflow discovery reported ${
              friendlyError(message)
            }.`,
          });
        }
        return { entries: drawable, exactSelection };
      }
      throw error;
    }
    const history = discovery.runs;
    const selectionFailure = discovery.failure;
    const latest = new Map<number, WorkflowRun>();
    for (const run of history) {
      const current = latest.get(run.id);
      if (!current || run.run_attempt > current.run_attempt) {
        latest.set(run.id, run);
      }
    }
    const requestedRuns = new Map(
      normalized.selectedRuns.map((run) => [run.runId, run.runAttempt]),
    );
    const selected = [...latest.values()]
      .filter((run) =>
        (!requestedRuns.size ||
          (requestedRuns.has(run.id) &&
            run.run_attempt === requestedRuns.get(run.id)!)) &&
        (!normalized.mainOnly ||
          (run.event === "push" &&
            (run.head_branch === undefined || run.head_branch === null ||
              run.head_branch === "main") &&
            (normalized.allConclusions ||
              (run.status === "completed" && run.conclusion === "success"))))
      )
      .sort((a, b) => runTime(b) - runTime(a))
      .slice(0, normalized.limit)
      .filter((run) => run.status === "completed");
    // A chart draws the step detail rather than the index entry, so a run the
    // detail store cannot return is collected again even though the index
    // knows it.
    const entryFor = (run: WorkflowRun): CachedCiRun | undefined =>
      exactSelection
        ? this.#store.get(
          source.repo,
          source.workflow,
          run.id,
          run.run_attempt,
        )
        : this.#store.latest(source.repo, source.workflow, run.id);
    const missing: WorkflowRun[] = [];
    for (const run of selected) {
      const entry = entryFor(run);
      if (
        !await this.#ganttDetailReadable(source, entry) || !entry ||
        (exactSelection
          ? entry.headSha !== normalized.headSha ||
            !hasAttemptAwareGanttTiming(entry)
          : entry.runAttempt < run.run_attempt ||
            !hasAttemptMetadata(entry)) ||
        Boolean(this.#pendingJobsForRun(run, source, exactSelection))
      ) missing.push(run);
    }
    if (progress) {
      this.#updateProgress(progress, {
        phase: "fetching",
        totalRuns: exactSelection
          ? normalized.selectedRuns.length
          : selected.length,
        cachedRuns: selected.length - missing.length,
      });
    }
    // Another collection can finish caching one of these while discovery runs,
    // so the detail is read again next to the decision to spend a request. One
    // attempt at a time, so a chart's worth of timings is never all in memory.
    const detailAvailable = new Set<number>();
    for (const run of missing) {
      if (await this.#ganttDetailReadable(source, entryFor(run))) {
        detailAvailable.add(run.id);
      }
    }
    const outcomes = await inFlight(
      missing,
      JOB_FETCH_CONCURRENCY,
      async (run): Promise<
        | { run: WorkflowRun; entry: CachedCiRun }
        | { run: WorkflowRun; error: unknown }
      > => {
        const load = this.#jobsForRun(run, token, source, now, {
          exactAttempt: exactSelection,
          expectedHeadSha: normalized.headSha,
          hasGanttDetail: detailAvailable.has(run.id),
        });
        if (progress) this.#startJobLoadProgress(progress, load.kind);
        try {
          const outcome = { run, entry: await load.result };
          if (progress) {
            this.#finishJobLoadProgress(progress, load.kind, true);
          }
          return outcome;
        } catch (error) {
          if (progress) {
            this.#finishJobLoadProgress(progress, load.kind, false);
          }
          return { run, error };
        }
      },
      (outcome) =>
        "error" in outcome && outcome.error instanceof CiJobCacheWriteError,
    );
    const failures = outcomes.flatMap((outcome) =>
      "error" in outcome ? [outcome] : []
    );
    const persistenceFailure = failures.find(({ error }) =>
      error instanceof CiJobCacheWriteError
    );
    if (persistenceFailure) throw persistenceFailure.error;
    const quotaFailure = failures.find(({ error }) =>
      error instanceof GitHubRateLimitBudgetError
    );
    const reportedFailure = quotaFailure ?? failures[0];
    if (progress) this.#updateProgress(progress, { phase: "saving" });
    await this.#saveCache(now);
    if (reportedFailure) {
      const message = reportedFailure.error instanceof Error
        ? reportedFailure.error.message
        : String(reportedFailure.error);
      console.error(
        `CI Gantt could not read ${failures.length} run(s); ` +
          `reported run ${reportedFailure.run.id} attempt ${reportedFailure.run.run_attempt}: ${message}`,
      );
    }
    const drawn = selected.flatMap((run) => {
      const entry = exactSelection
        ? this.#store.get(
          source.repo,
          source.workflow,
          run.id,
          run.run_attempt,
        )
        : this.#store.latest(source.repo, source.workflow, run.id);
      if (
        !entry ||
        (exactSelection
          ? entry.headSha !== normalized.headSha ||
            !hasAttemptAwareGanttTiming(entry)
          : entry.runAttempt < run.run_attempt ||
            !hasAttemptMetadata(entry))
      ) return [];
      return [entry];
    });
    if (exactSelection) {
      if (selectionFailure) {
        throw selectionFailure.error instanceof Error
          ? selectionFailure.error
          : new Error(String(selectionFailure.error));
      }
      if (reportedFailure) {
        throw reportedFailure.error instanceof Error
          ? reportedFailure.error
          : new Error(String(reportedFailure.error));
      }
      if (selected.length !== normalized.selectedRuns.length) {
        throw new Error(
          "Every selected CI run must be a completed successful main push.",
        );
      }
      if (drawn.length !== selected.length) {
        throw new Error("Not every selected CI run has cached job timings.");
      }
    }
    const fallback = drawn.length || !cachedRuns.length
      ? []
      : await drawableFromCache();
    const available = drawn.length ? drawn : fallback.length ? fallback : null;
    if (!available) {
      if (reportedFailure) {
        throw reportedFailure.error instanceof Error
          ? reportedFailure.error
          : new Error(String(reportedFailure.error));
      }
      throw new Error(
        "No completed CI runs with cached job timings were available.",
      );
    }
    if (progress && reportedFailure) {
      const message = reportedFailure.error instanceof Error
        ? reportedFailure.error.message
        : String(reportedFailure.error);
      this.#updateProgress(progress, {
        warning: `${failures.length} run check${
          failures.length === 1 ? "" : "s"
        } reported ${
          friendlyError(message)
        }; the chart uses available cached responses.`,
      });
    }
    return { entries: available, exactSelection };
  }

  startGantt(
    token: string | undefined,
    source: CiHistorySource,
    options: CiGanttOptions,
    now = Date.now(),
  ): CiGanttRefresh {
    const normalized = normalizedGanttOptions(options);
    const key = `gantt:${source.key}:${normalized.limit}:${
      normalized.mainOnly ? "main" : "all"
    }:${
      normalized.allConclusions ? "all-conclusions" : "successful"
    }:${normalized.headSha}:${
      normalized.selectedRuns.map(({ runId, runAttempt }) =>
        `${runId}:${runAttempt}`
      ).join(",")
    }`;
    const active = this.#ganttRequests.get(key);
    if (active) {
      return {
        progress: { ...active.progress.state },
        result: active.result,
      };
    }

    const progress = this.#newProgress(
      source,
      CI_HISTORY_DAYS,
      undefined,
      key,
    );
    const request: CiGanttRequest = {
      progress,
      result: Promise.resolve({ entries: [], exactSelection: false }),
    };
    request.result = Promise.resolve()
      .then(() =>
        this.#collectGantt(
          token,
          source,
          normalized,
          now,
          undefined,
          progress,
        )
      )
      .then((result) => {
        this.#updateProgress(progress, { phase: "complete" });
        return result;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#updateProgress(progress, {
          phase: "error",
          error: friendlyError(message),
        });
        throw error;
      })
      .finally(() => {
        if (this.#ganttRequests.get(key) === request) {
          this.#ganttRequests.delete(key);
        }
      });
    this.#ganttRequests.set(key, request);
    return { progress: { ...progress.state }, result: request.result };
  }

  startRefresh(
    token: string,
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
    baseline?: CiJobHistorySnapshot | null,
  ): CiJobRefresh {
    const key = snapshotKey(source, days);
    const latest = this.snapshot(source, days);
    const persistedRefresh = this.#store.freshRefresh(
      source.repo,
      source.workflow,
      days,
    );
    const refreshed = this.#refreshedAt.get(key) ??
      (persistedRefresh
        ? {
          at: persistedRefresh.refreshedAt,
          revision: this.#store.revisionFor(
            source.repo,
            source.workflow,
          ),
        }
        : undefined);
    const sourceRefreshActive = [...this.#refreshRequests.keys()].some(
      (refreshKey) => refreshKey.startsWith(`${source.key}:`),
    );
    if (
      latest && refreshed && !sourceRefreshActive &&
      refreshed.revision === this.#store.revisionFor(
          source.repo,
          source.workflow,
        ) &&
      Date.now() - refreshed.at >= 0 &&
      Date.now() - refreshed.at < REFRESH_MS
    ) {
      return {
        progress: null,
        result: Promise.resolve(inRequestedWindow(latest, Date.now(), days)),
      };
    }
    let request = this.#refreshRequests.get(key);
    if (request) {
      const progress = this.#progressByKey.get(key);
      if (progress && baseline !== undefined) {
        progress.baselines.add(snapshotFingerprint(baseline));
      }
      return {
        progress: progress ? { ...progress.state } : null,
        result: request,
      };
    }
    const now = Date.now();
    const progress = this.#newProgress(source, days, baseline);
    request = this.#runsForRefresh(token, source, now, progress)
      .then((runs) => this.collect(token, now, source, days, runs, progress))
      .then(async (collectedValue) => {
        let value = collectedValue;
        const refreshedAt = Date.now();
        const previousRefresh = this.#store.refresh(
          source.repo,
          source.workflow,
          days,
        );
        const samplingVersion = this.#samplingVersions.has(key)
          ? this.#samplingVersions.get(key)!
          : CI_JOB_HISTORY_SAMPLING_VERSION;
        const expectedRefresh = {
          repo: source.repo,
          workflow: source.workflow,
          days,
          refreshedAt,
          ...(samplingVersion === null ? {} : { samplingVersion }),
          successfulRunTimes: [...(value.successfulRunTimes ?? [])].filter(
            Number.isFinite,
          ).sort((a, b) => a - b),
          sampledRuns: (this.#sampledRuns.get(key) ?? []).map((run) => ({
            ...run,
          })),
          failedRunCount: value.failedRunCount,
          failedRunTimes: [...value.failedRunTimes].filter(Number.isFinite)
            .sort((a, b) => a - b),
          stale: value.stale,
        };
        this.#store.markRefreshed(
          source.repo,
          source.workflow,
          days,
          refreshedAt,
          value.successfulRunTimes ?? [],
          this.#sampledRuns.get(key) ?? [],
          value.failedRunCount,
          value.failedRunTimes,
          value.stale,
          samplingVersion,
        );
        try {
          await this.#saveCache(now);
        } catch (error) {
          this.#store.restoreRefresh(
            source.repo,
            source.workflow,
            days,
            previousRefresh,
          );
          throw error;
        }
        const persistedRefresh = this.#store.refresh(
          source.repo,
          source.workflow,
          days,
        );
        if (!persistedRefresh) {
          throw new Error("CI job history refresh manifest was not persisted.");
        }
        if (
          JSON.stringify(persistedRefresh) !== JSON.stringify(expectedRefresh)
        ) {
          this.#snapshotRevisions.delete(key);
          value = await this.cached(source, days, Date.now()) ?? value;
        }
        const persistedFreshRefresh = this.#store.freshRefresh(
          source.repo,
          source.workflow,
          days,
        );
        if (persistedFreshRefresh) {
          this.#refreshedAt.set(key, {
            at: persistedFreshRefresh.refreshedAt,
            revision: this.#store.revisionFor(source.repo, source.workflow),
          });
        } else this.#refreshedAt.delete(key);
        const fingerprint = snapshotFingerprint(value);
        this.#refreshFailureAt.delete(source.key);
        this.#refreshFailureError.delete(key);
        this.#updateProgress(progress, {
          phase: "complete",
          needsReload: [...progress.baselines].some((value) =>
            value !== fingerprint
          ),
        });
        return value;
      })
      .catch(async (error) => {
        let reportedError = error;
        if (error instanceof GitHubRateLimitBudgetError) {
          this.#store.invalidateRefresh(
            source.repo,
            source.workflow,
            days,
          );
          this.#refreshedAt.delete(key);
          try {
            await this.#saveCache(Date.now());
          } catch (persistenceError) {
            reportedError = persistenceError;
          }
        }
        this.#refreshFailureAt.set(source.key, Date.now());
        const message = reportedError instanceof Error
          ? reportedError.message
          : String(reportedError);
        const safeMessage = friendlyError(message);
        this.#refreshFailureError.set(key, safeMessage);
        console.error(
          `CI job history refresh failed for ${source.repo}:`,
          message,
        );
        this.#updateProgress(progress, {
          phase: "error",
          error: safeMessage,
        });
        throw reportedError;
      })
      .finally(() => this.#refreshRequests.delete(key));
    this.#refreshRequests.set(key, request);
    return { progress: { ...progress.state }, result: request };
  }

  startRefreshForCheck(
    token: string,
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
    baseline?: CiJobHistorySnapshot | null,
  ): CiJobRefresh | null {
    if (this.#refreshRequests.has(snapshotKey(source, days))) {
      return this.startRefresh(token, source, days, baseline);
    }
    const failedAt = this.#refreshFailureAt.get(source.key);
    const age = failedAt === undefined ? -1 : Date.now() - failedAt;
    if (
      failedAt !== undefined && age >= 0 && age < REFRESH_MS
    ) return null;
    return this.startRefresh(token, source, days, baseline);
  }

  lastRefreshError(
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
  ): string | null {
    return this.#refreshFailureError.get(snapshotKey(source, days)) ?? null;
  }

  async refresh(
    token: string,
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
  ): Promise<CiJobHistorySnapshot> {
    return await this.startRefresh(token, source, days).result;
  }
}

const productionStore = new CiJobHistoryStore();
const productionDetail = new CiGanttDetailStore(() =>
  ganttDetailDirectory(productionStore.file)
);
const productionCollector = new CiJobHistoryCollector(
  productionStore,
  performanceGithub,
  productionDetail,
);
const commitGanttCollector = new CiJobHistoryCollector(
  productionStore,
  github,
  productionDetail,
);

// Collects a chart and writes the renderer's input file, without ever holding
// more than one run's timings. Concurrent requests for the same chart share the
// collection; each writes its own file from the shared list of runs.
async function writeGanttInput(
  collector: CiGanttProvider,
  source: CiHistorySource,
  options: CiGanttOptions,
  destination: string,
  token: string | undefined,
): Promise<number> {
  const selection = await collector.startGantt(token, source, options).result;
  return await collector.writeGanttInput(source, selection, destination);
}

export function collectCiGanttInput(
  source: CiHistorySource,
  options: CiGanttOptions,
  destination: string,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
  collector: CiGanttProvider = productionCollector,
): Promise<number> {
  return writeGanttInput(collector, source, options, destination, token);
}

export function collectCommitCiGanttInput(
  source: CiHistorySource,
  options: CiGanttOptions,
  destination: string,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
  collector: CiGanttProvider = commitGanttCollector,
): Promise<number> {
  return writeGanttInput(collector, source, options, destination, token);
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function shortShardName(series: CiJobSeries): string {
  const prefix = `${series.base} (`;
  return series.name.startsWith(prefix) && series.name.endsWith(")")
    ? series.name.slice(prefix.length, -1)
    : series.name;
}

interface RenderedSeries {
  series: CiJobSeries;
  pct: number;
  status: ReturnType<typeof trendStatus>;
  spark: string;
  span: string;
  latest: CiJobPoint;
  trend: string;
}

function renderSeries(
  series: CiJobSeries,
  axisStart: number,
  axisEnd: number,
): RenderedSeries {
  const times = series.points.map((point) => point.at);
  const values = series.points.map((point) => point.seconds);
  const pct = trendPct(times, values);
  const trendDays = distinctTrendDays(times, values);
  const status = trendDays >= 7 ? trendStatus(pct) : "unknown";
  const axisSpan = axisEnd - axisStart || 1;
  const xs = times.map((at) => (at - axisStart) / axisSpan);
  const spark = sparkline(
    values,
    CHART_LINE,
    undefined,
    true,
    xs,
    {
      trim: PERFORMANCE_HISTORY_SCALE_TRIM,
      minValues: PERFORMANCE_HISTORY_SCALE_MIN_VALUES,
    },
  );
  const pointSpan = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  return {
    series,
    pct,
    status,
    spark,
    span: pointSpan > 0 ? durationTag(pointSpan) : "",
    latest: series.points[series.points.length - 1],
    trend: trendDays >= 7 ? trendPctLabel(pct) : "new",
  };
}

function rowHtml(
  row: RenderedSeries,
  label: string,
  detail: string,
): string {
  const latest = row.latest;
  const summary = `${label}: ${formatDuration(latest.seconds)} in its latest ` +
    `available sample on ${dateLabel(latest.at)}, ${row.trend} over ` +
    `${row.series.points.length} sampled runs.`;
  return `<div class="crow ${row.status}${
    row.series.kind === "group"
      ? " aggregate"
      : row.series.kind === "overall"
      ? " overall"
      : ""
  }" data-kind="${row.series.kind}">` +
    `<div class="cspark">${row.spark}${row.span}</div>` +
    `<div class="cmeta"><span class="cname">${escapeHtml(label)}</span>` +
    `<span class="cdetail">${escapeHtml(detail)} · last seen ${
      escapeHtml(dateLabel(latest.at))
    }</span></div>` +
    `<a class="cval" href="${escapeHtml(latest.runUrl)}" target="_blank" ` +
    `rel="noopener">${formatDuration(latest.seconds)}` +
    `<span class="ctrend">${
      escapeHtml(row.trend)
    } · ${row.series.points.length} runs</span></a>` +
    `<span class="sr-only">${escapeHtml(summary)}</span></div>`;
}

const dateLabel = (at: number): string =>
  new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

interface CiHistoryPageOptions {
  source?: CiHistorySource;
  days?: number;
  runtimeStat?: string;
  progress?: CiJobFetchProgress;
  lastRequestError?: string;
  fragment?: boolean;
}

interface CiFetchProgressPanelOptions {
  ariaLabel?: string;
  checkUrl?: string;
  snapshotVersion?: string;
  refreshOnComplete?: boolean;
  progressUrl?: string;
  lastRequestError?: string;
}

export function ciFetchProgressPanel(
  progress?: CiJobFetchProgress | null,
  options: CiFetchProgressPanelOptions = {},
): string {
  const progressIdle = !progress || progress.phase === "complete" ||
    progress.phase === "error";
  const lastRequestError = progress?.phase === "error"
    ? progress.error ?? "unknown error"
    : !progress
    ? options.lastRequestError
    : undefined;
  const progressTitle = progressIdle
    ? "Idle"
    : progress.phase === "discovering"
    ? "Finding workflow runs…"
    : `${progress.completedRuns} of ${progress.totalRuns} run checks complete`;
  const progressTotal = progressIdle
    ? "0 outstanding"
    : progress.phase === "discovering"
    ? `${progress.discoveryOutstandingRequests} outstanding`
    : `${progress.completedRuns} / ${progress.totalRuns || "?"}`;
  const progressDetail = lastRequestError
    ? `Last collection stopped: ${escapeHtml(lastRequestError)}`
    : progressIdle && progress?.warning
    ? escapeHtml(progress.warning)
    : !progressIdle && progress?.phase === "discovering"
    ? `${progress.discoveryRequestsMade} workflow requests made · ${progress.discoveryResponsesReceived} responded · ${progress.discoveryOutstandingRequests} outstanding`
    : !progressIdle && progress
    ? `${progress.cachedRuns} cached · ${progress.requestsMade} run requests made · ${progress.sharedRequests} shared · ${
      progress.responsesReceived + progress.sharedResponses
    } responded · ${progress.outstandingRequests} outstanding · ${progress.queuedRuns} queued`
    : "No requests in progress.";
  const attributes = [
    options.checkUrl ? `data-check-url="${escapeHtml(options.checkUrl)}"` : "",
    options.snapshotVersion !== undefined
      ? `data-snapshot-version="${escapeHtml(options.snapshotVersion)}"`
      : "",
    options.refreshOnComplete !== undefined
      ? `data-refresh-on-complete="${options.refreshOnComplete ? "1" : "0"}"`
      : "",
    options.progressUrl
      ? `data-progress-url="${escapeHtml(options.progressUrl)}"`
      : "",
    lastRequestError
      ? `data-last-request-error="${escapeHtml(lastRequestError)}"`
      : "",
  ].filter(Boolean).join(" ");
  return `<section class="fetch-progress${
    lastRequestError
      ? " error"
      : progressIdle && progress?.warning
      ? " warning"
      : ""
  }" id="fetch-progress" aria-live="polite"${
    attributes ? ` ${attributes}` : ""
  }><div class="fetch-head"><strong id="fetch-title">${progressTitle}</strong><span id="fetch-total">${progressTotal}</span></div><progress id="fetch-bar" max="${
    progressIdle ? 1 : Math.max(1, progress?.totalRuns ?? 1)
  }"${
    !progressIdle && progress && !progress.totalRuns
      ? ""
      : ` value="${progressIdle ? 0 : progress?.completedRuns ?? 0}"`
  } aria-label="${
    escapeHtml(options.ariaLabel ?? "CI history fetch progress")
  }"></progress><p id="fetch-detail">${progressDetail}</p></section>`;
}

function ciPageHref(
  source: CiHistorySource,
  days: number,
  sort: string,
  runtimeStat?: string,
): string {
  const params = new URLSearchParams({
    view: "ci",
    repo: source.key,
    days: String(days),
    sort,
  });
  if (runtimeStat) params.set("stat", runtimeStat);
  return `/bench?${escapeHtml(params.toString())}`;
}

export function ciJobHistoryPage(
  snapshot: CiJobHistorySnapshot | null,
  sortMode: string,
  refreshError?: string,
  options: CiHistoryPageOptions = {},
): string {
  const source = options.source ?? CI_HISTORY_SOURCES.labs;
  const days = options.days ?? CI_HISTORY_DAYS;
  const runtimeStat = options.runtimeStat;
  const progress = options.progress;
  const progressActive = progress && progress.phase !== "complete" &&
    progress.phase !== "error";
  const sort = sortMode === "trend" || sortMode === "duration"
    ? sortMode
    : "job";
  let body: string;
  const hasSeries = snapshot &&
    (snapshot.overall || snapshot.groups.length > 0 ||
      snapshot.jobs.length > 0);
  if (!snapshot || snapshot.runCount === 0 || !hasSeries) {
    if (progressActive) {
      body = "";
    } else {
      const message = refreshError ??
        (snapshot?.failedRunCount
          ? `CI job timings could not be read for ${snapshot.failedRunCount} sampled run${
            snapshot.failedRunCount === 1 ? "" : "s"
          }.`
          : "No completed CI job timings were found in the history window.");
      body = `<p class="empty">${escapeHtml(message)}</p>`;
    }
  } else {
    const rendered = new Map<CiJobSeries, RenderedSeries>();
    const get = (series: CiJobSeries) => {
      let row = rendered.get(series);
      if (!row) {
        row = renderSeries(series, snapshot.axisStart, snapshot.axisEnd);
        rendered.set(series, row);
      }
      return row;
    };
    const axis = `<div class="axisrow"><div class="timeaxis"><span>${
      dateLabel(snapshot.axisStart)
    }</span><span>${dateLabel(snapshot.axisEnd)}</span></div></div>`;
    if (sort === "trend" || sort === "duration") {
      const rows = [
        ...(snapshot.overall ? [get(snapshot.overall)] : []),
        ...snapshot.groups.flatMap((group) => [
          get(group.aggregate),
          ...group.shards.map(get),
        ]),
        ...snapshot.jobs.map(get),
      ].sort((a, b) => {
        const difference = sort === "duration"
          ? b.latest.seconds - a.latest.seconds
          : b.pct - a.pct;
        return difference || a.series.name.localeCompare(b.series.name);
      });
      body = `${axis}<div class="clist">${
        rows.map((row) => {
          const group = snapshot.groups.find((item) =>
            item.base === row.series.base
          );
          const label = row.series.kind === "overall"
            ? "Overall CI"
            : row.series.kind === "group"
            ? `${row.series.base} — slowest of up to ${
              group?.maxConcurrent ?? 0
            } shards`
            : row.series.name;
          return rowHtml(
            row,
            label,
            row.series.kind === "overall"
              ? "First job start to last job completion"
              : row.series.kind === "group"
              ? "Slowest shard duration"
              : "Individual job",
          );
        }).join("")
      }</div>`;
    } else {
      const overall = snapshot.overall
        ? `<section class="overall-section"><h2>Workflow <span>end-to-end wall time</span></h2><div class="clist">${
          rowHtml(
            get(snapshot.overall),
            "Overall CI",
            "First job start to last job completion",
          )
        }</div></section>`
        : "";
      const sections = snapshot.groups.map((group) =>
        `<section><h2>${
          escapeHtml(group.base)
        } <span>up to ${group.maxConcurrent} concurrent${
          group.shards.length === group.maxConcurrent
            ? ""
            : ` · ${group.shards.length} historical variants`
        }</span></h2>` +
        `<div class="clist">${
          rowHtml(
            get(group.aggregate),
            "longest-running shard",
            "Slowest shard duration",
          )
        }${
          group.shards.map((series) =>
            rowHtml(get(series), shortShardName(series), "Individual shard")
          ).join("")
        }</div></section>`
      ).join("");
      const jobs = snapshot.jobs.length
        ? `<section><h2>Unsharded jobs <span>${snapshot.jobs.length} jobs</span></h2>` +
          `<div class="clist">${
            snapshot.jobs.map((series) =>
              rowHtml(get(series), series.name, "Individual job")
            ).join("")
          }</div></section>`
        : "";
      body = `${axis}${overall}${sections}${jobs}`;
    }
  }

  const notices: string[] = [];
  if (refreshError && snapshot?.runCount) {
    notices.push(`Showing the last collected data. ${refreshError}`);
  }
  if (snapshot?.failedRunCount && snapshot.runCount) {
    notices.push(
      `${
        snapshot.stale
          ? "Showing the last collected data"
          : "Showing partial data"
      }. ` +
        `${snapshot.failedRunCount} sampled run${
          snapshot.failedRunCount === 1 ? "" : "s"
        } could not be read.`,
    );
  }
  const refreshNotice = notices.map((notice) =>
    `<p class="refresh-error">${escapeHtml(notice)}</p>`
  ).join("");
  const viewNav = performanceViewNav("ci", {
    repo: source.key,
    days,
    sort,
    stat: runtimeStat ?? "p99",
  });
  const workflowUrl =
    `https://github.com/${source.repo}/actions/workflows/${source.workflow}?query=branch%3Amain`;
  const version = ciJobHistorySnapshotVersion(snapshot);
  const checkParams = new URLSearchParams({
    view: "ci",
    repo: source.key,
    days: String(days),
  });
  const checkUrl = `/bench/check?${checkParams.toString()}`;
  const progressUrl = progress
    ? `/bench/ci-progress?id=${encodeURIComponent(progress.id)}`
    : "";
  const progressHtml = ciFetchProgressPanel(progress, {
    checkUrl,
    snapshotVersion: version,
    refreshOnComplete: Boolean(
      progressActive && (!snapshot || snapshot.runCount === 0 || !hasSeries),
    ),
    progressUrl,
    lastRequestError: options.lastRequestError,
  });
  const coverageHtml = snapshot
    ? `<p class="coverage">Coverage: ${snapshot.runCount} sampled build${
      snapshot.runCount === 1 ? "" : "s"
    } shown${
      snapshot.successfulRunTimes === null
        ? ""
        : ` out of ${snapshot.successfulRunTimes.length} successful main build${
          snapshot.successfulRunTimes.length === 1 ? "" : "s"
        }`
    }.</p>`
    : "";
  const rangeContent = `<div id="range-content">
    ${progressHtml}${coverageHtml}
    <p class="legend">Job start-to-finish duration. Overall CI runs from the first job start to the last job completion. A shard group's line is the longest-running shard in each run. Lower is faster; color follows the selected ${days}-day trend. Duration sort uses the latest sample.</p>
    ${refreshNotice}${body}
    <p class="note">Every successful main run is sampled when the selected window contains at most ${CI_HISTORY_POINT_TARGET}. Larger sets keep exactly ${CI_HISTORY_POINT_TARGET} builds spread evenly through the chronological run sequence from <a href="${
    escapeHtml(workflowUrl)
  }" target="_blank" rel="noopener">${
    escapeHtml(source.workflow)
  } runs ↗</a>. Values come from GitHub's job start and completion times. The detailed Gantt uses the same cached runs.</p>
  </div>`;
  if (options.fragment) return rangeContent;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CI job history</title>
${DASHBOARD_THEME_HEAD}
<style>
  ${PERFORMANCE_VIEW_STYLES}
  .coverage{font-size:11px;color:var(--text-secondary);font-variant-numeric:tabular-nums;margin:0 0 12px}
  h2 span{font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-weight:400;color:var(--text-faint);margin-left:6px}
  .crow.aggregate{border-left-width:4px}
  .crow.overall{border-left:4px solid var(--accent)}.overall-section{margin-bottom:20px}
  .cdetail{font-size:11px;color:var(--text-subtle)}
  .cval{flex:none;display:flex;flex-direction:column;align-items:flex-end;text-decoration:none}
  body.hide-green .crow.good{display:none}body.hide-green section:has(.clist):not(:has(.crow:not(.good))){display:none}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  @media(max-width:640px){.cmeta{flex:1 1 55%}.cval{font-size:16px}}
</style></head><body>
  <div class="top"><a class="back" href="/">← dashboard</a><b>Performance history</b><span>${
    escapeHtml(source.repo)
  } · ${escapeHtml(source.workflow)}</span></div>
  ${viewNav}
  <form class="controls" method="get" action="/bench"><input type="hidden" name="view" value="ci"><input type="hidden" name="sort" value="${sort}">${
    runtimeStat
      ? `<input type="hidden" name="stat" value="${escapeHtml(runtimeStat)}">`
      : ""
  }<label class="field">repository <select id="repo" name="repo"><option value="labs"${
    source.key === "labs" ? " selected" : ""
  }>labs</option><option value="loom"${
    source.key === "loom" ? " selected" : ""
  }>loom</option></select></label><label class="field" for="days">window <output id="daysv" for="days">${days} day${
    days === 1 ? "" : "s"
  }</output><input type="range" id="days" name="days" min="${CI_HISTORY_MIN_DAYS}" max="${CI_HISTORY_DAYS}" step="1" value="${days}"></label><nav class="choice-group" aria-label="Sort CI history"><span class="lbl">sort</span><a class="${
    sort === "job" ? "on" : ""
  }" href="${ciPageHref(source, days, "job", runtimeStat)}"${
    sort === "job" ? ' aria-current="true"' : ""
  }>job</a><a class="${sort === "duration" ? "on" : ""}" href="${
    ciPageHref(source, days, "duration", runtimeStat)
  }"${
    sort === "duration" ? ' aria-current="true"' : ""
  }>duration</a><a class="${sort === "trend" ? "on" : ""}" href="${
    ciPageHref(source, days, "trend", runtimeStat)
  }"${
    sort === "trend" ? ' aria-current="true"' : ""
  }>trend</a></nav><label class="check trailing"><input type="checkbox" id="hg"> hide green</label></form>
  ${rangeContent}
${dashboardThemeToggle()}
${DASHBOARD_THEME_CLIENT}
<script>
  const hg = document.getElementById("hg"), days = document.getElementById("days"), daysv = document.getElementById("daysv"), repo = document.getElementById("repo"), controls = days.form, KEY = "ciJobsHideGreen", DEFAULT_DAYS = days.value;
  let rangeContent = document.getElementById("range-content"), fetchProgress = document.getElementById("fetch-progress"), title = document.getElementById("fetch-title"), total = document.getElementById("fetch-total"), detail = document.getElementById("fetch-detail"), bar = document.getElementById("fetch-bar"), pageVersion = fetchProgress.dataset.snapshotVersion, appliedDays = days.value;
  let navigating = false, pendingRefresh = false, checking = false, eventStream = null, connectedProgressUrl = "", serverVersionChanged = false, collectionFailed = false, transportFailed = false, rangeRequest = null, rangeRequestDays = "", rangeSequence = 0, viewRevision = 0;
  const apply = () => document.body.classList.toggle("hide-green", hg.checked);
  hg.checked = sessionStorage.getItem(KEY) === "1";
  apply();
  hg.addEventListener("change", () => {
    sessionStorage.setItem(KEY, hg.checked ? "1" : "0");
    apply();
  });
  const syncDayLinks = () => {
    for (const link of document.querySelectorAll('a[href^="/bench?"]')) {
      const target = new URL(link.href);
      target.searchParams.set("days", days.value);
      link.href = target.pathname + "?" + target.searchParams.toString();
    }
  };
  days.addEventListener("input", () => {
    daysv.value = days.value + (days.value === "1" ? " day" : " days");
    syncDayLinks();
  });
  const applyDays = () => {
    if (days.value !== appliedDays) {
      if (!rangeRequest || rangeRequestDays !== days.value) void loadRange("push");
    } else if (rangeRequest && rangeRequestDays !== days.value) {
      void loadRange("restore");
    } else if (pendingRefresh && !rangeRequest) {
      pendingRefresh = false;
      void loadRange("refresh");
    }
  };
  days.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyDays();
    }
  });
  days.addEventListener("change", applyDays);
  const isSameTabLink = (event, link) =>
    link.target !== "_blank" && event.button === 0 && !event.metaKey &&
    !event.ctrlKey && !event.shiftKey && !event.altKey;
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (link && isSameTabLink(event, link)) navigating = true;
  }, true);
  controls.addEventListener("submit", () => navigating = true);
  window.addEventListener("pagehide", () => {
    navigating = true;
    rangeRequest?.abort();
    eventStream?.close();
  });
  repo.addEventListener("change", () => repo.form.requestSubmit());

  const renderIdle = (lastRequestError = fetchProgress.dataset.lastRequestError || "") => {
    collectionFailed = Boolean(lastRequestError);
    transportFailed = false;
    if (lastRequestError) {
      fetchProgress.dataset.lastRequestError = lastRequestError;
    } else delete fetchProgress.dataset.lastRequestError;
    fetchProgress.classList.toggle("error", collectionFailed);
    title.textContent = "Idle";
    total.textContent = "0 outstanding";
    bar.max = 1;
    bar.value = 0;
    detail.textContent = lastRequestError
      ? "Last collection stopped: " + lastRequestError
      : "No requests in progress.";
  };
  const refreshRangeWhenIdle = () => {
    if (navigating) return;
    if (
      days.value !== appliedDays || rangeContent.contains(document.activeElement) ||
      rangeRequest
    ) {
      pendingRefresh = true;
      return;
    }
    void loadRange("refresh");
  };
  document.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (
        pendingRefresh && !navigating && !rangeRequest &&
        !rangeContent.contains(document.activeElement)
      ) {
        pendingRefresh = false;
        refreshRangeWhenIdle();
      }
    });
  });
  const renderProgress = (state) => {
    collectionFailed = state.phase === "error";
    transportFailed = false;
    fetchProgress.classList.remove("error");
    if (collectionFailed) {
      fetchProgress.dataset.lastRequestError = state.error || "unknown error";
    } else delete fetchProgress.dataset.lastRequestError;
    if (state.phase === "discovering") {
      title.textContent = "Finding workflow runs…";
      total.textContent = state.discoveryOutstandingRequests + " outstanding";
      bar.removeAttribute("value");
      detail.textContent = state.discoveryRequestsMade + " workflow requests made · " +
        state.discoveryResponsesReceived + " responded · " +
        state.discoveryOutstandingRequests + " outstanding";
    } else {
      title.textContent = state.phase === "saving"
        ? "Saving completed responses…"
        : state.completedRuns + " of " + state.totalRuns + " run checks complete";
      total.textContent = state.completedRuns + " / " + state.totalRuns;
      bar.max = Math.max(1, state.totalRuns);
      bar.value = state.completedRuns;
      detail.textContent = state.cachedRuns + " cached · " +
        state.requestsMade + " run requests made · " +
        state.sharedRequests + " shared · " +
        (state.responsesReceived + state.sharedResponses) + " responded · " +
        state.outstandingRequests + " outstanding · " +
        state.queuedRuns + " queued" +
        (state.failedResponses ? " · " + state.failedResponses + " failed" : "");
    }
    if (state.phase === "error") {
      fetchProgress.classList.add("error");
      title.textContent = "Idle";
      total.textContent = "0 outstanding";
      bar.max = 1;
      bar.value = 0;
      detail.textContent = "Last collection stopped: " +
        fetchProgress.dataset.lastRequestError;
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
    } else if (state.phase === "complete") {
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
      if (state.needsReload || serverVersionChanged || fetchProgress.dataset.refreshOnComplete === "1") refreshRangeWhenIdle();
      else renderIdle();
    }
  };
  const connectProgress = (url) => {
    if (!url || connectedProgressUrl === url) return;
    eventStream?.close();
    connectedProgressUrl = url;
    const stream = new EventSource(url);
    eventStream = stream;
    stream.addEventListener("progress", (event) => {
      if (eventStream !== stream) return;
      try {
        renderProgress(JSON.parse(event.data));
      } catch {
        stream.close();
        eventStream = null;
        connectedProgressUrl = "";
        transportFailed = true;
        fetchProgress.classList.add("error");
        title.textContent = "Could not read collection progress";
      }
    });
    stream.onerror = () => {
      if (eventStream !== stream) return;
      stream.close();
      eventStream = null;
      connectedProgressUrl = "";
      transportFailed = true;
      fetchProgress.classList.add("error");
      title.textContent = "Progress connection closed; collection continues on the server";
    };
  };
  const checkForUpdates = async () => {
    if (checking || navigating || document.visibilityState === "hidden") return;
    checking = true;
    const revision = viewRevision;
    try {
      const response = await fetch(fetchProgress.dataset.checkUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const state = await response.json();
      if (revision !== viewRevision) return;
      serverVersionChanged ||= state.version !== pageVersion;
      if (state.progress) {
        connectProgress("/bench/ci-progress?id=" + encodeURIComponent(state.progress.id));
        renderProgress(state.progress);
      } else if (serverVersionChanged) refreshRangeWhenIdle();
      else if ("lastRequestError" in state) renderIdle(state.lastRequestError || "");
      else if (!collectionFailed) renderIdle();
    } catch {
      if (!eventStream && !collectionFailed && !transportFailed) renderIdle();
    } finally {
      checking = false;
    }
  };
  const bindRangeContent = () => {
    viewRevision++;
    fetchProgress = rangeContent.querySelector("#fetch-progress");
    title = rangeContent.querySelector("#fetch-title");
    total = rangeContent.querySelector("#fetch-total");
    detail = rangeContent.querySelector("#fetch-detail");
    bar = rangeContent.querySelector("#fetch-bar");
    pageVersion = fetchProgress.dataset.snapshotVersion;
    serverVersionChanged = false;
    collectionFailed = false;
    transportFailed = false;
    connectedProgressUrl = "";
    if (fetchProgress.dataset.progressUrl) connectProgress(fetchProgress.dataset.progressUrl);
    else renderIdle();
  };
  const showRangeLoading = (requestedDays) => {
    rangeContent.setAttribute("aria-busy", "true");
    fetchProgress.classList.remove("error");
    title.textContent = "Loading " + requestedDays + "-day view…";
    total.textContent = "updating";
    bar.removeAttribute("value");
    detail.textContent = "Reading cached history and checking for new CI data.";
  };
  const loadRange = async (mode) => {
    if (navigating) return;
    if (rangeRequest) {
      if (mode === "refresh") {
        pendingRefresh = true;
        return;
      }
      rangeRequest.abort();
    }
    const requestedDays = days.value;
    const url = new URL(location.href);
    url.searchParams.set("days", requestedDays);
    const sequence = ++rangeSequence;
    const controller = new AbortController();
    rangeRequest = controller;
    rangeRequestDays = requestedDays;
    let loaded = false;
    showRangeLoading(requestedDays);
    try {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set("fragment", "range");
      const response = await fetch(requestUrl.pathname + requestUrl.search, {
        cache: "no-store",
        headers: { accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      const replacement = page.getElementById("range-content");
      if (!replacement) throw new Error("Range content was missing from the response.");
      if (sequence !== rangeSequence || navigating) return;
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
      rangeContent.replaceWith(replacement);
      rangeContent = replacement;
      appliedDays = requestedDays;
      const target = url.pathname + url.search;
      if (mode === "push" && target !== location.pathname + location.search) {
        history.pushState(null, "", target);
      }
      bindRangeContent();
      syncDayLinks();
      loaded = true;
    } catch (error) {
      if (controller.signal.aborted || sequence !== rangeSequence) return;
      pendingRefresh = false;
      rangeContent.removeAttribute("aria-busy");
      fetchProgress.classList.add("error");
      title.textContent = "Could not update the history window";
      total.textContent = "0 outstanding";
      bar.max = 1;
      bar.value = 0;
      detail.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === rangeSequence) {
        rangeRequest = null;
        rangeRequestDays = "";
        if (loaded && pendingRefresh) {
          pendingRefresh = false;
          refreshRangeWhenIdle();
        }
      }
    }
  };
  const daysFromLocation = () => {
    const parameter = new URL(location.href).searchParams.get("days");
    if (parameter === null || parameter.trim() === "") return DEFAULT_DAYS;
    const value = Number(parameter);
    if (!Number.isFinite(value)) return DEFAULT_DAYS;
    return String(Math.max(Number(days.min), Math.min(Number(days.max), Math.floor(value))));
  };
  window.addEventListener("popstate", () => {
    days.value = daysFromLocation();
    daysv.value = days.value + (days.value === "1" ? " day" : " days");
    syncDayLinks();
    void loadRange("pop");
  });
  bindRangeContent();
  setInterval(checkForUpdates, ${PERFORMANCE_CHECK_MS});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdates();
  });
</script></body></html>`;
}

export function ciJobHistoryProgressResponse(
  url: URL,
  collector = productionCollector,
): Response {
  const id = url.searchParams.get("id");
  if (!id) return new Response("missing progress id", { status: 400 });
  if (!collector.progress(id)) {
    return new Response("unknown progress id", { status: 404 });
  }
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (progress: CiJobFetchProgress) => {
        if (closed) return;
        controller.enqueue(encoder.encode(
          `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
        ));
        if (progress.phase === "complete" || progress.phase === "error") {
          closed = true;
          controller.close();
          unsubscribe?.();
        }
      };
      unsubscribe = collector.subscribeProgress(id, send) ??
        undefined;
      if (closed) unsubscribe?.();
    },
    cancel() {
      closed = true;
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

function ganttProgressResponse(
  _request: Request,
  url: URL,
  collector: CiJobHistoryCollector,
  token: string | undefined,
): Response {
  const refresh = collector.startGantt(
    token,
    ciHistorySource(url.searchParams.get("repo")),
    ciGanttOptions(url.searchParams),
  );
  void refresh.result.catch(() => {});
  const progressUrl = new URL("http://dashboard/bench/ci-progress");
  progressUrl.searchParams.set("id", refresh.progress.id);
  return ciJobHistoryProgressResponse(progressUrl, collector);
}

export function ciGanttProgressResponse(
  request: Request,
  url: URL,
  collector = productionCollector,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Response {
  return ganttProgressResponse(request, url, collector, token);
}

export function ciCommitGanttProgressResponse(
  request: Request,
  url: URL,
  collector = commitGanttCollector,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Response {
  return ganttProgressResponse(request, url, collector, token);
}

// What the Gantt image routes need of a collector.
type CiGanttProvider = Pick<
  CiJobHistoryCollector,
  "startGantt" | "writeGanttInput"
>;

type CiJobHistoryProvider =
  & Pick<
    CiJobHistoryCollector,
    "cached" | "startRefresh"
  >
  & Partial<
    Pick<
      CiJobHistoryCollector,
      "lastRefreshError" | "startRefreshForCheck"
    >
  >;

export async function ciJobHistoryCheckResponse(
  url: URL,
  collector: CiJobHistoryProvider = productionCollector,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Promise<Response> {
  const source = ciHistorySource(url.searchParams.get("repo"));
  const days = ciHistoryDays(url.searchParams.get("days"));
  let snapshot = await collector.cached(source, days);
  let progress: CiJobFetchProgress | null = null;
  if (token) {
    const refresh = collector.startRefreshForCheck
      ? collector.startRefreshForCheck(token, source, days, snapshot)
      : collector.startRefresh(token, source, days, snapshot);
    if (refresh) {
      progress = refresh.progress;
      if (progress) void refresh.result.catch(() => {});
      else snapshot = await refresh.result;
    }
  }
  const lastRequestError = progress
    ? null
    : collector.lastRefreshError?.(source, days) ?? null;
  return Response.json(
    {
      version: ciJobHistorySnapshotVersion(snapshot),
      progress,
      lastRequestError,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function ciJobHistoryResponse(
  url: URL,
  collector: CiJobHistoryProvider = productionCollector,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Promise<Response> {
  const source = ciHistorySource(url.searchParams.get("repo"));
  const days = ciHistoryDays(url.searchParams.get("days"));
  let snapshot = await collector.cached(source, days);
  let refreshError: string | undefined;
  let progress: CiJobFetchProgress | undefined;
  let lastRequestError: string | undefined;
  if (!token) {
    refreshError = snapshot?.runCount
      ? "Set GH_TOKEN to refresh CI job history."
      : "Set GH_TOKEN to collect CI job history.";
  } else {
    const refresh = collector.startRefresh(token, source, days, snapshot);
    progress = refresh.progress ?? undefined;
    if (progress) void refresh.result.catch(() => {});
    else snapshot = await refresh.result;
  }
  if (!progress) {
    lastRequestError = collector.lastRefreshError?.(source, days) ?? undefined;
  }
  return new Response(
    ciJobHistoryPage(
      snapshot,
      url.searchParams.get("sort") ?? "job",
      refreshError,
      {
        source,
        days,
        runtimeStat: url.searchParams.get("stat") ?? undefined,
        progress,
        lastRequestError,
        fragment: url.searchParams.get("fragment") === "range",
      },
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
