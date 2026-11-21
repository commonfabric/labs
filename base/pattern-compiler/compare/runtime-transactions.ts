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

import {
  createSigilLinkFromParsedLink,
  parseLink,
} from "../../../runtime/runner/src/link-utils.ts";
import {
  isPrimitiveCellLink,
  type NormalizedFullLink,
} from "../../../runtime/runner/src/link-types.ts";
import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
import {
  type MemorySpace,
  recordRelevantSchemaWritePolicyInput,
} from "../../../runtime/runner/src/cell.ts";
import type { CompiledPlan } from "../../../runtime/runner/src/cfc/compiled-plans.ts";
import {
  consumedEntriesForRead,
  labelForConsumedEntries,
} from "../../../runtime/runner/src/cfc/consumed-label.ts";
import { readStoredCfcMetadata } from "../../../runtime/runner/src/cfc/metadata.ts";
import { runtimeOwnedStoreOwnerKey } from "../../../runtime/runner/src/cfc/runtime-owned-stores.ts";
import {
  type CfcAddress,
  type CfcMetadata,
  type ObservedPosition as RuntimeObserved,
  type PlanElements,
  type PlanInputs as RuntimePlanInputs,
  type PlanWrite as RuntimePlanWrite,
  runtimeWritePolicyAuthorization,
  type SlotBinding as RuntimeSlotBinding,
  type SlotBindings as RuntimeSlotBindings,
} from "../../../runtime/runner/src/cfc/types.ts";
import { readMaybeLink } from "../../../runtime/runner/src/link-resolution.ts";
import type { Runtime } from "../../../runtime/runner/src/runtime.ts";
import type { URI } from "../../../runtime/runner/src/sigil-types.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
  TransactionCommitReceipt,
} from "../../../runtime/runner/src/storage/interface.ts";
import type {
  Artifact,
  LabelChange,
  Transaction,
  TransactionHooks,
} from "../exec/executor.ts";
import type {
  Address,
  FoldElements,
  Observed,
  PlanInputs,
  PlanWrite,
  SlotBinding,
  SlotBindings,
} from "../exec/plan-write.ts";
import { isLink, type Schema, type Store } from "../exec/store.ts";

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
  /**
   * The paths whose label entries a commit changed in a document for which
   * it recorded such a write record.
   */
  labelEntriesChanged: number;
};

/**
 * A write record as the adapter recorded it with the runtime: the runtime's
 * `plan-write` input without its kind.
 */
