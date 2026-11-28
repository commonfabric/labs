/**
 * coverage-debt-history: the record store is replaced with one held in memory
 * that answers with real coverage objects, the shared run lists with a list
 * held in memory, and the history is pointed at a temporary file. No network
 * and nothing outside the temporary directory each test makes for itself.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  COVERAGE_OBJECT_GLOB,
  parseReportGroups,
} from "@commonfabric/test-support/records";
import { afterEach, beforeEach, describe, it } from "@commonfabric/test-support/test";
import {
  type CoverageDebtHistory,
  type CoverageDebtSource,
  CoverageDebtStore,
  type CoverageRunLookup,
  type CoverageRunState,
  daysEndingAt,
  liveCoverageDebtSource,
  refreshCoverageDebt,
  utcDay,
  workspaceDebtOf,
} from "./coverage-debt-history.ts";
import {
  coverageObject,
  coverageObjectName,
  type CoverageRun,
  fakeCoverageRuns,
  fakeCoverageStore,
} from "./test/coverage-store.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 2, 13, 30);

/** The one report a run's coverage object holds. */
function reportOf(run: CoverageRun) {
  return parseReportGroups(coverageObject(run))[0]!;
}

/**
 * A sample of `day` whose runs averaged `mean` and whose newest run counted
 * `newest`.
 */
const sample = (day: string, mean: number, newest = mean) => ({
  day,
  uncoveredLines: mean,
  newestUncoveredLines: newest,
});

