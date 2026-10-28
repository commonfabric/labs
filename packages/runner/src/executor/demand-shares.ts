/**
 * The demand shares of a space's sessions as a serving plane keeps them
 * between demand passes. A session's share is read from the server once and
 * handed to every later pass as the same object until the server reports
 * that session's demand changed, so a pass over unchanged sessions costs the
 * server nothing and the space server's mirror, which compares shares by
 * identity before it compares rows, no row comparisons either.
 */

import type { SessionDemand } from "@commonfabric/memory/v2/server";

/** A session as the cache needs to see it, beside the id it is keyed by. */
export type SessionOfShare = {
  readonly principal: string | undefined;
};

/**
 * The demand share of each space's sessions, read from the server once and
 * handed out as the same object until the server reports that session's
 * demand changed.
 */
export class DemandShareCache {
  readonly #shares = new Map<string, Map<string, SessionDemand>>();
  /** Per space, the sessions whose share is stale. */
  readonly #stale = new Map<string, Set<string>>();
  /** Spaces whose every share is stale. */
  readonly #allStale = new Set<string>();

  /**
   * Notes that `sessionId`'s demand in `space` changed, or every session's
   * when no session is named.
   */
  noteChanged(space: string, sessionId?: string): void {
    if (sessionId === undefined) {
      this.#allStale.add(space);
      return;
    }
    let stale = this.#stale.get(space);
    if (stale === undefined) {
      stale = new Set();
      this.#stale.set(space, stale);
    }
    stale.add(sessionId);
  }

  /** Forgets `sessionId`'s share in `space`. */
  forget(space: string, sessionId: string): void {
    const stale = this.#stale.get(space);
    stale?.delete(sessionId);
    if (stale?.size === 0) this.#stale.delete(space);
    const shares = this.#shares.get(space);
    if (shares === undefined) return;
    shares.delete(sessionId);
    if (shares.size === 0) {
      this.#shares.delete(space);
      this.#stale.delete(space);
      this.#allStale.delete(space);
    }
  }

  /**
   * The shares of `space`'s live `sessions`, those of `excludePrincipal`
   * left out, in the order given: each held share that is not stale as it
   * is, and the rest read through `read` in one call. A session `read` does
   * not return is one the server no longer holds, and contributes nothing.
   * An excluded session's stale mark is carried, not consumed, so the pass
   * that first includes it reads its share afresh.
   */
  async sharesFor(
    space: string,
    sessions: ReadonlyMap<string, SessionOfShare>,
    excludePrincipal: string | undefined,
    read: (sessionIds: string[]) => Promise<SessionDemand[]>,
  ): Promise<SessionDemand[]> {
    let shares = this.#shares.get(space);
    if (shares === undefined) {
      shares = new Map();
      this.#shares.set(space, shares);
    }
    const allStale = this.#allStale.has(space);
    const stale = this.#stale.get(space);
    // Consume only this pass's invalidations. Notices arriving during the
    // read belong to the next pass, including a change to the same session.
    this.#allStale.delete(space);
    this.#stale.delete(space);
    const wanted: string[] = [];
    const missing: string[] = [];
    for (const [sessionId, session] of sessions) {
      if (
        excludePrincipal !== undefined && session.principal === excludePrincipal
      ) {
        if (allStale || stale?.has(sessionId)) {
          this.noteChanged(space, sessionId);
        }
        continue;
      }
      wanted.push(sessionId);
      if (allStale || stale?.has(sessionId) || !shares.has(sessionId)) {
        missing.push(sessionId);
      }
    }
    for (const sessionId of shares.keys()) {
      if (!sessions.has(sessionId)) shares.delete(sessionId);
    }
    if (missing.length > 0) {
      let fresh: SessionDemand[];
      try {
        fresh = await read(missing);
      } catch (error) {
        for (const sessionId of missing) this.noteChanged(space, sessionId);
        throw error;
      }
      const returned = new Set<string>();
      for (const share of fresh) {
        if (!sessions.has(share.sessionId)) continue;
        shares.set(share.sessionId, share);
        returned.add(share.sessionId);
      }
      for (const sessionId of missing) {
        if (!returned.has(sessionId)) shares.delete(sessionId);
      }
    }
    const result: SessionDemand[] = [];
    for (const sessionId of wanted) {
      const share = shares.get(sessionId);
      if (share !== undefined) result.push(share);
    }
    return result;
  }
}
