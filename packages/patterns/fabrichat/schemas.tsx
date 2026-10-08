/**
 * The FabriChat records, and the parts of the contracts that don't depend on
 * how a room stores its messages: the reviewed surfaces, recorded times,
 * profiles, a room's records and requests, how a message's reactions tally,
 * and the manager's records, which `docs/specs/fabrichat/` states under the
 * same names; and the displays an element shown by a prop takes, as
 * `docs/common/patterns/conditional.md` describes. `room-records.tsx` defines
 * the records a room stores, and `room.tsx` the room's own output types over
 * them.
 *
 * Every recorded time is a `FabricEpochNsec`, unique in its room. Times are
 * compared through `nsecOf()`.
 */
import {
  type Cell,
  type DID,
  equals,
  FabricDurationNsec,
  FabricEpochNsec,
  isWellFormedDID,
} from "commonfabric";
import type { ProfileInbox } from "../system/profile-home.tsx";

//
// Reviewed surfaces
//

/** The reviewed surface a message is sent from. */
export const CHAT_SEND_SURFACE = "ChatSendSurface";

/** The reviewed action sending a message is, on `CHAT_SEND_SURFACE`. */
export const CHAT_SEND_ACTION = "ChatSend";

/** The reviewed surface a message is edited from. */
export const CHAT_EDIT_SURFACE = "ChatEditSurface";

/** The reviewed action editing a message is, on `CHAT_EDIT_SURFACE`. */
export const CHAT_EDIT_ACTION = "ChatEdit";

/** The reviewed surface a message is deleted from. */
export const CHAT_DELETE_SURFACE = "ChatDeleteSurface";

/** The reviewed action deleting a message is, on `CHAT_DELETE_SURFACE`. */
export const CHAT_DELETE_ACTION = "ChatDelete";

/** The reviewed surface a message is obliterated from. */
export const CHAT_OBLITERATE_SURFACE = "ChatObliterateSurface";

/**
 * The reviewed action obliterating a message is, on
 * `CHAT_OBLITERATE_SURFACE`.
 */
export const CHAT_OBLITERATE_ACTION = "ChatObliterate";

/** The reviewed surface a reaction is added or removed from. */
export const CHAT_REACT_SURFACE = "ChatReactSurface";

/** The reviewed action adding a reaction is, on `CHAT_REACT_SURFACE`. */
export const CHAT_REACT_ACTION = "ChatReact";

/** The reviewed action removing a reaction is, on `CHAT_REACT_SURFACE`. */
export const CHAT_UNREACT_ACTION = "ChatUnreact";

/** The reviewed surface a conversation is started from. */
export const CHAT_START_SURFACE = "ChatStartSurface";

/** The reviewed action starting a conversation is, on `CHAT_START_SURFACE`. */
export const CHAT_START_ACTION = "ChatStart";

/** The reviewed surface a member is added to a room from. */
export const CHAT_ADD_MEMBER_SURFACE = "ChatAddMemberSurface";

/** The reviewed action adding a member is, on `CHAT_ADD_MEMBER_SURFACE`. */
export const CHAT_ADD_MEMBER_ACTION = "ChatAddMember";

//
// Principals
//

/** A `did:key` whose key is base58btc multibase, as every principal's is. */
const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Whether `value` is a DID a principal can have: well formed, and, for a
 * `did:key`, a base58btc key, so that a key a period or other punctuation
 * follows is refused.
 */
export const isPrincipalDID = (value: unknown): value is DID =>
  isWellFormedDID(value) &&
  (!value.startsWith("did:key:") || DID_KEY.test(value));

//
// Times
//

/** Nanoseconds in one millisecond, the handler clock's unit. */
export const NSEC_PER_MSEC = 1_000_000n;

/**
 * Nanoseconds in one tick of the handler clock. A handler's clock reads to the
 * second, so a reading `t` stands for every time from `t` up to, but not
 * including, `t + CLOCK_TICK_NSEC`.
 */
export const CLOCK_TICK_NSEC = 1_000_000_000n;

