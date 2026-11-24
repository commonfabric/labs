/**
 * The capability gate for the raw `Date`/`Math` intrinsics inside pattern
 * compartments (W6).
 *
 * `sandboxDateNow`/`sandboxRandom` back the gated `Date`/`Math.random` injected
 * into pattern compartments, so authored `new Date()` / `Date.now()` /
 * `Math.random()` become the safe API. They enforce the time/entropy capability
 * boundary by reading the lift-vs-handler context from the active frame: a
 * lift/computed (pure) context cannot read a clock or entropy at all (it would be
 * a fine reactive time source and would break idempotency), while a handler gets
 * pass-through entropy and a clock frozen to its triggering event.
 *
 * The handler clock is NOT the live wall clock. It is the event's own instant
 * (Frame.eventTime), captured once when the event was created and carried
 * forward to every event the handler emits, coarsened to one second here. Time
 * therefore does not advance during a handler's own work: reading it before and
 * after an `await` yields the same value, so a handler has no clock that ticks
 * during a synchronous secret-dependent operation and no fine wall-clock edge to
 * correlate a network round trip against. Across separate events it still
 * advances, bounded by how fast events arrive. `new Date(arg)` is deterministic
 * and is left untouched at the injection site. See
 * docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md (W1/W6).
 */

import { getTopFrame } from "./pattern.ts";

const ONE_SECOND_MS = 1000;

class TimeCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeCapabilityError";
  }
}

export function sandboxDateNow(): number {
  const frame = getTopFrame();
  if (frame?.inHandler === true && frame.eventTime !== undefined) {
    // The dispatching event's frozen instant, coarsened — never the live clock.
    return Math.floor(frame.eventTime / ONE_SECOND_MS) * ONE_SECOND_MS;
  }
  throw new TimeCapabilityError(
    "The ambient clock (Date.now() / new Date()) is not available in this " +
      "context. Read it inside a handler (it reports the triggering event's " +
      "time, coarsened to one second), or for a live clock read the interval " +
      '#now wish (wish({ query: "#now/N" }), N in seconds). The bare "#now" ' +
      "wish is not a clock — it durably captures the piece's first-ever load " +
      "time and never advances (use it for created-at stamps). Formatting a " +
      "known timestamp with new Date(ms) is unaffected.",
  );
}

export function sandboxRandom(): number {
  const frame = getTopFrame();
  if (frame?.inHandler === true) {
    return Math.random();
  }
  throw new TimeCapabilityError(
    "Ambient randomness (Math.random()) is not available in this context: it " +
      "makes reactive computation non-idempotent. Use it inside a handler, or " +
      "precompute the value.",
  );
}
