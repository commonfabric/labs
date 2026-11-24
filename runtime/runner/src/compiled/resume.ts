/**
 * Starts a compiled piece from what the storage holds of it: a second
 * runtime, or the first after a restart, runs the piece on from the
 * argument, the state cells and the result that a run before stored
 * (milestone 6 of `docs/plans/compiled-pattern-language-integration.md`).
 *
 * `resumeCompiledPieceFromBasis()` first compares the basis the piece
 * stored (`compiled/basis.ts`) with the storage. Where they match, the
 * stored result is current: nothing is evaluated, no document of a row or
 * of the result is read, and no executor is made. The piece then waits,
 * and is woken when a document its basis names changes or when its caller
 * wakes it for an event.
 *
 * A wake, and a resume of a piece whose basis does not match, is
 * `resumeCompiledPiece()`. The executor keeps which cone instances are
 * current in memory alone, so it evaluates the whole derivation again,
 * against the stored argument and the stored state, and compares: a path of
 * the result or a row that holds what the derivation gives is not written.
 * Such a resume over inputs that did not change commits nothing but the
 * basis where that differs, and one over inputs that changed commits what
 * differs, in one transaction.
 */
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { rowDocumentCollections } from "../../../../base/pattern-compiler/exec/row-documents.ts";
import { storedRowCollections } from "../../../../base/pattern-compiler/exec/stored-units.ts";
import {
  argumentOf,
  identifierOf,
} from "../../../../base/pattern-compiler/exec/store.ts";
import {
  basisDocumentOf,
  basisMatches,
  basisPartDocumentOf,
  basisPartOf,
  basisPartsOf,
  compiledIdentityOf,
  staleSourcesOf,
  type StoredBasis,
  storedBasisOf,
} from "./basis.ts";
import {
  readsThroughStore,
  resumeCompiledPieceByUnits,
} from "./unit-resume.ts";
import {
  readersPartDocumentOf,
  readersPartsOf,
  unitsDocumentOf,
} from "./units.ts";
import type { JSONSchema } from "../builder/types.ts";
import type { Cell, MemorySpace } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { isCellLink, parseLink } from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  type CompiledPiece,
  type CompiledPieceOptions,
  startCompiledPiece,
} from "./piece.ts";
import { inSpaceOfPiece, linkOfDocument, namesScope } from "./scopes.ts";

/**
 * A schema that declares no structure, under which a sync follows every
 * link of a document, so that it brings what the document reaches.
 */
const EVERYTHING = {} as JSONSchema;

/**
 * A schema under which a sync brings a document and follows no link of it.
 */
const NOTHING_BELOW = false as JSONSchema;

/** The entity that holds a document the executor names by `id`. */
const entityOf = (id: string): URI =>
  (id.startsWith("of:") ? id : `of:${id}`) as URI;

/** What the replica of `runtime` holds at the root of an entity. */
const heldAt = (
  runtime: Runtime,
  space: MemorySpace,
  id: URI,
  scope: NormalizedFullLink["scope"] = "space",
): unknown => {
  const tx = runtime.edit();
  try {
    return tx.readValueOrThrow({ space, id, path: [], scope });
  } finally {
    tx.abort();
  }
};

/**
 * Brings the basis of the piece whose result document is `id` into the
 * replica of `runtime`, and each source the basis names, without what
 * those link to. Returns the basis, where the storage holds one.
 */
const syncBasis = async (
  runtime: Runtime,
  space: MemorySpace,
  id: string,
  /**
   * Whether the documents the piece made are brought too, each with what
   * it links to: a resume that starts the executor reads them.
   */
  made = false,
): Promise<StoredBasis | undefined> => {
  const at = (document: string) =>
    runtime.getCellFromLink(linkOfDocument(space, document), NOTHING_BELOW);
  const document = basisDocumentOf(id);
  await at(document).sync();
  const root = heldAt(runtime, space, entityOf(document));
  const parts = basisPartsOf(root);
  await Promise.all(
    parts.map((part) => at(basisPartDocumentOf(id, part)).sync()),
  );
  const basis = storedBasisOf(
    root,
    (part) => heldAt(runtime, space, entityOf(basisPartDocumentOf(id, part))),
  );
  if (basis === undefined) return undefined;
  await Promise.all(
    [...new Set([...Object.keys(basis.inputs), ...basis.recent])].map((
      source,
    ) => at(source).sync()),
  );
  if (made) {
    await Promise.all(
      Object.keys(basis.documents ?? {}).map((one) => at(one).sync()),
    );
    // The lists of what the body of each element read, which the piece
    // compares with what the bodies read now.
    const units = unitsDocumentOf(id);
    await at(units).sync();
    await Promise.all(
      readersPartsOf(heldAt(runtime, space, entityOf(units))).map((part) =>
        at(readersPartDocumentOf(id, part)).sync()
      ),
    );
  }
  return basis;
};

