/**
 * FabriChat's rules that need no runtime: what counts as a single emoji, how
 * the two views of a conversation are derived from replies, where a window
 * falls in a view, and how a thread's title reads when no member has set one. The room applies them to
 * its records; `logic.test.ts` states them directly.
 */

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

/**
 * Which end of its view a window holds: the newest messages, `before: "end"`,
 * or the oldest, `after: "start"`.
 */
export type WindowAnchor = { before: "end" } | { after: "start" };

/** A window's place in its view: indexes into it, and what lies beyond. */
export interface WindowSlice {
  /** The index of the window's first message in the view. */
  start: number;

  /** The index just past the window's last message. */
  end: number;

  /** Whether the view has messages before the window. */
  hasOlder: boolean;

  /** Whether the view has messages after the window. */
  hasNewer: boolean;
}

/**
 * How many messages a window asking for `requested` holds, at most `max`: a
 * request for none, for a negative count, for a count that is not a finite
 * number, or for no count at all holds none, and a fractional count is
 * rounded down.
 */
export const windowCount = (requested: unknown, max: number): number =>
  typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(Math.max(0, Math.floor(requested)), max)
    : 0;

/**
 * Where a window of at most `count` messages, held at the end of its view
 * `anchor` names, falls in a view of `length` messages, oldest first.
 */
export const windowSlice = (
  length: number,
  anchor: WindowAnchor,
  count: number,
): WindowSlice => {
  const size = Math.min(Math.max(0, Math.floor(count)), length);
  const start = "before" in anchor ? length - size : 0;
  const end = start + size;
  return { start, end, hasOlder: start > 0, hasNewer: end < length };
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

/** How many of a principal's last characters tell two same-named people apart. */
export const SAME_NAME_MARK_LENGTH = 6;

/** A person a list of people shows: their principal, and the name they show. */
export interface NamedPerson {
  /** The principal their profile attests. */
  principal: string;

  /** Their profile's name, `undefined` where it has none. */
  name: string | undefined;
}

/**
 * What tells each of `people` apart from another showing the same name, by
 * principal: an ellipsis and the last `SAME_NAME_MARK_LENGTH` characters of
 * their principal where another of `people` shows the same name, and the
 * empty string where none does. Names are the same when they match once each
 * is trimmed and case is ignored. A person showing no name is told apart from
 * no one here, since no name is anyone's name.
 */
export const sameNameMarks = (
  people: readonly NamedPerson[],
): Record<string, string> => {
  const keyOf = (person: NamedPerson): string =>
    (person.name ?? "").trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const person of people) {
    const key = keyOf(person);
    if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    people.map((person): [string, string] => [
      person.principal,
      (counts.get(keyOf(person)) ?? 0) > 1
        ? `…${person.principal.slice(-SAME_NAME_MARK_LENGTH)}`
        : "",
    ]),
  );
};
