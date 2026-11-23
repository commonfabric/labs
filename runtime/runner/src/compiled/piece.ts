/**
 * Runs a piece from a compiled pattern, the plan and the value code that
 * `base/pattern-compiler` emits, behind the experimental option
 * `compiledPatterns` (milestone 3 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * The executor of `base/pattern-compiler/exec/` evaluates the plan. Its
 * documents are entities of the space of the result cell, which
 * `RuntimeTransactions` writes through the runtime's transactions. The
 * runtime's scheduler runs the piece:
 *
 * - Each stream of the piece is an entity that holds the runtime's stream
 *   marker, with an event handler of the scheduler. `Cell.send` on the
 *   member of the result that links to it queues an event, and the handler
 *   runs the compiled handler in the transaction the scheduler gives it.
 * - The derivation is one action of the scheduler, an effect. The piece
 *   invalidates it when an event was handled, when another writer changed a
 *   document the executor holds, and when a stored label changed alone. The
 *   action brings the piece up to date in the transaction the scheduler
 *   gives it. Where a handler made instances, the action first derives
 *   those alone and runs again for the rest.
 *
 * So `Runtime.idle()` resolves for a compiled piece when no event of it is
 * queued and its derivation is current, as for any piece.
 *
 * The executor keeps each document it reads in memory. A document it did
 * not make is read from the replica when a reference first leads to it, and
 * a commit of another writer replaces what it changed.
 *
 * Nothing imports this module but the caller that starts a compiled piece,
 * so a runtime that starts none loads no executor.
 */
import {
  type Artifact,
  Instance,
  type ModuleEvaluator,
} from "../../../../base/pattern-compiler/exec/executor.ts";
import {
  bucketDocumentCollections,
  rowDocumentCollections,
} from "../../../../base/pattern-compiler/exec/row-documents.ts";
import {
  argumentOf,
  Ref,
} from "../../../../base/pattern-compiler/exec/store.ts";
import { makeFrame, runInFrame } from "../builder/pattern.ts";
import type { Cancel } from "../cancel.ts";
import { type Cell, convertCellsToLinks } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { Action, EventHandler } from "../scheduler/types.ts";
import type { URI } from "../sigil-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { FabricValue } from "@commonfabric/data-model";
import {
  basisDocumentOf,
  basisPartDocumentOf,
  PieceBasis,
  storedBasisOf,
} from "./basis.ts";
import {
  type ChangeByOther,
  type Restored,
  RuntimeTransactions,
  type StreamOfExecutor,
} from "./transactions.ts";
import { compartmentEvaluator } from "./value-code.ts";

/** What `startCompiledPiece()` takes beside the compiled pattern. */
export type CompiledPieceOptions = {
  /**
   * The artifact of a pattern by the identity its plan begins with, for a
   * pattern that a function body of the piece instantiates.
   */
  artifacts?: (id: string) => Artifact | undefined;
  /**
   * The secret the keys of plain values are salted with
   * (`execution-and-storage.md` §5.3). The runtime keeps no secret of a
   * space, so the default is the identifier of the space.
   */
  secret?: string;
  /** What the clock of the piece holds when it starts. */
  now?: number;
  /** Whether the size of the write records is counted. */
  countRecordBytes?: boolean;
  /**
   * Where the rows of a `map` over an array the plan declares as references
   * are stored, where a row is a record or a view node. `documents`, the
   * default: each row in a document of its own, named by the array and the
   * key of the row, with a link at the row's position. `in-place`: in the
   * array. The rows of every other collection are stored in place. The
   * buckets of an index the result keeps are stored the same way: each in
   * a document of its own with a link at its member of the record of the
   * buckets, or in that record.
   */
  rows?: "documents" | "in-place";
  /**
   * The most row documents that one transaction of the load holds. The
   * load commits the documents the instance makes for itself, and then the
   * row documents in transactions of at most this many, before the caller
   * commits the transaction it handed, which holds the rest. `Infinity`
   * writes the whole load into the handed transaction. The default is 250.
   */
  loadRows?: number;
  /**
   * Whether the storage holds the piece from a run before, in this runtime
   * or another (`resumeCompiledPiece()`). The argument is then the one the
   * storage holds, a state cell keeps what its document holds, and the
   * first derivation writes the paths whose value differs from what is
   * stored, in the handed transaction.
   */
  resume?: boolean;
  /**
   * Whether the argument is the one the storage holds in the argument
   * document of the result cell, which a client wrote
   * (`setUpCompiledPiece`). The argument given to `startCompiledPiece()` is
   * then not read.
   */
  storedArgument?: boolean;
  /**
   * What makes the functions of the value code. The default is a
   * compartment of the piece's own (`compartmentEvaluator`). A caller that
   * starts many pieces can give them one evaluator. An evaluator that
   * confines nothing is for a measurement of what the compartment costs.
   */
  evaluate?: ModuleEvaluator;
  /**
   * What each `wish` of the piece resolves to, by its operands: a harness's
   * stand-in for the runtime's own resolution, which a compiled piece does
   * not call yet. Without it a `wish` holds an error.
   */
  wishes?: NonNullable<Instance["options"]["wishes"]>;
  /**
   * What the value code imports from `commonfabric` under each name here,
   * for a built-in the executor does not have: a harness's stand-in for
   * what the runtime answers, such as the acting principal.
   */
  builtins?: Record<string, unknown>;
};

