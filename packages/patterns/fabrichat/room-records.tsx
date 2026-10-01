/**
 * What a FabriChat room stores, the policy its handlers apply, and those
 * handlers (`docs/specs/fabrichat/FabriChatRoom.md`). The records and their
 * writers are one module because each record's write policy names the
 * handlers that may write it.
 *
 * Every stream that changes the room's record has a handler of its own, as
 * `FabriChatRoom.md` names them. `commitWindow` writes the sending session's
 * windows.
 *
 * A message is a record of its own in the room's messages, labeled
 * `authored-by` whoever last wrote it, and admitted only from the reviewed
 * surface of the act that wrote it. Its reactions are a list of their own,
 * which the message links, so reacting never rewrites the message. The
 * reaction handlers add to and remove from that list, and a deletion or an
 * obliteration clears it and drops the link.
 */
import {
  AuthoredByCurrentUser,
  type Cell,
  currentPrincipal,
  type Default,
  entityRefToString,
  equals,
  eventKey,
  type FabricEpochNsec,
  getEntityId,
  handler,
  spaceAccess,
  type TrustedActionWrite,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import {
  chooseRecordedTime,
  isInMain,
  isSingleEmoji,
  type ShownIn,
  threadView,
  type ViewItem,
  type WindowAnchor,
  windowCount,
  windowSlice,
} from "./logic.ts";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_EDIT_ACTION,
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_UNREACT_ACTION,
  type ChatDeletedBody,
  type ChatMessageVersion,
  type ChatReaction,
  type ChatRoomActivity,
  type ChatRoomKind,
  type ChatRoomPolicy,
  CLOCK_TICK_NSEC,
  durationNsec,
  epochNsec,
  epochNsecFromMsec,
  nsecOf,
  type ProfileCell,
  type WindowEvent,
} from "./schemas.tsx";

//
// Policy
//

/** Nanoseconds in one second. */
const NSEC_PER_SEC = 1_000_000_000n;

/**
 * Every room's policy. Each setting is read by the handlers it governs, and
 * `about.policy` states it, so the two cannot disagree.
 */
export const FABRICHAT_POLICY: ChatRoomPolicy = {
  ownersMayObliterate: true,
  keepsHistory: true,
  deletionIsObliteration: false,
  proposedTimeMaxAgeNsec: durationNsec(600n * NSEC_PER_SEC),
  proposedTimeMaxLeadNsec: durationNsec(10n * NSEC_PER_SEC),
  recentActivityWindowNsec: durationNsec(600n * NSEC_PER_SEC),
  maxWindowCount: 100,
  maxOpenWindows: 50,
};

/**
 * How long the room remembers a request it acted on: the greater of the
 * proposed-time window's total width and the activity window.
 */
const REQUEST_MEMORY_NSEC = [
  FABRICHAT_POLICY.proposedTimeMaxAgeNsec.value +
  FABRICHAT_POLICY.proposedTimeMaxLeadNsec.value,
  FABRICHAT_POLICY.recentActivityWindowNsec.value,
].reduce((a, b) => (a > b ? a : b));

/** The time bounds `chooseRecordedTime()` holds a proposal to. */
const TIME_BOUNDS = {
  maxAgeNsec: FABRICHAT_POLICY.proposedTimeMaxAgeNsec.value,
  maxLeadNsec: FABRICHAT_POLICY.proposedTimeMaxLeadNsec.value,
  tickNsec: CLOCK_TICK_NSEC,
};

//
// Stored records
//

/**
 * A stored reaction: written by the reaction handlers, each from the reviewed
 * reaction surface with its own action, and labeled with its reactor; and
 * cleared by a deletion or an obliteration, from that act's own surface.
 */
export type SentReaction = AuthoredByCurrentUser<
  WritePolicyAnyOf<ChatReaction, [
    TrustedActionWrite<
      unknown,
      typeof commitSendReaction,
      typeof CHAT_REACT_ACTION,
      typeof CHAT_REACT_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDeleteReaction,
      typeof CHAT_UNREACT_ACTION,
      typeof CHAT_REACT_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDelete,
      typeof CHAT_DELETE_ACTION,
      typeof CHAT_DELETE_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitObliterate,
      typeof CHAT_OBLITERATE_ACTION,
      typeof CHAT_OBLITERATE_SURFACE
    >,
  ]>
