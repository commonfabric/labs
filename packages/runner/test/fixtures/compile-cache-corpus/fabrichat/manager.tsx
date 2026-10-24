/**
 * `FabriChatManager`: a user's index of the rooms they belong to, an
 * implementation of `ChatManagerOutput` (`docs/specs/fabrichat/`). It lives in
 * the user's home space, where `#chatManager` finds it, so everything it holds
 * is private to its user.
 *
 * The user's shared-space catalog supplies standalone rooms at their roots
 * and container conversations through each root's explicit `chatRoom` link.
 * `roomMembership` keeps choices about individual conversations, independently
 * of the catalog's membership of their containers. Resolved room identity
 * deduplicates every discovery path. Forgetting a container conversation
 * archives only that conversation; accepting or joining it restores it.
 *
 * It creates each room with `inSpace()` as the root of a space of its own,
 * which declares itself a `fabrichat-room`. The space grants the room's
 * creator and each other member named at creation OWNER, and no one else,
 * except that a group made joinable by its link grants everyone WRITE as well.
 * After that, who is in the space is the space's business: any OWNER may add
 * someone from the room's own rendering, and the manager never changes it.
 *
 * The room keeps its space's participants itself, and the manager adds its
 * user to them when it creates, accepts, or joins a room.
 *
 * A new room is offered to each other member whose profile the request names,
 * through each share inbox their profiles point at, once per inbox, in the
 * envelope a share inbox takes, and each member it is offered to is added to
 * the room's participants. A notice is queued for each other member offered
 * nothing: one the request names only by principal, or whose profiles point at
 * no inbox. A member someone adds to a room later, from the room, is offered
 * it the same way, through `offerRoom`. A direct room's counterpart who got a
 * notice instead is offered the room the same way once a later start with
 * them names a profile of theirs pointing at an inbox, until they join it, and
 * the notice is withdrawn.
 *
 * The people the user's rooms list, each by the principal their profile
 * attests, are what the manager's rendering offers to name a new group's
 * members by, so that each is offered the group, and what a member added by
 * principal alone is offered a room through.
 */
import {
  type Cell,
  computed,
  currentPrincipal,
  debugStr,
  type Default,
  type DID,
  equals,
  eventKey,
  getPatternEnvironment,
  handler,
  type InSpaceGrants,
  isWellFormedDID,
  NAME,
  pattern,
  type PerSession,
  principalOf,
  spaceAccess,
  spaceOf,
  Stream,
  UI,
  VIEWS,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  OFFER_ID_MAX_LENGTH,
  OFFER_TITLE_MAX_LENGTH,
  type OfferEvent,
  type PrivateInboxOutput,
} from "../system/private-inbox.tsx";
import type { ShareInboxPiece } from "../system/profile-home.tsx";
import {
  changeSharedSpaceMembershipIn,
  isSharedSpaceCatalog,
  readSharedSpaceCatalog,
  registerSharedSpaceIn,
  retitleSharedSpaceIn,
  type SharedSpaceCatalogStorage,
  type SharedSpaceEntry,
} from "../system/shared-space-catalog.ts";
import { entityKeyOf, listsRoomIn } from "./room-records.tsx";
import FabriChatRoom from "./room.tsx";
import {
  type AboutRecord,
  CHAT_ROOM_OFFER_KIND,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatContainer,
  type ChatDisplay,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatManagerProfile,
  type ChatOfferDelivery,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomKind,
  type ChatRoomLink,
  epochNsecFromMsec,
  isPrincipalDID,
  type ManagerProfileCell,
  nsecOf,
} from "./schemas.tsx";

/**
 * A user's shared-space catalog, which lists the rooms they belong to among
 * the other social spaces they keep.
 */
export type CatalogCell = Writable<
  | SharedSpaceCatalogStorage
  | Default<
    { entries: Record<PropertyKey, never>; offers: Record<PropertyKey, never> }
  >
>;

/** The direct room shared with each counterpart, by principal. */
export type DirectCell = Writable<
  Record<string, ChatIndexEntry> | Default<Record<PropertyKey, never>>
>;

/** A room's membership, independent of its container's catalog entry. */
export interface RoomMembership extends ChatIndexEntry {
  /** The root declaring a conversation joined through a container. */
  container?: Cell<ChatContainer>;

  /** Whether the user keeps the conversation in their chats. */
  state: "saved" | "archived";

  /** The event that last changed membership. */
  revision: string;

  /** A standalone catalog revision, which keeps the catalog authoritative. */
  catalogRevision?: string;
}

/** Explicit membership choices, compared by resolved room identity. */
export type RoomMembershipCell = Writable<RoomMembership[] | Default<[]>>;

/**
 * Applies standalone catalog choices to room records, including a removed
 * catalog entry. Container membership keeps its own state and revision.
 */
const effectiveMemberships = (
  memberships: readonly RoomMembership[],
  entries: Record<string, SharedSpaceEntry>,
): RoomMembership[] =>
  memberships.map((membership): RoomMembership => {
    const entry = entries[spaceOf(membership.room) ?? ""];
    const standalone = entry?.kind === CHAT_ROOM_OFFER_KIND;
    if (
      !standalone && membership.catalogRevision === undefined
    ) return membership;
    return {
      ...membership,
      state: standalone && entry.state === "saved" ? "saved" : "archived",
      revision: standalone ? entry.revision : membership.revision,
      catalogRevision: standalone ? entry.revision : membership.catalogRevision,
    };
  });

/** Each request's outcome, by its `requestId`. */
export type RequestsCell = Writable<
  Record<string, ChatRequestOutcome> | Default<Record<PropertyKey, never>>
>;

/** Notices waiting for a client to deliver them. */
export type NoticesCell = Writable<ChatManagerNotice[] | Default<[]>>;

/**
 * Every act the manager performs, each bound to one of its streams: a start by
 * `commitStart`, and every other act by `commitManager`.
 */
export type ManagerAct =
  | "openDirect"
  | "createGroup"
  | "offerRoom"
  | "accept"
  | "joinRoom"
  | "forget"
  | "delivered";

/** Whether `act` starts a chat. */
const isStart = (act: ManagerAct): boolean =>
  act === "openDirect" || act === "createGroup";

/**
 * An event on one of the manager's streams. Each stream's event carries the
 * fields its act needs. A rendered control sends no request id, which the
 * manager then mints, and either the text it holds, as `target.value`, or, for
 * a control that starts a direct room with one person, that person's profile,
 * bound as the control's `name`, as `target.name`. A chip a room rendered
 * before its control named a profile names the person's principal instead, as
 * `target.dataset.counterpart`.
 */
export interface ManagerStreamEvent {
  /**
   * Chosen by the sender; the outcome is recorded under it, except for a start
   * that would create a room without its reviewed `ChatStart`, which is
   * refused whole and records none.
   */
  requestId?: string;

  /** The DID of a direct room's other member. */
  counterpart?: string;

  /** The DID of a member added to a room, whom `offerRoom` offers it to. */
  member?: string;

  /**
   * A direct room's other member's profile, through whose share inbox a new
   * room, or a found one that was offered them nothing, is offered to them, or
   * the profile of a member added to a room, through whose share inbox
   * `offerRoom` offers it.
   */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  profile?: Cell<ChatManagerProfile>;

  /** The DIDs of a new group room's other members. */
  members?: string[];

  /**
   * The profiles of more of a new group room's other members, each naming its
   * member with its `represents-principal` label, through whose share inbox
   * the room is offered to them.
   */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  profiles?: Cell<ChatManagerProfile>[];

  /** A new group room's title. */
  title?: string;

  /**
   * Whether a new group room admits anyone who has its link; absent for a room
   * admitting its members alone.
   */
  joinableByLink?: boolean;

  /** A room to offer, accept, join, or forget. */
  room?: Cell<ChatRoomLink>;

  /** The container whose explicit `chatRoom` declaration names the room. */
  container?: Cell<ChatContainer>;

  /**
   * Whether a `joinRoom` comes from a message or a reaction the user sent in
   * the room, which leaves the title the catalog lists an already listed room
   * under as it is.
   */
  messageAct?: boolean;

  /**
   * Whether accepting a room leaves its entry archived, when it is; absent,
   * accepting the room restores it.
   */
  keepArchived?: boolean;

  /** The id of a notice delivered. */
  id?: string;

  /**
   * The revision of a room's entry, as the list the request was made from
   * showed it, for a room to forget.
   */
  revision?: string;

  /** A rendered control's text, or the profile it starts a direct room with. */
  readonly target?: {
    readonly value?: string;

    /** The profile of the person a participant's chip starts a chat with. */
    // `Cell<…>` is written out rather than reached through an alias: the
    // event's schema marks a reference position only where the wrapper is
    // written in the event type.
    readonly name?: Cell<ChatManagerProfile>;

    /** The principal an older room's chip names the person by. */
    readonly dataset?: { readonly counterpart?: string };
  };
}

