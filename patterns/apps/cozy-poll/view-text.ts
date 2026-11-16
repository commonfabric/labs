/**
 * Reads the cozy poll's view for its tests: whether an element shows a text,
 * an option's row, a vote chip's label and style, and a voter's chip in the
 * summary of all options. Each walks the view once, bottom up.
 */

import {
  childNodes,
  findElementByText,
  isElement,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";

/** What the vote chips show. */
const VOTE_CHIPS = new Set(["🟢", "🟡", "🔴"]);

/** What a walk learns of a subtree. */
interface Walked {
  /** The subtree's text. */
  text: string;

  /** Whether the subtree holds a vote chip. */
  chip: boolean;

  /** The whole text of each element in the subtree outside the vote chips. */
  shown: ReadonlySet<string>;
}

/**
 * Walks the view once, bottom up, calling `visit` with each element and what
 * its subtree holds.
 */
const walkView = (
  root: unknown,
  visit: (node: unknown, walked: Walked) => void,
): void => {
  const walk = (node: unknown): Walked => {
    const value = readValue(node);
    if (typeof value === "string" || typeof value === "number") {
      return { text: String(value), chip: false, shown: new Set() };
    }
    if (typeof value !== "object" || value === null) {
      return { text: "", chip: false, shown: new Set() };
    }
    const parts = childNodes(value).map(walk);
    const text = parts.map((part) => part.text).join("");
    if (Array.isArray(value)) {
      return {
        text,
        chip: parts.some((part) => part.chip),
        shown: new Set(parts.flatMap((part) => [...part.shown])),
      };
    }
    const isChip = isElement(value, "cf-button") &&
      VOTE_CHIPS.has(text.trim());
    const walked = {
      text,
      chip: isChip || parts.some((part) => part.chip),
      shown: isChip
        ? new Set<string>()
        : new Set([text.trim(), ...parts.flatMap((part) => [...part.shown])]),
    };
    visit(value, walked);
    return walked;
  };
  walk(root);
};

/** Whether the view shows an element whose whole text is `text`. */
export const shows = (root: unknown, text: string): boolean => {
  let found = false;
  walkView(root, (_, walked) => found ||= walked.text.trim() === text);
  return found;
};

/** The row of the option titled `title`: the innermost element holding a
 * vote chip and, outside the chips, an element whose whole text is `title`. */
export const optionRow = (root: unknown, title: string): unknown => {
  let row: unknown;
  walkView(root, (node, walked) => {
    if (row === undefined && walked.chip && walked.shown.has(title)) {
      row = node;
    }
  });
  return row;
};

/** The accessible label of the vote chip showing `chip` in `row`. */
export const chipLabel = (row: unknown, chip: string): unknown =>
  propValue(findElementByText(row, "cf-button", chip), "aria-label");

/** The style of the vote chip showing `chip` in `row`. */
export const chipStyle = (row: unknown, chip: string): unknown =>
  propValue(findElementByText(row, "cf-button", chip), "style");

/** The chip in the summary of all options that names `voter` in its title;
 * the viewer's own chip in the header names them too, after its "●". */
export const voterChip = (root: unknown, voter: string): unknown => {
  let chip: unknown;
  walkView(root, (node, walked) => {
    if (
      chip === undefined && propValue(node, "title") === voter &&
      walked.text.trim() !== `●${voter}`
    ) {
      chip = node;
    }
  });
  return chip;
};
