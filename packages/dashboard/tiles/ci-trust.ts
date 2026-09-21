/**
 * Reports the share of recent completed runs that passed on the first attempt,
 * which is the dashboard's signal for flakiness, with a history strip carrying
 * the newest runs in the trust window. An attempt cancelled before it started a
 * job, as a queued run is when a newer push replaces it, is not a try: a run's
 * first other attempt decides it, and a run with no other attempt is left out
 * of the share. A cancelled attempt that ran jobs timed out or was stopped, and
 * is a failed try. One factory builds both the labs and loom instances against
 * their own repository and workflow.
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
 * Scores `run` by its first attempt that was not cancelled before it started a
 * job: green when that attempt succeeded, and red otherwise, a cancelled
 * attempt that ran jobs included. A run that is unfinished, or whose every
 * attempt was cancelled before it started a job, is left out of the share.
 * Rejects when an earlier attempt, or a cancelled attempt's job count, cannot
 * be read from GitHub.
 */
async function trustOutcome(
  run: Run,
  attempts: CompletedAttempts,
): Promise<TrustOutcome> {
  if (run.status === "in_progress") return "run";
  if (run.status !== "completed" || !run.conclusion) return "gray";
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const tried = await attempts.get(run, attempt);
    if (!(await attempts.cancelledBeforeAnyJob(tried))) {
      return tried.conclusion === "success" ? "green" : "red";
    }
  }
  return "gray";
}

function makeCiTrust(opts: { id: string; label: string; repo: string; workflow: string }): Tile {
  const attempts = new CompletedAttempts(opts.repo);
  return {
    id: opts.id,
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
        label: opts.label,
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

export const labsCiTrust = makeCiTrust({ id: "ci-trust", label: "labs ci trust", repo: REPO, workflow: CI_WORKFLOW });
export const loomCiTrust = makeCiTrust({ id: "loom-ci-trust", label: "loom ci trust", repo: LOOM_REPO, workflow: LOOM_CI_WORKFLOW });
