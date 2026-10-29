// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Minimal pattern exposing a computed array and a string output.
 * Used to reproduce the .length bug on reactive proxy values.
 *
 * The bug: accessing .length on computed arrays or string outputs
 * from a pattern instance returns undefined instead of the actual length.
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  Writable,
} from "commonfabric";

interface Item {
  name: string;
}

interface Input {
  items: Writable<Item[] | Default<[]>>;
}

export interface Output {
  [NAME]: string;
  items: Item[];
  filteredItems: Item[];
  label: string;
  itemCount: number;
  addItem: Stream<void>;
}

export default pattern<Input, Output>(({ items }) => {
  const addItem = action(() => {
    const current = items.get();
    items.set([...current, { name: `Item ${current.length + 1}` }]);
  });

  // Computed array derived from the input
  const filteredItems = computed(() =>
    items.get().filter((i) => i.name !== "")
  );

  // Computed string
  const label = computed(() => `Total: ${items.get().length}`);

  // Computed count (for comparison)
  const itemCount = computed(() => items.get().length);

  return {
    [NAME]: "Proxy Length Repro",
    items,
    filteredItems,
    label,
    itemCount,
    addItem,
  };
});
