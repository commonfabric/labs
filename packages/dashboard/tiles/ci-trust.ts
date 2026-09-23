/**
 * Reports the share of recent completed runs that passed on the first attempt,
 * which is the dashboard's signal for flakiness, with a history strip carrying
 * the newest runs in the trust window. An attempt cancelled before it started a
 * job, as a queued run is when a newer push replaces it, is not a try and is
 * passed over. A run passes on the first try when exactly one try is left and
 * it succeeded. A try that did not succeed, a cancelled attempt that ran jobs
 * among them, makes the run a failure, and so does a second try whatever its
 * result, since the run needed a rerun. A run with no try left is left out of
 * the share. One factory builds both the labs and loom instances against their
 * own repository and workflow.
 */

import {
  runSource,
  type Run,
  type Status,
  type Tile,
  type TileView,
} from "../types.ts";
import { CompletedAttempts } from "../completed-attempts.ts";
import { strip } from "../lib.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO, TRUST_GOOD, TRUST_RUNS_MAX, TRUST_WARN } from "../config.ts";

type TrustOutcome = "green" | "red" | "run" | "gray";

/**
 * Scores `run` by the attempts left once every attempt cancelled before it
 * started a job is passed over: green when exactly one is left and it
 * succeeded, gray when none is, and red otherwise, so a rerun makes a run red
 * whatever its result. An unfinished run is left out of the share too. Reads
 * attempts in order and stops once the outcome is decided. Rejects when an
 * earlier attempt, or a cancelled attempt's job count, cannot be read from
 * GitHub.
 */
async function trustOutcome(
  run: Run,
  attempts: CompletedAttempts,
): Promise<TrustOutcome> {
  if (run.status === "in_progress") return "run";
  if (run.status !== "completed" || !run.conclusion) return "gray";
  let passed = false;
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const tried = await attempts.get(run, attempt);
    if (await attempts.cancelledBeforeAnyJob(tried)) continue;
    if (passed || tried.conclusion !== "success") return "red";
    passed = true;
  }
  return passed ? "green" : "gray";
}

function makeCiTrust(opts: { label: string; repo: string; workflow: string }): Tile {
  const attempts = new CompletedAttempts(opts.repo);
  return {
    label: opts.label,
    intervalMs: 30_000,
    runSources: [runSource(opts.repo, opts.workflow)],
    async collect(ctx): Promise<TileView> {
      const runs = await ctx.runsFor(opts.repo, opts.workflow);
      const recent = runs.slice(0, TRUST_RUNS_MAX);
      attempts.observe(recent);
      const scored = await Promise.all(recent.map(async (run) => ({
        run,
        outcome: await trustOutcome(run, attempts),
      })));
      const counted = scored.filter(({ outcome }) => outcome === "green" || outcome === "red");
      const firstTryGreen = counted.filter(({ outcome }) => outcome === "green").length;
      const pct = counted.length ? (firstTryGreen / counted.length) * 100 : 0;
      const s: Status = counted.length === 0
        ? "unknown"
        : pct >= TRUST_GOOD ? "good" : pct >= TRUST_WARN ? "warn" : "bad";
      const runSummary = counted.length === scored.length
        ? `last ${scored.length} runs`
        : `${counted.length} of last ${scored.length} runs`;
      const cells = [...scored].reverse().map(({ run, outcome }) => ({
        outcome,
        href: run.html_url,
      }));
      const times = scored.flatMap(({ run }) => {
        const createdAt = Date.parse(run.created_at);
        return Number.isFinite(createdAt) ? [createdAt] : [];
      });
      const spanMs = times.length === scored.length && times.length >= 2
        ? Math.max(...times) - Math.min(...times)
        : 0;
      return {
        status: s,
        value: `${pct.toFixed(1)}%`,
        sub: `first-try green · ${runSummary}`,
        extra: strip(cells, spanMs > 0),
        duration: spanMs,
        alignChartBottom: true,
      };
    },
  };
}

export const labsCiTrust = makeCiTrust({ label: "labs ci trust", repo: REPO, workflow: CI_WORKFLOW });
export const loomCiTrust = makeCiTrust({ label: "loom ci trust", repo: LOOM_REPO, workflow: LOOM_CI_WORKFLOW });
