/**
 * Test Pattern: Group Chat Room
 *
 * Two people, Ann and Bob, each have a room open on one shared message list,
 * roster and session. The test drives both views as they would: typing and
 * sending (by button and by Enter), reacting through the emoji picker and the
 * reaction chips, attaching and sending an image, and finally resetting the
 * session from under them.
 *
 * - Messages read as a conversation: one's own on the right in blue, the
 *   other's on the left with an avatar and name at the start of each run.
 * - A reaction counts the people who chose it, and a second press withdraws
 *   it; a reaction nobody holds any more disappears.
 * - An attached image waits as a preview until it is sent or discarded.
 * - A room whose session the lobby has replaced shows that it expired.
 *
 * Run: deno task cf test patterns/examples/group-chat-room/group-chat-room.test.tsx
 */
import {
  action,
  assert,
  ImageData,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  childNodes,
  clickButton,
  findElement,
  findElementByExactText,
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  isButton,
  propValue,
  readValue,
  setBound,
  styleOf,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import GroupChatRoom, { type Message, type User } from "./group-chat-room.tsx";

const CAT_URL = "https://images.example/cat.png";
const DOG_URL = "https://images.example/dog.png";

const image = (url: string): ImageData => ({
  id: url,
  name: url,
  url,
  data: "",
  timestamp: 0,
  size: 0,
  type: "image/png",
});

const composer = (ui: unknown) =>
  findNodeByProp(ui, "placeholder", "Type your message...");

/** The rows of the message list, one per message. */
const messageRows = (ui: unknown): unknown[] =>
  childNodes(findNode(ui, (node) => styleOf(node, "overflowY") === "auto"))
    .flatMap((child) => {
      const value = readValue(child);
      return Array.isArray(value) ? value : [value];
    });

/** The row that lays out the message showing `text`. */
const messageRow = (ui: unknown, text: string) =>
  messageRows(ui).find((row) => hasText(row, text));

const avatarIn = (node: unknown, size: string) =>
  findNodeByProp(node, "size", size);

/** What a viewer sees of the message showing `text`: the side it sits on,
 * its bubble's colors and lower corners, the avatar beside it, everything it
 * reads, and the space below it. */
const messageLook = (ui: unknown, text: string) => {
  const row = messageRow(ui, text);
  const bubble = findNode(
    row,
    (node) => styleOf(node, "padding") === "10px 14px",
  );
  const avatar = avatarIn(row, "sm");
  return {
    display: styleOf(row, "display"),
    side: styleOf(row, "flexDirection"),
    bubble: [
      styleOf(bubble, "backgroundColor"),
      styleOf(bubble, "color"),
      styleOf(bubble, "borderBottomLeftRadius"),
      styleOf(bubble, "borderBottomRightRadius"),
    ].join(" "),
    avatar: avatar === undefined
      ? "none"
      : `${propValue(avatar, "name")} ${propValue(avatar, "src")}`,
    reads: textContent(row),
    spaceBelow: styleOf(row, "marginBottom"),
  };
};

/** Presses the button labelled `label` on the message showing `text`. */
const pressOnMessage = (ui: unknown, text: string, label: string) =>
  fireClick(
    findNode(messageRow(ui, text), isButton(label)),
    `"${label}" on the message "${text}"`,
  );

/** The pending-image preview beside the composer. */
const preview = (ui: unknown) =>
  findNode(ui, (node) => styleOf(node, "width") === "40px");

/** Whether the emoji picker is open on the message showing `text`. */
const pickerOpen = (ui: unknown, text: string) =>
  findElementByExactText(messageRow(ui, text), "button", "😮") !== undefined;

const imageInput = (ui: unknown) => findElement(ui, "cf-image-input");

const messageWith = (messages: readonly Message[], content: string) =>
  messages.find((m) => m.content === content);

const reactionsOn = (messages: readonly Message[], content: string) =>
  (messageWith(messages, content)?.reactions ?? [])
    .map((r) => `${r.emoji}:${r.userNames.join("+")}`).join();

export default pattern(() => {
  const messages = Writable.of<Message[]>([{
    id: "join-ann",
    author: "System",
    content: "Ann joined the chat",
    timestamp: 0,
    type: "system",
    reactions: [],
  }]);
  const users = Writable.of<User[]>([
    { name: "Ann", joinedAt: 0, avatar: "🦊" },
    { name: "Bob", joinedAt: 1, avatar: "🐻" },
  ]);
  const sessionId = Writable.of("session-1");

  const ann = GroupChatRoom({
    messages,
    users,
    myName: "Ann",
    mySessionId: "session-1",
    currentSessionId: sessionId,
  });
  const bob = GroupChatRoom({
    messages,
    users,
    myName: "Bob",
    mySessionId: "session-1",
    currentSessionId: sessionId,
  });

  // ==========================================================================
  // Sending messages
  // ==========================================================================

  const action_ann_types_hello = action(() =>
    setBound(composer(ann[UI]), "$value", "Hello")
  );
  const action_ann_presses_send = action(() => clickButton(ann[UI], "Send"));
  const action_ann_sends_blank = action(() => {
    setBound(composer(ann[UI]), "$value", "   ");
    clickButton(ann[UI], "Send");
  });
  const action_bob_types_hi = action(() =>
    setBound(composer(bob[UI]), "$value", "Hi Ann")
  );
  const action_bob_presses_enter = action(() =>
    fireEvent(composer(bob[UI]), "oncf-submit", {}, "Bob's composer")
  );
  const action_bob_types_second = action(() =>
    setBound(composer(bob[UI]), "$value", "Second")
  );
  const action_bob_presses_send = action(() => clickButton(bob[UI], "Send"));

  const assert_names_and_roster = assert(() =>
    ann[NAME] === "Chat: Ann" && bob[NAME] === "Chat: Bob" &&
    ann.myName === "Ann" &&
    hasText(ann[UI], "Now chatting") &&
    hasText(ann[UI], "AnnBob") &&
    hasText(ann[UI], "Chatting as: Ann") &&
    propValue(avatarIn(ann[UI], "md"), "src") === "🦊"
  );
  const assert_hello_sent = assert(() =>
    messages.get().length === 2 &&
    messageWith(messages.get(), "Hello")?.author === "Ann" &&
    messageWith(messages.get(), "Hello")?.type === "chat" &&
    propValue(composer(ann[UI]), "$value") === ""
  );
  const assert_blank_not_sent = assert(() => messages.get().length === 2);
  const assert_bob_sent_two = assert(() =>
    messages.get().map((m) => `${m.author}:${m.content}`).join() ===
      "System:Ann joined the chat,Ann:Hello,Bob:Hi Ann,Bob:Second" &&
    propValue(composer(bob[UI]), "$value") === ""
  );

  // Ann's own message sits on the right in blue with no avatar.
  const assert_own_message_layout = assert(() => {
    const hello = messageLook(ann[UI], "Hello");
    return hello.display === "flex" && hello.side === "row-reverse" &&
      hello.bubble === "#007AFF white 18px 4px" && hello.avatar === "none";
  });
  // Bob's run of two opens with his avatar and name and sits close together;
  // the second message carries neither.
  const assert_others_message_layout = assert(() => {
    const first = messageLook(ann[UI], "Hi Ann");
    const second = messageLook(ann[UI], "Second");
    return first.side === "row" &&
      first.bubble === "#E5E5EA #1d1d1f 4px 18px" &&
      first.avatar === "Bob 🐻" && first.reads.startsWith("BobHi Ann") &&
      first.spaceBelow === "2px" &&
      second.avatar === "none" && second.reads.startsWith("Second") &&
      second.spaceBelow === "8px";
  });
  const assert_system_message_layout = assert(() => {
    const joined = messageLook(ann[UI], "Ann joined the chat");
    return joined.side === "column" && joined.spaceBelow === "8px" &&
      messageLook(ann[UI], "Hello").spaceBelow === "8px";
  });
  // The same messages from Bob's side.
  const assert_bob_sees_sides_swapped = assert(() => {
    const hello = messageLook(bob[UI], "Hello");
    return hello.side === "row" && hello.avatar === "Ann 🦊" &&
      messageLook(bob[UI], "Hi Ann").side === "row-reverse";
  });

  // ==========================================================================
  // Reactions
  // ==========================================================================

  const action_ann_opens_picker = action(() =>
    pressOnMessage(ann[UI], "Hi Ann", "+")
  );
  const action_ann_picks_thumbs_up = action(() =>
    pressOnMessage(ann[UI], "Hi Ann", "👍")
  );
  const action_bob_presses_thumbs_up = action(() =>
    pressOnMessage(bob[UI], "Hi Ann", "👍1")
  );
  const action_ann_presses_thumbs_up = action(() =>
    pressOnMessage(ann[UI], "Hi Ann", "👍2")
  );

  const assert_picker_closed = assert(() =>
    !pickerOpen(ann[UI], "Hi Ann") && !pickerOpen(ann[UI], "Second")
  );
  const assert_picker_open = assert(() =>
    pickerOpen(ann[UI], "Hi Ann") && !pickerOpen(ann[UI], "Second")
  );
  // Picking closes the picker and shows the reaction with its count.
  const assert_ann_reacted = assert(() =>
    reactionsOn(messages.get(), "Hi Ann") === "👍:Ann" &&
    !pickerOpen(ann[UI], "Hi Ann") &&
    findElementByExactText(messageRow(bob[UI], "Hi Ann"), "button", "👍1") !==
      undefined
  );
  const assert_both_reacted = assert(() =>
    reactionsOn(messages.get(), "Hi Ann") === "👍:Ann+Bob" &&
    findElementByExactText(messageRow(ann[UI], "Hi Ann"), "button", "👍2") !==
      undefined
  );
  const assert_ann_withdrew = assert(() =>
    reactionsOn(messages.get(), "Hi Ann") === "👍:Bob"
  );
  const assert_no_reactions = assert(() =>
    reactionsOn(messages.get(), "Hi Ann") === "" &&
    findElementByExactText(messageRow(ann[UI], "Hi Ann"), "button", "👍1") ===
      undefined
  );

  // ==========================================================================
  // Images
  // ==========================================================================

  const action_ann_attaches_cat = action(() =>
    fireEvent(imageInput(ann[UI]), "oncf-change", {
      detail: { images: [image(CAT_URL)] },
    })
  );
  const action_ann_attaches_nothing = action(() =>
    fireEvent(imageInput(ann[UI]), "oncf-change", { detail: {} })
  );
  const action_ann_attaches_dog_file = action(() =>
    fireEvent(imageInput(ann[UI]), "oncf-change", {
      detail: { files: [image(DOG_URL)] },
    })
  );
  const action_ann_discards_image = action(() => clickButton(ann[UI], "✗"));
  const action_ann_sends_image = action(() =>
    fireClick(
      findElementByExactText(ann[UI], "button", "Send"),
      "the image's Send button",
    )
  );

  const assert_no_preview = assert(() => preview(ann[UI]) === undefined);
  const assert_cat_previewed = assert(() =>
    propValue(preview(ann[UI]), "src") === CAT_URL
  );
  const assert_dog_previewed = assert(() =>
    propValue(preview(ann[UI]), "src") === DOG_URL
  );
  const assert_cat_sent = assert(() =>
    messages.get().length === 5 &&
    messages.get()[4].type === "image" &&
    messages.get()[4].imageUrl === CAT_URL &&
    messages.get()[4].author === "Ann" &&
    preview(ann[UI]) === undefined &&
    findNodeByProp(bob[UI], "src", CAT_URL) !== undefined
  );

  // ==========================================================================
  // Session reset
  // ==========================================================================

  const action_reset_session = action(() => sessionId.set("session-2"));

  const assert_session_live = assert(() =>
    !hasText(ann[UI], "Session Expired") && hasText(ann[UI], "Chatting as: Ann")
  );
  const assert_session_expired = assert(() =>
    hasText(ann[UI], "Session Expired") &&
    hasText(ann[UI], "You were chatting as: Ann") &&
    !hasText(ann[UI], "Hello") &&
    hasText(bob[UI], "You were chatting as: Bob")
  );

  return {
    [TESTS]: [
      { assertion: assert_names_and_roster },
      { assertion: assert_session_live },

      // Sending
      { action: action_ann_types_hello },
      { action: action_ann_presses_send },
      { assertion: assert_hello_sent },
      { action: action_ann_sends_blank },
      { assertion: assert_blank_not_sent },
      { action: action_bob_types_hi },
      { action: action_bob_presses_enter },
      { action: action_bob_types_second },
      { action: action_bob_presses_send },
      { assertion: assert_bob_sent_two },
      { assertion: assert_own_message_layout },
      { assertion: assert_others_message_layout },
      { assertion: assert_system_message_layout },
      { assertion: assert_bob_sees_sides_swapped },

      // Reactions
      { assertion: assert_picker_closed },
      { action: action_ann_opens_picker },
      { assertion: assert_picker_open },
      { action: action_ann_opens_picker },
      { assertion: assert_picker_closed },
      { action: action_ann_opens_picker },
      { action: action_ann_picks_thumbs_up },
      { assertion: assert_ann_reacted },
      { action: action_bob_presses_thumbs_up },
      { assertion: assert_both_reacted },
      { action: action_ann_presses_thumbs_up },
      { assertion: assert_ann_withdrew },
      // Bob's second press withdraws his reaction too.
      { action: action_bob_presses_thumbs_up },
      { assertion: assert_no_reactions },

      // Images
      { assertion: assert_no_preview },
      { action: action_ann_attaches_cat },
      { assertion: assert_cat_previewed },
      { action: action_ann_attaches_nothing },
      { assertion: assert_no_preview },
      { action: action_ann_attaches_dog_file },
      { assertion: assert_dog_previewed },
      { action: action_ann_discards_image },
      { assertion: assert_no_preview },
      { action: action_ann_attaches_cat },
      { action: action_ann_sends_image },
      { assertion: assert_cat_sent },

      // Session reset
      { action: action_reset_session },
      { assertion: assert_session_expired },
    ],
    ann,
    bob,
  };
});
