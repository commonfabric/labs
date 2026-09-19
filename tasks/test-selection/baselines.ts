/**
 * Where a manifest's coverage baselines come from.
 *
 * A baseline is what one measured set counted at one `main` commit. The
 * full run on `main` publishes those counts in its `perf-metrics`
 * artifact, beside the repository-wide figure the dashboard reads, and
 * this gathers the recent ones so a manifest carries them. The coverage
 * gate then compares against data the newest manifest already holds,
 * rather than downloading a run's artifacts at the barrier.
 *
 * Nothing here fails a publish. A run with no measured-set metrics
 * contributes none, and a store that cannot be reached contributes none;
 * a set with no baseline is reported by the gate rather than failed, so
 * the worst an empty list costs is a pull request that is told there is
 * nothing to compare it against.
 */

import {
  type Artifact,
  coverageMetricMeasuredSet,
  downloadAndParseCoverageBaseline,
  fetchArtifactsForRun,
  githubGet,
  isBaselineCandidateRun,
  newestArtifactsByName,
  PERF_METRICS_ARTIFACT_NAME,
  TOKEN,
  WORKFLOW_RUNS_PAGE_SIZE,
  type WorkflowRun,
  workflowRunsPagePath,
} from "../ci-check-lib.ts";
import type { CoverageBaseline } from "./manifest.ts";
import { LOCAL_COVERAGE_BASELINE_DAYS } from "./policy.ts";

/** One `main` run a baseline could come from. */
export interface BaselineRun {
  id: number;
  commit: string;

  /** When the run was created, ISO 8601. */
  createdAt: string;
}

/** Where the runs and their published metrics come from. */
export interface BaselineSource {
  /** Successful pushes to the default branch, newest first. */
  runs(): Promise<readonly BaselineRun[]>;

  /** What one run published, by metric name, or nothing where it published none. */
  metrics(runId: number): Promise<ReadonlyMap<string, number> | undefined>;
}

/**
 * The measured set one metric names, split into its suite and its member.
 *
 * The name is the suite and the member joined by a slash, and a suite
 * identifier holds no slash, so the first one separates them however deep
 * the member sits.
 */
export function splitMeasuredSet(
  name: string,
): { suite: string; member: string } | undefined {
  const at = name.indexOf("/");
  if (at <= 0 || at === name.length - 1) return undefined;
  return { suite: name.slice(0, at), member: name.slice(at + 1) };
}

/**
 * The baselines a manifest should carry: the ones the previous manifest
 * carried that are still inside `LOCAL_COVERAGE_BASELINE_DAYS`, plus the
 * ones the runs since then published.
 *
 * Carried forward rather than read again, because reading one run's
 * figures costs an artifact listing and a download, and a window of days
 * holds more runs than a publisher should ask about every few hours. What
 * is read is the runs whose commit no baseline names yet, which after the
 * first publish is the handful since the last one.
 *
 * The window is what the gate can use: it takes the newest baseline the
 * branch contains, so a branch based further back than the window finds
 * none and is reported rather than failed.
 */
export async function collectCoverageBaselines(
  source: BaselineSource,
  now: Date,
  known: readonly CoverageBaseline[] = [],
): Promise<CoverageBaseline[]> {
  const oldest = new Date(
    now.getTime() - LOCAL_COVERAGE_BASELINE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const baselines = known.filter((base) => base.createdAt >= oldest);
  const carried = new Set(baselines.map((base) => base.commit));
  for (const run of await source.runs()) {
    const createdAt = new Date(run.createdAt);
    if (Number.isNaN(createdAt.getTime())) continue;
    // The listing is newest first, so the first run past the window is
    // where the window ends.
    if (createdAt.toISOString() < oldest) break;
    if (carried.has(run.commit)) continue;
    const metrics = await source.metrics(run.id);
    if (metrics === undefined) continue;
    const sets = measuredSetFigures(metrics);
    // A run that published a report and named no measured set in it ran
    // a tree where nothing measures one. Every older run is such a tree
    // too, so there is nothing further back to read.
    if (sets.length === 0) break;
    // A commit can carry more than one successful run. Its figures are
    // taken from the newest of them and the rest are passed over, so a
    // set never holds two baselines at one commit for a comparison to
    // choose between.
    carried.add(run.commit);
    for (const [set, uncoveredLines] of sets) {
      baselines.push({
        suite: set.suite,
        member: set.member,
        commit: run.commit,
        createdAt: createdAt.toISOString(),
        uncoveredLines,
      });
    }
  }
  return baselines.sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) ||
    a.suite.localeCompare(b.suite) || a.member.localeCompare(b.member)
  );
}

