/**
 * Renders every tile the same way, turning each one's `TileView` into the same
 * markup whatever produced it. The shell around them wraps the grid and the
 * wide tiles in the page, together with the client that listens for updates.
 */

import type { Status } from "./types.ts";
export { renderTile } from "./tile-render.ts";
import {
  BOTTOM_CHART_RULES,
  DASHBOARD_GRID_RULE,
  TILE_BOX_RULE,
  tileContentRules,
} from "./chart-layout.ts";
import {
  escapeHtml,
  SPARKLINE_HEIGHT,
} from "./lib.ts";
import {
  STATUS_EDGE,
  STATUS_WASH,
  TEXTURE_ALPHA,
  TEXTURE_WIDTH,
} from "./palette.ts";
import { faviconHref, faviconLink, type FaviconStatus } from "./favicon.ts";
import { paintStatusFavicon } from "./favicon-client.ts";
import { liveUpdateStream } from "./stream-client.ts";
import { paintDashboardMessageInput } from "./dashboard-message-client.ts";
import { reconcileTiles } from "./tiles-client.ts";
import {
  DASHBOARD_MESSAGE_FADE_MS,
  DASHBOARD_MESSAGE_MAX_LENGTH,
  DASHBOARD_MESSAGE_VISIBLE_MS,
  dashboardMessageOpacity,
  type DashboardMessage,
} from "./dashboard-message.ts";
import {
  DASHBOARD_THEME_CLIENT,
  DASHBOARD_THEME_HEAD,
  DASHBOARD_THEME_STYLES,
  dashboardThemeToggle,
  statusLayer,
} from "./theme.ts";

const FAVICON_PNG_HREFS = JSON.stringify({
  good: faviconHref("good"),
  warn: faviconHref("warn"),
  bad: faviconHref("bad"),
  "bad-crying": faviconHref("bad-crying"),
});
const PAINT_STATUS_FAVICON = paintStatusFavicon.toString();
const LIVE_UPDATE_STREAM = liveUpdateStream.toString();
const DASHBOARD_MESSAGE_OPACITY = dashboardMessageOpacity.toString();
const PAINT_DASHBOARD_MESSAGE_INPUT = paintDashboardMessageInput.toString();
const RECONCILE_TILES = reconcileTiles.toString();

// How long past the refresh interval the freshness indicator stays orange before
// it turns red. The page treats the same span of silence from the server as a
// stream that has stopped delivering, and reconnects.
const STALE_GRACE_MS = 10_000;

export const FAVICON_CRY_AFTER_MS = 60 * 60 * 1000;

// A texture tile is this tall, and one line's worth of it repeats down the
// layer at that spacing. The width is the pattern's own period, so the tile
// holds a whole number of them and repeats across without a seam.
const TEXTURE_HEIGHT = 24;

/**
 * A tiling mask of one stroked path, for the texture that sits behind a tile's
 * flat color wash. The mask lets CSS paint the path with the active theme's
 * status color. The path is drawn in a `period` by `TEXTURE_HEIGHT` space, and
 * its corners come to a point.
 *
 * A path has to begin and end on the left and right edges of that space,
 * heading the same way at both, so the two ends butt together where the
 * pattern repeats. The round cap is what makes that joint clean: it fills the
 * stroke out to the edge, and the part that reaches past is clipped away.
 */
function strokeTexture(path: string, period: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${period}" height="${TEXTURE_HEIGHT}" ` +
    `viewBox="0 0 ${period} ${TEXTURE_HEIGHT}">` +
    `<path d="${path}" fill="none" stroke="black" ` +
    `stroke-width="${TEXTURE_WIDTH}" stroke-linecap="round"/></svg>`;
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return `--texture-mask:${mask};mask-size:${period}px ${TEXTURE_HEIGHT}px;` +
    `-webkit-mask-size:${period}px ${TEXTURE_HEIGHT}px;` +
    `mask-image:var(--texture-mask);-webkit-mask-image:var(--texture-mask)`;
}

