/**
 * `FabriChatRoom`: one conversation, an implementation of `ChatRoomOutput`
 * (`docs/specs/fabrichat/FabriChatRoom.md`).
 *
 * Every write goes through one of two handlers. `commitRoom` writes the room's
 * record: its messages, their reactions, its roster, its notices, and its
 * recent activity. `commitWindow` writes the sending session's windows. The
 * runtime admits one writer for a stored record, and the activity log records
 * every kind of act, so each stream that changes the room is a binding of
 * `commitRoom`, bound with the act it performs.
 *
 * A message is a record of its own in the room's messages, labeled
 * `authored-by` whoever last wrote it, and admitted only from the reviewed
 * message surface. Its reactions are a list of their own, which the message
 * links and only the reaction writer writes, so reacting never rewrites the
 * message. Deleting a message drops that link, which takes its reactions out
 * of the room's record.
 *
 * `FabriChatRoomCore` takes the viewer's profile as an input, so a test can
 * supply a stand-in. The default export, `FabriChatRoom`, resolves the real
 * one with `#profile`.
 */
import {
  action,
  AuthoredByCurrentUser,
  type Cell,
  computed,
  type Default,
  entityRefToString,
  equals,
  type FabricEpochNsec,
  getEntityId,
  handler,
  NAME,
  pattern,
  type PerSession,
  Stream,
  type TrustedActionWrite,
  UI,
  VIEWS,
  type VNode,
  wish,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  chooseRecordedTime,
  isInMain,
  isSingleEmoji,
  type ShownIn,
  threadReplyCounts,
  threadRootOf,
  threadView,
  type ViewItem,
  type WindowAnchor,
  windowSlice,
} from "./logic.ts";
import {
  CHAT_MEMBERS_SURFACE,
  CHAT_MESSAGE_ACTION,
  CHAT_MESSAGE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  type ChatDeletedBody,
  type ChatMessageVersion,
  type ChatProfile,
  type ChatReaction,
  type ChatRoomAbout,
  type ChatRoomActivity,
  type ChatRoomKind,
  type ChatRoomNotice,
  type ChatRoomPolicy,
  CLOCK_TICK_NSEC,
  epochNsec,
  epochNsecFromMsec,
  nsecOf,
  type ProfileCell,
  type WindowEvent,
} from "./schemas.tsx";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

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
  proposedTimeMaxAgeNsec: 600n * NSEC_PER_SEC,
  proposedTimeMaxLeadNsec: 10n * NSEC_PER_SEC,
  recentActivityWindowNsec: 600n * NSEC_PER_SEC,
  maxWindowCount: 100,
  maxOpenWindows: 50,
};

/**
 * How long the room remembers a request it acted on: the greater of the
 * proposed-time window's total width and the activity window.
 */
const REQUEST_MEMORY_NSEC = [
  FABRICHAT_POLICY.proposedTimeMaxAgeNsec +
  FABRICHAT_POLICY.proposedTimeMaxLeadNsec,
  FABRICHAT_POLICY.recentActivityWindowNsec,
].reduce((a, b) => (a > b ? a : b));

/** The time bounds `chooseRecordedTime()` holds a proposal to. */
const TIME_BOUNDS = {
  maxAgeNsec: FABRICHAT_POLICY.proposedTimeMaxAgeNsec,
  maxLeadNsec: FABRICHAT_POLICY.proposedTimeMaxLeadNsec,
  tickNsec: CLOCK_TICK_NSEC,
};

/** The emoji a message's reaction picker puts within easy reach. */
export const FABRICHAT_QUICK_REACTIONS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🎉",
] as const;

// ---------------------------------------------------------------------------
// Stored records
// ---------------------------------------------------------------------------

/**
 * A stored reaction: written only by `commitRoom`, from the reviewed
 * reaction surface, and labeled with its reactor.
 */
export type SentReaction = AuthoredByCurrentUser<
  TrustedActionWrite<
    ChatReaction,
    typeof commitRoom,
    typeof CHAT_REACT_ACTION,
    typeof CHAT_REACT_SURFACE
  >
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
 * A stored message: written only by `commitRoom`, from the reviewed message
 * surface, and labeled with whoever wrote its current version.
 */
export type SentMessage = AuthoredByCurrentUser<
  TrustedActionWrite<
    MessageRecord,
    typeof commitRoom,
    typeof CHAT_MESSAGE_ACTION,
    typeof CHAT_MESSAGE_SURFACE
  >
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

/** The requests the room has acted on, each addressed by its key. */
export type RequestsCell = Writable<RequestMemo[] | Default<[]>>;

/** A time the room has recorded something at. */
export interface UsedTime {
  /** The time. */
  at: FabricEpochNsec;
}

/** The times the room has used, each addressed by its nanoseconds. */
export type UsedTimesCell = Writable<UsedTime[] | Default<[]>>;

/**
 * A stored activity entry: a document of its own, written once by
 * `commitRoom`. The runtime labels a value `authored-by` its writer only when
 * a trusted gesture on one named surface made the write, and entries record
 * acts from every surface and from none, so an entry carries no such label.
 */
export type SentActivity = WriteAuthorizedBy<
  ChatRoomActivity,
  typeof commitRoom
>;

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
const NO_ACTIVITY = {
  nextSeq: 1,
  expiredThrough: 0,
} satisfies ActivityCounters;

/** The cell holding the room's activity numbering. */
export type ActivityCountersCell = Writable<
  ActivityCounters | Default<typeof NO_ACTIVITY>
>;

/**
 * The room's roster: members' profiles, as claims. It changes only through
 * `commitRoom`, and `items` is absent until the first profile is shown.
 */
export interface RosterValue {
  /** The profiles, in the order they were shown. */
  items?: WriteAuthorizedBy<ProfileCell[], typeof commitRoom>;
}

/** The cell holding the roster; a room nobody has joined yet holds `{}`. */
export type RosterCell = Writable<
  RosterValue | Default<Record<PropertyKey, never>>
>;

/** The profiles of members who have left. */
export type LeftCell = Writable<ProfileCell[] | Default<[]>>;

/** Notices from `add`, waiting for a client to deliver them. */
export type NoticesCell = Writable<ChatRoomNotice[] | Default<[]>>;

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

/** A session's windows onto the messages. */
export type WindowsCell = Writable<
  ChatMessageWindows | Default<Record<PropertyKey, never>>
>;

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
const SPACE_CHAT_ABOUT = { kind: "group" } as const satisfies AboutRecord;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The entity a cell names, as a string, or `undefined` if it names none. */
const entityKeyOf = (cell: unknown): string | undefined => {
  const ref = getEntityId(cell);
  return ref === undefined ? undefined : entityRefToString(ref);
};

/**
 * The cell `cell` resolves to, if there is one. It comes back inside an object
 * so that an absent cell stays absent: a cell bound to a name directly is
 * given that name, which an absent one can't take.
 */
const resolvedCell = <T,>(
  cell: Cell<T> | undefined,
): { cell?: Cell<T> } =>
  cell === undefined ? {} : { cell: cell.resolveAsCell() };

