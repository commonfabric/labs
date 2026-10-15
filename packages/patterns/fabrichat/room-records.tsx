/**
 * What a FabriChat room stores, the policy its handlers apply, and those
 * handlers (`docs/specs/fabrichat/FabriChatRoom.md`). The records and their
 * writers are one module because each record's write policy names the
 * handlers that may write it.
 *
 * Every stream that changes the room's record has a handler of its own, as
 * `FabriChatRoom.md` names them. `commitWindow` writes the sending session's
 * windows, and `commitSetTitle` the title a member last set, a record of its
 * own beside the one the room's creator wrote.
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
  principalOf,
  spaceAccess,
  type Stream,
  type TrustedActionWrite,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import { isSharedSpaceCatalog } from "../system/shared-space-catalog.ts";
import {
  chooseRecordedTime,
  isInMain,
  isSingleEmoji,
  type ShownIn,
  threadView,
  type ViewItem,
} from "./logic.ts";
import type { commitStart } from "./manager.tsx";
import { CHAT_POLICY } from "./records.ts";
import {
  type AboutRecord,
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_EDIT_ACTION,
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  CHAT_ROOM_OFFER_KIND,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  CHAT_UNREACT_ACTION,
  type ChatContainer,
  type ChatDeletedBody,
  type ChatMessageVersion,
  type ChatReaction,
  type ChatRoomActivity,
  type ChatRoomKind,
  type ChatRoomLink,
  type ChatRoomPolicy,
  CLOCK_TICK_NSEC,
  epochNsec,
  epochNsecFromMsec,
  type MessageActOutcome,
  type MessageActRefusalCode,
  nsecOf,
  type ProfileCell,
  type SetTitleOutcome,
  type SetTitleRefusalCode,
  type TitleRecord,
  type WindowEvent,
} from "./schemas.tsx";
import { selectWindow } from "./window.ts";

//
// Policy
//

/** The policy every room starts from; ownership overrides are room-specific. */
export const FABRICHAT_POLICY = CHAT_POLICY;

/**
 * The `ownersMayObliterate` a room of `kind` states in its policy, which
 * decides which policy document `about.policy` links: `given`, where the room
 * is configured, and otherwise yes for a group room and no for a direct room.
 * What the room enforces is what that document states
 * (`ownersMayObliterateBy()`).
 */
export const ownersMayObliterateIn = (
  kind: ChatRoomKind,
  given?: boolean,
): boolean => given ?? kind !== "direct";

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

  /** Whether the room has permanently removed the author and history. */
  obliterated?: true;

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

/** A request the room has acted on, retained for the room's lifetime. */
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
 * whose act it records, and labeled `authored-by` the principal that handler
 * acts for. Its writers name no gesture, since entries record acts from every
 * surface; the label says whose act it was, not that they made a gesture.
 */
export type SentActivity = AuthoredByCurrentUser<
  WritePolicyAnyOf<ChatRoomActivity, [
    WriteAuthorizedBy<unknown, typeof commitSend>,
    WriteAuthorizedBy<unknown, typeof commitEdit>,
    WriteAuthorizedBy<unknown, typeof commitDelete>,
    WriteAuthorizedBy<unknown, typeof commitObliterate>,
    WriteAuthorizedBy<unknown, typeof commitSendReaction>,
    WriteAuthorizedBy<unknown, typeof commitDeleteReaction>,
  ]>
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

/**
 * What a room created by a manager says about itself: written once, by the
 * manager's `commitStart` as it creates the room, from a reviewed `ChatStart`
 * on `ChatStartSurface`, and labeled `authored-by` the room's creator, which
 * `principalOf(about, "authored-by")` reads. It has no default, which
 * something other than its writer would write.
 */
export type StoredAbout = AuthoredByCurrentUser<
  TrustedActionWrite<
    AboutRecord,
    typeof commitStart,
    typeof CHAT_START_ACTION,
    typeof CHAT_START_SURFACE
  >
>;

/**
 * A room's title as a member last set it: written only by `commitSetTitle`,
 * from a reviewed `ChatRetitle` on `ChatRetitleSurface`, and labeled
 * `authored-by` that member. The creator's `about` record keeps the title the
 * room was created with, and its own label.
 */
export type StoredTitle = AuthoredByCurrentUser<
  TrustedActionWrite<
    TitleRecord,
    typeof commitSetTitle,
    typeof CHAT_RETITLE_ACTION,
    typeof CHAT_RETITLE_SURFACE
  >
