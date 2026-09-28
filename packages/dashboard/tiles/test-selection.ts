/**
 * Reports what the newest selection manifest would have a pull request
 * run: what share of the corpus fits five lanes.
 *
 * It goes amber on either of two counts. The manifest has gone stale, and
 * selection quality decays with it. Or the corpus holds a test that costs
 * more on its own than a whole lane's budget, which no packing can place,
 * so a pull request runs it only where its own diff makes it mandatory.
 * It goes red when a lane's projected work is past the bound the whole
 * design rests on.
 *
 * Two of those three want the sub line, and the red one takes it first.
 * Staleness wants the header facet instead, so it competes for neither.
 *
 * The packing itself — every lane, what each holds, and what each is
 * projected to spend — is a page away, along with every test no lane can
 * hold and what each was measured at.
 *
 * Following the dashboard's values (README.md): it reports on the system.
 */

import type { Manifest } from "@commonfabric/test-support/records";

import { compactSpan, groupDigits } from "../lib.ts";
import {
  collectSelectionTile,
  sharedTestSelection,
  type TestSelectionSource,
} from "../test-selection-history.ts";
import {
  laneBudgetOf,
  MANIFEST_SHARE_MS,
  selectedCount,
} from "../test-selection-manifest.ts";
import {
  TEST_SELECTION_PATH,
  testSelectionResponse,
} from "../test-selection-page.ts";
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
  const selected = selectedCount(manifest);
  const known = manifest.entries.length;
  const share = (selected / known) * 100;
  const age = (clock?.() ?? Date.now()) - Date.parse(manifest.generatedAt);
  const ageHours = age / 3_600_000;
  const budget = laneBudgetOf(manifest.dials);
  const fullest = manifest.lanes.length === 0
    ? 0
    : Math.max(...manifest.lanes.map((lane) => lane.projectedSeconds));
  const over = fullest > budget;
  const unplaceable = manifest.unschedulable.length;
  const stale = ageHours > MANIFEST_STALE_HOURS;
  const status: Status = over
    ? "bad"
    : unplaceable > 0 || stale
    ? "warn"
    : "good";
  const badge = `${compactSpan(age)} old`;
  return {
    status,
    value: `${share.toFixed(0)}%`,
    // The condition the tile is colored for takes this line, worst
    // first, and the corpus count holds it while neither has.
    sub: over
      ? `fullest lane ${fullest.toFixed(0)}s of ${budget}s`
      : unplaceable > 0
      ? `${groupDigits(unplaceable)} test${
        unplaceable === 1 ? "" : "s"
      } too long for any lane`
      : `${groupDigits(selected)} of ${groupDigits(known)} tests`,
    aside: stale
      ? `<span class="hfacet" title="${badge}">${badge}</span>`
      : undefined,
    href: TEST_SELECTION_PATH,
    hint: "lanes ↗",
  };
}

export const testSelection = makeTestSelection();
