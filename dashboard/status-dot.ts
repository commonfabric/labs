/**
 * The status dot every surface of the dashboard marks a good, warning, bad, or
 * unknown thing with. Its shape says what its color says without using color:
 * a circle when all is well, a triangle to warn, a diamond when something needs
 * a person, and a hollow ring when nothing could be read. A reader who cannot
 * tell the three colors apart reads the three shapes instead, so every page
 * that shows a dot takes these rules rather than coloring a circle of its own.
 */

import { STATUS_DOT } from "./tile-render-values.ts";
import type { Status } from "./types.ts";

const STATUSES: Status[] = ["good", "warn", "bad", "unknown"];

// The dot is drawn by its own layer so each status can take a shape as well
// as a color. The diamond is drawn a pixel over each edge so it carries the
// weight the circle does at the same nominal size.
const DOT_SHAPE: Record<Status, string> = {
  good: "border-radius:50%",
  warn: "clip-path:polygon(50% 0,100% 100%,0 100%)",
  bad: "inset:-1px;clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)",
  unknown: "border-radius:50%",
};

/** The dot's box and every shape it wears, at `size` pixels across. */
export function statusDotRules(size = 10): string {
  return `.dot{width:${size}px;height:${size}px;display:inline-block;flex:none;position:relative}
  .dot::before{content:"";position:absolute;inset:0}
  ${
    STATUSES.map((status) =>
      `.dot.${STATUS_DOT[status]}::before{${DOT_SHAPE[status]};${
        status === "unknown"
          ? `border:2px solid var(--status-${status})`
          : `background:var(--status-${status})`
      }}`
    ).join("\n  ")
  }
  .dot.run::before{border-radius:50%;background:var(--running)}`;
}
