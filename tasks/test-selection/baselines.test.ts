import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type BaselineRun,
  type BaselineSource,
  collectCoverageBaselines,
  liveBaselineSource,
  publishableBaselines,
  splitMeasuredSet,
} from "./baselines.ts";
import {
  coverageMetricForGroup,
  measuredSetCoverageMetric,
  PERF_METRICS_ARTIFACT_NAME,
  type WorkflowRun,
} from "../ci-check-lib.ts";
import { LOCAL_COVERAGE_BASELINE_DAYS } from "./policy.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z");

/** A day inside or outside the window, as an ISO moment. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A source answering with exactly what a case describes. */
function source(
  runs: readonly BaselineRun[],
  metrics: Record<number, Record<string, number>>,
): BaselineSource {
  return {
    runs: () => Promise.resolve(runs),
    metrics: (id) =>
      Promise.resolve(
        metrics[id] === undefined ? undefined : new Map(
          Object.entries(metrics[id]!),
        ),
      ),
  };
}

describe("baselines", () => {
  describe("naming a measured set", () => {
    it("splits at the first slash, however deep the member sits", () => {
      expect(splitMeasuredSet("workspace-unit/packages/connectors/github"))
        .toEqual({
          suite: "workspace-unit",
          member: "packages/connectors/github",
        });
    });

    it("refuses a name with no member or no suite", () => {
      expect(splitMeasuredSet("workspace-unit")).toBeUndefined();
      expect(splitMeasuredSet("/packages/memory")).toBeUndefined();
      expect(splitMeasuredSet("workspace-unit/")).toBeUndefined();
    });
  });

  describe("the baselines a manifest carries", () => {
    it("takes each run's measured-set figures against its commit", async () => {
      const baselines = await collectCoverageBaselines(
        source([{ id: 1, commit: "abc", createdAt: daysAgo(1) }], {
          1: {
            [measuredSetCoverageMetric("workspace-unit/packages/memory")]: 12,
            [measuredSetCoverageMetric("runner-unit/packages/runner")]: 40,
          },
        }),
        NOW,
      );
      expect(baselines).toEqual([
        {
          suite: "runner-unit",
          member: "packages/runner",
          commit: "abc",
          createdAt: daysAgo(1),
          uncoveredLines: 40,
        },
        {
          suite: "workspace-unit",
          member: "packages/memory",
          commit: "abc",
          createdAt: daysAgo(1),
          uncoveredLines: 12,
        },
      ]);
    });

    it("leaves out a run older than the window", async () => {
      const baselines = await collectCoverageBaselines(
        source([
          { id: 1, commit: "recent", createdAt: daysAgo(1) },
          {
            id: 2,
            commit: "ancient",
            createdAt: daysAgo(LOCAL_COVERAGE_BASELINE_DAYS + 1),
          },
        ], {
          1: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 1 },
          2: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 2 },
        }),
        NOW,
      );
      expect(baselines.map((base) => base.commit)).toEqual(["recent"]);
    });

    it("leaves out a run whose artifact says nothing", async () => {
      const baselines = await collectCoverageBaselines(
        source([{ id: 1, commit: "abc", createdAt: daysAgo(1) }], {}),
        NOW,
      );
      expect(baselines).toEqual([]);
    });

    it("never reads a source group as a measured set", async () => {
      const baselines = await collectCoverageBaselines(
        source([{ id: 1, commit: "abc", createdAt: daysAgo(1) }], {
          1: {
            [coverageMetricForGroup("packages/memory")]: 900,
            [coverageMetricForGroup("workspace")]: 90_000,
          },
        }),
        NOW,
      );
      expect(baselines).toEqual([]);
    });

    it("keeps two suites over one member apart", async () => {
      const baselines = await collectCoverageBaselines(
        source([{ id: 1, commit: "abc", createdAt: daysAgo(1) }], {
          1: {
            [measuredSetCoverageMetric("workspace-unit/packages/memory")]: 12,
            [measuredSetCoverageMetric("memory-e2e/packages/memory")]: 800,
          },
        }),
        NOW,
      );
      expect(baselines.map((base) => [base.suite, base.uncoveredLines]))
        .toEqual([
          ["memory-e2e", 800],
          ["workspace-unit", 12],
        ]);
    });

    it("carries forward what the previous manifest held", async () => {
      const known = [{
        suite: "workspace-unit",
        member: "packages/a",
        commit: "earlier",
        createdAt: daysAgo(2),
        uncoveredLines: 7,
      }];
      const baselines = await collectCoverageBaselines(
        source([{ id: 1, commit: "later", createdAt: daysAgo(1) }], {
          1: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 5 },
        }),
        NOW,
        known,
      );
      expect(baselines.map((base) => [base.commit, base.uncoveredLines]))
        .toEqual([["later", 5], ["earlier", 7]]);
    });

    it("drops a carried baseline that has fallen out of the window", async () => {
      const known = [{
        suite: "workspace-unit",
        member: "packages/a",
        commit: "ancient",
        createdAt: daysAgo(LOCAL_COVERAGE_BASELINE_DAYS + 1),
        uncoveredLines: 7,
      }];
      expect(await collectCoverageBaselines(source([], {}), NOW, known))
        .toEqual([]);
    });

    it("never reads a run a carried baseline already names", async () => {
      // Reading one costs an artifact listing and a download, and the
      // figure would be the same.
      const asked: number[] = [];
      const watching: BaselineSource = {
        runs: () =>
          Promise.resolve([{ id: 1, commit: "known", createdAt: daysAgo(1) }]),
        metrics: (id) => {
          asked.push(id);
          return Promise.resolve(undefined);
        },
      };
      await collectCoverageBaselines(watching, NOW, [{
        suite: "workspace-unit",
        member: "packages/a",
        commit: "known",
        createdAt: daysAgo(1),
        uncoveredLines: 7,
      }]);
      expect(asked).toEqual([]);
    });

    it("stops at the first run past the window", async () => {
      const asked: number[] = [];
      const watching: BaselineSource = {
        runs: () =>
          Promise.resolve([
            {
              id: 1,
              commit: "old",
              createdAt: daysAgo(LOCAL_COVERAGE_BASELINE_DAYS + 1),
            },
            { id: 2, commit: "older", createdAt: daysAgo(1) },
          ]),
        metrics: (id) => {
          asked.push(id);
          return Promise.resolve(undefined);
        },
      };
      // The listing is newest first, so nothing past the first run outside
      // the window is worth asking about.
      await collectCoverageBaselines(watching, NOW);
      expect(asked).toEqual([]);
    });

    it("takes one commit's figures from the newest of its runs", async () => {
      // A commit can carry more than one successful run. Two baselines
      // at one commit would leave a comparison choosing between them by
      // whichever was listed first.
      const baselines = await collectCoverageBaselines(
        source([
          { id: 1, commit: "shared", createdAt: daysAgo(0.25) },
          { id: 2, commit: "shared", createdAt: daysAgo(0.75) },
        ], {
          1: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 5 },
          2: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 9 },
        }),
        NOW,
      );
      expect(baselines).toHaveLength(1);
      expect(baselines[0]?.uncoveredLines).toBe(5);
    });

    it("passes over a measured-set metric that names no member", async () => {
      const baselines = await collectCoverageBaselines(
        source([{ id: 1, commit: "abc", createdAt: daysAgo(1) }], {
          1: {
            [measuredSetCoverageMetric("workspace-unit")]: 5,
            [measuredSetCoverageMetric("workspace-unit/packages/a")]: 7,
          },
        }),
        NOW,
      );
      expect(baselines.map((base) => base.member)).toEqual(["packages/a"]);
    });

    it("stops at a run whose report names no measured set", async () => {
      // Such a run measured a tree where nothing publishes one, and
      // every older run is such a tree too, so reading further costs an
      // artifact download per run and finds nothing.
      const asked: number[] = [];
      const watching: BaselineSource = {
        runs: () =>
          Promise.resolve([
            { id: 1, commit: "newer", createdAt: daysAgo(1) },
            { id: 2, commit: "older", createdAt: daysAgo(2) },
          ]),
        metrics: (id) => {
          asked.push(id);
          return Promise.resolve(
            new Map([[coverageMetricForGroup("workspace"), 90_000]]),
          );
        },
      };
      expect(await collectCoverageBaselines(watching, NOW)).toEqual([]);
      expect(asked).toEqual([1]);
    });

    it("orders two runs of one day by the moment each was created", async () => {
      const baselines = await collectCoverageBaselines(
        source([
          { id: 1, commit: "later", createdAt: daysAgo(0.25) },
          { id: 2, commit: "earlier", createdAt: daysAgo(0.75) },
        ], {
          1: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 1 },
          2: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 2 },
        }),
        NOW,
      );
      expect(baselines.map((base) => base.commit))
        .toEqual(["later", "earlier"]);
    });

    it("passes over a run with an unreadable date", async () => {
      const baselines = await collectCoverageBaselines(
        source([{ id: 1, commit: "abc", createdAt: "not a date" }], {
          1: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 1 },
        }),
        NOW,
      );
      expect(baselines).toEqual([]);
    });
  });

  describe("reading the repository's own runs and artifacts", () => {
    /** One artifact, with only the fields the source reads. */
    const artifact = (
      over: Partial<{ id: number; name: string; expired: boolean }> = {},
    ) => ({
      id: 1,
      name: PERF_METRICS_ARTIFACT_NAME,
      expired: false,
      created_at: "2026-09-09T00:00:00.000Z",
      ...over,
      // deno-lint-ignore no-explicit-any
    } as any);

    /** One run, a successful push to `main` unless told otherwise. */
    const run = (
      over: Partial<WorkflowRun> & Pick<WorkflowRun, "id">,
    ): WorkflowRun => ({
      head_sha: `sha-${over.id}`,
      created_at: "2026-09-09T10:00:00Z",
      head_branch: "main",
      event: "push",
      conclusion: "success",
      html_url: "",
      ...over,
    });

    /**
     * A page of `count` runs, `candidates` of them ones a baseline could come
     * from. A page of 100 is a full one, which has another behind it.
     */
    const page = (
      count: number,
      candidates: number,
      from: number,
    ): WorkflowRun[] =>
      Array.from({ length: count }, (_, at) =>
        run({
          id: from + at,
          ...(at < candidates ? {} : { event: "pull_request" }),
        }));

    it("names each run by its commit and the moment it was created", async () => {
      const source = liveBaselineSource({
        list: () => Promise.resolve({ workflow_runs: [run({ id: 7 })] }),
      });
      expect(await source.runs()).toEqual([
        { id: 7, commit: "sha-7", createdAt: "2026-09-09T10:00:00Z" },
      ]);
    });

    it("leaves out a run that is not a successful push to main", async () => {
      const source = liveBaselineSource({
        list: () =>
          Promise.resolve({
            workflow_runs: [
              run({ id: 1, conclusion: "failure" }),
              run({ id: 2, event: "pull_request" }),
              run({ id: 3, head_branch: "topic" }),
              run({ id: 4 }),
            ],
          }),
      });
      expect((await source.runs()).map((one) => one.id)).toEqual([4]);
    });

    it("asks for a listing carrying none of the indexed filters", async () => {
      const asked: string[] = [];
      const source = liveBaselineSource({
        list: (path) => {
          asked.push(path);
          return Promise.resolve({ workflow_runs: [run({ id: 9 })] });
        },
      });
      await source.runs();

      expect(asked.length).toBe(1);
      const query = new URLSearchParams(asked[0].split("?")[1]);
      expect(query.get("page")).toBe("1");
      // Any one of these has GitHub answer out of the search index, which
      // serves a window of runs weeks old with nothing to mark it. Every run
      // such a window names falls outside the publisher's own window, so the
      // gathering would stop at the first of them.
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
    });

    it("reads another page while the last one was full", async () => {
      const asked: string[] = [];
      const source = liveBaselineSource({
        list: (path) => {
          asked.push(path);
          const at = Number(path.match(/[?&]page=(\d+)/)?.[1]);
          // Two full pages holding two candidates each, then a short one
          // ending the listing.
          return Promise.resolve({
            workflow_runs: at <= 2 ? page(100, 2, at * 1000) : page(5, 1, 3000),
          });
        },
      });
      const runs = await source.runs();

      expect(asked.length).toBe(3);
      expect(runs.map((one) => one.id)).toEqual([1000, 1001, 2000, 2001, 3000]);
    });

    it("stops once it has gathered the runs one publish reads", async () => {
      const asked: string[] = [];
      const source = liveBaselineSource({
        list: (path) => {
          asked.push(path);
          const at = Number(path.match(/[?&]page=(\d+)/)?.[1]);
          return Promise.resolve({ workflow_runs: page(100, 50, at * 1000) });
        },
      });
      const runs = await source.runs();

      // The cap is reached partway through the second page, and no page is
      // asked for behind it.
      expect(runs.length).toBe(100);
      expect(asked.length).toBe(2);
    });

    it("reads the uncovered count out of each metric the artifact holds", async () => {
      const source = liveBaselineSource({
        artifacts: () => Promise.resolve([artifact()]),
        baseline: () =>
          Promise.resolve({
            metrics: new Map([["coverage-debt: tasks uncovered lines", {
              uncoveredLines: 12,
            }]]),
          }),
      });
      expect([...(await source.metrics(7))!]).toEqual([
        ["coverage-debt: tasks uncovered lines", 12],
      ]);
    });

    it("passes over an artifact that has expired or is named otherwise", async () => {
      const asked: number[] = [];
      const source = liveBaselineSource({
        artifacts: () =>
          Promise.resolve([
            artifact({ id: 2, expired: true }),
            artifact({ id: 3, name: "something-else" }),
          ]),
        baseline: (id) => {
          asked.push(id);
          return Promise.resolve({ metrics: new Map() });
        },
      });
      expect(await source.metrics(7)).toBeUndefined();
      expect(asked).toEqual([]);
    });

    it("answers with nothing where the run's artifacts cannot be listed", async () => {
      // A publish reads many runs, and one that cannot be read
      // contributes no baseline rather than ending the publish.
      const source = liveBaselineSource({
        artifacts: () => Promise.reject(new Error("the interface said no")),
      });
      expect(await source.metrics(7)).toBeUndefined();
    });

    it("answers with nothing where the artifact cannot be parsed", async () => {
      const source = liveBaselineSource({
        artifacts: () => Promise.resolve([artifact()]),
        baseline: () => Promise.resolve(null),
      });
      expect(await source.metrics(7)).toBeUndefined();
    });
  });

  describe("what a publish carries", () => {
    const known = [{
      suite: "workspace-unit",
      member: "packages/a",
      commit: "earlier",
      createdAt: daysAgo(1),
      uncoveredLines: 7,
    }];

    it("carries what the last manifest held when it cannot read more", async () => {
      // Switching the gate off for one publish would report every set
      // as having nothing to compare against.
      expect(
        await publishableBaselines(NOW, known, source([], {}), undefined),
      ).toEqual(known);
      expect(await publishableBaselines(NOW, known, source([], {}), ""))
        .toEqual(known);
    });

    it("carries what the last manifest held when the source throws", async () => {
      const broken: BaselineSource = {
        runs: () => Promise.reject(new Error("the interface said no")),
        metrics: () => Promise.resolve(undefined),
      };
      expect(await publishableBaselines(NOW, known, broken, "a token"))
        .toEqual(known);
    });

    it("adds what a run published to what it carried", async () => {
      const baselines = await publishableBaselines(
        NOW,
        known,
        source([{ id: 1, commit: "later", createdAt: daysAgo(0.5) }], {
          1: { [measuredSetCoverageMetric("workspace-unit/packages/a")]: 5 },
        }),
        "a token",
      );
      expect(baselines.map((base) => base.commit))
        .toEqual(["later", "earlier"]);
    });
  });
});
