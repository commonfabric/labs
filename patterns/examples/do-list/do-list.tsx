import {
  computed,
  Default,
  equals,
  handler,
  ifElse,
  NAME,
  pattern,
  Reactive,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import Suggestion from "../../system/suggestion/suggestion.tsx";

// ===== Types =====

/** A #do item — a task that may do itself */
export interface DoItem {
  title: string;
  done: boolean | Default<false>;
  indent: number | Default<0>; // 0 = root, 1 = child, 2 = grandchild...
  aiEnabled: boolean | Default<false>; // future: flag for AI auto-completion
  attachments: Writable<any>[] | Default<[]>;
}

interface DoListInput {
  items?: Writable<DoItem[] | Default<[]>>;
}

export interface DoListOutput {
  [NAME]: string;
  [UI]: VNode;
  compactUI: VNode;
  isHidden: true;
  items: DoItem[];
  itemCount: number;
  summary: string;
  mentionable: { [NAME]: string; summary: string; [UI]: VNode }[];
  // UI handlers (use cell references via equals())
  addItem: Reactive<
    Stream<{ title: string; indent?: number; attachments?: Writable<any>[] }>
  >;
  removeItem: Reactive<Stream<{ item: DoItem }>>;
  updateItem: Reactive<
    Stream<{ item: DoItem; title?: string; done?: boolean }>
  >;
  addItems: Reactive<
    Stream<{
      items: Array<{
        title: string;
        indent?: number;
        attachments?: Writable<any>[];
      }>;
    }>
  >;
  // LLM-friendly handlers (use title matching)

  /** Remove a task and its subtasks by title */
  removeItemByTitle: Reactive<Stream<{ title: string }>>;

  /** Update a task by title. Set done to mark complete, newTitle to rename, attachments to add references. */
  updateItemByTitle: Reactive<
    Stream<{
      title: string;
      newTitle?: string;
      done?: boolean;
      attachments?: Writable<any>[];
    }>
  >;
  archiveCompleted: Reactive<Stream<void>>;
}

// ===== Module-scope Handlers =====

const addItemHandler = handler<
  { title: string; indent?: number; attachments?: Writable<any>[] },
  { items: Writable<DoItem[]> }
>(({ title, indent, attachments }, { items }) => {
  const trimmed = title.trim();
  if (!trimmed) return;

  items.push({
    title: trimmed,
    done: false,
    indent: indent ?? 0,
    aiEnabled: false,
    attachments: attachments ?? [],
  });
});

const removeItemHandler = handler<
  { item: DoItem },
  { items: Writable<DoItem[]> }
>(({ item }, { items }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((i) => equals(i, item));

  if (index === -1) return;

  // Count consecutive children (items with higher indent)
  const itemIndent = item.indent ?? 0;
  let childCount = 0;
  for (let i = index + 1; i < currentItems.length; i++) {
    const nextIndent = currentItems[i].indent ?? 0;
    if (nextIndent > itemIndent) {
      childCount++;
    } else {
      break;
    }
  }

  // Remove item and all its children
  const newItems = [
    ...currentItems.slice(0, index),
    ...currentItems.slice(index + 1 + childCount),
  ];
  items.set(newItems);
});

const updateItemHandler = handler<
  { item: DoItem; title?: string; done?: boolean },
  { items: Writable<DoItem[]> }
>(({ item, title, done }, { items }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((i) => equals(i, item));
  if (index < 0) return;

  // Write THROUGH the element's cells (`items.key(index)` resolves through the
  // slot's link into the entity doc) — never replace the slot with a fresh
  // object literal: a fresh literal re-mints the entity identity, so every
  // previously-held reference to the item (a selection cell, a caller that
  // read it earlier) stops equals()-matching and later mutations with it
  // silently no-op. See patterns/product/primitives/editable-list.tsx.
  const element = items.key(index);
  if (title !== undefined) element.key("title").set(title);
  if (done !== undefined) element.key("done").set(done);
});

const addItemsHandler = handler<
  {
    items: Array<{
      title: string;
      indent?: number;
      attachments?: Writable<any>[];
    }>;
  },
  { items: Writable<DoItem[]> }
>(({ items: newItems }, { items }) => {
  newItems.forEach(({ title, indent, attachments }) => {
    const trimmed = title.trim();
    if (trimmed) {
      items.push({
        title: trimmed,
        done: false,
        indent: indent ?? 0,
        aiEnabled: false,
        attachments: attachments ?? [],
      });
    }
  });
});

// ===== LLM-friendly Handlers (title-based matching) =====

/** Remove a task and its subtasks by title */
const removeItemByTitleHandler = handler<
  { title: string },
  { items: Writable<DoItem[]> }
>(({ title }, { items }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex(
    (i) => i.title?.toLowerCase() === title.toLowerCase(),
  );

  if (index === -1) return;

  const itemIndent = currentItems[index].indent ?? 0;
  let childCount = 0;
  for (let i = index + 1; i < currentItems.length; i++) {
    const nextIndent = currentItems[i].indent ?? 0;
    if (nextIndent > itemIndent) {
      childCount++;
    } else {
      break;
    }
  }

  const newItems = [
    ...currentItems.slice(0, index),
    ...currentItems.slice(index + 1 + childCount),
  ];
  items.set(newItems);
});

/** Update a task by title. Set done to mark complete, newTitle to rename, attachments to add references. */
const updateItemByTitleHandler = handler<
  {
    title: string;
    newTitle?: string;
    done?: boolean;
    attachments?: Writable<any>[];
  },
  { items: Writable<DoItem[]> }
>(({ title, newTitle, done, attachments }, { items }) => {
  const currentItems = items.get();
  // Title matching stays the addressing mechanism (LLM-friendly API), but the
  // update itself writes through each matched element's cells instead of
  // replacing the array slot with a fresh literal — slot replacement re-mints
  // the entity identity and orphans every previously-held item reference
  // (see updateItemHandler above). All case-insensitive matches are updated,
  // matching the original `.map()` semantics.
  const needle = title.toLowerCase();
  for (let index = 0; index < currentItems.length; index++) {
    if (currentItems[index].title?.toLowerCase() !== needle) {
      continue;
    }
    const element = items.key(index);
    if (newTitle !== undefined) element.key("title").set(newTitle);
    if (done !== undefined) element.key("done").set(done);
    if (attachments !== undefined) {
      for (const attachment of attachments) {
        element.key("attachments").push(attachment);
      }
    }
  }
});

const addAttachment = handler<
  { detail: { sourceCell: Writable<any> } },
  { item: DoItem; items: Writable<DoItem[]> }
>((e, { item, items }) => {
  const cell = e.detail?.sourceCell;
  if (!cell) return;
  const currentItems = items.get();
  const idx = currentItems.findIndex((i) => equals(i, item));
  if (idx >= 0) {
    items.key(idx).key("attachments").push(cell);
  }
});

const removeAttachment = handler<
  unknown,
  { item: DoItem; attachment: Writable<any>; items: Writable<DoItem[]> }
>((_, { item, attachment, items }) => {
  const currentItems = items.get();
  const idx = currentItems.findIndex((i) => equals(i, item));
  if (idx >= 0) {
    const attachments = items.key(idx).key("attachments");
    const currentAttachments = attachments.get();
    const attIdx = currentAttachments.findIndex((a: any) =>
      equals(a, attachment)
    );
    if (attIdx >= 0) {
      attachments.set(currentAttachments.toSpliced(attIdx, 1));
    }
  }
});

const archiveCompletedHandler = handler<
  void,
  { items: Writable<DoItem[]> }
>((_, { items }) => {
  items.set(items.get().filter((i) => !i.done));
});

// ===== Sub-pattern for item rendering =====

const DoItemCard = pattern<
  {
    item: DoItem;
    removeItem: Stream<{ item: DoItem }>;
    items: Writable<DoItem[]>;
  },
  { [UI]: VNode; [NAME]: string; summary: string }
>(({ item, removeItem, items }) => {
  const attachments = computed(() => item.attachments ?? []);
  const hasAttachments = computed(() => attachments.length > 0);

  return {
    [NAME]: computed(() => item.title),
    summary: computed(() => item.title),
    [UI]: (
      <cf-drop-zone
        accept="cell-link"
        oncf-drop={addAttachment({ item, items })}
      >
        <cf-card style={`margin-left: ${(item.indent ?? 0) * 24}px;`}>
          <cf-hstack gap="2" align="center">
            <cf-checkbox $checked={item.done} />
            <cf-input
              $value={item.title}
              style="flex: 1;"
              placeholder="Item..."
            />
            <cf-button
              variant="ghost"
              onClick={() => removeItem.send({ item })}
            >
              x
            </cf-button>
          </cf-hstack>

          {ifElse(
            hasAttachments,
            <cf-hstack
              gap="1"
              style="margin-top: 4px; margin-left: 24px; flex-wrap: wrap;"
            >
              {attachments.map((att: any) => (
                <cf-hstack gap="0" align="center">
                  <cf-cell-link $cell={att} />
                  <cf-button
                    variant="ghost"
                    size="sm"
                    style="font-size: 0.7rem; padding: 0 2px;"
                    onClick={removeAttachment({ item, attachment: att, items })}
                  >
                    ×
                  </cf-button>
                </cf-hstack>
              ))}
            </cf-hstack>,
            null,
          )}

          <details style="margin-top: 8px; margin-left: 24px;">
            <summary style="cursor: pointer; font-size: 0.8rem; color: var(--cf-colors-gray-500);">
              AI Suggestions
            </summary>
            <Suggestion
              situation={computed(
                () => `Help the user complete this task: "${item.title}"`,
              )}
              context={{ title: item.title, attachments: attachments }}
              initialResults={[]}
            />
          </details>
        </cf-card>
      </cf-drop-zone>
    ),
  };
});

const CompletedItemCard = pattern<
  {
    item: DoItem;
  },
  { [UI]: VNode; [NAME]: string; summary: string }
>(({ item }) => {
  return {
    [NAME]: computed(() => item.title),
    summary: computed(() => item.title),
    [UI]: (
      <cf-card
        style={`margin-left: ${(item.indent ?? 0) * 24}px; opacity: 0.7;`}
      >
        <cf-hstack gap="2" align="center">
          <cf-checkbox $checked={item.done} />
          <span style="text-decoration: line-through; flex: 1; color: var(--cf-colors-gray-500);">
            {item.title}
          </span>
        </cf-hstack>
      </cf-card>
    ),
  };
});

// ===== Pattern =====

export default pattern<DoListInput, DoListOutput>(({ items }) => {
  // Computed values
  const itemCount = computed(() => items.get().length);
  const activeItems = computed(() => items.get().filter((i) => i && !i.done));
  const completedItems = computed(() => items.get().filter((i) => i && i.done));
  const hasCompleted = computed(() => completedItems.length > 0);
  const hasNoItems = computed(() => activeItems.length === 0);

  const summary = computed(() => {
    return items.get()
      .filter((item) => item)
      .map((item) => `${item.done ? "✓" : "○"} ${item.title}`)
      .join(", ");
  });

  // Bind handlers
  const addItem = addItemHandler({ items });
  const removeItem = removeItemHandler({ items });
  const updateItem = updateItemHandler({ items });
  const addItems = addItemsHandler({ items });
  const removeItemByTitle = removeItemByTitleHandler({ items });
  const updateItemByTitle = updateItemByTitleHandler({ items });
  const archiveCompleted = archiveCompletedHandler({ items });

  // Map items to sub-pattern instances once — reused for UI and mentionable
  const itemCards = activeItems.map((item: DoItem) => (
    <DoItemCard item={item} removeItem={removeItem} items={items} />
  ));

  const completedCards = completedItems.map((item: DoItem) => (
    <CompletedItemCard item={item} />
  ));

  // Compact UI - embeddable widget without cf-screen wrapper
  const compactUI = (
    <cf-vstack gap="2">
      <cf-vstack gap="2">
        {itemCards}

        {hasNoItems
          ? (
            <div style="text-align: center; color: var(--cf-colors-gray-500); padding: 1rem;">
              No items yet. Add one below!
            </div>
          )
          : null}
      </cf-vstack>

      {ifElse(
        hasCompleted,
        <cf-hstack justify="end" style="padding: 0 0.5rem;">
          <cf-button
            variant="ghost"
            size="sm"
            style="font-size: 0.8rem; color: var(--cf-colors-gray-500);"
            onClick={() => archiveCompleted.send()}
          >
            Archive completed
          </cf-button>
        </cf-hstack>,
        null,
      )}

      <cf-message-input
        placeholder="Add an item..."
        oncf-send={(e: { detail?: { message?: string } }) => {
          const title = e.detail?.message?.trim();
          if (title) {
            addItem.send({ title });
          }
        }}
      />
    </cf-vstack>
  );

  return {
    [NAME]: computed(() => `Do List (${items.get().length})`),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>Do List</cf-heading>
            <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
              {computed(() => activeItems.length)} items
            </span>
          </cf-hstack>
        </cf-vstack>

        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="2" style="padding: 1rem;">
            {itemCards}

            {hasNoItems
              ? (
                <div style="text-align: center; color: var(--cf-colors-gray-500); padding: 2rem;">
                  No items yet. Add one below!
                </div>
              )
              : null}

            {ifElse(
              hasCompleted,
              <details style="margin-top: 1rem;">
                <summary style="cursor: pointer; font-size: 0.875rem; color: var(--cf-colors-gray-500); padding: 0.5rem 0;">
                  Completed ({computed(() => completedItems.length)})
                </summary>
                <cf-vstack gap="2" style="padding-top: 0.5rem;">
                  {completedCards}
                  <cf-hstack justify="end">
                    <cf-button
                      variant="ghost"
                      size="sm"
                      style="font-size: 0.8rem; color: var(--cf-colors-gray-500);"
                      onClick={() => archiveCompleted.send()}
                    >
                      Archive all
                    </cf-button>
                  </cf-hstack>
                </cf-vstack>
              </details>,
              null,
            )}
          </cf-vstack>
        </cf-vscroll>

        <cf-hstack slot="footer" gap="2" style="padding: 1rem;">
          <cf-message-input
            placeholder="Add an item..."
            style="flex: 1;"
            oncf-send={(e: { detail?: { message?: string } }) => {
              const title = e.detail?.message?.trim();
              if (title) {
                addItem.send({ title });
              }
            }}
          />
        </cf-hstack>
      </cf-screen>
    ),
    compactUI,
    isHidden: true,
    items,
    itemCount,
    summary,
    mentionable: itemCards,
    addItem,
    removeItem,
    updateItem,
    addItems,
    removeItemByTitle,
    updateItemByTitle,
    archiveCompleted,
  };
});
