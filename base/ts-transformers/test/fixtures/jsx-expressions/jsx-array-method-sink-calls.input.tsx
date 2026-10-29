import { pattern, UI } from "commonfabric";

interface State {
  items: number[];
  threshold: number;
  factor: number;
}

// FIXTURE: jsx-array-method-sink-calls
// Verifies: direct JSX sink receiver-methods over structural array-method chains can use the shared post-closure path
//   state.items.filter(fn).join(", ")                        → shared post-closure lift-applied computation over the sink call
//   state.items.filter(fn).map(fn).join(", ")                → shared post-closure lift-applied computation over the sink call
//   state.items.filter(fn).join(", ").toUpperCase()          → shared post-closure lift-applied computation over the chained call
//   state.items.filter(fn).join(", ").toUpperCase().trim()   → shared post-closure lift-applied computation over the recursive chained call
// Context: Verifies recursive receiver-method chaining above a shareable array-method sink base
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <p>
          Filter joined:{" "}
          {state.items.filter((x) => x > state.threshold).join(", ")}
        </p>
        <p>
          Filter map joined:{" "}
          {state.items.filter((x) => x > state.threshold).map((x) =>
            x * state.factor
          ).join(", ")}
        </p>
        <p>
          Filter joined upper:{" "}
          {state.items.filter((x) => x > state.threshold).join(", ").toUpperCase()}
        </p>
        <p>
          Filter joined upper trimmed:{" "}
          {state.items.filter((x) => x > state.threshold).join(", ").toUpperCase()
            .trim()}
        </p>
      </div>
    ),
  };
});
