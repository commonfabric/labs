import { computed, pattern, UI } from "commonfabric";

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-local-array-conditional
// Verifies: nested ternary inside a callback-local array initializer within a
//   computed-array .map() callback is lowered at the array element site.
//   const view = [row.done ? "Done" : "Pending"]
//   → const view = [ifElse(row.done, "Done", "Pending")]
export default pattern<State>((state) => {
  const rows = computed(() => state.items);

  return {
    [UI]: (
      <div>
        {rows.map((row) => {
          const view = [row.done ? "Done" : "Pending"];
          return <span>{view[0]}</span>;
        })}
      </div>
    ),
  };
});
