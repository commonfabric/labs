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
import {
  type DocumentInterestQuery,
  type DocumentInterestsReport,
  inspectDocumentInterests,
} from "./document-interests.ts";
import type { TrackedGraphState } from "./query.ts";
import type { SessionCacheEntry } from "./server-sync.ts";
import { trackedIdsFromEntries } from "./server-sync.ts";

export type SessionState = {
  id: string;
  space: string;
  sessionToken: SessionToken;
  /**
   * The `resumeKey` and `resumeAttempt` the latest open carried, and the
   * token it presented. A newer attempt under the same key may present that
   * token instead of `sessionToken`: its client may never have received the
   * response that carried `sessionToken` (`SessionDescriptor.resumeKey`).
   */
  resumeKey?: string;
  resumeAttempt?: number;
  presentedToken?: SessionToken;

  /** The read ceiling this session declared at its LAST open
   * (`SessionDescriptor.readCeiling`); fresh per open, never inherited. */
  readCeiling?: SessionReadCeiling;
  /** Immutable root intent authenticated by this session's latest open. */
  genesisRoot?: SessionDescriptor["genesisRoot"];

  /** Immutable kind intent authenticated by this session's latest open. */
  spaceKind?: SessionDescriptor["spaceKind"];

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

  /** The crossings this session's frames have carried, by crossing key,
   * so a frame carries each once; a full replacement of the watch set
   * with no declared holdings starts the record over. */
  deliveredCrossings: Set<string>;
  trackedIds: Set<string>;
  caughtUpLocalSeq: number;
  pendingCaughtUpLocalSeq: number;

  /** Set when delivery-state rollback re-inserted tombstone cache entries
   * for a lost frame's removes: the incremental refresh retracts only what
   * its own re-walks retire, so the next sync must run a FULL watch
   * evaluation to re-diff them out. Self-clearing. */
  forceFullResync: boolean;

  /**
   * Set when a planner selection changed what the session's views may run
   * or adopt without changing what they are delivered: the next frame
   * carries the new plans, over the incremental refresh, and a session
   * nothing dirtied gets a frame of plans alone. Cleared as that frame is
   * built. A changed delivery takes `viewSupportGrown` or
   * `viewSupportReplaced` as well.
   */
  viewPlansPending: boolean;

  /**
   * Set when a planner selection added delivery roots to a view and took
   * none away: the next pass extends the view's support graph by the added
   * roots, inside the incremental refresh, instead of re-evaluating the
   * whole watch set. Cleared as that pass commits. A selection that removes
   * a root takes `viewSupportReplaced`.
   */
  viewSupportGrown: boolean;

  /**
   * Set when a planner selection took a delivery root away from a view of
   * the same revision: the next pass refreshes the demand graphs by its
   * dirty batch, rebuilds the support graphs from the current selections
   * over them, and diffs the session's delivery against the result, as a
   * full evaluation does, so the departed documents are removed without
   * the demand being walked again. Cleared as that pass begins.
   */
  viewSupportReplaced: boolean;

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
  /** Originating routed authority survives detach and is replaced only by admission. */
  routedAuthority?: () => boolean;
  principal?: string;

  /** The delegated READ binding (OW31; `SessionDescriptor.actingAs`):
   * the acting user — the space's ACL owner at open time — this
   * session's READ-class capability decisions resolve as. Never
   * consulted for WRITE/OWNER requirements, the lease-holder read row,
   * or scoped-read identity (those key on `principal`, the envelope).
   * Re-resolved on every open; a resume without the marker drops it. */
  actingPrincipal?: string;

  /**
   * Set when the opening connection's client advertised `elidedVerdicts`:
   * its replica promotes a layer the verdict elides to the document its
   * transaction computed rather than folding it, so the engine may elide a
   * positional write for this session. Set per open
   * from the opening connection, and a resume by a client without the
   * capability is refused, since a replayed verdict may carry an elision only
   * such a replica handles.
   */
  elidedVerdicts?: boolean;
};

/**
 * A change to the sessions a {@link SessionRegistry} holds, as its observer
 * sees it. `opened` reports a session opened or resumed, with what the open
 * declared; `detached` reports its connection gone; `removed` reports the
 * session deleted, either explicitly or after its detach expiry lapses.
 */