/** A fresh request id, for an event a rendered control sends without one. */
const freshRequestId = (): string =>
  `ui-${Math.random().toString(36).slice(2)}${
    Math.random().toString(36).slice(2)
  }`;

/** The handler clock's reading, in nanoseconds. */
const clockNsec = (): bigint => nsecOf(epochNsecFromMsec(Date.now()));

/** A request's key: the sender's profile entity, and the request's id. */
const requestKeyOf = (senderKey: string, requestId: string): string =>
  JSON.stringify([senderKey, requestId]);

/** Whether the room has acted on the request `key` and still remembers it. */
const actedOn = (requests: RequestsCell, key: string): boolean =>
  requests.elementById(key).get() !== undefined;

/**
 * Records that the room acted on the request `key`, and forgets every request
 * older than the room's request memory.
 */
const rememberRequest = (
  requests: RequestsCell,
  key: string,
  clock: bigint,
): void => {
  const stale = ((requests.get() ?? []) as RequestMemo[]).filter((memo) =>
    memo !== undefined && nsecOf(memo.at) < clock - REQUEST_MEMORY_NSEC
  );
  stale.forEach((memo) => {
    const entry: Writable<RequestMemo | undefined> = requests.elementById(
      memo.key,
    );
    requests.removeByValue(requests.elementById(memo.key));
    entry.set(undefined);
  });
  const memo = requests.elementById(key);
  memo.set({ key, at: epochNsec(clock) });
  requests.addUnique(memo);
};

/**
 * Chooses a recorded time as `chooseRecordedTime()` does, against the times
 * the room has used, and marks it used. `undefined` means the record is
 * refused.
 */
const claimTime = (
  usedTimes: UsedTimesCell,
  clock: bigint,
  proposed?: bigint,
  after?: bigint,
): FabricEpochNsec | undefined => {
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
  usedTimes.elementById(String(time)).set({ at });
  return at;
};

/**
 * Appends an activity entry, and drops entries older than the activity
 * window. `dropFor` also drops every earlier entry about that message. Each
 * entry is a document of its own, so appending one never rewrites another's.
 */
const appendActivity = (
  activity: ActivityCell,
  counters: ActivityCountersCell,
  usedTimes: UsedTimesCell,
  clock: bigint,
  requestId: string,
  what: Cell<unknown>,
  dropFor?: MessageCell,
): void => {
  const at = claimTime(usedTimes, clock);
  const numbering = counters.get() ?? NO_ACTIVITY;
  const horizon = clock - FABRICHAT_POLICY.recentActivityWindowNsec;
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
  if (at !== undefined) {
    const entry = activity.elementById(String(numbering.nextSeq));
    entry.set({ seq: numbering.nextSeq, at, requestId, what } as SentActivity);
    activity.addUnique(entry);
  }
  counters.set({
    nextSeq: numbering.nextSeq + (at === undefined ? 0 : 1),
    expiredThrough,
  });
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
const messageEntries = (messages: MessagesCell): MessageEntry[] =>
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
const entryFor = (
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
const compareEntries = (a: ViewItem, b: ViewItem): number =>
  a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0;

/** Whether a message is deleted, by its sender or by obliteration. */
const isDeleted = (record: MessageRecord | undefined): boolean =>
  record === undefined || typeof record.body !== "string";

/** Whether `text` is a message body the room accepts. */
const isValidBody = (text: unknown): text is string =>
  typeof text === "string" && text.trim() !== "";

/** The reply-shown-in values the room accepts. */
const SHOWN_IN: readonly ShownIn[] = ["main", "thread", "both"];

/**
 * Whether `sender` is an OWNER as far as the room can tell. The room can't
 * read its space's access list, so it knows only its creator, who holds OWNER.
 */
const isKnownOwner = (
  creatorProfile: ProfileCell | undefined,
  sender: ProfileCell,
): boolean =>
  creatorProfile?.get() !== undefined &&
  equals(creatorProfile.resolveAsCell(), sender);

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

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

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

  /** The DID of the person to add or remove. */
  principal?: string;

  /**
   * The access requested for the person added. A pattern can't grant it: the
   * host that serves the room's space has to.
   */
  access?: "WRITE" | "OWNER";

  /** The id of a notice delivered. */
  id?: string;

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

/** Every act `commitRoom` performs, each bound to one of the room's streams. */
export type RoomAct =
  | "send"
  | "edit"
  | "delete"
  | "obliterate"
  | "react"
  | "unreact"
  | "showProfile"
  | "leave"
  | "add"
  | "remove"
  | "delivered";

/**
 * The room's records, and a rendered control's bindings, as `commitRoom` is
 * bound to them.
 */
export interface RoomActState {
  /** The act this binding performs. */
  act: RoomAct;

  /** The viewer's profile, which holds no value until it resolves. */
  myProfile: ProfileCell | undefined;

  /** The room's kind. */
  kind: ChatRoomKind;

  /** Whether the room lives in a space of its own. */
  ownSpace: boolean;

  /** The room's creator, the one OWNER the room knows. */
  creatorProfile?: ProfileCell;

  /** The room's stored records. */
  messages: MessagesCell;
  reactionLists: ReactionListsCell;
  requests: RequestsCell;
  usedTimes: UsedTimesCell;
  activity: ActivityCell;
  counters: ActivityCountersCell;
  roster: RosterCell;
  left: LeftCell;
  notices: NoticesCell;

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

  /** A rendered control's notice id. */
  id?: string;
}

/**
 * Performs one message act: send, edit, delete, or obliterate. Each act is
 * refused silently when the event breaks the rules `ChatRoomOutput` states for
 * its stream; otherwise it records the change, an activity entry, and the
 * request, all in one transaction.
 */
const performMessageAct = (
  event: RoomStreamEvent,
  state: RoomActState,
): void => {
  const op = state.act;
  const {
    myProfile,
    kind,
    creatorProfile,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    composer,
  } = state;
  const { cell: profile } = resolvedCell(myProfile);
  if (profile?.get() === undefined) return;
  const senderKey = entityKeyOf(profile);
  if (senderKey === undefined) return;
  const requestId = event?.requestId ?? freshRequestId();
  const requestKey = requestKeyOf(senderKey, requestId);
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
    const composing = composer.get();
    const composed = state.replyFrom === "thread"
      ? composing?.thread
      : state.replyFrom === "replyTo"
      ? composing?.replyTo
      : undefined;
    // A cleared link still reads back as a cell, holding nothing.
    const fromComposer = composed?.get() === undefined ? undefined : composed;
    const { cell: replyCell } = resolvedCell(
      event?.replyTo?.message ?? state.message ?? fromComposer,
    );
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
    appendActivity(activity, counters, usedTimes, clock, requestId, record);
    rememberRequest(requests, requestKey, clock);
    if (state.replyFrom === "replyTo" && composing?.replyTo !== undefined) {
      composer.key("replyTo").set(undefined);
    }
    return;
  }

  const { cell: target } = resolvedCell(event?.message ?? state.message);
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
      : FABRICHAT_POLICY.ownersMayObliterate &&
        isKnownOwner(creatorProfile, profile);
    if (!allowed) return;
    if (op === "delete" && isDeleted(current)) return;
    const editedAt = claimTime(usedTimes, clock);
    if (editedAt === undefined) return;
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
      usedTimes,
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
    target.set({
      authorProfile: current.authorProfile,
      body: { deleted: true },
      sentAt: current.sentAt,
      editedAt,
      earlierVersions: kept,
      ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
    } as SentMessage);
    appendActivity(activity, counters, usedTimes, clock, requestId, target);
    rememberRequest(requests, requestKey, clock);
    return;
  }

  if (version === undefined || !isValidBody(version.body)) return;
  const editedAt = claimTime(usedTimes, clock, nsecOf(version.sentAt));
  if (editedAt === undefined) return;
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
  appendActivity(activity, counters, usedTimes, clock, requestId, target);
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
  event: RoomStreamEvent,
  state: RoomActState,
): void => {
  const op = state.act === "react" ? "add" : "remove";
  const { myProfile, messages, requests, usedTimes, activity, counters } =
    state;
  const { cell: profile } = resolvedCell(myProfile);
  if (profile?.get() === undefined) return;
  const senderKey = entityKeyOf(profile);
  if (senderKey === undefined) return;
  const typed = event?.target?.value?.trim();
  const emoji = event?.emoji ?? state.emoji ?? typed;
  if (!isSingleEmoji(emoji)) return;
  const requestId = event?.requestId ?? freshRequestId();
  const requestKey = requestKeyOf(senderKey, requestId);
  if (actedOn(requests, requestKey)) return;
  const { cell: target } = resolvedCell(event?.message ?? state.message);
  const entry = entryFor(messageEntries(messages), target);
  if (target === undefined || entry === undefined) return;
  if (isDeleted(entry.record)) return;
  const list = entry.record.reactions;
  if (list === undefined) return;
  const clock = clockNsec();
  if (state.closesPicker === true) state.pickerOpen?.set(false);
  const reactionKey = JSON.stringify([senderKey, emoji]);
  const mine = list.elementById(reactionKey);
  const present = mine.get() !== undefined;
  if (op === "add" && !present) {
    const sentAt = claimTime(usedTimes, clock);
    if (sentAt === undefined) return;
    mine.set({ reactorProfile: profile, emoji, sentAt } as SentReaction);
    list.addUnique(mine);
    appendActivity(activity, counters, usedTimes, clock, requestId, target);
  }
  if (op === "remove" && present) {
    list.removeByValue(mine);
    // The record outlives its place in the list, and it is the record that
    // says whether the reaction is there, so removing it clears it too.
    const cleared: Writable<SentReaction | undefined> = list.elementById(
      reactionKey,
    );
    cleared.set(undefined);
    appendActivity(activity, counters, usedTimes, clock, requestId, target);
  }
  rememberRequest(requests, requestKey, clock);
};

