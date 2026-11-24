/**
 * A duplex both ends of this connection can be carried over.
 *
 * The runtime is reached over a channel, and which channel is not the
 * runtime's business: a `MessagePort` a page's opener handed across, one a
 * native shell relays, and one a test builds from a `MessageChannel` are the
 * same thing to it. Naming the shape rather than the class is what says so.
 */
export interface MessagePortLike {
  /** Sends one encoded message to the far end. */
  postMessage(message: unknown): void;

  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;

  /**
   * Begins delivery. A `MessagePort` queues everything sent to it until this
   * is called, which is what lets a listener be installed without racing the
   * messages already in flight. Absent from a duplex that delivers from the
   * moment it exists.
   */
  start?(): void;

  /**
   * Stops delivery to `listener`. Absent from a duplex that cannot be
   * detached from, in which case letting go of it is `close`'s job alone.
   */
  removeEventListener?(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;

  /**
   * Releases the channel. Absent from a duplex whose lifetime is not its
   * holder's to end.
   */
  close?(): void;
}
