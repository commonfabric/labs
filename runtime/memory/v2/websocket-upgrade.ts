/**
 * Upgrades `request` to a websocket for a memory server to serve, with Deno's
 * idle timeout turned off.
 *
 * That timeout, 30 seconds unless told otherwise, closes a socket that has
 * carried nothing back from its peer in that time, a pong included. It reads a
 * busy thread as a dead peer, and a memory connection legitimately holds up
 * either end's thread for longer than that. A client compiling a pattern
 * answers no ping until it is done, and then has every request it had in flight
 * rejected by the close. A server evaluating frames synchronously reads no pong
 * until its event loop yields, and then closes every connection together, so
 * load turns into a reconnect storm.
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
