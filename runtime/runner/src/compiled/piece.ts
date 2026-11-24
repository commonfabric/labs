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
import { scopedDocument } from "../../../../base/pattern-compiler/exec/scope-instances.ts";
import {
  argumentOf,
  identifierOf,
  Ref,
} from "../../../../base/pattern-compiler/exec/store.ts";
import { makeFrame, runInFrame } from "../builder/pattern.ts";
import type { Cancel } from "../cancel.ts";
import { type Cell, convertCellsToLinks, type MemorySpace } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import { scopeRank } from "../scope.ts";
import { stampWaveRunContext, waveRunContextOf } from "../executor/wave.ts";
import { deriveEventKey } from "../scheduler/event-identity.ts";
import type { Action, EventHandler } from "../scheduler/types.ts";
import type { URI } from "../sigil-types.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { runtimeWritePolicyAuthorization } from "../cfc/types.ts";
import type { FabricValue } from "@commonfabric/data-model";
import type { DID } from "@commonfabric/identity";
import {
  basisDocumentOf,
  basisMadePartDocumentOf,
  basisPartDocumentOf,
  compiledIdentityOf,
  PieceBasis,
  storedBasisOf,
} from "./basis.ts";
import { PieceUnits } from "./units.ts";
import {
  type ChangeByOther,
  type Restored,
  RuntimeTransactions,
  type StreamOfExecutor,
} from "./transactions.ts";
import { RuntimeAnswers, runtimeBuiltins } from "./builtins.ts";
import { OutsideReads, outsideReadsDocumentOf } from "./outside-reads.ts";
import { argumentWithDefaults } from "./declared-policy.ts";
import { compartmentEvaluator } from "./value-code.ts";
import { answersEffect, RuntimeWishes } from "./wish.ts";

/**
 * The names under which the executor of a piece can have read the document
 * of `entity`: the entity for a document it did not make, and the entity
 * without `of:` for one an instance of the piece made.
 */
