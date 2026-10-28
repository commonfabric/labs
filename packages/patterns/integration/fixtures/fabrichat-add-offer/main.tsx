/**
 * Stands in for a person's Home around FabriChat: it holds their private
 * inbox, their profiles, created as `profile-create.tsx` creates them, Home's
 * own steps that give the profiles the inbox, and their FabriChat manager,
 * whose profile is their first. A session links its home space's root here,
 * so that a room's `#chatManager` wish resolves to this manager. Fixture for
 * `fabrichat-add-offer-multi-runtime.test.ts`.
 */

import {
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
  type FabriChatManagerOutput,
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
  ensurePrivateInbox,
  type EnsurePrivateInboxEvent,
  pointProfilesAtPrivateInbox,
  type PrivateInboxHolder,
  type PrivateInboxRefusalHolder,
  type RetainedPrivateInboxes,
} from "../../../system/private-inbox.tsx";

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

/** What the stand-in stores, the FabriChat manager's records among it. */
export interface MainInput extends FabriChatManagerInput {
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

  /** Creates a group room from the person's manager. */
  createGroup: Stream<ManagerStreamEvent>;

  /** The outcome of each of the manager's requests. */
  requests: Record<string, ChatRequestOutcome>;

  /** The person's FabriChat manager, where Home keeps its own. */
  chatManager: FabriChatManagerOutput;
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
  const retainedPrivateInboxes = new Writable<RetainedPrivateInboxes>([]).for(
    "retainedPrivateInboxes",
  );
  const privateInboxRefusal = new Writable<PrivateInboxRefusalHolder>({}).for(
    "privateInboxRefusal",
  );
  const chats = FabriChatManagerCore({
    myProfile: firstProfileOf(profiles),
    sharedSpaceCatalog,
    direct,
    requests,
    outgoingNotices,
  });
  return {
    [NAME]: "FabriChat add offer fixture",
    [UI]: <div>fabrichat add offer fixture</div>,
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
    createGroup: chats.createGroup,
    requests: chats.requests,
    chatManager: chats,
  };
});