>;

/**
 * The room's title as a member last set it, kept as one keyed record,
 * `TITLE_KEY`, absent until a member sets one. The list around it defaults to
 * empty, so nothing but `commitSetTitle` ever writes the record.
 */
export type TitlesCell = Writable<StoredTitle[] | Default<[]>>;

/** The key of the one record of the title a member set. */
export const TITLE_KEY = "title";

/**
 * The outcome of each of a sender's retitles, by its `requestId`: one
 * instance per user, which no one else reads.
 */
export type TitleRequestsCell = Writable<
  Record<string, SetTitleOutcome> | Default<Record<PropertyKey, never>>
>;

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

/** Whether the room has acted on the request `key`. */
const actedOn = (requests: RequestsCell, key: string): boolean =>
  requests.elementById(key).get() !== undefined;

/**
 * Records that the room acted on the request `key`. Requests remain remembered
 * for the room's lifetime because event redelivery has no finite upper bound.
 */
const rememberRequest = (
  requests: RequestsCell,
  key: string,
  clock: bigint,
): void => {
  const memo = requests.elementById(key);
  memo.set({ key, at: epochNsec(clock) });
  requests.addUnique(memo);
};

/**
 * Chooses a recorded time as `chooseRecordedTime()` does, against the times
 * the room has used, and marks it used. `undefined` means the record is
 * refused.
 * Reservations survive message removal and later events, including events
 * whose handler clock is older than the room's latest event.
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

/**
 * The key a message has in the views: its `sentAt`, unique in the room. It
 * starts with a letter, so that a record keyed by it has no key that reads as
 * an array index.
 */
const timeKeyOf = (time: FabricEpochNsec): string => `t${nsecOf(time)}`;

/**
 * The key the stored message `message` links has in the views, or `undefined`
 * while it links none. It reads the message's `sentAt` and nothing else of
 * it.
 */
export const viewKeyOf = (message: MessageCell): string | undefined => {
  const sentAt = message.key("sentAt").get();
  return sentAt === undefined ? undefined : timeKeyOf(sentAt);
};

/** A link to the stored message at `index` of `messages`. */
const cellAt = (
  messages: Cell<MessagesValue>,
  index: number,
): MessageCell => {
  const cell: MessageCell = messages.key(index);
  return cell;
};

/**
 * Every stored message of `messages`, as a view item. It reads the list and
 * writes nothing, which its parameter declares by being a `Cell` where
 * `MessagesCell` is a `Writable`: a computation that hands a cell to a
 * helper of another module is scheduled as a writer of that cell when the
 * helper's parameter is a `Writable`.
 */
export const messageEntries = (
  messages: Cell<MessagesValue>,
): MessageEntry[] =>
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

/**
 * Whether the record has lost its author through obliteration. The explicit
 * marker distinguishes a cleared optional cell handle from a profile link
 * whose contents the reader cannot resolve.
 */
export const isObliterated = (record: MessageRecord): boolean =>
  record.obliterated === true || record.authorProfile === undefined;

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

/** What one person may do to one message. */
export interface MessageRights {
  /** Whether they may record a new version of it. */
  canEdit: boolean;

  /** Whether they may delete it. */
  canDelete: boolean;

  /** Whether they may obliterate it. */
  canObliterate: boolean;
}

/** The rights of someone who may do nothing to a message. */
export const NO_MESSAGE_RIGHTS: MessageRights = {
  canEdit: false,
  canDelete: false,
  canObliterate: false,
};

/**
 * What a person may do to the message `record`, given authenticated authorship
 * and whether they hold OWNER in the room's space and
 * whether the room lets its OWNERs obliterate. Only the message's author may
 * edit or delete it, and in a direct room they may obliterate it too. An OWNER
 * may obliterate any message while `ownersMayObliterate` holds, and otherwise
 * gains nothing over anyone else: never an edit or a deletion of someone
 * else's message. A deleted message takes nothing further but obliteration,
 * and an obliterated one, which names no author, takes nothing. The room's
 * handlers supply authenticated authorship. Rendering supplies the viewer's
 * profile attestation, which can differ from the principal acting in a handler.
 */
