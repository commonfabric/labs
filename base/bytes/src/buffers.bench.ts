/**
 * `toOwnedUint8Array()` is how a value that promises an immutable byte
 * sequence gets bytes it can rely on, so its cost is paid once per such value
 * constructed. Each size runs three arms side by side, and it is the spread
 * between them that carries the information:
 *
 * - `share` allocates the source and does nothing else. It is the floor: what
 *   the caller would pay if a holder simply kept the caller's array, taking on
 *   trust what this function enforces. Every arm pays it, so the amount by
 *   which the other two exceed it is the price of that enforcement.
 * - `copy` is the default, and what a caller pays when it keeps its array.
 * - `transfer` is what a caller that cedes its array pays instead.
 *
 * Three properties are worth tracking:
 *
 * 1. **The crossover between `copy` and `transfer`.** `transfer()` moves a
 *    buffer in constant time while a copy is linear in length, so the two
 *    converge as the payload shrinks and diverge as it grows. At digest size
 *    they are near enough to a tie that the choice does not matter; by 1 MiB
 *    the gap is the whole point of offering `transfer` at all. Watch where the
 *    lines cross, because that is what decides whether ceding is worth a call
 *    site's attention.
 *
 * 2. **The floor's share of the total.** At 32 bytes most of what any arm
 *    costs is allocating the source and its wrapper, not moving bytes. That is
 *    why enforcement is not free even for a digest, and why the enforced cost
 *    barely responds to which strategy is chosen.
 *
 * 3. **The absolute cost at 32 bytes.** Digest-sized values are constructed
 *    on hot paths, and at that size the cost is a flat per-construction
 *    addition rather than anything proportional to the work around it. It is
 *    therefore the figure that turns into a percentage of some caller's total,
 *    and the smaller that caller's own work, the larger the percentage.
 *
 * Every arm allocates its own source, because `transfer()` detaches and so
 * cannot be handed the same array twice. At 1 MiB that allocation dominates
 * the absolute numbers; the differences remain meaningful, the totals less so.
 */

import { toOwnedUint8Array } from "./buffers.ts";

/** Sizes to measure, from a hash digest up to a large payload. */
const SIZES = [
  ["32B digest", 32],
  ["64KiB payload", 65536],
  ["1MiB payload", 1048576],
] as const;

/**
 * Sink for every result, so that nothing under measurement is dead code an
 * engine could drop.
 */
let sink: Uint8Array | undefined;

/** A freshly allocated source of the given size, touched at both ends. */
function fresh(size: number): Uint8Array {
  const result = new Uint8Array(size);
  result[0] = 1;
  result[size - 1] = 2;
  return result;
}

for (const [label, size] of SIZES) {
  Deno.bench({
    name: `${label}: share (allocation only, the floor)`,
    group: label,
    baseline: true,
    fn: () => {
      sink = fresh(size);
    },
  });

  Deno.bench({
    name: `${label}: copy`,
    group: label,
    fn: () => {
      sink = toOwnedUint8Array(fresh(size), false);
    },
  });

  Deno.bench({
    name: `${label}: transfer`,
    group: label,
    fn: () => {
      sink = toOwnedUint8Array(fresh(size), true);
    },
  });
}

addEventListener("unload", () => {
  if (sink === undefined) {
    throw new Error("Shouldn't happen: no benchmark ran.");
  }
});