/** Whether `text` looks like a principal: a DID. */
const isPrincipal = (text: unknown): text is string =>
  typeof text === "string" && /^did:[a-z0-9]+:\S+$/.test(text);

/**
 * Performs one membership act: showing the sender's profile, leaving, adding
 * or removing a member, or reporting a notice delivered.
 *
 * Only a host can change a space's access list, so `leave`, `add`, and
 * `remove` record what a pattern can: the roster, the members who left, the
 * notice, and the activity entry.
 */
const performMembershipAct = (
  event: RoomStreamEvent,
  state: RoomActState,
): void => {
  const op = state.act;
  const {
    myProfile,
    kind,
    ownSpace,
    creatorProfile,
    roster,
    left,
    notices,
    requests,
    usedTimes,
    activity,
    counters,
  } = state;
  const { cell: profile } = resolvedCell(myProfile);
  if (profile?.get() === undefined) return;
  const senderKey = entityKeyOf(profile);
  if (senderKey === undefined) return;
  const requestId = event?.requestId ?? freshRequestId();
  const requestKey = requestKeyOf(senderKey, requestId);
  if (actedOn(requests, requestKey)) return;
  const clock = clockNsec();

  if (op === "showProfile") {
    roster.key("items").addUnique(profile);
    appendActivity(
      activity,
      counters,
      usedTimes,
      clock,
      requestId,
      roster.key("items"),
    );
    rememberRequest(requests, requestKey, clock);
    return;
  }

  if (ownSpace !== true || kind !== "group") return;

  if (op === "leave") {
    roster.key("items").removeByValue(profile);
    left.addUnique(profile);
    appendActivity(
      activity,
      counters,
      usedTimes,
      clock,
      requestId,
      roster.key("items"),
    );
    rememberRequest(requests, requestKey, clock);
    return;
  }

  if (!isKnownOwner(creatorProfile, profile)) return;

  if (op === "delivered") {
    const id = event?.id ?? state.id;
    if (typeof id !== "string") return;
    notices.removeByValue(notices.elementById(id));
    const cleared: Writable<ChatRoomNotice | undefined> = notices.elementById(
      id,
    );
    cleared.set(undefined);
    rememberRequest(requests, requestKey, clock);
    return;
  }

  // A pattern can't revoke access, and a removal that changed nothing would
  // be recorded falsely, so `remove` is refused until a host can apply it.
  if (op === "remove") return;
  const principal = event?.principal ?? event?.target?.value?.trim();
  if (!isPrincipal(principal)) return;
  const access = event?.access ?? "WRITE";
  if (access !== "WRITE" && access !== "OWNER") return;
  // The adding client knows the id without reading it back: the person
  // added, and its own request.
  const id = JSON.stringify([principal, requestId]);
  const notice = notices.elementById(id);
  notice.set({ id, recipient: principal });
  notices.addUnique(notice);
  appendActivity(
    activity,
    counters,
    usedTimes,
    clock,
    requestId,
    roster.key("items"),
  );
  rememberRequest(requests, requestKey, clock);
};

/**
 * The room's one writer: every stream that changes the room's record is a
 * binding of it, with the act it performs. The runtime admits one writer for a
 * stored record, and the activity log records every kind of act, so the writer
 * is one handler; each record still names its own reviewed surface.
 */
export const commitRoom = handler<RoomStreamEvent, RoomActState>(
  (event, state) => {
    const act = state.act;
    if (
      act === "send" || act === "edit" || act === "delete" ||
      act === "obliterate"
    ) {
      performMessageAct(event, state);
    } else if (act === "react" || act === "unreact") {
      performReactionAct(event, state);
    } else {
      performMembershipAct(event, state);
    }
  },
);

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
export const commitWindow = handler<
  RoomWindowEvent,
  {
    op: "open" | "close";
    messages: MessagesCell;
    windows: WindowsCell;
  }
>((event, { op, messages, windows }) => {
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
  const { cell: root } = resolvedCell(request.root);
  const rootEntry = root === undefined ? undefined : entryFor(entries, root);
  if (root !== undefined && rootEntry === undefined) return;
  const view = rootEntry === undefined
    ? entries.filter(isInMain).sort(compareEntries)
    : threadView(entries, rootEntry.key);
  if (view === undefined) return;
  const anchor = anchorOf(request.from);
  if (anchor === undefined) return;
  const count = Math.min(
    Math.max(0, Math.floor(request.count ?? 0)),
    FABRICHAT_POLICY.maxWindowCount,
  );
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
});

