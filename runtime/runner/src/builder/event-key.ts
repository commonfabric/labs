import { topFrame } from "./frame-context.ts";

/**
 * Returns the event key of the event the running handler handles: a string
 * that names that one event, as the actor who sent it sent it, to the stream
 * it was sent to. Every run of the same event returns the same key — a retry
 * after a conflict, a client's speculative run and the serving runtime's run
 * of it — so a handler can use it to act on an event at most once, or to
 * address what the event creates. A second gesture, a retry the person asks
 * for, a different stream, or another actor sending the same event id each
 * get a different key. Nothing in the event's payload can choose the value.
 *
 * The key is distinct per durable event id, actor and stream, not per stream
 * entry. A stream that has handled an event can admit the same id again, and
 * the same actor sending it there gets the same key, so a record addressed by
 * the key may already exist: create it only if it is absent.
 *
 * The key is unlabeled runtime output and carries no trust. It says only that
 * one event is one event: not who sent it, and not that a person asked for it.
 *
 * A handler run that no event dispatched, such as a test calling the handler
 * directly, gets a key of its own that no other run shares.
 *
 * @throws Error when called anywhere but in a handler: in a pattern body, a
 *   `computed()`, or a `lift()`.
 */
export function eventKey(): string {
  const frame = topFrame();
  if (frame?.inHandler !== true || frame.eventKey === undefined) {
    throw new Error(
      "`eventKey()` is available only in a handler, not in a pattern body, " +
        "a `computed()`, or a `lift()`.",
    );
  }
  return frame.eventKey;
}
