import { computed, pattern, UI } from "commonfabric";

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-local-object-conditional
// Verifies: nested ternary inside a callback-local object initializer within a
//   computed-array .map() callback is lowered to ifElse().
//   const view = { status: row.done ? "Done" : "Pending" }
//   → const view = { status: ifElse(row.done, "Done", "Pending") }
export default pattern<State>((state) => {
  const rows = computed(() => state.items);

  return {
    [UI]: (
      <div>
        {rows.map((row) => {
          const view = { status: row.done ? "Done" : "Pending" };
          return <span>{view.status}</span>;
        })}
      </div>
    ),
  };
});
