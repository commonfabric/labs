/**
 * Builds the shared collection context handed to every tile. Its data sources
 * are memoized, so several tiles reading the same source — one repository's CI
 * runs, say — trigger only one fetch between them.
 */

import { github, memo } from "./lib.ts";
import {
  CI_RUNS_MAX,
  CI_RUNS_MAX_AGE_DAYS,
  CI_WORKFLOW,
  REPO,
} from "./config.ts";
import {
  type Ctx,
  type Run,
  runSource,
  type RunSource,
  runSourceKey,
} from "./types.ts";

// Up to CI_RUNS_MAX runs of one source, stopping early once runs
// pass the age cutoff — i.e. min(CI_RUNS_MAX, ~2 months). Each run is tagged with
// the repo it came from so a combined stream (recent-runs) can link each row to
// the right repo. Each tile slices this base to its own window.
// GitHub sends around 18 KB for each run: the repository, the head repository,
// the whole head commit, and both actors ride along with every entry. The
// fields below are around 350 bytes of it, and the snapshot is held between
// collections, so each run is narrowed to them as it arrives.
function tileRun(run: Run, repo: string): Run {
  return {
    repo,
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    run_attempt: run.run_attempt,
    event: run.event,
    head_sha: run.head_sha,
    display_title: run.display_title,
    created_at: run.created_at,
    run_started_at: run.run_started_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
    head_commit: run.head_commit && { message: run.head_commit.message },
  };
}

async function fetchRuns(
  { repo, workflow, scope }: RunSource,
): Promise<Run[]> {
  const filter = scope === "main" ? "branch=main" : "event=pull_request";
  const cutoff = Date.now() - CI_RUNS_MAX_AGE_DAYS * 86_400_000;
  const collected = new Map<number, Run>();
  const pages = Math.ceil(CI_RUNS_MAX / 100);
  let anchor: Run | undefined;
  walk:
  for (let page = 1; page <= pages; page++) {
    // A page after the first asks for the runs created at or before the one the
    // page before it ended on, rather than for an offset into a list that shifts
    // as runs land and that each request can be answered from a different moment
    // of. The anchor is a run the window already holds, so the page has to carry
    // it: a page that does not was cut from a moment that never held that run,
    // and joining the two would leave a hole in the window. Anchoring costs the
    // one run each page repeats, which is why the window is up to CI_RUNS_MAX.
    const anchored = anchor
      ? `&created=${encodeURIComponent(`<=${anchor.created_at}`)}`
      : "";
    const r = await github<{ workflow_runs: Run[] }>(
      `repos/${repo}/actions/workflows/${workflow}/runs?${filter}&per_page=100${anchored}`,
    );
    const batch = r.workflow_runs ?? [];
    if (!batch.length) break;
    if (anchor && !batch.some((run) => run.id === anchor!.id)) {
      throw new Error(
        `GitHub ${repo} ${workflow} runs at or before ${anchor.created_at} came ` +
          `back without run ${anchor.id}, opening on ${batch[0].id} of ` +
          `${batch[0].created_at}`,
      );
    }
    anchor = batch[batch.length - 1];
    for (const run of batch) {
      const t = Date.parse(run.run_started_at);
      if (Number.isFinite(t) && t < cutoff) break walk; // newest-first, so the rest are older too
      collected.set(run.id, tileRun(run, repo));
      if (collected.size >= CI_RUNS_MAX) break walk;
    }
  }
  // The walk decides which runs are in the window; the sort decides their order,
  // so a page served out of turn cannot leave an old run at the head.
  return [...collected.values()].sort((a, b) =>
    Date.parse(b.created_at) - Date.parse(a.created_at)
  );
}

export function makeCtx(): Ctx {
  // One memoized fetcher per source, created on first use and shared for ~20s
  // across every tile that reads it.
  const fetchers = new Map<string, () => Promise<Run[]>>();
  const runsFor = (source: RunSource): Promise<Run[]> => {
    const key = runSourceKey(source);
    let f = fetchers.get(key);
    if (!f) {
      f = memo(20_000, () => fetchRuns(source));
      fetchers.set(key, f);
    }
    return f();
  };
  return {
    runs: () => runsFor(runSource(REPO, CI_WORKFLOW, "main")),
    runsFor,
    env: (k) => Deno.env.get(k),
  };
}
