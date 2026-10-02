/**
 * A FabriChat manager with a profile of its own, for
 * `fabrichat-spaces-multi-runtime.test.ts`. The real manager resolves its
 * user's profile with `#profile`, which no session of a multi-runtime harness
 * has, and starts no chat without one; this hands its core a stand-in. The
 * core owns the same protected records the production manager uses.
 */

import {
  NAME,
  pattern,
  UI,
  VIEWS,
  wish,
  type WishState,
  Writable,
} from "commonfabric";
import {
  FabriChatManagerCore,
  type FabriChatManagerOutput,
} from "../../../fabrichat/manager.tsx";
import { type ChatProfile } from "../../../fabrichat/schemas.ts";

export default pattern<
  Record<string, never>,
  FabriChatManagerOutput & { profileWish: WishState<ChatProfile> }
>(
  () => {
    const profile = Writable.of<ChatProfile>({ name: "Starter" });
    const manager = FabriChatManagerCore({
      myProfile: profile,
    });
    return {
      [NAME]: manager[NAME],
      [UI]: manager[UI],
      [VIEWS]: manager[VIEWS],
      rooms: manager.rooms,
      direct: manager.direct,
      requests: manager.requests,
      outgoingNotices: manager.outgoingNotices,
      openDirect: manager.openDirect,
      createGroup: manager.createGroup,
      accept: manager.accept,
      forget: manager.forget,
      delivered: manager.delivered,
      profileWish: wish<ChatProfile>({ query: "#profile" }),
    };
  },
);
