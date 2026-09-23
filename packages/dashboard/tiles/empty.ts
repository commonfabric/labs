/**
 * Holds a place in the grid for a metric nobody has chosen yet. It reads
 * nothing, so it carries no figure, and it is green because there is nothing
 * wrong with an empty slot.
 */

import type { Tile, TileView } from "../types.ts";

export const emptyTile: Tile = {
  label: "your metric here",
  intervalMs: 3_600_000,
  collect(): Promise<TileView> {
    return Promise.resolve({
      status: "good",
      value: "—",
      sub: "do you have data to show?",
    });
  },
};
