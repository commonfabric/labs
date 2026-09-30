import type { TileView } from "./types.ts";
import { durationTag, escapeHtml, STATUS_DOT } from "./tile-render-values.ts";

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
  // A duration labels the chart in `extra`; without chart markup there is no
  // positioned box for the label.
  const body = v.duration && v.extra
    ? `<div class="chart" style="position:relative">${v.extra}${
      durationTag(v.duration)
    }</div>`
    : (v.extra ?? "");
  const inner = `<div class="texture"></div>${header}${big}${sub}${body}`;
  if (!v.href) return `<div ${attributes}>${inner}</div>`;
  const tgt = /^https?:/.test(v.href) ? ` target="_blank" rel="noopener"` : "";
  const description = v.hint
    ? ` aria-description="${escapeHtml(v.hint)}" title="${escapeHtml(v.hint)}"`
    : "";
  return `<a ${attributes} href="${
    escapeHtml(v.href)
  }"${tgt}${description}>${inner}</a>`;
}
