#!/usr/bin/env -S deno run --allow-env --allow-net=api.github.com

/**
 * Decides whether a run of `.github/workflows/test-order-tomorrow.yml`
 * runs the suites under the next Pacific day's seed. It does when the
 * CI workflow passed on the commit the run checks out, which is the head
 * of `main`, and no other run of that workflow has run the suites under
 * that seed yet. In the evening, a run fails when no run has run the seed
 * and CI failed on the head of `main`.
 *
 * Usage: test-order-tomorrow.ts SEED
 *
 * The commit is `GITHUB_SHA` and the run asking is `GITHUB_RUN_ID`. It
 * prints `true` or `false` to standard output, and why to standard error.
 */

import {
  githubGet,
  REPO,
  WORKFLOW_FILE,
  type WorkflowRun,
} from "./ci-check-lib.ts";
import { daySeed } from "@commonfabric/test-support/shuffle";

/** What the jobs of a run under a seed are listed under, before `/`. */
export const ORDER_JOB_NAME = "Tomorrow's order";

/** This workflow's file under `.github/workflows/`. */
export const ORDER_WORKFLOW_FILE = "test-order-tomorrow.yml";

/**
 * How far back the runs that may have run a seed were created. A run
 * picks its seed on the Pacific day before that seed's, which is at most
 * 25 hours long, and it may have waited behind the run ahead of it for
 * as long as that run took.
 */
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

/** How long before the next Pacific day starts the evening does. */
const EVENING_MS = 6 * 60 * 60 * 1000;

export interface Job {
  name: string;
  conclusion: string | null;
}

export type Get = <T>(path: string) => Promise<T>;

/** Whether `now` is in the evening, the last hours of its Pacific day. */
export function isEvening(now: Date): boolean {
  return daySeed(new Date(now.getTime() + EVENING_MS)) !== daySeed(now);
}

/** The name of the jobs of a run under `seed`, before `/`. */
export function orderJobName(seed: number): string {
  return `${ORDER_JOB_NAME} (${seed})`;
}

/** Every entry under `key` of every page `path` lists. */
async function listed<T>(
  get: Get,
  path: string,
  params: Record<string, string>,
  key: string,
): Promise<T[]> {
  const all: T[] = [];
  const perPage = 100;
  for (let page = 1;; page++) {
    const query = new URLSearchParams({
      ...params,
      per_page: `${perPage}`,
      page: `${page}`,
    });
    const data = await get<Record<string, T[] | undefined>>(
      `${path}?${query}`,
    );
    const found = data[key];
    if (found === undefined) {
      throw new Error(`GitHub's answer to ${path} has no "${key}".`);
    }
    for (const entry of found) all.push(entry);
    if (found.length < perPage) return all;
  }
}

/**
 * Where the CI workflow's runs for a push of `commit` stand: one passed,
 * or one has yet to finish, which includes having none yet, or every one
 * finished without passing.
 */
export async function ciState(
  commit: string,
  get: Get = githubGet,
): Promise<"passed" | "running" | "failed"> {
  const runs = await listed<WorkflowRun>(
    get,
    `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs`,
    { event: "push", head_sha: commit },
    "workflow_runs",
  );
  if (runs.some((run) => run.conclusion === "success")) return "passed";
  if (runs.length === 0 || runs.some((run) => run.status !== "completed")) {
    return "running";
  }
  return "failed";
}

/**
 * Whether a run of this workflow other than `self`, created after
 * `since`, started the suites under `seed`, whatever came of them. The
 * jobs of the called CI workflow, listed under the calling job's name and
 * `/`, exist once the suites have started. A run that skipped every job
 * started nothing, so its jobs are not read.
 */
export async function seedHasRun(
  seed: number,
  self: number,
  since: Date,
  get: Get = githubGet,
): Promise<boolean> {
  const runs = await listed<WorkflowRun>(
    get,
    `/repos/${REPO}/actions/workflows/${ORDER_WORKFLOW_FILE}/runs`,
    { created: `>=${since.toISOString()}` },
    "workflow_runs",
  );
  const prefix = `${orderJobName(seed)} / `;
  for (const run of runs) {
    if (run.id === self || run.conclusion === "skipped") continue;
    const jobs = await listed<Job>(
      get,
      `/repos/${REPO}/actions/runs/${run.id}/jobs`,
      {},
      "jobs",
    );
    if (jobs.some((job) => job.name.startsWith(prefix))) return true;
  }
  return false;
}

/**
 * What the run `self` at `now` does about `seed`, and why, in a line: it
 * runs the suites at `commit`, or skips them, or fails because the seed
 * went untested. Only a head CI passed on runs the suites. While CI on
 * the head has yet to finish, the run its finishing starts decides. When
 * CI failed on the head, a run outside the evening leaves the seed to a
 * later green head, and a run in the evening fails.
 */
export async function decide(
  seed: number,
  commit: string,
  self: number,
  now: Date,
  get: Get = githubGet,
): Promise<{ verdict: "run" | "skip" | "untested"; reason: string }> {
  const state = await ciState(commit, get);
  const unproven = `CI has ${
    state === "running" ? "not finished" : "failed"
  } on the head of main, ${commit}`;
  if (state === "running" || (state === "failed" && !isEvening(now))) {
    return {
      verdict: "skip",
      reason: `${unproven}; a later green head runs seed ${seed}.`,
    };
  }
  if (
    await seedHasRun(seed, self, new Date(now.getTime() - LOOKBACK_MS), get)
  ) {
    return { verdict: "skip", reason: `Another run has run seed ${seed}.` };
  }
  if (state === "failed") {
    return {
      verdict: "untested",
      reason: `No run has run seed ${seed}, and ${unproven}. Unless a ` +
        `green head comes first, the next Pacific day's commits will run ` +
        `in an order nothing has tested.`,
    };
  }
  return { verdict: "run", reason: `Running seed ${seed} at ${commit}.` };
}

/**
 * Runs the command line `args` with `env` at `now`, and returns the
 * status to exit with. It prints whether to run the suites, and fails
 * when a run in the evening finds the seed untested.
 */
export async function main(
  args: readonly string[],
  env: (name: string) => string | undefined,
  now: Date,
  get: Get = githubGet,
  print: (line: string) => void = console.log,
  announce: (line: string) => void = console.error,
): Promise<number> {
  const commit = env("GITHUB_SHA");
  const self = env("GITHUB_RUN_ID") ?? "";
  if (
    args.length !== 1 || !/^\d+$/.test(args[0]) || !commit ||
    !/^\d+$/.test(self)
  ) {
    announce(
      "test-order-tomorrow takes a seed, and reads GITHUB_SHA and " +
        "GITHUB_RUN_ID.",
    );
    return 2;
  }
  const { verdict, reason } = await decide(
    Number(args[0]),
    commit,
    Number(self),
    now,
    get,
  );
  announce(reason);
  if (verdict === "untested") return 1;
  print(String(verdict === "run"));
  return 0;
}

if (import.meta.main) {
  Deno.exitCode = await main(
    Deno.args,
    (name) => Deno.env.get(name),
    new Date(),
  );
}
