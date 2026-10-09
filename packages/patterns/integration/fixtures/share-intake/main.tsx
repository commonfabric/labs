/**
 * Stands in for Home around the host's share intake: it holds the owner's
 * private inbox, profiles and shared-space catalog, with Home's own catalog
 * handlers, and gives a sender handlers of its own that create a space and
 * offer it to the owner through the inbox the owner's profile points at. It
 * also holds a FabriChat manager, with a profile of its own, from which a
 * sender creates a real room to offer, or starts a direct chat with the owner
 * that the manager offers through the owner's inbox itself, and a second
 * FabriChat manager listing the rooms the intake registers, from which the
 * owner starts a chat. Fixture for `share-intake-multi-runtime.test.ts`.
 */

import {
  type AddIntegrity,
  type Cell,
  computed,
  currentPrincipal,
  Default,
  getPatternEnvironment,
  handler,
  type InSpaceGrants,
  isWellFormedDID,
  NAME,
  pattern,
  spaceOf,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  FabriChatManagerCore,
  type FabriChatManagerInput,
  type ManagerStreamEvent,
} from "../../../fabrichat/manager.tsx";
import {
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
} from "../../../fabrichat/schemas.tsx";
import ProfileHome, {
  type ProfileHomeOutput,
} from "../../../system/profile-home.tsx";
import {
  ensurePrivateInbox,
  type EnsurePrivateInboxEvent,
  type OfferEvent,
  pointProfilesAtPrivateInbox,
  type PrivateInboxHolder,
  type PrivateInboxOutput,
  type PrivateInboxRefusalHolder,
  type RetainedPrivateInboxes,
} from "../../../system/private-inbox.tsx";
import {
  changeSharedSpaceMembership,
  readSharedSpaceCatalog,
  registerSharedSpace,
  type SharedSpaceCatalog,
  type SharedSpaceCatalogStorage,
  type SharedSpaceMembershipChange,
  type SharedSpaceMembershipResult,
  type SharedSpaceRegistration,
  type SharedSpaceRegistrationResult,
} from "../../../system/shared-space-catalog.ts";
import Room, { type RoomOutput } from "./room.tsx";

/**
 * The kind of every offer here, and the kind each room's space declares by
 * default.
 */
const OFFER_KIND = "fabrichat-room";

/**
 * The FabriChat manager's stand-in profile, labeled, as a Fabric profile is,
 * because a room's participants link only a document that carries a label.
 */
type StandInProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** A space a sender's handler created and offered, as the test reads it. */
export interface OfferedSpace {
  /** The sender's key for the offer. */
  id: string;

  /** The DID of the space offered. */
  space: string;
}

/** A space for a sender's handler to create and offer to `recipient`. */
export interface CreateAndOfferRequest {
  /** The sender's key for the offer. */
  id: string;

  /** What the sender calls the space. */
  title: string;

  /** The DID of the principal the space is offered to. */
  recipient: string;

  /** Whether the room is its space's root; absent, it is. */
  root?: boolean;

  /**
   * The kind the room's space declares: absent, the offer's kind, and `null`,
   * none.
   */
  spaceKind?: string | null;
}

/** A space a sender's handler offers again, under another key. */
export interface OfferAgainRequest {
  /** The sender's key for the offer. */
  id: string;

  /** The DID of the space offered. */
  space: string;

  /** What the sender calls the space. */
  title: string;
}

/** A room a sender's handler created, queued to be offered. */
export interface OfferRoomEvent {
  /** The room. */
  room: Cell<RoomOutput>;

  /** The sender's key for the offer. */
  id: string;

  /** What the sender calls the room. */
  title: string;
}

/** A room's result, as the link an event carries. */
function roomLinkOf(room: unknown): Cell<RoomOutput>;
function roomLinkOf(room: unknown): unknown {
  return room;
}

/** An inbox a link reaches, as the cell its result is. */
function inboxOf(link: unknown): Cell<PrivateInboxOutput>;
function inboxOf(link: unknown): unknown {
  return link;
}

/**
 * The envelope a sender sends for an offer of `space`, from the principal
 * sending the event, naming the host this runtime is served by.
 */
