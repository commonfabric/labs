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
import Summary, { summaryResponseState } from "./summary.tsx";

export default pattern(() => {
  // Nothing names the subject to summarize, so no model request opens and the
  // summary is built and read entirely from what it holds on its own.
  const subject = Summary({});
  const request = new Writable<AsyncResult<string>>("First summary");
  const presentation = summaryResponseState({
    topic: "Donuts",
    responseRequest: request,
  });

  const assert_built = assert(() => subject != null);
  const assert_no_topic = assert(() => subject.topic === "");
  const assert_not_pending = assert(() => subject.pending === false);
  const assert_no_summary = assert(() => subject.summary === "");
  const assert_ready = assert(() => subject.availability === "ready");
  const assert_no_error = assert(() => subject.error === "");
  const assert_generic_heading = assert(() => hasText(subject[UI], "Summary"));
  const assert_no_loader = assert(() =>
    !hasText(subject[UI], "Generating summary")
  );

  return {
    [TESTS]: [
      { assertion: assert_built },
      { assertion: assert_no_topic },
      { assertion: assert_not_pending },
      { assertion: assert_no_summary },
      { assertion: assert_ready },
      { assertion: assert_no_error },
      { assertion: assert_generic_heading },
      { assertion: assert_no_loader },
      {
        assertion: assert(() =>
          presentation.response === "First summary" && !presentation.pending
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      {
        assertion: assert(() =>
          presentation.pending && presentation.availability === "syncing" &&
          presentation.error === ""
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "obsolete",
              null,
              null,
              "Use overview.summary instead.",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          !presentation.pending && presentation.availability === "obsolete" &&
          presentation.response === "" &&
          presentation.error === "Use overview.summary instead."
        ),
      },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable("obsolete", null, null, "") as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          !presentation.pending && presentation.availability === "obsolete" &&
          presentation.response === "" &&
          presentation.error === "This summary is no longer served."
        ),
      },
      { action: action(() => request.set("Recovered summary")) },
      {
        assertion: assert(() =>
          presentation.response === "Recovered summary" &&
          presentation.availability === "ready" && presentation.error === ""
        ),
      },
    ],
    subject,
  };
});
