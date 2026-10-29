import { computed, pattern, UI } from "commonfabric";

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-pre-resolved-return-conditional
// Verifies: pre-resolving a boolean inside the source computed does not avoid
//   the need to lower the later direct callback-return ternary.
//   computed(() => state.items.map((item) => ({ done: item.done })))
//   rows.map((row) => row.done ? "Done" : "Pending")
//   → rows.mapWithPattern(pattern(... return ifElse(row.done, "Done", "Pending")))
export default pattern<State>((state) => {
  const rows = computed(() =>
    state.items.map((item) => ({ done: item.done }))
  );

  return {
    [UI]: (
      <div>
        {rows.map((row) => row.done ? "Done" : "Pending")}
      </div>
    ),
  };
});