/** The nanoseconds a recorded time holds. */
export const nsecOf = (time: FabricEpochNsec): bigint => time.value;

/** A recorded time holding `nsec`. */
export const epochNsec = (nsec: bigint): FabricEpochNsec =>
  new FabricEpochNsec(nsec);

/** A span of `nsec` nanoseconds. */
export const durationNsec = (nsec: bigint): FabricDurationNsec =>
  new FabricDurationNsec(nsec);

/** A handler clock reading, in milliseconds, as a recorded time. */
export const epochNsecFromMsec = (msec: number): FabricEpochNsec =>
  epochNsec(BigInt(Math.floor(msec)) * NSEC_PER_MSEC);

/** Compares two recorded times, earliest first. */
export const compareTimes = (a: FabricEpochNsec, b: FabricEpochNsec): number =>
  nsecOf(a) < nsecOf(b) ? -1 : nsecOf(a) > nsecOf(b) ? 1 : 0;

//
// Profiles
//

/**
 * The part of a person's profile the room reads. It is a view of the person's
 * shared profile, reached through a link, and never a copy.
 */
export interface ChatProfile {
  /** The person's display name, if they have set one. */
  name?: string;

  /** The person's avatar: a URL or a glyph, if they have set one. */
  avatar?: string;
}

/** A live link to a person's profile. */
export type ProfileCell = Cell<ChatProfile>;

/**
 * The part of a person's profile a manager reads: what a room reads, and
 * where to offer the person a room. Only a manager reads the inbox pointer,
 * so the inbox's shape is part of no room's contract.
 */
export interface ChatManagerProfile extends ChatProfile {
  /**
   * Where the person's offers are delivered, as the profile types its pointer:
   * a link naming nothing of the inbox but its name. An inbox labels its
   * offers confidential to its owner, and a run reading the pointer as a link
   * to more of the inbox, or untyped, takes that label on, which then refuses
   * its sends.
   */
  inbox?: ProfileInbox;
}

/** A live link to a person's profile, as a manager reads it. */
export type ManagerProfileCell = Cell<ChatManagerProfile>;

//
// Room records
//

/** One version of a message: its body, and when the room recorded it. */
export interface ChatMessageVersion {
  /** The version's text. */
  body: string;

  /**
   * When the room recorded this version; in a send or an edit, the time the
   * sender proposes.
   */
  sentAt: FabricEpochNsec;
}

/** The body of a deleted or obliterated message. */
export interface ChatDeletedBody {
  /** Always `true`: the marker of a deleted message. */
  deleted: true;
}

/** Where a reply is shown. */
export type ChatReplyShownIn = "main" | "thread" | "both";

/** What a reply replies to, and where it is shown. */
export interface ChatReply {
  /** The message replied to, in the same room. */
  message: Cell<ChatMessage>;

  /** Where the reply is shown. */
  shownIn: ChatReplyShownIn;
}

/** One person's reaction to one message, with one emoji. */
export interface ChatReaction {
  /** The profile the reactor reacted under. */
  reactorProfile: ProfileCell;

  /** A single emoji. */
  emoji: string;

  /** When the room recorded the reaction. Unique in the room. */
  sentAt: FabricEpochNsec;
}

/** One message in a room, with its reactions and its edit history. */
export interface ChatMessage {
  /** The profile the sender sent under; absent once obliterated. */
  authorProfile?: ProfileCell;

  /** The current text, or the marker of a deleted message. */
  body: string | ChatDeletedBody;

  /** When the room recorded the message's first version. Unique in the room. */
  sentAt: FabricEpochNsec;

  /**
   * When the room recorded the current version, if it isn't the first: the
   * latest edit or deletion. Unique in the room.
   */
  editedAt?: FabricEpochNsec;

  /** The versions before the current one, oldest first. */
  earlierVersions: ChatMessageVersion[];

  /** What this message replies to, and where it is shown; absent for none. */
  replyTo?: ChatReply;

  /** Everyone's reactions to this message, in no particular order. */
  reactions: ChatReaction[];
}

