/**
 * Where a manifest's coverage baselines come from.
 *
 * A baseline is what one measured set counted at one `main` commit. The
 * full run on `main` writes those counts into the record store as
 * measurements, beside the repository-wide figure the dashboard reads, and
 * the publisher collects them from the objects it folds. The coverage gate
 * then compares against data the newest manifest already holds, rather than
 * reading a run's output at the barrier.
 *
 * Nothing here fails a publish. An object with no coverage figure contributes
 * none; a set with no baseline is reported by the gate rather than failed,
 * so the worst an empty list costs is a pull request that is told there is
 * nothing to compare it against.
 */

import {
  type CoverageBaseline,
  coverageFiguresOf,
  isMainPush,
  type StoredReportGroup,
} from "@commonfabric/test-support/records";
import { LOCAL_COVERAGE_BASELINE_DAYS } from "./policy.ts";

/**
 * The measured set one name denotes, split into its suite and its member.
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
 * The baselines one stored report holds: each measured set its records
 * count, against the commit the report ran at.
 *
 * Only a push to `main` holds any, by the rule the fold places a run on the
 * default branch by. Any other run measured code the default branch does
 * not carry, so it is not something a later change should be held to.
 */
export function baselinesOf(report: StoredReportGroup): CoverageBaseline[] {
  const context = report.context;
  if (context === undefined || !isMainPush(context)) return [];
  return [...coverageFiguresOf(report.records).sets].flatMap(
    ([name, uncoveredLines]) => {
      const set = splitMeasuredSet(name);
      return set === undefined ? [] : [{
        ...set,
        commit: context.commit,
        createdAt: context.startedAt,
        uncoveredLines,
      }];
    },
  );
}

/**
 * The baselines a manifest should carry: the ones the previous manifest
 * carried and the ones found since, in the order they were found, less any
 * older than `LOCAL_COVERAGE_BASELINE_DAYS`.
 *
 * A set holds one baseline at a commit, so that the gate never has two to
 * choose between. Where two runs measured it there, the one that started
 * later is kept, and where both are stamped with one start the one later in
 * `found` is. Two attempts of a run re-run across a UTC midnight are
 * stamped alike: the relay stamps each attempt's object with the start of
 * the attempt that shipped it, so the earlier attempt's copy under the
 * later day carries the later attempt's start. A caller orders `found` by
 * attempt for that reason.
 *
 * The window is what the gate can use: it takes the newest baseline the
 * branch contains, so a branch based further back than the window finds
 * none and is reported rather than failed.
 */
export function mergeBaselines(
  known: readonly CoverageBaseline[],
  found: readonly CoverageBaseline[],
  now: Date,
): CoverageBaseline[] {
  const oldest = now.getTime() - LOCAL_COVERAGE_BASELINE_DAYS * 86_400_000;
  const kept = new Map<string, CoverageBaseline>();
  for (const base of [...known, ...found]) {
    const at = Date.parse(base.createdAt);
    if (Number.isNaN(at) || at < oldest) continue;
    const key = JSON.stringify([base.suite, base.member, base.commit]);
    const held = kept.get(key);
    if (held === undefined || Date.parse(held.createdAt) <= at) {
      kept.set(key, base);
    }
  }
  return [...kept.values()].sort((a, b) =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
    a.suite.localeCompare(b.suite) || a.member.localeCompare(b.member) ||
    a.commit.localeCompare(b.commit)
  );
}
