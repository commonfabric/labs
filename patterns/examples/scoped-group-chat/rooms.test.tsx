import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  findNode,
  fireClick,
  hasText,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ScopedGroupChatPlainInputs from "./main-plain-inputs.tsx";
import ScopedGroupChatWritableInputs from "./main-with-writable-inputs.tsx";

/** The `justifyContent` a node's style sets, if it sets one. */
const justification = (node: unknown): unknown => {
  const style = propValue(node, "style");
  return typeof style === "object" && style !== null &&
      "justifyContent" in style
    ? readValue(style.justifyContent)
    : undefined;
};

/** Where the message row carrying `body` places its bubble: `flex-end` for
 * the viewer's own message, `flex-start` for anyone else's. */
const bubbleAlignment = (root: unknown, body: string): unknown =>
  justification(
    findNode(
      root,
      (node) => hasText(node, body) && justification(node) !== undefined,
    ),
  );

const TWO_ROOMS = {
  rooms: [
    { name: "Garden", messages: [] },
    { name: "Library", messages: [] },
  ],
};

export default pattern(() => {
  // Each variant twice: once with no room to post in, and once with two rooms
  // and none of them selected yet.
  const roomless = [
    ScopedGroupChatPlainInputs({ draft: "Anyone here?" }),
    ScopedGroupChatWritableInputs({ draft: "Anyone here?" }),
  ];
  const furnished = [
    ScopedGroupChatPlainInputs({
      name: "Ada",
      conversation: TWO_ROOMS,
      draft: "Hello garden",
    }),
    ScopedGroupChatWritableInputs({
      name: "Ada",
      conversation: TWO_ROOMS,
      draft: "Hello garden",
    }),
  ];

  // With no room at all, a message has nowhere to go: nothing is posted and
  // the draft is kept.
  const action_send_without_rooms = action(() => {
    for (const chat of roomless) chat.sendMessage.send();
  });
  const assert_roomless_send_kept_draft = assert(() =>
    roomless.every((chat) =>
      chat.roomCount === 0 &&
      chat.messageCount === 0 &&
      chat.draft === "Anyone here?" &&
      hasText(chat[UI], "No room")
    )
  );

  // With rooms but no selection, the message goes to the first room, which
  // becomes the selected one. The sender's own message sits on the right.
  const assert_furnished_starts_unselected = assert(() =>
    furnished.every((chat) =>
      chat.roomCount === 2 && chat.selectedRoom.room === undefined
    )
  );
  const action_send_to_first_room = action(() => {
    for (const chat of furnished) chat.sendMessage.send();
  });
  const assert_first_room_selected_and_posted = assert(() =>
    furnished.every((chat) =>
      chat.selectedRoom.room?.name === "Garden" &&
      chat.messageCount === 1 &&
      chat.conversation.rooms[0]?.messages[0]?.author === "Ada" &&
      chat.conversation.rooms[0]?.messages[0]?.body === "Hello garden" &&
      chat.draft === "" &&
      hasText(chat[UI], "1 total") &&
      bubbleAlignment(chat[UI], "Hello garden") === "flex-end"
    )
  );

  // Clicking a room's tab selects that room.
  const action_click_library_tab = action(() => {
    for (const chat of furnished) {
      fireClick(
        findElementByText(chat[UI], "cf-tab", "Library"),
        "the Library tab",
      );
    }
  });
  const assert_library_selected = assert(() =>
    furnished.every((chat) =>
      chat.selectedRoom.room?.name === "Library" &&
      chat.messageCount === 0 &&
      hasText(chat[UI], "No messages yet")
    )
  );

  return {
    [TESTS]: [
      { action: action_send_without_rooms },
      { assertion: assert_roomless_send_kept_draft },
      { assertion: assert_furnished_starts_unselected },
      { action: action_send_to_first_room },
      { assertion: assert_first_room_selected_and_posted },
      { action: action_click_library_tab },
      { assertion: assert_library_selected },
    ],
    roomless,
    furnished,
  };
});
