/**
 * Sends the writer topics through its message input and reads the topic and
 * the generated text back from the view and the outputs. The test states the
 * model's answer in `llmMocks`.
 */

import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  hasExactText,
  hasText,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import ProfileAwareWriter from "./main.tsx";

export const llmMocks = [
  {
    when: {
      systemContains: "helpful writing assistant",
      lastMessageContains: "Dragons in winter",
    },
    text: "The dragons slept beneath the snow.",
  },
];

export default pattern(() => {
  const writer = ProfileAwareWriter({});

  const assert_names_itself = assert(() =>
    writer[NAME] === "Profile-Aware Writer" &&
    hasText(writer[UI], "Profile-Aware Writer") &&
    hasText(writer[UI], "Profile Context:")
  );
  const assert_no_topic_yet = assert(() =>
    writer.topic === "" && !hasText(writer[UI], "Topic:") &&
    !hasText(writer[UI], "Generated Text:")
  );

  // A blank message names no topic, so the writer asks for nothing.
  const action_send_blank = action(() => sendMessage(writer[UI], "   "));
  const action_send_topic = action(() =>
    sendMessage(writer[UI], "  Dragons in winter  ")
  );

  const assert_topic_shown_trimmed = assert(() =>
    writer.topic === "Dragons in winter" &&
    hasText(writer[UI], "Topic:") &&
    hasExactText(findElement(writer[UI], "blockquote"), "Dragons in winter")
  );
  const assert_text_generated = assert(() =>
    writer.response === "The dragons slept beneath the snow." &&
    hasText(writer[UI], "Generated Text:") &&
    hasText(writer[UI], "The dragons slept beneath the snow.") &&
    !hasText(writer[UI], "Generating personalized content...")
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_no_topic_yet },
      { action: action_send_blank },
      { assertion: assert_no_topic_yet },
      { action: action_send_topic },
      { settle: true },
      { assertion: assert_topic_shown_trimmed },
      { assertion: assert_text_generated },
    ],
    writer,
  };
});
