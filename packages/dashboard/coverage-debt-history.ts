/**
 * Collects what each day's `main` runs measured for the repository's whole
 * coverage debt, so a tile can chart the direction it has moved in.
 *
 * The number comes from the `perf-metrics` artifact the Coverage Check job
 * uploads. That artifact records every `coverage-debt: <group> uncovered lines`
 * metric the run measured, and the `workspace` one among them is the
 * repository-wide total. `docs/development/COVERAGE.md` describes how the
 * groups are counted. Nothing else in the repository keeps that number over
 * time, so the history is assembled here a day at a time and kept on disk.
 *
 * One sample a day is enough for a trend measured in weeks, and it bounds what
 * the collection costs: only the newest few runs of a day are opened. Two
 * things disqualify a run. A run whose compile byte cache missed covers
 * branches that only a cold compile reaches, which lowers its debt by around a
 * tenth of a percent — the same size as a week's real movement, and the
 * reason the coverage ratchet skips a cold run too. And a run whose artifact
 * will not parse measured nothing this can read.
 *
 * The runs come from the listing that carries no filter, read newest first and
 * sorted into days here. A listing carrying `branch`, `event`, `status` or
 * `created` is answered from a search index that can return a window of runs
 * weeks old, with a success status and nothing to mark it; a day selected that
 * way can come back empty or stale, and a day that is over is never asked
 * about again, so a wrong answer would stay on the tile until it aged out of
 * the window. Reading one listing for the whole window rather than one per day
 * is what keeps that affordable: a day cannot be seeked to, only paged back
 * to, so a request per day would re-read every page the older days sit behind.
 *
 * A day that has been read keeps its answer, including the answer that it has
 * no usable run, because a day that is over gains no runs. A read that failed
 * establishes nothing and is left for the next collection, and so is a day the
 * listing was not read back far enough to have shown every run of.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";
import { REPO } from "./config.ts";
import { dashboardCacheFile } from "./history-files.ts";
import { type GitHubDownload, jsonFromZip } from "./lib.ts";

/** The workflow whose `main` runs measure coverage. */
export const COVERAGE_WORKFLOW = "deno.yml";

/** The artifact the Coverage Check job uploads its metrics in. */
export const COVERAGE_ARTIFACT = "perf-metrics";

/** The metric holding the repository-wide uncovered-line count. */
export const WORKSPACE_METRIC = "coverage-debt: workspace uncovered lines";

/** Runs of one day opened before the day is given up as unreadable. */
export const RUNS_READ_PER_DAY = 3;

/** Days whose runs are opened at once. */
const FETCH_CONCURRENCY = 8;

/** Runs on one page of the listing: GitHub's maximum. */
const RUNS_PAGE_SIZE = 100;

/**
 * The most pages one refresh reads.
 *
 * A refresh that finds every day but today already answered stops after the
 * page holding today's runs, so this bounds the refresh that has a whole
 * window to fill: the first one after the history file is lost, which pages
 * back as far as the oldest day of the window. It is set above what that
 * takes, so that the days beyond it are the ones no listing reaches rather
 * than the ones this stopped short of. A refresh that spends it says so and
 * leaves the days it did not reach for the next one.
 */
const RUNS_MAX_PAGES = 150;

const DAY_MS = 86_400_000;
/**
 * The shape the history file is written in, bumped when that shape changes. A
 * file the running code cannot read as it was written is discarded whole
 * rather than day by day: a day it half understands reads as a day that
 * measured nothing, and a day that is over is never asked about again, so the
 * window would stay empty until it aged out.
 */
export const STORE_VERSION = 2;

const COVERAGE_DEBT_FILE = () =>
  dashboardCacheFile("fabric-wall-coverage-debt.json");

/** What one day's `main` runs measured. */
export interface CoverageDebtSample {
  /** The UTC day, as `YYYY-MM-DD`. */
  day: string;

  /** Uncovered lines across every tracked source file. */
  uncoveredLines: number;

  /** The run the number was read from. */
  runId: number;
}

/** The GitHub calls the collection makes, so a test can supply its own. */
export interface CoverageDebtGitHub {
  json<T>(path: string, token: string): Promise<T>;
  download(path: string, token: string): Promise<GitHubDownload>;
}

/** What a day's runs came to, when one of them measured. */
interface DayMeasurement {
  uncoveredLines: number;

  /** The run the number was read from. */
  runId: number;
}

interface StoredDay {
  /** Absent when no run of the day carried a usable measurement. */
  measured?: DayMeasurement;

  /**
   * The newest run the day listed when it was last read. Today is read on
   * every refresh, and this is what lets that cost one request when nothing
   * has landed since: the number can only have moved if a run has.
   */
  newestRun?: number;
}

