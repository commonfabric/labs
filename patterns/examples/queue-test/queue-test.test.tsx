/**
 * Loads the queue test pattern and reads its five prompts and their answers
 * back from the view and the `responses` output.
 *
 * The test states the model's answers in `llmMocks`: it answers four of the
 * prompts, whose cards show the answer and count as completed, and the
 * request for the fifth fails, so its card settles on "waiting...".
 */

import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  countElements,
  findElement,
  hasExactText,
  hasText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import QueueTest from "./queue-test.tsx";

const PROMPTS = [1, 2, 3, 4, 5].map((n) =>
  `What is ${n}+${n}? Reply in one word.`
);
const ANSWERS = ["Two.", "Four.", "Six.", "Eight."];

export const llmMocks = [
  ...ANSWERS.map((text, i) => ({
    when: { lastMessageContains: PROMPTS[i] },
    text,
  })),
  {
    when: { lastMessageContains: PROMPTS[4] },
    error: "The model is unavailable.",
  },
];

/** One entry of the pattern's `responses` output. */
interface Response {
  pending: boolean;
  result?: string;
}

export default pattern(() => {
  const subject = QueueTest({ title: "Five at once" });

  const assert_title_is_the_name_and_heading = assert(() =>
    subject[NAME] === "Five at once" &&
    hasExactText(findElement(subject[UI], "cf-heading"), "Five at once")
  );
  const assert_one_card_per_prompt = assert(() =>
    countElements(subject[UI], "cf-card") === 5 &&
    PROMPTS.every((prompt) => hasText(subject[UI], prompt))
  );
  const assert_four_answered = assert(() =>
    subject.responses.length === 5 &&
    subject.responses.every((r: Response, i: number) =>
      !r.pending && r.result === ANSWERS[i]
    ) &&
    hasText(subject[UI], "Completed: 4 / 5") &&
    ANSWERS.every((answer) => hasText(subject[UI], answer)) &&
    countElements(subject[UI], "cf-loader") === 0
  );
  const assert_failed_card_waits = assert(() =>
    (textContent(subject[UI]).match(/waiting\.\.\./g) ?? []).length === 1
  );

  return {
    [TESTS]: [
      { assertion: assert_title_is_the_name_and_heading },
      { assertion: assert_one_card_per_prompt },
      { settle: true },
      { assertion: assert_four_answered },
      { assertion: assert_failed_card_waits },
    ],
    subject,
    // The failed `generateText` call warns that it failed.
    allowConsoleWarnings: true,
  };
});
