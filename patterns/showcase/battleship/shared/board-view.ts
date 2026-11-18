/**
 * Reading Battleship's rendered view in a pattern test. Both games draw each
 * board as a grid: a corner, ten column headers, ten row headers, and then
 * the squares, row by row. The viewer's own board comes first and the enemy
 * board second.
 *
 * Every node a test reads costs a cell read, and the boards hold most of the
 * view's nodes, so `viewOf()` walks the view once and does not descend into
 * the boards: it lists their squares, which a test then reads by position.
 */

import {
  childNodes,
  readValue,
  styleOf,
  textContent,
} from "../../../tools/test-support/vnode-helpers.ts";
import { BOARD_SIZE } from "./constants.tsx";

/** A rendered Battleship view, read once. */
export interface BoardView {
  /** Every node outside the two boards, in document order. */
  nodes: unknown[];

  /** The text outside the two boards, in document order. */
  text: string;

  /** The viewer's own board's squares, row by row; none while hidden. */
  own: unknown[];

  /** The enemy board's squares, row by row; none while hidden. */
  enemy: unknown[];
}

/** The squares of the board `grid`, row by row, past its headers. */
const squaresOf = (grid: unknown): unknown[] =>
  childNodes(grid).flatMap((child) => {
    const value = readValue(child);
    return Array.isArray(value) ? value : [value];
  }).slice(1 + 2 * BOARD_SIZE);

/** Reads the view `root`, listing each board's squares. */
export const viewOf = (root: unknown): BoardView => {
  const nodes: unknown[] = [];
  const grids: unknown[] = [];
  const visit = (node: unknown): void => {
    const value = readValue(node);
    if (styleOf(value, "gridTemplateColumns") !== undefined) {
      grids.push(value);
      return;
    }
    nodes.push(value);
    childNodes(value).forEach(visit);
  };
  visit(root);
  const [own, enemy] = grids.map(squaresOf);
  return {
    nodes,
    text: nodes.filter((node) =>
      typeof node === "string" || typeof node === "number"
    ).join(""),
    own: own ?? [],
    enemy: enemy ?? [],
  };
};

/** The square at `row`, `col` of a board's `squares`. */
export const squareAt = (
  squares: readonly unknown[],
  row: number,
  col: number,
): unknown => squares[row * BOARD_SIZE + col];

/** Whether `square` shows `text` on `color`. */
export const shows = (
  square: unknown,
  text: string,
  color: string,
): boolean =>
  textContent(square) === text && styleOf(square, "backgroundColor") === color;
