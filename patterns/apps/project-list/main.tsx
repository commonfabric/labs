import {
  action,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface ProjectItem {
  id: string;
  title: string;
  done: boolean;
}

interface ProjectListInput {
  items?: Writable<
    ProjectItem[] | Default<[]>
  >;
}

export interface ProjectListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: Writable<ProjectItem[]>;
}

// Exported for tests. Writes through the element's cell (`.key(index)`) —
// rebuilding the array with a fresh object literal for the toggled item would
// re-mint its entity identity and orphan previously-held references (see
// patterns/product/primitives/editable-list.tsx).
export const toggleItem = handler<
  void,
  { index: number; items: Writable<ProjectItem[]> }
>(
  (_, { index, items }) => {
    const list = items.get();
    if (index < 0 || index >= list.length) return;
    items.key(index).key("done").set(!list[index].done);
  },
);

const removeItem = handler<
  void,
  { index: number; items: Writable<ProjectItem[]> }
>(
  (_, { index, items }) => {
    const list = items.get();
    items.set(list.filter((_, i) => i !== index));
  },
);

export default pattern<ProjectListInput, ProjectListOutput>(({ items }) => {
  const addItem = action(() => {
    const id = Math.random().toString(36).slice(2, 8);
    items.set([
      ...items.get(),
      { id, title: `Project ${items.get().length + 1}`, done: false },
    ]);
  });

  return {
    [NAME]: "Project List",
    [UI]: (
      <cf-vstack gap="1" style={{ maxWidth: "400px" }}>
        {items.map((item, index) => (
          <cf-list-item label={item.title}>
            <cf-checkbox
              slot="icon"
              $checked={item.done}
              oncf-change={toggleItem({ index, items })}
            />
            <cf-button
              slot="action"
              color="neutral"
              variant="ghost"
              size="icon"
              onClick={removeItem({ index, items })}
            >
              x
            </cf-button>
          </cf-list-item>
        ))}
        <div style={{ display: "flex", gap: "9px", paddingTop: "8px" }}>
          <cf-button color="neutral" variant="outline" onClick={addItem}>
            + Label
          </cf-button>
          <cf-button color="neutral" variant="outline" onClick={addItem}>
            + Label
          </cf-button>
          <cf-button color="neutral" variant="outline" onClick={addItem}>
            + Label
          </cf-button>
        </div>
      </cf-vstack>
    ),
    items,
  };
});
