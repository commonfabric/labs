/**
 * Sets a piece from a compiled pattern up in storage, for a runtime that
 * does not run it: a client under server execution writes the compiled
 * pattern and the argument, and the serving runtime of the space starts the
 * piece from them (`compiled/serving.ts`, milestone 6 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * This module imports the identifiers of the executor's store and none of
 * the executor, so a runtime that only sets pieces up loads no executor.
 */
import {
  argumentOf,
  identifierOf,
} from "../../../../base/pattern-compiler/exec/store.ts";
import type { FabricValue } from "@commonfabric/data-model";
import { type Cell, convertCellsToLinks } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/** The entity that holds a document the executor names by `id`. */
export const entityOfDocument = (id: string): URI =>
  (id.startsWith("of:") ? id : `of:${id}`) as URI;

/**
 * The entity that names the compiled pattern of the piece whose result
 * document is `result`: it holds `{ artifact }`, the entity of the document
 * of the compiled pattern.
 */
export const compiledPointerOf = (result: string): URI =>
  entityOfDocument(identifierOf({ type: "compiled", parent: result }));

/**
 * The entity that holds a compiled pattern, by the text of its artifact:
 * two pieces of one compiled pattern in a space share the document.
 */
export const compiledPatternDocumentOf = (text: string): URI =>
  entityOfDocument(identifierOf({ type: "compiled pattern", text }));

/**
 * Writes into `tx` what the serving runtime starts a compiled piece from:
 * the document of the compiled pattern, which holds the artifact as JSON
 * text, the document that names it for the result document of
 * `resultCell`, and the argument document, where `argument` holds values
 * and cells. The caller commits `tx`, and the result document stays empty
 * until a serving runtime derives it.
 */
export const setUpCompiledPiece = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  artifact: unknown,
  argument: unknown,
  resultCell: Cell<unknown>,
): void => {
  const result = resultCell.getAsNormalizedFullLink();
  if (result.path.length > 0) {
    throw new Error("The result cell of a compiled piece is a whole entity.");
  }
  const at = (id: URI): NormalizedFullLink => ({
    space: result.space,
    id,
    path: [],
    scope: "space",
  });
  const text = JSON.stringify(artifact);
  const pattern = compiledPatternDocumentOf(text);
  tx.writeValueOrThrow(at(pattern), text);
  tx.writeValueOrThrow(at(compiledPointerOf(result.id)), {
    artifact: pattern,
  });
  tx.writeValueOrThrow(
    at(entityOfDocument(argumentOf(result.id))),
    convertCellsToLinks(argument as never) as FabricValue,
  );
  // The runtime is named so that the call reads as `startCompiledPiece`
  // does, and a setup that needs it later changes no caller.
  void runtime;
};
