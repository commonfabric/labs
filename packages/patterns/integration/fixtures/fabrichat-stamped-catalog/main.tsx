/**
 * Stands in for a person's Home around FabriChat, in their home space, with a
 * share inbox whose offers carry the person's `PersonalSpace` label. Taking an
 * offer into the person's shared-space catalog, as Home's share intake does,
 * carries that label into the catalog, which no room's space admits. The
 * person's FabriChat manager, whose profile is their first, creates rooms over
 * that catalog. An offer naming a space the catalog lists, with a title,
 * retitles that space's entry, which carries the label onto the entry's title
 * alone. The catalog and the share inbox are each a cell of their own, apart
 * from the manager's records, as Home's catalog and a share inbox are. The
 * stand-in also holds a private inbox, as Home does, which its profiles point
 * at, so that another person's manager can offer them a room. Fixture for
 * `fabrichat-stamped-catalog-multi-runtime.test.ts` and
 * `fabrichat-stamped-title-offers-multi-runtime.test.ts`.
 */

import {
  type Confidential,
  Default,
  handler,
  NAME,
  pattern,
  type PerUser,
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
  type ChatManagerNotice,
  type ChatRequestOutcome,
  type ManagerProfileCell,
} from "../../../fabrichat/schemas.tsx";
import {
  ensurePrivateInbox,
  type EnsurePrivateInboxEvent,
  pointProfilesAtPrivateInbox,
  type PrivateInboxHolder,
  type PrivateInboxRefusalHolder,
  type RetainedPrivateInboxes,
} from "../../../system/private-inbox.tsx";
import ProfileHome, {
  type ProfileHomeOutput,
} from "../../../system/profile-home.tsx";
import {
  registerSharedSpaceIn,
  retitleSharedSpaceIn,
  type SharedSpaceCatalogStorage,
} from "../../../system/shared-space-catalog.ts";

/**
 * The label of the person's own space: they are the DID the harness derives
 * for the session `fabrichat-stamped-catalog-ada`, whose home space this is.
 */
const HOME_LABEL = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: "did:key:z6MkgE21ZYyXAwWUKi527Y7ynYYDiRy1vjL1JVqn13hwu4VH",
} as const;

/** An offer of a space, as a share inbox holds one. */
interface InboxOffer {
  /** The principal offering the space. */
  from: string;

  /** The offer's id, unique to its sender. */
  id: string;

  /** The space offered. */
  space: string;

  /** The host serving the space. */
  host: string;

  /** The space's title, as its sender gives it. */
  title?: string;
}

/** The inbox's offers, readable by the person alone. */
type InboxOffers = Confidential<InboxOffer[], readonly [typeof HOME_LABEL]>;

/** The person's first profile, as the profile a FabriChat manager reads. */
function firstProfileOf(
  profiles: Writable<ProfileHomeOutput[]>,
): ManagerProfileCell;
function firstProfileOf(profiles: Writable<ProfileHomeOutput[]>): unknown {
  return profiles.key(0);
}

/** What creating a profile asks: the name to give it. */
interface CreateProfileEvent {
  /** The profile's name. */
  name?: string;
}

/**
 * Creates one of the person's profiles, in a space of its own that grants
 * anyone `WRITE`, as `profile-create.tsx` does.
 */
const createProfile = handler<
  CreateProfileEvent,
  { profiles: Writable<ProfileHomeOutput[]> }
>((event, { profiles }) => {
  profiles.push(
    ProfileHome.inSpace(undefined, { grants: { "*": "WRITE" }, root: true })({
      initialName: event?.name ?? "Someone",
    }) as ProfileHomeOutput,
  );
});

/** What receiving an offer asks: the offer. */
interface ReceiveEvent {
  /** The offer received. */
  offer: InboxOffer;
}

/** Adds the event's offer to the inbox. */
const receive = handler<ReceiveEvent, { inbox: Writable<InboxOffers> }>(
  (event, { inbox }) => {
    inbox.push(event.offer);
  },
);

/** Registers the space each of the inbox's offers names in the catalog. */
const ingest = handler<
  Record<PropertyKey, never>,
  {
    inbox: Writable<InboxOffers>;
    catalog: Writable<SharedSpaceCatalogStorage>;
  }
