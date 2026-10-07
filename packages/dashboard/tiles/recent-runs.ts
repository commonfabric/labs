/**
 * Lists every run on main in the window, newest first and including the ones
 * still in progress, with the labs and loom repositories interleaved
 * chronologically. Each row is tagged with its repository. Its text links to
 * its run, except that a pull request number in it links to that pull
 * request. Its arrow links to the pull request that landed the commit, or to
 * the commit when its title names none. A row whose commit the repository's
 * green branch is or was at opens with a star saying so. The tile is
 * full-width. Its aggregate status is bad when the latest completed run
 * failed, a warning when a failure sits within the recent window but the tip
 * has recovered, and good otherwise.
 */

import {
  runSource,
  type Run,
  type Status,
  type Tile,
  type TileView,
} from "../types.ts";
import {
  concDot,
  escapeHtml,
  humanDuration,
  landingHref,
  pullRequestLinks,
  runDurationMs,
} from "../lib.ts";
import {
  CI_WORKFLOW,
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  RECENT_DISPLAY,
  RECENT_WINDOW,
  REPO,
} from "../config.ts";
import { GANTT_MAX_RUNS } from "../ci-job-history.ts";
import { greenStar } from "../green-star.ts";

const utcFallback = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isFinite(at)
    ? `${new Date(at).toISOString().slice(11, 16)} UTC`
    : iso;
};

const repoOf = (run: Run): string => run.repo ?? REPO;

/**
 * The dot a run is marked with and the words its result is given: running
 * until it completes, green when it passed, saying which attempt passed when
 * it took more than one, and otherwise its conclusion.
 */
export function runOutcome(run: Run): { dot: string; text: string } {
  if (run.status !== "completed") {
    return {
      dot: "run",
      text: `running${run.run_attempt > 1 ? ` · attempt ${run.run_attempt}` : ""}`,
    };
  }
  return {
    dot: concDot(run.conclusion, run.run_attempt),
    text: run.conclusion === "success"
      ? (run.run_attempt > 1 ? `green on retry #${run.run_attempt}` : "green")
      : (run.conclusion ?? "done"),
  };
}

function runDuration(run: Run): string | null {
  const ran = runDurationMs(run);
  return ran === undefined ? null : humanDuration(ran);
}

export function commitGanttHref(
  run: Run,
  candidates: readonly Run[],
): string | null {
  if (
    !run.head_sha || run.status !== "completed" ||
    run.conclusion !== "success" || run.event !== "push"
  ) return null;
  const selected = new Map<number, Run>();
  for (const candidate of candidates) {
    if (
      repoOf(candidate) !== repoOf(run) ||
      candidate.head_sha !== run.head_sha ||
      candidate.status !== "completed" ||
      candidate.conclusion !== "success" || candidate.event !== "push"
    ) continue;
    const current = selected.get(candidate.id);
    if (!current || current.run_attempt < candidate.run_attempt) {
      selected.set(candidate.id, candidate);
    }
  }
  if (!selected.size || selected.size > GANTT_MAX_RUNS) return null;
  const parameters = new URLSearchParams({
    repo: repoOf(run) === LOOM_REPO ? "loom" : "labs",
    sha: run.head_sha,
    limit: String(selected.size),
    mainOnly: "1",
  });
  for (const selectedRun of selected.values()) {
    parameters.append(
      "run",
      `${selectedRun.id}:${selectedRun.run_attempt}`,
    );
  }
  return `/ci-gantt?${parameters}`;
}

const sources = [
  runSource(REPO, CI_WORKFLOW, "main"),
  runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "main"),
];

export const recentRuns: Tile = {
  label: "recent main runs",
  intervalMs: 30_000,
  wide: true,
  runSources: sources,
  async collect(ctx): Promise<TileView> {
    // Two shared bases (labs + loom), merged newest-first and cut to the most
    // recent RECENT_DISPLAY across both.
    const snapshots = await Promise.all(
      sources.map((source) => ctx.runsFor(source)),
    );
    const allRuns = snapshots.flat().sort((a, b) =>
      Date.parse(b.run_started_at) - Date.parse(a.run_started_at)
    );
    const runs = allRuns.slice(0, RECENT_DISPLAY);

    const completedOutcomes = [...runs].filter((r) =>
      r.status === "completed" && r.conclusion
    ).reverse()
      .map((r) => concDot(r.conclusion, r.run_attempt));
    const status: Status = completedOutcomes.length === 0
      ? "unknown"
      : completedOutcomes[completedOutcomes.length - 1] === "red"
      ? "bad"
      : completedOutcomes.slice(-RECENT_WINDOW).includes("red")
      ? "warn"
      : "good";

    const shortRepo = (r: Run) => repoOf(r).split("/")[1] ?? repoOf(r);
    const rows = runs.map((r) => {
      const running = r.status !== "completed";
      const { dot, text: label } = runOutcome(r);
      const title =
        (r.head_commit?.message ?? r.display_title).split("\n", 1)[0];
      const href = landingHref(title, r.head_sha, repoOf(r));
      const ganttHref = commitGanttHref(r, allRuns);
      const duration = runDuration(r);
      const startedAt = escapeHtml(r.run_started_at);
      const fallback = escapeHtml(utcFallback(r.run_started_at));
      const durationHtml = ganttHref && duration
        ? `<a class="evdur" data-focus-key="gantt-${r.id}" href="${
          escapeHtml(ganttHref)
        }" title="View CI Gantt for ${escapeHtml(r.head_sha.slice(0, 7))}">${
          escapeHtml(duration)
        }</a>`
        : `<span class="evdur">${
          escapeHtml(duration ?? (running ? "running" : "—"))
        }</span>`;
      return `<div class="ev"><time class="t" datetime="${startedAt}" data-viewer-time>${fallback}</time><span class="dot ${dot}"></span><span class="evtxt">${
        greenStar(r.green)
      }${
        pullRequestLinks(
          `${shortRepo(r)} · ${label} · ${title}`,
          repoOf(r),
          r.html_url,
          `title-${r.id}`,
        )
      }</span>${durationHtml}<a class="evarrow" data-focus-key="pr-arrow-${r.id}" href="${
        escapeHtml(href)
      }" target="_blank" rel="noopener" aria-label="Open landed change on GitHub">↗</a></div>`;
    }).join("") ||
      `<div class="ev"><span class="dot gray"></span><span>waiting for first poll…</span></div>`;

    const count = `${runs.length} in window`;
    return {
      status,
      aside: `<span class="hfacet" title="${count}">${count}</span>`,
      extra: `<div class="evscroll" data-focus-key="runs">${rows}</div>`,
    };
  },
};
