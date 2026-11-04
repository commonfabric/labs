/**
 * FabriChat's rules that need no runtime: what counts as a single emoji, and
 * how the two views of a conversation are derived from replies. The room
 * applies them to its records; `logic.test.ts` states them directly.
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
 * A message as the views see it: its identity, its time, and what it replies
 * to, by identity.
 */
export interface ViewItem {
  /** The message's identity, unique in the room. */
  key: string;

  /** The message's `sentAt`, which another message can share. */
  sentAt: bigint;

  /** The message this one replies to, and where it is shown. */
  replyTo?: { key: string; shownIn: ShownIn };
}

/**
 * Whether a message is shown in the main conversation: it replies to nothing,
 * or its reply is shown there.
 */
export const isInMain = (item: ViewItem): boolean =>
  item.replyTo === undefined || item.replyTo.shownIn !== "thread";

/**
 * Each message's thread root, by the message's key, for every message in a
 * thread. Threads are flat: a reply to a message already in a thread joins
 * that thread. Each reply chain is walked once, iteratively, so a long chain
 * costs its length and no stack: a message whose target's root is known takes
 * it, one whose target is in no thread takes the target, and a chain that
 * returns to a message it has already visited stops there.
 */
export const threadRoots = (
  items: readonly ViewItem[],
): Map<string, string> => {
  const byKey = new Map<string, ViewItem>(
    items.map((item) => [item.key, item]),
  );
  const roots = new Map<string, string>();
  for (const item of items) {
    const chain: string[] = [];
    const inChain = new Set<string>();
    let current: ViewItem | undefined = item;
    let root: string | undefined;
    while (current !== undefined) {
      const known = roots.get(current.key);
      if (known !== undefined) {
        root = known;
        break;
      }
      const reply: ViewItem["replyTo"] = current.replyTo;
      if (reply === undefined || reply.shownIn === "main") {
        // In no thread: it roots the chain that led here, if any did.
        root = chain.length === 0 ? undefined : current.key;
        break;
      }
      if (inChain.has(current.key)) {
        root = reply.key;
        break;
      }
      inChain.add(current.key);
      chain.push(current.key);
      current = byKey.get(reply.key);
      if (current === undefined) root = reply.key;
    }
    if (root !== undefined) {
      for (const key of chain) roots.set(key, root);
    }
  }
  return roots;
};

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
 * Every message's place in the views, by the message's key. The reply chains
 * are walked once for the whole list, as `threadRoots()` walks them.
 */
export const viewPlaces = (
  items: readonly ViewItem[],
): Record<string, ViewPlace> => {
  const roots = threadRoots(items);
  const replies = new Map<string, { count: number; latestAt: bigint }>();
  for (const item of items) {
    const root = roots.get(item.key);
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
      const thread = roots.get(item.key);
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
