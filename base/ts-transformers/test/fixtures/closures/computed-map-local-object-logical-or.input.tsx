import { computed, pattern, UI } from "commonfabric";

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-local-object-logical-or
// Verifies: nested || inside a callback-local object initializer within a
//   computed-array .map() callback is lowered to unless().
//   const view = { status: row.done || "Pending" }
//   → const view = { status: unless(row.done, "Pending") }
export default pattern<State>((state) => {
  const rows = computed(() => state.items);

  return {
    [UI]: (
      <div>
        {rows.map((row) => {
          const view = { status: row.done || "Pending" };
          return <span>{view.status}</span>;
        })}
      </div>
    ),
  };
});
