/**
 * Test Pattern: the suggestion surface
 *
 * A suggestion offered candidates is a picker: one candidate is the result
 * outright, several wait for the user to choose. A suggestion offered none
 * asks the agent, and the test drives that conversation through the controls
 * the view renders, reading back what each one put into it. The agent itself
 * needs a model, which a pattern test has none of, so no result arrives on
 * that path.
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  fireEvent,
  hasText,
  propValue,
  readValue,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
import Suggestion, { setQuestion } from "./suggestion.tsx";

/** The text of each message the view's conversation shows. */
const messageTexts = (ui: unknown): string[] => {
  const messages = propValue(findElement(ui, "cf-message-beads"), "$messages");
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    const content = propValue({ props: message }, "content");
    const first = Array.isArray(content) ? readValue(content[0]) : undefined;
    return typeof first === "object" && first !== null && "text" in first
      ? String(first.text)
      : "";
  });
};

export default pattern(() => {
  const apple = new Writable<{ [NAME]?: string }>({ [NAME]: "Apple" });
  const banana = new Writable<{ [NAME]?: string }>({ [NAME]: "Banana" });

  // ===== One candidate: the result outright =====

  const single = Suggestion({
    situation: "a fruit",
    context: {},
    initialResults: [apple],
  });
  const assert_single_candidate_is_result = assert(() =>
    single.result?.get()?.[NAME] === "Apple" &&
    hasText(single[UI], "Choose Result (1)")
  );

  // ===== Several candidates: the user picks one =====

  const several = Suggestion({
    situation: "a fruit",
    context: {},
    initialResults: [apple, banana],
  });
  const assert_waits_for_choice = assert(() =>
    several.result?.get() === undefined &&
    hasText(several[UI], "Choose Result (2)")
  );
  const action_choose_banana = action(() => {
    setBound(findElement(several[UI], "cf-picker"), "$selectedIndex", 1);
    clickButton(several[UI], "Confirm Selection");
  });
  const assert_choice_is_result = assert(() =>
    several.result?.get()?.[NAME] === "Banana"
  );

  // ===== No candidates: the agent conversation =====

  const freeform = Suggestion({
    situation: "Plan a picnic",
    context: {},
    initialResults: [],
  });
  const assert_freeform_hides_inputs = assert(() =>
    freeform.result?.get() === undefined &&
    propValue(findElement(freeform[UI], "cf-cell-link"), "style") ===
      "display:none" &&
    propValue(findElement(freeform[UI], "cf-question"), "style") ===
      "display:none" &&
    propValue(findElement(freeform[UI], "cf-question"), "question") === "" &&
    propValue(findElement(freeform[UI], "cf-prompt-input"), "style") ===
      "display:none"
  );

  // Starting asks the agent about the situation.
  const action_start = action(() =>
    fireEvent(findElement(freeform[UI], "cf-autostart"), "onstart", {})
  );
  const assert_start_sends_situation = assert(() =>
    messageTexts(freeform[UI])[0] === "Plan a picnic"
  );

  // Asking to refine shows the input, and what is typed there goes to the
  // agent.
  const action_refine = action(() =>
    fireEvent(findElement(freeform[UI], "cf-message-beads"), "oncf-refine", {})
  );
  const assert_refine_shows_input = assert(() =>
    propValue(findElement(freeform[UI], "cf-prompt-input"), "style") === ""
  );
  const action_send_refinement = action(() =>
    fireEvent(findElement(freeform[UI], "cf-prompt-input"), "oncf-send", {
      detail: { text: "For four people" },
    })
  );
  const assert_refinement_sent = assert(() =>
    messageTexts(freeform[UI]).includes("For four people")
  );

  // An answer to the agent's question goes to the agent too.
  const action_answer = action(() =>
    fireEvent(findElement(freeform[UI], "cf-question"), "oncf-answer", {
      detail: { answer: "Saturday" },
    })
  );
  const assert_answer_sent = assert(() =>
    messageTexts(freeform[UI]).includes("Saturday")
  );

  // ===== The agent's question tool =====

  const question = new Writable<{ question: string; options: string[] } | null>(
    null,
  );
  const ask = setQuestion({ pendingQuestion: question });
  const action_ask_without_options = action(() =>
    ask.send({ question: "Which day?" })
  );
  const assert_question_has_no_options = assert(() =>
    question.get()?.question === "Which day?" &&
    question.get()?.options.length === 0
  );
  const action_ask_with_options = action(() =>
    ask.send({ question: "Indoors?", options: ["Yes", "No"] })
  );
  const assert_question_keeps_options = assert(() =>
    question.get()?.options.join() === "Yes,No"
  );

  return {
    [TESTS]: [
      { assertion: assert_single_candidate_is_result },
      { assertion: assert_waits_for_choice },
      { action: action_choose_banana },
      { assertion: assert_choice_is_result },
      { assertion: assert_freeform_hides_inputs },
      { action: action_start },
      { assertion: assert_start_sends_situation },
      { action: action_refine },
      { assertion: assert_refine_shows_input },
      { action: action_send_refinement },
      { assertion: assert_refinement_sent },
      { action: action_answer },
      { assertion: assert_answer_sent },
      { action: action_ask_without_options },
      { assertion: assert_question_has_no_options },
      { action: action_ask_with_options },
      { assertion: assert_question_keeps_options },
    ],
  };
});
