import type { FabricValue, JSONSchema } from "@commonfabric/api";
import { getLogger } from "@commonfabric/utils/logger";
import { StagedMap } from "@commonfabric/utils/staged-map";
import {
  internPathSelector,
  internSchemaAsTaggedHashString,
  REJECTING_SELECTOR,
} from "@commonfabric/data-model-schema";
import {
  verifySchemaDocument,
  walkSchemaDocumentClosure,
} from "@commonfabric/data-model-schema/schema-closure";
import {
  classifySchemaMeta,
  collectExternalSchemaRefHashes,
  schemaMetaRefHashes,
} from "@commonfabric/data-model-schema/schema-refs";
import {
  createGraphQueryWalkStats,
  createSchemaMemo,
  GraphQueryWalk,
  type GraphQueryWalkStats,
  type IAttestation,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  type SchemaMemo,
  type SchemaPathSelector,
  schemaTrackerCoversSelector,
  schemaTrackerKey,
} from "@commonfabric/runner/graph-query";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  lookupSchemaDocument,
  registerSchemaDocument,
} from "../../runner/src/schema-registry.ts";
import type { MemorySpace, MIME, URI } from "../interface.ts";
import { mapLinkSchemas } from "./schema-table-links.ts";
import {
  canResolveScopeKey,
  type CellScope,
  type CommitClass,
  type EntitySnapshot,
  getServerExecutionConfig,
  type GraphQuery,
  type GraphQueryRoot,
  isScopeKey,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
  toDocumentSelector,
} from "../v2.ts";
import * as Engine from "./engine.ts";

const DEFAULT_SCOPE: CellScope = "space";

/**
 * Query/watch doc keys are per scope INSTANCE (scopes.md §7 M2, stage E):
 * the middle segment is the shared scope_key vocabulary, resolved against
 * the querying session's identity — the same identity the manager resolves
 * scoped reads with, so a key names exactly the instance the tracked read
 * saw. Per tracked-graph state the identity is fixed, so this re-keying
 * partitions state exactly as the scope-NAME form did (key-vocabulary.md
 * §2).
 */
export type QueryDocKey = `${string}/${ScopeKey}/${string}`;

export type TrackedGraphState = {
  branch: string;
  tracker: MapSetStringToPathSelectors;

  /** Value-link dead-ends the query's walks read as ABSENT (see
   * GraphQueryWalkOptions.onMissedDoc): keyed like the tracker, never
   * delivered — a miss keeps the graph reactive to the document's later
   * creation (the wake pass and the dirty refresh consult it) without
   * putting an absence marker on the wire. */
  missed: MapSetStringToPathSelectors;

  /** missKey → the REFERRER keys whose links dead-ended on it. A miss
   * lives while any referrer attributes it: a referrer that is
   * re-walked clears its attributions first, so a link edited away
   * retires the miss instead of leaving a stale wake (an
   * attribution-less miss — defensive, no known producer — retires
   * only on its own arrival). */
  missedBy: Map<string, Set<string>>;

  /** referrerKey → the miss keys it attributed (the reverse index the
   * re-walk clears by). */
  missesOf: Map<string, Set<string>>;

  /** The documents this graph delivered, at the version delivered. A
   * document joins only after the assembly delivering it verified its
   * whole schema-document closure, which is what lets a later assembly
   * stop at a schema document held here without reading it (see
   * `assembleSchemaDocClosures`). */
  entities: Map<QueryDocKey, EntitySnapshot>;

  memo: SchemaMemo;
  manager: EngineObjectManager;

  /** Per-version scans of this state's delivered documents for embedded
   * schema refs (`docKey -> { seq, refs }`), so only changed versions are
   * scanned. One entry per delivered version, the schema documents the
   * closure itself delivered included; reused by document key and sequence;
   * every scope, since the state is one identity's; the state's lifetime.
   * The engine-wide cache of space-scoped scans only seeds it. A `cid:`
   * document whose entry names its own hash, at the version `entities`
   * holds, is a schema document this state established, closure and all
   * (see `assembleSchemaDocClosures`). */
  schemaRefs: SchemaRefScans;
};

/** See TrackedGraphState.schemaRefs. */
export type SchemaRefScans = Map<
  QueryDocKey,
  { seq: number; refs: ReadonlySet<string> }
>;

/**
 * The costliest single root of one query evaluation.
 *
 * A query's roots are the union of every watch's roots on a branch, so a
 * slow `watch.add` reports its duration against a watch COUNT and says
 * nothing about which declaration spent it. This names the root that did.
 *
 * It names the root that PAID, which is not always the root to blame.
 * Roots share coverage within an evaluation: the first to reach a document
 * is charged for it, and a later root that would have reached the same
 * document is skipped instead. So where several roots declare overlapping
 * closures, the whole cost lands on whichever ran first, and bounding that
 * one root moves the charge to the next rather than removing it. Read a
 * large `slowestRoot` as "the cost is reachable from here", and confirm a
 * suspected cause by checking that narrowing it lowers the request's own
 * elapsed time — not merely that it lowers this root's.
 */
export type SlowestQueryRoot = {
  id: string;
  scope: CellScope;

  /** The explicit scope INSTANCE the root named, on the lease-holder reads
   * that may name one. Roots alike in every other field but this one are
   * different reads of different instances, so without it the record
   * cannot say which instance cost the time. */
  entityScopeKey?: ScopeKey;

  /** The selector's path, slash-joined; empty for a whole-document root. */
  path: string;

  /** The selector schema's interned tagged hash, absent when the root
   * declares none. The hash rather than the schema itself: a board root's
   * schema runs to kilobytes, and the hash is how the registry names it. */
  schema?: string;

  elapsedMs: number;

  /** Engine documents read while visiting this root. */
  reads: number;

  /** The walk this root ran, as counters: how many documents it crossed
   * (`dagTraversals`), what kind of structure it crossed them through, and
   * how much the schema memo saved. `elapsedMs` says a root was expensive;
   * this says what it did to get that way — a wide root crossing thousands
   * of documents and one deep root re-walking a schema are the same
   * duration and different bugs. */
  walk: GraphQueryWalkStats;
};

/** One root's share of the walk counters its evaluation accumulated. */
const walkStatsDelta = (
  after: GraphQueryWalkStats,
  before: GraphQueryWalkStats,
): GraphQueryWalkStats => ({
  coveredSelectorSkips: after.coveredSelectorSkips -
    before.coveredSelectorSkips,
  schemaTraversals: after.schemaTraversals - before.schemaTraversals,
  pointerTraversals: after.pointerTraversals - before.pointerTraversals,
  arrayTraversals: after.arrayTraversals - before.arrayTraversals,
  objectTraversals: after.objectTraversals - before.objectTraversals,
  dagTraversals: after.dagTraversals - before.dagTraversals,
  getDocAtPathCalls: after.getDocAtPathCalls - before.getDocAtPathCalls,
  schemaMemoHits: after.schemaMemoHits - before.schemaMemoHits,
});

/**
 * What one query cost: the walk's own counters, plus how many documents the
 * query read out of the engine, plus which of its roots was the expensive
 * one.
 */
export type QueryTraversalStats = GraphQueryWalkStats & {
  managerReads: number;

  /** Documents whose value this evaluation scanned for embedded schema
   * refs while assembling the delivered set's schema-document closure. A
   * version scanned before — by this state, or by any session that
   * delivered the same space-scoped version — costs no scan, so on a
   * refresh this counts the documents that actually changed. */
  schemaRefScans: number;

  /** Roots this evaluation visited. A cache hit visits none. */
  rootsVisited: number;

  /** Summed elapsed time of those visits. Roots are visited in sequence,
   * so this is directly comparable with the caller's own elapsed
   * measurement, and what it leaves over is everything outside the root
   * loop — entity assembly and schema-closure staging. Read the two
   * together: they say whether a slow evaluation was slow at a root at
   * all. */
  rootsElapsedMs: number;

  /** The costliest one, absent when no root was visited. */
  slowestRoot?: SlowestQueryRoot;
};

const createQueryTraversalStats = (): QueryTraversalStats => ({
  managerReads: 0,
  schemaRefScans: 0,
  rootsVisited: 0,
  rootsElapsedMs: 0,
  ...createGraphQueryWalkStats(),
});

/**
 * Run one root's evaluation, charging what it cost to `stats` and keeping
 * the costliest root seen so far.
 *
 * Two clock reads and one counter read per root, paid unconditionally,
 * because which evaluation turns out to be the slow one is not knowable
 * before it runs. The overhead is bounded by the same factor that makes a
 * query large: a root cheap enough for two `performance.now()` calls to
 * register against it did no document reads.
 */
const chargeRootVisit = (
  root: GraphQueryRoot,
  manager: EngineObjectManager,
  stats: QueryTraversalStats,
  visit: () => void,
): void => {
  const startedAt = performance.now();
  const readsBefore = manager.readCount;
  const walkBefore = { ...stats };
  try {
    visit();
  } finally {
    // Charged from `finally`, so a root that throws is attributed too: a
    // slow failing root is at least as interesting as a slow passing one.
    const elapsedMs = performance.now() - startedAt;
    stats.rootsVisited++;
    stats.rootsElapsedMs += elapsedMs;
    if (
      stats.slowestRoot === undefined ||
      elapsedMs > stats.slowestRoot.elapsedMs
    ) {
      stats.slowestRoot = {
        id: root.id,
        scope: root.scope ?? DEFAULT_SCOPE,
        ...(root.entityScopeKey === undefined
          ? {}
          : { entityScopeKey: root.entityScopeKey }),
        path: root.selector.path.join("/"),
        ...(root.selector.schema === undefined ? {} : {
          schema: internSchemaAsTaggedHashString(root.selector.schema),
        }),
        elapsedMs,
        reads: manager.readCount - readsBefore,
        walk: walkStatsDelta(stats, walkBefore),
      };
    }
  }
};

