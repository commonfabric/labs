/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

interface Group {
  name: string;
  items: Item[];
}

// Shapes whose cost is measured at two sizes of the data
// (`exec/test/growth.test.ts`): `nested` is a `map` inside a `map`,
// `labels` a `map` over the result of a `filter`, and `marks` a `map`
// over a long list. A test gives `groups`, the `items` of each group and
// `rows` as arrays of references and as arrays of plain values in place.
export default pattern<{ groups: Group[]; rows: Item[] }>(
  ({ groups, rows }) => {
    const nested = groups.map((group) => ({
      name: group.name,
      titles: group.items.map((item) => item.title + "!"),
    }));
    const open = rows.filter((row) => !row.done);
    const labels = open.map((row) => row.title.toUpperCase());
    const marks = rows.map((row) => `${row.title}:${row.done}`);
    return { nested, labels, marks };
  },
);
