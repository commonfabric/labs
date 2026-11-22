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
  debugStr,
  type FabricValue,
  isWalkableObjectNotArray,
} from "@commonfabric/data-model";

import { createSigilLinkFromParsedLink, parseLink } from "../link-utils.ts";
import { isPrimitiveCellLink, type NormalizedFullLink } from "../link-types.ts";
import type { JSONSchema } from "../builder/types.ts";
import {
  type MemorySpace,
  recordRelevantSchemaWritePolicyInput,
} from "../cell.ts";
import type { CompiledPlan } from "../cfc/compiled-plans.ts";
import {
  appliesAtItsPathOnly,
  consumedEntriesForRead,
  isRuntimeMintedTemplate,
  labelForConsumedEntries,
} from "../cfc/consumed-label.ts";
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
  type ObservedPosition as RuntimeObserved,
  type PlanElements,
  type PlanWrite as RuntimePlanWrite,
  runtimeWritePolicyAuthorization,
  type SlotBinding as RuntimeSlotBinding,
  type SlotBindings as RuntimeSlotBindings,
} from "../cfc/types.ts";
import { readMaybeLink } from "../link-resolution.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
  TransactionCommitReceipt,
} from "../storage/interface.ts";
import type {
  Artifact,
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
  identifierOf,
  isLink,
  isStream,
  type Schema,
  type Store,
  type StreamPosition,
} from "../../../../base/pattern-compiler/exec/store.ts";

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

/** What a handed transaction leaves for when its commit is applied. */
type Handed = {
  unchanged: Map<string, Map<string, string>>;
  created: string[];
};