/**
 * The identity a manager's tracked-graph keys resolve against: the
 * querying session's own (the same identity the manager threads into every
 * scoped engine read).
 */
const identityOf = (manager: EngineObjectManager): ScopeKeyIdentity => ({
  principal: manager.principal,
  sessionId: manager.sessionId,
});

export class EngineObjectManager implements ObjectStorageManager {
  #attestations = new Map<string, IAttestation>();
  #details = new Map<string, {
    seq: number;
    document: NonNullable<Engine.EntityState["document"]>;
  }>();
  #missing = new Map<string, true>();
  #readCount = 0;
  #onLoad?: (
    address: ReturnType<EngineObjectManager["loadedAddresses"]>[number],
  ) => void;

  readonly #engine: Engine.Engine;
  readonly #branch: string;
  readonly #readSeq?: number;

  constructor(
    engine: Engine.Engine,
    branch: string,
    readonly principal?: string,
    readonly sessionId?: string,
    readSeq?: number,
  ) {
    this.#engine = engine;
    this.#branch = branch;
    this.#readSeq = readSeq;
  }

  /** The scope INSTANCE an address resolves to for this manager: the
   * explicit key where the caller named one (protocol.md §2's read row),
   * else the manager's own bound identity. Cache keys use it, so an
   * explicit foreign instance never collides with the manager's own
   * (partition-equal to the scope-name form at cardinality 1 —
   * key-vocabulary.md §2). */
  #scopeKeyFor(scope: CellScope, explicit?: ScopeKey): ScopeKey {
    return explicit ??
      resolveScopeKey(scope, {
        principal: this.principal,
        sessionId: this.sessionId,
      });
  }

  readState(
    id: string,
    scope: CellScope = DEFAULT_SCOPE,
    scopeKey?: ScopeKey,
  ): Engine.EntityState | null {
    return Engine.readState(this.#engine, {
      id,
      scope,
      ...(scopeKey === undefined ? {} : { scopeKey }),
      principal: this.principal,
      sessionId: this.sessionId,
      branch: this.#branch,
      ...(this.#readSeq === undefined ? {} : { seq: this.#readSeq }),
    });
  }

  /** The class of the commit at `seq` (the covering commit of a snapshot
   * whose seq that is — one seq names exactly one commit), or undefined
   * for seq 0 / an unknown seq. Memoized per engine; see
   * {@link Engine.commitClassOfSeq}. */
  coverClassOf(seq: number): CommitClass | undefined {
    return Engine.commitClassOfSeq(this.#engine, seq);
  }

  load(
    address: {
      id: string;
      type?: string;
      scope?: CellScope;
      scopeKey?: ScopeKey;
    },
  ): IAttestation | null {
    const type = address.type ?? "application/json";
    const scope = address.scope ?? DEFAULT_SCOPE;
    const scopeKey = this.#scopeKeyFor(scope, address.scopeKey);
    const key = `${scopeKey}/${address.id}/${type}`;
    if (this.#attestations.has(key)) {
      return this.#attestations.get(key)!;
    }
    if (this.#missing.has(key)) {
      return null;
    }
    if (type !== "application/json") {
      this.#missing.set(key, true);
      return null;
    }

    const state = this.readState(address.id, scope, scopeKey);
    this.#readCount++;
    if (state === null || state.document === null) {
      this.#missing.set(key, true);
      return null;
    }

    const attestation: IAttestation = {
      address: {
        id: address.id as URI,
        scope,
        type: type as MIME,
        path: [],
      },
      value: state.document,
    };
    this.#attestations.set(key, attestation);
    this.#details.set(key, {
      seq: state.seq,
      document: state.document,
    });
    this.#onLoad?.({ id: address.id, type, scope, scopeKey });
    return attestation;
  }

  detail(
    address: {
      id: string;
      type?: string;
      scope?: CellScope;
      scopeKey?: ScopeKey;
    },
  ) {
    const scope = address.scope ?? DEFAULT_SCOPE;
    return this.#details.get(
      `${this.#scopeKeyFor(scope, address.scopeKey)}/${address.id}/${
        address.type ?? "application/json"
      }`,
    );
  }

  get readCount(): number {
    return this.#readCount;
  }

  loadedAddresses(): Array<
    { id: string; type: string; scope: CellScope; scopeKey: ScopeKey }
  > {
    // The cache key is `scopeKey/id/type`, and only the scopeKey prefix
    // is delimiter-safe (canonical scope keys percent-encode `/`; ids
    // and MIME types carry raw slashes routinely). Take id and type from
    // the attestation's own address and parse ONLY the prefix — a
    // key.split("/") here corrupted slash-bearing ids, so extension
    // bookkeeping missed the actual tracked document.
    return [...this.#attestations.entries()].map(([key, attestation]) => {
      const separator = key.indexOf("/");
      const scopeKey = key.slice(0, separator) as ScopeKey;
      return {
        id: attestation.address.id,
        type: attestation.address.type ?? "application/json",
        scope: attestation.address.scope ?? scopeOfScopeKey(scopeKey),
        scopeKey,
      };
    });
  }

  invalidateIds(ids: Iterable<string>, scope: CellScope = DEFAULT_SCOPE): void {
    // Own-instance invalidation: the manager caches under its own bound
    // identity's keys (plus explicitly named instances, which dirty
    // marking addresses by exact key through the same construction).
    const scopeKey = this.#scopeKeyFor(scope);
    for (const id of ids) {
      const key = `${scopeKey}/${id}/application/json`;
      this.#attestations.delete(key);
      this.#details.delete(key);
      this.#missing.delete(key);
    }
  }

  mergeFrom(other: EngineObjectManager): void {
    for (const key of other.#missing.keys()) {
      this.#attestations.delete(key);
      this.#details.delete(key);
      this.#missing.set(key, true);
    }
    for (const [key, value] of other.#attestations) {
      this.#attestations.set(key, value);
      const detail = other.#details.get(key);
      if (detail !== undefined) {
        this.#details.set(key, detail);
      }
      this.#missing.delete(key);
    }
  }

  /** Captures newly loaded addresses during synchronous `evaluate`. */
  captureLoads(
    evaluate: () => void,
  ): ReturnType<EngineObjectManager["loadedAddresses"]> {
    const addresses: ReturnType<EngineObjectManager["loadedAddresses"]> = [];
    const previous = this.#onLoad;
    this.#onLoad = (address) => {
      addresses.push(address);
      previous?.(address);
    };
    try {
      evaluate();
      return addresses;
    } finally {
      this.#onLoad = previous;
    }
  }

  /** Stages cache changes under exclusive access; discard the stage on failure. */
  stage(engine: Engine.Engine): {
    value: EngineObjectManager;
    commit: () => void;
  } {
    const value = new EngineObjectManager(
      engine,
      this.#branch,
      this.principal,
      this.sessionId,
      this.#readSeq,
    );
    const attestations = new StagedMap(this.#attestations);
    const details = new StagedMap(this.#details);
    const missing = new StagedMap(this.#missing);
    value.#attestations = attestations;
    value.#details = details;
    value.#missing = missing;
    return {
      value,
      commit: () => {
        attestations.commit();
        details.commit();
        missing.commit();
      },
    };
  }
}

export type QueryGraphReuseContext = {
  managers?: Map<string, EngineObjectManager>;
};

/** Source of fresh ids for {@link canonicalSelectorId}. */
let nextCanonicalSelectorId = 0;

/** Ids already issued, keyed by canonical (interned) selector instance. */
const canonicalSelectorIds = new WeakMap<SchemaPathSelector, number>();

/**
 * Returns the canonical selector identity for evaluation-cache keys.
 * Interning gives structurally equal selectors one canonical instance
 * (`internPathSelector`), so reference identity is structural equality and
 * the id is exact. Canonical instances are weakly held, so an id can lapse
 * with its selector and a re-interned equal reappears under a fresh id —
 * that costs a cache miss, never a wrong hit.
 */
const canonicalSelectorId = (selector: SchemaPathSelector): number => {
  const interned = internPathSelector(selector);
  let id = canonicalSelectorIds.get(interned);
  if (id === undefined) {
    id = nextCanonicalSelectorId++;
    canonicalSelectorIds.set(interned, id);
  }
  return id;
};

const evaluationQueryKey = (query: GraphQuery): string =>
  JSON.stringify([
    query.branch ?? "",
    query.roots
      .map((root) => [
        root.id,
        root.scope ?? DEFAULT_SCOPE,
        root.entityScopeKey ?? "",
        canonicalSelectorId(toDocumentSelector(root.selector)),
      ])
      .map((parts) => JSON.stringify(parts))
      .toSorted(),
  ]);

const evaluationIdentityKey = (options: TrackGraphOptions): string =>
  JSON.stringify([options.principal ?? null, options.sessionId ?? null]);

/**
 * Bounds an evaluation cache's entry COUNT — the cardinality backstop for
 * adversarial query-shape churn, not the memory bound. Memory is bounded
 * by the server's cross-space retained-entity budget, which evicts by
 * weight (see Server's evaluation-cache budget).
 */
const EVALUATION_CACHE_MAX_ENTRIES = 16;

export type QueryEvaluationCacheDiagnostics = {
  seq: number;
  entries: number;
  weight: number;

  /** Total serves: the sum of the three per-class hit counters. */
  hits: number;

  misses: number;
  rotations: number;

  /** Serves of a scope-pure entry (identical for every identity). */
  hitsPure: number;

  /** Serves of an absent-residue entry — the recording identity's own
   * re-ask included (its keys need no rewrite, but the entry is the
   * same class). */
  hitsAbsentResidue: number;

  /** Serves of a tainted entry to the identity it is keyed to. */
  hitsIdentity: number;

  /** Absent-residue shares refused because a residue doc is PRESENT
   * for the requester. A refusal is not a miss by itself: the call
   * then serves from the identity entry (an identity hit) or
   * evaluates in full (a miss). */
  residueRefusals: number;

  /** Live scope-pure entries. This count and the two below it are the live
   * entries by share class; together with the hit split they are the
   * production measure of how often scoped reach actually forecloses
   * cross-identity sharing. */
  entriesPure: number;

  /** Live absent-residue entries. */
  entriesAbsentResidue: number;

  /** Live tainted entries, each keyed to one identity. */
  entriesTainted: number;
};

/**
 * Caches whole tracked-graph evaluations per (query shape, engine seq).
 *
 * The WHOLE evaluation is the smallest soundly shareable unit: within one
 * walk, an already-covered (doc, selector) skips its subtree — including
 * the tracker registrations that subtree would record — so any per-document
 * slice of a walk's effects depends on what its siblings covered first, and
 * replaying one standalone under-registers coverage. A complete evaluation
 * carries no such context.
 *
 * Entries are valid only at the engine seq they were evaluated at; a seq
 * advance rotates the whole cache. Staleness is therefore structural — no
 * write hooks, no dependency tracking — and the sharing this buys is
 * exactly where the cost multiplies: many sessions establishing the same
 * watch corpus between two commits (a reconnect stampede after a process
 * death is this, at its worst).
 *
 * Only whole, current-state evaluations consult the cache: an eligible
 * `graph.query` (without `atSeq` or keyed snapshots), a whole watch-set
 * establishment, and `session.watch.add` when the session has no tracked graph
 * for that branch. A subsequent `session.watch.add` for an already tracked
 * branch extends the session's graph through `extendTrackedGraph()`. An
 * extension depends on the graph's existing coverage, so it neither serves nor
 * records a cache entry.
 *
 * Scope purity decides who may share an entry. An evaluation whose whole
 * reach — tracked, missed, and loaded — resolved under the `space` scope is
 * identical for every identity and is shared across them; one that touched
 * a session- or user-scoped instance is keyed to the evaluating identity
 * (key-vocabulary.md §5's identity-bound invariant — the same value-bleed
 * rule `assertSchemaMemoIdentity` enforces for the inner schema memos).
 * ACL changes are themselves commits, so a grant or revocation rotates the
 * cache before any post-change evaluation could be served from it.
 *
 * Cross-identity sharing rests on evaluation being recipient-blind: the
 * walk consults the requesting identity only to resolve scope instances,
 * never to shape what a document contributes, so scope classification
 * alone decides who an entry may serve. CFC enforcement lives outside
 * this path (the runtime's flow-label and sink-ceiling dials; the
 * server's sqlite read labeling annotates results rather than filtering
 * them). A per-recipient filter inside evaluation would invalidate
 * shared entries invisibly — clearance differs between identities at
 * one seq, so rotation cannot fence it and scope keys cannot classify
 * it — and must therefore key this cache by its filtering context or
 * bypass it (key-vocabulary.md §5, the identity-bound inventory).
 */
export type QueryEvaluationCache = {
  /** The engine the entries were evaluated against. A sequence number
   * identifies state only within its engine, so a different engine object
   * for the same space rotates the cache exactly as a seq advance does —
   * both entry points accept a caller-supplied engine. */
  engine: Engine.Engine | null;

  seq: number;
  entries: Map<
    string,
    { state: TrackedGraphState; share: StateScopeClass; weight: number }
  >;

  /** Sum of entry weights (retained entity count — the proxy for the
   * parsed documents an entry keeps alive). The server enforces its
   * cross-space budget against this. */
  weight: number;

  /** Serves of a scope-pure entry. This counter and the two below it are the
   * per-class serve counters, which diagnostics report summed as `hits`;
   * {@link QueryEvaluationCacheDiagnostics} defines each class. */
  hitsPure: number;

  /** Serves of an absent-residue entry. */
  hitsAbsentResidue: number;

  /** Serves of a tainted entry to the identity it is keyed to. */
  hitsIdentity: number;

  /** Absent-residue shares refused because a residue doc is present. */
  residueRefusals: number;

  /** Evaluations that found no usable entry. */
  misses: number;

  /** Times the cache was rotated out — a newer engine seq, or a different
   * engine object for the same space. */
  rotations: number;
};

export const createQueryEvaluationCache = (): QueryEvaluationCache => ({
  engine: null,
  seq: -1,
  entries: new Map(),
  weight: 0,
  hitsPure: 0,
  hitsAbsentResidue: 0,
  hitsIdentity: 0,
  residueRefusals: 0,
  misses: 0,
  rotations: 0,
});

export const queryEvaluationCacheDiagnostics = (
  cache: QueryEvaluationCache,
): QueryEvaluationCacheDiagnostics => {
  const entriesByClass = { "pure": 0, "absent-residue": 0, "tainted": 0 };
  for (const { share } of cache.entries.values()) {
    entriesByClass[share.kind]++;
  }
  return {
    seq: cache.seq,
    entries: cache.entries.size,
    weight: cache.weight,
    hits: cache.hitsPure + cache.hitsAbsentResidue + cache.hitsIdentity,
    misses: cache.misses,
    rotations: cache.rotations,
    hitsPure: cache.hitsPure,
    hitsAbsentResidue: cache.hitsAbsentResidue,
    hitsIdentity: cache.hitsIdentity,
    residueRefusals: cache.residueRefusals,
    entriesPure: entriesByClass["pure"],
    entriesAbsentResidue: entriesByClass["absent-residue"],
    entriesTainted: entriesByClass["tainted"],
  };
};

/**
 * How an evaluation's reach constrains who may share its cache entry.
 *
 * `pure`: every key resolved under the space scope — the result is
 * identical for every identity. `absent-residue`: identity-dependent ONLY
 * through scoped value-link dead-ends (`missed` keys — docs that were
 * ABSENT), which is the shape a live corpus actually produces: per-session
 * draft cells linked from shared documents that no fresh session has ever
 * written. Such an entry serves another identity by REWRITING those keys
 * to the requester's own instances — sound because the keys are the only
 * identity-dependent part of the state (nothing was delivered from them,
 * nothing was traversed under them) — after verifying each is absent for
 * the requester too. `tainted`: scoped PRESENT data reached the tracker,
 * or a key did not classify; the entry stays keyed to its identity.
 */
type StateScopeClass =
  | { kind: "pure" }
  | {
    kind: "absent-residue";
    residue: { key: QueryDocKey; id: string; scope: CellScope }[];
  }
  | { kind: "tainted" };

/** Exported for testing (the malformed-key guard is unreachable through
 * a real walk while the scope-key vocabulary holds). */
export const classifyStateScope = (
  state: TrackedGraphState,
): StateScopeClass => {
  for (const [key] of state.tracker) {
    if (fromDocKey(key as QueryDocKey).scopeKey !== "space") {
      return { kind: "tainted" };
    }
  }
  for (const address of state.manager.loadedAddresses()) {
    // Both halves checked deliberately: an explicit entity_scope_key can
    // pair a non-space scope NAME with an aliased key, and such a load
    // must never classify as shared. (Explicit foreign keys are
    // lease-holder-only, and that whole session class bypasses the cache
    // — this guards the invariant locally as well.)
    if (address.scopeKey !== "space" || address.scope !== "space") {
      return { kind: "tainted" };
    }
  }
  const residue: { key: QueryDocKey; id: string; scope: CellScope }[] = [];
  for (const [key] of state.missed) {
    // The scope-key vocabulary is closed (isScopeKey), so a key that is
    // not the space instance necessarily recovers a session or user
    // scope; fromDocKey throws on anything outside the vocabulary.
    const { id, scope, scopeKey } = fromDocKey(key as QueryDocKey);
    if (scopeKey === "space") continue;
    residue.push({ key: key as QueryDocKey, id, scope });
  }
  return residue.length === 0
    ? { kind: "pure" }
    : { kind: "absent-residue", residue };
};

/**
 * Serve an `absent-residue` entry to `options`' identity: verify each
 * residue doc is ABSENT for the requester too, then clone with the
 * residue's miss keys rewritten to the requester's instances — so the
 * clone's wake and dirty-refresh reactivity points at the docs the OWNING
 * session would create, not the recording session's.
 *
 * The absence probes are load-bearing and cannot be skipped for a
 * different identity: the requester's instance may have existed since
 * before the entry was recorded (the recording walk never looked at it).
 * They are also sufficient — entries live only within one engine seq, and
 * absence cannot change without a commit. A present instance returns
 * null: the caller evaluates normally, and that evaluation's tracker then
 * carries the scoped doc, keying its own entry to the identity.
 */
const cloneWithRewrittenResidue = (
  engine: Engine.Engine,
  space: string,
  state: TrackedGraphState,
  residue: { key: QueryDocKey; id: string; scope: CellScope }[],
  options: TrackGraphOptions,
): { state: TrackedGraphState | null; probeReads: number } => {
  const identity: ScopeKeyIdentity = {
    principal: options.principal,
    sessionId: options.sessionId,
  };
  const mapping = new Map<string, string>();
  let probeReads = 0;
  for (const { key, id, scope } of residue) {
    const requesterScopeKey = resolveScopeKey(scope, identity);
    const requesterKey = `${space}/${requesterScopeKey}/${id}`;
    if (requesterKey !== key) {
      probeReads++;
      const probe = Engine.readState(engine, {
        id,
        scope,
        scopeKey: requesterScopeKey,
        principal: options.principal,
        sessionId: options.sessionId,
        branch: state.branch,
      });
      if (probe !== null && probe.document !== null) {
        // Refused — but the probes already performed are reads this call
        // made, and the caller's statistics must carry them.
        return { state: null, probeReads };
      }
      mapping.set(key, requesterKey);
    }
  }
  const clone = cloneTrackedGraphStateForIdentity(engine, state, options);
  if (mapping.size === 0) {
    return { state: clone, probeReads };
  }
  const missed = new MapSetStringToPathSelectors(true);
  for (const [key, selectors] of clone.missed) {
    const mapped = mapping.get(key) ?? key;
    for (const selector of selectors) {
      missed.add(mapped, selector);
    }
  }
  const missedBy = new Map<string, Set<string>>();
  for (const [key, referrers] of clone.missedBy) {
    missedBy.set(mapping.get(key) ?? key, referrers);
  }
  const missesOf = new Map<string, Set<string>>();
  for (const [referrer, misses] of clone.missesOf) {
    missesOf.set(
      referrer,
      new Set([...misses].map((miss) => mapping.get(miss) ?? miss)),
    );
  }
  return { state: { ...clone, missed, missedBy, missesOf }, probeReads };
};

/**
 * Clone for a cache hit: `cloneTrackedGraphState` rebound to the
 * requesting identity. Only scope-pure entries are ever cloned across
 * identities, so every key, entity, memo entry, and manager cache line in
 * the source resolved identically to what this identity's own evaluation
 * would have produced; the rebind exists so the clone's LATER operations —
 * refreshes, extensions — resolve scoped reach against the session that
 * owns it. The cloned memo is a fresh Map, so the identity binding the
 * schema-memo tripwire tracks starts unbound and binds to the new owner.
 */
const cloneTrackedGraphStateForIdentity = (
  engine: Engine.Engine,
  state: TrackedGraphState,
  options: TrackGraphOptions,
): TrackedGraphState => {
  const clone = cloneTrackedGraphState(engine, state);
  if (
    clone.manager.principal === options.principal &&
    clone.manager.sessionId === options.sessionId
  ) {
    return clone;
  }
  const manager = new EngineObjectManager(
    engine,
    state.branch,
    options.principal,
    options.sessionId,
  );
  manager.mergeFrom(state.manager);
  return { ...clone, manager };
};

export type TrackGraphOptions = {
  readSeq?: number;
  principal?: string;
  sessionId?: string;

  /** Serve/record whole evaluations through this cache (current-seq reads
   * only; a `readSeq` read bypasses it). See {@link QueryEvaluationCache}
   * for the sharing and rotation rules. */
  evaluationCache?: QueryEvaluationCache;

  /**
   * `queryGraph` only (server-execution v2 stage A, OW17's wire leg):
   * annotate every returned snapshot with its scope INSTANCE
   * (`EntitySnapshot.scopeKey`). Set for a session whose lease-holder
   * read exemption is live — the one session class whose result may
   * legitimately hold two instances of one (branch, id, scope) — and
   * never otherwise, so the OFF-arm result shape is unchanged.
   */
  keyedSnapshots?: boolean;
};

export const cloneTrackedGraphState = (
  engine: Engine.Engine,
  state: TrackedGraphState,
): TrackedGraphState => {
  const tracker = state.tracker.clone();
  const missed = state.missed.clone();
  const missedBy = new Map(
    [...state.missedBy].map(([key, refs]) => [key, new Set(refs)] as const),
  );
  const missesOf = new Map(
    [...state.missesOf].map(([key, misses]) => [key, new Set(misses)] as const),
  );

  const manager = new EngineObjectManager(
    engine,
    state.branch,
    state.manager.principal,
    state.manager.sessionId,
  );
  manager.mergeFrom(state.manager);

  return {
    branch: state.branch,
    tracker,
    missed,
    missedBy,
    missesOf,
    entities: new Map(state.entities),
    memo: new Map(state.memo),
    manager,
    schemaRefs: new Map(state.schemaRefs),
  };
};

/**
 * Stages one graph's mutations without copying untouched entries. The caller
 * holds exclusive synchronous access through evaluation and publication, then
 * discards the stage. Shared evaluation-cache entries use independent clones.
 */
export const stageTrackedGraphState = (
  engine: Engine.Engine,
  state: TrackedGraphState,
): {
  value: TrackedGraphState;
  commit: () => void;
  changedMisses: () => Iterable<string>;
} => {
  const tracker = state.tracker.stage();
  const missed = state.missed.stage();
  const missedBy = new StagedMap(state.missedBy, (values) => new Set(values));
  const missesOf = new StagedMap(state.missesOf, (values) => new Set(values));
  const entities = new StagedMap(state.entities);
  const memo = new StagedMap(state.memo);
  const manager = state.manager.stage(engine);
  const schemaRefs = new StagedMap(state.schemaRefs);
  return {
    value: {
      branch: state.branch,
      tracker: tracker.value,
      missed: missed.value,
      missedBy,
      missesOf,
      entities,
      memo,
      manager: manager.value,
      schemaRefs,
    },
    commit: () => {
      tracker.commit();
      missed.commit();
      missedBy.commit();
      missesOf.commit();
      entities.commit();
      memo.commit();
      manager.commit();
      schemaRefs.commit();
    },
    changedMisses: missed.changedKeys,
  };
};

const snapshotForDocKey = (
  space: string,
  manager: EngineObjectManager,
  branch: string,
  key: QueryDocKey,
): EntitySnapshot | null => {
  if (!key.startsWith(`${space}/`)) {
    return null;
  }
  const { id, scope, scopeKey } = fromDocKey(key);
  const type = "application/json";
  const detail = manager.detail({ id, type, scope, scopeKey });
  const state = detail === undefined
    ? manager.readState(id, scope, scopeKey)
    : null;
  const seq = detail?.seq ?? state?.seq ?? 0;
  // The covering commit's class (speculation.md §4's arrival-witness
  // predicate, RULED 2026-08-22), ON arm only: the OFF-arm snapshot —
  // and therefore every OFF-arm frame — stays byte-identical.
  const coverClass = getServerExecutionConfig()
    ? manager.coverClassOf(seq)
    : undefined;
  return {
    branch,
    id,
    ...(scope !== DEFAULT_SCOPE ? { scope } : {}),
    seq,
    document: detail?.document === undefined
      ? state?.document === null || state?.document === undefined
        ? null
        : state.document
      : detail.document,
    ...(coverClass === undefined ? {} : { coverClass }),
  } satisfies EntitySnapshot;
};

/** The tracked doc key for a query root: the explicit instance where the
 * root names one (protocol.md §2's read row), else the session identity's
 * own — one construction for track/extend/coverage so the three never
 * disagree on which instance a root means. */
const rootDocKey = (
  space: string,
  root: GraphQuery["roots"][number],
  identity: ScopeKeyIdentity,
): QueryDocKey =>
  root.entityScopeKey !== undefined
    ? `${space}/${root.entityScopeKey}/${root.id}`
    : toDocKey(space, root.id, root.scope ?? DEFAULT_SCOPE, identity);

const entitiesFromTracker = (
  space: string,
  tracker: MapSetStringToPathSelectors,
  manager: EngineObjectManager,
  branch: string,
): Map<QueryDocKey, EntitySnapshot> => {
  const entities = new Map<QueryDocKey, EntitySnapshot>();
  for (const [key] of tracker) {
    const snapshot = snapshotForDocKey(
      space,
      manager,
      branch,
      key as QueryDocKey,
    );
    if (snapshot !== null) {
      entities.set(key as QueryDocKey, snapshot);
    }
  }
  return entities;
};

// Engine-wide per-version cache of document scans for embedded schema
// refs, so a version delivered again by ANOTHER session or query is not
// rescanned. Only canonical `"space"`-scoped snapshots are cached: a
// user- or session-scoped doc key names different content per principal,
// and sharing scans across principals could hand one principal's refs to
// another. Bounded; on overflow the cache clears and repopulates from
// live deliveries. A refresh does not depend on it: an unchanged
// version is answered from the graph state's own record
// (`TrackedGraphState.schemaRefs`), which this cache only seeds.
const SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES = 4096;
const schemaRefScanCaches = new WeakMap<
  Engine.Engine,
  Map<QueryDocKey, { seq: number; refs: ReadonlySet<string> }>
>();

/** This engine's cache of schema-ref scans, created on first use. */
const schemaRefScanCacheFor = (
  engine: Engine.Engine,
): Map<QueryDocKey, { seq: number; refs: ReadonlySet<string> }> => {
  let cache = schemaRefScanCaches.get(engine);
  if (cache === undefined) {
    cache = new Map();
    schemaRefScanCaches.set(engine, cache);
  }
  return cache;
};

// Per-version record of schema documents that verified in this engine's
// store (`docKey -> seq`), so a document another evaluation already
// verified costs a read but no re-hash. A version change drops the entry's
// usefulness by construction (the seq comparison fails).
const verifiedSchemaDocCaches = new WeakMap<
  Engine.Engine,
  Map<QueryDocKey, number>
>();

const EMPTY_SCHEMA_REFS: ReadonlySet<string> = new Set();

/**
 * The external schema-ref hashes a delivered document carries. For a
 * delivered schema document — decided by content-addressed identity,
 * since `cid:` also holds blobs: a document is a schema document exactly
 * when its id is the schema interning of its value — the document's own
 * hash is the single ref, and the closure walk verifies it and follows
 * its refs; its value is not link-scanned, because schema keywords such
 * as `default` may carry link-shaped DATA that is not a link position.
 * Every other document is scanned for link schemas anywhere in its value.
 * Every document, `cid:` or not, also contributes its reserved `schema`
 * metadata member, a schema position in the same spelling: content
 * addressing hashes `.value` alone, and a blob whose value is
 * schema-shaped is indistinguishable from a schema document, so the
 * member is read the same way on all of them. A malformed member — a
 * `cid:` reference outside a single root `$ref` — is state the commit
 * boundary refuses, so one found here predates that enforcement or was
 * written out of band; assembly fails the query on it
 * ({@link SchemaClosureError}) rather than deliver a document whose
 * schema no reader can resolve.
 */
const scanSnapshotSchemaRefs = (
  engine: Engine.Engine,
  key: QueryDocKey,
  snapshot: EntitySnapshot,
  scans: SchemaRefScans,
  stats: QueryTraversalStats,
): ReadonlySet<string> => {
  // The state's own record first: it covers every scope, and on a refresh
  // it answers every delivered document whose version did not change.
  const own = scans.get(key);
  if (own !== undefined && own.seq === snapshot.seq) {
    return own.refs;
  }
  if ((snapshot.scope ?? DEFAULT_SCOPE) === DEFAULT_SCOPE) {
    const cached = schemaRefScanCacheFor(engine).get(key);
    if (cached !== undefined && cached.seq === snapshot.seq) {
      recordSchemaRefScan(engine, key, snapshot, cached.refs, scans);
      return cached.refs;
    }
  }
  stats.schemaRefScans += 1;
  const refs = new Set<string>();
  const doc = snapshot.document;
  if (isObjectNotArray(doc)) {
    const { id } = fromDocKey(key);
    let isSchemaDocument = false;
    if (id.startsWith("cid:")) {
      const hash = id.slice("cid:".length);
      const inner = (doc as { value?: unknown }).value;
      if (verifySchemaDocument(hash, inner) !== undefined) {
        isSchemaDocument = true;
        refs.add(hash);
      }
    }
    if (!isSchemaDocument) {
      // Link positions only: an `$alias`-shaped record in a document is
      // plain data to this layer, so its `schema` member is never a
      // delivery obligation — data that merely looks like a binding must
      // not fail a query over an unresolvable ref inside it.
      mapLinkSchemas(doc as FabricValue, (schema) => {
        for (
          const hash of collectExternalSchemaRefHashes(schema as JSONSchema)
        ) {
          refs.add(hash);
        }
        return schema;
      });
    }
    const metaForm = classifySchemaMeta(doc);
    if (metaForm.kind === "malformed") {
      throw new SchemaClosureError(
        `Query result delivers document ${id} with malformed schema ` +
          `metadata (${metaForm.reason}). The commit boundary refuses this ` +
          `form, so the stored document predates that enforcement or was ` +
          `written out of band (docs/specs/content-addressed-schemas.md).`,
      );
    }
    for (const hash of schemaMetaRefHashes(metaForm)) refs.add(hash);
  }
  const result = refs.size === 0 ? EMPTY_SCHEMA_REFS : refs;
  recordSchemaRefScan(engine, key, snapshot, result, scans);
  return result;
};

/**
 * Records what a scan of `snapshot` finds — in the state's own record
 * always, and in the engine-wide cache when the version is space-scoped, so
 * another session delivering it is spared the scan.
 */
const recordSchemaRefScan = (
  engine: Engine.Engine,
  key: QueryDocKey,
  snapshot: EntitySnapshot,
  refs: ReadonlySet<string>,
  scans: SchemaRefScans,
): void => {
  const entry = { seq: snapshot.seq, refs };
  scans.set(key, entry);
  if ((snapshot.scope ?? DEFAULT_SCOPE) !== DEFAULT_SCOPE) return;
  const cache = schemaRefScanCacheFor(engine);
  if (cache.size >= SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, entry);
};

/**
 * Thrown when a query result's schema-document closure cannot be
 * assembled from the delivering space's own store: a referenced document
 * is missing, or its stored content does not hash to its id. The commit
 * boundary preserves installed documents, so this is a violated writer
 * or storage invariant, never a transient condition. A request-shaped
 * evaluation answers its caller with the diagnostic (a QueryError); the
 * fan-out refresh logs it and skips the affected session's frame.
 */
export class SchemaClosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaClosureError";
  }
}

