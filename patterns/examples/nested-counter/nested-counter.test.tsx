import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findNodeById,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import NestedCounter, { Counter } from "./nested-counter.tsx";

export default pattern(() => {
  const nested = NestedCounter({ value: 2 });
  const single = Counter({ value: 1 });

  // The nested view renders the counter twice over the one value, so either
  // copy's button moves both; `clickButton` presses the first.
  const action_increment = action(() => clickButton(nested[UI], "inc to 3"));
  const action_decrement = action(() => clickButton(nested[UI], "dec to 2"));
  const action_decrement_single = action(() =>
    clickButton(single[UI], "dec to 0")
  );

  const assert_starts_second = assert(() =>
    nested.value === 2 && nested[NAME] === "Double counter: 2" &&
    hasText(findNodeById(nested[UI], "counter-result"), "the 2nd number")
  );
  const assert_incremented = assert(() =>
    nested.value === 3 &&
    hasText(findNodeById(nested[UI], "counter-result"), "the 3rd number")
  );
  const assert_decremented = assert(() =>
    nested.value === 2 && nested[NAME] === "Double counter: 2"
  );
  const assert_single_starts_first = assert(() =>
    single[NAME] === "Simple counter: 1" &&
    hasText(findNodeById(single[UI], "counter-result"), "the 1st number")
  );
  const assert_single_at_zero = assert(() =>
    single.value === 0 &&
    hasText(findNodeById(single[UI], "counter-result"), "the 0th number")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_second },
      { action: action_increment },
      { assertion: assert_incremented },
      { action: action_decrement },
      { assertion: assert_decremented },
      { assertion: assert_single_starts_first },
      { action: action_decrement_single },
      { assertion: assert_single_at_zero },
    ],
    nested,
    single,
  };
});