export const messageRightsOf = (
  record: MessageRecord | undefined,
  isAuthor: boolean,
  kind: ChatRoomKind,
  isOwner: boolean,
  ownersMayObliterate: boolean,
): MessageRights => {
  const present = record !== undefined && !isObliterated(record);
  const live = !isDeleted(record);
  return {
    canEdit: present && live && isAuthor,
    canDelete: present && live && isAuthor,
    canObliterate: present &&
      ((isOwner && ownersMayObliterate) || (kind === "direct" && isAuthor)),
  };
};

/**
 * Whether the room whose policy `policy` is lets its OWNERs obliterate, as
 * the policy states it; a policy that is absent, or doesn't read yet, doesn't.
 */
export const ownersMayObliterateBy = (
  policy: Cell<ChatRoomPolicy> | undefined,
): boolean => policy?.get()?.ownersMayObliterate === true;

/**
 * Why an obliteration `messageRightsOf()` doesn't allow is refused, for a
 * person to read.
 */
const obliterationRefusal = (
  kind: ChatRoomKind,
  ownersMayObliterate: boolean,
): string =>
  kind === "direct"
    ? ownersMayObliterate
      ? "Only an owner of this chat can remove someone else's message."
      : "Only its author can remove a message in this chat."
    : ownersMayObliterate
    ? "Only an owner of this chat can remove a message."
    : "Messages in this chat can't be removed.";

/**
 * Whether the viewer can send, edit, delete, and react in the room whose
 * messages are `messages`: their profile resolves, and the room's space grants
 * them WRITE or OWNER. A level not known yet (`undefined`) is not a grant.
 * `messages` only names the room's space, and is a `Cell` for the reason
 * `messageEntries()` gives.
 */
export const canActIn = (
  messages: Cell<unknown>,
  myProfile: ProfileCell | undefined,
): boolean => {
  const level = spaceAccess(messages);
  return myProfile?.get() !== undefined &&
    (level === "WRITE" || level === "OWNER");
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

  /** The main composer's unsent text. */
  draft?: string;

  /** The thread composer's unsent text. */
  threadDraft?: string;
}

/** The cell holding a session's composer state. */
export type ComposerCell = Writable<
  ComposerState | Default<Record<PropertyKey, never>>
>;

/** The acts on a message, each performed by a handler of its own. */
type MessageAct = "send" | "edit" | "delete" | "obliterate";

/**
 * The cell holding the outcome of each of the sender's message acts, by its
 * `requestId`: one instance per user, which no one else reads.
 */
export type MessageRequestsCell = Writable<
  | Record<string, MessageActOutcome>
  | Default<Record<PropertyKey, never>>
>;

/**
 * The cell holding why the session's latest message act was refused, which
 * the room's composer shows; empty once an act takes effect.
 */
export type ActRefusalCell = Writable<string>;

/** What a room asks of its viewer's manager's `joinRoom`: the room itself. */
export interface JoinRoomRequest {
  /** The root explicitly declaring a room held inside a container. */
  container?: Cell<ChatContainer>;

  /** The room the viewer has joined. */
  room: Cell<ChatRoomLink>;
}

/**
 * Whether `catalog` keeps the room in `space` as one of its user's chats; a
 * catalog that doesn't read as one keeps none.
 */
export const listsRoomIn = (
  catalog: unknown,
  space: string | undefined,
): boolean => {
  if (!isSharedSpaceCatalog(catalog) || space === undefined) return false;
  const entry = catalog.entries[space];
  return entry?.kind === CHAT_ROOM_OFFER_KIND && entry.state === "saved";
};

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

  /** The sender's outcomes, by `requestId`; absent where none are kept. */
  outcomes?: MessageRequestsCell;

  /**
   * Why the session's latest act was refused, which the composer shows;
   * absent where nothing shows it.
   */
  refusal?: ActRefusalCell;

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

  /**
   * The room's policy, as `about.policy` links it, whose `ownersMayObliterate`
   * says whether an OWNER may obliterate; absent or unread, no OWNER may.
   */
  policy?: Cell<ChatRoomPolicy>;

  /**
   * Tells the viewer's manager the viewer has joined the room, as
   * `tellManagerJoined` does, in an event of its own; absent where nothing is
   * told. The act's own transaction reads nothing of the manager, which can
   * carry a label the room's space doesn't admit.
   */
  joined?: Stream<void>;
}

/** The part of the viewer's manager `tellManagerJoined` reaches. */
export interface JoiningManager {
  /** Makes a room the viewer has joined one of their chats. */
  joinRoom?: Stream<JoinRoomRequest>;
}

