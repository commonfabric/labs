/**
 * What a FabriChat room stores, the policy its handlers apply, and those
 * handlers (`docs/specs/fabrichat/FabriChatRoom.md`). The records and their
 * writers are one module because each record's write policy names the
 * handlers that may write it.
 *
 * A message is an object pushed onto the room's messages: a document of its
 * own, labeled `authored-by` whoever last wrote it, and admitted only from the
 * reviewed surface of the act that wrote it. Its reactions are a list of
 * their own, which the message links, so reacting never rewrites the message.
 * A reaction is an object pushed onto that list, labeled `authored-by` its
 * reactor, and admitted only from the reaction surface, which also admits its
 * removal. A message or a reaction is identified by its cell, and nothing is
 * addressed by a key.
 *
 * Every stream that changes the room's record has a handler of its own, as
 * `FabriChatRoom.md` names them. `commitSetTitle` writes the title a member
 * last set, a record of its own beside the one the room's creator wrote.
 *
 * A handler destructures its state and uses the cells inline, and a helper it
 * shares takes each cell as an argument of its own, never the state or an
 * object holding cells: that is what lets the pattern transformer shrink each
 * handler's state to what its body uses, so the runtime reads and binds no
 * more than that.
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
  spaceOf,
  type Stream,
  type TrustedActionWrite,
  Writable,
  type WritePolicyAnyOf,
} from "commonfabric";
import { profileKeyOf } from "../system/private-inbox.tsx";
import { isSharedSpaceCatalog } from "../system/shared-space-catalog.ts";
import {
  isInMain,
  isSingleEmoji,
  type ShownIn,
  type ViewItem,
} from "./logic.ts";
import type { commitStart } from "./manager.tsx";
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
  type ChatReaction,
  type ChatRoomKind,
  type ChatRoomLink,
  type ChatRoomPolicy,
  durationNsec,
  epochNsecFromMsec,
  nsecOf,
  type ProfileCell,
  type SetTitleOutcome,
  type SetTitleRefusalCode,
  type TitleRecord,
} from "./schemas.tsx";

//
// Policy
//

/** Nanoseconds in one second. */
const NSEC_PER_SEC = 1_000_000_000n;

/**
 * The policy every room starts from, a group room's. `about.policy` states
 * it, and the handlers read `deletionIsObliteration` from it, so the two
 * cannot disagree; `maxWindowCount` bounds `messages.latest`. The other
 * settings are stated for the policy's shape, which a user's Home carries,
 * and read by nothing. A room's `ownersMayObliterate` is
 * `ownersMayObliterateIn()`'s.
 */
export const FABRICHAT_POLICY: ChatRoomPolicy = {
  ownersMayObliterate: true,
  keepsHistory: false,
  deletionIsObliteration: false,
  proposedTimeMaxAgeNsec: durationNsec(600n * NSEC_PER_SEC),
  proposedTimeMaxLeadNsec: durationNsec(10n * NSEC_PER_SEC),
  recentActivityWindowNsec: durationNsec(600n * NSEC_PER_SEC),
  maxWindowCount: 100,
  maxOpenWindows: 50,
};

/**
 * The `ownersMayObliterate` a room of `kind` states in its policy, which
 * decides which policy document `about.policy` links: `given`, where the room
 * is configured, and otherwise yes for a group room and no for a direct room.
 * The handlers are bound to the same value, so what the room enforces is what
 * that document states.
 */
export const ownersMayObliterateIn = (
  kind: ChatRoomKind,
  given?: boolean,
): boolean => given ?? kind !== "direct";

//
// Stored records
//

/**
 * A stored reaction: an object pushed onto its message's reaction list by
 * `commitSendReaction`, from the reviewed reaction surface with its own
 * action, and labeled `authored-by` its reactor. `commitDeleteReaction`
 * removes it from the list, from the same surface, and a removal is a write
 * to the element removed, so the policy names both. The policy is the
 * element's, so it sits at the element's position in the list: a claim only
 * beneath a link position does not govern replacing the link or pointing it
 * elsewhere, so a policy moved down to a field would leave the list open to
 * a forged element.
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
  ]>
>;

/** One message's reactions, in the order they were added. */
export type ReactionsValue = SentReaction[] | Default<[]>;

/**
 * The cell holding one message's reactions: a list of its own, which the
 * message links, made by the send that made the message.
 */
export type ReactionsCell = Writable<ReactionsValue>;

