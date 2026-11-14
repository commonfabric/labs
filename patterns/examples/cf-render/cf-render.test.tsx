import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findNodeById,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import Counters, { Counter } from "./cf-render.tsx";

export default pattern(() => {
  const counters = Counters({ value: 0 });
  const single = Counter({ value: 2 });

  const action_increment = action(() => clickButton(counters[UI], "inc to 1"));
  const action_increment_again = action(() =>
    clickButton(counters[UI], "inc to 2")
  );
  const action_increment_third = action(() =>
    clickButton(counters[UI], "inc to 3")
  );
  const action_decrement = action(() => clickButton(single[UI], "dec to 1"));

  const assert_starts_at_zeroth = assert(() =>
    counters[NAME] === "Counters: 0" &&
    hasText(findNodeById(counters[UI], "counter-result"), "the 0th number")
  );
  const assert_first = assert(() =>
    counters.value === 1 &&
    hasText(findNodeById(counters[UI], "counter-result"), "the 1st number")
  );
  const assert_second = assert(() =>
    counters.value === 2 &&
    hasText(findNodeById(counters[UI], "counter-result"), "the 2nd number")
  );
  const assert_third = assert(() =>
    counters[NAME] === "Counters: 3" &&
    hasText(findNodeById(counters[UI], "counter-result"), "the 3rd number")
  );
  const assert_single_starts_second = assert(() =>
    single[NAME] === "Simple counter: 2" &&
    hasText(findNodeById(single[UI], "counter-result"), "the 2nd number")
  );
  const assert_single_decremented = assert(() =>
    single.value === 1 && single[NAME] === "Simple counter: 1"
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_at_zeroth },
      { action: action_increment },
      { assertion: assert_first },
      { action: action_increment_again },
      { assertion: assert_second },
      { action: action_increment_third },
      { assertion: assert_third },
      { assertion: assert_single_starts_second },
      { action: action_decrement },
      { assertion: assert_single_decremented },
    ],
    counters,
    single,
  };
});