/** What `tellManagerJoined` is bound to. */
export interface ManagerJoinState {
  /**
   * Whether the room is one a manager can take the viewer into: it names
   * itself, and is standalone or its container's declared conversation.
   * Absent, it isn't. It says nothing of the manager, so that what the room
   * stores reads nothing of a manager that can carry a label the room's space
   * doesn't admit.
   */
  canJoin?: boolean;

  /** The container's declaration, for a room held inside another space. */
  container?: Cell<ChatContainer>;

  /**
   * The viewer's manager; absent while the viewer has none, or theirs hasn't
   * resolved.
   */
  manager?: JoiningManager;

  /** The room itself, as the viewer's manager links it. */
  self?: Cell<ChatRoomLink>;
}

/**
 * Tells the viewer's manager the viewer has joined the room. The manager's
 * own event checks its private catalog and leaves an already listed room
 * unchanged, so catalog reads stay in the manager's event. A room's acts send
 * it an event once they have recorded what the viewer wrote.
 *
 * The manager is read here, as a value, rather than by what the room stores:
 * a stream bound to a manager that isn't there still reads as present, so
 * only the manager's own value says whether it has a `joinRoom`, and this
 * event writes nothing in the room's space.
 */
export const tellManagerJoined = handler<void, ManagerJoinState>(
  (_event, { canJoin, container, manager, self }) => {
    // The room decides first, so a room the viewer can't join reads nothing
    // of the manager.
    if (canJoin !== true || self === undefined) return;
    const joinRoom = manager?.joinRoom;
    if (joinRoom === undefined) return;
    joinRoom.send({ room: self, container });
  },
);

/**
 * Records that the act `requestId` took effect, and clears the session's
 * shown refusal.
 */
const actDone = (state: RoomActState, requestId: string): void => {
  state.outcomes?.key(requestId).set({ status: "done" });
  state.refusal?.set("");
};

/**
 * Records that the act `requestId` was refused, with `code` and `reason`, and
 * shows the reason to the session. Nothing else is written: a refusal leaves
 * the room's shared record as it is. A request already done keeps its
 * outcome, and shows nothing: a replay of an act that took effect is not
 * refused, whatever the state it arrives in.
 */
const refuseAct = (
  state: RoomActState,
  requestId: string,
  code: MessageActRefusalCode,
  reason: string,
): void => {
  const outcome = state.outcomes?.key(requestId);
  if (outcome?.get()?.status === "done") return;
  outcome?.set({ status: "refused", reason, code });
  state.refusal?.set(reason);
};

/**
 * Helper for the act handlers, which refuses an act whose sender can't act in
 * the room: one whose profile hasn't resolved, who isn't signed in, or whose
 * access to the room's space is known and doesn't let them write. Returns
 * whether it refused.
 */
const refuseUnableSender = (
  state: RoomActState,
  requestId: string,
  profileResolved: boolean,
  sender: string | undefined,
): boolean => {
  if (!profileResolved) {
    refuseAct(
      state,
      requestId,
      "no-profile",
      "Acting in a chat needs a profile, and yours hasn't resolved.",
    );
    return true;
  }
  const level = spaceAccess(state.messages);
  if (sender === undefined || level === "none" || level === "READ") {
    refuseAct(
      state,
      requestId,
      "not-member",
      "You can't write in this chat.",
    );
    return true;
  }
  return false;
};

/** The reason an act's time is refused for, as a person reads it. */
const OUT_OF_WINDOW = "The time it was made at is outside this chat's window.";

