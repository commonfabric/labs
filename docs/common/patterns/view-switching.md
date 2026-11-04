# View Switching

Any cell result with `[UI]` renders when placed in JSX — you don't need to know what pattern produced it. This is the foundation of all view switching: change which cell is in the vdom, and the UI updates.

## Approach 1: Switch on a String

Use a `Writable<string>` to represent the active view. A `computed()` block maps the string to a pattern instance:

```tsx
// Shown at module scope.
import { computed, handler, pattern, UI, Writable } from "commonfabric";
import EditView from "./edit-view.tsx";
import PreviewView from "./preview-view.tsx";
import SettingsView from "./settings-view.tsx";

export default pattern<{ activeView: Writable<string> }>(({ activeView }) => {
  const view = computed(() => {
    switch (activeView.get()) {
      case "edit":     return EditView({});
      case "preview":  return PreviewView({});
      case "settings": return SettingsView({});
      default:         return null;
    }
  });

  const setView = handler<unknown, { id: string; activeView: Writable<string> }>(
    (_, { id, activeView }) => activeView.set(id)
  );

  return {
    [UI]: (
      <div>
        <div>
          <cf-button onClick={setView({ id: "edit", activeView })}>Edit</cf-button>
          <cf-button onClick={setView({ id: "preview", activeView })}>Preview</cf-button>
          <cf-button onClick={setView({ id: "settings", activeView })}>Settings</cf-button>
        </div>
        <>{view}</>
      </div>
    ),
  };
});
```

When `activeView` changes, the `computed` re-runs and returns a different sub-pattern. The runtime extracts its `[UI]` and renders it in place.

**Real example:** `patterns/dev/catalog/ui/story-renderer.tsx` — the UI component catalog uses this pattern with 25+ views.

## Approach 2: Update a Cell Pointer

Instead of mapping a string to a view, hold a direct reference to the active cell and update it. The items must be **renderable cells** (pattern instances with `[UI]`) — not plain data objects. Use `<cf-render $cell={...} />` to display whatever cell is currently selected:

```tsx
import {
  computed,
  equals,
  handler,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import ItemView from "./item-view.tsx";

// ItemView produces cells with [UI]; this type captures what we need for the list
interface ItemCell { title: string; [UI]: VNode }

export default pattern<{
  items: Writable<ItemCell[]>;
  activeItem: Writable<ItemCell | null>;
}>(({ items, activeItem }) => {
  const selectItem = handler<unknown, {
    activeItem: Writable<ItemCell | null>;
    items: Writable<ItemCell[]>;
    index: number;
  }>((_, { activeItem, items, index }) => {
    // Stores a reference to the cell itself — not a copy of its data
    activeItem.set(items.get()[index]);
  });

  const itemsWithSelection = computed(() => {
    const selected = activeItem.get();
    return items.get().map((item, index) => ({
      item, index,
      isSelected: selected !== null && equals(selected, item),
    }));
  });

  return {
    [UI]: (
      <div>
        {itemsWithSelection.map((entry) => (
          <div
            onClick={selectItem({ activeItem, items, index: entry.index })}
            style={{ fontWeight: entry.isSelected ? "bold" : "normal" }}
          >
            {entry.item.title}
          </div>
        ))}
        {/* cf-render extracts and displays the active cell's [UI] */}
        <cf-render $cell={activeItem} />
      </div>
    ),
    activeItem,
  };
});
```

This is useful when:
- Selecting from a dynamic list (you don't know the items at compile time)
- Rendering anonymous cells — you just need to display whatever the pointer references
- Embedding cells from other patterns or spaces

**Key point:** The items stored in `activeItem` must be cells with `[UI]` (i.e., pattern instances), not plain data objects. Placing a plain data object in `activeItem` and using `<cf-render>` will render nothing. If you need to select plain data and display it, use Approach 1 (switch on a string) or render the data's fields directly in JSX.

**Rendering anonymous cells:** Use `<cf-render $cell={piece} />` to render any cell's `[UI]`, even if you don't know its type. See `patterns/system/piece-grid/piece-grid.tsx` for an example rendering a grid of arbitrary pieces.

## Approach 3: Tabs

For simple tabbed UIs, `cf-tabs` handles string-based view switching as a built-in:

```tsx
// Shown inside a pattern body.
const activeTab = new Writable("spaces").for("activeTab");

<cf-tabs $value={activeTab}>
  <cf-tab-list>
    <cf-tab value="spaces">Spaces</cf-tab>
    <cf-tab value="favorites">Favorites</cf-tab>
  </cf-tab-list>
  <cf-tab-panel value="spaces">{spacesView}</cf-tab-panel>
  <cf-tab-panel value="favorites">{favoritesView}</cf-tab-panel>
</cf-tabs>
```

The `.for("activeTab")` call makes the tab state durable (persisted by key). See `patterns/system/home/home.tsx`.

## When to Use Which

| Scenario | Approach |
|---|---|
| Known set of views, menu/sidebar navigation | Switch on a string |
| Selecting from dynamic data (list items, search results) | Cell pointer |
| Simple tabbed layout with static panels | `cf-tabs` |
| Rendering cells you don't control (grids, embeds) | Cell pointer + `cf-render` |

## See Also

- [Pattern Composition](./composition.md) — embedding sub-patterns in the vdom
- [Navigation](./navigation.md) — `navigateTo()` for drill-down to detail views
- [Conditional Rendering](./conditional.md) — plain ternaries for show/hide
