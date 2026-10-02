import { debugStr } from "@commonfabric/data-model";

/** How many entries one connection holds before its oldest is dropped. */
const ADMISSION_WAITERS_PER_CONNECTION = 1024;

/**
 * The principals the memory server has refused a space, by the connection
 * each was refused on, so that an access-list change admitting one can tell
 * that connection (`session/admissible`, 04-protocol.md §4.2.2).
 *
 * An entry is one (space, principal) pair per connection, added again as
 * often as it likes without growing. A connection holds at most `limit`
 * entries: adding one past that drops the connection's oldest, whose
 * principal then learns of a later grant only by asking again. An entry
 * leaves when `take()` hands it out, and with its connection or its
 * principal's authentication.
 */
export class AdmissionWaiters {
  /** Per space, per connection id, the principals refused it there. */
  #bySpace = new Map<string, Map<string, Set<string>>>();

  /** Per connection id, its entries as `[space, principal]`, oldest first. */
  #byConnection = new Map<string, Map<string, [string, string]>>();

  readonly #limit: number;

  /**
   * Constructs an instance holding at most `limit` entries per connection.
   *
   * @throws RangeError when `limit` is not a positive integer.
   */
  constructor(limit = ADMISSION_WAITERS_PER_CONNECTION) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(
        debugStr`An entry limit must be a positive integer, not $quote${limit}.`,
      );
    }
    this.#limit = limit;
  }

  /** Records that `principal` was refused `space` on `connectionId`. */
  add(connectionId: string, space: string, principal: string): void {
    const key = entryKey(space, principal);
    const held = this.#byConnection.get(connectionId);
    if (held?.has(key)) return;
    if (held !== undefined && held.size >= this.#limit) {
      const [oldestSpace, oldestPrincipal] = held.values().next().value!;
      this.remove(connectionId, oldestSpace, oldestPrincipal);
    }
    // The eviction above may have emptied the connection's map, and with it
    // its registration, so the map is looked up again.
    let entries = this.#byConnection.get(connectionId);
    if (entries === undefined) {
      entries = new Map();
      this.#byConnection.set(connectionId, entries);
    }
    entries.set(key, [space, principal]);
    let byConnection = this.#bySpace.get(space);
    if (byConnection === undefined) {
      byConnection = new Map();
      this.#bySpace.set(space, byConnection);
    }
    let principals = byConnection.get(connectionId);
    if (principals === undefined) {
      principals = new Set();
      byConnection.set(connectionId, principals);
    }
    principals.add(principal);
  }

  /** Drops the entry for `principal` and `space` on `connectionId`. */
  remove(connectionId: string, space: string, principal: string): void {
    const entries = this.#byConnection.get(connectionId);
    if (entries === undefined || !entries.delete(entryKey(space, principal))) {
      return;
    }
    if (entries.size === 0) this.#byConnection.delete(connectionId);
    const byConnection = this.#bySpace.get(space)!;
    const principals = byConnection.get(connectionId)!;
    principals.delete(principal);
    if (principals.size === 0) byConnection.delete(connectionId);
    if (byConnection.size === 0) this.#bySpace.delete(space);
  }

  /** Drops every entry `principal` holds on `connectionId`. */
  removePrincipal(connectionId: string, principal: string): void {
    for (const [space, held] of this.#entriesOf(connectionId)) {
      if (held === principal) this.remove(connectionId, space, principal);
    }
  }

  /** Drops every entry on `connectionId`. */
  removeConnection(connectionId: string): void {
    for (const [space, principal] of this.#entriesOf(connectionId)) {
      this.remove(connectionId, space, principal);
    }
  }

  /**
   * Removes and returns the entries for `space` whose principal `admits()`
   * accepts.
   */
  take(
    space: string,
    admits: (principal: string) => boolean,
  ): { connectionId: string; principal: string }[] {
    const taken: { connectionId: string; principal: string }[] = [];
    for (
      const [connectionId, principals] of this.#bySpace.get(space) ?? []
    ) {
      for (const principal of principals) {
        if (admits(principal)) taken.push({ connectionId, principal });
      }
    }
    for (const { connectionId, principal } of taken) {
      this.remove(connectionId, space, principal);
    }
    return taken;
  }

  /** Helper for the removals, which copies a connection's entries. */
  #entriesOf(connectionId: string): [string, string][] {
    return [...this.#byConnection.get(connectionId)?.values() ?? []];
  }
}

/** The key of one (space, principal) entry within a connection. */
const entryKey = (space: string, principal: string): string =>
  `${space}\0${principal}`;