>;

/** One message's reactions, in no particular order. */
export type ReactionList = SentReaction[] | Default<[]>;

/** Every message's reaction list, each addressed by its message's key. */
export type ReactionListsCell = Writable<ReactionList[] | Default<[]>>;

/** A stored reply: which message, and where the reply is shown. */
export interface StoredReply {
  /** The message replied to, in the same room. */
  message: Cell<MessageRecord>;

  /** Where the reply is shown. */
  shownIn: ShownIn;
}

/**
 * What the room stores for a message: a `ChatMessage` whose reactions are a
 * link to a list of their own, absent once the message is deleted.
 */
export interface MessageRecord {
  /** The profile the sender sent under; absent once obliterated. */
  authorProfile?: ProfileCell;

  /** The current text, or the marker of a deleted message. */
  body: string | ChatDeletedBody;

  /** When the room recorded the message's first version. */
  sentAt: FabricEpochNsec;

  /** When the room recorded the current version, if it isn't the first. */
  editedAt?: FabricEpochNsec;

  /** The versions before the current one, oldest first. */
  earlierVersions: ChatMessageVersion[];

  /** What this message replies to, and where it is shown. */
  replyTo?: StoredReply;

  /** The message's reactions; absent once the message is deleted. */
  reactions?: Writable<ReactionList>;
}

/**
 * A stored message: written only by the four message handlers, each from its
 * own reviewed surface, and labeled with whoever wrote its current version.
 */
export type SentMessage = AuthoredByCurrentUser<
  WritePolicyAnyOf<MessageRecord, [
    TrustedActionWrite<
      unknown,
      typeof commitSend,
      typeof CHAT_SEND_ACTION,
      typeof CHAT_SEND_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitEdit,
      typeof CHAT_EDIT_ACTION,
      typeof CHAT_EDIT_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitDelete,
      typeof CHAT_DELETE_ACTION,
      typeof CHAT_DELETE_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitObliterate,
      typeof CHAT_OBLITERATE_ACTION,
      typeof CHAT_OBLITERATE_SURFACE
    >,
  ]>
>;

/** The room's messages, in the order they were recorded. */
export type MessagesValue = SentMessage[] | Default<[]>;

/** The cell holding the room's messages. */
export type MessagesCell = Writable<MessagesValue>;

/** A link to one stored message. */
export type MessageCell = Cell<MessageRecord>;

/** A request the room has acted on, remembered until it expires. */
export interface RequestMemo {
  /** The request's key: its sender and its `requestId`. */
  key: string;

  /** When the room acted on it. */
  at: FabricEpochNsec;
}

/**
 * A remembered request, written by whichever handler acted on it. The tuple
 * is written out here, as `WritePolicyAnyOf` requires.
 */
export type StoredRequestMemo = WritePolicyAnyOf<RequestMemo, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
]>;

/** The requests the room has acted on, each addressed by its key. */
export type RequestsCell = Writable<StoredRequestMemo[] | Default<[]>>;

/** A time the room has recorded something at. */
export interface UsedTime {
  /** The time. */
  at: FabricEpochNsec;
}

/** A used time, written by whichever handler recorded something at it. */
export type StoredUsedTime = WritePolicyAnyOf<UsedTime, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
]>;

/** The times the room has used, each addressed by its nanoseconds. */
export type UsedTimesCell = Writable<StoredUsedTime[] | Default<[]>>;

/**
 * A stored activity entry: a document of its own, written once by the handler
 * whose act it records. Entries record acts from every surface and from none,
 * so an entry carries no `authored-by` label, which needs a reviewed gesture
 * from every writer.
 */
export type SentActivity = WritePolicyAnyOf<ChatRoomActivity, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
]>;

/** The room's recent activity, in `seq` order. */
export type ActivityCell = Writable<SentActivity[] | Default<[]>>;

/** Where the room's activity numbering stands. */
export interface ActivityCounters {
  /** The `seq` the next entry takes. */
  nextSeq: number;

  /** The highest `seq` dropped for age; 0 for none. */
  expiredThrough: number;
}

/** The empty activity numbering. */
export const NO_ACTIVITY = {
  nextSeq: 1,
  expiredThrough: 0,
} satisfies ActivityCounters;

