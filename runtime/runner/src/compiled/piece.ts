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
 *   gives it.
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
} from "../../../../base/pattern-compiler/exec/executor.ts";
import { Ref } from "../../../../base/pattern-compiler/exec/store.ts";
import type { Cancel } from "../cancel.ts";
import { type Cell, convertCellsToLinks } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { Action, EventHandler } from "../scheduler/types.ts";
import type { URI } from "../sigil-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  type ChangeByOther,
  RuntimeTransactions,
  type StreamOfExecutor,
} from "./transactions.ts";

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
};

/** A piece that runs from a compiled pattern. */
export class CompiledPiece {
  /** The executor's instance the piece was started with. */
  readonly instance: Instance;
  /** The store that keeps the executor's documents in the runtime. */
  readonly transactions: RuntimeTransactions;
  readonly #runtime: Runtime;
  readonly #cancels: Cancel[] = [];
  readonly #derive: Action;
  readonly #refusals: string[] = [];
  readonly #counts: CompiledPieceCounts = {
    events: 0,
    eventsRefused: 0,
    derivations: 0,
    changesByOthers: 0,
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
    const transactions = new RuntimeTransactions(runtime, space, {
      owner: result.id,
      artifact,
      countRecordBytes: options.countRecordBytes,
      stream: (entity, stream) => this.#registerStream(entity, stream),
      changes: (changes) => this.#changedByOthers(changes),
      applied: () => {
        if (this.#started && this.instance.relabelPending) this.#invalidate();
      },
      refused: (reason) => this.#refusals.push(reason),
    });
    this.transactions = transactions;
    this.#derive = (given) => {
      this.#counts.derivations += 1;
      transactions.within(given, () => {
        this.instance.settle();
        this.instance.relabel();
      });
    };
    this.instance = transactions.within(tx, () =>
      new Instance(
        artifact,
        transactions.decode(convertCellsToLinks(argument as never)),
        {
          space,
          id: result.id,
          secret: options.secret ?? space,
          artifacts: options.artifacts,
          now: options.now,
          measure: "patches",
          parts: false,
          events: "queue",
          transactions,
          load: (id) => transactions.load(id),
        },
      ));
    this.#started = true;
    this.#cancels.push(
      runtime.scheduler.subscribe(
        this.#derive,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      ),
    );
    this.#cancels.push(() => transactions.close());
  }

  /** What the piece did so far. */
  get counts(): Readonly<CompiledPieceCounts> {
    return { ...this.#counts };
  }

  /**
   * The reason of each commit of the piece that the storage refused. The
   * executor's documents are then ahead of what the storage holds.
   */
  get refusals(): readonly string[] {
    return this.#refusals;
  }

  /** Stops the piece: its handlers and its derivation no longer run. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const cancel of this.#cancels.splice(0)) cancel();
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
      const outcome = transactions.within(
        tx,
        () => this.instance.handleEvent(stream, transactions.decode(event)),
      );
      if (!outcome.committed) this.#counts.eventsRefused += 1;
      // An event a handler sends to a stream of the piece is an event of
      // the scheduler's queue like one sent from outside.
      for (const sent of this.instance.takeQueued()) {
        const target = transactions.entityOfStream(sent.stream);
        if (target === undefined) {
          throw new Error(
            "A handler sent an event to a stream the storage has no marker of.",
          );
        }
        this.#runtime.scheduler.queueEvent(
          { space, id: target, path: [], scope: "space" },
          transactions.encode(sent.event),
        );
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
 * whose entity becomes the result document. The creation of the instance
 * and its first derivation are written into `tx`, which the caller commits.
 * Throws where the experimental option `compiledPatterns` is off.
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
