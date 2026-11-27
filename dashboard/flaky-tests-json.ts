/**
 * The tests held back as flaky, as JSON, for an agent or a script setting
 * out to fix one. It reports what the test selection page's flaky table
 * shows, and the runs each test disagreed across, from the newest manifest
 * the tiles are already reading, so a request costs no GitHub requests.
 *
 * Following the dashboard's values (README.md): it names tests and runs,
 * never people. A run made on a workstation is reported by where it was
 * made alone.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type {
  CiJob,
  Manifest,
  SeenRun,
} from "@commonfabric/test-support/records";
import { REPO } from "./config.ts";
import { collectionSub } from "./test-selection-history.ts";
import {
  FLAKE_EXCLUSION_FALLBACK,
  FLAKE_WINDOW_FALLBACK_DAYS,
  flakyTests,
  type ManifestReader,
  numberDial,
} from "./test-selection-manifest.ts";

/** Where the flaky tests are served. */
export const FLAKY_TESTS_JSON_PATH = "/test-selection/flaky.json";

/** Where a job's run attempt is opened on GitHub. */
export function runUrl(ci: CiJob, repo = REPO): string {
  return `https://github.com/${repo}/actions/runs/${
    encodeURIComponent(ci.runId)
  }/attempts/${ci.runAttempt}`;
}

/** One run, with where to open it on GitHub when it has a page there. */
function runJson(run: SeenRun, repo: string) {
  const ci = run.ci;
  return {
    place: run.place,
    runId: ci?.runId ?? null,
    runAttempt: ci?.runAttempt ?? null,
    job: ci?.job ?? null,
    url: ci === undefined ? null : runUrl(ci, repo),
  };
}

/** The body for one manifest, or for a store holding none. */
export function flakyTestsJson(
  manifest: Manifest | undefined,
  now: number,
  repo = REPO,
) {
  const generatedAt = new Date(now).toISOString();
  if (manifest === undefined) return { generatedAt, manifest: null, tests: [] };
  return {
    generatedAt,
    manifest: {
      commit: manifest.commit,
      generatedAt: manifest.generatedAt,
      windowDays: numberDial(
        manifest.dials,
        "FLAKE_WINDOW_DAYS",
        FLAKE_WINDOW_FALLBACK_DAYS,
      ),
      exclusionRate: numberDial(
        manifest.dials,
        "FLAKE_EXCLUSION_RATE",
        FLAKE_EXCLUSION_FALLBACK,
      ),
    },
    tests: flakyTests(manifest).map(({ withheld, entry }) => ({
      kind: withheld.test.k,
      member: withheld.test.s,
      name: withheld.test.n,
      variant: withheld.test.v ?? null,
      suite: withheld.suite,
      unit: entry?.unit ?? null,
      flakeShare: entry?.flakeRate ?? null,
      flakes: entry?.flakeEvidence?.flakes ?? null,
      runs: entry?.flakeEvidence?.runs ?? null,
      lastFailure: entry?.lastFailure ?? null,
      lastRun: entry?.lastRun ?? null,
      // Newest first, which is the order someone fixing the test opens
      // them in.
      disagreements: (entry?.disagreements ?? []).toReversed().map((
        held,
      ) => ({
        day: held.day,
        commit: held.commit,
        seed: held.seed ?? null,
        failed: runJson(held.failed, repo),
        passed: held.passed === undefined
          ? null
          : runJson(held.passed, repo),
      })),
    })),
  };
}

/** Serves the body against the manifest the tiles are already reading. */
export async function flakyTestsResponse(
  read: ManifestReader,
  clock: () => number,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  try {
    return Response.json(flakyTestsJson(await read(), clock()), { headers });
  } catch (error) {
    console.error("flaky tests json:", describeFailure(error));
    return Response.json({
      generatedAt: new Date(clock()).toISOString(),
      error: collectionSub(error),
    }, { status: 503, headers });
  }
}