/**
 * What a reply reads of the message it replies to: the message without its
 * reactions, and of the message's own reply only where that is shown.
 */
export interface RepliedMessage {
  /** The profile the sender sent under; absent once obliterated. */
  authorProfile?: ProfileCell;

  /** The current text, or the marker of a deleted message. */
  body: string | ChatDeletedBody;

  /** The room's handler clock when it recorded the message. */
  sentAt: FabricEpochNsec;

  /** Where the message's own reply is shown; absent for none. */
  replyTo?: { shownIn: ShownIn };
}

/** A stored reply: which message, and where the reply is shown. */
export interface StoredReply {
  /**
   * The message replied to, in the same room, read as `RepliedMessage`. The
   * link carries no more of the message's schema than that, so a message's
   * schema nests no message: a reply typed as the message it replies to would
   * nest without end, the generator would cut the nesting at a depth that
   * varies with the type a writer addresses the message by, and a write cut
   * shallower than the stored schema would drop the policies stored below
   * the cut and be refused.
   */
  message: Cell<RepliedMessage>;

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

  /** The handler clock when the room recorded the message. */
  sentAt: FabricEpochNsec;

  /** The handler clock at the latest edit or deletion; absent until then. */
  editedAt?: FabricEpochNsec;

  /** What this message replies to, and where it is shown. */
  replyTo?: StoredReply;

  /** The message's reactions; absent once the message is deleted. */
  reactions?: ReactionsCell;
}

/**
 * A stored message: written only by the message handlers, each from its act's
 * reviewed surface, and labeled with whoever wrote its current version. The
 * four send handlers write from the send surface, and differ only in where a
 * send's reply comes from. As with `SentReaction`, the policy is the
 * element's and sits at its position in the list, which is what refuses a
 * message replaced in place, a position pointed at another document, or an
 * element pushed under someone else's profile.
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
      typeof commitComposerSend,
      typeof CHAT_SEND_ACTION,
      typeof CHAT_SEND_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitThreadSend,
      typeof CHAT_SEND_ACTION,
      typeof CHAT_SEND_SURFACE
    >,
    TrustedActionWrite<
      unknown,
      typeof commitReply,
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

/** The handler clock's reading. */
const now = (): FabricEpochNsec => epochNsecFromMsec(Date.now());

/**
 * A stored message as the views see it, keyed by its entity: the facts the
 * room's derivations read of it, taken from the record once, so that none of
 * them reads the record again. A derivation over the entries reads plain
 * values, and follows a link only where it hands one on.
 */
export interface MessageEntry extends ViewItem {
  /** A link to the stored message. */
  cell: MessageCell;

  /** Whether the message is shown in the main conversation. */
  inMain: boolean;

  /** Whether the message is live: neither deleted nor obliterated. */
  live: boolean;

  /**
   * The key of the profile the sender sent under, as Home's `profileKeyOf()`
   * names the link the message stores, which `sendInto()` writes resolved:
   * the space of the profile's document and the entity it is, since an
   * entity's id is minted from its cause and two spaces can hold documents of
   * one id. Absent once obliterated. Two messages have the same author when
   * their keys agree, and a reader is the author when their resolved
   * profile's key is this one.
   */
  authorKey?: string;
}

/** The entries of a room's messages, and every author among them. */
export interface MessageEntries {
  /** Every stored message, in the order recorded. */
  entries: MessageEntry[];

  /**
   * Every author, each once, in the order each first appears, by the link
   * each message stores; an obliterated message names none.
   */
  authors: ProfileCell[];
}

/**
 * The key the stored message `message` links has in the views: the entity of
 * the document that holds it, or `undefined` while it links none. It resolves
 * the link, and reads nothing of the message.
 */
export const viewKeyOf = (message: Cell<unknown>): string | undefined =>
  entityKeyOf(message.resolveAsCell());

/** A link to the stored message at `index` of `messages`. */
const cellAt = (
  messages: Cell<MessagesValue>,
  index: number,
): MessageCell => {
  const cell: MessageCell = messages.key(index);
  return cell;
};

/**
 * Every stored message of `messages`, as an entry, with the authors among
 * them, in one walk of the list that reads each record once. It writes
 * nothing, which its parameter declares by being a `Cell` where
 * `MessagesCell` is a `Writable`: a computation that hands a cell to a
 * helper of another module is scheduled as a writer of that cell when the
 * helper's parameter is a `Writable`.
 */
