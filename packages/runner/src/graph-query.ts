/**
 * The driver a storage engine uses to resolve a schema graph query: given
 * documents the engine supplies, walk them under a schema and record every
 * document that schema reaches.
 *
 * A memory server resolves a subscriber's watch set with this, while a client
 * asks the same question of a live replica through `schema.ts`. Both run the
 * one traversal in `traverse.ts`, because a server and a client that disagree
 * about which documents a schema reaches leave the client waiting on a
 * document nobody will send. This module is the whole of what a storage engine
 * needs from the runtime to take part in that, and it re-exports the vocabulary
 * the two sides name in common so a caller reaches for one module rather than
 * the traversal's internals.
 */

import type { FabricValue } from "@commonfabric/data-model";
import { internPathSelector } from "@commonfabric/data-model-schema";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  CellScope,
  ScopeKey,
  ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "./builder/types.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import {
  type BaseMemoryAddress,
  CompoundCycleTracker,
  createSchemaMemo,
  createTraversalContext,
  getAtPath,
  type IAttestation,
  type IMemorySpaceValueAttestation,
  loadLabelSchemaDoc,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  type SchemaMemo,
  SchemaObjectTraverser,
  type SchemaPathSelector,
  schemaTrackerCoversSelector,
  schemaTrackerKey,
  type TraversalContext,
} from "./traverse.ts";

export type {
  BaseMemoryAddress,
  IAttestation,
  ObjectStorageManager,
  SchemaPathSelector,
};
export {
  createSchemaMemo,
  MapSetStringToPathSelectors,
  type SchemaMemo,
  schemaTrackerCoversSelector,
  schemaTrackerKey,
};

/** Counters a walk accumulates, for query diagnostics and benchmarks. */
export type GraphQueryWalkStats = {
  coveredSelectorSkips: number;
  schemaTraversals: number;
  pointerTraversals: number;
  arrayTraversals: number;
  objectTraversals: number;
  dagTraversals: number;
  getDocAtPathCalls: number;
  schemaMemoHits: number;
};

export const createGraphQueryWalkStats = (): GraphQueryWalkStats => ({
  coveredSelectorSkips: 0,
  schemaTraversals: 0,
  pointerTraversals: 0,
  arrayTraversals: 0,
  objectTraversals: 0,
  dagTraversals: 0,
  getDocAtPathCalls: 0,
  schemaMemoHits: 0,
});

/**
 * The key a walk records a crossing under: the target document by space,
 * scope NAME, and id, as one JSON array, so any character in an id survives
 * the round trip. The scope stays a name rather than resolving to an
 * instance, since the client that loads the target resolves it under its
 * own identity.
 */
export const crossingDocKey = (
  space: MemorySpace,
  id: string,
  scope: CellScope | undefined,
): string => JSON.stringify([space, scope ?? "space", id]);

/** The parts of a {@link crossingDocKey}. */
export const parseCrossingDocKey = (
  key: string,
): { space: MemorySpace; scope: CellScope; id: string } => {
  const [space, scope, id] = JSON.parse(key) as [string, string, string];
  return { space: space as MemorySpace, scope: scope as CellScope, id };
};

