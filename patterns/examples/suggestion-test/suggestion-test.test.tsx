/**
 * Loads the suggestion tester and reads the page it lays out: two free-form
 * suggestions, then one of each suggestable pattern under the topic it is
 * given.
 *
 * The test states that the model fails every request the suggestable patterns
 * make, so none produces an answer here; what this reads is what each shows
 * before one.
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

// The model fails every request the suggestable patterns make.
export const llmMocks = [
  {
    when: { systemContains: "concise summaries" },
    error: "The model is unavailable.",
  },
  {
    when: { systemContains: "ASCII diagrams" },
    error: "The model is unavailable.",
  },
  {
    when: { systemContains: "budget breakdowns" },
    error: "The model is unavailable.",
  },
  {
    when: { systemContains: "actionable checklists" },
    error: "The model is unavailable.",
  },
  {
    when: { systemContains: "help clarify intent" },
    error: "The model is unavailable.",
  },
];

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
    // The failed requests of the suggestable patterns warn that they failed.
    allowConsoleWarnings: true,
  };
});