/** What a compiled piece did, counted. */
export type CompiledPieceCounts = {
  /** Events the scheduler handed to a compiled handler. */
  events: number;
  /** Events whose handler did not commit. */
  eventsRefused: number;
  /** Runs of the derivation action. */
  derivations: number;
  /** Changes by other writers applied to the executor's documents. */
  changesByOthers: number;
  /**
   * The time the piece spent in its event handlers and in its derivation
   * action, in milliseconds: the executor's work and the adapter's, without
   * the commit that the scheduler makes afterwards.
   */
  ownMs: number;
};

/** A piece that runs from a compiled pattern. */
export class CompiledPiece {
  /** The executor's instance the piece was started with. */
  readonly instance: Instance;
  /** The store that keeps the executor's documents in the runtime. */
  readonly transactions: RuntimeTransactions;
  readonly #runtime: Runtime;
  /** The identifier of the result document. */
  readonly #result: string;
  /** The record of what the stored result was derived from. */
  readonly #basis: PieceBasis<IExtendedStorageTransaction>;
  readonly #cancels: Cancel[] = [];
  readonly #derive: Action;
  readonly #refusals: string[] = [];
  readonly #counts: CompiledPieceCounts = {
    events: 0,
    eventsRefused: 0,
    derivations: 0,
    changesByOthers: 0,
    ownMs: 0,
  };
  /** The counts of the instance that the storage holds. */
  #minted: { events: number; created: number; made: Record<string, string> } = {
    events: 0,
    created: 0,
    made: {},
  };
  /** The instance exists: a change by another writer can be applied. */
  #started = false;
  #stopped = false;

  /** Use `startCompiledPiece()`. */
  constructor(
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    artifact: Artifact,
    argument: unknown,
    resultCell: Cell<unknown>,
    options: CompiledPieceOptions,
  ) {
    this.#runtime = runtime;
    const result = resultCell.getAsNormalizedFullLink();
    if (result.path.length > 0) {
      throw new Error("The result cell of a compiled piece is a whole entity.");
    }
    const { space } = result;
    this.#result = result.id;
    const rowDocuments = options.rows === "in-place"
      ? undefined
      : rowDocumentCollections(artifact);
    const bucketDocuments = options.rows === "in-place"
      ? undefined
      : bucketDocumentCollections(artifact);
    const transactions = new RuntimeTransactions(runtime, space, {
      owner: result.id,
      artifact,
      resume: options.resume,
      countRecordBytes: options.countRecordBytes,
      ...(rowDocuments === undefined ? {} : { rowDocuments }),
      ...(bucketDocuments === undefined ? {} : { bucketDocuments }),
      stream: (entity, stream) => this.#registerStream(entity, stream),
      changes: (changes) => this.#changedByOthers(changes),
      labels: () => this.#invalidate(),
      applied: () => {
        if (this.#started && this.instance.relabelPending) this.#invalidate();
      },
      refused: (reason, restored) => this.#refused(reason, restored ?? []),
      sources: {
        read: (doc) => this.#basis.source(doc),
        changed: (doc, taken, by) => {
          if (taken) this.#basis.source(doc);
          this.#basis.changed(doc);
          // A commit of the piece that stores a label on a source writes
          // the source, though the executor wrote no value of it. Where
          // the basis was recorded before, the derivation records it again.
          if (by !== undefined && this.#basis.wrote(by, [doc], [])) {
            this.#invalidate();
          }
        },
        handed: (handed, written, sources) => {
          this.#basis.wrote(handed, written, sources);
        },
        refused: (handed) => this.#basis.refused(handed),
        made: (doc) => this.#basis.made(doc),
      },
    });
    this.transactions = transactions;
    const basisDocument = basisDocumentOf(result.id);
    this.#basis = new PieceBasis(
      artifact,
      {
        seqOf: (doc) => transactions.confirmedSeqOf(doc),
        write: (handed, part, path, value) =>
          transactions.writeOwn(
            handed,
            part === undefined
              ? basisDocument
              : basisPartDocumentOf(result.id, part),
            path,
            value as FabricValue,
          ),
        affirm: (handed, doc) => transactions.readWhole(handed, doc),
        confirmedAt: (handed) => handed.committedSeq?.(space),
        failed: (handed) => handed.status().status === "error",
        writtenIn: (handed) =>
          (handed.getWriteAttemptLog?.() ?? []).flatMap((attempt) =>
            attempt.space === space ? [transactions.documentOf(attempt.id)] : []
          ),
      },
      options.resume === true ? this.#storedBasis(basisDocument) : undefined,
    );
    this.#basis.source(argumentOf(result.id));
    this.#basis.source(transactions.mintedDocument);
    this.#derive = (given) => {
      this.#counts.derivations += 1;
      const began = performance.now();
      // The first derivation of the instances a handler made is a
      // transaction of its own, which the scheduler commits before the
      // derivation of what reads them runs: that one then finds the labels
      // of their results stored, and gives no record again for a row whose
      // value and whose labels stayed.
      let first = false;
      try {
        transactions.within(given, () => {
          first = this.instance.settleMade();
          if (first) return;
          this.instance.settle();
          this.instance.relabel();
        });
      } finally {
        this.#counts.ownMs += performance.now() - began;
      }
      this.#keepMinted(given);
      // The basis is of a derivation that brought everything up to date.
      if (first) this.#invalidate();
      else {
        this.#basis.record(
          given,
          (given.getWriteAttemptLog?.().length ?? 0) > 0,
        );
      }
    };
    const resumed = options.resume === true;
    const minted = resumed ? transactions.heldMinted() : undefined;
    if (minted !== undefined) this.#minted = minted;
    // An instance a handler made is started again from what the storage
    // holds of it: no body of the resumed piece makes it.
    const made = Object.entries(minted?.made ?? {}).map(([id, pattern]) => {
      const artifact = options.artifacts?.(pattern);
      if (artifact === undefined) {
        throw new Error(
          `The piece holds an instance of a pattern it has no artifact of: ${pattern}.`,
        );
      }
      return {
        id,
        artifact,
        argument: transactions.heldArgument(argumentOf(id)),
      };
    });
    this.instance = transactions.within(tx, () =>
      new Instance(
        artifact,
        resumed || options.storedArgument === true
          ? transactions.heldArgument(argumentOf(result.id))
          : transactions.decode(convertCellsToLinks(argument as never)),
        {
          resume: resumed,
          ...(minted === undefined ? {} : { minted }),
          ...(made.length === 0 ? {} : { made }),
          space,
          id: result.id,
          secret: options.secret ?? space,
          artifacts: options.artifacts,
          now: options.now,
          measure: "patches",
          parts: false,
          events: "queue",
          transactions,
          evaluate: options.evaluate ?? compartmentEvaluator(),
          ...(options.wishes === undefined ? {} : { wishes: options.wishes }),
          ...(options.builtins === undefined
            ? {}
            : { builtins: options.builtins }),
          ...(rowDocuments === undefined ? {} : { rowDocuments }),
          ...(bucketDocuments === undefined ? {} : { bucketDocuments }),
          load: (id) => transactions.load(id),
        },
      ), { loadRows: resumed ? Infinity : options.loadRows ?? 250 });
    transactions.resumed();
    // A place the resumed executor found no document of is a source: the
    // next resume then brings it before it starts the executor.
    for (const doc of transactions.absent) this.#basis.source(doc);
    this.#keepMinted(tx);
    this.#basis.record(tx, true);
    this.#started = true;
    this.#cancels.push(
      runtime.scheduler.subscribe(
        this.#derive,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      ),
    );
    // The scheduler delays an action whose runs take long on average, so
    // that a slow computation does not run for each of a burst of changes.
    // The derivation of a piece is one action for all of its cones, whose
    // average says nothing of the next run, and an event waits for it.
    runtime.scheduler.setNoDebounce(this.#derive, true);
    this.#cancels.push(() => transactions.close());
  }

  /** What the piece did so far. */
  get counts(): Readonly<CompiledPieceCounts> {
    return { ...this.#counts };
  }

  /**
   * The reason of each commit of the piece that the storage refused, and
   * of each write by another writer that the piece does not take.
   */
  get refusals(): readonly string[] {
    return this.#refusals;
  }

  /**
   * The basis the replica holds of the piece, for a resume, with the
   * sequence number of the document that holds it.
   */
  #storedBasis(
    document: string,
  ):
    | { stored: NonNullable<ReturnType<typeof storedBasisOf>>; seq: number }
    | undefined {
    const stored = storedBasisOf(
      this.transactions.heldOwn(document),
      (part) =>
        this.transactions.heldOwn(basisPartDocumentOf(this.#result, part)),
    );
    const seq = this.transactions.confirmedSeqOf(document);
    return stored === undefined || seq === undefined
      ? undefined
      : { stored, seq };
  }

  /** How many documents the basis of the piece names. */
  get sources(): number {
    return this.#basis.size;
  }

  /** Stops the piece: its handlers and its derivation no longer run. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const cancel of this.#cancels.splice(0)) cancel();
  }

  /**
   * Writes into `tx` what the instance counted, where a count went on
   * since the last write: the names of the runs of its handlers and of the
   * documents its bodies make are formed from the counts, and a resume
   * goes on from what is stored.
   */
  #keepMinted(tx: IExtendedStorageTransaction): void {
    const { events, created } = this.instance.minted;
    const made = Object.fromEntries(
      this.instance.madeByHandlers().map(({ id, pattern }) => [id, pattern]),
    );
    const held = this.#minted.made;
    if (
      events === this.#minted.events && created === this.#minted.created &&
      Object.keys(made).length === Object.keys(held).length &&
      Object.keys(made).every((id) => held[id] === made[id])
    ) return;
    this.#minted = { events, created, made };
    this.transactions.writeMinted(tx, this.#minted);
    this.#basis.wrote(tx, [this.transactions.mintedDocument], []);
  }

  /** Has the scheduler run the derivation action. */
  #invalidate(): void {
    if (this.#started && !this.#stopped) {
      this.#runtime.scheduler.invalidateAction(this.#derive);
    }
  }

  /**
   * Registers the handler of the scheduler for a stream of the executor,
   * whose marker `entity` holds.
   */
  #registerStream(entity: URI, stream: StreamOfExecutor): void {
    const { transactions } = this;
    const { space } = transactions;
    const handler: EventHandler = (tx, event) => {
      this.#counts.events += 1;
      const began = performance.now();
      let outcome: ReturnType<Instance["handleEvent"]>;
      // The events the handler sent to streams of the piece, each with the
      // entity of the marker of its stream.
      const queued: { entity: URI; event: unknown }[] = [];
      try {
        // The frame of a handler, under which the gated `Date` and `Math`
        // of the value code give the time of the event and a random draw.
        outcome = runInFrame(
          makeFrame({
            inHandler: true,
            eventTime: tx.dispatchedEventTime ?? Date.now(),
          }),
          () =>
            transactions.within(tx, () => {
              const handled = this.instance.handleEvent(
                stream,
                transactions.decode(event),
              );
              // A stream that no stored value links has no marker yet: the
              // transaction of the handler that first sends to it writes
              // the marker.
              for (const sent of this.instance.takeQueued()) {
                queued.push({
                  entity: transactions.markedStream(sent.stream),
                  event: sent.event,
                });
              }
              return handled;
            }),
        );
      } finally {
        this.#counts.ownMs += performance.now() - began;
      }
      if (!outcome.committed) this.#counts.eventsRefused += 1;
      this.#keepMinted(tx);
      // An event a handler sends to a stream of the piece is sent through
      // the cell of the stream in the handler's transaction, as a handler
      // of today's runtime sends one (`Cell.send`). On a serving runtime
      // that appends the event to the entries of the stream in this
      // transaction, so it is stored with what the handler wrote and
      // withdrawn with it, and a serving loop that takes the space over
      // before the event was handled finds it. On every other runtime it
      // is an event of the scheduler's queue. The marker of the stream is
      // in the storage or written by this transaction (`markedStream`
      // above), so the cell of the stream reads it.
      for (const { entity, event: sent } of queued) {
        this.#runtime.getCellFromLink(
          { space, id: entity, path: [], scope: "space" },
          undefined,
          tx,
        ).send(transactions.encode(sent) as never);
      }
      this.#invalidate();
    };
    this.#cancels.push(
      this.#runtime.scheduler.addEventHandler(handler, {
        space,
        id: entity,
        path: [],
        scope: "space",
      }),
    );
  }

  /**
   * Keeps the reason of a commit of the piece that was refused, and brings
   * the executor's documents back to what the storage holds for those the
   * transaction wrote (`Instance.restore`): the executor had gone on when
   * the refusal became known. What read those documents is marked, and the
   * derivation runs again. A handler that the scheduler runs again starts
   * from what the storage holds.
   */
  #refused(reason: string, restored: Restored[]): void {
    this.#refusals.push(reason);
    if (!this.#started || this.#stopped) return;
    for (const { doc, value } of restored) this.instance.restore(doc, value);
    this.#invalidate();
  }

  /**
   * Applies the changes another writer committed to the documents the
   * executor holds, which marks what read them, and has the derivation run.
   */
  #changedByOthers(changes: ChangeByOther[]): void {
    if (!this.#started || this.#stopped) return;
    for (const { doc, path, value, splice } of changes) {
      this.#counts.changesByOthers += 1;
      const ref = new Ref(doc, path);
      if (splice === undefined) this.instance.store.write(ref, value);
      else {
        this.instance.store.splice(
          ref,
          splice.start,
          splice.removed,
          splice.members,
        );
      }
    }
    this.#invalidate();
  }
}

/**
 * Starts a piece from a compiled pattern, as `Runtime.run` starts one from a
 * pattern: `argument` holds values and cells, and `resultCell` is the cell
 * whose entity becomes the result document. The caller commits `tx`. The
 * creation of the instance and the row documents of its first derivation
 * are committed here, in bounded transactions
 * (`CompiledPieceOptions.loadRows`), and the rest of the first derivation is
 * written into `tx`. Throws where the experimental option `compiledPatterns`
 * is off.
 */
export const startCompiledPiece = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  artifact: Artifact,
  argument: unknown,
  resultCell: Cell<unknown>,
  options: CompiledPieceOptions = {},
): CompiledPiece => {
  if (runtime.experimental.compiledPatterns !== true) {
    throw new Error(
      "A compiled piece needs the experimental option `compiledPatterns`.",
    );
  }
  return new CompiledPiece(
    runtime,
    tx,
    artifact,
    argument,
    resultCell,
    options,
  );
};
