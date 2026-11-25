/**
 * Keeps the documents of an executor in the runtime's storage, so that
 * what the runtime's transactions cost the compiled path can be measured
 * (milestone 1 of `docs/plans/compiled-pattern-language-integration.md`).
 *
 * Each transaction of the executor is a transaction of the runtime
 * (`Runtime.edit()`). Each position the executor reads is read through it,
 * which journals the read and marks the transaction as one that observed
 * labels where the document has some. Each change the executor makes is
 * written into it as the change is made, so that a later read in the same
 * transaction finds it. When the executor's transaction ends the runtime's
 * commits, and `ExtendedStorageTransaction.commit()` runs the preparation of
 * Contextual Flow Control that it runs for every commit; a transaction the
 * executor does not commit is aborted. The executor computes on the
 * documents it holds in memory, and the storage holds the same documents
 * (`RuntimeTransactions.stored()`).
 *
 * With the runtime's experimental option `compiledPatterns` on, the runtime
 * serving (`servingPosture`) and the artifact given, the adapter registers the compiled pattern with the
 * runtime (`CompiledPlanRegistry`) and records each write record the
 * executor gives with a change as an authorized `plan-write` write-policy
 * input, so that the paths the records cover store the labels their
 * templates instantiate to. It answers the executor's `labelOf` with the
 * identifier of the label a value read of the position consumes, interned
 * in the runtime's label table.
 *
 * A document of the executor is the entity `of:<identifier>` of the space,
 * and a link the executor stores is written as the runtime's link to that
 * entity (`createSigilLinkFromParsedLink()`). A path of a link that crosses
 * an array by key holds the key's text, which the runtime does not resolve:
 * nothing but the executor reads these documents.
 */
import {
  cloneIfNecessary,
  debugStr,
  FabricPrimitive,
  type FabricValue,
  isWalkableObjectNotArray,
} from "@commonfabric/data-model";

