/// <cts-enable />
import { lift, pattern } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

// The patterns of `compare/sandbox-cost.ts`, each over an array of plain
// values in place. `PerRow`: a `map` whose element body is an expression,
// one value function per row. `BodyPerRow`: a `map` whose element body
// calls a `lift`, one function body per row. `Whole`: a `lift` that is
// handed the whole array, one function body for all rows.
export const PerRow = pattern<
  { items: Item[] },
  { rows: { label: string; done: boolean }[] }
>(({ items }) => {
  const rows = items.map((item) => ({
    label: item.title + "!",
    done: item.done,
  }));
  return { rows };
});

const label = lift(({ title }: { title: string }) => title + "!");

export const BodyPerRow = pattern<{ items: Item[] }, { labels: string[] }>(
  ({ items }) => {
    const labels = items.map((item) => label({ title: item.title }));
    return { labels };
  },
);

const countOpen = lift(({ items }: { items: Item[] }) =>
  items.filter((item) => !item.done).length
);

export const Whole = pattern<{ items: Item[] }, { open: number }>(
  ({ items }) => {
    return { open: countOpen({ items }) };
  },
);
