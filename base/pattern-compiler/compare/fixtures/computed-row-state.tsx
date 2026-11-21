/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

const pick = handler<unknown, { picked: Writable<string[]>; title: string }>(
  (_, { picked, title }) => {
    picked.push(title);
  },
);

// `rows` is an array that a computation returns from two inputs, so its
// elements are at no stored position. The handler bound in the body of the
// `map` over it takes `title` from its row and appends it to `picked`:
// what it writes depends on both inputs.
export default pattern<{ names: string[]; suffix: string }>(
  ({ names, suffix }) => {
    const picked = Writable.of<string[]>([]);
    const rows = computed(() =>
      names.map((name) => ({ title: `${name}${suffix}` }))
    );
    return {
      picked,
      list: rows.map((row) => ({
        title: row.title,
        pick: pick({ picked, title: row.title }),
      })),
    };
  },
);