/**
 * The read-side delivery guarantee, enforced at the result-assembly
 * boundary: every schema reference embedded in the documents being
 * delivered — a link schema anywhere in a document's value, the document's
 * `schema` metadata member, or a delivered schema document's own refs —
 * must resolve to a verified schema document
 * in this space, and the whole closure joins the delivered set and the
 * watch set. A missing or forged closure document fails the query loudly
 * ({@link SchemaClosureError}): the write-side guarantee installs closures
 * with their referrers, so a hole is a consistency bug to surface, never
 * to repair around.
 *
 * Two-phase: the walk verifies everything into staging and returns the
 * tracker keys and snapshots to add — the caller commits them only after
 * the whole closure verified. Scan records update during assembly;
 * additive callers stage them with the graph. A refresh whose traversal
 * already advanced its tracker before a failure is healed by the session's
 * forced full re-evaluation instead (the server marks it on the skipped
 * frame).
 *
 * The walk starts from the documents in `delivered` and stops at every
 * schema document the state has already established: not being delivered
 * again, held in `established` (the state's `entities`) at the version
 * `scans` records, and recorded there as the schema document its hash
 * names. `entities` takes a document only once the assembly delivering it
 * verified the whole closure, so a pass that failed — whose traversal and
 * scans may already have run over a new schema document — establishes
 * nothing, even for a later extension of the same state. The commit
 * boundary never replaces or removes a stored `cid:` document, so an
 * established closure costs no read. What the walk does not see is the
 * store altered out of band beneath an unchanged referrer; an evaluation
 * that builds its graph afresh, rather than taking it from the evaluation
 * cache, reads it again. A delivered document's previous version
 * contributes its refs too, which is what re-checks a `cid:` document
 * delivered at a new version against the hash it verified as. Every
 * schema document the walk verifies that `established` does not hold at
 * the version read joins the additions, whether or not the tracker
 * already holds it.
 *
 * Verification is against THIS space's stored content — a verified copy in
 * the realm registry never stands in for the space's own (the
 * space-boundary rule in `docs/specs/content-addressed-schemas.md`).
 */
