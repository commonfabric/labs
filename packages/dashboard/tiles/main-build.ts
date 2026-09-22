/**
 * Reports whether main builds. The last completed attempt on main drives the
 * status, good or bad, passing over any attempt cancelled before it started a
 * job, and the tile is unknown until a first attempt it does not pass over is
 * known. A cancelled attempt that ran jobs drives the status like any other,
 * as a failure. A newer in-flight run is a minor secondary facet. The tile
 * drills through to the commit history of main. One factory builds both the
 * labs and loom instances against their own repository and workflow.
 */

import {
  runSource,
  type Run,
  type Status,
  type Tile,
  type TileView,
} from "../types.ts";
import { CompletedAttempts } from "../completed-attempts.ts";
import { escapeHtml, humanDur } from "../lib.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "../config.ts";

function makeBuildTile(opts: { label: string; repo: string; workflow: string }): Tile {
  const commitsUrl = `https://github.com/${opts.repo}/commits/main`;
  const attempts = new CompletedAttempts(opts.repo);

  async function completedHistory(runs: Run[]): Promise<Run[]> {
    attempts.observe(runs);
    const completed: Run[] = [];
    let headConclusion: string | undefined;
    history:
    for (const run of runs) {
      let attempt = run.status === "completed" && run.conclusion
        ? run.run_attempt
        : run.run_attempt - 1;
      while (attempt >= 1) {
        let prior: Run;
        let neverStarted: boolean;
        try {
          prior = await attempts.get(run, attempt);
          neverStarted = await attempts.cancelledBeforeAnyJob(prior);
        } catch (error) {
          if (completed.length === 0) throw error;
          break history;
        }
        attempt--;
        // An attempt cancelled before it started a job, as a queued run is when
        // a newer push replaces it, passed no judgment on its commit, so it
        // neither sets the verdict nor ends a streak. A cancelled attempt that
        // ran jobs timed out or was stopped, and counts like any other failure.
        if (neverStarted) continue;
        completed.push(prior);
        if (headConclusion === undefined) {
          headConclusion = prior.conclusion!;
        } else if (prior.conclusion !== headConclusion) {
          break history;
        }
      }
    }
    return completed;
  }

  return {
    label: opts.label,
    intervalMs: 30_000,
    runSources: [runSource(opts.repo, opts.workflow)],
    async collect(ctx): Promise<TileView> {
      const runs = await ctx.runsFor(opts.repo, opts.workflow);
      const latest = runs[0];
      const completed = await completedHistory(runs);
      const lastDone = completed[0];
      const conclusion = lastDone?.conclusion ?? "";
      const s: Status = conclusion === "" ? "unknown" : conclusion === "success" ? "good" : "bad";

      let streak = "";
      if (lastDone) {
        const head = lastDone.conclusion;
        let flipAt = lastDone.run_started_at;
        for (const r of completed) {
          if (r.conclusion !== head) break;
          flipAt = r.run_started_at;
        }
        streak = `${head === "success" ? "green" : head} for ${humanDur(Date.now() - Date.parse(flipAt))}`;
      }

      const runningLabel = latest?.run_attempt > 1
        ? "build rerunning"
        : "next build running";
      const running = latest && latest.status !== "completed"
        ? `<span class="running" title="${escapeHtml((latest.display_title ?? "").slice(0, 90))}"><span class="rdot"></span>${runningLabel}</span>`
        : "";

      const value = s === "unknown"
        ? "—"
        : s === "good"
        ? "passing"
        : escapeHtml(conclusion);
      return {
        status: s,
        value,
        valueLabel: value,
        sub: streak || "no completed runs in window",
        href: commitsUrl,
        hint: "commits ↗",
        extra: running, // a build in flight — shown at the bottom, where there's room
      };
    },
  };
}

export const labsCi = makeBuildTile({ label: "labs ci", repo: REPO, workflow: CI_WORKFLOW });
export const loomCi = makeBuildTile({ label: "loom ci", repo: LOOM_REPO, workflow: LOOM_CI_WORKFLOW });
