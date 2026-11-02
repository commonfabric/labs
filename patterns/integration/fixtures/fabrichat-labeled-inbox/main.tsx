/**
 * Stands in for a person's Home around FabriChat, in the home space of the
 * person who adds others to rooms, with their profiles and their FabriChat
 * manager, whose profile is their first. A profile is either a Fabric profile
 * as `profile-create.tsx` creates one, or one whose inbox pointer carries the
 * `PersonalSpace` label of the person it is offered to, as a pointer can come
 * to carry its inbox's label. That person's stand-in creates a private inbox
 * and points their labeled profile at it, as Home's own steps do. Fixture for
 * `fabrichat-labeled-inbox-multi-runtime.test.ts`.
 */

import {
  type Cell,
  type Cfc,
  type Confidential,
  type CurrentPrincipal,
  Default,
  handler,
  NAME,
  pattern,
  type RepresentsCurrentUser,
  type Stream,
  UI,
  type VNode,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  FabriChatManagerCore,
  type FabriChatManagerInput,
  type ManagerStreamEvent,
} from "../../../system/fabrichat/manager.tsx";
import {
  type ChatManagerNotice,
  type ChatRequestOutcome,
  type ManagerProfileCell,
} from "../../../system/fabrichat/schemas.tsx";
import PrivateInbox, {
  type PrivateInboxHolder,
} from "../../../system/private-inbox/private-inbox.tsx";
import ProfileHome, {
  type ProfileHomeOutput,
  type ProfileInbox,
  type ShareInboxPiece,
} from "../../../system/profile-home/profile-home.tsx";

/**
 * The label of the space of the person a labeled profile is offered to: they
 * are the DID the harness derives for the session
 * `fabrichat-labeled-inbox-grace`.
 */
const INVITEE_LABEL = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: "did:key:z6Mkv4owUpSDRe9uYnrgBeQtoT7kE7RvU67BtfR8m9N2QNCa",
} as const;

/** An inbox pointer carrying the invitee's label. */
type LabeledPointer = Confidential<
  ProfileInbox,
  readonly [typeof INVITEE_LABEL]
>;

/** What setting the labeled profile's name asks: the name. */
interface SetNameEvent {
  /** The name to set. */
  name?: string;
}

/** Sets the labeled profile's name, its one writer, as a profile's is. */
const setName = handler<SetNameEvent, { name: Writable<string> }>(
  (event, { name }) => {
    name.set(event?.name ?? "");
  },
);

/**
 * The labeled profile's name, written by `setName` alone and representing its
 * owner, as a Fabric profile's name is.
 */
type OwnName = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<string, typeof setName>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

/** What pointing the labeled profile at an inbox asks: the inbox. */
interface SetInboxEvent {
  /** The inbox piece to point at. */
  // `Cell<…>` is written out rather than reached through an alias: the
  // handler's event schema marks a reference position only where the wrapper
  // is written in the event type.
  inbox?: Cell<ShareInboxPiece>;
}

/** Points the labeled profile at the event's inbox. */
const setInbox = handler<SetInboxEvent, { inbox: Writable<LabeledPointer> }>(
  (event, { inbox }) => {
    inbox.set(event?.inbox === undefined ? {} : { piece: event.inbox });
  },
);

/** What the labeled profile holds. */
type LabeledProfileInput = Record<never, never>;

/** The labeled profile's result. */
interface LabeledProfileOutput {
  [NAME]: string;

  /** The person's display name. */
  name: OwnName;

  /** Where the person's offers are delivered, carrying the invitee's label. */
  inbox: LabeledPointer;

  /** Sets the person's display name. */
  setName: Stream<SetNameEvent>;

  /** Points the profile at an inbox. */
  setInbox: Stream<SetInboxEvent>;
}

/** A profile whose inbox pointer carries the invitee's label. */
const LabeledProfile = pattern<LabeledProfileInput, LabeledProfileOutput>(
  () => {
    const name = new Writable<OwnName>("").for("name");
    const inbox = new Writable<LabeledPointer>({} as LabeledPointer).for(
      "inbox",
    );
    return {
      [NAME]: "Labeled profile",
      name,
      inbox,
      setName: setName({ name }),
      setInbox: setInbox({ inbox }),
    };
  },
);

/** The person's first profile, as the profile a FabriChat manager reads. */
function firstProfileOf(
  profiles: Writable<ProfileHomeOutput[]>,
): ManagerProfileCell;
function firstProfileOf(profiles: Writable<ProfileHomeOutput[]>): unknown {
  return profiles.key(0);
}

/** A newly created profile, as an entry in the profile list. */
function asProfile(profile: unknown): ProfileHomeOutput;
function asProfile(profile: unknown): unknown {
  return profile;
}

