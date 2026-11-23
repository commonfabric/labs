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

import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { internPathSelector } from "@commonfabric/data-model-schema";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  CellScope,
  ScopeKey,
  ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { JSONSchema } from "./builder/types.ts";
import { ownImmutableCells } from "./immutable-cell.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import {
  type AttributionEntry,
  type BaseMemoryAddress,
  CompoundCycleTracker,
  coverageKind,
  coveringSelector,
  createSchemaMemo,
  createTraversalContext,
  getAtPath,
  type IAttestation,
  type IMemorySpaceValueAttestation,
  loadLabelSchemaDoc,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  type MemoizedAttributions,
  type MissingAttribution,
  type ObjectStorageManager,
  type RecordAttribution,
  type SchemaMemo,
  SchemaObjectTraverser,
  type SchemaPathSelector,
  schemaTrackerCoversSelector,
  schemaTrackerKey,
  type TrackedAttribution,
  type TraversalContext,
} from "./traverse.ts";

/**
 * The key of one tracker record: the document `docKey` names, under
 * `selector`. A walk attributes what it reaches to the record whose walk
 * reached it (see `GraphQueryWalkOptions.onTrackedDoc`), and `memory` keys
 * its attribution by the same records.
 */
export const trackedRecordKey = (
  docKey: string,
  selector: SchemaPathSelector,
): string => `${docKey}\0${hashStringOf(internPathSelector(selector))}`;

