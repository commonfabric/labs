import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  findNodeById,
  fireClick,
  hasExactText,
  hasText,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import Factory, { Counter } from "./instantiate-pattern.tsx";

const counterText = (view: unknown, expected: string) =>
  hasExactText(findNodeById(view, "counter-result"), expected);

// Covers both patterns this example file defines: the Counter it hands to
// navigateTo, and the factory that creates them.
export default pattern(() => {
  const counter = Counter({ value: 1 });
  const factory = Factory({ pieceRegistry: [] });

  const action_increment = action(() => {
    fireClick(
      findElementByText(counter[UI], "cf-button", "inc to"),
      "the increment button",
    );
  });
  const action_decrement_twice = action(() => {
    const decrement = findElementByText(counter[UI], "cf-button", "dec to");
    fireClick(decrement, "the decrement button");
    fireClick(decrement, "the decrement button");
  });
  const action_increment_twice = action(() => {
    const increment = findElementByText(counter[UI], "cf-button", "inc to");
    fireClick(increment, "the increment button");
    fireClick(increment, "the increment button");
  });
  const action_add_counter = action(() => {
    sendMessage(factory[UI], "another", "the new counter input");
  });

  const assert_counter_reports_its_value = assert(() =>
    counter.value === 1 && counter[NAME] === "Simple counter: 1"
  );
  const assert_view_says_first = assert(() =>
    counterText(counter[UI], "Counter is the 1st number") &&
    hasText(counter[UI], "dec to 0") &&
    hasText(counter[UI], "inc to 2")
  );
  const assert_second = assert(() =>
    counter.value === 2 &&
    counterText(counter[UI], "Counter is the 2nd number") &&
    counter[NAME] === "Simple counter: 2"
  );
  const assert_zeroth = assert(() =>
    counter.value === 0 &&
    counterText(counter[UI], "Counter is the 0th number") &&
    hasText(counter[UI], "dec to -1")
  );
  const assert_back_to_second = assert(() =>
    counter.value === 2 && counterText(counter[UI], "Counter is the 2nd number")
  );
  const assert_after_third = assert(() =>
    counter.value === 3 && counterText(counter[UI], "Counter is the 3rd number")
  );
  const assert_factory_instantiates = assert(() =>
    factory[NAME] === "Counter Factory"
  );

  return {
    [TESTS]: [
      { assertion: assert_counter_reports_its_value },
      { assertion: assert_view_says_first },
      { action: action_increment },
      { assertion: assert_second },
      { action: action_decrement_twice },
      { assertion: assert_zeroth },
      { action: action_increment_twice },
      { assertion: assert_back_to_second },
      { action: action_increment },
      { assertion: assert_after_third },
      { assertion: assert_factory_instantiates },
      // Creates a Counter with a random starting value and navigates to it.
      // The step's only effect is a navigation, which the runner records but
      // exposes to no assertion.
      { action: action_add_counter },
    ],
    counter,
    factory,
  };
});
