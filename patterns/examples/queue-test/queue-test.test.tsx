/**
 * Loads the queue test pattern and reads its five prompts and their answers
 * back from the view and the `responses` output.
 *
 * A pattern test has no LLM endpoint: each `generateText` call fails, so
 * every card settles on "waiting..." and none counts as completed. The
 * answered branch is covered only where a real endpoint answers.
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
  const assert_none_answered_without_an_endpoint = assert(() =>
    subject.responses.length === 5 &&
    subject.responses.every((r: Response) =>
      !r.pending && r.result === undefined
    ) &&
    hasText(subject[UI], "Completed: 0 / 5") &&
    countElements(subject[UI], "cf-loader") === 0
  );
  const assert_every_card_waits = assert(() =>
    (textContent(subject[UI]).match(/waiting\.\.\./g) ?? []).length === 5
  );

  return {
    [TESTS]: [
      { assertion: assert_title_is_the_name_and_heading },
      { assertion: assert_one_card_per_prompt },
      { settle: true },
      { assertion: assert_none_answered_without_an_endpoint },
      { assertion: assert_every_card_waits },
    ],
    subject,
    // Each `generateText` call finds no endpoint, and warns that it failed.
    allowConsoleWarnings: true,
  };
});
