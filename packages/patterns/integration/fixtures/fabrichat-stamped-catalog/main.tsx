/**
 * Stands in for a person's Home around FabriChat, in their home space, with a
 * share inbox whose offers carry the person's `PersonalSpace` label. Taking an
 * offer into the person's shared-space catalog, as Home's share intake does,
 * carries that label into the catalog, which no room's space admits. The
 * person's FabriChat manager, whose profile is their first, creates rooms over
 * that catalog. The catalog and the inbox are each a cell of their own, apart
 * from the manager's records, as Home's catalog and a share inbox are.
 * Fixture for `fabrichat-stamped-catalog-multi-runtime.test.ts`.
 */

import {
  type Confidential,
  Default,
  handler,
  NAME,
  pattern,
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
  type ChatRequestOutcome,
  type ManagerProfileCell,
} from "../../../fabrichat/schemas.tsx";
import ProfileHome, {
  type ProfileHomeOutput,
} from "../../../system/profile-home.tsx";
import {
  registerSharedSpaceIn,
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

/** What the stand-in stores, the FabriChat manager's records among it. */
export interface MainInput
  extends Omit<FabriChatManagerInput, "sharedSpaceCatalog"> {
  profiles: Writable<Default<ProfileHomeOutput[], []>>;
}

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
  profiles: ProfileHomeOutput[];

  /** Creates one of the person's profiles. */
  createProfile: Stream<CreateProfileEvent>;

  /** Adds an offer to the person's share inbox. */
  receive: Stream<ReceiveEvent>;

  /** Takes the share inbox's offers into the person's catalog. */
  ingest: Stream<Record<PropertyKey, never>>;

  /** Finds or creates a direct room from the person's manager. */
  openDirect: Stream<ManagerStreamEvent>;

  /** Creates a group room from the person's manager. */
  createGroup: Stream<ManagerStreamEvent>;

  /** The outcome of each of the manager's requests. */
  requests: Record<string, ChatRequestOutcome>;

  /** The person's shared-space catalog, as stored. */
  sharedSpaceCatalog: SharedSpaceCatalogStorage;
}

export default pattern<MainInput, MainOutput>((
  { profiles, direct, requests, outgoingNotices },
) => {
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
    profiles,
    createProfile: createProfile({ profiles }),
    receive: receive({ inbox }),
    ingest: ingest({ inbox, catalog }),
    openDirect: chats.openDirect,
    createGroup: chats.createGroup,
    requests: chats.requests,
    sharedSpaceCatalog: chats.sharedSpaceCatalog,
  };
});
