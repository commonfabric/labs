import type { Tile } from "../types.ts";

/**
 * Holds the spend row's slot for Cubic, the code review service. Cubic's API
 * reports no billing figure, so the tile carries the name, says why it has no
 * value to show, and stays green.
 */
export const cubicSpend: Tile = {
  label: "cubic spend",
  intervalMs: 24 * 60 * 60_000,
  collect: () => Promise.resolve({
    status: "good",
    value: "—",
    sub: "api does not expose value",
  }),
};
