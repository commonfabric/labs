/**
 * The refusal of a candidate schema by a stored envelope: the candidate
 * changes or weakens an `ifc` claim the envelope fixes, and the merge in
 * `schema-merge.ts` refuses it however often it is presented. Nothing a grant
 * does moves either side of that comparison; a different candidate, or a
 * different stored envelope, does. That is what lets a caller outside the
 * commit — the source reconciler — stop presenting the same candidate.
 *
 * The class rides as a token at the front of the prepare `reason`, as
 * `CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON` does (`migration-reason.ts` says
 * why a token rather than an error class), and a consumer reads it off the
 * refusal's `reasons`, anchored at the start of one reason, so no prose is
 * matched. This module is dependency-free, so the storage rejection vocabulary
 * can import it without pulling in the `cfc/mod.ts` barrel.
 */

/**
 * Stable machine token marking a CFC prepare reason as a refusal by a stored
 * envelope. Emitted into the prepare `reason` (see `prepare.ts`).
 */
export const CFC_ENVELOPE_STABILITY_REASON = "cfc-envelope-stability";

/**
 * What the merge throws when a candidate changes or weakens an `ifc` claim the
 * existing envelope fixes: a set-like claim the candidate drops members of, or
 * a claim that must stay as it is — `writePolicyAnyOf`, `writeAuthorizedBy`,
 * `uiContract`, `exactCopyOf` and the rest of that set — and that the
 * candidate changes. The `.message` is the merge's own sentence; only the
 * recorded reason gains {@link CFC_ENVELOPE_STABILITY_REASON}.
 */
export class CfcEnvelopeStabilityError extends Error {
  /** Constructs an instance with the merge's own `message`. */
  constructor(message: string) {
    super(message);
    this.name = "CfcEnvelopeStabilityError";
  }
}

/** Tags `message` as a refusal by a stored envelope. */
export const envelopeStabilityReason = (message: string): string =>
  `${CFC_ENVELOPE_STABILITY_REASON}: ${message}`;

/** Whether a reason was tagged by {@link envelopeStabilityReason}. */
export const isEnvelopeStabilityReason = (reason: string): boolean =>
  reason.startsWith(`${CFC_ENVELOPE_STABILITY_REASON}: `);

/**
 * `reason` without a leading {@link CFC_ENVELOPE_STABILITY_REASON}, for text a
 * person reads. The token is a classification channel for the refusal's
 * `reasons`, which is where a consumer reads it, and has no business in a
 * rejection message or anything shown from one.
 */
export const withoutEnvelopeStabilityToken = (reason: string): string =>
  isEnvelopeStabilityReason(reason)
    ? reason.slice(CFC_ENVELOPE_STABILITY_REASON.length + 2)
    : reason;
