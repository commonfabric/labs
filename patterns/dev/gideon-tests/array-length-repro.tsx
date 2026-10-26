// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Minimal reproduction: Does .length track reactively on arrays?
 *
 * Hypothesis: Direct .length access doesn't establish reactive tracking,
 * but .filter(() => true).length does (because it iterates).
 *
 * Run: deno task cf test patterns/dev/gideon-tests/array-length-repro.tsx --verbose
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
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
  [UI]: VNode;
  items: Item[];
  addItem: Stream<{ name: string }>;
}

export default pattern<Input, Output>(({ items }) => {
  const addItem = action<{ name: string }>(({ name }) => {
    items.push({ name });
  });

  const itemCount = computed(() => items.get().length);

  return {
    [NAME]: "Array Length Repro",
    [UI]: <div>Items: {itemCount}</div>,
    items,
    addItem,
  };
});
