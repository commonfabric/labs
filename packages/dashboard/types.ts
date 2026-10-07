/**
 * Declares the contract a tile and the dashboard core hold each other to: the
 * statuses a tile may report, the render-ready view its `collect()` returns,
 * the shared context it is handed to gather that view, and the drill-down
 * routes it may claim. A file under tiles/ becomes a tile by exporting a
 * `Tile`. Its optional `collectActivity()` is refreshed independently:
 * `true` shows workflow activity, `false` means idle, and `undefined` means
 * activity is unavailable.
 */

export type Status = "good" | "warn" | "bad" | "unknown";

// A render-ready snapshot produced by a tile's collect().
export interface TileView {
  status: Status; // good / warn / bad / unknown -> green / orange / red / gray
  value?: string; // big headline (TRUSTED html — escape in the tile if it holds data)
  valueLabel?: string; // plain-text headline shown when CSS truncates value
  sub?: string; // sub line (plain text; escaped by the renderer)
  extra?: string; // trusted inline html under sub (sparkline / strip / list)
  duration?: number; // a span in ms; rendered (humanSpan) in the chart's bottom-left corner
  alignChartBottom?: boolean; // keep the chart at the tile bottom when its grid row grows taller
  aside?: string; // trusted inline html minor header facet (e.g. an MTD or "running" badge)
  href?: string; // if set, the whole tile becomes a link (external opens a new tab)
  hint?: string; // drill arrow tooltip and accessible link description
}

export interface Route {
  path: string;
  handler(req: Request, url: URL): Response | Promise<Response>;
  // The page is rendered again on every serving tick while a browser shows
  // it, and sent to that browser when it changes (live-page.ts).
  live?: boolean;
}

// Which of a workflow's runs a source follows: those on the main branch, or
// those started for pull requests.
export type RunScope = "main" | "pull requests";

export function runSource(repo: string, workflow: string, scope: RunScope) {
  return { repo, workflow, scope } as const;
}

export type RunSource = ReturnType<typeof runSource>;

export const runSourceKey = (source: RunSource): string =>
  `${source.repo} ${source.workflow} ${source.scope}`;

export interface Tile {
  // The tile's header on every view (plain text; escaped by the renderer). It
  // is unique among registered tiles, and keys the tile's scheduling and
  // latest-view state on the server and its markup in the browser.
  label: string;

  // The repository the tile reports on, as "owner/name", when it reports on
  // one alone. That repository's page shows the tile's view among its
  // measures (repo-page.ts).
  repo?: string;

  intervalMs: number; // how often collect() runs, per source when runSources is set
  wide?: boolean; // render full-width below the grid, including before collection
  // Keep the last completed status and values while ignoring intermediate views.
  showOnlyCompletedViews?: boolean;
  // GitHub workflow snapshots that drive this tile. The scheduler refreshes
  // each source independently and publishes its due dependent tiles together.
  runSources?: readonly RunSource[];
  // The tile reports a problem with one of its sources itself, through
  // ctx.runSourceProblem, and the scheduler leaves its view as it is rather
  // than turning it gray.
  reportsSourceProblems?: boolean;
  // Optional workflow activity, refreshed independently on the tile's interval.
  // true lights the running badge; false or undefined clears it.
  collectActivity?(ctx: Ctx): Promise<boolean | undefined>;
  collect(ctx: Ctx, publish?: (view: TileView) => void): Promise<TileView>; // publish usable data before slower work completes
  routes?: Route[]; // optional drill-down routes this tile owns
}

// Shared, memoized data sources handed to every collect().
export interface Ctx {
  runs(): Promise<Run[]>; // labs deno.yml runs on main (shared across CI tiles, memoized)
  // The runs of any source, memoized per source so several tiles reading the
  // same one share one fetch (loom's CI tiles, and the combined recent-runs
  // stream).
  runsFor(source: RunSource): Promise<Run[]>;
  // For a tile collected from run-source snapshots: why the snapshot of that
  // source is missing or out of date, or undefined when it is current.
  runSourceProblem?(source: RunSource): string | undefined;
  // For a tile collected from run-source snapshots: asks for the tile to be
  // collected again from the snapshots it was last published from, for when
  // data of its own has arrived since its last collection. Each ask brings
  // one more collection, so a tile asks only when such data arrives.
  collectAgain?(): void;
  env(key: string): string | undefined;
}

/**
 * That a repository's green branch is at a run's commit, or was at it: the
 * branch CI moves to the newest commit of main whose tests passed.
 */
export interface GreenMark {
  /** The branch's name, such as `main-green`. */
  readonly branch: string;

  /** Whether the branch is at the commit now. */
  readonly current: boolean;
}

export interface Run {
  repo?: string; // the "owner/name" the run was fetched for (tagged by the fetcher)
  green?: GreenMark; // set by the fetcher when the repo's green branch is or was at the commit
  id: number;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  event: string;
  head_sha: string;
  display_title: string;
  created_at: string;
  run_started_at: string;
  updated_at: string;
  html_url: string;
  head_commit: { message: string } | null;
}
