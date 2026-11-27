/**
 * Collects what each day's `main` runs measured for the repository's whole
 * coverage debt, so a tile can chart the direction it has moved in.
 *
 * The number comes from the coverage measurements the full run on `main`
 * writes into the test-run record store, whose `workspace` group is the
 * repository-wide total. `docs/development/COVERAGE.md` describes how the
 * groups are counted. The store keeps every run's measurements, and the
 * collection keeps what it has read on disk, a day at a time.
 *
 * A day's figure is the mean over every run of that day that qualifies, so
 * that the few lines by which two runs of nearly the same commit can disagree
 * move it less than they would move any one run's figure. A day's coverage
 * objects are found by one listing that the store filters by name, and an
 * object is opened only once the run lists say its attempt passed. Five
 * things disqualify a run. A run attempt that did not pass
 * measured through tests that failed or never ran, and reads high by however
 * much those tests would have covered, which can be thousands of lines. A run
 * whose compile byte cache missed covers branches that only a cold compile
 * reaches, which lowers its debt. A run that is not a run of `main` measured
 * code `main` does not carry. A run created more than a day before the day an
 * attempt of it is filed under measured a commit of an earlier day. And a run
 * that recorded no repository-wide figure measured nothing this can use.
 *
 * The store does not say whether a run passed, so that comes from the
 * dashboard's shared lists of workflow runs, which carry each `main` run's
 * latest attempt and how it concluded, back to a day before the oldest day
 * read; a run they do not hold does not qualify. Where an object comes from
 * an attempt newer than the one the lists hold, GitHub's record of that one
 * run is read instead. An object from an attempt that a later attempt of its
 * run has replaced is passed over.
 *
 * An attempt is filed under the day it started, and its measurements reach the
 * store when the run has finished, so yesterday can still gain some; a day
 * before that gains none. A day is pending while it can still change: when it
 * was last read before it was two days old, or when it holds an object whose
 * run is not yet known to have finished at that attempt. A pending day is
 * charted with what it has so far, and read again on every collection. A day
 * that is not pending keeps its answer, including the answer that it has no
 * usable run. A read that failed establishes nothing and is left for the next
 * collection.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  COVERAGE_OBJECT_GLOB,
  coverageArtifactAttempt,
  coverageFiguresOf,
  datePartition,
  isMainRun,
  listObjects,
  readObject,
  RECORD_SCHEMA_VERSION,
  type StoredReportGroup,
} from "@commonfabric/test-support/records";
import type { GitHubRun } from "./github-runs.ts";
import { dashboardCacheFile } from "./history-files.ts";
import {
  TEST_RECORDS_BUCKET,
  TEST_RECORDS_CI_PREFIX,
} from "./test-records-history.ts";

/** The group holding the repository-wide uncovered-line count. */
export const WORKSPACE_GROUP = "workspace";

/** Days whose runs are opened at once. */
const FETCH_CONCURRENCY = 8;

const DAY_MS = 86_400_000;

const COVERAGE_DEBT_FILE = () =>
  dashboardCacheFile("fabric-wall-coverage-debt.json");

/** What one day's `main` runs measured. */
export interface CoverageDebtSample {
  /** The UTC day, as `YYYY-MM-DD`. */
  day: string;

  /** The mean of the uncovered lines each qualifying run of the day counted. */
  uncoveredLines: number;

  /** The uncovered lines the day's newest qualifying run counted. */
  newestUncoveredLines: number;
}

/**
 * Where the collection reads the record store, so a test can supply its own.
 */
export interface CoverageDebtSource {
  /** The names of the coverage objects stored for one day, `YYYY-MM-DD`. */
  list(day: string): Promise<string[]>;

  /** The reports one object holds. */
  read(objectName: string): Promise<StoredReportGroup[]>;
}

/** The fields of a workflow run the collection reads. */
export type CoverageRunState = Pick<
  GitHubRun,
  "id" | "status" | "conclusion" | "run_attempt" | "created_at"
>;

/**
 * Where the collection reads whether a run passed, so a test can supply its
 * own.
 */
export interface CoverageRunLookup {
  /**
   * Returns the `main` runs of the workflow that writes the coverage
   * measurements, every one created at or after `since`, a time in
   * milliseconds, among them.
   */
  list(since: number): Promise<readonly CoverageRunState[]>;

  /** Returns run `id` as it stands now, or `undefined` once it is gone. */
  get(id: number): Promise<CoverageRunState | undefined>;
}

/** One run attempt, as an object's name gives it. */
interface Upload {
  runId: number;
  attempt: number;
}