/** The activity numbering, written by whichever handler records an entry. */
export type StoredActivityCounters = WritePolicyAnyOf<ActivityCounters, [
  WriteAuthorizedBy<unknown, typeof commitSend>,
  WriteAuthorizedBy<unknown, typeof commitEdit>,
  WriteAuthorizedBy<unknown, typeof commitDelete>,
  WriteAuthorizedBy<unknown, typeof commitObliterate>,
  WriteAuthorizedBy<unknown, typeof commitSendReaction>,
  WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
]>;

/**
 * The room's activity numbering, kept as one keyed record, `NUMBERING_KEY`,
 * absent until the first entry. The list around it defaults to empty, so
 * nothing but the handlers its policy lists ever writes the record.
 */
export type ActivityCountersCell = Writable<
  StoredActivityCounters[] | Default<[]>
>;

/** The key of the activity numbering's one record. */
export const NUMBERING_KEY = "numbering";

/** A run of consecutive messages from one view of a conversation. */
export interface ChatMessageWindow {
  /** The `openWindow` request that set the window as it is now. */
  requestId: string;

  /** For a thread's window, the thread's root; absent for the main one. */
  root?: MessageCell;

  /** The messages in the window, oldest first. */
  messages: MessageCell[];

  /** Whether the view has messages older than the window's first. */
  hasOlder: boolean;

  /** Whether the view has messages newer than the window's last. */
  hasNewer: boolean;
}

/** A session's open windows, by the `windowId` its client chose. */
export type ChatMessageWindows = Record<string, ChatMessageWindow>;

/** A session's windows onto the messages, written only by `commitWindow`. */
export type WindowsValue = WriteAuthorizedBy<
  ChatMessageWindows,
  typeof commitWindow
>;

/**
 * The cell holding a session's windows, absent until the first opens: only
 * `commitWindow` writes it, so it has no default for anything else to write.
 */
export type WindowsCell = Writable<WindowsValue>;

/** What a room says about itself, as its creator wrote it. */
export interface AboutRecord {
  /** How the room was created. */
  kind: ChatRoomKind;

  /** A group room's title. */
  title?: string;

  /** When the room was created. */
  createdAt?: FabricEpochNsec;
}

/** A space's own chat: a group room with no title. */
export const SPACE_CHAT_ABOUT = {
  kind: "group",
} as const satisfies AboutRecord;

//
// Helpers
//

/** The entity a cell names, as a string, or `undefined` if it names none. */
export const entityKeyOf = (cell: unknown): string | undefined => {
  const ref = getEntityId(cell);
  return ref === undefined ? undefined : entityRefToString(ref);
};

/** The handler clock's reading, in nanoseconds. */
const clockNsec = (): bigint => nsecOf(epochNsecFromMsec(Date.now()));

/** A request's key: its sender's principal, and its id. */
const requestKeyOf = (sender: string, requestId: string): string =>
  JSON.stringify([sender, requestId]);

/** Whether the room has acted on the request `key` and still remembers it. */
const actedOn = (requests: RequestsCell, key: string): boolean =>
  requests.elementById(key).get() !== undefined;

/**
 * Removes every record recorded before `horizon` from `list`, a list of keyed
 * records, and clears each one: a keyed record outlives its place in the list,
 * and it is the record a lookup by key finds.
 */
const forgetBefore = <T extends { at: FabricEpochNsec }>(
  list: Writable<T[]>,
  keyOf: (record: T) => string,
  horizon: bigint,
): void => {
  ((list.get() ?? []) as T[])
    .filter((record) => record !== undefined && nsecOf(record.at) < horizon)
    .forEach((record) => {
      const key = keyOf(record);
      list.removeByValue(list.elementById(key));
      const cleared: Writable<T | undefined> = list.elementById(key);
      cleared.set(undefined);
    });
};

/**
 * Records that the room acted on the request `key`, and forgets every request
 * older than the room's request memory.
 */
const rememberRequest = (
  requests: RequestsCell,
  key: string,
  clock: bigint,
): void => {
  forgetBefore(requests, (memo) => memo.key, clock - REQUEST_MEMORY_NSEC);
  const memo = requests.elementById(key);
  memo.set({ key, at: epochNsec(clock) });
  requests.addUnique(memo);
};