export const messageEntries = (
  messages: Cell<MessagesValue>,
): MessageEntries => {
  const authorKeys = new Set<string>();
  const authors: ProfileCell[] = [];
  const entries = ((messages.get() ?? []) as MessageRecord[]).flatMap(
    (record, index): MessageEntry[] => {
      if (record?.sentAt === undefined) return [];
      const cell = cellAt(messages, index);
      const key = viewKeyOf(cell);
      if (key === undefined) return [];
      const target = record.replyTo?.message;
      const targetKey = target === undefined ? undefined : viewKeyOf(target);
      const item: ViewItem = {
        key,
        sentAt: nsecOf(record.sentAt),
        ...(record.replyTo === undefined || targetKey === undefined ? {} : {
          replyTo: { key: targetKey, shownIn: record.replyTo.shownIn },
        }),
      };
      const author = record.authorProfile;
      const authorKey = author === undefined ? undefined : profileKeyOf(author);
      if (author !== undefined && authorKey !== undefined) {
        if (!authorKeys.has(authorKey)) {
          authorKeys.add(authorKey);
          authors.push(author);
        }
      }
      return [{
        ...item,
        cell,
        inMain: isInMain(item),
        live: !isDeleted(record),
        ...(authorKey === undefined ? {} : { authorKey }),
      }];
    },
  );
  return { entries, authors };
};

/** What `messageRightsOf()` reads of a message: its author and its body. */
export type RightsFacts = Pick<MessageRecord, "authorProfile" | "body">;

/** Whether a message is deleted, by its sender or by obliteration. */
export const isDeleted = (
  record: Pick<RepliedMessage, "body"> | undefined,
): boolean => record === undefined || typeof record.body !== "string";

/**
 * Whether the principal this code runs for holds OWNER in the room's space,
 * which `cell` lives in: the event's actor in a handler, the viewer in a
 * computation (see `spaceAccess()`).
 */
export const isOwnerOf = (cell: Cell<unknown>): boolean =>
  spaceAccess(cell) === "OWNER";

/** Whether `profile` is the profile `record`'s author sent it under. */
const isAuthorOf = (
  record: RightsFacts | undefined,
  profile: ProfileCell | undefined,
): boolean => {
  const author = record?.authorProfile;
  return author !== undefined && profile !== undefined &&
    equals(author, profile);
};

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
 * What the person acting under `profile` may do to the message `record` in a
 * room of `kind`, given whether they hold OWNER in the room's space and
 * whether the room lets its OWNERs obliterate. Only the message's author may
 * edit or delete it, and in a direct room they may obliterate it too. An OWNER
 * may obliterate any message while `ownersMayObliterate` holds, and otherwise
 * gains nothing over anyone else: never an edit or a deletion of someone
 * else's message. A deleted message takes nothing further but obliteration,
 * and an obliterated one, which names no author, takes nothing. The room's
 * handlers admit an act by this, and the room's view and rendering offer one
 * by it.
 */
export const messageRightsOf = (
  record: RightsFacts | undefined,
  profile: ProfileCell | undefined,
  kind: ChatRoomKind,
  isOwner: boolean,
  ownersMayObliterate: boolean,
): MessageRights =>
  rightsOf(
    isAuthorOf(record, profile),
    !isDeleted(record),
    record?.authorProfile !== undefined,
    kind,
    isOwner,
    ownersMayObliterate,
  );

/**
 * `messageRightsOf()`, from the facts it decides by: whether the person is the
 * message's author, whether the message is live, and whether it still names
 * an author. The room derives every message's rights from its entries this
 * way, and reads two plain values of each entry rather than its record.
 */
export const rightsOf = (
  isAuthor: boolean,
  live: boolean,
  hasAuthor: boolean,
  kind: ChatRoomKind,
  isOwner: boolean,
  ownersMayObliterate: boolean,
): MessageRights => ({
  canEdit: live && isAuthor,
  canDelete: live && isAuthor,
  canObliterate: hasAuthor &&
    ((isOwner && ownersMayObliterate) || (kind === "direct" && isAuthor)),
});

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
 * `target.value`.
 */
export interface RoomStreamEvent {
  /** The text to send, or to record as a message's new version. */
  body?: string;

  /** What a sent message replies to. */
  replyTo?: StoredReply;

  /** The message acted on. */
  message?: MessageCell;

