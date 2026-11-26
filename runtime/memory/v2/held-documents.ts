/**
 * One decoded copy per stored revision, for as long as anything holds it.
 *
 * Decoded documents are deep-frozen and the revision a key names never
 * changes, so every reader of a revision can share one copy. The engine's
 * document cache shares a copy only while the copy is cached, and its bounds
 * evict revisions that readers still hold: a memory server keeps the
 * documents of each session's watch set for as long as the watch lasts. A
 * read that misses the cache then decodes a second copy, and a server whose
 * sessions watch the same documents holds one copy per session.
 *
 * This table refers to each copy weakly, so it keeps nothing alive itself: a
 * copy stays shared exactly while something outside the table holds it, and
 * once nothing does it is collected and its entry removed.
 */
export class HeldDocuments<T extends object> {
  #copies = new Map<string, WeakRef<T>>();

  #collected = new FinalizationRegistry<{ key: string; copy: WeakRef<T> }>(
    ({ key, copy }) => {
      // The key may name a later copy by now, decoded after this one was
      // collected and before this callback ran.
      if (this.#copies.get(key) === copy) this.#copies.delete(key);
    },
  );

  /**
   * Entries in the table. A collected copy's entry leaves shortly after the
   * collection, so this can count a few that are already gone.
   */
  get size(): number {
    return this.#copies.size;
  }

  /**
   * Returns the copy of the revision `key` names that is still held, if there
   * is one, and otherwise records `decoded` as that copy and returns it.
   * `decoded` must be what the revision decodes to.
   */
  intern(key: string, decoded: T): T {
    const held = this.#copies.get(key)?.deref();
    if (held !== undefined) return held;
    const copy = new WeakRef(decoded);
    this.#copies.set(key, copy);
    this.#collected.register(decoded, { key, copy });
    return decoded;
  }

  /** Forgets every entry, leaving the copies to whatever holds them. */
  clear(): void {
    this.#copies.clear();
  }
}
