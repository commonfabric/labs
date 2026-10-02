/**
 * Allocates exact room times and selects flat conversation threads. These
 * helpers operate inside the caller's transaction or reactive computation.
 */

import {
  type Cell,
  equals,
  FabricDurationNsec,
  FabricEpochNsec,
  type Writable,
} from "commonfabric";
import type { ChatMessage, ChatRoomPolicy } from "./schemas.ts";

/** The policy used by writers and the published policy cell. */
export const CHAT_POLICY: ChatRoomPolicy = {
  ownersMayObliterate: true,
  keepsHistory: true,
  deletionIsObliteration: false,
  proposedTimeMaxAgeNsec: new FabricDurationNsec(600_000_000_000n),
  proposedTimeMaxLeadNsec: new FabricDurationNsec(10_000_000_000n),
  recentActivityWindowNsec: new FabricDurationNsec(600_000_000_000n),
  maxWindowCount: 100,
  maxOpenWindows: 50,
};

/** Returns the handler's coarse clock as epoch nanoseconds. */
export function handlerTime(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Validates and clamps a proposed time against the room's handler clock. */
export function proposedTime(
  proposed: FabricEpochNsec,
  now: bigint,
): bigint | undefined {
  const value = proposed?.value;
  if (
    typeof value !== "bigint" ||
    value < now - CHAT_POLICY.proposedTimeMaxAgeNsec.value ||
    value > now + CHAT_POLICY.proposedTimeMaxLeadNsec.value
  ) return undefined;
  return value > now ? now : value;
}

/**
 * Reserves the smallest unused time at or after `start`. The keyed reads and
 * write participate in the caller's transaction, so concurrent reservations
 * conflict. Reservations survive the removal of the record using them.
 */
export function reserveTime(
  used: Writable<Record<string, boolean>>,
  start: bigint,
  now: bigint,
): FabricEpochNsec | undefined {
  let candidate = start;
  const end = now + 1_000_000_000n;
  while (candidate < end && used.key(`t:${candidate}`).get()) candidate++;
  if (candidate >= end) return undefined;
  used.key(`t:${candidate}`).set(true);
  return new FabricEpochNsec(candidate);
}

/** Returns whether a message appears in the main conversation. */
export function isMainMessage(message: ChatMessage): boolean {
  return message.replyTo?.shownIn !== "thread";
}

/** Returns the root of a thread reply, or no root for a main-only message. */
export function threadRoot(
  message: ChatMessage,
): Cell<ChatMessage> | undefined {
  let reply = message.replyTo;
  const visited: Cell<ChatMessage>[] = [];
  while (reply && reply.shownIn !== "main") {
    const target = reply.message.resolveAsCell();
    if (visited.some((entry) => equals(entry, target))) return undefined;
    visited.push(target);
    const value = target.get();
    if (!value) return undefined;
    if (!value.replyTo || value.replyTo.shownIn === "main") return target;
    reply = value.replyTo;
  }
  return undefined;
}

/** Returns the selected conversation view, ordered by exact recorded time. */
export function conversationView(
  messages: readonly ChatMessage[],
  root?: Cell<ChatMessage>,
): ChatMessage[] {
  if (root?.get() === undefined) root = undefined;
  return messages.filter((message) =>
    root
      ? equals(message, root) || equals(threadRoot(message), root)
      : isMainMessage(message)
  ).sort((left, right) =>
    left.sentAt.value < right.sentAt.value
      ? -1
      : left.sentAt.value > right.sentAt.value
      ? 1
      : 0
  );
}

/** Returns whether text is one Unicode RGI emoji sequence. */
export function isSingleEmoji(emoji: string): boolean {
  return typeof emoji === "string" &&
    new RegExp("^\\p{RGI_Emoji}$", "v").test(emoji);
}
