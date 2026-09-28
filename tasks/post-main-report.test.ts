import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  coverageRecords,
  RECORD_SCHEMA_VERSION,
  type RunContext,
  sampleEntry,
  sampleManifest,
  testIdentityKey,
} from "@commonfabric/test-support/records";

import type { WorkflowRun } from "./ci-check-lib.ts";
import { MAIN_REPORT_MARKER } from "./test-selection/report.ts";
import type { Suite } from "./test-topology/suite.ts";
import type { TestRecord } from "@commonfabric/test-support/records";

import type { ManifestFetch } from "./test-selection/store.ts";
import type { RunOutcomes } from "./test-selection/report.ts";
import { excusedMeasurementName } from "./lane-measurement.ts";
import { ciSubmissionsPrefix } from "./test-records-config.ts";
import { buildZip } from "./zip-testing.ts";
import {
  committedAt,
  coverageOfRun,
  isReportable,
  main,
  manifestView,
  outcomesFromArtifacts,
  outcomesFromStore,
  postReport,
  pullRequestHead,
  pullRequestOf,
  recordsInDirectory,
  reportsFromArtifacts,
  runAt,
  runGit,
  runPartitions,
  type StoredRun,
  withdrawReport,
} from "./post-main-report.ts";

//
// Fixtures
//

/** One request the poster made, as the fetch stub recorded it. */
interface Recorded {
  method: string;
  url: string;
  body?: string;
}

/** One comment a pull request is already carrying. */
interface Existing {
  body: string;

  /** The login it was written under. */
  author: string;
}

/**
 * Runs one of the posters against a pull request already carrying these
 * comments, and reports what it asked GitHub to do.
 */
async function posting(
  post: (pullRequest: number, body: string) => Promise<void>,
  body: string,
  existing: readonly Existing[],
): Promise<Recorded[]> {
  const requests: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST" || method === "PATCH") {
      requests.push({
        method,
        url,
        body: JSON.parse(String(init?.body)).body,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1 }), {
          status: method === "POST" ? 201 : 200,
        }),
      );
    }
    requests.push({ method, url });
    return Promise.resolve(
      new Response(
        JSON.stringify(
          existing.map((comment, index) => ({
            id: index + 1,
            body: comment.body,
            user: { login: comment.author },
          })),
        ),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  try {
    await post(4211, body);
  } finally {
    globalThis.fetch = original;
  }
  return requests.filter((request) => request.method !== "GET");
}

/** A run as the workflow-runs interface describes one. */
function workflowRun(fields: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 1,
    html_url: "https://ci/run/1",
    head_sha: "a".repeat(40),
    head_branch: "main",
    created_at: "2026-09-07T06:00:00Z",
    run_started_at: "2026-09-07T06:00:00Z",
    conclusion: "success",
    event: "push",
    ...fields,
  } as WorkflowRun;
}

/** One `test-records-*` artifact holding these records, as a zip. */
async function recordsZip(
  records: readonly TestRecord[],
): Promise<Uint8Array> {
  return await buildZip(
    "records.ndjson",
    new TextEncoder().encode(
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    ),
    0,
  );
}

/** One run's coverage artifact, carrying the figures a case names. */
async function coverageZip(
  uncovered: Readonly<Record<string, number>>,
): Promise<Uint8Array> {
  return await recordsZip(coverageRecords({
    groups: new Map(Object.entries(uncovered)),
    sets: new Map(),
    cold: false,
  }));
}

/** One test's record, which is all any of these cases needs of one. */
function record(name: string, outcome: TestRecord["outcome"]): TestRecord {
  return {
    line: "record",
    test: { k: "unit", s: "bakery", n: name },
    outcome,
    durationMs: 1,
  };
}

/**
 * The context line a pull request's run writes ahead of its records,
 * naming the merge it tested. The branch tip is `b` repeated.
 */