export type GraphQueryWalkOptions = {
  /** Supplies documents by address. */
  manager: ObjectStorageManager;

  /** Space the visited documents belong to. */
  space: MemorySpace;

  /**
   * Receives one entry per document the walk reached, keyed by
   * `schemaTrackerKey`. Share it across walks to accumulate the reach of a
   * whole query; the walk reads it too, and skips a document whose selector
   * it already covers.
   */
  schemaTracker: MapSetStringToPathSelectors;

  /**
   * The acting identity the walk's tracker keys resolve scoped addresses
   * against (key-vocabulary.md §1 sites 5–6): coverage proven for one scope
   * INSTANCE is not coverage of another. The identity arrives with the work
   * — the memory server's query path supplies the querying session's —
   * never from ambient state (key-vocabulary.md §3).
   */
  identity: ScopeKeyIdentity;

  /**
   * Receives one call per SAME-SPACE document a value-link hop tried to
   * read and found ABSENT: the miss's tracker-style key, the
   * target-rooted selector the read needed, and the key of the REFERRER
   * document whose link dead-ended. A value link the walk dead-ends on
   * is a READ of that document, so the graph must stay reactive to it:
   * the recorded miss is what lets the target's later CREATION re-fire
   * the query — the session wake pass and the dirty refresh both consult
   * it — and without one a quiet space never heals the miss (the OW45
   * arm-B first-read lottery: first-hydration create-then-read ends with
   * a write followed by pure reads, so no later commit exists to deliver
   * through). The referrer key is the miss's lifecycle: a referrer that
   * is re-walked and no longer dead-ends retires the misses it
   * attributed. Deliberately SEPARATE from the schema tracker: tracker
   * entries materialize as delivered entities — absence markers on the
   * wire — while a miss is server-side reactivity only, and the client's
   * view stays exactly as today until the document exists (the dedicated
   * absence-confirmation flows depend on that). The meta-doc loader
   * keeps tracking its absent targets in the tracker (delivered whole,
   * marker included) — its narrower pre-existing contract.
   */
  onMissedDoc?: (
    missKey: string,
    selector: SchemaPathSelector,
    referrerKey: string | undefined,
  ) => void;

  /**
   * Receives one call per value link the walk followed into ANOTHER space:
   * the target's crossing key (`crossingDocKey`), the target-rooted
   * selector the read needed there, and the key of the referrer document
   * whose link crossed. The walk reads one space, so the target is never
   * loaded here; a client told of the crossing loads it from the target
   * space under that selector. Attributed to the referrer the way a miss
   * is, so a referrer re-walked without the link retires it.
   */
  onCrossing?: (
    crossingKey: string,
    selector: SchemaPathSelector,
    referrerKey: string | undefined,
  ) => void;

  /** Schema-traversal results reused across walks that share it. */
  memo?: SchemaMemo;

  /** Counters to add into. */
  stats?: GraphQueryWalkStats;
};

/**
 * Resolves a schema query against documents a storage engine supplies, rather
 * than against a live replica: the traversal a memory server runs to decide
 * which documents a subscriber's schema reaches.
 *
 * A walk owns a pointer-cycle tracker, so a link cycle terminates. The schema
 * tracker and the memo are handed in instead, so several walks can share them
 * and accumulate the reach of one query between them.
 */
export class GraphQueryWalk {
  readonly #manager: ObjectStorageManager;
  readonly #space: MemorySpace;
  readonly #identity: ScopeKeyIdentity;
  readonly #context: TraversalContext;
  readonly #memo: SchemaMemo;
  readonly stats: GraphQueryWalkStats;

  /** identity-derived key → the caller-supplied key a visit recorded
   * under (a query root naming an explicit scope INSTANCE — protocol.md
   * §2's read row). Miss attribution consults this so a miss recorded
   * from inside such a root attributes to the key the refresh will
   * later release, not to a session-resolved key nothing ever walks. */
  readonly #keyOverrides = new Map<string, string>();

