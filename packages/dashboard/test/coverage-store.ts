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
import type { CoverageDebtSource } from "../coverage-debt-history.ts";

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
