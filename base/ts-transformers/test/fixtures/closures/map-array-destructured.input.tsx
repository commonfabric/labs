import { pattern, UI } from "commonfabric";

type PizzaEntry = [date: string, pizza: string];

interface State {
  pizzas: PizzaEntry[];
  scale: number;
}

// FIXTURE: map-array-destructured
// Verifies: array destructuring in .map() is lowered, with and without captured outer state
//   .map(([date, pizza]) => ...) → .mapWithPattern(pattern(...), {}) with index-based keys
//   Closing over state.scale → captures { state: { scale: state.key("scale") } }
// Context: Two map calls — one without captures (empty {}), one with a captured outer variable
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Map with array destructured parameter */}
        {state.pizzas.map(([date, pizza]) => (
          <div>
            {date}: {pizza}
          </div>
        ))}

        {/* Map with array destructured parameter and capture */}
        {state.pizzas.map(([date, pizza]) => (
          <div>
            {date}: {pizza} (scale: {state.scale})
          </div>
        ))}
      </div>
    ),
  };
});