function envelopeOf(id: string, space: string, title: string): OfferEvent {
  const host = new URL(getPatternEnvironment().apiUrl).origin;
  return {
    kind: OFFER_KIND,
    id,
    space,
    host,
    ownerOrigin: host,
    title,
    from: currentPrincipal(),
    sharedAt: Date.now(),
  };
}

/**
 * Sends `envelope` to the inbox the owner's first profile points at, reading
 * the pointer through the profile's own types, as a typed link.
 */
function sendToPointedInbox(
  profiles: Writable<ProfileHomeOutput[]>,
  envelope: OfferEvent,
): void {
  const pointer = profiles.key(0).resolveAsCell().key("inbox").get()?.piece;
  if (pointer === undefined) return;
  inboxOf(pointer.resolveAsCell()).key("receive").send(envelope);
}

/**
 * Creates one of the owner's profiles, in a space of its own that grants
 * anyone `WRITE`, as `profile-create.tsx` does.
 */
const createProfile = handler<
  void,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.push(
    ProfileHome.inSpace(undefined, { grants: { "*": "WRITE" } })({
      initialName: "Owner",
    }) as ProfileHomeOutput,
  );
});

/**
 * Creates a room in a space of its own, as the space's root and declaring the
 * offer's kind unless the event says otherwise, which the event's actor owns
 * and which grants the recipient `OWNER`, and queues offering it to the owner.
 */
const createAndOffer = handler<
  CreateAndOfferRequest,
  { offerRoom: Stream<OfferRoomEvent> }
>((event, { offerRoom }) => {
  const grants = Object.fromEntries([[
    event.recipient,
    "OWNER",
  ]]) as InSpaceGrants;
  const spaceKind = event.spaceKind === undefined
    ? OFFER_KIND
    : event.spaceKind;
  const room = roomLinkOf(
    Room.inSpace(undefined, {
      grants,
      root: event.root !== false,
      ...(spaceKind === null ? {} : { spaceKind }),
    })({ title: event.title }),
  );
  offerRoom.send({ room, id: event.id, title: event.title });
});

/**
 * Offers the event's room to the owner through the inbox the owner's first
 * profile points at, and records the room's space under the offer's key. It
 * runs as an event of its own, queued by the one that creates the room, so
 * that it reads the room's space once the room's creation has committed.
 */
const offerRoom = handler<
  OfferRoomEvent,
  {
    profiles: Writable<ProfileHomeOutput[]>;
    offered: Writable<OfferedSpace[]>;
  }
>((event, { profiles, offered }) => {
  const space = spaceOf(event?.room);
  if (!isWellFormedDID(space)) return;
  offered.push({ id: event.id, space });
  sendToPointedInbox(profiles, envelopeOf(event.id, space, event.title));
});

/**
 * Offers a space again, under another key, through the inbox the owner's
 * first profile points at.
 */
const offerAgain = handler<
  OfferAgainRequest,
  { profiles: Writable<ProfileHomeOutput[]> }
>((event, { profiles }) => {
  sendToPointedInbox(profiles, envelopeOf(event.id, event.space, event.title));
});