/**
 * Performs one message act: send, edit, delete, or obliterate. An act that
 * breaks the rules `ChatRoomOutput` states for its stream is refused, which
 * records the refusal in the sender's outcomes and nothing else; otherwise it
 * records the change, an activity entry, the request, and its outcome, all in
 * one transaction.
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
  const requestId = event?.requestId ?? eventKey();
  if (state.outcomes?.key(requestId).get() !== undefined) return;
  const refuse = (code: MessageActRefusalCode, reason: string): void =>
    refuseAct(state, requestId, code, reason);
  const profile = myProfile?.resolveAsCell();
  const sender = currentPrincipal();
  if (
    refuseUnableSender(
      state,
      requestId,
      op === "delete" || op === "obliterate" || profile?.get() !== undefined,
      sender,
    ) ||
    sender === undefined
  ) {
    return;
  }
  const requestKey = requestKeyOf(sender, requestId);
  if (actedOn(requests, requestKey)) return;
  const clock = clockNsec();
  const typed = event?.target?.value;
  const version: ChatMessageVersion | undefined = event?.version ??
    (typeof typed === "string"
      ? { body: typed, sentAt: epochNsec(clock) }
      : undefined);

  if (op === "send") {
    if (version === undefined || !isValidBody(version.body)) {
      refuse("invalid-body", "A message needs some text.");
      return;
    }
    // The message itself also prevents duplication if request bookkeeping
    // is unavailable.
    if (messages.elementById(requestKey).get() !== undefined) {
      rememberRequest(requests, requestKey, clock);
      actDone(state, requestId);
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
    // Only a reply looks up a message, so a plain send builds no entry for
    // any message already in the room.
    const target = replyCell === undefined
      ? undefined
      : entryFor(messageEntries(messages), replyCell);
    if (replyCell !== undefined) {
      if (target === undefined) {
        refuse("bad-reply", "The message replied to isn't in this chat.");
        return;
      }
      if (isDeleted(target.record)) {
        refuse("deleted-target", "The message replied to was deleted.");
        return;
      }
      if (!SHOWN_IN.includes(shownIn)) {
        refuse("bad-reply", "A reply is shown in the main chat or a thread.");
        return;
      }
      if (shownIn === "main" && !isInMain(target)) {
        refuse(
          "bad-reply",
          "A message shown only in a thread takes its replies there.",
        );
        return;
      }
    }
    const sentAt = claimTime(
      usedTimes,
      clock,
      nsecOf(version.sentAt),
      target?.sentAt,
    );
    const loggedAt = sentAt === undefined
      ? undefined
      : claimTime(usedTimes, clock);
    if (sentAt === undefined || loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
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
    actDone(state, requestId);
    if (state.replyFrom === "replyTo" && composing?.replyTo !== undefined) {
      composer.key("replyTo").set(undefined);
    }
    const draftKey = state.replyFrom === "thread" ? "threadDraft" : "draft";
    if (composer.key(draftKey).get() === version.body) {
      composer.key(draftKey).set("");
    }
    state.joined?.send();
    return;
  }

  const target = (event?.message ?? state.message)?.resolveAsCell();
  const entry = entryFor(messageEntries(messages), target);
  if (target === undefined || entry === undefined) {
    refuse("unknown-target", "That message isn't in this chat.");
    return;
  }
  const current = entry.record;
  const ownersMayObliterate = ownersMayObliterateBy(state.policy);
  const rights = messageRightsOf(
    current,
    principalOf(target, "authored-by") === sender,
    kind,
    isOwnerOf(messages),
    ownersMayObliterate,
  );
  const deletionObliterates = op === "delete" &&
    FABRICHAT_POLICY.deletionIsObliteration;

  if (op === "obliterate" || deletionObliterates) {
    if (isObliterated(current)) {
      rememberRequest(requests, requestKey, clock);
      actDone(state, requestId);
      return;
    }
    if (op === "delete" && isDeleted(current)) {
      refuse("deleted-target", "That message was already deleted.");
      return;
    }
    if (!(op === "delete" ? rights.canDelete : rights.canObliterate)) {
      refuse(
        "not-allowed",
        op === "delete"
          ? "Only its author can delete a message."
          : obliterationRefusal(kind, ownersMayObliterate),
      );
      return;
    }
    const editedAt = claimTime(usedTimes, clock);
    const loggedAt = editedAt === undefined
      ? undefined
      : claimTime(usedTimes, clock);
    if (editedAt === undefined || loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
    if (current.reactions?.get() !== undefined) current.reactions.set([]);
    target.key("obliterated").set(true);
    target.key("authorProfile").set(undefined);
    target.key("body").set({ deleted: true });
    target.key("editedAt").set(editedAt);
    target.key("earlierVersions").set([]);
    target.key("reactions").set(undefined);
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
    actDone(state, requestId);
    return;
  }

  if (isDeleted(current)) {
    refuse("deleted-target", "That message was deleted.");
    return;
  }
  if (!(op === "delete" ? rights.canDelete : rights.canEdit)) {
    refuse(
      "not-allowed",
      op === "delete"
        ? "Only its author can delete a message."
        : "Only its author can edit a message.",
    );
    return;
  }
  const kept: ChatMessageVersion[] = FABRICHAT_POLICY.keepsHistory
    ? [...(current.earlierVersions ?? []), {
      body: current.body as string,
      sentAt: current.editedAt ?? current.sentAt,
    }]
    : [];

  if (op === "delete") {
    const editedAt = claimTime(usedTimes, clock);
    const loggedAt = editedAt === undefined
      ? undefined
      : claimTime(usedTimes, clock);
    if (editedAt === undefined || loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
    if (current.reactions?.get() !== undefined) current.reactions.set([]);
    target.key("body").set({ deleted: true });
    target.key("editedAt").set(editedAt);
    target.key("earlierVersions").set(kept);
    target.key("reactions").set(undefined);
    appendActivity(activity, counters, loggedAt, clock, requestId, target);
    rememberRequest(requests, requestKey, clock);
    actDone(state, requestId);
    return;
  }

  if (version === undefined || !isValidBody(version.body)) {
    refuse("invalid-body", "A message needs some text.");
    return;
  }
  const editedAt = claimTime(usedTimes, clock, nsecOf(version.sentAt));
  const loggedAt = editedAt === undefined
    ? undefined
    : claimTime(usedTimes, clock);
  if (editedAt === undefined || loggedAt === undefined) {
    refuse("out-of-window", OUT_OF_WINDOW);
    return;
  }
  target.key("body").set(version.body);
  target.key("editedAt").set(editedAt);
  target.key("earlierVersions").set(kept);
  appendActivity(activity, counters, loggedAt, clock, requestId, target);
  rememberRequest(requests, requestKey, clock);
  actDone(state, requestId);
  const editing = composer.get()?.editing;
  if (editing !== undefined && equals(editing, target)) {
    composer.key("editing").set(undefined);
  }
};

/**
 * Adds or removes the sender's reaction to a message. Adding one already
 * there, or removing one that isn't, changes nothing, and is done. A reaction
 * is kept at an address within its message's list derived from its reactor
 * and its emoji, so one person's one reaction has a single address in every
 * session. A refused reaction records only the refusal in the sender's
 * outcomes.
 */