/** The measured sets one run's metrics name, and what each counted. */
function measuredSetFigures(
  metrics: ReadonlyMap<string, number>,
): [{ suite: string; member: string }, number][] {
  const figures: [{ suite: string; member: string }, number][] = [];
  for (const [name, uncoveredLines] of metrics) {
    const set = coverageMetricMeasuredSet(name);
    if (set === null) continue;
    const split = splitMeasuredSet(set);
    if (split === undefined) continue;
    figures.push([split, uncoveredLines]);
  }
  return figures;
}

/**
 * How many of the newest `main` runs one reading gathers.
 *
 * It bounds how far one publish can catch up rather than how much
 * history a manifest holds: what the window holds is built up by each
 * publish carrying the previous manifest's baselines forward and adding
 * the runs since. A busy day lands more runs than this, so a publisher
 * that has been down for a day reaches back less far than the window
 * until it has run a few times.
 */
const BASELINE_RUNS = 100;

/**
 * The most pages one reading asks for.
 *
 * The listing holds every run of the workflow, of which the pushes to
 * `main` that succeeded are a fraction, so gathering {@link BASELINE_RUNS}
 * of them takes several pages. This bounds what a stretch holding few of
 * them costs: the reading stops early, and the publish after it carries
 * what this one published forward and adds the runs since.
 */
const BASELINE_LISTING_MAX_PAGES = 15;

/** What the live source reaches for, so a test can hand it something. */
export interface BaselineReads {
  /** The runs a listing path names. */
  list?: (path: string) => Promise<{ workflow_runs: WorkflowRun[] }>;

  /** The artifacts one run left behind. */
  artifacts?: (runId: number) => Promise<Artifact[]>;

  /** What one artifact holds, or nothing where it cannot be read. */
  baseline?: (
    artifactId: number,
  ) => Promise<{ metrics: Map<string, { uncoveredLines: number }> } | null>;
}

/**
 * The runs and artifacts of the repository this is running in.
 *
 * The runs are gathered from the listing that carries no filter, and which
 * of them could serve as a baseline is decided here. Asking GitHub to make
 * that selection is served from a search index that can answer with a window
 * of runs weeks old, with a success status and nothing to mark it; such a
 * window puts every run it names outside the publisher's own window, so the
 * gathering would stop at the first of them and the manifest would carry
 * forward without the runs since.
 */
export function liveBaselineSource(reads: BaselineReads = {}): BaselineSource {
  const list = reads.list ??
    ((path: string) => githubGet<{ workflow_runs: WorkflowRun[] }>(path));
  const artifactsOf = reads.artifacts ?? fetchArtifactsForRun;
  const baselineOf = reads.baseline ?? downloadAndParseCoverageBaseline;
  return {
    async runs() {
      const found: BaselineRun[] = [];
      for (let page = 1; page <= BASELINE_LISTING_MAX_PAGES; page++) {
        const { workflow_runs: runs } = await list(workflowRunsPagePath(page));
        for (const run of runs) {
          if (!isBaselineCandidateRun(run)) continue;
          found.push({
            id: run.id,
            commit: run.head_sha,
            createdAt: run.created_at,
          });
          if (found.length === BASELINE_RUNS) return found;
        }
        // A short page is the last one the listing has.
        if (runs.length < WORKFLOW_RUNS_PAGE_SIZE) break;
      }
      return found;
    },
    async metrics(runId: number) {
      let artifacts: Artifact[];
      try {
        artifacts = await artifactsOf(runId);
      } catch {
        return undefined;
      }
      const artifact = newestArtifactsByName(
        artifacts.filter((one) =>
          one.name === PERF_METRICS_ARTIFACT_NAME && !one.expired
        ),
      )[0];
      if (artifact === undefined) return undefined;
      const parsed = await baselineOf(artifact.id);
      if (parsed === null) return undefined;
      return new Map(
        [...parsed.metrics].map(([name, sample]) => [
          name,
          sample.uncoveredLines,
        ]),
      );
    },
  };
}

/**
 * The baselines to publish, or the ones already published where the
 * credential to read any more is absent. Reading a run's artifacts needs
 * a token, and a publisher run without one still has a manifest worth
 * creating; carrying what the previous manifest held keeps the gate
 * working across such a run rather than switching it off for one.
 */
export async function publishableBaselines(
  now: Date,
  known: readonly CoverageBaseline[] = [],
  source: BaselineSource = liveBaselineSource(),
  token: string | undefined = TOKEN,
): Promise<CoverageBaseline[]> {
  if (token === undefined || token.length === 0) {
    console.warn(
      "test selection: no GitHub credential, so this manifest carries only " +
        "the coverage baselines the last one did.",
    );
    return [...known];
  }
  try {
    return await collectCoverageBaselines(source, now, known);
  } catch (error) {
    console.warn(`test selection: cannot read coverage baselines: ${error}`);
    return [...known];
  }
}
