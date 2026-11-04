/** What a hover card shows for: the pointer, or focus. */
export type Presence = "pointer" | "focus";

/**
 * Whether a hover card's card should show: while the pointer is on its content
 * or focus is inside it, and until both have left.
 */
export class HoverPresence {
  #pointer = false;
  #focus = false;

  /** Whether anything the card shows for is inside. */
  get inside(): boolean {
    return this.#pointer || this.#focus;
  }

  /** Notes that `presence` has arrived. */
  enter(presence: Presence): void {
    if (presence === "pointer") this.#pointer = true;
    else this.#focus = true;
  }

  /** Notes that `presence` has left. */
  leave(presence: Presence): void {
    if (presence === "pointer") this.#pointer = false;
    else this.#focus = false;
  }

  /** Forgets both, as when the card's element leaves the document. */
  reset(): void {
    this.#pointer = false;
    this.#focus = false;
  }
}
