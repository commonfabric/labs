import { computed, pattern, UI } from "commonfabric";

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-direct-return-conditional
// Verifies: direct callback-return ternary on a computed array is lowered to ifElse()
//   rows.map((row) => row.done ? "Done" : "Pending")
//   → rows.mapWithPattern(pattern(... return ifElse(row.done, "Done", "Pending")))
// Context: the conditional is the callback's root return expression, not nested
//   inside returned JSX, which currently slips past the JSX-local rewrite pass.
export default pattern<State>((state) => {
  const rows = computed(() => state.items);

  return {
    [UI]: (
      <div>
        {rows.map((row) => row.done ? "Done" : "Pending")}
      </div>
    ),
  };
});
