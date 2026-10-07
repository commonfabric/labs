import type { TileView } from "./types.ts";
import { durationTag, escapeHtml, STATUS_DOT } from "./tile-render-values.ts";

/**
 * The markup under a view's headline: its `extra`, with the span its
 * `duration` gives drawn in the chart's corner. A duration labels the chart in
 * `extra`, so without chart markup there is no positioned box for the label.
 */
export function chartBody(v: TileView): string {
  return v.duration && v.extra
    ? `<div class="chart" style="position:relative">${v.extra}${
      durationTag(v.duration)
    }</div>`
    : (v.extra ?? "");
}

/** What a link to `href` adds to open it in a new tab when it leaves the page. */
export function newTab(href: string): string {
  return /^https?:/.test(href) ? ` target="_blank" rel="noopener"` : "";
}

export function renderTile(label: string, v: TileView, wide = false): string {
  const cls = `tile ${v.status}${v.href ? " link" : ""}${wide ? " wide" : ""}${
    v.alignChartBottom ? " bottom-chart" : ""
  }`;
  const attributes = `class="${cls}" data-tile-label="${escapeHtml(label)}"`;
  const dot = `<span class="dot ${STATUS_DOT[v.status]}"></span>`;
  const hint = v.hint
    ? `<span class="drill" title="${escapeHtml(v.hint)}" aria-hidden="true">↗</span>`
    : "";
  const header = `<p class="lbl">${dot} ${
    escapeHtml(label)
  }<span class="spacer"></span>${v.aside ?? ""}${hint}</p>`;
  const big = v.value !== undefined
    ? `<p class="big ${v.status}"${
      v.valueLabel === undefined ? "" : ` title="${escapeHtml(v.valueLabel)}"`
    }>${v.value}</p>`
    : "";
  const sub = v.sub
    ? `<p class="sub" title="${escapeHtml(v.sub)}">${escapeHtml(v.sub)}</p>`
    : "";
  const inner = `<div class="texture"></div>${header}${big}${sub}${
    chartBody(v)
  }`;
  if (!v.href) return `<div ${attributes}>${inner}</div>`;
  const tgt = newTab(v.href);
  const description = v.hint
    ? ` aria-description="${escapeHtml(v.hint)}" title="${escapeHtml(v.hint)}"`
    : "";
  return `<a ${attributes} href="${
    escapeHtml(v.href)
  }"${tgt}${description}>${inner}</a>`;
}