/** Keeps the documents of one executor in one space of a runtime. */
export class RuntimeTransactions implements TransactionHooks {
  readonly #runtime: Runtime;
  readonly #space: MemorySpace;
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
  };
  /** Whether `RuntimeCounts.recordBytes` is counted. */
  readonly #countRecordBytes: boolean;
  /** The identifier of each document the storage holds. */
  readonly #documents = new Set<string>();
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
  /** The paths the transaction in progress wrote, by document. */
  readonly #written = new Map<string, (readonly string[])[]>();
  /** The stored labels of each document `labelOf` read, per transaction. */
  readonly #metadata = new Map<string, CfcMetadata | undefined>();
  /**
   * The label entries of each document `labelOf` read, each as text by the
   * text of its path, which a change of the document is compared against.
   */
  readonly #entries = new Map<string, Map<string, string>>();
  /** The documents of `#entries` that a commit changed since. */
  readonly #touched = new Set<string>();
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
   * The storage transactions this adapter writes through, each with what
   * it leaves for when its commit is applied where it was handed.
   */
  readonly #own = new WeakMap<object, Handed | undefined>();
  /** The stream each entity that holds a stream marker is of. */
  readonly #streams = new Map<string, StreamOfExecutor>();
  /** The stream entities the transaction in progress wrote first. */
  #createdStreams: string[] = [];
  readonly #onStream:
    | ((entity: URI, stream: StreamOfExecutor) => void)
    | undefined;
  readonly #onChanges: ((changes: ChangeByOther[]) => void) | undefined;
  readonly #onApplied: (() => void) | undefined;
  readonly #onRefused: ((reason: string) => void) | undefined;

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
       * Called when the replica applied the commit of a transaction the
       * adapter was handed, after the executor was told of the labels it
       * stored.
       */
      applied?: () => void;
      /**
       * Called with the reason when the storage refused the commit of a
       * transaction the adapter was handed.
       */
      refused?: (reason: string) => void;
    } = {},
  ) {
    this.#runtime = runtime;
    this.#space = space;
    this.#owner = options.owner;
    this.#onStream = options.stream;
    this.#onChanges = options.changes;
    this.#onApplied = options.applied;
    this.#onRefused = options.refused;
    this.#countRecordBytes = options.countRecordBytes === true;
    this.#compiledPattern = options.artifact === undefined ||
        !runtime.experimental.compiledPatterns || !runtime.servingPosture
      ? undefined
      : this.#register(options.artifact);
    if (this.#compiledPattern !== undefined || this.#onChanges !== undefined) {
      // A commit of the space, the executor's own or another's, can change
      // the labels of a document whose positions the executor grouped
      // elements by, and another writer's can change a value the executor
      // holds.
      this.#subscription = {
        next: (notification) => {
          if (
            notification.type === "reset" ||
            notification.space !== this.#space
          ) {
            return undefined;
          }
          const source = "source" in notification
            ? notification.source
            : undefined;
          const own = source !== undefined && this.#own.has(source);
          const byOther: ChangeByOther[] = [];
          const seen = new Set<string>();
          for (const { address, before, after } of notification.changes) {
            const doc = this.#byEntity.get(address.id);
            if (doc === undefined) continue;
            if (this.#entries.has(doc)) this.#touched.add(doc);
            if (
              own || this.#onChanges === undefined ||
              address.scope !== "space" || !this.#documents.has(doc) ||
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
            if (!Array.isArray(now) || !Array.isArray(then)) {
              byOther.push({ doc, path: at, value: this.#decode(now) });
              continue;
            }
            const splice = spliceBetween(then, now);
            byOther.push({
              doc,
              path: at,
              splice: {
                start: splice.start,
                removed: splice.removed,
                members: splice.members.map((member) => this.#decode(member)),
              },
            });
          }
          if (own && notification.type === "commit") {
            const handed = this.#own.get(source!);
            if (handed !== undefined) this.#applied(handed);
          }
          if (byOther.length > 0) this.#onChanges?.(byOther);
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
      const doc = this.#byEntity.get(address.id);
      return doc !== undefined && address.space === this.#spaceOf(doc);
    });
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
    let context = this.#contexts.get(pattern);
    if (context === undefined) {
      context = {
        pattern,
        recorded: { writes: [], interner: new PlanInputsInterner() },
        converted: undefined,
      };
      this.#contexts.set(pattern, context);
    }
    this.#context = context;
  }

  /** @inheritDoc */
  instantiated(instance: string, artifact: Artifact): void {
    if (this.#compiledPattern === undefined) return;
    this.#patternOf.set(instance, this.#register(artifact));
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
    this.entityOf(doc);
    this.#documents.add(doc);
    if (space !== undefined) this.#spaces.set(doc, space);
  }

  /** The space a document of the executor is in. */
  #spaceOf(doc: string): MemorySpace {
    return this.#spaces.get(doc) ?? this.#space;
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
    const tx = this.#runtime.edit();
    try {
      for (const doc of this.#touched) {
        this.#metadata.delete(doc);
        const before = this.#entries.get(doc) ?? new Map();
        const after = entriesOf(this.#storedLabels(tx, doc));
        this.#entries.set(doc, after);
        const { paths, alone } = changedLabelPaths(before, after);
        if (paths.length > 0) {
          changes.push({ doc, paths, ...(alone.length > 0 ? { alone } : {}) });
        }
      }
    } finally {
      tx.abort();
      this.#touched.clear();
    }
    if (changes.length > 0) this.#labelsChanged?.(changes, false, stored);
  }

  /** The stored labels of a document of the executor, read through `tx`. */
  #storedLabels(
    tx: IExtendedStorageTransaction,
    doc: string,
  ): CfcMetadata | undefined {
    return readStoredCfcMetadata(tx, {
      space: this.#spaceOf(doc),
      id: this.entityOf(doc),
      scope: "space",
    });
  }

  /** @inheritDoc */
  begin(cause: Transaction["cause"] | "send" | "watermark"): void {
    if (this.#tx !== undefined) {
      throw new Error("A transaction began while another was open.");
    }
    if (this.#given !== undefined) {
      // Every transaction the executor opens while the adapter holds a
      // handed transaction is written into that one.
      this.#cause = cause;
      this.#tx = this.#given.tx;
      return;
    }
    this.#reportLabels();
    this.#cause = cause;
    this.#tx = this.#runtime.edit();
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
    this.#resetRecorded();
    this.#stagedState = 0;
    this.#created = [];
    this.#createdStreams = [];
  }

  /**
   * Runs `run` with every transaction the executor opens in it written
   * into `tx`, which the caller commits: the adapter records the write
   * records with the runtime when `run` returns, and neither prepares nor
   * commits. Where a transaction of the executor did not commit, `tx` is
   * aborted. The executor is told of the labels the commit stored when the
   * replica applies it.
   */
  within<T>(tx: IExtendedStorageTransaction, run: () => T): T {
    if (this.#tx !== undefined || this.#given !== undefined) {
      throw new Error("A transaction was handed while another was open.");
    }
    this.#reportLabels();
    const given: Given = { tx, failed: undefined };
    this.#given = given;
    this.#resetTransaction();
    let result: T;
    try {
      result = run();
    } catch (error) {
      this.#given = undefined;
      this.#tx = undefined;
      this.#dropCreated();
      this.#unchanged.clear();
      throw error;
    }
    this.#given = undefined;
    if (given.failed !== undefined) {
      this.#dropCreated();
      this.#unchanged.clear();
      tx.abort(new Error(given.failed));
      return result;
    }
    this.#recordWrites(tx);
    const handed: Handed = {
      unchanged: new Map(this.#unchanged),
      created: [...this.#created, ...this.#createdStreams],
    };
    this.#unchanged.clear();
    this.#own.set(tx.tx, handed);
    tx.addCommitCallback((_tx, { error }) => {
      if (error === undefined) return;
      // The storage does not hold a document whose first write was
      // refused.
      for (const doc of handed.created) {
        this.#documents.delete(doc);
        this.#streams.delete(doc);
      }
      this.#onRefused?.(`${error.name}: ${error.message}`);
    });
    this.#resetRecorded();
    this.#created = [];
    this.#createdStreams = [];
    return result;
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
    const table = this.#runtime.compiledPlans.labels;
    if (!this.#metadata.has(doc)) {
      const tx = this.#tx ?? this.#runtime.edit();
      try {
        const metadata = this.#storedLabels(tx, doc);
        this.#metadata.set(doc, metadata);
        if (!this.#entries.has(doc)) {
          this.#entries.set(doc, entriesOf(metadata));
        }
      } finally {
        if (tx !== this.#tx) tx.abort();
      }
    }
    const metadata = this.#metadata.get(doc);
    if (metadata === undefined) return table.empty.id;
    // The class the runtime observes the position in (`observesOf`), read
    // as its observation of a label alone is: below the position too for a
    // read of the value, and at the position for the other classes.
    const consumes = observesOf(observes);
    const label = labelForConsumedEntries(
      consumedEntriesForRead(metadata, path, {
        nonRecursive: consumes !== "value",
        consumes,
      }),
      path,
      consumes !== "value",
    );
    return table.intern({
      confidentiality: [...label?.confidentiality ?? []],
      integrity: [...label?.integrity ?? []],
    }).id;
  }

  /** @inheritDoc */
  change(
    doc: string,
    path: readonly string[],
    store: Store,
    schema?: Schema,
    writes?: readonly PlanWrite[],
    splice?: { start: number; removed: number; inserted: number },
    inputs?: InputsTable,
  ): void {
    const tx = this.#open();
    this.#counts.writes += 1;
    this.#stagedState += 1;
    const written = this.#written.get(doc) ?? [];
    this.#written.set(doc, written);
    const document = store.docs.get(doc);
    const attempts = tx.getWriteAttemptLog?.().length;
    // Whether the change was written as the positions of a splice, which
    // are then the paths written, and the path of the change is not.
    let spliced = false;
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
      tx.writeValueOrThrow(
        this.#address(doc, []),
        this.#encode(document.value),
      );
      this.#enroll(tx, doc);
    } else {
      const parent = path.length === 0
        ? undefined
        : store.peek(doc, path.slice(0, -1));
      const absent = path.length > 0 && isWalkableObjectNotArray(parent) &&
        !Object.hasOwn(parent, path[path.length - 1]);
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
          tx.writeValueOrThrow(
            this.#address(doc, [...path, "length"]),
            held.length,
          );
        }
        for (let at = splice.start; at < end; at++) {
          written.push([...path, `${at}`]);
          tx.writeValueOrThrow(
            this.#address(doc, [...path, `${at}`]),
            this.#encode(held[at]),
          );
        }
      } else if (absent) {
        tx.writeValueOrThrow(this.#address(doc, path), undefined, {
          delete: true,
        });
      } else {
        tx.writeValueOrThrow(
          this.#address(doc, path),
          this.#encode(store.peek(doc, path)),
        );
      }
    }
    if (!spliced) written.push([...path]);
    // A write can change the label of a value a reader's own value does
    // not change with, so the label entries the document stores before
    // the transaction are kept as for a write that changes no value.
    if (this.#compiledPattern !== undefined) this.#noteUnchanged(doc);
    // The write policy of the write, as a cell's write records it
    // (`Cell.set`): the schema the write was made under where it declares
    // labels, and otherwise the schema the document's stored labels name.
    // A schema of a plan is a JSON schema with the members the executor
    // reads typed (`Schema` of `exec/store.ts`).
    this.#recordSchema(tx, doc, path, schema, store);
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
    this.#record(
      writes,
      attempts !== undefined && tx.getWriteAttemptLog?.().length === attempts,
      inputs,
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
    const isIndex = (at: number) =>
      /^(0|[1-9][0-9]*)$/.test(path[at]) &&
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
      return;
    }
    const tx = this.#runtime.edit();
    try {
      this.#unchanged.set(doc, entriesOf(this.#storedLabels(tx, doc)));
    } finally {
      tx.abort();
    }
  }

  /**
   * Tells the executor of the label entries that the transaction that just
   * committed changed in the documents of `#unchanged`, where it changed
   * a label and no value, and counts them.
   */
  #reportUnchanged(unchanged = this.#unchanged, stored = false): void {
    if (unchanged.size === 0) return;
    const changes: LabelChange[] = [];
    const tx = this.#runtime.edit();
    try {
      for (const [doc, before] of unchanged) {
        const after = entriesOf(this.#storedLabels(tx, doc));
        const { paths, alone } = changedLabelPaths(before, after);
        if (paths.length === 0) continue;
        this.#counts.labelEntriesChanged += paths.length;
        changes.push({ doc, paths, ...(alone.length > 0 ? { alone } : {}) });
      }
    } finally {
      tx.abort();
      unchanged.clear();
    }
    if (changes.length > 0) this.#labelsChanged?.(changes, true, stored);
  }

  /** @inheritDoc */
  unchanged(
    doc: string,
    path: readonly string[],
    store: Store,
    schema: Schema | undefined,
    writes: readonly PlanWrite[],
    inputs: InputsTable,
  ): void {
    if (this.#compiledPattern === undefined) return;
    const tx = this.#open();
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
  ): void {
    if (this.#compiledPattern === undefined) return;
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
        target: this.#cfcAddress(write.target),
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
        this.#noteUnchanged(write.target.doc);
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
  #recordWrites(tx: IExtendedStorageTransaction): void {
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
    for (const { pattern, recorded } of this.#contexts.values()) {
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
    }
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
  #binding(binding: SlotBinding, staged: boolean): RuntimeSlotBinding {
    if ("output" in binding) return { output: binding.output };
    if ("constant" in binding) return { constant: true };
    if ("staged" in binding) {
      return { staged: this.#cfcAddress(binding.staged) };
    }
    // A staged position that the read crossed links to, or that holds
    // links the read followed, keeps those positions: the binding names
    // them all, marked as read after the write.
    if (staged && binding.chain.length === 1 && binding.below === undefined) {
      return { staged: this.#cfcAddress(binding.chain[0]) };
    }
    // A position the transaction did not read, such as the one an element
    // of a fold's group read in an earlier transaction, is the runtime's to
    // observe: it observes the label stored there in the committing
    // transaction and reads no value (ruling (c)).
    const observes = observesOf(binding.observes);
    return {
      chain: binding.chain.map((address) => this.#cfcAddress(address)),
      observes,
      ...(binding.below === undefined ? {} : {
        below: binding.below.map((chain) =>
          chain.map((address) => this.#cfcAddress(address))
        ),
      }),
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
    return (this.#written.get(doc) ?? []).some((written) =>
      written.length <= path.length &&
      written.every((segment, index) => segment === path[index])
    );
  }

  /** The runtime's address of a position of a document of the executor. */
  #cfcAddress({ doc, path }: Address): CfcAddress {
    return {
      space: this.#spaceOf(doc),
      id: this.entityOf(doc),
      scope: "space",
      path: [...path],
    };
  }

  /** @inheritDoc */
  end({ committed }: { committed: boolean }): void {
    const tx = this.#open();
    this.#tx = undefined;
    if (this.#given !== undefined) {
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
    const tx = this.#runtime.edit();
    try {
      return new Map(
        [...this.#documents].map((
          doc,
        ) => [doc, this.#decode(tx.readValueOrThrow(this.#address(doc, [])))]),
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
    const entity: URI = doc.startsWith("of:") ? doc as URI : `of:${doc}`;
    this.#byEntity.set(entity, doc);
    return entity;
  }

  /** The document of the executor that an entity holds. */
  documentOf(entity: string): string {
    return this.#byEntity.get(entity) ?? entity;
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

  /** Helper for the hooks, which gives the transaction in progress. */
  #open(): IExtendedStorageTransaction {
    if (this.#tx === undefined) {
      throw new Error("The executor used a transaction that is not open.");
    }
    return this.#tx;
  }

  /** The address of a path of a document of the executor. */
  #address(doc: string, path: readonly string[]): NormalizedFullLink {
    return {
      space: this.#spaceOf(doc),
      id: this.entityOf(doc),
      path: [...path],
      scope: "space",
    };
  }

  /**
   * A value of the executor, with each link written as the runtime's. The
   * executor's documents hold JSON values and its own records of a link,
   * a stream and an error state, which are records too.
   */
  #encode(value: unknown): FabricValue {
    if (this.#onStream !== undefined && isStream(value)) {
      return createSigilLinkFromParsedLink({
        id: this.#streamEntity(value.$stream),
        space: this.#space,
        path: [],
      });
    }
    if (isLink(value)) {
      const { doc, path, schema } = value.$link;
      return createSigilLinkFromParsedLink(
        {
          id: this.entityOf(doc),
          space: this.#spaceOf(doc),
          path,
          // A schema of a plan is a JSON schema with the members the
          // executor reads typed (`Schema` of `exec/store.ts`).
          ...(schema === undefined ? {} : { schema: schema as JSONSchema }),
        },
        { includeSchema: true },
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
    if (!this.#streams.has(entity)) {
      this.#streams.set(entity, stream);
      this.#createdStreams.push(entity);
      this.#open().writeValueOrThrow(
        { space: this.#space, id: entity, path: [], scope: "space" },
        { $stream: true },
      );
      this.#onStream?.(entity, stream);
    }
    return entity;
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
    if (!id.startsWith("of:") || this.#streams.has(id)) return undefined;
    const address = this.#address(id, []);
    const read = this.#runtime.edit();
    let value: FabricValue | undefined;
    try {
      value = read.readValueOrThrow(address);
    } finally {
      read.abort();
    }
    // A document that the transaction in progress wrote, as one handed with
    // the inputs staged in it, is read through that transaction.
    if (value === undefined && this.#tx !== undefined) {
      value = this.#tx.readValueOrThrow(address);
    }
    if (value === undefined) return undefined;
    this.#documents.add(id);
    return { kind: "external", value: this.#decode(value) };
  }

  /** A stored value, with each of the runtime's links written back. */
  #decode(value: unknown): unknown {
    if (isPrimitiveCellLink(value)) {
      const link = parseLink(value);
      const stream = this.#streams.get(link.id ?? "");
      if (stream !== undefined) return { $stream: stream };
      return {
        $link: {
          doc: this.documentOf(link.id ?? ""),
          path: [...link.path],
          ...(link.schema === undefined
            ? {}
            : { schema: link.schema as Schema }),
        },
      };
    }
    if (Array.isArray(value)) {
      return value.map((member) => this.#decode(member));
    }
    if (isWalkableObjectNotArray(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, member]) => [
          name,
          this.#decode(member),
        ]),
      );
    }
    return value;
  }
}

/**
 * The one run of positions in which two arrays differ, as the splice that
 * makes `after` of `before`: the members before the run and behind it are
 * the same in both, by identity or by their JSON text. The work is the
 * number of members.
 */
const spliceBetween = (
  before: readonly unknown[],
  after: readonly unknown[],
): { start: number; removed: number; members: unknown[] } => {
  const same = (a: unknown, b: unknown) =>
    a === b || JSON.stringify(a) === JSON.stringify(b);
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
    texts.push(
      `${
        appliesAtItsPathOnly(entry, isRuntimeMintedTemplate(entry))
          ? AT_ITS_PATH_ONLY
          : ""
      }${JSON.stringify(entry)}`,
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
