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
 * One sample a day is enough for a trend measured in weeks, and it bounds what
 * the collection costs: a day's coverage objects are found by one listing that
 * the store filters by name, and they are opened newest first until one
 * measured. Four things disqualify a run. A run attempt that did not pass
 * measured through tests that failed or never ran, and reads high by however
 * much those tests would have covered, which can be thousands of lines. A run
 * whose compile byte cache missed covers branches that only a cold compile
 * reaches, which lowers its debt by around a tenth of a percent — the same
 * size as a week's real movement. A run that is not a run of the head of
 * `main` measured code `main` does not carry. And a run that recorded no
 * repository-wide figure measured nothing this can use.
 *
 * The store does not say whether a run passed, so that comes from GitHub, one
 * request per attempt opened. A day held on disk with a measurement that
 * names no attempt has not had its run checked. It is read again from the
 * store when the store holds anything for it, and otherwise is charted once
 * its run's latest attempt is found to have passed.
 *
 * A day that has been read keeps its answer, including the answer that it has
 * no usable run, once it is two days old. A run is filed under the day it
 * started, and its measurements reach the store when the run has finished, so
 * yesterday can still gain some; a day before that gains none. A read that
 * failed establishes nothing and is left for the next collection.
 */

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
import { isObjectOrArray } from "@commonfabric/utils/types";
import { dashboardCacheFile } from "./history-files.ts";
import { github } from "./lib.ts";
import {
  TEST_RECORDS_BUCKET,
  TEST_RECORDS_CI_PREFIX,
  TEST_RECORDS_REPO,
} from "./test-records-history.ts";

/** The group holding the repository-wide uncovered-line count. */
export const WORKSPACE_GROUP = "workspace";

/** Days whose runs are opened at once. */
const FETCH_CONCURRENCY = 8;

const DAY_MS = 86_400_000;
/**
 * The shape the history file is written in, bumped when that shape changes, and
 * when a change to the collection means a day the file records as measuring
 * nothing may have measured after all. A file the running code cannot read as
 * it was written is discarded whole rather than day by day: a day it half
 * understands reads as a day that measured nothing, and a day that is over is
 * never asked about again, so the window would stay empty until it aged out.
 * The record store keeps every coverage measurement a run has written into it,
 * so for the days it holds them for, discarding the file costs the collection
 * it takes to fill the window again. A day the store holds none for is known
 * only from this file.
 */
export const STORE_VERSION = 3;

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

  /** The attempt of that run, which passed. */
  attempt: number;
}

/**
 * Where the collection reads the store and the runs' outcomes, so a test can
 * supply its own.
 */
export interface CoverageDebtSource {
  /** The names of the coverage objects stored for one day, `YYYY-MM-DD`. */
  list(day: string): Promise<string[]>;

  /** The reports one object holds. */
  read(objectName: string): Promise<StoredReportGroup[]>;

  /**
   * Attempt `attempt` of run `runId`, or its latest when `attempt` is absent,
   * and whether it concluded `success`. The store holds an attempt's objects
   * only once the attempt has finished, so this rejects for one that has not.
   */
  outcome(
    runId: number,
    attempt?: number,
  ): Promise<{ attempt: number; passed: boolean }>;
}

/** What a day's runs came to, when one of them measured. */
interface DayMeasurement {
  uncoveredLines: number;

  /** The run the number was read from. */
  runId: number;

  /**
   * The attempt of that run, which passed. Absent while nothing has checked
   * whether the run passed.
   */
  attempt?: number;
}

interface StoredDay {
  /** Absent when no run of the day carried a usable measurement. */
  measured?: DayMeasurement;

  /**
   * How many coverage objects the day listed when it was last read. The two
   * newest days are read on every refresh, and this is what lets that cost a
   * listing each when nothing has landed since: objects are only ever added,
   * so the number can only have moved if the count has.
   */
  listed?: number;
}

interface StoredHistory {
  version: number;
  days: Record<string, StoredDay>;
}

const isPositiveInteger = (value: unknown): boolean =>
  Number.isInteger(value) && (value as number) > 0;

const isMeasurement = (value: unknown): value is DayMeasurement => {
  if (typeof value !== "object" || value === null) return false;
  const measured = value as DayMeasurement;
  return Number.isFinite(measured.uncoveredLines) &&
    measured.uncoveredLines >= 0 && isPositiveInteger(measured.runId) &&
    (measured.attempt === undefined || isPositiveInteger(measured.attempt));
};

/** A day's measurement, when nothing has checked whether its run passed. */
const uncheckedOf = (
  day: StoredDay | undefined,
): DayMeasurement | undefined =>
  day?.measured?.attempt === undefined ? day?.measured : undefined;