/**
 * Brings into the replica of `runtime` the documents `roots` name and every
 * document of the space that a link leads to from one of them, at any
 * depth, each once and each by a sync of the one document. The replica is
 * then subscribed to each document, and the session holds no query that
 * follows links: the memory server evaluates such a query again, over what
 * it reaches, when a document it visited changes, which for the result of
 * a board is work that follows the board for each commit of the piece.
 */
const bringReached = async (
  runtime: Runtime,
  space: MemorySpace,
  roots: readonly string[],
): Promise<void> => {
  // A document is brought in the scope its name or the link to it says:
  // the instance of the identity of the runtime.
  const textOf = ({ id, scope }: NormalizedFullLink) => `${scope}\n${id}`;
  let level = roots.map((root) => linkOfDocument(space, root));
  const seen = new Set<string>(level.map(textOf));
  const linksOf = (
    value: unknown,
    base: NormalizedFullLink,
    found: NormalizedFullLink[],
  ) => {
    if (typeof value !== "object" || value === null) return;
    if (isCellLink(value)) {
      const link = parseLink(value, base);
      if (link.space === space && link.id !== undefined) {
        found.push({
          space,
          id: link.id as URI,
          path: [],
          scope: link.scope ?? base.scope,
        });
      }
      return;
    }
    for (const member of Object.values(value)) linksOf(member, base, found);
  };
  while (level.length > 0) {
    await Promise.all(
      level.map((link) => runtime.getCellFromLink(link, NOTHING_BELOW).sync()),
    );
    const found: NormalizedFullLink[] = [];
    for (const link of level) {
      linksOf(heldAt(runtime, space, link.id, link.scope), link, found);
    }
    level = [];
    for (const link of found) {
      if (seen.has(textOf(link))) continue;
      seen.add(textOf(link));
      level.push(link);
    }
  }
};

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
  /**
   * Whether what the result document links to is brought. A load of a
   * piece whose result document is empty brings the document alone: a
   * sync that follows links stays a query of the session, which the memory
   * server evaluates again, over every link of the document, each time the
   * piece appends a row to it.
   */
  rows = true,
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
      runtime.getCellFromLink(
        linkOfDocument(space, document),
        document === id && !rows ? NOTHING_BELOW : EVERYTHING,
      ).sync()
    ),
  );
};

/**
 * Starts the piece whose result `resultCell` names from what the storage
 * holds of it, and commits what its first derivation writes. `artifact` is
 * the compiled pattern the piece was started with.
 *
 * A document of the executor's own that the stored result links to by no
 * link a sync follows is brought by name: the state cells of the pattern's
 * own body, and what the basis of the piece lists, its sources and the
 * documents the piece made. A place that the derivation finds no document
 * of and that none of those names, as the state cell of an element body of
 * a piece that stored no basis, is found when the derivation reaches it:
 * the derivation is then made in a transaction that is aborted, the place
 * is brought, and the derivation is made again.
 */