interface StoredHistory {
  version: number;
  days: Record<string, StoredDay>;
}

interface WorkflowRun {
  id: number;

  /** When the run was created, ISO 8601; the day it is sorted into. */
  created_at: string;

  /** The branch the run's head commit is on. */
  head_branch?: string;

  event: string;
  conclusion: string;
}

interface RunArtifact {
  id: number;
  name: string;
  expired: boolean;
}

const isRunId = (value: unknown): boolean =>
  Number.isInteger(value) && (value as number) > 0;

const isMeasurement = (value: unknown): value is DayMeasurement => {
  if (typeof value !== "object" || value === null) return false;
  const measured = value as DayMeasurement;
  return Number.isFinite(measured.uncoveredLines) &&
    measured.uncoveredLines >= 0 && isRunId(measured.runId);
};

const isStoredDay = (value: unknown): value is StoredDay => {
  if (!isObjectOrArray(value)) return false;
  const day = value as StoredDay;
  if (day.newestRun !== undefined && !isRunId(day.newestRun)) return false;
  return day.measured === undefined || isMeasurement(day.measured);
};

const sameDay = (a: StoredDay | undefined, b: StoredDay): boolean =>
  a !== undefined && a.newestRun === b.newestRun &&
  a.measured?.uncoveredLines === b.measured?.uncoveredLines &&
  a.measured?.runId === b.measured?.runId;

/** The UTC day an instant falls in, as `YYYY-MM-DD`. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The `count` UTC days ending at `now`, oldest first. */
export function daysEndingAt(now: number, count: number): string[] {
  const days: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    days.push(utcDay(now - back * DAY_MS));
  }
  return days;
}

/**
 * The repository-wide uncovered-line count a `perf-metrics` file records, or
 * `undefined` when it carries no such metric or was measured on a cold compile
 * cache. Anything the file does not hold in the shape the artifact writes reads
 * as no measurement rather than as a zero.
 */
export function workspaceDebtOf(content: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isObjectOrArray(parsed)) return undefined;
  const file = parsed as {
    metrics?: unknown;
    compileCacheStates?: Record<string, unknown>;
  };
  const states = file.compileCacheStates;
  if (isObjectOrArray(states)) {
    if (Object.values(states).includes("cold")) return undefined;
  }
  if (!Array.isArray(file.metrics)) return undefined;
  for (const metric of file.metrics) {
    if (!isObjectOrArray(metric)) continue;
    const record = metric as { name?: unknown; durationSeconds?: unknown };
    if (record.name !== WORKSPACE_METRIC) continue;
    const lines = record.durationSeconds;
    // The artifact records the count under `durationSeconds`, which is the key
    // the file has carried since it also held CI timings.
    return typeof lines === "number" && Number.isFinite(lines) && lines >= 0
      ? lines
      : undefined;
  }
  return undefined;
}

/** Keeps each day's measurement across dashboard restarts. */
export class CoverageDebtStore {
  #file: string;
  #days = new Map<string, StoredDay>();
  #loaded = false;
  #dirty = false;

  /** Constructs a store over `file`, which need not exist yet. */
  constructor(file: string = COVERAGE_DEBT_FILE()) {
    this.#file = file;
  }

  /** Reads the stored days once; an unreadable file starts an empty history. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    let stored: StoredHistory;
    try {
      stored = JSON.parse(await Deno.readTextFile(this.#file));
    } catch {
      return;
    }
    if (stored?.version !== STORE_VERSION) return;
    if (!isObjectOrArray(stored.days)) return;
    for (const [day, value] of Object.entries(stored.days)) {
      if (isStoredDay(value)) this.#days.set(day, value);
    }
  }

  /** What the day holds, or `undefined` when it has never been read. */
  get(day: string): StoredDay | undefined {
    return this.#days.get(day);
  }

