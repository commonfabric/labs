/**
 * Test: whether equals() recognizes a selected list item.
 *
 * The pattern intends that clicking a row selects that item, that equals()
 * then identifies the selection as the row's item, so the row is
 * highlighted, clicking it again deselects it, and Remove Selected removes
 * it. The runtime does otherwise: selecting writes a copy of the item, and
 * equals() compares identity, so it never matches the copy to the row's
 * item.
 *
 * This test asserts the runtime's current behavior, which the pattern does
 * not intend: the selection follows the clicks while no row is highlighted,
 * clicking the selected row leaves it selected, and Remove Selected removes
 * nothing. Once selecting keeps the item's identity, these assertions fail,
 * and they are to be replaced by the intended behavior above. Add Item
 * appends a new item at the end of the list either way.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-cell-equals.test.tsx --root patterns
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  fireClick,
  hasText,
  innermostNode,
  propsOf,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import TestCellEquals from "./test-cell-equals.tsx";

/** The clickable row that shows `title`. */
const rowOf = (root: unknown, title: string): unknown =>
  innermostNode(
    root,
    (node) => propsOf(node)?.onClick !== undefined && hasText(node, title),
  );

/** Clicks the row that shows `title`. */
const clickRow = (root: unknown, title: string): void =>
  fireClick(rowOf(root, title), `the row "${title}"`);

/** Whether the row that shows `title` has the unselected style. */
const rowIsPlain = (root: unknown, title: string): boolean =>
  styleOf(rowOf(root, title), "background") === "#f9f9f9" &&
  styleOf(rowOf(root, title), "border") === "1px solid #ddd";

export default pattern(() => {
  const subject = TestCellEquals({
    items: [
      { title: "Alpha", description: "First" },
      { title: "Beta", description: "Second" },
    ],
    selectedItem: null,
  });

  const action_remove_without_selection = action(() =>
    clickButton(subject[UI], "Remove Selected")
  );
  const action_select_alpha = action(() => clickRow(subject[UI], "Alpha"));
  const action_click_alpha_again = action(() => clickRow(subject[UI], "Alpha"));
  const action_select_beta = action(() => clickRow(subject[UI], "Beta"));
  const action_remove_beta = action(() =>
    clickButton(subject[UI], "Remove Selected")
  );
  const action_add_item = action(() => clickButton(subject[UI], "Add Item"));

  const assert_starts_unselected = assert(() =>
    subject[NAME] === "Test equals()" && subject.selectedItem === null &&
    hasText(subject[UI], "No item selected") &&
    !hasText(subject[UI], "Selected:") &&
    hasText(subject[UI], "Total items: 2") &&
    hasText(rowOf(subject[UI], "Alpha"), "First") &&
    hasText(rowOf(subject[UI], "Beta"), "Second") &&
    rowIsPlain(subject[UI], "Alpha") && rowIsPlain(subject[UI], "Beta")
  );
  // With nothing selected, Remove Selected removes nothing.
  const assert_nothing_removed = assert(() =>
    subject.items.length === 2 && subject.items[0].title === "Alpha" &&
    subject.items[1].title === "Beta" && subject.selectedItem === null &&
    hasText(subject[UI], "Total items: 2")
  );
  // The selection shows the clicked item. The runtime's copy defeats equals(),
  // so the row keeps the unselected style, which the pattern does not intend.
  const assert_alpha_selected = assert(() =>
    subject.selectedItem?.title === "Alpha" &&
    subject.selectedItem?.description === "First" &&
    hasText(subject[UI], "Selected: Alpha") &&
    !hasText(subject[UI], "No item selected") &&
    rowIsPlain(subject[UI], "Alpha") && rowIsPlain(subject[UI], "Beta")
  );
  // Clicking another row moves the selection to that item.
  const assert_beta_selected = assert(() =>
    subject.selectedItem?.title === "Beta" &&
    hasText(subject[UI], "Selected: Beta") &&
    !hasText(subject[UI], "Selected: Alpha") &&
    rowIsPlain(subject[UI], "Alpha") && rowIsPlain(subject[UI], "Beta")
  );
  // Remove Selected finds no item equal to the runtime's copy, so the list and
  // the selection stay as they were, which the pattern does not intend.
  const assert_beta_kept = assert(() =>
    subject.items.length === 2 && subject.items[0].title === "Alpha" &&
    subject.items[1].title === "Beta" &&
    subject.selectedItem?.title === "Beta" &&
    hasText(subject[UI], "Total items: 2") &&
    rowOf(subject[UI], "Beta") !== undefined
  );
  // Add Item appends an item titled and described by the same time.
  const assert_item_appended = assert(() =>
    subject.items.length === 3 && subject.items[0].title === "Alpha" &&
    subject.items[1].title === "Beta" &&
    subject.items[2]?.title.startsWith("Item ") === true &&
    subject.items[2]?.description ===
      `Created at ${subject.items[2]?.title.slice("Item ".length)}` &&
    hasText(subject[UI], "Total items: 3") &&
    rowIsPlain(subject[UI], subject.items[2]?.title ?? "missing") &&
    subject.selectedItem?.title === "Beta"
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_unselected },
      { action: action_remove_without_selection },
      { assertion: assert_nothing_removed },
      { action: action_select_alpha },
      { assertion: assert_alpha_selected },
      // Clicking the selected row again leaves it selected, where the pattern
      // intends it to deselect.
      { action: action_click_alpha_again },
      { assertion: assert_alpha_selected },
      { action: action_select_beta },
      { assertion: assert_beta_selected },
      { action: action_remove_beta },
      { assertion: assert_beta_kept },
      { action: action_add_item },
      { assertion: assert_item_appended },
    ],
    subject,
  };
});