/** A group room being composed in the manager's own rendering. */
export interface GroupDraft {
  /** The room's title. */
  title: string;

  /** The other members' DIDs, one per line or separated by spaces. */
  members: string;

  /**
   * The profiles of more of the other members, picked from the people the
   * user's rooms list; absent for none.
   */
  picked?: Cell<ChatManagerProfile>[];

  /** Whether the room admits anyone who has its link. */
  joinableByLink: boolean;
}

/** An empty group draft. */
const EMPTY_DRAFT = {
  title: "",
  members: "",
  picked: [],
  joinableByLink: false,
} satisfies GroupDraft;

/** The manager's records, and a rendered control's bindings. */
export interface ManagerActState {
  /** The act this binding performs. */
  act: ManagerAct;

  /** The user's profile, which holds no value until it resolves. */
  myProfile: ManagerProfileCell | undefined;

  /** The user's shared-space catalog, which supplies room discovery. */
  catalog: CatalogCell;

  /** Explicit room membership, independent of container membership. */
  roomMembership: RoomMembershipCell;

  /** The direct room shared with each counterpart. */
  direct: DirectCell;

  /** Each request's outcome. */
  requests: RequestsCell;

  /** Notices waiting for a client to deliver them. */
  outgoingNotices: NoticesCell;

  /** Offers a newly created room to the members a request named profiles of. */
  offerRooms: Stream<OfferRoomEvent>;

  /** Adds this user's profile to a room's participants. */
  joinRooms: Stream<JoinRoomsEvent>;

  /**
   * The people this user's rooms list, through whose profiles `offerRoom`
   * offers a room to a member it names by principal alone; absent for every
   * other act.
   */
  people?: PerSession<Record<string, readonly ManagerProfileCell[]>>;

  /** The session's group draft, which a rendered create reads. */
  draft: Writable<GroupDraft>;

  /**
   * Why the session's latest start was refused, which the rendering shows;
   * empty when it wasn't refused.
   */
  startRefusal: Writable<string>;

  /** Whether this binding creates a group from `draft`. */
  fromDraft?: boolean;

  /** A rendered control's room. */
  room?: Cell<ChatRoomLink>;

  /** The container whose explicit `chatRoom` declaration names the room. */
  container?: Cell<ChatContainer>;

  /** A rendered control's notice id. */
  id?: string;

  /** A rendered control's room's revision, as its row shows it. */
  revision?: string;
}

/** The DIDs in `text`, separated by spaces, commas, or lines. */
const principalsIn = (text: string): string[] =>
  text.split(/[\s,]+/).filter((part) => part !== "");

/**
 * A member a request names by profile, with the principal the profile's
 * `represents-principal` label attests; absent when it attests none.
 */
interface NamedMember {
  /** The member's profile. */
  profile: Cell<ChatManagerProfile>;

  /** The principal the profile attests. */
  recipient?: string;
}

/** `members`, without duplicates, `self`, or anything but a DID. */
const otherMembers = (
  members: readonly unknown[],
  self: string,
): DID[] =>
  members.reduce<DID[]>(
    (found, member) =>
      isPrincipalDID(member) && member !== self && !found.includes(member)
        ? [...found, member]
        : found,
    [],
  );

/**
 * Records a request's outcome. A `done` or `refused` outcome is kept for as
 * long as the manager exists. A start's outcome also replaces what the
 * session's rendering says about its latest start: `shown` or the reason for
 * a refusal, and nothing for a start that is done.
 */
const recordOutcome = (
  state: ManagerActState,
  requestId: string,
  outcome: ChatRequestOutcome,
  shown?: string,
): void => {
  state.requests.key(requestId).set(outcome);
  if (isStart(state.act)) {
    state.startRefusal.set(
      outcome.status === "refused" ? shown ?? outcome.reason : "",
    );
  }
};

/** The origin of the host serving this pattern, and so the rooms it creates. */
const hostOrigin = (): string => new URL(getPatternEnvironment().apiUrl).origin;

/**
 * Brings the title registered with the listed room in `space` up to `title`,
 * the room's own, cut to the length an offer's may run to. The catalog is
 * written only where the two differ, and the entry's membership and revision
 * stay as they are. A room with no title leaves the entry's as it is, and so
 * does an entry of any kind but a room's: a container's entry names the
 * container, whatever chat it declares.
 */
const refreshListedTitle = (
  catalog: CatalogCell,
  space: DID,
  title: string | undefined,
): void => {
  if (title === undefined) return;
  const entry = readSharedSpaceCatalog(catalog).entries[space];
  if (entry?.kind !== CHAT_ROOM_OFFER_KIND) return;
  retitleSharedSpaceIn(catalog, {
    space,
    title: title.slice(0, OFFER_TITLE_MAX_LENGTH),
  });
};

/**
 * Lists the room in `space` in the user's catalog: registers the space, or
 * restores its entry when the entry is archived, unless `restore` is false.
 * An entry in any other state keeps its membership. The room's title, cut to
 * the length an offer's may run to, is registered with it, or replaces the
 * one an existing entry holds, as `refreshListedTitle` says.
 */
const listRoom = (
  catalog: CatalogCell,
  space: DID,
  { title, since, restore = true }: {
    title?: string;
    since?: number;
    restore?: boolean;
  } = {},
): void => {
  const entry = readSharedSpaceCatalog(catalog).entries[space];
  if (entry === undefined) {
    // The host registered is this pattern's own, which serves each room this
    // manager creates. A room it accepts is registered under it as well,
    // since a pattern can't read which host serves a space, and a room
    // another host serves is then registered under the wrong one.
    // TODO(danfuzz): Register an accepted room under the host that serves
    // its space, once a pattern can read it.
    registerSharedSpaceIn(catalog, {
      space,
      host: hostOrigin(),
      kind: CHAT_ROOM_OFFER_KIND,
      ...(title === undefined
        ? {}
        : { title: title.slice(0, OFFER_TITLE_MAX_LENGTH) }),
      ...(since === undefined ? {} : { since }),
    });
    return;
  }
  refreshListedTitle(catalog, space, title);
  if (entry.state === "archived" && restore) {
    // The restore names the revision this run just read, since no list was
    // shown to observe one: the request, to start a chat or to accept a room,
    // is the person's choice to have the room listed whatever its archive
    // state. The read is in this transaction's reads, so a membership change
    // committed meanwhile conflicts the commit, and on the re-run the restore
    // wins over it, an archive from another device included, by choice: the
    // person has just asked to open or accept the room.
    changeSharedSpaceMembershipIn(catalog, {
      space,
      id: eventKey(),
      expectedRevision: entry.revision,
      state: "saved",
    });
  }
};

/**
 * A share inbox a profile's pointer reaches, as the cell of its result, whose
 * `receive` takes an offer. The pointer is typed as a link naming the piece
 * alone, and a link's target is reached as a cell.
 */
function inboxOf(
  pointer: Cell<ShareInboxPiece>,
): Cell<Pick<PrivateInboxOutput, "receive">>;
function inboxOf(pointer: Cell<ShareInboxPiece>): unknown {
  return pointer;
}

/**
 * The notice telling `recipient` of `room`, which the request `requestId`
 * created, keyed so that each request has at most one per recipient.
 */
const noticeFor = (
  recipient: string,
  requestId: string,
  room: Cell<ChatRoomLink>,
): ChatManagerNotice => ({
  id: JSON.stringify([recipient, requestId]),
  room,
  recipient,
});

/** A member a room is offered to. */
export interface OfferedMember {
  /** The member's DID. */
  recipient: string;

  /**
   * The member's profiles, through whose share inboxes the room is offered,
   * each inbox once.
   */
  profiles: Cell<ChatManagerProfile>[];
}

/** What offering a new room asks: the room, and whom to offer it to. */
export interface OfferRoomEvent {
  /** The room offered. */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  room: Cell<ChatRoomLink>;

  /** The id of the request that created the room, which keys the offer. */
  id: string;

  /** A group room's title, or empty for a direct room. */
  title: string;

  /** The members to offer it to. */
  members: OfferedMember[];
}

/** What `offerRooms` is bound to. */
interface OfferRoomsState {
  /** Notices waiting for a client to deliver them. */
  outgoingNotices: NoticesCell;

  /** Adds a profile to a room's participants. */
  joinRooms: Stream<JoinRoomsEvent>;
}

/** The share inbox `profile` points at; absent when it points at none. */
const inboxPointerOf = (
  profile: Cell<ChatManagerProfile> | undefined,
): Cell<ShareInboxPiece> | undefined =>
  // The pointer is read through its parent: a link-typed field read on its
  // own is a cell whether or not anything is stored there.
  profile?.key("inbox").get()?.piece;

