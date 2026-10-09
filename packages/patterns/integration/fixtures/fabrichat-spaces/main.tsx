/**
 * A FabriChat manager with a profile of its own, for
 * `fabrichat-spaces-multi-runtime.test.ts`. The real manager resolves its
 * user's profile with `#profile`, which no session of a multi-runtime harness
 * has, and starts no chat without one; this hands its core a stand-in. Its
 * records are its own inputs, defaulted, as the real manager's are.
 */

import { type AddIntegrity, pattern, Writable } from "commonfabric";
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

export default pattern<FabriChatManagerInput, FabriChatManagerOutput>(
  ({ sharedSpaceCatalog, direct, requests, outgoingNotices }) => {
    const profile = Writable.of<StandInProfile>({ name: "Starter" });
    return FabriChatManagerCore({
      myProfile: profile,
      sharedSpaceCatalog,
      direct,
      requests,
      outgoingNotices,
    });
  },
);
