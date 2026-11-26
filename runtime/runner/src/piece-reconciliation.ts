/**
 * The record a piece keeps of what following its active origin last did
 * (`pieceReconciliation` in `meta-seam.ts`), and the reader for it. It
 * depends on nothing above the meta seam, so a module that `runner.ts`
 * imports can read the record without importing `runner.ts` back.
 */

import {
  isObjectNotArray,
  isObjectOrArray,
} from "@commonfabric/js-values/types";

import type { Cell } from "./cell.ts";
import { asPatternIdentityRef } from "./meta-seam.ts";
import { ignoreReadForScheduling } from "./storage/reactivity-log.ts";

/**
 * What the last attempt to follow a piece's active origin did. `unreachable`
 * never had a candidate to weigh; `unapplied` had one the piece could take,
 * and the write adopting it did not land, so the next attempt proposes it
 * again; `refused` had one the piece did not take, for the reason recorded.
 */
export type PieceReconciliationOutcome =
  | "followed"
  | "unreachable"
  | "unapplied"
  | "refused";

/**
 * Why a reconciliation did not adopt what its origin offered.
 *
 * `incompatible-schema` and `argument-mismatch` are different refusals and
 * only one of them can be overruled. The first says the candidate is not an
 * acceptable replacement for what the piece runs, which its owner may decide
 * to accept anyway. The second says the piece's own stored data does not
 * satisfy the candidate, so the piece could not run it — there is nothing to
 * accept, and the data has to change first.
 */
export type PieceReconciliationReason =
  | "incompatible-schema"
  | "argument-mismatch"
  | "source-invalid"
  | "identity-mismatch"
  | "apply-failed";

/**
 * The outcome of the last attempt to follow a piece's active origin, kept on
 * the piece so a reader can tell a piece that runs what its origin offers from
 * one that does not. It is not a revision: a refused candidate was never
 * accepted, and the revision log records only what the piece adopted.
 */
export interface PieceReconciliation {
  outcome: PieceReconciliationOutcome;

  /** When the piece reached this outcome. */
  at: number;

  /** The origin the attempt was following. */
  origin: string;

  /** The pattern the origin offered, when one was resolved. */
  offered?: { identity: string; symbol: string };

  /** Why the candidate was refused. Absent unless `outcome` is `refused`. */
  reason?: PieceReconciliationReason;

  /** What the attempt reported, in its own words. */
  detail?: string;

  /**
   * The source the piece runs, with the latest release time at which its
   * `system:` origin has offered that source since the piece adopted it, in
   * milliseconds since the epoch (`pattern-release-time.ts`). A later deploy
   * of unchanged source moves it forward without adopting anything, which is
   * what keeps the piece from being moved to a release between the one it
   * adopted and the one that confirmed it. It never moves backward, and an
   * accepted transition clears it with the rest of the record.
   */
  confirmed?: { identity: string; releasedAt: number };
}

/**
 * Read the outcome of the last attempt to follow this piece's active origin.
 *
 * A value this runtime cannot read is reported as absent. This state describes
 * a piece rather than guarding a write, so an unreadable one leaves the panel
 * saying nothing instead of failing the read that carries it.
 */
export function getPieceReconciliation(
  resultCell: Cell<unknown>,
): PieceReconciliation | undefined {
  const raw = resultCell.getMetaRaw("pieceReconciliation", {
    meta: ignoreReadForScheduling,
  });
  if (!isObjectOrArray(raw)) return undefined;
  const { outcome, at, origin, offered, reason, detail, confirmed } = raw;
  if (
    !isPieceReconciliationOutcome(outcome) ||
    typeof at !== "number" || !Number.isFinite(at) || at < 0 ||
    typeof origin !== "string" || origin.length === 0
  ) {
    return undefined;
  }
  const offeredRef = asPatternIdentityRef(offered);
  return {
    outcome,
    at,
    origin,
    ...(offeredRef === undefined ? {} : { offered: offeredRef }),
    ...(isPieceReconciliationReason(reason) ? { reason } : {}),
    ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
    ...(isObjectNotArray(confirmed) &&
        typeof confirmed.identity === "string" &&
        confirmed.identity.length > 0 &&
        typeof confirmed.releasedAt === "number" &&
        Number.isFinite(confirmed.releasedAt) && confirmed.releasedAt >= 0
      ? {
        confirmed: {
          identity: confirmed.identity,
          releasedAt: confirmed.releasedAt,
        },
      }
      : {}),
  };
}

function isPieceReconciliationOutcome(
  value: unknown,
): value is PieceReconciliationOutcome {
  return value === "followed" || value === "unreachable" ||
    value === "unapplied" || value === "refused";
}

function isPieceReconciliationReason(
  value: unknown,
): value is PieceReconciliationReason {
  return value === "incompatible-schema" || value === "argument-mismatch" ||
    value === "source-invalid" || value === "identity-mismatch" ||
    value === "apply-failed";
}