/** A room's policy, stated correctly, with every key present. */
export interface ChatRoomPolicy {
  /** Whether an OWNER may obliterate messages. */
  ownersMayObliterate: boolean;

  /** Whether an edit or a plain deletion keeps the version it replaces. */
  keepsHistory: boolean;

  /** Whether a sender's deletion of their own message obliterates it. */
  deletionIsObliteration: boolean;

  /** How far before the room's clock a proposed time is accepted, in ns. */
  proposedTimeMaxAgeNsec: FabricDurationNsec;

  /** How far after the room's clock a proposed time is accepted, in ns. */
  proposedTimeMaxLeadNsec: FabricDurationNsec;

  /** How long an entry stays in `recentActivity`, in ns. */
  recentActivityWindowNsec: FabricDurationNsec;

  /** The most messages a message window holds. */
  maxWindowCount: number;

  /** The most message windows a session can have open. */
  maxOpenWindows: number;
}

/** The kind of room: how it was created, not how many members it has. */
export type ChatRoomKind = "direct" | "group";

/**
 * What a room's creator wrote about it, as it was created. A manager-created
 * room stores it labeled `authored-by` its creator, which is what
 * `principalOf(record, "authored-by")` reads.
 */
export interface AboutRecord {
  /** How the room was created. */
  kind: ChatRoomKind;

  /** A group room's title. */
  title?: string;

  /** When the room was created. */
  createdAt?: FabricEpochNsec;
}

/** What a room says about itself, set once when it is created. */
export interface ChatRoomAbout {
  /** `"direct"` if created as a direct room; `"group"` otherwise. */
  kind: ChatRoomKind;

  /** A group room's title. A direct room, and a space's own chat, have none. */
  title?: string;

  /** When the room was created; absent for a space's own chat. */
  createdAt?: FabricEpochNsec;

  /** The room's policy, stated correctly, in a document of its own. */
  policy: Cell<ChatRoomPolicy>;

  /**
   * The record the room's creator wrote, whose label names them; absent for a
   * space's own chat, which no one created as a room.
   */
  record?: Cell<AboutRecord>;
}

/** One entry in a room's log of recent activity. */
export interface ChatRoomActivity {
  /** The entry's place in the room's activity: 1, 2, 3, … with no gaps. */
  seq: number;

  /** When the room recorded it. Unique in the room. */
  at: FabricEpochNsec;

  /** The `requestId` of the event it records. */
  requestId: string;

  /** The message the event changed or added. */
  what: Cell<ChatMessage>;
}

/** Where a window of messages sits in its view. */
export type ChatWindowAnchor =
  | { before: FabricEpochNsec | "end" }
  | { after: FabricEpochNsec | "start" }
  | { around: FabricEpochNsec };

/**
 * A request that opens, moves, or closes a window. Opening names where the
 * window sits and how many messages it holds; closing names only the window.
 */
export interface WindowEvent {
  /** Chosen by the client; shown in the window once an open is fulfilled. */
  requestId: string;

  /** The window to set or close, chosen by the client. */
  windowId: string;

  /** The root of the thread to show; absent for the main conversation. */
  root?: Cell<ChatMessage>;

  /** Where the window sits; required to open one. */
  from?: ChatWindowAnchor;

  /** The most messages to show, capped by the room's `maxWindowCount`. */
  count?: number;
}

//
// Reaction tallies
//

/** How one emoji stands on one message. */
export interface ChatReactionTally {
  /** The emoji. */
  emoji: string;

  /** How many people reacted with it. */
  count: number;

  /** Whether the viewer is one of them. */
  mine: boolean;

  /** Their profiles, in the order they reacted. */
  reactors: ProfileCell[];
}

/**
 * The emoji `reactions` hold, in the order each was first used, each with the
 * profiles that used it. A reaction is the viewer's when its profile is
 * `viewer`, compared with `equals()`.
 */
