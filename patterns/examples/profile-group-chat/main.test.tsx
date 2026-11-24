import {
  action,
  assert,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findNode,
  findNodeByProp,
  hasText,
  isButton,
  propsOf,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ProfileGroupChat, { type ChatMessage, sendMessage } from "./main.tsx";

const asObject = (value: unknown): object | undefined =>
  typeof value === "object" && value !== null ? value : undefined;

type StandInProfile = { name?: string; avatar?: string };

export default pattern(() => {
  const messages = Writable.of<ChatMessage[]>([]);
  const draft = Writable.of("  Hello there  ");
  const chat = ProfileGroupChat({ messages, draft });

  // Sending needs the viewer's `#profile`, which a pattern test cannot
  // resolve, so the send handler is bound here to stand-in profile cells.
  // Two people who share the name "Ben" are two cells.
  const firstBen = Writable.of<StandInProfile>({ name: "Ben" });
  const secondBen = Writable.of<StandInProfile>({ name: "Ben" });
  const firstBenSends = sendMessage({
    messages,
    draft,
    profile: firstBen,
    name: " Ben ",
  });
  const secondBenSends = sendMessage({
    messages,
    draft,
    profile: secondBen,
    name: "Ben",
  });
  const namelessSends = sendMessage({
    messages,
    draft,
    profile: firstBen,
    name: "   ",
  });
  const profilelessSends = sendMessage({
    messages,
    draft,
    profile: undefined,
    name: "Ben",
  });

  // Enter in the message field fires the very stream the Send button does.
  const assert_enter_fires_send = assert(() => {
    const onSubmit = asObject(
      propsOf(findNodeByProp(chat[UI], "aria-label", "Message"))
        ?.["oncf-submit"],
    );
    const onClick = asObject(
      propsOf(findNode(chat[UI], isButton("Send")))?.onClick,
    );
    return onSubmit !== undefined && equals(onSubmit, onClick);
  });
  // With no profile resolved, the composer's Send stays disabled.
  const assert_send_disabled_without_profile = assert(() =>
    propValue(findNode(chat[UI], isButton("Send")), "disabled") === true
  );
  const assert_starts_empty = assert(() =>
    chat.messageCount === 0 &&
    findNodeByProp(chat[UI], "message", "No messages yet — say hello!") !==
      undefined &&
    hasText(chat[UI], "In this room (0)")
  );

  // A sender with no name, or no profile cell, has no identity to send under,
  // so the draft stays put and nothing is posted.
  const assert_nothing_sent = assert(() =>
    chat.messageCount === 0 && draft.get() === "  Hello there  "
  );

  const assert_first_message_posted = assert(() =>
    chat.messageCount === 1 &&
    messages.get()[0].author === "Ben" &&
    messages.get()[0].body === "Hello there" &&
    messages.get()[0].avatar === "" &&
    draft.get() === "" &&
    hasText(chat[UI], "Hello there") &&
    findNodeByProp(chat[UI], "message", "No messages yet — say hello!") ===
      undefined &&
    hasText(chat[UI], "In this room (1)")
  );

  const action_draft_again = action(() => draft.set("Me again"));
  // The roster dedupes by profile cell, so a second message from the same
  // person leaves one participant.
  const assert_same_sender_one_participant = assert(() =>
    chat.messageCount === 2 && hasText(chat[UI], "In this room (1)")
  );

  const action_draft_reply = action(() => draft.set("Different Ben here"));
  // The other Ben shares the name but not the profile cell, so he is a second
  // participant.
  const assert_namesake_is_second_participant = assert(() =>
    chat.messageCount === 3 &&
    hasText(chat[UI], "Different Ben here") &&
    hasText(chat[UI], "In this room (2)")
  );

  // The draft is empty now, and an empty message is not sent.
  const assert_empty_draft_not_sent = assert(() => chat.messageCount === 3);

  return {
    [TESTS]: [
      { assertion: assert_enter_fires_send },
      { assertion: assert_send_disabled_without_profile },
      { assertion: assert_starts_empty },
      { action: namelessSends },
      { action: profilelessSends },
      { assertion: assert_nothing_sent },
      { action: firstBenSends },
      { assertion: assert_first_message_posted },
      { action: action_draft_again },
      { action: firstBenSends },
      { assertion: assert_same_sender_one_participant },
      { action: action_draft_reply },
      { action: secondBenSends },
      { assertion: assert_namesake_is_second_participant },
      { action: secondBenSends },
      { assertion: assert_empty_draft_not_sent },
    ],
    chat,
  };
});
