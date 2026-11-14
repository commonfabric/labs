/**
 * Test: a button rendered at top level with a computed `disabled` attribute.
 *
 * The button is always rendered. Setting either the `pending` or the
 * `isProcessing` cell the "Simulate" boxes bind disables it and makes its
 * handler return early, and the handler writes `count` once both are clear.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-onclick-toplevel-disabled-working.test.tsx --root patterns --verbose
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
  findElement,
  findElementByText,
  fireClick,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import TopLevelDisabled from "./test-onclick-toplevel-disabled-working.tsx";

/** Whether the checkbox labeled `label` shows as checked. */
const boxChecked = (ui: unknown, label: string): unknown =>
  propValue(findElementByText(ui, "cf-checkbox", label), "$checked");

/** The view's one button. */
const button = (ui: unknown): unknown => findElement(ui, "cf-button");

export default pattern(() => {
  const pending = new Writable(false);
  const isProcessing = new Writable(false);
  const subject = TopLevelDisabled({ count: 0, pending, isProcessing });

  const action_click = action(() =>
    fireClick(button(subject[UI]), "the increment button")
  );
  const action_check_pending = action(() => pending.set(true));
  const action_clear_pending = action(() => pending.set(false));
  const action_check_processing = action(() => isProcessing.set(true));
  const action_clear_processing = action(() => isProcessing.set(false));

  const assert_starts_enabled = assert(() =>
    subject[NAME] === "TEST: Top-level button - WORKING" &&
    subject.count === 0 &&
    propValue(button(subject[UI]), "disabled") === false &&
    hasText(button(subject[UI]), "Increment (WORKING)") &&
    hasText(subject[UI], "Current count: 0")
  );
  const assert_count_one = assert(() =>
    subject.count === 1 && hasText(subject[UI], "Current count: 1")
  );
  const assert_pending_disables = assert(() =>
    subject.pending === true &&
    boxChecked(subject[UI], "Simulate pending state") === true &&
    boxChecked(subject[UI], "Simulate processing state") === false &&
    propValue(button(subject[UI]), "disabled") === true &&
    hasText(button(subject[UI]), "Processing...") &&
    !hasText(button(subject[UI]), "Increment")
  );
  const assert_still_one = assert(() => subject.count === 1);
  const assert_processing_disables = assert(() =>
    subject.pending === false && subject.isProcessing === true &&
    boxChecked(subject[UI], "Simulate pending state") === false &&
    boxChecked(subject[UI], "Simulate processing state") === true &&
    propValue(button(subject[UI]), "disabled") === true &&
    hasText(button(subject[UI]), "Increment (WORKING)")
  );
  const assert_reenabled = assert(() =>
    subject.isProcessing === false &&
    propValue(button(subject[UI]), "disabled") === false
  );
  const assert_count_two = assert(() =>
    subject.count === 2 && hasText(subject[UI], "Current count: 2")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_enabled },
      { action: action_click },
      { assertion: assert_count_one },
      { action: action_check_pending },
      { assertion: assert_pending_disables },
      { action: action_click },
      { assertion: assert_still_one },
      { action: action_clear_pending },
      { action: action_check_processing },
      { assertion: assert_processing_disables },
      { action: action_click },
      { assertion: assert_still_one },
      { action: action_clear_processing },
      { assertion: assert_reenabled },
      { action: action_click },
      { assertion: assert_count_two },
    ],
    subject,
  };
});
