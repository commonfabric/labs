/**
 * Sets a piece from a compiled pattern up in storage, for a runtime that
 * does not run it: a client under server execution writes the source of the
 * pattern and the argument, and the serving runtime of the space compiles
 * the source and starts the piece (`compiled/serving.ts`, milestone 6 of
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
import { rawMetaWriteAuthorization } from "../meta-seam.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * The source of a pattern as a client writes it: the files of the program
 * by name, the name of the main file, and the export of that file that is
 * the pattern, `default` where none is named.
 */
export type PatternProgram = {
  main: string;
  mainExport?: string;
  files: { name: string; contents: string }[];
};

/** The entity that holds a document the executor names by `id`. */
export const entityOfDocument = (id: string): URI =>
  (id.startsWith("of:") ? id : `of:${id}`) as URI;

/**
 * The entity that names the source of the pattern of the piece whose
 * result document is `result`: it holds `{ source }`, the entity of the
 * document of the source.
 */
export const compiledPointerOf = (result: string): URI =>
  entityOfDocument(identifierOf({ type: "compiled", parent: result }));

/**
 * The entity that holds the source of a pattern, by the text it is stored
 * as: two pieces of one source in a space share the document.
 */
export const patternSourceDocumentOf = (text: string): URI =>
  entityOfDocument(identifierOf({ type: "pattern source", text }));

/** The entity of the argument document of the piece whose result is `result`. */
export const argumentDocumentOf = (result: string): URI =>
  entityOfDocument(argumentOf(result));

/**
 * The entity in which the serving runtime writes why it did not start the
 * piece whose result document is `result`: `{ reason }`, where the reason
 * holds the diagnostics of the compiler for a source it refused.
 */
export const compiledFailureOf = (result: string): URI =>
  entityOfDocument(identifierOf({ type: "compiled failure", parent: result }));

/**
 * Whether the result document `id` of `space` is that of a piece of a
 * compiled pattern: the document that names its source holds a source, as
 * `setUpCompiledPiece` writes it. Brings that document into the replica of
 * `runtime` first.
 */
export const namesCompiledPattern = async (
  runtime: Runtime,
  space: NormalizedFullLink["space"],
  id: string,
): Promise<boolean> => {
  const pointer: NormalizedFullLink = {
    space,
    id: compiledPointerOf(id),
    path: [],
    scope: "space",
  };
  await runtime.getCellFromLink(pointer).sync();
  const tx = runtime.edit();
  try {
    const named = tx.readValueOrThrow(pointer) as { source?: unknown };
    return typeof named?.source === "string";
  } finally {
    tx.abort();
  }
};

/** The text a program is stored as, and parsed from (`patternProgramOf`). */
const textOfProgram = ({ main, mainExport, files }: PatternProgram): string =>
  JSON.stringify({
    main,
    ...(mainExport === undefined ? {} : { mainExport }),
    files: files.map(({ name, contents }) => ({ name, contents })),
  });

/**
 * The program a stored text holds, or nothing where the text is not that
 * of a program: some other JSON, an artifact among it, or no JSON.
 */
export const patternProgramOf = (text: string): PatternProgram | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { main, mainExport, files } = parsed as Record<string, unknown>;
  if (
    typeof main !== "string" ||
    (mainExport !== undefined && typeof mainExport !== "string") ||
    !Array.isArray(files)
  ) return undefined;
  const read: PatternProgram["files"] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) return undefined;
    const { name, contents } = file as Record<string, unknown>;
    if (typeof name !== "string" || typeof contents !== "string") {
      return undefined;
    }
    read.push({ name, contents });
  }
  return {
    main,
    ...(mainExport === undefined ? {} : { mainExport }),
    files: read,
  };
};

/**
 * Writes into `tx` what the serving runtime starts a compiled piece from:
 * the document of the source, which holds `program` as JSON text, the
 * document that names it for the result document of `resultCell`, and the
 * argument document, where `argument` holds values and cells. The caller
 * commits `tx`, and the value of the result document stays empty until a
 * serving runtime compiled the source and derived the result. The client
 * writes no artifact: the serving runtime evaluates value code its own
 * compile gave and none it finds stored.
 *
 * The metadata of the result document links to the argument document, as
 * the runner's setup links a piece's result to its argument, so a client
 * that reads or writes the argument of a piece finds it the same way for
 * a compiled piece (`PiecesController.getArgument`). Returns the entity of
 * the document of the source, which is named by the text it holds.
 */
export const setUpCompiledPiece = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  program: PatternProgram,
  argument: unknown,
  resultCell: Cell<unknown>,
): URI => {
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
  const text = textOfProgram(program);
  const source = patternSourceDocumentOf(text);
  tx.writeValueOrThrow(at(source), text);
  tx.writeValueOrThrow(at(compiledPointerOf(result.id)), { source });
  const argumentDocument = at(argumentDocumentOf(result.id));
  tx.writeValueOrThrow(
    argumentDocument,
    convertCellsToLinks(argument as never) as FabricValue,
  );
  // Written through the transaction and not the cell, which would start a
  // load of the result document: a subscription that reaches the serving
  // loop before this commit demands a piece the storage does not name yet.
  tx.writeOrThrow(
    { ...at(result.id), path: ["argument"] },
    runtime.getCellFromLink(argumentDocument).getAsWriteRedirectLink({
      base: resultCell,
    }) as FabricValue,
    rawMetaWriteAuthorization,
  );
  return source;
};