const performReactionAct = (
  op: "add" | "remove",
  event: RoomStreamEvent,
  state: RoomActState,
): void => {
  const { myProfile, messages, requests, usedTimes, activity, counters } =
    state;
  const requestId = event?.requestId ?? eventKey();
  if (state.outcomes?.key(requestId).get() !== undefined) return;
  const refuse = (code: MessageActRefusalCode, reason: string): void =>
    refuseAct(state, requestId, code, reason);
  const profile = myProfile?.resolveAsCell();
  const sender = currentPrincipal();
  // A reaction's address derives from its reactor's profile.
  const reactorKey = profile === undefined ? undefined : entityKeyOf(profile);
  if (
    refuseUnableSender(
      state,
      requestId,
      profile?.get() !== undefined && reactorKey !== undefined,
      sender,
    ) || sender === undefined
  ) {
    return;
  }
  const typed = event?.target?.value?.trim();
  const emoji = event?.emoji ?? state.emoji ?? typed;
  if (!isSingleEmoji(emoji)) {
    refuse("invalid-body", "A reaction is a single emoji.");
    return;
  }
  const requestKey = requestKeyOf(sender, requestId);
  if (actedOn(requests, requestKey)) return;
  const target = (event?.message ?? state.message)?.resolveAsCell();
  const entry = entryFor(messageEntries(messages), target);
  if (target === undefined || entry === undefined) {
    refuse("unknown-target", "That message isn't in this chat.");
    return;
  }
  const list = entry.record.reactions;
  if (isDeleted(entry.record) || list === undefined) {
    refuse("deleted-target", "That message was deleted.");
    return;
  }
  const clock = clockNsec();
  if (state.closesPicker === true) state.pickerOpen?.set(false);
  const reactionKey = JSON.stringify([reactorKey, emoji]);
  const mine = list.elementById(reactionKey);
  const present = mine.get() !== undefined;
  if (op === "add" && !present) {
    const sentAt = claimTime(usedTimes, clock);
    const loggedAt = sentAt === undefined
      ? undefined
      : claimTime(usedTimes, clock);
    if (sentAt === undefined || loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
    mine.set({ reactorProfile: profile, emoji, sentAt } as SentReaction);
    list.addUnique(mine);
    appendActivity(activity, counters, loggedAt, clock, requestId, target);
    state.joined?.send();
  }
  if (op === "remove" && present) {
    if (principalOf(mine, "authored-by") !== sender) {
      refuse("not-allowed", "Only its author can remove a reaction.");
      return;
    }
    const loggedAt = claimTime(usedTimes, clock);
    if (loggedAt === undefined) {
      refuse("out-of-window", OUT_OF_WINDOW);
      return;
    }
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
  actDone(state, requestId);
};

/** Sends a message, from `ChatSendSurface`. */
export const commitSend = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("send", event, state),
);

/** Edits the sender's message, from `ChatEditSurface`. */
export const commitEdit = handler<RoomStreamEvent, RoomActState>(
  (event, state) => performMessageAct("edit", event, state),
);

/** Deletes a message, from `ChatDeleteSurface`. */
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
    if (request.from === undefined || request.count === undefined) return;
    const selected = selectWindow(
      view.map((entry) => ({ sentAt: entry.record.sentAt, cell: entry.cell })),
      request.from,
      request.count,
      FABRICHAT_POLICY.maxWindowCount,
    );
    if (selected === undefined) return;
    windows.key(windowId).set({
      requestId: request.requestId,
      ...(root === undefined ? {} : { root }),
      messages: selected.messages.map((entry) => entry.cell.resolveAsCell()),
      hasOlder: selected.hasOlder,
      hasNewer: selected.hasNewer,
    });
  },
);