/** A share inbox, and the first of a member's profiles pointing at it. */
interface ProfileInboxEntry {
  /** The inbox, as the profile points at it. */
  pointer: Cell<ShareInboxPiece>;

  /** The profile. */
  profile: Cell<ChatManagerProfile>;
}

/**
 * The share inboxes `profiles` point at, each once, in the order of the first
 * profile pointing at each, with that profile. A profile pointing at no inbox
 * is left out.
 */
const distinctInboxes = (
  profiles: readonly Cell<ChatManagerProfile>[],
): ProfileInboxEntry[] =>
  profiles.reduce<ProfileInboxEntry[]>((found, profile) => {
    const pointer = inboxPointerOf(profile);
    return pointer === undefined ||
        found.some((known) => equals(known.pointer, pointer))
      ? found
      : [...found, { pointer, profile }];
  }, []);

/** An offer of a room, which its `id` keys. */
type RoomOffer = OfferEvent & { id: string };

/**
 * The offer of the room in `space` that a share inbox takes, keyed by `id`,
 * from `from`, naming the host serving the room, this pattern's own.
 */
const offerEnvelope = (
  id: string,
  space: DID,
  title: string,
  from: string,
): RoomOffer => {
  const origin = hostOrigin();
  return {
    kind: CHAT_ROOM_OFFER_KIND,
    id,
    space,
    host: origin,
    ownerOrigin: origin,
    title: title.slice(0, OFFER_TITLE_MAX_LENGTH),
    from,
    sharedAt: Date.now(),
  };
};

/**
 * Helper for `offerRooms` and `offerRoom`, which offers `room` to `member`,
 * sending `offer` to each distinct share inbox their profiles point at, and
 * adds to the room's participants the first profile it offered the room
 * through, so that the member is listed once however many inboxes they have.
 * A member whose profiles point at no inbox is offered nothing, and a notice
 * for them, keyed by the offer's `id`, is queued instead. Returns which of the
 * two it did.
 */
const offerToMember = (
  offer: RoomOffer,
  room: Cell<ChatRoomLink>,
  { recipient, profiles }: OfferedMember,
  { outgoingNotices, joinRooms }: OfferRoomsState,
): ChatOfferDelivery => {
  const inboxes = distinctInboxes(profiles ?? []);
  if (inboxes.length === 0) {
    outgoingNotices.push(noticeFor(recipient, offer.id, room));
    return "noticed";
  }
  for (const { pointer } of inboxes) {
    inboxOf(pointer.resolveAsCell()).key("receive").send(offer);
  }
  joinRooms.send({ room, profile: inboxes[0].profile });
  return "offered";
};

/**
 * Offers a room to each of the event's `members`, as `offerToMember()` does,
 * naming the principal sending it as its sender.
 *
 * It runs as an event of its own, queued by the one that creates the room, so
 * that it reads the room's space once the room's creation has committed, and
 * the members' profiles are read apart from that creation. While the space is
 * not known, nothing is sent.
 */
const offerRooms = handler<OfferRoomEvent, OfferRoomsState>(
  (event, state) => {
    const space = spaceOf(event?.room);
    const from = currentPrincipal();
    if (!isWellFormedDID(space) || from === undefined) return;
    const offer = offerEnvelope(event.id, space, event.title ?? "", from);
    for (const member of event.members ?? []) {
      offerToMember(offer, event.room, member, state);
    }
  },
);

/** What joining a room asks: the room, and the profile to join it as. */
export interface JoinRoomsEvent {
  /** The room to join. */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  room: Cell<ChatRoomLink>;

  /** This user's profile. */
  profile: Cell<ChatProfile>;
}

/** The room's stream that adds a profile to its participants. */
function joinStreamOf(
  room: Cell<ChatRoomLink>,
): Cell<{ addParticipant: Stream<{ profile: Cell<ChatProfile> }> }>;
function joinStreamOf(room: Cell<ChatRoomLink>): unknown {
  return room;
}

/**
 * Adds the event's profile to the room's participants, through the room's own
 * `addParticipant`, the one writer its roster admits, so that whoever creates
 * or accepts a room, and each member it is offered to, is listed in it without
 * a step of their own. It runs as an event of its own, queued by the one that
 * creates, accepts, or offers the room, so that the room's streams exist when
 * it sends. A profile that hasn't resolved is added to nothing.
 */
const joinRooms = handler<JoinRoomsEvent, Record<PropertyKey, never>>(
  (event) => {
    // TODO(danfuzz): A stop-gap. A member offered nothing, whose manager
    // neither created nor accepted the room, is never sent here, so isn't on
    // the room's roster, and is shown among its participants only as an
    // author, once they write. Add each member once their manager lists the
    // room without a step of their own.
    const profile = event?.profile?.resolveAsCell();
    if (profile === undefined || profile.get() === undefined) return;
    joinStreamOf(event.room).key("addParticipant").send({ profile });
  },
);

/**
 * A room's result, as the link an index entry holds. The room is created
 * where the link can't be typed as a cell, and stored as a link to it.
 */
function roomLinkOf(room: unknown): Cell<ChatRoomLink>;
function roomLinkOf(room: unknown): unknown {
  return room;
}

/**
 * The record a room's creator wrote, which the room's `about` links, as a
 * cell: what `principalOf()` reads the creator from, and what reads without
 * the room running. It holds nothing for a space's own chat.
 */
function aboutRecordOf(room: Cell<ChatRoomLink>): Cell<AboutRecord>;
function aboutRecordOf(room: Cell<ChatRoomLink>): unknown {
  return room.key("about").key("record");
}

/** How a room `createRoom()` makes differs by its kind. */
interface RoomOptions {
  /** A group room's title. */
  title?: string;

  /** A direct room's other member. */
  counterpart?: string;

  /**
   * Whether the room's space admits anyone with its link, with WRITE: its
   * address is then all that keeps it private.
   */
  joinableByLink?: boolean;

  /** The other members to offer the room to. */
  offerTo?: readonly OfferedMember[];
}

/**
 * Creates a room in a space of its own, as the space's root, and its notices,
 * records its entry, and registers its space in the user's catalog, all in one
 * transaction: the space's grants and its declared kind are part of creating
 * it, so nothing has to commit apart. A notice for each other member not in
 * `offerTo` is queued for a client to deliver, and adding this user to the
 * room's participants, and offering the room to each member in `offerTo`, are
 * queued to follow.
 *
 * The space's name is pending on the first run, which the runtime discards and
 * runs again with the name resolved. Nothing is registered or sent until the
 * name resolves, since a discarded run's sends may still be delivered.
 */
const createRoom = (
  state: ManagerActState,
  requestId: string,
  kind: ChatRoomKind,
  members: readonly DID[],
  { title, counterpart, joinableByLink = false, offerTo = [] }: RoomOptions =
    {},
): ChatIndexEntry => {
  const now = Date.now();
  const createdAt = epochNsecFromMsec(now);
  // The room's space grants this user and each other member OWNER, so any
  // member can add others, and, for a room joinable by its link, everyone
  // WRITE.
  const grants = Object.fromEntries([
    ...members.map((member) => [member, "OWNER"]),
    ...(joinableByLink ? [["*", "WRITE"]] : []),
  ]) as InSpaceGrants;
  const room = roomLinkOf(
    FabriChatRoom.inSpace(undefined, {
      grants,
      root: true,
      spaceKind: CHAT_ROOM_OFFER_KIND,
    })({
      about: {
        kind,
        createdAt,
        ...(title === undefined ? {} : { title }),
      },
    }),
  );
  // A member offered the room has a notice only if the offer can't be sent,
  // which `offerRooms` decides, since that reads their profile.
  const offered = offerTo.map(({ recipient }) => recipient);
  members.filter((member) => !offered.includes(member)).forEach(
    (recipient) => {
      state.outgoingNotices.push(noticeFor(recipient, requestId, room));
    },
  );
  const space = spaceOf(room);
  if (isWellFormedDID(space)) {
    listRoom(state.catalog, space, { title, since: now });
    if (state.myProfile !== undefined) {
      state.joinRooms.send({ room, profile: state.myProfile });
    }
    if (offerTo.length > 0) {
      state.offerRooms.send({
        room,
        id: requestId,
        title: title ?? "",
        members: [...offerTo],
      });
    }
  }
  return {
    room,
    kind,
    ...(counterpart === undefined ? {} : { counterpart }),
    since: createdAt,
  };
};

