/**
 * The lo-fi inductor's items: a box that adds one, then each item with its
 * labels as the inductor words them, a surprise in the error tone, a badge on
 * a held-out item, and a button that takes it out. The draft in the box is per
 * session; everything else is the inductor's.
 */

import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { Item, Verdict } from "./induction.ts";

/** An item as `addItem` takes it; an id is minted when none is given. */
export interface SubmittedItem {
  id?: string;

  /**
   * The item's text fields. The event's schema drops a field that is not a
   * string before `addItem` sees it.
   */
  fields: Record<string, string>;
}

/** The item `removeItem` takes out: the item itself, as read from `items`. */
export interface ItemRef {
  item: Item;
}

interface ItemsCardInput {
  /** The inductor's items, in the order they were added. */
  items: Item[];

  /** Each item's labels, by id (`verdictsOf`). */
  verdicts?: Default<Record<string, Verdict>, Record<string, never>>;

  addItem: Stream<SubmittedItem>;
  removeItem: Stream<ItemRef>;
}

/** The inductor's items with their labels, and a box to add one. */
export interface ItemsCardOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<ItemsCardInput, ItemsCardOutput>(
  ({ items, verdicts, addItem, removeItem }) => {
    const draft = new Writable.perSession("");

    // The box sends one text field; an empty box sends nothing.
    const addDraft = action(() => {
      const text = draft.get().trim();
      if (text === "") return;
      addItem.send({ fields: { text } });
      draft.set("");
    });

    const noItems = computed(() => items.length === 0);

    return {
      [NAME]: "Items",
      [UI]: (
        <cf-card>
          <cf-vstack gap="2">
            <cf-heading level={5}>Items</cf-heading>
            <cf-hstack gap="2">
              <cf-input
                $value={draft}
                placeholder="Add an item's text"
                style="flex: 1;"
              />
              <cf-button color="primary" onClick={addDraft}>Add</cf-button>
            </cf-hstack>
            {noItems
              ? (
                <cf-empty-state message="No items yet. Add one above, or have a connector or an agent send them." />
              )
              : null}
            {items.map((item) => (
              <cf-hstack gap="2" align="center">
                <cf-text style="flex: 1;">
                  {computed(() => Object.values(item.fields ?? {}).join(" · "))}
                </cf-text>
                {computed(() =>
                  verdicts[item.id]?.heldOut
                    ? <cf-badge size="xs" color="neutral">held out</cf-badge>
                    : null
                )}
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
          </cf-vstack>
        </cf-card>
      ),
    };
  },
);
