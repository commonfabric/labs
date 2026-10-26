/**
 * Metadata-only attribution of a space-scoped document to retained sessions.
 * The lookup reads existing indexes; it never loads or traverses documents.
 */
import { DEFAULT_BRANCH } from "../v2.ts";
import { toDocKey, type TrackedGraphState } from "./query.ts";
import { cacheKeyForEntity } from "./server-sync.ts";
import type { SessionState } from "./session-registry.ts";

/** Maximum session rows returned by one diagnostic lookup. */
export const MAX_DOCUMENT_INTEREST_SESSIONS = 100;

/** One exact space-scoped document; an omitted branch means the main branch. */
export type DocumentInterestQuery = {
  /** Space whose retained sessions to inspect. */
  space: string;
  /** Document identifier, including its `cid:` or other prefix. */
  id: string;
  /** Branch containing the document. */
  branch?: string;
  /** Maximum session rows, between 1 and MAX_DOCUMENT_INTEREST_SESSIONS. */
  limit?: number;
};

/** A session that directly watches or caches the requested document. */
export type DocumentInterestSession = {
  /** Session identifier, never a session token. */
  sessionId: string;
  /** Authenticated identity that opened the session, when known. */
  principal: string | null;
  /** Delegated read identity, when the session has one. */
  actingPrincipal: string | null;
  /** Current owning connection; null after detach. */
  connectionId: string | null;
  /** Detach-grace deadline; null for an attached session. */
  expiresAt: number | null;
  /** Whether the grace deadline has passed but the registry still holds it. */
  expired: boolean;
  /** Total watch declarations in the session. */
  watchCount: number;
  /** Watch declarations with the requested document as a root. */
  directWatchCount: number;
  /** Whether the session delivery cache has an entry for the document. */
  cached: boolean;
  /** Query graphs holding an entry for the document. */
  graphCount: number;
  /** Whether the view-demand cache has an entry for the document. */
  viewDemandCached: boolean;
  /** View-demand graphs holding an entry for the document. */
  viewDemandGraphCount: number;
};

/** Bounded attribution snapshot, including expired sessions still retained. */
export type DocumentInterestsReport = {
  /** Wall-clock time at which the snapshot was taken, in milliseconds. */
  timestamp: number;
  /** Space that was inspected. */
  space: string;
  /** Document that was inspected. */
  id: string;
  /** Exact branch that was inspected; the main branch is the empty string. */
  branch: string;
  /** This diagnostic inspects only the shared space scope. */
  scope: "space";
  /** Number of matching sessions before the response limit. */
  totalMatches: number;
  /** Whether additional matching sessions were omitted. */
  truncated: boolean;
  /** Matching sessions in registry insertion order, up to the limit. */
  sessions: DocumentInterestSession[];
};

/** Counts retained graph entries using their index, without reading payloads. */
function countGraphs(
  graphs: Iterable<TrackedGraphState>,
  branch: string,
  key: ReturnType<typeof toDocKey>,
): number {
  let count = 0;
  for (const graph of graphs) {
    if (graph.branch === branch && graph.entities.has(key)) count++;
  }
  return count;
}

/**
 * Inspects existing session metadata without pruning, opening storage, or
 * modifying delivery state. Cache entries can be absence records: these counts
 * attribute interest, not retained bytes or distinct copies of a document.
 */
export function inspectDocumentInterests(
  sessions: Iterable<SessionState>,
  query: DocumentInterestQuery,
): DocumentInterestsReport {
  const limit = query.limit ?? MAX_DOCUMENT_INTEREST_SESSIONS;
  if (
    !Number.isInteger(limit) || limit < 1 ||
    limit > MAX_DOCUMENT_INTEREST_SESSIONS
  ) {
    throw new RangeError("Document-interest limit must be between 1 and 100");
  }
  const branch = query.branch ?? DEFAULT_BRANCH;
  const timestamp = Date.now();
  const cacheKey = cacheKeyForEntity(branch, query.id, "space");
  // Shared-space keys are independent of the requesting identity.
  const graphKey = toDocKey(query.space, query.id, "space", {});
  const matches: DocumentInterestSession[] = [];
  let totalMatches = 0;

  for (const session of sessions) {
    if (session.space !== query.space) continue;
    let directWatchCount = 0;
    for (const watch of session.watches) {
      if ((watch.query.branch ?? DEFAULT_BRANCH) !== branch) continue;
      const roots = watch.kind === "operation"
        ? [watch.query]
        : watch.query.roots;
      if (
        roots.some((root) =>
          root.id === query.id &&
          ("entityScopeKey" in root && root.entityScopeKey !== undefined
              ? root.entityScopeKey
              : root.scope ?? "space") === "space"
        )
      ) directWatchCount++;
    }
    const cached = session.entities.has(cacheKey);
    const graphCount = countGraphs(session.graphs.values(), branch, graphKey);
    const viewDemandCached = session.viewDemandEntities.has(cacheKey);
    const viewDemandGraphCount = countGraphs(
      session.viewDemandGraphs.values(),
      branch,
      graphKey,
    );
    if (
      directWatchCount === 0 && !cached && graphCount === 0 &&
      !viewDemandCached && viewDemandGraphCount === 0
    ) continue;
    totalMatches++;
    if (matches.length === limit) continue;
    matches.push({
      sessionId: session.id,
      principal: session.principal ?? null,
      actingPrincipal: session.actingPrincipal ?? null,
      connectionId: session.ownerConnectionId,
      expiresAt: session.expiresAt,
      expired: session.expiresAt !== null && session.expiresAt <= timestamp,
      watchCount: session.watches.length,
      directWatchCount,
      cached,
      graphCount,
      viewDemandCached,
      viewDemandGraphCount,
    });
  }
  return {
    timestamp,
    space: query.space,
    id: query.id,
    branch,
    scope: "space",
    totalMatches,
    truncated: totalMatches > matches.length,
    sessions: matches,
  };
}
