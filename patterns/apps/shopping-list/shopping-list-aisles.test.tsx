/**
 * Test Pattern: Shopping List sorted view and aisle correction
 *
 * Switches a two-item list with a connected store layout to the sorted view
 * and corrects an item's aisle from the locations that layout names.
 *
 * No language model answers in a pattern test, so each item's aisle
 * categorization fails, logging a warning, and the view falls back to "Other".
 *
 * Run: deno task cf test patterns/apps/shopping-list/shopping-list-aisles.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  clickInRow,
  countElements,
  findElementByExactText,
  findNodeByProp,
  hasText,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ShoppingList from "./shopping-list.tsx";

const STORE_LAYOUT = `# Aisle 1
Dairy

# Fruit & Veg (front)
Fresh produce
`;

/** Whether the view offers a button labelled exactly `label`. */
const offers = (ui: unknown, label: string) =>
  findElementByExactText(ui, "cf-button", label) !== undefined;

const variantOf = (ui: unknown, label: string) =>
  propValue(findElementByExactText(ui, "cf-button", label), "variant");

export default pattern(() => {
  const list = ShoppingList({ items: [], storeLayout: STORE_LAYOUT });

  // Items arrive the way the list's own entry points add them.
  const action_add_and_sort = action(() => {
    list.addItems.send({ itemNames: ["Bread", "Tea"] });
    clickButton(list[UI], "📍 Sorted");
  });
  const assert_sorted_view = assert(() => {
    const ui = readValue(list[UI]);
    return list.items.map((item) => item.title).join(",") === "Bread,Tea" &&
      variantOf(ui, "📍 Sorted") === "primary" &&
      variantOf(ui, "Quick") === "secondary" &&
      hasText(ui, "Bread") &&
      hasText(ui, "Tea") &&
      hasText(ui, "Other") &&
      !hasText(ui, "sorting") &&
      !hasText(ui, "Using demo store layout");
  });

  const action_correct_tea = action(() => clickInRow(list[UI], "Tea", "✏️"));
  const assert_store_locations_offered = assert(() => {
    const ui = readValue(list[UI]);
    return hasText(ui, 'Where is "Tea" actually located?') &&
      offers(ui, "Aisle 1") &&
      offers(ui, "Fruit & Veg") &&
      offers(ui, "Other") &&
      !offers(ui, "Fromagerie");
  });
  const action_cancel = action(() => clickButton(list[UI], "✕ Cancel"));
  const assert_panel_closed = assert(() =>
    !hasText(list[UI], "actually located?") &&
    list.items.every((item) => item.aisleOverride === "")
  );

  const action_pick_fruit_and_veg = action(() =>
    clickButton(list[UI], "Fruit & Veg")
  );
  const assert_tea_in_fruit_and_veg = assert(() => {
    const ui = readValue(list[UI]);
    return list.items[1]?.aisleOverride === "Fruit & Veg" &&
      list.items[0]?.aisleOverride === "" &&
      hasText(ui, "Fruit & Veg") &&
      !hasText(ui, "actually located?");
  });

  const action_quick = action(() => clickButton(list[UI], "Quick"));
  const assert_quick_view = assert(() => {
    const ui = readValue(list[UI]);
    // The quick view shows each title as an editable input, not as text.
    return variantOf(ui, "Quick") === "primary" &&
      countElements(ui, "cf-input") === 2 &&
      findNodeByProp(ui, "$value", "Bread") !== undefined &&
      findNodeByProp(ui, "$value", "Tea") !== undefined &&
      hasText(ui, "2 items to get • 0 checked off") &&
      !hasText(ui, "Tea") &&
      !hasText(ui, "Fruit & Veg");
  });

  return {
    // Every item's categorization request warns, as the header says.
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: action_add_and_sort },
      { assertion: assert_sorted_view },
      { action: action_correct_tea },
      { assertion: assert_store_locations_offered },
      { action: action_cancel },
      { assertion: assert_panel_closed },
      { action: action_correct_tea },
      { action: action_pick_fruit_and_veg },
      { assertion: assert_tea_in_fruit_and_veg },
      { action: action_quick },
      { assertion: assert_quick_view },
    ],
    list,
  };
});
