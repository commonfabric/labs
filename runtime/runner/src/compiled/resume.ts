/**
 * Starts a compiled piece from what the storage holds of it: a second
 * runtime, or the first after a restart, runs the piece on from the
 * argument, the state cells and the result that a run before stored
 * (milestone 6 of `docs/plans/compiled-pattern-language-integration.md`).
 *
 * The executor keeps which cone instances are current in memory alone, so
 * a resume evaluates the whole derivation again, against the stored
 * argument and the stored state, and compares: a path of the result or a
 * row that holds what the derivation gives is not written. A resume over
 * inputs that did not change while no runtime ran the piece therefore
 * commits nothing, and one over inputs that changed commits what differs,
 * in one transaction.
 */
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import {
  argumentOf,
  identifierOf,
} from "../../../../base/pattern-compiler/exec/store.ts";
import type { JSONSchema } from "../builder/types.ts";
import type { Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import {
  type CompiledPiece,
  type CompiledPieceOptions,
  startCompiledPiece,
} from "./piece.ts";

/**
 * A schema that declares no structure, under which a sync follows every
 * link of a document, so that it brings what the document reaches.
 */
const EVERYTHING = {} as JSONSchema;

/** The entity that holds a document the executor names by `id`. */
const entityOf = (id: string): URI =>
  (id.startsWith("of:") ? id : `of:${id}`) as URI;

/**
 * Brings into the replica of `runtime` what a resume of the piece whose
 * result is `resultCell` reads: the result document, the argument
 * document, the document of the counts, the document of each state cell of the pattern's own body, and
 * what each of them reaches through links, the rows that are documents of
 * their own and the inputs among it.
 */
export const syncCompiledPiece = async (
  runtime: Runtime,
  artifact: Artifact,
  resultCell: Cell<unknown>,
  further: readonly string[] = [],
): Promise<void> => {
  const { space, id } = resultCell.getAsNormalizedFullLink();
  const states = artifact.plan.stateCells
    .filter(({ within, name }) =>
      within.length === 0 && typeof name === "string"
    )
    .map(({ name }) =>
      identifierOf({ parent: id, type: "internal", cause: name })
    );
  await Promise.all(
    [
      id,
      argumentOf(id),
      identifierOf({ type: "minted", parent: id }),
      ...states,
      ...further,
    ].map((document) =>
      runtime.getCellFromLink({
        space,
        id: entityOf(document),
        path: [],
        scope: "space",
      }, EVERYTHING).sync()
    ),
  );
};

/**
 * Starts the piece whose result `resultCell` names from what the storage
 * holds of it, and commits what its first derivation writes. `artifact` is
 * the compiled pattern the piece was started with.
 *
 * The state cell of an element body is found when the derivation reaches
 * its element. Where the replica holds no document of one, the derivation
 * is made in a transaction that is aborted, the document is brought, and
 * the derivation is made again.
 */
export const resumeCompiledPiece = async (
  runtime: Runtime,
  artifact: Artifact,
  resultCell: Cell<unknown>,
  options: Omit<CompiledPieceOptions, "resume" | "loadRows"> = {},
): Promise<CompiledPiece> => {
  const brought = new Set<string>();
  await syncCompiledPiece(runtime, artifact, resultCell);
  while (true) {
    const tx = runtime.edit();
    let piece: CompiledPiece;
    try {
      piece = startCompiledPiece(
        runtime,
        tx,
        artifact,
        undefined,
        resultCell.withTx(tx),
        { ...options, resume: true },
      );
    } catch (error) {
      tx.abort(error);
      throw error;
    }
    const states = new Set(
      piece.instance.stateCells().map(({ id }) => id),
    );
    const missing = [...piece.transactions.absent].filter((id) =>
      states.has(id) && !brought.has(id)
    );
    if (missing.length === 0) {
      runtime.prepareTxForCommit(tx);
      const { error } = await tx.commit().settled;
      if (error !== undefined) {
        piece.stop();
        throw error;
      }
      return piece;
    }
    piece.stop();
    tx.abort(new Error("A state cell of the piece was not in the replica."));
    for (const id of missing) brought.add(id);
    await syncCompiledPiece(runtime, artifact, resultCell, missing);
  }
};