// ---------------------------------------------------------------------------
// Derived facts
// ---------------------------------------------------------------------------

/** How one emoji stands on one message. */
export interface ReactionTally {
  /** The emoji. */
  emoji: string;

  /** How many people reacted with it. */
  count: number;

  /** Whether the viewer is one of them. */
  mine: boolean;

  /** Their profiles, in the order they reacted. */
  reactors: ProfileCell[];

  /**
   * An id for the card that lists them, unique on the page, so the count can
   * name the card as its description.
   */
  cardId: string;
}

/**
 * The emoji `reactions` hold, in the order each was first used, each with the
 * profiles that used it. A reaction is the viewer's when its profile is the
 * viewer's profile cell.
 */
export const reactionTallies = (
  reactions: readonly ChatReaction[],
  viewer: ProfileCell | undefined,
  cardIdPrefix: string,
): ReactionTally[] => {
  const ordered = [...reactions]
    .filter((reaction) => reaction?.sentAt !== undefined)
    .sort((a, b) => compareTimes(a.sentAt, b.sentAt));
  const emoji = ordered.reduce<string[]>(
    (found, reaction) =>
      found.includes(reaction.emoji) ? found : [...found, reaction.emoji],
    [],
  );
  return emoji.map((each, index) => {
    const onThis = ordered.filter((reaction) => reaction.emoji === each);
    return {
      emoji: each,
      count: onThis.length,
      mine: viewer !== undefined &&
        onThis.some((reaction) => equals(reaction.reactorProfile, viewer)),
      reactors: onThis.map((reaction) => reaction.reactorProfile),
      cardId: `${cardIdPrefix}-${index}`,
    };
  });
};

/** Earliest first. */
const compareTimes = (a: FabricEpochNsec, b: FabricEpochNsec): number =>
  nsecOf(a) < nsecOf(b) ? -1 : nsecOf(a) > nsecOf(b) ? 1 : 0;

/**
 * The room's participants: the roster, plus every author with no roster
 * entry, in the order each first appears. Two are the same person when their
 * profiles are the same cell.
 */
export const participantsOf = (
  roster: readonly ProfileCell[],
  entries: readonly MessageEntry[],
): ProfileCell[] =>
  [...entries].sort(compareEntries).reduce<ProfileCell[]>(
    (found, entry) => {
      const author = entry.record.authorProfile;
      return author === undefined ||
          found.some((known) => equals(known, author))
        ? found
        : [...found, author];
    },
    [...roster],
  );

/** How a message's body reads, for a quote or a deleted message. */
const bodyText = (record: MessageRecord | undefined): string =>
  record === undefined
    ? ""
    : typeof record.body === "string"
    ? record.body
    : record.authorProfile === undefined
    ? "This message was removed."
    : "This message was deleted.";

// ---------------------------------------------------------------------------
// A message
// ---------------------------------------------------------------------------

/** How a reaction's emoji is drawn. */
const EMOJI_STYLE = { fontSize: "18px", lineHeight: "1" };

/** What a message row needs. */
export interface FabriChatMessageRowInput {
  /** The message. */
  message: MessageCell;

  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /**
   * Whether the row belongs to the open thread's list rather than the main
   * conversation's. Every message has a row in each list, shown only where
   * the message belongs.
   */
  inThread: boolean;

  /** The room's kind. */
  kind: ChatRoomKind;

  /** Whether the room lives in a space of its own. */
  ownSpace: boolean;

  /** The room's creator, the one OWNER the room knows. */
  creatorProfile?: ProfileCell;

  /** The session's composer state. */
  composer: PerSession<ComposerCell>;

  /** The room's stored records. */
  messages: MessagesCell;
  reactionLists: ReactionListsCell;
  requests: RequestsCell;
  usedTimes: UsedTimesCell;
  activity: ActivityCell;
  counters: ActivityCountersCell;
  roster: RosterCell;
  left: LeftCell;
  notices: NoticesCell;
}

/** What a message row provides: its rendering, and its controls' streams. */
export interface FabriChatMessageRowOutput {
  [UI]: VNode;

  /** The message's reactions, tallied by emoji. */
  tallies: ReactionTally[];

  /** Adds the viewer's reaction: `emoji`, or the text typed in. */
  sendReaction: Stream<RoomStreamEvent>;

  /** Removes the viewer's reaction: `emoji`. */
  deleteReaction: Stream<RoomStreamEvent>;

  /** Records a new version of the message, from the text typed in. */
  editMessage: Stream<RoomStreamEvent>;

  /** Deletes the message. */
  deleteMessage: Stream<RoomStreamEvent>;

  /** Obliterates the message. */
  obliterateMessage: Stream<RoomStreamEvent>;

  /** Sends a reply to the message, shown only in its thread. */
  replyInThread: Stream<RoomStreamEvent>;

  /** Sends a reply to the message, shown in its thread and the conversation. */
  replyInBoth: Stream<RoomStreamEvent>;

  /** Sends a reply to the message, shown in the conversation, quoting it. */
  replyInMain: Stream<RoomStreamEvent>;
}

/**
 * One message: its sender, its body, what it replies to, and its reactions,
 * with controls that appear on hover to react, reply, edit, and delete.
 */
export const FabriChatMessageRow = pattern<
  FabriChatMessageRowInput,
  FabriChatMessageRowOutput
