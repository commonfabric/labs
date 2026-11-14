/**
 * Test Pattern: Shopping List view and entry points
 *
 * Adds items through every entry point the list exposes (the message input
 * and the three omnibot streams), reads them back through the quick view and
 * the summary, and removes one with its row's remove button.
 * `shopping-list-aisles.test.tsx` covers the sorted view.
 *
 * Run: deno task cf test patterns/apps/shopping-list/shopping-list-view.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  findElement,
  fireEvent,
  hasText,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ShoppingList, { searchItemsPattern } from "./shopping-list.tsx";

const titles = (items: readonly { title: string }[]) =>
  items.map((item) => item.title).join(",");

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

  const search = searchItemsPattern({
    items: [
      { title: "Bread", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Shortbread", done: false, aisleSeed: 0, aisleOverride: "" },
      { title: "Milk", done: false, aisleSeed: 0, aisleOverride: "" },
    ],
    query: "BREAD",
  });

  const assert_starts_empty = assert(() => {
    const ui = readValue(list[UI]);
    return titles(search) === "Bread,Shortbread" &&
      hasText(ui, "Your shopping list is empty") &&
      hasText(ui, "0 items to get • 0 checked off") &&
      hasText(ui, "Using demo store layout") &&
      list.summary === "";
  });

  // Each entry point ignores a blank entry and trims the rest.
  const action_add_entries = action(() => {
    list.addItem.send({ detail: { message: "   " } });
    list.addItemForOmnibot.send({ itemText: "  " });
    list.addItem.send({ detail: { message: " Milk " } });
    list.addItemForOmnibot.send({ itemText: " Bread " });
    list.addItems.send({ itemNames: ["", " Jam "] });
  });
  const action_type_into_input = action(() =>
    fireEvent(findElement(list[UI], "cf-message-input"), "oncf-send", {
      detail: { message: "Tea" },
    })
  );
  const assert_entries_added = assert(() => {
    const ui = readValue(list[UI]);
    // With server execution on, sends from one action can land in any order.
    return [...list.items].map((item) => item.title).sort().join(",") ===
        "Bread,Jam,Milk,Tea" &&
      list.items[3]?.title === "Tea" &&
      list.items.every((item) => !item.done && item.aisleOverride === "") &&
      hasText(ui, "4 items to get • 0 checked off") &&
      !hasText(ui, "Your shopping list is empty") &&
      list.summary.split(", ").length === 4;
  });

  // The quick view's rows show each title in an input, so the first row's
  // remove button is the first "×" in the view. The action notes the order it
  // saw, since the entries' own order is not fixed.
  const seenBeforeRemoval = new Writable<string[]>([]);
  const action_remove_first_row = action(() => {
    seenBeforeRemoval.set(itemsCell.get().map((item) => item.title));
    clickButton(list[UI], "×");
  });
  const assert_first_removed = assert(() =>
    seenBeforeRemoval.get().length === 4 &&
    titles(list.items) === seenBeforeRemoval.get().slice(1).join(",") &&
    !list.items.some((item) => item.title === seenBeforeRemoval.get()[0]) &&
    hasText(list[UI], "3 items to get • 0 checked off")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_add_entries },
      { action: action_type_into_input },
      { assertion: assert_entries_added },
      { action: action_remove_first_row },
      { assertion: assert_first_removed },
    ],
    list,
  };
});
