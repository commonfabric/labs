/**
 * Test: whether selecting an item by index aliases the item or copies it.
 *
 * The diagnostic's Select button reads `items.get()[index]` and writes that
 * value with `selectedItem.set(...)`. The question the fixture asks is whether
 * the selection then follows the item in the list or keeps the value it was
 * given. This selects the seeded item, renames that item in the list, and
 * checks the selection still shows the old name, so the selection is a copy.
 * It also checks the selection leaves the list as it was.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-cell-equals-diagnostic.test.tsx --root patterns
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
  clickInRow,
  findElement,
  hasText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import Diagnostic from "./test-cell-equals-diagnostic.tsx";

interface Item {
  title: string;
  value: number;
}

/** One field of the selected item, or `undefined` while none is selected. */
const fieldOf = (selected: unknown, field: "title" | "value"): unknown =>
  typeof selected === "object" && selected !== null && field in selected
    ? Reflect.get(selected, field)
    : undefined;

export default pattern(() => {
  const items = new Writable<Item[]>([{ title: "Seeded", value: 7 }]);
  const subject = Diagnostic({ items, selectedItem: null, log: [] });

  const action_add_item = action(() => clickButton(subject[UI], "Add Item"));
  const action_select_seeded = action(() =>
    clickInRow(subject[UI], "[0] Seeded: 7", "Select")
  );
  const action_rename_seeded = action(() =>
    items.key(0).key("title").set("Renamed")
  );
  const action_clear_selection = action(() =>
    clickButton(subject[UI], "Clear Selection")
  );
  const action_clear_log = action(() => clickButton(subject[UI], "Clear Log"));

  const assert_starts_empty = assert(() =>
    subject[NAME] === "Writable.equals Diagnostic" &&
    subject.selectedItem === null && subject.log.length === 0 &&
    hasText(subject[UI], "Items (1):") &&
    hasText(subject[UI], "[0] Seeded: 7")
  );
  const assert_item_added = assert(() =>
    subject.items.length === 2 &&
    subject.items[1].title.startsWith("Item-") &&
    subject.log.length === 1 &&
    subject.log[0] === `Added item: ${subject.items[1].title}` &&
    hasText(subject[UI], "Items (2):") &&
    hasText(subject[UI], `[1] ${subject.items[1].title}`)
  );
  // The selection holds the seeded item, and selecting changed nothing in the
  // list.
  const assert_seeded_selected = assert(() =>
    fieldOf(subject.selectedItem, "title") === "Seeded" &&
    fieldOf(subject.selectedItem, "value") === 7 &&
    hasText(findElement(subject[UI], "pre"), '"Seeded"') &&
    subject.items.length === 2 && subject.items[0].title === "Seeded" &&
    subject.items[0].value === 7 && subject.items[1].title.startsWith("Item-")
  );
  // Renaming the item in the list does not reach the selection.
  const assert_selection_is_a_copy = assert(() =>
    subject.items[0].title === "Renamed" &&
    hasText(subject[UI], "[0] Renamed: 7") &&
    fieldOf(subject.selectedItem, "title") === "Seeded" &&
    hasText(findElement(subject[UI], "pre"), '"Seeded"') &&
    !hasText(findElement(subject[UI], "pre"), "Renamed")
  );
  const assert_selection_cleared = assert(() =>
    subject.selectedItem === null &&
    subject.log[subject.log.length - 1] === "Cleared selection" &&
    !textContent(findElement(subject[UI], "pre")).includes("Seeded")
  );
  const assert_log_cleared = assert(() =>
    subject.log.length === 0 &&
    !hasText(subject[UI], "Cleared selection") &&
    subject.items.length === 2
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_add_item },
      { assertion: assert_item_added },
      { action: action_select_seeded },
      { assertion: assert_seeded_selected },
      { action: action_rename_seeded },
      { assertion: assert_selection_is_a_copy },
      { action: action_clear_selection },
      { assertion: assert_selection_cleared },
      { action: action_clear_log },
      { assertion: assert_log_cleared },
    ],
    subject,
  };
});
