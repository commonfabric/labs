/**
 * Decides which of the capability sessions offered to one guest frame is the
 * one that matters. A session is offered per load report, and per port request
 * from a guest that started listening after its document loaded. A load report
 * cannot be matched to a document: a guest can renavigate its own frame, and
 * the inner frame's initial `about:blank` navigation can complete after a
 * document was asked for, so the reports do not stand one to one with the
 * documents the host asks for. What settles it is use rather than counting.
 */

/** A capability session, as far as deciding between offers is concerned. */
export type OfferedSession = {
  /** Cancels the session's subscriptions and closes its port. */
  disconnect(): void;
};

/**
 * The sessions on offer to one guest frame, in offer order.
 *
 * Two entries is the most this holds. A guest takes the first port to reach a
 * document of its that has none, so the session it holds is the earliest one
 * still here, and everything offered after that one was refused.
 */
export class GuestSessions<T extends OfferedSession = OfferedSession> {
  #offered: T[] = [];

  /** The sessions on offer, oldest first. */
  get offered(): readonly T[] {
    return this.#offered;
  }

  /**
   * Takes `session` as the newest offer, disconnecting any offer that is
   * neither the first nor this one.
   *
   * A guest can renavigate its own frame, and each navigation reports a load,
   * so what is held has to be bounded by something other than the guest's
   * restraint. The first offer is kept because a guest that has held a port
   * since before any of this holds that one; the newest is kept because it is
   * the only other one still reachable. Dropping what was newest costs a guest
   * that took that offer, has never spoken on it, and is still there after a
   * further load report -- a document driving navigations while staying silent
   * about the port it holds.
   */
  offer(session: T): void {
    for (const superseded of this.#offered.splice(1)) {
      superseded.disconnect();
    }
    this.#offered.push(session);
  }

  /**
   * Retires every session offered before `session`, which has shown the first
   * request of its port, and returns whether any were.
   *
   * The guest holds one port, so a request on this session says every earlier
   * offer went to a document that is gone or was refused. Either way those
   * sessions serve nobody, and disconnecting them is what cancels a gone
   * document's subscriptions. Later offers are left alone, and so is a session
   * this does not hold: a session is never unseated by an earlier one.
   */
  retireBefore(session: T): boolean {
    const index = this.#offered.indexOf(session);
    if (index <= 0) return false;
    for (const retired of this.#offered.splice(0, index)) {
      retired.disconnect();
    }
    return true;
  }

  /**
   * Disconnects every session on offer and forgets them. What the guest sends
   * afterwards reaches nothing, which is the point: the guest on the other end
   * of a closed port is one the host is done with.
   */
  closeAll(): void {
    const closing = this.#offered;
    this.#offered = [];
    for (const session of closing) {
      session.disconnect();
    }
  }
}
