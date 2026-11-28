/**
 * Test Pattern: Shopping List store button
 *
 * The Store button opens a new store mapper named "My Store", with no aisles,
 * entrances, or corrections and every department unplaced. A navigation is
 * not observable from a pattern test, so the test reads the map the button
 * opens from `newStoreMapper`, which the button's handler navigates to, and
 * presses the button to check that opening the map leaves the list and its
 * store layout as they were.
 *
 * Run: deno task cf test patterns/apps/shopping-list/shopping-list-store.test.tsx --root patterns --verbose
 */
import { assert, NAME, pattern, TESTS, UI, Writable } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import ShoppingList, { newStoreMapper } from "./main.tsx";

export default pattern(() => {
  const itemsCell = new Writable<
    {
      title: string;
      done: boolean;
      aisleSeed: number;
      aisleOverride: string;
    }[]
  >([]);
  const layoutCell = new Writable("");
  const list = ShoppingList({ items: itemsCell, storeLayout: layoutCell });
  const mapper = newStoreMapper();

  const assert_mapper_is_new_and_empty = assert(() =>
    mapper[NAME] === "My Store" &&
    mapper.storeName === "My Store" &&
    mapper.aisleCount === 0 &&
    mapper.departments.every((dept) => dept.location === "unassigned") &&
    mapper.correctionCount === 0 &&
    mapper.entrances.length === 0 &&
    mapper.outline === ""
  );

  const assert_list_unchanged = assert(() =>
    list.totalCount === 0 &&
    layoutCell.get() === "" &&
    hasText(list[UI], "Using demo store layout") &&
    hasText(list[UI], "Your shopping list is empty")
  );

  return {
    [TESTS]: [
      { assertion: assert_mapper_is_new_and_empty },
      { press: list[UI], control: "🗺️ Store" },
      { assertion: assert_list_unchanged },
    ],
    list,
    mapper,
  };
});
