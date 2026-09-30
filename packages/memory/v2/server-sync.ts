import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import {
  type CellScope,
  DEFAULT_BRANCH,
  type EntitySnapshot,
  type GraphQuery,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  type SessionHolding,
  type SessionSync,
  type SessionSyncRemove,
  type SessionSyncUpsert,
  type WatchSpec,
} from "../v2.ts";
import { toDirtyKey } from "./query.ts";

/**
 * A session's cached snapshot of one tracked doc INSTANCE. `scopeKey` is
 * server-internal (the wire upsert keeps the scope NAME — a client's
 * instances resolve from its session, protocol.md §1): it keys the cache
 * and the tracked-id set per instance (scopes.md §7 M4, stage F), so two
 * principals' instances of one doc never collapse to one entry.
 */
export type SessionCacheEntry = SessionSyncUpsert & {
  scope: CellScope;
  scopeKey: ScopeKey;
};

const DEFAULT_SCOPE: CellScope = "space";

export const cacheKeyForEntity = (
  branch: string,
  id: string,
  scopeKey: ScopeKey = "space",
): string => `${branch}\0${scopeKey}\0${id}`;

export const sameSnapshot = (
  left: SessionCacheEntry | undefined,
  right: SessionCacheEntry | undefined,
): boolean => {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  // `coverClass` is deliberately not compared: it is a pure function of
  // `seq` (one seq names exactly one commit, whose class is immutable),
  // so it cannot differ while seq matches.
  return left.branch === right.branch &&
    left.id === right.id &&
    left.scopeKey === right.scopeKey &&
    left.seq === right.seq &&
    left.deleted === right.deleted;
};

export const isEmptySync = (sync: SessionSync): boolean =>
  sync.upserts.length === 0 && sync.removes.length === 0 &&
  (sync.operationFields?.length ?? 0) === 0 && sync.viewPlans === undefined;

/**
 * Build a session cache entry for one tracked instance. The instance key
 * is the TRACKED one — passed by callers that walked a graph state's
 * instance-keyed entries — falling back to the session identity's own
 * resolution for the entity's declared scope (the two agree everywhere a
 * root did not name an explicit foreign instance).
 */
export const toCacheEntry = (
  entity: EntitySnapshot,
  identity: ScopeKeyIdentity,
  scopeKey?: ScopeKey,
): SessionCacheEntry => {
  const scope = entity.scope ?? DEFAULT_SCOPE;
  const instanceKey = scopeKey ?? resolveScopeKey(scope, identity);
  if (entity.document === null) {
    return {
      branch: entity.branch,
      id: entity.id,
      scope,
      scopeKey: instanceKey,
      seq: entity.seq,
      deleted: true,
      ...(entity.coverClass === undefined
        ? {}
        : { coverClass: entity.coverClass }),
    };
  }
  return {
    branch: entity.branch,
    id: entity.id,
    scope,
    scopeKey: instanceKey,
    seq: entity.seq,
    doc: entity.document,
    ...(entity.coverClass === undefined
      ? {}
      : { coverClass: entity.coverClass }),
  };
};

/**
 * The delivery diff base a client DECLARES: its holdings, in the cache's
 * own terms. Each holding names a document instance the client confirms
 * it holds at `seq` (a tombstone when `deleted`); the instance resolves
 * from the session identity as every wire frame's does, and the branch is
 * the holding's own declaration, the default branch when it declares
 * none. A holding the diff then finds unchanged is
 * elided, a changed or unlisted document is delivered, and a held
 * document the watch union no longer covers is removed — the same rules
 * the server's own delivery memory drives, with the client's statement
 * in that memory's place. Keyed by branch as the cache is: a holding
 * names its branch (absent = the default), so a same-id document on
 * another branch can never stand in for it. `doc` is deliberately absent:
 * a diff never reads the previous entry's content.
 */