  /** The reaction removed, one of the message's. */
  reaction?: Cell<ChatReaction>;

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

/** What a room asks of its viewer's manager's `joinRoom`: the room itself. */
export interface JoinRoomRequest {
  /** The root explicitly declaring a room held inside a container. */
  container?: Cell<ChatContainer>;

  /** The room the viewer has joined. */
  room: Cell<ChatRoomLink>;

  /**
   * Whether the viewer joined the room by sending a message or a reaction, as
   * `JoinedEvent` says.
   */
  messageAct?: boolean;
}

/** What a room's write tells `tellManagerJoined` of how the viewer joined. */
export interface JoinedEvent {
  /**
   * Whether the write was a message or a reaction. One comes with every such
   * write and none changes the room's title, so the manager leaves the title
   * its catalog lists the room under as it is; any other join brings that
   * title up to the room's.
   */
  messageAct?: boolean;
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

/** What every message and reaction act is bound to. */
export interface ActState {
  /** The viewer's profile, which holds no value until it resolves. */
  myProfile: ProfileCell | undefined;
}

/** What every send is bound to. */
export interface SendState extends ActState {
  /** The room's messages, which a send pushes its message onto. */
  messages: MessagesCell;

  /**
   * Tells the viewer's manager the viewer has joined the room, as
   * `tellManagerJoined` does, in an event of its own; absent where nothing is
   * told. The act's own transaction reads nothing of the manager, which can
   * carry a label the room's space doesn't admit.
   */
  joined?: Stream<JoinedEvent>;
}

/** What a rendered composer's send is bound to. */
export interface ComposerSendState extends SendState {
  /** The session's composer state, whose reply the send takes and ends. */
  composer: ComposerCell;
}

/** What a rendered thread composer's send is bound to. */
export interface ThreadSendState extends ComposerSendState {
  /** Where the reply is shown. */
  shownIn: ShownIn;
}

/** What a rendered message's reply control is bound to. */
export interface ReplyState extends SendState {
  /** The message replied to. */
  message: MessageCell;

  /** Where the reply is shown. */
  shownIn: ShownIn;
}

/** What an act on one of the room's messages is bound to. */
export interface MessageActState extends ActState {
  /**
   * One of the room's records, which names the room's space: an act takes a
   * message of that space and no other, and reads nothing of the record.
   */
  room: Cell<unknown>;

  /** A rendered control's message, the one acted on. */
  message?: MessageCell;
}

/** What `commitEdit` is bound to. */
export interface EditState extends MessageActState {
  /** The session's composer state, whose edit an edit ends. */
  composer: ComposerCell;
}

/** What `commitObliterate` is bound to. */
export interface ObliterateState extends MessageActState {
  /** The room's kind. */
  kind: ChatRoomKind;

  /**
   * Whether the room lets an OWNER of its space obliterate any message;
   * absent, it doesn't.
   */
  ownersMayObliterate?: boolean;
}

/** What `commitDeleteReaction` is bound to, and `commitSendReaction` too. */
export interface ReactionState extends MessageActState {
  /** A rendered control's emoji. */
  emoji?: string;
}

/** What `commitDeleteReaction` is bound to. */
export interface DeleteReactionState extends MessageActState {
  /** A rendered tally's reaction of the viewer's, the one removed. */
  reaction?: Cell<ChatReaction>;
}

/** What `commitSendReaction` is bound to. */
export interface AddReactionState extends ReactionState {
  /** A rendered reaction picker's open state, closed by a reaction. */
  pickerOpen?: Writable<boolean>;

  /** Whether this binding closes `pickerOpen`, which only a picker binds. */
  closesPicker?: boolean;