  constructor(options: GraphQueryWalkOptions) {
    this.#manager = options.manager;
    this.#space = options.space;
    this.#identity = options.identity;
    const { space, identity, onMissedDoc, onCrossing } = options;
    this.#context = createTraversalContext(
      new CompoundCycleTracker<FabricValue, JSONSchema | undefined>(),
      options.schemaTracker,
      identity,
      true,
      // Record a value-link dead-end with the caller: a same-space target
      // as a miss (see `onMissedDoc` above for the contract and why it is
      // not the schema tracker), a target in another space as a crossing
      // (`onCrossing`), which this space's per-space watch can never
      // deliver. The recorded selector is the target-rooted shape the
      // read needed, so a miss's arrival re-walk and a crossing's load
      // each deliver the closure this read would have reached.
      onMissedDoc === undefined && onCrossing === undefined
        ? undefined
        : (link, _sourceSpace, source) => {
          const sourceKey = source === undefined
            ? undefined
            : schemaTrackerKey(space, source.id, source.scope, identity);
          const referrerKey = sourceKey === undefined
            ? undefined
            : this.#keyOverrides.get(sourceKey) ?? sourceKey;
          const selector = internPathSelector({
            path: ["value", ...link.path],
            schema: link.schema ?? false,
          });
          if (link.space !== space) {
            onCrossing?.(
              crossingDocKey(link.space, link.id, link.scope),
              selector,
              referrerKey,
            );
            return;
          }
          onMissedDoc?.(
            schemaTrackerKey(space, link.id, link.scope, identity),
            selector,
            referrerKey,
          );
        },
    );
    this.#memo = options.memo ?? createSchemaMemo();
    this.stats = options.stats ?? createGraphQueryWalkStats();
  }

  /**
   * Walks `document` under `selector`, recording every document the schema
   * reaches in the walk's schema tracker, and with each of them — the
   * named document and the documents reached through link crossings alike
   * — the schema document its `cfc` envelope names.
   *
   * The document records under `schemaTrackerKey` over the walk's identity
   * unless the caller passes `docKey`: a caller that named an explicit
   * scope INSTANCE (protocol.md §2's read row — a query root carrying
   * `entityScopeKey`) records under THAT instance's key rather than one
   * resolved from the acting identity.
   */
  visit(
    document: IAttestation,
    selector: SchemaPathSelector,
    docKey?: `${string}/${ScopeKey}/${string}`,
  ): void {
    const effectiveSelector = selector.schema === undefined
      ? { ...selector, schema: false }
      : selector;

    const derivedKey = schemaTrackerKey(
      this.#space,
      document.address.id,
      document.address.scope,
      this.#identity,
    );
    docKey ??= derivedKey;
    if (docKey !== derivedKey) {
      this.#keyOverrides.set(derivedKey, docKey);
    }
    const internedSelector = internPathSelector(effectiveSelector);
    const covered = schemaTrackerCoversSelector(
      this.#context.schemaTracker,
      docKey,
      internedSelector,
    );
    if (covered) {
      this.stats.coveredSelectorSkips++;
    } else {
      this.#context.schemaTracker.add(docKey, internedSelector);
    }

    if (!isObjectNotArray(document.value)) {
      return;
    }

    const tx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(this.#manager),
    );
    if (!covered) {
      const value = (document.value as { value: FabricValue }).value;
      const root: IMemorySpaceValueAttestation = {
        address: { ...document.address, space: this.#space, path: ["value"] },
        value,
      };
      const [nextDoc, nextSelector] = getAtPath(
        tx,
        root,
        effectiveSelector.path.slice(1),
        this.#context,
        effectiveSelector,
      );
      if (
        nextDoc.value !== undefined &&
        nextSelector !== undefined &&
        nextSelector.schema !== false
      ) {
        const traverser = new SchemaObjectTraverser(
          tx,
          nextSelector,
          this.#context,
          undefined,
          this.#memo,
        );
        traverser.traverse(nextDoc);
        this.#addTraverserStats(traverser);
      }
    }

    // The schema document the labels are stated against, loaded even when
    // selector coverage skipped the traversal above: coverage proves reach,
    // and a reader of a labeled document is owed that schema wherever it
    // reached the document from.
    const loaded = {
      address: { ...document.address, space: this.#space },
      value: document.value,
    };
    loadLabelSchemaDoc(tx, loaded, this.#context);
  }

  #addTraverserStats(traverser: SchemaObjectTraverser<FabricValue>): void {
    this.stats.schemaTraversals += traverser.traverseWithSchemaCalls;
    this.stats.pointerTraversals += traverser.traversePointerCalls;
    this.stats.arrayTraversals += traverser.traverseArrayCalls;
    this.stats.objectTraversals += traverser.traverseObjectCalls;
    this.stats.dagTraversals += traverser.traverseDAGCalls;
    this.stats.getDocAtPathCalls += traverser.getDocAtPathCalls;
    this.stats.schemaMemoHits += traverser.schemaMemoHits;
  }
}
