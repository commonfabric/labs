/**
 * Reports how many tests are too noisy to judge a change by: the ones the
 * publisher measured disagreeing with themselves often enough to be held
 * back from pull requests. A flake list derived from measurement rather
 * than from anybody's judgement at one moment, which is what makes it
 * reverse on its own the moment a test is fixed.
 *
 * The line under the count says how much history the publisher measured over
 * and how long ago it measured. The chart shows the count in every available
 * manifest, with gaps for missing measurements. The tests are a page away.
 *
 * Following the dashboard's values (README.md): it reports on the system.
 * Neither the count nor the page behind it is aggregated per person, and
 * that page names tests, never the people who wrote or touched them.
 */

import type { Manifest } from "@commonfabric/test-support/records";

import { compactSpan, groupDigits } from "../lib.ts";
import {
  collectSelectionTile,
  sharedTestSelection,
  type TestSelectionSource,
} from "../test-selection-history.ts";
import {
  FLAKE_WINDOW_FALLBACK_DAYS,
  flakyCount,
  MANIFEST_SHARE_MS,
  numberDial,
} from "../test-selection-manifest.ts";
import {
  FLAKY_SECTION_ID,
  TEST_SELECTION_PATH,
} from "../test-selection-page.ts";
import { publisherRunning } from "../test-selection-activity.ts";
import type { Status, Tile, TileView } from "../types.ts";

/** How many flaky tests turn the dashboard amber. */
export const FLAKES_WARN = 1;

/** How many turn it red. */
export const FLAKES_BAD = 10;

/** Builds the tile against a data source and a clock. */
export function makeTestFlakes(
  options: { source?: TestSelectionSource; now?: () => number } = {},
): Tile {
  const source = options.source ?? sharedTestSelection;
  return {
    label: "flaky tests",
    intervalMs: MANIFEST_SHARE_MS,
    collectActivity: publisherRunning,
    collect: (_ctx, publish) =>
      collectSelectionTile(
        source,
        "flaky",
        (manifest) => flakesView(manifest, options.now),
        publish,
      ),
  };
}

function flakesView(
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
  const held = flakyCount(manifest);
  const status: Status = held >= FLAKES_BAD
    ? "bad"
    : held >= FLAKES_WARN
    ? "warn"
    : "good";
  // The headline names what it counts, so the figure still means
  // something to somebody who read it before the label above it.
  const headline = held === 0
    ? "no flaky tests"
    : `${groupDigits(held)} flaky test${held === 1 ? "" : "s"}`;
  const days = numberDial(
    manifest.dials,
    "FLAKE_WINDOW_DAYS",
    FLAKE_WINDOW_FALLBACK_DAYS,
  );
  const age = compactSpan(
    (clock?.() ?? Date.now()) - Date.parse(manifest.generatedAt),
  );
  return {
    status,
    value: headline,
    valueLabel: headline,
    // What the count was drawn from: the span of history a flake share is
    // measured over, and how long ago the publisher measured it.
    sub: `${days} days of runs · ${age} old`,
    href: `${TEST_SELECTION_PATH}#${FLAKY_SECTION_ID}`,
    hint: "flakes ↗",
  };
}

export const testFlakes = makeTestFlakes();
