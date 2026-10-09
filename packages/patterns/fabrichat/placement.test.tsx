/** Verifies placements retain room links and redact unavailable room facts. */

import {
  action,
  type AddIntegrity,
  assert,
  FabricEpochNsec,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import FabriChatAdapter from "./adapter.tsx";
import FabriChatPlacement from "./placement.tsx";
import { CHAT_POLICY } from "./records.ts";
import { FabriChatRoom } from "./room.tsx";
import type { ChatRoomAbout, ChatRoomPolicy } from "./schemas.tsx";

export default pattern(() => {
  const policy = new Writable<AddIntegrity<ChatRoomPolicy, ["chat-test"]>>(
    CHAT_POLICY,
  );
  const about = new Writable<AddIntegrity<ChatRoomAbout, ["chat-test"]>>();
  const room = FabriChatRoom({ about });
  const first = FabriChatPlacement({ room });
  const second = FabriChatPlacement({ room });
  const adapter = FabriChatAdapter({ placement: first });
  const initialize = action(() => {
    about.set({
      kind: "direct",
      createdAt: new FabricEpochNsec(0n),
      policy,
    });
  });
  return {
    [TESTS]: [
      {
        assertion: assert(() => first[VIEWS].chat.state === "unavailable"),
      },
      { assertion: assert(() => first[VIEWS].chat.about?.get() === undefined) },
      {
        assertion: assert(() =>
          first[VIEWS].chat.messages?.get() === undefined
        ),
      },
      {
        assertion: assert(() =>
          adapter[VIEWS].chat.get().state === "unavailable"
        ),
      },
      { action: initialize },
      { assertion: assert(() => first[VIEWS].chat.state === "member") },
      { assertion: assert(() => second[VIEWS].chat.state === "member") },
      { assertion: assert(() => first.room.equals(second.room)) },
      {
        assertion: assert(() =>
          first[VIEWS].chat.messages?.equals(first.room.key("messages")) ===
            true
        ),
      },
      {
        assertion: assert(() =>
          first[VIEWS].chat.about?.equals(first.room.key("about")) === true
        ),
      },
      {
        assertion: assert(() =>
          adapter[VIEWS].chat.equals(adapter.placement.key(VIEWS).key("chat"))
        ),
      },
      { assertion: assert(() => adapter[VIEWS].chat.get().state === "member") },
    ],
  };
});
