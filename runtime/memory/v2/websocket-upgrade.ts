/**
 * Upgrades `request` to a websocket carrying the memory protocol, with Deno's
 * idle timeout turned off.
 *
 * That timeout, 30 seconds unless told otherwise, closes a socket whose peer
 * has not answered a ping in that time. It reads a busy thread as a dead peer,
 * and either end of a memory connection can legitimately be busy for longer. A
 * Deno client compiling a pattern answers no ping until it is done, and the
 * close then rejects every request it had in flight. A server evaluating frames
 * synchronously can take its own stretch for silence from every peer and close
 * every connection together when its event loop yields, which turns load into
 * a reconnect storm.
 *
 * Without the timeout, this end learns of a peer that vanishes without closing
 * its socket only when the network reports the failure.
 *
 * Deno-only, as `Deno.upgradeWebSocket()` is.
 */
export function upgradeMemoryWebSocket(
  request: Request,
): Deno.WebSocketUpgrade {
  return Deno.upgradeWebSocket(request, { idleTimeout: 0 });
}
