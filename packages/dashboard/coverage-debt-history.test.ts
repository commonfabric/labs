/**
 * coverage-debt-history: the record store is replaced with one held in memory
 * that answers with real coverage objects, and the history is pointed at a
 * temporary file. No network and nothing outside the temporary directory each
 * test makes for itself.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import {
  COVERAGE_OBJECT_GLOB,
  parseReportGroups,
} from "@commonfabric/test-support/records";
import {
  CoverageDebtStore,
  daysEndingAt,
  liveCoverageDebtSource,
  refreshCoverageDebt,
  STORE_VERSION,
  utcDay,
  workspaceDebtOf,
} from "./coverage-debt-history.ts";
import {
  coverageObject,
  coverageObjectName,
  type CoverageRun,
  fakeCoverageStore,
} from "./test/coverage-store.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 2, 13, 30);

/** The one report a run's coverage object holds. */
function reportOf(run: CoverageRun) {
  return parseReportGroups(coverageObject(run))[0]!;
}

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
      // below a warm run's by about as much as a week of real work moves it.
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
        measured: { uncoveredLines: 78404, runId: 7 },
      });
      store.set("2026-09-02", {});
      await store.save(["2026-09-01", "2026-09-02"]);

      const reopened = new CoverageDebtStore(file);
      await reopened.load();
      expect(reopened.get("2026-09-01")).toEqual({
        measured: { uncoveredLines: 78404, runId: 7 },
      });
      expect(reopened.get("2026-09-02")).toEqual({});
    });

    it("forgets the days outside the window it is saved with", async () => {
      const store = new CoverageDebtStore(file);
      await store.load();
      store.set("2026-08-01", { measured: { uncoveredLines: 1, runId: 1 } });
      store.set("2026-09-02", { measured: { uncoveredLines: 2, runId: 2 } });
      await store.save(["2026-09-02"]);

      const reopened = new CoverageDebtStore(file);
      await reopened.load();
      expect(reopened.get("2026-08-01")).toBeUndefined();
      expect(reopened.get("2026-09-02")?.measured?.uncoveredLines).toBe(2);
    });

    it("drops a day whose record it cannot read, and a file of another version", async () => {
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          version: STORE_VERSION,
          days: {
            "2026-09-01": { measured: { uncoveredLines: "lots", runId: 1 } },
            "2026-09-02": { measured: { uncoveredLines: 5, runId: 2 } },
            "2026-08-31": null,
            "2026-08-30": { listed: "not a count" },
            "2026-08-29": { measured: { uncoveredLines: 5, runId: 0 } },
            "2026-08-28": { measured: 5 },
          },
        }),
      );
      const store = new CoverageDebtStore(file);
      await store.load();
      expect(store.get("2026-09-01")).toBeUndefined();
      expect(store.get("2026-09-02")?.measured?.uncoveredLines).toBe(5);
      expect(store.get("2026-08-31")).toBeUndefined();
      expect(store.get("2026-08-30")).toBeUndefined();
      expect(store.get("2026-08-29")).toBeUndefined();
      expect(store.get("2026-08-28")).toBeUndefined();

      // A `days` that is a list rather than a record of days reads as a
      // record whose keys are indices, and no index is a day.
      const listed = join(directory, "listed.json");
      await Deno.writeTextFile(
        listed,
        JSON.stringify({ version: STORE_VERSION, days: ["2026-09-02"] }),
      );
      const fromList = new CoverageDebtStore(listed);
      await fromList.load();
      expect(fromList.get("2026-09-02")).toBeUndefined();

      const notDays = join(directory, "not-days.json");
      await Deno.writeTextFile(
        notDays,
        JSON.stringify({ version: STORE_VERSION, days: "none" }),
      );
      const fromNothing = new CoverageDebtStore(notDays);
      await fromNothing.load();
      expect(fromNothing.get("2026-09-02")).toBeUndefined();

      // A file written before a day's measurement moved into `measured` has
      // days this code would read as days that measured nothing, and a day
      // that is over is never read again — so the whole file goes.
      const older = join(directory, "older.json");
      await Deno.writeTextFile(
        older,
        JSON.stringify({
          version: 1,
          days: { "2026-09-02": { uncoveredLines: 78404, runId: 7 } },
        }),
      );
      const fromOlder = new CoverageDebtStore(older);
      await fromOlder.load();
      expect(fromOlder.get("2026-09-02")).toBeUndefined();

      const other = join(directory, "other.json");
      await Deno.writeTextFile(
        other,
        JSON.stringify({
          version: STORE_VERSION + 1,
          days: { "2026-09-02": {} },
        }),
      );
      const newer = new CoverageDebtStore(other);
      await newer.load();
      expect(newer.get("2026-09-02")).toBeUndefined();
    });
  });

  describe("refreshCoverageDebt()", () => {
    it("returns one sample per day that measured, oldest first", async () => {
      const source = fakeCoverageStore([
        { day: "2026-08-31", runId: 11, lines: 79552 },
        { day: "2026-09-01", runId: 12, lines: 78404 },
        { day: "2026-09-02", runId: 13, lines: 78166 },
      ]);
      const history = await refreshCoverageDebt({
        days: 3,
        now: NOW,
        source,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-08-31", uncoveredLines: 79552, runId: 11 },
        { day: "2026-09-01", uncoveredLines: 78404, runId: 12 },
        { day: "2026-09-02", uncoveredLines: 78166, runId: 13 },
      ]);
      expect(history.error).toBeUndefined();
    });

    it("takes a day's number from its newest run that measured", async () => {
      const history = await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore([
          { day: "2026-09-02", runId: 20, lines: 78300 },
          { day: "2026-09-02", runId: 22, lines: 78166 },
          { day: "2026-09-02", runId: 21, lines: 78200 },
        ]),
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 22 },
      ]);
    });

    it("passes over a cold run, a run with no figure, and one that is not a push to main", async () => {
      const history = await refreshCoverageDebt({
        days: 2,
        now: NOW,
        source: fakeCoverageStore([
          { day: "2026-09-02", runId: 24, lines: 78060, cold: true },
          { day: "2026-09-02", runId: 23 },
          { day: "2026-09-02", runId: 22, lines: 78166 },
          { day: "2026-09-01", runId: 21, lines: 1, event: "pull_request" },
        ]),
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 22 },
      ]);
    });

    it("opens a day's runs newest first until one measured", async () => {
      const source = fakeCoverageStore([
        { day: "2026-09-02", runId: 31, lines: 78166 },
        { day: "2026-09-02", runId: 34, cold: true, lines: 1 },
        { day: "2026-09-02", runId: 33, cold: true, lines: 1 },
        { day: "2026-09-02", runId: 32, event: "pull_request", lines: 1 },
        { day: "2026-09-02", runId: 30, lines: 79000 },
      ]);
      const history = await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 31 },
      ]);
      expect(source.readNames.length).toBe(4);
    });

    it("opens only the day's coverage uploads among what the listing names", async () => {
      const run: CoverageRun = { day: "2026-09-02", runId: 71, lines: 78166 };
      const stored = fakeCoverageStore([run]);
      const read: string[] = [];
      const history = await refreshCoverageDebt({
        days: 1,
        now: NOW,
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
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 71 },
      ]);
      expect(read).toEqual([coverageObjectName(run)]);
    });

    it("takes a re-run's newest attempt, and reads today again once one lands", async () => {
      const store = new CoverageDebtStore(file);
      const first: CoverageRun = { day: "2026-09-02", runId: 41, lines: 78060 };
      expect(
        (await refreshCoverageDebt({
          days: 1,
          now: NOW,
          source: fakeCoverageStore([first]),
          store,
        })).samples,
      ).toEqual([{ day: "2026-09-02", uncoveredLines: 78060, runId: 41 }]);
      // Both attempts measured, and the one listed first is the older.
      const history = await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore([
          first,
          { ...first, attempt: 2, lines: 78166 },
        ]),
        store,
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 41 },
      ]);
    });

    it("keeps a day the history recorded by its newest run, and reads today again", async () => {
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          version: STORE_VERSION,
          days: {
            "2026-08-31": {
              measured: { uncoveredLines: 78404, runId: 12 },
              newestRun: 12,
            },
            "2026-09-02": {
              measured: { uncoveredLines: 78300, runId: 13 },
              newestRun: 13,
            },
          },
        }),
      );
      const source = fakeCoverageStore([
        { day: "2026-09-02", runId: 14, lines: 78166 },
      ]);
      const history = await refreshCoverageDebt({
        days: 3,
        now: NOW,
        source,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-08-31", uncoveredLines: 78404, runId: 12 },
        { day: "2026-09-02", uncoveredLines: 78166, runId: 14 },
      ]);
      expect(source.listed).toEqual(["2026-09-01", "2026-09-02"]);
    });

    it("leaves a day unread when its object cannot be read", async () => {
      const store = new CoverageDebtStore(file);
      const run: CoverageRun = { day: "2026-09-02", runId: 61, lines: 78166 };
      const first = await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: {
          list: () => Promise.resolve([coverageObjectName(run)]),
          read: () => Promise.reject(new Error("HTTP 503")),
        },
        store,
      });
      expect(first.samples).toEqual([]);
      expect((first.error as Error).message).toBe("HTTP 503");

      const second = await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore([run]),
        store,
      });
      expect(second.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 61 },
      ]);
    });

    it("costs one listing when nothing has landed since the last refresh", async () => {
      const store = new CoverageDebtStore(file);
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 71, lines: 78166 },
      ];
      await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore(runs),
        store,
      });
      const second = fakeCoverageStore(runs);
      const history = await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: second,
        store,
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 71 },
      ]);
      expect(second.listed).toEqual(["2026-09-02"]);
      expect(second.readNames).toEqual([]);
    });

    it("reads today again once a newer run has landed", async () => {
      const store = new CoverageDebtStore(file);
      const first: CoverageRun = { day: "2026-09-02", runId: 81, lines: 78166 };
      await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore([first]),
        store,
      });
      const history = await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore([
          first,
          { day: "2026-09-02", runId: 82, lines: 78040 },
        ]),
        store,
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78040, runId: 82 },
      ]);
    });

    it("does not rewrite the file when a refresh changed nothing", async () => {
      const store = new CoverageDebtStore(file);
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 91, lines: 78166 },
      ];
      await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore(runs),
        store,
      });
      const written = (await Deno.stat(file)).mtime?.getTime();
      await Deno.writeTextFile(`${file}.witness`, "");
      await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore(runs),
        store,
      });
      expect((await Deno.stat(file)).mtime?.getTime()).toBe(written);
    });

    it("keeps a day with no usable run, and does not ask about it again", async () => {
      const store = new CoverageDebtStore(file);
      await refreshCoverageDebt({
        days: 3,
        now: NOW,
        source: fakeCoverageStore([]),
        store,
      });
      const second = fakeCoverageStore([]);
      const history = await refreshCoverageDebt({
        days: 3,
        now: NOW,
        source: second,
        store,
      });
      expect(history.samples).toEqual([]);
      // A day two days old is settled, so only yesterday and today are
      // listed again.
      expect(second.listed).toEqual(["2026-09-01", "2026-09-02"]);
    });

    it("reads yesterday again, for a run that started before midnight", async () => {
      const store = new CoverageDebtStore(file);
      await refreshCoverageDebt({
        days: 2,
        now: NOW,
        source: fakeCoverageStore([]),
        store,
      });
      const history = await refreshCoverageDebt({
        days: 2,
        now: NOW,
        source: fakeCoverageStore([
          { day: "2026-09-01", runId: 61, lines: 78404 },
        ]),
        store,
      });
      expect(history.samples).toEqual([
        { day: "2026-09-01", uncoveredLines: 78404, runId: 61 },
      ]);
    });

    it("reports a failed read and asks again on the next refresh", async () => {
      const store = new CoverageDebtStore(file);
      const runs: CoverageRun[] = [
        { day: "2026-09-01", runId: 42, lines: 78404 },
        { day: "2026-09-02", runId: 41, lines: 78166 },
      ];
      const recovered = fakeCoverageStore(runs);
      const first = await refreshCoverageDebt({
        days: 2,
        now: NOW,
        source: {
          list: (day) =>
            day === "2026-09-01"
              ? Promise.reject(new Error("HTTP 502"))
              : recovered.list(day),
          read: recovered.read,
        },
        store,
      });
      expect(first.samples.map((sample) => sample.day)).toEqual(["2026-09-02"]);
      expect((first.error as Error).message).toBe("HTTP 502");

      const second = await refreshCoverageDebt({
        days: 2,
        now: NOW,
        source: recovered,
        store,
      });
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
        const history = await refreshCoverageDebt({
          days: 1,
          now: NOW,
          source: fakeCoverageStore([
            { day: "2026-09-02", runId: 101, lines: 78166 },
          ]),
          store: new CoverageDebtStore(join(directory, "gone", "history.json")),
        });
        expect(history.samples).toEqual([
          { day: "2026-09-02", uncoveredLines: 78166, runId: 101 },
        ]);
      } finally {
        console.error = error;
      }
      expect(logged).toEqual(["coverage debt: could not persist history:"]);
    });

    it("writes the history it could not write once the next refresh can", async () => {
      // The refresh after a failed write usually has nothing of its own to
      // write — that is what the newest-run check buys — so a store that
      // counted the failed attempt as saved would never come back here.
      const missing = join(directory, "gone");
      const store = new CoverageDebtStore(join(missing, "history.json"));
      const runs: CoverageRun[] = [
        { day: "2026-09-02", runId: 111, lines: 78166 },
      ];
      const error = console.error;
      console.error = () => {};
      try {
        await refreshCoverageDebt({
          days: 1,
          now: NOW,
          source: fakeCoverageStore(runs),
          store,
        });
      } finally {
        console.error = error;
      }
      await Deno.mkdir(missing);
      await refreshCoverageDebt({
        days: 1,
        now: NOW,
        source: fakeCoverageStore(runs),
        store,
      });

      const reopened = new CoverageDebtStore(join(missing, "history.json"));
      await reopened.load();
      expect(reopened.get("2026-09-02")?.measured?.uncoveredLines).toBe(78166);
    });

    it("keeps the days of the window it was given and drops the rest", async () => {
      const store = new CoverageDebtStore(file);
      await store.load();
      const old = utcDay(NOW - 30 * DAY_MS);
      store.set(old, { measured: { uncoveredLines: 90000, runId: 1 } });
      const history = await refreshCoverageDebt({
        days: 2,
        now: NOW,
        source: fakeCoverageStore([
          { day: "2026-09-02", runId: 51, lines: 78166 },
        ]),
        store,
      });
      expect(history.samples.map((sample) => sample.day)).toEqual([
        "2026-09-02",
      ]);
      expect(store.get(old)).toBeUndefined();
    });
  });
});
