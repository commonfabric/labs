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
 * leaves when `take()` hands it out, and with its principal's
 * authentication.
 *
 * An entry outlives its connection as a held entry (`hold()`), since with
 * one connection per space a refused open closes the connection it was refused on while the
 * principal's other spaces stay open on theirs. A held entry belongs to no
 * connection: `take()` hands it out without one, for the caller to tell
 * every connection serving the principal. A principal's held entries count
 * against one limit of their own, and leave with `releaseHeld()`.
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

  /** Moves `connectionId`'s entries to their principals' held entries. */
  hold(connectionId: string): void {
    for (const [space, principal] of this.#entriesOf(connectionId)) {
      this.remove(connectionId, space, principal);
      this.add(heldKey(principal), space, principal);
    }
  }

  /** The principals holding held entries. */
  heldPrincipals(): string[] {
    const principals = new Set<string>();
    for (const [connectionId, entries] of this.#byConnection) {
      if (!connectionId.startsWith(HELD_PREFIX)) continue;
      for (const [, principal] of entries.values()) principals.add(principal);
    }
    return [...principals];
  }

  /**
   * Drops `principal`'s held entry for `space`, returning whether it held
   * one.
   */
  removeHeld(space: string, principal: string): boolean {
    const held = this.#byConnection.get(heldKey(principal))?.has(
      entryKey(space, principal),
    ) ?? false;
    this.remove(heldKey(principal), space, principal);
    return held;
  }

  /** Drops every held entry of `principal`. */
  releaseHeld(principal: string): void {
    this.removeConnection(heldKey(principal));
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
   * accepts. A held entry comes back with no `connectionId`.
   */
  take(
    space: string,
    admits: (principal: string) => boolean,
  ): { connectionId: string | undefined; principal: string }[] {
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
    return taken.map(({ connectionId, principal }) => ({
      connectionId: connectionId.startsWith(HELD_PREFIX)
        ? undefined
        : connectionId,
      principal,
    }));
  }

  /** Helper for the removals, which copies a connection's entries. */
  #entriesOf(connectionId: string): [string, string][] {
    return [...this.#byConnection.get(connectionId)?.values() ?? []];
  }
}

/**
 * The prefix of the key a principal's held entries are kept under in place
 * of a connection id, which is a UUID and so never starts with it.
 */
const HELD_PREFIX = "\0held\0";

/** The key `principal`'s held entries are kept under. */
const heldKey = (principal: string): string => `${HELD_PREFIX}${principal}`;

/** The key of one (space, principal) entry within a connection. */
const entryKey = (space: string, principal: string): string =>
  `${space}\0${principal}`;
