/**
 * Keeps a list of titled items you can add to, tick off, rename and remove,
 * with live counts of how many remain and how many are done, an action that
 * drops every completed item, and an optional per-row quantity field.
 *
 * Embed it as `<CheckList items={myItems} />` and it mutates the host's own
 * array: adding, toggling and removing all write through the cell the host
 * passed.
 *
 * Items are addressed by live reference, never by index or by a minted id, so
 * a reference a host stashed before an edit still matches afterwards.
 *
 * @hashtags checklist, todo, list, tasks, packing-list, shopping-list
 * @keywords check off, tick, toggle, done, complete, add item, remove item,
 * remaining, packing list, grocery list, shopping list, todo list, task list,
 * checkbox list, quantities
 */
import {
  action,
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface CheckItem {
  title: string;
  done: boolean | Default<false>;
  quantity: number | Default<1>;
}

export interface CheckListInput {
  /** The list itself. A host passes its own cell to share it. */
  items?: Writable<CheckItem[] | Default<[]>>;

  /** Placeholder in the add-item field. */
  placeholder?: Writable<string | Default<"Add an item…">>;

  /** Shown in place of the rows while the list is empty. */
  emptyMessage?: Writable<string | Default<"Nothing here yet.">>;

  /** Whether each row carries an editable quantity. */
  showQuantity?: Writable<boolean | Default<false>>;
}

export interface CheckListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: CheckItem[];
  remainingCount: number;
  completedCount: number;
  summary: string;
  addItem: Stream<{ title: string; quantity?: number }>;
  toggleItem: Stream<{ item: CheckItem }>;
  removeItem: Stream<{ item: CheckItem }>;
  clearCompleted: Stream<void>;
}

export const CheckList = pattern<CheckListInput, CheckListOutput>(
  ({ items, placeholder, emptyMessage, showQuantity }) => {
    const draft = new Writable("");

    const addItem = action(
      ({ title, quantity }: { title: string; quantity?: number }) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        items.push({ title: trimmed, done: false, quantity: quantity ?? 1 });
      },
    );

    // Toggling writes through the element's own cell rather than replacing the
    // array slot: a fresh object literal would re-mint the entity identity and
    // silently strand every reference taken before the edit.
    const toggleItem = action(({ item }: { item: CheckItem }) => {
      const index = items.get().findIndex((candidate) =>
        Writable.equals(candidate, item)
      );
      if (index < 0) return;
      const cell = items.key(index).key("done");
      cell.set(!cell.get());
    });

    const removeItem = action(({ item }: { item: CheckItem }) => {
      // Plain reads of inline rows carry value references; mapped UI rows
      // carry the live slot reference.
      const index = items.get().findIndex((candidate, index) =>
        Writable.equals(items.key(index), item) ||
        Writable.equals(candidate, item)
      );
      if (index < 0) return;
      items.set(items.get().filter((_, position) => position !== index));
    });

    const clearCompleted = action(() => {
      items.set(items.get().filter((item) => !item.done));
    });

    const remainingCount = computed(() =>
      items.get().filter((item) => !item.done).length
    );
    const completedCount = computed(() =>
      items.get().filter((item) => item.done).length
    );
    const isEmpty = computed(() => items.get().length === 0);
    const hasCompleted = computed(() => completedCount > 0);
    const summary = computed(() =>
      items.get()
        .map((item) => `${item.done ? "done" : "open"}: ${item.title}`)
        .join(", ")
    );

    const rows = items.map((item: CheckItem) => (
      <cf-hstack gap="2" align="center">
        <cf-checkbox $checked={item.done} />
        {ifElse(
          showQuantity,
          <cf-input
            type="number"
            $value={item.quantity}
            style="width: 4.5rem;"
          />,
          null,
        )}
        <cf-input $value={item.title} style="flex: 1;" />
        <cf-button
          variant="ghost"
          color="neutral"
          onClick={() =>
            removeItem.send({ item })}
        >
          Remove
        </cf-button>
      </cf-hstack>
    ));

    return {
      [NAME]: computed(() => `Checklist (${remainingCount} left)`),
      [UI]: (
        <cf-vstack gap="3" padding="3">
          <cf-hstack justify="between" align="center">
            <cf-text tone="muted">
              {computed(() => `${remainingCount} left, ${completedCount} done`)}
            </cf-text>
            {ifElse(
              hasCompleted,
              <cf-button
                variant="ghost"
                color="neutral"
                size="sm"
                onClick={clearCompleted}
              >
                Clear completed
              </cf-button>,
              null,
            )}
          </cf-hstack>

          <cf-vstack gap="2">
            {rows}
          </cf-vstack>

          {ifElse(
            isEmpty,
            <cf-empty-state message={emptyMessage} />,
            null,
          )}

          <cf-hstack gap="2">
            <cf-input
              $value={draft}
              placeholder={placeholder}
              style="flex: 1;"
            />
            <cf-button
              variant="primary"
              onClick={() => {
                addItem.send({ title: draft.get() });
                draft.set("");
              }}
            >
              Add
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      ),
      items,
      remainingCount,
      completedCount,
      summary,
      addItem,
      toggleItem,
      removeItem,
      clearCompleted,
    };
  },
);

export default CheckList;
