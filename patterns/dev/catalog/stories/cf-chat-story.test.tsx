/**
 * Test Pattern: the cf-chat story
 *
 * The story seeds a weather conversation and appends what the prompt input
 * sends to it as a user message, trimmed; a blank send adds nothing.
 *
 * Run: deno task cf test patterns/dev/catalog/stories/cf-chat-story.test.tsx --root patterns
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  fireEvent,
  propValue,
} from "../../../tools/test-support/vnode-helpers.ts";
import ChatStory from "./cf-chat-story.tsx";

/** The messages the story's chat shows. */
const messages = (ui: unknown): Array<{ role: string; content: unknown }> => {
  const shown = propValue(findElement(ui, "cf-chat"), "$messages");
  return Array.isArray(shown) ? shown : [];
};

/** Sends `text` from the story's prompt input. */
const send = (ui: unknown, text: string): void =>
  fireEvent(
    findElement(ui, "cf-prompt-input"),
    "oncf-send",
    { detail: { text } },
    "the prompt input",
  );

export default pattern(() => {
  const story = ChatStory({});

  const action_send_blank = action(() => send(story[UI], "   "));
  const action_send_question = action(() =>
    send(story[UI], "  And Chicago?  ")
  );

  const assert_starts_with_the_seeded_conversation = assert(() => {
    const shown = messages(story[UI]);
    return story[NAME] === "cf-chat Story" && shown.length === 8 &&
      shown[0].content === "What's the weather in San Francisco?" &&
      shown[7].content === "New York is currently 45°F and rainy.";
  });
  const assert_blank_send_adds_nothing = assert(() =>
    messages(story[UI]).length === 8
  );
  const assert_send_appends_trimmed_user_message = assert(() => {
    const shown = messages(story[UI]);
    return shown.length === 9 && shown[8].role === "user" &&
      shown[8].content === "And Chicago?";
  });

  return {
    [TESTS]: [
      { assertion: assert_starts_with_the_seeded_conversation },
      { action: action_send_blank },
      { assertion: assert_blank_send_adds_nothing },
      { action: action_send_question },
      { assertion: assert_send_appends_trimmed_user_message },
    ],
  };
});
