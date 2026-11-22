/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

interface Row {
  label: string;
  done: boolean;
}

// The lists of `compare/runner-path.ts`, which runs each on today's
// runtime and as a compiled piece: a test gives `items` as an array of
// references or as an array of plain values in place. The label is no
// template literal, which today's runtime writes as `[object Object]` for
// a cell.
export const Plain = pattern<{ items: Item[] }, { rows: Row[] }>(
  ({ items }) => {
    const rows = items.map((item) => ({
      label: item.title + "!",
      done: item.done,
    }));
    return { rows };
  },
);

// A `map` over the result of a `filter`, which is the result of another
// per-element construct.
export const Chained = pattern<{ items: Item[] }, { rows: Row[] }>(
  ({ items }) => {
    const open = items.filter((item) => !item.done);
    const rows = open.map((item) => ({
      label: item.title + "!",
      done: item.done,
    }));
    return { rows };
  },
);
