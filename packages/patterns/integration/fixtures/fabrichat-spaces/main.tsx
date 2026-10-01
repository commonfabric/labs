/**
 * A FabriChat manager with a profile of its own, for
 * `fabrichat-spaces-multi-runtime.test.ts`. The real manager resolves its
 * user's profile with `#profile`, which no session of a multi-runtime harness
 * has, and starts no chat without one; this hands its core a stand-in.
 */

import { pattern, Writable } from "commonfabric";
import {
  FabriChatManagerCore,
  type FabriChatManagerOutput,
} from "../../../fabrichat/manager.tsx";
import { type ChatProfile } from "../../../fabrichat/schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

export default pattern<Record<PropertyKey, never>, FabriChatManagerOutput>(
  () => {
    const profile = Writable.of<ChatProfile>({ name: "Starter" });
    return FabriChatManagerCore({ myProfile: profile } as ManagerArg);
  },
);
