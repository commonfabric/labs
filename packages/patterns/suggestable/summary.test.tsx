import { assert, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../test/vnode-helpers.ts";
import Summary from "./summary.tsx";

export default pattern(() => {
  // Nothing names the subject to summarize, so no model request opens and the
  // summary is built and read entirely from what it holds on its own.
  const subject = Summary({});

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
    ],
    subject,
  };
});
