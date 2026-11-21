/**
 * Tests the grid view of pieces: each listed piece renders as a tile preview
 * and as a chip.
 */
import { assert, NAME, pattern, TESTS, UI, Writable } from "commonfabric";
import { countElements } from "../../tools/test-support/vnode-helpers.ts";
import PieceGrid from "./piece-grid.tsx";

export default pattern(() => {
  const alpha = new Writable<{ [NAME]?: string }>({ [NAME]: "Alpha" });
  const beta = new Writable<{ [NAME]?: string }>({ [NAME]: "Beta" });
  const grid = PieceGrid({ pieces: [alpha, beta] });

  return {
    [TESTS]: [
      { assertion: assert(() => grid[NAME] === "Grid View") },
      // A tile preview and a chip for each piece.
      {
        assertion: assert(() => countElements(grid[UI], "cf-render") === 4),
      },
    ],
    grid,
  };
});
