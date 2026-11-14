/**
 * Test: a button inside ifElse() on a plain input cell.
 *
 * While `showButton` is true the button is rendered and its handler writes
 * `count`. Clearing `showButton` replaces the button with the hidden notice,
 * and setting it again brings back a button that still writes `count`.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-onclick-ifelse-simple-cell-working.test.tsx --root patterns --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  findElementByText,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import IfElseSimpleCell from "./test-onclick-ifelse-simple-cell-working.tsx";

const HIDDEN = "Button hidden by ifElse condition";

export default pattern(() => {
  const showButton = new Writable(true);
  const subject = IfElseSimpleCell({ count: 0, showButton });

  const action_click = action(() =>
    clickButton(subject[UI], "Increment (WORKING with ifElse)")
  );
  const action_hide = action(() => showButton.set(false));
  const action_show = action(() => showButton.set(true));

  const assert_starts_shown = assert(() =>
    subject[NAME] === "TEST: ifElse with simple cell - WORKING" &&
    subject.count === 0 &&
    findElement(subject[UI], "cf-button") !== undefined &&
    !hasText(subject[UI], HIDDEN) &&
    propValue(
        findElementByText(subject[UI], "cf-checkbox", "Show button"),
        "$checked",
      ) === true
  );
  const assert_count_one = assert(() =>
    subject.count === 1 && hasText(subject[UI], "Current count: 1")
  );
  const assert_hidden = assert(() =>
    subject.showButton === false &&
    findElement(subject[UI], "cf-button") === undefined &&
    hasText(subject[UI], HIDDEN) &&
    subject.count === 1
  );
  const assert_shown_again = assert(() =>
    findElement(subject[UI], "cf-button") !== undefined &&
    !hasText(subject[UI], HIDDEN)
  );
  const assert_count_two = assert(() =>
    subject.count === 2 && hasText(subject[UI], "Current count: 2")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_shown },
      { action: action_click },
      { assertion: assert_count_one },
      { action: action_hide },
      { assertion: assert_hidden },
      { action: action_show },
      { assertion: assert_shown_again },
      { action: action_click },
      { assertion: assert_count_two },
    ],
    subject,
  };
});