function tested(commit: string): RunContext {
  return {
    schema: RECORD_SCHEMA_VERSION,
    line: "context",
    reportId: "01J8Z3K4Q5R6S7T8V9W0X1Y2Z3",
    repo: "commonfabric/labs",
    commit,
    dirty: false,
    env: "ci",
    ci: {
      workflowRunId: "3",
      runAttempt: 1,
      workflow: "CI",
      job: "Test",
      headCommit: "b".repeat(40),
      event: "pull_request",
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.5.0",
    startedAt: "2026-09-07T05:40:00Z",
  };
}

/**
 * The name of an object the store holds for a run in the continuous
 * integration provider, under the day `day` its attempt started.
 */
function stored(day: string, stem: string): string {
  return `${ciSubmissionsPrefix()}/v${RECORD_SCHEMA_VERSION}/${day}/` +
    `${stem}.ndjson`;
}

/** A record a lane wrote about itself, which says the run ran in lanes. */
const laneMeasurement: TestRecord = {
  line: "record",
  test: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" },
  outcome: "pass",
  durationMs: 1,
};

/** The record a lane writes for a test whose failures it excused. */
function excusing(name: string): TestRecord {
  return {
    line: "record",
    test: {
      k: "gate",
      s: "ci",
      n: excusedMeasurementName(
        testIdentityKey({ k: "unit", s: "bakery", n: name }),
      ),
    },
    outcome: "pass",
    durationMs: 0,
  };
}

const kneads = { k: "unit", s: "bakery", n: "kneads" };
const proves = { k: "unit", s: "bakery", n: "proves" };

/** The one unit every test these cases name lives in. */
const bakeryUnit = "packages/bakery/test/bakery.test.ts";

/** A tree holding one suite of one unit, which is where these tests live. */
const suites: Suite[] = [{
  id: "workspace-unit",
  recordSurfaces: [{ kind: "unit", scope: "bakery" }],
  needs: ["deno"],
  units: [bakeryUnit],
  unavailable: [],
  whole: [],
  locate: () => undefined,
  command: () => Promise.resolve([]),
}];

/** A manifest holding `kneads` back as too flaky to judge a change by. */
const manifest = sampleManifest({
  entries: [
    sampleEntry(kneads, {
      unit: bakeryUnit,
      flakeRate: 0.5,
      flakeEvidence: { flakes: 20, runs: 20 },
      cost: 1,
    }),
    // No counts, as an entry from a manifest written before they were
    // published has none.
    sampleEntry(proves, {
      unit: bakeryUnit,
      flakeRate: 0.002,
      cost: 1,
      inputs: { catches: 3, sources: 2, churn: 0 },
    }),
  ],
  withheld: [{ test: kneads, suite: "workspace-unit", reason: "flaky" }],
});

/** What one case says the world outside the reporter holds. */
interface World {
  /** The run named in the event, and the run at the commit's parent. */
  runs: readonly WorkflowRun[];

  /** What each run's `test-records-*` artifact holds, by run id. */
  records: Record<number, readonly TestRecord[]>;

  /** The commit subject `git log` gives. */
  subject: string;

  /** The comments the pull request is already carrying. */
  comments: readonly Existing[];

  /** Whether the pull request exists. */
  pullRequest?: boolean;

  /** Uncovered lines per source group, by run id, where a case gives them. */
  uncovered?: Record<number, Record<string, number>>;

  /** The run whose records artifact refuses to download. */
  unreadable?: number;

  /**
   * When each commit was made, by its hash, as the commits interface
   * gives it; null for a commit that interface cannot find. A commit the
   * case does not name was made at five in the morning.
   */
  committed?: Record<string, string | null>;

  /** What the store gives for a manifest, by the moment it is asked at. */
  manifests?: Record<string, ManifestFetch>;

  /** The suites the tree declares. */
  suites?: Suite[];

  /**
   * When the commit under report was made, as `git log` gives it; null
   * for a git that refuses to say. Half past eight in the morning, two
   * hours east of UTC, where a case does not say.
   */
  madeHere?: string | null;

  /** Every moment a manifest was asked for at, which the case fills in. */
  resolved?: string[];

  /**
   * Whether the pull request has a run of its own, run 3 at its head.
   * Where a case does not say, it has one exactly when the case gives
   * that run's records.
   */
  theirRun?: boolean;

  /**
   * What the pull request's own run recorded, as the store holds it, where
   * the case gives that run's records.
   */
  theirRecords?: readonly (TestRecord | RunContext)[];
}

/**
 * Runs the whole reporter against one world and reports what it asked
 * GitHub to write. Everything it reads over the network goes through the
 * one stub; the checkout, the tree and the store come through its deps.
 */
async function reporting(
  world: World,
  dryRun = false,
): Promise<Recorded[]> {
  const requests: Recorded[] = [];
  const original = globalThis.fetch;
  const event = await Deno.makeTempDir({ prefix: "run-report-" });
  await Deno.writeTextFile(
    `${event}/event.json`,
    JSON.stringify({ workflow_run: world.runs[0] }),
  );
  Deno.env.set("GITHUB_EVENT_PATH", `${event}/event.json`);

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST" || method === "PATCH") {
      requests.push({
        method,
        url,
        body: JSON.parse(String(init?.body)).body,
      });
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }
    if (/\/actions\/runs\/\d+$/.test(url)) {
      const id = Number(url.match(/runs\/(\d+)$/)![1]);
      const run = world.runs.find((candidate) => candidate.id === id);
      if (run === undefined) {
        return new Response("no", { status: 404, statusText: "Not Found" });
      }
      return Response.json(run);
    }
    if (url.includes("/actions/workflows/")) {
      const sha = new URL(url).searchParams.get("head_sha");
      const theirRun = world.theirRun ?? world.theirRecords !== undefined;
      const theirs = !theirRun ? [] : [workflowRun({
        id: 3,
        head_sha: "b".repeat(40),
        event: "pull_request",
      })];
      return Response.json({
        workflow_runs: [...world.runs, ...theirs].filter((run) =>
          run.head_sha === sha
        ),
      });
    }
    if (url.endsWith("/zip")) {
      const id = Number(url.match(/artifacts\/(\d+)\/zip/)![1]);
      // An artifact id over a hundred is a run's coverage; under it, the
      // records of the run with that id.
      if (id > 100) {
        const lines = world.uncovered?.[id - 100];
        if (lines === undefined) {
          return new Response("no", { status: 404, statusText: "Not Found" });
        }
        return new Response(await coverageZip(lines) as BodyInit, {
          status: 200,
        });
      }
      if (world.unreadable === id) {
        return new Response("no", { status: 404, statusText: "Not Found" });
      }
      const body = await recordsZip(world.records[id] ?? []);
      return new Response(body as BodyInit, { status: 200 });
    }
    if (url.includes("/artifacts")) {
      const id = Number(url.match(/runs\/(\d+)\/artifacts/)![1]);
      // A run the case gives no figures for uploaded no coverage.
      const artifacts = [
        { id, name: "test-records-Test", size_in_bytes: 1, expired: false },
        ...world.uncovered?.[id] === undefined ? [] : [{
          id: id + 100,
          name: "test-records-coverage-a1",
          size_in_bytes: 1,
          expired: false,
        }],
      ];
      return Response.json({ total_count: artifacts.length, artifacts });
    }
    if (/\/pulls\/\d+$/.test(url)) {
      if (world.pullRequest === false) {
        return new Response("no", { status: 404, statusText: "Not Found" });
      }
      return Response.json({ head: { sha: "b".repeat(40) } });
    }
    if (url.includes("/commits/")) {
      const date = world.committed?.[url.slice(url.lastIndexOf("/") + 1)];
      if (date === null) {
        return new Response("no", { status: 404, statusText: "Not Found" });
      }
      return Response.json({
        commit: { committer: { date: date ?? "2026-09-07T05:00:00Z" } },
      });
    }
    if (url.includes("/issues/") && url.includes("/comments")) {
      return Response.json(
        world.comments.map((comment, index) => ({
          id: index + 1,
          body: comment.body,
          user: { login: comment.author },
        })),
      );
    }
    // The store, which holds the pull request's own run under the day it
    // started where a case gives its records, and otherwise nothing, so
    // that run reads as one nothing is known about.
    if (url.includes("/storage/v1/")) {
      const prefix = new URL(url).searchParams.get("prefix") ?? "";
      const names = world.theirRecords === undefined
        ? []
        : [stored("2026/09/07", "run-3-Test")];
      return Response.json({
        items: names.filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
      });
    }
    return new Response(
      (world.theirRecords ?? []).map((line) => JSON.stringify(line))
        .join("\n") + "\n",
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    await main(dryRun, {
      git: (...args: string[]) => {
        if (args.includes("--format=%cI")) {
          return world.madeHere === null
            ? Promise.reject(new Error("git log failed"))
            : Promise.resolve(
              `${world.madeHere ?? "2026-09-07T08:30:00+02:00"}\n`,
            );
        }
        if (args[0] === "log") return Promise.resolve(`${world.subject}\n`);
        if (args[0] === "rev-parse") {
          return Promise.resolve(`${"c".repeat(40)}\n`);
        }
        return Promise.resolve("packages/bakery/src/oven.ts\n");
      },
      topology: () => Promise.resolve(world.suites ?? []),
      manifest: ({ at }) => {
        world.resolved?.push(at);
        return Promise.resolve(
          world.manifests?.[at] ?? { absent: "nothing published yet" },
        );
      },
    });
  } finally {
    globalThis.fetch = original;
    Deno.env.delete("GITHUB_EVENT_PATH");
    await Deno.remove(event, { recursive: true });
  }
  return requests.filter((request) => request.method !== "GET");
}

