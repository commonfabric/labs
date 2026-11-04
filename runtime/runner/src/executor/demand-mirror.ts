import type {
  DemandedInstanceRow,
  SessionDemand,
} from "@commonfabric/memory/v2/server";

/**
 * A serving loop's copy of its space's demand set, as the memory server's
 * `demandForSpace()` last reported it, indexed by instance key.
 *
 * `update()` folds a fresh read in and reports the instance keys whose rows
 * differ from the ones held, which is what lets the demand pass reconcile only
 * those keys. A session whose `SessionDemand` is the object the mirror already
 * holds is unchanged by the server's contract and costs nothing; one whose
 * object was replaced costs a comparison of its old rows against its new ones;
 * a session absent from the read has departed, and all of its rows go.
 *
 * Rows are compared by what the demand pass reads off them, so a session
 * rebuilt with rows equal to the ones held reports no key.
 */
export class DemandMirror {
  readonly #sessions = new Map<string, SessionDemand>();
  readonly #rowsByKey = new Map<
    string,
    Map<string, Readonly<DemandedInstanceRow>>
  >();

  #rowCount = 0;

  /** Rows held, one per (instance key, session). */
  get rowCount(): number {
    return this.#rowCount;
  }

  /** Every instance key at least one session demands. */
  keys(): IterableIterator<string> {
    return this.#rowsByKey.keys();
  }

  /**
   * The rows held for `key`, by session id, or `undefined` when no session
   * demands it. The map is live, and is not to be kept across an `update()`.
   */
  rowsFor(
    key: string,
  ): ReadonlyMap<string, Readonly<DemandedInstanceRow>> | undefined {
    return this.#rowsByKey.get(key);
  }

  /**
   * Folds `demand`, a complete read of the space's demand set, into the
   * mirror, and returns the instance keys whose rows it changed: a row added,
   * a row removed, or a row replaced by one that differs.
   */
  update(demand: readonly SessionDemand[]): Set<string> {
    const changed = new Set<string>();
    const present = new Set<string>();
    for (const session of demand) {
      present.add(session.sessionId);
      const held = this.#sessions.get(session.sessionId);
      if (held === session) continue;
      this.#sessions.set(session.sessionId, session);
      for (const [key, row] of session.rows) {
        const previous = held?.rows.get(key);
        if (previous !== undefined && sameDemandRow(previous, row)) continue;
        this.#setRow(key, session.sessionId, row);
        changed.add(key);
      }
      if (held === undefined) continue;
      for (const key of held.rows.keys()) {
        if (session.rows.has(key)) continue;
        this.#deleteRow(key, session.sessionId);
        changed.add(key);
      }
    }
    for (const [sessionId, held] of this.#sessions) {
      if (present.has(sessionId)) continue;
      this.#sessions.delete(sessionId);
      for (const key of held.rows.keys()) {
        this.#deleteRow(key, sessionId);
        changed.add(key);
      }
    }
    return changed;
  }

  /** Forgets every session and row, as though nothing had been read. */
  clear(): void {
    this.#sessions.clear();
    this.#rowsByKey.clear();
    this.#rowCount = 0;
  }

  #setRow(
    key: string,
    sessionId: string,
    row: Readonly<DemandedInstanceRow>,
  ): void {
    let rows = this.#rowsByKey.get(key);
    if (rows === undefined) {
      rows = new Map();
      this.#rowsByKey.set(key, rows);
    }
    if (!rows.has(sessionId)) this.#rowCount += 1;
    rows.set(sessionId, row);
  }

  #deleteRow(key: string, sessionId: string): void {
    const rows = this.#rowsByKey.get(key);
    if (rows === undefined || !rows.delete(sessionId)) return;
    this.#rowCount -= 1;
    if (rows.size === 0) this.#rowsByKey.delete(key);
  }
}

/** Whether two rows of one key and session say the same thing. */
const sameDemandRow = (
  left: Readonly<DemandedInstanceRow>,
  right: Readonly<DemandedInstanceRow>,
): boolean =>
  left === right ||
  (left.id === right.id &&
    left.scope === right.scope &&
    left.scopeKey === right.scopeKey &&
    left.root === right.root &&
    left.identity?.principal === right.identity?.principal &&
    left.identity?.sessionId === right.identity?.sessionId);