export type SessionLifecycleEvent =
  | {
    readonly kind: "opened";
    readonly space: string;
    readonly sessionId: string;
    readonly principal?: string;
    readonly readCeiling?: SessionReadCeiling;
  }
  | {
    readonly kind: "detached";
    readonly space: string;
    readonly sessionId: string;
    readonly expiresAt: number;
  }
  | {
    readonly kind: "removed";
    readonly space: string;
    readonly sessionId: string;
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

/** The `opened` event describing `session` as it stands. */
const openedEvent = (session: SessionState): SessionLifecycleEvent => ({
  kind: "opened",
  space: session.space,
  sessionId: session.id,
  ...(session.principal === undefined ? {} : { principal: session.principal }),
  ...(session.readCeiling === undefined
    ? {}
    : { readCeiling: session.readCeiling }),
});

export class SessionRegistry {
  readonly #ttlMs: number;
  #sessions = new Map<string, SessionState>();
  #observer: ((event: SessionLifecycleEvent) => void) | undefined;

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  #prune(now = Date.now()): void {
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) {
        this.#sessions.delete(key);
        this.#observer?.({
          kind: "removed",
          space: session.space,
          sessionId: session.id,
        });
      }
    }
  }

  /**
   * Installs the one observer of this registry's changes, replacing any
   * installed before, so a registry two servers share reports to the one
   * that installed last; `undefined` removes it. It is called as each change
   * is made, with the registry already reflecting it, and a detached
   * session that lapses is reported when a read prunes it.
   */
  setObserver(
    observer: ((event: SessionLifecycleEvent) => void) | undefined,
  ): void {
    this.#observer = observer;
  }

  /**
   * The events that would bring an observer installed now up to date: an
   * `opened` for every session held, followed by a `detached` for each one
   * whose connection is gone.
   */
  snapshot(): SessionLifecycleEvent[] {
    this.#prune();
    const events: SessionLifecycleEvent[] = [];
    for (const session of this.#sessions.values()) {
      events.push(openedEvent(session));
      if (session.expiresAt !== null) {
        events.push({
          kind: "detached",
          space: session.space,
          sessionId: session.id,
          expiresAt: session.expiresAt,
        });
      }
    }
    return events;
  }

  open(
    space: string,
    session: SessionDescriptor,
    serverSeq: number,
    ownerConnectionId = "session-registry",
    principal?: string,
    actingPrincipal?: string,
    routed = false,
    elidedVerdicts = false,
  ): OpenSessionState {
    this.#prune();
    const sessionId = session.sessionId ?? crypto.randomUUID();
    const key = sessionKey(space, sessionId);
    const existing = this.#sessions.get(key);
    if (existing?.routedAuthority !== undefined && !routed) {
      throw authorizationError("A routed session requires a routed connection");
    }
    // A commit this session had accepted under the waived identity proof
    // may replay as an elided positional write, which only a replica that
    // promotes elided layers by their computed document handles; a client
    // that no longer advertises the capability opens a fresh session instead
    // of resuming this one.
    if (existing?.elidedVerdicts === true && !elidedVerdicts) {
      throw authorizationError(
        "A session opened with elidedVerdicts requires a client that advertises it",
      );
    }
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
      session.sessionToken !== existing.sessionToken &&
      !(
        existing.resumeKey !== undefined &&
        existing.presentedToken !== undefined &&
        existing.resumeAttempt !== undefined &&
        session.resumeKey === existing.resumeKey &&
        session.sessionToken === existing.presentedToken &&
        // A superseded attempt, still in flight when a newer one restored
        // the session, must not take it back.
        session.resumeAttempt !== undefined &&
        session.resumeAttempt > existing.resumeAttempt
      )
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
      ...(session.resumeKey !== undefined
        ? { resumeKey: session.resumeKey }
        : {}),
      ...(session.resumeAttempt !== undefined
        ? { resumeAttempt: session.resumeAttempt }
        : {}),
      ...(session.sessionToken !== undefined
        ? { presentedToken: session.sessionToken }
        : {}),
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
      deliveredCrossings: existing?.deliveredCrossings ?? new Set(),
      trackedIds: existing?.trackedIds ??
        trackedIdsFromEntries(existing?.entities?.values() ?? []),
      caughtUpLocalSeq: existing?.caughtUpLocalSeq ?? 0,
      pendingCaughtUpLocalSeq: existing?.pendingCaughtUpLocalSeq ?? 0,
      forceFullResync: existing?.forceFullResync ?? false,
      viewPlansPending: existing?.viewPlansPending ?? false,
      viewSupportGrown: existing?.viewSupportGrown ?? false,
      viewSupportReplaced: existing?.viewSupportReplaced ?? false,
      ...(existing?.leaseHolderReads === true
        ? { leaseHolderReads: true }
        : {}),
      ...(existing?.leaseHolderReadsLapsed === true
        ? { leaseHolderReadsLapsed: true }
        : {}),
      expiresAt: null,
      ownerConnectionId,
      routedAuthority: existing?.routedAuthority,
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
      ...(session.spaceKind !== undefined
        ? { spaceKind: session.spaceKind }
        : {}),
      // Fresh per open (never inherited): the binding reflects THIS
      // open's resolution against the current ACL; an open without the
      // marker carries none (fail-closed toward less authority).
      ...(actingPrincipal !== undefined ? { actingPrincipal } : {}),
      ...(elidedVerdicts ? { elidedVerdicts: true } : {}),
    });
    this.#observer?.(openedEvent(this.#sessions.get(key)!));
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

  /** Attributes a document to retained sessions without pruning or mutation. */
  documentInterests(query: DocumentInterestQuery): DocumentInterestsReport {
    return inspectDocumentInterests(this.#sessions.values(), query);
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
    if (this.#sessions.delete(sessionKey(space, sessionId))) {
      this.#observer?.({ kind: "removed", space, sessionId });
    }
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

  /** Clears a routed context's retained interests before a fresh-context restore. */
  clearRoutedInterests(space: string, sessionId: string): void {
    const session = this.#sessions.get(sessionKey(space, sessionId));
    if (session === undefined) return;
    session.watches = [];
    session.views = [];
    session.operationWatches = [];
    session.watchIndex = new Map();
    session.graphs = new Map();
    session.entities = new Map();
    session.deliveredCrossings = new Set();
    session.trackedIds = new Set();
    session.operationTrackedIds = new Set();
    session.operationCursors = new Map();
    session.viewEpochs = new Map();
    session.viewSelections = new Map();
    session.viewDemandGraphs = new Map();
    session.viewDemandEntities = new Map();
    session.forceFullResync = true;
    session.viewPlansPending = false;
    session.viewSupportGrown = false;
    session.viewSupportReplaced = false;
  }

  detach(space: string, sessionId: string, ownerConnectionId: string): void {
    const session = this.#sessions.get(sessionKey(space, sessionId));
    if (session?.ownerConnectionId === ownerConnectionId) {
      session.ownerConnectionId = null;
      session.expiresAt = Date.now() + this.#ttlMs;
      this.#observer?.({
        kind: "detached",
        space,
        sessionId,
        expiresAt: session.expiresAt,
      });
    }
  }
}
