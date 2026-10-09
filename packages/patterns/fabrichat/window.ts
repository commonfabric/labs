/**
 * Selects a bounded window from a time-ordered conversation. The caller keeps
 * the returned message references so later sends do not move an open window.
 */

import type { FabricEpochNsec } from "commonfabric";
import type { ChatWindowAnchor } from "./schemas.tsx";

/** A selected run and the presence of messages beyond either end. */
export interface WindowSelection<T> {
  messages: T[];
  hasOlder: boolean;
  hasNewer: boolean;
}

/**
 * Selects messages around an exclusive cursor or an included center. Returns
 * `undefined` for malformed requests or a center absent from the view.
 */
export function selectWindow<T extends { sentAt: FabricEpochNsec }>(
  messages: readonly T[],
  anchor: ChatWindowAnchor,
  count: number,
  limit: number,
): WindowSelection<T> | undefined {
  if (
    !Number.isSafeInteger(count) || count <= 0 ||
    !Number.isSafeInteger(limit) || limit <= 0 ||
    !anchor || Object.keys(anchor).length !== 1
  ) return undefined;
  const size = Math.min(count, limit);
  if ("before" in anchor) {
    const cursor = anchor.before;
    if (cursor !== "end" && typeof cursor?.value !== "bigint") {
      return undefined;
    }
    const next = cursor === "end"
      ? -1
      : messages.findIndex((message) => message.sentAt.value >= cursor.value);
    const end = next < 0 ? messages.length : next;
    return selectedRange(messages, Math.max(0, end - size), end);
  }
  if ("after" in anchor) {
    const cursor = anchor.after;
    if (cursor !== "start" && typeof cursor?.value !== "bigint") {
      return undefined;
    }
    const next = cursor === "start"
      ? 0
      : messages.findIndex((message) => message.sentAt.value > cursor.value);
    const start = next < 0 ? messages.length : next;
    return selectedRange(
      messages,
      start,
      Math.min(messages.length, start + size),
    );
  }
  if (!("around" in anchor) || typeof anchor.around?.value !== "bigint") {
    return undefined;
  }
  const center = messages.findIndex((message) =>
    message.sentAt.value === anchor.around.value
  );
  if (center < 0) return undefined;
  const start = Math.max(
    0,
    Math.min(center - Math.floor(size / 2), messages.length - size),
  );
  return selectedRange(
    messages,
    start,
    Math.min(messages.length, start + size),
  );
}

/** Returns the selected interval and its boundaries in the complete view. */
function selectedRange<T>(
  messages: readonly T[],
  start: number,
  end: number,
): WindowSelection<T> {
  return {
    messages: messages.slice(start, end),
    hasOlder: start > 0,
    hasNewer: end < messages.length,
  };
}
