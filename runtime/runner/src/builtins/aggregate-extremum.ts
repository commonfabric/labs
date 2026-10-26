/**
 * Selects the candidate an extremum aggregate publishes. The choice between two
 * candidates is associative and commutative, so the order and grouping of the
 * aggregate tree cannot change the winner;
 * `docs/features/collection-aggregates.md` explains why.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";

import type { NormalizedFullLink } from "../link-types.ts";

/** Value and stable identity of an extremum candidate. */
export interface AggregateCandidate {
  /** Numeric comparison value, including NaN and infinities. */
  score: number;

  /** Source identity, including duplicate occurrence. */
  key: string;

  /** Original element address, held as data rather than a dereferenced link. */
  element: NormalizedFullLink;
}

/**
 * Chooses the preferred of two candidates; an absent candidate is never
 * preferred. A NaN score is preferred to any other. Otherwise the smaller score
 * is preferred when `minimum` holds and the larger when it does not, and with
 * `distinguishZero` a minimum prefers `-0` to `+0` while a maximum prefers
 * `+0`. Remaining ties prefer the smaller key in UTF-8 order.
 *
 * Over candidates with distinct keys the preference is a total order, which
 * makes the choice associative and commutative. Equal keys return `left`.
 */
export function chooseAggregateCandidate(
  left: AggregateCandidate | undefined,
  right: AggregateCandidate | undefined,
  minimum: boolean,
  distinguishZero: boolean,
): AggregateCandidate | undefined {
  if (!left) return right;
  if (!right) return left;
  const a = left.score;
  const b = right.score;
  if (Number.isNaN(a) !== Number.isNaN(b)) {
    return Number.isNaN(a) ? left : right;
  }
  if (!Number.isNaN(a)) {
    if (a !== b) return (minimum ? a < b : a > b) ? left : right;
    if (distinguishZero && a === 0 && Object.is(a, -0) !== Object.is(b, -0)) {
      return Object.is(a, minimum ? -0 : 0) ? left : right;
    }
  }
  return utf8Compare(left.key, right.key) <= 0 ? left : right;
}
