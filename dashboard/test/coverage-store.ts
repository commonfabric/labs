/**
 * A record store holding coverage measurements, for the tests of the coverage
 * debt collection and the tile built on it. Each object is written the way the
 * relay writes one and read back through the store's own parser, so what a
 * test hands the collection is what the real store would hand it.
 */

import {
  buildObjectBody,
  ciObjectName,
  COVERAGE_ARTIFACT,
  coverageRecords,
  parseReportGroups,
  type RunContext,
} from "@commonfabric/test-support/records";
import type {
  CoverageDebtSource,
  CoverageRunLookup,
  CoverageRunState,
} from "../coverage-debt-history.ts";

/** One run's coverage object, as a test describes it. */
export interface CoverageRun {
  /** The UTC day the run started on, `YYYY-MM-DD`. */
  day: string;

  runId: number;

  /** The attempt of the run that uploaded the object; the first by default. */
  attempt?: number;

  /** The repository-wide uncovered lines; absent writes no such figure. */
  lines?: number;

  cold?: boolean;

  /** Whether the attempt concluded `success`, which it does by default. */
  passed?: boolean;

  event?: string;
  branch?: string;
  fork?: boolean;
}

/** The name the relay gives the object one run's coverage artifact makes. */
export function coverageObjectName(run: CoverageRun): string {
  return "labs/test-records/submissions/ci/" + ciObjectName({
    runStartedAt: `${run.day}T12:00:00Z`,
    workflowRunId: String(run.runId),
    artifactName: `test-records-${COVERAGE_ARTIFACT}-a${run.attempt ?? 1}`,
  });
}

/** The text of one run's coverage object. */
export function coverageObject(run: CoverageRun): string {
  const context: RunContext = {
    schema: 1,
    line: "context",
    reportId: `report-${run.runId}`,
    repo: "commonfabric/labs",
    commit: `commit-${run.runId}`,
    dirty: false,
    branch: run.branch ?? "main",
    env: "ci",
    ci: {
      workflowRunId: String(run.runId),
      runAttempt: run.attempt ?? 1,
      workflow: "CI",
      job: "Coverage Check",
      event: run.event ?? "push",
      fork: run.fork ?? false,
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: `${run.day}T12:00:00Z`,
  };
  return buildObjectBody(
    context,
    coverageRecords({
      groups: new Map(
        run.lines === undefined ? [] : [["workspace", run.lines]],
      ),
      sets: new Map(),
      cold: run.cold ?? false,
    }),
  );
}

/** A store holding `runs`, and the requests it has been asked. */
export interface FakeCoverageStore extends CoverageDebtSource {
  /** The days listed, in the order they were asked for. */
  listed: string[];

  /** The objects read, in the order they were asked for. */
  readNames: string[];
}

/**
 * A store holding `runs`. A listing or a read fails with `failure` where one
 * is given.
 */
export function fakeCoverageStore(
  runs: readonly CoverageRun[],
  failure?: Error,
): FakeCoverageStore {
  const objects = new Map(
    runs.map((run) => [coverageObjectName(run), coverageObject(run)]),
  );
  const listed: string[] = [];
  const readNames: string[] = [];
  return {
    listed,
    readNames,
    list: (day) => {
      listed.push(day);
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve(
        runs.filter((run) => run.day === day).map(coverageObjectName),
      );
    },
    read: (objectName) => {
      readNames.push(objectName);
      if (failure !== undefined) return Promise.reject(failure);
      const text = objects.get(objectName);
      if (text === undefined) {
        return Promise.reject(new Error(`no such object ${objectName}`));
      }
      return Promise.resolve(parseReportGroups(text));
    },
  };
}

/** Run lists holding `runs`, and the requests they have been asked. */
export interface FakeCoverageRuns extends CoverageRunLookup {
  /** The `since` of each listing, in the order they were asked for. */
  listed: number[];

  /** The runs asked for by id, in the order they were asked for. */
  gotten: number[];
}

/**
 * Run lists holding each run of `runs` as GitHub lists it: created at noon on
 * the day of its first attempt, at its newest attempt, finished, and
 * concluded `success` when that attempt passed. A listing holds only the runs
 * whose head branch is `main`, created at or after the time it is asked from,
 * as the real lists do, and leaves out the runs whose ids `unlisted` names; a
 * run is found by its id whatever its branch. A request fails with `failure`
 * where one is given.
 */
export function fakeCoverageRuns(
  runs: readonly CoverageRun[],
  options: { unlisted?: readonly number[]; failure?: Error } = {},
): FakeCoverageRuns {
  const listed: number[] = [];
  const gotten: number[] = [];
  const first = new Map<number, CoverageRun>();
  const latest = new Map<number, CoverageRun>();
  for (const run of runs) {
    const attempt = run.attempt ?? 1;
    if (attempt < (first.get(run.runId)?.attempt ?? Infinity)) {
      first.set(run.runId, run);
    }
    if (attempt > (latest.get(run.runId)?.attempt ?? 0)) {
      latest.set(run.runId, { ...run, attempt });
    }
  }
  const states = new Map<number, CoverageRunState>();
  for (const [id, run] of latest) {
    states.set(id, {
      id,
      status: "completed",
      conclusion: run.passed === false ? "failure" : "success",
      run_attempt: run.attempt ?? 1,
      created_at: `${first.get(id)?.day}T12:00:00Z`,
    });
  }
  const unlisted = new Set(options.unlisted);
  const onMain = new Set(
    runs.filter((run) => (run.branch ?? "main") === "main")
      .map((run) => run.runId),
  );
  return {
    listed,
    gotten,
    list: (since) => {
      listed.push(since);
      if (options.failure !== undefined) return Promise.reject(options.failure);
      return Promise.resolve(
        [...states.values()].filter((run) =>
          onMain.has(run.id) && !unlisted.has(run.id) &&
          Date.parse(run.created_at) >= since
        ),
      );
    },
    get: (id) => {
      gotten.push(id);
      if (options.failure !== undefined) return Promise.reject(options.failure);
      return Promise.resolve(states.get(id));
    },
  };
}