/**
 * An event on the room's `setTitle`. A rendered control sends the text it
 * holds as `target.value`, and no request id, which the room then mints.
 */
export interface SetTitleEvent {
  /**
   * Chosen by the sender, and unique among its retitles. The outcome is
   * recorded under it, and sending the same event again with it changes
   * nothing.
   */
  requestId?: string;

  /** The new title. */
  title?: string;

  /** A rendered control's text. */
  readonly target?: { readonly value?: string };
}

/** What `commitSetTitle` is bound to. */
export interface SetTitleState {
  /**
   * The room's title as a member last set it; absent for a room whose title
   * no member sets.
   */
  titles?: TitlesCell;

  /**
   * Whether the room is one a manager created in a space of its own. A
   * space's own chat is shown by its space's name.
   */
  ownSpace: boolean;

  /** The room's messages, which name the room's space. */
  messages: MessagesCell;

  /** The sender's retitles' outcomes. */
  outcomes: TitleRequestsCell;

  /**
   * Why the session's latest retitle was refused, which the rendered control
   * shows; empty once one takes effect.
   */
  refusal: Writable<string>;

  /**
   * Tells the viewer's manager the viewer has joined the room, as
   * `tellManagerJoined` does, in an event of its own, which brings the title
   * the manager's catalog lists the room under up to the new one; absent where
   * nothing is told. The retitle's own transaction reads nothing of the
   * manager.
   */
  joined?: Stream<void>;
}

/**
 * Sets the room's title, which every member shares, from a trusted gesture on
 * `ChatRetitleSurface`. Any member who can write in the room may, in a group
 * room or a direct one. The outcome is recorded under the event's
 * `requestId` in the sender's own outcomes, and a refusal leaves the title as
 * it is. A retitle that takes effect then tells the sender's manager, as a
 * write in the room does, so the catalog lists the room under the new title.
 */
export const commitSetTitle = handler<SetTitleEvent, SetTitleState>(
  (event, { titles, ownSpace, messages, outcomes, refusal, joined }) => {
    const requestId = event?.requestId ?? eventKey();
    if (outcomes.key(requestId).get() !== undefined) return;
    const refuse = (code: SetTitleRefusalCode, reason: string): void => {
      outcomes.key(requestId).set({ status: "refused", reason, code });
      refusal.set(reason);
    };
    if (!ownSpace || titles === undefined) {
      refuse("fixed-title", "This chat is named by its space.");
      return;
    }
    // A level not known yet is left to the space's own access list, which
    // refuses the write where it doesn't admit it.
    const level = spaceAccess(messages);
    if (
      currentPrincipal() === undefined || level === "none" || level === "READ"
    ) {
      refuse("not-member", "You can't write in this chat.");
      return;
    }
    const proposed = event?.title ?? event?.target?.value;
    const title = typeof proposed === "string" ? proposed.trim() : "";
    if (title === "") {
      refuse("invalid-title", "A chat's title needs some text.");
      return;
    }
    const record = titles.elementById(TITLE_KEY);
    record.set({ title } as StoredTitle);
    titles.addUnique(record);
    outcomes.key(requestId).set({ status: "done" });
    refusal.set("");
    joined?.send();
  },
);
