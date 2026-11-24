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

/**
 * A box carrying `attributes` that holds the texture layer, then `head`, then
 * `chart`, all of it a link to `link.href` when there is a `link`, with its
 * `hint` as the link's tooltip and description. The box is that link, unless
 * `chart` holds links of its own: an anchor cannot hold another, so the link
 * then wraps the texture and `head`, and `chart` follows it. The texture
 * covers the box, so all of the box but `chart` is still the link.
 */
export function linkedBox(
  attributes: string,
  head: string,
  chart: string,
  link?: { href: string; hint?: string },
): string {
  const texture = `<div class="texture"></div>`;
  if (link === undefined) {
    return `<div ${attributes}>${texture}${head}${chart}</div>`;
  }
  const target = `href="${escapeHtml(link.href)}"${newTab(link.href)}${
    link.hint
      ? ` aria-description="${escapeHtml(link.hint)}" title="${escapeHtml(link.hint)}"`
      : ""
  }`;
  return /<a[\s>]/i.test(chart)
    ? `<div ${attributes}><a class="tile-head" ${target}>${texture}${head}</a>${chart}</div>`
    : `<a ${attributes} ${target}>${texture}${head}${chart}</a>`;
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
  return linkedBox(
    attributes,
    `${header}${big}${sub}`,
    chartBody(v),
    v.href ? { href: v.href, hint: v.hint } : undefined,
  );
}
