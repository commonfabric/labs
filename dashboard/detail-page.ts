/**
 * Holds the chrome a page behind a tile starts from: the page frame, the line
 * of navigation back to the dashboard at the top of it, the heading above a
 * section, and the footnote at the bottom. A drill-down adds what its own
 * subject needs on top of these, and may narrow one of them as the CI Gantt
 * page narrows the frame.
 */

import { DASHBOARD_THEME_STYLES } from "./theme.ts";

/** The frame, the navigation, and the type a drill-down page shares. */
export const DETAIL_PAGE_STYLES = `
  ${DASHBOARD_THEME_STYLES}
  body{box-sizing:border-box;width:100%;margin:0 auto;background:var(--page);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px}
  .top{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .top b{font-size:16px;font-weight:600}.top span{font-size:12px;color:var(--text-faint)}
  a.back{color:var(--accent);text-decoration:none;font-size:13px}
  h2{font-size:12px;letter-spacing:.04em;color:var(--text-subtle);font-weight:600;margin:20px 0 8px;font-family:ui-monospace,Menlo,monospace}
  .empty{color:var(--text-muted);font-size:14px}
  .note{font-size:11px;color:var(--text-faint);margin-top:22px}.note a{color:var(--accent);text-decoration:none}`;
