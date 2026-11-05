/**
 * FabriChat's rules that need no runtime: what counts as a single emoji, how
 * the two views of a conversation are derived from replies, how a thread's
 * title reads when no member has set one, the id an add's offer goes by, and
 * what a manager's report of an add does to its outcome. The room applies them
 * to its records; `logic.test.ts` states them directly.
 */

import type { AddDeliveryReport, AddMemberOutcome } from "./schemas.tsx";

/**
 * Whether `text` is a single emoji: exactly one `RGI_Emoji` sequence, with its
 * modifiers and joiners, and nothing else.
 */
export const isSingleEmoji = (text: unknown): text is string =>
  typeof text === "string" &&
  // Built here rather than written as a literal: the `v` flag, which
  // `\p{RGI_Emoji}` needs, is newer than the language level patterns compile
  // at, though every runtime that runs them has it.
  new RegExp("^\\p{RGI_Emoji}$", "v").test(text);

/** Where a reply is shown. */
export type ShownIn = "main" | "thread" | "both";

/**
 * A message as the views see it: its identity, its time, and the thread it
 * joins and the message it quotes, by identity.
 */
export interface ViewItem {
  /** The message's identity, unique in the room. */
  key: string;

  /** The message's `sentAt`, which another message can share. */
  sentAt: bigint;

  /**
   * The root of the thread the message joins and the message it quotes, each
   * where it names one, and where the message is shown.
   */
  replyTo?: { thread?: string; quotes?: string; shownIn: ShownIn };
}

/**
 * Whether a message is shown in the main conversation: it replies to nothing,
 * or its reply is shown there.
 */
export const isInMain = (item: ViewItem): boolean =>
  item.replyTo === undefined || item.replyTo.shownIn !== "thread";

/** A message's place in the two views of a conversation. */
export interface ViewPlace {
  /** Whether the message is shown in the main conversation. */
  inMain: boolean;

  /** How many messages the thread it roots holds besides it; 0 for none. */
  replies: number;

  /**
   * The newest `sentAt` among the messages the thread it roots holds besides
   * it; absent when it roots none.
   */
  latestReplyAt?: bigint;

  /**
   * The key of the root of the thread the message is in; absent for a message
   * in no thread.
   */
  thread?: string;
}

/**
 * Every message's place in the views, by the message's key. Each message
 * names the root of the thread it joins, so threads are flat by what is
 * stored, and one pass over the list finds every thread's messages.
 */
export const viewPlaces = (
  items: readonly ViewItem[],
): Record<string, ViewPlace> => {
  const replies = new Map<string, { count: number; latestAt: bigint }>();
  for (const item of items) {
    const root = item.replyTo?.thread;
    if (root === undefined) continue;
    const known = replies.get(root);
    replies.set(root, {
      count: (known?.count ?? 0) + 1,
      latestAt: known === undefined || item.sentAt > known.latestAt
        ? item.sentAt
        : known.latestAt,
    });
  }
  return Object.fromEntries(
    items.map((item): [string, ViewPlace] => {
      const thread = item.replyTo?.thread;
      const own = replies.get(item.key);
      return [item.key, {
        inMain: isInMain(item),
        replies: own?.count ?? 0,
        ...(own === undefined ? {} : { latestReplyAt: own.latestAt }),
        ...(thread === undefined ? {} : { thread }),
      }];
    }),
  );
};

/** The most characters a thread's title has when no member has set one. */
export const THREAD_EXCERPT_LENGTH = 50;

/**
 * A thread's title when no member has set one: the start of its root's text,
 * `text`, as a reader sees it. Each run of whitespace reads as one space, and
 * none leads or trails. Text of at most `THREAD_EXCERPT_LENGTH` characters is
 * the title as it stands; longer text is cut to the words that fit before an
 * ellipsis (`…`) within that length, or, for a first word longer than that,
 * to as much of the word as fits. A character is a Unicode code point, so a
 * cut never splits one.
 */
export const threadExcerpt = (text: string): string => {
  const plain = Array.from(text.replace(/\s+/gu, " ").trim());
  if (plain.length <= THREAD_EXCERPT_LENGTH) return plain.join("");
  // Room for the ellipsis, and whether the text breaks between words right
  // where that room ends.
  const room = plain.slice(0, THREAD_EXCERPT_LENGTH - 1);
  const atBreak = plain[THREAD_EXCERPT_LENGTH - 1] === " ";
  const space = room.lastIndexOf(" ");
  const kept = atBreak || space <= 0 ? room : room.slice(0, space);
  return `${kept.join("").trimEnd()}…`;
};

/**
 * The `requestId` under which an add to the room in `space` asks the adder's
 * manager to offer the room, given the add's own `requestId`, which the offer
 * carries as its `id`. It names the room as well as the add, so adds to two
 * rooms under one `requestId` neither share an outcome in the manager nor
 * replace each other's offer in a share inbox.
 */
export const addMemberOfferId = (space: string, requestId: string): string =>
  JSON.stringify(["addMember", space, requestId]);

/**
 * The `requestId` of the add in the room in `space` that `offerId` offers, as
 * {@link addMemberOfferId} composes it, or `undefined` if it offers no such add.
 */
export const addMemberRequestIdOf = (
  offerId: string,
  space: string | undefined,
): string | undefined => {
  let parts: unknown;
  try {
    parts = JSON.parse(offerId);
  } catch {
    return undefined;
  }
  return Array.isArray(parts) && parts.length === 3 &&
      parts[0] === "addMember" && parts[1] === space &&
      typeof parts[2] === "string"
    ? parts[2]
    : undefined;
};

/**
 * What `report` makes of an add's `outcome`, or `undefined` if the outcome
 * stands. It holds only for an add that is done: `offered` may yet turn to what
 * the manager decides once it has looked where the member's profiles point, and
 * anything else is final, so a report heard twice changes nothing.
 */
export const outcomeOnReport = (
  outcome: AddMemberOutcome | undefined,
  report: AddDeliveryReport,
): AddMemberOutcome | undefined => {
  if (outcome?.status !== "done") return undefined;
  if (outcome.delivery !== undefined && outcome.delivery !== "offered") {
    return undefined;
  }
  if (outcome.delivery === report.delivery) return undefined;
  return {
    status: "done",
    delivery: report.delivery,
    ...(report.deliveryRefusal === undefined
      ? {}
      : { deliveryRefusal: report.deliveryRefusal }),
  };
};

/**
 * `recorded`, each outcome copied, where each add with no `delivery` of its own
 * takes what `read` holds for it. The one document that reads the manager is
 * `read`, so that a label the manager carries holds back only that document.
 */
export const withReadDeliveries = (
  recorded: Readonly<Record<string, AddMemberOutcome>>,
  read: Readonly<Record<string, AddMemberOutcome>> | undefined,
): Record<string, AddMemberOutcome> =>
  Object.fromEntries(
    Object.entries(recorded).map(([id, outcome]) => [
      id,
      outcome === undefined
        ? outcome
        : outcome.status === "done" && outcome.delivery === undefined
        ? { ...(read?.[id] ?? outcome) }
        : { ...outcome },
    ]),
  );
