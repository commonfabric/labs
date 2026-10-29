/**
 * Renders a tile's body as a list of rows, each a name with a status dot and a
 * measurement beside it. A row is one line: a name or measurement too wide for
 * the tile is cut rather than wrapped onto a second line, which would push the
 * row below it out of the list's view, and the full text stays in its tooltip.
 * The names and the measurements each fill a column. When the two do not both
 * fit, a column that needs less than half the room between them keeps all it
 * needs and the other takes the rest; otherwise each gets half. A long name
 * therefore never squeezes a short measurement down to nothing, nor a long
 * measurement a short name. Room left over goes to the measurements, so a
 * linked row spans the whole list.
 * A row with an address is a link to it.
 */

// From the render values rather than lib.ts, so the browser layout tests can
// bundle this module without pulling the server-side half of the package in.
import { escapeHtml, STATUS_DOT } from "./tile-render-values.ts";
import type { Status } from "./types.ts";

const LINE = "min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";

export interface DetailRow {
  status: Status;
  name: string;
  detail: string;
  href?: string;
}

function row(entry: DetailRow): string {
  const content =
    `<span title="${
      escapeHtml(entry.name)
    }" style="font-weight:600;${LINE}"><span class="dot ${
      STATUS_DOT[entry.status]
    }"></span>${escapeHtml(entry.name)}</span><span title="${
      escapeHtml(entry.detail)
    }" style="color:var(--text-muted);font-variant-numeric:tabular-nums;${LINE}">${
      escapeHtml(entry.detail)
    }</span>`;
  // A linked row is one grid item across both columns, laid out on the list's
  // own columns, so the link is a box a keyboard and a screen reader can reach
  // rather than an element that draws nothing of its own.
  return entry.href === undefined ? content : `<a href="${
    escapeHtml(entry.href)
  }" target="_blank" rel="noopener" style="grid-column:1/-1;display:grid;grid-template-columns:subgrid;color:inherit;text-decoration:none">${content}</a>`;
}

/** What a list is called, to a screen reader and to the page's live updates. */
export interface DetailListNames {
  // Names the list for a screen reader, as in "Production target details".
  subject: string;
  // Matches this list with its replacement when a live update redraws the
  // tile, so the list keeps a reader's keyboard focus and scroll position.
  focusKey: string;
}

/** The rows as a tile's `extra`, or nothing at all when there are none. */
export function detailList(
  rows: readonly DetailRow[],
  names: DetailListNames,
): string | undefined {
  if (rows.length === 0) return undefined;
  const scrolls = rows.length > 1
    ? ` title="Scroll for more details"`
    : "";
  return `<div class="tile-detail-list" role="region" tabindex="0" data-focus-key="${
    escapeHtml(names.focusKey)
  }" aria-label="${escapeHtml(names.subject)}${
    rows.length > 1 ? "; scroll for more" : ""
  }"${scrolls} style="display:grid;grid-template-columns:minmax(0,max-content) minmax(0,auto);gap:7px 10px;margin-top:11px;font-size:12px;line-height:1.35">${
    rows.map(row).join("")
  }</div>`;
}
