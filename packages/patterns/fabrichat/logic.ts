/**
 * FabriChat's rules that need no runtime: how a room chooses a recorded time,
 * what counts as a single emoji, how the two views of a conversation are
 * derived from replies, and where a window of messages falls in a view. The
 * room applies them to its records; `logic.test.ts` states them directly.
 */

/**
 * The bounds a room holds a proposed time to, and the resolution of its clock,
 * all in nanoseconds.
 */
export interface TimeBounds {
  /** How far before the clock a proposed time is accepted. */
  maxAgeNsec: bigint;

  /** How far after the clock a proposed time is accepted. */
  maxLeadNsec: bigint;

  /** How much time one reading of the clock stands for. */
  tickNsec: bigint;
}

/** What a room knows when it chooses the time to record something at. */
export interface TimeChoice {
  /** The sender's proposed time; absent when the record takes the clock. */
  proposed?: bigint;

  /** The handler clock's reading. */
  clock: bigint;

  /** The earliest time allowed, exclusive: a reply's target's `sentAt`. */
  after?: bigint;

  /** Whether the room has already recorded something at a time. */
  isUsed: (time: bigint) => boolean;
}

/**
 * The end of the tick `time` falls in, exclusive: the first time a bump for
 * uniqueness may not reach.
 */
const tickEnd = (time: bigint, tickNsec: bigint): bigint =>
  time - (((time % tickNsec) + tickNsec) % tickNsec) + tickNsec;

/**
 * The time a room records something at, or `undefined` when it refuses to.
 *
 * A proposal more than `maxAgeNsec` before the clock, or more than
 * `maxLeadNsec` after it, is refused. One within those bounds is recorded as
 * proposed, except that one after the clock is recorded at the clock, since a
 * room never records a time later than its own. A reply's time is then raised,
 * if need be, past its target's. Last, a time already used is replaced by the
 * smallest later one that isn't, within the tick of the clock reading or of
 * the raised time, whichever ends later. A tick with no time left is refused,
 * and a later tick takes the record.
 */
export const chooseRecordedTime = (
  choice: TimeChoice,
  bounds: TimeBounds,
): bigint | undefined => {
  const { proposed, clock, after, isUsed } = choice;
  if (proposed !== undefined) {
    if (proposed < clock - bounds.maxAgeNsec) return undefined;
    if (proposed > clock + bounds.maxLeadNsec) return undefined;
  }
  const asProposed = proposed === undefined || proposed > clock
    ? clock
    : proposed;
  const base = after !== undefined && asProposed <= after
    ? after + 1n
    : asProposed;
  const limit = [
    tickEnd(clock, bounds.tickNsec),
    tickEnd(base, bounds.tickNsec),
  ]
    .reduce((a, b) => (a > b ? a : b));
  for (let time = base; time < limit; time++) {
    if (!isUsed(time)) return time;
  }
  return undefined;
};

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

  /** The message's `sentAt`, unique in the room. */
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
 * The key of the thread a message is in, by its root, or `undefined` for a
 * message in no thread. Threads are flat: a reply to a message already in a
 * thread joins that thread.
 */
export const threadRootOf = (
  item: ViewItem,
  byKey: ReadonlyMap<string, ViewItem>,
): string | undefined => {
  const reply = item.replyTo;
  if (reply === undefined || reply.shownIn === "main") return undefined;
  const target = byKey.get(reply.key);
  const targetRoot = target === undefined
    ? undefined
    : threadRootOf(target, byKey);
  return targetRoot ?? reply.key;
};

/** `items`, oldest first. */
export const bySentAt = <T extends ViewItem>(items: readonly T[]): T[] =>
  [...items].sort((
    a,
    b,
  ) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0));

/** Every message in the main conversation, oldest first. */
export const mainView = <T extends ViewItem>(items: readonly T[]): T[] =>
  bySentAt(items.filter(isInMain));

/**
 * The thread rooted at `rootKey`, oldest first, root included; or `undefined`
 * when `rootKey` names no message that can root a thread.
 */
export const threadView = <T extends ViewItem>(
  items: readonly T[],
  rootKey: string,
): T[] | undefined => {
  const byKey = new Map<string, ViewItem>(
    items.map((item) => [item.key, item]),
  );
  const root = byKey.get(rootKey);
  if (root === undefined || threadRootOf(root, byKey) !== undefined) {
    return undefined;
  }
  if (!isInMain(root)) return undefined;
  return bySentAt(
    items.filter((item) =>
      item.key === rootKey || threadRootOf(item, byKey) === rootKey
    ),
  );
};

/** How many messages each thread holds besides its root, by root key. */
export const threadReplyCounts = (
  items: readonly ViewItem[],
): Map<string, number> => {
  const byKey = new Map<string, ViewItem>(
    items.map((item) => [item.key, item]),
  );
  return items.reduce((counts, item) => {
    const root = threadRootOf(item, byKey);
    if (root !== undefined) counts.set(root, (counts.get(root) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
};

/** Where a window sits in its view. */
export type WindowAnchor =
  | { before: bigint | "end" }
  | { after: bigint | "start" }
  | { around: bigint };

/** A window's place in its view: indexes into the view, and what lies beyond. */
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
 * Where a window of at most `count` messages falls in `view`, placed as
 * `anchor` says; or `undefined` for an `around` anchor that names no message
 * in the view. `view` is oldest first.
 */
export const windowSlice = (
  view: readonly ViewItem[],
  anchor: WindowAnchor,
  count: number,
): WindowSlice | undefined => {
  const size = Math.max(0, Math.floor(count));
  const span = (start: number, end: number): WindowSlice => ({
    start,
    end,
    hasOlder: start > 0,
    hasNewer: end < view.length,
  });
  if ("before" in anchor) {
    const before = anchor.before;
    const end = before === "end"
      ? view.length
      : view.filter((item) => item.sentAt < before).length;
    return span(Math.max(0, end - size), end);
  }
  if ("after" in anchor) {
    const after = anchor.after;
    const start = after === "start"
      ? 0
      : view.filter((item) => item.sentAt <= after).length;
    return span(start, Math.min(view.length, start + size));
  }
  const at = view.findIndex((item) => item.sentAt === anchor.around);
  if (at < 0) return undefined;
  const half = Math.floor((size - 1) / 2);
  const start = Math.max(0, Math.min(at - half, view.length - size));
  return span(start, Math.min(view.length, start + size));
};