import type { StoredArray } from "../../../../base/pattern-compiler/exec/stored-units.ts";
import {
  createSigilLinkFromParsedLink,
  getMetaLink,
  parseLink,
} from "../link-utils.ts";
import { rawMetaWriteAuthorization } from "../meta-seam.ts";
import { isPrimitiveCellLink, type NormalizedFullLink } from "../link-types.ts";
import type { JSONSchema, JSONSchemaObj } from "../builder/types.ts";
import {
  type MemorySpace,
  recordRelevantSchemaWritePolicyInput,
} from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";
import type { CompiledPlan } from "../cfc/compiled-plans.ts";
import {
  appliesAtItsPathOnly,
  consumedEntriesForRead,
  isRuntimeMintedTemplate,
  joinLabels,
  labelForConsumedEntries,
} from "../cfc/consumed-label.ts";
import { ConsumedLabelIndex } from "../cfc/consumed-label-index.ts";
import { readStoredCfcMetadata } from "../cfc/metadata.ts";
import {
  type NestedPlanInputs,
  type NestedPlanWrite,
  nestedPlanWrite,
  PlanInputsInterner,
} from "../cfc/plan-inputs.ts";
import { mergedPlanWrites } from "../cfc/plan-write-targets.ts";
import { runtimeOwnedStoreOwnerKey } from "../cfc/runtime-owned-stores.ts";
import {
  type CfcAddress,
  type CfcMetadata,
  type IFCLabel,
  type ImplementationIdentity,
  type ObservedPosition as RuntimeObserved,
  type PlanElements,
  type PlanWrite as RuntimePlanWrite,
  runtimeWritePolicyAuthorization,
  type SlotBinding as RuntimeSlotBinding,
  type SlotBindings as RuntimeSlotBindings,
} from "../cfc/types.ts";
import { readMaybeLink } from "../link-resolution.ts";
import type { Runtime } from "../runtime.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import { markReadAsAttemptedWrite } from "../storage/reactivity-log.ts";
import { handlerIdentityOf } from "./handler-identity.ts";
import { appendedBehind, appendedBySplice } from "./appended.ts";
import { recordNewDocumentProtectedDefaults } from "../cfc/default-initialization.ts";
import { declaredBy, DeclaredPolicies } from "./declared-policy.ts";
import { isStateCellSeed, recordStateCellSeed } from "./initialization.ts";
import {
  declaresMemberPolicy,
  type ResultPolicy,
  writePoliciesOf,
} from "./result-policy.ts";
import type { URI } from "../sigil-types.ts";
import { documentIn, placeOfDocument } from "./names.ts";
import {
  ByDocumentInstance,
  cellScopeOf,
  DocumentInstances,
  instanceNameOf,
  scopeKeyOf,
} from "./scopes.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
  IStorageNotification,
  TransactionCommitReceipt,
} from "../storage/interface.ts";
import type {
  Artifact,
  DeclaredWrite,
  LabelChange,
  Transaction,
  TransactionHooks,
} from "../../../../base/pattern-compiler/exec/executor.ts";
import type {
  Address,
  FoldElements,
  InputsTable,
  Observed,
  PlanWrite,
  SlotBinding,
  SlotBindings,
} from "../../../../base/pattern-compiler/exec/plan-write.ts";
import {
  canonical,
  identifierOf,
  isKeySegment,
  isLink,
  isStream,
  type Schema,
  spliceIn,
  type Store,
  type StreamPosition,
} from "../../../../base/pattern-compiler/exec/store.ts";
import {
  type Scope,
  scopedDocument,
  scopeOfDocument,
} from "../../../../base/pattern-compiler/exec/scope-instances.ts";
import {
  type CellScope,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";

/** What the runtime's transactions were given, counted. */
export type RuntimeCounts = {
  /** Transactions committed. */
  committed: number;
  /** Transactions committed, by the cause the executor gave each. */
  byCause: Record<string, number>;
  /** Transactions aborted, because the executor did not commit them. */
  aborted: number;
  /** Positions read through a transaction, each once per transaction. */
  reads: number;
  /** Writes staged, one for each change of the executor. */
  writes: number;
  /**
   * Write records recorded for a write that left the value at its target
   * as it was.
   */
  unchangedRecords: number;
  /** Write records the executor gave in transactions that committed. */
  recordsGiven: number;
  /**
   * The `plan-write` inputs recorded for them: one for the records that
   * differ only in a member of one container or in the document.
   */
  recordsRecorded: number;
  /**
   * The size, as JSON text, of the `plan-write` and `plan-inputs` inputs
   * recorded, where the adapter was asked to count it.
   */
  recordBytes: number;
  /**
   * The paths whose label entries a commit changed in a document for which
   * it recorded such a write record.
   */
  labelEntriesChanged: number;
  /**
   * The links to row documents written into an array of them: one for each
   * position a change of the array's members wrote.
   */
  rowLinks: number;
  /**
   * Arrays of row documents written whole, as the links they hold: one for
   * each array a transaction spliced so that positions shifted.
   */
  rowArraysWritten: number;
  /**
   * The documents written whole that hold links of a list stored as
   * documents of its own: a chunk of an array of row documents, the list of
   * its chunks (`LinkList`) and the links of a record of bucket documents,
   * each counted once for each write.
   */
  listDocumentsWritten: number;
  /**
   * The labels the runtime's table of labels was asked to name: one for
   * each distinct label that a position asked for consumes.
   */
  labelsResolved: number;
};

/**
 * A write record as the adapter recorded it with the runtime: the runtime's
 * `plan-write` input without its kind, with the inputs it names in the
 * transaction's table of inputs held by value.
 */
export type RecordedPlanWrite = NestedPlanWrite;

/** The write records of one transaction, with the table they name. */
type Recorded = {
  writes: RuntimePlanWrite[];
  interner: PlanInputsInterner;
};

/**
 * What the transaction in progress recorded for the instances of one
 * compiled pattern: the write records, the table of inputs they name, and
 * what of the executor's table was converted into it.
 */
type Context = {
  /** The identity the runtime registered the compiled pattern under. */
  pattern: string;
  recorded: Recorded;
  /**
   * The executor's table of inputs that the records name, and for each of
   * its entries the index it was given in the runtime's table, with what
   * that index was formed under: for a binding whether its position takes
   * the label the transaction staged, and for a set of inputs the state of
   * the transaction's reads and writes (`#stagedState`).
   */
  converted: {
    table: InputsTable;
    bindings: Map<number, { staged: boolean; index: number }>;
    inputs: Map<number, { state: number; index: number }>;
  } | undefined;
};

/** What the stored form of a stream of the executor holds. */
export type StreamOfExecutor = StreamPosition["stream"];

/**
 * A change that another writer than the executor committed to a document
 * the executor holds: the path, and what the path holds after it, as the
 * executor holds a value. `value` is `undefined` where the path holds
 * nothing.
 */
export type ChangeByOther = {
  doc: string;
  path: string[];
  value?: unknown;
  /**
   * For a change of the members of an array at the path: the one run of
   * positions that differs, as the position it starts at, how many members
   * the array lost there, and the members it holds there now.
   */
  splice?: { start: number; removed: number; members: unknown[] };
  /**
   * For a change of an instance of a document of the scope `user` or
   * `session`: the scope key of the instance.
   */
  scoped?: string;
};

/**
 * A transaction that the adapter was handed (`RuntimeTransactions.within`),
 * and what the executor's transactions made of it.
 */
type Given = {
  tx: IExtendedStorageTransaction;
  /** A transaction of the executor did not commit. */
  failed: string | undefined;
};

/**
 * An array of the result of the instance the executor was started with
 * whose rows are stored as documents of their own: where it stands, and
 * the keys of the rows as the storage holds them, by position.
 */
type RowArray = {
  doc: string;
  path: string[];
  /** The text the executor's store names the array by (`Store.rowKeys`). */
  text: string;
  keys: string[];
  /** The position of each key, formed when it is asked for. */
  positions?: Map<string, number>;
  /** The identifier of the document of each row, by its key. */
  ids: Map<string, string>;
  /** The link to the document of each row, by its key. */
  links: Map<string, FabricValue>;
  /**
   * How the links are stored, where the lists of links of the result are
   * documents of their own; nothing where the array holds them in place.
   */
  list?: LinkList;
};

/**
 * How the storage holds the links of an array of row documents apart from
 * the result document, which holds a link to `doc` at the path of the
 * array.
 *
 * An array of at most `LIST_WHOLE` rows is one document, `doc`, that holds
 * the links to the rows in order: a reader that follows the link in the
 * result document reads the array the result would hold in place. A longer
 * array is stored in chunks: `doc` holds, in order, a link to the document
 * of each chunk, and a chunk holds at most `LIST_CHUNK` links to rows. A
 * reader that wants the rows in order reads the members of each member of
 * `doc` that is an array in the place of that member.
 */
type LinkList = {
  doc: string;
  /** Whether the storage holds, in the result document, the link to `doc`. */
  linked: boolean;
  /** The chunks in order, or nothing where `doc` holds the links to rows. */
  chunks: ListChunk[] | undefined;
  /** The chunks whose document does not hold the links of its rows. */
  dirty: Set<ListChunk>;
  /** The documents of chunks the list holds no more, not yet removed. */
  dropped: string[];
  /** Whether `doc` does not hold what the list holds now. */
  top: boolean;
  /** The identifiers of the documents of the chunks. */
  ids: Set<string>;
  /** The number the identifier of the next chunk is tried with first. */
  next: number;
  /**
   * Whether the layout the storage holds from a run before was looked for,
   * for a resumed instance.
   */
  adopted: boolean;
};

/** A chunk of a `LinkList`: its document and how many links it holds. */
type ListChunk = { doc: string; length: number };

/** The most links to rows that one chunk of a `LinkList` holds. */
const LIST_CHUNK = 64;

/**
 * The most links to rows that a `LinkList` holds in the list document
 * itself, unless the option `listWhole` gives another number. A reader
 * through the runtime reads a list of at most this many rows as the array
 * of the rows; a longer one it reads as an array of chunks. Measured on
 * the Topics board under the serving loop (note 925 of
 * `base/pattern-compiler/SPEC-NOTES.md`), a topic created takes as long
 * with 128 links in one document as in chunks, and longer with 256.
 */
const LIST_WHOLE = 128;

/**
 * The links a chunk is given where a list is laid out anew or a chunk is
 * split by a member that enters in its middle: fewer than `LIST_CHUNK`, so
 * that the next members to enter a chunk do not split it.
 */
const LIST_FILL = 48;

/**
 * The record of the buckets of an index that the result of the instance the
 * executor was started with keeps, where each bucket is stored as a document
 * of its own: where the record stands, and the encoded keys of the buckets
 * the storage holds a link to there.
 */
type BucketRecord = {
  doc: string;
  path: string[];
  keys: Set<string>;
  /**
   * Where the lists of links of the result are documents of their own: the
   * document that holds the link to each bucket by its encoded key, which
   * the result holds a link to at the path of the record, and whether the
   * storage holds that link. A reader that follows the link reads the
   * record the result would hold in place.
   */
  list?: { doc: string; linked: boolean };
};

/**
 * The most positions behind a splice of an array of row documents that are
 * written one by one. A splice that shifts more is written as the array.
 */
const SPLICE_AS_POSITIONS = 16;

/** What a handed transaction leaves for when its commit is applied. */
type Handed = {
  unchanged: Map<string, Map<string, string>>;
  created: string[];
  /** The documents of the executor the transaction wrote. */
  written: string[];
  /** The transaction, where something observes the sources of the piece. */
  tx?: IExtendedStorageTransaction;
  /**
   * Whether the commit of the transaction settled with no error. For a
   * transaction that a serving runtime sealed into a wave, that is before
   * the wave commits, and the replica takes its writes back where the wave
   * is rejected.
   */
  settled?: boolean;
  /** Whether the piece was told that the transaction was refused. */
  refused?: boolean;
};

/**
 * What hears of the documents the derivation of a piece reads and does not
 * derive, and of the transactions that write them (`compiled/basis.ts`).
 */
export type SourceObserver = {
  /**
   * The executor read a document that exists outside it from the replica,
   * or a place of its own that the storage holds no document of.
   */
  read(doc: string): void;
  /**
   * The replica applied or took back a commit, of this runtime or another,
   * that changed a document the adapter knows. With `taken`, the change is
   * of another writer and the executor took it into the document it holds.
   * `by` is the handed transaction whose commit the replica applied, where
   * it is one: a commit changes a document it wrote no value of where it
   * stores a label there.
   */
  changed(
    doc: string,
    taken: boolean,
    by?: IExtendedStorageTransaction,
  ): void;
  /**
   * A transaction the adapter was handed wrote `written`, of which a
   * transaction of the executor that was no derivation wrote `sources`.
   */
  handed(
    tx: IExtendedStorageTransaction,
    written: readonly string[],
    sources: ReadonlySet<string>,
  ): void;
  /** The commit of a handed transaction was refused or taken back. */
  refused(tx: IExtendedStorageTransaction): void;
  /**
   * The executor made a document that is neither a row nor the result
   * document, or the adapter made the entity of a stream.
   */
  made(doc: string): void;
};

/**
 * What the storage holds for a document of the executor after a commit that
 * wrote it was refused, as the executor holds a value: `undefined` where
 * the storage holds nothing.
 */
export type Restored = {
  doc: string;
  value: unknown;
  /**
   * The identity whose instance of the document `value` is, where the
   * transaction that wrote it carried one (`RuntimeTransactions.actingFor`).
   */
  acting?: ScopeKeyIdentity;
};

/** Keeps the documents of one executor in one space of a runtime. */
export class RuntimeTransactions implements TransactionHooks {
  readonly #runtime: Runtime;
  readonly #space: MemorySpace;
  readonly #resume: boolean;
  /**
   * The documents whose creation by the executor is the value the storage
   * holds, which the adapter gave it (`heldArgument`).
   */
  readonly #heldWhole = new DocumentInstances((doc) => this.#instanceOf(doc));
  /** The `result` link the documents the executor makes are given. */
  #resultLink: unknown;
  /**
   * With `resume`: the identifiers `load()` was asked for that the replica
   * holds no document of.
   */
  readonly absent = new Set<string>();
  /**
   * The documents outside the executor that `load()` was asked for and the
   * replica held none of, by name: the storage may hold one that the
   * replica has not been brought.
   */
  readonly wanted = new Set<string>();
  /**
   * Whether the first derivation of a resumed instance is in progress. A
   * change of it that writes what the storage holds is then no write, and
   * the path keeps the label the storage holds for it. No record is given
   * for a path that differs either: the runtime labels it with the join of
   * what the transaction read, which is every label the derivation read.
   */
  #resuming: boolean;
  #tx: IExtendedStorageTransaction | undefined;
  #cause = "";
  /** The positions the transaction in progress read, as text. */
  readonly #read = new Set<string>();
  /**
   * The positions of `#read` that the transaction read before it wrote
   * them, as text.
   */
  readonly #readBeforeWrite = new Set<string>();
  /**
   * The positions the transaction read after it wrote them, at their path
   * or above, as text. A read is counted here even where `#read` already
   * held its position from a read before the write.
   */
  readonly #readAfterWrite = new Set<string>();
  readonly #receipts: {
    receipt: TransactionCommitReceipt;
    recorded: Recorded[];
    created: string[];
  }[] = [];
  /**
   * What the transaction in progress recorded, by compiled pattern: the
   * write records of an instance name the records of its own plan, and
   * their inputs in a table of that compiled pattern.
   */
  readonly #contexts = new Map<string, Context>();
  /** The entry of `#contexts` the record being converted belongs to. */
  #context: Context = {
    pattern: "",
    recorded: { writes: [], interner: new PlanInputsInterner() },
    converted: undefined,
  };
  /**
   * The identity of the compiled pattern of each instance the executor
   * made of another artifact than the one it was started with.
   */
  readonly #patternOf = new Map<string, string>();
  /** The identity each artifact was registered under. */
  readonly #registered = new Map<Artifact, string>();
  /** The artifact the adapter was given, of the instance it was started with. */
  readonly #artifact: Artifact | undefined;
  /** The artifact of each instance the executor made of another artifact. */
  readonly #artifactOf = new Map<string, Artifact>();
  /**
   * The number of changes of what decides whether a binding takes a staged
   * label, in the transaction in progress: its writes, and its reads of a
   * position it wrote.
   */
  #stagedState = 0;
  /**
   * The label entries each document stored before the transaction in
   * progress, for the documents it recorded a write for that left the
   * value as it was.
   */
  readonly #unchanged = new Map<string, Map<string, string>>();
  /** The documents the transaction in progress wrote first. */
  #created: string[] = [];
  /** What hears of the write records of each commit that settled. */
  #onCommitted: ((writes: readonly RecordedPlanWrite[]) => void) | undefined;
  /** What hears of the write records of each transaction as recorded. */
  #onRecorded: ((writes: readonly RuntimePlanWrite[]) => void) | undefined;
  /** Removes this adapter from the readers of the storage manager. */
  readonly #stopReading: (() => void) | undefined;
  /**
   * The document whose instance owns the documents the executor makes: the
   * result document of the instance the executor was started with.
   */
  readonly #owner: string | undefined;
  readonly #counts: RuntimeCounts = {
    committed: 0,
    byCause: {},
    aborted: 0,
    reads: 0,
    writes: 0,
    unchangedRecords: 0,
    recordsGiven: 0,
    recordsRecorded: 0,
    recordBytes: 0,
    labelEntriesChanged: 0,
    rowLinks: 0,
    rowArraysWritten: 0,
    listDocumentsWritten: 0,
    labelsResolved: 0,
  };
  /** Whether `RuntimeCounts.recordBytes` is counted. */
  readonly #countRecordBytes: boolean;
  /** The identifier of each document the storage holds. */
  readonly #documents = new DocumentInstances((doc) => this.#instanceOf(doc));
  /** The document of the executor that each entity holds. */
  readonly #byEntity = new Map<string, string>();
  /** The space of each document that is in another space than `#space`. */
  readonly #spaces = new Map<string, MemorySpace>();
  /**
   * The identity the runtime registered the compiled pattern under, where
   * the runtime's option `compiledPatterns` is on and the artifact was
   * given; write records are recorded only then.
   */
  readonly #compiledPattern: string | undefined;
  /**
   * The write policies the result type of the compiled pattern declares, or
   * `undefined` where it declares none.
   */
  readonly #resultPolicy: ResultPolicy | undefined;
  /** The transaction `#resultPolicy` was last recorded for. */
  #resultPolicyIn: IExtendedStorageTransaction | undefined;
  /**
   * The write policies declared for the argument documents, and for the
   * result documents of the instances a body or a handler made.
   */
  readonly #declared = new DeclaredPolicies();
  /** The paths the transaction in progress wrote, by document. */
  readonly #written = new Map<string, (readonly string[])[]>();
  /** The stored labels of each document `labelOf` read, per transaction. */
  readonly #metadata = new Map<string, CfcMetadata | undefined>();
  /**
   * The label entries of each document `labelOf` read, each as text by the
   * text of its path, which a change of the document is compared against.
   */
  readonly #entries = new ByDocumentInstance<Map<string, string>>((doc) =>
    this.#instanceOf(doc)
  );
  /**
   * The stored labels of each document of `#entries` as they were when
   * the entries were taken, which a change is compared against by the
   * label a read consumes (`LabelChange.unchanged`).
   */
  readonly #entriesOf = new ByDocumentInstance<CfcMetadata | undefined>((
    doc,
  ) => this.#instanceOf(doc));
  /** The documents of `#entries` that a commit changed since. */
  readonly #touched = new DocumentInstances((doc) => this.#instanceOf(doc));
  /** What the executor registered to hear of changed labels. */
  #labelsChanged:
    | ((
      changes: readonly LabelChange[],
      alone?: boolean,
      stored?: boolean,
    ) => void)
    | undefined;
  /** The subscription that hears of the commits of the space. */
  readonly #subscription: IStorageNotification | undefined;
  /** The transaction the adapter was handed, while `within` runs. */
  #given: Given | undefined;
  /**
   * While `within` runs a load in bounded transactions: the most row
   * documents one transaction holds, the transaction that holds the row
   * documents written since the last one was committed, and those
   * documents.
   */
  #load:
    | {
      rows: number;
      tx: IExtendedStorageTransaction | undefined;
      documents: string[];
      /** The reads the handed transaction had made when the load began. */
      before: IReadActivity[];
    }
    | undefined;
  /**
   * What the transaction of `#load` recorded, by compiled pattern, as
   * `#contexts` holds it for the transaction in progress.
   */
  readonly #rowContexts = new Map<string, Context>();
  /** Whether a record being converted is one of the transaction of `#load`. */
  #recordingRows = false;
  /**
   * While `change` writes during such a load: the write records of each row
   * document that goes into a transaction of rows, with the table they
   * name, and the records recorded there.
   */
  #rowsApart:
    | {
      records: Map<string, PlanWrite[]>;
      inputs: InputsTable;
      recorded: Set<PlanWrite>;
    }
    | undefined;
  /**
   * The row documents that a transaction of rows of the load in progress
   * stored and that the handed transaction has not written since. A
   * position of one holds a stored label, and none the handed transaction
   * stages.
   */
  readonly #rowsStored = new Set<string>();
  /** The row documents the handed transaction of such a load wrote. */
  readonly #rowsHanded = new Set<string>();
  /**
   * The storage transactions this adapter writes through, each with what
   * it leaves for when its commit is applied where it was handed.
   */
  readonly #own = new WeakMap<object, Handed | undefined>();
  /**
   * The collections of the plan of the instance the executor was started
   * with whose rows are stored as documents of their own; none where the
   * rows of every collection stay in place.
   */
  readonly #rowCollections: ReadonlySet<number>;
  /** The arrays whose rows are documents of their own, by their document. */
  readonly #rowArrays = new Map<string, RowArray[]>();
  /**
   * The row documents that the change being written wrote with what they
   * held, by their identifier.
   */
  readonly #rowsHeld = new Set<string>();
  /** The array and the key of each row document, by its identifier. */
  readonly #rowDocuments = new Map<string, { array: RowArray; key: string }>();
  /**
   * The records of buckets of the result document whose buckets are
   * documents of their own.
   */
  readonly #bucketRecords: BucketRecord[] = [];
  /** The record and the encoded key of each bucket document. */
  readonly #bucketDocuments = new Map<
    string,
    { record: BucketRecord; key: string }
  >();
  /**
   * Whether the lists of links of the result are stored as documents of
   * their own (`LinkList`, `BucketRecord.list`).
   */
  readonly #lists: boolean;
  /** The most links to rows that a list document holds itself. */
  readonly #listWhole: number;
  /**
   * The array of row documents whose links each document of a `LinkList`
   * holds: the list document itself and the document of each chunk.
   */
  readonly #listDocuments = new Map<string, RowArray>();
  /** The record of bucket documents whose links each such document holds. */
  readonly #bucketLists = new Map<string, BucketRecord>();
  /** The stream each entity that holds a stream marker is of. */
  readonly #streams = new Map<string, StreamOfExecutor>();
  /** The stream entities the transaction in progress wrote first. */
  #createdStreams: string[] = [];

  /**
   * The markers of streams that the change in progress wrote, each with its
   * stream, for the records `#recordsOfMarkers` gives them.
   */
  #markersMade: { entity: URI; stream: StreamOfExecutor }[] = [];
  readonly #onStream:
    | ((entity: URI, stream: StreamOfExecutor) => void)
    | undefined;
  readonly #onChanges: ((changes: ChangeByOther[]) => void) | undefined;
  readonly #onArrived: ((doc: string) => void) | undefined;
  readonly #onLabels: (() => void) | undefined;
  readonly #unheld:
    | { reads(entity: string): boolean; changed(entities: string[]): void }
    | undefined;
  readonly #onApplied: (() => void) | undefined;
  /**
   * For a resumed instance: the documents of the executor that the replica
   * held when the instance was resumed and that this runtime has not
   * written.
   */
  readonly #heldBefore = new DocumentInstances((doc) => this.#instanceOf(doc));
  readonly #sources: SourceObserver | undefined;
  /**
   * The documents the transaction in progress wrote in a transaction of
   * the executor that was no derivation.
   */
  readonly #writtenAsSource = new Set<string>();
  readonly #onRefused:
    | ((reason: string, restored?: Restored[]) => void)
    | undefined;

  /**
   * Constructs an instance which keeps the documents in `space` of
   * `runtime`.
   */
  constructor(
    runtime: Runtime,
    space: MemorySpace,
    options: {
      /**
       * The identifier of the result document of the instance the executor
       * is started with. Each document the executor makes is then enrolled
       * as a store the runtime owns, under that instance, as the runner
       * enrolls the stores of a piece it sets up.
       */
      owner?: string;
      /**
       * The compiled pattern the executor runs. With the runtime's option
       * `compiledPatterns` on, it is registered with the runtime and the
       * executor's write records are recorded with each write.
       */
      artifact?: Artifact;
      /**
       * Whether to count the size of the write records recorded
       * (`RuntimeCounts.recordBytes`), which costs a pass over each.
       */
      countRecordBytes?: boolean;
      /**
       * Whether `artifact`, and each artifact the executor instantiates,
       * is one the runtime's compiler gave for a source, or one host code
       * vouches for (`CompiledPieceOptions.attested`). The handlers of any
       * other artifact have no identity a writer claim is checked by.
       */
      attested?: boolean;
      /**
       * The collections of the plan of `artifact` whose rows are stored as
       * documents of their own, each named by the array and the key of the
       * row, with a link to it at the row's position
       * (`rowDocumentCollections` of the executor). The rows of every
       * other collection, and of every collection of another artifact,
       * are stored in place.
       */
      rowDocuments?: ReadonlySet<number>;
      /**
       * The collections of the plan of `artifact` whose index the result
       * keeps with each bucket stored as a document of its own, named by
       * the record of the buckets and the encoded key, with a link to it at
       * the bucket's member of the record (`bucketDocumentCollections` of
       * the executor). The executor is given the same set
       * (`Instance` option `bucketDocuments`), so that it writes the record
       * member by member.
       */
      bucketDocuments?: ReadonlySet<number>;
      /**
       * Whether the links to the row documents of each array of
       * `rowDocuments`, and the links to the bucket documents of each index
       * of `bucketDocuments`, are stored in documents of their own, a long
       * array in chunks, with a link in the result document at the path of
       * the array or of the record. A change of one link of an array then
       * writes a document whose size does not follow the number of rows,
       * and a change of one link of a record writes one path of the
       * document of the record.
       */
      listDocuments?: boolean;
      /**
       * The most rows of an array whose links the list document holds
       * itself, where the lists are documents of their own. A longer array
       * is stored in chunks. The default is `LIST_WHOLE`.
       */
      listWhole?: number;
      /**
       * Called when a value first stored holds a stream of the executor.
       * The stream is then stored as a link to an entity that holds the
       * runtime's stream marker, which a `Cell.send` resolves to; without
       * this option a stream is stored as the executor's record of it.
       */
      stream?: (entity: URI, stream: StreamOfExecutor) => void;
      /**
       * Called with the changes that a commit of another writer made to
       * documents the executor holds, when the replica applied it.
       */
      changes?: (changes: ChangeByOther[]) => void;
      /**
       * Called when the replica took a commit or a load of a document that
       * `load()` was asked for and gave nothing of (`wanted`).
       */
      arrived?: (doc: string) => void;
      /**
       * Called when a commit of another writer changed a document whose
       * stored labels the executor has read. The executor is told of the
       * labels that changed when it next opens a transaction or is handed
       * one, and the label of a record that read one of them is then
       * formed again.
       */
      labels?: () => void;
      /**
       * What the adapter asks and tells of the entities of the space of
       * the instance that the executor holds no document of, while the
       * executor holds rows as stored (`rowsHeld`): a row left as stored
       * was derived from documents that this executor has not read.
       * `reads` says whether a row may have read the entity, so that the
       * replica keeps the document and reports a write to it. `changed`
       * is called with the entities that a commit of another writer
       * changed, value or label.
       */
      unheld?: {
        reads(entity: string): boolean;
        changed(entities: string[]): void;
      };
      /**
       * Called when the replica applied the commit of a transaction the
       * adapter was handed, after the executor was told of the labels it
       * stored.
       */
      applied?: () => void;
      /**
       * Called with the reason when the storage refused the commit of a
       * transaction the adapter was handed, and with what the storage
       * holds for each document of the executor that the transaction
       * wrote, which the executor's store is then ahead of.
       */
      refused?: (reason: string, restored?: Restored[]) => void;
      /** What hears of the sources of the piece and of what writes them. */
      sources?: SourceObserver;
      /**
       * Whether the storage holds the documents of the instance from a run
       * before. `load()` then gives a document the executor names by an
       * identifier of its own as well, and the write that creates the
       * result document empty is not made.
       */
      resume?: boolean;
    } = {},
  ) {
    this.#runtime = runtime;
    this.#space = space;
    this.#owner = options.owner;
    this.#rowCollections = options.rowDocuments ?? new Set();
    this.#lists = options.listDocuments === true;
    this.#listWhole = options.listWhole ?? LIST_WHOLE;
    if (options.owner !== undefined && options.bucketDocuments !== undefined) {
      for (const output of options.artifact?.plan.outputs ?? []) {
        if (
          output.kept === true && output.collection !== undefined &&
          options.bucketDocuments.has(output.collection) &&
          !output.path.includes("*")
        ) {
          const record: BucketRecord = {
            doc: options.owner,
            path: [...output.path, "buckets"],
            keys: new Set(),
          };
          if (this.#lists) {
            const doc = identifierOf({
              bucketList: [record.doc, ...record.path],
            });
            record.list = { doc, linked: false };
            this.#bucketLists.set(doc, record);
            this.entityOf(doc);
          }
          this.#bucketRecords.push(record);
        }
      }
    }
    this.#onStream = options.stream;
    this.#onChanges = options.changes;
    this.#onArrived = options.arrived;
    this.#onLabels = options.labels;
    this.#unheld = options.unheld;
    this.#onApplied = options.applied;
    this.#onRefused = options.refused;
    this.#sources = options.sources;
    this.#resume = options.resume === true;
    this.#resuming = this.#resume;
    this.#countRecordBytes = options.countRecordBytes === true;
    this.#compiledPattern = options.artifact === undefined ||
        !runtime.experimental.compiledPatterns || !runtime.servingPosture
      ? undefined
      : this.#register(options.artifact);
    this.#artifact = options.artifact;
    this.#attested = options.attested === true;
    if (options.artifact !== undefined && options.owner !== undefined) {
      this.#declared.declare(options.owner, options.artifact, false);
    }
    this.#resultPolicy = writePoliciesOf(
      options.artifact?.schemas.find(({ id }) =>
        id === (options.artifact?.plan as { resultSchema?: unknown })
          .resultSchema
      )?.schema,
    );
    if (
      this.#compiledPattern !== undefined || this.#onChanges !== undefined ||
      this.#sources !== undefined
    ) {
      // A commit of the space, the executor's own or another's, can change
      // the labels of a document whose positions the executor grouped
      // elements by, and another writer's can change a value the executor
      // holds.
      this.#subscription = {
        next: (notification) => {
          if (notification.type === "reset") this.#labelIds.clear();
          // A commit of another space changes a document the executor
          // holds where a link led it into that space (`#spaces`).
          if (
            notification.type === "reset" ||
            (notification.space !== this.#space && this.#spaces.size === 0)
          ) {
            return undefined;
          }
          const source = "source" in notification
            ? notification.source
            : undefined;
          const own = source !== undefined && this.#own.has(source);
          const byOther: ChangeByOther[] = [];
          const seen = new Set<string>();
          let labelsByOther = false;
          // The entities that another writer changed and that the executor
          // holds no document of, while it holds rows as stored. A document
          // that a read brings into the replica is no change.
          const unheld = !own && this.#unheld !== undefined &&
              this.#keptArrays.size > 0 &&
              notification.space === this.#space &&
              notification.type !== "load" && notification.type !== "pull"
            ? new Set<string>()
            : undefined;
          for (const { address, before, after } of notification.changes) {
            // Two spaces can hold documents of one entity: a document of
            // another space is held under a name that names the space.
            const named = this.#byEntity.get(
              this.#keyOf(notification.space, address.id),
            );
            // A change of an instance of a scope is of one scope key: the
            // one the change names, and the runtime's own where it names
            // none.
            const changed = address.scope === undefined ||
                address.scope === "space"
              ? undefined
              : address.scopeKey ??
                resolveScopeKey(address.scope, this.#runtime.scopeKeyIdentity);
            const doc = named === undefined || changed === undefined
              ? named
              : `${named}~${changed}`;
            if (doc === undefined || !this.#documents.has(doc)) {
              // A row can have read the entity where the basis of the
              // piece names it.
              if (
                unheld !== undefined && changed === undefined &&
                (doc === undefined || !this.#rowDocuments.has(doc)) &&
                this.#unheld?.reads(address.id) === true
              ) unheld.add(address.id);
            }
            if (named === undefined || doc === undefined) continue;
            if (this.#spaceOf(named) !== notification.space) continue;
            // A document the executor asked for and the replica held none
            // of now has one: the piece reads it again.
            if (this.wanted.has(doc) && !this.#documents.has(doc)) {
              this.#onArrived?.(doc);
              continue;
            }
            this.#sources?.changed(
              doc,
              false,
              own && notification.type === "commit"
                ? this.#own.get(source!)?.tx
                : undefined,
            );
            this.#labelIds.delete(doc);
            if (this.#entries.has(doc)) {
              this.#touched.add(doc);
              if (!own) labelsByOther = true;
            }
            // A document of a row is one the executor holds as the row, at
            // its position in the array. A place the executor declared and
            // has not written, as a state cell that a result holds a write
            // redirect to, gets its document from another writer's first
            // write, which the executor takes as it takes a later one.
            const row = this.#rowDocuments.get(doc);
            if (
              own || this.#onChanges === undefined ||
              (!this.#documents.has(doc) && row === undefined &&
                this.#store?.declared.has(doc) !== true) ||
              (address.path.length > 0 && address.path[0] !== "value")
            ) continue;
            // A change names its path below the member `value` of what the
            // entity holds, and carries the whole of that after the change.
            const held = isWalkableObjectNotArray(after)
              ? after.value
              : undefined;
            const was = isWalkableObjectNotArray(before)
              ? before.value
              : undefined;
            // A change below a position that holds a link, before or after
            // it, is a change of what that position holds.
            const path = aboveLinks(address.path.slice(1), was, held);
            // A change of a member of an array, or of how many it has, is
            // given as one of the array: the executor then finds which
            // members stayed by their keys, where the changes of a moved
            // member's positions one by one would name each a new member.
            const at = path.length > 0 &&
                Array.isArray(valueAt(held, path.slice(0, -1)))
              ? path.slice(0, -1)
              : path;
            const text = JSON.stringify([doc, at]);
            if (seen.has(text)) continue;
            seen.add(text);
            const now = valueAt(held, at);
            const then = valueAt(was, at);
            // Where the executor holds the change: for a row's document,
            // below the position of the row, and nowhere for a row that
            // left its array.
            const stored = row === undefined
              ? { doc, path: at }
              : this.#addressOfStored(doc, at);
            // The executor names the instances of a scope by one name.
            const place = {
              doc: changed === undefined
                ? stored.doc
                : scopedDocument(named, address.scope as Scope),
              path: [...stored.path],
              ...(changed === undefined ? {} : { scoped: changed }),
            };
            if (row !== undefined && !row.array.keys.includes(row.key)) {
              continue;
            }
            // A change at or above an array of row documents changed which
            // links the array holds. The array is derived, and the
            // executor holds each row in it by its key: it does not take
            // the members of another writer, and the piece is told, as of
            // a commit that was refused.
            if (
              row === undefined &&
              (this.#rowArrays.get(doc) ?? []).some((array) =>
                isPrefix(at, array.path)
              )
            ) {
              this.#onRefused?.(
                "Another writer wrote the array of the row documents of the piece, or above it.",
              );
              continue;
            }
            this.#sources?.changed(doc, true);
            if (!Array.isArray(now) || !Array.isArray(then)) {
              byOther.push({
                ...place,
                value: this.#decode(
                  now,
                  undefined,
                  notification.space,
                  address.scope ?? "space",
                  doc,
                ),
              });
              continue;
            }
            const splice = spliceBetween(then, now);
            byOther.push({
              ...place,
              splice: {
                start: splice.start,
                removed: splice.removed,
                members: splice.members.map((member) =>
                  this.#decode(
                    member,
                    undefined,
                    notification.space,
                    address.scope ?? "space",
                    doc,
                  )
                ),
              },
            });
          }
          if (own && notification.type === "commit") {
            const handed = this.#own.get(source!);
            if (handed !== undefined) this.#applied(handed);
          }
          // A transaction that was sealed into a wave of a serving runtime
          // settled without an error, and the wave was then rejected: the
          // replica took its writes back. The executor is ahead by them, as
          // after a commit that was refused. A commit that is refused
          // outright takes its writes back before it settles with the
          // error, which the piece is told of then.
          if (own && notification.type === "revert") {
            const handed = this.#own.get(source!);
            if (
              handed !== undefined && handed.settled === true &&
              handed.refused !== true
            ) {
              handed.refused = true;
              if (handed.tx !== undefined) this.#sources?.refused(handed.tx);
              this.#onRefused?.(
                `${notification.reason.name}: ${notification.reason.message}`,
                this.#restored(handed),
              );
            }
          }
          if (byOther.length > 0) this.#onChanges?.(byOther);
          if (labelsByOther) this.#onLabels?.();
          if (unheld !== undefined && unheld.size > 0) {
            this.#unheld?.changed([...unheld]);
          }
          return undefined;
        },
      };
      runtime.storageManager.subscribe(this.#subscription);
    }
    // The replica drops a document that nothing holds or reads at its next
    // release pass (`releaseUnreadDocuments()`), and a read through a
    // transaction does not load it again: it reads the document as absent
    // at seq 0, and the commit is refused as a stale read. The executor
    // holds its documents in memory and reads them through transactions, so
    // it reads, as the replica counts it, every document it has named.
    this.#stopReading = runtime.storageManager.addDocumentReader?.((
      address,
    ) => {
      const doc = this.#byEntity.get(
        this.#keyOf(address.space, address.id),
      );
      if (doc !== undefined) return address.space === this.#spaceOf(doc);
      // A row left as stored was derived from documents the executor has
      // not named: the replica keeps those, and reports a write to one.
      return this.#keptArrays.size > 0 && address.space === this.#space &&
        this.#unheld?.reads(address.id) === true;
    });
  }

  /**
   * The transaction that brings the piece into being for the principal it
   * acts for (`attributeFirstValuesIn`).
   */
  #attributedIn: IExtendedStorageTransaction | undefined;

  /**
   * Has the first value of each state cell that `tx` writes attributed to
   * the principal `tx` acts for: `tx` is the transaction that brings the
   * piece into being on their behalf, which the caller marked for the
   * result document (`markCfcAttributedInitialization`).
   */
  attributeFirstValuesIn(tx: IExtendedStorageTransaction): void {
    this.#attributedIn = tx;
  }

  /** See the option `attested` of the constructor. */
  readonly #attested: boolean;

  /**
   * The fields of each argument document that hold the default of the
   * argument type, because the argument left them out (`filledDefaults`).
   */
  readonly #filledDefaults = new Map<string, readonly string[]>();

  /**
   * Notes that the argument document `doc`, which the executor is about to
   * make, holds the default of its type at each field of `names`
   * (`argumentWithDefaults`): the write that makes the document records
   * each protected one among them as a seed.
   */
  filledDefaults(doc: string, names: readonly string[]): void {
    this.#filledDefaults.set(doc, names);
  }

  /** Registers a compiled pattern with the runtime, once. */
  #register(artifact: Artifact): string {
    let identity = this.#registered.get(artifact);
    if (identity === undefined) {
      identity = this.#runtime.compiledPlans.register(
        // The plan as the crate emits it carries every member the
        // runtime reads.
        artifact.plan as unknown as CompiledPlan,
        JSON.stringify(artifact.code),
        runtimeWritePolicyAuthorization,
      );
      this.#registered.set(artifact, identity);
    }
    return identity;
  }

  /** The write records recorded for the compiled pattern being converted. */
  get #recorded(): Recorded {
    return this.#context.recorded;
  }

  /** What was converted of the table the records of `#recorded` name. */
  get #converted(): Context["converted"] {
    return this.#context.converted;
  }

  set #converted(converted: Context["converted"]) {
    this.#context.converted = converted;
  }

  /**
   * Begins the records of a transaction, and makes those of the compiled
   * pattern the executor was started with the ones being converted.
   */
  #resetRecorded(): void {
    this.#contexts.clear();
    this.#use(this.#compiledPattern ?? "");
  }

  /** Makes the records of `pattern` the ones being converted. */
  #use(pattern: string): void {
    const contexts = this.#recordingRows ? this.#rowContexts : this.#contexts;
    let context = contexts.get(pattern);
    if (context === undefined) {
      context = {
        pattern,
        recorded: { writes: [], interner: new PlanInputsInterner() },
        converted: undefined,
      };
      contexts.set(pattern, context);
    }
    this.#context = context;
  }

  /** @inheritDoc */
  instantiated(instance: string, artifact: Artifact): void {
    this.#artifactOf.set(instance, artifact);
    this.#declared.declare(instance, artifact, true);
    if (this.#compiledPattern === undefined) return;
    this.#patternOf.set(instance, this.#register(artifact));
  }

  /**
   * The identity a transaction that runs the handler of `stream` is stamped
   * with (`handlerIdentityOf`), or `undefined` where the adapter was given
   * no artifact, the artifact is not attested, or the experimental option
   * `compiledPatterns` is off.
   */
  handlerOf(stream: StreamOfExecutor): ImplementationIdentity | undefined {
    const artifact =
      (stream.instance === undefined
        ? undefined
        : this.#artifactOf.get(stream.instance)) ?? this.#artifact;
    // `Body.code` of an artifact nothing vouches for is a statement of
    // whoever wrote the artifact about a handler, which nothing checked
    // against a source: its handlers are writers with no identity.
    if (
      artifact === undefined || !this.#attested ||
      !this.#runtime.experimental.compiledPatterns
    ) return undefined;
    // A runtime that stores no labels from templates registers the pattern
    // here: a writer claim is checked in every runtime that commits.
    const pattern = this.#register(artifact);
    return handlerIdentityOf(
      this.#runtime.compiledPlans.plan(
        pattern,
        runtimeWritePolicyAuthorization,
      ),
      pattern,
      stream.binding,
    );
  }

  /** The space the documents of the executor are in. */
  get space(): MemorySpace {
    return this.#space;
  }

  /**
   * The entity that holds the stream marker of a stream of the executor,
   * where a transaction wrote one.
   */
  entityOfStream(stream: StreamOfExecutor): URI | undefined {
    const entity = this.#entityOfStream(stream);
    return this.#streams.has(entity) ? entity : undefined;
  }

  /**
   * The entity that holds the stream marker of a stream of the executor,
   * written into the handed transaction in progress (`within()`) where no
   * transaction wrote it: a stream that a handler sends to and that no
   * stored value links, as one that the state of a binding alone holds,
   * has its marker from the transaction of the handler that first sends to
   * it.
   */
  markedStream(stream: StreamOfExecutor): URI {
    const known = this.entityOfStream(stream);
    if (known !== undefined) return known;
    this.begin("send");
    let committed = false;
    try {
      const entity = this.#streamEntity(stream);
      committed = true;
      return entity;
    } finally {
      this.end({ committed });
    }
  }

  /** What the transactions were given so far. */
  get counts(): Readonly<RuntimeCounts> {
    return { ...this.#counts, byCause: { ...this.#counts.byCause } };
  }

  /**
   * Takes a document as one that exists in storage and that the executor did
   * not make, as an input it is handed: it is kept loaded, a change to it is
   * written at its path, and it is not enrolled as a store the runtime owns.
   * `space` is the space of a document that is in another space than the
   * executor's.
   */
  external(doc: string, space?: MemorySpace): void {
    const entity = this.entityOf(doc);
    this.#documents.add(doc);
    if (space !== undefined && space !== this.#space) {
      this.#spaces.set(doc, space);
      // The caller named the document by its entity alone: a link into
      // that space leads to it under the name the caller gave.
      this.#byEntity.set(documentIn(entity, space), doc);
    }
  }

  /** The space a document of the executor is in. */
  #spaceOf(doc: string): MemorySpace {
    const of = doc.indexOf("~") < 0 ? doc : scopeOfDocument(doc).base;
    return placeOfDocument(of).space as MemorySpace | undefined ??
      this.#spaces.get(of) ?? this.#space;
  }

  /**
   * What `#byEntity` holds the document of `space` at `entity` under: the
   * entity for the space of the piece, and the entity with the space for
   * another (`documentIn`).
   */
  #keyOf(space: MemorySpace, entity: string): string {
    return space === this.#space || entity.startsWith("data:")
      ? entity
      : documentIn(entity, space);
  }

  /**
   * The document of the executor that the entity of a link holds in the
   * space the link names: for a link into another space than the piece's,
   * the name that names the space.
   */
  documentAt(link: { space?: MemorySpace; id: string }): string {
    if (
      link.space === undefined || link.space === this.#space ||
      link.id.startsWith("data:")
    ) return this.documentOf(link.id);
    const doc = documentIn(link.id, link.space);
    // A document a caller handed under another name (`external`).
    const known = this.#byEntity.get(doc);
    if (known !== undefined) return known;
    this.entityOf(doc);
    return doc;
  }

  /** Stops keeping the documents of the executor loaded. */
  close(): void {
    this.#stopReading?.();
    if (this.#subscription !== undefined) {
      this.#runtime.storageManager.unsubscribe?.(this.#subscription);
    }
  }

  /** @inheritDoc */
  watchLabels(
    changed: (
      changes: readonly LabelChange[],
      alone?: boolean,
      stored?: boolean,
    ) => void,
  ): void {
    this.#labelsChanged = changed;
  }

  /**
   * Tells the executor of the label entries that changed in each document
   * a commit touched since the last call: those added, removed or changed,
   * by path. The work is the number of entries of the touched documents.
   */
  #reportLabels(stored = false): void {
    if (this.#touched.size === 0) return;
    const changes: LabelChange[] = [];
    const tx = this.#edit();
    try {
      for (const doc of this.#touched) {
        this.#metadata.delete(doc);
        const before = this.#entries.get(doc) ?? new Map();
        const was = this.#entriesOf.get(doc);
        const now = this.#storedLabels(tx, doc);
        const after = entriesOf(now);
        this.#entries.set(doc, after);
        this.#entriesOf.set(doc, now);
        const { paths, alone } = changedLabelPaths(before, after);
        if (paths.length > 0) {
          // The answer for a path and a class is the same for every record
          // that read the path, and the records of the rows of a list read
          // the same few paths of it.
          const answered = new Map<string, boolean>();
          changes.push({
            doc,
            paths,
            ...(alone.length > 0 ? { alone } : {}),
            unchanged: (path, observes) => {
              const asked = `${observes}\n${JSON.stringify(path)}`;
              let answer = answered.get(asked);
              if (answer === undefined) {
                answer = this.#labelIn(was, path, observes) ===
                  this.#labelIn(now, path, observes);
                answered.set(asked, answer);
              }
              return answer;
            },
          });
        }
      }
    } finally {
      tx.abort();
      this.#touched.clear();
      this.#labelsOverRows.clear();
    }
    if (changes.length > 0) {
      this.#labelsChanged?.(this.#toExecutor(changes), false, stored);
    }
  }

  /**
   * Label changes of documents the storage holds, as changes of the
   * executor's documents: a change of a row document is one below the
   * position of its row.
   */
  #toExecutor(changes: readonly LabelChange[]): LabelChange[] {
    if (this.#rowDocuments.size === 0 && this.#bucketDocuments.size === 0) {
      return [...changes];
    }
    return changes.map((change) => {
      const { doc, paths, alone, unchanged } = change;
      // The document of the links of a record of buckets holds the link
      // to each bucket, which the executor holds at the bucket's member of
      // the record.
      const record = this.#bucketLists.get(doc);
      if (record !== undefined) {
        return {
          doc: record.doc,
          paths: paths.map((path) => [...record.path, ...path]),
        };
      }
      if (!this.#rowDocuments.has(doc) && !this.#bucketDocuments.has(doc)) {
        return change;
      }
      const moved = (path: readonly string[]) =>
        this.#addressOfStored(doc, path).path;
      const row = moved([]);
      return {
        doc: this.#addressOfStored(doc, []).doc,
        paths: paths.map(moved),
        ...(alone === undefined ? {} : { alone: alone.map(moved) }),
        // A position at or above the row is not one of the row's document.
        ...(unchanged === undefined ? {} : {
          unchanged: (path: readonly string[], observes: string) =>
            path.length >= row.length &&
            row.every((segment, index) => segment === path[index]) &&
            unchanged(path.slice(row.length), observes),
        }),
      };
    });
  }

  /** The stored labels of a document of the executor, read through `tx`. */
  #storedLabels(
    tx: IExtendedStorageTransaction,
    doc: string,
  ): CfcMetadata | undefined {
    return readStoredCfcMetadata(tx, {
      space: this.#spaceOf(doc),
      id: this.entityOf(doc),
      scope: cellScopeOf(doc),
    });
  }

  /** @inheritDoc */
  begin(cause: Transaction["cause"] | "send" | "watermark"): void {
    if (this.#tx !== undefined) {
      throw new Error("A transaction began while another was open.");
    }
    if (this.#given !== undefined) {
      // Every transaction the executor opens while the adapter holds a
      // handed transaction is written into that one, but the creation of a
      // load in bounded transactions, which is committed here.
      this.#cause = cause;
      if (this.#load === undefined || cause !== "creation") {
        this.#tx = this.#given.tx;
        return;
      }
      // The caller can have computed the argument from what it read in the
      // transaction it hands. The creation makes those reads too, so that
      // what it stores has the label it would have in that transaction
      // where no record gives it one.
      const creation = this.#edit();
      for (const read of this.#load.before) {
        creation.read({
          space: read.space,
          id: read.id,
          scope: read.scope,
          type: "application/json",
          path: [...read.path],
        }, {
          meta: read.meta,
          ...(read.nonRecursive ? { nonRecursive: true } : {}),
        });
      }
      this.#tx = creation;
      return;
    }
    this.#reportLabels();
    this.#cause = cause;
    this.#tx = this.#edit();
    this.#own.set(this.#tx.tx, undefined);
    this.#resetTransaction();
  }

  /** Forgets what the adapter kept of the transaction before. */
  #resetTransaction(): void {
    this.#read.clear();
    this.#readBeforeWrite.clear();
    this.#readAfterWrite.clear();
    this.#written.clear();
    this.#metadata.clear();
    this.#labelsOverRows.clear();
    this.#resetRecorded();
    this.#stagedState = 0;
    this.#created = [];
    this.#createdStreams = [];
    this.#splicedArrays.clear();
    this.#writtenAsSource.clear();
  }

  /**
   * Runs `run` with every transaction the executor opens in it written
   * into `tx`, which the caller commits: the adapter records the write
   * records with the runtime when `run` returns, and neither prepares nor
   * commits. Where a transaction of the executor did not commit, `tx` is
   * aborted. The executor is told of the labels the commit stored when the
   * replica applies it.
   */
  /**
   * A transaction of the runtime's for what the adapter reads or commits
   * itself. Every transaction a compiled piece commits stores its labels
   * as version-2 envelopes, each label of more than the inline limit as a
   * reference to a content-addressed label document of the space
   * (`docs/specs/content-addressed-cfc-labels.md`), whatever the runtime's
   * `cfcContentAddressedLabels` says for its other transactions (P452,
   * ruling Z95). The option only chooses how a label is spelled: either
   * version reads back as the same labels.
   */
  #edit(): IExtendedStorageTransaction {
    const tx = this.#runtime.edit();
    tx.setCfcContentAddressedLabels(true);
    return tx;
  }

  within<T>(
    tx: IExtendedStorageTransaction,
    run: () => T,
    /**
     * With `loadRows`, `run` is the load of an instance, in bounded
     * transactions. The adapter commits, before it returns:
     *
     * 1. The creation: the documents the instance makes for itself, so that
     *    a record of a later transaction whose input passes through one of
     *    them finds its label stored. Its transaction makes the reads that
     *    `tx` had made when the load began.
     * 2. The row documents, in transactions of at most `loadRows`: each row
     *    whose records name no position the load itself wrote and include
     *    one for the row whole. Such a transaction stores a row under the
     *    labels its records give, which name stored positions alone, so the
     *    row has the label it has when the load is done.
     *
     * Everything else, the links to the rows among it, is written into
     * `tx`. A load whose `tx` the caller wrote into before is written into
     * `tx` whole. Until the caller commits `tx`, the storage holds row documents
     * that no document links to. Where one of the adapter's commits is
     * refused, `tx` is aborted.
     */
    options: { loadRows?: number } = {},
  ): T {
    if (this.#tx !== undefined || this.#given !== undefined) {
      throw new Error("A transaction was handed while another was open.");
    }
    // What the piece commits through the handed transaction stores its
    // labels as references to content-addressed label documents.
    tx.setCfcContentAddressedLabels(true);
    this.#reportLabels();
    const given: Given = { tx, failed: undefined };
    this.#given = given;
    this.#resetTransaction();
    // A position that the caller wrote into `tx` holds its value and its
    // label there alone, which no other transaction reads, so such a load
    // is written into `tx` whole.
    this.#load = options.loadRows === undefined ||
        !Number.isFinite(options.loadRows) || options.loadRows < 1 ||
        tx.getWriteAttemptLog?.().length !== 0
      ? undefined
      : {
        rows: options.loadRows,
        tx: undefined,
        documents: [],
        before: [
          ...tx.getPotentiallyExternalReadActivities?.() ??
            tx.getReadActivities?.() ?? [],
        ],
      };
    let result: T;
    try {
      result = run();
    } catch (error) {
      this.#given = undefined;
      this.#tx = undefined;
      this.#endLoad(false);
      this.#dropCreated();
      this.#unchanged.clear();
      throw error;
    }
    this.#endLoad(given.failed === undefined);
    this.#given = undefined;
    if (given.failed !== undefined) {
      this.#dropCreated();
      this.#unchanged.clear();
      tx.abort(new Error(given.failed));
      return result;
    }
    this.#handOver(tx);
    return result;
  }

  /**
   * Records with `tx` what the transaction in progress recorded, and keeps
   * for it what its commit leaves to do: `tx` is one whose commit the
   * adapter hears of, and a refusal of it restores the documents it wrote.
   */
  #handOver(tx: IExtendedStorageTransaction): void {
    this.#recordWrites(tx);
    const handed: Handed = {
      unchanged: new Map(this.#unchanged),
      created: [...this.#created, ...this.#createdStreams],
      written: [...this.#written.keys()],
      tx,
    };
    this.#sources?.handed(tx, handed.written, this.#writtenAsSource);
    this.#unchanged.clear();
    this.#own.set(tx.tx, handed);
    tx.addCommitCallback((_tx, { error }) => {
      if (error === undefined) handed.settled = true;
      if (error === undefined || handed.refused === true) return;
      handed.refused = true;
      this.#sources?.refused(tx);
      this.#onRefused?.(
        `${error.name}: ${error.message}`,
        this.#restored(handed),
      );
    });
    this.#resetRecorded();
    this.#created = [];
    this.#createdStreams = [];
  }

  /**
   * Prepares and commits a transaction of a load in bounded transactions,
   * and has the handed transaction fail where the preparation refuses it.
   */
  #commitOfLoad(tx: IExtendedStorageTransaction): void {
    this.#runtime.prepareTxForCommit(tx);
    const { prepare } = tx.getCfcState();
    if (prepare.status === "invalidated" && this.#given !== undefined) {
      this.#given.failed ??=
        `The preparation refused a transaction of the load: ${
          prepare.reasons.join("; ")
        }`;
    }
    tx.commit();
  }

  /**
   * Commits the row documents written since the last transaction of rows,
   * with their records.
   */
  #commitRows(): void {
    const load = this.#load;
    if (load?.tx === undefined) return;
    const { tx, documents } = load;
    load.tx = undefined;
    load.documents = [];
    this.#recordWrites(tx, this.#rowContexts);
    this.#rowContexts.clear();
    const handed: Handed = {
      unchanged: new Map(),
      created: documents,
      written: documents,
      tx,
    };
    this.#own.set(tx.tx, handed);
    tx.addCommitCallback((_tx, { error }) => {
      if (error === undefined) handed.settled = true;
      if (error === undefined || handed.refused === true) return;
      handed.refused = true;
      this.#onRefused?.(
        `${error.name}: ${error.message}`,
        this.#restored(handed),
      );
    });
    this.#commitOfLoad(tx);
  }

  /** Ends a load in bounded transactions: `kept` where it did not fail. */
  #endLoad(kept: boolean): void {
    const load = this.#load;
    if (load === undefined) return;
    if (kept) this.#commitRows();
    else load.tx?.abort();
    this.#load = undefined;
    this.#rowContexts.clear();
    this.#rowsApart = undefined;
    this.#rowsStored.clear();
    this.#rowsHanded.clear();
  }

  /**
   * For a change of `doc` during a load in bounded transactions: the row
   * documents among its records that go into a transaction of rows, each
   * with its records. A row goes there where no transaction of the load
   * has written its document, one of its records is of the row whole, and
   * no record of it names an input the load wrote (`#namesStoredAlone`).
   */
  #rowsToStoreApart(
    doc: string,
    store: Store,
    rows: readonly RowArray[],
    writes: readonly PlanWrite[],
    inputs: InputsTable,
  ): Map<string, PlanWrite[]> {
    const found = new Map<string, { records: PlanWrite[]; whole: boolean }>();
    for (const write of writes) {
      const { target } = write;
      if (target.doc !== doc) continue;
      const array = rows.find(({ path }) =>
        target.path.length > path.length && isPrefix(path, target.path)
      );
      if (array === undefined) continue;
      const { length } = array.path;
      const key = /^\d+$/.test(target.path[length])
        ? store.rowKeys.get(array.text)?.()[Number(target.path[length])]
        : undefined;
      if (key === undefined) continue;
      const id = this.#rowDocument(array, key);
      let row = found.get(id);
      if (row === undefined) {
        row = { records: [], whole: false };
        found.set(id, row);
      }
      row.records.push(write);
      if (target.path.length === length + 1) row.whole = true;
    }
    const clean = new Map<number, boolean>();
    const apart = new Map<string, PlanWrite[]>();
    for (const [id, { records, whole }] of found) {
      if (
        whole && !this.#rowsHanded.has(id) && !this.#rowsStored.has(id) &&
        records.every((write) =>
          this.#namesStoredAlone(inputs, write.inputs, clean) &&
          (write.decided ?? []).every(({ address }) => !this.#wrote(address)) &&
          (write.observed ?? []).every(({ address }) => !this.#wrote(address))
        )
      ) apart.set(id, records);
    }
    return apart;
  }

  /**
   * Whether the entry `index` of the executor's table of inputs names
   * nothing but positions the storage holds: no position the transaction
   * in progress wrote, and no label of an output or of a staged position,
   * which only the transaction that writes them can give.
   */
  #namesStoredAlone(
    table: InputsTable,
    index: number,
    known: Map<number, boolean>,
  ): boolean {
    const held = known.get(index);
    if (held !== undefined) return held;
    // An entry that names itself through another is not taken apart.
    known.set(index, false);
    const place = table.inputs[index];
    const stored = (address: Address) => !this.#wrote(address);
    const slots = (bindings: SlotBindings) =>
      Object.values(bindings).every((at) => {
        const binding = table.bindings[at];
        if ("constant" in binding) return true;
        if (!("chain" in binding)) return false;
        return binding.chain.every(stored) &&
          (binding.below ?? []).every((chain) => chain.every(stored)) &&
          (binding.members ?? []).every(({ container }) => stored(container));
      });
    const nested = (at: number) => this.#namesStoredAlone(table, at, known);
    const result = slots(place.slots) &&
      Object.values(place.picks ?? {}).every((chosen) =>
        chosen === null || slots(chosen.slots)
      ) &&
      Object.values(place.elements ?? {}).every((elements) =>
        "uniform" in elements
          ? nested(elements.uniform)
          : elements.groups.every(({ inputs }) => nested(inputs))
      ) &&
      Object.values(place.dynamic ?? {}).every((addresses) =>
        addresses.every(stored)
      ) &&
      Object.values(place.outputs ?? {}).every(nested);
    known.set(index, result);
    return result;
  }

  /**
   * What the storage holds for each document a refused transaction wrote,
   * read from the replica when the refusal is known. The adapter keeps of
   * each what the storage holds: a document the storage does not hold is
   * written whole by its next change, and the keys of the rows of an array
   * of row documents are those of the links the storage holds there.
   */
  #restored(handed: Handed): Restored[] {
    // What the transaction wrote of a document of a scope, it wrote of the
    // instance of the identity it carried.
    const acting = handed.tx?.tx.scopeKeyIdentity;
    return this.actingFor(acting, () => this.#restoredFor(handed, acting));
  }

  /** `#restored()`, with the documents standing for the instances of `acting`. */
  #restoredFor(
    handed: Handed,
    acting: ScopeKeyIdentity | undefined,
  ): Restored[] {
    const restored: Restored[] = [];
    const tx = this.#edit();
    if (acting !== undefined) tx.tx.scopeKeyIdentity = acting;
    try {
      for (const doc of handed.created) this.#streams.delete(doc);
      for (const doc of handed.written) {
        const stored = tx.readValueOrThrow(this.#address(doc, []));
        if (stored === undefined) this.#documents.delete(doc);
        for (const array of this.#rowArrays.get(doc) ?? []) {
          const links = array.list === undefined
            ? valueAt(stored, array.path)
            : this.#storedRowLinks(tx, array, valueAt(stored, array.path));
          array.keys = (Array.isArray(links) ? links : []).flatMap((link) => {
            const row = isPrimitiveCellLink(link)
              ? this.#rowDocuments.get(
                this.documentOf(parseLink(link).id ?? ""),
              )
              : undefined;
            return row?.array === array ? [row.key] : [];
          });
          array.positions = undefined;
          // The executor takes the result document with the rows of each
          // collection left out, and its next derivation gives every row
          // as one that enters (`Instance.restore`). The list is laid out
          // anew by that change: it holds no row until then, and the
          // documents of the chunks the storage holds are removed with it.
          if (array.list !== undefined) {
            const { list } = array;
            for (const chunk of list.chunks ?? []) this.#dropChunk(list, chunk);
            list.chunks = undefined;
            list.top = true;
            array.keys = [];
          }
        }
        for (const record of this.#bucketRecordsOf(doc)) {
          const links = record.list === undefined
            ? valueAt(stored, record.path)
            : this.#storedBucketLinks(tx, record, valueAt(stored, record.path));
          record.keys = new Set(
            isWalkableObjectNotArray(links) ? Object.keys(links) : [],
          );
        }
        this.#metadata.delete(doc);
        restored.push({
          doc,
          value: stored === undefined ? undefined : this.#decode(
            stored,
            tx,
            this.#spaceOf(doc),
            cellScopeOf(doc),
            doc,
          ),
          ...(acting === undefined ? {} : { acting }),
        });
      }
    } finally {
      tx.abort();
    }
    return restored;
  }

  /** Forgets the documents the transaction in progress wrote first. */
  #dropCreated(): void {
    for (const doc of this.#created) this.#documents.delete(doc);
    for (const entity of this.#createdStreams) this.#streams.delete(entity);
    this.#created = [];
    this.#createdStreams = [];
  }

  /**
   * Tells the executor of the labels that the commit of a handed
   * transaction stored, when the replica applied it.
   */
  #applied(handed: Handed): void {
    this.#reportLabels(true);
    this.#reportUnchanged(handed.unchanged, true);
    this.#onApplied?.();
  }

  /** @inheritDoc */
  read(doc: string, path: readonly string[]): void {
    const tx = this.#open();
    const text = JSON.stringify([doc, path]);
    const wrote = this.#wrote({ doc, path });
    if (wrote && !this.#readAfterWrite.has(text)) {
      this.#readAfterWrite.add(text);
      this.#stagedState += 1;
    }
    if (this.#read.has(text)) return;
    this.#read.add(text);
    // A place of the executor's own that the storage holds no document of.
    if (
      this.#sources !== undefined && !doc.startsWith("of:") &&
      !this.#documents.has(doc)
    ) this.#sources.read(doc);
    if (!wrote) this.#readBeforeWrite.add(text);
    this.#counts.reads += 1;
    const address = this.#address(doc, path);
    const value = tx.readValueOrThrow(address);
    // A slot's chain names each link position the read crossed, which the
    // label of the slot takes as a reference-identity observation: the probe
    // that link resolution journals.
    if (this.#compiledPattern !== undefined && isPrimitiveCellLink(value)) {
      readMaybeLink(tx, address);
    }
    // A read at or above an array whose rows are documents of their own
    // reads every row.
    for (const array of this.#rowArrays.get(doc) ?? []) {
      if (!isPrefix(path, array.path)) continue;
      // The links are read too where documents of their own hold them.
      if (array.list?.linked === true) {
        tx.readValueOrThrow(this.#address(array.list.doc, []));
        for (const chunk of array.list.chunks ?? []) {
          tx.readValueOrThrow(this.#address(chunk.doc, []));
        }
      }
      for (const key of array.keys) {
        tx.readValueOrThrow(this.#address(this.#rowDocument(array, key), []));
      }
    }
    for (const record of this.#bucketRecordsOf(doc)) {
      if (isPrefix(path, record.path)) {
        // A read at or above a record of bucket documents reads every
        // bucket, and the links to them where documents of their own hold
        // those.
        if (record.list?.linked === true) {
          tx.readValueOrThrow(this.#address(record.list.doc, []));
        }
        for (const key of record.keys) {
          tx.readValueOrThrow(
            this.#address(this.#bucketDocument(record, key), []),
          );
        }
      } else if (isPrefix(record.path, path)) {
        // A read below a bucket crosses the link to its document, which
        // the result document holds at the bucket's member of the record,
        // or, where the links are in a document of their own, the link the
        // result document holds to that document and the link it holds to
        // the bucket.
        if (record.list !== undefined) {
          readMaybeLink(tx, this.#ownAddress(record.doc, record.path));
        }
        readMaybeLink(tx, this.#linkOfBucket(record, path));
      }
    }
  }

  /** @inheritDoc */
  labelOf(
    doc: string,
    path: readonly string[],
    observes = "value",
  ): string | undefined {
    if (this.#compiledPattern === undefined) return undefined;
    // The label of a position the transaction wrote, at its path, above it
    // or below it, is the staged one, which the storage does not hold.
    if (
      (this.#written.get(doc) ?? []).some((written) =>
        written.every((segment, index) =>
          index >= path.length || segment === path[index]
        )
      )
    ) return undefined;
    // A read of the value at or above an array whose rows are documents of
    // their own reads every row: its label is the join of what the read
    // consumes of the document itself and of each row's document.
    const arrays = observes !== "value"
      ? []
      : (this.#rowArrays.get(doc) ?? []).filter((array) =>
        isPrefix(path, array.path)
      );
    if (arrays.length > 0) {
      const text = JSON.stringify([doc, path]);
      let over = this.#labelsOverRows.get(text);
      if (over === undefined) {
        const parts = [
          this.#labelAt(this.#metadataOf(doc), path, "value"),
        ];
        for (const array of arrays) {
          for (const key of array.keys) {
            parts.push(
              this.#labelAt(
                this.#metadataOf(this.#rowDocument(array, key)),
                [],
                "value",
              ),
            );
          }
        }
        const joined = joinLabels(parts);
        over = this.#runtime.compiledPlans.labels.intern({
          confidentiality: [...joined.confidentiality ?? []],
          integrity: [...joined.integrity ?? []],
        }).id;
        this.#labelsOverRows.set(text, over);
      }
      return over;
    }
    // A read at or above a record of bucket documents reads every bucket,
    // and a read below a bucket crosses the link the result document holds
    // to it: its label is the join of what the read consumes of the
    // result document at that position, where the entry of the index
    // stands above it, and of the documents of the buckets read.
    const record = this.#bucketRecordsOf(doc).find((one) =>
      isPrefix(path, one.path) || isPrefix(one.path, path)
    );
    if (record !== undefined) {
      const below = path.length > record.path.length;
      if (below || observes === "value") {
        const text = JSON.stringify([doc, path, observes]);
        let over = this.#labelsOverRows.get(text);
        if (over === undefined) {
          const parts = below
            ? [
              this.#labelAt(
                this.#metadataOf(doc),
                path.slice(0, record.path.length + 1),
                "value",
              ),
              // The link to the bucket, where a document of the links
              // holds it.
              ...(record.list === undefined ? [] : [
                this.#labelAt(
                  this.#metadataOf(record.list.doc),
                  [path[record.path.length]],
                  "value",
                ),
              ]),
              this.#labelAt(
                this.#metadataOf(
                  this.#bucketDocument(record, path[record.path.length]),
                ),
                path.slice(record.path.length + 1),
                observes,
              ),
            ]
            : [
              this.#labelAt(this.#metadataOf(doc), path, "value"),
              ...[...record.keys].map((key) =>
                this.#labelAt(
                  this.#metadataOf(this.#bucketDocument(record, key)),
                  [],
                  "value",
                )
              ),
            ];
          const joined = joinLabels(parts);
          over = this.#runtime.compiledPlans.labels.intern({
            confidentiality: [...joined.confidentiality ?? []],
            integrity: [...joined.integrity ?? []],
          }).id;
          this.#labelsOverRows.set(text, over);
        }
        return over;
      }
    }
    const executorDoc = doc;
    ({ doc, path } = this.#placeOf(executorDoc, path));
    // The adapter hears of no commit of another space than its own.
    if (this.#spaces.has(doc)) {
      return this.#labelIn(this.#metadataOf(doc), path, observes);
    }
    let known = this.#labelIds.get(doc);
    if (known === undefined) {
      known = new Map();
      this.#labelIds.set(doc, known);
    }
    const text = `${observes}\n${JSON.stringify(path)}`;
    let id = known.get(text);
    if (id === undefined) {
      id = this.#labelIn(this.#metadataOf(doc), path, observes);
      known.set(text, id);
    }
    return id;
  }

  /**
   * The identifier `labelOf` found for each position of a document the
   * storage holds, by the class and the path, until a commit changes the
   * document. A `lift` over a whole list asks for the positions it read of
   * every member each time it runs.
   */
  readonly #labelIds = new ByDocumentInstance<Map<string, string>>((doc) =>
    this.#instanceOf(doc)
  );

  /**
   * The identifier `labelOf` found for a read of the value at or above an
   * array of row documents, by the text of the position, in the transaction
   * in progress. A write at or below the position gives it no identifier
   * from then on.
   */
  readonly #labelsOverRows = new Map<string, string>();

  /**
   * The stored labels of a document the storage holds, read once for the
   * transaction in progress. The entries of a document read here are the
   * ones a later change of its labels is compared with.
   */
  #metadataOf(doc: string): CfcMetadata | undefined {
    if (!this.#metadata.has(doc)) {
      const tx = this.#tx ?? this.#edit();
      try {
        const metadata = this.#storedLabels(tx, doc);
        this.#metadata.set(doc, metadata);
        if (!this.#entries.has(doc)) {
          this.#entries.set(doc, entriesOf(metadata));
          this.#entriesOf.set(doc, metadata);
        }
      } finally {
        if (tx !== this.#tx) tx.abort();
      }
    }
    return this.#metadata.get(doc);
  }

  /**
   * The label that a read of the class `observes` at `path` consumes of
   * the stored labels `metadata` of a document.
   */
  #labelAt(
    metadata: CfcMetadata | undefined,
    path: readonly string[],
    observes: string,
  ): IFCLabel | undefined {
    if (metadata === undefined) return undefined;
    // The class the runtime observes the position in (`observesOf`), read
    // as its observation of a label alone is: below the position too for a
    // read of the value, and at the position for the other classes. The
    // entries at, above and below the path are found through the index of
    // the document's entries, which is built once for a list of entries: a
    // document that holds the rows of a whole-list derivation has an entry
    // for each row.
    const consumes = observesOf(observes);
    return labelForConsumedEntries(
      consumedEntriesForRead(
        metadata,
        path,
        { nonRecursive: consumes !== "value", consumes },
        new ConsumedLabelIndex(metadata.labelMap.entries),
      ),
      path,
      consumes !== "value",
    );
  }

  /**
   * The identifier of the label that a read of the class `observes` at
   * `path` consumes of the stored labels `metadata` of a document.
   */
  #labelIn(
    metadata: CfcMetadata | undefined,
    path: readonly string[],
    observes: string,
  ): string {
    const table = this.#runtime.compiledPlans.labels;
    if (metadata === undefined) return table.empty.id;
    const consumes = observesOf(observes);
    // Where every entry of the document is at its root, as in a document
    // written under one schema with one clause, a read of one class
    // consumes one label at the root and one at every path below it.
    let known = this.#rootLabels.get(metadata);
    if (known === undefined) {
      known = metadata.labelMap.entries.every(({ path }) => path.length === 0)
        ? new Map()
        : null;
      this.#rootLabels.set(metadata, known);
    }
    const kind = `${consumes}${path.length === 0 ? " at the root" : ""}`;
    const held = known?.get(kind);
    if (held !== undefined) return held;
    const label = this.#labelAt(metadata, path, observes);
    // The table names a label by a hash of its content. The same label is
    // consumed at most positions, so its identifier is kept by its text.
    const text = JSON.stringify([
      label?.confidentiality ?? [],
      label?.integrity ?? [],
    ]);
    let id = this.#internedByText.get(text);
    if (id === undefined) {
      this.#counts.labelsResolved += 1;
      id = table.intern({
        confidentiality: [...label?.confidentiality ?? []],
        integrity: [...label?.integrity ?? []],
      }).id;
      this.#internedByText.set(text, id);
    }
    known?.set(kind, id);
    return id;
  }

  /** The identifier the runtime's table gave each label, by its text. */
  readonly #internedByText = new Map<string, string>();

  /**
   * For stored labels whose entries are all at the root of their document:
   * the identifier `#labelIn` found for a read of each class, at the root
   * and below it. `null` for stored labels with an entry at another path.
   */
  readonly #rootLabels = new WeakMap<CfcMetadata, Map<string, string> | null>();

  /** @inheritDoc */
  change(
    doc: string,
    path: readonly string[],
    store: Store,
    schema?: Schema,
    writes?: readonly PlanWrite[],
    splice?: { start: number; removed: number; inserted: number },
    inputs?: InputsTable,
    made?: { start: number; removed: number; inserted: number },
    declared?: DeclaredWrite,
  ): void {
    const tx = this.#open();
    this.#store = store;
    if (path.length === 0 && this.#heldWhole.delete(doc)) return;
    this.#listsWritten = [];
    this.#markersMade = [];
    // The records of the arrays of rows the change wrote, which give the
    // markers of streams it wrote their records (`#recordsOfMarkers`).
    const memberships = writes?.filter((record) =>
      record.target.doc === doc &&
      (record.membersChanged === true || record.membersAppended === true)
    ) ?? [];
    this.#counts.writes += 1;
    this.#stagedState += 1;
    // What a derivation writes is derived. What a handler, the creation
    // of the instance, a request or its completion writes is a source.
    if (this.#cause !== "derivation" && doc !== this.#owner) {
      this.#writtenAsSource.add(doc);
    }
    // The runtime that made a document enrolled it as a store the instance
    // owns. A runtime that resumed the instance enrolls it with its first
    // write of it.
    if (this.#heldBefore.delete(doc)) this.#enroll(tx, doc);
    this.#enrollKeptRow(tx, doc, path);
    const written = this.#written.get(doc) ?? [];
    this.#written.set(doc, written);
    const document = store.docs.get(doc);
    const attempts = tx.getWriteAttemptLog?.().length;
    const rows = this.#rowArraysOf(doc, store);
    this.#rowsHeld.clear();
    // The array of rows the change is of, where it is one, and whether the
    // change is of a path above such an array.
    const array = rows.find((one) => samePath(one.path, path));
    const buckets = this.#bucketRecordsOf(doc);
    const above =
      rows.some((one) =>
        one.path.length > path.length && isPrefix(path, one.path)
      ) || buckets.some((one) => isPrefix(path, one.path));
    // The record of bucket documents the change is of one member of.
    const bucket = buckets.find((one) =>
      path.length === one.path.length + 1 && isPrefix(one.path, path)
    );
    // The address the storage holds a path of the document at: that of a
    // row document for a path below a row that is one.
    const at = (below: readonly string[]) => this.#address(doc, below);
    // During a load in bounded transactions, the rows of this change that
    // are stored by a transaction of rows (`#writeRow`).
    if (
      this.#load !== undefined && this.#given !== undefined &&
      tx === this.#given.tx && rows.length > 0 && writes !== undefined &&
      inputs !== undefined && this.#compiledPattern !== undefined
    ) {
      this.#rowsApart = {
        records: this.#rowsToStoreApart(doc, store, rows, writes, inputs),
        inputs,
        recorded: new Set(),
      };
    }
    // A write below a row that a transaction of rows stored makes the row
    // one the handed transaction writes.
    const below = this.#rowsStored.size === 0
      ? undefined
      : this.#placeOf(doc, path);
    if (below !== undefined && below.doc !== doc) {
      this.#rowsStored.delete(below.doc);
      this.#rowsHanded.add(below.doc);
    }
    // Whether the change was written as the positions of a splice, which
    // are then the paths written, and the path of the change is not.
    let spliced = false;
    // Whether the change is the first write of a document the storage does
    // not hold.
    const creates = document !== undefined && !this.#documents.has(doc);
    if (document === undefined) {
      if (!this.#documents.delete(doc)) return;
      tx.writeValueOrThrow(this.#address(doc, []), undefined, {
        delete: true,
      });
    } else if (!this.#documents.has(doc)) {
      // A document the storage does not hold yet is written whole: the
      // first write below the root of a declared place makes the document
      // from the place's default, and the change names only the path
      // written.
      this.#documents.add(doc);
      this.#created.push(doc);
      if (doc !== this.#owner) this.#sources?.made(doc);
      // The executor makes the result document of a resumed instance empty
      // and derives into it, and the storage keeps what it holds until a
      // path of the derivation differs.
      if (
        !(this.#resume && doc === this.#owner && document.value === undefined)
      ) {
        const whole = this.#encodeWithRows(
          tx,
          store,
          rows,
          [],
          document.value,
          buckets,
        );
        tx.writeValueOrThrow(this.#address(doc, []), whole);
        // A protected field of an argument document that the argument left
        // out, and that holds the default of its type, is a seed, and one
        // the maker supplies is the maker's write
        // (`recordNewDocumentProtectedDefaults`).
        const filled = this.#filledDefaults.get(doc);
        const declaredFor = this.#declared.of(doc);
        if (
          filled !== undefined && declaredFor !== undefined &&
          isWalkableObjectNotArray(whole)
        ) {
          recordNewDocumentProtectedDefaults(
            tx,
            this.#address(doc, []),
            declaredFor.policy.schema,
            whole,
            Object.fromEntries(
              Object.entries(whole).filter(([name]) => !filled.includes(name)),
            ),
            whole,
          );
        }
        if (isStateCellSeed(document, path, schema, writes)) {
          const seeded = this.#address(doc, []);
          recordStateCellSeed(tx, seeded, whole);
          // The state cell is a document of the piece the transaction
          // brings into being for the principal it acts for.
          if (this.#attributedIn === tx) {
            tx.markCfcAttributedInitialization(
              runtimeWritePolicyAuthorization,
              { space: seeded.space, id: seeded.id, scope: seeded.scope },
            );
          }
        }
      }
      this.#enroll(tx, doc);
      this.#linkToResult(tx, doc);
    } else if (array !== undefined || above) {
      const held = store.peek(doc, path);
      const cut = made ?? splice;
      if (array !== undefined && cut !== undefined && Array.isArray(held)) {
        // The records of a splice the executor gives as one of positions
        // (`splice`) are of those positions; the record of any other names
        // the array. An addition at the end of the array is written as
        // the number of members and the links it adds
        // (`#recordAppended`), and any other change of the members writes
        // the array whole, as links.
        const record = writes?.find(({ target }) =>
          target.doc === doc && samePath(target.path, path)
        );
        const appended = splice === undefined && cut.removed === 0 &&
          cut.inserted > 0 && cut.start + cut.inserted === held.length &&
          record?.membersAppended === true && inputs !== undefined;
        spliced = splice !== undefined || appended;
        this.#spliceRows(tx, store, array, held, cut, written, spliced);
        if (array.list !== undefined) {
          // The links of the array are in documents of their own, and the
          // transaction writes those and not the path of the array, which
          // holds the link to the list. The record of the array is that of
          // a write that left the path as it was, so the path keeps the
          // label of the membership as the record gives it now, and it is
          // the record of each document of the list that was written.
          if (record !== undefined && inputs !== undefined) {
            this.#record([record], true, inputs);
            this.#record(this.#recordsOfLists(() => record), false, inputs);
            writes = writes?.filter((write) => write !== record);
          }
        } else if (appended) {
          this.#recordAppended(array, record, cut, inputs);
          writes = writes?.filter((write) => write !== record);
        }
        // The executor gives a record for each position behind the splice,
        // which an array that holds its rows in place writes again. The
        // document of a row that stayed is not written, and the record of
        // its row is the one it has.
        const { length } = array.path;
        writes = writes?.filter(({ target }) => {
          if (
            target.doc !== doc || target.path.length <= length ||
            !isPrefix(array.path, target.path)
          ) return true;
          const index = Number(target.path[length]);
          return index >= cut.start && index < cut.start + cut.inserted;
        });
      } else {
        tx.writeValueOrThrow(
          this.#address(doc, path),
          this.#encodeWithRows(tx, store, rows, path, held, buckets),
        );
      }
    } else if (bucket !== undefined) {
      // A bucket that changed is written as its document, and one that
      // came to exist also as the link to it. A bucket that emptied loses
      // its document and its link.
      const key = path[path.length - 1];
      const held = store.peek(doc, path);
      const record = writes?.find(({ target }) =>
        target.doc === doc && samePath(target.path, path)
      );
      if (held === undefined) {
        if (bucket.keys.delete(key)) {
          tx.writeValueOrThrow(
            this.#address(this.#bucketDocument(bucket, key), []),
            undefined,
            { delete: true },
          );
          tx.writeValueOrThrow(this.#linkOfBucket(bucket, path), undefined, {
            delete: true,
          });
        }
      } else {
        const link = this.#writeBucket(tx, bucket, key, held);
        if (!bucket.keys.has(key)) {
          bucket.keys.add(key);
          if (bucket.list?.linked === false) {
            // The record was not written whole before its first bucket.
            this.#writeBucketLinks(tx, bucket, { [key]: link });
            tx.writeValueOrThrow(
              this.#ownAddress(bucket.doc, bucket.path),
              this.#linkTo(bucket.list.doc),
            );
          } else {
            tx.writeValueOrThrow(this.#linkOfBucket(bucket, path), link);
          }
        }
      }
      // The document of a bucket is written under no record of the plan,
      // and so is its link: each stores the join of what the transaction
      // read. The transaction reads the index at its own position in the
      // result document, so that join holds the entry of the index. A read
      // of a bucket stored in place consumes that entry, which stands above
      // it, and a read that follows the link to the document does not.
      tx.readValueOrThrow(
        this.#ownAddress(bucket.doc, [...bucket.path.slice(0, -1), "kind"]),
      );
      writes = writes?.filter((write) => write !== record);
    } else {
      const parent = path.length === 0
        ? undefined
        : store.peek(doc, path.slice(0, -1));
      const absent = path.length > 0 && isWalkableObjectNotArray(parent) &&
        !Object.hasOwn(parent, path[path.length - 1]);
      // A handler that puts an array in the place of the array the storage
      // holds, with members added behind those it held, wrote the added
      // positions: the storage is given those and the number of members, as
      // for a splice, so that a claim the schema declares for a member is
      // decided for the members the handler added and for no other. It is
      // done where the schema of the write, or the type the handler declares
      // for the handle, declares a policy for a member. Where the executor
      // spliced the stored array, as it does for a push, its splice says
      // which members were added, and no member is compared.
      if (
        splice === undefined && this.#cause === "event" &&
        (declaresMemberPolicy(schema) ||
          declaresMemberPolicy(declared?.schema))
      ) {
        const now = store.peek(doc, path);
        splice = appendedBySplice(made, Array.isArray(now) ? now.length : -1);
      }
      if (
        splice === undefined && made === undefined &&
        this.#cause === "event" &&
        (declaresMemberPolicy(schema) ||
          declaresMemberPolicy(declared?.schema))
      ) {
        const stored = tx.readValueOrThrow(at(path), {
          meta: ignoreReadForScheduling,
        });
        splice = appendedBehind(
          stored,
          store.peek(doc, path),
          (member) => this.#encode(member),
        );
        // Where the storage holds no array yet, the empty one is written
        // first, and the members behind it.
        if (splice !== undefined && stored === undefined) {
          tx.writeValueOrThrow(at(path), []);
        }
      }
      const held = splice === undefined ? undefined : store.peek(doc, path);
      if (splice !== undefined && Array.isArray(held)) {
        // A splice of a stored array writes the number of members and the
        // positions it changed, and no position before it: the labels
        // stored for those stay with them. The number is written first, so
        // that it is a write of its own where the array grows.
        const moved = splice.removed !== splice.inserted;
        const end = moved ? held.length : splice.start + splice.inserted;
        spliced = true;
        if (moved) {
          written.push([...path, "length"]);
          tx.writeValueOrThrow(at([...path, "length"]), held.length);
        }
        for (let index = splice.start; index < end; index++) {
          written.push([...path, `${index}`]);
          tx.writeValueOrThrow(
            at([...path, `${index}`]),
            this.#encode(held[index]),
          );
        }
      } else if (absent) {
        tx.writeValueOrThrow(at(path), undefined, { delete: true });
      } else {
        tx.writeValueOrThrow(at(path), this.#encode(store.peek(doc, path)));
      }
    }
    // A change at or above a record of bucket documents wrote each bucket
    // whole. The record the executor gave for the path of the index is that
    // of each bucket's document too, which then stores the label of the
    // index and not the join of what the transaction read.
    if (document !== undefined && writes !== undefined) {
      const given: readonly PlanWrite[] = writes;
      const ofBuckets: PlanWrite[] = [];
      for (const record of buckets) {
        if (!isPrefix(path, record.path)) continue;
        const ofIndex = given.findLast(({ target }) =>
          target.doc === doc && isPrefix(target.path, record.path)
        );
        if (ofIndex === undefined) continue;
        for (const key of record.keys) {
          ofBuckets.push({
            ...ofIndex,
            target: { doc, path: [...record.path, key] },
          });
        }
      }
      // The documents of lists that the change wrote whole have the
      // record of the path the list stands at, or of the nearest path
      // above it that has one.
      const ofLists = this.#recordsOfLists((at) =>
        given.findLast(({ target }) =>
          target.doc === doc && isPrefix(target.path, at)
        )
      );
      const ofMarkers = this.#recordsOfMarkers(
        doc,
        path,
        store,
        memberships,
        splice,
      );
      if (ofBuckets.length > 0 || ofLists.length > 0 || ofMarkers.length > 0) {
        writes = [...given, ...ofBuckets, ...ofLists, ...ofMarkers];
      }
    }
    if (
      this.#resuming && attempts !== undefined &&
      tx.getWriteAttemptLog?.().length === attempts
    ) return;
    if (this.#rowsApart !== undefined) {
      // No transaction of rows stays open behind the change: a later read
      // or write of a row through the handed transaction finds it stored.
      this.#commitRows();
      const { recorded } = this.#rowsApart;
      this.#rowsApart = undefined;
      if (recorded.size > 0) {
        writes = writes?.filter((write) => !recorded.has(write));
      }
    }
    if (!spliced) written.push([...path]);
    // A write can change the label of a value a reader's own value does
    // not change with, so the label entries the document stores before
    // the transaction are kept as for a write that changes no value.
    if (this.#compiledPattern !== undefined) {
      this.#noteUnchanged(this.#placeOf(doc, path).doc);
    }
    // The write policy of the write, as a cell's write records it
    // (`Cell.set`): the schema the write was made under where it declares
    // labels, and otherwise the schema the document's stored labels name.
    // A schema of a plan is a JSON schema with the members the executor
    // reads typed (`Schema` of `exec/store.ts`).
    // A handler's write of the value the storage holds logs no write: the
    // executor can hold a place as absent that the storage holds with its
    // default. The write was attempted all the same, and is marked as the
    // attempt it is (`unchanged`).
    if (
      this.#cause === "event" && document !== undefined &&
      attempts !== undefined &&
      tx.getWriteAttemptLog?.().length === attempts
    ) {
      tx.readValueOrThrow(at(path), {
        meta: { ...ignoreReadForScheduling, ...markReadAsAttemptedWrite },
      });
    }
    this.#recordSchema(tx, doc, path, schema, store);
    // A handler's write also answers to the write policies its own state
    // type declares for the handle, as a write through a cell of today's
    // path answers to the schema of the cell: the policy is recorded at the
    // position the handle names.
    const own = declared === undefined || declared.schema === schema
      ? undefined
      : declaredBy(declared.schema);
    if (own !== undefined) {
      this.#recordSchema(
        tx,
        declared!.doc,
        declared!.path,
        own.schema as Schema,
        store,
      );
    }
    if (doc === this.#owner) this.#recordResultPolicy(tx, path, store);
    else this.#recordDeclaredPolicy(tx, doc, path, store, creates);
    if (this.#compiledPattern === undefined) return;
    // A write of the value the storage holds is no write of the
    // transaction: its records are given as those of a write that left the
    // value as it was, so the path stores the label of the write for the
    // value it holds. A transaction that keeps no log of its writes gives
    // every record as that of a write.
    if (writes === undefined || writes.length === 0) return;
    if (inputs === undefined) {
      throw new Error(
        "Write records were given without their table of inputs.",
      );
    }
    // A row document that was written with what it held is not written: the
    // records of its row are those of a write that left the value as it
    // was, as the records of a change that wrote nothing are.
    const held = this.#rowsHeld.size === 0
      ? []
      : writes.filter((write) =>
        this.#rowsHeld.has(
          this.#placeOf(write.target.doc, write.target.path).doc,
        )
      );
    if (held.length > 0) {
      this.#record(held, true, inputs);
      const kept = new Set(held);
      writes = writes.filter((write) => !kept.has(write));
      if (writes.length === 0) return;
    }
    this.#record(
      writes,
      attempts !== undefined && tx.getWriteAttemptLog?.().length === attempts,
      inputs,
    );
  }

  /**
   * The arrays of a document whose rows are stored as documents of their
   * own, with those the executor's store names since the last call.
   */
  #rowArraysOf(doc: string, store: Store): RowArray[] {
    if (this.#rowCollections.size === 0 || doc !== this.#owner) return [];
    let arrays = this.#rowArrays.get(doc);
    if (arrays === undefined) {
      arrays = [];
      this.#rowArrays.set(doc, arrays);
    }
    if (arrays.length < this.#rowCollections.size) {
      for (const [text, collection] of store.rowCollections) {
        if (!this.#rowCollections.has(collection)) continue;
        const [of, path] = JSON.parse(text) as [string, string[]];
        if (of !== doc || arrays.some((one) => one.text === text)) continue;
        const array: RowArray = {
          doc,
          path,
          text,
          keys: [],
          ids: new Map(),
          links: new Map(),
        };
        if (this.#lists) {
          array.list = {
            doc: identifierOf({ list: [doc, ...path] }),
            linked: false,
            chunks: undefined,
            dirty: new Set(),
            dropped: [],
            top: true,
            ids: new Set(),
            next: 0,
            adopted: false,
          };
          this.#listDocuments.set(array.list.doc, array);
          // The entity is known as that of the list from here on, also to
          // a resumed instance that reads a link to it.
          this.entityOf(array.list.doc);
        }
        arrays.push(array);
        this.#rowArraysNamed += 1;
      }
    }
    return arrays;
  }

  /**
   * The address of a path of a document of the executor in the document
   * itself, where `#address` gives that of a row or of a bucket for a path
   * below one.
   */
  #ownAddress(doc: string, path: readonly string[]): NormalizedFullLink {
    return {
      space: this.#spaceOf(doc),
      id: this.entityOf(doc),
      path: [...path],
      scope: "space",
    };
  }

  /** The link to a document of the executor, whole. */
  #linkTo(doc: string): FabricValue {
    return createSigilLinkFromParsedLink({
      id: this.entityOf(doc),
      space: this.#spaceOf(doc),
      path: [],
    });
  }

  /**
   * Writes a document that holds links of a list stored apart from the
   * result document, whole. `at` is the path of the result document that
   * the list stands at (`#listsWritten`).
   */
  #writeListDocument(
    tx: IExtendedStorageTransaction,
    doc: string,
    value: FabricValue,
    at: readonly string[],
  ): void {
    const address = this.#address(doc, []);
    const attempts = tx.getWriteAttemptLog?.().length;
    tx.writeValueOrThrow(address, value);
    this.#enroll(tx, doc);
    // The write policy of the write, as `change` records it for a path.
    recordRelevantSchemaWritePolicyInput(tx, address, undefined);
    this.#counts.listDocumentsWritten += 1;
    // A write of what the document holds is no write of the transaction,
    // and has no record.
    if (
      attempts === undefined ||
      tx.getWriteAttemptLog?.().slice(attempts).some((attempt) =>
        attempt.id === address.id
      )
    ) this.#listsWritten.push({ doc, at });
  }

  /**
   * The documents of lists that the change being written wrote whole, each
   * with the path of the result document that the array of rows or the
   * record of buckets it belongs to stands at. `change` gives each the
   * record of that path, so that the document stores the label of the
   * membership and not the join of what the transaction read.
   */
  #listsWritten: { doc: string; at: readonly string[] }[] = [];

  /**
   * The records of the documents of `#listsWritten`: for each, `of` with
   * the root of the document as its target, as the record of a write that
   * names no change of members.
   */
  #recordsOfLists(
    of: (at: readonly string[]) => PlanWrite | undefined,
  ): PlanWrite[] {
    const records: PlanWrite[] = [];
    for (const { doc, at } of this.#listsWritten.splice(0)) {
      const record = of(at);
      if (record === undefined) continue;
      const {
        enumeration: _enumeration,
        removes: _removes,
        moves: _moves,
        start: _start,
        relabel: _relabel,
        membersChanged: _changed,
        membersAppended: _appended,
        ...plain
      } = record;
      records.push({ ...plain, target: { doc, path: [] } });
    }
    return records;
  }

  /**
   * The records of the markers of streams that the change of `path` of `doc`
   * wrote (`#markersMade`). A marker says that its stream exists, and the
   * stream of a binding in an element body exists while the collection has
   * the element, so the marker of a stream with element keys has the record
   * of the membership of each collection that holds its row: the record
   * the change gave the array that holds the row, at the array
   * (`membersChanged`, `membersAppended`; `arrays`). That is the label a
   * record of
   * what the marker depends on gives it (ruling Z96;
   * `plan-and-label-templates.md` §2.6, "A row of the stream index"), where
   * the marker would otherwise take the join of what the transaction read.
   * A marker of a stream with no element key, or of a row whose array the
   * change gives no record, is left with that join.
   */
  #recordsOfMarkers(
    doc: string,
    path: readonly string[],
    store: Store,
    arrays: readonly PlanWrite[],
    splice: { start: number; removed: number; inserted: number } | undefined,
  ): PlanWrite[] {
    const made = this.#markersMade.splice(0).filter(({ stream }) =>
      stream.keys.length > 0
    );
    if (made.length === 0 || arrays.length === 0) return [];
    // A splice wrote the members it put in, and only those can hold a
    // marker it made: what is looked at follows what was written.
    const held = store.peek(doc, path);
    const wanted = new Set<object>(made.map(({ stream }) => stream));
    const paths = new Map<object, string[]>();
    if (splice !== undefined && Array.isArray(held)) {
      for (
        let position = splice.start;
        position < splice.start + splice.inserted && position < held.length;
        position++
      ) {
        for (const [stream, below] of streamPaths(held[position], wanted)) {
          paths.set(stream, [`${position}`, ...below]);
        }
      }
    } else {
      for (const [stream, below] of streamPaths(held, wanted)) {
        paths.set(stream, below);
      }
    }
    const records: PlanWrite[] = [];
    for (const { entity, stream } of made) {
      const below = paths.get(stream);
      if (below === undefined) continue;
      const at = [...path, ...below];
      for (const record of arrays) {
        if (
          record.target.path.length >= at.length ||
          !isPrefix(record.target.path, at)
        ) continue;
        const {
          enumeration: _enumeration,
          removes: _removes,
          moves: _moves,
          start: _start,
          relabel: _relabel,
          membersChanged: _changed,
          membersAppended: _appended,
          ...plain
        } = record;
        records.push({ ...plain, target: { doc: entity, path: [] } });
      }
    }
    return records;
  }

  /** A chunk of `length` links of a list, in a document not yet in use. */
  #newChunk(array: RowArray, length: number): ListChunk {
    const list = array.list!;
    let doc: string;
    do {
      doc = identifierOf({
        list: [array.doc, ...array.path],
        chunk: list.next++,
      });
    } while (list.ids.has(doc));
    list.ids.add(doc);
    this.#listDocuments.set(doc, array);
    const chunk = { doc, length };
    list.dirty.add(chunk);
    return chunk;
  }

  /** Takes a chunk out of the layout of a list; its document is removed. */
  #dropChunk(list: LinkList, chunk: ListChunk): void {
    list.dropped.push(chunk.doc);
    list.ids.delete(chunk.doc);
    list.dirty.delete(chunk);
    list.top = true;
  }

  /**
   * Lays the links of an array of `length` rows out anew: in the list
   * document itself for at most `#listWhole` rows, and otherwise in chunks
   * of `LIST_FILL`.
   */
  #layOutList(array: RowArray, length: number): void {
    const list = array.list!;
    for (const chunk of list.chunks ?? []) this.#dropChunk(list, chunk);
    list.top = true;
    if (length <= this.#listWhole) {
      list.chunks = undefined;
      return;
    }
    list.chunks = [];
    for (let at = 0; at < length; at += LIST_FILL) {
      list.chunks.push(this.#newChunk(array, Math.min(LIST_FILL, length - at)));
    }
  }

  /**
   * Applies a splice of the rows of an array to the layout of its list:
   * `removed` rows leave at `start`, and `inserted` enter there.
   *
   * The rows that leave are taken from the chunks that hold them, and a
   * chunk that holds none any more leaves the list. The rows that enter go
   * into the chunk that holds the position, or into the last where they
   * are appended. A chunk that then holds more than `LIST_CHUNK` links is
   * split: one that grew at the end of the list keeps `LIST_CHUNK` links
   * and the rest go into chunks behind it, and any other is split into
   * chunks of equal length of at most `LIST_FILL`. A chunk that is left
   * with fewer than a quarter of `LIST_CHUNK` joins the chunk beside it
   * where the two hold at most `LIST_FILL` together. So one row that
   * enters, leaves or moves writes at most three chunks, and the list of
   * the chunks only where a chunk came to exist or ceased to. A list that
   * shrinks to half of `#listWhole` rows is stored in the list document
   * again.
   */
  #spliceList(
    array: RowArray,
    start: number,
    removed: number,
    inserted: number,
  ): void {
    const list = array.list!;
    if (list.chunks === undefined) {
      list.top = true;
      if (array.keys.length > this.#listWhole) {
        this.#layOutList(array, array.keys.length);
      }
      return;
    }
    const chunks = list.chunks;
    const touched = new Set<ListChunk>();
    let offset = 0;
    for (const chunk of chunks) {
      const next = offset + chunk.length;
      const from = Math.max(start, offset);
      const to = Math.min(start + removed, next);
      if (to > from) {
        chunk.length -= to - from;
        touched.add(chunk);
      }
      offset = next;
    }
    if (inserted > 0) {
      // The first chunk that ends at or behind the position.
      let at = 0;
      offset = 0;
      while (at < chunks.length - 1 && start > offset + chunks[at].length) {
        offset += chunks[at].length;
        at += 1;
      }
      const chunk = chunks[at];
      const appended = at === chunks.length - 1 &&
        start === offset + chunk.length;
      chunk.length += inserted;
      touched.add(chunk);
      if (chunk.length > LIST_CHUNK) {
        const total = chunk.length;
        const lengths: number[] = [];
        if (appended) {
          for (let left = total; left > 0; left -= LIST_CHUNK) {
            lengths.push(Math.min(LIST_CHUNK, left));
          }
        } else {
          const pieces = Math.ceil(total / LIST_FILL);
          for (let piece = 0; piece < pieces; piece++) {
            lengths.push(
              Math.floor(total / pieces) + (piece < total % pieces ? 1 : 0),
            );
          }
        }
        chunk.length = lengths[0];
        spliceIn(
          chunks,
          at + 1,
          0,
          lengths.slice(1).map((length) => this.#newChunk(array, length)),
        );
        list.top = true;
      }
    }
    for (const chunk of touched) {
      const at = chunks.indexOf(chunk);
      if (at < 0) continue;
      if (chunk.length === 0) {
        chunks.splice(at, 1);
        this.#dropChunk(list, chunk);
        continue;
      }
      list.dirty.add(chunk);
      if (chunk.length >= LIST_CHUNK / 4) continue;
      const beside = chunks[at + 1] ?? chunks[at - 1];
      if (
        beside === undefined || beside.length === 0 ||
        beside.length + chunk.length > LIST_FILL
      ) continue;
      // The earlier of the two keeps the links of both.
      const [kept, gone] = chunks[at + 1] === beside
        ? [chunk, beside]
        : [beside, chunk];
      kept.length += gone.length;
      list.dirty.add(kept);
      chunks.splice(chunks.indexOf(gone), 1);
      this.#dropChunk(list, gone);
    }
    if (array.keys.length <= this.#listWhole / 2) {
      for (const chunk of chunks) this.#dropChunk(list, chunk);
      list.chunks = undefined;
    }
  }

  /**
   * Writes the documents of the list of an array of row documents that do
   * not hold what the list holds now, and returns the link to the list.
   */
  #flushList(tx: IExtendedStorageTransaction, array: RowArray): FabricValue {
    const list = array.list!;
    for (const doc of list.dropped.splice(0)) {
      if (list.ids.has(doc)) continue;
      tx.writeValueOrThrow(this.#address(doc, []), undefined, { delete: true });
    }
    let offset = 0;
    for (const chunk of list.chunks ?? []) {
      if (list.dirty.has(chunk)) {
        this.#counts.rowLinks += chunk.length;
        this.#writeListDocument(
          tx,
          chunk.doc,
          array.keys.slice(offset, offset + chunk.length).map((key) =>
            this.#linkOfRow(array, key)
          ),
          array.path,
        );
      }
      offset += chunk.length;
    }
    list.dirty.clear();
    if (list.top) {
      list.top = false;
      if (list.chunks === undefined) this.#counts.rowLinks += array.keys.length;
      this.#writeListDocument(
        tx,
        list.doc,
        list.chunks === undefined
          ? array.keys.map((key) => this.#linkOfRow(array, key))
          : list.chunks.map((chunk) => this.#linkTo(chunk.doc)),
        array.path,
      );
    }
    return this.#linkTo(list.doc);
  }

  /**
   * The links to the rows of an array, in order, as the storage holds them
   * in the documents of its list, where `held` is what the result document
   * holds at the path of the array. The layout of the list is set to the
   * one the storage holds.
   */
  #storedRowLinks(
    tx: IExtendedStorageTransaction,
    array: RowArray,
    held: unknown,
  ): unknown[] {
    const list = array.list!;
    for (const doc of list.ids) this.#listDocuments.delete(doc);
    list.ids.clear();
    list.dirty.clear();
    list.dropped = [];
    list.chunks = undefined;
    list.linked = isPrimitiveCellLink(held) &&
      parseLink(held).id === this.entityOf(list.doc);
    list.top = !list.linked;
    if (!list.linked) return [];
    const members = tx.readValueOrThrow(this.#address(list.doc, []));
    if (!Array.isArray(members)) {
      list.top = true;
      return [];
    }
    const links: unknown[] = [];
    const chunks: ListChunk[] = [];
    for (const member of members) {
      // The document of a chunk is named as the adapter names one it
      // makes: by the identifier its entity holds after `of:`.
      const entity = isPrimitiveCellLink(member)
        ? parseLink(member).id
        : undefined;
      const doc = entity?.startsWith("of:")
        ? entity.slice("of:".length)
        : entity;
      const below = doc === undefined
        ? undefined
        : tx.readValueOrThrow(this.#address(doc, []));
      // A row is a record or a view node, so a member that leads to an
      // array is a chunk.
      if (doc === undefined || !Array.isArray(below)) {
        links.push(member);
        continue;
      }
      chunks.push({ doc, length: below.length });
      list.ids.add(doc);
      this.#listDocuments.set(doc, array);
      for (const link of below) links.push(link);
    }
    if (chunks.length > 0) list.chunks = chunks;
    return links;
  }

  /**
   * Brings the layout of the list of an array to the keys the array holds
   * now, `array.keys`, where it held `was` before: the one run of keys
   * that differs is applied as a splice, so the chunks outside it stay as
   * they are.
   */
  #relayList(array: RowArray, was: readonly string[]): void {
    const list = array.list!;
    const now = array.keys;
    // A resumed instance writes the array whole first. The layout the
    // storage holds is kept where it holds as many links as the array has
    // rows, and each document is then written with what it holds, which is
    // no write.
    if (this.#resume && !list.adopted) {
      list.adopted = true;
      const read = this.#edit();
      let stored: number;
      try {
        stored = this.#storedRowLinks(
          read,
          array,
          read.readValueOrThrow(this.#ownAddress(array.doc, array.path)),
        ).length;
      } finally {
        read.abort();
      }
      list.top = true;
      if (stored === now.length && list.linked) {
        for (const chunk of list.chunks ?? []) list.dirty.add(chunk);
        return;
      }
      this.#layOutList(array, now.length);
      return;
    }
    list.adopted = true;
    if (!list.linked) {
      this.#layOutList(array, now.length);
      return;
    }
    const shorter = Math.min(was.length, now.length);
    let start = 0;
    while (start < shorter && was[start] === now[start]) start += 1;
    let end = 0;
    while (
      end < shorter - start &&
      was[was.length - 1 - end] === now[now.length - 1 - end]
    ) end += 1;
    const removed = was.length - end - start;
    const inserted = now.length - end - start;
    if (removed === 0 && inserted === 0) return;
    this.#spliceList(array, start, removed, inserted);
  }

  /**
   * Writes the links to the buckets of a record, each by its encoded key,
   * into the document of the links, whole, and returns the link to it.
   */
  #writeBucketLinks(
    tx: IExtendedStorageTransaction,
    record: BucketRecord,
    links: Record<string, FabricValue>,
  ): FabricValue {
    const list = record.list!;
    this.#writeListDocument(tx, list.doc, links, record.path);
    list.linked = true;
    return this.#linkTo(list.doc);
  }

  /**
   * The links to the buckets of a record, each by its encoded key, as the
   * storage holds them in the document of the links, where `held` is what
   * the result document holds at the path of the record.
   */
  #storedBucketLinks(
    tx: IExtendedStorageTransaction,
    record: BucketRecord,
    held: unknown,
  ): Record<string, unknown> {
    const list = record.list!;
    list.linked = isPrimitiveCellLink(held) &&
      parseLink(held).id === this.entityOf(list.doc);
    if (!list.linked) return {};
    const links = tx.readValueOrThrow(this.#address(list.doc, []));
    return isWalkableObjectNotArray(links) ? links : {};
  }

  /** The identifier of the document of the row of `key` of an array. */
  #rowDocument(array: RowArray, key: string): string {
    let id = array.ids.get(key);
    if (id === undefined) {
      id = identifierOf({ rows: [array.doc, ...array.path], key });
      array.ids.set(key, id);
      if (!this.#rowDocuments.has(id)) {
        this.#rowDocuments.set(id, { array, key });
      }
    }
    return id;
  }

  /**
   * The link to the document of the row of `key` of an array: one value
   * for each key, so that an array written again holds, at a position
   * whose row stayed, the link it held.
   */
  #linkOfRow(array: RowArray, key: string): FabricValue {
    let link = array.links.get(key);
    if (link === undefined) {
      const id = this.#rowDocument(array, key);
      link = createSigilLinkFromParsedLink({
        id: this.entityOf(id),
        space: this.#spaceOf(id),
        path: [],
      });
      array.links.set(key, link);
    }
    return link;
  }

  /**
   * The arrays of row documents that the transaction in progress spliced
   * so that positions behind the splice shifted, each with the transaction
   * the array is written into. The links of such an array are written
   * once, when the transaction ends (`#writeSplicedArrays`), however many
   * splices it made.
   */
  readonly #splicedArrays = new Map<RowArray, IExtendedStorageTransaction>();

  /**
   * Writes each array of `#splicedArrays` as the links it holds now, under
   * a read of the array.
   */
  #writeSplicedArrays(): void {
    for (const [array, tx] of this.#splicedArrays) {
      const at: NormalizedFullLink = {
        space: this.#spaceOf(array.doc),
        id: this.entityOf(array.doc),
        path: [...array.path],
        scope: "space",
      };
      tx.readValueOrThrow(at);
      tx.writeValueOrThrow(
        at,
        array.keys.map((key) => this.#linkOfRow(array, key)),
      );
      this.#counts.rowArraysWritten += 1;
    }
    this.#splicedArrays.clear();
  }

  /** The records of bucket documents of a document of the executor. */
  #bucketRecordsOf(doc: string): readonly BucketRecord[] {
    return doc === this.#owner ? this.#bucketRecords : [];
  }

  /** The identifier of the document of the bucket of `key` of a record. */
  #bucketDocument(record: BucketRecord, key: string): string {
    const id = identifierOf({ buckets: [record.doc, ...record.path], key });
    if (!this.#bucketDocuments.has(id)) {
      this.#bucketDocuments.set(id, { record, key });
    }
    return id;
  }

  /**
   * The position of the result document that holds the link to the bucket
   * that `path`, a path at or below the bucket, is of.
   */
  #linkOfBucket(
    record: BucketRecord,
    path: readonly string[],
  ): NormalizedFullLink {
    // Where the links are in a document of their own, that document holds
    // the link, at the key.
    if (record.list !== undefined) {
      return {
        ...this.#address(record.list.doc, []),
        path: [path[record.path.length]],
      };
    }
    return {
      space: this.#spaceOf(record.doc),
      id: this.entityOf(record.doc),
      path: path.slice(0, record.path.length + 1),
      scope: "space",
    };
  }

  /** Writes the document of a bucket whole, and returns the link to it. */
  #writeBucket(
    tx: IExtendedStorageTransaction,
    record: BucketRecord,
    key: string,
    value: unknown,
  ): FabricValue {
    const id = this.#bucketDocument(record, key);
    const address = this.#address(id, []);
    tx.writeValueOrThrow(address, this.#encode(value));
    this.#enroll(tx, id);
    // The write policy of the write, as `change` records it for a path.
    recordRelevantSchemaWritePolicyInput(tx, address, undefined);
    return createSigilLinkFromParsedLink({
      id: address.id,
      space: address.space,
      path: [],
    });
  }

  /**
   * Where the storage holds a path of a document of the executor: a path
   * below a row that is a document of its own is a path of that document,
   * a path at or below a bucket that is one is a path of that document,
   * and every other path is itself.
   */
  #placeOf(doc: string, path: readonly string[]): Address {
    for (const record of this.#bucketRecordsOf(doc)) {
      const { length } = record.path;
      if (path.length <= length || !isPrefix(record.path, path)) continue;
      return {
        doc: this.#bucketDocument(record, path[length]),
        path: path.slice(length + 1),
      };
    }
    for (const array of this.#rowArrays.get(doc) ?? []) {
      const { length } = array.path;
      if (path.length <= length || !isPrefix(array.path, path)) continue;
      const key = /^\d+$/.test(path[length])
        ? array.keys[Number(path[length])]
        : undefined;
      if (key === undefined) break;
      return {
        doc: this.#rowDocument(array, key),
        path: path.slice(length + 1),
      };
    }
    return { doc, path: [...path] };
  }

  /**
   * Where the storage holds what a reference by key into an array of row
   * documents names: the document of the row of that key, and the path
   * below the row. Nothing for any other path.
   */
  #rowByKey(doc: string, path: readonly string[]): Address | undefined {
    for (const array of this.#rowArrays.get(doc) ?? []) {
      const { length } = array.path;
      if (
        path.length <= length || !isPrefix(array.path, path) ||
        !isKeySegment(path[length])
      ) continue;
      return {
        doc: this.#rowDocument(array, path[length]),
        path: path.slice(length + 1),
      };
    }
    return undefined;
  }

  /**
   * The executor's address of a path of a document the storage holds: for a
   * row document, the path below the position of its row.
   */
  #addressOfStored(doc: string, path: readonly string[]): Address {
    const bucket = this.#bucketDocuments.get(doc);
    if (bucket !== undefined) {
      return {
        doc: bucket.record.doc,
        path: [...bucket.record.path, bucket.key, ...path],
      };
    }
    const row = this.#rowDocuments.get(doc);
    if (row === undefined) return { doc, path: [...path] };
    const { array, key } = row;
    if (array.positions === undefined) {
      array.positions = new Map(array.keys.map((one, index) => [one, index]));
    }
    return {
      doc: array.doc,
      path: [...array.path, `${array.positions.get(key) ?? -1}`, ...path],
    };
  }

  /** Writes the document of a row whole, and returns the link to it. */
  #writeRow(
    tx: IExtendedStorageTransaction,
    array: RowArray,
    key: string,
    value: unknown,
  ): FabricValue {
    const id = this.#rowDocument(array, key);
    const address = this.#address(id, []);
    // During a load in bounded transactions, a row whose records name
    // stored positions alone is written into a transaction of rows, with
    // those records.
    const load = this.#load;
    const apart = load === undefined
      ? undefined
      : this.#rowsApart?.records.get(id);
    if (load !== undefined && apart !== undefined) {
      tx = load.tx ??= this.#edit();
    }
    const attempts = tx.getWriteAttemptLog?.().length;
    tx.writeValueOrThrow(address, this.#encode(value));
    // A write of what the document holds is no write of the transaction:
    // the log gains no attempt at the row's document. The first write of a
    // transaction can log an attempt at another document.
    if (
      attempts !== undefined &&
      !tx.getWriteAttemptLog?.().slice(attempts).some((attempt) =>
        attempt.id === address.id
      )
    ) this.#rowsHeld.add(id);
    else this.#rowsHeld.delete(id);
    // A row that the handed transaction of a load writes is one of its
    // own from then on.
    if (load !== undefined && apart === undefined && !this.#rowsHeld.has(id)) {
      this.#rowsStored.delete(id);
      this.#rowsHanded.add(id);
    }
    this.#enroll(tx, id);
    if (!this.#rowsHeld.has(id)) this.#linkToResult(tx, id);
    // The write policy of the write, as `change` records it for a path.
    recordRelevantSchemaWritePolicyInput(tx, address, undefined);
    if (load !== undefined && apart !== undefined && this.#rowsApart) {
      this.#recordingRows = true;
      try {
        this.#record(apart, false, this.#rowsApart.inputs);
      } finally {
        this.#recordingRows = false;
      }
      for (const write of apart) this.#rowsApart.recorded.add(write);
      this.#rowsStored.add(id);
      load.documents.push(id);
      if (load.documents.length >= load.rows) this.#commitRows();
    }
    return createSigilLinkFromParsedLink({
      id: address.id,
      space: address.space,
      path: [],
    });
  }

  /**
   * A value of a document at `path` as the storage holds it: `#encode`,
   * with each row of an array of `rows` at or below the path written as a
   * document of its own and a link to it in its place.
   */
  #encodeWithRows(
    tx: IExtendedStorageTransaction,
    store: Store,
    rows: readonly RowArray[],
    path: readonly string[],
    value: unknown,
    buckets: readonly BucketRecord[] = [],
  ): FabricValue {
    const record = buckets.find((one) => samePath(one.path, path));
    if (record !== undefined) {
      // The record of the buckets: each bucket as its document and a link
      // to it. The document of a bucket the record holds no more is
      // removed.
      const members = isWalkableObjectNotArray(value) ? value : {};
      for (const key of record.keys) {
        if (Object.hasOwn(members, key)) continue;
        record.keys.delete(key);
        tx.writeValueOrThrow(
          this.#address(this.#bucketDocument(record, key), []),
          undefined,
          { delete: true },
        );
      }
      const links = Object.fromEntries(
        Object.entries(members).map(([key, bucket]) => {
          record.keys.add(key);
          return [key, this.#writeBucket(tx, record, key, bucket)];
        }),
      );
      return record.list === undefined
        ? links
        : this.#writeBucketLinks(tx, record, links);
    }
    const array = rows.find((one) => samePath(one.path, path));
    if (array !== undefined) {
      if (!Array.isArray(value)) {
        this.#dropRows(tx, array, array.keys);
        array.keys = [];
        array.positions = undefined;
        if (array.list?.linked === true) {
          // The path holds the value in place again, and the documents of
          // the list are removed.
          const { list } = array;
          for (const chunk of list.chunks ?? []) this.#dropChunk(list, chunk);
          list.chunks = undefined;
          list.dropped.push(list.doc);
          this.#flushListDropped(tx, list);
          list.linked = false;
          list.top = true;
        }
        return this.#encode(value);
      }
      const keys = [...(store.rowKeys.get(array.text)?.() ?? [])];
      if (keys.length !== value.length) {
        throw new Error("The executor named no key for a row of an array.");
      }
      const now = new Set(keys);
      const was = array.keys;
      this.#dropRows(tx, array, array.keys.filter((key) => !now.has(key)));
      array.keys = keys;
      array.positions = undefined;
      const links = value.map((row, index) =>
        this.#writeRow(tx, array, keys[index], row)
      );
      if (array.list === undefined) return links;
      // The links go into the documents of the list, and the path holds
      // the link to it.
      this.#relayList(array, was);
      const link = this.#flushList(tx, array);
      array.list.linked = true;
      return link;
    }
    const on = rows.filter((one) =>
      one.path.length > path.length && isPrefix(path, one.path)
    );
    const inside = buckets.filter((one) =>
      one.path.length > path.length && isPrefix(path, one.path)
    );
    if (on.length === 0 && inside.length === 0) return this.#encode(value);
    // An array of rows can stand below a member of an array, as the
    // children of a view node do.
    if (Array.isArray(value)) {
      return value.map((member, index) =>
        this.#encodeWithRows(
          tx,
          store,
          on,
          [...path, `${index}`],
          member,
          inside,
        )
      );
    }
    if (!isWalkableObjectNotArray(value)) return this.#encode(value);
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => [
        name,
        this.#encodeWithRows(tx, store, on, [...path, name], member, inside),
      ]),
    );
  }

  /** Removes the documents a list holds no more, without writing any. */
  #flushListDropped(tx: IExtendedStorageTransaction, list: LinkList): void {
    for (const doc of list.dropped.splice(0)) {
      tx.writeValueOrThrow(this.#address(doc, []), undefined, { delete: true });
    }
    list.dirty.clear();
  }

  /** Removes the documents of the rows of `keys`. */
  #dropRows(
    tx: IExtendedStorageTransaction,
    array: RowArray,
    keys: readonly string[],
  ): void {
    for (const key of keys) {
      const id = this.#rowDocument(array, key);
      if (this.#keptArrays.has(array) && !this.#keptEnrolled.has(id)) {
        this.#keptEnrolled.add(id);
        this.#enroll(tx, id);
      }
      tx.writeValueOrThrow(this.#address(id, []), undefined, { delete: true });
      array.ids.delete(key);
      array.links.delete(key);
    }
  }

  /**
   * Writes a splice of an array whose rows are documents of their own: the
   * document of each row that entered, whole, the number of members where
   * it changed, and a link at each position the splice changed. The
   * document of a row that left is removed.
   */
  #spliceRows(
    tx: IExtendedStorageTransaction,
    store: Store,
    array: RowArray,
    held: readonly unknown[],
    splice: { start: number; removed: number; inserted: number },
    written: (readonly string[])[],
    positions: boolean,
  ): void {
    const { doc, path } = array;
    const keys = store.rowKeys.get(array.text)?.() ?? [];
    const entered = keys.slice(splice.start, splice.start + splice.inserted);
    if (entered.length !== splice.inserted) {
      throw new Error("The executor named no key for a row that entered.");
    }
    const left = spliceIn(array.keys, splice.start, splice.removed, entered);
    array.positions = undefined;
    const stay = new Set(entered);
    this.#dropRows(tx, array, left.filter((key) => !stay.has(key)));
    const linkAt = (index: number): FabricValue => {
      const key = array.keys[index];
      if (
        index >= splice.start && index < splice.start + splice.inserted
      ) {
        this.#writeRow(tx, array, key, held[index]);
      }
      return this.#linkOfRow(array, key);
    };
    // A position of the array is written at the array itself, which
    // `#address` would take for a path of the row's document.
    const here = (below: string[]): NormalizedFullLink => ({
      space: this.#spaceOf(doc),
      id: this.entityOf(doc),
      path: [...path, ...below],
      scope: "space",
    });
    // Where the links are in documents of their own, the rows that
    // entered are written, and then the chunks the splice touches, under a
    // read of the link to the list. The path of the array is written only
    // where it does not hold that link yet. The paths the executor counts
    // as written are those of an array that holds its links in place.
    if (array.list !== undefined) {
      for (let offset = 0; offset < splice.inserted; offset++) {
        linkAt(splice.start + offset);
      }
      this.#spliceList(array, splice.start, splice.removed, splice.inserted);
      tx.readValueOrThrow(here([]));
      const link = this.#flushList(tx, array);
      if (!array.list.linked) {
        tx.writeValueOrThrow(here([]), link);
        array.list.linked = true;
      }
      if (!positions) return;
      const shifted = splice.removed !== splice.inserted;
      if (shifted) written.push([...path, "length"]);
      const last = shifted ? held.length : splice.start + splice.inserted;
      for (let index = splice.start; index < last; index++) {
        written.push([...path, `${index}`]);
      }
      return;
    }
    // A change of the members that is not given as one of positions writes
    // the array, as the links it holds when the transaction ends
    // (`#writeSplicedArrays`), and the rows that entered now. A row that
    // moves is taken out by one such change and put in by another, and the
    // array is written once for the two.
    if (!positions) {
      this.#counts.rowLinks += held.length;
      for (let offset = 0; offset < splice.inserted; offset++) {
        linkAt(splice.start + offset);
      }
      this.#splicedArrays.set(array, tx);
      return;
    }
    const moved = splice.removed !== splice.inserted;
    const end = moved ? held.length : splice.start + splice.inserted;
    // A splice in the middle of a long array shifts every position behind
    // it, and the array is then written in the same way, under a read of
    // the array. A later splice of an array that waits for that write waits
    // with it, since the transaction does not hold the array it would
    // write positions of. The paths written are the same either way.
    const whole = this.#splicedArrays.has(array) ||
      (moved && end - splice.start > SPLICE_AS_POSITIONS);
    if (moved) {
      written.push([...path, "length"]);
      if (!whole) tx.writeValueOrThrow(here(["length"]), held.length);
    }
    this.#counts.rowLinks += Math.max(0, end - splice.start);
    for (let index = splice.start; index < end; index++) {
      written.push([...path, `${index}`]);
      const link = index < splice.start + splice.inserted || !whole
        ? linkAt(index)
        : undefined;
      if (!whole) tx.writeValueOrThrow(here([`${index}`]), link);
    }
    if (whole) this.#splicedArrays.set(array, tx);
  }

  /**
   * Records an addition at the end of an array whose rows are documents of
   * their own, which was written as the number of members and the links
   * added. `record` is the record of the array, which names what decides
   * its members: it is recorded for the array as that of a write that left
   * the path as it was, since the transaction holds no write of the array
   * itself, and for each path written, so that the number and each link
   * added have the label of the membership and not the join of everything
   * the transaction read.
   */
  #recordAppended(
    array: RowArray,
    record: PlanWrite,
    splice: { start: number; inserted: number },
    inputs: InputsTable,
  ): void {
    this.#record([record], true, inputs);
    const { membersAppended: _appended, ...positional } = record;
    const below = ["length"];
    for (let offset = 0; offset < splice.inserted; offset++) {
      below.push(`${splice.start + offset}`);
    }
    this.#record(
      below.map((segment) => ({
        ...positional,
        target: { doc: array.doc, path: [...array.path, segment] },
      })),
      false,
      inputs,
      true,
    );
  }

  /**
   * Records the schema write-policy input of a write at `path` of `doc`
   * under `schema`, the schema of the reference the write was made through.
   * A write at or below a member of an array is recorded at the outermost
   * array on the way: a schema input is spelled from its path with each
   * segment as a named property, and the envelope the document stores
   * spells an array as an array, so an input at a path through an index
   * does not merge with it. The schema of the write is then spelled from
   * that array, an index as its `items`; a write under a schema that
   * declares no label answers to the schema the document stores there.
   */
  #recordSchema(
    tx: IExtendedStorageTransaction,
    doc: string,
    path: readonly string[],
    schema: Schema | undefined,
    store: Store,
  ): void {
    // A path below a row that is a document of its own is spelled from the
    // root of that document.
    const stored = this.#placeOf(doc, path);
    const base = path.length - stored.path.length;
    const isIndex = (at: number) =>
      at >= base && /^(0|[1-9][0-9]*)$/.test(path[at]) &&
      Array.isArray(store.peek(doc, path.slice(0, at)));
    const first = path.findIndex((_, at) => isIndex(at));
    if (first < 0) {
      recordRelevantSchemaWritePolicyInput(
        tx,
        this.#address(doc, path),
        schema as JSONSchema | undefined,
      );
      return;
    }
    let spelled = schema as JSONSchema | undefined;
    for (let at = path.length - 1; at >= first; at--) {
      if (typeof spelled !== "object") break;
      spelled = isIndex(at)
        ? { type: "array", items: spelled }
        : { type: "object", properties: { [path[at]]: spelled } };
    }
    recordRelevantSchemaWritePolicyInput(
      tx,
      this.#address(doc, path.slice(0, first)),
      typeof spelled === "object" ? spelled : undefined,
    );
  }

  /**
   * Records, for a write at `path` of the result document, the write
   * policies the result type declares (`writePoliciesOf`), once for each
   * transaction, so that the write answers to them. Where the write leaves
   * a reference at a path that declares a writer claim, and is no write of
   * a handler, the reference is recorded as a binding the runtime staged
   * there (CFC specification §8.15.4, `08-15-write-authority.md`: "The
   * reference that exposes the new cell is protected in its own right"):
   * the claim then holds for every change of the reference that the
   * piece's own derivation does not make, and the value the reference names
   * is written under the policy of its own document.
   */
  #recordResultPolicy(
    tx: IExtendedStorageTransaction,
    path: readonly string[],
    store: Store,
  ): void {
    const policy = this.#resultPolicy;
    const owner = this.#owner;
    if (policy === undefined || owner === undefined) return;
    if (this.#resultPolicyIn !== tx) {
      this.#resultPolicyIn = tx;
      recordRelevantSchemaWritePolicyInput(
        tx,
        this.#address(owner, []),
        policy.schema,
      );
    }
    if (this.#cause === "event") return;
    for (const claimed of policy.claimed) {
      if (!isPrefix(path, claimed) && !isPrefix(claimed, path)) continue;
      const held = store.peek(owner, claimed);
      if (!isLink(held)) continue;
      const at = this.#address(owner, claimed);
      tx.recordCfcWritePolicyInput({
        kind: "initialization",
        mode: "binding",
        target: { space: at.space, id: at.id, scope: at.scope, path: at.path },
        value: this.#encode(held),
      }, runtimeWritePolicyAuthorization);
    }
  }

  /**
   * Records, for the write that makes an argument document or the result
   * document of an instance a body or a handler made, the write policies
   * the type of its pattern declares (`DeclaredPolicies`), so that the
   * write answers to them and the stored envelope names them. A reference at a path that
   * declares a writer claim is recorded as a binding the runtime staged
   * there where the write is the one that makes an argument document, in
   * which the maker hands the instance its cells, or a derivation's write
   * of a result document (CFC specification §8.15.4,
   * `08-15-write-authority.md`: "The reference that exposes the new cell is
   * protected in its own right"). A plain value at such a path is the
   * write of whoever wrote it, and answers to the claim.
   */
  #recordDeclaredPolicy(
    tx: IExtendedStorageTransaction,
    doc: string,
    path: readonly string[],
    store: Store,
    creates: boolean,
  ): void {
    const declared = this.#declared.of(doc);
    if (declared === undefined) return;
    const { policy, of } = declared;
    // The schema is recorded by the transaction that makes the document.
    // A later write answers to the envelope that transaction stored, as a
    // later write of today's path does, and the schema is not recorded
    // again: the stored envelope is held to its shape, and a schema that
    // requires a field would be read as a change of it.
    if (creates) {
      recordRelevantSchemaWritePolicyInput(
        tx,
        this.#address(doc, []),
        policy.schema,
      );
    }
    if (of === "argument" ? !creates : this.#cause === "event") return;
    for (const claimed of policy.claimed) {
      if (!isPrefix(path, claimed) && !isPrefix(claimed, path)) continue;
      const held = store.peek(doc, claimed);
      if (!isLink(held)) continue;
      const at = this.#address(doc, claimed);
      tx.recordCfcWritePolicyInput({
        kind: "initialization",
        mode: "binding",
        target: { space: at.space, id: at.id, scope: at.scope, path: at.path },
        value: this.#encode(held),
      }, runtimeWritePolicyAuthorization);
    }
  }

  /**
   * Keeps the label entries a document stores before the transaction in
   * progress stores, for a write that left a value of the document as it
   * was, the label of that write.
   */
  #noteUnchanged(doc: string): void {
    if (this.#unchanged.has(doc)) return;
    // The entries kept of a document no commit changed since are the ones
    // it stores.
    const kept = this.#touched.has(doc) ? undefined : this.#entries.get(doc);
    if (kept !== undefined) {
      this.#unchanged.set(doc, kept);
      if (this.#entriesOf.has(doc)) {
        this.#labelsOfEntries.set(kept, this.#entriesOf.get(doc));
      }
      return;
    }
    const tx = this.#edit();
    try {
      const stored = this.#storedLabels(tx, doc);
      const entries = entriesOf(stored);
      this.#labelsOfEntries.set(entries, stored);
      this.#unchanged.set(doc, entries);
    } finally {
      tx.abort();
    }
  }

  /**
   * The stored labels that each map of label entries kept for
   * `#reportUnchanged` was made of, so that a change of the entries can be
   * told from a change of the label a read consumes
   * (`LabelChange.unchanged`).
   */
  readonly #labelsOfEntries = new WeakMap<
    Map<string, string>,
    CfcMetadata | undefined
  >();

  /**
   * Tells the executor of the label entries that the transaction that just
   * committed changed in the documents of `#unchanged`, where it changed
   * a label and no value, and counts them.
   */
  #reportUnchanged(unchanged = this.#unchanged, stored = false): void {
    if (unchanged.size === 0) return;
    const changes: LabelChange[] = [];
    const tx = this.#edit();
    try {
      for (const [doc, before] of unchanged) {
        const now = this.#storedLabels(tx, doc);
        const after = entriesOf(now);
        const { paths, alone } = changedLabelPaths(before, after);
        if (paths.length === 0) continue;
        this.#counts.labelEntriesChanged += paths.length;
        // Where the labels the document stored before are known, a record
        // that read a path is given again only where a read of the path
        // consumes another label than before, as for a change that
        // `#reportLabels` tells of: an entry stored for an appended member
        // changes the entries below the array, and no label that a read of
        // the reference at the array consumes.
        const known = this.#labelsOfEntries.has(before);
        const was = this.#labelsOfEntries.get(before);
        const answered = new Map<string, boolean>();
        changes.push({
          doc,
          paths,
          ...(alone.length > 0 ? { alone } : {}),
          ...(known
            ? {
              unchanged: (path: readonly string[], observes: string) => {
                const asked = `${observes}\n${JSON.stringify(path)}`;
                let answer = answered.get(asked);
                if (answer === undefined) {
                  answer = this.#labelIn(was, path, observes) ===
                    this.#labelIn(now, path, observes);
                  answered.set(asked, answer);
                }
                return answer;
              },
            }
            : {}),
        });
      }
    } finally {
      tx.abort();
      unchanged.clear();
    }
    if (changes.length > 0) {
      this.#labelsChanged?.(this.#toExecutor(changes), true, stored);
    }
  }

  /** @inheritDoc */
  unchanged(
    doc: string,
    path: readonly string[],
    store: Store,
    schema: Schema | undefined,
    writes: readonly PlanWrite[],
    inputs: InputsTable,
    attempt?: { declared?: DeclaredWrite },
  ): void {
    if (this.#compiledPattern === undefined) return;
    const tx = this.#open();
    // A handler's write of the value a position holds is an attempt to
    // write it, which a write policy of the position is held to as it is
    // for a write that changes the value: the read is marked as today's
    // write of an equal value marks its read (`diffAndUpdate`), and the
    // policies the handler's own state type declares are recorded as for
    // a change.
    if (this.#cause === "event" && attempt !== undefined) {
      const { declared } = attempt;
      tx.readValueOrThrow(this.#address(doc, path), {
        meta: { ...ignoreReadForScheduling, ...markReadAsAttemptedWrite },
      });
      const own = declared === undefined || declared.schema === schema
        ? undefined
        : declaredBy(declared.schema);
      if (own !== undefined) {
        this.#recordSchema(
          tx,
          declared!.doc,
          declared!.path,
          own.schema as Schema,
          store,
        );
      }
    }
    // The write policy of each path a record names, as `change` records it
    // for a write: the label is stored under the policy a write of the
    // path is held to.
    for (const target of new Set(writes.map((write) => write.target))) {
      this.#recordSchema(
        tx,
        target.doc,
        target.path,
        target.doc === doc &&
          JSON.stringify(target.path) === JSON.stringify(path)
          ? schema
          : undefined,
        store,
      );
    }
    this.#record(writes, true, inputs);
  }

  /**
   * Keeps each write record as the runtime reads it, for the end of the
   * transaction (`#recordWrites`): `unchanged` for a write that left the
   * value at its target as it was. The inputs a record names in `table`,
   * the executor's table of inputs, become entries of the runtime's, each
   * distinct one once for the transaction.
   */
  #record(
    writes: readonly PlanWrite[],
    unchanged: boolean,
    table: InputsTable,
    /**
     * The targets are positions of an array of row documents themselves,
     * which hold the links, and not paths of the rows' documents.
     */
    links = false,
  ): void {
    if (this.#compiledPattern === undefined || this.#resuming) return;
    // The records of one change of the members of a list hold one array of
    // what the change compared, which is given to the runtime as one
    // object.
    const observed = (positions: readonly Observed[]) =>
      positions.map(({ address, observes, alone }) => ({
        address: this.#cfcAddress(address),
        observes: observesOf(observes),
        ...(alone ? { alone: true as const } : {}),
      }));
    const decidedOf = new Map<readonly Observed[], RuntimeObserved[]>();
    for (const write of writes) {
      // The record names a record of the plan of the instance that made
      // the write, and its inputs in the table of that compiled pattern.
      const pattern = this.#patternOf.get(write.instance) ??
        this.#compiledPattern;
      this.#use(pattern);
      let decided = write.decided === undefined
        ? undefined
        : decidedOf.get(write.decided);
      if (write.decided !== undefined && decided === undefined) {
        decided = observed(write.decided);
        decidedOf.set(write.decided, decided);
      }
      // The records are recorded with the runtime when the transaction
      // ends (`#recordWrites`), those that differ in their target alone as
      // one.
      this.#recorded.writes.push({
        inputs: this.#inputs(table, write.inputs),
        target: links
          ? {
            space: this.#spaceOf(write.target.doc),
            id: this.entityOf(write.target.doc),
            scope: cellScopeOf(write.target.doc),
            path: write.target.path,
          }
          : this.#cfcAddress(write.target),
        compiledPattern: pattern,
        record: write.record,
        instance: write.instance,
        keys: write.keys,
        ...(unchanged ? { unchanged: true as const } : {}),
        ...(decided === undefined ? {} : { decided }),
        ...(write.observed === undefined
          ? {}
          : { observed: observed(write.observed) }),
        ...(write.enumeration ? { enumeration: true as const } : {}),
        ...(write.removes ? { removes: true as const } : {}),
        ...(write.moves === undefined ? {} : { moves: write.moves }),
        ...(write.start === undefined ? {} : { start: write.start }),
        ...(write.relabel ? { relabel: true as const } : {}),
        ...(write.bound ? { bound: true as const } : {}),
        ...(write.membersChanged ? { membersChanged: true as const } : {}),
        ...(write.membersAppended ? { membersAppended: true as const } : {}),
      });
      if (unchanged) {
        this.#counts.unchangedRecords += 1;
        this.#noteUnchanged(
          this.#placeOf(write.target.doc, write.target.path).doc,
        );
      }
    }
  }

  /**
   * Records the write records of the transaction in progress with the
   * runtime, as authorized `plan-write` inputs behind the `plan-inputs`
   * input that holds the table they name: one record for those that name
   * one record of the plan and one entry of the table and differ only in
   * a member of one container or in the document (`mergedPlanWrites`).
   */
  #recordWrites(
    tx: IExtendedStorageTransaction,
    contexts: ReadonlyMap<string, Context> = this.#contexts,
  ): void {
    if (this.#compiledPattern === undefined) return;
    // The runtime's mark: this adapter stands in for the runner, which
    // records what its own code computed.
    const record = (
      input: Parameters<
        IExtendedStorageTransaction["recordCfcWritePolicyInput"]
      >[0],
    ) => {
      if (this.#countRecordBytes) {
        this.#counts.recordBytes += JSON.stringify(input).length;
      }
      tx.recordCfcWritePolicyInput(input, runtimeWritePolicyAuthorization);
    };
    for (const { pattern, recorded } of contexts.values()) {
      const { writes, interner } = recorded;
      if (writes.length === 0) continue;
      const part = interner.take();
      if (part !== undefined) {
        record({ kind: "plan-inputs", compiledPattern: pattern, ...part });
      }
      const merged = mergedPlanWrites(writes);
      this.#counts.recordsGiven += writes.length;
      this.#counts.recordsRecorded += merged.length;
      for (const write of merged) record({ kind: "plan-write", ...write });
      this.#onRecorded?.(writes);
    }
  }

  /**
   * Has `listener` hear the write records of each transaction as they are
   * recorded with the runtime, before any is merged with another.
   */
  onRecorded(listener: (writes: readonly RuntimePlanWrite[]) => void): void {
    this.#onRecorded = listener;
  }

  /**
   * The positions a body read through a handle as a write record lists
   * them: one address for each group of positions whose stored labels have
   * one identifier, for a read of the value and for the reference observed
   * there, and the number of positions and of groups where that leaves a
   * position out. The label of the reads is the join of the labels of the
   * positions, so the positions of a group add to it what the listed one
   * adds. A position with no identifier, such as one the transaction in
   * progress wrote, is listed itself. The grouping follows ruling Z75 (c),
   * which names the members of one container by one member of each group.
   */
  #groupedReads(addresses: readonly Address[]): {
    listed: CfcAddress[];
    groups?: { positions: number; groups: number };
  } {
    const seen = new Set<string>();
    const listed: CfcAddress[] = [];
    for (const address of addresses) {
      const value = this.labelOf(address.doc, address.path, "value");
      const reference = value === undefined
        ? undefined
        : this.labelOf(address.doc, address.path, "identity");
      if (value !== undefined && reference !== undefined) {
        const key = `${value}|${reference}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      listed.push(this.#cfcAddress(address));
      for (const link of this.#crossedBucketLink(address)) listed.push(link);
    }
    return listed.length === addresses.length ? { listed } : {
      listed,
      groups: { positions: addresses.length, groups: listed.length },
    };
  }

  /**
   * The index, in the runtime's table of inputs of the transaction in
   * progress, of the entry `index` of the executor's table `table`, as the
   * runtime reads it. An entry is given an index again where what decides
   * whether one of its bindings takes a staged label changed since
   * (`#stagedState`), and the same index where it reads as it did.
   */
  #inputs(table: InputsTable, index: number): number {
    if (this.#converted?.table !== table) {
      this.#converted = { table, bindings: new Map(), inputs: new Map() };
    }
    const known = this.#converted.inputs.get(index);
    if (known?.state === this.#stagedState) return known.index;
    const { interner } = this.#recorded;
    const place = table.inputs[index];
    const entries = <T, U>(
      record: Record<number, T> | undefined,
      as: (value: T) => U,
    ): Record<number, U> | undefined =>
      record === undefined ? undefined : Object.fromEntries(
        Object.entries(record).map(([at, value]) => [at, as(value)]),
      );
    const elements = (given: FoldElements): PlanElements =>
      "uniform" in given ? { uniform: this.#inputs(table, given.uniform) } : {
        groups: given.groups.map(({ inputs, count }) => ({
          inputs: this.#inputs(table, inputs),
          count,
        })),
      };
    // The reads through a handle, with one address for each group of
    // positions that hold one label (`#groupedReads`).
    const dynamic = place.dynamic === undefined
      ? undefined
      : entries(place.dynamic, (addresses) => this.#groupedReads(addresses));
    const grouped = Object.entries(dynamic ?? {}).filter(([, { groups }]) =>
      groups !== undefined
    );
    const formed = interner.inputs({
      slots: this.#slots(table, place.slots),
      ...(place.selections === undefined
        ? {}
        : { selections: place.selections }),
      ...(place.picks === undefined ? {} : {
        picks: entries(
          place.picks,
          (chosen) =>
            chosen === null
              ? null
              : { slots: this.#slots(table, chosen.slots) },
        ),
      }),
      ...(place.elements === undefined
        ? {}
        : { elements: entries(place.elements, elements) }),
      ...(dynamic === undefined ? {} : {
        dynamic: entries(dynamic, ({ listed }) => listed),
      }),
      ...(grouped.length === 0 ? {} : {
        dynamicGroups: Object.fromEntries(
          grouped.map(([read, { groups }]) => [read, groups!]),
        ),
      }),
      ...(place.outputs === undefined ? {} : {
        outputs: entries(
          place.outputs,
          (inputs) => this.#inputs(table, inputs),
        ),
      }),
    });
    this.#converted.inputs.set(index, {
      state: this.#stagedState,
      index: formed,
    });
    return formed;
  }

  /**
   * The bindings of slots that name theirs in `table`, as the runtime reads
   * them: each the index of the binding in the runtime's table. A plan's
   * class `identity` is the runtime's `followRef`. A slot whose position the
   * transaction in progress wrote takes the label staged there.
   */
  #slots(table: InputsTable, slots: SlotBindings): RuntimeSlotBindings {
    const converted = this.#converted!.bindings;
    return Object.fromEntries(
      Object.entries(slots).map(([slot, at]) => {
        const binding = table.bindings[at];
        const staged = this.#takesStaged(binding);
        const known = converted.get(at);
        if (known?.staged === staged) return [slot, known.index];
        const index = this.#recorded.interner.binding(
          this.#binding(binding, staged),
        );
        converted.set(at, { staged, index });
        return [slot, index];
      }),
    );
  }

  /**
   * Whether the position a binding's chain ends at takes, for the slot,
   * the label the transaction in progress staged there. A position the
   * transaction read before it wrote it, and only then, holds for the slot
   * what the read found: its stored label, and not the label the write
   * stages, which a write edge that reads its own target would make depend
   * on itself. A position it read after the write holds what the write
   * made, whose label is the staged one; the binding names no read, so a
   * position read both before and after the write takes the staged label,
   * and a slot whose label then depends on itself is refused as a cycle.
   */
  #takesStaged(binding: SlotBinding): boolean {
    if ("output" in binding) {
      return binding.through !== undefined &&
        this.#takesStaged(binding.through);
    }
    if (!("chain" in binding)) return false;
    const last = binding.chain.at(-1);
    if (last === undefined || !this.#wrote(last)) return false;
    const position = JSON.stringify([last.doc, last.path]);
    return this.#readAfterWrite.has(position) ||
      !this.#readBeforeWrite.has(position);
  }

  /**
   * Helper for `#slots()`, for one binding, with whether its position
   * takes the staged label (`#takesStaged`).
   */
  #binding(
    binding: SlotBinding,
    staged: boolean,
    alone = true,
  ): RuntimeSlotBinding {
    if ("output" in binding) {
      if (binding.through === undefined) return { output: binding.output };
      // The read keeps its chain where the one position it went through
      // is one this transaction wrote, marked as read after the write.
      const through = this.#binding(binding.through, staged, false);
      return "chain" in through
        ? { output: binding.output, through }
        : { output: binding.output };
    }
    if ("constant" in binding) return { constant: true };
    if ("staged" in binding) {
      return { staged: this.#cfcAddress(binding.staged) };
    }
    // A staged position that the read crossed links to, or that holds
    // links the read followed, keeps those positions: the binding names
    // them all, marked as read after the write.
    if (
      alone && staged && binding.chain.length === 1 &&
      binding.below === undefined
    ) {
      return { staged: this.#cfcAddress(binding.chain[0]) };
    }
    // A position the transaction did not read, such as the one an element
    // of a fold's group read in an earlier transaction, is the runtime's to
    // observe: it observes the label stored there in the committing
    // transaction and reads no value (ruling (c)).
    const observes = observesOf(binding.observes);
    // A chain that ends at or below a bucket that is a document of its own
    // crossed the link to it, which the result document holds below the
    // entry of the index: that position is observed with the chain.
    const crossed = [binding.chain, ...(binding.below ?? [])].flatMap(
      (chain) =>
        this.#crossedBucketLink(chain[chain.length - 1]).map((link) => [link]),
    );
    const below = [
      ...(binding.below ?? []).map((chain) =>
        chain.map((address) => this.#cfcAddress(address))
      ),
      ...crossed,
    ];
    return {
      chain: binding.chain.map((address) => this.#cfcAddress(address)),
      observes,
      ...(below.length === 0 ? {} : { below }),
      ...(binding.members === undefined ? {} : {
        members: binding.members.map(({ container, count, groups }) => ({
          container: this.#cfcAddress(container),
          count,
          groups,
        })),
      }),
      ...(staged ? { staged: true as const } : {}),
    };
  }

  /**
   * Whether the transaction in progress wrote `address`, at its path or
   * above it.
   */
  #wrote({ doc, path }: Address): boolean {
    // A row that a transaction of rows of the load in progress stored is
    // no write of the handed transaction, though the array above it is.
    if (
      this.#rowsStored.size > 0 &&
      this.#rowsStored.has(this.#placeOf(doc, path).doc)
    ) return false;
    return (this.#written.get(doc) ?? []).some((written) =>
      written.length <= path.length &&
      written.every((segment, index) => segment === path[index])
    );
  }

  /**
   * The runtime's address of the position of the result document that
   * holds the link to a bucket document, for an address at or below the
   * bucket; nothing for any other address.
   */
  #crossedBucketLink(address: Address | undefined): CfcAddress[] {
    if (address === undefined) return [];
    const record = this.#bucketRecordsOf(address.doc).find((one) =>
      address.path.length > one.path.length && isPrefix(one.path, address.path)
    );
    if (record === undefined) return [];
    const { space, id, path } = this.#linkOfBucket(record, address.path);
    const link: CfcAddress = { space, id, scope: "space", path: [...path] };
    // Where a document of the links holds the link, the read crossed the
    // link the result document holds at the path of the record first, below
    // the entry of the index.
    if (record.list === undefined) return [link];
    const above = this.#ownAddress(record.doc, record.path);
    return [
      { space: above.space, id: above.id, scope: "space", path: above.path },
      link,
    ];
  }

  /** The runtime's address of a position of a document of the executor. */
  #cfcAddress(address: Address): CfcAddress {
    const { doc, path } = this.#placeOf(address.doc, address.path);
    return {
      space: this.#spaceOf(doc),
      id: this.entityOf(doc),
      scope: cellScopeOf(doc),
      path,
    };
  }

  /** @inheritDoc */
  end({ committed }: { committed: boolean }): void {
    const tx = this.#open();
    if (committed) this.#writeSplicedArrays();
    else this.#splicedArrays.clear();
    this.#tx = undefined;
    if (this.#given !== undefined) {
      if (tx !== this.#given.tx) {
        // The creation of a load in bounded transactions.
        if (committed) {
          this.#handOver(tx);
          this.#commitOfLoad(tx);
          // What it wrote is stored: no later record takes a label staged
          // there.
          this.#resetTransaction();
        } else {
          tx.abort();
        }
      }
      if (committed) {
        this.#counts.committed += 1;
        this.#counts.byCause[this.#cause] =
          (this.#counts.byCause[this.#cause] ?? 0) + 1;
      } else {
        this.#counts.aborted += 1;
        this.#given.failed ??=
          `A transaction of the executor (${this.#cause}) did not commit.`;
      }
      return;
    }
    if (!committed) {
      tx.abort();
      this.#unchanged.clear();
      this.#counts.aborted += 1;
      for (const doc of this.#created) this.#documents.delete(doc);
      return;
    }
    // The preparation runs here, before the commit, so that a refusal is
    // known before the executor begins its next transaction, which can
    // depend on what this one wrote. The storage holds nothing this
    // transaction wrote then, so the next change of each document it wrote
    // writes the document whole. The commit finds the transaction prepared.
    this.#recordWrites(tx);
    this.#runtime.prepareTxForCommit(tx);
    const refused = tx.getCfcState().prepare.status === "invalidated";
    if (refused) {
      for (const doc of this.#written.keys()) this.#documents.delete(doc);
    }
    this.#receipts.push({
      receipt: tx.commit(),
      recorded: [...this.#contexts.values()].map(({ recorded }) => recorded),
      // A document forgotten here may be written again by a later
      // transaction before this one settles.
      created: refused ? [] : this.#created,
    });
    this.#resetRecorded();
    this.#created = [];
    this.#reportLabels();
    if (refused) this.#unchanged.clear();
    else this.#reportUnchanged();
    this.#counts.committed += 1;
    this.#counts.byCause[this.#cause] = (this.#counts.byCause[this.#cause] ??
      0) + 1;
  }

  /**
   * Waits until every commit so far has settled, and returns the reason
   * of each commit the storage refused.
   */
  async settled(): Promise<string[]> {
    const refused: string[] = [];
    for (const { receipt, recorded, created } of this.#receipts.splice(0)) {
      const { error } = await receipt.settled;
      if (error === undefined) {
        if (this.#onCommitted !== undefined) {
          this.#onCommitted(recorded.flatMap(({ writes, interner }) => {
            const expanded = new Map<number, NestedPlanInputs>();
            return writes.map((write) =>
              nestedPlanWrite(write, interner.table, expanded)
            );
          }));
        }
        continue;
      }
      refused.push(`${error.name}: ${error.message}`);
      // The storage does not hold a document whose first write was refused:
      // the next change of it writes it whole again.
      for (const doc of created) this.#documents.delete(doc);
    }
    return refused;
  }

  /**
   * Has `listener` hear, as `settled()` finds each commit settled without
   * a refusal, the write records the commit recorded, in the order they
   * were recorded.
   */
  onCommitted(listener: (writes: readonly RecordedPlanWrite[]) => void): void {
    this.#onCommitted = listener;
  }

  /**
   * What the storage holds for each document the executor's commits
   * wrote, read in a transaction of its own, with each of the runtime's
   * links written back as the executor's.
   */
  stored(): Map<string, unknown> {
    const tx = this.#edit();
    try {
      return new Map(
        [...this.#documents].map((
          doc,
        ) => [
          doc,
          this.#decode(
            tx.readValueOrThrow(this.#address(doc, [])),
            tx,
            this.#space,
            "space",
            doc,
          ),
        ]),
      );
    } finally {
      tx.abort();
    }
  }

  /**
   * The entity of the space that holds a document of the executor: the
   * identifier itself where it is an entity's, as that of a document the
   * runtime made is, and `of:` before it otherwise. The replica keeps every
   * entity named here loaded until `close()`.
   */
  entityOf(doc: string): URI {
    // The instances of every scope of a document are of one entity.
    const of = doc.indexOf("~") < 0 ? doc : scopeOfDocument(doc).base;
    const { named, space } = placeOfDocument(of);
    const entity: URI = named.startsWith("of:") || named.startsWith("data:")
      ? named as URI
      : `of:${named}`;
    this.#byEntity.set(
      space === undefined ? entity : documentIn(entity, space),
      of,
    );
    // The subscription takes the commits of each space named here.
    if (space !== undefined) this.#spaces.set(of, space as MemorySpace);
    return entity;
  }

  /** The document of the executor that an entity holds. */
  documentOf(entity: string): string {
    const known = this.#byEntity.get(entity);
    if (known !== undefined || !this.#resume) return known ?? entity;
    return this.#heldDocumentOf(entity);
  }

  /**
   * Enrolls a document the executor made as a store the runtime owns, as
   * `enrollPieceOwnedStores` in `runtime/runner/src/runner.ts` enrolls the
   * result, the argument and the internal documents of a piece: a clause
   * that does not fit the store is then declared onto it rather than refused
   * (CFC spec §8.12.5). The enrollment outlives the transaction.
   */
  #enroll(tx: IExtendedStorageTransaction, doc: string): void {
    if (this.#owner === undefined) return;
    const store = this.#address(doc, []);
    const owner = runtimeOwnedStoreOwnerKey(
      store,
      this.#address(this.#owner, []),
      this.#runtime.scopeKeyIdentity,
    );
    if (owner === undefined) return;
    // The runtime's mark: this adapter stands in for the runner, which
    // enrolls a piece's stores with it.
    tx.enrollRuntimeOwnedStore(
      { ...store, path: [] },
      owner,
      runtimeWritePolicyAuthorization,
    );
  }

  /**
   * Writes onto a document the executor made the `result` link to the
   * result document of the instance, as the runner writes it onto the
   * cells a piece owns (`setResultCell`). The runtime finds the piece that
   * a document belongs to by this link, and a resumed instance tells by it
   * a document the executor named from one that exists outside it.
   */
  #linkToResult(tx: IExtendedStorageTransaction, doc: string): void {
    if (this.#owner === undefined || doc === this.#owner) return;
    const owner = this.#address(this.#owner, []);
    this.#resultLink ??= this.#runtime.getCellFromLink(owner)
      .getAsWriteRedirectLink({ includeSchema: true });
    tx.writeOrThrow(
      { ...this.#address(doc, []), path: ["result"] },
      this.#resultLink as FabricValue,
      rawMetaWriteAuthorization,
    );
  }

  /**
   * The document of the executor that the replica holds in `entity`, for a
   * resumed instance: the identifier without `of:` where the entity holds
   * the `result` link to the result document of the instance, and the
   * identifier of the entity otherwise.
   */
  #heldDocumentOf(entity: string): string {
    let doc = entity;
    if (this.#owner !== undefined && entity.startsWith("of:")) {
      const read = this.#edit();
      try {
        const link = getMetaLink(
          this.#runtime.getCellFromLink(
            {
              space: this.#space,
              id: entity as URI,
              path: [],
              scope: "space",
            },
            undefined,
            read,
          ),
          "result",
        );
        if (link?.id === this.#owner && entity !== this.#owner) {
          doc = entity.slice("of:".length);
        }
      } finally {
        read.abort();
      }
    }
    this.#byEntity.set(entity, doc);
    return doc;
  }

  /**
   * Whether the executor holds a document of this name: one it made, or
   * one `load()` gave it.
   */
  holds(doc: string): boolean {
    return this.#documents.has(doc);
  }

  /**
   * The runtime's address of a position of a document of the executor: the
   * entity and the space of the document, and the path as the storage
   * holds it.
   */
  linkOf(doc: string, path: readonly string[]): NormalizedFullLink {
    return this.#address(doc, path);
  }

  /** Helper for the hooks, which gives the transaction in progress. */
  #open(): IExtendedStorageTransaction {
    if (this.#tx === undefined) {
      throw new Error("The executor used a transaction that is not open.");
    }
    return this.#tx;
  }

  /** The address of a path of a document of the executor. */
  #address(doc: string, path: readonly string[]): NormalizedFullLink {
    const place = this.#placeOf(doc, path);
    const { scope, key } = scopeOfDocument(place.doc);
    return {
      space: this.#spaceOf(place.doc),
      id: this.entityOf(place.doc),
      path: place.path,
      // The transaction resolves the instance of a scope from the identity
      // it carries. A name of the instance of another key than that
      // identity's names the instance.
      scope: scope ?? "space",
      ...(scope !== undefined && key !== undefined &&
          key !== this.scopeKey(scope)
        ? { scopeKey: key as ScopeKey }
        : {}),
    };
  }

  /**
   * The scope keys that stand in the place of those of the identity of
   * the transaction in progress (`actingAs`).
   */
  #actingKeys: Partial<Record<Scope, string>> | undefined;

  /**
   * The identity whose instances a document of a scope stands for now:
   * that of the transaction in progress, which a serving loop stamped with
   * the principal and the session of the run, and the runtime's own
   * where the transaction carries none or none is open.
   */
  #actingIdentity(): ScopeKeyIdentity {
    return this.#actingFor ??
      (this.#tx ?? this.#given?.tx)?.tx.scopeKeyIdentity ??
      this.#runtime.scopeKeyIdentity;
  }

  /** The identity that stands in the place of the transaction's (`actingFor`). */
  #actingFor: ScopeKeyIdentity | undefined;

  /**
   * Runs `run` with the documents of a scope standing for the instances
   * of `identity`, where it is one: for what a transaction that carried it
   * wrote, taken up after the transaction ended.
   */
  actingFor<T>(identity: ScopeKeyIdentity | undefined, run: () => T): T {
    if (identity === undefined) return run();
    const outer = this.#actingFor;
    this.#actingFor = identity;
    try {
      return run();
    } finally {
      this.#actingFor = outer;
    }
  }

  /** Whether the piece has named a document of a scope narrower than the space. */
  get scoped(): boolean {
    return this.#scopes;
  }

  /** The narrowest scope the piece has named a document of. */
  get narrowestScope(): CellScope {
    return this.#narrowest;
  }

  #narrowest: CellScope = "space";

  /**
   * The scope key that a document of `scope` stands for now, as the
   * storage forms it from the identity of the transaction in progress.
   */
  scopeKey(scope: Scope): string {
    return this.#actingKeys?.[scope] ??
      scopeKeyOf(scope, this.#actingIdentity());
  }

  /**
   * Runs `run` with the documents of the scope of `key` standing for the
   * instance of `key`: for a change that reached the adapter outside a
   * transaction, as one another writer committed to one instance.
   */
  actingAs<T>(key: string, run: () => T): T {
    const outer = this.#actingKeys;
    this.#actingKeys = {
      ...outer,
      [key.startsWith("session:") ? "session" : "user"]: key,
    };
    try {
      return run();
    } finally {
      this.#actingKeys = outer;
    }
  }

  /**
   * Whether the piece has named a document of the scope `user` or
   * `session`. From then on a link it stores says the scope of its target
   * (`#encodeOnce`).
   */
  #scopes = false;

  /** The name of the instance that `doc` stands for now. */
  #instanceOf(doc: string): string {
    if (doc.indexOf("~") < 0) return doc;
    const { scope } = scopeOfDocument(doc);
    if (!this.#scopes && scope !== undefined) {
      this.#scopes = true;
      // What was encoded before holds links that say no scope.
      this.#encoded = new WeakMap();
    }
    if (scope === "session" || this.#narrowest === "space") {
      this.#narrowest = scope ?? this.#narrowest;
    }
    return instanceNameOf(doc, (scope) => this.scopeKey(scope));
  }

  /**
   * What the replica holds at `address`, read through a transaction of
   * its own, which no commit depends on. For an address of a scope the
   * transaction carries the identity of the transaction in progress, so
   * it reads the instance that one reads.
   */
  #readStored(address: NormalizedFullLink): FabricValue | undefined {
    const read = this.#edit();
    try {
      const acting = this.#actingFor ??
        (this.#tx ?? this.#given?.tx)?.tx.scopeKeyIdentity;
      if (address.scope !== "space" && acting !== undefined) {
        read.tx.scopeKeyIdentity = acting;
      }
      return read.readValueOrThrow(address);
    } finally {
      read.abort();
    }
  }

  /**
   * A value of the executor, with each link written as the runtime's. The
   * executor's documents hold JSON values and its own records of a link,
   * a stream and an error state, which are records too.
   */
  #encode(value: unknown): FabricValue {
    const store = this.#store;
    if (store === undefined || !store.holds(value)) {
      return this.#encodeOnce(value);
    }
    // A stored container that holds no link, no stream and no error state
    // is frozen with all it holds, and is the value the runtime stores.
    if (store.plain(value)) return value as FabricValue;
    const known = this.#encoded.get(value as object);
    if (known !== undefined && known.rowArrays === this.#rowArraysNamed) {
      return known.value;
    }
    const streams = this.#streamsEncoded;
    const made = this.#encodeOnce(value);
    // The link of a stream is made with the transaction in progress, which
    // writes the marker of a stream the storage has none of.
    if (this.#streamsEncoded !== streams) return made;
    const frozen = cloneIfNecessary(made);
    this.#encoded.set(value as object, {
      rowArrays: this.#rowArraysNamed,
      value: frozen,
    });
    return frozen;
  }

  /**
   * The store of the executor, from its first change on: it says which
   * containers it holds, which are frozen with all they hold.
   */
  #store: Store | undefined;

  /**
   * What `#encode` gave for each stored container that holds a link, with
   * how many arrays of row documents were named then: a link by key into
   * such an array is written as a link to the document of the row. A
   * stored container is never changed, so what it encodes to stays, and
   * the value is frozen once and is the same object at each write, which
   * the runtime compares and hashes by.
   */
  #encoded = new WeakMap<
    object,
    { rowArrays: number; value: FabricValue }
  >();

  /** How many arrays of row documents `#rowArraysOf` has named. */
  #rowArraysNamed = 0;

  /** How many links of streams `#encodeOnce` has made. */
  #streamsEncoded = 0;

  /** `#encode`, for a value it keeps no encoded form of. */
  #encodeOnce(value: unknown): FabricValue {
    if (this.#onStream !== undefined && isStream(value)) {
      this.#streamsEncoded += 1;
      return createSigilLinkFromParsedLink({
        id: this.#streamEntity(value.$stream),
        space: this.#space,
        path: [],
      });
    }
    if (isLink(value)) {
      const { schema } = value.$link;
      // A reference by key to a row that is a document of its own is a
      // link to that document, which stays the row's whatever position
      // the row has.
      const { doc, path } = this.#rowByKey(value.$link.doc, value.$link.path) ??
        value.$link;
      const { scope } = scopeOfDocument(doc);
      return createSigilLinkFromParsedLink(
        {
          id: this.entityOf(doc),
          space: this.#spaceOf(doc),
          path,
          // A link holds the name of the scope of its target and no
          // principal. In a piece that has documents of a scope, a link
          // to a document of the space says so: a link with no scope
          // inherits the scope of the document it is stored in.
          ...(scope !== undefined
            ? { scope }
            : this.#scopes
            ? { scope: "space" as const }
            : {}),
          // A schema of a plan is a JSON schema with the members the
          // executor reads typed (`Schema` of `exec/store.ts`).
          ...(schema === undefined ? {} : { schema: schema as JSONSchema }),
        },
        // A write redirect stays one: a write at its position, by today's
        // runtime or by a piece, lands where it leads.
        value.$link.redirect === true
          ? { includeSchema: true, overwrite: "redirect" }
          : { includeSchema: true },
      );
    }
    if (Array.isArray(value)) {
      return value.map((member) => this.#encode(member));
    }
    if (isWalkableObjectNotArray(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, member]) => [
          name,
          this.#encode(member),
        ]),
      );
    }
    if (
      value === null || value === undefined || typeof value === "string" ||
      typeof value === "number" || typeof value === "boolean"
    ) {
      return value;
    }
    // A primitive of the data model, such as a time, and a `bigint` are
    // values of the storage as they are.
    if (value instanceof FabricPrimitive || typeof value === "bigint") {
      return value;
    }
    throw new Error(debugStr`The executor holds no JSON value: ${value}`);
  }

  /** The entity that a stream of the executor has its marker in. */
  #entityOfStream(stream: StreamOfExecutor): URI {
    return `of:${
      identifierOf({
        stream: [
          this.#owner ?? "",
          stream.instance ?? "",
          stream.binding,
          ...stream.keys,
        ],
      })
    }`;
  }

  /**
   * The entity that holds the runtime's stream marker for a stream of the
   * executor. The transaction in progress writes the marker where no
   * transaction did before.
   */
  #streamEntity(stream: StreamOfExecutor): URI {
    const entity = this.#entityOfStream(stream);
    // A stream taken with a row left as stored has its marker where the
    // stored row linked to it, which the first value that holds the stream
    // here finds out with one read.
    if (this.#streamsAssumed.delete(entity) && !this.#holdsMarker(entity)) {
      this.#streams.delete(entity);
    }
    if (!this.#streams.has(entity)) {
      this.#streams.set(entity, stream);
      this.#createdStreams.push(entity);
      this.#sources?.made(entity);
      this.#open().writeValueOrThrow(
        { space: this.#space, id: entity, path: [], scope: "space" },
        { $stream: true },
      );
      this.#markersMade.push({ entity, stream });
      // The marker's document is a store the instance owns, as the runner
      // enrolls the cell of each stream of a piece (`pieceOwnedStores`).
      this.#enroll(this.#open(), entity);
      this.#linkToResult(this.#open(), entity);
      this.#handleStream(entity, stream);
    }
    return entity;
  }

  /**
   * The streams of `heldStream` that no value this adapter encoded has
   * held: whether the storage holds the marker of each was not read.
   */
  readonly #streamsAssumed = new Set<string>();

  /** The entities of the streams whose handler was registered. */
  readonly #streamsHandled = new Set<string>();

  /** Registers the handler of a stream, once for each entity. */
  #handleStream(entity: URI, stream: StreamOfExecutor): void {
    if (this.#streamsHandled.has(entity)) return;
    this.#streamsHandled.add(entity);
    this.#onStream?.(entity, stream);
  }

  /** Whether the replica holds the runtime's stream marker in `entity`. */
  #holdsMarker(entity: URI): boolean {
    const read = this.#edit();
    try {
      const held = read.readValueOrThrow({
        space: this.#space,
        id: entity,
        path: [],
        scope: "space",
      });
      return isWalkableObjectNotArray(held) && held.$stream === true;
    } finally {
      read.abort();
    }
  }

  /**
   * Takes a stream of the executor as one of a row that the executor
   * holds as stored: its handler is registered, and a link to its entity
   * is read as the stream, with nothing written and nothing read. The run
   * that stored the row wrote the marker where the row links to the
   * stream.
   */
  heldStream(stream: StreamOfExecutor): void {
    const entity = this.#entityOfStream(stream);
    if (this.#streams.has(entity)) return;
    this.#streams.set(entity, stream);
    this.#streamsAssumed.add(entity);
    this.#handleStream(entity, stream);
  }

  /**
   * A value of the runtime as the executor holds it: each link as the
   * executor's link to the document its entity holds, and a link to the
   * marker of a stream of the executor as the executor's record of the
   * stream.
   */
  decode(value: unknown): unknown {
    return this.#decode(value);
  }

  /**
   * A value of the executor as the runtime stores it, for a value that
   * holds no stream the storage has no marker for.
   */
  encode(value: unknown): FabricValue {
    return this.#encode(value);
  }

  /**
   * Reads a document the executor does not hold from the replica: one that
   * exists outside the executor, which is then kept loaded and whose changes
   * by other writers are reported (`options.changes`). The identifier is
   * that of its entity.
   */
  load(id: string): { kind: string; value: unknown } | undefined {
    if (this.#streams.has(id)) return undefined;
    // The executor makes the result document of a resumed instance empty.
    if (this.#resume && id === this.#owner) return undefined;
    // An entity named `data:` holds the value its name encodes.
    if (!id.startsWith("of:") && !id.startsWith("data:")) {
      return this.#resume ? this.#held(id) : undefined;
    }
    const address = this.#address(id, []);
    const scope = cellScopeOf(id);
    let value = this.#readStored(address);
    // A document that the transaction in progress wrote, as one handed with
    // the inputs staged in it, is read through that transaction.
    if (value === undefined && this.#tx !== undefined) {
      value = this.#tx.readValueOrThrow(address);
    }
    // The result document is derived, and no source of the piece.
    if (id !== this.#owner) this.#sources?.read(id);
    if (value === undefined) {
      // The replica holds no such document. The storage may: the piece
      // asks it (`CompiledPiece`), and reads again when it answered. The
      // result document is the piece's to make.
      if (id !== this.#owner) this.wanted.add(id);
      return undefined;
    }
    this.wanted.delete(id);
    this.#documents.add(id);
    // A link of the document that names no space leads into its own, and
    // one that names no scope to an instance of its own scope.
    return {
      kind: "external",
      value: this.#decode(value, undefined, this.#spaceOf(id), scope, id),
    };
  }

  /**
   * What the replica holds of a document the executor names by an
   * identifier of its own, for an instance that is resumed. The document
   * counts as one the storage holds, so its first write is of the path
   * written and not of the document whole.
   */
  #held(id: string): { kind: string; value: unknown } | undefined {
    const value = this.#readStored(this.#address(id, []));
    if (value === undefined) {
      this.absent.add(id);
      return undefined;
    }
    this.#documents.add(id);
    this.#heldBefore.add(id);
    return {
      kind: "held",
      value: this.#decode(
        value,
        undefined,
        this.#space,
        cellScopeOf(id),
        id,
      ),
    };
  }

  /**
   * The document that keeps what the instance whose result document is
   * `owner` counted (`Instance.minted`).
   */
  #mintedDocument(): string {
    return identifierOf({ type: "minted", parent: this.#owner ?? "" });
  }

  /**
   * What the replica holds of the counts of the instance, and of the
   * instances its handlers made, each by its identifier with the identity
   * of its pattern, for a resume.
   */
  heldMinted():
    | { events: number; created: number; made: Record<string, string> }
    | undefined {
    const held = this.#held(this.#mintedDocument())?.value;
    if (!isWalkableObjectNotArray(held)) return undefined;
    const made: Record<string, string> = {};
    if (isWalkableObjectNotArray(held.made)) {
      for (const [id, pattern] of Object.entries(held.made)) {
        if (typeof pattern === "string") made[id] = pattern;
      }
    }
    return {
      events: Number(held.events),
      created: Number(held.created),
      made,
    };
  }

  /**
   * Writes the counts of the instance into `tx`, with the instances its
   * handlers made.
   */
  writeMinted(
    tx: IExtendedStorageTransaction,
    minted: { events: number; created: number; made: Record<string, string> },
  ): void {
    const doc = this.#mintedDocument();
    tx.writeValueOrThrow(this.#address(doc, []), {
      events: minted.events,
      created: minted.created,
      made: { ...minted.made },
    });
    if (this.#heldBefore.delete(doc)) this.#enroll(tx, doc);
    if (!this.#documents.has(doc)) {
      this.#documents.add(doc);
      this.#enroll(tx, doc);
      this.#linkToResult(tx, doc);
    }
  }

  /**
   * Writes `value` at `path` of a document that the piece keeps beside
   * those of the executor, into `tx`: the document is one the instance
   * owns, as the document of the counts is.
   */
  writeOwn(
    tx: IExtendedStorageTransaction,
    doc: string,
    path: readonly string[],
    value: FabricValue,
  ): void {
    tx.writeValueOrThrow(this.#address(doc, path), value);
    if (this.#heldBefore.delete(doc)) this.#enroll(tx, doc);
    if (!this.#documents.has(doc)) {
      this.#documents.add(doc);
      this.#enroll(tx, doc);
      this.#linkToResult(tx, doc);
    }
  }

  /**
   * What the replica holds of a document that the piece keeps beside those
   * of the executor, as stored. The document counts as one the storage
   * holds where it holds one.
   */
  heldOwn(doc: string): FabricValue | undefined {
    const read = this.#edit();
    let value: FabricValue | undefined;
    try {
      value = read.readValueOrThrow(this.#address(doc, []));
    } finally {
      read.abort();
    }
    if (value !== undefined) {
      this.#documents.add(doc);
      this.#heldBefore.add(doc);
    }
    return value;
  }

  /**
   * The arrays of row documents whose rows the executor holds as the
   * storage does, with no row evaluated (`rowsHeld`).
   */
  readonly #keptArrays = new Set<RowArray>();

  /** The row documents of `#keptArrays` that this runtime enrolled. */
  readonly #keptEnrolled = new Set<string>();

  /**
   * The links to the rows of the array at `path` of the result document, in
   * order, where the storage holds them in the documents of a list
   * (`LinkList`) and `held`, what the result document holds at `path`, is
   * the link to the list document of the path; `held` itself otherwise. The
   * list document holds either the links to the rows or the links to its
   * chunks, each an array of links to rows, and its first member says
   * which: a row is a record or a view node.
   */
  #linksThroughList(
    tx: IExtendedStorageTransaction,
    path: readonly string[],
    held: unknown,
  ): unknown {
    if (
      !this.#lists || this.#owner === undefined || !isPrimitiveCellLink(held)
    ) return held;
    const doc = identifierOf({ list: [this.#owner, ...path] });
    if (parseLink(held).id !== this.entityOf(doc)) return held;
    const members = tx.readValueOrThrow(this.#address(doc, []));
    if (!Array.isArray(members)) return held;
    const chunkOf = (member: unknown): string | undefined => {
      const entity = isPrimitiveCellLink(member)
        ? parseLink(member).id
        : undefined;
      return entity?.startsWith("of:") ? entity.slice("of:".length) : entity;
    };
    const first = members.length === 0 ? undefined : chunkOf(members[0]);
    if (
      first === undefined ||
      !Array.isArray(tx.readValueOrThrow(this.#address(first, [])))
    ) return members;
    const links: unknown[] = [];
    for (const member of members) {
      const chunk = chunkOf(member);
      const below = chunk === undefined
        ? undefined
        : tx.readValueOrThrow(this.#address(chunk, []));
      if (!Array.isArray(below)) continue;
      for (const link of below) links.push(link);
    }
    return links;
  }

  /**
   * What the replica holds of the result document of the instance, for an
   * executor that leaves rows as stored: the value as the executor holds
   * one, with no member at each path of `rows`, and for each of those
   * paths the entity that each position of the stored array links to, or
   * nothing where the storage holds no array of links to whole documents
   * there. With `arrays`, the value also has nothing at each other
   * position of the document that holds an array of links to whole
   * documents, and `found` names each such position
   * (`StoredUnits.result`). Nothing where the replica holds no result
   * document. The document counts as one the storage holds, and the
   * executor's creation of it with this value is no write.
   */
  heldResult(
    rows: readonly (readonly string[])[],
    arrays = false,
  ): {
    value: unknown;
    rows: (readonly string[] | undefined)[];
    found?: StoredArray[];
  } | undefined {
    if (this.#owner === undefined) return undefined;
    const read = this.#edit();
    try {
      return this.#heldResultIn(read, rows, arrays);
    } finally {
      read.abort();
    }
  }

  /** Helper for `heldResult`, which reads through `read`. */
  #heldResultIn(
    read: IExtendedStorageTransaction,
    rows: readonly (readonly string[])[],
    arrays: boolean,
  ): ReturnType<RuntimeTransactions["heldResult"]> {
    const owner = this.#owner!;
    const stored = read.readValueOrThrow(this.#address(owner, []));
    if (!isWalkableObjectNotArray(stored)) return undefined;
    // The entity each position of an array links to, where every position
    // links to a whole document of the space of the instance.
    const entitiesOf = (held: unknown): string[] | undefined => {
      if (!Array.isArray(held)) return undefined;
      const ids: string[] = [];
      for (const member of held) {
        if (!isPrimitiveCellLink(member)) return undefined;
        const link = parseLink(member);
        if (
          link.id === undefined || link.path.length > 0 ||
          (link.space !== undefined && link.space !== this.#space)
        ) return undefined;
        ids.push(link.id);
      }
      return ids;
    };
    const entities = rows.map((path) =>
      entitiesOf(this.#linksThroughList(read, path, valueAt(stored, path)))
    );
    const found: StoredArray[] = [];
    // The value without the members at the paths of `rows` and, with
    // `arrays`, without the arrays of links to whole documents: none of
    // the links there is decoded, which for each reads the entity it names.
    const without = (value: unknown, at: readonly string[]): unknown => {
      if (!arrays) {
        const inside = rows.filter((path) =>
          path.length > at.length && isPrefix(at, path)
        );
        if (inside.length === 0 || !isWalkableObjectNotArray(value)) {
          return this.#decode(value);
        }
      }
      // The links of an array whose list is a document of its own.
      const through = arrays ? this.#linksThroughList(read, at, value) : value;
      if (through !== value) {
        const ids = entitiesOf(through);
        if (ids !== undefined && ids.length > 0) {
          found.push({ path: at, entities: ids });
          return undefined;
        }
      }
      if (Array.isArray(value)) {
        // An array that holds the link to the list document of one of its
        // members holds that list, and no rows.
        const ids = value.length === 0 ||
            value.some((member, index) =>
              this.#linksThroughList(read, [...at, `${index}`], member) !==
                member
            )
          ? undefined
          : entitiesOf(value);
        if (ids !== undefined) {
          found.push({ path: at, entities: ids });
          return undefined;
        }
        return value.map((member, index) =>
          without(member, [...at, `${index}`])
        );
      }
      if (!isWalkableObjectNotArray(value) || isPrimitiveCellLink(value)) {
        return this.#decode(value);
      }
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        const below = [...at, name];
        if (rows.some((path) => samePath(path, below))) continue;
        const kept = without(member, below);
        // A member that held an array which was taken out is absent.
        if (kept !== undefined || member === undefined) members[name] = kept;
      }
      return members;
    };
    this.#documents.add(owner);
    this.#heldBefore.add(owner);
    this.#heldWhole.add(owner);
    const value = without(stored, []);
    return { value, rows: entities, ...(arrays ? { found } : {}) };
  }

  /**
   * The executor holds the rows of `keys`, in that order, at `path` of the
   * result document as the storage holds them: the array of row documents
   * there has those keys, and no row of it is written until the executor
   * stores one.
   */
  rowsHeld(path: readonly string[], keys: readonly string[]): void {
    if (this.#owner === undefined) return;
    const doc = this.#owner;
    const text = JSON.stringify([doc, path]);
    let arrays = this.#rowArrays.get(doc);
    if (arrays === undefined) {
      arrays = [];
      this.#rowArrays.set(doc, arrays);
    }
    let array = arrays.find((one) => one.text === text);
    if (array === undefined) {
      array = {
        doc,
        path: [...path],
        text,
        keys: [],
        ids: new Map(),
        links: new Map(),
      };
      arrays.push(array);
      this.#rowArraysNamed += 1;
    }
    array.keys = [...keys];
    array.positions = undefined;
    this.#keptArrays.add(array);
    if (this.#lists) this.#adoptList(array);
  }

  /**
   * Gives an array whose rows the executor holds as stored (`rowsHeld`) the
   * layout of its list as the storage holds it, so that a later change of
   * the rows writes the chunks it changes and the list document only where
   * the layout changed (`#relayList`), as for a list this runtime wrote.
   */
  #adoptList(array: RowArray): void {
    array.list ??= {
      doc: identifierOf({ list: [array.doc, ...array.path] }),
      linked: false,
      chunks: undefined,
      dirty: new Set(),
      dropped: [],
      top: true,
      ids: new Set(),
      next: 0,
      adopted: false,
    };
    const { list } = array;
    this.#listDocuments.set(list.doc, array);
    this.entityOf(list.doc);
    list.adopted = true;
    list.dirty.clear();
    list.chunks = undefined;
    const read = this.#edit();
    try {
      const held = read.readValueOrThrow(
        this.#ownAddress(array.doc, array.path),
      );
      list.linked = isPrimitiveCellLink(held) &&
        parseLink(held).id === this.entityOf(list.doc);
      list.top = !list.linked;
      if (!list.linked) return;
      const members = read.readValueOrThrow(this.#address(list.doc, []));
      // The list document holds the links to the rows, or to its chunks;
      // the first member says which (`#linksThroughList`).
      const through = this.#linksThroughList(read, array.path, held);
      if (!Array.isArray(members) || through === members) return;
      const chunks: ListChunk[] = [];
      for (const member of members) {
        const entity = isPrimitiveCellLink(member)
          ? parseLink(member).id
          : undefined;
        const doc = entity?.startsWith("of:")
          ? entity.slice("of:".length)
          : entity;
        if (doc === undefined) continue;
        const below = read.readValueOrThrow(this.#address(doc, []));
        chunks.push({ doc, length: Array.isArray(below) ? below.length : 0 });
        list.ids.add(doc);
        this.#listDocuments.set(doc, array);
      }
      list.chunks = chunks;
    } finally {
      read.abort();
    }
  }

  /**
   * Enrolls the document of a row of an array of `#keptArrays` as a store
   * the instance owns, with the first write of this runtime at or below
   * the row: the runtime that made the document enrolled it, and this one
   * has not written it whole.
   */
  #enrollKeptRow(
    tx: IExtendedStorageTransaction,
    doc: string,
    path: readonly string[],
  ): void {
    if (this.#keptArrays.size === 0 || doc !== this.#owner) return;
    const place = this.#placeOf(doc, path);
    if (place.doc === doc || this.#keptEnrolled.has(place.doc)) return;
    const row = this.#rowDocuments.get(place.doc);
    if (row === undefined || !this.#keptArrays.has(row.array)) return;
    this.#keptEnrolled.add(place.doc);
    this.#enroll(tx, place.doc);
  }

  /** Reads a document whole in `tx`, so that its commit depends on it. */
  readWhole(tx: IExtendedStorageTransaction, doc: string): void {
    tx.readValueOrThrow(this.#address(doc, []));
  }

  /**
   * The sequence number the replica's confirmed view of a document stands
   * at, 0 for one it has taken no accepted write of, and nothing for a
   * document of another space than the instance's.
   */
  confirmedSeqOf(doc: string): number | undefined {
    // The replica's view of an instance of a scope is of one principal:
    // a document of a scope has no number here, as one of another space.
    if (cellScopeOf(doc) !== "space") return undefined;
    if (this.#spaceOf(doc) !== this.#space) return undefined;
    return this.#runtime.storageManager.open(this.#space).replica
      .confirmedDocumentSeq(this.entityOf(doc));
  }

  /** The document that keeps what the instance counted. */
  get mintedDocument(): string {
    return this.#mintedDocument();
  }

  /** Ends the first derivation of a resumed instance. */
  resumed(): void {
    this.#resuming = false;
  }

  /**
   * What the replica holds of the argument document of the instance whose
   * result document is `owner`, as the executor holds a value.
   */
  heldArgument(argument: string): unknown {
    const held = this.#held(argument);
    // The executor creates the argument document with this value, which
    // is no write: the storage holds it.
    if (held !== undefined) this.#heldWhole.add(argument);
    return held?.value;
  }

  /**
   * A stored value, with each of the runtime's links written back. With
   * `rows`, a link to the document of a row is written back as the row,
   * read through that transaction.
   */
  #decode(
    value: unknown,
    rows?: IExtendedStorageTransaction,
    /**
     * The space of the document the value is of: a link in it that names
     * no space leads into that space.
     */
    within: MemorySpace = this.#space,
    /**
     * The scope of the document the value is of: a link in it that names
     * no scope leads to an instance of that scope.
     */
    scope: CellScope = "space",
    /**
     * The document the value is of: a link in it that names no entity
     * leads into that document.
     */
    of?: string,
  ): unknown {
    if (isPrimitiveCellLink(value)) {
      const link = parseLink(value);
      const stream = this.#streams.get(link.id ?? "");
      if (stream !== undefined) return { $stream: stream };
      const to = link.scope === undefined || link.scope === "inherit"
        ? scope
        : link.scope;
      // A link into another space than the piece's leads to a document of
      // that space, which the executor holds under a name that names the
      // space (`documentAt`), and a link of the scope `user` or `session`
      // to the document the executor names for that scope. A link that
      // names no entity leads into the document it is of, whose instances
      // of every scope are of one entity.
      const at = link.id === undefined && of !== undefined
        ? (of.indexOf("~") < 0 ? of : scopeOfDocument(of).base)
        : this.documentAt({
          space: link.space ?? within,
          id: link.id ?? "",
        });
      const row = to === "space" ? at : scopedDocument(at, to);
      if (
        rows !== undefined &&
        (this.#rowDocuments.has(row) || this.#bucketDocuments.has(row))
      ) {
        return this.#decode(
          rows.readValueOrThrow(this.#address(row, [])),
          rows,
          within,
          scope,
        );
      }
      // A link to the list of an array of row documents is written back as
      // the rows in order, and a link to the document of the links of a
      // record of bucket documents as the buckets by their keys.
      if (rows !== undefined && link.path.length === 0) {
        const array = this.#listDocuments.get(row);
        if (array?.list?.doc === row) {
          const members = rows.readValueOrThrow(this.#address(row, []));
          return (Array.isArray(members) ? members : []).flatMap((member) => {
            const held = isPrimitiveCellLink(member)
              ? rows.readValueOrThrow(
                this.#address(
                  this.documentOf(parseLink(member).id ?? ""),
                  [],
                ),
              )
              : undefined;
            return Array.isArray(held)
              ? held.map((one) => this.#decode(one, rows))
              : [this.#decode(member, rows)];
          });
        }
        if (this.#bucketLists.has(row)) {
          return this.#decode(
            rows.readValueOrThrow(this.#address(row, [])),
            rows,
          );
        }
      }
      // A schema the storage holds by reference is handed as the schema
      // it names, so that a reader takes the default it declares where the
      // target holds nothing, as today's runtime does.
      const byReference = typeof link.schema === "object" &&
        link.schema !== null &&
        typeof (link.schema as { $ref?: unknown }).$ref === "string";
      const schema = byReference
        ? ContextualFlowControl.resolveSchemaRefs(
          link.schema as JSONSchemaObj,
        ) ?? link.schema
        : link.schema;
      return {
        $link: {
          doc: row,
          path: [...link.path],
          ...(schema === undefined ? {} : { schema: schema as Schema }),
          ...(link.overwrite === "redirect" ? { redirect: true as const } : {}),
        },
      };
    }
    if (Array.isArray(value)) {
      return value.map((member) =>
        this.#decode(member, rows, within, scope, of)
      );
    }
    if (isWalkableObjectNotArray(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, member]) => [
          name,
          this.#decode(member, rows, within, scope, of),
        ]),
      );
    }
    return value;
  }
}

/**
 * The one run of positions in which two arrays differ, as the splice that
 * makes `after` of `before`: the members before the run and behind it are
 * the same in both, by identity or by their canonical text. The work is
 * the number of members.
 */
const spliceBetween = (
  before: readonly unknown[],
  after: readonly unknown[],
): { start: number; removed: number; members: unknown[] } => {
  // A member written again holds its members in another order where the
  // writer formed it anew, as a link is: the text compared has one order.
  const same = (a: unknown, b: unknown) =>
    a === b || canonical(a) === canonical(b);
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && same(before[start], after[start])) start += 1;
  let end = 0;
  while (
    end < shorter - start &&
    same(before[before.length - 1 - end], after[after.length - 1 - end])
  ) end += 1;
  return {
    start,
    removed: before.length - end - start,
    members: after.slice(start, after.length - end),
  };
};

/**
 * The shortest prefix of `path` at which `before` or `after` holds a link,
 * or `path` where neither holds one on the way.
 */
const aboveLinks = (
  path: readonly string[],
  before: unknown,
  after: unknown,
): string[] => {
  for (let length = 0; length < path.length; length++) {
    const prefix = path.slice(0, length);
    if (
      isPrimitiveCellLink(valueAt(before, prefix)) ||
      isPrimitiveCellLink(valueAt(after, prefix))
    ) return prefix;
  }
  return [...path];
};

const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);

/**
 * The path below `value` of each stream of `wanted` that it holds, by the
 * stream: the executor stores a stream as `{ $stream: <the stream> }`, and
 * the stream is the object a marker was written for. A link is not followed.
 */
const streamPaths = (
  value: unknown,
  wanted: ReadonlySet<object>,
): Map<object, string[]> => {
  const found = new Map<object, string[]>();
  const walk = (held: unknown, at: string[]): void => {
    if (found.size === wanted.size) return;
    if (typeof held !== "object" || held === null || isLink(held)) return;
    if (isStream(held)) {
      if (wanted.has(held.$stream)) found.set(held.$stream, at);
      return;
    }
    if (Array.isArray(held)) {
      held.forEach((member, index) => walk(member, [...at, `${index}`]));
      return;
    }
    for (const [name, member] of Object.entries(held)) {
      walk(member, [...at, name]);
    }
  };
  walk(value, []);
  return found;
};

const isPrefix = (prefix: readonly string[], path: readonly string[]) =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

/** What a value holds at a path, or `undefined` where it holds nothing. */
const valueAt = (value: unknown, path: readonly string[]): unknown => {
  let at = value;
  for (const segment of path) {
    at = isWalkableObjectNotArray(at) || Array.isArray(at)
      ? (at as Record<string, unknown>)[segment]
      : undefined;
  }
  return at;
};

/**
 * The runtime's read shape of a plan's observation class (PL §2.2). A read
 * of `identity` is the runtime's `followRef`. An `enumeration` slot
 * observes which children its container has and resolves as a `shape`
 * read at the container's path, which consumes the `shape` and `enumerate`
 * entries there and no entry below it. The executor reads the array it
 * enumerates as a value, a wider read than the slot's, so the journal
 * holds no read in the slot's class and the runtime observes the label
 * stored at the path at commit.
 */
const observesOf = (observes: string): "value" | "shape" | "followRef" =>
  observes === "identity"
    ? "followRef"
    : observes === "shape" || observes === "enumeration"
    ? "shape"
    : "value";

/**
 * The label entries of stored labels, each as text by the text of its path;
 * entries at one path are one, their texts in order. An entry that labels a
 * read of its own path and no read below it (`appliesAtItsPathOnly`) is
 * marked, so that a change of such entries alone is told apart
 * (`changedLabelPaths`).
 */
const entriesOf = (metadata: CfcMetadata | undefined): Map<string, string> => {
  const byPath = new Map<string, string[]>();
  for (const entry of metadata?.labelMap.entries ?? []) {
    const path = JSON.stringify(entry.path);
    const texts = byPath.get(path) ?? [];
    // The text is the same for two entries that hold the same members in
    // another order, as an entry written again by another writer can.
    texts.push(
      `${
        appliesAtItsPathOnly(entry, isRuntimeMintedTemplate(entry))
          ? AT_ITS_PATH_ONLY
          : ""
      }${canonical(entry)}`,
    );
    byPath.set(path, texts);
  }
  return new Map(
    [...byPath].map(([path, texts]) => [path, texts.sort().join("\n")]),
  );
};

/** What marks, in `entriesOf`, an entry no read below its path consumes. */
const AT_ITS_PATH_ONLY = "\u0001";

/**
 * The paths whose entries differ between `before` and `after`, and those
 * among them where only entries that no read below the path consumes
 * differ (`LabelChange.alone`).
 */
const changedLabelPaths = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): { paths: string[][]; alone: string[][] } => {
  const below = (text: string | undefined) =>
    (text ?? "").split("\n").filter((entry) =>
      !entry.startsWith(AT_ITS_PATH_ONLY)
    ).join("\n");
  const paths: string[][] = [];
  const alone: string[][] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) === after.get(path)) continue;
    const parsed = JSON.parse(path) as string[];
    paths.push(parsed);
    if (below(before.get(path)) === below(after.get(path))) alone.push(parsed);
  }
  return { paths, alone };
};