/**
 * Helper for `openDirect`, which offers `room`, a direct room it found, to
 * `counterpart` through the share inbox `profile` points at, as `offerRooms`
 * offers a new one, when the room was offered them nothing: a notice for them
 * of the room is still waiting. The offer replaces each such notice, so they
 * are withdrawn. A counterpart the room's roster lists has joined the room
 * already, and is offered nothing, and so is one whose profile points at no
 * inbox, whose notice stays. So does the notice when `requestId`, which keys
 * the offer, is longer than a share inbox keeps an offer's `id`, since the
 * inbox would cut it short and could take it for another's.
 */
const reofferDirect = (
  state: ManagerActState,
  requestId: string,
  room: Cell<ChatRoomLink>,
  counterpart: string,
  profile: Cell<ChatManagerProfile> | undefined,
): void => {
  const notices = state.outgoingNotices.get() ?? [];
  const waiting = notices.filter((notice) =>
    notice.recipient === counterpart && equals(notice.room, room)
  );
  if (waiting.length === 0 || requestId.length > OFFER_ID_MAX_LENGTH) return;
  if (profile === undefined || inboxPointerOf(profile) === undefined) return;
  const joined = (room.key("roster").get() ?? []).some((member) =>
    principalOf(member, "represents-principal") === counterpart
  );
  const space = spaceOf(room);
  const from = currentPrincipal();
  if (joined || !isWellFormedDID(space) || from === undefined) return;
  state.outgoingNotices.set(
    notices.filter((notice) => !waiting.includes(notice)),
  );
  offerToMember(
    offerEnvelope(requestId, space, "", from),
    room,
    { recipient: counterpart, profiles: [profile] },
    state,
  );
};

/**
 * Performs one manager act: finding or creating a direct room, creating a
 * group room, offering a room to a member added to it, accepting a room,
 * forgetting one, or reporting a notice delivered. Each act's outcome is
 * recorded under its `requestId`, and a request already decided changes
 * nothing. A start that creates a room commits
 * only from `commitStart` under a reviewed `ChatStart`; without one, its run
 * is refused whole, and it records no outcome.
 */