/** One run attempt's figure. */
interface RunMeasurement extends Upload {
  uncoveredLines: number;
}

/** What a day's qualifying runs measured, oldest run first. */
interface StoredDay {
  runs: RunMeasurement[];

  /**
   * Present when the day can still change: it was read before it was two days
   * old, or an object of it is waiting for its run to finish.
   */
  pending?: true;

  /**
   * For a pending day, the `main` figure each object it has opened holds, or
   * `null` for one that holds none, by object name. An object's contents
   * never change once stored, so a later read opens only the objects that are
   * new.
   */
  figures?: Record<string, number | null>;
}

const isPositiveInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isMeasurement = (value: unknown): value is RunMeasurement =>
  isObjectNotArray(value) && isPositiveInteger(value.runId) &&
  isPositiveInteger(value.attempt) &&
  typeof value.uncoveredLines === "number" &&
  Number.isFinite(value.uncoveredLines) && value.uncoveredLines >= 0;

const isFigure = (value: unknown): boolean =>
  value === null ||
  typeof value === "number" && Number.isFinite(value) && value >= 0;

// A day in any other shape, including one a different version of this code
// wrote, reads as a day that has not been read.
const isStoredDay = (value: unknown): value is StoredDay =>
  isObjectNotArray(value) && Array.isArray(value.runs) &&
  value.runs.every(isMeasurement) &&
  (value.pending === undefined || value.pending === true) &&
  (value.figures === undefined ||
    isObjectNotArray(value.figures) &&
      Object.values(value.figures).every(isFigure));

const byRun = (a: RunMeasurement, b: RunMeasurement): number =>
  a.runId - b.runId || a.attempt - b.attempt;

/** The instant a UTC day, `YYYY-MM-DD`, starts at, in milliseconds. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

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
 * The repository-wide uncovered-line count one stored report records, or
 * `undefined` where it is not a run of `main`, carries no such figure, or was
 * measured on a cold compile cache.
 */
export function workspaceDebtOf(report: StoredReportGroup): number | undefined {
  if (report.context === undefined || !isMainRun(report.context)) {
    return undefined;
  }
  const figures = coverageFiguresOf(report.records);
  return figures.cold ? undefined : figures.groups.get(WORKSPACE_GROUP);
}

/** The record store as it really is. */
export function liveCoverageDebtSource(
  fetchImpl?: typeof fetch,
): CoverageDebtSource {
  const bucket = TEST_RECORDS_BUCKET;
  return {
    list: (day) =>
      listObjects({
        bucket,
        prefix: `${TEST_RECORDS_CI_PREFIX}/v${RECORD_SCHEMA_VERSION}/` +
          `${datePartition(`${day}T00:00:00Z`)}/`,
        matchGlob: COVERAGE_OBJECT_GLOB,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      }),
    read: async (objectName) =>
      (await readObject({
        bucket,
        objectName,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      })).reports,
  };
}

/** Keeps each day's qualifying runs across dashboard restarts. */
export class CoverageDebtStore {
  #file: string;
  #days = new Map<string, StoredDay>();
  #loaded = false;
  #dirty = false;

  /** Constructs an instance over `file`, which need not exist yet. */
  constructor(file: string = COVERAGE_DEBT_FILE()) {
    this.#file = file;
  }

  /** Reads the stored days once; an unreadable file starts an empty history. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    let stored: unknown;
    try {
      stored = JSON.parse(await Deno.readTextFile(this.#file));
    } catch {
      return;
    }
    if (!isObjectNotArray(stored) || !isObjectNotArray(stored.days)) return;
    for (const [day, value] of Object.entries(stored.days)) {
      if (isStoredDay(value)) this.#days.set(day, value);
    }
  }

  /** What the day's qualifying runs measured, or `undefined` if never read. */
  get(day: string): StoredDay | undefined {
    return this.#days.get(day);
  }