>((input) => {
  const {
    message,
    myProfile,
    inThread,
    kind,
    ownSpace,
    creatorProfile,
    composer,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    roster,
    left,
    notices,
  } = input;
  const records = {
    kind,
    ownSpace,
    creatorProfile,
    composer,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    roster,
    left,
    notices,
  };
  const pickerOpen = new Writable.perSession(false);
  const togglePicker = action(() => pickerOpen.set(!pickerOpen.get()));
  const tallies = computed(() => {
    const record = message.get();
    const reactions = (record?.reactions?.get() ?? []) as ChatReaction[];
    const key = entityKeyOf(message.resolveAsCell()) ?? "unsaved";
    return reactionTallies(
      reactions,
      myProfile?.get() === undefined ? undefined : myProfile,
      `fabrichat-reactors-${key}`,
    );
  });
  const cannotWrite = computed(() => myProfile?.get() === undefined);
  const isDeletedNow = computed(() => isDeleted(message.get()));
  const isMine = computed(() => {
    const author = message.get()?.authorProfile;
    return myProfile?.get() !== undefined && author !== undefined &&
      equals(author, myProfile.resolveAsCell());
  });
  const canObliterate = computed(() => {
    const record = message.get();
    if (record?.authorProfile === undefined || myProfile?.get() === undefined) {
      return false;
    }
    const viewer = myProfile.resolveAsCell();
    return kind === "direct"
      ? equals(record.authorProfile, viewer)
      : FABRICHAT_POLICY.ownersMayObliterate &&
        isKnownOwner(creatorProfile, viewer);
  });
  const isEditing = computed(() => {
    const editing = composer.get()?.editing;
    return editing !== undefined && equals(editing, message);
  });
  const text = computed(() => bodyText(message.get()));
  const isEdited = computed(() => {
    const record = message.get();
    return record?.editedAt !== undefined && typeof record.body === "string";
  });
  const quote = computed(() => {
    const reply = message.get()?.replyTo;
    return reply?.shownIn === "main" ? bodyText(reply.message.get()) : "";
  });
  // Where the message belongs: the main conversation, the open thread, or
  // both, and how many replies the thread it roots holds.
  const placement = computed(() => {
    const entries = messageEntries(messages);
    const own = entryFor(entries, message);
    if (own === undefined) {
      return { inMain: false, inOpenThread: false, replies: 0 };
    }
    const openRoot = composer.get()?.thread;
    const root = openRoot?.get() === undefined
      ? undefined
      : entryFor(entries, openRoot);
    const byKey = new Map<string, ViewItem>(
      entries.map((entry) => [entry.key, entry]),
    );
    return {
      inMain: isInMain(own),
      inOpenThread: root !== undefined &&
        (own.key === root.key || threadRootOf(own, byKey) === root.key),
      replies: threadReplyCounts(entries).get(own.key) ?? 0,
    };
  });
  const rowDisplay = computed(() =>
    (inThread ? placement.inOpenThread : placement.inMain) ? "block" : "none"
  );
  const threadLabel = computed(() =>
    placement.replies === 1 ? "1 reply" : `${placement.replies} replies`
  );
  const threadLinkDisplay = computed(() =>
    !inThread && placement.replies > 0 ? "inline-flex" : "none"
  );
  // What differs by viewer or by session is shown or hidden through a prop,
  // never by building a different tree: a branch chosen per viewer is stored
  // once for everyone, and runtimes that chose differently overwrite each
  // other without end.
  const ownDisplay = computed(() =>
    isMine && !isDeletedNow ? "inline-flex" : "none"
  );
  const obliterateDisplay = computed(() =>
    canObliterate ? "inline-flex" : "none"
  );
  const editorDisplay = computed(() => (isEditing ? "block" : "none"));
  const pickerDisplay = computed(() =>
    pickerOpen.get() === true ? "flex" : "none"
  );
  const pickerLabel = computed(() => (pickerOpen.get() === true ? "✕" : "☺+"));
  const startReply = action(() => composer.key("replyTo").set(message));
  const openThread = action(() => composer.key("thread").set(message));
  const startEdit = action(() => composer.key("editing").set(message));
  const stopEdit = action(() => composer.key("editing").set(undefined));

  const sendReaction = commitRoom({
    act: "react",
    myProfile,
    ...records,
    message,
    pickerOpen,
    closesPicker: true,
  });
  const deleteReaction = commitRoom({
    act: "unreact",
    myProfile,
    ...records,
    message,
  });
  const editMessage = commitRoom({
    act: "edit",
    myProfile,
    ...records,
    message,
  });
  const deleteMessage = commitRoom({
    act: "delete",
    myProfile,
    ...records,
    message,
  });
  const obliterateMessage = commitRoom({
    act: "obliterate",
    myProfile,
    ...records,
    message,
  });
  const replyInThread = commitRoom({
    act: "send",
    myProfile,
    ...records,
    message,
    shownIn: "thread",
  });
  const replyInBoth = commitRoom({
    act: "send",
    myProfile,
    ...records,
    message,
    shownIn: "both",
  });
  const replyInMain = commitRoom({
    act: "send",
    myProfile,
    ...records,
    message,
    shownIn: "main",
  });

  return {
    [UI]: (
      <div style={{ display: rowDisplay }}>
        <cf-hover-reveal revealed={pickerOpen}>
          <div
            style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}
          >
            <cf-profile-badge
              variant="circle"
              size="sm"
              $profile={message.key("authorProfile")}
            />
            <cf-vstack gap="1" style={{ flex: "1", minWidth: "0" }}>
              {quote
                ? (
                  <cf-text
                    variant="caption"
                    style={{
                      borderLeft: "3px solid var(--cf-theme-color-border)",
                      paddingLeft: "0.5rem",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {quote}
                  </cf-text>
                )
                : null}
              {isDeletedNow
                ? (
                  <cf-text variant="body" style={{ fontStyle: "italic" }}>
                    {text}
                  </cf-text>
                )
                : (
                  <cf-cfc-authorship
                    $value={message.key("body")}
                    $author={message.key("authorProfile")}
                  >
                    <cf-text
                      variant="body"
                      block
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {text}
                    </cf-text>
                  </cf-cfc-authorship>
                )}
              {isEdited ? <cf-text variant="caption">(edited)</cf-text> : null}
              <div
                data-ui-pattern={CHAT_MESSAGE_SURFACE}
                data-ui-event-integrity={CHAT_MESSAGE_SURFACE}
                style={{ display: editorDisplay }}
              >
                <cf-hstack gap="1" align="center">
                  <cf-submit-input
                    data-ui-action={CHAT_MESSAGE_ACTION}
                    placeholder="Edit message"
                    buttonText="Save"
                    disabled={cannotWrite}
                    onClick={editMessage}
                  />
                  <cf-button size="sm" variant="ghost" onClick={stopEdit}>
                    Cancel
                  </cf-button>
                </cf-hstack>
              </div>
              <div
                data-ui-pattern={CHAT_REACT_SURFACE}
                data-ui-event-integrity={CHAT_REACT_SURFACE}
                style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}
              >
                {tallies.map((tally) => (
                  <cf-hover-card>
                    <cf-button
                      data-ui-action={CHAT_REACT_ACTION}
                      aria-describedby={tally.cardId}
                      size="sm"
                      color="primary"
                      variant={tally.mine ? "outline" : "ghost"}
                      disabled={cannotWrite}
                      onClick={commitRoom({
                        act: "react",
                        myProfile,
                        kind,
                        ownSpace,
                        creatorProfile,
                        composer,
                        messages,
                        reactionLists,
                        requests,
                        usedTimes,
                        activity,
                        counters,
                        roster,
                        left,
                        notices,
                        message,
                        emoji: tally.emoji,
                      })}
                    >
                      <span>
                        <span style={EMOJI_STYLE}>{tally.emoji}</span>{" "}
                        {tally.count}
                      </span>
                    </cf-button>
                    <cf-button
                      data-ui-action={CHAT_REACT_ACTION}
                      size="sm"
                      variant="ghost"
                      aria-label="Remove my reaction"
                      title="Remove my reaction"
                      disabled={cannotWrite}
                      style={{ display: tally.mine ? "inline-flex" : "none" }}
                      onClick={commitRoom({
                        act: "unreact",
                        myProfile,
                        kind,
                        ownSpace,
                        creatorProfile,
                        composer,
                        messages,
                        reactionLists,
                        requests,
                        usedTimes,
                        activity,
                        counters,
                        roster,
                        left,
                        notices,
                        message,
                        emoji: tally.emoji,
                      })}
                    >
                      ✕
                    </cf-button>
                    <cf-vstack id={tally.cardId} slot="card" gap="1">
                      {tally.reactors.map((reactor) => (
                        <cf-profile-badge
                          size="sm"
                          noNavigate
                          $profile={reactor}
                        />
                      ))}
                    </cf-vstack>
                  </cf-hover-card>
                ))}
              </div>
              <cf-button
                size="sm"
                variant="link"
                style={{ display: threadLinkDisplay }}
                onClick={openThread}
              >
                {threadLabel}
              </cf-button>
            </cf-vstack>
          </div>
          <cf-hstack slot="actions" gap="1" align="center">
            <div
              data-ui-pattern={CHAT_REACT_SURFACE}
              data-ui-event-integrity={CHAT_REACT_SURFACE}
              style={{
                display: pickerDisplay,
                gap: "0.25rem",
                alignItems: "center",
              }}
            >
              {FABRICHAT_QUICK_REACTIONS.map((emoji) => (
                <cf-button
                  data-ui-action={CHAT_REACT_ACTION}
                  size="sm"
                  variant="ghost"
                  disabled={cannotWrite}
                  onClick={commitRoom({
                    act: "react",
                    myProfile,
                    kind,
                    ownSpace,
                    creatorProfile,
                    composer,
                    messages,
                    reactionLists,
                    requests,
                    usedTimes,
                    activity,
                    counters,
                    roster,
                    left,
                    notices,
                    message,
                    emoji,
                    pickerOpen,
                    closesPicker: true,
                  })}
                >
                  <span style={EMOJI_STYLE}>{emoji}</span>
                </cf-button>
              ))}
              <cf-submit-input
                data-ui-action={CHAT_REACT_ACTION}
                placeholder="Any emoji"
                buttonText="React"
                disabled={cannotWrite}
                onClick={sendReaction}
              />
            </div>
            {isDeletedNow ? null : (
              <cf-button
                size="sm"
                variant="ghost"
                aria-label="Add reaction"
                title="Add reaction"
                disabled={cannotWrite}
                onClick={togglePicker}
              >
                <span style={EMOJI_STYLE}>{pickerLabel}</span>
              </cf-button>
            )}
            {isDeletedNow || inThread
              ? null
              : (
                <cf-button size="sm" variant="ghost" onClick={startReply}>
                  Reply
                </cf-button>
              )}
            {isDeletedNow || inThread
              ? null
              : (
                <cf-button size="sm" variant="ghost" onClick={openThread}>
                  Thread
                </cf-button>
              )}
            <cf-button
              size="sm"
              variant="ghost"
              style={{ display: ownDisplay }}
              onClick={startEdit}
            >
              Edit
            </cf-button>
            <div
              data-ui-pattern={CHAT_MESSAGE_SURFACE}
              data-ui-event-integrity={CHAT_MESSAGE_SURFACE}
              style={{ display: "flex", gap: "0.25rem" }}
            >
              <cf-button
                data-ui-action={CHAT_MESSAGE_ACTION}
                size="sm"
                variant="ghost"
                style={{ display: ownDisplay }}
                onClick={deleteMessage}
              >
                Delete
              </cf-button>
              <cf-button
                data-ui-action={CHAT_MESSAGE_ACTION}
                size="sm"
                variant="ghost"
                style={{ display: obliterateDisplay }}
                onClick={obliterateMessage}
              >
                Remove entirely
              </cf-button>
            </div>
          </cf-hstack>
        </cf-hover-reveal>
      </div>
    ),
    tallies,
    sendReaction,
    deleteReaction,
    editMessage,
    deleteMessage,
    obliterateMessage,
    replyInThread,
    replyInBoth,
    replyInMain,
  };
});

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/** A room's messages: facts, the newest, and this session's windows. */
export interface ChatMessageList {
  /** How many messages the room holds, obliterated tombstones included. */
  count: number;

