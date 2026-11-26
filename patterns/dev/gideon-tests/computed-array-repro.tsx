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
 * A computed() that returns a filtered array of JSX rows, each with an onClick
 * handler. Filtering to no rows ("Done" while every item is pending) and then
 * back to "All" or "Pending" puts the rows back in the view tree the pattern
 * returns; its test reads that tree, not the DOM rendered from it.
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
