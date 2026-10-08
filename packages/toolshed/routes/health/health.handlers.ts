import { z } from "zod";
import { resolveGitSha } from "@/lib/build-info.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { DashRoute, IndexRoute, StatsRoute } from "./health.routes.ts";
import {
  getCommitRates,
  getDocumentCachesDiagnostics,
  getPushPriorityStats,
  getSlowQueries,
} from "@commonfabric/memory/v2/server";
import { getServingLoopStats } from "@commonfabric/runner/executor/stats";
import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
} from "@commonfabric/utils/logger";
import * as HttpStatusCodes from "stoker/http-status-codes";
export const HealthResponseSchema = z.object({
  status: z.literal("OK"),
  timestamp: z.number(),
  // The commit this server runs (same resolution as /api/meta). Rides the
  // health response so clients can detect version skew without an extra
  // request; null when unknown.
  gitSha: z.string().nullable(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const GIT_SHA = resolveGitSha();

/** Header carrying the same commit as the body's `gitSha`. Clients that only
 * need liveness + version (the cf CLI) read this instead of the body, so
 * their health probe completes at headers-arrival — a stalled or truncated
 * body cannot delay them. */
export const GIT_SHA_HEADER = "x-cf-git-sha";

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: HealthResponse = {
    status: "OK",
    timestamp: Date.now(),
    gitSha: GIT_SHA,
  };
  if (GIT_SHA !== null) c.header(GIT_SHA_HEADER, GIT_SHA);
  return c.json(response, HttpStatusCodes.OK);
};

const serverStartTimestamp = Date.now();

export const stats: AppRouteHandler<StatsRoute> = (c) => {
  // The serving loop's §7 counters
  // (docs/specs/server-side-execution/serving-loop.md §7): present only
  // when an ExecutorHost runs in this process (the ON arm); the OFF-arm
  // response is byte-identical to today. Phase 6 nests the memory
  // server's push-priority counters (protocol.md §3) under the same
  // ON-arm-only block — all-zero OFF by construction, but the block's
  // very presence stays flag-gated so the OFF response never changes.
  const servingLoop = getServingLoopStats();
  const push = getPushPriorityStats();
  // The memory server's decoded-document caches, one per open space:
  // whether a corpus's working set stays resident between the walks that
  // read it. Present whenever a memory server is co-hosted.
  const documentCaches = getDocumentCachesDiagnostics();
  // The memory server's commit rates over the last minute and ten minutes:
  // which spaces are being written to, by which sessions, and whether one
  // is in a write storm. Present whenever a memory server is co-hosted.
  const commitRates = getCommitRates();
  return c.json({
    timestamp: Date.now(),
    serverStart: serverStartTimestamp,
    logCounts: getLoggerCountsBreakdown(),
    timingStats: getTimingStatsBreakdown(),
    slowQueries: [...getSlowQueries()],
    ...(documentCaches === undefined ? {} : { documentCaches }),
    ...(commitRates === undefined ? {} : { commitRates }),
    ...(servingLoop === undefined ? {} : {
      servingLoop: { ...servingLoop, ...(push === undefined ? {} : { push }) },
    }),
  }, HttpStatusCodes.OK);
};

export const dash: AppRouteHandler<DashRoute> = (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0d1117; color: #c9d1d9; padding: 20px; line-height: 1.5;
  }
  h1 { font-size: 1.5rem; margin-bottom: 4px; color: #58a6ff; }
  h2 { font-size: 1.1rem; margin: 24px 0 8px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .meta { font-size: 0.85rem; color: #8b949e; margin-bottom: 16px; }
  .summary {
    display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px;
  }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 14px 20px; min-width: 140px;
  }
  .card .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.5rem; font-weight: 600; color: #e6edf3; }
  table {
    width: 100%; border-collapse: collapse; background: #161b22;
    border: 1px solid #30363d; border-radius: 8px; overflow: hidden;
    font-size: 0.85rem;
  }
  th {
    text-align: left; padding: 8px 12px; background: #1c2128;
    color: #8b949e; font-weight: 600; font-size: 0.75rem;
    text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid #30363d; white-space: nowrap;
  }
  th[title] {
    cursor: help; border-bottom: 1px dashed #484f58;
  }
  td {
    padding: 6px 12px; border-bottom: 1px solid #21262d; white-space: nowrap;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1c2128; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .warn { color: #d29922; }
  .error { color: #f85149; }
  .empty { color: #484f58; font-style: italic; padding: 16px; text-align: center; }
  .refresh-info { font-size: 0.75rem; color: #484f58; margin-top: 16px; text-align: center; }
  .truncated { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
  .copyable { cursor: pointer; text-decoration: underline dotted #484f58; }
  .copyable:hover { color: #58a6ff; }
  .copied { color: #3fb950 !important; }
  .charts { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
  .chart-box {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 16px; flex: 1 1 320px; min-width: 320px;
  }
  .chart-box h3 {
    font-size: 0.85rem; color: #8b949e; text-transform: uppercase;
    letter-spacing: 0.05em; margin-bottom: 10px; font-weight: 600;
  }
  .chart-box svg { display: block; width: 100%; height: auto; }
  .chart-box svg text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .chart-tooltip {
    position: absolute; background: #1c2128; border: 1px solid #30363d;
    border-radius: 6px; padding: 8px 10px; font-size: 0.75rem; color: #c9d1d9;
    pointer-events: none; white-space: nowrap; z-index: 10; display: none;
    line-height: 1.5; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
</style>
</head>
<body>
<h1>Health Dashboard</h1>
<div class="meta">Auto-refreshes every 5 seconds</div>

<div class="summary" id="summary"></div>

<div class="charts" id="charts">
  <div class="chart-box"><h3>Slow Query Timeline</h3><div id="chart-timeline"></div></div>
  <div class="chart-box"><h3>Operation Distribution</h3><div id="chart-ops"></div></div>
  <div class="chart-box"><h3>Query Latency Histogram</h3><div id="chart-histogram"></div></div>
</div>
<div class="chart-tooltip" id="tooltip"></div>

<h2>Timing Stats</h2>
<div id="timing"></div>

<h2>Slow Queries</h2>
<div id="slow"></div>

<h2>Commit Rates</h2>
<div id="rates"></div>

<h2>Log Counts</h2>
<div id="logs"></div>

<div class="refresh-info" id="refresh-info"></div>

<script>
const $summary = document.getElementById("summary");
const $timing  = document.getElementById("timing");
const $slow    = document.getElementById("slow");
const $rates   = document.getElementById("rates");
const $logs    = document.getElementById("logs");
const $info    = document.getElementById("refresh-info");
let serverStart = null;

function fmtMs(ms) {
  if (ms == null) return "-";
  return ms < 1 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms).toLocaleString();
}

function fmtUptime(startMs) {
  const sec = Math.floor((Date.now() - startMs) / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function fmtSpace(s) {
  if (!s) return "-";
  if (s.length > 24) return s.slice(0, 12) + "..." + s.slice(-8);
  return s;
}

function renderSummary(data) {
  if (data.serverStart) serverStart = data.serverStart;
  const totalLogs = typeof data.logCounts?.total === "number" ? data.logCounts.total : 0;
  const slowCount = Array.isArray(data.slowQueries) ? data.slowQueries.length : 0;
  const storms = Array.isArray(data.commitRates?.spaces) ? data.commitRates.spaces.filter((s) => s.storm).length : 0;
  let timingOps = 0;
  if (data.timingStats) {
    for (const logger of Object.values(data.timingStats)) {
      timingOps += Object.keys(logger).length;
    }
  }
  $summary.innerHTML =
    '<div class="card"><div class="label">Server Uptime</div><div class="value">' + fmtUptime(serverStart) + '</div></div>' +
    '<div class="card"><div class="label">Total Logs</div><div class="value">' + totalLogs.toLocaleString() + '</div></div>' +
    '<div class="card"><div class="label">Timed Ops</div><div class="value">' + timingOps + '</div></div>' +
    '<div class="card"><div class="label">Slow Queries</div><div class="value' + (slowCount > 0 ? ' warn' : '') + '">' + slowCount + '</div></div>' +
    '<div class="card"><div class="label">Write Storms</div><div class="value' + (storms > 0 ? ' error' : '') + '">' + storms + '</div></div>';
}

function renderTiming(timingStats) {
  if (!timingStats || Object.keys(timingStats).length === 0) {
    $timing.innerHTML = '<div class="empty">No timing data recorded yet.</div>';
    return;
  }
  const rows = [];
  for (const [logger, ops] of Object.entries(timingStats)) {
    for (const [op, s] of Object.entries(ops)) {
      rows.push({ logger: logger, op: op, count: s.count, total: s.totalTime, avg: s.average, max: s.max, p50: s.p50, p95: s.p95 });
    }
  }
  rows.sort((a, b) => b.total - a.total);
  let h = '<table><thead><tr><th>Logger</th><th>Operation</th><th class="num">Count</th><th class="num">Total ms</th><th class="num">Avg ms</th><th class="num">P50 ms</th><th class="num">P95 ms</th><th class="num">Max ms</th></tr></thead><tbody>';
  for (const r of rows) {
    h += '<tr><td>' + escHtml(r.logger) + '</td><td>' + escHtml(r.op) + '</td><td class="num">' + r.count.toLocaleString() + '</td><td class="num">' + fmtMs(r.total) + '</td><td class="num">' + fmtMs(r.avg) + '</td><td class="num">' + fmtMs(r.p50) + '</td><td class="num">' + fmtMs(r.p95) + '</td><td class="num">' + fmtMs(r.max) + '</td></tr>';
  }
  h += '</tbody></table>';
  $timing.innerHTML = h;
}

// Store slow query data so click handlers can reference it by index
let _slowData = [];

function renderSlow(slowQueries) {
  if (!Array.isArray(slowQueries) || slowQueries.length === 0) {
    $slow.innerHTML = '<div class="empty">No slow queries recorded.</div>';
    _slowData = [];
    return;
  }
  const sorted = [...slowQueries].sort((a, b) => b.timestamp - a.timestamp);
  _slowData = sorted;
  let h = '<table><thead><tr>'
    + '<th>Time</th>'
    + '<th class="num" title="Total wall-clock time for the query (milliseconds)">Elapsed</th>'
    + '<th>Operation</th>'
    + '<th title="DID of the memory space being queried. Click to copy.">Space</th>'
    + '<th title="Document IDs queried (selectSchema keys). Click to copy.">Docs</th>'
    + '<th class="num" title="Number of schema selectors in the query. Click to copy full selector JSON.">Sel</th>'
    + '<th class="num" title="Number of facts returned in the query result">Facts</th>'
    + '<th class="num" title="Number of documents loaded from storage during traversal">Loaded</th>'
    + '<th class="num" title="Number of individual SQLite selectFact reads (cache misses)">SQLite</th>'
    + '<th class="num" title="Total time spent in SQLite reads (milliseconds)">SQL ms</th>'
    + '<th class="num" title="Number of SQLite reads served from the in-memory cache">Cache</th>'
    + '<th class="num" title="Schema tracker: unique doc keys / total selector values tracked for subscriptions">Tracker</th>'
    + '<th class="num" title="Schema memo: cached traverseWithSchema results reused across docs">Memo</th>'
    + '</tr></thead><tbody>';
  sorted.forEach((q, i) => {
    const cls = q.elapsed > 500 ? ' class="error"' : q.elapsed > 200 ? ' class="warn"' : '';
    const v = (x) => x != null ? x.toLocaleString() : "-";
    const vMs = (x) => x != null ? x.toFixed(0) : "-";
    const tracker = q.trackerKeys != null ? q.trackerKeys + "/" + q.trackerVals : "-";
    const docsArr = Array.isArray(q.docs) ? q.docs : [];
    const docsFull = docsArr.join(", ");
    const docsShort = docsArr.length === 0 ? "-" : docsArr.length === 1 ? fmtSpace(docsArr[0]) : fmtSpace(docsArr[0]) + " +" + (docsArr.length - 1);
    h += '<tr>'
      + '<td>' + fmtTime(q.timestamp) + '</td>'
      + '<td class="num"' + cls + '>' + fmtMs(q.elapsed) + '</td>'
      + '<td>' + escHtml(q.operation || "-") + '</td>'
      + '<td class="truncated copyable" title="' + escHtml(q.space || "") + '" onclick="copySlow(this,'+i+',\\'space\\')">' + escHtml(fmtSpace(q.space)) + '</td>'
      + '<td class="truncated copyable" title="' + escHtml(docsFull) + '" onclick="copySlow(this,'+i+',\\'docs\\')">' + escHtml(docsShort) + '</td>'
      + '<td class="num copyable" title="Click to copy full selector JSON" onclick="copySlow(this,'+i+',\\'selector\\')">' + (q.selectorCount ?? "-") + '</td>'
      + '<td class="num">' + v(q.factCount) + '</td>'
      + '<td class="num">' + v(q.docsLoaded) + '</td>'
      + '<td class="num">' + v(q.sqliteReads) + '</td>'
      + '<td class="num">' + vMs(q.sqliteMs) + '</td>'
      + '<td class="num">' + v(q.sqliteCacheHits) + '</td>'
      + '<td class="num">' + tracker + '</td>'
      + '<td class="num">' + v(q.sharedMemoSize) + '</td>'
      + '</tr>';
  });
  h += '</tbody></table>';
  $slow.innerHTML = h;
}

function copySlow(el, idx, field) {
  const q = _slowData[idx];
  if (!q) return;
  let text;
  if (field === "space") text = q.space || "";
  else if (field === "docs") text = Array.isArray(q.docs) ? q.docs.join(", ") : "";
  else if (field === "selector") text = JSON.stringify(q.selector, null, 2);
  else return;
  copyText(el, text);
}

// One row per reported space: both windows' commits and operations, the
// storm state, and the top writers as "session (principal): 1 min / 10 min".
function renderRates(rates) {
  if (!rates || !Array.isArray(rates.spaces) || rates.spaces.length === 0) {
    $rates.innerHTML = '<div class="empty">No commits in the last ten minutes.</div>';
    return;
  }
  const commits = (w) => (w.accepted + w.rejected).toLocaleString() + (w.rejected > 0 ? ' (' + w.rejected.toLocaleString() + ' rejected)' : '');
  const ops = (w) => w.operations.toLocaleString();
  let h = '<div class="meta">Storm threshold: ' + rates.storm.commitsPerMinute + ' commits/min sustained for ' + rates.storm.sustainedSeconds + ' s. '
    + rates.activeSpaces + ' active space' + (rates.activeSpaces === 1 ? '' : 's') + '.</div>';
  h += '<table><thead><tr>'
    + '<th title="DID of the memory space committed to. Click to copy.">Space</th>'
    + '<th class="num" title="Commits in the last 60 seconds, accepted and rejected">1 min</th>'
    + '<th class="num" title="Operations carried by the last 60 seconds of commits">Ops</th>'
    + '<th class="num" title="Commits in the last 10 minutes, accepted and rejected">10 min</th>'
    + '<th class="num" title="Operations carried by the last 10 minutes of commits">Ops</th>'
    + '<th title="When the run over the storm threshold began, once it has lasted the sustained window">Storm</th>'
    + '<th class="num" title="Sessions with a commit in the last 10 minutes">Writers</th>'
    + '<th title="Top writers over each window: session (principal): 1 min / 10 min commits">Top writers</th>'
    + '</tr></thead><tbody>';
  for (const s of rates.spaces) {
    const storm = s.storm ? '<span class="error">since ' + fmtTime(s.storm.since) + '</span>' : '-';
    const writers = s.writers.map((w) =>
      escHtml(fmtSpace(w.session)) + (w.principal ? ' (' + escHtml(fmtSpace(w.principal)) + ')' : '') + ': ' + commits(w.minute) + ' / ' + commits(w.tenMinutes)
    ).join('<br>');
    h += '<tr>'
      + '<td class="truncated copyable" title="' + escHtml(s.space) + '" onclick="copyText(this)">' + escHtml(fmtSpace(s.space)) + '</td>'
      + '<td class="num' + (s.storm ? ' error' : '') + '">' + commits(s.minute) + '</td>'
      + '<td class="num">' + ops(s.minute) + '</td>'
      + '<td class="num">' + commits(s.tenMinutes) + '</td>'
      + '<td class="num">' + ops(s.tenMinutes) + '</td>'
      + '<td>' + storm + '</td>'
      + '<td class="num">' + s.activeWriters + '</td>'
      + '<td style="white-space: normal">' + writers + '</td>'
      + '</tr>';
  }
  h += '</tbody></table>';
  $rates.innerHTML = h;
}

function renderLogs(logCounts) {
  if (!logCounts || Object.keys(logCounts).length === 0) {
    $logs.innerHTML = '<div class="empty">No log data recorded yet.</div>';
    return;
  }
  let h = '<table><thead><tr><th>Category</th><th class="num">Total</th><th class="num">Debug</th><th class="num">Info</th><th class="num">Warn</th><th class="num">Error</th></tr></thead><tbody>';
  const entries = Object.entries(logCounts).filter(([k]) => k !== "total").sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
  for (const [name, data] of entries) {
    const t = data.total || 0;
    let debug = 0, info = 0, warn = 0, error = 0;
    for (const [k, v] of Object.entries(data)) {
      if (k === "total") continue;
      if (v && typeof v === "object") {
        debug += v.debug || 0;
        info += v.info || 0;
        warn += v.warn || 0;
        error += v.error || 0;
      }
    }
    h += '<tr><td>' + escHtml(name) + '</td><td class="num">' + t.toLocaleString() + '</td><td class="num">' + debug.toLocaleString() + '</td><td class="num">' + info.toLocaleString() + '</td><td class="num' + (warn > 0 ? " warn" : "") + '">' + warn.toLocaleString() + '</td><td class="num' + (error > 0 ? " error" : "") + '">' + error.toLocaleString() + '</td></tr>';
  }
  h += '</tbody></table>';
  $logs.innerHTML = h;
}

const $chartTimeline  = document.getElementById("chart-timeline");
const $chartOps       = document.getElementById("chart-ops");
const $chartHistogram = document.getElementById("chart-histogram");
const $tooltip        = document.getElementById("tooltip");

function svgEl(tag, attrs, children) {
  let s = "<" + tag;
  if (attrs) for (const [k, v] of Object.entries(attrs)) s += " " + k + '="' + v + '"';
  if (!children && !["text","title"].includes(tag)) return s + "/>";
  s += ">";
  if (children) s += children;
  return s + "</" + tag + ">";
}

function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

function copyText(el, text) {
  const str = text ?? el.getAttribute("data-copy") ?? el.title ?? "";
  navigator.clipboard.writeText(str).then(() => {
    el.classList.add("copied");
    const orig = el.textContent;
    el.textContent = "copied!";
    setTimeout(() => { el.classList.remove("copied"); el.textContent = orig; }, 1200);
  });
}

/* ---------- Slow Query Timeline (scatter plot) ---------- */
function renderChartTimeline(slowQueries) {
  if (!Array.isArray(slowQueries) || slowQueries.length === 0) {
    $chartTimeline.innerHTML = '<div class="empty">No slow queries to chart.</div>';
    return;
  }
  const W = 600, H = 260, PAD = {t:20, r:20, b:40, l:55};
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const sorted = [...slowQueries].sort((a, b) => a.timestamp - b.timestamp);
  const now = Date.now();
  const tMin = sorted[0].timestamp, tMax = sorted[sorted.length - 1].timestamp;
  const tSpan = Math.max(tMax - tMin, 1);
  const eMax = sorted.reduce((most, q) => Math.max(most, q.elapsed), 500);

  function dotColor(ms) { return ms > 500 ? "#f85149" : ms > 200 ? "#d29922" : "#3fb950"; }
  function dotR(sc) { return Math.max(3, Math.min(10, 3 + (sc || 1) * 0.7)); }
  function relTime(ts) {
    const sec = Math.round((now - ts) / 1000);
    if (sec < 60) return sec + "s ago";
    if (sec < 3600) return Math.round(sec / 60) + "m ago";
    return Math.round(sec / 3600) + "h ago";
  }

  let dots = "";
  sorted.forEach((q, i) => {
    const cx = PAD.l + ((q.timestamp - tMin) / tSpan) * pw;
    const cy = PAD.t + ph - (q.elapsed / eMax) * ph;
    const r = dotR(q.selectorCount);
    let tip = escHtml(q.operation) + "\\\\n" + fmtMs(q.elapsed) + " ms | " + (q.selectorCount ?? 0) + " selectors\\\\n" + relTime(q.timestamp);
    if (q.factCount != null) tip += "\\\\nfacts=" + q.factCount + " docs=" + q.docsLoaded;
    if (q.sqliteReads != null) tip += "\\\\nsqlite: " + q.sqliteReads + " reads (" + (q.sqliteMs||0).toFixed(0) + "ms) cache=" + q.sqliteCacheHits;
    if (q.trackerKeys != null) tip += "\\\\ntracker: " + q.trackerKeys + " keys / " + q.trackerVals + " vals";
    if (q.sharedMemoSize != null) tip += "\\\\nmemo: " + q.sharedMemoSize + " entries";
    dots += svgEl("circle", {cx:cx.toFixed(1), cy:cy.toFixed(1), r:r, fill:dotColor(q.elapsed), opacity:"0.85",
      "data-tip": tip, onmouseenter:"showTip(evt)", onmouseleave:"hideTip()"});
  });

  // Y-axis ticks
  let yTicks = "";
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round((eMax / ySteps) * i);
    const y = PAD.t + ph - (i / ySteps) * ph;
    yTicks += svgEl("line", {x1:PAD.l, x2:W-PAD.r, y1:y.toFixed(1), y2:y.toFixed(1), stroke:"#21262d", "stroke-width":"1"});
    yTicks += svgEl("text", {x:PAD.l-6, y:y.toFixed(1), fill:"#8b949e", "font-size":"10", "text-anchor":"end", "dominant-baseline":"middle"}, val + "");
  }

  // X-axis labels
  let xLabels = "";
  const xSteps = Math.min(5, sorted.length);
  for (let i = 0; i <= xSteps; i++) {
    const ts = tMin + (tSpan / xSteps) * i;
    const x = PAD.l + (i / xSteps) * pw;
    xLabels += svgEl("text", {x:x.toFixed(1), y:(H - PAD.b + 18).toFixed(1), fill:"#8b949e", "font-size":"10", "text-anchor":"middle"}, relTime(ts));
  }

  // Axis labels
  const yLabel = svgEl("text", {x:"14", y:(PAD.t + ph / 2).toFixed(1), fill:"#8b949e", "font-size":"10", "text-anchor":"middle", transform:"rotate(-90,14," + (PAD.t + ph / 2).toFixed(1) + ")"}, "Elapsed ms");

  // Severity legend
  const legend =
    svgEl("circle", {cx:PAD.l, cy:H-6, r:"4", fill:"#3fb950"}) +
    svgEl("text", {x:PAD.l+8, y:H-3, fill:"#8b949e", "font-size":"9"}, "&lt;200ms") +
    svgEl("circle", {cx:PAD.l+56, cy:H-6, r:"4", fill:"#d29922"}) +
    svgEl("text", {x:PAD.l+64, y:H-3, fill:"#8b949e", "font-size":"9"}, "200-500ms") +
    svgEl("circle", {cx:PAD.l+132, cy:H-6, r:"4", fill:"#f85149"}) +
    svgEl("text", {x:PAD.l+140, y:H-3, fill:"#8b949e", "font-size":"9"}, "&gt;500ms");

  $chartTimeline.innerHTML = svgEl("svg", {viewBox:"0 0 " + W + " " + H, xmlns:"http://www.w3.org/2000/svg"},
    yTicks + xLabels + yLabel + dots + legend);
}

/* ---------- Operation Distribution (horizontal bar chart) ---------- */
function renderChartOps(timingStats) {
  if (!timingStats || Object.keys(timingStats).length === 0) {
    $chartOps.innerHTML = '<div class="empty">No timing data to chart.</div>';
    return;
  }
  const rows = [];
  for (const [logger, ops] of Object.entries(timingStats)) {
    for (const [op, s] of Object.entries(ops)) {
      rows.push({ label: logger + " / " + op, total: s.totalTime, count: s.count, avg: s.average });
    }
  }
  rows.sort((a, b) => b.total - a.total);
  const top = rows.slice(0, 15);
  const maxTotal = Math.max(...top.map(r => r.total), 1);

  const barH = 22, gap = 4, PAD = {t:10, r:20, b:20, l:160};
  const H = PAD.t + top.length * (barH + gap) + PAD.b;
  const W = 600, pw = W - PAD.l - PAD.r;

  let bars = "";
  top.forEach((r, i) => {
    const y = PAD.t + i * (barH + gap);
    const bw = Math.max(2, (r.total / maxTotal) * pw);
    // Label
    const label = r.label.length > 26 ? r.label.slice(0, 24) + ".." : r.label;
    bars += svgEl("text", {x:PAD.l - 6, y:(y + barH / 2 + 1).toFixed(1), fill:"#c9d1d9", "font-size":"11", "text-anchor":"end", "dominant-baseline":"middle"}, escHtml(label));
    // Bar
    const tip = escHtml(r.label) + "\\\\nTotal: " + fmtMs(r.total) + " ms\\\\nCount: " + r.count + " | Avg: " + fmtMs(r.avg) + " ms";
    bars += svgEl("rect", {x:PAD.l, y:y, width:bw.toFixed(1), height:barH, rx:"3", fill:"#58a6ff", opacity:"0.85",
      "data-tip": tip, onmouseenter:"showTip(evt)", onmouseleave:"hideTip()"});
    // Value text
    bars += svgEl("text", {x:(PAD.l + bw + 5).toFixed(1), y:(y + barH / 2 + 1).toFixed(1), fill:"#8b949e", "font-size":"10", "dominant-baseline":"middle"}, fmtMs(r.total) + " ms");
  });

  $chartOps.innerHTML = svgEl("svg", {viewBox:"0 0 " + W + " " + H, xmlns:"http://www.w3.org/2000/svg"}, bars);
}

/* ---------- Query Latency Histogram ---------- */
function renderChartHistogram(slowQueries) {
  if (!Array.isArray(slowQueries) || slowQueries.length === 0) {
    $chartHistogram.innerHTML = '<div class="empty">No slow queries to chart.</div>';
    return;
  }
  const buckets = [
    { label: "0-100", min: 0, max: 100, color: "#3fb950", count: 0 },
    { label: "100-200", min: 100, max: 200, color: "#56d364", count: 0 },
    { label: "200-500", min: 200, max: 500, color: "#d29922", count: 0 },
    { label: "500-1000", min: 500, max: 1000, color: "#db6d28", count: 0 },
    { label: "1000-2000", min: 1000, max: 2000, color: "#f85149", count: 0 },
    { label: "2000+", min: 2000, max: Infinity, color: "#da3633", count: 0 },
  ];
  for (const q of slowQueries) {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (q.elapsed >= buckets[i].min) { buckets[i].count++; break; }
    }
  }
  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  const W = 600, H = 220, PAD = {t:20, r:20, b:40, l:45};
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const barW = pw / buckets.length - 8;

  // Y-axis gridlines
  let grid = "";
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round((maxCount / ySteps) * i);
    const y = PAD.t + ph - (i / ySteps) * ph;
    grid += svgEl("line", {x1:PAD.l, x2:W-PAD.r, y1:y.toFixed(1), y2:y.toFixed(1), stroke:"#21262d", "stroke-width":"1"});
    grid += svgEl("text", {x:PAD.l-6, y:y.toFixed(1), fill:"#8b949e", "font-size":"10", "text-anchor":"end", "dominant-baseline":"middle"}, val + "");
  }

  let bars = "";
  buckets.forEach((b, i) => {
    const x = PAD.l + i * (pw / buckets.length) + 4;
    const bh = Math.max(0, (b.count / maxCount) * ph);
    const y = PAD.t + ph - bh;
    const tip = b.label + " ms\\\\n" + b.count + " quer" + (b.count === 1 ? "y" : "ies");
    bars += svgEl("rect", {x:x.toFixed(1), y:y.toFixed(1), width:barW.toFixed(1), height:bh.toFixed(1), rx:"3", fill:b.color, opacity:"0.85",
      "data-tip": tip, onmouseenter:"showTip(evt)", onmouseleave:"hideTip()"});
    // Count on top of bar
    if (b.count > 0) {
      bars += svgEl("text", {x:(x + barW / 2).toFixed(1), y:(y - 5).toFixed(1), fill:"#c9d1d9", "font-size":"11", "text-anchor":"middle", "font-weight":"600"}, b.count + "");
    }
    // Bucket label
    bars += svgEl("text", {x:(x + barW / 2).toFixed(1), y:(H - PAD.b + 16).toFixed(1), fill:"#8b949e", "font-size":"10", "text-anchor":"middle"}, b.label);
  });
  // X-axis label
  bars += svgEl("text", {x:(PAD.l + pw / 2).toFixed(1), y:(H - 4).toFixed(1), fill:"#8b949e", "font-size":"10", "text-anchor":"middle"}, "Latency (ms)");
  // Y-axis label
  bars += svgEl("text", {x:"12", y:(PAD.t + ph / 2).toFixed(1), fill:"#8b949e", "font-size":"10", "text-anchor":"middle", transform:"rotate(-90,12," + (PAD.t + ph / 2).toFixed(1) + ")"}, "Count");

  $chartHistogram.innerHTML = svgEl("svg", {viewBox:"0 0 " + W + " " + H, xmlns:"http://www.w3.org/2000/svg"}, grid + bars);
}

/* ---------- Tooltip helpers ---------- */
function showTip(evt) {
  const el = evt.target;
  const tip = (el.getAttribute("data-tip") || "").replace(/\\\\n/g, "\\n");
  if (!tip) return;
  $tooltip.innerHTML = tip.replace(/\\n/g, "<br>");
  $tooltip.style.display = "block";
  const rect = el.getBoundingClientRect();
  $tooltip.style.left = (rect.left + rect.width / 2 + window.scrollX) + "px";
  $tooltip.style.top  = (rect.top - 8 + window.scrollY) + "px";
  $tooltip.style.transform = "translate(-50%, -100%)";
}
function hideTip() { $tooltip.style.display = "none"; }

async function refresh() {
  try {
    const res = await fetch("/api/health/stats");
    const data = await res.json();
    renderSummary(data);
    renderChartTimeline(data.slowQueries);
    renderChartOps(data.timingStats);
    renderChartHistogram(data.slowQueries);
    renderTiming(data.timingStats);
    renderSlow(data.slowQueries);
    renderRates(data.commitRates);
    renderLogs(data.logCounts);
    $info.textContent = "Last updated: " + new Date().toLocaleTimeString();
  } catch (e) {
    $info.textContent = "Fetch error: " + e.message;
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

  return c.html(html);
};