  /** Records what a day's runs measured, or that none of them did. */
  set(day: string, value: StoredDay): void {
    if (sameDay(this.#days.get(day), value)) return;
    this.#days.set(day, value);
    this.#dirty = true;
  }

  /**
   * Forgets every day outside `keep`, then writes the rest. A refresh that
   * changed nothing writes nothing: with the tile polling for a landing every
   * few minutes, most refreshes find the day exactly as they left it.
   */
  async save(keep: readonly string[]): Promise<void> {
    const kept = new Set(keep);
    for (const day of [...this.#days.keys()]) {
      if (!kept.has(day)) {
        this.#days.delete(day);
        this.#dirty = true;
      }
    }
    if (!this.#dirty) return;
    const stored: StoredHistory = {
      version: STORE_VERSION,
      days: Object.fromEntries([...this.#days.entries()].sort()),
    };
    try {
      const temporary = `${this.#file}.tmp`;
      await Deno.writeTextFile(temporary, JSON.stringify(stored));
      await Deno.rename(temporary, this.#file);
      // Only once the file is in place, so a write that failed is written
      // again by the next refresh. Clearing it before the write would leave
      // the store looking saved, and the refresh after a failure usually has
      // nothing of its own to write and would not come back here at all.
      this.#dirty = false;
    } catch (error) {
      console.error(
        "coverage debt: could not persist history:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** What one day's read produced. */
type DayReading =
  | { outcome: "read"; day: StoredDay }
  | { outcome: "unchanged" }
  | { outcome: "unshown" }
  | { outcome: "failed"; error: unknown };

/** The API path of one page of every run of the workflow, newest first. */
function runsPagePath(page: number): string {
  const params = new URLSearchParams({
    per_page: String(RUNS_PAGE_SIZE),
    page: String(page),
    exclude_pull_requests: "true",
  });
  return `repos/${REPO}/actions/workflows/${COVERAGE_WORKFLOW}/runs` +
    `?${params}`;
}

/** Whether a run is one a day's number could be read from. */
function measuresMain(run: WorkflowRun): boolean {
  return run.event === "push" && run.head_branch === "main" &&
    run.conclusion === "success";
}

/** The UTC day a run falls in, or nothing where its date will not read. */
function runDay(run: WorkflowRun): string | undefined {
  const at = Date.parse(run.created_at);
  return Number.isNaN(at) ? undefined : utcDay(at);
}

/** The runs one day of the window holds. */
interface DayRuns {
  /** The day's newest runs, newest first, at most `RUNS_READ_PER_DAY`. */
  runs: WorkflowRun[];

  /**
   * Whether the listing was read back past the start of the day, which is
   * what makes the runs above all of the day's rather than the ones shown so
   * far. Until it is, a day holding fewer than `RUNS_READ_PER_DAY` of them
   * may hold more that a later page would name.
   */
  whole: boolean;
}

/** A day the listing is read for, and what the store already holds of it. */
interface WantedDay {
  day: string;

  /** The newest run the day listed when it was last read. */
  newestRun?: number;
}

/** What reading the listing for a window of days found. */
interface WindowRuns {
  days: Map<string, DayRuns>;

  /** Why the reading stopped early, when a page could not be read. */
  error?: unknown;
}

/**
 * The runs of each day named, read from the listing newest first.
 *
 * It stops once every day named is answered, which is what keeps the usual
 * refresh to one page: a day whose newest run is the one it already held has
 * gained nothing, whatever the rest of the day holds, and the listing is
 * newest first, so the first page a day appears on settles that.
 */
async function readWindowRuns(
  wanted: readonly WantedDay[],
  token: string,
  github: CoverageDebtGitHub,
): Promise<WindowRuns> {
  const days = new Map<string, DayRuns>(
    wanted.map(({ day }) => [day, { runs: [], whole: false }]),
  );
  const seen = new Set<number>();
  const knownNewest = new Map(
    wanted.map(({ day, newestRun }) => [day, newestRun]),
  );
  const answered = (day: string, found: DayRuns) => {
    if (found.whole || found.runs.length === RUNS_READ_PER_DAY) return true;
    const newest = found.runs[0]?.id;
    return newest !== undefined && newest === knownNewest.get(day);
  };
  const settled = () => [...days].every(([day, found]) => answered(day, found));
  const markWholeBefore = (oldest: string) => {
    for (const [day, value] of days) {
      if (day > oldest) value.whole = true;
    }
  };
  for (let page = 1; page <= RUNS_MAX_PAGES; page++) {
    let listed: { workflow_runs?: WorkflowRun[] };
    try {
      listed = await github.json(runsPagePath(page), token);
    } catch (error) {
      return { days, error };
    }
    const runs = listed.workflow_runs ?? [];
    for (const run of runs) {
      // A run created while the pages are being read pushes the ones behind
      // it down a place, so the run that ended a page is listed again at the
      // head of the next. Taken twice it holds two of the day's places, and
      // a day whose repeated run measures nothing would lose the older run
      // that measured to it — and then be recorded as measuring nothing.
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      if (!measuresMain(run)) continue;
      const at = runDay(run);
      const day = at === undefined ? undefined : days.get(at);
      if (day !== undefined && day.runs.length < RUNS_READ_PER_DAY) {
        day.runs.push(run);
      }
    }
    if (runs.length < RUNS_PAGE_SIZE) {
      // The listing ended, so every run it holds has been shown.
      for (const day of days.values()) day.whole = true;
      return { days };
    }
    // The listing is newest first, so a day newer than the page's last run
    // is one every run of has been shown. A last run with no usable date
    // says where the page reached back to no better than the page before it.
    const reached = runDay(runs[runs.length - 1]);
    if (reached !== undefined) markWholeBefore(reached);
    if (settled()) return { days };
  }
  console.warn(
    `coverage debt: read ${RUNS_MAX_PAGES} pages of runs without reaching ` +
      `${wanted[0]?.day}; the days it did not reach are left for a later ` +
      "refresh.",
  );
  return { days };
}

async function readArtifact(
  artifactId: number,
  token: string,
  github: CoverageDebtGitHub,
): Promise<number | undefined> {
  // GitHub answers with a redirect to a signed blob URL, which the download
  // follows; the archive holds the one JSON file the job uploaded.
  const zip = await github.download(
    `repos/${REPO}/actions/artifacts/${artifactId}/zip`,
    token,
  );
  if (!zip.ok) throw new Error(`artifact ${artifactId}: HTTP ${zip.status}`);
  const json = await jsonFromZip(zip.body);
  return json === null ? undefined : workspaceDebtOf(json);
}

async function readDay(
  found: DayRuns,
  token: string,
  github: CoverageDebtGitHub,
  known: StoredDay | undefined,
): Promise<DayReading> {
  try {
    const runs = found.runs;
    const newestRun = runs[0]?.id;
    // Nothing has landed since the day was last read, so nothing can have
    // measured a different number. This is what a refresh that finds the tree
    // where it left it costs beyond the listing itself.
    if (newestRun !== undefined && newestRun === known?.newestRun) {
      return { outcome: "unchanged" };
    }
    for (const run of runs) {
      const artifacts = await github.json<{ artifacts?: RunArtifact[] }>(
        `repos/${REPO}/actions/runs/${run.id}/artifacts`,
        token,
      );
      const artifact = (artifacts.artifacts ?? []).find((candidate) =>
        candidate.name === COVERAGE_ARTIFACT && !candidate.expired
      );
      if (artifact === undefined) continue;
      const uncoveredLines = await readArtifact(artifact.id, token, github);
      if (uncoveredLines === undefined) continue;
      return {
        outcome: "read",
        day: { measured: { uncoveredLines, runId: run.id }, newestRun },
      };
    }
    // No run the reading showed measured the day. Saying the day has none
    // takes having seen them all, which a reading stopped short of the day's
    // start has not: the rest of the day is where a usable run would be. A
    // day that is over is never asked about again, so recording this one now
    // would keep the wrong answer for as long as the window holds it.
    if (!found.whole && runs.length < RUNS_READ_PER_DAY) {
      return { outcome: "unshown" };
    }
    const seen = newestRun === undefined ? {} : { newestRun };
    return { outcome: "read", day: seen };
  } catch (error) {
    return { outcome: "failed", error };
  }
}

/** What a refresh of the window produced. */
export interface CoverageDebtHistory {
  /** One sample per day that measured the repository, oldest first. */
  samples: CoverageDebtSample[];

  /** Why the newest days are missing, when a read failed. */
  error?: unknown;
}

/**
 * Fills in every day of the window the store has not read, then returns the
 * samples it holds. Today is read again on every refresh, because the day is
 * still gaining runs.
 */
export async function refreshCoverageDebt(options: {
  token: string;
  days: number;
  now: number;
  github: CoverageDebtGitHub;
  store: CoverageDebtStore;
}): Promise<CoverageDebtHistory> {
  const { store, github, token } = options;
  await store.load();
  const window = daysEndingAt(options.now, options.days);
  const today = window[window.length - 1];
  const wanted = window.filter((day) =>
    day === today || store.get(day) === undefined
  );
  const listing = await readWindowRuns(
    wanted.map((day) => ({ day, newestRun: store.get(day)?.newestRun })),
    token,
    github,
  );
  let error: unknown = listing.error;
  for (let at = 0; at < wanted.length; at += FETCH_CONCURRENCY) {
    const batch = wanted.slice(at, at + FETCH_CONCURRENCY);
    const readings = await Promise.all(
      batch.map((day) =>
        readDay(
          listing.days.get(day) ?? { runs: [], whole: false },
          token,
          github,
          store.get(day),
        )
      ),
    );
    readings.forEach((reading, index) => {
      if (reading.outcome === "read") store.set(batch[index], reading.day);
      else if (reading.outcome === "failed") error ??= reading.error;
    });
  }
  await store.save(window);
  const samples: CoverageDebtSample[] = [];
  for (const day of window) {
    const measured = store.get(day)?.measured;
    if (measured === undefined) continue;
    samples.push({ day, ...measured });
  }
  return error === undefined ? { samples } : { samples, error };
}
