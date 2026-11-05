import { computed, pattern } from "commonfabric";

const identity = (value: string) => value;

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-local-call-root
// Verifies: callback-local ordinary call roots in a computed-array .map()
//   callback whole-wrap as callback-local lift-applied computations even when
//   introduced through a local variable initializer in non-JSX output code.
//   const label = identity(row.done ? "Done" : "Pending")
//   → const label = lift(({ row }) => identity(row.done ? "Done" : "Pending"))(...)
export default pattern<State, { labels: string[] }>((state) => {
  const rows = computed(() => state.items);

  const labels = rows.map((row) => {
    const label = identity(row.done ? "Done" : "Pending");
    return label;
  });

  return { labels };
});
