/**
 * `FabriChatManager`: a user's index of the rooms they belong to, an
 * implementation of `ChatManagerOutput` (`docs/specs/fabrichat/`). It lives in
 * the user's home space, where `#chatManager` finds it, so everything it holds
 * is private to its user.
 *
 * The rooms it lists are the ones the user's shared-space catalog, Home's,
 * keeps as saved: each room is its space's root, and the catalog lists the
 * space. The manager registers there each room it creates, and each room a
 * manager created that it accepts, and the host that vets an offer of a room
 * registers that room there. Forgetting a room archives its entry.
 *
 * It creates each room with `inSpace()` as the root of a space of its own,
 * which declares itself a `fabrichat-room`. The space grants the room's
 * creator and each other member named at creation OWNER, and no one else,
 * except that a group made joinable by its link grants everyone WRITE as well.
 * After that, who is in the space is the space's business: any OWNER may add
 * someone from the room's own rendering, and the manager never changes it.
 *
 * The room keeps its space's participants itself, and the manager adds its
 * user to them when it creates or accepts a room.
 *
 * A new room is offered to each other member whose profile the request names,
 * through the share inbox the profile points at, in the envelope a share inbox
 * takes. A notice is queued for every other member all the same, since
 * nothing tells the sender an offer arrived.
 */
import {
  type Cell,
  computed,
  currentPrincipal,
  debugStr,
  type Default,
  type DID,
  eventKey,
  getPatternEnvironment,
  handler,
  type InSpaceGrants,
  isWellFormedDID,
  NAME,
  pattern,
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
  type SharedSpaceCatalogStorage,
  type SharedSpaceEntry,
} from "../system/shared-space-catalog.ts";
import FabriChatRoom from "./room.tsx";
import {
  type AboutRecord,
  CHAT_ROOM_OFFER_KIND,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatDisplay,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatManagerProfile,
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
  | "accept"
  | "forget"
  | "delivered";

/** Whether `act` starts a chat. */
const isStart = (act: ManagerAct): boolean =>
  act === "openDirect" || act === "createGroup";

/**
 * An event on one of the manager's streams. Each stream's event carries the
 * fields its act needs. A rendered control sends no request id, which the
 * manager then mints, and either the text it holds, as `target.value`, or, for
 * a control that starts a direct room with one person, that person's principal
 * as `target.dataset.counterpart`.
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

  /**
   * A direct room's other member's profile, through whose share inbox a new
   * room is offered to them.
   */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  profile?: Cell<ChatManagerProfile>;

  /** The DIDs of a new group room's other members. */
  members?: string[];

  /** A new group room's title. */
  title?: string;

  /**
   * Whether a new group room admits anyone who has its link; absent for a room
   * admitting its members alone.
   */
  joinableByLink?: boolean;

  /** A room to accept or forget. */
  room?: Cell<ChatRoomLink>;

  /** The id of a notice delivered. */
  id?: string;

  /**
   * The revision of a room's entry, as the list the request was made from
   * showed it, for a room to forget.
   */
  revision?: string;

  /** A rendered control's text, or the principal it starts a direct room with. */
  readonly target?: {
    readonly value?: string;
    readonly dataset?: { readonly counterpart?: string };
  };
}

/** A group room being composed in the manager's own rendering. */
export interface GroupDraft {
  /** The room's title. */
  title: string;

  /** The other members' DIDs, one per line or separated by spaces. */
  members: string;

  /** Whether the room admits anyone who has its link. */
  joinableByLink: boolean;
}

/** An empty group draft. */
const EMPTY_DRAFT = {
  title: "",
  members: "",
  joinableByLink: false,
} satisfies GroupDraft;

/** The manager's records, and a rendered control's bindings. */
export interface ManagerActState {
  /** The act this binding performs. */
  act: ManagerAct;

  /** The user's profile, which holds no value until it resolves. */
  myProfile: ManagerProfileCell | undefined;

  /** The user's shared-space catalog, where each room listed is registered. */
  catalog: CatalogCell;

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

  /** A rendered control's notice id. */
  id?: string;

  /** A rendered control's room's revision, as its row shows it. */
  revision?: string;
}

/** The DIDs in `text`, separated by spaces, commas, or lines. */
const principalsIn = (text: string): string[] =>
  text.split(/[\s,]+/).filter((part) => part !== "");

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
 * Lists the room in `space` in the user's catalog: registers the space, or
 * restores its entry when the entry is archived. An entry in any other state
 * stays as it is. A group room's title, cut to the length an offer's may run
 * to, is registered with it.
 */