// The wave rises and falls once across its period, which is long enough for a
// stroke this wide to follow without a crest reaching the trough below it. It
// starts and ends halfway up a rise, which is where the pattern repeats.
const WAVE_PERIOD = 60;
const WAVE_TEXTURE = strokeTexture(
  `M0 12q${WAVE_PERIOD / 4} -8 ${WAVE_PERIOD / 2} 0t${WAVE_PERIOD / 2} 0`,
  WAVE_PERIOD,
) + `;background-color:${statusLayer("warn", TEXTURE_ALPHA)}`;
// Two turns of the zig-zag, which puts its period at half the tile. It starts
// and ends halfway along a run rather than on a corner, which keeps every
// corner inside a tile, where the join between its two runs draws the point.
const ZIGZAG_TEXTURE = strokeTexture(
  "M0 12l6-6 12 12 12-12 12 12 6-6",
  48,
) + `;background-color:${statusLayer("bad", TEXTURE_ALPHA)}`;
// Two copies of the same dot grid make a triangular lattice, where each dot has
// six neighbors at one distance rather than a square lattice's four near ones
// and four far ones. The copies are one dot spacing apart across, one spacing
// times the square root of three apart down, and the second copy is shifted by
// half of each. That puts its dots above the midpoint of the gap between two
// dots of the first copy, one spacing away from both, and the same distance
// again from the two below.
const DOT_SPACING_PX = 16;
const DOT_ROW_PX = DOT_SPACING_PX * Math.sqrt(3);
const DOT_STIPPLE = `radial-gradient(${
  statusLayer("unknown", 0.15)
} 1px,transparent 1px)`;
const DOT_TEXTURE = [
  `background-image:${DOT_STIPPLE},${DOT_STIPPLE};`,
  `background-position:0 0,${DOT_SPACING_PX / 2}px ${
    (DOT_ROW_PX / 2).toFixed(2)
  }px;`,
  `background-size:${DOT_SPACING_PX}px ${DOT_ROW_PX.toFixed(2)}px`,
].join("");

// The tallest a tile is taken to be against its own width. The grid gives a
// tile at least 220 pixels across and lets its height follow its content, and
// the tightest the two come is a little under square, on the narrowest layout
// the grid produces. The margin above that carries a label or a sub line that
// wraps onto another line or two.
const MAX_TILE_ASPECT = 1.5;

// The side of the square texture layer, as a percentage of the tile's width.
// Turning the layer sweeps its corners inward, so half its side has to reach
// the tile's corner from the tile's center — the tile's half-diagonal — at
// whatever angle the texture is turned to.
const TEXTURE_LAYER_PCT = Math.ceil(Math.hypot(1, MAX_TILE_ASPECT) * 100);

const STATUSES: readonly Status[] = ["good", "warn", "bad", "unknown"];

// A tile's own color: the wash behind it and the border around it, both
// stronger the more serious the status is. An unknown tile takes neither and
// keeps the neutral border below.
const TILE_RULES = STATUSES.filter((s) => s !== "unknown").map((s) =>
  `  .tile.${s},.tile.wide.${s}{border-color:${
    statusLayer(s, STATUS_EDGE[s])
  };background:${statusLayer(s, STATUS_WASH[s])}}`
).join("\n");

const BIG_RULES = STATUSES.map((s) =>
  `.big.${s}{color:var(--status-${s}-text)}`
)
  .join("");

type ViewerTimeElement = Pick<HTMLTimeElement, "dateTime" | "textContent">;

/** Replace marked absolute timestamps with the viewer's local wall-clock time. */
export function formatViewerTimes(
  times: Iterable<ViewerTimeElement> = document.querySelectorAll<
    HTMLTimeElement
  >(
    "time[data-viewer-time][datetime]",
  ),
  formatter: { format(value: number): string } = new Intl.DateTimeFormat(
    undefined,
    {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    },
  ),
): void {
  for (const time of times) {
    const at = Date.parse(time.dateTime);
    if (Number.isFinite(at)) time.textContent = formatter.format(at);
  }
}

