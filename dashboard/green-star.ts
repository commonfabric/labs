/**
 * The star that marks a run whose commit a repository's green branch is or
 * was at: solid while the branch is at the commit, and hollow once the branch
 * has moved past it. Every view that draws a run on main large enough
 * to carry the star takes it, and its rules, from here.
 */

import { escapeHtml } from "./tile-render-values.ts";
import type { GreenMark } from "./types.ts";

/** What `mark` says, in words, such as `main-green is at this commit`. */
export const greenWords = (mark: GreenMark): string =>
  `${mark.branch} ${mark.current ? "is" : "was"} at this commit`;

/** The star `mark` is drawn as, or nothing when there is no mark. */
export function greenStar(mark: GreenMark | undefined): string {
  if (mark === undefined) return "";
  const words = escapeHtml(greenWords(mark));
  return `<span class="green-star" role="img" aria-label="${words}" title="${words}">${
    mark.current ? "★" : "☆"
  }</span>`;
}

/**
 * The star's rules: green, and set off from the text that follows it. They
 * name the element, so that they outweigh a page's rule for the spans of a
 * line the star sits in when they come after it.
 */
export const GREEN_STAR_RULES =
  "span.green-star{color:var(--status-good);line-height:1;margin-right:.3em}";