const listRoom = (
  catalog: CatalogCell,
  space: DID,
  { title, since }: { title?: string; since?: number } = {},
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
  } else if (entry.state === "archived") {
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

  /** The profiles of the members to offer it to. */
  profiles: Cell<ChatManagerProfile>[];
}

/**
 * Offers a room to each person in the event's `profiles`, through the share
 * inbox each profile points at, in the envelope a share inbox takes; a
 * profile pointing at no inbox is offered nothing. The offer names the room's
 * space and the host serving it, this pattern's own, and the principal
 * sending it as its sender.
 *
 * It runs as an event of its own, queued by the one that creates the room, so
 * that it reads the room's space once the room's creation has committed, and
 * the members' profiles are read apart from that creation. While the space is
 * not known, nothing is sent.
 */
const offerRooms = handler<OfferRoomEvent, Record<PropertyKey, never>>(
  (event) => {
    const space = spaceOf(event?.room);
    const from = currentPrincipal();
    if (!isWellFormedDID(space) || from === undefined) return;
    const origin = hostOrigin();
    const offer: OfferEvent = {
      kind: CHAT_ROOM_OFFER_KIND,
      id: event.id,
      space,
      host: origin,
      ownerOrigin: origin,
      title: (event.title ?? "").slice(0, OFFER_TITLE_MAX_LENGTH),
      from,
      sharedAt: Date.now(),
    };
    for (const profile of event.profiles ?? []) {
      // The pointer is read through its parent: a link-typed field read on
      // its own is a cell whether or not anything is stored there.
      const pointer = profile?.key("inbox").get()?.piece;
      if (pointer === undefined) continue;
      inboxOf(pointer.resolveAsCell()).key("receive").send(offer);
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
 * or accepts a room is listed in it without a step of their own. It runs as an
 * event of its own, queued by the one that creates or accepts the room, so
 * that the room's streams exist when it sends. A profile that hasn't resolved
 * is added to nothing.
 */
const joinRooms = handler<JoinRoomsEvent, Record<PropertyKey, never>>(
  (event) => {
    // TODO(danfuzz): A stop-gap. A member whose manager neither created nor
    // accepted the room is never sent here, so isn't on the room's roster,
    // and is shown among its participants only as an author, once they write.
    // Add each member once their manager lists the room without a step of
    // their own.
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

  /** The profiles of the other members to offer the room to. */
  offerTo?: readonly Cell<ChatManagerProfile>[];
}

/**
 * Creates a room in a space of its own, as the space's root, and its notices,
 * records its entry, and registers its space in the user's catalog, all in one
 * transaction: the space's grants and its declared kind are part of creating
 * it, so nothing has to commit apart. A notice for each other member is
 * queued for a client to deliver, and adding this user to the room's
 * participants, and offering the room to each profile in `offerTo`, are queued
 * to follow.
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
  members.forEach((recipient) => {
    state.outgoingNotices.push({
      id: JSON.stringify([recipient, requestId]),
      room,
      recipient,
    });
  });
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
        profiles: [...offerTo],
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
 * Performs one manager act: finding or creating a direct room, creating a
 * group room, accepting a room, forgetting one, or reporting a notice
 * delivered. Each act's outcome is recorded under its `requestId`, and a
 * request already decided changes nothing. A start that creates a room commits
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
  // So is accepting one, whose acceptance adds this user's profile to the
  // room's participants.
  if (act === "accept" && state.myProfile?.get() === undefined) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: "Accepting a chat needs a profile.",
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
    const counterpart = event?.counterpart ??
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
    const profile = event?.profile;
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
      recordOutcome(state, requestId, { status: "done", entry: known });
      return;
    }
    const entry = createRoom(state, requestId, "direct", [counterpart], {
      counterpart,
      offerTo: profile === undefined ? [] : [profile],
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
    const members = otherMembers(listed, self ?? "");
    const joinableByLink = event?.joinableByLink ??
      draft?.joinableByLink ?? false;
    const entry = createRoom(state, requestId, "group", members, {
      title,
      joinableByLink,
    });
    if (state.fromDraft === true) state.draft.set(EMPTY_DRAFT);
    recordOutcome(state, requestId, { status: "done", entry });
    return;
  }

  const room = event?.room ?? state.room;
  if (room === undefined) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason: "The request names no room.",
    });
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
    // The catalog names a room by its space, which holds at most one room,
    // its root; a link to anything else in that space, such as one of the
    // room's messages, names no room to forget.
    const kind = aboutRecordOf(room).key("kind").get() ??
      room.key("about").get()?.kind;
    if (kind !== "direct" && kind !== "group") {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The request names no room.",
      });
      return;
    }
    const space = spaceOf(room);
    const entry = isWellFormedDID(space)
      ? readSharedSpaceCatalog(catalog).entries[space]
      : undefined;
    if (
      isWellFormedDID(space) && entry?.kind === CHAT_ROOM_OFFER_KIND &&
      entry.state === "saved"
    ) {
      const changed = changeSharedSpaceMembershipIn(catalog, {
        space,
        id: eventKey(),
        expectedRevision: revision,
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
    recordOutcome(state, requestId, { status: "done" });
    return;
  }

  // `accept`. The kind comes from the record the room's creator wrote,
  // which reads without the room running, as its own view needs; a space's
  // own chat has none, and its view says what it is.
  const record = aboutRecordOf(room);
  const kind = record.key("kind").get() ?? room.key("about").get()?.kind;
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
  // The catalog lists a room by its space, so only a room that is its space's
  // root can be listed, and only a room a manager created is one, which its
  // record says: such a room is its space's root, in a space that declares
  // itself a `fabrichat-room`. A space's own chat has no record, and its space
  // is the social space it belongs to.
  if (record.key("kind").get() === undefined) {
    recordOutcome(state, requestId, {
      status: "refused",
      reason:
        "The room is a social space's own chat, which isn't listed among chats.",
    });
    return;
  }
  // A direct room's counterpart is its creator, as its `about` is labeled,
  // whatever the event claims. A room this user created is found again with
  // `openDirect`, and its label names no one else.
  const creator = kind === "direct"
    ? principalOf(record, "authored-by")
    : undefined;
  const refusal = kind !== "direct"
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
  const counterpart = creator;
  const entry: ChatIndexEntry = {
    room,
    kind,
    ...(kind === "direct" ? { counterpart } : {}),
    since: epochNsecFromMsec(Date.now()),
  };
  // Registers the room, or restores an archived entry at the revision just
  // read, as `listRoom` says: accepting the room is the choice to have it
  // listed.
  listRoom(catalog, space, {
    title: kind === "group" ? room.key("about").get()?.title : undefined,
  });
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
 * creates a room commits only from that gesture.
 */
export const commitStart = handler<ManagerStreamEvent, ManagerActState>(
  (event, state) => performManagerAct(event, state),
);

/**
 * Performs one of the manager's other acts: accepting a room, forgetting one,
 * or reporting a notice delivered. None of them needs a gesture, since each
 * changes only this user's own manager, except that accepting a room also
 * adds this user to its participants, which anyone in its space may do.
 */
export const commitManager = handler<ManagerStreamEvent, ManagerActState>(
  (event, state) => performManagerAct(event, state),
);

/** What a manager stores. Every field has a default. */
export interface FabriChatManagerInput {
  /**
   * The user's shared-space catalog, which lists the rooms they belong to: in
   * a user's home space, Home's. A manager given none keeps one of its own.
   */
  sharedSpaceCatalog?: CatalogCell;

  /**
   * The direct room shared with each counterpart, for the rooms this manager
   * created or accepted.
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
  rooms: ChatIndexEntry[];

  /**
   * The user's shared-space catalog, as stored, from which `rooms` is drawn. A
   * reader in another piece finds a room's entry here by its space without
   * this manager's view having been computed.
   */
  sharedSpaceCatalog: SharedSpaceCatalogStorage;

  /** The direct room this user shares with each counterpart, by principal. */
  direct: Record<string, ChatIndexEntry>;

  /** The outcome of each request, by the `requestId` its caller chose. */
  requests: Record<string, ChatRequestOutcome>;

  /** Notices this user's requests have produced that no one has delivered. */
  outgoingNotices: ChatManagerNotice[];

  /** Finds or creates the direct room with a person. */
  openDirect: Stream<ManagerStreamEvent>;

  /** Creates a group room. */
  createGroup: Stream<ManagerStreamEvent>;

  /** Records a room this user has been admitted to. */
  accept: Stream<ManagerStreamEvent>;

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

/** What finding a catalog entry's room needs. */
interface FoundRoomInput {
  /** The DID of the room's space, as the catalog entry names it. */
  space: string;
}

/** A catalog entry's room, once found. */
interface FoundRoomOutput {
  /** The room; absent until it resolves. */
  room?: Cell<ChatRoomLink>;
}

/** The room in `space`, found as the space's root. */
const FoundRoom = pattern<FoundRoomInput, FoundRoomOutput>(({ space }) => {
  const root = wish<Cell<ChatRoomLink>>({
    query: "#default",
    scope: computed(() => isWellFormedDID(space) ? [space] : []),
  });
  return { room: root.result };
});

/**
 * The other member of the direct room in `space`: the counterpart `direct`
 * holds the room under, for a room this manager created or accepted, or else
 * the room's creator, as its `about.record` is labeled, unless that is `self`.
 * Absent when neither names one, as when the label can't be read.
 */
const counterpartOf = (
  direct: Record<string, ChatIndexEntry>,
  space: string,
  room: Cell<ChatRoomLink>,
  self: string | undefined,
): string | undefined => {
  const stored = Object.entries(direct).find(([, known]) =>
    spaceOf(known.room) === space
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
 * A person's rooms, those they belong to, and the way to start new ones,
 * given the person's profile.
 */
export const FabriChatManagerCore = pattern<
  FabriChatManagerCoreInput,
  FabriChatManagerOutput
>(
  ({ myProfile, sharedSpaceCatalog, direct, requests, outgoingNotices }) => {
    const draft = new Writable.perSession<GroupDraft>(EMPTY_DRAFT);
    const startRefusal = new Writable.perSession<string>("");
    // The rooms the catalog keeps as saved; a catalog that doesn't read as one
    // lists none.
    const savedRooms = computed((): SharedSpaceEntry[] => {
      const catalog = sharedSpaceCatalog.get();
      return isSharedSpaceCatalog(catalog)
        ? Object.values(catalog.entries).filter((entry) =>
          entry.kind === CHAT_ROOM_OFFER_KIND && entry.state === "saved"
        )
        : [];
    });
    const found = savedRooms.map((entry) => FoundRoom({ space: entry.space }));
    // Each saved room once it resolves and reads as a room, newest first. The
    // room's own records are read here, beside the entry they belong to, so
    // they are read in the run that lists them.
    const newestFirst = computed((): ChatIndexEntry[] => {
      const self = principalOf(myProfile, "represents-principal");
      const stored = direct.get() ?? {};
      return savedRooms.flatMap((entry, index): ChatIndexEntry[] => {
        const room = found[index]?.room;
        if (room === undefined) return [];
        const kind = aboutRecordOf(room).key("kind").get() ??
          room.key("about").get()?.kind;
        if (kind !== "direct" && kind !== "group") return [];
        const counterpart = kind === "direct"
          ? counterpartOf(stored, entry.space, room, self)
          : undefined;
        return [{
          room,
          kind,
          ...(counterpart === undefined ? {} : { counterpart }),
          since: epochNsecFromMsec(entry.since ?? 0),
          revision: entry.revision,
        }];
      }).sort((a, b) =>
        nsecOf(b.since) < nsecOf(a.since)
          ? -1
          : nsecOf(b.since) > nsecOf(a.since)
          ? 1
          : 0
      );
    });
    const records = {
      myProfile,
      catalog: sharedSpaceCatalog,
      direct,
      requests,
      outgoingNotices,
      offerRooms: offerRooms({}),
      joinRooms: joinRooms({}),
      draft,
      startRefusal,
    };
    const shown = computed((): ShownEntry[] =>
      newestFirst.map((entry) => ({
        room: entry.room,
        ...(entry.revision === undefined ? {} : { revision: entry.revision }),
        label: entry.kind === "direct"
          ? `With ${entry.counterpart ?? "someone"}`
          : entry.room.key("about").get()?.title ?? "Group chat",
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
    const noticeList = computed(
      () => [...((outgoingNotices.get() ?? []) as ChatManagerNotice[])],
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
    const streams = {
      openDirect: commitStart({ act: "openDirect", ...records }),
      createGroup: commitStart({ act: "createGroup", ...records }),
      accept: commitManager({ act: "accept", ...records }),
      forget: commitManager({ act: "forget", ...records }),
      delivered: commitManager({ act: "delivered", ...records }),
    };
    const view = {
      rooms: newestFirst,
      sharedSpaceCatalog,
      direct,
      requests,
      outgoingNotices: noticeList,
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
              <cf-checkbox $checked={draft.key("joinableByLink")}>
                Anyone with its link can join
              </cf-checkbox>
              <cf-button
                data-ui-action={CHAT_START_ACTION}
                disabled={cannotStart}
                onClick={commitStart({
                  act: "createGroup",
                  ...records,
                  fromDraft: true,
                })}
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
    direct: core.direct,
    requests: core.requests,
    outgoingNotices: core.outgoingNotices,
    openDirect: core.openDirect,
    createGroup: core.createGroup,
    accept: core.accept,
    forget: core.forget,
    delivered: core.delivered,
  };
});

export default FabriChatManager;