  /** The oldest message's `sentAt`; absent while there are none. */
  oldestAt?: FabricEpochNsec;

  /** The newest message's `sentAt`; absent while there are none. */
  newestAt?: FabricEpochNsec;

  /** The newest messages of the main conversation, kept current. */
  latest: {
    /** Up to `maxWindowCount` of them, oldest first. */
    messages: MessageCell[];

    /** Whether the main conversation has older messages than these. */
    hasOlder: boolean;
  };

  /** This session's open windows, by the `windowId` its client chose. */
  windows: PerSession<WindowsCell>;

  /** Opens a window, or moves one already open. */
  openWindow: Stream<RoomWindowEvent>;

  /** Closes a window. */
  closeWindow: Stream<RoomWindowEvent>;
}

/** A room's data face, for hosts that draw it natively. */
export interface ChatRoomView {
  /** What the room says about itself. */
  about: ChatRoomAbout;

  /** What the room recorded recently, in `seq` order. */
  recentActivity: ChatRoomActivity[];

  /** The highest `seq` dropped from `recentActivity` for age; 0 for none. */
  recentActivityExpiredThrough: number;

  /** Members' profiles, as claims. */
  roster: ProfileCell[];

  /** `roster`, plus any author with no roster entry. */
  participants: ProfileCell[];

  /** The room's messages. */
  messages: ChatMessageList;

  /** Whether this reader can send, edit, delete, react, and show a profile. */
  canSend: boolean;

  /** Sends a message. */
  sendMessage: Stream<RoomStreamEvent>;

  /** Records a new version of one of the sender's messages. */
  editMessage: Stream<RoomStreamEvent>;

  /** Records one of the sender's messages as deleted. */
  deleteMessage: Stream<RoomStreamEvent>;

  /** Reduces a message to a tombstone. */
  obliterateMessage: Stream<RoomStreamEvent>;

  /** Adds the sender's reaction to a message. */
  sendReaction: Stream<RoomStreamEvent>;

  /** Removes the sender's reaction to a message. */
  deleteReaction: Stream<RoomStreamEvent>;

  /** Adds the sender's profile to `roster`. */
  showProfile: Stream<RoomStreamEvent>;

  /** Gives up the sender's own access to a group room of its own. */
  leave: Stream<RoomStreamEvent>;

  /** Admits another person to a group room of its own. */
  add: Stream<RoomStreamEvent>;

  /** Removes a person from a group room of its own. */
  remove: Stream<RoomStreamEvent>;

  /** Reports a notice from `add` delivered. */
  delivered: Stream<RoomStreamEvent>;

  /** Notices from `add` that no one has delivered yet. */
  outgoingNotices: ChatRoomNotice[];
}

/** What a room offers everyone its space admits: `ChatRoomOutput`. */
export interface ChatRoomOutput extends ChatRoomView {
  /** The room's name, for lists of pieces. */
  [NAME]: string;

  /** The room's own rendering, with its reviewed surfaces. */
  [UI]: VNode;

  /** The room's data face, as one group. */
  [VIEWS]: { room: ChatRoomView };
}

/** What a room stores, and who is looking at it. */
export interface FabriChatRoomCoreInput {
  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /** What the room says about itself, as its creator wrote it. */
  about: AboutRecord;

  /** Whether the room lives in a space of its own. */
  ownSpace: boolean;

  /** The room's creator, whom the room knows as its OWNER. */
  creatorProfile?: ProfileCell;

  messages: MessagesCell;
  reactionLists: ReactionListsCell;
  requests: RequestsCell;
  usedTimes: UsedTimesCell;
  activity: ActivityCell;
  counters: ActivityCountersCell;
  roster: RosterCell;
  left: LeftCell;
  notices: NoticesCell;
}