const performManagerAct = (
  event: ManagerStreamEvent | undefined,
  state: ManagerActState,
): void => {
  const { act, catalog, direct, requests, outgoingNotices } = state;
  const requestId = event?.requestId ?? eventKey();
  const earlier = requests.key(requestId).get();
  if (earlier !== undefined && earlier.status !== "pending") return;
  const typed = event?.target?.value?.trim();

  // A chat is started by someone who can take part in it, and taking part
  // needs a profile.
  if (
    isStart(act) &&
    state.myProfile?.get() === undefined
  ) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: "Starting a chat needs a profile.",
    });
    return;
  }
  if (act === "delivered") {
    const id = event?.id ?? state.id;
    // An event's type doesn't refuse an event that lacks a field it requires,
    // so each act refuses the request itself, where a rendered control's
    // binding doesn't supply the field.
    if (typeof id !== "string") {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The request names no notice.",
      });
      return;
    }
    outgoingNotices.set(
      ((outgoingNotices.get() ?? []) as ChatManagerNotice[]).filter((
        notice,
      ) => notice.id !== id),
    );
    return;
  }

  // A start needs to know who this user is, to leave them out of the
  // room's other members.
  const self = currentPrincipal();
  if (isStart(act) && self === undefined) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: "Starting a chat needs a signed-in user.",
    });
    return;
  }

  if (act === "openDirect") {
    // A participant's chip names the person by their profile, which says
    // whose it is with its `represents-principal` label. A `name` attesting
    // no principal names no one, so it is offered nothing either.
    const named = event?.target?.name;
    const namedPrincipal = named === undefined
      ? undefined
      : principalOf(named, "represents-principal");
    // A chip a room rendered before its control named a profile names the
    // person by principal. Such a start finds or creates the room, but offers
    // it to no one, since it carries no profile.
    // TODO(danfuzz): Stop reading `target.dataset.counterpart` once no
    // deployed room renders a chip that sends it, and record the contract
    // break that removing the field from the event's type is.
    const counterpart = event?.counterpart ?? namedPrincipal ??
      event?.target?.dataset?.counterpart ?? typed;
    if (!isPrincipalDID(counterpart)) {
      const reason = "The counterpart is not a principal.";
      // The session is shown the text it sent, which says what is wrong
      // with it. The recorded reason is kept for as long as the manager
      // exists, so it holds no text a person typed.
      recordOutcome(
        state,
        requestId,
        { status: "refused", reason },
        counterpart === undefined || counterpart === ""
          ? undefined
          : debugStr`${reason} Received: $long${counterpart}`,
      );
      return;
    }
    if (counterpart === self) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The counterpart is this user.",
      });
      return;
    }
    // The room is offered through the profile's inbox, so the profile has to
    // be the counterpart's own.
    const profile = event?.profile ??
      (namedPrincipal === undefined ? undefined : named);
    if (
      profile !== undefined &&
      principalOf(profile, "represents-principal") !== counterpart
    ) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The profile is not the counterpart's.",
      });
      return;
    }
    const known = direct.key(counterpart).get();
    if (known !== undefined) {
      // Restores an archived entry at the revision just read, as `listRoom`
      // says: starting the chat is the choice to have it listed.
      const knownSpace = spaceOf(known.room);
      if (isWellFormedDID(knownSpace)) listRoom(catalog, knownSpace);
      const memberships = state.roomMembership.get() ?? [];
      if (
        memberships.some((entry) =>
          equals(entry.room, known.room) && entry.state === "archived"
        )
      ) {
        state.roomMembership.set(
          memberships.map((entry) =>
            equals(entry.room, known.room)
              ? {
                ...entry,
                state: "saved",
                revision:
                  readSharedSpaceCatalog(catalog).entries[knownSpace ?? ""]
                    ?.revision ?? eventKey(),
              }
              : entry
          ),
        );
      }
      reofferDirect(state, requestId, known.room, counterpart, profile);
      recordOutcome(state, requestId, { status: "done", entry: known });
      return;
    }
    const entry = createRoom(state, requestId, "direct", [counterpart], {
      counterpart,
      offerTo: profile === undefined ? [] : [{
        recipient: counterpart,
        profiles: [profile],
      }],
    });
    direct.key(counterpart).set(entry);
    recordOutcome(state, requestId, { status: "done", entry });
    return;
  }

  if (act === "createGroup") {
    const draft = state.fromDraft === true ? state.draft.get() : undefined;
    const title = (event?.title ?? draft?.title ?? "").trim();
    if (title === "") {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "A group room needs a title.",
      });
      return;
    }
    if (draft === undefined && !Array.isArray(event?.members)) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "A group's members must be listed.",
      });
      return;
    }
    const listed = event?.members ?? principalsIn(draft?.members ?? "");
    const notPrincipals = listed.filter((member) => !isPrincipalDID(member));
    if (notPrincipals.length > 0) {
      const reason = "A group's members must be principals.";
      // As for a direct room, the session is shown what it sent that isn't
      // one, and the recorded reason holds no text a person typed.
      recordOutcome(
        state,
        requestId,
        { status: "refused", reason },
        debugStr`${reason} Received: $long${notPrincipals}`,
      );
      return;
    }
    // A member named by profile, the event's or else the draft's, is the
    // principal the profile attests, so a profile attesting none names no
    // one, and is refused rather than left out.
    const named = (event?.profiles ?? draft?.picked ?? []).map((
      profile,
    ): NamedMember => ({
      profile,
      recipient: principalOf(profile, "represents-principal"),
    }));
    if (named.some(({ recipient }) => !isPrincipalDID(recipient))) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "A member's profile attests no principal.",
      });
      return;
    }
    // An offer goes to an inbox, so profiles of two people pointing at one
    // inbox would hand each the other's offer. No setup makes them, so the
    // request is refused whole, before anything is created.
    const inboxes = named.map(({ recipient, profile }) => ({
      recipient,
      pointer: inboxPointerOf(profile),
    }));
    if (
      inboxes.some((one, index) =>
        one.pointer !== undefined &&
        inboxes.slice(index + 1).some((other) =>
          other.recipient !== one.recipient &&
          other.pointer !== undefined && equals(other.pointer, one.pointer)
        )
      )
    ) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "Two members' profiles point at the same inbox.",
        code: "shared-inbox",
      });
      return;
    }
    // Each other member named by profile is offered the room through every
    // profile naming them, each inbox once, and added to its participants
    // once.
    const offerTo = named.reduce<OfferedMember[]>(
      (found, { recipient, profile }) => {
        if (!isPrincipalDID(recipient) || recipient === self) return found;
        const known = found.find((each) => each.recipient === recipient);
        return known === undefined
          ? [...found, { recipient, profiles: [profile] }]
          : found.map((each) =>
            each === known
              ? { recipient, profiles: [...each.profiles, profile] }
              : each
          );
      },
      [],
    );
    const members = otherMembers(
      [...listed, ...offerTo.map(({ recipient }) => recipient)],
      self ?? "",
    );
    const joinableByLink = event?.joinableByLink ??
      draft?.joinableByLink ?? false;
    const entry = createRoom(state, requestId, "group", members, {
      title,
      joinableByLink,
      offerTo,
    });
    if (state.fromDraft === true) state.draft.set(EMPTY_DRAFT);
    recordOutcome(state, requestId, { status: "done", entry });
    return;
  }

  const room = (event?.room ?? state.room)?.resolveAsCell();
  if (room === undefined) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: "The request names no room.",
    });
    return;
  }

  const catalogEntries = readSharedSpaceCatalog(catalog).entries;
  const memberships = effectiveMemberships(
    state.roomMembership.get() ?? [],
    catalogEntries,
  );
  const membership = memberships.find((known) => equals(known.room, room));
  const candidateContainer = event?.container ?? state.container;
  const container = candidateContainer?.get() === undefined
    ? undefined
    : candidateContainer;
  const declared = container?.key("chatRoom").get();
  const hasDeclaration = declared !== undefined && equals(declared, room);

  const discoveredSource = act === "forget"
    ? Object.values(readSharedSpaceCatalog(catalog).entries).find((entry) =>
      entry.kind !== CHAT_ROOM_OFFER_KIND &&
      chatRevision(entry, room) === (event?.revision ?? state.revision)
    )
    : undefined;

  // A room this user's chats list already is one they have joined, so
  // joining it again changes nothing, and a join that names no request
  // records nothing either: a caller may send one each time the person
  // enters the room.
  const joinedSpace = spaceOf(room);
  if (
    act === "joinRoom" && event?.requestId === undefined &&
    (membership?.state === "saved" ||
      (membership === undefined && listsRoomIn(catalog.get(), joinedSpace)))
  ) {
    // Every message and reaction in the room sends one of these, and none of
    // them changes the room's title, so those leave the room's `about`
    // unread. Any other join reads only `about`, whose links it doesn't
    // follow, and writes the catalog only where the two titles differ, which
    // a retitle makes them. A room listed only through a container has no
    // catalog entry, and gets no write.
    if (isWellFormedDID(joinedSpace) && event?.messageAct !== true) {
      refreshListedTitle(
        catalog,
        joinedSpace,
        room.key("about").get()?.title,
      );
    }
    return;
  }

  if (act === "offerRoom") {
    // The manager tells someone only of a room of its user's own, which its
    // user may add people to: one its catalog lists, in a space its user
    // holds OWNER on.
    const space = spaceOf(room);
    if (!isWellFormedDID(space) || !listsRoomIn(catalog.get(), space)) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The room isn't among this user's chats.",
      });
      return;
    }
    // An access list the run doesn't hold yet, as a served run may not for a
    // room created moments before, says nothing of this user's level, so
    // only a level it states refuses.
    const access = spaceAccess(room);
    if (access !== undefined && access !== "OWNER") {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "This user can't add people to the room.",
      });
      return;
    }
    // People are added only to a group room, which its creator's record
    // says it is; a link to anything else in the room's space, such as one
    // of its messages, has no such record.
    if (aboutRecordOf(room).key("kind").get() !== "group") {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The request names no group room.",
      });
      return;
    }
    // The request's id is the offer's, which a share inbox cuts to a bounded
    // length, so a longer one could be taken for another's.
    if (requestId.length > OFFER_ID_MAX_LENGTH) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The request's id is too long to key an offer by.",
      });
      return;
    }
    // A member named by profile is the principal the profile attests, so a
    // profile attesting none names no one.
    const named = event?.profile;
    const attested = named === undefined
      ? undefined
      : principalOf(named, "represents-principal");
    if (named !== undefined && !isPrincipalDID(attested)) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "A member's profile attests no principal.",
      });
      return;
    }
    const member = event?.member ?? attested;
    if (!isPrincipalDID(member)) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The member is not a principal.",
      });
      return;
    }
    if (attested !== undefined && attested !== member) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The profile is not the member's.",
      });
      return;
    }
    const from = currentPrincipal();
    if (from === undefined) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "Offering a room needs a signed-in user.",
      });
      return;
    }
    if (member === from) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The member is this user.",
      });
      return;
    }
    // A member named by principal alone is offered the room through the
    // profiles `people` lists for them, so a person this user shares no room
    // with is offered nothing.
    // TODO(danfuzz): A served run can't read the session's instance of
    // `people`, and finds none listed, so under server execution such a
    // member gets a notice. Offer through `people` there too, once a served
    // handler can read a per-session instance of its user's.
    const profiles = named === undefined
      ? [...(state.people?.[member] ?? [])]
      : [named];
    const delivery = offerToMember(
      offerEnvelope(
        requestId,
        space,
        room.key("about").get()?.title ?? "",
        from,
      ),
      room,
      { recipient: member, profiles },
      state,
    );
    recordOutcome(state, requestId, { status: "done", delivery });
    return;
  }

  if (act === "forget") {
    // Forgetting archives the room's entry, at the revision the list the
    // request came from showed, so a choice made since is not overridden.
    const revision = event?.revision ?? state.revision;
    if (typeof revision !== "string") {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The request names no revision of the room's entry.",
      });
      return;
    }
    if (
      membership !== undefined || container !== undefined ||
      discoveredSource !== undefined
    ) {
      const source = discoveredSource ??
        (container === undefined
          ? undefined
          : readSharedSpaceCatalog(catalog).entries[spaceOf(container) ?? ""]);
      const standalone = catalogEntries[spaceOf(room) ?? ""];
      const currentRevision = standalone?.kind === CHAT_ROOM_OFFER_KIND
        ? standalone.state === "saved" ? standalone.revision : undefined
        : membership?.state === "saved"
        ? membership.revision
        : membership === undefined && source?.state === "saved"
        ? chatRevision(source, room)
        : undefined;
      if (currentRevision !== revision) {
        recordOutcome(state, requestId, {
          status: "refused",
          reason: "The room's entry changed since it was listed.",
        });
        return;
      }
      const kind = membership?.kind ??
        aboutRecordOf(room).key("kind").get() ??
        room.key("about").key("kind").get();
      if (kind !== "direct" && kind !== "group") {
        recordOutcome(state, requestId, {
          status: "refused",
          reason: "The request names no room.",
        });
        return;
      }
      if (
        standalone?.kind === CHAT_ROOM_OFFER_KIND &&
        standalone.state === "saved"
      ) {
        const changed = changeSharedSpaceMembershipIn(catalog, {
          space: standalone.space,
          id: eventKey(),
          expectedRevision: standalone.revision,
          state: "archived",
        });
        if (changed.status === "conflict") {
          recordOutcome(state, requestId, {
            status: "refused",
            reason: "The room's entry changed since it was listed.",
          });
          return;
        }
      }
      const entry: RoomMembership = {
        room,
        container: membership?.container ?? container,
        kind,
        since: membership?.since ?? epochNsecFromMsec(source?.since ?? 0),
        state: "archived",
        revision: eventKey(),
        catalogRevision: standalone?.kind === CHAT_ROOM_OFFER_KIND
          ? readSharedSpaceCatalog(catalog).entries[standalone.space]?.revision
          : membership?.catalogRevision,
      };
      state.roomMembership.set([
        ...memberships.filter((known) => !equals(known.room, room)),
        entry,
      ]);
      recordOutcome(state, requestId, { status: "done" });
      return;
    }
    // The catalog names a room by its space, which holds at most one room,
    // its root; a link to anything else in that space, such as one of the
    // room's messages, names no room to forget.
    const kind = aboutRecordOf(room).key("kind").get() ??
      room.key("about").key("kind").get();
    if (kind !== "direct" && kind !== "group") {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The request names no room.",
      });
      return;
    }
    // An entry no longer saved, archived or removed by another client since
    // the list was read, has moved on from any revision a list showed.
    const space = spaceOf(room);
    const entry = isWellFormedDID(space)
      ? readSharedSpaceCatalog(catalog).entries[space]
      : undefined;
    const changed = isWellFormedDID(space) &&
        entry?.kind === CHAT_ROOM_OFFER_KIND && entry.state === "saved"
      ? changeSharedSpaceMembershipIn(catalog, {
        space,
        id: eventKey(),
        expectedRevision: revision,
        state: "archived",
      })
      : undefined;
    if (changed === undefined || changed.status === "conflict") {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The room's entry changed since it was listed.",
      });
      return;
    }
    state.roomMembership.set([
      ...memberships,
      {
        room,
        kind,
        since: epochNsecFromMsec(entry?.since ?? 0),
        state: "archived",
        revision: eventKey(),
        catalogRevision: readSharedSpaceCatalog(catalog).entries[space ?? ""]
          ?.revision,
      },
    ]);
    recordOutcome(state, requestId, { status: "done" });
    return;
  }

  // `accept` and `joinRoom`. The kind comes from the record the room's
  // creator wrote, or the view of a container's declared conversation.
  const record = aboutRecordOf(room);
  const kind = record.key("kind").get() ?? room.key("about").key("kind").get();
  const space = spaceOf(room);
  if (
    currentPrincipal() === undefined || spaceAccess(room) === "none" ||
    (kind !== "direct" && kind !== "group") || !isWellFormedDID(space)
  ) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: "The room can't be read by this user.",
    });
    return;
  }
  if (container !== undefined && !hasDeclaration) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: "The container does not declare this room.",
    });
    return;
  }
  if (container === undefined && record.key("kind").get() === undefined) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: "The room needs its container's chat declaration.",
      code: "space-own-chat",
    });
    return;
  }
  // A direct room's counterpart is its creator, as its `about` is labeled,
  // whatever the event claims. A room this user created is found again with
  // `openDirect`, and its label names no one else; joining it lists it
  // again, leaving `direct`, which holds it under its counterpart, as it is.
  const creator = kind === "direct"
    ? principalOf(record, "authored-by")
    : undefined;
  const ownDirect = act === "joinRoom" && creator !== undefined &&
    creator === currentPrincipal();
  const refusal = kind !== "direct" || ownDirect
    ? undefined
    : creator === undefined
    ? "The room's creator can't be verified."
    : creator === currentPrincipal()
    ? "The room was created by this user."
    : event?.counterpart !== undefined && event.counterpart !== creator
    ? "The counterpart is not the room's creator."
    : undefined;
  if (refusal !== undefined) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: refusal,
    });
    return;
  }
  const counterpart = ownDirect ? undefined : creator;
  const entry: ChatIndexEntry = {
    room,
    kind,
    ...(counterpart === undefined ? {} : { counterpart }),
    since: epochNsecFromMsec(Date.now()),
  };
  // Registers the room, or restores an archived entry at the revision just
  // read, as `listRoom` says: accepting the room, or joining it, is the
  // choice to have it listed. An acceptance made on the person's behalf,
  // which `keepArchived` marks, is no such choice, and leaves an archived
  // entry as it is; a join is always the person's own.
  const restore = act === "joinRoom" || event?.keepArchived !== true;
  const catalogManaged = record.key("kind").get() !== undefined ||
    container === undefined ||
    catalogEntries[space]?.kind === CHAT_ROOM_OFFER_KIND ||
    membership?.catalogRevision !== undefined;
  if (catalogManaged) {
    listRoom(catalog, space, {
      title: room.key("about").get()?.title,
      restore,
    });
  }
  if (container !== undefined || membership !== undefined) {
    if (
      membership === undefined || (membership.state === "archived" && restore)
    ) {
      state.roomMembership.set([
        ...memberships.filter((known) => !equals(known.room, room)),
        {
          ...entry,
          container: container ?? membership?.container,
          since: membership?.since ?? entry.since,
          catalogRevision: catalogManaged
            ? readSharedSpaceCatalog(catalog).entries[space]?.revision
            : undefined,
          revision: catalogManaged
            ? readSharedSpaceCatalog(catalog).entries[space]?.revision ??
              eventKey()
            : eventKey(),
          state: "saved",
        },
      ]);
    }
  }
  // A user whose profile hasn't resolved is listed without joining the
  // room's participants, which `joinRooms` leaves as they are: an acceptance
  // the host makes on their behalf can come before the profile resolves, and
  // the room's sender has joined them to it already.
  if (state.myProfile !== undefined) {
    state.joinRooms.send({ room, profile: state.myProfile });
  }
  if (
    kind === "direct" && counterpart !== undefined &&
    direct.key(counterpart).get() === undefined
  ) {
    direct.key(counterpart).set(entry);
  }
  recordOutcome(state, requestId, { status: "done", entry });
};

