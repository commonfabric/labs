/**
 * Builds the shared collection context handed to every tile. Its data sources
 * are memoized, so several tiles reading the same source — one repository's CI
 * runs, say — trigger only one fetch between them.
 */

import { github, memo, STALE_RUNS_ERROR } from "./lib.ts";
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
  type RunScope,
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

/** A run as GitHub lists it, which also names the branch it ran for. */
type ListedRun = Run & { head_branch: string | null };

// Whether `run` belongs to `scope`, by the test GitHub applies for the
// listing's `branch=main` or `event=pull_request` parameter.
function inScope(run: ListedRun, scope: RunScope): boolean {
  return scope === "main"
    ? run.head_branch === "main"
    : run.event === "pull_request";
}

// Whether `run` started before `cutoff`. A run with an unreadable start time is
// kept rather than read as ancient.
function startedBefore(run: Run, cutoff: number): boolean {
  const t = Date.parse(run.run_started_at);
  return Number.isFinite(t) && t < cutoff;
}

// The newest page of one workflow's runs, whatever they ran for. GitHub serves
// this listing current. A listing narrowed by branch or event is served from an
// index that can be days behind it.
async function fetchHead(repo: string, workflow: string): Promise<ListedRun[]> {
  const r = await github<{ workflow_runs?: ListedRun[] }>(
    `repos/${repo}/actions/workflows/${workflow}/runs?per_page=100`,
  );
  return r.workflow_runs ?? [];
}

async function fetchListed(
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
    const r = await github<{ workflow_runs?: Run[] }>(
      `repos/${repo}/actions/workflows/${workflow}/runs?${filter}&per_page=100${anchored}`,
    );
    const batch = r.workflow_runs ?? [];
    if (!batch.length) break;
    const joint = anchor;
    if (joint && !batch.some((run) => run.id === joint.id)) {
      throw new Error(
        `GitHub ${repo} ${workflow} runs at or before ${joint.created_at} came ` +
          `back without run ${joint.id}, opening on ${batch[0].id} of ` +
          `${batch[0].created_at}`,
      );
    }
    anchor = batch[batch.length - 1];
    for (const run of batch) {
      if (startedBefore(run, cutoff)) break walk; // newest-first, so the rest are older too
      collected.set(run.id, tileRun(run, repo));
      if (collected.size >= CI_RUNS_MAX) break walk;
    }
  }
  return [...collected.values()];
}

// Up to CI_RUNS_MAX runs of one source, stopping at the age cutoff, newest
// first, joined from three reads: the source's runs on the workflow's newest
// page from `head`, the filtered listing, and `held`, the window this source
// returned last. The newest page is current. When the source has runs on it,
// either the listing or `held` has to reach the oldest of them, so that nothing
// falls between them; a read that does not was cut from a moment before that
// run. Each run is taken from whichever read last saw it updated, so a run a
// lagging read missed joins the window once a current listing carries it.
async function fetchRuns(
  source: RunSource,
  head: Promise<ListedRun[]>,
  held: readonly Run[] | undefined,
): Promise<Run[]> {
  const key = runSourceKey(source);
  let failure: unknown;
  const [page, listed] = await Promise.all([
    head,
    fetchListed(source).catch((e: unknown) => {
      failure = e;
      return undefined;
    }),
  ]);
  const cutoff = Date.now() - CI_RUNS_MAX_AGE_DAYS * 86_400_000;
  const recent = page.filter((run) =>
    inScope(run, source.scope) && !startedBefore(run, cutoff)
  ).map((run) => tileRun(run, source.repo));
  const joint = recent.at(-1);
  const reaches = (runs: readonly Run[] | undefined) =>
    runs !== undefined && (!joint || runs.some((run) => run.id === joint.id));
  if (!reaches(listed) && !reaches(held)) {
    if (listed && joint) {
      console.error(
        `run source ${key} listing does not reach run ${joint.id} of ` +
          `${joint.created_at}; its newest run is ` +
          `${listed[0] ? `${listed[0].id} of ${listed[0].created_at}` : "none"}.`,
      );
    }
    throw failure ?? new Error(STALE_RUNS_ERROR);
  }
  if (failure !== undefined) {
    console.error(`run source ${key} listing failed:`, String(failure));
  }
  const runs = new Map<number, Run>();
  for (const run of [...held ?? [], ...listed ?? [], ...recent]) {
    const kept = runs.get(run.id);
    if (!kept || Date.parse(run.updated_at) >= Date.parse(kept.updated_at)) {
      runs.set(run.id, run);
    }
  }
  return [...runs.values()]
    .filter((run) => !startedBefore(run, cutoff))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, CI_RUNS_MAX);
}

export function makeCtx(): Ctx {
  // One memoized fetcher per source and one per workflow's newest page, each
  // created on first use and shared for ~20s across every tile that reads it.
  const fetchers = new Map<string, () => Promise<Run[]>>();
  const heads = new Map<string, () => Promise<ListedRun[]>>();
  const held = new Map<string, Run[]>();
  const runsFor = (source: RunSource): Promise<Run[]> => {
    const key = runSourceKey(source);
    const head = shared(
      heads,
      `${source.repo} ${source.workflow}`,
      () => fetchHead(source.repo, source.workflow),
    );
    return shared(fetchers, key, async () => {
      const runs = await fetchRuns(source, head(), held.get(key));
      held.set(key, runs);
      return runs;
    })();
  };
  return {
    runs: () => runsFor(runSource(REPO, CI_WORKFLOW, "main")),
    runsFor,
    env: (k) => Deno.env.get(k),
  };
}

// The memoized fetcher stored under `key`, created from `fetch` on first use.
function shared<T>(
  fetchers: Map<string, () => Promise<T>>,
  key: string,
  fetch: () => Promise<T>,
): () => Promise<T> {
  let f = fetchers.get(key);
  if (!f) {
    f = memo(20_000, fetch);
    fetchers.set(key, f);
  }
  return f;
}
