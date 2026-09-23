/**
 * coverage-debt-history: GitHub is replaced with a stand-in that answers with
 * real artifact zips, and the store is pointed at a temporary file. No network
 * and nothing outside the temporary directory each test makes for itself.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import { REPO } from "./config.ts";
import type { GitHubDownload } from "./lib.ts";
import {
  type CoverageDebtGitHub,
  CoverageDebtStore,
  daysEndingAt,
  STORE_VERSION,
  refreshCoverageDebt,
  utcDay,
  workspaceDebtOf,
} from "./coverage-debt-history.ts";
import { artifactZip } from "./test/artifact-zip.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 2, 13, 30);

/** A `perf-metrics` file recording `lines`, warm unless told otherwise. */
function metrics(lines: number, cache: "warm" | "cold" = "warm"): string {
  return JSON.stringify({
    version: 1,
    generatedAt: "2026-09-02T22:47:59.729Z",
    metrics: [
      {
        name: "coverage-debt: packages/runner uncovered lines",
        durationSeconds: Math.round(lines / 2),
      },
      {
        name: "coverage-debt: workspace uncovered lines",
        durationSeconds: lines,
      },
    ],
    compileCacheStates: { "pattern-unit": cache },
  });
}

interface FakeRun {
  id: number;

  /** The `perf-metrics` file the artifact holds; absent means there is none. */
  metrics?: string;

  /** Whether the artifact is listed but its download fails. */
  zipFails?: boolean;

  /** What the run is, over the successful `main` push it is by default. */
  over?: Partial<
    {
      head_branch: string;
      event: string;
      conclusion: string;
      created_at: string;
    }
  >;
}

interface FakeGitHub extends CoverageDebtGitHub {
  /** Every path the collection asked for, in order. */
  readonly paths: string[];
}

/** Runs the listing puts on one page, which is what the collection asks for. */
const PAGE_SIZE = 100;

/**
 * One listing of the days named, newest day first and a page to each day: the
 * day's runs ahead of runs no coverage number can come from, filling the page
 * out so that reaching an older day takes another page as it does of the real
 * listing. A day whose value is an `Error` fails the page it sits on, and a
 * day the record does not name has no runs.
 *
 * `pages`, where a case needs runs placed across the pages itself rather than
 * a page to each day, is served as the listing instead; `days` then says only
 * what each run's artifact holds.
 */