const assembleSchemaDocClosures = (
  space: string,
  engine: Engine.Engine,
  manager: EngineObjectManager,
  branch: string,
  tracker: MapSetStringToPathSelectors,
  delivered: ReadonlyMap<QueryDocKey, EntitySnapshot>,
  established: ReadonlyMap<QueryDocKey, EntitySnapshot>,
  scans: SchemaRefScans,
  stats: QueryTraversalStats,
): {
  trackerAdds: QueryDocKey[];
  additions: Map<QueryDocKey, EntitySnapshot>;
} => {
  const roots = new Set<string>();
  for (const [key, snapshot] of delivered) {
    const previous = scans.get(key);
    if (previous !== undefined && previous.seq !== snapshot.seq) {
      for (const hash of previous.refs) roots.add(hash);
    }
    for (
      const hash of scanSnapshotSchemaRefs(
        engine,
        key,
        snapshot,
        scans,
        stats,
      )
    ) {
      roots.add(hash);
    }
  }
  const identity = identityOf(manager);
  const schemaDocKey = (hash: string): QueryDocKey =>
    toDocKey(space, `cid:${hash}`, DEFAULT_SCOPE, identity);
  const isEstablished = (hash: string, key: QueryDocKey): boolean => {
    if (delivered.has(key)) return false;
    const scan = scans.get(key);
    return scan !== undefined && scan.refs.has(hash) &&
      established.get(key)?.seq === scan.seq;
  };
  let verified = verifiedSchemaDocCaches.get(engine);
  if (verified === undefined) {
    verified = new Map();
    verifiedSchemaDocCaches.set(engine, verified);
  }
  const trackerAdds: QueryDocKey[] = [];
  const additions = new Map<QueryDocKey, EntitySnapshot>();
  // What the loader read for each hash, for the verified callback: the key
  // and snapshot, and whether this exact version had verified here before.
  const loaded = new Map<
    string,
    { key: QueryDocKey; snapshot: EntitySnapshot; cached: boolean }
  >();
  walkSchemaDocumentClosure({
    roots,
    load: (hash) => {
      const key = schemaDocKey(hash);
      if (isEstablished(hash, key)) return { kind: "settled" };
      const id = `cid:${hash}`;
      manager.load({ id, scope: DEFAULT_SCOPE, type: "application/json" });
      const snapshot = snapshotForDocKey(space, manager, branch, key);
      const doc = snapshot?.document;
      const inner = isObjectNotArray(doc)
        ? (doc as { value?: unknown }).value
        : undefined;
      if (snapshot === null || inner === undefined) return undefined;
      // This exact version verified here before: skip re-hashing, but keep
      // the registry entry warm (a registry clear may have dropped it).
      const registered = verified.get(key) === snapshot.seq
        ? lookupSchemaDocument(hash)
        : undefined;
      loaded.set(hash, { key, snapshot, cached: registered !== undefined });
      return registered === undefined
        ? { kind: "stored", value: inner }
        : { kind: "verified", schema: registered };
    },
    onMissing: (hash, miss) => {
      const id = `cid:${hash}`;
      if (miss === "absent") {
        throw new SchemaClosureError(
          `Query result requires schema document ${id}, which is not stored ` +
            `in this space. Every embedded schema ref must resolve within ` +
            `the delivered set (docs/specs/content-addressed-schemas.md).`,
        );
      }
      throw new SchemaClosureError(
        `Schema document ${id} did not verify in this space: its stored ` +
          `content does not hash to its id.`,
      );
    },
    onVerified: (hash, schema) => {
      const { key, snapshot, cached } = loaded.get(hash)!;
      if (!cached) {
        registerSchemaDocument(hash, schema);
        if (verified.size >= SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES) {
          verified.clear();
        }
        verified.set(key, snapshot.seq);
      }
      // The document just verified is the schema document its id names,
      // which is all a scan of it finds: its own hash. Recording that here
      // keeps the state's record at one entry per delivered version, so a
      // later refresh answers the closure's documents without scanning
      // them.
      recordSchemaRefScan(
        engine,
        key,
        snapshot,
        new Set([hash]),
        scans,
      );
      if (!tracker.has(key)) trackerAdds.push(key);
      // What the graph delivered is its entities, not its tracker: the
      // traversal of a pass that failed may have tracked this document
      // without its closure ever being delivered.
      if (!delivered.has(key) && established.get(key)?.seq !== snapshot.seq) {
        additions.set(key, snapshot);
      }
    },
  });
  return { trackerAdds, additions };
};

