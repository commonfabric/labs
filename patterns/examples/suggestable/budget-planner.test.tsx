import { assert, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import BudgetPlanner from "./budget-planner.tsx";

export default pattern(() => {
  // Neither instance names a topic, so neither opens a model request; the
  // planner is built and read entirely from what it can work out on its own.
  const subject = BudgetPlanner({});
  const capped = BudgetPlanner({ maxAmount: 250 });

  const assert_built = assert(() => subject != null);
  const assert_no_topic = assert(() => subject.topic === "");
  const assert_not_pending = assert(() => subject.pending === false);
  const assert_no_items = assert(() => subject.items.length === 0);
  const assert_total_is_zero = assert(() => subject.total === 0);
  const assert_whole_budget_remains = assert(() => subject.remaining === 1000);
  const assert_ceiling_is_honored = assert(() => capped.remaining === 250);
  const assert_totals_rendered = assert(() =>
    hasText(subject[UI], "Total") && hasText(subject[UI], "Remaining")
  );

  return {
    [TESTS]: [
      { assertion: assert_built },
      { assertion: assert_no_topic },
      { assertion: assert_not_pending },
      { assertion: assert_no_items },
      { assertion: assert_total_is_zero },
      { assertion: assert_whole_budget_remains },
      { assertion: assert_ceiling_is_honored },
      { assertion: assert_totals_rendered },
    ],
    subject,
    capped,
  };
});
