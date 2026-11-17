/**
 * The lo-fi inductor's items: each with its lo-fi and hi-fi labels, a surprise
 * in the error tone, a button that takes it out, and a box that adds one. The
 * draft in the box is per session; everything else is the inductor's, read
 * and changed through the cells and streams it passes in.
 */

import {
  action,
  computed,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import { type Item, type ItemRow, verdictText } from "./induction.ts";

/** An item as `addItem` takes it; an id is minted when none is given. */
export interface SubmittedItem {
  id?: string;
  fields: Record<string, string>;
}

/** The item `removeItem` takes out: the item itself, as read from `items`. */
export interface ItemRef {
  item: Item;
}

interface ItemsCardInput {
  /** The inductor's items, in the order they were added. */
  items: Item[];
  /** The same items, graded. */
  rows: ItemRow[];
  addItem: Stream<SubmittedItem>;
  removeItem: Stream<ItemRef>;
}

/** The inductor's items with their labels, and a box to add one. */
export interface ItemsCardOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<ItemsCardInput, ItemsCardOutput>(
  ({ items, rows, addItem, removeItem }) => {
    const draft = new Writable.perSession("");

    // The box sends one text field; an empty box sends nothing.
    const addDraft = action(() => {
      const text = draft.get().trim();
      if (text === "") return;
      addItem.send({ fields: { text } });
      draft.set("");
    });

    // The rows are graded copies; the view maps the items themselves, so the
    // remove button sends the item, and looks its labels up here.
    const verdicts = computed(() =>
      Object.fromEntries(
        rows.map((row) => [row.id, {
          text: verdictText(row),
          surprise: row.surprise,
        }]),
      )
    );
    const noItems = computed(() => items.length === 0);

    return {
      [NAME]: "Items",
      [UI]: (
        <cf-card>
          <cf-vstack gap="2">
            <cf-heading level={5}>Items</cf-heading>
            {noItems
              ? (
                <cf-empty-state message="No items yet. Add one below, or have a connector or an agent send them." />
              )
              : null}
            {items.map((item) => (
              <cf-hstack gap="2" align="center">
                <cf-text style="flex: 1;">
                  {computed(() => Object.values(item.fields ?? {}).join(" · "))}
                </cf-text>
                <cf-text
                  variant="caption"
                  tone={computed(() =>
                    verdicts[item.id]?.surprise ? "error" : "muted"
                  )}
                >
                  {computed(() => verdicts[item.id]?.text ?? "")}
                </cf-text>
                <cf-button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeItem.send({ item })}
                >
                  Remove
                </cf-button>
              </cf-hstack>
            ))}
            <cf-hstack gap="2">
              <cf-input
                $value={draft}
                placeholder="Add an item's text"
                style="flex: 1;"
              />
              <cf-button color="primary" onClick={addDraft}>Add</cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-card>
      ),
    };
  },
);
