import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { REPO, WORKFLOW_FILE } from "./ci-check-lib.ts";
import {
  commitIsGreen,
  decide,
  type Get,
  type Job,
  main,
  ORDER_WORKFLOW_FILE,
  orderJobName,
  seedHasRun,
} from "./test-order-tomorrow.ts";

const SEED = 20261029;
const COMMIT = "60cd866374f5b59bdf16c8469ad3f71cd35ac040";
const SELF = 900;
const NOW = new Date("2026-10-28T18:00:00Z");
const SINCE = new Date("2026-10-26T18:00:00Z");

interface Run {
  id: number;
  status?: string;
  conclusion: string | null;
}

/** A CI run of `COMMIT` that finished with `conclusion`. */
function finished(id: number, conclusion: string): Run {
  return { id, status: "completed", conclusion };
}

/** A CI run of `COMMIT` that has yet to finish. */
function going(id: number): Run {
  return { id, status: "in_progress", conclusion: null };
}

/**
 * A GitHub that knows the CI runs of `COMMIT`, the runs of this workflow
 * created since `SINCE`, and each of those runs' jobs. It answers a path
 * it does not know by throwing, and records every path it is asked.
 */
function github(
  ciRuns: Run[],
  orderRuns: Run[],
  jobs: Record<number, Job[]>,
): { get: Get; asked: string[] } {
  const pages = new Map<string, unknown>();
  const workflowRuns = (file: string, params: Record<string, string>) =>
    `/repos/${REPO}/actions/workflows/${file}/runs?${new URLSearchParams(
      { ...params, per_page: "100", page: "1" },
    )}`;
  pages.set(
    workflowRuns(WORKFLOW_FILE, { event: "push", head_sha: COMMIT }),
    { workflow_runs: ciRuns },
  );
  pages.set(
    workflowRuns(ORDER_WORKFLOW_FILE, { created: `>=${SINCE.toISOString()}` }),
    { workflow_runs: orderRuns },
  );
  for (const [id, list] of Object.entries(jobs)) {
    pages.set(`/repos/${REPO}/actions/runs/${id}/jobs?per_page=100&page=1`, {
      jobs: list,
    });
  }
  const asked: string[] = [];
  const get = <T>(path: string): Promise<T> => {
    asked.push(path);
    if (!pages.has(path)) throw new Error(`unexpected request: ${path}`);
    return Promise.resolve(pages.get(path) as T);
  };
  return { get, asked };
}

/** The jobs of a run that ran the suites under `seed`. */
function ranUnder(seed: number, conclusion: string | null): Job[] {
  return [
    { name: "Tomorrow's seed", conclusion: "success" },
    { name: `${orderJobName(seed)} / Plan the Run`, conclusion: "success" },
    { name: `${orderJobName(seed)} / Tests (1/2)`, conclusion },
  ];
}

/** The jobs of a run that decided not to run the suites under `seed`. */
function skippedUnder(seed: number): Job[] {
  return [
    { name: "Tomorrow's seed", conclusion: "success" },
    { name: orderJobName(seed), conclusion: "skipped" },
  ];
}

