/**
 * Renders the runners page, which shows what every runner of the
 * organization is doing, and what is waiting for one, as balls, one for each
 * job queued or running, colored by run, heaped in each pool's queue until a
 * runner takes it, then running there until it ends, and leaving the board
 * marked as it ended.
 *
 * The page's script is the runner modules' declarations, handed to the
 * browser by name through `Function.prototype.toString`, with the constants
 * they read written out as JSON, so that the browser runs the same code the
 * server's tests do.
 */

import {
  abbreviateHashes,
  boardTokens,
  boxOffline,
  boxRunning,
  buildBoard,
  compareTuples,
  forgetBeyond,
  MOST_PLACES,
  newSteadiness,
  poolTitle,
  remembersMore,
  RUN_COLORS,
  RunPalette,
  runTitle,
  stableHash,
  steadyBoard,
} from "./runner-board.ts";
import { BallRenderer } from "./runner-gl.ts";
import { JobTracker, outcomeOf } from "./runner-jobs.ts";
import { BOARD_INSET, boxCount, CIRCLE_SIZES, counted, layoutBoard } from "./runner-layout.ts";
import {
  FLIGHT_STEP,
  GRAVITY,
  GROWING,
  heapDiameter,
  HeapWorld,
  LEAVE,
  leaveStep,
  startLeaving,
  steerStep,
} from "./runner-physics.ts";
import {
  BOARD_WIDTH,
  followRunners,
  openedSocket,
  OUTCOME_COLORS,
  RunnersView,
  SOCKET_CHECK_MS,
} from "./runner-view.ts";
import { DETAIL_PAGE_STYLES } from "./detail-page.ts";
import { LIVE_PAGE_BADGE, LIVE_PAGE_STYLES } from "./live-page.ts";
import { RUNNERS_KEY_PATH, RUNNERS_SOCKET_PATH } from "./runners-paths.ts";
import { DASHBOARD_THEME_CLIENT, DASHBOARD_THEME_HEAD, dashboardThemeToggle } from "./theme.ts";

/** The constants the page's script reads, by name. */
const CONSTANTS: Readonly<Record<string, unknown>> = {
  BOARD_INSET,
  BOARD_WIDTH,
  CIRCLE_SIZES,
  FLIGHT_STEP,
  GRAVITY,
  GROWING,
  LEAVE,
  MOST_PLACES,
  OUTCOME_COLORS,
  RUN_COLORS,
  SOCKET_CHECK_MS,
};

/** The functions and classes the page's script runs. */
const DECLARATIONS: readonly { toString(): string }[] = [
  abbreviateHashes,
  BallRenderer,
  boardTokens,
  boxCount,
  boxOffline,
  boxRunning,
  buildBoard,
  compareTuples,
  counted,
  followRunners,
  forgetBeyond,
  heapDiameter,
  HeapWorld,
  JobTracker,
  layoutBoard,
  leaveStep,
  newSteadiness,
  openedSocket,
  outcomeOf,
  poolTitle,
  remembersMore,
  RunnersView,
  RunPalette,
  runTitle,
  stableHash,
  startLeaving,
  steadyBoard,
  steerStep,
];

/**
 * Returns the page's script: every declaration the board runs, and the call
 * that starts it, which connects to the socket at `RUNNERS_SOCKET_PATH` and
 * reloads the page when the server's version is no longer `version`.
 */
export function runnersScript(version: string): string {
  const constants = Object.entries(CONSTANTS).map(([name, value]) =>
    `const ${name} = ${JSON.stringify(value)};`
  );
  return `{
${constants.join("\n")}
${DECLARATIONS.map((declaration) => declaration.toString()).join("\n")}
const scheme = location.protocol === "https:" ? "wss:" : "ws:";
// The socket needs the key that only a page of the dashboard's own origin
// can read.
const openSocket = async (url) => {
  const response = await fetch(${JSON.stringify(RUNNERS_KEY_PATH)}, { cache: "no-store" });
  if (!response.ok) throw new Error("the dashboard did not give the runners page its key");
  const key = await response.text();
  return await openedSocket(url + "?key=" + encodeURIComponent(key));
};
followRunners(scheme + "//" + location.host + ${JSON.stringify(RUNNERS_SOCKET_PATH)}, ${JSON.stringify(version)}, {
  board: document.getElementById("board"),
  chrome: document.getElementById("chrome"),
  balls: document.getElementById("balls"),
  effects: document.getElementById("effects"),
  legend: document.getElementById("legend"),
  tooltip: document.getElementById("tooltip"),
  badge: document.getElementById("live-badge"),
}, openSocket);
}`;
}

/** Returns the runners page, served by the server at `version`. */
export function runnersPage(version: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Runners</title>
${DASHBOARD_THEME_HEAD}
<style>
${DETAIL_PAGE_STYLES}
${LIVE_PAGE_STYLES}
  body{max-width:1140px}
  .stage{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
  .board{position:relative;width:${BOARD_WIDTH}px;aspect-ratio:13/10;flex:none;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .board canvas{position:absolute;left:0;top:0;width:100%;height:100%}
  /* With no room for the legend beside it, the board fills the width and the
     legend goes under it; it is never taller than the window. */
  @media (max-width:${BOARD_WIDTH + 16 + 240 + 40}px){.board{width:min(100%,calc((100vh - 90px) * 1.3))}}
  #balls,#effects{width:100%;height:100%;pointer-events:none}
  .legend{flex:1 1 260px;min-width:240px;max-height:600px;overflow:auto;font-size:12px;padding:10px 12px;box-sizing:border-box;background:var(--surface);border:1px solid var(--border);border-radius:12px}
  .legend .run{display:flex;gap:7px;align-items:center;padding:2px 0}
  .legend .swatch{width:10px;height:10px;border-radius:50%;flex:none}
  .legend .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit;text-decoration:none}
  .legend a.title:hover,.legend a.title:focus-visible{text-decoration:underline}
  .legend .jobs{color:var(--text-muted);font-variant-numeric:tabular-nums;flex:none}
  .tooltip{position:absolute;z-index:3;pointer-events:none;white-space:pre;font-size:10px;line-height:1.35;padding:4px 6px;border-radius:5px;background:var(--surface-deep);color:var(--text);border:1px solid var(--border-strong);box-shadow:0 2px 6px rgba(0,0,0,.2)}
</style></head><body>
  <div class="top"><a class="back" href="/">← dashboard</a><b>Runners</b>${LIVE_PAGE_BADGE}<span>every job queued or running, colored by run</span></div>
  <div class="stage">
    <div class="board" id="board" role="img"><canvas id="chrome"></canvas><canvas id="balls"></canvas><canvas id="effects"></canvas><div class="tooltip" id="tooltip" hidden></div></div>
    <div class="legend" id="legend" role="list" aria-label="What each color is"></div>
  </div>
  <p class="note">Each ball is a job. Point at one to see what it is; click it to open it on GitHub. A job that ends leaves the board marked ✓ if it passed, ✕ if it failed, and – otherwise.</p>
  <div class="foot">${dashboardThemeToggle()}</div>
${DASHBOARD_THEME_CLIENT}
<script>${runnersScript(version)}</script></body></html>`;
}
