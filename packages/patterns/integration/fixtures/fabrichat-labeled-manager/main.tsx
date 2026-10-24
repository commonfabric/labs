/**
 * Stands in for a person's Home around FabriChat, in their home space: it
 * holds their profiles, created as `profile-create.tsx` creates them, and their
 * FabriChat manager, whose profile is their first. The manager a room's
 * `#chatManager` wish reaches carries the person's `PersonalSpace` label, which
 * no room's space admits, on a result document of its own that passes the
 * manager through. The manager's own documents declare no confidentiality, so
 * the label reaches a room only through the wish's result, which the room's
 * space holds. A manager whose own root carries the label, in the person's home
 * space, as a real Home's manager can, is the case
 * `fabrichat-flat-manager-send.test.ts` covers. A session links its home
 * space's root here, so that the wish resolves to it. Fixture for
 * `fabrichat-labeled-manager-multi-runtime.test.ts`.
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

/**
 * The label of the person's own space: they are the DID the harness derives
 * for the session `fabrichat-labeled-manager-ada`, whose home space this is.
 */
const HOME_LABEL = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: "did:key:z6MkqonmiAA2fg5wAEkagDYr8ghbNvmRD4QBTCB8tihLvHuN",
} as const;

/** The person's manager, as a document carrying `HOME_LABEL`. */
type LabeledManager = Confidential<
  FabriChatManagerOutput,
  readonly [typeof HOME_LABEL]
>;

/**
 * Passes the manager through a result document of its own, whose schema
 * declares `HOME_LABEL` over all of it.
 */
const LabelManager = pattern<
  { manager: FabriChatManagerOutput },
  LabeledManager
>(
  ({ manager }) => manager as LabeledManager,
);

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
  profiles: Writable<Default<ProfileHomeOutput[], []>>;
}

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
  profiles: ProfileHomeOutput[];

  /** Creates one of the person's profiles. */
  createProfile: Stream<CreateProfileEvent>;

  /** Creates a group room from the person's manager. */
  createGroup: Stream<ManagerStreamEvent>;

  /** The outcome of each of the manager's requests. */
  requests: Record<string, ChatRequestOutcome>;

  /**
   * The person's FabriChat manager, where Home keeps its own, reached through
   * the document carrying `HOME_LABEL`. Home's own result declares nothing,
   * so a wish resolved through it reads no label unless it reaches the
   * manager.
   */
  chatManager: FabriChatManagerOutput;
}

export default pattern<MainInput, MainOutput>((
  { profiles, sharedSpaceCatalog, direct, requests, outgoingNotices },
) => {
  const chats = FabriChatManagerCore({
    myProfile: firstProfileOf(profiles),
    sharedSpaceCatalog,
    direct,
    requests,
    outgoingNotices,
  });
  return {
    [NAME]: "FabriChat labeled manager fixture",
    [UI]: <div>fabrichat labeled manager fixture</div>,
    profiles,
    createProfile: createProfile({ profiles }),
    createGroup: chats.createGroup,
    requests: chats.requests,
    chatManager: LabelManager({ manager: chats }) as FabriChatManagerOutput,
  };
});