/**
 * What the room's core offers: `ChatRoomOutput`, and the streams its own
 * composers send to, which take the reply they compose from the session's
 * composer state.
 */
export interface FabriChatRoomCoreOutput extends ChatRoomOutput {
  /** The main composer's send, replying to the reply being composed. */
  composerSend: Stream<RoomStreamEvent>;

  /** The thread composer's send, replying in the open thread. */
  threadComposerSend: Stream<RoomStreamEvent>;
}

/**
 * A conversation with a composer that sends as the viewer: the whole of
 * `ChatRoomOutput`, given the viewer's profile.
 */
export const FabriChatRoomCore = pattern<
  FabriChatRoomCoreInput,
  FabriChatRoomCoreOutput
>((input) => {
  const {
    myProfile,
    about,
    ownSpace,
    creatorProfile,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    roster,
    left,
    notices,
  } = input;
  const composer = new Writable.perSession<ComposerState>({});
  const kind = computed((): ChatRoomKind => about?.kind ?? "group");
  const records = {
    kind,
    ownSpace,
    creatorProfile,
    composer,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    roster,
    left,
    notices,
  };
  const alsoToMain = new Writable.perSession(false);
  const windows = new Writable.perSession<ChatMessageWindows>({});

  const entries = computed(() => messageEntries(messages));
  const mainEntries = computed(() =>
    entries.filter(isInMain).sort(compareEntries)
  );
  const latest = computed(() => ({
    messages: mainEntries.slice(-FABRICHAT_POLICY.maxWindowCount).map((
      entry,
    ) => entry.cell),
    hasOlder: mainEntries.length > FABRICHAT_POLICY.maxWindowCount,
  }));
  const count = computed(() => entries.length);
  const sortedEntries = computed(() => [...entries].sort(compareEntries));
  const oldestAt = computed(() => sortedEntries[0]?.record.sentAt);
  const newestAt = computed(() =>
    sortedEntries[sortedEntries.length - 1]?.record.sentAt
  );
  const rosterItems = computed(
    () => [...((roster.get() as RosterValue | undefined)?.items ?? [])],
  );
  const participants = computed(() => participantsOf(rosterItems, entries));
  const canSend = computed(() => myProfile?.get() !== undefined);
  const cannotSend = computed(() => myProfile?.get() === undefined);
  // The policy is a document of its own, which `about` links.
  const policy = new Writable.perSpace<ChatRoomPolicy>(FABRICHAT_POLICY);
  const aboutView = {
    kind,
    title: computed(() => about?.title),
    createdAt: computed(() => about?.createdAt),
    policy,
  };
  const expiredThrough = computed(() =>
    (counters.get() ?? NO_ACTIVITY).expiredThrough
  );
  const groupOfItsOwn = computed(() => ownSpace === true && kind === "group");
  const viewerIsOwner = computed(() =>
    myProfile?.get() !== undefined &&
    isKnownOwner(creatorProfile, myProfile.resolveAsCell())
  );
  const title = computed(() =>
    about?.title ?? (kind === "direct" ? "Direct chat" : "Chat")
  );
  const hasThread = computed(() => {
    const root = composer.get()?.thread;
    return root?.get() !== undefined && entryFor(entries, root) !== undefined;
  });
  const replyingTo = computed(() => bodyText(composer.get()?.replyTo?.get()));
  // Per-session and per-viewer parts are hidden by a prop, never built as a
  // different tree (see `FabriChatMessageRow`).
  const replyDisplay = computed(() => (replyingTo ? "flex" : "none"));
  const threadDisplay = computed(() => (hasThread ? "flex" : "none"));
  const ownerDisplay = computed(() => (viewerIsOwner ? "block" : "none"));
  const isEmpty = computed(() => mainEntries.length === 0);
  const threadShownIn = computed((): ShownIn =>
    alsoToMain.get() ? "both" : "thread"
  );
  const noticeList = computed(
    () => [...((notices.get() ?? []) as ChatRoomNotice[])],
  );

  const sendMessage = commitRoom({ act: "send", myProfile, ...records });
  const composeSend = commitRoom({
    act: "send",
    myProfile,
    ...records,
    replyFrom: "replyTo",
  });
  const sendThreadReply = commitRoom({
    act: "send",
    myProfile,
    ...records,
    replyFrom: "thread",
    shownIn: threadShownIn,
  });
  const streams = {
    sendMessage,
    editMessage: commitRoom({
      act: "edit",
      myProfile,
      ...records,
    }),
    deleteMessage: commitRoom({
      act: "delete",
      myProfile,
      ...records,
    }),
    obliterateMessage: commitRoom({
      act: "obliterate",
      myProfile,
      ...records,
    }),
    sendReaction: commitRoom({
      act: "react",
      myProfile,
      ...records,
    }),
    deleteReaction: commitRoom({
      act: "unreact",
      myProfile,
      ...records,
    }),
    showProfile: commitRoom({
      act: "showProfile",
      myProfile,
      ...records,
    }),
    leave: commitRoom({
      act: "leave",
      myProfile,
      ...records,
    }),
    add: commitRoom({
      act: "add",
      myProfile,
      ...records,
    }),
    remove: commitRoom({
      act: "remove",
      myProfile,
      ...records,
    }),
    delivered: commitRoom({
      act: "delivered",
      myProfile,
      ...records,
    }),
  };
  const messageList = {
    count,
    oldestAt,
    newestAt,
    latest,
    windows,
    openWindow: commitWindow({ op: "open", messages, windows }),
    closeWindow: commitWindow({ op: "close", messages, windows }),
  };
  const view = {
    about: aboutView,
    recentActivity: activity,
    recentActivityExpiredThrough: expiredThrough,
    roster: rosterItems,
    participants,
    messages: messageList,
    canSend,
    outgoingNotices: noticeList,
    ...streams,
  };
  const closeThread = action(() => composer.key("thread").set(undefined));
  const cancelReply = action(() => composer.key("replyTo").set(undefined));

  return {
    [NAME]: title,
    [UI]: (
      <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "720px" }}>
        <cf-hstack justify="between" align="center" gap="4">
          <cf-heading level={3}>{title}</cf-heading>
          <cf-profile-badge $profile={myProfile} size="sm" />
        </cf-hstack>

        {
          /* A plain flex row, not `cf-hstack`, whose host clips overflow
            and would cut off the badges' verified glow. */
        }
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {participants.map((participant) => (
            <cf-profile-badge variant="chip" $profile={participant} />
          ))}
          <cf-button
            size="sm"
            variant="ghost"
            disabled={cannotSend}
            onClick={streams.showProfile}
          >
            Show me as a member
          </cf-button>
        </div>

        <cf-vstack
          id="fabrichat-messages"
          gap="3"
          style={{ minHeight: "160px" }}
        >
          {messages.map((message) => (
            <FabriChatMessageRow
              message={message}
              inThread={false}
              myProfile={myProfile}
              kind={kind}
              ownSpace={ownSpace}
              creatorProfile={creatorProfile}
              composer={composer}
              messages={messages}
              reactionLists={reactionLists}
              requests={requests}
              usedTimes={usedTimes}
              activity={activity}
              counters={counters}
              roster={roster}
              left={left}
              notices={notices}
            />
          ))}
          {isEmpty
            ? <cf-empty-state message="No messages yet. Say hello!" />
            : null}
        </cf-vstack>

        <cf-hstack gap="2" align="center" style={{ display: replyDisplay }}>
          <cf-text variant="caption">Replying to: {replyingTo}</cf-text>
          <cf-button size="sm" variant="ghost" onClick={cancelReply}>
            Cancel
          </cf-button>
        </cf-hstack>
        <div
          data-ui-pattern={CHAT_MESSAGE_SURFACE}
          data-ui-event-integrity={CHAT_MESSAGE_SURFACE}
        >
          <cf-submit-input
            data-ui-action={CHAT_MESSAGE_ACTION}
            inputId="fabrichat-message"
            placeholder="Message"
            buttonText="Send"
            disabled={cannotSend}
            onClick={composeSend}
          />
        </div>

        <cf-vstack
          id="fabrichat-thread"
          gap="2"
          style={{
            display: threadDisplay,
            borderTop: "1px solid var(--cf-theme-color-border)",
            paddingTop: "0.75rem",
          }}
        >
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>Thread</cf-heading>
            <cf-button size="sm" variant="ghost" onClick={closeThread}>
              Close
            </cf-button>
          </cf-hstack>
          {messages.map((message) => (
            <FabriChatMessageRow
              message={message}
              inThread
              myProfile={myProfile}
              kind={kind}
              ownSpace={ownSpace}
              creatorProfile={creatorProfile}
              composer={composer}
              messages={messages}
              reactionLists={reactionLists}
              requests={requests}
              usedTimes={usedTimes}
              activity={activity}
              counters={counters}
              roster={roster}
              left={left}
              notices={notices}
            />
          ))}
          <cf-checkbox $checked={alsoToMain}>
            Also send to the conversation
          </cf-checkbox>
          <div
            data-ui-pattern={CHAT_MESSAGE_SURFACE}
            data-ui-event-integrity={CHAT_MESSAGE_SURFACE}
          >
            <cf-submit-input
              data-ui-action={CHAT_MESSAGE_ACTION}
              inputId="fabrichat-thread-message"
              placeholder="Reply in thread"
              buttonText="Reply"
              disabled={cannotSend}
              onClick={sendThreadReply}
            />
          </div>
        </cf-vstack>

        {groupOfItsOwn
          ? (
            <cf-vstack
              id="fabrichat-members"
              gap="2"
              style={{
                borderTop: "1px solid var(--cf-theme-color-border)",
                paddingTop: "0.75rem",
              }}
            >
              <cf-heading level={4}>Members</cf-heading>
              <div
                data-ui-pattern={CHAT_MEMBERS_SURFACE}
                data-ui-event-integrity={CHAT_MEMBERS_SURFACE}
                style={{ display: ownerDisplay }}
              >
                <cf-vstack gap="2">
                  <cf-submit-input
                    placeholder="did:key:… to add"
                    buttonText="Add"
                    onClick={streams.add}
                  />
                  <cf-submit-input
                    placeholder="did:key:… to remove"
                    buttonText="Remove"
                    onClick={streams.remove}
                  />
                </cf-vstack>
              </div>
              {noticeList.map((notice) => (
                <cf-hstack gap="2" align="center">
                  <cf-text variant="caption">
                    Tell {notice.recipient} about this room
                  </cf-text>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={commitRoom({
                      act: "delivered",
                      myProfile,
                      kind,
                      ownSpace,
                      creatorProfile,
                      composer,
                      messages,
                      reactionLists,
                      requests,
                      usedTimes,
                      activity,
                      counters,
                      roster,
                      left,
                      notices,
                      id: notice.id,
                    })}
                  >
                    Done
                  </cf-button>
                </cf-hstack>
              ))}
              <cf-button
                size="sm"
                variant="ghost"
                disabled={cannotSend}
                onClick={streams.leave}
              >
                Leave this room
              </cf-button>
            </cf-vstack>
          )
          : null}
      </cf-vstack>
    ),
    [VIEWS]: { room: view },
    ...view,
    composerSend: composeSend,
    threadComposerSend: sendThreadReply,
  };
});

