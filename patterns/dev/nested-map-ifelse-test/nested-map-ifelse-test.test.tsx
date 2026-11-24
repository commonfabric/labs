/**
 * Test: lists built from map and ifElse follow a check and a removal.
 *
 * The fixture renders the same items four ways: a plain map, a map of
 * categories with an ifElse per item that falls back to null, and two
 * filters of the done items whose ifElse falls back to null and to an empty
 * span. Its "Run Test Sequence" button checks Milk and then removes it, and it
 * states what each list should show afterward. The test presses that button
 * and checks each list against that statement, then presses "Reset" and checks
 * the lists are back where they started.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  hasText,
  innermostNode,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import NestedMapIfElseTest from "./nested-map-ifelse-test.tsx";

/** The section whose heading is `heading`: the innermost node carrying both
 * the heading and the caption under it. */
const section = (root: unknown, heading: string, caption: string) =>
  textContent(
    innermostNode(
      root,
      (node) => hasText(node, heading) && hasText(node, caption),
    ),
  );

/** The text of the category list's group for `category`. */
const group = (root: unknown, category: string) =>
  textContent(
    innermostNode(
      innermostNode(
        root,
        (node) =>
          hasText(node, "2. Category List") && hasText(node, "Nested map"),
      ),
      (node) => hasText(node, `${category}:`) && hasText(node, "["),
    ),
  );

const basic = (root: unknown) =>
  section(root, "1. Basic List", "Simple map over items");
const filteredNull = (root: unknown) =>
  section(root, "3. Filtered (ifElse null)", "null fallback");
const filteredSpan = (root: unknown) =>
  section(root, "4. Filtered (ifElse span)", "empty span fallback");

export default pattern(() => {
  const subject = NestedMapIfElseTest({
    items: [
      { title: "Milk", done: false, category: "Dairy" },
      { title: "Bread", done: false, category: "Bakery" },
      { title: "Cheese", done: true, category: "Dairy" },
    ],
    log: [],
  });

  const action_run_sequence = action(() =>
    clickButton(subject[UI], "Run Test Sequence")
  );
  const action_reset = action(() => clickButton(subject[UI], "Reset"));

  const assert_initial_lists = assert(() =>
    subject[NAME] === "Nested Map + ifElse Test" &&
    hasText(basic(subject[UI]), "[0] Milk (Dairy)") &&
    hasText(group(subject[UI], "Dairy"), "Milk") &&
    hasText(group(subject[UI], "Dairy"), "Cheese") &&
    !hasText(group(subject[UI], "Bakery"), "Milk") &&
    hasText(filteredNull(subject[UI]), "Cheese (done)") &&
    !hasText(filteredNull(subject[UI]), "Milk") &&
    hasText(filteredSpan(subject[UI]), "Cheese (done)") &&
    !hasText(filteredSpan(subject[UI]), "Bread")
  );

  // The sequence logs each step and ends on its own statement of the result.
  const assert_sequence_logged = assert(() =>
    subject.log.length === 7 &&
    subject.log[6].endsWith(
      "Test complete - all lists should show Bread and Cheese",
    ) &&
    hasText(subject[UI], "Removing items[0] (Milk)")
  );

  const assert_milk_removed = assert(() =>
    subject.items.length === 2 &&
    subject.items[0].title === "Bread" &&
    subject.items[1].title === "Cheese"
  );

  // What the fixture says each list shows after the sequence.
  const assert_lists_after_sequence = assert(() =>
    hasText(basic(subject[UI]), "[0] Bread (Bakery)") &&
    hasText(basic(subject[UI]), "[1] Cheese (Dairy)") &&
    !hasText(basic(subject[UI]), "Milk") &&
    hasText(group(subject[UI], "Bakery"), "[0] Bread") &&
    hasText(group(subject[UI], "Dairy"), "[1] Cheese") &&
    !hasText(group(subject[UI], "Dairy"), "Milk") &&
    hasText(filteredNull(subject[UI]), "[1] Cheese (done)") &&
    !hasText(filteredNull(subject[UI]), "Bread") &&
    hasText(filteredSpan(subject[UI]), "[1] Cheese (done)") &&
    !hasText(filteredSpan(subject[UI]), "Bread")
  );

  const assert_reset = assert(() =>
    subject.items.length === 3 &&
    subject.items[0].title === "Milk" &&
    !subject.items[0].done &&
    subject.log.length === 1 &&
    subject.log[0] === "Reset to initial state" &&
    hasText(basic(subject[UI]), "[0] Milk (Dairy)")
  );

  return {
    [TESTS]: [
      { assertion: assert_initial_lists },
      { action: action_run_sequence },
      { assertion: assert_sequence_logged },
      { assertion: assert_milk_removed },
      { assertion: assert_lists_after_sequence },
      { action: action_reset },
      { assertion: assert_reset },
    ],
    subject,
  };
});
