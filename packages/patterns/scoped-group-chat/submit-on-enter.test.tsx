import { action, assert, pattern, TESTS, UI } from "commonfabric";
import { findNodeByProp, fireEvent, propValue } from "../test/vnode-helpers.ts";
import ScopedGroupChatPlainInputs from "./main-plain-inputs.tsx";
import ScopedGroupChatWritableInputs from "./main-with-writable-inputs.tsx";

// Pressing Enter in a `cf-input` fires its `oncf-submit` with the serialized
// custom event: the event's `type`, and the component's `detail`.
const pressEnter = (root: unknown, label: string, value: string): void =>
  fireEvent(
    findNodeByProp(root, "aria-label", label),
    "oncf-submit",
    { type: "cf-submit", detail: { value } },
    `the "${label}" field`,
  );

export default pattern(() => {
  const plain = ScopedGroupChatPlainInputs({
    newRoomName: "Lobby",
    draft: "Hello",
  });
  const writable = ScopedGroupChatWritableInputs({
    newRoomName: "Lobby",
    draft: "Hello",
  });
  const chats = [plain, writable];

  // Enter acts on what the field has written to its cell, so the field must
  // write each keystroke at once: under a delayed write, the text lands after
  // the handler has cleared the field, and puts it back.
  const assert_fields_write_immediately = assert(() =>
    chats.every((chat) =>
      ["Room name", "Message"].every((label) =>
        propValue(
          findNodeByProp(chat[UI], "aria-label", label),
          "timingStrategy",
        ) === "immediate"
      )
    )
  );

  const assert_no_rooms_yet = assert(() =>
    chats.every((chat) => chat.roomCount === 0)
  );

  const action_press_enter_in_room_name = action(() => {
    for (const chat of chats) pressEnter(chat[UI], "Room name", "Lobby");
  });

  const assert_enter_added_the_room = assert(() =>
    chats.every((chat) =>
      chat.roomCount === 1 &&
      chat.conversation.rooms[0]?.name === "Lobby" &&
      chat.newRoomName === ""
    )
  );

  const action_press_enter_in_message = action(() => {
    for (const chat of chats) pressEnter(chat[UI], "Message", "Hello");
  });

  const assert_enter_sent_the_message = assert(() =>
    chats.every((chat) =>
      chat.messageCount === 1 &&
      chat.conversation.rooms[0]?.messages[0]?.body === "Hello" &&
      chat.draft === ""
    )
  );

  return {
    [TESTS]: [
      { assertion: assert_fields_write_immediately },
      { assertion: assert_no_rooms_yet },
      { action: action_press_enter_in_room_name },
      { assertion: assert_enter_added_the_room },
      { action: action_press_enter_in_message },
      { assertion: assert_enter_sent_the_message },
    ],
    plain,
    writable,
  };
});
