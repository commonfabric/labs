import type {
  OpCursor,
  OperationWatchSpec,
  SessionDescriptor,
  SessionReadCeiling,
  SessionToken,
  ViewInterest,
  ViewPlan,
  ViewQuery,
  WatchSpec,
} from "../v2.ts";
import type { TrackedGraphState } from "./query.ts";
import type { SessionCacheEntry } from "./server-sync.ts";
import { trackedIdsFromEntries } from "./server-sync.ts";

export type SessionState = {
  id: string;
  space: string;
  sessionToken: SessionToken;

  /** The read ceiling this session declared at its LAST open
   * (`SessionDescriptor.readCeiling`); fresh per open, never inherited. */
  readCeiling?: SessionReadCeiling;
  /** Immutable root intent authenticated by this session's latest open. */
  genesisRoot?: SessionDescriptor["genesisRoot"];
  seenSeq: number;
  lastSyncedSeq: number;
  watches: WatchSpec[];
  /** Stable across a true resume, replaced when a forgotten session is opened. */
  viewEpoch: string;
  /** Renderer interests independent of ordinary subscriptions. */
  views: ViewInterest[];
  viewEpochs: Map<string, string>;
  /** Delivery-only roots selected by the co-hosted planner, keyed by view ID. */
  viewSelections: Map<
    string,
    {
      revision: number;
      generation: number;
      delivery: readonly ViewQuery[];
      eligibleActions?: readonly string[];
      pieces?: ViewPlan["pieces"];
      inputs?: ViewPlan["inputs"];
      producers?: ViewPlan["producers"];
      errors?: ViewPlan["errors"];
    }
  >;
  /** Demand provenance, excluding server-selected supporting documents. */
  viewDemandGraphs: Map<string, TrackedGraphState>;
  viewDemandEntities: Map<string, SessionCacheEntry>;

  /** Watch declarations by id, updated with the array at publication. */
  watchIndex: Map<string, WatchSpec>;

  /** Scoped dirty keys owned by operation watches. Rebuilt on replacement. */
  operationTrackedIds: Set<string>;

  /** Operation declarations in accepted list order, for incremental refresh. */
  operationWatches: OperationWatchSpec[];

  operationCursors: Map<string, OpCursor>;
  graphs: Map<string, TrackedGraphState>;
  entities: Map<string, SessionCacheEntry>;
  trackedIds: Set<string>;
  caughtUpLocalSeq: number;
  pendingCaughtUpLocalSeq: number;

  /** Set when delivery-state rollback re-inserted tombstone cache entries
   * for a lost frame's removes: the incremental refresh path never emits
   * removes, so the next sync must run a FULL watch evaluation to re-diff
   * them out (CT-1927 review, round 7). Self-clearing. */
  forceFullResync: boolean;

  /** Set once this session was admitted an explicit `entity_scope_key`
   * read (protocol.md §2's read row — lease holders only), and STICKY
   * for the session's life: it selects the session's WIRE VOCABULARY
   * (fan-out stage A, protocol.md §3) — every upsert, remove, and
   * snapshot to it carries the instance key from then on, so an
   * instance delivered KEYED is always retracted KEYED (an unkeyed
   * remove names the session's OWN instance in its replica: the
   * former-holder wipe, fan-out stage A's independent review, finding
   * 1). Whether FOREIGN instances are DELIVERED is a separate, per-pass
   * question answered against the LIVE lease
   * (`Server.#currentLeaseHolderExemption`); this bit alone never
   * admits one. */
  leaseHolderReads?: boolean;

  /** Set by a push pass (or a resume catch-up) that found
   * `leaseHolderReads` armed but no live lease: that pass withheld or
   * retracted the session's foreign instances. The first pass that
   * finds the lease live again RE-ARMS by running a FULL watch
   * evaluation, which re-delivers every instance the lapse withheld —
   * a renewal blip the SpaceServer survives in-process must not leave
   * its serving replica silently stale. Cleared by that pass. */
  leaseHolderReadsLapsed?: boolean;

  expiresAt: number | null;
  ownerConnectionId: string | null;
  principal?: string;

  /** The delegated READ binding (OW31; `SessionDescriptor.actingAs`):
   * the acting user — the space's ACL owner at open time — this
   * session's READ-class capability decisions resolve as. Never
   * consulted for WRITE/OWNER requirements, the lease-holder read row,
   * or scoped-read identity (those key on `principal`, the envelope).
   * Re-resolved on every open; a resume without the marker drops it. */
  actingPrincipal?: string;
};

type OpenSessionState = {
  sessionId: string;
  sessionToken: SessionToken;
  serverSeq: number;
  caughtUpLocalSeq?: number;
  resumed?: boolean;
  revokedConnectionId?: string;
};

const sessionKey = (space: string, sessionId: string): string =>
  `${space}\0${sessionId}`;

const authorizationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AuthorizationError" });

const revokedError = (message: string): Error =>
  Object.assign(new Error(message), { name: "SessionRevokedError" });

const nextSessionToken = (): SessionToken =>
  crypto.randomUUID() as SessionToken;