function renderShell(
  gridHtml: string,
  wideHtml: string,
  ago: number,
  refreshMs: number,
  shellVersion: string,
  status: FaviconStatus,
  serverRedSince: number | null = null,
  serverRedAgeMs: number | null = null,
  message: DashboardMessage = { text: "", updatedAt: null, revision: 0 },
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dashboard — LIVE</title>
${DASHBOARD_THEME_HEAD}
${faviconLink(status)}
<style>
${DASHBOARD_THEME_STYLES}
  body{margin:0;background:var(--page);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px;margin:0 auto}
  .top{display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;align-items:center;gap:18px;margin-bottom:14px}
  .brand{display:flex;align-items:center;gap:8px}.shortcut{font-size:12px;color:var(--text-faint)}
  .badge{font-size:11px;color:var(--status-good-text);border:1px solid ${
    statusLayer("good", 0.4)
  };border-radius:6px;padding:2px 8px}
  .top-actions{display:flex;align-items:center;gap:12px}.live{font-size:12px;color:var(--text-muted)}
  .message-form{position:relative;width:min(100%,480px);min-width:0;margin:0;justify-self:center;border-radius:8px}
  .message-form:focus-within{background:var(--surface);box-shadow:0 0 0 1px var(--border-hover)}
  .message-input{box-sizing:border-box;width:100%;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--text);font:500 16px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;padding:4px 9px;text-align:center;transition:border-color .12s,background-color .12s}
  .message-input::placeholder{color:var(--text-faint);font-weight:400}
  .message-input:hover{border-color:var(--border)}
  .message-input:focus{outline:none}
  .message-input[aria-invalid="true"]{border-color:var(--status-bad)}
  .message-status{position:absolute;top:100%;left:9px;right:9px;color:var(--status-bad-text);font-size:11px;text-align:center}
  ${DASHBOARD_GRID_RULE}
  ${TILE_BOX_RULE}
  ${BOTTOM_CHART_RULES}
  .tile.wide{margin-bottom:12px}