/**
 * Chooses a recorded time as `chooseRecordedTime()` does, against the times
 * the room has used, and marks it used. `undefined` means the record is
 * refused.
 *
 * It also forgets every used time older than the request memory. A recorded
 * time is never older than the proposed-time window's lower bound, so no
 * runtime whose clock is within the window's lead of this one chooses a time
 * that old again.
 */
const claimTime = (
  usedTimes: UsedTimesCell,
  clock: bigint,
  proposed?: bigint,
  after?: bigint,
): FabricEpochNsec | undefined => {
  forgetBefore(
    usedTimes,
    (used) => String(nsecOf(used.at)),
    clock - REQUEST_MEMORY_NSEC,
  );
  const time = chooseRecordedTime(
    {
      proposed,
      clock,
      after,
      isUsed: (t) => usedTimes.elementById(String(t)).get() !== undefined,
    },
    TIME_BOUNDS,
  );
  if (time === undefined) return undefined;
  const at = epochNsec(time);
  const used = usedTimes.elementById(String(time));
  used.set({ at } as StoredUsedTime);
  usedTimes.addUnique(used);
  return at;
};

/**
 * Appends an activity entry recorded at `at`, and drops entries older than the
 * activity window. `dropFor` also drops every earlier entry about that
 * message. Each entry is a document of its own, so appending one never
 * rewrites another's. The act claims `at` before it writes anything, so an
 * act with no time left for its entry is refused rather than recorded without
 * one.
 */
const appendActivity = (
  activity: ActivityCell,
  counters: ActivityCountersCell,
  at: FabricEpochNsec,
  clock: bigint,
  requestId: string,
  what: Cell<unknown>,
  dropFor?: MessageCell,
): void => {
  const record = counters.elementById(NUMBERING_KEY);
  const numbering = (record.get() ?? NO_ACTIVITY) as ActivityCounters;
  const horizon = clock - FABRICHAT_POLICY.recentActivityWindowNsec.value;
  const current = (activity.get() ?? []) as ChatRoomActivity[];
  const expired = current.filter((entry) => nsecOf(entry.at) < horizon);
  const expiredThrough = expired.reduce(
    (highest, entry) => Math.max(highest, entry.seq),
    numbering.expiredThrough,
  );
  const dropped = current.filter((entry) =>
    nsecOf(entry.at) < horizon ||
    (dropFor !== undefined && equals(entry.what, dropFor))
  );
  dropped.forEach((entry) => {
    const key = String(entry.seq);
    activity.removeByValue(activity.elementById(key));
    const cleared: Writable<SentActivity | undefined> = activity.elementById(
      key,
    );
    cleared.set(undefined);
  });
  const entry = activity.elementById(String(numbering.nextSeq));
  entry.set({ seq: numbering.nextSeq, at, requestId, what } as SentActivity);
  activity.addUnique(entry);
  record.set({
    nextSeq: numbering.nextSeq + 1,
    expiredThrough,
  } as StoredActivityCounters);
  counters.addUnique(record);
};

/** A stored message as the views see it, keyed by its `sentAt`. */
export interface MessageEntry extends ViewItem {
  /** A link to the stored message. */
  cell: MessageCell;

  /** The stored message. */
  record: MessageRecord;
}

/** The key a message has in the views: its `sentAt`, unique in the room. */
const timeKeyOf = (time: FabricEpochNsec): string => String(nsecOf(time));

/** A link to the stored message at `index` of `messages`. */
const cellAt = (messages: MessagesCell, index: number): MessageCell => {
  const cell: MessageCell = messages.key(index);
  return cell;
};

/** Every stored message of `messages`, as a view item. */
export const messageEntries = (messages: MessagesCell): MessageEntry[] =>
  ((messages.get() ?? []) as MessageRecord[]).flatMap((record, index) => {
    if (record?.sentAt === undefined) return [];
    const target = record.replyTo?.message?.get();
    return [{
      key: timeKeyOf(record.sentAt),
      sentAt: nsecOf(record.sentAt),
      ...(record.replyTo === undefined || target?.sentAt === undefined ? {} : {
        replyTo: {
          key: timeKeyOf(target.sentAt),
          shownIn: record.replyTo.shownIn,
        },
      }),
      cell: cellAt(messages, index),
      record,
    }];
  });