export const holdingsToCacheEntries = (
  holdings: readonly SessionHolding[],
  identity: ScopeKeyIdentity,
): Map<string, SessionCacheEntry> => {
  const entries = new Map<string, SessionCacheEntry>();
  for (const holding of holdings) {
    const scope = holding.scope ?? DEFAULT_SCOPE;
    const scopeKey = resolveScopeKey(scope, identity);
    const branch = holding.branch ?? DEFAULT_BRANCH;
    entries.set(cacheKeyForEntity(branch, holding.id, scopeKey), {
      branch,
      id: holding.id,
      scope,
      scopeKey,
      seq: holding.seq,
      ...(holding.deleted === true ? { deleted: true } : {}),
    });
  }
  return entries;
};

export const trackedIdsFromEntries = (
  entries: Iterable<SessionCacheEntry>,
): Set<string> => {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(toDirtyKey(entry.id, entry.scopeKey));
  }
  return ids;
};

/**
 * The wire form of a cache entry: the server-internal `scopeKey` is
 * STRIPPED — the wire carries scope NAMES, and a client's instances
 * resolve from its authenticated session (protocol.md §1; clients never
 * receive keys). Every path that puts cache entries into a `SessionSync`
 * frame goes through this, so the instance keying stays server-internal
 * and the OFF-arm wire is byte-identical.
 *
 * `keyed` (server-execution v2 stage A, OW17's wire leg): a frame to a
 * session whose lease-holder read exemption is LIVE keeps the instance
 * key on every entry — that session may hold two instances of one
 * (branch, id, scope) at once (its explicit-instance reads name them),
 * and the scope name alone cannot tell them apart. The field is added
 * AFTER the pre-existing fields, so a keyed frame is the byte-identical
 * unkeyed frame plus one field per entry; an unkeyed frame is unchanged.
 */
export const toWireUpsert = (
  entry: SessionCacheEntry,
  keyed = false,
): SessionSyncUpsert => {
  // Field order matches the pre-instance-keying cache entry exactly
  // (branch, id, scope, seq, then deleted|doc), so serialized frames are
  // byte-identical to before the re-key. `coverClass` (the arrival
  // witness's class annotation, populated only under the ON arm) appends
  // after the keying field for the same reason.
  if (entry.deleted === true) {
    return {
      branch: entry.branch,
      id: entry.id,
      scope: entry.scope,
      seq: entry.seq,
      deleted: true,
      ...(keyed ? { scopeKey: entry.scopeKey } : {}),
      ...(entry.coverClass === undefined
        ? {}
        : { coverClass: entry.coverClass }),
    };
  }
  return {
    branch: entry.branch,
    id: entry.id,
    scope: entry.scope,
    seq: entry.seq,
    ...(entry.doc === undefined ? {} : { doc: entry.doc }),
    ...(keyed ? { scopeKey: entry.scopeKey } : {}),
    ...(entry.coverClass === undefined ? {} : { coverClass: entry.coverClass }),
  };
};

/** The wire form of a removed cache entry — `keyed` as on
 * {@link toWireUpsert}. */
export const toWireRemove = (
  entry: SessionCacheEntry,
  keyed = false,
): SessionSyncRemove => ({
  branch: entry.branch,
  id: entry.id,
  scope: entry.scope,
  ...(keyed ? { scopeKey: entry.scopeKey } : {}),
});

export const compareSyncAddress = (
  left: { branch: string; id: string; scope?: CellScope },
  right: { branch: string; id: string; scope?: CellScope },
): number =>
  left.branch.localeCompare(right.branch) ||
  (left.scope ?? DEFAULT_SCOPE).localeCompare(right.scope ?? DEFAULT_SCOPE) ||
  left.id.localeCompare(right.id);

export const groupedQueries = (
  watches: readonly WatchSpec[],
): Map<string, GraphQuery> => {
  const grouped = new Map<string, GraphQuery>();
  for (const watch of watches) {
    if (watch.kind === "operation") continue;
    const branch = watch.query.branch ?? "";
    const existing = grouped.get(branch);
    if (existing === undefined) {
      grouped.set(branch, {
        branch,
        roots: [...watch.query.roots],
      });
      continue;
    }
    for (const root of watch.query.roots) existing.roots.push(root);
  }
  return grouped;
};

