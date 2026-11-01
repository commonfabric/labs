/**
 * Stands in for a person's Home around FabriChat, in their home space, whose
 * FabriChat manager's profile is one whose inbox pointer carries the person's
 * `PersonalSpace` label, as a pointer can come to carry its inbox's label. The
 * profile lives in a space of its own, as a person's profile does, and is the
 * person's own, as a Fabric profile is: its name's owner policy names them.
 * Fixture for `fabrichat-labeled-own-profile-multi-runtime.test.ts`.
 */

import {
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
  type ChatRequestOutcome,
  type ManagerProfileCell,
} from "../../../system/fabrichat/schemas.tsx";

/**
 * The label of the person's own space: they are the DID the harness derives
 * for the session `fabrichat-labeled-own-profile-ada`, whose home space this
 * is.
 */
const HOME_LABEL = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: "did:key:z6MkjGZUMuQpf6DMV3GxfZRZr9AvJgnkMtmXC3tetprSKxsU",
} as const;

/** An inbox pointer carrying the person's label, with what it points at. */
type LabeledPointer = Confidential<
  { piece?: { offers?: string[] } },
  readonly [typeof HOME_LABEL]
>;

/** What setting the profile stand-in's name asks: the name. */
interface SetNameEvent {
  /** The name to set. */
  name?: string;
}

/** Sets the profile stand-in's name, its one writer, as a profile's is. */
const setName = handler<SetNameEvent, { name: Writable<string> }>(
  (event, { name }) => {
    name.set(event?.name ?? "");
  },
);

/**
 * The profile stand-in's name, written by `setName` alone and representing
 * its owner, as a Fabric profile's name is.
 */
type OwnName = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<string, typeof setName>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

/** What the profile stand-in holds. */
type LabeledProfileInput = Record<never, never>;

/** The profile stand-in's result. */
interface LabeledProfileOutput {
  [NAME]: string;

  /** The person's display name. */
  name: OwnName;

  /** Where the person's offers are delivered, carrying their label. */
  inbox: LabeledPointer;

  /** Sets the person's display name. */
  setName: Stream<SetNameEvent>;
}

/** A profile whose inbox pointer carries the person's label. */
const LabeledProfile = pattern<LabeledProfileInput, LabeledProfileOutput>(
  () => {
    const name = new Writable<OwnName>("").for("name");
    const inbox = new Writable<LabeledPointer>(
      { piece: { offers: [] } } as LabeledPointer,
    ).for("inbox");
    return {
      [NAME]: "Labeled profile",
      name,
      inbox,
      setName: setName({ name }),
    };
  },
);

/** The person's profiles, as the stand-in stores them. */
type Profiles = LabeledProfileOutput[];

/** The person's first profile, as the profile a FabriChat manager reads. */
function firstProfileOf(profiles: Writable<Profiles>): ManagerProfileCell;
function firstProfileOf(profiles: Writable<Profiles>): unknown {
  return profiles.key(0);
}

/** A newly created profile stand-in, as an entry in the profile list. */
function asProfile(profile: unknown): LabeledProfileOutput;
function asProfile(profile: unknown): unknown {
  return profile;
}

/** What creating a profile asks: nothing. */
type CreateProfileEvent = Record<never, never>;

/** Creates one of the person's profiles, in a space of its own. */
const createProfile = handler<
  CreateProfileEvent,
  { profiles: Writable<Profiles> }
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

/** What the stand-in stores, the FabriChat manager's records among it. */
export interface MainInput extends FabriChatManagerInput {
  profiles: Writable<Default<Profiles, []>>;
}

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
  profiles: Profiles;

  /** Creates one of the person's profiles. */
  createProfile: Stream<CreateProfileEvent>;

  /** Finds or creates a direct room from the person's manager. */
  openDirect: Stream<ManagerStreamEvent>;

  /** Creates a group room from the person's manager. */
  createGroup: Stream<ManagerStreamEvent>;

  /** The outcome of each of the manager's requests. */
  requests: Record<string, ChatRequestOutcome>;
}

export default pattern<MainInput, MainOutput>((
  { profiles, sharedSpaceCatalog, direct, requests, outgoingNotices },
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
    [NAME]: "FabriChat labeled own profile fixture",
    [UI]: <div>fabrichat labeled own profile fixture</div>,
    profiles,
    createProfile: createProfile({ profiles }),
    openDirect: chats.openDirect,
    createGroup: chats.createGroup,
    requests: chats.requests,
  };
});