export const resumeCompiledPiece = async (
  runtime: Runtime,
  artifact: Artifact,
  resultCell: Cell<unknown>,
  options: Omit<CompiledPieceOptions, "resume" | "loadRows"> & {
    /**
     * Called with each transaction the resume opens, before anything
     * reads or writes through it: a serving runtime stamps the context of
     * the run here, without which its wave takes no transaction.
     */
    opened?: (tx: IExtendedStorageTransaction) => void;
    /**
     * Whether the resume returns when its transaction was handed to the
     * commit, without waiting for the outcome: a transaction of a serving
     * runtime is settled by the wave it joins, which commits after the
     * cycle that the resume runs in. A commit that fails then stops the
     * piece and is given to `failed`.
     */
    sealed?: { failed: (piece: CompiledPiece, error: Error) => void };
  } = {},
): Promise<CompiledPiece> => {
  const { opened, sealed, ...pieceOptions } = options;
  const brought = new Set<string>();
  const { space, id } = resultCell.getAsNormalizedFullLink();
  // The inputs by a query that follows links, as at the load, so that the
  // piece hears of a member another writer adds and gets its document. The
  // documents of the piece, which the result links to, each by itself.
  await syncCompiledPiece(runtime, artifact, resultCell, [], false);
  await bringReached(runtime, space, [id]);
  // The resumed piece compares the number of each document its basis names
  // with what the replica holds, so the replica has to hold each.
  const basis = await syncBasis(runtime, space, id, true);
  for (
    const known of [
      ...Object.keys(basis?.inputs ?? {}),
      ...basis?.recent ?? [],
      ...Object.keys(basis?.documents ?? {}),
    ]
  ) brought.add(known);
  while (true) {
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
        { ...pieceOptions, resume: true },
      );
    } catch (error) {
      tx.abort(error);
      throw error;
    }
    // A place the executor found no document of, and a document of the
    // space of the piece that a link led to and the replica held none of,
    // as the cell a `wish` keeps for the principal.
    const missing = [
      ...piece.transactions.absent,
      ...[...piece.transactions.wanted].filter(inSpaceOfPiece),
    ].filter((id) => !brought.has(id));
    if (missing.length === 0) {
      runtime.prepareTxForCommit(tx);
      const { settled } = tx.commit();
      if (sealed !== undefined) {
        const resumed = piece;
        settled.then(({ error }) => {
          if (error === undefined) return;
          resumed.stop();
          sealed.failed(resumed, error);
        });
        return piece;
      }
      const { error } = await settled;
      if (error !== undefined) {
        piece.stop();
        throw error;
      }
      return piece;
    }
    piece.stop();
    tx.abort(
      new Error("A document of the piece may not have been in the replica."),
    );
    for (const id of missing) brought.add(id);
    await bringReached(runtime, space, missing);
  }
};

/** What `resumeCompiledPieceFromBasis()` takes. */
export type ResumeFromBasisOptions = Parameters<typeof resumeCompiledPiece>[3];

/**
 * A piece that was resumed from its basis. Where the basis matched the
 * storage, nothing of the piece runs until it is woken.
 */
export class ResumedPiece {
  /** Whether the basis matched the storage when the piece was resumed. */
  readonly current: boolean;
  /**
   * How many documents the comparison brought into the replica: the
   * document of the basis, those of its parts, and the sources.
   */
  readonly checked: number;
  /** How many sources the basis names. */
  readonly sources: number;
  /**
   * Resolves with the running piece once it was woken, by `wake()` or by a
   * change of a document its basis names, and rejects where the wake fails.
   */
  readonly woken: Promise<CompiledPiece>;
  readonly #wake: () => Promise<CompiledPiece>;
  readonly #stop: () => void;
  #piece: CompiledPiece | undefined;
  #waking: Promise<CompiledPiece> | undefined;
  #stopped = false;

  /** Use `resumeCompiledPieceFromBasis()`. */
  constructor(
    current: boolean,
    checked: number,
    sources: number,
    wake: () => Promise<CompiledPiece>,
    watch: (changed: () => void) => () => void,
  ) {
    this.current = current;
    this.checked = checked;
    this.sources = sources;
    this.#wake = wake;
    const { promise, resolve, reject } = Promise.withResolvers<CompiledPiece>();
    this.woken = promise;
    // A caller that wakes the piece itself hears of a failure from `wake()`.
    promise.catch(() => {});
    this.#woke = { resolve, reject };
    this.#stop = watch(() => {
      this.wake().catch(() => {});
    });
  }

  readonly #woke: {
    resolve: (piece: CompiledPiece) => void;
    reject: (error: unknown) => void;
  };

  /** The running piece, once the piece was woken. */
  get piece(): CompiledPiece | undefined {
    return this.#piece;
  }

  /**
   * Starts the executor of the piece from what the storage holds, where it
   * does not run, and resolves with the running piece.
   */
  wake(): Promise<CompiledPiece> {
    if (this.#stopped) {
      return Promise.reject(new Error("The resumed piece was stopped."));
    }
    this.#waking ??= this.#wake().then((piece) => {
      this.#stop();
      if (this.#stopped) piece.stop();
      else this.#piece = piece;
      this.#woke.resolve(piece);
      return piece;
    }, (error) => {
      this.#woke.reject(error);
      throw error;
    });
    return this.#waking;
  }

  /** Stops the piece, running or not. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stop();
    this.#piece?.stop();
  }
}

/**
 * Resumes the piece whose result `resultCell` names from its basis:
 * brings the document of the basis and the documents it names into the
 * replica, without what they link to, and compares the sequence number of
 * each with the one the basis records. `artifact` is the compiled pattern
 * of the piece.
 *
 * Where they match, the stored result is current, and the returned piece
 * runs nothing until it is woken: by `ResumedPiece.wake()`, which a caller
 * calls before it hands the piece an event, or by a commit that changes a
 * document the basis names. Where they do not match, or the storage holds
 * no basis of this compiled pattern, the piece is woken at once.
 *
 * What the comparison reads is one document for each source of the piece,
 * outside any transaction, and it writes nothing.
 */
