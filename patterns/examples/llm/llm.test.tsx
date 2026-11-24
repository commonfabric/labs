/**
 * Asks the LLM test pattern questions through its message input, and reads
 * the questions and the model's answers back from the view and the outputs.
 *
 * The test states the model's side in `llmMocks`: it answers the first
 * question, and the request for the second fails, so the view shows no answer.
 */

import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findElementByText,
  hasExactText,
  hasText,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import LLMTest from "./llm.tsx";

export const llmMocks = [
  {
    when: {
      systemContains: "helpful assistant",
      lastMessageContains: "What is 2+2?",
    },
    text: "4.",
  },
  {
    when: { lastMessageContains: "And 3+3?" },
    error: "The model is unavailable.",
  },
];

export default pattern(() => {
  const subject = LLMTest({ title: "Ask anything" });

  const assert_title_is_the_name_and_heading = assert(() =>
    subject[NAME] === "Ask anything" &&
    hasExactText(findElement(subject[UI], "h2"), "Ask anything")
  );
  const assert_no_question_yet = assert(() =>
    subject.question === "" &&
    findElementByText(subject[UI], "h3", "Your Question:") === undefined
  );

  const action_send_blank = action(() => sendMessage(subject[UI], "   "));
  const action_ask = action(() => sendMessage(subject[UI], "  What is 2+2?  "));
  const action_ask_again = action(() => sendMessage(subject[UI], "And 3+3?"));

  const assert_question_shown_trimmed = assert(() =>
    subject.question === "What is 2+2?" &&
    hasExactText(findElement(subject[UI], "blockquote"), "What is 2+2?") &&
    findElementByText(subject[UI], "h3", "Your Question:") !== undefined
  );
  const assert_second_question_replaces_first = assert(() =>
    subject.question === "And 3+3?" &&
    hasExactText(findElement(subject[UI], "blockquote"), "And 3+3?")
  );
  const assert_answer_shown = assert(() =>
    subject.response === "4." &&
    hasExactText(findElement(subject[UI], "pre"), "4.") &&
    hasText(subject[UI], "LLM Response:") &&
    !hasText(subject[UI], "Thinking...")
  );
  const assert_no_answer_when_the_request_fails = assert(() =>
    subject.response === undefined &&
    !hasText(subject[UI], "LLM Response:") &&
    !hasText(subject[UI], "Thinking...")
  );

  return {
    [TESTS]: [
      { assertion: assert_title_is_the_name_and_heading },
      { assertion: assert_no_question_yet },

      { action: action_send_blank },
      { assertion: assert_no_question_yet },

      { action: action_ask },
      { settle: true },
      { assertion: assert_question_shown_trimmed },
      { assertion: assert_answer_shown },

      { action: action_ask_again },
      { settle: true },
      { assertion: assert_second_question_replaces_first },
      { assertion: assert_no_answer_when_the_request_fails },
    ],
    subject,
    // The `generateText` call warns that the second request failed.
    allowConsoleWarnings: true,
  };
});
