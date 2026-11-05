/**
 * The framing between the interactive chat service's event envelopes and the
 * Server-Sent Events stream the console page reads. Everything here is pure so
 * the resume contract — what a browser reconnecting at `afterSequence` is owed,
 * and in what order — is testable without a model, a gateway, or a socket.
 */

import type { HarnessChatEventEnvelope } from "../src/contracts/interactive-chat.ts";

/** The SSE event name every chat envelope arrives under. */
export const CONSOLE_CHAT_SSE_EVENT = "chat";

/** The SSE event name the server's own liveness ticks arrive under. */
export const CONSOLE_PING_SSE_EVENT = "ping";

/**
 * One SSE frame. `data` is written as a single line because every payload here
 * is JSON, which carries no literal newline; `id` is the envelope sequence, so
 * a browser's `EventSource` last-event-id and the service's own monotonic
 * counter are the same number.
 */
export const sseFrame = (
  event: string,
  data: string,
  id?: number,
): string =>
  `event: ${event}\n${id === undefined ? "" : `id: ${id}\n`}data: ${data}\n\n`;

/** Frames one chat envelope, keyed by its sequence so a resume can name it. */
export const chatEventFrame = (envelope: HarnessChatEventEnvelope): string =>
  sseFrame(CONSOLE_CHAT_SSE_EVENT, JSON.stringify(envelope), envelope.sequence);

/**
 * Frames a liveness tick. A session between tool calls publishes nothing for
 * minutes at a time, so the browser cannot read silence as a fault unless the
 * server speaks on its own schedule. The count is in the data field because an
 * SSE event with no data is not delivered to the page.
 */
export const pingFrame = (beat: number): string =>
  sseFrame(CONSOLE_PING_SSE_EVENT, String(beat));

/**
 * The `afterSequence` a stream request asks to resume from, or `undefined` for
 * a request that asks for the whole log. A malformed value is refused rather
 * than rounded to zero: silently replaying from the start would look to the
 * page like a session that restarted itself.
 */
export const parseAfterSequence = (raw: string | null): number | undefined => {
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(
      `afterSequence must be a non-negative integer: ${raw}`,
    );
  }
  return parsed;
};

/**
 * The backfill a browser resuming at `afterSequence` is owed, in sequence
 * order. The service returns its events already filtered, but a resumed stream
 * mixes that answer with envelopes that arrived live while it was being read,
 * so this sorts and drops what the caller has seen rather than trusting the
 * order the two sources happened to interleave in.
 */
export const envelopesAfter = (
  envelopes: readonly HarnessChatEventEnvelope[],
  afterSequence: number,
): readonly HarnessChatEventEnvelope[] =>
  [...envelopes]
    .filter((envelope) => envelope.sequence > afterSequence)
    .sort((left, right) => left.sequence - right.sequence);

/**
 * Whether a live envelope still has to be written to a stream that has already
 * delivered up to `deliveredSequence`. A backfill and the live callback both
 * carry the envelopes emitted while the backfill was in flight, and this is
 * what makes the overlap harmless.
 */
export const isUndelivered = (
  envelope: HarnessChatEventEnvelope,
  deliveredSequence: number,
): boolean => envelope.sequence > deliveredSequence;
