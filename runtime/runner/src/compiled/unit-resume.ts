/**
 * Starts a compiled piece from what the storage holds of it and leaves the
 * rows it can as stored: the wake of `resumeCompiledPieceFromBasis()` for a
 * runtime whose replica reads from the store (note 843 of
 * `base/pattern-compiler/SPEC-NOTES.md`).
 *
 * `resumeCompiledPiece()` brings every document the result reaches into
 * the replica and evaluates the whole derivation. Here nothing is brought
 * before the executor starts: the executor reads a document when it
 * evaluates what reads it, which the replica answers from the store in the
 * same read. So the wake needs a replica that reads through the store, as
 * the replica of a serving runtime does.
 */
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import { type CompiledPiece, startCompiledPiece } from "./piece.ts";
import type { ResumeFromBasisOptions } from "./resume.ts";

/**
 * Whether the replica of `space` in `runtime` reads a document it does not
 * hold from the store in the read that asks for it.
 */
export const readsThroughStore = (
  runtime: Runtime,
  space: MemorySpace,
): boolean =>
  (runtime.storageManager as {
    readsThroughStore?: (space: MemorySpace) => boolean;
  }).readsThroughStore?.(space) === true;

/**
 * Starts the piece whose result `resultCell` names from what the storage
 * holds of it, and commits what its first derivation writes. `stale` names
 * the sources of the piece that changed since the stored result was
 * derived. The executor evaluates the bodies that read one of them and
 * every construct it cannot leave as stored, and leaves the rows of the
 * other elements as the storage holds them.
 */
export const resumeCompiledPieceByUnits = (
  runtime: Runtime,
  artifact: Artifact,
  resultCell: Cell<unknown>,
  options: NonNullable<ResumeFromBasisOptions>,
  stale: readonly string[],
): Promise<CompiledPiece> => {
  const { opened, sealed, ...pieceOptions } = options;
  const tx = runtime.edit();
  opened?.(tx);
  let piece: CompiledPiece;
  try {
    piece = startCompiledPiece(
      runtime,
      tx,
      artifact,
      undefined,
      resultCell.withTx(tx),
      { ...pieceOptions, resume: true, stale },
    );
  } catch (error) {
    tx.abort(error);
    return Promise.reject(error);
  }
  runtime.prepareTxForCommit(tx);
  const { settled } = tx.commit();
  if (sealed !== undefined) {
    settled.then(({ error }) => {
      if (error === undefined) return;
      piece.stop();
      sealed.failed(piece, error);
    });
    return Promise.resolve(piece);
  }
  return settled.then(({ error }) => {
    if (error === undefined) return piece;
    piece.stop();
    throw error;
  });
};