/** The entry for the stored message `message` links, if it is in the room. */
export const entryFor = (
  entries: readonly MessageEntry[],
  message: MessageCell | undefined,
): MessageEntry | undefined => {
  const target = message?.get();
  if (target?.sentAt === undefined) return undefined;
  const key = timeKeyOf(target.sentAt);
  return entries.find((entry) =>
    entry.key === key && equals(entry.cell, message)
  );
};

/** Oldest first, by `sentAt`. */
export const compareEntries = (a: ViewItem, b: ViewItem): number =>
  a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0;

/** Whether a message is deleted, by its sender or by obliteration. */
export const isDeleted = (record: MessageRecord | undefined): boolean =>
  record === undefined || typeof record.body !== "string";

/** Whether `text` is a message body the room accepts. */
const isValidBody = (text: unknown): text is string =>
  typeof text === "string" && text.trim() !== "";

/** The reply-shown-in values the room accepts. */
const SHOWN_IN: readonly ShownIn[] = ["main", "thread", "both"];

/**
 * Whether the principal this code runs for holds OWNER in the room's space,
 * which `cell` lives in: the event's actor in a handler, the viewer in a
 * computation (see `spaceAccess()`).
 */
export const isOwnerOf = (cell: Cell<unknown>): boolean =>
  spaceAccess(cell) === "OWNER";

/**
 * Whether the viewer can send, edit, delete, and react in the room whose
 * messages are `messages`: their profile resolves, and the room's space grants
 * them WRITE or OWNER. A level not known yet (`undefined`) is not a grant.
 */
export const canActIn = (
  messages: MessagesCell,
  myProfile: ProfileCell | undefined,
): boolean => {
  const level = spaceAccess(messages);
  return myProfile?.get() !== undefined &&
    (level === "WRITE" || level === "OWNER");
};

/** A `ChatWindowAnchor` as `windowSlice()` takes it, if it is well formed. */
const anchorOf = (
  from: WindowEvent["from"] | undefined,
): WindowAnchor | undefined => {
  if (from === undefined || from === null) return undefined;
  if ("before" in from) {
    return { before: from.before === "end" ? "end" : nsecOf(from.before) };
  }
  if ("after" in from) {
    return { after: from.after === "start" ? "start" : nsecOf(from.after) };
  }
  if ("around" in from) return { around: nsecOf(from.around) };
  return undefined;
};

//
// Writers
//

/**
 * An event on one of the room's streams. Each stream's event carries the
 * fields its act needs. A rendered control sends the text it holds as
 * `target.value`, and no request id, which the room then mints.
 */
export interface RoomStreamEvent {
  /** Chosen by the sender, and unique among its requests. */
  requestId?: string;

  /** The version to send or record. */
  version?: ChatMessageVersion;

  /** What a sent message replies to. */
  replyTo?: StoredReply;

  /** The message acted on. */
  message?: MessageCell;

  /** A single emoji. */
  emoji?: string;

  /** A rendered control's text. */
  readonly target?: { readonly value?: string };
}

/** Where a rendered composer keeps the reply and the edit it is composing. */
export interface ComposerState {
  /** The message the next send replies to in the main conversation. */
  replyTo?: MessageCell;

  /** The message being edited. */
  editing?: MessageCell;

  /** The thread shown beside the conversation, by its root. */
  thread?: MessageCell;
}

/** The cell holding a session's composer state. */
export type ComposerCell = Writable<
  ComposerState | Default<Record<PropertyKey, never>>
>;

/** The acts on a message, each performed by a handler of its own. */
type MessageAct = "send" | "edit" | "delete" | "obliterate";

/**
 * The room's records, and a rendered control's bindings, as every handler
 * that changes the room is bound to them.
 */
export interface RoomActState {
  /** The viewer's profile, which holds no value until it resolves. */
  myProfile: ProfileCell | undefined;

  /** The room's kind. */
  kind: ChatRoomKind;

  /** The room's messages. */
  messages: MessagesCell;

  /** Every message's reaction list. */
  reactionLists: ReactionListsCell;

  /** The requests the room has acted on. */
  requests: RequestsCell;

  /** The times the room has recorded something at. */
  usedTimes: UsedTimesCell;

  /** The room's recent activity. */
  activity: ActivityCell;

  /** Where the activity's numbering stands. */
  counters: ActivityCountersCell;

