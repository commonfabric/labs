/**
 * Loads the suggestion tester and reads the page it lays out: two free-form
 * suggestions, then one of each suggestable pattern under the topic it is
 * given.
 *
 * A pattern test has no LLM endpoint, so no suggestion or suggestable pattern
 * produces an answer here; what this reads is what each shows before one.
 */

import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  countElements,
  findElement,
  findElementByExactText,
  hasExactText,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import SuggestionTest from "./suggestion-test.tsx";

const TOPICS = [
  "Count items in the list and categorize",
  "What do I need to do to go see these animals?",
  "I'm looking to improve my fitness level",
  "Diagram of the animal kingdom",
  "Weekend trip",
];

export default pattern(() => {
  const subject = SuggestionTest({ title: "Try suggestions" });

  const assert_title_is_the_name = assert(() =>
    subject[NAME] === "Try suggestions" &&
    hasExactText(findElement(subject[UI], "h1"), "Suggestion Tester")
  );
  const assert_two_freeform_suggestions = assert(() =>
    findElementByExactText(subject[UI], "h2", "Counter") !== undefined &&
    findElementByExactText(subject[UI], "h2", "Note") !== undefined &&
    countElements(subject[UI], "cf-message-beads") === 2 &&
    countElements(subject[UI], "cf-picker") === 0
  );
  const assert_each_suggestable_under_its_topic = assert(() =>
    TOPICS.every((topic) =>
      findElementByExactText(subject[UI], "cf-heading", topic) !== undefined
    ) &&
    hasText(subject[UI], "Budget: $1000") &&
    countElements(subject[UI], "hr") === 7
  );

  return {
    [TESTS]: [
      { assertion: assert_title_is_the_name },
      { assertion: assert_two_freeform_suggestions },
      { assertion: assert_each_suggestable_under_its_topic },
    ],
    subject,
    // The model requests the suggestable patterns open find no endpoint, and
    // warn that they failed.
    allowConsoleWarnings: true,
  };
});