/**
 * Starts a chat, finding or creating a direct room or creating a group room,
 * from a reviewed `ChatStart` on `ChatStartSurface`: a room's `about` record
 * names this handler and that action as its only writer, so a start that
 * creates a room commits only from that gesture. A start that finds a direct
 * room commits without one, and may offer the room to its counterpart, as
 * `offerRoom` offers a room without one: the start that created the room, and
 * granted them access, was the gesture.
 */
export const commitStart = handler<ManagerStreamEvent, ManagerActState>(
  (event, state) => performManagerAct(event, state),
);

/**
 * Performs one of the manager's other acts: offering a room to a member added
 * to it, accepting a room, joining one, forgetting one, or reporting a notice
 * delivered. None of them needs a gesture. Each changes only this user's own
 * manager, except that accepting or joining a room also adds this user to its
 * participants, when their profile has resolved, which anyone in its space may
 * do; and that offering one tells someone of a room this user may add people
 * to, which the add that admitted them was the gesture for.
 */
export const commitManager = handler<ManagerStreamEvent, ManagerActState>(
  (event, state) => performManagerAct(event, state),
);

/** What picking a group's member asks: the member's profile. */
export interface PickMemberEvent {
  /** The profile to pick, or to stop picking. */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  profile?: Cell<ChatManagerProfile>;
}

/** What `pickMember` is bound to. */
interface PickMemberState {
  /** The session's group draft. */
  draft: Writable<GroupDraft>;

  /** A rendered control's profile, which an event's own outranks. */
  profile?: Cell<ChatManagerProfile>;
}

/**
 * Whether two profiles name the same person: they are the same cell, or their
 * `represents-principal` labels attest the same principal.
 */
const samePerson = (
  a: Cell<ChatManagerProfile>,
  b: Cell<ChatManagerProfile>,
): boolean => {
  if (equals(a, b)) return true;
  const principal = principalOf(a, "represents-principal");
  return principal !== undefined &&
    principal === principalOf(b, "represents-principal");
};

/**
 * Adds a profile to the members the session's group draft has picked, or,
 * when the draft has picked that person already, by this profile or another
 * of theirs, removes every profile of theirs it holds.
 */
const pickMember = handler<PickMemberEvent, PickMemberState>(
  (event, { draft, profile: bound }) => {
    const profile = event?.profile ?? bound;
    if (profile === undefined) return;
    const picked = draft.key("picked").get() ?? [];
    draft.key("picked").set(
      picked.some((known) => samePerson(known, profile))
        ? picked.filter((known) => !samePerson(known, profile))
        : [...picked, profile],
    );
  },
);

/** What a manager stores. Every field has a default. */
export interface FabriChatManagerInput {
  /**
   * The user's catalog for standalone membership and container discovery:
   * in a user's home space, Home's. A manager given none keeps one of its own.
   */
  sharedSpaceCatalog?: CatalogCell;

  /**
   * The direct room shared with each counterpart, for the rooms this manager
   * created or accepted, the ones its user's host accepted for them included.
   */
  direct?: DirectCell;

  /** Each request's outcome. */
  requests?: RequestsCell;

  /** Notices waiting for a client to deliver them. */
  outgoingNotices?: NoticesCell;
}

/** What a manager offers: `ChatManagerOutput`. */
export interface FabriChatManagerOutput {
  /** The manager's name, for lists of pieces. */
  [NAME]: string;

  /** The manager's rendering. */
  [UI]: VNode;

  /** Every room this user belongs to and hasn't forgotten, newest first. */
  rooms: PerSession<ChatIndexEntry[]>;

  /**
   * The stored catalog used for standalone membership and container discovery.
   * `rooms` combines those discoveries with individual `roomMembership` choices;
   * a reader can inspect catalog membership here without computing the view.
   */
  sharedSpaceCatalog: SharedSpaceCatalogStorage;

  /** Explicit room membership, including forgotten conversations. */
  roomMembership: RoomMembership[];

  /** The direct room this user shares with each counterpart, by principal. */
  direct: Record<string, ChatIndexEntry>;

  /** The outcome of each request, by the `requestId` its caller chose. */
  requests: Record<string, ChatRequestOutcome>;

  /**
   * Notices this user's requests have produced that no one has delivered,
   * other than those whose room's roster lists a profile attesting their
   * recipient.
   */
  outgoingNotices: ChatManagerNotice[];

  /**
   * The people this user's rooms list, other than this user: by the principal
   * each one's profile attests, the profiles attesting it, each once, in the
   * order the rooms, newest first, list them.
   */
  people: PerSession<Record<string, ManagerProfileCell[]>>;

  /** Finds or creates the direct room with a person. */
  openDirect: Stream<ManagerStreamEvent>;

  /** Creates a group room. */
  createGroup: Stream<ManagerStreamEvent>;