/**
 * Validates the schema references a query's root selectors carry, loudly:
 * every referenced document, transitively through its closure, must be
 * stored in this space with content that verifies against its id. A
 * compliant client emits a selector reference only after verifying the
 * closure persisted here, so an unresolvable reference is a protocol
 * violation answered with the diagnostic — never the lenient
 * selects-nothing wait that link schemas inside delivered documents get.
 * Validation registers each document as it verifies, so the traversal
 * behind the selector resolves without re-reading. It reads through the
 * caller's manager, so a historical query (`atSeq`) bounds resolution the
 * same way it bounds every other read: the referenced document must exist
 * and verify at that sequence.
 */
const validateSelectorSchemaRefs = (
  space: string,
  manager: EngineObjectManager,
  branch: string,
  roots: GraphQuery["roots"],
): void => {
  const hashes = new Set<string>();
  for (const root of roots) {
    const schema = root.selector?.schema;
    if (schema === undefined || typeof schema === "boolean") continue;
    for (const hash of collectExternalSchemaRefHashes(schema as JSONSchema)) {
      hashes.add(hash);
    }
  }
  if (hashes.size === 0) return;
  walkSchemaDocumentClosure({
    roots: hashes,
    load: (hash) => {
      const id = `cid:${hash}`;
      const key = toDocKey(space, id, DEFAULT_SCOPE, identityOf(manager));
      manager.load({ id, scope: DEFAULT_SCOPE, type: "application/json" });
      const snapshot = snapshotForDocKey(space, manager, branch, key);
      const doc = snapshot?.document;
      const inner = isObjectNotArray(doc)
        ? (doc as { value?: unknown }).value
        : undefined;
      if (snapshot === null || inner === undefined) return undefined;
      return { kind: "stored", value: inner };
    },
    onVerified: (hash, schema) => {
      registerSchemaDocument(hash, schema);
    },
    onMissing: (hash, miss) => {
      const id = `cid:${hash}`;
      if (miss === "absent") {
        throw new SchemaClosureError(
          `Selector references schema document ${id}, which is not stored ` +
            `in this space. A selector reference must name a persisted ` +
            `closure (docs/specs/content-addressed-schemas.md).`,
        );
      }
      throw new SchemaClosureError(
        `Selector references schema document ${id} that did not verify ` +
          `in this space: its stored content does not hash to its id.`,
      );
    },
  });
};