const isStoredDay = (value: unknown): value is StoredDay => {
  if (!isObjectOrArray(value)) return false;
  const day = value as StoredDay;
  if (
    day.listed !== undefined &&
    !(Number.isSafeInteger(day.listed) && day.listed >= 0)
  ) {
    return false;
  }
  return day.measured === undefined || isMeasurement(day.measured);
};

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

/** The fields of a GitHub workflow run attempt this reads. */
interface RunAttempt {
  run_attempt: number;
  status: string;
  conclusion: string | null;
}

/** The store and GitHub as they really are. */
export function liveCoverageDebtSource(
  fetchImpl?: typeof fetch,
  githubImpl: (path: string) => Promise<RunAttempt> = github,
): CoverageDebtSource {
  const bucket = TEST_RECORDS_BUCKET;
  return {
    outcome: async (runId, attempt) => {
      const run = await githubImpl(
        `repos/${TEST_RECORDS_REPO}/actions/runs/${runId}` +
          (attempt === undefined ? "" : `/attempts/${attempt}`),
      );
      if (run.status !== "completed") {
        throw new Error(
          `GitHub run ${runId} attempt ${run.run_attempt} has not finished`,
        );
      }
      return {
        attempt: run.run_attempt,
        passed: run.conclusion === "success",
      };
    },
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
  | { outcome: "failed"; error: unknown };

/**
 * The run an object's name says it came from, and the attempt of that run
 * that uploaded it, or nothing for a name `ciObjectName` would not give a
 * coverage artifact.
 */
function uploadOf(
  objectName: string,
): { runId: number; attempt: number } | undefined {
  const match = objectName.match(/\/run-(\d+)-([^/]*)\.ndjson$/);
  if (match === null) return undefined;
  const attempt = coverageArtifactAttempt(match[2]);
  return attempt === undefined
    ? undefined
    : { runId: Number(match[1]), attempt };
}

async function readDay(
  day: string,
  source: CoverageDebtSource,
  known: StoredDay | undefined,
): Promise<DayReading> {
  try {
    const names = await source.list(day);
    const unchecked = uncheckedOf(known);
    // Objects are only ever added, so a day listing what it listed last
    // time holds nothing the last reading did not see.
    if (unchecked === undefined && names.length === known?.listed) {
      return { outcome: "unchanged" };
    }
    if (unchecked !== undefined && names.length === 0) {
      const latest = await source.outcome(unchecked.runId);
      return {
        outcome: "read",
        day: latest.passed
          ? { measured: { ...unchecked, attempt: latest.attempt }, listed: 0 }
          : { listed: 0 },
      };
    }
    // Newest run first, and a run's newest attempt ahead of the one it
    // measured again.
    const objects = names
      .flatMap((name) => {
        const upload = uploadOf(name);
        return upload === undefined ? [] : [{ name, ...upload }];
      })
      .sort((a, b) => b.runId - a.runId || b.attempt - a.attempt);
    for (const { name, runId, attempt } of objects) {
      for (const report of await source.read(name)) {
        const uncoveredLines = workspaceDebtOf(report);
        if (uncoveredLines === undefined) continue;
        if (!(await source.outcome(runId, attempt)).passed) break;
        return {
          outcome: "read",
          day: {
            measured: { uncoveredLines, runId, attempt },
            listed: names.length,
          },
        };
      }
    }
    return { outcome: "read", day: { listed: names.length } };
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
 * Fills in every day of the window the store has not read or whose run it has
 * not checked, then returns the samples it holds. Today and yesterday are read
 * again on every refresh, because they can still gain runs.
 */
export async function refreshCoverageDebt(options: {
  days: number;
  now: number;
  source: CoverageDebtSource;
  store: CoverageDebtStore;
}): Promise<CoverageDebtHistory> {
  const { store, source } = options;
  await store.load();
  const window = daysEndingAt(options.now, options.days);
  const open = new Set(window.slice(-2));
  const wanted = window.filter((day) => {
    const stored = store.get(day);
    return open.has(day) || stored === undefined ||
      uncheckedOf(stored) !== undefined;
  });
  let error: unknown;
  for (let at = 0; at < wanted.length; at += FETCH_CONCURRENCY) {
    const batch = wanted.slice(at, at + FETCH_CONCURRENCY);
    const readings = await Promise.all(
      batch.map((day) => readDay(day, source, store.get(day))),
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
    if (measured?.attempt === undefined) continue;
    samples.push({ day, ...measured, attempt: measured.attempt });
  }
  return error === undefined ? { samples } : { samples, error };
}