/** What the stand-in stores, the FabriChat manager's records among it. */
export interface MainInput extends FabriChatManagerInput {
  privateInbox: Writable<Default<PrivateInboxHolder, Record<never, never>>>;
  profiles: Writable<Default<ProfileHomeOutput[], []>>;
  offered: Writable<Default<OfferedSpace[], []>>;
}

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
  privateInbox: PrivateInboxHolder;
  retainedPrivateInboxes: RetainedPrivateInboxes;
  privateInboxRefusal: PrivateInboxRefusalHolder;
  profiles: ProfileHomeOutput[];
  offered: OfferedSpace[];
  sharedSpaceCatalog: SharedSpaceCatalog;

  /** Registers a vetted space in the catalog, as Home's own stream does. */
  registerSharedSpace: Stream<
    SharedSpaceRegistration,
    SharedSpaceRegistrationResult
  >;

  /** Changes an entry's membership, as Home's own stream does. */
  changeSharedSpaceMembership: Stream<
    SharedSpaceMembershipChange,
    SharedSpaceMembershipResult
  >;

  /** Gives the stand-in its private inbox, as Home's own stream does. */
  ensurePrivateInbox: Stream<EnsurePrivateInboxEvent>;

  /** Creates one of the owner's profiles. */
  createProfile: Stream<void>;

  /** Creates a space as the event's actor, and offers it to the owner. */
  createAndOffer: Stream<CreateAndOfferRequest>;

  /** Offers a space to the owner again, under another key. */
  offerAgain: Stream<OfferAgainRequest>;

  /**
   * Creates a group room from the stand-in's FabriChat manager, which a
   * sender offers to the owner with `offerAgain`.
   */
  createChatGroup: Stream<ManagerStreamEvent>;

  /** The outcome of each of the FabriChat manager's requests. */
  chatRequests: Record<string, ChatRequestOutcome>;

  /**
   * Starts a direct chat from the stand-in's FabriChat manager, which offers
   * it through the inbox of the profile the event names.
   */
  openChatDirect: Stream<ManagerStreamEvent>;

  /** The FabriChat manager's notices. */
  chatNotices: ChatManagerNotice[];

  /**
   * Starts a direct chat from the FabriChat manager listing the rooms the
   * intake registers, as the owner's own manager does.
   */
  openOwnerChat: Stream<ManagerStreamEvent>;

  /** The outcome of each of the owner's FabriChat manager's requests. */
  ownerChatRequests: Record<string, ChatRequestOutcome>;
}

export default pattern<MainInput, MainOutput>((
  {
    privateInbox,
    profiles,
    offered,
    direct,
    requests,
    outgoingNotices,
  },
) => {
  const retainedPrivateInboxes = new Writable<RetainedPrivateInboxes>([]).for(
    "retainedPrivateInboxes",
  );
  const privateInboxRefusal = new Writable<PrivateInboxRefusalHolder>({}).for(
    "privateInboxRefusal",
  );
  const chats = FabriChatManagerCore({
    myProfile: Writable.of<StandInProfile>({ name: "Sender" }),
    // The sender's own catalog, apart from the one the intake registers in.
    sharedSpaceCatalog: Writable.of<SharedSpaceCatalogStorage>({
      entries: {},
      offers: {},
    }),
    direct,
    requests,
    outgoingNotices,
  });
  const catalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  }).for("sharedSpaceCatalog");
  const ownerChats = FabriChatManagerCore({
    myProfile: Writable.of<StandInProfile>({ name: "Owner" }),
    sharedSpaceCatalog: catalog,
    direct: new Writable<Record<string, ChatIndexEntry>>({}).for(
      "ownerChatDirect",
    ),
    requests: new Writable<Record<string, ChatRequestOutcome>>({}).for(
      "ownerChatRequests",
    ),
    outgoingNotices: new Writable<ChatManagerNotice[]>([]).for(
      "ownerChatNotices",
    ),
  });
  return {
    [NAME]: "Share intake fixture",
    [UI]: <div>share intake fixture</div>,
    privateInbox,
    retainedPrivateInboxes,
    privateInboxRefusal,
    profiles,
    offered,
    sharedSpaceCatalog: computed(() => readSharedSpaceCatalog(catalog)),
    registerSharedSpace: registerSharedSpace({ catalog }),
    changeSharedSpaceMembership: changeSharedSpaceMembership({ catalog }),
    ensurePrivateInbox: ensurePrivateInbox({
      privateInbox,
      retainedPrivateInboxes,
      privateInboxRefusal,
      // deno-lint-ignore no-explicit-any
      profiles: profiles as any,
      pointProfiles: pointProfilesAtPrivateInbox({
        privateInbox,
        // deno-lint-ignore no-explicit-any
        profiles: profiles as any,
      }),
    }),
    createProfile: createProfile({ profiles }),
    createAndOffer: createAndOffer({
      offerRoom: offerRoom({ profiles, offered }),
    }),
    offerAgain: offerAgain({ profiles }),
    createChatGroup: chats.createGroup,
    chatRequests: chats.requests,
    openChatDirect: chats.openDirect,
    chatNotices: chats.outgoingNotices,
    openOwnerChat: ownerChats.openDirect,
    ownerChatRequests: ownerChats.requests,
  };
});