/** What a room stores. Every field has a default, for a space's own chat. */
export interface FabriChatRoomInput {
  /**
   * What the room says about itself, written once by whoever creates it. A
   * space's own chat is a group room with no title.
   */
  about?: AboutRecord | Default<typeof SPACE_CHAT_ABOUT>;

  /** Whether the room lives in a space of its own. */
  ownSpace?: boolean | Default<false>;

  /** The room's creator, whom the room knows as its OWNER. */
  creatorProfile?: ProfileCell;

  messages?: MessagesCell;
  reactionLists?: ReactionListsCell;
  requests?: RequestsCell;
  usedTimes?: UsedTimesCell;
  activity?: ActivityCell;
  counters?: ActivityCountersCell;
  roster?: RosterCell;
  left?: LeftCell;
  notices?: NoticesCell;
}

/**
 * A FabriChat room whose viewer is the person looking at it: the
 * `ChatRoomOutput` its space's members share. A viewer with no profile can
 * read the conversation, and is offered the form that creates one.
 */
const FabriChatRoom = pattern<FabriChatRoomInput, ChatRoomOutput>(
  (input) => {
    const profileWish = wish<ChatProfile>({ query: "#profile" });
    // Hidden by a prop rather than a branch, as `FabriChatMessageRow` says.
    const setupDisplay = computed(() =>
      profileWish.result === undefined ? "block" : "none"
    );
    const room = FabriChatRoomCore(
      {
        myProfile: profileWish.result,
        about: input.about,
        ownSpace: input.ownSpace,
        creatorProfile: input.creatorProfile,
        messages: input.messages,
        reactionLists: input.reactionLists,
        requests: input.requests,
        usedTimes: input.usedTimes,
        activity: input.activity,
        counters: input.counters,
        roster: input.roster,
        left: input.left,
        notices: input.notices,
      } as Parameters<typeof FabriChatRoomCore>[0],
    );

    return {
      [NAME]: room[NAME],
      [VIEWS]: room[VIEWS],
      about: room.about,
      recentActivity: room.recentActivity,
      recentActivityExpiredThrough: room.recentActivityExpiredThrough,
      roster: room.roster,
      participants: room.participants,
      messages: room.messages,
      canSend: room.canSend,
      sendMessage: room.sendMessage,
      editMessage: room.editMessage,
      deleteMessage: room.deleteMessage,
      obliterateMessage: room.obliterateMessage,
      sendReaction: room.sendReaction,
      deleteReaction: room.deleteReaction,
      showProfile: room.showProfile,
      leave: room.leave,
      add: room.add,
      remove: room.remove,
      delivered: room.delivered,
      outgoingNotices: room.outgoingNotices,
      [UI]: (
        <cf-screen>
          {room[UI]}
          <div
            id="fabrichat-profile-setup"
            style={{
              display: setupDisplay,
              padding: "0 1rem 1rem",
              maxWidth: "720px",
            }}
          >
            {profileWish[UI]}
          </div>
        </cf-screen>
      ),
    };
  },
);

export default FabriChatRoom;
