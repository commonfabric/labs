/** Keeps a space conversation private until a reviewed creation gesture. */
import { assert, pattern, TESTS, UI } from "commonfabric";
import Main from "./main.tsx";
import {
  findElementByText,
  hasText,
  propValue,
} from "../test/vnode-helpers.ts";

export default pattern(() => {
  const chat = Main({});
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
    ],
  };
});