${TILE_RULES}
  .tile.unknown,.tile.wide.unknown{border-color:var(--border-strong)}
  /* Each status carries a texture as well as a color, so the dashboard reads at a
     glance and without relying on color alone: dots for gray, waves for
     amber, zig-zags for red. The waves run across the zig-zags, a quarter turn
     from the angle the others take. The texture layer covers the tile and sits
     above the color wash and below the content. It carries the fade: whole
     for the top seventh of the tile, thinning from there, and gone seven
     tenths of the way down. Inside it the texture is turned on an angle, on a
     square layer centered on the tile and measured from the tile's width.
     Turning a box sweeps its corners inward, so the layer only still covers
     the tile if half its side reaches the tile's corner from the center. That
     distance is the tile's half-diagonal, which ${TEXTURE_LAYER_PCT}% of the
     width clears for a tile up to ${MAX_TILE_ASPECT} times as tall as it is
     wide. The fade is measured against the tile and the texture is drawn in
     the turned frame, which is why they are two boxes rather than one. */
  .texture{position:absolute;inset:0;z-index:-1;overflow:hidden;mask-image:linear-gradient(to bottom,#000 15%,transparent 70%)}
  .texture::before{content:"";position:absolute;top:50%;left:50%;width:${TEXTURE_LAYER_PCT}%;aspect-ratio:1;transform:translate(-50%,-50%) rotate(var(--turn,30deg))}
  .tile.unknown .texture::before{${DOT_TEXTURE}}
  .tile.warn .texture::before{${WAVE_TEXTURE};--turn:120deg}
  .tile.bad .texture::before{${ZIGZAG_TEXTURE}}
  ${tileContentRules(SPARKLINE_HEIGHT)}
  ${BIG_RULES}
  a.cell{display:block}
  a.cell:hover{outline:1px solid var(--accent);outline-offset:-1px}
  a.tile.link:hover{border-color:var(--border-hover)}
  .evscroll{max-height:340px;overflow:auto}
  .ev{display:flex;align-items:center;gap:11px;padding:6px 0;font-size:13px;border-top:1px solid var(--divider)}.ev:first-child{border-top:0}
  .ev .t{color:var(--text-muted);min-width:54px;flex:none}
  .evtxt{color:inherit;text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .1s}
  .evtxt:hover{color:var(--text-strong)}
  .evdur{color:var(--text-muted);text-decoration:none;text-align:right;min-width:64px;flex:none;font-variant-numeric:tabular-nums}
  a.evdur:hover{color:var(--accent)}
  .evarrow{color:var(--icon-subtle);text-decoration:none;flex:none;font-size:11px;transition:color .1s}
  .evarrow:hover{color:var(--text-subtle)}
  .note{font-size:11px;color:var(--text-faint);margin-top:14px}
  code{background:var(--surface-code);padding:1px 5px;border-radius:4px}
  @media(max-width:560px){.top{grid-template-columns:minmax(0,1fr) max-content;gap:8px 12px}.top-actions{gap:8px}.message-form{grid-column:1/-1;grid-row:2;width:100%}.message-input{font-size:14px;padding-inline:5px}}
</style></head><body>
  <div class="top">
    <div class="brand"><span class="badge" id="livebadge">● LIVE</span><span class="shortcut">go/fabricwall</span></div>
    <form class="message-form" id="dashboard-message-form"><input class="message-input" id="dashboard-message" aria-label="Shared dashboard message" aria-describedby="dashboard-message-status" maxlength="${DASHBOARD_MESSAGE_MAX_LENGTH}" value="${
      escapeHtml(message.text)
    }"><span class="message-status" id="dashboard-message-status" role="status" aria-live="polite"></span></form>
    <div class="top-actions"><div class="live"><span class="dot green" id="freshdot"></span> <span id="agotext">updated ${ago}s ago</span></div></div>
  </div>
  <div class="grid" id="dashboard-grid">${gridHtml}</div>
  <div id="dashboard-wide">${wideHtml}</div>
${dashboardThemeToggle()}
${DASHBOARD_THEME_CLIENT}
<script>
  const REFRESH = ${refreshMs};
  const RED_AFTER = REFRESH + ${STALE_GRACE_MS};
  const SHELL_VERSION = ${JSON.stringify(shellVersion)};
  const COL = ${
    JSON.stringify({
      green: "var(--status-good-text)",
      amber: "var(--status-warn-text)",
      red: "var(--status-bad-text)",
    })
  };
  const EDGE = ${
    JSON.stringify({
      green: "var(--status-good)",
      amber: "var(--status-warn)",
      red: "var(--status-bad)",
    })
  };
  const FAVICONS = ${FAVICON_PNG_HREFS};
  const FAVICON_CRY_AFTER_MS = ${FAVICON_CRY_AFTER_MS};
  const paintStatusFavicon = ${PAINT_STATUS_FAVICON};
  const dashboardMessageOpacity = ${DASHBOARD_MESSAGE_OPACITY};
  const paintDashboardMessageInput = ${PAINT_DASHBOARD_MESSAGE_INPUT};
  const reconcileTiles = ${RECONCILE_TILES};
  const liveUpdateStream = ${LIVE_UPDATE_STREAM};
  const badge = document.getElementById('livebadge');
  const dot = document.getElementById('freshdot');
  const agotext = document.getElementById('agotext');
  const messageForm = document.getElementById('dashboard-message-form');
  const messageInput = document.getElementById('dashboard-message');
  const messageStatus = document.getElementById('dashboard-message-status');
  ${formatViewerTimes.toString()}
  formatViewerTimes();
  const grid = document.getElementById('dashboard-grid');
  const wide = document.getElementById('dashboard-wide');
  let base = ${ago};
  let t0 = Date.now();
  let faviconServerRedSince = ${serverRedSince};
  let faviconServerRedAgeMs = ${serverRedAgeMs};
  let faviconStartedAt = performance.now();
  let savedMessageText = messageInput.value;
  let messageUpdatedAt = ${message.updatedAt};
  let messageRevision = ${message.revision};
  let messageDirty = false;
  let messageSaveSequence = 0;
  let messageSavePending = false;
  function paintDashboardMessage(now) {
    const state = {
      savedText: savedMessageText,
      updatedAt: messageUpdatedAt,
      draftProtected: messageDirty || messageSavePending,
    };
    paintDashboardMessageInput(
      messageInput,
      state,
      now,
      ${DASHBOARD_MESSAGE_VISIBLE_MS},
      ${DASHBOARD_MESSAGE_FADE_MS},
    );
    savedMessageText = state.savedText;
    messageUpdatedAt = state.updatedAt;
  }
  function applyDashboardMessage(next) {
    if (next.revision < messageRevision) return;
    savedMessageText = next.text;
    messageUpdatedAt = next.updatedAt;
    messageRevision = next.revision;
    if (!messageDirty && !messageSavePending) messageInput.value = next.text;
    paintDashboardMessage(Date.now());
  }
  async function saveDashboardMessage() {
    const saveSequence = ++messageSaveSequence;
    const text = messageInput.value;
    messageDirty = false;
    messageSavePending = true;
    messageStatus.textContent = 'Saving…';
    messageInput.style.opacity = '1';
    try {
      const response = await fetch('/message', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error('Message save failed');
      const saved = await response.json();
      applyDashboardMessage(saved);
      if (saveSequence !== messageSaveSequence) return;
      messageSavePending = false;
      if (!messageDirty) messageInput.value = savedMessageText;
      messageInput.removeAttribute('aria-invalid');
      messageStatus.textContent = '';
    } catch {
      if (saveSequence !== messageSaveSequence) return;
      messageSavePending = false;
      messageDirty = true;
      messageInput.setAttribute('aria-invalid', 'true');
      messageStatus.textContent = 'Message could not be saved.';
    }
  }
  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    messageInput.blur();
  });
  messageInput.addEventListener('input', () => {
    messageDirty = true;
    messageInput.style.opacity = '1';
    messageInput.removeAttribute('aria-invalid');
    messageStatus.textContent = '';
  });
  messageInput.addEventListener('blur', () => {
    if (messageDirty) void saveDashboardMessage();
  });
  function paint() {
    const now = Date.now();
    const ago = base + Math.floor((now - t0) / 1000);
    agotext.textContent = 'updated ' + ago + 's ago';
    // Fresh up to the refresh interval, then orange for 10s, then red.
    const state = ago * 1000 <= REFRESH ? 'green' : ago * 1000 <= RED_AFTER ? 'amber' : 'red';
    dot.className = 'dot ' + state;
    agotext.style.color = COL[state];
    // The badge says which of the two the stale data means: the server is there
    // and has nothing new, or the page cannot hear it.
    badge.textContent = updates.check(now) ? '● LIVE' : '● OFFLINE';
    // LIVE badge: green only when fresh AND no tile is gray; gray if a tile is gray;
    // when stale, the border takes the orange/red and the contents go gray.
    const anyGray = document.querySelector('.tile.unknown') !== null;
    if (state !== 'green') { badge.style.borderColor = EDGE[state]; badge.style.color = 'var(--status-unknown-text)'; }
    else if (anyGray) { badge.style.borderColor = 'var(--status-unknown)'; badge.style.color = 'var(--status-unknown-text)'; }
    else { badge.style.borderColor = 'var(--status-good-text)'; badge.style.color = 'var(--status-good-text)'; }
    paintStatusFavicon(
      FAVICONS,
      FAVICON_CRY_AFTER_MS,
      faviconServerRedSince,
      faviconServerRedAgeMs,
      faviconStartedAt,
    );
    paintDashboardMessage(now);
  }
  function updateTiles(container, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    formatViewerTimes(template.content.querySelectorAll('time[data-viewer-time][datetime]'));
    reconcileTiles(container, Array.from(template.content.children));
  }
  const updates = liveUpdateStream(RED_AFTER, () => {
    const es = new EventSource('/events');
    // The connection's own events repaint, so the badge follows the connection
    // as it changes.
    const alive = () => { updates.heard(Date.now()); paint(); };
    es.addEventListener('open', alive);
    es.addEventListener('ping', alive);
    es.addEventListener('error', () => { updates.lost(); paint(); });
    es.addEventListener('update', (e) => {
      updates.heard(Date.now());
      const update = JSON.parse(e.data);
      if (update.shellVersion !== SHELL_VERSION) { location.reload(); return; }
      updateTiles(grid, update.gridHtml);
      updateTiles(wide, update.wideHtml);
      base = update.ageSeconds;
      t0 = Date.now();
      faviconServerRedSince = update.faviconRedSince;
      faviconServerRedAgeMs = update.faviconRedAgeMs;
      faviconStartedAt = performance.now();
      applyDashboardMessage(update.message);
      paint();
    });
    return es;
  });
  paint();
  setInterval(paint, 1000);
  // A background tab's timers are throttled to about one a minute, and a
  // sleeping machine's stop altogether. These two events fire as the page comes
  // back into use, which is when someone is there to read it.
  document.addEventListener('visibilitychange', paint);
  addEventListener('online', paint);
</script></body></html>`;
}

export function shell(
  gridHtml: string,
  wideHtml: string,
  ago: number,
  refreshMs: number,
  shellVersion: string,
  status: FaviconStatus,
  serverRedSince: number | null = null,
  serverRedAgeMs: number | null = null,
  message: DashboardMessage = { text: "", updatedAt: null, revision: 0 },
): string {
  return renderShell(
    gridHtml,
    wideHtml,
    ago,
    refreshMs,
    shellVersion,
    status,
    serverRedSince,
    serverRedAgeMs,
    message,
  );
}
