/**
 * Test: a computed() that returns a filtered array of rows with onClick
 * handlers renders rows again after a filter that matches nothing.
 *
 * The filter is the cell the tabs bind as `$value`, so the test switches tabs
 * by writing that cell.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/computed-array-repro.test.tsx --root patterns --verbose
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  countElements,
  findElement,
  findElementByText,
  fireClick,
  hasText,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import ComputedArrayRepro from "./computed-array-repro.tsx";

/** Selects the tab `value` by writing the cell the tabs bind. */
const selectTab = (ui: unknown, value: string): void => {
  const cell = propsOf(findElement(ui, "cf-tabs"))?.["$value"];
  if (
    typeof cell !== "object" || cell === null || !("set" in cell) ||
    typeof cell.set !== "function"
  ) {
    throw new Error("the tabs bind no $value cell");
  }
  cell.set(value);
};

/** How many item rows the view shows: one "log" button each. */
const rowCount = (ui: unknown): number => countElements(ui, "button");

export default pattern(() => {
  const subject = ComputedArrayRepro({});

  const action_add_item = action(() =>
    clickButton(subject[UI], "Add Pending Item")
  );
  const action_show_done = action(() => selectTab(subject[UI], "done"));
  const action_show_pending = action(() => selectTab(subject[UI], "pending"));
  const action_show_all = action(() => selectTab(subject[UI], "all"));
  const action_log_first = action(() =>
    fireClick(findElementByText(subject[UI], "button", "log"), "a log button")
  );

  const assert_starts_empty = assert(() =>
    subject[NAME] === "Computed Array Bug" && subject.items.length === 0 &&
    rowCount(subject[UI]) === 0 &&
    hasText(subject[UI], "Filter: all | Total: 0")
  );
  const assert_two_rows = assert(() =>
    subject.items.length === 2 &&
    subject.items[1].name === "Item 2" &&
    rowCount(subject[UI]) === 2 &&
    hasText(subject[UI], "Item 1") && hasText(subject[UI], "Item 2") &&
    hasText(subject[UI], "Filter: all | Total: 2")
  );
  const assert_done_empty = assert(() =>
    rowCount(subject[UI]) === 0 && !hasText(subject[UI], "Item 1") &&
    hasText(subject[UI], "Filter: done | Total: 2")
  );
  const assert_pending_rows_return = assert(() =>
    rowCount(subject[UI]) === 2 && hasText(subject[UI], "Item 2") &&
    hasText(subject[UI], "Filter: pending")
  );
  const assert_all_rows_return = assert(() =>
    rowCount(subject[UI]) === 2 && hasText(subject[UI], "Filter: all")
  );
  const assert_log_changes_nothing = assert(() =>
    subject.items.length === 2 && rowCount(subject[UI]) === 2
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_add_item },
      { action: action_add_item },
      { assertion: assert_two_rows },
      { action: action_show_done },
      { assertion: assert_done_empty },
      { action: action_show_pending },
      { assertion: assert_pending_rows_return },
      { action: action_show_done },
      { assertion: assert_done_empty },
      { action: action_show_all },
      { assertion: assert_all_rows_return },
      { action: action_log_first },
      { assertion: assert_log_changes_nothing },
    ],
    subject,
  };
});
