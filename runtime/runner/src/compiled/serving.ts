/**
 * Runs pieces from compiled patterns in a serving runtime: the piece that
 * a result document names a compiled pattern for (`compiled/setup.ts`) is
 * started from what the storage holds when the serving loop reaches one of
 * its documents, by demand or by an event to one of its streams
 * (milestone 6 of `docs/plans/compiled-pattern-language-integration.md`).
 *
 * The serving loop finds the result document of a piece from any document
 * of it by the `result` links, as it does for a piece of today's runtime,
 * and asks `Runtime.compiledPieceLoader` where the result document names no
 * pattern. The piece then runs as on any runtime that starts one: its
 * handlers are event handlers of the scheduler and its derivation is an
 * action of the scheduler, so the loop's event drain reaches the handlers
 * and its waves hold what they and the derivation write.
 */
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { getLogger } from "@commonfabric/logger";
import { stampWaveRunContext } from "../executor/wave.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import {
  type CompiledPiece,
  type CompiledPieceOptions,
  startCompiledPiece,
} from "./piece.ts";
import { resumeCompiledPiece, syncCompiledPiece } from "./resume.ts";
import { compiledPointerOf } from "./setup.ts";

const logger = getLogger("compiled-serving");

/** The pieces a runtime runs or is starting, by the result document. */
const loading = new WeakMap<
  Runtime,
  Map<string, Promise<CompiledPiece | undefined>>
>();
/** The pieces a runtime runs. */
const running = new WeakMap<Runtime, CompiledPiece[]>();

/**
 * The compiled patterns this process parsed, by the entity that holds the
 * text: one parsed artifact serves every piece of it in every space.
 */
const parsed = new Map<string, Artifact>();

/** What `serveCompiledPieces()` takes. */
export type ServeCompiledPiecesOptions = {
  /**
   * What each piece is started with beside the compiled pattern: the
   * artifacts of the patterns its function bodies instantiate, and what its
   * clock holds.
   */
  piece?: Pick<CompiledPieceOptions, "artifacts" | "now">;
  /** Called with each piece the runtime started. */
  started?: (piece: CompiledPiece) => void;
  /**
   * Called where a piece did not start, or where the commit of its load
   * failed, with the result document and the error.
   */
  failed?: (result: string, error: unknown) => void;
};

/** The compiled pieces `runtime` runs through `serveCompiledPieces()`. */
export const compiledPiecesOf = (runtime: Runtime): CompiledPiece[] => [
  ...running.get(runtime) ?? [],
];

/** Reads what the replica of `runtime` holds at the root of an entity. */
const held = (
  runtime: Runtime,
  space: NormalizedFullLink["space"],
  id: URI,
): unknown => {
  const tx = runtime.edit();
  try {
    return tx.readValueOrThrow({ space, id, path: [], scope: "space" });
  } finally {
    tx.abort();
  }
};

/** Brings an entity into the replica of `runtime` and reads its root. */
const brought = async (
  runtime: Runtime,
  space: NormalizedFullLink["space"],
  id: URI,
): Promise<unknown> => {
  await runtime.getCellFromLink({ space, id, path: [], scope: "space" })
    .sync();
  return held(runtime, space, id);
};

/**
 * Starts the piece whose result document is at `root`, where the storage
 * names a compiled pattern for it: from the stored argument alone where
 * the result document is empty, in the bounded transactions of a load, and
 * otherwise as a resume (`resumeCompiledPiece`).
 */
const start = async (
  runtime: Runtime,
  root: Pick<NormalizedFullLink, "space" | "id">,
  failed: (piece: CompiledPiece, error: Error) => void,
  options: ServeCompiledPiecesOptions["piece"] = {},
): Promise<CompiledPiece | undefined> => {
  const { space, id } = root;
  const pointer = await brought(runtime, space, compiledPointerOf(id));
  const named = (pointer as { artifact?: unknown } | undefined)?.artifact;
  if (typeof named !== "string") return undefined;
  let artifact = parsed.get(named);
  if (artifact === undefined) {
    const text = await brought(runtime, space, named as URI);
    if (typeof text !== "string") return undefined;
    artifact = JSON.parse(text) as Artifact;
    parsed.set(named, artifact);
  }
  const resultCell = runtime.getCellFromLink({
    space,
    id,
    path: [],
    scope: "space",
  });
  await syncCompiledPiece(runtime, artifact, resultCell);
  // The wave of a serving runtime takes a transaction that names the run
  // it is of. The load of a piece is a derivation with no acting principal.
  const opened = (tx: IExtendedStorageTransaction) =>
    stampWaveRunContext(tx, {
      actionId: `compiled-piece:load:${id}`,
      kind: "derivation",
    });
  if (held(runtime, space, id) !== undefined) {
    return await resumeCompiledPiece(runtime, artifact, resultCell, {
      ...options,
      opened,
      sealed: { failed },
    });
  }
  const tx = runtime.edit();
  opened(tx);
  let piece: CompiledPiece;
  try {
    piece = startCompiledPiece(
      runtime,
      tx,
      artifact,
      undefined,
      resultCell.withTx(tx),
      // One transaction: the wave commits what the cycle sealed as one
      // commit, and a transaction the load would commit by itself is one
      // the wave has no run for.
      { ...options, loadRows: Infinity, storedArgument: true },
    );
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  runtime.prepareTxForCommit(tx);
  const started = piece;
  tx.commit().settled.then(({ error }) => {
    if (error === undefined) return;
    started.stop();
    failed(started, error);
  });
  return piece;
};

/**
 * Has `runtime` start a piece from a compiled pattern when its serving
 * loop, or an event with no handler, reaches a document of one
 * (`Runtime.compiledPieceLoader`). The runtime needs the experimental
 * option `compiledPatterns`.
 */
export const serveCompiledPieces = (
  runtime: Runtime,
  options: ServeCompiledPiecesOptions = {},
): void => {
  const pieces = new Map<string, Promise<CompiledPiece | undefined>>();
  loading.set(runtime, pieces);
  running.set(runtime, []);
  runtime.compiledPieceLoader = async (root) => {
    let piece = pieces.get(root.id);
    if (piece === undefined) {
      const failed = (stopped: CompiledPiece, error: Error) => {
        pieces.delete(root.id);
        const list = running.get(runtime) ?? [];
        const at = list.indexOf(stopped);
        if (at >= 0) list.splice(at, 1);
        logger.warn("compiled-piece-load-refused", () => [
          `The load of the compiled piece ${root.id} did not commit:`,
          error,
        ]);
        options.failed?.(root.id, error);
      };
      piece = start(runtime, root, failed, options.piece).then((started) => {
        if (started === undefined) pieces.delete(root.id);
        else {
          running.get(runtime)?.push(started);
          options.started?.(started);
        }
        return started;
      }, (error) => {
        pieces.delete(root.id);
        options.failed?.(root.id, error);
        throw error;
      });
      pieces.set(root.id, piece);
    }
    return await piece !== undefined;
  };
};
