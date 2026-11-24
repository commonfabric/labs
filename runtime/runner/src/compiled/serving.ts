/**
 * Runs pieces from compiled patterns in a serving runtime: the piece that
 * a result document names the source of a pattern for (`compiled/setup.ts`)
 * is compiled and started from what the storage holds when the serving loop
 * reaches one of its documents, by demand or by an event to one of its
 * streams (milestone 6 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * The serving runtime compiles. A client writes the source, and the
 * artifact the executor is given is the one the compiler of this process
 * returned for it, whose check accepted every module. The value code is
 * evaluated in a compartment. An artifact that the storage holds is not
 * read, and a source the compiler refuses is not evaluated: the reason is
 * written where the client reads it (`compiledFailureOf`).
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
import type { JSONSchema } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import {
  CompiledPiece,
  type CompiledPieceOptions,
  startCompiledPiece,
} from "./piece.ts";
import { wakeOnOutsideReads } from "./outside-reads.ts";
import {
  resumeCompiledPieceFromBasis,
  type ResumedPiece,
  syncCompiledPiece,
} from "./resume.ts";
import {
  compiledFailureOf,
  compiledPointerOf,
  type PatternProgram,
  patternProgramOf,
} from "./setup.ts";

export type { PatternProgram } from "./setup.ts";

/**
 * What compiles the source of a pattern for a serving runtime: it resolves
 * to the artifact of the pattern the program names and to the artifacts of
 * the program by identity, and rejects where the compiler refuses the
 * program. `PatternCompiler.compile` of `compiled/compile.deno.ts` is one.
 */
export type CompilePatternProgram = (program: PatternProgram) => Promise<{
  main: Artifact;
  artifacts: (id: string) => Artifact | undefined;
}>;

const logger = getLogger("compiled-serving");

/**
 * A piece a serving runtime serves: one that runs, or one that was resumed
 * from its basis, which runs once it is woken.
 */
type Served = CompiledPiece | ResumedPiece;

/** The pieces a runtime serves or is starting, by the result document. */
const loading = new WeakMap<
  Runtime,
  Map<string, Promise<Served | undefined>>
>();
/** The pieces a runtime runs. */
const running = new WeakMap<Runtime, CompiledPiece[]>();

/**
 * What each compiler of this process gave, by the entity that holds the
 * source: one compile serves every piece of a source in every space, and a
 * source the compiler refused is not compiled again. The entity is named
 * by the text it holds.
 */
const compiles = new WeakMap<
  CompilePatternProgram,
  Map<string, ReturnType<CompilePatternProgram>>
>();

/** Why the serving runtime does not start a piece that names a source. */
export class CompiledPieceRefused extends Error {
  override name = "CompiledPieceRefused";
}