  /** Records what a day's qualifying runs measured. */
  set(day: string, value: StoredDay): void {
    if (JSON.stringify(this.#days.get(day)) === JSON.stringify(value)) return;
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
    const stored = {
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
  | { outcome: "failed"; error: unknown };

/**
 * The run an object's name says it came from, and the attempt of that run
 * that uploaded it, or nothing for a name `ciObjectName` would not give a
 * coverage artifact.
 */
function uploadOf(objectName: string): Upload | undefined {
  const match = objectName.match(/\/run-(\d+)-([^/]*)\.ndjson$/);
  if (match === null) return undefined;
  const attempt = coverageArtifactAttempt(match[2]);
  return attempt === undefined
    ? undefined
    : { runId: Number(match[1]), attempt };
}

/**
 * Helper for `readDay()`, which returns the `main` figure one object holds,
 * whether or not the attempt that wrote it passed, or `undefined` for none.
 * Where the object holds several, the last one stands, as with the records
 * of one report.
 */
async function figureOf(
  objectName: string,
  source: CoverageDebtSource,
): Promise<number | undefined> {
  let figure: number | undefined;
  for (const report of await source.read(objectName)) {
    figure = workspaceDebtOf(report) ?? figure;
  }
  return figure;
}

async function readDay(
  day: string,
  open: boolean,
  source: CoverageDebtSource,
  store: CoverageDebtStore,
  runs: CoverageRunLookup,
  listed: () => Promise<Map<number, CoverageRunState>>,
): Promise<DayReading> {
  try {
    const known = store.get(day)?.figures ?? {};
    const figures: Record<string, number | null> = {};
    const uploads = new Map<string, Upload>();
    // An object from a later attempt of a run shows that its earlier ones were
    // replaced, whatever the lists say.
    const newest = new Map<number, number>();
    for (const name of await source.list(day)) {
      const upload = uploadOf(name);
      if (upload === undefined) continue;
      uploads.set(name, upload);
      newest.set(
        upload.runId,
        Math.max(newest.get(upload.runId) ?? 0, upload.attempt),
      );
    }
    const earliest = dayStart(day) - DAY_MS;
    const measured: RunMeasurement[] = [];
    let pending = open;
    for (const [name, upload] of uploads) {
      if (upload.attempt < (newest.get(upload.runId) ?? 0)) continue;
      let run = (await listed()).get(upload.runId);
      if (run !== undefined && upload.attempt > run.run_attempt) {
        run = await runs.get(upload.runId);
      }
      if (
        run === undefined || upload.attempt < run.run_attempt ||
        Date.parse(run.created_at) < earliest
      ) continue;
      if (upload.attempt > run.run_attempt || run.status !== "completed") {
        pending = true;
        continue;
      }
      if (run.conclusion !== "success") continue;
      figures[name] = Object.hasOwn(known, name)
        ? known[name]
        : (await figureOf(name, source)) ?? null;
      const uncoveredLines = figures[name];
      if (uncoveredLines !== null) measured.push({ ...upload, uncoveredLines });
    }
    measured.sort(byRun);
    return {
      outcome: "read",
      day: pending
        ? { runs: measured, pending: true, figures }
        : { runs: measured },
    };
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
 * Fills in every day of the window the store has not read or holds as
 * pending, and today and yesterday, which can still gain runs, then returns
 * the samples it holds. `runs` lists runs at most once a refresh, and only
 * when a day being read holds a coverage object.
 */
export async function refreshCoverageDebt(options: {
  days: number;
  now: number;
  source: CoverageDebtSource;
  runs: CoverageRunLookup;
  store: CoverageDebtStore;
}): Promise<CoverageDebtHistory> {
  const { store, source } = options;
  await store.load();
  const window = daysEndingAt(options.now, options.days);
  const open = window.slice(-2);
  const wanted = window.filter((day) => {
    const stored = store.get(day);
    return open.includes(day) || stored === undefined ||
      stored.pending === true;
  });
  // A day's objects can come from runs created up to a day before it.
  const since = dayStart(wanted[0]) - DAY_MS;
  let held: Promise<Map<number, CoverageRunState>> | undefined;
  const listed = () =>
    held ??= options.runs.list(since).then((list) =>
      new Map(list.map((run) => [run.id, run]))
    );
  let error: unknown;
  for (let at = 0; at < wanted.length; at += FETCH_CONCURRENCY) {
    const batch = wanted.slice(at, at + FETCH_CONCURRENCY);
    const readings = await Promise.all(
      batch.map((day) =>
        readDay(day, open.includes(day), source, store, options.runs, listed)
      ),
    );
    readings.forEach((reading, index) => {
      if (reading.outcome === "read") store.set(batch[index], reading.day);
      else error ??= reading.error;
    });
  }
  await store.save(window);
  const samples: CoverageDebtSample[] = [];
  for (const day of window) {
    const measured = store.get(day)?.runs ?? [];
    if (measured.length === 0) continue;
    const total = measured.reduce((sum, run) => sum + run.uncoveredLines, 0);
    samples.push({
      day,
      uncoveredLines: total / measured.length,
      newestUncoveredLines: measured[measured.length - 1].uncoveredLines,
    });
  }
  return error === undefined ? { samples } : { samples, error };
}