function fakeGitHub(
  days: Record<string, FakeRun[] | Error>,
  pages?: unknown[][],
): FakeGitHub {
  const paths: string[] = [];
  const runsById = new Map<number, FakeRun>();
  for (const runs of Object.values(days)) {
    if (Array.isArray(runs)) for (const run of runs) runsById.set(run.id, run);
  }
  const newestDayFirst = Object.keys(days).sort().reverse();

  /** The page the day sits on: its runs, newest first, then the filler. */
  const pageOf = (day: string) => {
    const listed = days[day];
    if (listed instanceof Error) throw listed;
    const runs = (listed ?? []).map((run, at) => ({
      id: run.id,
      created_at: `${day}T${String(23 - at).padStart(2, "0")}:00:00Z`,
      head_branch: "main",
      event: "push",
      conclusion: "success",
      ...run.over,
    }));
    while (runs.length < PAGE_SIZE) {
      runs.push({
        id: 900_000 + runs.length,
        created_at: `${day}T00:00:00Z`,
        head_branch: "topic",
        event: "pull_request",
        conclusion: "success",
      });
    }
    return runs;
  };

  return {
    paths,
    // deno-lint-ignore require-await
    json: async <T>(path: string): Promise<T> => {
      paths.push(path);
      const page = Number(path.match(/[?&]page=(\d+)/)?.[1] ?? 0);
      const runId = Number(path.match(/\/runs\/(\d+)\/artifacts/)?.[1] ?? 0);
      if (runId > 0) {
        const run = runsById.get(runId);
        // A run of the workflow uploads over a hundred artifacts, so a listing
        // covering them all does not reach the coverage baseline among them:
        // only the request naming it is answered with it.
        const asked = new URLSearchParams(path.split("?")[1] ?? "").get("name");
        const artifacts = run?.metrics === undefined ||
            asked !== "perf-metrics"
          ? []
          : [{ id: runId, name: "perf-metrics", expired: false }];
        return { artifacts } as T;
      }
      if (pages !== undefined) {
        return { workflow_runs: pages[page - 1] ?? [] } as T;
      }
      const day = newestDayFirst[page - 1];
      // Past the last day the record names the listing has ended.
      return { workflow_runs: day === undefined ? [] : pageOf(day) } as T;
    },
    download: async (path: string): Promise<GitHubDownload> => {
      paths.push(path);
      const id = Number(path.match(/\/artifacts\/(\d+)\/zip/)?.[1] ?? 0);
      const run = runsById.get(id);
      if (run?.metrics === undefined || run.zipFails) {
        return { ok: false, status: 404, body: new Uint8Array() };
      }
      return {
        ok: true,
        status: 200,
        body: await artifactZip("perf-metrics.json", run.metrics),
      };
    },
  };
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
    it("returns the repository-wide uncovered-line count", () => {
      expect(workspaceDebtOf(metrics(78166))).toBe(78166);
    });

    it("returns `undefined` for a run whose compile cache missed", () => {
      // A cold run reaches branches only a cold compile takes, so its debt sits
      // below a warm run's by about as much as a week of real work moves it.
      expect(workspaceDebtOf(metrics(78060, "cold"))).toBeUndefined();
    });

    it("returns `undefined` when no metric is the workspace one", () => {
      const file = JSON.stringify({
        metrics: [{
          name: "coverage-debt: tasks uncovered lines",
          durationSeconds: 1809,
        }],
      });
      expect(workspaceDebtOf(file)).toBeUndefined();
    });

    it("returns `undefined` rather than zero for content it cannot read", () => {
      expect(workspaceDebtOf("not json")).toBeUndefined();
      expect(workspaceDebtOf("[]")).toBeUndefined();
      expect(workspaceDebtOf("null")).toBeUndefined();
      expect(workspaceDebtOf(`{"metrics":"none"}`)).toBeUndefined();
      expect(workspaceDebtOf(`{"metrics":[null]}`)).toBeUndefined();
    });

    it("returns `undefined` for a count that is not a line count", () => {
      const withCount = (count: unknown) =>
        JSON.stringify({
          metrics: [{
            name: "coverage-debt: workspace uncovered lines",
            durationSeconds: count,
          }],
        });
      expect(workspaceDebtOf(withCount("78166"))).toBeUndefined();
      expect(workspaceDebtOf(withCount(-1))).toBeUndefined();
      expect(workspaceDebtOf(withCount(Number.NaN))).toBeUndefined();
      expect(workspaceDebtOf(withCount(0))).toBe(0);
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
            "2026-08-30": { newestRun: "not a run" },
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
      const github = fakeGitHub({
        "2026-08-31": [{ id: 11, metrics: metrics(79552) }],
        "2026-09-01": [{ id: 12, metrics: metrics(78404) }],
        "2026-09-02": [{ id: 13, metrics: metrics(78166) }],
      });
      const history = await refreshCoverageDebt({
        token: "t",
        days: 3,
        now: NOW,
        github,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-08-31", uncoveredLines: 79552, runId: 11 },
        { day: "2026-09-01", uncoveredLines: 78404, runId: 12 },
        { day: "2026-09-02", uncoveredLines: 78166, runId: 13 },
      ]);
      expect(history.error).toBeUndefined();
      expect(github.paths[0]).toContain(
        `repos/${REPO}/actions/workflows/deno.yml/runs`,
      );
    });

    it("asks for a listing carrying none of the indexed filters", async () => {
      const github = fakeGitHub({
        "2026-09-02": [{ id: 51, metrics: metrics(78166) }],
      });
      await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github,
        store: new CoverageDebtStore(file),
      });
      const listings = github.paths.filter((path) => path.includes("/runs?"));
      expect(listings.length).toBeGreaterThan(0);
      for (const path of listings) {
        const query = new URLSearchParams(path.split("?")[1]);
        expect(query.get("exclude_pull_requests")).toBe("true");
        // Any one of these has GitHub answer out of the search index, which
        // serves a window of runs weeks old with nothing to mark it.
        for (
          const filter of [
            "actor",
            "branch",
            "check_suite_id",
            "created",
            "event",
            "head_sha",
            "status",
          ]
        ) {
          expect(query.get(filter)).toBeNull();
        }
      }
    });

    it("reads a day's number from none but a successful main push", async () => {
      const github = fakeGitHub({
        "2026-09-02": [
          { id: 52, metrics: metrics(70000), over: { conclusion: "failure" } },
          { id: 53, metrics: metrics(71000), over: { event: "pull_request" } },
          { id: 54, metrics: metrics(72000), over: { head_branch: "topic" } },
        ],
      });
      const history = await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([]);
      expect(github.paths.filter((path) => !path.includes("/runs?")))
        .toEqual([]);
    });

    it("asks the artifact listing for the coverage baseline by name", async () => {
      const github = fakeGitHub({
        "2026-09-02": [{ id: 55, metrics: metrics(78166) }],
      });
      const history = await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 55 },
      ]);
      const listings = github.paths.filter((path) =>
        path.includes("/artifacts?")
      );
      expect(listings.length).toBe(1);
      expect(new URLSearchParams(listings[0].split("?")[1]).get("name"))
        .toBe("perf-metrics");
    });

    it("names a run once that two listing pages both hold", async () => {
      const day = "2026-09-02";
      const listed = (id: number, at: number) => ({
        id,
        created_at: `${day}T${String(23 - at).padStart(2, "0")}:00:00Z`,
        head_branch: "main",
        event: "push",
        conclusion: "success",
      });
      const filler = Array.from({ length: PAGE_SIZE - 1 }, (_, at) => ({
        ...listed(900_000 + at, 23),
        head_branch: "topic",
        event: "pull_request",
      }));
      // Run 41 ends the first page and, a run having landed between the two
      // reads, heads the second as well. Counted twice it takes two of the
      // day's three places and keeps run 43, the one that measured, out of
      // them — and the day would then be recorded as measuring nothing.
      const github = fakeGitHub({
        [day]: [{ id: 41 }, { id: 42 }, { id: 43, metrics: metrics(78166) }],
      }, [
        [...filler, listed(41, 0)],
        [listed(41, 0), listed(42, 1), listed(43, 2)],
      ]);
      const history = await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day, uncoveredLines: 78166, runId: 43 },
      ]);
    });

    it("passes over a run whose date does not read as a day", async () => {
      const github = fakeGitHub({
        "2026-09-02": [
          { id: 57, metrics: metrics(70000), over: { created_at: "soon" } },
          { id: 58, metrics: metrics(78166) },
        ],
      });
      const history = await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 58 },
      ]);
      expect(history.error).toBeUndefined();
    });

    it("leaves a day unread when the listing stopped short of it", async () => {
      const store = new CoverageDebtStore(file);
      // The page today's older runs would be on cannot be read, so the day
      // has been shown no usable run and has not been shown whole either.
      const cut = fakeGitHub({
        "2026-09-02": [],
        "2026-09-01": new Error("HTTP 502"),
      });
      const first = await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github: cut,
        store,
      });
      expect(first.samples).toEqual([]);
      expect((first.error as Error).message).toBe("HTTP 502");

      const whole = fakeGitHub({
        "2026-09-02": [{ id: 55, metrics: metrics(78166) }],
        "2026-09-01": [{ id: 56, metrics: metrics(78404) }],
      });
      const second = await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github: whole,
        store,
      });
      expect(second.samples).toEqual([
        { day: "2026-09-01", uncoveredLines: 78404, runId: 56 },
        { day: "2026-09-02", uncoveredLines: 78166, runId: 55 },
      ]);
    });

    it("stops at the run-listing page budget", async () => {
      // Page 151 keeps the listing full past the 150-page budget, and page 152
      // ends it, so the fixture cannot leave the case running forever.
      const fullPage = Array.from({ length: PAGE_SIZE }, (_, at) => ({
        id: at + 1,
        created_at: "not a date",
        head_branch: "topic",
        event: "pull_request",
        conclusion: "success",
      }));
      const github = fakeGitHub({}, Array(151).fill(fullPage));
      const warnings: unknown[][] = [];
      const warn = console.warn;
      console.warn = (...parts: unknown[]) => void warnings.push(parts);
      try {
        const history = await refreshCoverageDebt({
          token: "t",
          days: 1,
          now: NOW,
          github,
          store: new CoverageDebtStore(file),
        });
        expect(history.samples).toEqual([]);
      } finally {
        console.warn = warn;
      }

      expect(github.paths.length).toBe(150);
      const last = new URLSearchParams(github.paths[149].split("?")[1]);
      expect(last.get("page")).toBe("150");
      expect(warnings).toEqual([[
        "coverage debt: read 150 pages of runs without reaching " +
        "2026-09-02; the days it did not reach are left for a later refresh.",
      ]]);
    });

    it("passes over a cold run, a run with no artifact, and one it cannot parse", async () => {
      const github = fakeGitHub({
        "2026-09-02": [
          { id: 21 },
          { id: 22, metrics: metrics(78060, "cold") },
          { id: 23, metrics: metrics(78166) },
        ],
        "2026-09-01": [{ id: 24, metrics: "{" }],
      });
      const history = await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github,
        store: new CoverageDebtStore(file),
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 23 },
      ]);
    });

    it("leaves a day unread when its artifact download fails", async () => {
      const store = new CoverageDebtStore(file);
      const failing = fakeGitHub({
        "2026-09-02": [{ id: 61, metrics: metrics(78166), zipFails: true }],
      });
      const first = await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: failing,
        store,
      });
      expect(first.samples).toEqual([]);
      expect(first.error).toBeDefined();

      const recovered = fakeGitHub({
        "2026-09-02": [{ id: 61, metrics: metrics(78166) }],
      });
      const second = await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: recovered,
        store,
      });
      expect(second.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 61 },
      ]);
    });

    it("costs one request when nothing has landed since the last refresh", async () => {
      const store = new CoverageDebtStore(file);
      const days = {
        "2026-09-02": [{ id: 71, metrics: metrics(78166) }],
      };
      await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: fakeGitHub(days),
        store,
      });
      const second = fakeGitHub(days);
      const history = await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: second,
        store,
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78166, runId: 71 },
      ]);
      expect(second.paths.length).toBe(1);
      const query = new URLSearchParams(second.paths[0].split("?")[1]);
      expect(query.get("page")).toBe("1");
      for (const filter of ["branch", "event", "status", "created"]) {
        expect(query.get(filter)).toBeNull();
      }
    });

    it("reads today again once a newer run has landed", async () => {
      const store = new CoverageDebtStore(file);
      await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: fakeGitHub({
          "2026-09-02": [{ id: 81, metrics: metrics(78166) }],
        }),
        store,
      });
      const landed = fakeGitHub({
        "2026-09-02": [
          { id: 82, metrics: metrics(78040) },
          { id: 81, metrics: metrics(78166) },
        ],
      });
      const history = await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: landed,
        store,
      });
      expect(history.samples).toEqual([
        { day: "2026-09-02", uncoveredLines: 78040, runId: 82 },
      ]);
    });

    it("does not rewrite the file when a refresh changed nothing", async () => {
      const store = new CoverageDebtStore(file);
      const days = {
        "2026-09-02": [{ id: 91, metrics: metrics(78166) }],
      };
      await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: fakeGitHub(days),
        store,
      });
      const written = (await Deno.stat(file)).mtime?.getTime();
      await Deno.writeTextFile(`${file}.witness`, "");
      await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: fakeGitHub(days),
        store,
      });
      expect((await Deno.stat(file)).mtime?.getTime()).toBe(written);
    });

    it("opens no run when today's newest is the one it read before", async () => {
      const store = new CoverageDebtStore(file);
      const days = {
        "2026-09-01": [{ id: 31, metrics: metrics(78404) }],
        "2026-09-02": [{ id: 32, metrics: metrics(78166) }],
      };
      const first = fakeGitHub(days);
      await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github: first,
        store,
      });
      const second = fakeGitHub(days);
      const history = await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github: second,
        store,
      });
      expect(history.samples.length).toBe(2);
      // Only the listing: the day already read is not among the days asked
      // about, and today's newest run is the one its sample came from.
      expect(second.paths.filter((path) => !path.includes("/runs?")))
        .toEqual([]);
    });

    it("keeps a day with no usable run, and does not ask about it again", async () => {
      const store = new CoverageDebtStore(file);
      const days = { "2026-09-01": [], "2026-09-02": [] };
      await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github: fakeGitHub(days),
        store,
      });
      const second = fakeGitHub(days);
      const history = await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github: second,
        store,
      });
      expect(history.samples).toEqual([]);
      // The day is settled, so nothing of it is opened a second time.
      expect(second.paths.filter((path) => !path.includes("/runs?")))
        .toEqual([]);
    });

    it("reports a failed read and asks again on the next refresh", async () => {
      const store = new CoverageDebtStore(file);
      const failing = fakeGitHub({
        "2026-09-01": new Error("HTTP 502"),
        "2026-09-02": [{ id: 41, metrics: metrics(78166) }],
      });
      const first = await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github: failing,
        store,
      });
      expect(first.samples.map((sample) => sample.day)).toEqual(["2026-09-02"]);
      expect((first.error as Error).message).toBe("HTTP 502");

      const recovered = fakeGitHub({
        "2026-09-01": [{ id: 42, metrics: metrics(78404) }],
        "2026-09-02": [{ id: 41, metrics: metrics(78166) }],
      });
      const second = await refreshCoverageDebt({
        token: "t",
        days: 2,
        now: NOW,
        github: recovered,
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
          token: "t",
          days: 1,
          now: NOW,
          github: fakeGitHub({
            "2026-09-02": [{ id: 101, metrics: metrics(78166) }],
          }),
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
      const days = { "2026-09-02": [{ id: 111, metrics: metrics(78166) }] };
      const error = console.error;
      console.error = () => {};
      try {
        await refreshCoverageDebt({
          token: "t",
          days: 1,
          now: NOW,
          github: fakeGitHub(days),
          store,
        });
      } finally {
        console.error = error;
      }
      await Deno.mkdir(missing);
      await refreshCoverageDebt({
        token: "t",
        days: 1,
        now: NOW,
        github: fakeGitHub(days),
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
        token: "t",
        days: 2,
        now: NOW,
        github: fakeGitHub({
          "2026-09-02": [{ id: 51, metrics: metrics(78166) }],
        }),
        store,
      });
      expect(history.samples.map((sample) => sample.day)).toEqual([
        "2026-09-02",
      ]);
      expect(store.get(old)).toBeUndefined();
    });
  });
});