describe("post-main-report", () => {
  describe("pullRequestOf()", () => {
    it("reads the number a squash merge puts in the subject", () => {
      expect(pullRequestOf("fix(oven): hold the temperature (#7008)"))
        .toBe(7008);
    });

    it("takes the merge's own number when the subject names two", () => {
      expect(pullRequestOf("revert of (#6900), reland (#7008)")).toBe(7008);
    });

    // A commit pushed straight to the default branch has none, and that is
    // why nothing is posted rather than a pull request being guessed at.
    it("finds none in a subject that names none", () => {
      expect(pullRequestOf("fix(oven): hold the temperature")).toBeUndefined();
    });

    it("does not read an issue reference as a pull request", () => {
      expect(pullRequestOf("close #7008 by holding the temperature"))
        .toBeUndefined();
    });
  });

  describe("isReportable()", () => {
    const run = (fields: Partial<WorkflowRun>): WorkflowRun =>
      ({
        event: "push",
        head_branch: "main",
        conclusion: "success",
        ...fields,
      }) as WorkflowRun;

    it("takes a finished push to the default branch", () => {
      expect(isReportable(run({}))).toBe(true);
      expect(isReportable(run({ conclusion: "failure" }))).toBe(true);
    });

    // A workflow_run payload describes the run it names, so these are the
    // triggering run's own facts and mean what they say.
    it("leaves a pull request's run and another branch alone", () => {
      expect(isReportable(run({ event: "pull_request" }))).toBe(false);
      expect(isReportable(run({ head_branch: "a-branch" }))).toBe(false);
    });

    // A run killed at its bound is the shape a hanging test takes, and
    // every note needs evidence rather than the absence of it, so what
    // such a run did record is worth reading.
    it("takes a run killed at its bound", () => {
      expect(isReportable(run({ conclusion: "cancelled" }))).toBe(true);
      expect(isReportable(run({ conclusion: "timed_out" }))).toBe(true);
    });

    it("leaves a run that never started alone", () => {
      expect(isReportable(run({ conclusion: "skipped" }))).toBe(false);
      expect(isReportable(run({ conclusion: "action_required" }))).toBe(false);
    });
  });

  describe("runAt()", () => {
    /** Answers one workflow-runs listing with these runs. */
    async function asking(
      runs: readonly Partial<WorkflowRun>[],
    ): Promise<{ url: string; found?: number }> {
      const original = globalThis.fetch;
      let url = "";
      globalThis.fetch = ((input: string | URL | Request) => {
        url = typeof input === "string" ? input : input.toString();
        return Promise.resolve(
          new Response(JSON.stringify({ workflow_runs: runs }), {
            status: 200,
          }),
        );
      }) as typeof fetch;
      try {
        const run = await runAt("a".repeat(40), "push");
        return run === undefined ? { url } : { url, found: run.id };
      } finally {
        globalThis.fetch = original;
      }
    }

    it("asks for the finished runs at that commit on the branch", async () => {
      const { url } = await asking([]);
      expect(url).toContain(`head_sha=${"a".repeat(40)}`);
      expect(url).toContain("status=completed");
      expect(url).toContain("branch=main");
      expect(url).toContain("event=push");
    });

    it("takes the newest run at that commit that left records", async () => {
      const { found } = await asking([
        { id: 3, conclusion: "skipped" },
        { id: 2, conclusion: "cancelled" },
        { id: 1, conclusion: "success" },
      ]);
      expect(found).toBe(2);
    });

    it("finds nothing when no run at that commit left any", async () => {
      const { found } = await asking([{ id: 3, conclusion: "skipped" }]);
      expect(found).toBeUndefined();
    });
  });

  describe("runPartitions()", () => {
    it("gives one day for a run that was never re-run", () => {
      expect(runPartitions({
        created_at: "2026-09-07T06:53:17Z",
        run_started_at: "2026-09-07T06:53:17Z",
      } as WorkflowRun)).toEqual(["2026/09/07"]);
    });

    // An object is named for the day its attempt started, so a run
    // re-run after a UTC midnight has its two attempts under two days.
    it("gives both days for a run re-run after a midnight", () => {
      expect(runPartitions({
        created_at: "2026-09-06T23:57:12Z",
        run_started_at: "2026-09-07T00:14:02Z",
      } as WorkflowRun)).toEqual(["2026/09/06", "2026/09/07"]);
    });

    it("gives every day a run spent between its first and last attempt", () => {
      expect(runPartitions({
        created_at: "2026-09-05T23:57:12Z",
        run_started_at: "2026-09-07T00:14:02Z",
      } as WorkflowRun)).toEqual(["2026/09/05", "2026/09/06", "2026/09/07"]);
    });

    it("gives no day for a run timed with nothing that is a moment", () => {
      expect(runPartitions({
        created_at: "not a moment",
        run_started_at: "not a moment",
      } as WorkflowRun)).toEqual([]);
    });

    it("gives the day it can read when the other is not a moment", () => {
      expect(runPartitions({
        created_at: "2026-09-07T06:53:17Z",
        run_started_at: "not a moment",
      } as WorkflowRun)).toEqual(["2026/09/07"]);
    });
  });

  describe("manifestView()", () => {
    it("reports what the packing reached and what was held back", () => {
      const view = manifestView(manifest, suites, new Set());
      expect(view.manifest).toBe(true);
      expect(view.withheld.get(testIdentityKey(kneads))).toBe("flaky");
      expect(view.selected.has(testIdentityKey(proves))).toBe(true);
    });

    it("carries the flake counts and the catches behind every entry", () => {
      const view = manifestView(manifest, suites, new Set());
      expect(view.flakes.get(testIdentityKey(kneads)))
        .toEqual({ flakes: 20, runs: 20 });
      // An entry with no counts is still a key, since membership is what
      // says the store has seen the test at all.
      expect(view.flakes.has(testIdentityKey(proves))).toBe(true);
      expect(view.flakes.get(testIdentityKey(proves))).toBeUndefined();
      expect(view.catches.get(testIdentityKey(proves))).toBe(3);
    });

    // Which unit a test lives in is what says whether a run that did not
    // record it ran its unit at all.
    it("carries the unit every entry lives in", () => {
      const view = manifestView(manifest, suites, new Set());
      expect(view.units.get(testIdentityKey(kneads)))
        .toBe(`workspace-unit\t${bakeryUnit}`);
    });

    // The tree decides what exists. A manifest naming a unit this tree no
    // longer holds is work no run could have done, so nothing about it
    // reaches the packing.
    it("drops an entry naming a unit the tree no longer holds", () => {
      const view = manifestView(
        manifest,
        [{ ...suites[0]!, units: [] }],
        new Set(),
      );
      expect(view.selected.size).toBe(0);
    });
  });

  describe("runGit()", () => {
    it("gives back what git printed", async () => {
      expect((await runGit("rev-parse", "HEAD")).trim()).toMatch(
        /^[0-9a-f]{40}$/,
      );
    });

    // A git that failed has not answered the question asked, and standing
    // in an empty answer would read as a commit with no subject and no
    // diff.
    it("throws what git said when git refused", async () => {
      await expect(runGit("rev-parse", "not-a-ref-in-any-repository"))
        .rejects.toThrow("git rev-parse not-a-ref-in-any-repository failed");
    });
  });

  describe("outcomesFromStore()", () => {
    /**
     * Answers each store listing with the objects among these whose names
     * are under the prefix it asks for, each one record, under a context
     * naming the commit given for it where one is. An object is named for
     * its day, as `stored()` names it.
     */
    async function fromStore(
      names: readonly string[],
      commits: Readonly<Record<string, string>> = {},
      run: WorkflowRun = workflowRun({ id: 5 }),
    ): Promise<StoredRun | undefined> {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/storage/v1/")) {
          const prefix = new URL(url).searchParams.get("prefix") ?? "";
          return Promise.resolve(
            Response.json({
              items: names.filter((name) => name.startsWith(prefix))
                .map((name) => ({ name })),
            }),
          );
        }
        const commit = commits[url.slice(url.lastIndexOf("/") + 1)];
        return Promise.resolve(
          new Response(
            [
              ...(commit === undefined ? [] : [tested(commit)]),
              record("kneads", "pass"),
            ].map((line) => JSON.stringify(line)).join("\n") + "\n",
            { status: 200 },
          ),
        );
      }) as typeof fetch;
      try {
        return await outcomesFromStore(run);
      } finally {
        globalThis.fetch = original;
      }
    }

    it("folds the records of every object the run wrote", async () => {
      const outcomes = await fromStore([stored("2026/09/07", "run-5-Test")]);
      expect(outcomes?.outcomes.get('["unit","bakery","kneads"]'))
        .toEqual({ passed: 1, failed: 0 });
    });

    it("reads each object once where a re-run's attempts are under two days", async () => {
      // The run was created one day and re-run the next, so each attempt
      // wrote its object under its own day, and both days are listed.

      const outcomes = await fromStore(
        [
          stored("2026/09/07", "run-5-Test-1"),
          stored("2026/09/08", "run-5-Test-2"),
        ],
        {},
        workflowRun({
          id: 5,
          created_at: "2026-09-07T23:00:00Z",
          run_started_at: "2026-09-08T01:00:00Z",
        }),
      );
      expect(outcomes?.outcomes.get('["unit","bakery","kneads"]'))
        .toEqual({ passed: 2, failed: 0 });
    });

    it("names the commit every report of the run tested", async () => {
      const found = await fromStore(
        [
          stored("2026/09/07", "run-5-Test-1"),
          stored("2026/09/07", "run-5-Test-2"),
        ],
        {
          "run-5-Test-1.ndjson": "d".repeat(40),
          "run-5-Test-2.ndjson": "d".repeat(40),
        },
      );
      expect(found?.commit).toBe("d".repeat(40));
      expect(found?.outcomes.get('["unit","bakery","kneads"]'))
        .toEqual({ passed: 2, failed: 0 });
    });

    it("names no commit where the reports name several", async () => {
      const found = await fromStore(
        [
          stored("2026/09/07", "run-5-Test-1"),
          stored("2026/09/07", "run-5-Test-2"),
        ],
        {
          "run-5-Test-1.ndjson": "d".repeat(40),
          "run-5-Test-2.ndjson": "e".repeat(40),
        },
      );
      expect(found?.outcomes.size).toBe(1);
      expect(found?.commit).toBeUndefined();
    });

    // A run whose records never arrived is a run nothing is known about,
    // not a run that skipped every test it did not record.
    it("gives nothing for a run the store holds nothing for", async () => {
      expect(await fromStore([])).toBeUndefined();
    });
  });

  describe("recordsInDirectory()", () => {
    it("reads every record line the artifact holds", async () => {
      const directory = await Deno.makeTempDir({ prefix: "records-" });
      try {
        await Deno.writeTextFile(
          `${directory}/records.ndjson`,
          JSON.stringify(record("kneads", "fail")) + "\nnot a record\n",
        );
        const records = await recordsInDirectory(directory);
        expect(records.length).toBe(1);
        expect(records[0]!.outcome).toBe("fail");
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    // The gather step always writes the file, so one that is not there is
    // a truncated artifact and contributes nothing.
    it("reads nothing from an artifact carrying no records file", async () => {
      const directory = await Deno.makeTempDir({ prefix: "records-" });
      try {
        expect(await recordsInDirectory(directory)).toEqual([]);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  });

  describe("outcomesFromArtifacts()", () => {
    /** Answers the artifact listing with one artifact, and its zip with a 500. */
    async function unreadable(): Promise<RunOutcomes | undefined> {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/zip")) {
          return Promise.resolve(new Response("no", { status: 500 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              total_count: 1,
              artifacts: [{
                id: 1,
                name: "test-records-Test",
                size_in_bytes: 1,
                expired: false,
              }],
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;
      try {
        return await outcomesFromArtifacts(7);
      } finally {
        globalThis.fetch = original;
      }
    }

    // A share of a run that could not be read would otherwise read as a
    // share the run did not run, and a report built on that withdraws
    // one an earlier attempt correctly made.
    it("says nothing at all when one artifact could not be read", async () => {
      expect(await unreadable()).toBeUndefined();
    });
  });

  describe("reportsFromArtifacts()", () => {
    it("returns each attempt's records apart, and none of the coverage upload's", async () => {
      // A lane re-run is two artifacts, and what one attempt excused is
      // only an excusal of what that attempt failed.

      const zips: Record<number, Uint8Array> = {
        5: await recordsZip([excusing("kneads"), record("kneads", "fail")]),
        7: await recordsZip([record("kneads", "fail")]),
      };
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        const id = Number(url.match(/artifacts\/(\d+)\/zip/)![1]);
        return Promise.resolve(
          new Response(zips[id]! as BodyInit, { status: 200 }),
        );
      }) as typeof fetch;
      const upload = (id: number, name: string) => ({
        id,
        name,
        size_in_bytes: 1,
        expired: false,
      });
      try {
        expect(
          await reportsFromArtifacts(7, [
            upload(5, "test-records-lane-a1"),
            upload(7, "test-records-lane-a2"),
            upload(9, "test-records-coverage-a2"),
          ]),
        ).toEqual([
          [excusing("kneads"), record("kneads", "fail")],
          [record("kneads", "fail")],
        ]);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe("coverageOfRun()", () => {
    it("returns the figures of the newest coverage upload", async () => {
      // Two attempts' uploads, listed oldest first: the re-run found the
      // compile cache warm where the first had not.
      const zips: Record<number, Uint8Array> = {
        9: await recordsZip(coverageRecords({
          groups: new Map([["workspace", 900]]),
          sets: new Map(),
          cold: false,
        })),
        5: await recordsZip(coverageRecords({
          groups: new Map([["workspace", 1000]]),
          sets: new Map(),
          cold: true,
        })),
      };
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        const id = Number(url.match(/artifacts\/(\d+)\/zip/)![1]);
        return Promise.resolve(
          new Response(zips[id]! as BodyInit, { status: 200 }),
        );
      }) as typeof fetch;
      const upload = (id: number, name: string) => ({
        id,
        name,
        size_in_bytes: 1,
        expired: false,
      });
      try {
        expect(
          await coverageOfRun(7, [
            upload(5, "test-records-coverage-a1"),
            upload(7, "test-records-check-a2"),
            upload(9, "test-records-coverage-a2"),
          ]),
        ).toEqual({
          groups: new Map([["workspace", 900]]),
          sets: new Map(),
          cold: false,
        });
      } finally {
        globalThis.fetch = original;
      }
    });

    it("returns no figure for a run with no coverage upload", async () => {
      expect(await coverageOfRun(7, [])).toEqual({
        groups: new Map(),
        sets: new Map(),
        cold: false,
      });
    });
  });

  describe("main()", () => {
    const here = workflowRun({ id: 1, head_sha: "a".repeat(40) });
    const there = workflowRun({
      id: 2,
      head_sha: "c".repeat(40),
      html_url: "https://ci/run/2",
    });
    const world = (fields: Partial<World> = {}): World => ({
      runs: [here, there],
      records: {
        1: [record("kneads", "fail"), record("proves", "pass")],
        2: [record("kneads", "pass"), record("proves", "pass")],
      },
      subject: "fix(oven): hold the temperature (#7008)",
      comments: [],
      ...fields,
    });

    it("posts what the run found that the pull request's run could not", async () => {
      const written = await reporting(world());
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("POST");
      expect(written[0]!.url).toContain("/issues/7008/comments");
      expect(written[0]!.body).toContain("Failing for the first time");
      expect(written[0]!.body).toContain("[unit] bakery: kneads");
      expect(written[0]!.body).toContain("aaaaaaaaaaaa");
    });

    it("prints what it would say and writes nothing on a dry run", async () => {
      expect(await reporting(world(), true)).toEqual([]);
    });

    it("writes nothing when the two runs agree", async () => {
      expect(
        await reporting(world({
          records: {
            1: [record("kneads", "pass")],
            2: [record("kneads", "pass")],
          },
        })),
      ).toEqual([]);
    });

    // A re-run that clears every note withdraws what the earlier attempt
    // said, rather than leaving it standing.
    it("withdraws a report an earlier attempt left", async () => {
      const written = await reporting(world({
        records: {
          1: [record("kneads", "pass")],
          2: [record("kneads", "pass")],
        },
        comments: [{
          body: `${MAIN_REPORT_MARKER}\nThe run found something.`,
          author: "github-actions[bot]",
        }],
      }));
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("PATCH");
      expect(written[0]!.body).toContain("no longer holds");
    });

    it("writes nothing for a commit with no pull request behind it", async () => {
      expect(
        await reporting(world({
          subject: "fix(oven): hold the temperature",
        })),
      ).toEqual([]);
    });

    // A number in a subject may name an issue, and an issue takes
    // comments the same way a pull request does.
    it("writes nothing when the number is not a pull request", async () => {
      expect(await reporting(world({ pullRequest: false }))).toEqual([]);
    });

    it("writes nothing for a run that is not a push to the branch", async () => {
      expect(
        await reporting(world({
          runs: [workflowRun({ id: 1, event: "pull_request" }), there],
        })),
      ).toEqual([]);
    });

    it("writes nothing when the parent commit has no finished run", async () => {
      expect(await reporting(world({ runs: [here] }))).toEqual([]);
    });

    it("writes nothing when a run recorded nothing", async () => {
      expect(await reporting(world({ records: { 1: [], 2: [] } }))).toEqual([]);
    });

    // A share of a run that could not be read would read as a share the
    // run did not run, so nothing is concluded from it at all.
    it("writes nothing when a run's artifact could not be read", async () => {
      expect(await reporting(world({ unreadable: 1 }))).toEqual([]);
    });

    it("carries the coverage the two runs measured", async () => {
      const written = await reporting(world({
        records: {
          1: [record("kneads", "pass")],
          2: [record("kneads", "pass")],
        },
        uncovered: {
          1: { workspace: 1000, "packages/bakery": 40 },
          2: { workspace: 900, "packages/bakery": 10 },
        },
      }));
      expect(written.length).toBe(1);
      expect(written[0]!.body).toContain("Coverage debt");
      expect(written[0]!.body).toContain("from 900 to 1000");
      expect(written[0]!.body).toContain("`packages/bakery`: 10 to 40");
    });

    it("says what the pull request's own run did where the store holds it", async () => {
      const written = await reporting(world({
        theirRecords: [record("kneads", "pass")],
      }));
      expect(written[0]!.body).toContain(
        "This pull request ran it, and it passed there",
      );
    });

    it("says nothing about whether the pull request's own run ran the test where the store holds none of its records", async () => {
      // The pull request's run is there to be found, and the relay has not
      // shipped what it recorded, so no manifest is resolved for it either.

      const resolved: string[] = [];
      const written = await reporting(world({
        suites,
        theirRun: true,
        manifests: { "2026-09-07T05:00:00.000Z": { manifest } },
        resolved,
      }));
      expect(resolved).toEqual([]);
      expect(written[0]!.body).toContain(
        "The pull request's own run could not be read, so there is nothing " +
          "to say about whether it ran this test.",
      );
      expect(written[0]!.body).not.toContain(
        "This pull request did not run it",
      );
    });

    describe("the manifest the pull request's own run resolved", () => {
      // The pull request's run tested the merge `d…`, made at half past
      // five, and ran `proves` and not `kneads`. Its branch tip `b…` was
      // made at five. The manifest holding `kneads` back was published
      // between the two, so only the merge's moment finds it.

      const merge = "d".repeat(40);

      const theirs = (fields: Partial<World> = {}): World =>
        world({
          suites,
          theirRecords: [
            tested(merge),
            laneMeasurement,
            record("proves", "pass"),
          ],
          committed: {
            [merge]: "2026-09-07T05:30:00Z",
            ["b".repeat(40)]: "2026-09-07T05:00:00Z",
          },
          manifests: {
            "2026-09-07T05:30:00.000Z": { manifest },
          },
          ...fields,
        });

      it("resolves it at the moment the merge that run tested was made", async () => {
        const written = await reporting(theirs());
        expect(written[0]!.body).toContain("too flaky to judge a change by");
      });

      it("never resolves it at the moment the branch tip was made", async () => {
        const written = await reporting(theirs({
          manifests: { "2026-09-07T05:00:00.000Z": { manifest } },
        }));
        expect(written[0]!.body).not.toContain("too flaky");
        expect(written[0]!.body).toContain(
          "This pull request did not run it, and there is no manifest to " +
            "say why.",
        );
      });

      it("says the run did not run the test where the merge's date cannot be read", async () => {
        const written = await reporting(theirs({
          committed: { [merge]: null },
        }));
        expect(written[0]!.body).not.toContain("too flaky");
        expect(written[0]!.body).toContain(
          "This pull request did not run it, and there is no manifest to " +
            "say why.",
        );
      });

      it("says the run did not run the test where its records name no one merge", async () => {
        const written = await reporting(theirs({
          theirRecords: [
            tested(merge),
            laneMeasurement,
            record("proves", "pass"),
            tested("e".repeat(40)),
            record("proves", "pass"),
          ],
          committed: {
            [merge]: "2026-09-07T05:30:00Z",
            ["e".repeat(40)]: "2026-09-07T05:30:00Z",
          },
        }));
        expect(written[0]!.body).toContain(
          "This pull request did not run it, and there is no manifest to " +
            "say why.",
        );
      });

      it("says the run did not run the test where that run did not run in lanes", async () => {
        // A run of the jobs that ran every test in a fixed arrangement
        // chose nothing, so no manifest says why it did not run a test.

        const written = await reporting(theirs({
          theirRecords: [tested(merge), record("proves", "pass")],
        }));
        expect(written[0]!.body).not.toContain("too flaky");
        expect(written[0]!.body).toContain(
          "This pull request did not run it, and there is no manifest to " +
            "say why.",
        );
      });
    });

    describe("a test the run did not fail for", () => {
      // The run under report ran in lanes, and a lane recorded excusing
      // `kneads`, whose three runs failed here where its three runs at the
      // parent passed. The manifest resolved at the moment the commit was
      // made carries the store's counts for it.

      /** The moment the commit under report was made, in UTC. */
      const madeAt = "2026-09-07T06:30:00.000Z";

      /** The run under report's records, with or without the excusal. */
      const here = (excused: boolean): TestRecord[] => [
        laneMeasurement,
        ...(excused ? [excusing("kneads")] : []),
        record("kneads", "fail"),
        record("kneads", "fail"),
        record("kneads", "fail"),
        record("proves", "pass"),
      ];

      const laned = (fields: Partial<World> = {}): World =>
        world({
          records: {
            1: here(true),
            2: [
              record("kneads", "pass"),
              record("kneads", "pass"),
              record("kneads", "pass"),
              record("proves", "pass"),
            ],
          },
          suites,
          manifests: { [madeAt]: { manifest } },
          ...fields,
        });

      it("reports it as a known flaky test the run was not failed by", async () => {
        const written = await reporting(laned());
        expect(written.length).toBe(1);
        const body = written[0]!.body!;
        expect(body).toContain("A known flaky test that failed every time");
        expect(body).toContain(
          "failed all 3 of its runs at this commit and passed all 3 of its " +
            "runs at the commit before",
        );
        expect(body).toContain("disagree with itself 20 times in 20 runs");
        expect(body).not.toContain("Failing for the first time");
      });

      it("reports a first failure where the run did not run in lanes", async () => {
        // Excusing a failure is a lane's decision, so a run with no lane
        // in it failed for everything that failed in it.

        const written = await reporting(laned({
          records: { ...laned().records, 1: here(false).slice(1) },
        }));
        expect(written[0]!.body).toContain("Failing for the first time");
        expect(written[0]!.body).not.toContain("known flaky test");
      });

      it("reports a first failure where the lane recorded excusing nothing", async () => {
        // A lane withdraws an excusal from a batch that did not account
        // for everything it was asked to run, and fails the run for it,
        // whatever the manifest holds back.

        const written = await reporting(laned({
          records: { ...laned().records, 1: here(false) },
        }));
        expect(written[0]!.body).toContain("Failing for the first time");
        expect(written[0]!.body).not.toContain("known flaky test");
      });

      it("reads no manifest for the run where no note needs its counts", async () => {
        const resolved: string[] = [];
        await reporting(laned({
          records: { ...laned().records, 1: here(false) },
          resolved,
        }));
        expect(resolved).toEqual([]);
        await reporting(laned({ resolved }));
        expect(resolved).toEqual([madeAt]);
      });

      describe("posts the note without the store's counts", () => {
        // The counts label the note, and nothing about the note rests on
        // them, so a manifest that cannot be read costs the label alone.

        /** What the run posts, which must be the note with no counts. */
        async function uncounted(fields: Partial<World>): Promise<string> {
          const written = await reporting(laned(fields));
          const body = written[0]!.body!;
          expect(body).toContain("A known flaky test that failed every time");
          expect(body).not.toContain("disagree with itself");
          return body;
        }

        it("where no manifest was published", async () => {
          await uncounted({ manifests: {} });
        });

        it("where the store could not be asked", async () => {
          await uncounted({
            manifests: {
              [madeAt]: {
                absent: "the listing was refused",
                unreachable: true,
              },
            },
          });
        });

        it("where git will not say when the commit was made", async () => {
          await uncounted({ madeHere: null });
        });

        it("where the commit carries no usable date", async () => {
          await uncounted({ madeHere: "whenever" });
        });
      });
    });
  });

  describe("pullRequestHead()", () => {
    /** Answers the pull request and commit lookups however a case says. */
    async function asking(
      answer: (url: string) => Response,
    ): Promise<Awaited<ReturnType<typeof pullRequestHead>>> {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) =>
        Promise.resolve(
          answer(typeof input === "string" ? input : input.toString()),
        )) as typeof fetch;
      try {
        return await pullRequestHead(7008);
      } finally {
        globalThis.fetch = original;
      }
    }

    it("gives the branch tip", async () => {
      expect(
        await asking(() => Response.json({ head: { sha: "b".repeat(40) } })),
      ).toBe("b".repeat(40));
    });

    // A number in a commit subject may name an issue, and an issue takes
    // comments the same way a pull request does.
    it("says the number is not a pull request when there is none", async () => {
      expect(
        await asking(() =>
          new Response("no", { status: 404, statusText: "Not Found" })
        ),
      ).toBe("absent");
    });

    it("gives nothing when the interface could not answer", async () => {
      expect(
        await asking(() =>
          new Response("no", { status: 401, statusText: "Unauthorized" })
        ),
      ).toBeUndefined();
    });
  });

  describe("committedAt()", () => {
    /** Answers the commit lookup however a case says. */
    async function asking(answer: Response): Promise<string | undefined> {
      const original = globalThis.fetch;
      globalThis.fetch = (() => Promise.resolve(answer)) as typeof fetch;
      try {
        return await committedAt("d".repeat(40));
      } finally {
        globalThis.fetch = original;
      }
    }

    it("gives the moment the commit was made, in UTC", async () => {
      expect(
        await asking(Response.json({
          commit: { committer: { date: "2026-09-07T07:30:00+02:00" } },
        })),
      ).toBe("2026-09-07T05:30:00.000Z");
    });

    it("gives nothing when the commit carries no usable date", async () => {
      expect(
        await asking(Response.json({
          commit: { committer: { date: "whenever" } },
        })),
      ).toBeUndefined();
    });

    it("gives nothing when the interface could not find the commit", async () => {
      expect(
        await asking(
          new Response("no", { status: 422, statusText: "Unprocessable" }),
        ),
      ).toBeUndefined();
    });
  });

  describe("runUnderReport()", () => {
    /** Runs the reporter with MAIN_REPORT_RUN_ID set to this. */
    async function withOverride(id: string): Promise<Recorded[]> {
      Deno.env.set("MAIN_REPORT_RUN_ID", id);
      try {
        return await reporting({
          runs: [
            workflowRun({
              id: 9,
              head_sha: "a".repeat(40),
              html_url: "https://ci/run/9",
            }),
            workflowRun({ id: 2, head_sha: "c".repeat(40) }),
          ],
          records: {
            9: [record("kneads", "fail")],
            2: [record("kneads", "pass")],
          },
          subject: "fix(oven): hold the temperature (#7008)",
          comments: [],
        });
      } finally {
        Deno.env.delete("MAIN_REPORT_RUN_ID");
      }
    }

    // The run to report on is named by a person, and a value that names
    // no run would otherwise fall through to the event's.
    it("refuses a run selector that is not a run id", async () => {
      await expect(withOverride("not-a-run")).rejects.toThrow(
        "MAIN_REPORT_RUN_ID is not a run id",
      );
    });

    it("reports on the run its selector names", async () => {
      const written = await withOverride("9");
      expect(written.length).toBe(1);
      expect(written[0]!.body).toContain("https://ci/run/9");
      expect(written[0]!.body).toContain("[unit] bakery: kneads");
    });
  });

  describe("postReport()", () => {
    const body = `${MAIN_REPORT_MARKER}\nThe run found this.`;

    it("posts when the pull request carries no report yet", async () => {
      const written = await posting(postReport, body, [
        { body: "a review comment", author: "somebody" },
      ]);
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("POST");
      expect(written[0]!.body).toBe(body);
    });

    it("edits the report already there rather than adding another", async () => {
      // It is actionable and it ends: the same thing recurring edits the
      // comment that is there rather than adding another beside it.

      const written = await posting(postReport, body, [
        { body: "a review comment", author: "somebody" },
        {
          body: `${MAIN_REPORT_MARKER}\nThe run found something else.`,
          author: "github-actions[bot]",
        },
      ]);
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("PATCH");
      expect(written[0]!.url).toContain("/issues/comments/2");
      expect(written[0]!.body).toBe(body);
    });

    it("writes nothing when the report already says this", async () => {
      expect(
        await posting(postReport, body, [{
          body,
          author: "github-actions[bot]",
        }]),
      )
        .toEqual([]);
    });

    // The token this runs under may edit any comment on the pull request,
    // so a person quoting the marker must not have their comment
    // overwritten with the report.
    // Every review app on a pull request writes as a bot as well, so
    // matching on the login rather than on being one is what keeps this
    // from overwriting theirs.
    it("leaves another author's comment alone however it quotes the marker", async () => {
      const written = await posting(postReport, body, [
        {
          body: `Look at ${MAIN_REPORT_MARKER} in the source`,
          author: "somebody",
        },
        {
          body: `A review app quoting ${MAIN_REPORT_MARKER}`,
          author: "some-review-app[bot]",
        },
      ]);
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("POST");
    });
  });

  describe("withdrawReport()", () => {
    const withdrawal = `${MAIN_REPORT_MARKER}\nNothing to report.`;

    it("replaces a report an earlier attempt left standing", async () => {
      const written = await posting(withdrawReport, withdrawal, [
        {
          body: `${MAIN_REPORT_MARKER}\nThe run found something.`,
          author: "github-actions[bot]",
        },
      ]);
      expect(written.length).toBe(1);
      expect(written[0]!.method).toBe("PATCH");
      expect(written[0]!.body).toBe(withdrawal);
    });

    it("writes nothing when there is no report to withdraw", async () => {
      expect(
        await posting(withdrawReport, withdrawal, [
          { body: "a review comment", author: "somebody" },
        ]),
      ).toEqual([]);
    });
  });
});
