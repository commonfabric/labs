/**
 * The page behind the two selection tiles. The tiles carry one number each,
 * which is all a dashboard glanced at from across a room can hold; everything a
 * person wants once that number has caught their eye is here, at full width and
 * with nothing abbreviated: how close each of a pull request's lanes is to its
 * budget, whether the cost model the lanes are packed by still describes what
 * they spend, and every test held back from those lanes together with the
 * measurement that held it back.
 *
 * Following the dashboard's values (README.md): it reports on the system. It
 * names tests, never the people who wrote or touched them.
 */

import {
  type CalibrationHealth,
  type Manifest,
  type ManifestEntry,
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import { type LivePageContent, livePageResponse } from "./live-page.ts";
import {
  compactSpan,
  escapeHtml,
  groupDigits,
} from "./lib.ts";
import { STATUS_EDGE, STATUS_WASH } from "./palette.ts";
import {
  collectionSub,
  sharedTestSelection,
} from "./test-selection-history.ts";
import {
  FLAKE_EXCLUSION_FALLBACK,
  FLAKE_WINDOW_FALLBACK_DAYS,
  flakyCount,
  laneBudgetOf,
  laneTestCount,
  type ManifestReader,
  numberDial,
  selectedCount,
} from "./test-selection-manifest.ts";
import { statusLayer } from "./theme.ts";

/** The fragment the flaky tests tile links to. */
export const FLAKY_SECTION_ID = "flaky";

/** The fragment the tests no lane can hold are listed under. */
export const UNSCHEDULABLE_SECTION_ID = "unschedulable";

/** The fragment the cost model's health is under. */
export const HEALTH_SECTION_ID = "cost-model";

/** Where the page lives, and what both tiles link to. */
export const TEST_SELECTION_PATH = "/test-selection";

const STYLES = `
  .summary{display:flex;flex-wrap:wrap;gap:10px 34px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:4px}
  .summary div{display:flex;flex-direction:column;gap:2px}
  .summary dt{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-subtle)}
  .summary dd{margin:0;font-size:18px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
  .lead{font-size:12px;color:var(--text-muted);margin:0 0 8px}
  .lane{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 14px;margin-bottom:7px}
  .lane.over{border-color:${statusLayer("bad", STATUS_EDGE.bad)};background:${
  statusLayer("bad", STATUS_WASH.bad)
}}
  .lane b{font-size:13px;font-weight:600;flex:none;min-width:58px}
  .lane .fill{flex:1 1 90px;order:1;height:8px;border-radius:4px;background:var(--surface-deep);overflow:hidden}
  @media(max-width:560px){.lane .fill{flex-basis:100%;order:2}}
  .lane .fill span{display:block;height:100%;background:var(--accent)}
  .lane.over .fill span{background:var(--status-bad)}
  .lane .num{flex:none;font-size:13px;color:var(--text-muted);font-variant-numeric:tabular-nums}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th{text-align:left;font-weight:600;color:var(--text-subtle);font-size:11px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;padding:0 12px 5px 0}
  td{padding:5px 12px 5px 0;border-top:1px solid var(--divider);color:var(--text-secondary);vertical-align:top}
  td.measure{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--text)}
  td.name{width:99%;word-break:break-word}
  .alarm{background:${statusLayer("bad", STATUS_WASH.bad)};border:1px solid ${
  statusLayer("bad", STATUS_EDGE.bad)
};border-radius:10px;padding:8px 14px;margin:0 0 8px;font-size:13px;color:var(--text)}
  .alarm ul{margin:4px 0 0;padding-left:18px}
  .scroll{overflow-x:auto}
  tr.over td{color:var(--status-bad)}
  td .was{color:var(--text-faint)}
  td .variant{color:var(--text-faint)}`;

/** One second count, to the precision a page of them stays readable at. */
const seconds = (value: number): string => `${value.toFixed(0)}s`;

/** A flake rate as the percentage the publisher measured. */
const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** An ISO 8601 time cut to the minute, which is the precision a reader wants. */
function minutePrecision(at: string): string {
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

/** The cells naming one test: its kind, its member, and its leaf name. */
function identityCells(test: TestIdentity): string {
  const variant = test.v === undefined
    ? ""
    : ` <span class="variant">(${escapeHtml(test.v)})</span>`;
  return `<td>${escapeHtml(test.k)}</td><td>${escapeHtml(test.s)}</td>` +
    `<td class="name">${escapeHtml(test.n)}${variant}</td>`;
}

/** One test named in a table, under the table's own measurement of it. */
interface TestRow {
  test: TestIdentity;

  /** What the leading column says, absent where nothing measured it. */
  measure?: string;
}

/** A section listing tests, or nothing at all when the list is empty. */
function testSection(section: {
  heading: string;
  id?: string;
  lead: string;

  /** The leading column's heading. */
  measure: string;

  rows: TestRow[];
}): string {
  if (section.rows.length === 0) return "";
  // A row carrying no measurement leaves a gap in the table rather than
  // shifting it.
  const body = section.rows.map((row) =>
    `<tr><td class="measure">${
      escapeHtml(row.measure ?? "—")
    }</td>${identityCells(row.test)}</tr>`
  ).join("");
  const id = section.id === undefined ? "" : ` id="${section.id}"`;
  return `<h2${id}>${escapeHtml(section.heading)} · ${section.rows.length}</h2>
  <p class="lead">${escapeHtml(section.lead)}</p>
  <table><thead><tr><th>${
    escapeHtml(section.measure)
  }</th><th>kind</th><th>member</th><th>test</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * What the flake share counts. The share is over runs rather than over
 * failures, so a test that passes reliably reads as small however many of
 * its rare failures were flakes, and a disagreement weighs less the more
 * runs have followed it, so a test that has settled since reads lower
 * than one that has just started. The counts beside it are what let a reader weigh it,
 * since one disagreement in two runs and a thousand in two thousand are
 * the same ratio and not the same claim.
 */
function flakeLead(manifest: Manifest): string {
  const days = numberDial(
    manifest.dials,
    "FLAKE_WINDOW_DAYS",
    FLAKE_WINDOW_FALLBACK_DAYS,
  );
  const exclusion = numberDial(
    manifest.dials,
    "FLAKE_EXCLUSION_RATE",
    FLAKE_EXCLUSION_FALLBACK,
  );
  return `The share of the runs each test took part in over the last ${days} ` +
    "days that it was seen disagreeing with itself over: the same commit " +
    "both passing and failing, with nothing between the two runs but " +
    "chance. A test that is deterministic cannot do that, so nothing is " +
    "charged against the count and one disagreement among two runs reads " +
    "as the half it is; a disagreement counts for less as the test goes " +
    "on running without repeating it. " +
    `Past ${percent(exclusion)} a test is held back from pull requests, ` +
    "and the share falls again as it goes on running without disagreeing, " +
    "so the exclusion reverses on its own. The counts are flat, so they " +
    "are not what the share divides.";
}

/** The tests held back as flaky, worst-measured first. */
function flakyRows(manifest: Manifest): TestRow[] {
  const scored = new Map(
    manifest.entries.map((entry) => [testIdentityKey(entry.test), entry]),
  );
  return manifest.withheld
    .filter((entry) => entry.reason === "flaky")
    .map((entry) => ({
      test: entry.test,
      scored: scored.get(testIdentityKey(entry.test)),
    }))
    .sort((a, b) => (b.scored?.flakeRate ?? 0) - (a.scored?.flakeRate ?? 0))
    .map(({ test, scored }) => ({
      test,
      ...(scored === undefined ? {} : { measure: flakeMeasure(scored) }),
    }));
}

/**
 * One test's flake share with the counts it was taken from, where the
 * manifest carries them. The share alone says how the exclusion was
 * decided; the counts say how much is behind that decision.
 */
function flakeMeasure(entry: ManifestEntry): string {
  const share = percent(entry.flakeRate);
  const evidence = entry.flakeEvidence;
  if (evidence === undefined) return share;
  return `${share} · ${groupDigits(evidence.flakes)} in ${
    groupDigits(evidence.runs)
  }`;
}

/** The lanes a pull request would run, each against the budget it was packed to. */
function lanesSection(manifest: Manifest): string {
  const budget = laneBudgetOf(manifest.dials);
  const rows = manifest.lanes.map((lane) => {
    const tests = laneTestCount(lane);
    const over = lane.projectedSeconds > budget;
    const filled = Math.min(100, (lane.projectedSeconds / budget) * 100);
    return `<div class="lane${over ? " over" : ""}"><b>Lane ${lane.lane}</b>` +
      `<span class="fill"><span style="width:${filled.toFixed(1)}%"></span></span>` +
      `<span class="num">${seconds(lane.projectedSeconds)} of ${
        seconds(budget)
      }</span>` +
      `<span class="num">${groupDigits(tests)} tests</span></div>`;
  }).join("");
  return `<h2>Lanes</h2>
  <p class="lead">What each lane is projected to spend against the budget this manifest was packed to. The publisher packs these with nothing mandatory, so this is the run a pull request touching no test would get: a real one re-packs against its own diff, placing what that diff makes mandatory first and whatever the cost, and filling what is left of the budget from the same corpus.</p>
  ${rows}`;
}

/** A figure, and what it was in the manifest before where that differs. */
function against(now: string, was: string | undefined): string {
  return was === undefined || was === now
    ? escapeHtml(now)
    : `${escapeHtml(now)} <span class="was">was ${escapeHtml(was)}</span>`;
}

/**
 * Whether the cost model this manifest was packed by still describes what
 * lanes spend: what the publisher found broken, how many lanes ran past their
 * bound, and each suite's charges against the manifest before and against
 * what its batches spent. The suites a lane pays most to hold come first,
 * since those are nearest to crowding everything else out.
 */
function healthSection(manifest: Manifest): string {
  const health = manifest.health;
  const heading = `<h2 id="${HEALTH_SECTION_ID}">Cost model</h2>`;
  if (health === undefined) {
    return `${heading}
  <p class="lead">This manifest carries no figures about its cost model that this page can read.</p>`;
  }
  const budget = laneBudgetOf(manifest.dials);
  const alarms = health.alarms.length === 0
    ? ""
    : `<div class="alarm"><b>The cost model is broken.</b><ul>${
      health.alarms.map((alarm) => `<li>${escapeHtml(alarm)}</li>`).join("")
    }</ul></div>`;
  const rows = Object.entries(health.suites)
    .sort(([a, x], [b, y]) => y.fixed - x.fixed || (a < b ? -1 : 1))
    .map(([suite, figures]) => {
      const was = health.previous?.suites[suite];
      return `<tr${figures.fixed > budget ? ' class="over"' : ""}>` +
        `<td class="name">${escapeHtml(suite)}</td>` +
        `<td class="measure">${
          against(
            seconds(figures.fixed),
            was === undefined ? undefined : seconds(was.fixed),
          )
        }</td>` +
        `<td class="measure">${
          against(
            String(figures.tooLong),
            was === undefined ? undefined : String(was.tooLong),
          )
        }</td>` +
        `<td class="measure">${groupDigits(figures.batches)}</td>` +
        `<td class="measure">${
          figures.ratio === undefined ? "—" : figures.ratio.median.toFixed(2)
        }</td>` +
        `<td class="measure">${
          figures.ratio === undefined ? "—" : figures.ratio.p90.toFixed(2)
        }</td></tr>`;
    }).join("");
  return `${heading}
  <p class="lead">${escapeHtml(healthLead(health))}</p>
  ${alarms}
  <div class="scroll"><table><thead><tr><th>suite</th><th>to hold</th><th>too long</th><th>batches</th><th>median</th><th>90th</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * What the figures in the cost model's table are, and how the lanes it was
 * measured against came out.
 */
function healthLead(health: CalibrationHealth): string {
  const { observed, pastBound, projectedInside, overran } = health.lanes;
  const lanes = observed === 0
    ? "No lane in the cost window recorded its work as a whole."
    : `${groupDigits(pastBound)} of the ${
      groupDigits(observed)
    } lanes in the cost window ran past their bound, ${
      groupDigits(overran)
    } of them among the ${
      groupDigits(projectedInside)
    } the packer projected to finish inside it.`;
  const previous = health.previous === undefined
    ? ""
    : ` A grayed figure is the one in the manifest of ${
      minutePrecision(health.previous.generatedAt)
    }.`;
  return `${lanes} "To hold" is what a lane pays before it runs anything of ` +
    "a suite; past a lane's budget, nothing can share a lane with it. " +
    '"Too long" counts its tests no lane can hold. The last two columns ' +
    "are what its batches spent over what the packer charged for them, at " +
    "the middle batch and at the ninetieth percentile, which the model is " +
    `fitted to hold near one.${previous}`;
}

/** The counts the two tiles headline, spelled out. */
function summary(manifest: Manifest): string {
  const selected = selectedCount(manifest);
  const known = manifest.entries.length;
  const share = known === 0 ? 0 : (selected / known) * 100;
  const facts: Array<[string, string]> = [
    ["selected", `${share.toFixed(0)}%`],
    ["tests", `${groupDigits(selected)} of ${groupDigits(known)}`],
    ["lanes", String(manifest.lanes.length)],
    ["flaky", groupDigits(flakyCount(manifest))],
    ["runs seen", groupDigits(manifest.runs)],
  ];
  return `<dl class="summary">${
    facts.map(([term, value]) =>
      `<div><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`
    ).join("")
  }</dl>`;
}

/**
 * The page's frame, which every state of it wears. Everything that changes
 * from one manifest to the next is inside `<main>`, which the page brings up
 * to date as the server renders it again.
 */
function frame(head: string, body: string): LivePageContent {
  return {
    title: "Test selection",
    styles: STYLES,
    head,
    body: `${body}
  <p class="note">What a pull request runs, from the newest manifest the selection publisher wrote.</p>`,
  };
}

/** The page for one manifest, or the page saying there is not one. */
export function testSelectionPage(
  manifest: Manifest | undefined,
  now = Date.now(),
): LivePageContent {
  if (manifest === undefined) {
    return frame(
      "",
      `<p class="empty">No selection manifest has been published yet.</p>`,
    );
  }
  const head = `commit ${escapeHtml(manifest.commit.slice(0, 7))} · generated ${
    escapeHtml(minutePrecision(manifest.generatedAt))
  }, ${compactSpan(now - Date.parse(manifest.generatedAt))} ago`;
  return frame(
    head,
    `${summary(manifest)}
  ${lanesSection(manifest)}
  ${healthSection(manifest)}
  ${
      testSection({
        heading: "Held back as flaky",
        id: FLAKY_SECTION_ID,
        lead: flakeLead(manifest),
        measure: "flake share",
        rows: flakyRows(manifest),
      })
    }
  ${
      testSection({
        heading: "Too long for any lane",
        id: UNSCHEDULABLE_SECTION_ID,
        lead:
          "One execution costs more than a whole lane's budget, so no packing can place them.",
        measure: "cost",
        rows: [...manifest.unschedulable]
          .sort((a, b) => b.cost - a.cost)
          .map((entry) => ({
            test: entry.test,
            measure: seconds(entry.cost),
          })),
      })
    }`,
  );
}

/**
 * The page for a store that could not be read, which is a different thing
 * from a store holding no manifest and says so.
 */
export function testSelectionUnavailable(reason: string): LivePageContent {
  return frame(
    "",
    `<p class="empty">The selection manifest could not be read: ${
      escapeHtml(reason)
    }.</p>`,
  );
}

/** Serves the page against the manifest the tiles are already reading. */
export async function testSelectionResponse(
  read: ManifestReader = sharedTestSelection.latest,
  clock?: () => number,
): Promise<Response> {
  try {
    return livePageResponse(testSelectionPage(await read(), clock?.()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("test selection page:", message);
    return livePageResponse(
      testSelectionUnavailable(collectionSub(error)),
      503,
    );
  }
}
