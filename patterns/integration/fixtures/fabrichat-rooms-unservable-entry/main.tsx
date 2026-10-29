/**
 * Stands in for a person's Home around FabriChat: a shared-space catalog the
 * person registers spaces in, and their FabriChat manager over it, whose
 * profile is their first. A registration carries only the fields its event
 * names, so the catalog carries no label. Fixture for
 * `fabrichat-rooms-unservable-entry-multi-runtime.test.ts`.
 */

import {
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
} from "../../../system/fabrichat/manager.tsx";
import {
  type ChatIndexEntry,
  type ChatRequestOutcome,
  type ManagerProfileCell,
} from "../../../system/fabrichat/schemas.tsx";
import ProfileHome, {
  type ProfileHomeOutput,
} from "../../../system/profile-home/profile-home.tsx";
import {
  registerSharedSpaceIn,
  type SharedSpaceCatalogStorage,
} from "../../../system/shared-space/shared-space-catalog.ts";

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

/** What registering a space asks: the space, its host and its kind. */
interface RegisterEvent {
  /** The space to register. */
  space: string;

  /** The host serving the space. */
  host: string;

  /** The kind of space it is. */
  kind: string;
}

/** Registers the event's space in the catalog, saved. */
const register = handler<
  RegisterEvent,
  { catalog: Writable<SharedSpaceCatalogStorage> }
>((event, { catalog }) => {
  registerSharedSpaceIn(catalog, {
    space: event.space,
    host: event.host,
    kind: event.kind,
  });
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

  /** Registers a space in the person's catalog. */
  register: Stream<RegisterEvent>;

  /** Creates a group room from the person's manager. */
  createGroup: Stream<ManagerStreamEvent>;

  /** The outcome of each of the manager's requests. */
  requests: Record<string, ChatRequestOutcome>;

  /** The person's shared-space catalog, as stored. */
  sharedSpaceCatalog: SharedSpaceCatalogStorage;

  /** The rooms the manager lists for the person. */
  rooms: PerUser<ChatIndexEntry[]>;
}

export default pattern<MainInput, MainOutput>((
  { profiles, direct, requests, outgoingNotices },
) => {
  const catalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  }).for("sharedSpaceCatalog");
  const chats = FabriChatManagerCore({
    myProfile: firstProfileOf(profiles),
    sharedSpaceCatalog: catalog,
    direct,
    requests,
    outgoingNotices,
  });
  return {
    [NAME]: "FabriChat unservable catalog entry fixture",
    [UI]: <div>fabrichat unservable catalog entry fixture</div>,
    profiles,
    createProfile: createProfile({ profiles }),
    register: register({ catalog }),
    createGroup: chats.createGroup,
    requests: chats.requests,
    sharedSpaceCatalog: chats.sharedSpaceCatalog,
    rooms: chats.rooms,
  };
});