>((_, { inbox, catalog }) => {
  for (const offer of inbox.get() ?? []) {
    registerSharedSpaceIn(catalog, {
      space: offer.space,
      host: offer.host,
      kind: "workspace",
      offer: { from: offer.from, id: offer.id },
    });
  }
});

/**
 * Retitles the catalog's entry for each space the inbox's offers name, to the
 * offer's title. An offer with no title, or naming a space the catalog
 * doesn't list, changes nothing.
 */
const retitle = handler<
  Record<PropertyKey, never>,
  {
    inbox: Writable<InboxOffers>;
    catalog: Writable<SharedSpaceCatalogStorage>;
  }
>((_, { inbox, catalog }) => {
  for (const offer of inbox.get() ?? []) {
    if (offer.title === undefined) continue;
    retitleSharedSpaceIn(catalog, { space: offer.space, title: offer.title });
  }
});

/** What the stand-in stores, the FabriChat manager's records among it. */
export interface MainInput
  extends Omit<FabriChatManagerInput, "sharedSpaceCatalog"> {
  privateInbox: Writable<Default<PrivateInboxHolder, Record<never, never>>>;
  profiles: Writable<Default<ProfileHomeOutput[], []>>;
}

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
  privateInbox: PrivateInboxHolder;
  retainedPrivateInboxes: RetainedPrivateInboxes;
  privateInboxRefusal: PrivateInboxRefusalHolder;
  profiles: ProfileHomeOutput[];

  /** Gives the stand-in its private inbox, as Home's own stream does. */
  ensurePrivateInbox: Stream<EnsurePrivateInboxEvent>;

  /** Creates one of the person's profiles. */
  createProfile: Stream<CreateProfileEvent>;

  /** Adds an offer to the person's share inbox. */
  receive: Stream<ReceiveEvent>;

  /** Takes the share inbox's offers into the person's catalog. */
  ingest: Stream<Record<PropertyKey, never>>;

  /** Retitles the catalog's entries the share inbox's offers name. */
  retitle: Stream<Record<PropertyKey, never>>;

  /** Finds or creates a direct room from the person's manager. */
  openDirect: Stream<ManagerStreamEvent>;

  /** Creates a group room from the person's manager. */
  createGroup: Stream<ManagerStreamEvent>;

  /** Offers a room of the person's to a member added to it. */
  offerRoom: Stream<ManagerStreamEvent>;

  /** Joins a room, listing it in the person's catalog. */
  joinRoom: Stream<ManagerStreamEvent>;

  /** The outcome of each of the manager's requests. */
  requests: Record<string, ChatRequestOutcome>;

  /** The notices the manager holds for a client to deliver. */
  outgoingNotices: PerUser<ChatManagerNotice[]>;

  /** The person's shared-space catalog, as stored. */
  sharedSpaceCatalog: SharedSpaceCatalogStorage;
}

export default pattern<MainInput, MainOutput>((
  { privateInbox, profiles, direct, requests, outgoingNotices },
) => {
  const retainedPrivateInboxes = new Writable<RetainedPrivateInboxes>([]).for(
    "retainedPrivateInboxes",
  );
  const privateInboxRefusal = new Writable<PrivateInboxRefusalHolder>({}).for(
    "privateInboxRefusal",
  );
  const catalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  }).for("sharedSpaceCatalog");
  const inbox = new Writable<InboxOffers>([]).for("inbox");
  const chats = FabriChatManagerCore({
    myProfile: firstProfileOf(profiles),
    sharedSpaceCatalog: catalog,
    direct,
    requests,
    outgoingNotices,
  });
  return {
    [NAME]: "FabriChat stamped catalog fixture",
    [UI]: <div>fabrichat stamped catalog fixture</div>,
    privateInbox,
    retainedPrivateInboxes,
    privateInboxRefusal,
    profiles,
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
    receive: receive({ inbox }),
    ingest: ingest({ inbox, catalog }),
    retitle: retitle({ inbox, catalog }),
    openDirect: chats.openDirect,
    createGroup: chats.createGroup,
    offerRoom: chats.offerRoom,
    joinRoom: chats.joinRoom,
    requests: chats.requests,
    outgoingNotices: chats.outgoingNotices,
    sharedSpaceCatalog: chats.sharedSpaceCatalog,
  };
});