  /**
   * Offers someone added to a room the room, where this user may add people
   * to it, and records how they were told of it.
   */
  offerRoom: Stream<ManagerStreamEvent>;

  /** Records a room this user has been admitted to. */
  accept: Stream<ManagerStreamEvent>;

  /**
   * Makes a room this user has entered one of their chats: lists it, or
   * lists it again once forgotten, and adds them to its participants. A room
   * their chats list already is left as it is.
   */
  joinRoom: Stream<ManagerStreamEvent>;

  /** Removes a room from this user's list. */
  forget: Stream<ManagerStreamEvent>;

  /** Reports a notice delivered. */
  delivered: Stream<ManagerStreamEvent>;

  /** The manager's data face, as one group. */
  [VIEWS]: { chats: FabriChatManagerView };
}

/** A manager's data face, for hosts that draw it natively. */
export type FabriChatManagerView = Omit<
  FabriChatManagerOutput,
  typeof NAME | typeof UI | typeof VIEWS
>;

/** A room in the manager's own rendering. */
interface ShownEntry {
  /** The room. */
  room: Cell<ChatRoomLink>;

  /** The revision of the room's entry, which forgetting it names. */
  revision?: string;

  /** How the entry is labeled. */
  label: string;
}

/** A person the manager's rendering offers to name a new group's member by. */
interface ShownPerson {
  /** The profile a group is offered through, the first attesting them. */
  profile: ManagerProfileCell;

  /** What the control picking them says, which shows whether they are. */
  label: string;
}

/** The opaque revision of a conversation discovered through a catalog entry. */
const chatRevision = (
  entry: SharedSpaceEntry,
  room: Cell<ChatRoomLink>,
): string => {
  const resolved = room.resolveAsCell();
  return `chat:${
    JSON.stringify([
      entry.space,
      entry.revision,
      spaceOf(resolved),
      entityKeyOf(resolved),
    ])
  }`;
};

/** What finding a catalog entry's room needs. */
interface FoundRoomInput {
  /** The DID of the room's space, as the catalog entry names it. */
  space: string;

  /** The catalog's declared strategy for locating the room. */
  kind: string;
}

/** A catalog entry's room, once found. */
interface FoundRoomOutput {
  /** The room; absent until it resolves. */
  room?: Cell<ChatRoomLink>;
}

/** Locates a standalone root or a container's explicit chat declaration. */
const FoundRoom = pattern<FoundRoomInput, FoundRoomOutput>(
  ({ space, kind }) => {
    const root = wish<Cell<ChatRoomLink & ChatContainer>>({
      query: "#default",
      scope: computed(() => isWellFormedDID(space) ? [space] : []),
    });
    const standalone = computed(() => kind === CHAT_ROOM_OFFER_KIND);
    // The room is the document its root or declaration finally reaches. A
    // declaration may reach it through a document holding only a link, as a
    // Loom root's ensured room is reached through the handler's output for
    // it; that document stores no labels, so a link to it gives a labeled
    // list nothing to carry, and the room's own labels are what a link to
    // the room carries.
    return {
      room: computed(() =>
        (standalone ? root.result : root.result?.key("chatRoom").get())
          ?.resolveAsCell()
      ),
    };
  },
);

/**
 * The other member of the direct `room`: the counterpart `direct`
 * holds the room under, for a room `direct` holds, or else the room's
 * creator, as its `about.record` is labeled, unless that is `self`. Absent
 * when neither names one, as when the label can't be read.
 */
const counterpartOf = (
  direct: Record<string, ChatIndexEntry>,
  room: Cell<ChatRoomLink>,
  self: string | undefined,
): string | undefined => {
  const stored = Object.entries(direct).find(([, known]) =>
    equals(known.room, room)
  )?.[0];
  if (stored !== undefined) return stored;
  const creator = principalOf(aboutRecordOf(room), "authored-by");
  return creator === self ? undefined : creator;
};

/** What a manager's core needs: what it stores, and whose it is. */
export interface FabriChatManagerCoreInput
  extends Required<FabriChatManagerInput> {
  /** The user's profile, which holds no value until it resolves. */
  myProfile: ManagerProfileCell | undefined;
}

/**
 * What a manager's core offers: `ChatManagerOutput`, and the streams its own
 * group form sends to, which work on the session's group draft.
 */
export interface FabriChatManagerCoreOutput extends FabriChatManagerOutput {
  /** Picks a member for the draft's group, or stops picking them. */
  pickMember: Stream<PickMemberEvent>;

  /**
   * Creates the draft's group, from a reviewed `ChatStart`, and empties the
   * draft. An event's own title and members outrank the draft's.
   */
  createDraftedGroup: Stream<ManagerStreamEvent>;
}

/**
 * A person's rooms, those they belong to, and the way to start new ones,
 * given the person's profile.
 */
export const FabriChatManagerCore = pattern<
  FabriChatManagerCoreInput,
  FabriChatManagerCoreOutput
