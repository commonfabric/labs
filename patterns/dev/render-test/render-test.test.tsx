/**
 * Test: every level of the render fixture's nested lists takes its handler.
 *
 * The fixture binds a handler at each of three levels: the root, each item in
 * a mapped list, and each sub-item in a list mapped inside that. The test
 * presses one button at every level and checks that the change lands on the
 * row it was pressed in, and on no other, both in the state and in the text
 * the row renders.
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  clickInRow,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import RenderTest from "./render-test.tsx";

export default pattern(() => {
  const subject = RenderTest({
    title: "Nested Render",
    globalCounter: 0,
    items: [
      { name: "first", value: 1, subItems: [] },
      { name: "second", value: 2, subItems: [] },
    ],
  });

  const action_increment_global = action(() =>
    clickButton(subject[UI], "+1 Global")
  );
  const action_add_item = action(() => clickButton(subject[UI], "Add Item"));
  const action_increment_first = action(() =>
    clickInRow(subject[UI], "first", "+1 Item")
  );
  const action_add_sub_to_first = action(() =>
    clickInRow(subject[UI], "first", "Add Sub")
  );
  const action_increment_sub = action(() =>
    clickInRow(subject[UI], "Sub 1", "+1 Sub")
  );
  const action_remove_second = action(() =>
    clickInRow(subject[UI], "second", "Remove")
  );

  const assert_initial = assert(() =>
    subject.title === "Nested Render" &&
    subject.globalCounter === 0 &&
    subject.items.length === 2 &&
    hasText(subject[UI], "Global Counter: 0") &&
    hasText(subject[UI], "first - Value: 1")
  );

  const assert_global_incremented = assert(() =>
    subject.globalCounter === 1 && hasText(subject[UI], "Global Counter: 1")
  );

  const assert_item_added = assert(() =>
    subject.items.length === 3 &&
    subject.items[2].name === "Item 3" &&
    hasText(subject[UI], "Item 3 - Value: 0")
  );

  const assert_only_first_incremented = assert(() =>
    subject.items[0].value === 2 &&
    subject.items[1].value === 2 &&
    hasText(subject[UI], "first - Value: 2")
  );

  const assert_sub_added_to_first = assert(() =>
    subject.items[0].subItems.length === 1 &&
    subject.items[0].subItems[0].label === "Sub 1" &&
    subject.items[1].subItems.length === 0 &&
    hasText(subject[UI], "Sub 1: 0")
  );

  // The serving loop evaluates every assertion from the start, so the
  // sub-item, which a later step adds, is read through `?.`.
  const assert_sub_incremented = assert(() =>
    subject.items[0].subItems[0]?.count === 1 &&
    hasText(subject[UI], "Sub 1: 1")
  );

  const assert_second_removed = assert(() =>
    subject.items.length === 2 &&
    subject.items[0].name === "first" &&
    subject.items[1].name === "Item 3" &&
    !hasText(subject[UI], "second")
  );

  return {
    [TESTS]: [
      { assertion: assert_initial },
      { action: action_increment_global },
      { assertion: assert_global_incremented },
      { action: action_add_item },
      { assertion: assert_item_added },
      { action: action_increment_first },
      { assertion: assert_only_first_incremented },
      { action: action_add_sub_to_first },
      { assertion: assert_sub_added_to_first },
      { action: action_increment_sub },
      { assertion: assert_sub_incremented },
      { action: action_remove_second },
      { assertion: assert_second_removed },
    ],
    subject,
  };
});
