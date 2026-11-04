import { assert, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import Question from "./question.tsx";

export default pattern(() => {
  // Nothing names the subject to ask about, so no model request opens and the
  // question is built and read entirely from what it holds on its own.
  const subject = Question({});

  const assert_built = assert(() => subject != null);
  const assert_no_topic = assert(() => subject.topic === "");
  const assert_not_pending = assert(() => subject.pending === false);
  const assert_no_question = assert(() => subject.question === "");
  const assert_no_options = assert(() => subject.options.length === 0);
  const assert_generic_heading = assert(() => hasText(subject[UI], "Question"));
  const assert_no_loader = assert(() =>
    !hasText(subject[UI], "Generating question")
  );

  return {
    [TESTS]: [
      { assertion: assert_built },
      { assertion: assert_no_topic },
      { assertion: assert_not_pending },
      { assertion: assert_no_question },
      { assertion: assert_no_options },
      { assertion: assert_generic_heading },
      { assertion: assert_no_loader },
    ],
    subject,
  };
});