export type {
  BaseMemoryAddress,
  IAttestation,
  ObjectStorageManager,
  SchemaPathSelector,
};
export {
  coveringSelector,
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

  /** Positions the traversal ran from its own stack rather than on the
   * JavaScript stack, which it does once the data is deep enough
   * (`SchemaObjectTraverser.nativeDepthHandoffs`). */
  nativeDepthHandoffs: number;

  /**
   * Session-scoped links left unfollowed because the walk acts as a
   * principal with no session. A walk that counts none reached nothing that
   * depends on who walked it beyond the scope instances its tracker keys
   * name.
   */
  unresolvedLinkScopes: number;
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
  nativeDepthHandoffs: 0,
  unresolvedLinkScopes: 0,
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
   * — the memory server's query path supplies the one it walks a graph's
   * roots under — never from ambient state (key-vocabulary.md §3).
   */
  identity: ScopeKeyIdentity;

  /**
   * Receives one call per SAME-SPACE document a value-link hop tried to
   * read and found ABSENT: the miss's tracker-style key, the
   * target-rooted selector the read needed, and the REFERRER whose link
   * dead-ended: the record walking the document that holds the link
   * (`trackedRecordKey`), or that document's tracker key where the walk
   * entered no record of it. A value link the walk dead-ends on
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
   * selector the read needed there, and the referrer whose link crossed,
   * named as a miss's referrer is. The walk reads one space, so the target is never
   * loaded here; a client told of the crossing loads it from the target
   * space under that selector. Attributed to the referrer the way a miss
   * is, so a referrer re-walked without the link retires it.
   */
  onCrossing?: (
    crossingKey: string,
    selector: SchemaPathSelector,
    referrerKey: string | undefined,
  ) => void;

  /**
   * Receives one call per selector the walk records in the schema tracker,
   * or finds the tracker already covering (see
   * `TraversalContext.onTrackedDoc`): the tracker key, the selector, the
   * REFERRER whose walk needed it — for a document reached through a link,
   * the record walking the document that holds the link
   * (`trackedRecordKey`), or that document's tracker key where the walk
   * entered no record of it; for a root, the referrer `visit()` was given —
   * and whether the referrer's walk recorded
   * the selector (`walked`) or was skipped because it covers the
   * referrer's own (`covered`). Attributed like a miss, so a referrer
   * re-walked without the link, or a root released, retires what nothing
   * else reaches. A record attributed to its own document is reported as
   * it is; the receiver decides what a self-reference means.
   */
  onTrackedDoc?: (
    key: string,
    selector: SchemaPathSelector,
    referrerKey: string | undefined,
    kind: "walked" | "covered",
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

  readonly #onTrackedDoc: GraphQueryWalkOptions["onTrackedDoc"];

  /**
   * The records this visit has entered, by the tracker key of their
   * document, latest last: the visit's root, and each document a followed
   * link entered, with how many positions were being traversed when it was
   * entered and the innermost of them. A record is walked while that
   * position is still being traversed. One entered outside any position,
   * as the root is and as each document the root's selector path leads
   * through is, is walked while the visit lasts.
   */
  readonly #entered = new Map<
    string,
    {
      record: string;
      docKey: string;
      depth: number;
      position: object | undefined;
    }[]
  >();

  /** The positions being traversed, which the traversal keeps
   * (`RecordWalk.positions`). */
  readonly #positions: object[] = [];

  /** What this visit's positions have attributed, by the referrer they
   * attributed to: in order, as `RecordWalk.positionOf()` lists it, and the
   * attributions made and memoized positions stood for, each once. */
  readonly #attributions = new Map<
    string | undefined,
    {
      made: AttributionEntry[];
      held: Set<AttributionEntry>;

      /** The depth of the positions being traversed when the walk last
       * attributed to the record from outside every position of its
       * document, until a position of the document begins. */
      outside?: number;
    }
  >();

  constructor(options: GraphQueryWalkOptions) {
    this.#manager = options.manager;
    this.#space = options.space;
    this.#identity = options.identity;
    const { space, identity, onMissedDoc, onCrossing, onTrackedDoc } = options;
    this.#onTrackedDoc = onTrackedDoc;
    // A referrer arrives as an address; its attribution key is its tracker
    // key, overridden to the explicit-instance key a root was recorded
    // under (`#keyOverrides`), as a miss's referrer is. A document reports
    // once per link it holds, so its tracker key is kept per document. The
    // override is read on every report: one walk visits every explicit
    // instance of a root in turn, and each visit records its own.
    const sourceKeys = new Map<string, string>();
    const trackerKeyOf = (source: { id: string; scope?: CellScope }) => {
      const cacheKey = `${source.scope ?? ""}\0${source.id}`;
      let sourceKey = sourceKeys.get(cacheKey);
      if (sourceKey === undefined) {
        sourceKey = schemaTrackerKey(space, source.id, source.scope, identity);
        sourceKeys.set(cacheKey, sourceKey);
      }
      return sourceKey;
    };
    const referrerKeyOf = (
      source: { id: string; scope?: CellScope } | undefined,
    ): string | undefined => {
      if (source === undefined) return undefined;
      const sourceKey = trackerKeyOf(source);
      return this.#keyOverrides.get(sourceKey) ?? sourceKey;
    };
    // The entry of the record a source's document is being walked under,
    // if any.
    const walkingOf = (source: { id: string; scope?: CellScope }) => {
      const sourceKey = trackerKeyOf(source);
      return this.#walkingEntryOf(
        this.#keyOverrides.get(sourceKey) ?? sourceKey,
      );
    };
    // What a source reaches is attributed to that record, or to the
    // document where no record of it was entered.
    const referrerOf = (
      source: { id: string; scope?: CellScope } | undefined,
    ): string | undefined =>
      source === undefined
        ? undefined
        : walkingOf(source)?.record ?? referrerKeyOf(source);
    const attributionsTo = (referrer: string | undefined) => {
      let attributions = this.#attributions.get(referrer);
      if (attributions === undefined) {
        attributions = { made: [], held: new Set() };
        this.#attributions.set(referrer, attributions);
      }
      return attributions;
    };
    // Lists what a traversal attributed from `source`, noting one made
    // while the walk had begun no position of the document since entering
    // its record, as resolving a link through to its target does. A record
    // attributed to itself is listed without a source: the walk's report of
    // its own root precedes every position and is not one of them.
    const list = (
      made: RecordAttribution,
      source: { id: string; scope?: CellScope } | undefined,
      referrer: string | undefined,
    ) => {
      const attributions = attributionsTo(referrer);
      attributions.made.push(made);
      const entry = source === undefined ? undefined : walkingOf(source);
      if (entry?.depth === this.#positions.length) {
        attributions.outside = entry.depth;
      }
    };
    // Whether `made` is an attribution to `referrer` this visit has not made
    // yet, which it then holds.
    const attributesAnew = (
      made: RecordAttribution,
      referrer: string | undefined,
    ): boolean => {
      const { held } = attributionsTo(referrer);
      if (held.has(made)) return false;
      held.add(made);
      return true;
    };
    // The attributions `memoized` stands for that `held` does not, with
    // those of the memoized positions it stands for in turn, each once, and
    // the memoized positions read. A memoized position `held` holds already
    // stands; one whose range lies inside the range being read lists nothing
    // that range does not.
    const standsFor = (
      memoized: MemoizedAttributions,
      held: ReadonlySet<AttributionEntry>,
    ) => {
      const attributions = new Set<RecordAttribution>();
      const seen = new Set<MemoizedAttributions>([memoized]);
      const pending = [memoized];
      for (let entry = pending.pop(); entry; entry = pending.pop()) {
        for (let i = entry.start; i < entry.end; i++) {
          const made = entry.made[i];
          if (made.kind !== "memoized") {
            if (!held.has(made)) attributions.add(made);
          } else if (!seen.has(made) && !held.has(made)) {
            seen.add(made);
            const inside = made.made === entry.made &&
              made.start >= entry.start && made.end <= entry.end;
            if (!inside) pending.push(made);
          }
        }
      }
      return { attributions, read: seen };
    };
    // Record a value-link dead-end with the caller: a same-space target as a
    // miss (see `onMissedDoc` above for the contract and why it is not the
    // schema tracker), a target in another space as a crossing
    // (`onCrossing`), which this space's per-space watch can never deliver.
    // The recorded selector is the target-rooted shape the read needed, so a
    // miss's arrival re-walk and a crossing's load each deliver the closure
    // this read would have reached.
    const attributeMissing = (
      made: MissingAttribution,
      referrerKey: string | undefined,
    ): void => {
      if (!attributesAnew(made, referrerKey)) return;
      const { link } = made;
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
    };
    // A record is reported under the key the tracker holds it under, the
    // derived one, so that its attribution names a record that exists; the
    // override reaches the referrer side alone.
    const attributeTracked = (
      made: TrackedAttribution,
      referrer: string | undefined,
    ): void => {
      if (!attributesAnew(made, referrer)) return;
      onTrackedDoc?.(made.key, made.selector, referrer, made.kind);
    };
    const reportTracked = (
      key: string,
      selector: SchemaPathSelector,
      source: { id: string; scope?: CellScope } | undefined,
      kind: "walked" | "covered",
    ): void => {
      const referrer = referrerOf(source);
      const made: TrackedAttribution = { kind, key, selector };
      attributeTracked(made, referrer);
      // A record attributed to itself is listed all the same: a position
      // that stands for it attributes it to another record that replays the
      // position. A walked record other than the one the source is walked
      // under, another document's or another of its own, is the record the
      // walk continues under for as long as the position being traversed
      // now lasts, if it continues into that document. The traversal's own
      // record of an explicit instance's root, under the derived key, is the
      // root's walk, not another.
      const itself = referrer ===
        trackedRecordKey(this.#keyOverrides.get(key) ?? key, selector);
      list(made, itself ? undefined : source, referrer);
      if (kind === "walked" && !itself) this.#enter(key, selector);
    };
    this.#context = createTraversalContext(
      new CompoundCycleTracker<FabricValue, JSONSchema | undefined>({
        numbered: true,
      }),
      options.schemaTracker,
      identity,
      true,
      onMissedDoc === undefined && onCrossing === undefined
        ? undefined
        : (link, sourceSpace, source) => {
          const referrer = referrerOf(source);
          const made: MissingAttribution = {
            kind: "missing",
            link,
            sourceSpace,
          };
          attributeMissing(made, referrer);
          list(made, source, referrer);
        },
      undefined,
      undefined,
      onTrackedDoc === undefined ? undefined : reportTracked,
    );
    if (onTrackedDoc !== undefined) {
      const tracker = options.schemaTracker;
      this.#context.records = {
        positions: this.#positions,
        // A position that begins just after the walk attributed to its
        // record from outside every position of the document is not
        // replayable: a direct traversal of the position can make those
        // attributions inside it, and its range lacks them.
        positionOf: (source) => {
          const entry = walkingOf(source);
          const docKey = entry?.docKey;
          const attributions = attributionsTo(
            entry?.record ?? referrerKeyOf(source),
          );
          const replayable =
            attributions.outside !== this.#positions.length - 1;
          attributions.outside = undefined;
          return {
            made: attributions.made,
            instance: docKey === trackerKeyOf(source) ? undefined : docKey,
            replayable,
          };
        },
        // A record the tracker still holds keeps what its own walk reached,
        // so attributing it again stands for walking it; one it no longer
        // holds took its reach with it, and only a walk restores that. The
        // replay walks into none of the records it attributes, so every
        // attribution goes to the record walking the position. Nothing
        // retires during a visit, so what the record made in this visit
        // stands.
        replay: (memoized, source) => {
          const referrer = referrerOf(source);
          const attributions = attributionsTo(referrer);
          if (
            memoized.made !== attributions.made &&
            !attributions.held.has(memoized)
          ) {
            const { attributions: reached, read } = standsFor(
              memoized,
              attributions.held,
            );
            for (const made of reached) {
              if (
                made.kind !== "missing" &&
                !tracker.hasValue(made.key, made.selector)
              ) {
                return false;
              }
            }
            for (const made of reached) {
              if (made.kind === "missing") {
                attributeMissing(made, referrer);
              } else {
                attributeTracked(made, referrer);
              }
            }
            // Every memoized position read stands now, as it does once a
            // record has made all it stands for.
            for (const position of read) attributions.held.add(position);
          }
          attributions.held.add(memoized);
          attributions.made.push(memoized);
          return true;
        },
      };
    }
    this.#context.onUnresolvedLinkScope = () => {
      this.stats.unresolvedLinkScopes++;
    };
    // The manager serves stored documents and nothing is handed back to be
    // written elsewhere, so an inline array element is walked where it is
    // stored.
    this.#context.inlineArrayItemsInPlace = true;
    this.#memo = options.memo ?? createSchemaMemo();
    this.stats = options.stats ?? createGraphQueryWalkStats();
  }

  /** Notes that the walk entered `docKey`'s record under `selector`, kept
   * under the key a referrer in that document resolves to, which is the
   * explicit instance's when a visit to one is overriding `docKey`. */
  #enter(docKey: string, selector: SchemaPathSelector): void {
    const at = this.#keyOverrides.get(docKey) ?? docKey;
    let entered = this.#entered.get(at);
    if (entered === undefined) {
      entered = [];
      this.#entered.set(at, entered);
    }
    entered.push({
      record: trackedRecordKey(docKey, selector),
      docKey,
      depth: this.#positions.length,
      position: this.#positions.at(-1),
    });
  }

  /** The entry of the record `docKey`'s document is being walked under,
   * if any: the latest it entered whose position is still being traversed.
   * Entries whose position has ended are dropped as it looks. */
  #walkingEntryOf(docKey: string) {
    const entered = this.#entered.get(docKey);
    while (entered !== undefined && entered.length > 0) {
      const latest = entered[entered.length - 1];
      if (
        latest.depth === 0 ||
        this.#positions[latest.depth - 1] === latest.position
      ) {
        return latest;
      }
      entered.pop();
    }
    return undefined;
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
   * `entityScopeKeys`) records under THAT instance's key rather than one
   * resolved from the acting identity.
   *
   * The document's own record attributes to `referrer` through
   * `onTrackedDoc` (a watch's root key, for a walk a watch roots); the
   * records of what its walk reaches attribute to that record, or to the
   * record covering it when the tracker already holds one. Without a
   * referrer the document's record attributes to nothing, as a re-walk of
   * a document already attributed wants.
   *
   * A position the shared memo holds is not traversed again: what it
   * attributed when it was memoized is attributed again to the record
   * walking it now (`RecordWalk.replay()`), so a document visited again is
   * attributed all it reaches.
   */
  visit(
    document: IAttestation,
    selector: SchemaPathSelector,
    docKey?: `${string}/${ScopeKey}/${string}`,
    referrer?: string,
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
    // The override stands for the instance this visit walks, and only
    // while it does: a later visit's walk reaching this document reaches the
    // session's own instance of it.
    this.#keyOverrides.clear();
    if (docKey !== derivedKey) this.#keyOverrides.set(derivedKey, docKey);
    const internedSelector = internPathSelector(effectiveSelector);
    const covering = coveringSelector(
      this.#context.schemaTracker,
      docKey,
      internedSelector,
    );
    const covered = covering !== undefined;
    if (covered) {
      this.stats.coveredSelectorSkips++;
      this.#onTrackedDoc?.(
        docKey,
        covering,
        referrer,
        coverageKind(covering, internedSelector),
      );
    } else {
      this.#context.schemaTracker.add(docKey, internedSelector);
      this.#onTrackedDoc?.(docKey, internedSelector, referrer, "walked");
    }
    // A covered root is walked under the record covering it, which is the
    // record its walk keeps.
    this.#entered.clear();
    this.#attributions.clear();
    this.#enter(docKey, covering ?? internedSelector);
    this.#context.trackedReferrer = {
      id: document.address.id,
      scope: document.address.scope,
    };

    if (!isObjectNotArray(document.value)) {
      return;
    }

    const tx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(this.#manager),
      {},
      ownImmutableCells(this.#memo),
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
    this.stats.nativeDepthHandoffs += traverser.nativeDepthHandoffs;
  }
}
