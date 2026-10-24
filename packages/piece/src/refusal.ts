/**
 * What the three doors share when they refuse a name the vocabulary does not
 * hold.
 *
 * Three doors refuse a misspelled name — a projection key, a payload field,
 * and a verb flag — and a caller who mistypes one has made the same mistake
 * whichever door they arrived at. One implementation is what keeps the three
 * refusals from drifting into three different opinions about what counts as
 * close enough.
 */

/**
 * The root of a payload, as a refusal names it. Positions below it are spelled
 * the way the read boundary spells its own (`normalizeProjectionSchema`,
 * `packages/cli/lib/cell-selection.ts`): a property is `.name`, an array
 * element is `[index]`. A caller meets both refusals through the same command,
 * so they name a position the same way.
 *
 * Every flag-door refusal names THIS position and never one below it, because
 * a flag can only name a root field. A payload can nest, and reports the path
 * it reached.
 */
export const EVENT_ROOT_POSITION = "<event>";

/**
 * The edit distance between `left` and `right`.
 *
 * Adjacent transposition counts as one edit rather than two, because it is the
 * typo the refusal exists for: `titel` is one slip from `title` however many
 * substitutions it takes to spell as substitutions.
 */
export function editDistance(left: string, right: string): number {
  const rows: number[][] = [
    Array.from({ length: right.length + 1 }, (_, j) => j),
  ];
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const previous = rows[i - 1];
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]
        : 1 + Math.min(previous[j - 1], previous[j], current[j - 1]);
      if (
        i > 1 && j > 1 && left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        current[j] = Math.min(current[j], rows[i - 2][j - 2] + 1);
      }
    }
    rows.push(current);
  }
  return rows[left.length][right.length];
}

/**
 * The candidate `name` was most likely meant to be, or `undefined` where
 * nothing is close enough to name. A refusal prints no schema, so the accepted
 * vocabulary is the whole remediation, and the one name a caller transposed
 * two letters of is the useful half of it.
 *
 * The threshold scales with the name's length — one edit is always forgiven,
 * and a longer name earns proportionally more — so a short name cannot match
 * an unrelated short name simply by being short.
 *
 * Comparison is case-insensitive, and the candidate is returned in the casing
 * the vocabulary declares it in, which is the casing the caller must type.
 */
export function nearestName(
  name: string,
  candidates: Iterable<string>,
): string | undefined {
  const lowered = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(lowered, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(1, Math.floor(name.length / 4))
    ? best
    : undefined;
}

/**
 * Flag names as prose: "--a", "--a and --b", "--a, --b and --c".
 *
 * Shared because a refusal naming more than one flag is written by more than
 * one door, and a list joined two ways reads as two conventions.
 */
export function listFlags(flags: readonly string[]): string {
  if (flags.length <= 1) return flags.join("");
  return `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)}`;
}