export const resumeCompiledPieceFromBasis = async (
  runtime: Runtime,
  artifact: Artifact,
  resultCell: Cell<unknown>,
  options: ResumeFromBasisOptions = {},
): Promise<ResumedPiece> => {
  const { space, id } = resultCell.getAsNormalizedFullLink();
  // The watch begins before the comparison, so that no change falls
  // between the two.
  const entities = new Set<string>();
  // The sources a commit changed since the watch began, by entity.
  const changedSince = new Set<string>();
  let changed: (() => void) | undefined;
  let missed = false;
  const subscription = {
    next(
      notification: Parameters<
        Parameters<Runtime["storageManager"]["subscribe"]>[0]["next"]
      >[0],
    ) {
      if (notification.type === "reset" || notification.space !== space) {
        return undefined;
      }
      // The comparison's own sync delivers the documents it brings.
      if (notification.type === "load" || notification.type === "pull") {
        return undefined;
      }
      for (const { address } of notification.changes) {
        if (!entities.has(address.id)) continue;
        changedSince.add(address.id);
        if (changed === undefined) missed = true;
        else changed();
      }
      return undefined;
    },
  };
  runtime.storageManager.subscribe(subscription);
  const unsubscribe = () => runtime.storageManager.unsubscribe?.(subscription);
  let basis: StoredBasis | undefined;
  try {
    basis = await syncBasis(runtime, space, id);
  } catch (error) {
    unsubscribe();
    throw error;
  }
  const sources = basis === undefined
    ? []
    : [...new Set([...Object.keys(basis.inputs), ...basis.recent])];
  for (const source of sources) entities.add(entityOf(source));
  const { replica } = runtime.storageManager.open(space);
  const basisSeq = replica.confirmedDocumentSeq(entityOf(basisDocumentOf(id)));
  const seqOf = (source: string) =>
    replica.confirmedDocumentSeq(entityOf(source));
  const current = basis !== undefined && !missed &&
    basis.pattern === compiledIdentityOf(artifact) &&
    basisMatches(basis, basisSeq, seqOf);
  // A wake by units: the sources that differ from the basis, and those a
  // commit changed since the comparison, are the documents that changed.
  // It is taken where the storage holds a basis of this compiled pattern,
  // the replica reads from the store, and the plan has a collection whose
  // rows can be left as stored. A piece with rows in place alone
  // (`CompiledPieceOptions.rows`) finds no list of the readers and derives
  // whole.
  // A piece that has named a document of a scope derives for each
  // principal that demands it, and its basis names a source of a scope
  // (`CompiledPiece`): it resumes whole, with no row left as stored.
  const byUnits = basis !== undefined &&
    basis.pattern === compiledIdentityOf(artifact) &&
    !Object.keys(basis.inputs).some(namesScope) &&
    readsThroughStore(runtime, space) &&
    storedRowCollections(artifact, rowDocumentCollections(artifact)).size > 0;
  const staleNow = (stored: StoredBasis): string[] => [
    ...new Set([
      ...staleSourcesOf(stored, basisSeq, seqOf),
      ...sources.filter((source) => changedSince.has(entityOf(source))),
    ]),
  ];
  const resumed = new ResumedPiece(
    current,
    basis === undefined ? 1 : sources.length + 1 +
      new Set(Object.keys(basis.inputs).map(basisPartOf)).size,
    sources.length,
    () =>
      byUnits && basis !== undefined
        // A change of a source wakes the piece from inside the replica's
        // notification of the commit, which the replica is still applying:
        // the executor starts once that has returned.
        ? Promise.resolve().then(() =>
          resumeCompiledPieceByUnits(
            runtime,
            artifact,
            resultCell,
            options,
            staleNow(basis),
          )
        )
        : resumeCompiledPiece(runtime, artifact, resultCell, options),
    (heard) => {
      changed = heard;
      return unsubscribe;
    },
  );
  if (!current) await resumed.wake();
  return resumed;
};
