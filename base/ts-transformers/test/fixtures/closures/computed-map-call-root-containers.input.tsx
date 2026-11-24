import { computed, pattern } from "commonfabric";

const identity = (value: string) => value;

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-call-root-containers
// Verifies: inside a computed-array .map() callback, callback-local ordinary
//   call roots whole-wrap as callback-local lift-applied computations across
//   object-property, array-element, and direct return-expression sites.
//   ({ value: identity(row.done ? "Done" : "Pending") })
//   → ({ value: lift(({ row }) => identity(row.done ? "Done" : "Pending"))(...) })
//   [identity(row.done ? "Done" : "Pending")]
//   → [lift(({ row }) => identity(row.done ? "Done" : "Pending"))(...)]
//   row => identity(row.done ? "Done" : "Pending")
//   → row => lift(({ row }) => identity(row.done ? "Done" : "Pending"))(...)
export default pattern<
  State,
  { views: { value: string; list: string[] }[]; labels: string[] }
>((state) => {
  const rows = computed(() => state.items);

  const views = rows.map((row) => ({
    value: identity(row.done ? "Done" : "Pending"),
    list: [identity(row.done ? "Done" : "Pending")],
  }));

  const labels = rows.map((row) =>
    identity(row.done ? "Done" : "Pending")
  );

  return { views, labels };
});