/** The walk-side recorder over a graph state's miss structures: records
 * the miss's selector and its referrer attribution (see
 * GraphQueryWalkOptions.onMissedDoc for the contract). */
const missRecorderFor = (
  state: Pick<TrackedGraphState, "missed" | "missedBy" | "missesOf">,
  changed?: Set<string>,
): (
  missKey: string,
  selector: SchemaPathSelector,
  referrerKey: string | undefined,
) => void =>
(missKey, selector, referrerKey) => {
  if (!state.missed.has(missKey)) changed?.add(missKey);
  state.missed.add(missKey, selector);
  if (referrerKey === undefined) return;
  let refs = state.missedBy.get(missKey);
  if (refs === undefined) {
    refs = new Set();
    state.missedBy.set(missKey, refs);
  }
  refs.add(referrerKey);
  let misses = state.missesOf.get(referrerKey);
  if (misses === undefined) {
    misses = new Set();
    state.missesOf.set(referrerKey, misses);
  }
  misses.add(missKey);
};

/** Retire one miss outright: the target arrived (or every referrer let
 * go) — drop its selectors and both attribution directions. */
const retireMiss = (
  state: Pick<TrackedGraphState, "missed" | "missedBy" | "missesOf">,
  missKey: string,
  changed?: Set<string>,
): void => {
  if (state.missed.has(missKey)) changed?.add(missKey);
  state.missed.delete(missKey);
  const refs = state.missedBy.get(missKey);
  if (refs !== undefined) {
    for (const referrerKey of refs) {
      const misses = state.missesOf.get(referrerKey);
      if (misses === undefined) continue;
      misses.delete(missKey);
      if (misses.size === 0) state.missesOf.delete(referrerKey);
    }
    state.missedBy.delete(missKey);
  }
};

/** A referrer is about to be re-walked: its previous attributions no
 * longer stand (the walk re-records the ones that still dead-end). A
 * miss whose last attribution goes retires with it. */
const releaseReferrerMisses = (
  state: Pick<TrackedGraphState, "missed" | "missedBy" | "missesOf">,
  referrerKey: string,
  changed?: Set<string>,
): void => {
  const misses = state.missesOf.get(referrerKey);
  if (misses === undefined) return;
  state.missesOf.delete(referrerKey);
  for (const missKey of misses) {
    const refs = state.missedBy.get(missKey);
    if (refs === undefined) continue;
    refs.delete(referrerKey);
    if (refs.size === 0) {
      changed?.add(missKey);
      state.missedBy.delete(missKey);
      state.missed.delete(missKey);
    }
  }
};

export const trackGraph = (
  space: string,
  engine: Engine.Engine,
  query: GraphQuery,
  reuse?: QueryGraphReuseContext,
  options: TrackGraphOptions = {},
): {
  serverSeq: number;
  state: TrackedGraphState;
  stats: QueryTraversalStats;
} => {
  const branch = query.branch ?? "";
  // Historical reads bypass the cache (entries are current-seq only), and
  // so does the lease-holder exemption class: an exempt evaluation judges
  // the CURRENT live lease, which is host state that can move without a
  // commit — seq rotation cannot fence it, so those evaluations are never
  // cached or served.
  const cache = options.readSeq === undefined && options.keyedSnapshots !== true
    ? options.evaluationCache
    : undefined;
  let cacheKeys: { pure: string; identity: string } | undefined;
  let refusalProbeReads = 0;
  if (cache !== undefined) {
    const currentSeq = Engine.serverSeq(engine);
    if (cache.engine !== engine || cache.seq !== currentSeq) {
      cache.engine = engine;
      cache.seq = currentSeq;
      cache.entries.clear();
      cache.weight = 0;
      cache.rotations++;
    }
    const queryKey = evaluationQueryKey(query);
    cacheKeys = {
      pure: `P${queryKey}`,
      identity: `I${evaluationIdentityKey(options)}${queryKey}`,
    };
    const pureEntry = cache.entries.get(cacheKeys.pure);
    let served: TrackedGraphState | null = null;
    let probeReads = 0;
    if (pureEntry !== undefined) {
      if (pureEntry.share.kind === "absent-residue") {
        const rewritten = cloneWithRewrittenResidue(
          engine,
          space,
          pureEntry.state,
          pureEntry.share.residue,
          options,
        );
        served = rewritten.state;
        probeReads = rewritten.probeReads;
        if (served === null) {
          cache.residueRefusals++;
        } else {
          cache.hitsAbsentResidue++;
        }
      } else {
        served = cloneTrackedGraphStateForIdentity(
          engine,
          pureEntry.state,
          options,
        );
        cache.hitsPure++;
      }
    }
    if (served === null) {
      // Either no shared entry, or its residue is PRESENT for this
      // identity and the share was refused. The identity's own earlier
      // evaluation — tainted, keyed to exactly this (principal,
      // sessionId) — still answers; without this lookup a shared entry
      // would shadow it and the identity would re-evaluate every time.
      const identityEntry = cache.entries.get(cacheKeys.identity);
      if (identityEntry !== undefined) {
        served = cloneTrackedGraphStateForIdentity(
          engine,
          identityEntry.state,
          options,
        );
        cache.hitsIdentity++;
      }
    }
    if (served !== null) {
      // A hit ran no traversal, and its stats say so — but the residue
      // absence probes ARE engine reads, and they report as such.
      return {
        serverSeq: currentSeq,
        state: served,
        stats: { ...createQueryTraversalStats(), managerReads: probeReads },
      };
    }
    // A refused share's probes were still reads this call performed; the
    // full evaluation below reports them alongside its own.
    refusalProbeReads = probeReads;
    cache.misses++;
  }
  const managerKey = options.readSeq === undefined
    ? `${branch}\0${options.principal ?? ""}\0${options.sessionId ?? ""}`
    : `${branch}\0${options.readSeq}\0${options.principal ?? ""}\0${
      options.sessionId ?? ""
    }`;
  let manager = reuse?.managers?.get(managerKey);
  if (manager === undefined) {
    manager = new EngineObjectManager(
      engine,
      branch,
      options.principal,
      options.sessionId,
      options.readSeq,
    );
    reuse?.managers?.set(managerKey, manager);
  }
  const schemaTracker = new MapSetStringToPathSelectors(true);
  const missState = {
    missed: new MapSetStringToPathSelectors(true),
    missedBy: new Map<string, Set<string>>(),
    missesOf: new Map<string, Set<string>>(),
  };
  const sharedMemo = createSchemaMemo();
  const stats = createQueryTraversalStats();
  const readCountBefore = manager.readCount;
  const walk = new GraphQueryWalk({
    manager,
    space: space as MemorySpace,
    schemaTracker,
    onMissedDoc: missRecorderFor(missState),
    identity: identityOf(manager),
    memo: sharedMemo,
    stats,
  });

  validateSelectorSchemaRefs(space, manager, branch, query.roots);

  for (const root of query.roots) {
    chargeRootVisit(root, manager, stats, () => {
      const selector = toDocumentSelector(root.selector);
      const rootScope = root.scope ?? DEFAULT_SCOPE;
      // A root naming an explicit instance (protocol.md §2's read row —
      // lease-holder only, admission enforced at the server layer) reads
      // and tracks THAT instance; traversal beyond the root resolves under
      // the session identity as today (per-run deep threading is the
      // Phase 2 fan-out work).
      const loaded = manager.load({
        id: root.id,
        scope: rootScope,
        ...(root.entityScopeKey === undefined
          ? {}
          : { scopeKey: root.entityScopeKey }),
        type: "application/json",
      });
      const rootKey = rootDocKey(space, root, identityOf(manager));
      if (loaded !== null) {
        walk.visit(loaded, selector, rootKey);
      } else {
        schemaTracker.add(rootKey, selector);
      }
    });
  }

  const entities = entitiesFromTracker(space, schemaTracker, manager, branch);
  const schemaRefs: SchemaRefScans = new Map();
  const staged = assembleSchemaDocClosures(
    space,
    engine,
    manager,
    branch,
    schemaTracker,
    entities,
    // A graph's first assembly has nothing established to stop at.
    new Map(),
    schemaRefs,
    stats,
  );
  for (const key of staged.trackerAdds) {
    schemaTracker.add(key, REJECTING_SELECTOR);
  }
  for (const [key, snapshot] of staged.additions) {
    entities.set(key, snapshot);
  }

  stats.managerReads = manager.readCount - readCountBefore +
    refusalProbeReads;

  const state: TrackedGraphState = {
    branch,
    tracker: schemaTracker,
    ...missState,
    entities,
    memo: sharedMemo,
    manager,
    schemaRefs,
  };
  if (
    cache !== undefined && cacheKeys !== undefined &&
    cache.entries.size < EVALUATION_CACHE_MAX_ENTRIES
  ) {
    // The cache keeps its own clone: the state returned below belongs to
    // the caller's session, whose refreshes and extensions mutate it.
    const share = classifyStateScope(state);
    const weight = state.entities.size;
    const key = share.kind === "tainted" ? cacheKeys.identity : cacheKeys.pure;
    const previous = cache.entries.get(key);
    cache.entries.set(key, {
      state: cloneTrackedGraphState(engine, state),
      share,
      weight,
    });
    cache.weight += weight - (previous?.weight ?? 0);
  }
  return {
    serverSeq: Engine.serverSeq(engine),
    state,
    stats,
  };
};