  /** Tells the viewer's manager the viewer has joined, as `SendState` says. */
  joined?: Stream<JoinedEvent>;
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
 * own event checks its private catalog, so catalog reads stay in the
 * manager's event. For an already listed room it changes no membership, and
 * brings the title its catalog lists the room under up to the room's, except
 * for a join marked `messageAct`, which leaves the title as it is. A room's
 * acts send it an event once they have recorded what the viewer wrote, saying
 * whether that was a message or a reaction, which it passes on.
 *
 * The manager is read here, as a value, rather than by what the room stores:
 * a stream bound to a manager that isn't there still reads as present, so
 * only the manager's own value says whether it has a `joinRoom`, and this
 * event writes nothing in the room's space.
 */
export const tellManagerJoined = handler<JoinedEvent, ManagerJoinState>(
  (event, { canJoin, container, manager, self }) => {
    // The room decides first, so a room the viewer can't join reads nothing
    // of the manager.
    if (canJoin !== true || self === undefined) return;
    const joinRoom = manager?.joinRoom;
    if (joinRoom === undefined) return;
    joinRoom.send({
      room: self,
      container,
      ...(event?.messageAct === true ? { messageAct: true } : {}),
    });
  },
);

/**
 * The profile `myProfile` resolves to, once it holds a value; `undefined`
 * until it does.
 */
const resolvedProfile = (
  myProfile: ProfileCell | undefined,
): ProfileCell | undefined => {
  const profile = myProfile?.resolveAsCell();
  return profile?.get() === undefined ? undefined : profile;
};

/** The text an event sends: its `body`, or a rendered control's, trimmed. */
const textOf = (event: RoomStreamEvent): string => {
  const text = event?.body ?? event?.target?.value;
  return typeof text === "string" ? text.trim() : "";
};

/**
 * The emoji an event sends: its own, the one its control is bound to, or the
 * text typed into a rendered control.
 */
const emojiOf = (event: RoomStreamEvent, bound: string | undefined): unknown =>
  event?.emoji ?? bound ?? event?.target?.value?.trim();

/**
 * Whether `target` is one of the room's messages as far as an act on it, or
 * a reply to it, goes: a message of the space `room`, any of the room's
 * records, lives in. An act on a message elsewhere would apply this room's
 * rules, its kind and its policy, to a message another room's rules govern,
 * and a reply to one would have the room's views read a document of
 * another space.
 */
const isInRoomOf = (room: Cell<unknown>, target: Cell<unknown>): boolean =>
  spaceOf(target) === spaceOf(room);

/** Why an act from a sender whose profile hasn't resolved is refused. */
const NO_PROFILE = "Your profile hasn't loaded yet.";

/** Why an act on, or a reply to, a message the room doesn't hold is refused. */
const NOT_IN_ROOM = "That message isn't in this chat.";

/** Why an act on a deleted message, other than its obliteration, is refused. */
const DELETED = "That message was deleted.";

/**
 * The message `link` names, as the target of an act: one of the room's
 * messages, by `isInRoomOf()`.
 *
 * @throws If `link` names no message, or one outside the room's space.
 */
const messageInRoom = (
  room: Cell<unknown>,
  link: MessageCell | undefined,
): MessageCell => {
  const target = link?.resolveAsCell();
  if (target === undefined || !isInRoomOf(room, target)) {
    throw new Error(NOT_IN_ROOM);
  }
  return target;
};

/**
 * Why `messageRightsOf()` refuses an obliteration, for a person to read: the
 * room's `kind` and whether its OWNERs may obliterate decide who may.
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
 * Leaves a tombstone of the message at `target`: its time and what it replies
 * to stay, its body becomes the deleted marker, its reactions go, and so does
 * its author unless `keepsAuthor`. The whole message is written, where an
 * edit writes its text alone, since only a write of the whole drops a key: a
 * key written `undefined` is present, and an author's link so written reads
 * as a handle to nothing rather than as no author.
 */
const leaveTombstone = (target: MessageCell, keepsAuthor: boolean): void => {
  const current = target.get();
  target.set({
    ...(keepsAuthor && current.authorProfile !== undefined
      ? { authorProfile: current.authorProfile }
      : {}),
    body: { deleted: true },
    sentAt: current.sentAt,
    editedAt: now(),
    ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
  } as SentMessage);
};

/**
 * Pushes a send onto `messages`: the text `event` carries, from `myProfile`,
 * as a reply to `reply` where that names a message, shown `shownIn`, with a
 * reaction list of its own; then `joined` is told.
 *
 * Every handler here takes the event a rendered control of the room sends,
 * and the controls offer only acts the viewer may take, so a handler checks
 * what the element's write policy does not — whose message it is, and that
 * a message acted on or replied to is one of the room's — and refuses
 * anything else by throwing, with a reason a person can read, before it
 * writes: the run fails and writes nothing, and a send that awaits its
 * handling is rejected with the reason. An act that would change nothing,
 * such as a reaction added twice, writes nothing and succeeds.
 *
 * @throws If the profile hasn't resolved, the send has no text, or `reply`
 *   names a message outside the room's space.
 */
const sendInto = (
  event: RoomStreamEvent,
  myProfile: ProfileCell | undefined,
  messages: MessagesCell,
  reply: Cell<RepliedMessage> | undefined,
  shownIn: ShownIn,
  joined: Stream<JoinedEvent> | undefined,
): void => {
  const profile = resolvedProfile(myProfile);
  if (profile === undefined) throw new Error(NO_PROFILE);
  const body = textOf(event);
  if (body === "") throw new Error("This send has no text in `body`.");
  const target = reply?.resolveAsCell();
  if (target !== undefined && !isInRoomOf(messages, target)) {
    throw new Error(NOT_IN_ROOM);
  }
  // A message may link only a list that exists, so the list is made before
  // the message links it.
  const reactions = new Writable<ReactionsValue>([] as ReactionsValue);
  messages.push({
    authorProfile: profile,
    body,
    sentAt: now(),
    ...(target === undefined ? {} : { replyTo: { message: target, shownIn } }),
    reactions,
  } as SentMessage);
  joined?.send({ messageAct: true });
};

/**
 * Sends a message, from `ChatSendSurface`: the event's text, replying to the
 * event's `replyTo` where it carries one.
 */
export const commitSend = handler<RoomStreamEvent, SendState>(
  (event, { myProfile, messages, joined }) => {
    sendInto(
      event,
      myProfile,
      messages,
      event?.replyTo?.message,
      event?.replyTo?.shownIn ?? "main",
      joined,
    );
  },
);

/**
 * Sends a rendered composer's text, from `ChatSendSurface`, replying in the
 * main conversation to the message the composer holds, if any, and ending
 * that reply.
 */
export const commitComposerSend = handler<RoomStreamEvent, ComposerSendState>(
  (event, { myProfile, messages, composer, joined }) => {
    // A cleared link still reads back as a cell, holding nothing.
    const link = composer.get()?.replyTo;
    const reply = link?.get() === undefined ? undefined : link;
    sendInto(event, myProfile, messages, reply, "main", joined);
    if (reply !== undefined) composer.key("replyTo").set(undefined);
  },
);

/**
 * Sends a rendered thread composer's text, from `ChatSendSurface`, replying in
 * the open thread.
 */
export const commitThreadSend = handler<RoomStreamEvent, ThreadSendState>(
  (event, { myProfile, messages, composer, shownIn, joined }) => {
    const link = composer.get()?.thread;
    const reply = link?.get() === undefined ? undefined : link;
    sendInto(event, myProfile, messages, reply, shownIn, joined);
  },
);

/**
 * Sends a rendered message's reply, from `ChatSendSurface`, shown where the
 * control is bound to show it.
 */
export const commitReply = handler<RoomStreamEvent, ReplyState>(
  (event, { myProfile, messages, message, shownIn, joined }) => {
    sendInto(event, myProfile, messages, message, shownIn, joined);
  },
);

/**
 * Records a new version of the sender's message, from `ChatEditSurface`: the
 * event's text, in place of the current one. An edit of the message the
 * session's composer is editing ends that edit.
 */
export const commitEdit = handler<RoomStreamEvent, EditState>(
  (event, { myProfile, room, message, composer }) => {
    const profile = resolvedProfile(myProfile);
    if (profile === undefined) throw new Error(NO_PROFILE);
    const target = messageInRoom(room, event?.message ?? message);
    const current = target.get();
    if (isDeleted(current)) throw new Error(DELETED);
    if (!isAuthorOf(current, profile)) {
      throw new Error("Only its author can edit a message.");
    }
    const body = textOf(event);
    if (body === "") throw new Error("This edit has no text in `body`.");
    target.key("body").set(body);
    target.key("editedAt").set(now());
    const editing = composer.get()?.editing;
    if (editing !== undefined && equals(editing, target)) {
      composer.key("editing").set(undefined);
    }
  },
);

/**
 * Deletes the sender's message, from `ChatDeleteSurface`: what is left is a
 * tombstone under its author, with no body and no reactions; or, where the
 * room's policy makes deletion obliteration, under no author.
 */
export const commitDelete = handler<RoomStreamEvent, MessageActState>(
  (event, { myProfile, room, message }) => {
    const profile = resolvedProfile(myProfile);
    if (profile === undefined) throw new Error(NO_PROFILE);
    const target = messageInRoom(room, event?.message ?? message);
    const current = target.get();
    // Deleted already: there is nothing to delete.
    if (isDeleted(current)) return;
    if (!isAuthorOf(current, profile)) {
      throw new Error("Only its author can delete a message.");
    }
    leaveTombstone(target, !FABRICHAT_POLICY.deletionIsObliteration);
  },
);

/**
 * Obliterates a message, from `ChatObliterateSurface`, where
 * `messageRightsOf()` lets the sender: what is left is a tombstone under no
 * author, labeled with whoever obliterated it.
 */
export const commitObliterate = handler<RoomStreamEvent, ObliterateState>(
  (event, { myProfile, room, message, kind, ownersMayObliterate }) => {
    const target = messageInRoom(room, event?.message ?? message);
    const current = target.get();
    // Obliterated already, its author gone: there is nothing to remove.
    if (isDeleted(current) && current?.authorProfile === undefined) return;
    const rights = messageRightsOf(
      current,
      resolvedProfile(myProfile),
      kind,
      isOwnerOf(target),
      ownersMayObliterate === true,
    );
    if (!rights.canObliterate) {
      throw new Error(
        obliterationRefusal(kind, ownersMayObliterate === true),
      );
    }
    leaveTombstone(target, false);
  },
);

/**
 * The reaction list of the message at `target`, as the cell the message
 * links, or `undefined` where the message links none. It is addressed as a
 * cell rather than read off the message's value: a client addresses a message
 * through the room's public type, where the reactions read as values.
 */
const reactionsOf = (target: MessageCell): ReactionsCell | undefined =>
  target.get()?.reactions === undefined
    ? undefined
    : target.key("reactions").resolveAsCell() as never;

/**
 * Adds the sender's reaction to a message, from `ChatReactSurface`: the
 * event's emoji, the one its control is bound to, or the text typed in. A
 * reaction the sender already has on the message with that emoji is not added
 * again, and the act is done.
 */
export const commitSendReaction = handler<RoomStreamEvent, AddReactionState>(
  (
    event,
    {
      myProfile,
      room,
      message,
      emoji: bound,
      pickerOpen,
      closesPicker,
      joined,
    },
  ) => {
    const profile = resolvedProfile(myProfile);
    if (profile === undefined) throw new Error(NO_PROFILE);
    const emoji = emojiOf(event, bound);
    if (!isSingleEmoji(emoji)) throw new Error("A reaction is a single emoji.");
    const target = messageInRoom(room, event?.message ?? message);
    const list = reactionsOf(target);
    // A send gives every message its reaction list, and a deletion takes it
    // away, so a message without one is a deleted one.
    if (isDeleted(target.get()) || list === undefined) {
      throw new Error(DELETED);
    }
    if (closesPicker === true) pickerOpen?.set(false);
    const reactions = (list.get() ?? []) as ChatReaction[];
    const present = reactions.some((reaction) =>
      reaction?.emoji === emoji && equals(reaction.reactorProfile, profile)
    );
    if (!present) {
      list.push(
        { reactorProfile: profile, emoji, sentAt: now() } as SentReaction,
      );
    }
    joined?.send({ messageAct: true });
  },
);

/**
 * Removes the sender's reaction, from `ChatReactSurface`: the reaction the
 * event or the binding names, by its cell, from the reactions of the message
 * the event or the binding names. One no longer on the message removes
 * nothing.
 */
export const commitDeleteReaction = handler<
  RoomStreamEvent,
  DeleteReactionState
>(
  (event, { myProfile, room, message, reaction }) => {
    const profile = resolvedProfile(myProfile);
    if (profile === undefined) throw new Error(NO_PROFILE);
    const target = messageInRoom(room, event?.message ?? message);
    const list = reactionsOf(target);
    // A send gives every message its reaction list, and a deletion takes it
    // away, so a message without one is a deleted one.
    if (isDeleted(target.get()) || list === undefined) {
      throw new Error(DELETED);
    }
    const removed = (event?.reaction ?? reaction)?.resolveAsCell();
    if (removed === undefined) throw new Error("This names no reaction.");
    const record = removed.get();
    // One no longer there, which reads as none, removes nothing.
    if (record === undefined) return;
    if (!equals(record.reactorProfile, profile)) {
      throw new Error("Only the person who reacted can remove a reaction.");
    }
    list.removeByValue(removed);
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
  joined?: Stream<JoinedEvent>;
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
    joined?.send({});
  },
);
