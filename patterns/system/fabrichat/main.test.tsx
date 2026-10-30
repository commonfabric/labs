/** Keeps a space conversation private until a reviewed creation gesture. */

import {
  action,
  assert,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElementByText,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Loom from "../loom/main.tsx";
import Main from "./main.tsx";
import { CHAT_START_ACTION, CHAT_START_SURFACE } from "./schemas.tsx";

export default pattern(() => {
  const chat = Main({});
  const loom = Loom({});
  const root = wish<
    Writable<{
      chatRoom?: unknown;
      setChatRoom?: unknown;
    }>
  >({ query: "#default" }).result!;
  const install = action(() => {
    root.key("chatRoom").set(loom.chatRoom);
    root.key("setChatRoom").set(loom.setChatRoom);
  });
  const start = action(() => clickButton(chat[UI], "Start conversation"));
  return {
    [TESTS]: [
      { render: chat[UI] },
      { assertion: assert(() => hasText(chat[UI], "Start conversation")) },
      {
        assertion: assert(() =>
          propValue(
            findElementByText(chat[UI], "cf-button", "Start conversation"),
            "disabled",
          ) === true
        ),
      },
      { assertion: assert(() => chat.room.get().messages.count === 0) },
      { assertion: assert(() => !chat.room.get().canSend) },
      { action: install },
      { render: chat[UI] },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      { assertion: assert(() => hasText(chat[UI], "Start conversation")) },
      {
        assertion: assert(() =>
          propValue(
            findElementByText(chat[UI], "cf-button", "Start conversation"),
            "disabled",
          ) === false
        ),
      },
      {
        action: start,
        trustedUi: { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION },
      },
      { render: chat[UI] },
      { assertion: assert(() => loom.chatRoom?.get() !== undefined) },
      {
        assertion: assert(() => loom.chatRoom?.equals(chat.room) === true),
      },
      { assertion: assert(() => !hasText(chat[UI], "Start conversation")) },
    ],
  };
});
