/**
 * The view interests of a space's sessions as a serving plane keeps them
 * between publishes. The server's list is read once and handed to every later
 * publish until the server reports a change that can move it: a session's
 * view set, which a watch set that carries views sets, or a session's
 * lifecycle, which is what attaches, detaches and removes one. A publish over
 * unchanged interests then costs the server nothing, where a request for the
 * list would wait for the server's thread's turn however empty the list.
 */

import type { SessionViewInterest } from "@commonfabric/memory/v2";

/**
 * The view interests of each space's sessions, read from the server once and
 * held until the server reports a change that can move them.
 */
export class ViewInterestCache {
  readonly #interests = new Map<string, SessionViewInterest[]>();
  /** The spaces whose held list may no longer be the server's. */
  readonly #stale = new Set<string>();
  /** The number of the read of each space's list that started last. */
  readonly #latestRead = new Map<string, number>();
  /** How many reads of any space's list have started. */
  #reads = 0;

  /** How many spaces it keeps anything for: a list, a read or a change. */
  get size(): number {
    return new Set([
      ...this.#interests.keys(),
      ...this.#stale,
      ...this.#latestRead.keys(),
    ]).size;
  }

  /**
   * Notes that `space`'s interests may have changed. A space it has not read
   * since it last forgot it has no list to doubt, and its next publish reads
   * it anyway, so the note is kept only for a space it has read.
   */
  noteChanged(space: string): void {
    if (this.#latestRead.has(space)) this.#stale.add(space);
  }

  /**
   * Forgets `space`'s list, once the space has no session left to hold one,
   * so a plane that outlives its spaces does not keep every list it read. A
   * read of it in flight then holds nothing when it settles.
   */
  forget(space: string): void {
    this.#interests.delete(space);
    this.#stale.delete(space);
    this.#latestRead.delete(space);
  }

  /**
   * Notes that the selection the plane installed for `handle` in `space` was
   * accepted at `generation`, which is then the generation the held interest
   * carries, as the server's list would after the install.
   */
  noteSelection(
    space: string,
    handle: SessionViewInterest["handle"],
    generation: number,
  ): void {
    const interests = this.#interests.get(space);
    if (interests === undefined) return;
    const index = interests.findIndex((interest) =>
      interest.handle.sessionId === handle.sessionId &&
      interest.handle.sessionEpoch === handle.sessionEpoch &&
      interest.handle.viewEpoch === handle.viewEpoch
    );
    if (index < 0) return;
    interests[index] = { ...interests[index], selectionGeneration: generation };
  }

  /**
   * The interests of `space`'s sessions, those of `excludePrincipal` left
   * out: the held list when the server has reported no change since it was
   * read, and otherwise the list `read` returns, which is held in its place.
   */
  async interestsFor(
    space: string,
    excludePrincipal: string | undefined,
    read: () => Promise<SessionViewInterest[]>,
  ): Promise<SessionViewInterest[]> {
    let interests = this.#interests.get(space);
    if (interests === undefined || this.#stale.has(space)) {
      // A change the server reports while the read is in flight is one the
      // list read may or may not carry, so it stays noted for the next read;
      // a read that fails leaves the space noted, so the next publish reads
      // again rather than publishing over a list the server has moved on
      // from. Of two reads in flight at once, the list the later one
      // started is the one held, whichever settles last.
      this.#stale.delete(space);
      const started = ++this.#reads;
      this.#latestRead.set(space, started);
      try {
        interests = await read();
      } catch (error) {
        this.noteChanged(space);
        throw error;
      }
      if (this.#latestRead.get(space) === started) {
        this.#interests.set(space, interests);
      }
    }
    return excludePrincipal === undefined ? [...interests] : interests.filter((
      interest,
    ) => interest.principal !== excludePrincipal);
  }
}