export const mergeWatchesById = (
  current: readonly WatchSpec[],
  added: readonly WatchSpec[],
): WatchSpec[] => {
  const merged = new Map(current.map((watch) => [watch.id, watch] as const));
  for (const watch of added) {
    merged.set(watch.id, watch);
  }
  return [...merged.values()];
};

const watchRootIdentity = (root: GraphQuery["roots"][number]): string =>
  JSON.stringify([
    root.id,
    root.scope ?? DEFAULT_SCOPE,
    root.selector.path,
    root.selector.schema === undefined
      ? ""
      : internSchemaAsTaggedHashString(root.selector.schema),
    // The explicit INSTANCE is query semantics like scope and path
    // (protocol.md §2's read row): a changed `entityScopeKey` on the
    // same watch id must compare as a CHANGED spec, or watch.add keeps
    // silently tracking the old instance. `null` for the (universal)
    // keyless case, so OFF-arm identities stay pairwise-identical.
    root.entityScopeKey ?? null,
  ]);

const watchQueryIdentity = (watch: WatchSpec): string =>
  watch.kind === "operation"
    ? JSON.stringify({
      branch: watch.query.branch ?? "",
      id: watch.query.id,
      scope: watch.query.scope ?? DEFAULT_SCOPE,
      path: watch.query.path,
      after: watch.query.after ?? null,
    })
    : JSON.stringify({
      branch: watch.query.branch ?? "",
      atSeq: watch.query.atSeq ?? null,
      excludeSent: watch.query.excludeSent === true,
      roots: watch.query.roots.map(watchRootIdentity).toSorted(),
    });

export const sameWatchSpec = (
  left: WatchSpec,
  right: WatchSpec,
): boolean =>
  left.id === right.id &&
  left.kind === right.kind &&
  watchQueryIdentity(left) === watchQueryIdentity(right);

export const buildFullSync = (
  previous: ReadonlyMap<string, SessionCacheEntry>,
  next: ReadonlyMap<string, SessionCacheEntry>,
  fromSeq: number,
  toSeq: number,
  // Lease-holder frames carry instance keys (see toWireUpsert).
  keyed = false,
): SessionSync => {
  const removes = [...previous.values()]
    .filter((entry) =>
      !next.has(
        cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey),
      )
    )
    .map((entry) => toWireRemove(entry, keyed))
    .sort(compareSyncAddress);
  const upserts = [...next.values()].sort(compareSyncAddress)
    .map((entry) => toWireUpsert(entry, keyed));
  return {
    type: "sync",
    fromSeq,
    toSeq,
    upserts,
    removes,
  };
};

export const buildDiffSync = (
  previous: ReadonlyMap<string, SessionCacheEntry>,
  next: ReadonlyMap<string, SessionCacheEntry>,
  fromSeq: number,
  toSeq: number,
  // Delivery-state out-parameter (CT-1927 family): the wire frame strips
  // instance keys, so a caller that must be able to ROLL BACK this
  // frame's delivery (the push path) collects the internal instance-keyed
  // entries here — the only exact record of which instances the frame
  // carried.
  delivered?: {
    upserts: SessionCacheEntry[];
    removes: SessionCacheEntry[];
  },
  // Lease-holder frames carry instance keys (see toWireUpsert).
  keyed = false,
): SessionSync => {
  const upserts: SessionCacheEntry[] = [];
  for (const [key, current] of next.entries()) {
    if (!sameSnapshot(previous.get(key), current)) {
      upserts.push(current);
    }
  }
  const removedEntries = [...previous.entries()]
    .filter(([key]) => !next.has(key))
    .map(([, entry]) => entry);
  const removes = removedEntries
    .map((entry) => toWireRemove(entry, keyed))
    .sort(compareSyncAddress);
  if (delivered !== undefined) {
    for (const upsert of upserts) delivered.upserts.push(upsert);
    for (const entry of removedEntries) delivered.removes.push(entry);
  }
  return {
    type: "sync",
    fromSeq,
    toSeq,
    upserts: upserts.toSorted(compareSyncAddress).map((entry) =>
      toWireUpsert(entry, keyed)
    ),
    removes,
  };
};
