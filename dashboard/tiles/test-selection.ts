/**
 * Reports what the newest selection manifest would have a pull request
 * run: what share of the corpus's tests, and of their test time, the lanes
 * of a change touching nothing would run, and how many tests that is
 * against the whole corpus. What such a change runs is bounded by its
 * discretionary target, which is a number of seconds, so the share of test
 * time falls as the corpus's test time grows, while the share of tests
 * depends on what each chosen test costs.
 *
 * It goes amber on either of two counts. The manifest has gone stale, and
 * selection quality decays with it. Or the corpus holds a test that costs
 * more on its own than a whole lane's budget, which no packing can place,
 * so a pull request runs it only where its own diff makes it mandatory.
 * It goes red when a lane's projected work is past the bound the whole
 * design rests on, or when the publisher found the cost model the lanes
 * are packed by broken: a model that has stopped describing what lanes
 * spend takes tests out of pull requests, or runs lanes long, without
 * anything else turning red.
 *
 * Three of those four want the sub line, and the red ones take it first.
 * Staleness wants the header facet instead, so it competes for none.
 *
 * The packing itself — every lane, what each holds, and what each is
 * projected to spend — is a page away, along with every test no lane can
 * hold and what each was measured at.
 *
 * Following the dashboard's values (README.md): it reports on the system.
 */

import type { Manifest } from "@commonfabric/test-support/records";

import { maxOf } from "@commonfabric/collections/math";
import { compactSpan, groupDigits } from "../lib.ts";
import {
  collectSelectionTile,
  sharedTestSelection,
  type TestSelectionSource,
} from "../test-selection-history.ts";
import {
  corpusSeconds,
  laneBudgetOf,
  MANIFEST_SHARE_MS,
  selectedCount,
  selectedSeconds,
  shareLabel,
} from "../test-selection-manifest.ts";
import {
  HEALTH_SECTION_ID,
  TEST_SELECTION_PATH,
  testSelectionResponse,
} from "../test-selection-page.ts";
import { REPO } from "../config.ts";
import { publisherRunning } from "../test-selection-activity.ts";
import type { Status, Tile, TileView } from "../types.ts";

/** Hours before a manifest is stale enough to say so. */
export const MANIFEST_STALE_HOURS = 8;

/** Builds the tile against a data source and a clock. */
export function makeTestSelection(
  options: { source?: TestSelectionSource; now?: () => number } = {},
): Tile {
  const source = options.source ?? sharedTestSelection;
  return {
    label: "test selection",
    repo: REPO,
    intervalMs: MANIFEST_SHARE_MS,
    routes: [{
      path: TEST_SELECTION_PATH,
      handler: () => testSelectionResponse(source.latest, options.now),
      live: true,
    }],
    collectActivity: publisherRunning,
    collect: (_ctx, publish) =>
      collectSelectionTile(
        source,
        "selected",
        (manifest) => selectionView(manifest, options.now),
        publish,
      ),
  };
}

function selectionView(
  manifest: Manifest | undefined,
  clock?: () => number,
): TileView {
  if (manifest === undefined || manifest.entries.length === 0) {
    return {
      status: "unknown",
      value: "—",
      sub: manifest === undefined
        ? "no selection manifest yet"
        : "selection manifest has no tests",
    };
  }
  const corpus = manifest.entries.length;
  const selected = selectedCount(manifest);
  const seconds = selectedSeconds(manifest);
  const corpusTime = corpusSeconds(manifest);
  const tests = shareLabel(selected, corpus);
  const time = shareLabel(seconds, corpusTime);
  const age = (clock?.() ?? Date.now()) - Date.parse(manifest.generatedAt);
  const ageHours = age / 3_600_000;
  const budget = laneBudgetOf(manifest.dials);
  const fullest = manifest.lanes.length === 0
    ? 0
    : maxOf(manifest.lanes.map((lane) => lane.projectedSeconds));
  const over = fullest > budget;
  const unplaceable = manifest.unschedulable.length;
  const broken = manifest.health?.alarms.length ?? 0;
  const stale = ageHours > MANIFEST_STALE_HOURS;
  const status: Status = broken > 0 || over
    ? "bad"
    : unplaceable > 0 || stale
    ? "warn"
    : "good";
  const badge = `${compactSpan(age)} old`;
  return {
    status,
    value: `${tests}<small> tests · </small>${time}<small> time</small>`,
    valueLabel: `${tests} of tests, ${time} of test time`,
    // The condition the tile is colored for takes this line, worst
    // first, and the counts of tests and test time hold it while none has.
    sub: broken > 0
      ? `cost model broken: ${broken} alarm${broken === 1 ? "" : "s"}`
      : over
      ? `fullest lane ${fullest.toFixed(0)}s of ${budget}s`
      : unplaceable > 0
      ? `${groupDigits(unplaceable)} test${
        unplaceable === 1 ? "" : "s"
      } too long for any lane`
      : `${groupDigits(selected)} of ${groupDigits(corpus)} · ${
        compactSpan(seconds * 1_000)
      } of ${compactSpan(corpusTime * 1_000)}`,
    aside: stale
      ? `<span class="hfacet" title="${badge}">${badge}</span>`
      : undefined,
    href: broken > 0
      ? `${TEST_SELECTION_PATH}#${HEALTH_SECTION_ID}`
      : TEST_SELECTION_PATH,
    hint: "lanes ↗",
  };
}

export const testSelection = makeTestSelection();