export type RecordedPlanWrite = RuntimePlanWrite;

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
    writes: RecordedPlanWrite[];
    created: string[];
  }[] = [];
  /** The write records recorded in the transaction in progress. */
  #recorded: RecordedPlanWrite[] = [];
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
    labelEntriesChanged: 0,
  };
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
    | ((changes: readonly LabelChange[], alone?: boolean) => void)
    | undefined;
  /** The subscription that hears of the commits of the space. */
  readonly #subscription: IStorageNotification | undefined;

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
    } = {},
  ) {
    this.#runtime = runtime;
    this.#space = space;
    this.#owner = options.owner;
    this.#compiledPattern = options.artifact === undefined ||
        !runtime.experimental.compiledPatterns || !runtime.servingPosture
      ? undefined
      : runtime.compiledPlans.register(
        // The plan as the crate emits it carries every member the
        // runtime reads.
        options.artifact.plan as unknown as CompiledPlan,
        JSON.stringify(options.artifact.code),
        runtimeWritePolicyAuthorization,
      );
    if (this.#compiledPattern !== undefined) {
      // A commit of the space, the executor's own or another's, can change
      // the labels of a document whose positions the executor grouped
      // elements by.
      this.#subscription = {
        next: (notification) => {
          if (
            notification.type === "reset" ||
            notification.space !== this.#space
          ) {
            return undefined;
          }
          for (const { address } of notification.changes) {
            const doc = this.#byEntity.get(address.id);
            if (doc !== undefined && this.#entries.has(doc)) {
              this.#touched.add(doc);
            }
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
      const doc = this.#byEntity.get(address.id);
      return doc !== undefined && address.space === this.#spaceOf(doc);
    });
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
    changed: (changes: readonly LabelChange[], alone?: boolean) => void,
  ): void {
    this.#labelsChanged = changed;
  }

  /**
   * Tells the executor of the label entries that changed in each document
   * a commit touched since the last call: those added, removed or changed,
   * by path. The work is the number of entries of the touched documents.
   */
  #reportLabels(): void {
    if (this.#touched.size === 0) return;
    const changes: LabelChange[] = [];
    const tx = this.#runtime.edit();
    try {
      for (const doc of this.#touched) {
        this.#metadata.delete(doc);
        const before = this.#entries.get(doc) ?? new Map();
        const after = entriesOf(this.#storedLabels(tx, doc));
        this.#entries.set(doc, after);
        const paths = new Set<string>();
        for (const [path, label] of after) {
          if (before.get(path) !== label) paths.add(path);
        }
        for (const path of before.keys()) {
          if (!after.has(path)) paths.add(path);
        }
        if (paths.size > 0) {
          changes.push({
            doc,
            paths: [...paths].map((path) => JSON.parse(path) as string[]),
          });
        }
      }
    } finally {
      tx.abort();
      this.#touched.clear();
    }
    if (changes.length > 0) this.#labelsChanged?.(changes);
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
    this.#reportLabels();
    this.#cause = cause;
    this.#tx = this.#runtime.edit();
    this.#read.clear();
    this.#readBeforeWrite.clear();
    this.#readAfterWrite.clear();
    this.#written.clear();
    this.#metadata.clear();
    this.#recorded = [];
    this.#created = [];
  }

  /** @inheritDoc */
  read(doc: string, path: readonly string[]): void {
    const tx = this.#open();
    const text = JSON.stringify([doc, path]);
    const wrote = this.#wrote({ doc, path });
    if (wrote) this.#readAfterWrite.add(text);
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
  ): void {
    const tx = this.#open();
    this.#counts.writes += 1;
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
    this.#record(
      tx,
      writes ?? [],
      attempts !== undefined && tx.getWriteAttemptLog?.().length === attempts,
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
  #reportUnchanged(): void {
    if (this.#unchanged.size === 0) return;
    const changes: LabelChange[] = [];
    const tx = this.#runtime.edit();
    try {
      for (const [doc, before] of this.#unchanged) {
        const after = entriesOf(this.#storedLabels(tx, doc));
        const paths = [...new Set([...before.keys(), ...after.keys()])]
          .filter((path) => before.get(path) !== after.get(path));
        if (paths.length === 0) continue;
        this.#counts.labelEntriesChanged += paths.length;
        changes.push({
          doc,
          paths: paths.map((path) => JSON.parse(path) as string[]),
        });
      }
    } finally {
      tx.abort();
      this.#unchanged.clear();
    }
    if (changes.length > 0) this.#labelsChanged?.(changes, true);
  }

  /** @inheritDoc */
  unchanged(
    doc: string,
    path: readonly string[],
    store: Store,
    schema: Schema | undefined,
    writes: readonly PlanWrite[],
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
    this.#record(tx, writes, true);
  }

  /**
   * Records each write record with the runtime as an authorized
   * `plan-write` input: `unchanged` for a write that left the value at its
   * target as it was.
   */
  #record(
    tx: IExtendedStorageTransaction,
    writes: readonly PlanWrite[],
    unchanged: boolean,
  ): void {
    if (this.#compiledPattern === undefined) return;
    // The records of one change of the members of a list hold one array of
    // what the change compared, and one set of bindings: each is given to
    // the runtime as one object.
    const observed = (positions: readonly Observed[]) =>
      positions.map(({ address, observes, alone }) => ({
        address: this.#cfcAddress(address),
        observes: observesOf(observes),
        ...(alone ? { alone: true as const } : {}),
      }));
    const decidedOf = new Map<readonly Observed[], RuntimeObserved[]>();
    const inputsOf = new Map<
      SlotBindings,
      { write: PlanWrite; inputs: RuntimePlanInputs }
    >();
    for (const write of writes) {
      let decided = write.decided === undefined
        ? undefined
        : decidedOf.get(write.decided);
      if (write.decided !== undefined && decided === undefined) {
        decided = observed(write.decided);
        decidedOf.set(write.decided, decided);
      }
      let shared = inputsOf.get(write.slots);
      if (
        shared === undefined || shared.write.selections !== write.selections ||
        shared.write.picks !== write.picks ||
        shared.write.elements !== write.elements ||
        shared.write.dynamic !== write.dynamic ||
        shared.write.outputs !== write.outputs
      ) {
        shared = { write, inputs: this.#inputs(write) };
        inputsOf.set(write.slots, shared);
      }
      const recorded: RecordedPlanWrite = {
        ...shared.inputs,
        target: this.#cfcAddress(write.target),
        compiledPattern: this.#compiledPattern,
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
      };
      this.#recorded.push(recorded);
      if (unchanged) {
        this.#counts.unchangedRecords += 1;
        this.#noteUnchanged(write.target.doc);
      }
      // The runtime's mark: this adapter stands in for the runner, which
      // records what its own code computed.
      tx.recordCfcWritePolicyInput(
        { kind: "plan-write", ...recorded },
        runtimeWritePolicyAuthorization,
      );
    }
  }

  /** The inputs of one place of a write record, as the runtime reads them. */
  #inputs(place: PlanInputs): RuntimePlanInputs {
    const entries = <T, U>(
      record: Record<number, T> | undefined,
      as: (value: T) => U,
    ): Record<number, U> | undefined =>
      record === undefined ? undefined : Object.fromEntries(
        Object.entries(record).map(([index, value]) => [index, as(value)]),
      );
    return {
      slots: this.#slots(place.slots),
      ...(place.selections === undefined
        ? {}
        : { selections: place.selections }),
      ...(place.picks === undefined ? {} : {
        picks: entries(
          place.picks,
          (chosen) =>
            chosen === null ? null : { slots: this.#slots(chosen.slots) },
        ),
      }),
      ...(place.elements === undefined ? {} : {
        elements: entries(
          place.elements,
          (elements) => this.#elements(elements),
        ),
      }),
      ...(place.dynamic === undefined ? {} : {
        dynamic: entries(
          place.dynamic,
          (addresses) => addresses.map((address) => this.#cfcAddress(address)),
        ),
      }),
      ...(place.outputs === undefined ? {} : {
        outputs: entries(place.outputs, (inputs) => this.#inputs(inputs)),
      }),
    };
  }

  /** The elements of a fold, as the runtime reads them. */
  #elements(elements: FoldElements): PlanElements {
    return "uniform" in elements
      ? { uniform: this.#inputs(elements.uniform) }
      : {
        groups: elements.groups.map(({ count, ...inputs }) => ({
          ...this.#inputs(inputs),
          count,
        })),
      };
  }

  /**
   * The bindings of slots, as the runtime reads them. A plan's class
   * `identity` is the runtime's `followRef`. A slot whose position the
   * transaction in progress wrote takes the label staged there.
   */
  #slots(slots: SlotBindings): RuntimeSlotBindings {
    return Object.fromEntries(
      Object.entries(slots).map(([slot, binding]) => [
        slot,
        this.#binding(binding),
      ]),
    );
  }

  /** Helper for `#slots()`, for one binding. */
  #binding(binding: SlotBinding): RuntimeSlotBinding {
    if ("output" in binding) return { output: binding.output };
    if ("constant" in binding) return { constant: true };
    if ("staged" in binding) {
      return { staged: this.#cfcAddress(binding.staged) };
    }
    const last = binding.chain.at(-1);
    // A position the transaction read before it wrote it, and only then,
    // holds for the slot what the read found: its stored label, and not
    // the label the write stages, which a write edge that reads its own
    // target would make depend on itself. A position it read after the
    // write holds what the write made, whose label is the staged one; the
    // binding names no read, so a position read both before and after the
    // write takes the staged label, and a slot whose label then depends on
    // itself is refused as a cycle.
    // A staged position that the read crossed links to, or that holds
    // links the read followed, keeps those positions: the binding names
    // them all, marked as read after the write.
    const position = JSON.stringify([last?.doc, last?.path]);
    const staged = last !== undefined && this.#wrote(last) &&
      (this.#readAfterWrite.has(position) ||
        !this.#readBeforeWrite.has(position));
    if (staged && binding.chain.length === 1 && binding.below === undefined) {
      return { staged: this.#cfcAddress(last) };
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
    this.#runtime.prepareTxForCommit(tx);
    const refused = tx.getCfcState().prepare.status === "invalidated";
    if (refused) {
      for (const doc of this.#written.keys()) this.#documents.delete(doc);
    }
    this.#receipts.push({
      receipt: tx.commit(),
      writes: this.#recorded,
      // A document forgotten here may be written again by a later
      // transaction before this one settles.
      created: refused ? [] : this.#created,
    });
    this.#recorded = [];
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
    for (const { receipt, writes, created } of this.#receipts.splice(0)) {
      const { error } = await receipt.settled;
      if (error === undefined) {
        this.#onCommitted?.(writes);
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

  /** A stored value, with each of the runtime's links written back. */
  #decode(value: unknown): unknown {
    if (isPrimitiveCellLink(value)) {
      const link = parseLink(value);
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
 * entries at one path are one, their texts in order.
 */
const entriesOf = (metadata: CfcMetadata | undefined): Map<string, string> => {
  const byPath = new Map<string, string[]>();
  for (const entry of metadata?.labelMap.entries ?? []) {
    const path = JSON.stringify(entry.path);
    const texts = byPath.get(path) ?? [];
    texts.push(JSON.stringify(entry));
    byPath.set(path, texts);
  }
  return new Map(
    [...byPath].map(([path, texts]) => [path, texts.sort().join("\n")]),
  );
};
