/**
 * Gathers the dashboard's configuration in one place: the environment
 * variables it reads at startup, the repositories and workflows its CI tiles
 * follow, and the thresholds that decide when a tile turns orange or red. A
 * threshold is tuned here rather than in the tile that applies it.
 */

export { TRUST_RUNS_MAX } from "./ci-trust-layout.ts";

export const PORT = Number(Deno.env.get("DASHBOARD_PORT") ?? "8731");
export const REPO = Deno.env.get("DASHBOARD_REPO") ?? "commonfabric/labs";
export const CI_WORKFLOW = "deno.yml";
export const TEST_SELECTION_WORKFLOW = "test-selection.yml";

// The service.name production reports under in SigNoz. The tiles that read traces
// scope to it by name: the same SigNoz also holds staging and one-off perf runs,
// whose spans are not production's and whose error rates are nothing like it.
// Override with PROD_SERVICE.
export const PROD_SERVICE = "toolshed-production";

// The loom repo and its main CI workflow ("Tests (fast)"), for the loom-repo CI
// tiles and the combined recent-runs stream.
export const LOOM_REPO = Deno.env.get("DASHBOARD_LOOM_REPO") ?? "commonfabric/loom";
export const LOOM_CI_WORKFLOW = "test-fast.yml";

// Shared fetch window: the fetch stops at whichever of these two yields fewer
// workflow runs. Every CI tile slices from it.
export const CI_RUNS_MAX = 200; // workflow runs
export const CI_RUNS_MAX_AGE_DAYS = 60; // ~2 months

// How long a job's failure stays red on the ci tile. A job that has been
// failing for longer than this is still failing, and still listed, but it is
// no longer the thing that just broke, so it goes orange and leaves the red
// for a failure somebody can still act on.
export const CI_FAILURE_FRESH_HOURS = 48;

// Tile display windows and status thresholds (tune here).
export const TRUST_GOOD = 90, TRUST_WARN = 75; // first-try-green %
export const DUR_GOOD = 12, DUR_WARN = 20; // median CI minutes
// ci-duration median window — the larger of these two (more runs wins).
export const DUR_MIN_RUNS = 20;
export const DUR_MAX_AGE_HOURS = 6;
// benchmark trend window — the same "larger of the two" idea, but in days: the
// benchmarks.yml job runs about four-hourly, and the daily-median trend fit needs
// several distinct days, so the recent slice is measured in days, not hours.
export const BENCH_TREND_MIN_RUNS = 20;
export const BENCH_TREND_MAX_AGE_DAYS = 14;
// A processor contributes to the benchmark headline only while the collection
// has measured it recently. This keeps an old processor-specific regression
// from setting the tile after the runner group has moved to other processors.
export const BENCH_HEADLINE_MAX_AGE_HOURS = 12;
// The trend reads one run per bucket of this length, matching the
// benchmarks.yml cron. The collection keeps every run, for the drill-down's
// shortest view; the trend does not want that resolution, because runs closer
// together than the cadence are one moment in wall clock, and counting them
// separately lets one moment supply a whole level of the fit.
export const BENCH_TREND_BUCKET_MS = 4 * 60 * 60_000;
export const RECENT_WINDOW = 10; // recent completed runs scanned for the recent-runs status
export const RECENT_DISPLAY = 50; // rows the recent-runs tile shows
