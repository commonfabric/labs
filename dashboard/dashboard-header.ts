/**
 * The dashboard's header: its identity on the left, the freshness indicator on
 * the right, and the shared message filling the space between them.
 */

import { escapeHtml } from "./tile-render-values.ts";
import { statusLayer } from "./theme.ts";

// A steady box shows its text over a hidden copy of the widest text it takes in
// ordinary use, so it keeps one width while its text changes, and the message
// between the two sides of the header keeps its place. The badge reads LIVE or
// OFFLINE; the freshness text counts up an age of up to four digits, all of
// one width.
function steady(id: string, text: string, room: string): string {
  return `<span class="steady"><span id="${id}">${text}</span><span class="room">${room}</span></span>`;
}

export const DASHBOARD_HEADER_RULES = `
  .top{display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;align-items:center;gap:18px;margin-bottom:14px}
  .brand{display:flex;align-items:center;gap:8px}.shortcut{font-size:12px;color:var(--text-faint)}
  .badge{font-size:11px;color:var(--status-good-text);border:1px solid ${
  statusLayer("good", 0.4)
};border-radius:6px;padding:2px 8px;text-align:center}
  .top-actions{display:flex;align-items:center;gap:12px}.live{font-size:12px;color:var(--text-muted);font-variant-numeric:tabular-nums}
  .steady{display:inline-grid}.steady>*{grid-area:1/1}.steady>.room{visibility:hidden}
  .message-form{position:relative;min-width:0;margin:0;border-radius:8px}
  .message-form:focus-within{background:var(--surface);box-shadow:0 0 0 1px var(--border-hover)}
  .message-input{box-sizing:border-box;width:100%;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--text);font:500 16px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;padding:4px 9px;text-align:center;transition:border-color .12s,background-color .12s}
  .message-input::placeholder{color:var(--text-faint);font-weight:400}
  .message-input:hover{border-color:var(--border)}
  .message-input:focus{outline:none}
  .message-input[aria-invalid="true"]{border-color:var(--status-bad)}
  .message-status{position:absolute;top:100%;left:9px;right:9px;color:var(--status-bad-text);font-size:11px;text-align:center}
  @media(max-width:560px){.top{grid-template-columns:minmax(0,1fr) max-content;gap:8px 12px}.top-actions{gap:8px}.message-form{grid-column:1/-1;grid-row:2}.message-input{font-size:14px;padding-inline:5px}}`;

export function dashboardHeader(
  message: string,
  messageMaxLength: number,
  ago: number,
): string {
  return `<div class="top">
    <div class="brand"><span class="badge" id="livebadge">${steady("livetext", "● LIVE", "● OFFLINE")}</span><span class="shortcut">go/fabricwall</span></div>
    <form class="message-form" id="dashboard-message-form"><input class="message-input" id="dashboard-message" aria-label="Shared dashboard message" aria-describedby="dashboard-message-status" maxlength="${messageMaxLength}" value="${
    escapeHtml(message)
  }"><span class="message-status" id="dashboard-message-status" role="status" aria-live="polite"></span></form>
    <div class="top-actions"><div class="live"><span class="dot green" id="freshdot"></span> ${steady("agotext", `updated ${ago}s ago`, "updated 0000s ago")}</div></div>
  </div>`;
}