export class SessionRegistry {
  readonly #ttlMs: number;
  #sessions = new Map<string, SessionState>();

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  #prune(now = Date.now()): void {
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) {
        this.#sessions.delete(key);
      }
    }
  }

  open(
    space: string,
    session: SessionDescriptor,
    serverSeq: number,
    ownerConnectionId = "session-registry",
    principal?: string,
    actingPrincipal?: string,
  ): OpenSessionState {
    this.#prune();
    const sessionId = session.sessionId ?? crypto.randomUUID();
    const key = sessionKey(space, sessionId);
    const existing = this.#sessions.get(key);
    if (
      existing?.principal !== undefined &&
      principal !== existing.principal
    ) {
      throw authorizationError(
        `session ${sessionId} is already bound to ${existing.principal}`,
      );
    }
    if (
      existing !== undefined &&
      session.sessionToken !== existing.sessionToken
    ) {
      throw revokedError(
        `session ${sessionId} resume token is no longer valid`,
      );
    }
    const seenSeq = Math.max(
      existing?.seenSeq ?? 0,
      session.seenSeq ?? 0,
    );
    const sessionToken = nextSessionToken();
    const revokedConnectionId = existing?.ownerConnectionId !== undefined &&
        existing.ownerConnectionId !== null &&
        existing.ownerConnectionId !== ownerConnectionId
      ? existing.ownerConnectionId
      : undefined;
    this.#sessions.set(key, {
      id: sessionId,
      space,
      sessionToken,
      seenSeq,
      lastSyncedSeq: existing?.lastSyncedSeq ?? seenSeq,
      watches: existing?.watches ?? [],
      viewEpoch: existing?.viewEpoch ?? crypto.randomUUID(),
      views: existing?.views ?? [],
      viewEpochs: existing?.viewEpochs ?? new Map(),
      viewSelections: existing?.viewSelections ?? new Map(),
      viewDemandGraphs: existing?.viewDemandGraphs ?? new Map(),
      viewDemandEntities: existing?.viewDemandEntities ?? new Map(),
      watchIndex: existing?.watchIndex ?? new Map(),
      operationTrackedIds: existing?.operationTrackedIds ?? new Set(),
      operationWatches: existing?.operationWatches ?? [],
      operationCursors: existing?.operationCursors ?? new Map(),
      graphs: existing?.graphs ?? new Map(),
      entities: existing?.entities ?? new Map(),
      trackedIds: existing?.trackedIds ??
        trackedIdsFromEntries(existing?.entities?.values() ?? []),
      caughtUpLocalSeq: existing?.caughtUpLocalSeq ?? 0,
      pendingCaughtUpLocalSeq: existing?.pendingCaughtUpLocalSeq ?? 0,
      forceFullResync: existing?.forceFullResync ?? false,
      ...(existing?.leaseHolderReads === true
        ? { leaseHolderReads: true }
        : {}),
      ...(existing?.leaseHolderReadsLapsed === true
        ? { leaseHolderReadsLapsed: true }
        : {}),
      expiresAt: null,
      ownerConnectionId,
      principal: existing?.principal ?? principal,
      // Fresh per open (never inherited), like the binding below: a
      // resuming client re-declares its ceiling, and an open declaring none
      // is a session that reads unbounded.
      ...(session.readCeiling !== undefined
        ? { readCeiling: session.readCeiling }
        : {}),
      ...(session.genesisRoot !== undefined
        ? { genesisRoot: session.genesisRoot }
        : {}),
      // Fresh per open (never inherited): the binding reflects THIS
      // open's resolution against the current ACL; an open without the
      // marker carries none (fail-closed toward less authority).
      ...(actingPrincipal !== undefined ? { actingPrincipal } : {}),
    });
    return {
      sessionId,
      sessionToken,
      serverSeq,
      caughtUpLocalSeq: existing?.caughtUpLocalSeq ?? 0,
      ...(existing !== undefined ? { resumed: true } : {}),
      ...(revokedConnectionId ? { revokedConnectionId } : {}),
    };
  }

  get(space: string, sessionId: string): SessionState | null {
    this.#prune();
    return this.#sessions.get(sessionKey(space, sessionId)) ?? null;
  }

  /**
   * Like `get()`, except that it prunes nothing, so it may return a session
   * whose detach grace has run out but which no read has pruned yet.
   */
  peek(space: string, sessionId: string): SessionState | undefined {
    return this.#sessions.get(sessionKey(space, sessionId));
  }

  hasOpenSessionForPrincipal(
    space: string,
    principal: string | undefined,
  ): boolean {
    this.#prune();
    for (const session of this.#sessions.values()) {
      if (
        session.space === space &&
        session.principal === principal
      ) {
        return true;
      }
    }
    return false;
  }

  sessionsForSpace(space: string): SessionState[] {
    this.#prune();
    const sessions: SessionState[] = [];
    for (const session of this.#sessions.values()) {
      if (session.space === space) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  /** Every live session of one principal across ALL spaces — the
   * co-hosted serving identity's loopback sessions (its own space's and,
   * under FP2's cross-space reads, foreign spaces'). */
  sessionsForPrincipal(principal: string): SessionState[] {
    this.#prune();
    const sessions: SessionState[] = [];
    for (const session of this.#sessions.values()) {
      if (session.principal === principal) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  /** Remove a session outright (e.g. its principal lost access). */
  remove(space: string, sessionId: string): void {
    this.#sessions.delete(sessionKey(space, sessionId));
  }

  updateSeenSeq(
    space: string,
    sessionId: string,
    seenSeq: number,
  ): SessionState | null {
    const session = this.get(space, sessionId);
    if (session === null) {
      return null;
    }
    session.seenSeq = Math.max(session.seenSeq, seenSeq);
    return session;
  }

  detach(space: string, sessionId: string, ownerConnectionId: string): void {
    const session = this.#sessions.get(sessionKey(space, sessionId));
    if (session?.ownerConnectionId === ownerConnectionId) {
      session.ownerConnectionId = null;
      session.expiresAt = Date.now() + this.#ttlMs;
    }
  }
}
