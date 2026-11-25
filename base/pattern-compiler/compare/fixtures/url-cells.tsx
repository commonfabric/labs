/// <cts-enable />
import { cellFromUrl, lift, pattern } from "commonfabric";

interface Link {
  url: string;
}

interface Resolution {
  cell?: unknown;
  pending?: boolean;
}

/** Which resolutions name a cell, and the cells they name, in order. */
const targetsOf = lift(
  (
    { resolutions }: { resolutions: Resolution[] },
  ): { named: boolean[]; cells: unknown[] } => ({
    named: resolutions.map((resolution) => resolution?.cell !== undefined),
    cells: resolutions
      .map((resolution) => resolution?.cell)
      .filter((cell) => cell !== undefined),
  }),
);

// A `map` over an array of plain values in place whose body asks
// `cellFromUrl` for the cell each link's URL names, as the links of a topic
// are asked.
export default pattern<{ links: Link[] }>(({ links }) => {
  const resolutions = links.map((link) => cellFromUrl({ url: link.url }));
  return { targets: targetsOf({ resolutions }) };
});