describe("coverage-debt-history", () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "coverage-debt-" });
    file = join(directory, "history.json");
  });

  afterEach(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  /**
   * Refreshes `days` days into `store` from a record store holding `runs` and
   * run lists holding the same runs, unless `source` or `lists` replaces one.
   */
  function refresh(
    store: CoverageDebtStore,
    days: number,
    runs: readonly CoverageRun[],
    replaced: { source?: CoverageDebtSource; lists?: CoverageRunLookup } = {},
  ): Promise<CoverageDebtHistory> {
    return refreshCoverageDebt({
      days,
      now: NOW,
      source: replaced.source ?? fakeCoverageStore(runs),
      runs: replaced.lists ?? fakeCoverageRuns(runs),
      store,
    });
  }

  describe("utcDay()", () => {
    it("returns the UTC day an instant falls in", () => {
      expect(utcDay(Date.UTC(2026, 8, 2, 23, 59))).toBe("2026-09-02");
      expect(utcDay(Date.UTC(2026, 8, 3, 0, 0))).toBe("2026-09-03");
    });
  });

  describe("daysEndingAt()", () => {
    it("returns the days up to and including today, oldest first", () => {
      expect(daysEndingAt(NOW, 3)).toEqual([
        "2026-08-31",
        "2026-09-01",
        "2026-09-02",
      ]);
    });
  });

  describe("workspaceDebtOf()", () => {
    const run: CoverageRun = { day: "2026-09-02", runId: 1, lines: 78166 };

    it("returns the repository-wide uncovered-line count", () => {
      expect(workspaceDebtOf(reportOf(run))).toBe(78166);
      expect(workspaceDebtOf(reportOf({ ...run, cold: false })))
        .toBe(78166);
    });

    it("returns `undefined` for a run whose compile cache missed", () => {
      // A cold run reaches branches only a cold compile takes, so its debt sits
      // below a warm run's.
      expect(workspaceDebtOf(reportOf({ ...run, cold: true })))
        .toBeUndefined();
    });

    it("returns `undefined` when no figure is the workspace one", () => {
      expect(workspaceDebtOf(reportOf({ ...run, lines: undefined })))
        .toBeUndefined();
    });

    it("returns `undefined` for a run that is not a push to main", () => {
      expect(workspaceDebtOf(reportOf({ ...run, event: "pull_request" })))
        .toBeUndefined();
      expect(workspaceDebtOf(reportOf({ ...run, branch: "topic" })))
        .toBeUndefined();
      expect(workspaceDebtOf(reportOf({ ...run, fork: true })))
        .toBeUndefined();
    });

    it("returns `undefined` for a report with no context", () => {
      const { records } = reportOf(run);
      expect(workspaceDebtOf({ context: undefined, records })).toBeUndefined();
    });
  });

  describe("liveCoverageDebtSource()", () => {
    it("lists a day's coverage objects alone, and reads one's reports", async () => {
      const run: CoverageRun = { day: "2026-09-02", runId: 7, lines: 78166 };
      const asked: URL[] = [];
      const source = liveCoverageDebtSource((input) => {
        const url = new URL(String(input));
        asked.push(url);
        return Promise.resolve(
          url.pathname.endsWith("/o")
            ? Response.json({ items: [{ name: coverageObjectName(run) }] })
            : new Response(coverageObject(run)),
        );
      });
      expect(await source.list("2026-09-02")).toEqual([
        coverageObjectName(run),
      ]);
      expect(asked[0]?.searchParams.get("prefix")).toBe(
        "labs/test-records/submissions/ci/v1/2026/09/02/",
      );
      expect(asked[0]?.searchParams.get("matchGlob")).toBe(
        COVERAGE_OBJECT_GLOB,
      );
      const reports = await source.read(coverageObjectName(run));
      expect(reports.map(workspaceDebtOf)).toEqual([78166]);
    });
  });

  describe("CoverageDebtStore", () => {
    it("starts empty when the file is not there", async () => {
      const store = new CoverageDebtStore(file);
      await store.load();
      expect(store.get("2026-09-02")).toBeUndefined();
    });

    it("reads back what it wrote", async () => {
      const store = new CoverageDebtStore(file);
      await store.load();
      store.set("2026-09-01", {
        runs: [{ runId: 7, attempt: 2, uncoveredLines: 78404 }],
      });
      store.set("2026-09-02", { runs: [], pending: true });
      await store.save(["2026-09-01", "2026-09-02"]);

      const reopened = new CoverageDebtStore(file);
      await reopened.load();
      expect(reopened.get("2026-09-01")).toEqual({
        runs: [{ runId: 7, attempt: 2, uncoveredLines: 78404 }],
      });
      expect(reopened.get("2026-09-02")).toEqual({ runs: [], pending: true });
    });

    it("forgets the days outside the window it is saved with", async () => {
      const store = new CoverageDebtStore(file);
      await store.load();
      store.set("2026-08-01", {
        runs: [{ runId: 1, attempt: 1, uncoveredLines: 1 }],
      });
      store.set("2026-09-02", {
        runs: [{ runId: 2, attempt: 1, uncoveredLines: 2 }],
      });
      await store.save(["2026-09-02"]);

      const reopened = new CoverageDebtStore(file);
      await reopened.load();
      expect(reopened.get("2026-08-01")).toBeUndefined();
      expect(reopened.get("2026-09-02")?.runs[0]?.uncoveredLines).toBe(2);
    });

    it("reads a day in any other shape as a day it has not read", async () => {
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          days: {
            "2026-09-02": {
              runs: [{ runId: 2, attempt: 1, uncoveredLines: 5 }],
            },
            "2026-09-01": {
              runs: [{ runId: 1, attempt: 1, uncoveredLines: "lots" }],
            },
            "2026-08-31": null,
            "2026-08-30": { runs: "none" },
            "2026-08-29": {
              runs: [{ runId: 0, attempt: 1, uncoveredLines: 5 }],
            },
            "2026-08-28": {
              runs: [{ runId: 3, attempt: 1.5, uncoveredLines: 5 }],
            },
            "2026-08-27": {
              runs: [{ runId: 3, attempt: 1, uncoveredLines: -1 }],
            },
            "2026-08-26": [],
            "2026-08-24": { runs: [], pending: false },
            "2026-08-23": { runs: [], pending: true, figures: { a: "lots" } },
            "2026-08-22": { runs: [], pending: true, figures: [] },
            // The shape a single measurement a day was kept in.
            "2026-08-25": {
              measured: { uncoveredLines: 5, runId: 3, attempt: 1 },
              listed: 1,
            },
          },
        }),
      );
      const store = new CoverageDebtStore(file);
      await store.load();
      expect(store.get("2026-09-02")?.runs[0]?.uncoveredLines).toBe(5);
      for (const day of daysEndingAt(Date.UTC(2026, 8, 1), 11)) {
        expect(store.get(day)).toBeUndefined();
      }
    });

    it("starts empty from a file that holds no record of days", async () => {
      for (const contents of ["[]", '{"days":["2026-09-02"]}', "{", "7"]) {
        await Deno.writeTextFile(file, contents);
        const store = new CoverageDebtStore(file);
        await store.load();
        expect(store.get("2026-09-02")).toBeUndefined();
      }
    });
  });

  describe("refreshCoverageDebt()", () => {
    it("returns one sample per day that measured, oldest first", async () => {
      const history = await refresh(new CoverageDebtStore(file), 3, [
        { day: "2026-08-31", runId: 11, lines: 79552 },
        { day: "2026-09-01", runId: 12, lines: 78404 },
        { day: "2026-09-02", runId: 13, lines: 78166 },
      ]);
      expect(history.samples).toEqual([
        sample("2026-08-31", 79552),
        sample("2026-09-01", 78404),
        sample("2026-09-02", 78166),
      ]);
      expect(history.error).toBeUndefined();
    });

    it("takes a day's number as the mean of its runs, beside its newest run's", async () => {
      const history = await refresh(new CoverageDebtStore(file), 1, [
        { day: "2026-09-02", runId: 20, lines: 78300 },
        { day: "2026-09-02", runId: 22, lines: 78166 },
        { day: "2026-09-02", runId: 21, lines: 78200 },
      ]);
      expect(history.samples).toEqual([
        sample("2026-09-02", 78222, 78166),
      ]);
    });

    it("passes over a cold run, a run with no figure, and one that is not a push to main", async () => {
      const history = await refresh(new CoverageDebtStore(file), 2, [
        { day: "2026-09-02", runId: 24, lines: 78060, cold: true },
        { day: "2026-09-02", runId: 23 },
        { day: "2026-09-02", runId: 22, lines: 78166 },
        { day: "2026-09-01", runId: 21, lines: 1, event: "pull_request" },
      ]);
      expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
    });

    it("passes over a run attempt that did not pass", async () => {
      const history = await refresh(new CoverageDebtStore(file), 2, [
        { day: "2026-09-02", runId: 26, lines: 87656, passed: false },
        { day: "2026-09-02", runId: 25, lines: 78166 },
        { day: "2026-09-01", runId: 24, lines: 78404, passed: false },
      ]);
      expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
    });

    it("passes over an attempt a later attempt of its run replaced", async () => {
      const history = await refresh(new CoverageDebtStore(file), 1, [
        { day: "2026-09-02", runId: 27, lines: 87656, passed: false },
        { day: "2026-09-02", runId: 27, attempt: 2, lines: 78166 },
        { day: "2026-09-02", runId: 28, lines: 78000 },
        { day: "2026-09-02", runId: 28, attempt: 2, lines: 1, passed: false },
      ]);
      expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
    });

    it("counts a re-run's newest attempt alone once one lands", async () => {
      const store = new CoverageDebtStore(file);
      const first: CoverageRun = { day: "2026-09-02", runId: 41, lines: 78060 };
      expect((await refresh(store, 1, [first])).samples).toEqual([
        sample("2026-09-02", 78060),
      ]);
      const history = await refresh(store, 1, [
        first,
        { ...first, attempt: 2, lines: 78166 },
      ]);
      expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
    });

    it("passes over an attempt that passed once a re-run of it fails", async () => {
      const store = new CoverageDebtStore(file);
      const first: CoverageRun = { day: "2026-09-02", runId: 42, lines: 78060 };
      await refresh(store, 1, [first]);
      const history = await refresh(store, 1, [
        first,
        { ...first, attempt: 2, lines: 87656, passed: false },
      ]);
      expect(history.samples).toEqual([]);
    });

    it("opens only the objects of `main` run attempts that passed", async () => {
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 31, lines: 78166 },
        { day: "2026-09-02", runId: 34, cold: true, lines: 1 },
        {
          day: "2026-09-02",
          runId: 32,
          event: "pull_request",
          branch: "topic",
          lines: 1,
        },
        { day: "2026-09-02", runId: 33, lines: 1, passed: false },
        { day: "2026-09-02", runId: 30, lines: 79000 },
      ];
      const source = fakeCoverageStore(runs);
      const history = await refresh(new CoverageDebtStore(file), 1, runs, {
        source,
      });
      expect(history.samples).toEqual([sample("2026-09-02", 78583, 78166)]);
      expect(source.readNames.toSorted()).toEqual(
        [runs[0], runs[1], runs[4]].map(coverageObjectName).toSorted(),
      );
    });

    it("opens only the day's coverage uploads among what the listing names", async () => {
      const run: CoverageRun = { day: "2026-09-02", runId: 71, lines: 78166 };
      const stored = fakeCoverageStore([run]);
      const read: string[] = [];
      const history = await refresh(new CoverageDebtStore(file), 1, [run], {
        source: {
          list: () =>
            Promise.resolve([
              "labs/test-records/submissions/ci/v1/2026/09/02/stray.ndjson",
              "labs/test-records/submissions/ci/v1/2026/09/02/" +
              "run-90-test-records-check-a1.ndjson",
              coverageObjectName(run),
            ]),
          read: (name) => {
            read.push(name);
            return stored.read(name);
          },
        },
      });
      expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
      expect(read).toEqual([coverageObjectName(run)]);
    });

    it("asks for the runs back to the start of the oldest day it reads, and only when an object needs deciding", async () => {
      const store = new CoverageDebtStore(file);
      const runs: CoverageRun[] = [
        { day: "2026-08-31", runId: 11, lines: 79552 },
      ];
      const lists = fakeCoverageRuns(runs);
      await refresh(store, 3, runs, { lists });
      // A day's objects can come from runs created the day before it.
      expect(lists.listed).toEqual([Date.UTC(2026, 7, 30)]);

      // Every day is read, and the two still open hold no figure.
      const again = fakeCoverageRuns(runs);
      await refresh(store, 3, runs, { lists: again });
      expect(again.listed).toEqual([]);
    });

    it("leaves an object undecided while the run lists cannot be read, and decides it on the next refresh", async () => {
      const store = new CoverageDebtStore(file);
      const run: CoverageRun = { day: "2026-09-02", runId: 28, lines: 78166 };
      const first = await refresh(store, 1, [run], {
        lists: fakeCoverageRuns([], { failure: new Error("set GH_TOKEN") }),
      });
      expect(first.samples).toEqual([]);
      expect((first.error as Error).message).toBe("set GH_TOKEN");
      expect(store.get("2026-09-02")).toBeUndefined();

      const second = await refresh(store, 1, [run]);
      expect(second.samples).toEqual([sample("2026-09-02", 78166)]);
    });

    it("charts a pending day with what it has, while a run has not finished at that attempt", async () => {
      const store = new CoverageDebtStore(file);
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 29, attempt: 2, lines: 78166 },
        { day: "2026-09-02", runId: 30, lines: 78000 },
      ];
      const created_at = "2026-09-02T12:00:00Z";
      const settled: CoverageRunState = {
        id: 30,
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        created_at,
      };
      const running: CoverageRunState = {
        id: 29,
        status: "in_progress",
        conclusion: null,
        run_attempt: 2,
        created_at,
      };
      const lists: CoverageRunState[][] = [
        [running, settled],
        // A list read before the attempt that uploaded the object started,
        // which leaves the run to be read by its id.
        [{ ...running, status: "completed", run_attempt: 1 }, settled],
      ];
      for (const list of lists) {
        const history = await refresh(store, 1, runs, {
          lists: {
            list: () => Promise.resolve(list),
            get: () => Promise.resolve(running),
          },
        });
        expect(history.samples).toEqual([sample("2026-09-02", 78000)]);
      }

      const history = await refresh(store, 1, runs);
      expect(history.samples).toEqual([sample("2026-09-02", 78083, 78000)]);
    });

    it("reads a pending day again once it is two days old, opening its objects once, until nothing in it is pending", async () => {
      const store = new CoverageDebtStore(file);
      const run: CoverageRun = { day: "2026-08-31", runId: 12, lines: 78404 };
      const source = fakeCoverageStore([run]);
      const running: CoverageRunLookup = {
        list: () =>
          Promise.resolve([{
            id: 12,
            status: "in_progress",
            conclusion: null,
            run_attempt: 1,
            created_at: "2026-08-31T12:00:00Z",
          }]),
        get: () => Promise.reject(new Error("not asked")),
      };
      await refresh(store, 3, [run], { source, lists: running });
      expect(store.get("2026-08-31")).toEqual({
        runs: [],
        pending: true,
        figures: {},
      });

      const lists = fakeCoverageRuns([run]);
      await refresh(store, 3, [run], { source, lists });
      const history = await refresh(store, 3, [run], { source, lists });
      expect(history.samples).toEqual([sample("2026-08-31", 78404)]);
      // The day settled on the first of those, so the second lists no runs.
      expect(lists.listed).toEqual([Date.UTC(2026, 7, 30)]);
      expect(source.readNames).toEqual([coverageObjectName(run)]);

      const after = fakeCoverageStore([run]);
      await refresh(store, 3, [run], { source: after });
      expect(after.listed.toSorted()).toEqual(["2026-09-01", "2026-09-02"]);
    });

    it("reads a day again once it is two days old, after a refresh that read it before then", async () => {
      const store = new CoverageDebtStore(file);
      const early: CoverageRun = { day: "2026-09-01", runId: 51, lines: 78404 };
      const late: CoverageRun = { ...early, runId: 52, lines: 78300 };
      await refreshCoverageDebt({
        days: 2,
        now: NOW,
        source: fakeCoverageStore([early]),
        runs: fakeCoverageRuns([early]),
        store,
      });
      const history = await refreshCoverageDebt({
        days: 4,
        now: NOW + 2 * DAY_MS,
        source: fakeCoverageStore([early, late]),
        runs: fakeCoverageRuns([early, late]),
        store,
      });
      expect(history.samples).toEqual([sample("2026-09-01", 78352, 78300)]);
      expect(store.get("2026-09-01")?.pending).toBeUndefined();
    });

    it("passes over a run the lists do not hold", async () => {
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 31, lines: 78166 },
        { day: "2026-09-02", runId: 32, lines: 78000 },
      ];
      const lists = fakeCoverageRuns(runs, { unlisted: [31] });
      const history = await refresh(new CoverageDebtStore(file), 1, runs, {
        lists,
      });
      expect(history.samples).toEqual([sample("2026-09-02", 78000)]);
      expect(lists.gotten).toEqual([]);
    });

    it("reads by its id a run whose attempt is newer than the one the lists hold", async () => {
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 33, attempt: 2, lines: 78166 },
      ];
      const lists = fakeCoverageRuns(runs);
      const history = await refresh(new CoverageDebtStore(file), 1, runs, {
        lists: {
          list: async (since) =>
            (await lists.list(since)).map((run) => ({
              ...run,
              run_attempt: 1,
            })),
          get: lists.get,
        },
      });
      expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
      expect(lists.gotten).toEqual([33]);
    });

    it("passes over an earlier attempt of a run a later attempt's object shows was replaced, whatever the lists say", async () => {
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 36, lines: 100 },
        { day: "2026-09-02", runId: 36, attempt: 2, lines: 200 },
      ];
      const lists = fakeCoverageRuns(runs);
      const history = await refresh(new CoverageDebtStore(file), 1, runs, {
        lists: {
          list: async (since) =>
            (await lists.list(since)).map((run) => ({
              ...run,
              run_attempt: 1,
            })),
          get: lists.get,
        },
      });
      expect(history.samples).toEqual([sample("2026-09-02", 200)]);
    });

    it("passes over a re-run of a run created more than a day before the day it is filed under", async () => {
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 34, lines: 1 },
        { day: "2026-09-02", runId: 35, lines: 78166 },
      ];
      const lists = fakeCoverageRuns(runs);
      const created = new Map([
        [34, "2026-08-31T23:59:59Z"],
        [35, "2026-09-01T00:00:00Z"],
      ]);
      const history = await refresh(new CoverageDebtStore(file), 1, runs, {
        lists: {
          list: async (since) =>
            (await lists.list(since)).map((run) => ({
              ...run,
              created_at: created.get(run.id) ?? run.created_at,
            })),
          get: lists.get,
        },
      });
      expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
    });

    it("keeps a settled day the history recorded, and reads yesterday and today again", async () => {
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          days: {
            "2026-08-31": {
              runs: [{ runId: 12, attempt: 1, uncoveredLines: 78404 }],
            },
            "2026-09-02": {
              runs: [{ runId: 13, attempt: 1, uncoveredLines: 78300 }],
            },
          },
        }),
      );
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 13, lines: 78300 },
        { day: "2026-09-02", runId: 14, lines: 78166 },
      ];
      const source = fakeCoverageStore(runs);
      const history = await refresh(new CoverageDebtStore(file), 3, runs, {
        source,
      });
      expect(history.samples).toEqual([
        sample("2026-08-31", 78404),
        sample("2026-09-02", 78233, 78166),
      ]);
      expect(source.listed.toSorted()).toEqual(["2026-09-01", "2026-09-02"]);
    });

    it("leaves a day unread when its object cannot be read", async () => {
      const store = new CoverageDebtStore(file);
      const run: CoverageRun = { day: "2026-09-02", runId: 61, lines: 78166 };
      const first = await refresh(store, 1, [run], {
        source: {
          list: () => Promise.resolve([coverageObjectName(run)]),
          read: () => Promise.reject(new Error("HTTP 503")),
        },
      });
      expect(first.samples).toEqual([]);
      expect((first.error as Error).message).toBe("HTTP 503");

      const second = await refresh(store, 1, [run]);
      expect(second.samples).toEqual([sample("2026-09-02", 78166)]);
    });

    it("costs one listing when nothing has landed since the last refresh", async () => {
      const store = new CoverageDebtStore(file);
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 71, lines: 78166 },
      ];
      await refresh(store, 1, runs);
      const second = fakeCoverageStore(runs);
      const lists = fakeCoverageRuns(runs);
      const history = await refresh(store, 1, runs, { source: second, lists });
      expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
      expect(second.listed).toEqual(["2026-09-02"]);
      expect(second.readNames).toEqual([]);
      expect(lists.listed).toHaveLength(1);
      expect(lists.gotten).toEqual([]);
    });

    it("opens again, in a new process, only the objects of a day that are new", async () => {
      const first: CoverageRun = { day: "2026-09-02", runId: 71, lines: 78166 };
      const second: CoverageRun = { ...first, runId: 72, lines: 78100 };
      await refresh(new CoverageDebtStore(file), 1, [first]);
      const source = fakeCoverageStore([first, second]);
      const history = await refresh(
        new CoverageDebtStore(file),
        1,
        [first, second],
        { source },
      );
      expect(history.samples).toEqual([sample("2026-09-02", 78133, 78100)]);
      expect(source.readNames).toEqual([coverageObjectName(second)]);
    });

    it("keeps the figures of a day's objects only while the day can still change", async () => {
      const store = new CoverageDebtStore(file);
      const run: CoverageRun = { day: "2026-09-01", runId: 73, lines: 78166 };
      await refresh(store, 3, [run]);
      expect(store.get("2026-09-01")?.figures).toEqual({
        [coverageObjectName(run)]: 78166,
      });
      await refreshCoverageDebt({
        days: 4,
        now: NOW + 2 * DAY_MS,
        source: fakeCoverageStore([run]),
        runs: fakeCoverageRuns([run]),
        store,
      });
      expect(store.get("2026-09-01")).toEqual({
        runs: [{ runId: 73, attempt: 1, uncoveredLines: 78166 }],
      });
    });

    it("reads today again once a newer run has landed", async () => {
      const store = new CoverageDebtStore(file);
      const first: CoverageRun = { day: "2026-09-02", runId: 81, lines: 78166 };
      await refresh(store, 1, [first]);
      const history = await refresh(store, 1, [
        first,
        { day: "2026-09-02", runId: 82, lines: 78040 },
      ]);
      expect(history.samples).toEqual([sample("2026-09-02", 78103, 78040)]);
    });

    it("does not rewrite the file when a refresh changed nothing", async () => {
      const store = new CoverageDebtStore(file);
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 91, lines: 78166 },
      ];
      await refresh(store, 1, runs);
      const written = (await Deno.stat(file)).mtime?.getTime();
      await Deno.writeTextFile(`${file}.witness`, "");
      await refresh(new CoverageDebtStore(file), 1, runs);
      expect((await Deno.stat(file)).mtime?.getTime()).toBe(written);
    });

    it("keeps a day with no usable run, and does not ask about it again", async () => {
      const store = new CoverageDebtStore(file);
      await refresh(store, 3, []);
      const second = fakeCoverageStore([]);
      const history = await refresh(store, 3, [], { source: second });
      expect(history.samples).toEqual([]);
      // A day two days old is settled, so only yesterday and today are
      // listed again.
      expect(second.listed.toSorted()).toEqual(["2026-09-01", "2026-09-02"]);
    });

    it("reads yesterday again, for a run that started before midnight", async () => {
      const store = new CoverageDebtStore(file);
      await refresh(store, 2, []);
      const history = await refresh(store, 2, [
        { day: "2026-09-01", runId: 61, lines: 78404 },
      ]);
      expect(history.samples).toEqual([sample("2026-09-01", 78404)]);
    });

    it("reports a failed read and asks again on the next refresh", async () => {
      const store = new CoverageDebtStore(file);
      const runs: CoverageRun[] = [
        { day: "2026-09-01", runId: 42, lines: 78404 },
        { day: "2026-09-02", runId: 41, lines: 78166 },
      ];
      const recovered = fakeCoverageStore(runs);
      const first = await refresh(store, 2, runs, {
        source: {
          list: (day) =>
            day === "2026-09-01"
              ? Promise.reject(new Error("HTTP 502"))
              : recovered.list(day),
          read: recovered.read,
        },
      });
      expect(first.samples.map((sample) => sample.day)).toEqual(["2026-09-02"]);
      expect((first.error as Error).message).toBe("HTTP 502");

      const second = await refresh(store, 2, runs, { source: recovered });
      expect(second.samples.map((sample) => sample.day)).toEqual([
        "2026-09-01",
        "2026-09-02",
      ]);
      expect(second.error).toBeUndefined();
    });

    it("says so and carries on when the history cannot be written", async () => {
      // A store that cannot persist still answers from memory: losing the file
      // costs the next start its cache, not this refresh its numbers.
      const logged: unknown[] = [];
      const error = console.error;
      console.error = (...parts: unknown[]) => void logged.push(parts[0]);
      try {
        const history = await refresh(
          new CoverageDebtStore(join(directory, "gone", "history.json")),
          1,
          [{ day: "2026-09-02", runId: 101, lines: 78166 }],
        );
        expect(history.samples).toEqual([sample("2026-09-02", 78166)]);
      } finally {
        console.error = error;
      }
      expect(logged).toEqual(["coverage debt: could not persist history:"]);
    });

    it("writes the history it could not write once the next refresh can", async () => {
      // The refresh after a failed write usually has nothing of its own to
      // write, since nothing has landed since, so a store that counted the
      // failed attempt as saved would never come back here.
      const missing = join(directory, "gone");
      const store = new CoverageDebtStore(join(missing, "history.json"));
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 111, lines: 78166 },
      ];
      const error = console.error;
      console.error = () => {};
      try {
        await refresh(store, 1, runs);
      } finally {
        console.error = error;
      }
      await Deno.mkdir(missing);
      await refresh(store, 1, runs);

      const reopened = new CoverageDebtStore(join(missing, "history.json"));
      await reopened.load();
      expect(reopened.get("2026-09-02")?.runs[0]?.uncoveredLines).toBe(78166);
    });

    it("keeps the days of the window it was given and drops the rest", async () => {
      const store = new CoverageDebtStore(file);
      await store.load();
      const old = utcDay(NOW - 30 * DAY_MS);
      store.set(old, {
        runs: [{ runId: 1, attempt: 1, uncoveredLines: 90000 }],
      });
      const history = await refresh(store, 2, [
        { day: "2026-09-02", runId: 51, lines: 78166 },
      ]);
      expect(history.samples.map((sample) => sample.day)).toEqual([
        "2026-09-02",
      ]);
      expect(store.get(old)).toBeUndefined();
    });
  });
});