  /** A rendered control's message: the one acted on, or replied to. */
  message?: MessageCell;

  /** Where a rendered control's reply is shown. */
  shownIn?: ShownIn;

  /**
   * The session's composer state. Every binding passes it: an optional cell
   * left unbound would read back as a handle into the binding itself.
   */
  composer: ComposerCell;

  /**
   * For a rendered composer's send, which reply it takes from the composer:
   * the main reply, or the open thread. Other sends take none from it.
   */
  replyFrom?: "replyTo" | "thread";

  /** A rendered control's emoji. */
  emoji?: string;

  /** A rendered reaction picker's open state, closed by a reaction. */
  pickerOpen?: Writable<boolean>;

  /** Whether this binding closes `pickerOpen`, which only a picker binds. */
  closesPicker?: boolean;
}

/**
 * Performs one message act: send, edit, delete, or obliterate. Each act is
 * refused silently when the event breaks the rules `ChatRoomOutput` states for
 * its stream; otherwise it records the change, an activity entry, and the
 * request, all in one transaction.
 */
const performMessageAct = (
  op: MessageAct,
  event: RoomStreamEvent,
  state: RoomActState,
): void => {
  const {
    myProfile,
    kind,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    composer,
  } = state;
  const profile = myProfile?.resolveAsCell();
  if (profile?.get() === undefined) return;
  const sender = currentPrincipal();
  if (sender === undefined) return;
  const requestId = event?.requestId ?? eventKey();
  const requestKey = requestKeyOf(sender, requestId);
  if (actedOn(requests, requestKey)) return;
  const clock = clockNsec();
  const entries = messageEntries(messages);
  const typed = event?.target?.value;
  const version: ChatMessageVersion | undefined = event?.version ??
    (typeof typed === "string"
      ? { body: typed.trim(), sentAt: epochNsec(clock) }
      : undefined);

  if (op === "send") {
    if (version === undefined || !isValidBody(version.body)) return;
    // A send arriving again after its memo has expired finds the message it
    // made, and changes nothing.
    if (messages.elementById(requestKey).get() !== undefined) {
      rememberRequest(requests, requestKey, clock);
      return;
    }
    const composing = composer.get();
    const composed = state.replyFrom === "thread"
      ? composing?.thread
      : state.replyFrom === "replyTo"
      ? composing?.replyTo
      : undefined;
    // A cleared link still reads back as a cell, holding nothing.
    const fromComposer = composed?.get() === undefined ? undefined : composed;
    const replyCell = (event?.replyTo?.message ?? state.message ?? fromComposer)
      ?.resolveAsCell();
    const shownIn = event?.replyTo?.shownIn ?? state.shownIn ?? "main";
    const target = replyCell === undefined
      ? undefined
      : entryFor(entries, replyCell);
    if (replyCell !== undefined) {
      if (target === undefined || isDeleted(target.record)) return;
      if (!SHOWN_IN.includes(shownIn)) return;
      if (shownIn === "main" && !isInMain(target)) return;
    }
    const sentAt = claimTime(
      usedTimes,
      clock,
      nsecOf(version.sentAt),
      target?.sentAt,
    );
    if (sentAt === undefined) return;
    const loggedAt = claimTime(usedTimes, clock);
    if (loggedAt === undefined) return;
    // The message and its reactions are addressed by the request that sent
    // it, which names one message in every session.
    const record = messages.elementById(requestKey);
    // A message may link only a list that exists, so the list is written
    // before the message links it.
    const reactions = reactionLists.elementById(requestKey);
    reactions.set([]);
    record.set({
      authorProfile: profile,
      body: version.body,
      sentAt,
      earlierVersions: [],
      ...(replyCell === undefined
        ? {}
        : { replyTo: { message: replyCell, shownIn } }),
      reactions,
    } as SentMessage);
    messages.addUnique(record);
    appendActivity(activity, counters, loggedAt, clock, requestId, record);
    rememberRequest(requests, requestKey, clock);
    if (state.replyFrom === "replyTo" && composing?.replyTo !== undefined) {
      composer.key("replyTo").set(undefined);
    }
    return;
  }

  const target = (event?.message ?? state.message)?.resolveAsCell();
  const entry = entryFor(entries, target);
  if (target === undefined || entry === undefined) return;
  const current = entry.record;
  const isAuthor = current.authorProfile !== undefined &&
    equals(current.authorProfile, profile);
  const deletionObliterates = op === "delete" &&
    FABRICHAT_POLICY.deletionIsObliteration;

  if (op === "obliterate" || deletionObliterates) {
    if (current.authorProfile === undefined) return;
    const allowed = op === "delete" || kind === "direct"
      ? isAuthor
      : FABRICHAT_POLICY.ownersMayObliterate && isOwnerOf(messages);
    if (!allowed) return;
    if (op === "delete" && isDeleted(current)) return;
    const editedAt = claimTime(usedTimes, clock);
    if (editedAt === undefined) return;
    const loggedAt = claimTime(usedTimes, clock);
    if (loggedAt === undefined) return;
    current.reactions?.set([]);
    target.set({
      body: { deleted: true },
      sentAt: current.sentAt,
      editedAt,
      earlierVersions: [],
      ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
    } as SentMessage);
    appendActivity(
      activity,
      counters,
      loggedAt,
      clock,
      requestId,
      target,
      target,
    );
    rememberRequest(requests, requestKey, clock);
    return;
  }

  if (!isAuthor || isDeleted(current)) return;
  const kept: ChatMessageVersion[] = FABRICHAT_POLICY.keepsHistory
    ? [...(current.earlierVersions ?? []), {
      body: current.body as string,
      sentAt: current.editedAt ?? current.sentAt,
    }]
    : [];

  if (op === "delete") {
    const editedAt = claimTime(usedTimes, clock);
    if (editedAt === undefined) return;
    const loggedAt = claimTime(usedTimes, clock);
    if (loggedAt === undefined) return;
    current.reactions?.set([]);
    target.set({
      authorProfile: current.authorProfile,
      body: { deleted: true },
      sentAt: current.sentAt,
      editedAt,
      earlierVersions: kept,
      ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
    } as SentMessage);
    appendActivity(activity, counters, loggedAt, clock, requestId, target);
    rememberRequest(requests, requestKey, clock);
    return;
  }

  if (version === undefined || !isValidBody(version.body)) return;
  const editedAt = claimTime(usedTimes, clock, nsecOf(version.sentAt));
  if (editedAt === undefined) return;
  const loggedAt = claimTime(usedTimes, clock);
  if (loggedAt === undefined) return;
  target.set({
    authorProfile: current.authorProfile,
    body: version.body,
    sentAt: current.sentAt,
    editedAt,
    earlierVersions: kept,
    ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
    ...(current.reactions === undefined
      ? {}
      : { reactions: current.reactions }),
  } as SentMessage);
  appendActivity(activity, counters, loggedAt, clock, requestId, target);
  rememberRequest(requests, requestKey, clock);
  const editing = composer.get()?.editing;
  if (editing !== undefined && equals(editing, target)) {
    composer.key("editing").set(undefined);
  }
};