>(
  (
    {
      myProfile,
      sharedSpaceCatalog,
      direct,
      requests,
      outgoingNotices,
    },
  ) => {
    const roomMembership = new Writable<RoomMembership[]>([]);
    const draft = new Writable.perSession<GroupDraft>(EMPTY_DRAFT);
    const startRefusal = new Writable.perSession<string>("");
    // Saved catalog entries are discovery sources; standalone rooms come first.
    // A catalog that doesn't read as one supplies no sources.
    const savedRooms = computed((): SharedSpaceEntry[] => {
      const catalog = sharedSpaceCatalog.get();
      return isSharedSpaceCatalog(catalog)
        ? Object.values(catalog.entries).filter((entry) =>
          entry.state === "saved"
        ).sort((a, b) =>
          Number(b.kind === CHAT_ROOM_OFFER_KIND) -
          Number(a.kind === CHAT_ROOM_OFFER_KIND)
        )
        : [];
    });
    // A room's space is read under the reader's own access, so a principal it
    // refuses finds nothing there that the others find. Each room is found,
    // and everything read from it derived, per session: a value stored once
    // for every reader, which readers derive differently, is one their
    // runtimes overwrite without end.
    const found = savedRooms.map((entry) =>
      FoundRoom.asScope("session")({ space: entry.space, kind: entry.kind })
    );
    // Each saved room once it resolves and reads as a room, newest first. The
    // room's own records are read here, beside the entry they belong to, so
    // they are read in the run that lists them.
    const newestFirst = computed((): PerSession<ChatIndexEntry[]> => {
      const self = principalOf(myProfile, "represents-principal");
      const stored = direct.get() ?? {};
      const catalogValue = sharedSpaceCatalog.get();
      const catalogEntries = isSharedSpaceCatalog(catalogValue)
        ? catalogValue.entries
        : {};
      const memberships = effectiveMemberships(
        roomMembership.get() ?? [],
        catalogEntries,
      );
      const discovered = savedRooms.flatMap(
        (entry, index): ChatIndexEntry[] => {
          const room = found[index]?.room;
          if (room === undefined) return [];
          const standalone = catalogEntries[spaceOf(room) ?? ""];
          if (
            standalone?.kind === CHAT_ROOM_OFFER_KIND &&
            standalone.state !== "saved"
          ) return [];
          const kind = aboutRecordOf(room).key("kind").get() ??
            room.key("about").key("kind").get();
          if (kind !== "direct" && kind !== "group") return [];
          const counterpart = kind === "direct"
            ? counterpartOf(stored, room, self)
            : undefined;
          return [{
            room,
            kind,
            ...(counterpart === undefined ? {} : { counterpart }),
            since: epochNsecFromMsec(entry.since ?? 0),
            revision: entry.kind === CHAT_ROOM_OFFER_KIND
              ? entry.revision
              : chatRevision(entry, room),
          }];
        },
      );
      const listed = [
        ...memberships.filter((entry) => entry.state === "saved"),
        ...discovered.filter((entry) =>
          !memberships.some((known) => equals(known.room, entry.room))
        ),
      ];
      return listed.filter((entry, index) =>
        listed.findIndex((known) => equals(known.room, entry.room)) === index
      ).map((entry) =>
        entry.kind === "direct"
          ? { ...entry, counterpart: counterpartOf(stored, entry.room, self) }
          : entry
      ).sort((a, b) =>
        nsecOf(b.since) < nsecOf(a.since)
          ? -1
          : nsecOf(b.since) > nsecOf(a.since)
          ? 1
          : 0
      );
    });
    // The people the listed rooms' rosters hold, by the principal each
    // profile's own label attests, read beside the rooms that list them, and
    // per session, as `newestFirst` is: a profile attests no one to a reader
    // its space refuses. A profile attesting no principal, or a DID no
    // principal can have, names no one to offer a room to, and this user's
    // own are left out.
    const people = computed(
      (): PerSession<Record<string, ManagerProfileCell[]>> => {
        const self = principalOf(myProfile, "represents-principal");
        return newestFirst.reduce<Record<string, ManagerProfileCell[]>>(
          (found, entry) =>
            (entry.room.key("roster").get() ?? []).reduce((known, profile) => {
              const principal = principalOf(profile, "represents-principal");
              if (!isPrincipalDID(principal) || principal === self) {
                return known;
              }
              const profiles = known[principal] ?? [];
              return profiles.some((each) => equals(each, profile))
                ? known
                : { ...known, [principal]: [...profiles, profile] };
            }, found),
          {},
        );
      },
    );
    const joining = joinRooms({});
    const records = {
      myProfile,
      catalog: sharedSpaceCatalog,
      roomMembership,
      direct,
      requests,
      outgoingNotices,
      offerRooms: offerRooms({ outgoingNotices, joinRooms: joining }),
      joinRooms: joining,
      draft,
      startRefusal,
    };
    // Per session, as `newestFirst` is: a room's label is the title its room
    // holds, which a direct room has only once a member sets one.
    const shown = computed((): PerSession<ShownEntry[]> =>
      newestFirst.map((entry) => ({
        room: entry.room,
        ...(entry.revision === undefined ? {} : { revision: entry.revision }),
        label: entry.room.key("about").get()?.title ??
          (entry.kind === "direct"
            ? `With ${entry.counterpart ?? "someone"}`
            : "Group chat"),
      }))
    );
    // A refusal differs by session, so it is always rendered and hidden by a
    // prop: a tree built differently per session is stored once for every
    // session, and runtimes that built it differently overwrite each other
    // without end. It is `hidden` until its display has a value, as
    // `FabriChatMessageRow` says.
    const refusalDisplay = computed((): ChatDisplay =>
      startRefusal.get() === "" ? "none" : "block"
    );
    // Each person once, by the first profile attesting them, and whether the
    // session's draft has picked them, by any profile of theirs, per session,
    // as `people` is.
    const shownPeople = computed((): PerSession<ShownPerson[]> => {
      const picked = draft.get()?.picked ?? [];
      return Object.values(people).flatMap((profiles): ShownPerson[] => {
        const profile = profiles[0];
        if (profile === undefined) return [];
        return [{
          profile,
          label: picked.some((known) => samePerson(known, profile))
            ? "Added"
            : "Add",
        }];
      });
    });
    const peopleDisplay = computed((): ChatDisplay =>
      shownPeople.length === 0 ? "none" : "block"
    );
    // A notice whose room's roster lists a profile attesting its recipient
    // has nothing left to tell them: they are in the room. Per session, as
    // `newestFirst` is: the roster is read under the reader's access, and a
    // profile attests no one to a reader its space refuses.
    const noticeList = computed((): PerSession<ChatManagerNotice[]> =>
      ((outgoingNotices.get() ?? []) as ChatManagerNotice[]).filter((notice) =>
        !(notice.room.key("roster").get() ?? []).some((member) =>
          principalOf(member, "represents-principal") === notice.recipient
        )
      )
    );
    const cannotStart = computed(() => myProfile?.get() === undefined);
    // The principal this user's profile attests, which someone starting a
    // chat with them needs; empty when the profile attests none.
    const myAddress = computed(() =>
      principalOf(myProfile, "represents-principal") ?? ""
    );
    const addressDisplay = computed(
      (): ChatDisplay => (myAddress === "" ? "none" : "block"),
    );
    const createDraftedGroup = commitStart({
      act: "createGroup",
      ...records,
      fromDraft: true,
    });
    const streams = {
      openDirect: commitStart({ act: "openDirect", ...records }),
      createGroup: commitStart({ act: "createGroup", ...records }),
      offerRoom: commitManager({ act: "offerRoom", ...records, people }),
      accept: commitManager({ act: "accept", ...records }),
      joinRoom: commitManager({ act: "joinRoom", ...records }),
      forget: commitManager({ act: "forget", ...records }),
      delivered: commitManager({ act: "delivered", ...records }),
    };
    const view = {
      rooms: newestFirst,
      sharedSpaceCatalog,
      roomMembership,
      direct,
      requests,
      outgoingNotices: noticeList,
      people,
      ...streams,
    };

    return {
      [NAME]: "Chats",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-heading level={3}>Chats</cf-heading>
          <cf-vstack id="fabrichat-rooms" gap="1">
            {shown.map((entry) => (
              <cf-hstack gap="2" align="center">
                <cf-cell-link $cell={entry.room} label={entry.label} />
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={commitManager({
                    act: "forget",
                    ...records,
                    room: entry.room,
                    revision: entry.revision,
                  })}
                >
                  Forget
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
          <div
            id="fabrichat-my-address"
            hidden
            style={{ display: addressDisplay }}
          >
            <cf-hstack gap="2" align="center">
              <cf-text variant="caption">
                Your chat address: {myAddress}
              </cf-text>
              <cf-copy-button text={myAddress} size="sm" icon-only />
            </cf-hstack>
          </div>
          <div
            data-ui-pattern={CHAT_START_SURFACE}
            data-ui-event-integrity={CHAT_START_SURFACE}
          >
            <cf-vstack gap="2">
              <cf-submit-input
                data-ui-action={CHAT_START_ACTION}
                inputId="fabrichat-start-direct"
                placeholder="Their chat address (did:key:…)"
                buttonText="Chat"
                disabled={cannotStart}
                onClick={streams.openDirect}
              />
              <cf-input
                id="fabrichat-group-title"
                $value={draft.key("title")}
                placeholder="New group's title"
              />
              <cf-textarea
                $value={draft.key("members")}
                placeholder="Members' chat addresses, one per line"
              />
              <div
                id="fabrichat-group-people"
                hidden
                style={{ display: peopleDisplay }}
              >
                <cf-vstack gap="1">
                  <cf-text variant="caption">
                    Or add people from your chats:
                  </cf-text>
                  {shownPeople.map((person) => (
                    <cf-hstack gap="2" align="center">
                      <cf-profile-badge
                        variant="chip"
                        $profile={person.profile}
                      />
                      <cf-button
                        size="sm"
                        variant="ghost"
                        onClick={pickMember({ draft, profile: person.profile })}
                      >
                        {person.label}
                      </cf-button>
                    </cf-hstack>
                  ))}
                </cf-vstack>
              </div>
              <cf-checkbox $checked={draft.key("joinableByLink")}>
                Anyone with its link can join
              </cf-checkbox>
              <cf-button
                data-ui-action={CHAT_START_ACTION}
                disabled={cannotStart}
                onClick={createDraftedGroup}
              >
                Create group
              </cf-button>
              <div
                id="fabrichat-start-refusal"
                hidden
                style={{ display: refusalDisplay }}
              >
                <cf-alert status="error">{startRefusal}</cf-alert>
              </div>
            </cf-vstack>
          </div>
          {noticeList.map((notice) => (
            <cf-hstack gap="2" align="center">
              <cf-text variant="caption">
                {notice.recipient}{" "}
                may not know of this chat yet. Open it, and send them its
                address:
              </cf-text>
              <cf-cell-link $cell={notice.room} />
              <cf-button
                size="sm"
                variant="ghost"
                onClick={commitManager({
                  act: "delivered",
                  ...records,
                  id: notice.id,
                })}
              >
                Done
              </cf-button>
            </cf-hstack>
          ))}
        </cf-vstack>
      ),
      [VIEWS]: { chats: view },
      ...view,
      pickMember: pickMember({ draft }),
      createDraftedGroup,
    };
  },
);

/**
 * A person's chat manager, whose person is the one looking at it: what
 * `#chatManager` resolves to.
 */
const FabriChatManager = pattern<
  FabriChatManagerInput,
  FabriChatManagerOutput
>((input) => {
  const profileWish = wish<ChatManagerProfile>({ query: "#profile" });
  const core = FabriChatManagerCore(
    {
      myProfile: profileWish.result,
      sharedSpaceCatalog: input.sharedSpaceCatalog,
      direct: input.direct,
      requests: input.requests,
      outgoingNotices: input.outgoingNotices,
    },
  );
  return {
    [NAME]: core[NAME],
    [UI]: core[UI],
    [VIEWS]: core[VIEWS],
    rooms: core.rooms,
    sharedSpaceCatalog: core.sharedSpaceCatalog,
    roomMembership: core.roomMembership,
    direct: core.direct,
    requests: core.requests,
    outgoingNotices: core.outgoingNotices,
    people: core.people,
    openDirect: core.openDirect,
    createGroup: core.createGroup,
    offerRoom: core.offerRoom,
    accept: core.accept,
    joinRoom: core.joinRoom,
    forget: core.forget,
    delivered: core.delivered,
  };
});

export default FabriChatManager;
