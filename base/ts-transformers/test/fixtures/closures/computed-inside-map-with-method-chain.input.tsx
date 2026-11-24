import { computed, pattern, UI } from "commonfabric";

interface SubItem {
  id: number;
  name: string;
  active: boolean;
}

interface Item {
  id: number;
  title: string;
  subItems: SubItem[];
}

interface State {
  items: Item[];
}

// FIXTURE: computed-inside-map-with-method-chain
// Verifies: a computed nested inside .map() correctly transforms outer .map() but leaves inner chains alone
//   state.items.map(fn) → state.items.mapWithPattern(pattern(...))
//   inner .filter().map() inside the computed callback → NOT transformed (plain array)
// Context: computed is used inline in JSX within a mapWithPattern callback
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Edge case: explicit computed inside mapWithPattern with method chain.
            The inner .filter().map() should NOT be transformed because:
            - inside the computed, item.subItems unwraps to a plain JS array
            - .filter() returns a plain JS array
            - Plain arrays don't have .mapWithPattern() */}
        {state.items.map((item) => (
          <div>
            <h2>{item.title}</h2>
            <p>
              Active items:{" "}
              {computed(() =>
                item.subItems
                  .filter((s) => s.active)
                  .map((s) => s.name)
                  .join(", ")
              )}
            </p>
          </div>
        ))}
      </div>
    ),
  };
});