/** A newly created inbox, as the link the holder keeps. */
function asInbox(inbox: unknown): Cell<ShareInboxPiece>;
function asInbox(inbox: unknown): unknown {
  return inbox;
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
    asProfile(
      ProfileHome.inSpace(undefined, { grants: { "*": "WRITE" }, root: true })(
        { initialName: event?.name ?? "Someone" },
      ),
    ),
  );
});

/** Creates a profile whose inbox pointer carries the invitee's label. */
const createLabeledProfile = handler<
  Record<PropertyKey, never>,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.push(
    asProfile(
      LabeledProfile.inSpace(undefined, {
        grants: { "*": "WRITE" },
        root: true,
      })({}),
    ),
  );
});

/**
 * Creates the person's private inbox, in a space of its own that grants
 * anyone `WRITE`, as Home's is.
 */
const createInbox = handler<
  Record<PropertyKey, never>,
  { privateInbox: Writable<PrivateInboxHolder> }
>((_event, { privateInbox }) => {
  privateInbox.set({
    piece: asInbox(
      PrivateInbox.inSpace(undefined, { grants: { "*": "WRITE" }, root: true })(
        { offers: [] },
      ),
    ),
  });
});

/** The stream that points a labeled profile at an inbox. */
function setInboxOf(
  profile: Writable<ProfileHomeOutput>,
): Writable<{ setInbox: Stream<SetInboxEvent> }>;
function setInboxOf(profile: Writable<ProfileHomeOutput>): unknown {
  return profile;
}

/**
 * Points the person's first profile at their private inbox, through the
 * profile's own `setInbox`, without reading the profile's pointer. It runs
 * apart from `createInbox`, once the inbox exists.
 */
const pointInbox = handler<
  Record<PropertyKey, never>,
  {
    privateInbox: Writable<PrivateInboxHolder>;
    profiles: Writable<ProfileHomeOutput[]>;
  }
>((_event, { privateInbox, profiles }) => {
  const inbox = privateInbox.get()?.piece?.resolveAsCell();
  if (inbox === undefined) return;
  setInboxOf(profiles.key(0)).key("setInbox").send({ inbox });
});

/** What the stand-in stores, the FabriChat manager's records among it. */
export interface MainInput extends FabriChatManagerInput {
  privateInbox: Writable<Default<PrivateInboxHolder, Record<never, never>>>;
  profiles: Writable<Default<ProfileHomeOutput[], []>>;
}

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
  privateInbox: PrivateInboxHolder;
  profiles: ProfileHomeOutput[];

  /** Creates one of the person's profiles. */
  createProfile: Stream<CreateProfileEvent>;

  /** Creates a profile whose inbox pointer carries the invitee's label. */
  createLabeledProfile: Stream<Record<PropertyKey, never>>;

  /** Creates the person's private inbox. */
  createInbox: Stream<Record<PropertyKey, never>>;

  /** Points the person's first profile at their private inbox. */
  pointInbox: Stream<Record<PropertyKey, never>>;

  /** Finds or creates a direct room from the person's manager. */
  openDirect: Stream<ManagerStreamEvent>;

  /** Creates a group room from the person's manager. */
  createGroup: Stream<ManagerStreamEvent>;

  /** Offers a room of the person's to a member added to it. */
  offerRoom: Stream<ManagerStreamEvent>;

  /** The outcome of each of the manager's requests. */
  requests: Record<string, ChatRequestOutcome>;

  /** The notices the manager holds for a client to deliver. */
  outgoingNotices: ChatManagerNotice[];
}

export default pattern<MainInput, MainOutput>((
  {
    privateInbox,
    profiles,
    sharedSpaceCatalog,
    direct,
    requests,
    outgoingNotices,
  },
) => {
  const profile = firstProfileOf(profiles);
  const chats = FabriChatManagerCore({
    myProfile: profile,
    sessionProfile: profile,
    sharedSpaceCatalog,
    direct,
    requests,
    outgoingNotices,
  });
  return {
    [NAME]: "FabriChat labeled inbox fixture",
    [UI]: <div>fabrichat labeled inbox fixture</div>,
    privateInbox,
    profiles,
    createProfile: createProfile({ profiles }),
    createLabeledProfile: createLabeledProfile({ profiles }),
    createInbox: createInbox({ privateInbox }),
    pointInbox: pointInbox({ privateInbox, profiles }),
    openDirect: chats.openDirect,
    createGroup: chats.createGroup,
    offerRoom: chats.offerRoom,
    requests: chats.requests,
    outgoingNotices: chats.outgoingNotices,
  };
});
