/**
 * Test Pattern: Deep Research
 *
 * Drives the research view's controls: the autostart that asks the question,
 * the refine affordance, and the prompt that sends a follow-up. Each sending
 * control is driven on a research of its own, as the first message that
 * research's dialog receives, so the dialog takes it whether or not a model
 * answers the turn it starts; the test checks only the user's messages, which
 * an answer does not change. It reads the result-free view before anything is
 * sent. `research-result.test.ts` covers how a result reads.
 */
import {
  action,
  assert,
  type BuiltInLLMMessage,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import DeepResearch from "./deep-research.tsx";
import {
  findElement,
  fireEvent,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";

const QUESTION = "How do tide pools form?";

/** The text of every message `role` sent, in order. */
const textsFrom = (
  messages: readonly BuiltInLLMMessage[],
  role: BuiltInLLMMessage["role"],
): string[] =>
  messages.filter((m) => m?.role === role).flatMap((m) =>
    typeof m.content === "string"
      ? [m.content]
      : m.content.flatMap((part) => part.type === "text" ? [part.text] : [])
  );

export default pattern(() => {
  const messages = Writable.of<BuiltInLLMMessage[]>([]);
  const research = DeepResearch({ situation: QUESTION, messages });
  const refineMessages = Writable.of<BuiltInLLMMessage[]>([]);
  const refined = DeepResearch({
    situation: QUESTION,
    messages: refineMessages,
  });

  const assert_named_for_question = assert(() =>
    research[NAME] === `Research: ${QUESTION}`
  );
  const assert_no_result_shown = assert(() =>
    research.result === undefined &&
    !hasText(research[UI], "Summary") && !hasText(research[UI], "Findings") &&
    !hasText(research[UI], "Sources") && !hasText(research[UI], "Confidence")
  );
  const assert_refine_hidden = assert(() =>
    propValue(findElement(refined[UI], "cf-prompt-input"), "style") ===
      "display:none"
  );

  const action_autostart = action(() => {
    fireEvent(findElement(research[UI], "cf-autostart"), "onstart", {});
  });
  const assert_question_asked = assert(() =>
    textsFrom(messages.get(), "user").join("|") === QUESTION
  );

  const action_refine = action(() => {
    fireEvent(findElement(refined[UI], "cf-message-beads"), "oncf-refine", {});
  });
  const assert_refine_shown = assert(() =>
    propValue(findElement(refined[UI], "cf-prompt-input"), "style") === ""
  );

  const action_send_follow_up = action(() => {
    fireEvent(findElement(refined[UI], "cf-prompt-input"), "oncf-send", {
      detail: { text: "Focus on rocky coasts." },
    });
  });
  const assert_follow_up_sent = assert(() =>
    textsFrom(refineMessages.get(), "user").join("|") ===
      "Focus on rocky coasts."
  );

  return {
    [TESTS]: [
      { assertion: assert_named_for_question },
      { assertion: assert_no_result_shown },
      { assertion: assert_refine_hidden },
      { action: action_autostart },
      { assertion: assert_question_asked },
      { action: action_refine },
      { assertion: assert_refine_shown },
      { action: action_send_follow_up },
      { assertion: assert_follow_up_sent },
    ],
    research,
    refined,
  };
});
