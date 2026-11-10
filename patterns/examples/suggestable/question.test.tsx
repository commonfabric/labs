import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type IsObsolete,
  type IsSyncing,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import Question, { questionResponseState } from "./question.tsx";

export default pattern(() => {
  // Nothing names the subject to ask about, so no model request opens and the
  // question is built and read entirely from what it holds on its own.
  const subject = Question({});
  const request = new Writable<
    AsyncResult<{ question: string; options: string[] }>
  >({ question: "First question", options: ["Yes"] });
  const presentation = questionResponseState({ responseRequest: request });

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
      {
        assertion: assert(() =>
          presentation.response.question === "First question" &&
          !presentation.pending
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      {
        assertion: assert(() =>
          presentation.pending && presentation.error === ""
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "obsolete",
              null,
              "Use review.question instead.",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          !presentation.pending && presentation.response.question === "" &&
          presentation.error === "Use review.question instead."
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable("obsolete", null, "") as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          !presentation.pending && presentation.response.question === "" &&
          presentation.error === "This question is no longer served."
        ),
      },
      {
        action: action(() =>
          request.set({ question: "Recovered question", options: [] })
        ),
      },
      {
        assertion: assert(() =>
          presentation.response.question === "Recovered question" &&
          presentation.error === ""
        ),
      },
    ],
    subject,
  };
});
