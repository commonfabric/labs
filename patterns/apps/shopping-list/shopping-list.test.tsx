/**
 * Test Pattern: Shopping List
 *
 * Tests the core shopping list functionality:
 * - Initial state (empty list)
 * - Adding items
 * - Marking items as done
 * - Removing items
 * - Statistics (totalCount, doneCount, remainingCount)
 * - held-reference survival (CT-1715): a reference stashed in a cell BEFORE
 *   an aisle correction (selectAisle) must still `equals()`-match and still
 *   drive a subsequent equals()-located removal AFTER the correction. The
 *   correction writes through the element's cell; replacing the array slot
 *   with a fresh object literal would re-mint the entity identity and
 *   orphan every held reference.
 *
 * Run: deno task cf test patterns/apps/shopping-list/shopping-list.test.tsx --verbose
 */
import {
  action,
  assert,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import ShoppingList, { removeItem, selectAisle } from "./shopping-list.tsx";

interface ShoppingItem {
  title: string;
  done: boolean;
  aisleSeed: number;
  aisleOverride: string;
}

// Handler to set items. Builds fresh literals (not copies of the
// state-bound data proxies) so each item becomes an entity doc with its own
// identity — the same shape the pattern's own add handlers produce. Entity
// identity is what the held-reference tests below exercise.
const setItems = handler<
  void,
  { items: Writable<ShoppingItem[]>; data: ShoppingItem[] }
>(
  (_event, { items, data }) => {
    items.set(data.map((d) => ({
      title: d.title,
      done: d.done,
      aisleSeed: d.aisleSeed,
      aisleOverride: d.aisleOverride,
    })));
  },
);

// Handler to set store layout
const setLayout = handler<
  void,
  { storeLayout: Writable<string>; layout: string }
>(
  (_event, { storeLayout, layout }) => {
    storeLayout.set(layout);
  },
);

export default pattern(() => {
  // Create writable cells that we control
  const itemsCell = new Writable<ShoppingItem[]>([]);
  const layoutCell = new Writable("");

  // Instantiate the shopping list pattern
  const list = ShoppingList({
    items: itemsCell,
    storeLayout: layoutCell,
  });

  // Held-reference survival plumbing: an external holder (selection cell)
  // that read an item once and keeps the reference across later mutations.
  // Typed non-null (placeholder initial value) so the cell can be bound
  // directly as handler state.
  const heldItem = new Writable<ShoppingItem>({
    title: "",
    done: false,
    aisleSeed: 0,
    aisleOverride: "",
  });
  const correctionIndexCell = new Writable<number>(-1);

  // ==========================================================================
  // Actions - bind handlers with hardcoded data
  // ==========================================================================

  const action_add_milk = setItems({
    items: itemsCell,
    data: [{ title: "Milk", done: false, aisleSeed: 0, aisleOverride: "" }],
  });

  const action_add_bread_eggs = setItems({
    items: itemsCell,
    data: [
      { title: "Milk", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Bread", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Eggs", done: false, aisleSeed: 0, aisleOverride: "" },
    ],
  });

  const action_mark_first_done = setItems({
    items: itemsCell,
    data: [
      { title: "Milk", done: true, aisleSeed: 0, aisleOverride: "" },
      { title: "Bread", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Eggs", done: false, aisleSeed: 0, aisleOverride: "" },
    ],
  });

  const action_remove_first = setItems({
    items: itemsCell,
    data: [
      { title: "Bread", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Eggs", done: false, aisleSeed: 0, aisleOverride: "" },
    ],
  });

  const action_set_store_layout = setLayout({
    storeLayout: layoutCell,
    layout: `# Aisle 1
Dairy, Milk, Eggs

# Aisle 2
Bread, Bakery

# Produce
Fresh vegetables and fruits
`,
  });

  const action_clear_store_layout = setLayout({
    storeLayout: layoutCell,
    layout: "",
  });

  // === Held-reference survival actions (CT-1715) ===
  // After test 5 the list is [Bread, Eggs]; stash a reference to Bread.
  const action_stash_held_item = action(() => {
    const item = itemsCell.get()[0];
    if (item) heldItem.set(item);
  });
  const action_open_correction = action(() => {
    correctionIndexCell.set(0);
  });
  // The REAL exported selectAisle handler, bound to the test-owned cells.
  const action_select_aisle = selectAisle({
    items: itemsCell,
    correctionIndex: correctionIndexCell,
    selectedAisle: "Aisle 2",
  });
  // The REAL exported removeItem handler, driven by the held reference
  // (removeItem locates the item with equals()).
  const action_remove_via_held = removeItem({
    items: itemsCell,
    item: heldItem,
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  // Initial state - use totalCount which is computed from items.get().length
  const assert_initial_empty = assert(() => list.totalCount === 0);
  const assert_initial_total_zero = assert(() => list.totalCount === 0);
  const assert_initial_done_zero = assert(() => list.doneCount === 0);
  const assert_initial_remaining_zero = assert(() => list.remainingCount === 0);

  // After adding one item
  const assert_one_item = assert(() => list.totalCount === 1);
  const assert_total_one = assert(() => list.totalCount === 1);
  const assert_remaining_one = assert(() => list.remainingCount === 1);
  const assert_first_item_milk = assert(() => list.items[0]?.title === "Milk");

  // After adding three items
  const assert_three_items = assert(() => list.totalCount === 3);
  const assert_total_three = assert(() => list.totalCount === 3);
  const assert_remaining_three = assert(() => list.remainingCount === 3);
  const assert_done_still_zero = assert(() => list.doneCount === 0);

  // After marking first done
  const assert_done_one = assert(() => list.doneCount === 1);
  const assert_remaining_two = assert(() => list.remainingCount === 2);
  const assert_first_is_done = assert(() => list.items[0]?.done === true);

  // After removing first item
  const assert_two_items = assert(() => list.totalCount === 2);
  const assert_total_two = assert(() => list.totalCount === 2);
  const assert_done_zero_after_remove = assert(() => list.doneCount === 0);
  const assert_first_now_bread = assert(() => list.items[0]?.title === "Bread");

  // Store layout
  const assert_no_layout_initially = assert(() =>
    String(list.storeLayout).trim().length === 0
  );
  const assert_has_layout = assert(() =>
    String(list.storeLayout).trim().length > 0
  );
  const assert_layout_cleared = assert(() =>
    String(list.storeLayout).trim().length === 0
  );

  // === Held-reference survival assertions (CT-1715) ===
  const assert_held_stashed = assert(() => {
    const h = heldItem.get();
    return h.title === "Bread" && equals(itemsCell.get()[0], h);
  });
  const assert_override_set = assert(() =>
    itemsCell.get()[0]?.aisleOverride === "Aisle 2"
  );
  const assert_correction_closed = assert(() =>
    correctionIndexCell.get() === -1
  );
  // KEY: the stale-but-once-valid reference still equals()-matches the item
  // AFTER selectAisle updated it.
  const assert_held_survives_correction = assert(() => {
    const h = heldItem.get();
    return equals(itemsCell.get()[0], h);
  });
  // The held reference also READS the update (it would show the stale,
  // orphaned entity if selectAisle had re-minted identity).
  const assert_held_reads_correction = assert(() =>
    heldItem.get().aisleOverride === "Aisle 2"
  );
  // KEY: the held reference still DRIVES an equals()-located removal.
  const assert_removed_via_held = assert(() =>
    list.totalCount === 1 && list.items[0]?.title === "Eggs"
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Test 1: Initial empty state ===
      { assertion: assert_initial_empty },
      { assertion: assert_initial_total_zero },
      { assertion: assert_initial_done_zero },
      { assertion: assert_initial_remaining_zero },
      { assertion: assert_no_layout_initially },

      // === Test 2: Add first item ===
      { action: action_add_milk },
      { assertion: assert_one_item },
      { assertion: assert_total_one },
      { assertion: assert_remaining_one },
      { assertion: assert_first_item_milk },

      // === Test 3: Add more items ===
      { action: action_add_bread_eggs },
      { assertion: assert_three_items },
      { assertion: assert_total_three },
      { assertion: assert_remaining_three },
      { assertion: assert_done_still_zero },

      // === Test 4: Mark item as done ===
      { action: action_mark_first_done },
      { assertion: assert_done_one },
      { assertion: assert_remaining_two },
      { assertion: assert_first_is_done },

      // === Test 5: Remove item ===
      { action: action_remove_first },
      { assertion: assert_two_items },
      { assertion: assert_total_two },
      { assertion: assert_done_zero_after_remove },
      { assertion: assert_first_now_bread },

      // === Test 6: Store layout ===
      { action: action_set_store_layout },
      { assertion: assert_has_layout },
      { action: action_clear_store_layout },
      { assertion: assert_layout_cleared },

      // === Test 7: Held-reference survival across an aisle correction ===
      { action: action_stash_held_item },
      { assertion: assert_held_stashed },
      { action: action_open_correction },
      { action: action_select_aisle },
      { assertion: assert_override_set },
      { assertion: assert_correction_closed },
      { assertion: assert_held_survives_correction },
      { assertion: assert_held_reads_correction },
      { action: action_remove_via_held },
      { assertion: assert_removed_via_held },
    ],
    list,
  };
});
