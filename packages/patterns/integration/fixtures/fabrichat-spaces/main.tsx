/**
 * A FabriChat manager with a profile of its own, for
 * `fabrichat-spaces-multi-runtime.test.ts`. The real manager resolves its
 * user's profile with `#profile`, which no session of a multi-runtime harness
 * has, and starts no chat without one; this hands its core a stand-in. Its
 * records are its own inputs, defaulted, as the real manager's are.
 */

import { pattern, Writable } from "commonfabric";
import {
  FabriChatManagerCore,
  type FabriChatManagerInput,
  type FabriChatManagerOutput,
} from "../../../fabrichat/manager.tsx";
import { type ChatProfile } from "../../../fabrichat/schemas.tsx";

export default pattern<FabriChatManagerInput, FabriChatManagerOutput>(
  ({ rooms, direct, requests, outgoingNotices, handledOffers }) => {
    const profile = Writable.of<ChatProfile>({ name: "Starter" });
    return FabriChatManagerCore({
      myProfile: profile,
      rooms,
      direct,
      requests,
      outgoingNotices,
      handledOffers,
    });
  },
);