describe("test-order-tomorrow", () => {
  describe("commitIsGreen()", () => {
    it("returns true when a CI run of the push passed", async () => {
      for (
        const runs of [
          [finished(1, "success")],
          [finished(1, "failure"), finished(2, "success")],
          [going(1), finished(2, "success")],
        ]
      ) {
        expect(await commitIsGreen(COMMIT, github(runs, [], {}).get)).toBe(
          true,
        );
      }
    });

    it("returns false when no CI run of the push has passed", async () => {
      for (
        const runs of [
          [],
          [going(1)],
          [finished(1, "failure")],
          [finished(1, "cancelled"), going(2)],
        ]
      ) {
        expect(await commitIsGreen(COMMIT, github(runs, [], {}).get)).toBe(
          false,
        );
      }
    });

    it("throws for an answer that lists no runs", async () => {
      const get: Get = <T>() => Promise.resolve({ total_count: 0 } as T);
      await expect(commitIsGreen(COMMIT, get)).rejects.toThrow(
        'has no "workflow_runs"',
      );
    });

    it("reads every page of the runs", async () => {
      const failures = Array.from(
        { length: 100 },
        (_, id) => finished(id, "failure"),
      );
      const second =
        `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?${new URLSearchParams(
          {
            event: "push",
            head_sha: COMMIT,
            per_page: "100",
            page: "2",
          },
        )}`;
      const { get } = github(failures, [], {});
      const paged: Get = <T>(path: string) =>
        path === second
          ? Promise.resolve({ workflow_runs: [finished(100, "success")] } as T)
          : get<T>(path);
      expect(await commitIsGreen(COMMIT, paged)).toBe(true);
    });
  });

  describe("seedHasRun()", () => {
    it("returns true when another run ran or is running the seed", async () => {
      for (const conclusion of ["success", "failure", "cancelled", null]) {
        const { get } = github([], [{ id: 1, conclusion }], {
          1: ranUnder(SEED, conclusion),
        });
        expect(await seedHasRun(SEED, SELF, SINCE, get)).toBe(true);
      }
    });

    it("returns false when no other run ran the seed", async () => {
      // Run 2 was cancelled while it waited, before it started a job. Run 4
      // skipped every job, and has no jobs listed to read.
      const { get, asked } = github([], [
        { id: SELF, conclusion: null },
        { id: 1, conclusion: "success" },
        { id: 2, conclusion: "cancelled" },
        { id: 3, conclusion: "failure" },
        { id: 4, conclusion: "skipped" },
      ], {
        [SELF]: ranUnder(SEED, null),
        1: skippedUnder(SEED),
        2: [],
        3: ranUnder(SEED - 1, "failure"),
      });
      expect(await seedHasRun(SEED, SELF, SINCE, get)).toBe(false);
      expect(asked.some((path) => path.includes(`/runs/${SELF}/`))).toBe(
        false,
      );
    });

    it("returns false for a run whose suites never started", async () => {
      // A run whose seed job failed names the call without a seed.
      const { get } = github([], [{ id: 1, conclusion: "failure" }], {
        1: [
          { name: "Tomorrow's seed", conclusion: "failure" },
          { name: "Tomorrow's order ()", conclusion: "skipped" },
        ],
      });
      expect(await seedHasRun(SEED, SELF, SINCE, get)).toBe(false);
    });

    it("stops at the first run that ran the seed", async () => {
      const { get, asked } = github([], [
        { id: 2, conclusion: "success" },
        { id: 1, conclusion: "success" },
      ], { 2: ranUnder(SEED, "success"), 1: ranUnder(SEED, "success") });
      expect(await seedHasRun(SEED, SELF, SINCE, get)).toBe(true);
      expect(asked.some((path) => path.includes("/runs/1/"))).toBe(false);
    });
  });

  describe("decide()", () => {
    it("runs the seed at a green head no other run ran it at", async () => {
      const { get } = github([finished(1, "success")], [], {});
      expect(await decide(SEED, COMMIT, SELF, NOW, get)).toEqual({
        run: true,
        reason: `Running seed ${SEED} at ${COMMIT}.`,
      });
    });

    it("does not run the seed at a head CI has not passed on", async () => {
      for (const run of [finished(1, "failure"), going(1)]) {
        const { get, asked } = github([run], [], {});
        expect(await decide(SEED, COMMIT, SELF, NOW, get)).toEqual({
          run: false,
          reason: `CI has not passed on the head of main, ${COMMIT}; a ` +
            `later green head runs seed ${SEED}.`,
        });
        expect(asked).toHaveLength(1);
      }
    });

    it("does not run a seed another run ran", async () => {
      const { get } = github([finished(1, "success")], [{
        id: 2,
        conclusion: "failure",
      }], { 2: ranUnder(SEED, "failure") });
      expect(await decide(SEED, COMMIT, SELF, NOW, get)).toEqual({
        run: false,
        reason: `Another run has run seed ${SEED}.`,
      });
    });
  });

  describe("main()", () => {
    const env = (name: string) =>
      ({ GITHUB_SHA: COMMIT, GITHUB_RUN_ID: `${SELF}` })[name];

    it("prints the decision and says why", async () => {
      const { get } = github([finished(1, "success")], [], {});
      const printed: string[] = [];
      const announced: string[] = [];
      expect(
        await main(
          [`${SEED}`],
          env,
          NOW,
          get,
          (line) => printed.push(line),
          (line) => announced.push(line),
        ),
      ).toBe(0);
      expect(printed).toEqual(["true"]);
      expect(announced).toEqual([`Running seed ${SEED} at ${COMMIT}.`]);
    });

    it("prints false when the head is not green", async () => {
      const { get } = github([finished(1, "failure")], [], {});
      const printed: string[] = [];
      expect(
        await main(
          [`${SEED}`],
          env,
          NOW,
          get,
          (line) => printed.push(line),
          () => {},
        ),
      ).toBe(0);
      expect(printed).toEqual(["false"]);
    });

    it("refuses a command line or environment it cannot read", async () => {
      const cases: [string[], (name: string) => string | undefined][] = [
        [[], env],
        [["tomorrow"], env],
        [[`${SEED}`, `${SEED}`], env],
        [[""], env],
        [[" "], env],
        [["1e3"], env],
        [["0x10"], env],
        [[`${SEED}`], () => undefined],
        [[`${SEED}`], (name: string) => name === "GITHUB_SHA" ? COMMIT : " "],
      ];
      for (const [args, environment] of cases) {
        const printed: string[] = [];
        const announced: string[] = [];
        const { get, asked } = github([], [], {});
        expect(
          await main(
            args,
            environment,
            NOW,
            get,
            (line) => printed.push(line),
            (line) => announced.push(line),
          ),
        ).toBe(2);
        expect(printed).toEqual([]);
        expect(asked).toEqual([]);
        expect(announced[0]).toContain("test-order-tomorrow takes a seed");
      }
    });
  });
});
