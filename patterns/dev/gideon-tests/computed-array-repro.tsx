// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * MINIMAL BUG REPRODUCTION
 *
 * Bug: computed() returning array with onClick handler "sticks" empty
 *
 * Root cause: When computed() returns JSX array containing onClick handlers,
 * and the array becomes empty (e.g. filtering to no results), the UI
 * permanently shows empty even when the computed should return items again.
 *
 * To reproduce:
 * 1. Add some "Pending" items
 * 2. Switch to "Done" tab (shows empty - no done items)
 * 3. Switch back to "All" or "Pending" tab
 * 4. BUG: Items don't reappear!
 *
 * Workaround: Use items.map() with computed style to hide/show instead of
 * computed() returning filtered array.
 */

type Status = "pending" | "done";

interface Item {
  name: string;
  status: Status;
}

interface Input {
  items?: Writable<Item[] | Default<[]>>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  items: Item[];
}

export default pattern<Input, Output>(({ items }) => {
  const filter = new Writable<Status | "all">("all");
  const counter = new Writable(1);

  return {
    [NAME]: "Computed Array Bug",
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="2">
          <cf-tabs $value={filter}>
            <cf-tab-list>
              <cf-tab value="all">All</cf-tab>
              <cf-tab value="pending">Pending</cf-tab>
              <cf-tab value="done">Done</cf-tab>
            </cf-tab-list>
          </cf-tabs>
        </cf-vstack>

        <cf-vscroll flex>
          <cf-vstack gap="2" style="padding: 1rem;">
            <cf-button
              variant="secondary"
              onClick={() => {
                const c = counter.get();
                items.push({ name: `Item ${c}`, status: "pending" });
                counter.set(c + 1);
              }}
            >
              Add Pending Item
            </cf-button>

            <p>
              Filter: {filter} | Total: {computed(() => items.get().length)}
            </p>

            {/* BUG: This breaks after visiting empty tab */}
            {computed(() =>
              (filter.get() === "all"
                ? items.get().filter((i) => i != null)
                : items.get().filter((i) => i && i.status === filter.get()))
                .map((item) => (
                  <div style="padding: 0.5rem; background: #eee; border-radius: 4px;">
                    {item.name}
                    <button type="button" onClick={() => console.log(item)}>
                      log
                    </button>
                  </div>
                ))
            )}
          </cf-vstack>
        </cf-vscroll>
      </cf-screen>
    ),
    items,
  };
});