const unheldNames = (entity: string): string[] =>
  entity.startsWith("of:") ? [entity, entity.slice("of:".length)] : [entity];

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
   * Where the links to the row documents of an array, and the links to the
   * bucket documents of an index the result keeps, are stored. `documents`,
   * the default: in documents of their own, a long array in chunks, with a
   * link in the result document at the path of the array or of the record
   * (`RuntimeTransactions` option `listDocuments`). `in-place`: in the
   * result document. With `rows` at `in-place` there are no such links.
   */
  lists?: "documents" | "in-place";
  /**
   * The most rows of an array whose links one list document holds, where
   * `lists` is `documents`: a reader through the runtime reads such an
   * array as the array of its rows, and a longer one as an array of chunks
   * (`RuntimeTransactions` option `listWhole`, which has the default).
   */
  listWhole?: number;
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
   * With `resume`, on a runtime whose replica reads from the store: the
   * sources of the piece that changed since the stored result was derived.
   * The executor then leaves the rows it can as the storage holds them,
   * and evaluates the body of an element when a document it read changes
   * (`resumeCompiledPieceByUnits()`). Without it a resumed piece evaluates
   * its whole derivation.
   */
  stale?: readonly string[];
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
   * table in the place of the runtime's own `wish`, which answers without
   * this option (`RuntimeWishes`).
   */
  wishes?: NonNullable<Instance["options"]["wishes"]>;
  /**
   * The principal the runs of the piece act for where the runtime is in
   * the serving posture and no serving loop stamped the transaction of the
   * run: a harness's stand-in for the identity a serving loop takes from
   * the demand or from the event. A run a serving loop stamped keeps its
   * stamp.
   */
  actsFor?: DID;
  /**
   * Whether the artifact, and each artifact `artifacts` gives, is one the
   * runtime's own compiler gave for a source (`runCompiledPatterns` and
   * `serveCompiledPieces` set this), or one the caller vouches for: the
   * caller is host code and says that `Body.code` of each handler names
   * the module and the binding the handler is declared at. A harness that
   * hands an artifact the crate emitted for a fixture sets it. Without it
   * a handler of the piece has no identity a writer claim is checked by,
   * so its write of a position that names a writer is refused: nothing
   * checks `Body.code` of a handed artifact against a source.
   */
  attested?: boolean;
  /**
   * What the value code imports from `commonfabric` under each name here,
   * for a built-in the executor does not have, in the place of what the
   * runtime answers under that name (`runtimeBuiltins`): a harness's
   * stand-in, such as a constant for the acting principal.
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
  /** The space of the result document. */
  readonly #space: MemorySpace;
  /**
   * The principal the runs of the piece act for where nothing stamped
   * their transaction (`CompiledPieceOptions.actsFor`).
   */
  readonly #actsFor: DID | undefined;
  /** The identifier of the result document. */
  readonly #result: string;
  /** The record of what the stored result was derived from. */
  readonly #basis: PieceBasis<IExtendedStorageTransaction>;
  /** The lists of what the body of each element read. */
  readonly #units: PieceUnits<IExtendedStorageTransaction>;
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
  /**
   * Whether the piece was started to leave rows as stored
   * (`CompiledPieceOptions.stale`).
   */
  readonly #byUnits: boolean;
  /** The instance exists: a change by another writer can be applied. */
  #started = false;
  /**
   * How many events the piece handled and changes of other writers it
   * took: what a derivation could find different from the one before.
   */
  #changes = 0;
  /** The documents asked for that the replica has since taken a write of. */
  readonly #arrived = new Set<string>();
  /** The documents the piece asked the storage for (`#bring`). */
  readonly #asked = new Set<string>();
  /** Whether the derivation names its piece to the scheduler. */
  #named = false;
  /**
   * Whether a run made the first derivation of the instances a handler made
   * and its transaction has not ended. A serving loop runs the derivation
   * for each principal and session that demands the piece in one pass, and
   * a run of that pass reads its replica before the commit of the run
   * before it: a run that read the result of such an instance as the
   * handler stored it would be refused. The runs wait for that commit, and
   * its end asks for the derivation again.
   */
  #madePending = false;
  /** What stops the derivation action. */
  #unsubscribe: Cancel | undefined;
  /**
   * Whether the basis is recorded by a run that made a document alone,
   * because the piece has documents of a scope narrower than the space.
   */
  #basisOfEveryKey = false;
  /** Whether the piece made a document since the basis was recorded. */
  #madeSinceBasis = false;
  /** The reason of the last commit refused, and `#changes` then. */
  #refusedLast: { reason: string; changes: number } | undefined;
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
    this.#byUnits = options.resume === true && options.stale !== undefined;
    const result = resultCell.getAsNormalizedFullLink();
    if (result.path.length > 0) {
      throw new Error("The result cell of a compiled piece is a whole entity.");
    }
    const { space } = result;
    this.#space = space;
    this.#actsFor = options.actsFor;
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
      attested: options.attested,
      countRecordBytes: options.countRecordBytes,
      ...(rowDocuments === undefined ? {} : { rowDocuments }),
      ...(bucketDocuments === undefined ? {} : { bucketDocuments }),
      listDocuments: options.rows !== "in-place" &&
        options.lists !== "in-place",
      ...(options.listWhole === undefined
        ? {}
        : { listWhole: options.listWhole }),
      stream: (entity, stream) => this.#registerStream(entity, stream),
      changes: (changes) => this.#changedByOthers(changes),
      arrived: (doc) => {
        this.#arrived.add(doc);
        this.#invalidate();
      },
      labels: () => this.#invalidate(),
      unheld: {
        reads: (entity) =>
          unheldNames(entity).some((doc) => this.#basis.has(doc)),
        changed: (entities) => this.#changedUnheld(entities),
      },
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
        refused: (handed) => {
          this.#basis.refused(handed);
          this.#units.refused(handed);
        },
        made: (doc) => {
          this.#madeSinceBasis = true;
          this.#basis.made(doc);
        },
      },
    });
    this.transactions = transactions;
    // A piece brought into being outside any scheduled action is the act
    // of the principal its transaction acts for, as on today's path
    // (`Runner.#setupInternal`): what the start initializes in the piece's
    // own documents is attributed to them, so a first value whose type adds
    // integrity of the current principal names them, and is refused where
    // the transaction acts for no one. A piece that is resumed is not
    // brought into being, and one started from a stored argument is started
    // by a serving runtime for the client that set it up, whom the
    // transaction of the start does not name: its first values are
    // initialized on nobody's behalf.
    if (
      options.resume !== true && options.storedArgument !== true &&
      tx.tx.sourceAction === undefined
    ) {
      // Where a harness names the principal the piece acts for, the start
      // acts for them as a handler's run does.
      this.#stamp(tx, "start");
      tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization, {
        space,
        id: result.id,
        scope: result.scope,
      });
      transactions.attributeFirstValuesIn(tx);
    }
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
        writeMade: (handed, part, path, value) =>
          transactions.writeOwn(
            handed,
            basisMadePartDocumentOf(result.id, part),
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
    this.#units = new PieceUnits(
      result.id,
      compiledIdentityOf(artifact),
      {
        held: (doc) => transactions.heldOwn(doc),
        write: (handed, doc, path, value) =>
          transactions.writeOwn(handed, doc, path, value as FabricValue),
        result: (rows, arrays) => transactions.heldResult(rows, arrays),
        rowsHeld: (path, keys) => transactions.rowsHeld(path, keys),
        streamsHeld: (bindings, keys) => {
          for (const key of keys) {
            for (const binding of bindings) {
              transactions.heldStream({ binding, keys: [key] });
            }
          }
        },
      },
      options.resume === true ? options.stale : undefined,
    );
    this.#derive = (given) => {
      this.#counts.derivations += 1;
      const began = performance.now();
      this.#stamp(given, "derivation");
      // What the piece holds of documents of a scope, it holds in memory,
      // and a run in which every entry is current reads none of them
      // through its transaction. The run still gives the value of the
      // principal and the session it is for, which the scheduler learns
      // from the scope the transaction read: without it a principal that
      // comes to demand the piece later is given no run.
      const narrowest = transactions.narrowestScope;
      if (scopeRank(given.getNarrowestReadScope()) < scopeRank(narrowest)) {
        given.resetNarrowestReadScope(narrowest);
      }
      // A run of the same pass behind the first derivation of the instances
      // a handler made derives nothing until that commit has ended.
      if (this.#madePending) return;
      for (const doc of this.#arrived) this.#take(doc);
      this.#arrived.clear();
      // The first derivation of the instances a handler made is a
      // transaction of its own, which the scheduler commits before the
      // derivation of what reads them runs: that one then finds the labels
      // of their results stored, and gives no record again for a row whose
      // value and whose labels stayed.
      let first = false;
      try {
        this.#deriving(given, () =>
          transactions.within(given, () => {
            first = this.instance.settleMade();
            if (first) return;
            this.instance.settle();
            this.instance.relabel();
          }));
      } finally {
        this.#counts.ownMs += performance.now() - began;
      }
      this.#keepMinted(given);
      this.#bring();
      // A piece that has documents of a scope is never resumed without its
      // executor, which registers every action again.
      if (!first && !transactions.scoped) outside.flush(given);
      // The piece names itself to the scheduler from the run on in which it
      // first named a document of a scope, and derives the rest behind the
      // first derivation of the instances a handler made. Both when the
      // transaction of this run has ended: a serving loop runs an action
      // that was invalidated during its run again at once, where the
      // replica does not hold what this run wrote yet.
      const names = transactions.scoped && !this.#named;
      if (names || (first && this.#named)) {
        if (first) this.#madePending = true;
        given.addCommitCallback(() => {
          this.#madePending = false;
          if (this.#stopped) return;
          if (transactions.scoped && !this.#named) this.#subscribe();
          this.#invalidate();
        });
      } else if (first) this.#invalidate();
      // The basis is of a derivation that brought everything up to date.
      if (first) return;
      // What the bodies of the elements read, where that differs from the
      // lists the storage holds. A piece that has documents of a scope
      // resumes whole (`resumeCompiledPieceFromBasis`) and reads no list,
      // and the runs of one pass for several principals would each write
      // what the bodies read for their principal.
      if (!transactions.scoped) this.#units.record(given);
      // A piece that has documents of a scope is derived once for each
      // principal that demands it, and no run brings it up to date for
      // all of them. Its basis names a document of a scope as a source,
      // which has no number, so a resume from it starts the executor. The
      // basis is still what lists the documents the piece made, which a
      // resume brings: it is recorded by the run that made one, and not
      // by every run, since the runs of one pass for several principals
      // would each write it.
      if (!this.#basisOfEveryKey || this.#madeSinceBasis) {
        this.#madeSinceBasis = false;
        this.#sourceOfNoNumber();
        this.#basis.record(
          given,
          (given.getWriteAttemptLog?.().length ?? 0) > 0,
        );
        if (this.transactions.scoped) this.#basisOfEveryKey = true;
      }
    };
    // What the wishes and the built-ins read outside the executor, for a
    // resume from a basis that matches (`outside-reads.ts`).
    const outsideDocument = outsideReadsDocumentOf(result.id);
    const outside = new OutsideReads({
      stored: transactions.heldOwn(outsideDocument) !== undefined,
      write: (handed, path, value) =>
        transactions.writeOwn(
          handed,
          outsideDocument,
          path,
          value as FabricValue,
        ),
      changed: () => this.#invalidate(),
    });
    const readOutside = (position: string, by: IExtendedStorageTransaction) => {
      if (!transactions.scoped) outside.noted(position, by);
    };
    // The runtime's `wish` answers each `wish` operation the instance
    // evaluates, unless a harness gave a table, and its built-ins the
    // effects of the reactive tier that they implement.
    const wishes = new RuntimeWishes(runtime, {
      resultCell: resultCell.withTx(),
      entityOf: (doc) => transactions.entityOf(doc),
      linkOf: (doc) => transactions.linkOf(doc, []),
      read: (state, by) => readOutside(`wish ${state}`, by),
      ...(options.actsFor === undefined ? {} : { actsFor: options.actsFor }),
    });
    this.#cancels.push(() => wishes.stop());
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
    // The built-ins the runtime answers, and what a derivation used of
    // their answers.
    const builtinsContext = {
      runtime,
      space,
      linkOf: (doc: string, path: readonly string[]) =>
        transactions.linkOf(doc, path),
      documentOf: (link: NormalizedFullLink) => transactions.documentAt(link),
      invalidate: () => this.#invalidate(),
      stamp: (given: IExtendedStorageTransaction, what: string) =>
        this.#stamp(given, what),
      scopeKey: (scope: "user" | "session") => transactions.scopeKey(scope),
      read: readOutside,
      piece: {
        space,
        pieceId: `space:${result.id}`,
        pieceRootId: result.id,
      },
    };
    const answers = new RuntimeAnswers(builtinsContext);
    this.#cancels.push(() => answers.stop());
    const builtins = (of: Instance) => ({
      ...runtimeBuiltins(builtinsContext, answers, of),
      ...options.builtins,
    });
    this.instance = this.#deriving(
      tx,
      () =>
        transactions.within(tx, () =>
          new Instance(
            artifact,
            resumed || options.storedArgument === true
              ? transactions.heldArgument(argumentOf(result.id))
              : transactions.decode(convertCellsToLinks(argument as never)),
            {
              resume: resumed,
              units: this.#units,
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
              // An argument document holds the defaults of its type, as
              // today's setup writes them, where the type declares a write
              // policy (`argumentWithDefaults`).
              argumentStored: (given, of, instance) => {
                const { argument: stored, filled } = argumentWithDefaults(
                  of,
                  given,
                );
                if (filled.length > 0) {
                  transactions.filledDefaults(argumentOf(instance), filled);
                }
                return stored;
              },
              evaluate: options.evaluate ?? compartmentEvaluator(),
              wishes: options.wishes ?? ((_operands, of) => {
                if (of === undefined) return undefined;
                wishes.answer(of.state);
                // The action of the runtime's `wish` writes the outcome.
                return { outcome: {} };
              }),
              effects: (builtin, { state }) => {
                if (!answersEffect(builtin)) return false;
                wishes.answer(state, builtin as "fetchJson");
                return true;
              },
              builtins,
              ...(rowDocuments === undefined ? {} : { rowDocuments }),
              ...(bucketDocuments === undefined ? {} : { bucketDocuments }),
              load: (id) => transactions.load(id),
              // A document of the scope `user` or `session` stands for the
              // instance of the identity of the transaction of the run.
              scopes: { keyOf: (scope) => transactions.scopeKey(scope) },
            },
          ), { loadRows: resumed ? Infinity : options.loadRows ?? 250 }),
    );
    transactions.resumed();
    // A place the resumed executor found no document of is a source: the
    // next resume then brings it before it starts the executor.
    for (const doc of transactions.absent) this.#basis.source(doc);
    this.#keepMinted(tx);
    this.#sourceOfNoNumber();
    if (!transactions.scoped) this.#units.record(tx);
    this.#basis.record(tx, true);
    this.#started = true;
    this.#bring();
    this.#subscribe();
    this.#cancels.push(() => this.#unsubscribe?.());
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
      (part) =>
        this.transactions.heldOwn(
          basisMadePartDocumentOf(this.#result, part),
        ),
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

  /**
   * Asks the storage for each document the executor asked for and the
   * replica held none of (`RuntimeTransactions.wanted`), once: a read
   * through a transaction does not bring a document, and a document of
   * another space than the piece's is in no query the piece's load made.
   * When the storage answered with a document, the executor takes it, what
   * read the place is marked, and the derivation runs. The scheduler counts
   * the request as work under way, so the runtime is not idle before the
   * answer.
   */
  #bring(): void {
    for (const doc of this.transactions.wanted) {
      if (this.#asked.has(doc)) continue;
      this.#asked.add(doc);
      const answered = this.#runtime.getCellFromLink(
        this.transactions.linkOf(doc, []),
      ).sync().then(() => {
        if (!this.#stopped && this.#take(doc)) this.#invalidate();
      });
      this.#runtime.scheduler.trackBackgroundTask(answered);
    }
  }

  /**
   * Has the executor take a document it asked for and was given nothing
   * of, where the replica now holds one, and marks what read the place.
   * Returns whether it took one.
   */
  #take(doc: string): boolean {
    // A place the executor has made a document of since is its own.
    if (this.transactions.holds(doc)) return false;
    const loaded = this.transactions.load(doc);
    if (loaded === undefined) return false;
    this.instance.restore(doc, loaded.value);
    this.#changes += 1;
    return true;
  }

  /**
   * Runs `run`, which derives through `tx`, under a frame of the kind
   * `lift` that holds the runtime and the transaction: the frame the
   * runtime's built-ins read in a reactive computation.
   */
  #deriving<T>(tx: IExtendedStorageTransaction, run: () => T): T {
    return runInFrame(
      makeFrame({
        runtime: this.#runtime,
        tx,
        space: this.#space,
        frameKind: "lift",
      }),
      run,
    );
  }

  /**
   * Names the principal the run on `tx` acts for where the runtime is in
   * the serving posture and no serving loop stamped the transaction
   * (`CompiledPieceOptions.actsFor`): the runtime's built-ins and the
   * preparation of a commit read the principal of a run from its stamp.
   * `what` is `handler` for the run of a handler and `start` for the
   * transaction that brings the piece into being, which act as the
   * principal, and anything else for a derivation, whose reads of a scoped
   * document are those of the principal.
   */
  #stamp(tx: IExtendedStorageTransaction, what: string): void {
    const actsFor = this.#actsFor;
    if (
      actsFor === undefined || !this.#runtime.servingPosture ||
      waveRunContextOf(tx) !== undefined
    ) return;
    // The claims a handler's write makes about the current principal name
    // the principal of the transaction's trust snapshot, which the stamper
    // of a serving loop sets beside the actor.
    const acts = what === "handler" || what === "start";
    if (acts) {
      setCfcTrustSnapshot(tx, this.#runtime.trustSnapshotForPrincipal(actsFor));
    }
    stampWaveRunContext(
      tx,
      acts
        ? {
          actionId: `compiled-piece:${what}:${this.#result}`,
          kind: "event-handler",
          acting: { user: actsFor },
        }
        : {
          actionId: `compiled-piece:${what}:${this.#result}`,
          kind: "derivation",
          // The session of the runtime: a document of the scope `session`
          // has an instance for a session of the principal alone.
          scopeKeyIdentity: {
            principal: actsFor,
            sessionId: this.#runtime.scopeKeyIdentity.sessionId,
          },
        },
    );
  }

  /**
   * Has the basis of a piece that has named a document of a scope name a
   * source that has no sequence number, so that no resume finds the basis
   * current: the name of a document of a scope that nothing writes. A
   * document of a scope the piece wrote itself is compared as one it
   * wrote lately, which a resume in another runtime finds unchanged.
   */
  #sourceOfNoNumber(): void {
    if (!this.transactions.scoped) return;
    this.#basis.source(
      scopedDocument(
        identifierOf({ type: "scopes", parent: this.#result }),
        "user",
      ),
    );
  }

  /**
   * Registers the derivation with the scheduler, in the place of an
   * earlier registration. A piece that has named a document of a scope
   * names itself: a serving loop runs an action that names its piece once
   * for each principal that demands the piece, and each session of one,
   * from the run on in which it read a document of that scope. A piece
   * with no such document is derived once for every principal, by an
   * action that names no piece.
   */
  #subscribe(): void {
    this.#unsubscribe?.();
    this.#named = this.transactions.scoped;
    this.#unsubscribe = this.#runtime.scheduler.subscribe(
      this.#derive,
      { reads: [], shallowReads: [], writes: [] },
      {
        isEffect: true,
        ...(this.#named
          ? {
            observationIdentity: {
              space: this.#space,
              pieceId: `space:${this.#result}`,
              pieceRootId: this.#result,
            },
          }
          : {}),
      },
    );
    // The scheduler delays an action whose runs take long on average, so
    // that a slow computation does not run for each of a burst of changes.
    // The derivation of a piece is one action for all of its cones, whose
    // average says nothing of the next run, and an event waits for it.
    this.#runtime.scheduler.setNoDebounce(this.#derive, true);
  }

  /**
   * Has the scheduler run the derivation, as the piece does after each
   * event it handles: for a caller that hands the executor an event
   * itself (`RuntimeTransactions.within`).
   */
  derive(): void {
    this.#invalidate();
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
      this.#changes += 1;
      const began = performance.now();
      let outcome: ReturnType<Instance["handleEvent"]>;
      // The events the handler sent to streams of the piece, each with the
      // entity of the marker of its stream.
      const queued: { entity: URI; event: unknown }[] = [];
      this.#stamp(tx, "handler");
      // What the handler stages is recorded under its identity, which a
      // writer claim of a written position is checked against.
      const writer = transactions.handlerOf(stream);
      const before = tx.getCfcState().implementationIdentity;
      if (writer !== undefined) setCfcImplementationIdentity(tx, writer);
      // The principal invoked the handler, so what its run initializes is
      // theirs, as on today's path (`Runner`, where it runs a handler).
      tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
      try {
        // The frame of a handler, under which the gated `Date` and `Math`
        // of the value code give the time of the event and a random draw,
        // and the runtime's built-ins the transaction of the run and the
        // key of the event, which is derived as the runner derives it for
        // a handler of today's path.
        outcome = runInFrame(
          makeFrame({
            inHandler: true,
            frameKind: "handler",
            runtime: this.#runtime,
            tx,
            space,
            eventTime: tx.dispatchedEventTime ?? Date.now(),
            eventKey: deriveEventKey(
              tx.dispatchedEventId ?? crypto.randomUUID(),
              this.#runtime.actingPrincipalFor(tx),
              { space, id: entity, path: [], scope: "space" },
            ),
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
        if (writer !== undefined) setCfcImplementationIdentity(tx, before);
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
    this.instance.recordsRefused();
    for (const { doc, value, acting } of restored) {
      this.transactions.actingFor(
        acting,
        () => this.instance.restore(doc, value),
      );
    }
    // A derivation from the same documents writes the same and is refused
    // the same way. Where the storage refused a commit for the reason it
    // gave for the one before, and the piece handled no event and took no
    // change of another writer between the two, the derivation is not run
    // again until one of those happens.
    const last = this.#refusedLast;
    this.#refusedLast = { reason, changes: this.#changes };
    if (last?.reason === reason && last.changes === this.#changes) return;
    this.#invalidate();
  }

  /**
   * Another writer changed entities that the executor holds no document
   * of, while it holds rows as stored: the body of each row that the
   * storage lists as a reader of one of them is marked, and the derivation
   * runs where there is one.
   */
  #changedUnheld(entities: string[]): void {
    this.#afterNotification(() => {
      if (this.instance.changedUnread(entities.flatMap(unheldNames))) {
        this.#invalidate();
      }
    });
  }

  /**
   * Runs `apply`, which tells the executor of a change that a notification
   * of the replica named, where the piece runs: at once, or, for a piece
   * that holds rows as stored, once the replica has applied the commit the
   * notification is of. The executor of such a piece reads the list of the
   * readers of a changed document, and a read inside the notification of a
   * commit gives a document the replica does not hold as absent.
   */
  #afterNotification(apply: () => void): void {
    if (!this.#started || this.#stopped) return;
    if (!this.#byUnits) {
      apply();
      return;
    }
    queueMicrotask(() => {
      if (!this.#stopped) apply();
    });
  }

  /**
   * Applies the changes another writer committed to the documents the
   * executor holds, which marks what read them, and has the derivation run.
   */
  #changedByOthers(changes: ChangeByOther[]): void {
    if (!this.#started || this.#stopped) return;
    this.#changes += 1;
    this.#afterNotification(() => {
      for (const { doc, path, value, splice, scoped } of changes) {
        this.#counts.changesByOthers += 1;
        const ref = new Ref(doc, path);
        const apply = () => {
          if (splice === undefined) this.instance.store.write(ref, value);
          else {
            this.instance.store.splice(
              ref,
              splice.start,
              splice.removed,
              splice.members,
            );
          }
        };
        // A change of an instance of a scope is applied to that instance.
        if (scoped === undefined) apply();
        else this.transactions.actingAs(scoped, apply);
      }
      this.#invalidate();
    });
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
