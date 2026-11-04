import { assert, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import Checklist from "./checklist.tsx";

export default pattern(() => {
  // Nothing names what the steps would be for, so no model request opens and
  // the checklist is built and read entirely from what it holds on its own.
  const subject = Checklist({});

  const assert_built = assert(() => subject != null);
  const assert_no_topic = assert(() => subject.topic === "");
  const assert_not_pending = assert(() => subject.pending === false);
  const assert_no_items = assert(() => subject.items.length === 0);
  const assert_generic_heading = assert(() =>
    hasText(subject[UI], "Checklist")
  );
  const assert_no_loader = assert(() =>
    !hasText(subject[UI], "Generating checklist")
  );

  return {
    [TESTS]: [
      { assertion: assert_built },
      { assertion: assert_no_topic },
      { assertion: assert_not_pending },
      { assertion: assert_no_items },
      { assertion: assert_generic_heading },
      { assertion: assert_no_loader },
    ],
    subject,
  };
});