/**
 * Adds or removes the sender's reaction to a message. Adding one already
 * there, or removing one that isn't, changes nothing. A reaction is kept at an
 * address within its message's list derived from its reactor and its emoji,
 * so one person's one reaction has a single address in every session.
 */
const performReactionAct = (
  op: "add" | "remove",
  event: RoomStreamEvent,
  state: RoomActState,
): void => {
  const { myProfile, messages, requests, usedTimes, activity, counters } =
    state;
  const profile = myProfile?.resolveAsCell();
  if (profile?.get() === undefined) return;
  const sender = currentPrincipal();
  if (sender === undefined) return;
  // A reaction's address derives from its reactor's profile.
  const reactorKey = entityKeyOf(profile);
  if (reactorKey === undefined) return;
  const typed = event?.target?.value?.trim();
  const emoji = event?.emoji ?? state.emoji ?? typed;
  if (!isSingleEmoji(emoji)) return;
  const requestId = event?.requestId ?? eventKey();
  const requestKey = requestKeyOf(sender, requestId);
  if (actedOn(requests, requestKey)) return;
  const target = (event?.message ?? state.message)?.resolveAsCell();
  const entry = entryFor(messageEntries(messages), target);
  if (target === undefined || entry === undefined) return;
  if (isDeleted(entry.record)) return;
  const list = entry.record.reactions;
  if (list === undefined) return;
  const clock = clockNsec();
  if (state.closesPicker === true) state.pickerOpen?.set(false);
  const reactionKey = JSON.stringify([reactorKey, emoji]);
  const mine = list.elementById(reactionKey);
  const present = mine.get() !== undefined;
  if (op === "add" && !present) {
    const sentAt = claimTime(usedTimes, clock);
    if (sentAt === undefined) return;
    const loggedAt = claimTime(usedTimes, clock);
    if (loggedAt === undefined) return;
    mine.set({ reactorProfile: profile, emoji, sentAt } as SentReaction);
    list.addUnique(mine);
    appendActivity(activity, counters, loggedAt, clock, requestId, target);
  }
  if (op === "remove" && present) {
    const loggedAt = claimTime(usedTimes, clock);
    if (loggedAt === undefined) return;
    list.removeByValue(mine);
    // The record outlives its place in the list, and it is the record that
    // says whether the reaction is there, so removing it clears it too.
    const cleared: Writable<SentReaction | undefined> = list.elementById(
      reactionKey,
    );
    cleared.set(undefined);
    appendActivity(activity, counters, loggedAt, clock, requestId, target);
  }
  rememberRequest(requests, requestKey, clock);
};

