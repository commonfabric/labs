import { computed, pattern, UI } from "commonfabric";

const identity = (x: string) => x;

interface Item {
  done: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-map-call-arg-conditional
// Verifies: callback-local ordinary call roots within a computed-array .map()
//   callback whole-wrap as callback-local lift-applied computations rather than
//   lowering only the nested ternary argument site.
//   const label = identity(row.done ? "Done" : "Pending")
//   → const label = lift(({ row }) => identity(row.done ? "Done" : "Pending"))(...)
export default pattern<State>((state) => {
  const rows = computed(() => state.items);

  return {
    [UI]: (
      <div>
        {rows.map((row) => {
          const label = identity(row.done ? "Done" : "Pending");
          return <span>{label}</span>;
        })}
      </div>
    ),
  };
});
