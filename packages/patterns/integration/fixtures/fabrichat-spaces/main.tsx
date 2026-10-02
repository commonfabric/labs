/**
 * A FabriChat manager with a profile of its own, for
 * `fabrichat-spaces-multi-runtime.test.ts`. The real manager resolves its
 * user's profile with `#profile`, which no session of a multi-runtime harness
 * has, and starts no chat without one; this hands its core a stand-in. The
 * core owns the same protected records the production manager uses.
 */

import { pattern, Writable } from "commonfabric";
import {
  FabriChatManagerCore,
  type FabriChatManagerOutput,
} from "../../../fabrichat/manager.tsx";
import { type ChatProfile } from "../../../fabrichat/schemas.ts";

export default pattern<
  Record<string, never>,
  FabriChatManagerOutput
>(
  () => {
    const profile = Writable.of<ChatProfile>({ name: "Starter" });
    return FabriChatManagerCore({
      myProfile: profile,
    });
  },
);
