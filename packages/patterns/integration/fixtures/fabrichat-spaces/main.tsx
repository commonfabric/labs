/**
 * A FabriChat manager with a profile of its own, for
 * `fabrichat-spaces-multi-runtime.test.ts`. The real manager resolves its
 * user's profile with `#profile`, and starts no chat without one; this hands
 * its core a stand-in. Its records are its own inputs, defaulted, as the real
 * manager's are. A member can claim an attested profile for the test host to
 * select, letting the real room resolve `#profile` when that member sends.
 */

import {
  type AddIntegrity,
  type Cell,
  computed,
  handler,
  NAME,
  pattern,
  principalOf,
  type RepresentsCurrentUser,
  type Stream,
  type TrustedActionWrite,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  FabriChatManagerCore,
  type FabriChatManagerInput,
  type FabriChatManagerOutput,
} from "../../../fabrichat/manager.tsx";
import { type ChatProfile } from "../../../fabrichat/schemas.tsx";

/**
 * The stand-in profile, labeled, as a Fabric profile is, because a room's
 * participants link only a document that carries a label.
 */
type StandInProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** An authenticated member's profile, selected by the test host as their own. */
type MemberProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof claimProfile,
    "FabriChatTestWriteProfile",
    "FabriChatTestProfileSurface"
  >
>;

/** The member's profile writer state. */
interface ProfileState {
  profile: Writable<MemberProfile>;
}

/** Labels the selected profile with the principal who operates its control. */
const claimProfile = handler<{ name: string }, ProfileState>(
  ({ name }, { profile }) => {
    profile.set({ name } as MemberProfile);
  },
);

/** The manager plus the viewer profile the harness can select for a member. */
interface TestOutput extends FabriChatManagerOutput {
  memberProfile: Cell<ChatProfile>;
  memberPrincipal: string | undefined;
  claimProfile: Stream<{ name: string }>;
}

export default pattern<FabriChatManagerInput, TestOutput>(
  ({ sharedSpaceCatalog, direct, requests, outgoingNotices }) => {
    const profile = Writable.of<StandInProfile>({ name: "Starter" });
    const memberProfile = new Writable<MemberProfile>();
    const manager = FabriChatManagerCore({
      myProfile: profile,
      sharedSpaceCatalog,
      direct,
      requests,
      outgoingNotices,
    });
    return {
      [NAME]: manager[NAME],
      [UI]: manager[UI],
      [VIEWS]: manager[VIEWS],
      rooms: manager.rooms,
      sharedSpaceCatalog: manager.sharedSpaceCatalog,
      direct: manager.direct,
      requests: manager.requests,
      outgoingNotices: manager.outgoingNotices,
      openDirect: manager.openDirect,
      createGroup: manager.createGroup,
      accept: manager.accept,
      forget: manager.forget,
      delivered: manager.delivered,
      memberProfile,
      memberPrincipal: computed(() =>
        principalOf(memberProfile, "represents-principal")
      ),
      claimProfile: claimProfile({ profile: memberProfile }),
    };
  },
);
