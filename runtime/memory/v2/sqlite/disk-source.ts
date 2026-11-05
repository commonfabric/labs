// Phase 7 — injected on-disk SQLite source registry (read-only v1).
//
// A `cf piece link <piece> <field> sqlite:<absPath>` operation registers a
// `{ disk: { path } }` source descriptor as SERVER-SIDE state keyed by the
// handle cell's entity id. The descriptor must NOT live in the cell's readable
// value (which stays the opaque `{ id, tables, rev }`) — the absolute file path
// is not pattern-visible state.
//
// When the server attaches a database for a handle id (Server.#onCellDb), it
// consults this registry first: a registered id is attached read-only from the
// descriptor's path instead of the cell-derived per-(space,id) file. Writes to a
// registered (injected) source are rejected — on-disk write/atomicity is gated
// on Q13/Q14 and reactivity on Q12 (see plans/on-disk-source.md).
//
// v1 scope: in-memory map on the Server instance. Persisting the registration
// across restarts (and the operator/service-space ownership of the handle cell)
// is a deferred product decision documented in plans/on-disk-source.md.

/** A resolved on-disk source descriptor. */
export type DiskSourceDescriptor = {
  /** Absolute path to a plain on-disk SQLite file. */
  path: string;
};

/** Server-side registry of injected on-disk sources, keyed by `(space, id)`.
 *  Keying by space (not id alone) stops a session on one space from governing —
 *  or hijacking the reads of — a handle id resolved in another space. */
export class DiskSourceRegistry {
  #byKey = new Map<string, DiskSourceDescriptor>();

  /**
   * Cap on total entries, so a client looping `sqlite.register-disk-source`
   * with distinct ids cannot grow server memory without bound. Re-registering
   * an existing `(space, id)` is always allowed (idempotent); only _new_ keys
   * past the cap are rejected — a clear error rather than silent eviction
   * (which would drop a legitimate source and silently fall back to the
   * cell-db).
   */
  readonly #maxEntries: number;

  constructor(maxEntries = 4096) {
    this.#maxEntries = maxEntries;
  }

  /**
   * Returns the NUL-separated composite key for `space` and `id` (`\0` cannot
   * appear in a DID or entity id).
   */
  #key(space: string, id: string): string {
    return `${space}\x00${id}`;
  }

  /** Register (or replace) the on-disk source for `(space, id)`. Idempotent for
   *  a stable `(space, absPath)`-derived id + canonical path. */
  register(space: string, id: string, descriptor: DiskSourceDescriptor): void {
    const key = this.#key(space, id);
    if (!this.#byKey.has(key) && this.#byKey.size >= this.#maxEntries) {
      throw new Error(
        `disk-source registry is full (max ${this.#maxEntries} sources)`,
      );
    }
    this.#byKey.set(key, { path: descriptor.path });
  }

  /** Resolve the on-disk descriptor for `(space, id)`, or undefined if it is not
   *  an injected on-disk source (caller falls back to cell-derived). */
  get(space: string, id: string): DiskSourceDescriptor | undefined {
    const d = this.#byKey.get(this.#key(space, id));
    return d ? { path: d.path } : undefined;
  }

  /** Whether `(space, id)` is a registered injected on-disk source. */
  has(space: string, id: string): boolean {
    return this.#byKey.has(this.#key(space, id));
  }
}
