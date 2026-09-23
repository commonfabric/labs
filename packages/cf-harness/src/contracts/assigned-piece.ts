/** A successful naming receipt retained on the host for session follow-ups. */
export interface HarnessAssignedPiece {
  /** The validated slug confirmed by assign_slug. */
  slug: string;

  /** The piece's complete address, including its space; never model-facing. */
  ref: string;
}