export const extendTrackedGraph = (
  space: string,
  engine: Engine.Engine,
  state: TrackedGraphState,
  query: GraphQuery,
): {
  serverSeq: number;
  updates: Map<QueryDocKey, EntitySnapshot>;
  stats: QueryTraversalStats;
} => {
  const manager = state.manager;
  const stats = createQueryTraversalStats();
  const readCountBefore = manager.readCount;
  const touched = new Set<QueryDocKey>();

  const loaded = manager.captureLoads(() => {
    validateSelectorSchemaRefs(space, manager, state.branch, query.roots);
    for (const root of query.roots) {
      chargeRootVisit(root, manager, stats, () => {
        const selector = toDocumentSelector(root.selector);
        const rootScope = root.scope ?? DEFAULT_SCOPE;
        const rootKey = rootDocKey(space, root, identityOf(manager));
        touched.add(rootKey);
        evaluateTrackedDocument(
          space,
          manager,
          {
            id: root.id,
            scope: rootScope,
            ...(root.entityScopeKey === undefined
              ? {}
              : { scopeKey: root.entityScopeKey }),
          },
          selector,
          state.tracker,
          missRecorderFor(state),
          state.memo,
          stats,
        );
      });
    }
  });
  for (const address of loaded) {
    touched.add(`${space}/${address.scopeKey}/${address.id}`);
  }

  const updates = new Map<QueryDocKey, EntitySnapshot>();
  for (const key of touched) {
    if (!state.tracker.has(key)) {
      continue;
    }
    const snapshot = snapshotForDocKey(
      space,
      manager,
      state.branch,
      key,
    );
    if (snapshot === null) {
      continue;
    }
    updates.set(key, snapshot);
  }

  // Assembly validates before anything commits to `state.entities`; the
  // caller stages the whole graph state (`stageTrackedGraphState`), which
  // covers the tracker mutations the traversal above already made.
  const staged = assembleSchemaDocClosures(
    space,
    engine,
    manager,
    state.branch,
    state.tracker,
    updates,
    state.entities,
    state.schemaRefs,
    stats,
  );
  for (const key of staged.trackerAdds) {
    state.tracker.add(key, REJECTING_SELECTOR);
  }
  for (const [key, snapshot] of staged.additions) {
    updates.set(key, snapshot);
  }
  for (const [key, snapshot] of updates) {
    state.entities.set(key, snapshot);
  }

  stats.managerReads = manager.readCount - readCountBefore;

  return {
    serverSeq: Engine.serverSeq(engine),
    updates,
    stats,
  };
};

export const isGraphQueryCoveredByState = (
  space: string,
  state: TrackedGraphState,
  query: GraphQuery,
): boolean =>
  query.roots.every((root) => {
    const selector = toDocumentSelector(root.selector);
    const rootKey = rootDocKey(space, root, identityOf(state.manager));
    return schemaTrackerCoversSelector(state.tracker, rootKey, selector);
  });

