/**
 * Input cells supplied by the host: operator attachments or targets retained
 * from a completed session turn that named a piece. Each receives a handle
 * token at run start, so inputs reach the model as tokens from its first turn.
 * `src/input-cells.ts` documents the posture and performs parsing and minting;
 * this contract is what run state persists.
 */

/** One host-supplied input cell, before minting its turn's handle. */
export interface HarnessInputCellSpec {
  /**
   * The attachment's name, or a slug confirmed by this session's naming
   * tool. Model-facing; the host supplies it rather than reading cell data.
   */
  name: string;

  /**
   * The reference to mint, as an LLM-friendly link string. The cell's shape
   * and labels are not stated here: both live on the cell's declared schema
   * in the fabric, which `describe_handle` reads through the session.
   */
  ref: string;
}

/** One input cell, as recorded in run state. */
export interface HarnessInputCell {
  name: string;

  /** The token the model holds. */
  token: string;

  /** The canonical reference behind it; never model-facing. */
  ref: string;
}