/** What `serveCompiledPieces()` takes. */
export type ServeCompiledPiecesOptions = {
  /** What compiles the source a client wrote. */
  compile: CompilePatternProgram;
  /**
   * What each piece is started with beside the compiled pattern: the
   * artifacts of the patterns its function bodies instantiate beside those
   * of its program, what its clock holds, what evaluates its value code
   * where that is not a compartment of the piece's own, the principal its
   * runs act for where no serving loop stamps them, where the links to its
   * rows and buckets are stored, and a harness's stand-ins for `wish` and
   * for built-ins the executor does not have.
   */
  piece?: Pick<
    CompiledPieceOptions,
    | "artifacts"
    | "now"
    | "evaluate"
    | "actsFor"
    | "lists"
    | "listWhole"
    | "wishes"
    | "builtins"
  >;
  /** Called with each piece the runtime started, when its executor runs. */
  started?: (piece: CompiledPiece) => void;
  /**
   * Called with each piece the runtime resumed from its basis, whether the
   * basis matched the storage or not.
   */
  resumed?: (result: string, piece: ResumedPiece) => void;
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

/** The context a transaction of the serving runtime's own is stamped with. */
const stamp = (id: string, what: string) => (tx: IExtendedStorageTransaction) =>
  // The wave of a serving runtime takes a transaction that names the run
  // it is of. The load of a piece is a derivation with no acting principal.
  stampWaveRunContext(tx, {
    actionId: `compiled-piece:${what}:${id}`,
    kind: "derivation",
  });

/**
 * Writes why the piece whose result document is at `root` was not started
 * where the client that set it up reads it. The wave the transaction joins
 * settles it.
 */
const refuse = (
  runtime: Runtime,
  { space, id }: Pick<NormalizedFullLink, "space" | "id">,
  reason: string,
): void => {
  const at = compiledFailureOf(id);
  const stored = held(runtime, space, at);
  if ((stored as { reason?: unknown } | undefined)?.reason === reason) return;
  const tx = runtime.edit();
  stamp(id, "refused")(tx);
  tx.writeValueOrThrow({ space, id: at, path: [], scope: "space" }, {
    reason,
  });
  runtime.prepareTxForCommit(tx);
  tx.commit().settled.then(({ error }) => {
    if (error === undefined) return;
    logger.warn("compiled-piece-refusal-not-stored", () => [
      `The reason the compiled piece ${id} was not started did not commit:`,
      error,
    ]);
  });
};

/**
 * The artifact of the piece whose result document is at `root`, compiled
 * from the source the storage names for it, or nothing where the storage
 * names nothing for it. Throws `CompiledPieceRefused` where what is named
 * is no source, and what the compiler rejects with where it refuses the
 * source.
 */
const compiledFor = async (
  runtime: Runtime,
  { space, id }: Pick<NormalizedFullLink, "space" | "id">,
  compile: CompilePatternProgram,
): Promise<Awaited<ReturnType<CompilePatternProgram>> | undefined> => {
  const pointer = await brought(runtime, space, compiledPointerOf(id));
  if (pointer === undefined) return undefined;
  const named = (pointer as { source?: unknown }).source;
  if (typeof named !== "string") {
    throw new CompiledPieceRefused(
      "The document that names the pattern of the piece names no source. " +
        "The serving runtime compiles the source of a pattern and " +
        "evaluates no artifact that it finds stored.",
    );
  }
  let known = compiles.get(compile);
  if (known === undefined) {
    known = new Map();
    compiles.set(compile, known);
  }
  let compiled = known.get(named);
  if (compiled === undefined) {
    const text = await brought(runtime, space, named as URI);
    const program = typeof text === "string"
      ? patternProgramOf(text)
      : undefined;
    if (program === undefined) {
      throw new CompiledPieceRefused(
        "The document the piece names as its source holds no program.",
      );
    }
    compiled = compile(program);
    known.set(named, compiled);
  }
  return await compiled;
};

/**
 * Starts the piece whose result document is at `root`, where the storage
 * names the source of a pattern for it: from the stored argument alone
 * where the result document is empty, and otherwise from its basis
 * (`resumeCompiledPieceFromBasis`), which starts no executor where the
 * stored result is current. Where the source is refused, the reason is
 * stored for the client and nothing is started.
 */
const start = async (
  runtime: Runtime,
  root: Pick<NormalizedFullLink, "space" | "id">,
  failed: (piece: CompiledPiece, error: Error) => void,
  refused: (error: unknown) => void,
  { compile, piece: options = {} }: ServeCompiledPiecesOptions,
): Promise<Served | undefined> => {
  const { space, id } = root;
  let compiled: Awaited<ReturnType<CompilePatternProgram>> | undefined;
  try {
    compiled = await compiledFor(runtime, root, compile);
  } catch (error) {
    // A demand that reaches the piece again finds the compile kept and the
    // reason stored, and writes nothing.
    await brought(runtime, space, compiledFailureOf(id));
    refuse(runtime, root, error instanceof Error ? error.message : `${error}`);
    refused(error);
    return undefined;
  }
  if (compiled === undefined) return undefined;
  const artifact = compiled.main;
  const ofProgram = compiled.artifacts;
  const pieceOptions = {
    ...options,
    // The artifacts are what the compiler of the runtime gave for the
    // stored source.
    attested: true,
    artifacts: (identity: string) =>
      ofProgram(identity) ?? options.artifacts?.(identity),
  };
  const resultCell = runtime.getCellFromLink({
    space,
    id,
    path: [],
    scope: "space",
  });
  const opened = stamp(id, "load");
  // The result document alone: a piece that is resumed from its basis
  // reads none of its rows.
  await runtime.getCellFromLink(
    { space, id, path: [], scope: "space" },
    false as JSONSchema,
  ).sync();
  if (held(runtime, space, id) !== undefined) {
    const resumed = await resumeCompiledPieceFromBasis(
      runtime,
      artifact,
      resultCell,
      { ...pieceOptions, opened, sealed: { failed } },
    );
    // A piece whose stored result is current runs no action of a `wish`
    // or of a built-in: a change of what those read wakes it.
    if (resumed.current) {
      const stop = await wakeOnOutsideReads(runtime, resultCell, resumed);
      resumed.woken.then(stop, stop);
    }
    return resumed;
  }
  // The result document is empty, and the piece alone writes it.
  await syncCompiledPiece(runtime, artifact, resultCell, [], false);
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
      { ...pieceOptions, loadRows: Infinity, storedArgument: true },
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
  options: ServeCompiledPiecesOptions,
): void => {
  const pieces = new Map<string, Promise<Served | undefined>>();
  loading.set(runtime, pieces);
  running.set(runtime, []);
  const runs = (piece: CompiledPiece) => {
    running.get(runtime)?.push(piece);
    options.started?.(piece);
  };
  runtime.compiledPieceLoader = async (root, why) => {
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
      const refused = (error: unknown) => options.failed?.(root.id, error);
      piece = start(runtime, root, failed, refused, options).then((started) => {
        if (started === undefined) pieces.delete(root.id);
        else if (started instanceof CompiledPiece) runs(started);
        else {
          options.resumed?.(root.id, started);
          // The piece runs once it is woken: here for an event, or by a
          // change of a document its basis names.
          started.woken.then(runs, (error) => {
            pieces.delete(root.id);
            options.failed?.(root.id, error);
          });
        }
        return started;
      }, (error) => {
        pieces.delete(root.id);
        options.failed?.(root.id, error);
        throw error;
      });
      pieces.set(root.id, piece);
    }
    const served = await piece;
    if (served === undefined) return false;
    // A piece whose stored result is current answers a read as it is. An
    // event needs its handlers, which the executor registers.
    if (why?.forEvent === true && !(served instanceof CompiledPiece)) {
      await served.wake();
    }
    return true;
  };
};

/**
 * Has the loader of `runtime` treat `piece` as the running piece of the
 * result document `result`, where `Runtime.run` started it
 * (`runCompiledPatterns`) and the loader did not: a demand or an event
 * that reaches the piece then starts no second executor for it. Does
 * nothing where `serveCompiledPieces()` was not called for the runtime.
 */
export const adoptCompiledPiece = (
  runtime: Runtime,
  result: string,
  piece: CompiledPiece,
): void => {
  loading.get(runtime)?.set(result, Promise.resolve(piece));
  running.get(runtime)?.push(piece);
};

/**
 * Has the loader of `runtime` forget `piece` as the running piece of the
 * result document `result` (`adoptCompiledPiece`): the transaction that
 * started it did not commit, so the storage holds nothing of it.
 */
export const forgetCompiledPiece = (
  runtime: Runtime,
  result: string,
  piece: CompiledPiece,
): void => {
  loading.get(runtime)?.delete(result);
  const list = running.get(runtime);
  const at = list?.indexOf(piece) ?? -1;
  if (at >= 0) list!.splice(at, 1);
};