export const reactionTalliesOf = (
  reactions: readonly ChatReaction[],
  viewer: ProfileCell | undefined,
): ChatReactionTally[] => {
  const ordered = [...reactions]
    .filter((reaction) => reaction?.sentAt !== undefined)
    .sort((a, b) => compareTimes(a.sentAt, b.sentAt));
  const emoji = ordered.reduce<string[]>(
    (found, reaction) =>
      found.includes(reaction.emoji) ? found : [...found, reaction.emoji],
    [],
  );
  return emoji.map((each) => {
    const onThis = ordered.filter((reaction) => reaction.emoji === each);
    return {
      emoji: each,
      count: onThis.length,
      mine: viewer !== undefined &&
        onThis.some((reaction) => equals(reaction.reactorProfile, viewer)),
      reactors: onThis.map((reaction) => reaction.reactorProfile),
    };
  });
};

//
// Manager records
//

/**
 * A room as a manager links it: only the part of `ChatRoomOutput` the manager
 * reads through the link. The manager runs in its user's home, not in the
 * room's space, and a server running it reads only the documents the room's
 * space shares with every member, never the ones each member has of their
 * own. A served handler whose declared reads reach one of those never runs,
 * and the link's schema is part of every manager handler's declared reads.
 *
 * So the link carries what the room's space shares with every member and
 * costs little to read: what the room says about itself, and how many
 * messages it holds and when the newest was sent, which the room derives from
 * its messages alone. It leaves out the rest of the room's data face. A
 * room's `canSend` is decided per reader, from their own profile, and its
 * `messages.windows` are each session's own, so both reach documents of a
 * member's own, as the room's rendering does. Its `messages.latest` is
 * shared, but holds up to `maxWindowCount` messages and their reactions, which
 * every manager handler would then load for every room; a reader that wants
 * the messages reads them through the room. The rendering is not part of the
 * link either, and `cf-render` still draws the room through it, since a render
 * reads the rendering whatever the link declares.
 */
export interface ChatRoomLink {
  /** What the room says about itself. */
  about?: ChatRoomAbout;

  /** Where the conversation stands: what of `messages` every member shares. */
  messages?: {
    /** How many messages the room holds, obliterated tombstones included. */
    count: number;

    /** The newest message's `sentAt`; absent while there are none. */
    newestAt?: FabricEpochNsec;
  };
}

/** One room in a user's chat manager. */
export interface ChatIndexEntry {
  /** The room. */
  room: Cell<ChatRoomLink>;

  /** The room's kind, as its `about.kind` says. */
  kind: ChatRoomKind;

  /** A direct room's other member, by principal. */
  counterpart?: string;

  /** When this user's index admitted it. */
  since: FabricEpochNsec;

  /**
   * The revision of the room's entry in the user's index, as listed, which a
   * request to forget the room names; absent where the entry is not one the
   * index keeps revisions of.
   */
  revision?: string;
}

/** The outcome of a manager request. */
export type ChatRequestOutcome =
  | {
    /** The request has not finished. */
    status: "pending";
  }
  | {
    /** The request finished. */
    status: "done";

    /** The entry it produced; absent for `forget`. */
    entry?: ChatIndexEntry;
  }
  | {
    /** The request was refused. */
    status: "refused";

    /** Why. */
    reason: string;
  };

/**
 * The `kind` of a room, as its offer to a member's share inbox names it and
 * as a user's shared-space catalog records it.
 */
export const CHAT_ROOM_OFFER_KIND = "fabrichat-room";

/** A notice a manager's request produced, for a client to deliver. */
export interface ChatManagerNotice {
  /** The notice's id, unique in the manager. */
  id: string;

  /** The room the recipient was admitted to. */
  room: Cell<ChatRoomLink>;

  /** The DID of the person admitted. */
  recipient: string;
}

//
// Displays
//

/**
 * What a FabriChat element shown or hidden by a prop has as its `display`,
 * which a computed decides. Such an element also carries a static `hidden`,
 * which keeps it out of view until the computed has a value and which only a
 * concrete display outranks, so every shown state names one: a computed
 * returning `""`, `undefined` or `null` to show its element would leave it
 * hidden for good.
 */
export type ChatDisplay = "block" | "flex" | "inline-flex" | "none";