/** Sends a message, from `ChatSendSurface`. */
export const commitSend = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("send", event, state),
);

/** Edits the sender's message, from `ChatEditSurface`. */
export const commitEdit = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("edit", event, state),
);

/** Deletes the sender's message, from `ChatDeleteSurface`. */
export const commitDelete = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("delete", event, state),
);

/** Obliterates a message, from `ChatObliterateSurface`. */
export const commitObliterate = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("obliterate", event, state),
);

/** Adds the sender's reaction, from `ChatReactSurface`. */
export const commitSendReaction = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performReactionAct("add", event, state),
);

/** Removes the sender's reaction, from `ChatReactSurface`. */
export const commitDeleteReaction = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performReactionAct("remove", event, state),
);

/** What `commitWindow` is bound to. */
export interface WindowActState {
  /** Whether the binding opens (or moves) a window, or closes one. */
  op: "open" | "close";

  /** The room's messages. */
  messages: MessagesCell;

  /** The session's windows. */
  windows: WindowsCell;
}

/** A window request, whose thread root is one of the room's messages. */
export interface RoomWindowEvent extends Omit<WindowEvent, "root"> {
  /** The root of the thread to show; absent for the main conversation. */
  root?: MessageCell;
}

/**
 * Opens, moves, or closes one of the sending session's windows onto the
 * messages. It changes nothing but that session's windows, so it keeps no
 * request memory: repeating a request sets or removes the same window again.
 */
export const commitWindow = handler<RoomWindowEvent, WindowActState>(
  (event, { op, messages, windows }) => {
    const windowId = event?.windowId;
    if (typeof windowId !== "string" || windowId === "") return;
    const current = (windows.get() ?? {}) as ChatMessageWindows;
    if (op === "close") {
      if (!(windowId in current)) return;
      windows.set(
        Object.fromEntries(
          Object.entries(current).filter(([id]) => id !== windowId),
        ),
      );
      return;
    }
    const request = event;
    if (
      !(windowId in current) &&
      Object.keys(current).length >= FABRICHAT_POLICY.maxOpenWindows
    ) {
      return;
    }
    const entries = messageEntries(messages);
    const root = request.root?.resolveAsCell();
    const rootEntry = root === undefined ? undefined : entryFor(entries, root);
    if (root !== undefined && rootEntry === undefined) return;
    const view = rootEntry === undefined
      ? entries.filter(isInMain).sort(compareEntries)
      : threadView(entries, rootEntry.key);
    if (view === undefined) return;
    const anchor = anchorOf(request.from);
    if (anchor === undefined) return;
    const count = windowCount(request.count, FABRICHAT_POLICY.maxWindowCount);
    const slice = windowSlice(view, anchor, count);
    if (slice === undefined) return;
    windows.key(windowId).set({
      requestId: request.requestId,
      ...(root === undefined ? {} : { root }),
      messages: view.slice(slice.start, slice.end).map((entry) =>
        entry.cell.resolveAsCell()
      ),
      hasOlder: slice.hasOlder,
      hasNewer: slice.hasNewer,
    });
  },
);
