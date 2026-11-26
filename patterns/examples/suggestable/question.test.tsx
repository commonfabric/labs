import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  fireEvent,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import Question from "./question.tsx";

export default pattern(() => {
  // Nothing names the subject to ask about, so no model request opens and the
  // question is built and read entirely from what it holds on its own.
  const subject = Question({});

  const assert_built = assert(() => subject != null);
  // Without a topic it names itself generically.
  const assert_generic_name = assert(() => subject[NAME] === "Question");
  const assert_no_topic = assert(() => subject.topic === "");
  const assert_not_pending = assert(() => subject.pending === false);
  const assert_no_question = assert(() => subject.question === "");
  const assert_no_options = assert(() => subject.options.length === 0);
  const assert_generic_heading = assert(() => hasText(subject[UI], "Question"));
  const assert_no_loader = assert(() =>
    !hasText(subject[UI], "Generating question")
  );

  // Answering in the rendered question records the answer.
  const assert_unanswered = assert(() => subject.answer.get() === "");
  const action_answer = action(() =>
    fireEvent(
      findElement(subject[UI], "cf-question"),
      "oncf-answer",
      { detail: { answer: "Next weekend" } },
      "the question",
    )
  );
  const assert_answer_recorded = assert(() =>
    subject.answer.get() === "Next weekend"
  );

  return {
    [TESTS]: [
      { assertion: assert_built },
      { assertion: assert_generic_name },
      { assertion: assert_no_topic },
      { assertion: assert_not_pending },
      { assertion: assert_no_question },
      { assertion: assert_no_options },
      { assertion: assert_generic_heading },
      { assertion: assert_no_loader },
      { assertion: assert_unanswered },
      { action: action_answer },
      { assertion: assert_answer_recorded },
    ],
    subject,
  };
});
