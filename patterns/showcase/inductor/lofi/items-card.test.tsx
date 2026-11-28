/**
 * The lo-fi inductor's items card: the box sends its trimmed text as one
 * `text` field and empties, an empty or blank box sends nothing, each row
 * shows its item's fields and labels, and a row's Remove sends that row's item.
 *
 * Pattern under test: ./items-card.tsx
 */
import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElement,
  findElementByExactText,
  hasText,
  propValue,
  rowWith,
  typeInto,
} from "../../../tools/test-support/vnode-helpers.ts";
import type { Item, Verdict } from "./induction.ts";
import ItemsCard, { type ItemRef, type SubmittedItem } from "./items-card.tsx";

const PLACEHOLDER = "Add an item's text";

/** Records each item the card asks to add. */
const recordAdd = handler<SubmittedItem, { added: Writable<SubmittedItem[]> }>(
  (event, { added }) => {
    added.push(event);
  },
);

/** Records the id of each item the card asks to remove. */
const recordRemove = handler<ItemRef, { removed: Writable<string[]> }>(
  (event, { removed }) => {
    removed.push(event.item.id);
  },
);

export default pattern(() => {
  const items = new Writable<Item[]>([
    { id: "mail-1", fields: { subject: "Bill for March", from: "Power Co" } },
    { id: "mail-2", fields: { subject: "Lunch?" } },
  ]);
  const verdicts: Record<string, Verdict> = {
    "mail-1": { text: "hi-fi YES · lo-fi NO", surprise: true, heldOut: false },
    "mail-2": { text: "hi-fi NO · lo-fi NO", surprise: false, heldOut: true },
  };
  const added = new Writable<SubmittedItem[]>([]);
  const removed = new Writable<string[]>([]);

  const card = ItemsCard({
    items,
    verdicts,
    addItem: recordAdd({ added }),
    removeItem: recordRemove({ removed }),
  });
  const empty = ItemsCard({
    items: [],
    addItem: recordAdd({ added }),
    removeItem: recordRemove({ removed }),
  });

  const assert_rows_shown = assert(() =>
    hasText(rowWith(card[UI], "Bill for March", "Remove"), "Power Co") &&
    !hasText(rowWith(card[UI], "Lunch?", "Remove"), "Power Co") &&
    findElement(card[UI], "cf-empty-state") === undefined
  );
  const assert_labels_shown = assert(() =>
    propValue(
        findElementByExactText(card[UI], "cf-text", "hi-fi YES · lo-fi NO"),
        "tone",
      ) === "error" &&
    propValue(
        findElementByExactText(card[UI], "cf-text", "hi-fi NO · lo-fi NO"),
        "tone",
      ) === "muted"
  );
  const assert_held_out_badge = assert(() =>
    hasText(rowWith(card[UI], "Lunch?", "Remove"), "held out") &&
    !hasText(rowWith(card[UI], "Bill for March", "Remove"), "held out")
  );
  const assert_empty_state = assert(() =>
    hasText(
      propValue(findElement(empty[UI], "cf-empty-state"), "message"),
      "No items yet",
    ) &&
    findElementByExactText(empty[UI], "cf-button", "Remove") === undefined
  );

  const action_type_blank = action(() => typeInto(card[UI], PLACEHOLDER, "  "));
  const assert_nothing_added = assert(() => added.get().length === 0);

  const action_type_text = action(() =>
    typeInto(card[UI], PLACEHOLDER, "  Invoice 42 is due  ")
  );
  const assert_one_added = assert(() =>
    added.get().length === 1 &&
    added.get()[0].id === undefined &&
    JSON.stringify(added.get()[0].fields) ===
      JSON.stringify({ text: "Invoice 42 is due" }) &&
    propValue(findElement(card[UI], "cf-input"), "$value") === ""
  );

  const assert_nothing_removed = assert(() => removed.get().length === 0);
  const assert_lunch_removed = assert(() =>
    JSON.stringify(removed.get()) === JSON.stringify(["mail-2"])
  );

  return {
    [TESTS]: [
      { assertion: assert_rows_shown },
      { assertion: assert_labels_shown },
      { assertion: assert_held_out_badge },
      { assertion: assert_empty_state },

      // An empty box, then a blank one, sends nothing.
      { press: card[UI], control: "Add" },
      { assertion: assert_nothing_added },
      { action: action_type_blank },
      { press: card[UI], control: "Add" },
      { assertion: assert_nothing_added },

      // Text sends one trimmed `text` field and empties the box.
      { action: action_type_text },
      { press: card[UI], control: "Add" },
      { assertion: assert_one_added },

      // Remove sends the item of the row it sits in, and only that one.
      { assertion: assert_nothing_removed },
      { press: card[UI], control: "Remove", within: "Lunch?" },
      { assertion: assert_lunch_removed },
    ],
    card,
    empty,
  };
});