export const queryGraph = (
  space: string,
  engine: Engine.Engine,
  query: GraphQuery,
  reuse?: QueryGraphReuseContext,
  options: TrackGraphOptions = {},
): {
  serverSeq: number;
  entities: EntitySnapshot[];

  /** What the evaluation cost. Carried out so the server can attribute a
   * slow `graph.query` to a root; it is not part of the wire result, and
   * the caller drops it before responding. */
  stats: QueryTraversalStats;
} => {
  const tracked = trackGraph(space, engine, query, reuse, {
    ...options,
    readSeq: query.atSeq,
  });
  const entities = options.keyedSnapshots === true
    ? [...tracked.state.entities.entries()].map(([key, snapshot]) => ({
      ...snapshot,
      scopeKey: fromDocKey(key as QueryDocKey).scopeKey,
    }))
    : [...tracked.state.entities.values()];
  return {
    serverSeq: tracked.serverSeq,
    stats: tracked.stats,
    entities: entities
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
};

// The refresh's own phase rows (`memory/refresh/walk/<phase>` on the
// health route's timing stats, beside the server's `memory/refresh/phase/*`
// rows): one row per phase of one graph's incremental re-evaluation, so a
// slow pass can be read as "the closure scan" or "the re-walk" rather than
// as one number. Recorded whether or not the logger prints.
const refreshTiming = getLogger("memory", { enabled: false });

/**
 * The phase clock of one graph's incremental re-evaluation. `enter(name)`
 * closes the phase in progress, if any, and opens `name`; `close()` closes
 * the phase in progress and records the whole as `total`, once. The
 * evaluation closes the clock in a `finally`, so one that throws still
 * records the phase it was in and its total — an expensive failure is the
 * one most worth attributing, and it is skipped and requeued by its caller
 * rather than surfaced anywhere else.
 */
const walkPhaseClock = (): {
  enter(name: string): void;
  close(): void;
} => {
  const startedAt = performance.now();
  let phaseAt = startedAt;
  let current: string | undefined;
  let closed = false;
  const record = (name: string, now: number) =>
    refreshTiming.time(phaseAt, now, "memory", "refresh", "walk", name);
  return {
    enter(name) {
      const now = performance.now();
      if (current !== undefined) record(current, now);
      current = name;
      phaseAt = now;
    },
    close() {
      if (closed) return;
      closed = true;
      const now = performance.now();
      if (current !== undefined) record(current, now);
      current = undefined;
      refreshTiming.time(startedAt, now, "memory", "refresh", "walk", "total");
    },
  };
};

export const refreshTrackedGraph = (
  space: string,
  engine: Engine.Engine,
  state: TrackedGraphState,
  dirtyIds: ReadonlySet<string>,
): {
  serverSeq: number;
  updates: Map<QueryDocKey, EntitySnapshot>;
  changedMisses: ReadonlySet<string>;
  stats: QueryTraversalStats;
} | null => {
  const affectedDocs = new Map<QueryDocKey, Set<SchemaPathSelector>>();
  // Dirty docs the query had MISSED, kept apart from the tracked ones:
  // their re-evaluation routes a still-absent outcome back into the miss
  // set (never the tracker, whose entries reach the wire).
  const affectedMisses = new Map<QueryDocKey, Set<SchemaPathSelector>>();
  const invalidations = new Map<CellScope, Set<string>>();
  const identity = identityOf(state.manager);
  const phases = walkPhaseClock();
  try {
    phases.enter("select");
    for (const dirtyId of dirtyIds) {
      // Dirtiness arrives keyed by scope INSTANCE (M4, stage F): the dirty
      // key's scope_key segment IS the tracked doc key's middle segment, so
      // the affected-tracker lookup is a direct join — no session-identity
      // re-resolution, and another principal's instance simply never
      // matches this state's tracker.
      const { id, scopeKey, scope } = fromDirtyKey(dirtyId);
      // The manager's read cache keys by (scope name, id) under its ONE
      // bound identity, so invalidate only dirtiness aimed at THIS
      // identity's own instance — a foreign instance was never cached here.
      if (
        canResolveScopeKey(scope, identity) &&
        resolveScopeKey(scope, identity) === scopeKey
      ) {
        let scopedIds = invalidations.get(scope);
        if (scopedIds === undefined) {
          scopedIds = new Set();
          invalidations.set(scope, scopedIds);
        }
        scopedIds.add(id);
      }
      const key: QueryDocKey = `${space}/${scopeKey}/${id}`;
      const selectors = state.tracker.get(key);
      if (selectors !== undefined && selectors.size > 0) {
        affectedDocs.set(key, new Set(selectors));
      }
      // A dirty doc the query's walks MISSED (read as absent) re-fires the
      // query exactly like a tracked one: this is the arrival half of the
      // dead-end read contract — the write that creates the document is the
      // event that heals every read that dead-ended on it. Without this, a
      // first-hydration miss on a quiet space starves for the session's
      // life (OW45 arm B).
      const missedSelectors = state.missed.get(key);
      if (missedSelectors !== undefined && missedSelectors.size > 0) {
        affectedMisses.set(key, new Set(missedSelectors));
      }
    }
    if (affectedDocs.size === 0 && affectedMisses.size === 0) {
      return null;
    }
    phases.enter("rewalk");

    const manager = new EngineObjectManager(
      engine,
      state.branch,
      state.manager.principal,
      state.manager.sessionId,
    );
    const sharedMemo = createSchemaMemo();
    const stats = createQueryTraversalStats();
    const readCountBefore = manager.readCount;

    const changedMisses = new Set<string>();
    const recorder = missRecorderFor(state, changedMisses);
    for (const key of affectedDocs.keys()) {
      state.tracker.delete(key);
      // The re-walk below re-records this referrer's still-live misses;
      // attributions from its PREVIOUS walk no longer stand, so a link
      // edited away retires its miss instead of leaving a stale wake.
      releaseReferrerMisses(state, key, changedMisses);
    }

    for (const [key, selectors] of affectedDocs) {
      const { id, scope, scopeKey } = fromDocKey(key);
      for (const selector of selectors) {
        evaluateTrackedDocument(
          space,
          manager,
          { id, scope, scopeKey },
          selector,
          state.tracker,
          recorder,
          sharedMemo,
          stats,
        );
      }
    }
    phases.enter("misses");
    // Re-evaluate the dirtied misses. A BORN target is visited — it enters
    // the tracker (and the update assembly below delivers it) — and its
    // miss retires; a still-absent one keeps its miss and attributions
    // untouched (the throwaway sink swallows the absent re-registration:
    // a miss never migrates into the tracker, whose entries reach the
    // wire).
    const stillAbsent = new MapSetStringToPathSelectors(true);
    for (const [key, selectors] of affectedMisses) {
      const { id, scope, scopeKey } = fromDocKey(key);
      for (const selector of selectors) {
        evaluateTrackedDocument(
          space,
          manager,
          { id, scope, scopeKey },
          selector,
          state.tracker,
          recorder,
          sharedMemo,
          stats,
          stillAbsent,
        );
      }
      // Retirement is decided by THIS evaluation's own outcome — the
      // throwaway sink received the key iff the doc was still absent. The
      // tracker is no witness here: the same key can be an absent watch
      // ROOT whose re-evaluation just re-added its seq-0 marker, and
      // retiring the miss on that would lose the link-derived selector's
      // closure when the doc is finally born.
      if (!stillAbsent.has(key)) {
        retireMiss(state, key, changedMisses);
      }
    }

    phases.enter("loaded");
    const touched = new Set<QueryDocKey>(affectedDocs.keys());
    for (const key of affectedMisses.keys()) touched.add(key);
    for (const address of manager.loadedAddresses()) {
      const key: QueryDocKey = `${space}/${address.scopeKey}/${address.id}`;
      const previous = state.entities.get(key);
      const detail = manager.detail({
        id: address.id,
        scope: address.scope,
        scopeKey: address.scopeKey,
      });
      if (previous !== undefined && detail?.seq === previous.seq) {
        continue;
      }
      touched.add(key);
    }
    phases.enter("snapshot");
    const updates = new Map<QueryDocKey, EntitySnapshot>();
    for (const key of touched) {
      if (!state.tracker.has(key)) {
        continue;
      }
      const snapshot = snapshotForDocKey(
        space,
        manager,
        state.branch,
        key,
      );
      if (snapshot === null) {
        continue;
      }
      updates.set(key, snapshot);
    }

    // Only the closures the updated documents reach are walked, and the
    // walk stops at schema documents this state already established, so a
    // refresh reads no closure document an earlier pass delivered. A throw
    // here can leave this graph's tracker partially advanced; the caller
    // marks the session for a full re-evaluation, which re-diffs everything
    // on the next successful pass rather than trusting increments computed
    // over the failure.
    phases.enter("closure");
    const staged = assembleSchemaDocClosures(
      space,
      engine,
      manager,
      state.branch,
      state.tracker,
      updates,
      state.entities,
      state.schemaRefs,
      stats,
    );
    phases.enter("merge");
    for (const key of staged.trackerAdds) {
      state.tracker.add(key, REJECTING_SELECTOR);
    }
    for (const [key, snapshot] of staged.additions) {
      updates.set(key, snapshot);
    }

    for (const [key, snapshot] of updates) {
      state.entities.set(key, snapshot);
    }
    for (const [scope, ids] of invalidations) {
      state.manager.invalidateIds(ids, scope);
    }
    state.manager.mergeFrom(manager);

    stats.managerReads = manager.readCount - readCountBefore;

    return {
      serverSeq: Engine.serverSeq(engine),
      updates,
      changedMisses,
      stats,
    };
  } finally {
    phases.close();
  }
};

const evaluateTrackedDocument = (
  space: string,
  manager: EngineObjectManager,
  address: { id: string; scope?: CellScope; scopeKey?: ScopeKey },
  selector: SchemaPathSelector,
  schemaTracker: MapSetStringToPathSelectors,
  onMissedDoc: (
    missKey: string,
    selector: SchemaPathSelector,
    referrerKey: string | undefined,
  ) => void,
  sharedMemo: SchemaMemo,
  stats: QueryTraversalStats,
  // Where an ABSENT document's selector lands. A watch ROOT records in
  // the tracker — absence is delivered as the seq-0 marker entity — while
  // a re-evaluated MISS must NOT migrate into the delivered set: a
  // dirtied-but-still-absent target (a creation and deletion coalesced
  // into one batch, say) keeps waiting for a real arrival, so its
  // caller passes a sink the wire never sees.
  absentSink: MapSetStringToPathSelectors = schemaTracker,
): void => {
  const docKey: QueryDocKey = address.scopeKey !== undefined
    ? `${space}/${address.scopeKey}/${address.id}`
    : toDocKey(
      space,
      address.id,
      address.scope ?? DEFAULT_SCOPE,
      identityOf(manager),
    );
  const loaded = manager.load(address);
  if (loaded === null || loaded.value === undefined) {
    absentSink.add(docKey, internPathSelector(selector));
    return;
  }
  // A fresh walk per document, so each starts with an empty pointer-cycle
  // tracker while sharing the query's reach and its memoized schema results.
  const walk = new GraphQueryWalk({
    manager,
    space: space as MemorySpace,
    schemaTracker,
    onMissedDoc,
    identity: identityOf(manager),
    memo: sharedMemo,
    stats,
  });
  walk.visit(loaded, selector, docKey);
};

export const toDocKey = (
  space: string,
  id: string,
  scope: CellScope = DEFAULT_SCOPE,
  identity: ScopeKeyIdentity,
): QueryDocKey => schemaTrackerKey(space, id, scope, identity);

export const fromDocKey = (key: QueryDocKey): {
  space: string;
  id: string;
  scope: CellScope;
  scopeKey: ScopeKey;
} => {
  // The SPACE (a did) and the scope-key segment (its parts are
  // encodeURIComponent-encoded) never contain "/", so the first two
  // separators are exact and everything after them is the ID — which CAN
  // contain "/" (module-derived handler ids, `data:` ids). The scope
  // NAME is recovered from the instance key because readers resolve rows
  // by (scope, session identity) as before. The instance key itself is
  // returned too: the M4/M1 paths (stage F) address rows by exact
  // instance rather than re-resolving from the session.
  const [space, scopeKey, ...rest] = key.split("/");
  if (rest.length > 0 && isScopeKey(scopeKey)) {
    return {
      space,
      scope: scopeOfScopeKey(scopeKey),
      scopeKey,
      id: rest.join("/"),
    };
  }
  throw new Error(`invalid memory v2 query doc key: ${key}`);
};

/**
 * Wake/sync dirty keys are per scope INSTANCE (scopes.md §7 M4, stage F):
 * `${scope_key}\0${id}`, the same shared vocabulary storage rows and
 * query doc keys use. Dirtiness and delivery both key by scope_key, so a
 * commit to one principal's instance touches only the sessions tracking
 * THAT instance (protocol.md §3) — the scope-NAME form collapsed every
 * principal's instances onto one key, quadratic waste once one server
 * hosts every instance. At cardinality 1 per session the re-keyed form
 * partitions exactly as the name form did (key-vocabulary.md §2).
 */
// Relocated to the shared browser-safe vocabulary surface (v2.ts, beside
// resolveScopeKey) so client-bundled modules can key with it; re-exported
// here for this module's existing importers.
export { toDirtyKey } from "../v2.ts";

export const fromDirtyKey = (
  key: string,
): { id: string; scopeKey: ScopeKey; scope: CellScope } => {
  const separator = key.indexOf("\0");
  if (separator > 0) {
    const scopeKey = key.slice(0, separator);
    if (isScopeKey(scopeKey)) {
      return {
        scopeKey,
        scope: scopeOfScopeKey(scopeKey),
        id: key.slice(separator + 1),
      };
    }
  }
  throw new Error(`invalid memory v2 dirty key: ${key}`);
};
