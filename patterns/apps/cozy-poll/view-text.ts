/**
 * Reads the cozy poll's view for its tests: whether an element shows a text,
 * an option's row, a vote chip's label and style, and a voter's chip in the
 * summary of all options. Each walks the view once, bottom up.
 */

import {
  childNodes,
  findElementByText,
  propsOf,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";

/** What `walk` learns of a node: its text, and whether it holds a red chip. */
interface Walked {
  text: string;
  chip: boolean;
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
      return { text: String(value), chip: false };
    }
    if (typeof value !== "object" || value === null) {
      return { text: "", chip: false };
    }
    const parts = childNodes(value).map(walk);
    const text = parts.map((part) => part.text).join("");
    const walked = {
      text,
      chip: parts.some((part) => part.chip) ||
        propsOf(value) !== undefined && text.trim() === "🔴",
    };
    if (!Array.isArray(value)) visit(value, walked);
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

/** The innermost element showing `text` that holds a vote chip: the row of
 * the option titled `text`. */
export const optionRow = (root: unknown, text: string): unknown => {
  let row: unknown;
  walkView(root, (node, walked) => {
    if (row === undefined && walked.chip && walked.text.includes(text)) {
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

/** The chip in the summary of all options that names `voter` in its title
 * and shows their initials; the viewer's own chip in the header also names
 * them, but shows their whole name. */
export const voterChip = (root: unknown, voter: string): unknown => {
  let chip: unknown;
  walkView(root, (node, walked) => {
    if (
      chip === undefined && propValue(node, "title") === voter &&
      !walked.text.includes(voter)
    ) {
      chip = node;
    }
  });
  return chip;
};
